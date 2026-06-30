import logging
import base64
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from decimal import Decimal
from threading import BoundedSemaphore

import requests
from django.conf import settings
from django.db import close_old_connections
from django.utils.html import escape


logger = logging.getLogger(__name__)

_executor = ThreadPoolExecutor(
    max_workers=max(1, int(getattr(settings, 'RESEND_EMAIL_WORKERS', 2)))
)
_queue_slots = BoundedSemaphore(
    max(1, int(getattr(settings, 'RESEND_EMAIL_MAX_QUEUED_TASKS', 100)))
)


def _mask_email(value):
    email = str(value or '')
    if '@' not in email:
        return '***'
    name, domain = email.split('@', 1)
    if not name:
        return f"***@{domain}"
    return f"{name[:1]}***@{domain}"


def _recipient_count(to):
    return len([to] if isinstance(to, str) else list(to or []))


def _submit_email_task(task, *, failure_callback=None):
    if not _queue_slots.acquire(blocking=False):
        logger.error("Email queue is full; rejecting email task")
        if failure_callback:
            failure_callback()
        raise RuntimeError("Email queue is full")

    try:
        future = _executor.submit(task)
    except Exception:
        _queue_slots.release()
        raise

    def release_slot(done):
        _queue_slots.release()

    future.add_done_callback(release_slot)
    return future


@dataclass
class EmailResult:
    success: bool
    message: str = ''
    provider_id: str = ''
    status_code: int | None = None


class EmailConfigurationError(ValueError):
    pass


class ResendEmailService:
    """Small Resend API client for transactional email delivery."""

    def __init__(self):
        self.api_key = getattr(settings, 'RESEND_API_KEY', '')
        self.api_url = getattr(settings, 'RESEND_API_URL', 'https://api.resend.com/emails')
        self.sender_email = getattr(settings, 'RESEND_SENDER_EMAIL', '')
        self.sender_name = getattr(settings, 'RESEND_SENDER_NAME', 'FOTASCO Payroll NoReply')
        self.reply_to = getattr(settings, 'RESEND_REPLY_TO', '')
        self.connect_timeout = float(getattr(settings, 'RESEND_EMAIL_CONNECT_TIMEOUT_SECONDS', 2))
        self.read_timeout = float(getattr(settings, 'RESEND_EMAIL_READ_TIMEOUT_SECONDS', 5))
        self.retries = max(0, int(getattr(settings, 'RESEND_EMAIL_RETRIES', 1)))

    def validate_configuration(self):
        if not self.api_key:
            raise EmailConfigurationError('Resend API key is not configured.')
        if not self.sender_email:
            raise EmailConfigurationError('Resend sender email is not configured.')

    @property
    def from_email(self):
        sender_name = (self.sender_name or 'NoReply').strip()
        return f"{sender_name} <{self.sender_email}>"

    def send_html_email(self, *, to, subject, html, text=None, reply_to=None, attachments=None):
        self.validate_configuration()
        payload = {
            'from': self.from_email,
            'to': [to] if isinstance(to, str) else list(to),
            'subject': subject,
            'html': html,
        }
        if text:
            payload['text'] = text
        resolved_reply_to = reply_to or self.reply_to
        if resolved_reply_to:
            payload['reply_to'] = resolved_reply_to
        if attachments:
            payload['attachments'] = attachments

        headers = {
            'Authorization': f"Bearer {self.api_key}",
            'Content-Type': 'application/json',
        }

        recipient_count = len(payload['to'])
        last_error = ''
        for attempt in range(self.retries + 1):
            try:
                response = requests.post(
                    self.api_url,
                    json=payload,
                    headers=headers,
                    timeout=(self.connect_timeout, self.read_timeout),
                )
                try:
                    if 200 <= response.status_code < 300:
                        data = response.json() if response.content else {}
                        provider_id = data.get('id', '')
                        logger.info(
                            "Resend email accepted subject=%s recipient_count=%s provider_id=%s",
                            subject,
                            recipient_count,
                            provider_id,
                        )
                        return EmailResult(True, 'Email sent', provider_id, response.status_code)

                    last_error = f"status={response.status_code}"
                    logger.warning(
                        "Resend API rejected email subject=%s recipient_count=%s attempt=%s status=%s",
                        subject,
                        recipient_count,
                        attempt + 1,
                        response.status_code,
                    )
                    if response.status_code not in {408, 429, 500, 502, 503, 504}:
                        break
                finally:
                    response.close()
            except requests.Timeout as exc:
                last_error = str(exc)
                logger.warning(
                    "Resend email timeout subject=%s recipient_count=%s attempt=%s error=%s",
                    subject,
                    recipient_count,
                    attempt + 1,
                    exc,
                )
            except requests.RequestException as exc:
                last_error = str(exc)
                logger.warning(
                    "Resend email request failed subject=%s recipient_count=%s attempt=%s error=%s",
                    subject,
                    recipient_count,
                    attempt + 1,
                    exc,
                )

            if attempt < self.retries:
                time.sleep(min(4, 0.25 * (2 ** attempt)))

        logger.error(
            "Resend email delivery failed subject=%s recipient_count=%s error=%s",
            subject,
            recipient_count,
            last_error,
        )
        return EmailResult(False, last_error)


def build_internal_payment_otp_email(*, otp_code, reference, employee_names, total_amount, expiry_seconds):
    total_amount = Decimal(str(total_amount or 0))
    escaped_code = escape(str(otp_code))
    escaped_reference = escape(str(reference))
    escaped_employee_names = escape(employee_names)
    text = (
        f"FOTASCO Payroll NoReply\n\n"
        f"Use this OTP to authorize the payment request: {otp_code}\n\n"
        f"Reference: {reference}\n"
        f"Employees: {employee_names}\n"
        f"Total amount: NGN {total_amount:,.2f}\n"
        f"Expires in {expiry_seconds} seconds.\n\n"
        "If you did not request this payment authorization, contact your payroll administrator immediately."
    )
    html = f"""<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f7f6;font-family:Arial,Helvetica,sans-serif;color:#172026;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7f6;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border:1px solid #dfe7e4;border-radius:8px;overflow:hidden;">
            <tr>
              <td style="background:#117e62;padding:22px 28px;color:#ffffff;">
                <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#d8fff4;">FOTASCO Security Services</div>
                <h1 style="margin:8px 0 0;font-size:22px;line-height:1.3;font-weight:700;">Payment confirmation OTP</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Use the one-time password below to confirm this payroll payment request.</p>
                <div style="margin:24px 0;padding:18px;background:#ecfdf5;border:1px solid #bbf7d0;border-radius:8px;text-align:center;">
                  <div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#0f766e;margin-bottom:8px;">Verification code</div>
                  <div style="font-size:34px;line-height:1;font-weight:700;letter-spacing:8px;color:#064e3b;">{escaped_code}</div>
                </div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;line-height:1.5;border-collapse:collapse;">
                  <tr><td style="padding:6px 0;color:#667085;width:120px;">Reference</td><td style="padding:6px 0;color:#172026;">{escaped_reference}</td></tr>
                  <tr><td style="padding:6px 0;color:#667085;">Employees</td><td style="padding:6px 0;color:#172026;">{escaped_employee_names}</td></tr>
                  <tr><td style="padding:6px 0;color:#667085;">Total amount</td><td style="padding:6px 0;color:#172026;font-weight:700;">NGN {total_amount:,.2f}</td></tr>
                  <tr><td style="padding:6px 0;color:#667085;">Expires</td><td style="padding:6px 0;color:#b45309;font-weight:700;">In {expiry_seconds} seconds</td></tr>
                </table>
                <p style="margin:24px 0 0;padding:14px 16px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;color:#9a3412;font-size:13px;line-height:1.5;">If you did not request this authorization, do not share this code. Contact your payroll administrator immediately.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 28px;background:#f8faf9;color:#667085;font-size:12px;line-height:1.5;">
                This is an automated NoReply message from FOTASCO Payroll. Please do not share OTP codes with anyone.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>"""
    return text, html


def enqueue_internal_payment_otp_email(*, recipient, subject, otp_code, reference, employee_names, total_amount, expiry_seconds, failure_callback=None):
    service = ResendEmailService()
    service.validate_configuration()
    text, html = build_internal_payment_otp_email(
        otp_code=otp_code,
        reference=reference,
        employee_names=employee_names,
        total_amount=total_amount,
        expiry_seconds=expiry_seconds,
    )

    def send():
        close_old_connections()
        try:
            result = service.send_html_email(
                to=recipient,
                subject=subject,
                html=html,
                text=text,
            )
            if not result.success and failure_callback:
                failure_callback()
            return result
        finally:
            close_old_connections()

    future = _submit_email_task(send, failure_callback=failure_callback)

    def log_result(done):
        try:
            result = done.result()
            if not result.success:
                logger.error(
                    "Internal payment OTP email delivery failed recipient=%s reference=%s error=%s",
                    _mask_email(recipient),
                    reference,
                    result.message,
                )
        except Exception:
            logger.exception(
                "Internal payment OTP email worker crashed recipient=%s reference=%s",
                _mask_email(recipient),
                reference,
            )
            if failure_callback:
                failure_callback()

    future.add_done_callback(log_result)


def enqueue_transactional_email(*, recipient, subject, text=None, html=None, attachments=None, failure_callback=None):
    service = ResendEmailService()
    service.validate_configuration()

    def send():
        close_old_connections()
        try:
            result = service.send_html_email(
                to=recipient,
                subject=subject,
                html=html or f"<p>{escape(text or '')}</p>",
                text=text,
                attachments=attachments,
            )
            if not result.success and failure_callback:
                failure_callback()
            return result
        finally:
            close_old_connections()

    future = _submit_email_task(send, failure_callback=failure_callback)

    def log_result(done):
        try:
            result = done.result()
            if not result.success:
                logger.error(
                    "Transactional email delivery failed recipient=%s subject=%s recipient_count=%s error=%s",
                    _mask_email(recipient),
                    subject,
                    _recipient_count(recipient),
                    result.message,
                )
        except Exception:
            logger.exception(
                "Transactional email worker crashed recipient=%s subject=%s",
                _mask_email(recipient),
                subject,
            )
            if failure_callback:
                failure_callback()

    future.add_done_callback(log_result)


def build_resend_attachment(*, filename, content, content_type):
    encoded = base64.b64encode(content).decode('ascii')
    return {
        'filename': filename,
        'content': encoded,
        'content_type': content_type,
    }
