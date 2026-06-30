import logging

from django.core.mail.backends.base import BaseEmailBackend

from .email_service import ResendEmailService, build_resend_attachment


logger = logging.getLogger(__name__)


class ResendEmailBackend(BaseEmailBackend):
    """Django email backend that routes legacy send_mail calls through Resend."""

    def send_messages(self, email_messages):
        if not email_messages:
            return 0

        service = ResendEmailService()
        sent_count = 0

        for message in email_messages:
            try:
                html = None
                for content, mimetype in getattr(message, 'alternatives', []):
                    if mimetype == 'text/html':
                        html = content
                        break

                text = message.body or ''
                attachments = []
                for attachment in getattr(message, 'attachments', []):
                    if isinstance(attachment, tuple):
                        filename, content, mimetype = attachment
                        if isinstance(content, str):
                            content = content.encode('utf-8')
                        attachments.append(
                            build_resend_attachment(
                                filename=filename,
                                content=content,
                                content_type=mimetype or 'application/octet-stream',
                            )
                        )

                result = service.send_html_email(
                    to=message.to,
                    subject=message.subject,
                    html=html or f"<p>{text}</p>",
                    text=text,
                    reply_to=(message.reply_to[0] if getattr(message, 'reply_to', None) else None),
                    attachments=attachments,
                )
                if result.success:
                    sent_count += 1
                elif not self.fail_silently:
                    raise RuntimeError(result.message)
            except Exception:
                logger.exception(
                    "Resend Django email backend failed subject=%s recipient_count=%s",
                    getattr(message, 'subject', ''),
                    len(getattr(message, 'to', []) or []),
                )
                if not self.fail_silently:
                    raise

        return sent_count
