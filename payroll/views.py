import base64
import csv
import hashlib
import hmac
import io
import logging
import os
import random
import secrets
import string
import uuid
import zipfile
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from django.contrib.auth import get_user_model
from django.conf import settings
from django.core.mail import EmailMessage, EmailMultiAlternatives
from django.core.exceptions import ValidationError
from django.contrib.auth.tokens import default_token_generator
from django.utils.http import urlsafe_base64_encode, urlsafe_base64_decode
from django.utils.encoding import force_bytes, force_str
from django.core.mail import send_mail
from django.db import transaction
from django.db.models import Q, Sum
from django.core.cache import cache
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.template.loader import render_to_string
from django.utils.html import escape
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
import requests
from rest_framework import serializers, status, viewsets
from rest_framework.authentication import BasicAuthentication, SessionAuthentication
from rest_framework.decorators import action, api_view, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView
import json
from rest_framework_simplejwt.authentication import JWTAuthentication

try:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
except ImportError:
    colors = None
    letter = None
    getSampleStyleSheet = None
    ParagraphStyle = None
    SimpleDocTemplate = None
    Table = None
    TableStyle = None
    Paragraph = None
    Spacer = None
from .models import (
    Employee, Attendance, Deduction, Payment, PaymentStatus,
    Company, SackedEmployee, Notification, OTP, ExportToken, EmployeeRequest, EmployeeRequestAttachment, DownloadLog
)
from . import auth_views
from .serializers import (
    UserSerializer, EmployeeSerializer, AttendanceSerializer,
    DeductionSerializer, PaymentSerializer, CompanySerializer,
    SackedEmployeeSerializer, NotificationSerializer, EmployeeRequestSerializer,
    SelfSignupSerializer
)
from .paystack import PaystackAPI
from .services import applied_deductions_for_month, get_employee_bank_code
from .image_utils import compress_and_validate_image
from .permissions import (
    IsAdmin, CanCreateEmployee, IsSackAdmin, IsPayrollAdmin, IsHRAdmin,
    IsDeductionAdmin, CanEditNotification, CanViewAndEditCompany, IsRequestAdmin
)
from payroll.throttles import AttendanceThrottle, PaymentThrottle, BulkPaymentThrottle, ExportThrottle, BankVerifyThrottle
from .utils import log_audit, get_client_ip

User = get_user_model()
logger = logging.getLogger(__name__)



@csrf_exempt
def approve_paystack_transfer(request):
    """
    Paystack Transfer Approval URL.
    Paystack POSTs here to ask if a transfer should proceed.
    
    Return 200 to approve, 400 to reject.
    """
    # Verify it's actually Paystack calling
    paystack_secret = getattr(settings, 'PAYSTACK_SECRET_KEY', '')
    signature = request.headers.get('x-paystack-signature', '')
    
    raw_body = request.body
    computed = hmac.new(
        paystack_secret.encode('utf-8'),
        raw_body,
        hashlib.sha512
    ).hexdigest()
    
    if not hmac.compare_digest(computed, signature):
        return JsonResponse({'error': 'Invalid signature'}, status=400)
    
    try:
        payload = json.loads(raw_body)
        transfer_data = payload.get('data', {})
        reference = transfer_data.get('reference')
        
        # Find the payment by reference
        try:
            payment = Payment.objects.get(transaction_reference=reference)
        except Payment.DoesNotExist:
            return JsonResponse({'error': 'Payment not found'}, status=400)
        
        # Check if HR approval is required but not given
        if payment.status == PaymentStatus.PENDING_HR:
            logger.warning(f"Transfer {reference} rejected: awaiting HR approval")
            return JsonResponse({
                'status': False,
                'message': 'Awaiting HR approval'
            }, status=400)
        
        # Check if payment is in a valid state
        if payment.status not in [PaymentStatus.PENDING, PaymentStatus.PROCESSING]:
            logger.warning(f"Transfer {reference} rejected: invalid status {payment.status}")
            return JsonResponse({
                'status': False,
                'message': f'Invalid payment status: {payment.status}'
            }, status=400)
        
        # Approve the transfer
        logger.info(f"Transfer {reference} approved via Paystack approval URL")
        return JsonResponse({'status': True, 'message': 'Approved'})
        
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    except Exception as e:
        logger.error(f"Approval URL error: {e}")
        return JsonResponse({'error': str(e)}, status=500)

def _paystack_reference_from_data(data):
    if not isinstance(data, dict):
        return ''
    return str(data.get('id') or data.get('transfer_code') or data.get('reference') or '')


def _paystack_transfer_code_from_data(data):
    if not isinstance(data, dict):
        return ''
    return str(data.get('transfer_code') or '')


def _apply_paystack_transfer_result(payment, transfer_data, save=True):
    transfer_data = transfer_data if isinstance(transfer_data, dict) else {}
    transfer_status = transfer_data.get('status')
    paystack_ref = _paystack_reference_from_data(transfer_data)
    transfer_code = _paystack_transfer_code_from_data(transfer_data)

    if paystack_ref:
        payment.paystack_reference = paystack_ref
    if transfer_code:
        payment.paystack_transfer_code = transfer_code

    if transfer_status == 'success':
        payment.status = 'completed'
    elif transfer_status == 'otp':
        payment.status = 'pending_paystack_otp'
    elif transfer_status in ['failed', 'reversed']:
        payment.status = 'failed'
    elif transfer_status in ['pending', 'processing', 'queued', 'received']:
        payment.status = 'processing'
    elif not transfer_status and payment.status in ['pending', 'pending_hr']:
        payment.status = 'processing'

    if save:
        payment.save(update_fields=['status', 'paystack_reference', 'paystack_transfer_code', 'updated_at'])
    return payment


def _sync_payment_with_paystack(payment):
    if payment.payment_method != 'bank_transfer':
        return payment
    if payment.status not in ['processing', 'pending', 'pending_hr', 'pending_paystack_otp']:
        return payment

    result = PaystackAPI().verify_transfer(payment.transaction_reference)
    transfer_data = result.get('data') if isinstance(result.get('data'), dict) else {}
    if result.get('status') is True:
        with transaction.atomic():
            locked = Payment.objects.select_for_update().get(pk=payment.pk)
            return _apply_paystack_transfer_result(locked, transfer_data)
    return payment


def _is_paystack_otp_still_valid(payment):
    if payment.payment_method != 'bank_transfer':
        return False
    if payment.status != 'pending_paystack_otp':
        return False
    if not payment.transaction_reference:
        return False

    result = PaystackAPI().verify_transfer(payment.transaction_reference)
    if result.get('status') is not True:
        return False

    transfer_data = result.get('data') if isinstance(result.get('data'), dict) else {}
    return transfer_data.get('status') == 'otp'


class DownloadLogSerializer(serializers.ModelSerializer):
    employee_name = serializers.ReadOnlyField(source='employee.name')
    employee_id = serializers.ReadOnlyField(source='employee.employee_id')
    user_username = serializers.ReadOnlyField(source='user.username')

    class Meta:
        model = DownloadLog
        fields = [
            'id', 'user', 'user_username', 'employee', 'employee_name', 
            'employee_id', 'doc_type', 'reference', 'ip_address', 'timestamp'
        ]


@api_view(['GET'])
@permission_classes([AllowAny])
def paystack_banks(request):
    """Get list of Nigerian banks from Paystack"""
    paystack = PaystackAPI()
    result = paystack.get_banks()
    return Response(result)


class PaystackVerifyAccountView(APIView):
    permission_classes = [AllowAny]
    # Throttle this endpoint to avoid bursts hammering Paystack (429s).
    throttle_classes = [BankVerifyThrottle]

    def post(self, request):
        """Verify bank account number"""
        account_number = request.data.get('account_number')
        bank_code = request.data.get('bank_code')

        if not account_number or not bank_code:
            return Response(
                {'error': 'account_number and bank_code required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Check for existing active employees to avePaystack API calls and prevent duplicates
        duplicate = Employee.objects.filter(
            account_number=account_number,
            bank_code=bank_code,
            status__in=['active', 'pending']
        ).first()

        if duplicate:
            return Response({
                'status': True,
                'message': 'Account already verified and registered in system',
                'data': {
                    'account_name': duplicate.account_holder,
                    'account_number': duplicate.account_number,
                    'bank_name': duplicate.bank_name
                }
            }, status=status.HTTP_200_OK)

        paystack = PaystackAPI()
        result = paystack.verify_account(account_number, bank_code)

        # Normalize Paystack 429/rate-limited payloads so frontend doesn't hammer the endpoint.
        if (
            result.get('error_code') == 'rate_limited'
            or result.get('status') is False and str(result.get('message', '')).lower().find('rate limit') >= 0
        ):
            retry_after = result.get('retry_after')
            message = "Verification service is temporarily unavailable. Please try again in 5 minutes."
            if retry_after:
                message = f"Rate limited. Try again in {retry_after}s."

            return Response(
                {
                    'success': False,
                    'message': message,
                    'detail': message,
                    'retry_after': retry_after,
                    'error_code': 'rate_limited'
                },
                status=status.HTTP_429_TOO_MANY_REQUESTS
    )
        return Response(result)



@api_view(['GET'])
@permission_classes([AllowAny])
@throttle_classes([BankVerifyThrottle])
def paystack_resolve_account(request):
    """Resolve Paystack account name (GET /paystack/resolve-account/)."""
    account_number = request.GET.get('account_number')
    bank_code = request.GET.get('bank_code')

    if not account_number or not bank_code:
        return Response(
            {'success': False, 'message': 'account_number and bank_code are required'},
            status=status.HTTP_400_BAD_REQUEST
        )

    # If already resolved/registered, avoid external calls
    duplicate = Employee.objects.filter(
        account_number=account_number,
        bank_code=bank_code,
        status__in=['active', 'pending']
    ).first()
    if duplicate:
        return Response({
            'success': True,
            'message': 'Account already verified and registered in system',
            'data': {
                'account_name': duplicate.account_holder,
                'account_number': duplicate.account_number,
                'bank_name': duplicate.bank_name,
            }
        }, status=status.HTTP_200_OK)

    paystack = PaystackAPI()
    # Reuse existing caching & normalization by calling verify_account
    result = paystack.verify_account(account_number, bank_code)

    if (
        result.get('error_code') == 'rate_limited'
        or result.get('status') is False and str(result.get('message', '')).lower().find('rate limit') >= 0
    ):
        retry_after = result.get('retry_after')
        message = "Verification service is temporarily unavailable. Please try again in 5 minutes."
        if retry_after:
            message = f"Rate limited. Try again in {retry_after}s."

        return Response(
            {
                'success': False,
                'message': message,
                'detail': message,
                'retry_after': retry_after,
                'error_code': 'rate_limited'
            },
            status=status.HTTP_429_TOO_MANY_REQUESTS
        )

    # Expect verify_account payload to contain account_name/account_number/bank_name
    return Response(result)


@api_view(['POST'])
@permission_classes([IsAdmin])
def clear_paystack_cache(request):

    """
    Clear all cached Paystack bank account resolutions.
    Requires django-redis for delete_pattern support.
    """
    try:
        # This pattern matches keys created in paystack.py
        # Key format: paystack:resolve:{bank_code}:{account_number}
        if hasattr(cache, 'delete_pattern'):
            cache.delete_pattern("paystack:resolve:*")
        else:
            # Fallback for LocMemCache
            cache.clear()
        log_audit(request.user, "Cleared all Paystack bank resolution caches", request)
        return Response({'status': True, 'message': 'Bank resolution cache cleared successfully'})
    except Exception as e:
        logger.error(f"Failed to clear cache: {e}")
        return Response({'status': False, 'message': str(e)}, status=500)

def draw_watermark(canvas, doc):
    """Draw low-opacity logo watermark on PDF"""
    canvas.saveState()
    canvas.setFillAlpha(0.05)
    logo_path = os.path.join(settings.BASE_DIR, 'static', 'no_bggg.png')
    if os.path.exists(logo_path):
        canvas.drawImage(logo_path, 150, 250, width=300, height=300, mask='auto')
    canvas.restoreState()

def generate_receipt_pdf_buffer(payment):
    """Refactored PDF generator for reuse in views and emails"""
    employee = payment.employee
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=letter)
    styles = getSampleStyleSheet()
    elements = []

    # Custom Receipt Header
    header_style = ParagraphStyle('Header', parent=styles['Heading1'], alignment=1, textColor=colors.HexColor("#117e62"))
    elements.append(Paragraph("FOTASCO SECURITY SERVICES", header_style))
    elements.append(Paragraph("OFFICIAL PAYMENT RECEIPT", styles['Heading2']))
    elements.append(Spacer(1, 20))

    # Metadata
    meta_data = [
        ["Receipt No:", f"REC-{payment.transaction_reference[:8].upper()}"],
        ["Date Issued:", payment.payment_date.strftime('%d %b %Y')],
        ["Payment Ref:", payment.transaction_reference]
    ]
    meta_table = Table(meta_data, colWidths=[100, 400])
    meta_table.setStyle(TableStyle([('FONTNAME', (0,0), (0,-1), 'Helvetica-Bold')]))
    elements.append(meta_table)
    elements.append(Spacer(1, 20))

    # Breakdown Table
    payment_data = [
        ["Description", "Amount"],
        [f"Salary Payment - {payment.payment_month or 'Custom'}", f"NGN {payment.base_salary:,.2f}"],
        ["Total Deductions", f"NGN ({payment.total_deductions:,.2f})"],
        [Paragraph("<b>TOTAL PAID</b>", styles['Normal']), Paragraph(f"<b>NGN {payment.net_amount:,.2f}</b>", styles['Normal'])]
    ]
    pt = Table(payment_data, colWidths=[350, 150])
    pt.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (1,0), colors.HexColor("#117e62")),
        ('TEXTCOLOR', (0,0), (1,0), colors.whitesmoke),
        ('ALIGN', (1,0), (1,-1), 'RIGHT'),
        ('GRID', (0,0), (-1,-1), 0.5, colors.grey),
        ('LINEBELOW', (0,-1), (-1,-1), 2, colors.HexColor("#117e62")),
    ]))
    elements.append(pt)
    elements.append(Spacer(1, 20))

    # Stamp and T&C
    stamp_path = os.path.join(settings.BASE_DIR, 'static', 'stamp.png')
    if os.path.exists(stamp_path):
        from reportlab.platypus import Image
        elements.append(Image(stamp_path, width=100, height=100))
    
    elements.append(Spacer(1, 10))
    elements.append(Paragraph("<b>Terms & Conditions:</b>", styles['Normal']))
    tc_style = ParagraphStyle('TC', parent=styles['Normal'], fontSize=8, textColor=colors.grey)
    elements.append(Paragraph("1. This receipt confirms the electronic transfer of funds for the stated period.", tc_style))
    elements.append(Paragraph("2. Any discrepancies regarding this payment must be reported to HR within 48 hours.", tc_style))
    elements.append(Paragraph("3. This document is a valid proof of payment for tax and accounting purposes.", tc_style))

    elements.append(Spacer(1, 20))
    elements.append(Paragraph("<i>This is a computer generated receipt, no signature is required.</i>", styles['Italic']))

    doc.build(elements, onLaterPages=draw_watermark, onFirstPage=draw_watermark)
    buffer.seek(0)
    return buffer

def send_payment_receipt_email(payment):
    """Automated email delivery of receipts"""
    try:
        employee = payment.employee
        if not employee.email:
            logger.warning(f"Cannot send receipt: Employee {employee.employee_id} has no email.")
            return

        buffer = generate_receipt_pdf_buffer(payment)
        subject = f"Payment Receipt: {payment.payment_month or 'Salary Payment'}"
        
        email = EmailMessage(
            subject=subject,
            body=f"Dear {employee.name},\n\nYour salary payment has been processed successfully. Please find your official receipt attached.\n\nTransaction Ref: {payment.transaction_reference}\n\nThank you,\nFotasco Security Services",
            from_email=settings.DEFAULT_FROM_EMAIL,
            to=[employee.email],
        )
        
        # Attach PDF
        filename = f"receipt_{payment.transaction_reference[:8]}.pdf"
        email.attach(filename, buffer.getvalue(), 'application/pdf')
        
        # Send
        email.send(fail_silently=True)
        logger.info(f"Receipt email sent to {employee.email} for payment {payment.transaction_reference}")
    except Exception as e:
        logger.error(f"Error sending receipt email: {e}")

# ─────────────────────────────────────────
# PAYSTACK WEBHOOK HANDLER
# ─────────────────────────────────────────

@csrf_exempt
def paystack_webhook(request):
    """
    Handle Paystack webhook events.
    Uses Django's raw HttpRequest, NOT DRF's Request wrapper.
    This avoids RawPostDataException when accessing request.body.
    """
    # CRITICAL: Read body ONCE and store it
    raw_body = request.body
    
    paystack_secret = getattr(settings, 'PAYSTACK_SECRET_KEY', '')
    signature = request.headers.get('x-paystack-signature', '')

    # Verify webhook signature
    computed = hmac.new(
        paystack_secret.encode('utf-8'),
        raw_body,
        hashlib.sha512
    ).hexdigest()

    if not hmac.compare_digest(computed, signature):
        logger.error(f"Invalid Paystack webhook signature. Computed: {computed[:20]}..., Received: {signature[:20]}...")
        return HttpResponse(status=400)

    try:
        # Parse JSON manually from the stored raw body
        payload = json.loads(raw_body)
        event = payload.get('event')
        data = payload.get('data', {})
        reference = data.get('reference')
        
        logger.info(f"Paystack webhook: {event} | ref={reference}")

        if event == 'transfer.success':
            _handle_transfer_success(data)
        elif event == 'transfer.failed':
            _handle_transfer_failed(data)
        elif event == 'transfer.reversed':
            _handle_transfer_reversed(data)
        elif event == 'charge.success':
            _handle_charge_success(data)
        else:
            logger.info(f"Unhandled Paystack event: {event}")

        return HttpResponse(status=200)

    except json.JSONDecodeError as e:
        logger.error(f"Webhook JSON parse error: {e}")
        return HttpResponse(status=400)
    except Exception as e:
        logger.error(f"Webhook processing error: {e}")
        # Return 200 so Paystack doesn't retry and spam you
        return HttpResponse(status=200)


def _handle_transfer_success(data):
    """Mark payment as completed when transfer succeeds"""
    reference = data.get('reference')
    # Use select_for_update to prevent race conditions during state transition
    with transaction.atomic():
        try:
            payment = Payment.objects.select_for_update().get(transaction_reference=reference)
            logger.info(f"Handling transfer.success for payment {payment.id}, current status: {payment.status}")

            payment.paystack_reference = _paystack_reference_from_data(data)
            payment.paystack_transfer_code = _paystack_transfer_code_from_data(data) or payment.paystack_transfer_code
            if payment.status == 'completed':
                return
            payment.status = 'completed'
            payment.save(update_fields=['status', 'paystack_reference', 'paystack_transfer_code', 'updated_at'])
            
            # Automate Receipt Email
            send_payment_receipt_email(payment)
            
            # Notify employee
            Notification.objects.create(
                user=payment.employee.user,
                message=(
                    f"Salary payment of ₦{payment.net_amount:,.2f} has been "
                    f"sent to your {payment.employee.bank_name} account."
                ),
                type='success'
            )

            logger.info(f"Transfer successful for {payment.employee.name} (Ref: {reference}): NGN {payment.net_amount}. New status: {payment.status}")

        except ValueError as ve: # Catches illegal status transitions from change_status
            logger.warning(f"Webhook transfer.success: Illegal status transition for payment {reference}: {ve}")
        except Payment.DoesNotExist:
            logger.error(f"Webhook transfer.success: Payment not found for reference={reference}")


def _handle_transfer_failed(data):
    """Mark payment as failed when transfer fails"""
    reference = data.get('reference')
    with transaction.atomic():
        try:
            payment = Payment.objects.select_for_update().get(transaction_reference=reference)
            logger.info(f"Handling transfer.failed for payment {payment.id}, current status: {payment.status}")
            
            if payment.status == 'failed':
                return
            payment.paystack_reference = _paystack_reference_from_data(data) or payment.paystack_reference
            payment.paystack_transfer_code = _paystack_transfer_code_from_data(data) or payment.paystack_transfer_code
            payment.status = 'failed'
            payment.save(update_fields=['status', 'paystack_reference', 'paystack_transfer_code', 'updated_at'])
            
            # Keep deductions as 'pending' unless they are cancelled manually by deduction admin.

            Notification.objects.create(
                user=payment.employee.user,
                message=(
                    f"Salary payment of ₦{payment.net_amount:,.2f} failed. "
                    f"Please contact HR for assistance."
                ),
                type='warning'
            )

            logger.error(f"Transfer failed for {payment.employee.name} (Ref: {reference}). New status: {payment.status}")

        except ValueError as ve: # Catches illegal status transitions from change_status
            logger.warning(f"Webhook transfer.failed: Illegal status transition for payment {reference}: {ve}")
        except Payment.DoesNotExist:
            logger.error(f"Webhook transfer.failed: Payment not found for reference={reference}")


def _handle_transfer_reversed(data):
    """Mark payment as failed when transfer is reversed"""
    reference = data.get('reference')
    with transaction.atomic():
        try:
            payment = Payment.objects.select_for_update().get(transaction_reference=reference)
            logger.info(f"Handling transfer.reversed for payment {payment.id}, current status: {payment.status}")

            if payment.status == 'failed':
                return
            payment.paystack_reference = _paystack_reference_from_data(data) or payment.paystack_reference
            payment.paystack_transfer_code = _paystack_transfer_code_from_data(data) or payment.paystack_transfer_code
            payment.status = 'failed'
            payment.save(update_fields=['status', 'paystack_reference', 'paystack_transfer_code', 'updated_at'])

            Notification.objects.create(
                user=payment.employee.user,
                message=(
                    f"Salary payment of ₦{payment.net_amount:,.2f} was reversed. "
                    f"Please contact HR."
                ),
                type='warning'
            )

            logger.error(f"Transfer reversed for payment {payment.employee.name} (Ref: {reference}). New status: {payment.status}")

        except ValueError as ve: # Catches illegal status transitions from change_status
            logger.warning(f"Webhook transfer.reversed: Illegal status transition for payment {reference}: {ve}")
        except Payment.DoesNotExist:
            logger.error(f"Webhook transfer.reversed: Payment not found for reference={reference}")


def _handle_charge_success(data):
    """
    Handle successful charge (used with initialize_transaction).
    Kept for future use if you collect payments.
    """
    reference = data.get('reference')
    try:
        payment = Payment.objects.get(transaction_reference=reference)
        logger.info(f"Handling charge.success for payment {payment.id}, current status: {payment.status}")

        if payment.status == 'completed':
            return

        # This path is for charge.success, not transfer.success, so it directly sets status
        with transaction.atomic():
            payment.status = 'completed'
            
            payment.paystack_reference = data.get('reference', '')
            payment.save()

            Notification.objects.create(
                user=payment.employee.user,
                message=f"Payment of ₦{payment.net_amount:,.2f} confirmed.",
                type='success'
            )

        logger.info(f"Charge successful for payment {payment.employee.name} (Ref: {reference}). New status: {payment.status}")

    except Payment.DoesNotExist:
        logger.error(f"Webhook charge.success: Payment not found for reference={reference}")
    except Exception as e:
        logger.error(f"Webhook _handle_charge_success error: {e}")
        
# ─────────────────────────────────────────
# PAYMENT STATUS POLLING ENDPOINT
# ─────────────────────────────────────────

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def verify_payment_status(request, reference):
    try:
        payment = Payment.objects.get(transaction_reference=reference)
    except Payment.DoesNotExist:
        return Response(
            {'status': False, 'message': 'Payment not found'},
            status=status.HTTP_404_NOT_FOUND
        )

    if payment.status == 'processing' and payment.payment_method == 'bank_transfer':
        try:
            verification = PaystackAPI().verify_transfer(reference)
            transfer_data = verification.get('data') if isinstance(verification.get('data'), dict) else {}
            if verification.get('status') is True and transfer_data.get('status') == 'success':
                with transaction.atomic():
                    payment = Payment.objects.select_for_update().get(pk=payment.pk)
                    if payment.status == 'processing':
                        _apply_paystack_transfer_result(payment, transfer_data)
            elif verification.get('status') is True and transfer_data.get('status') in ['failed', 'reversed']:
                _apply_paystack_transfer_result(payment, transfer_data)
        except Exception as exc:
            logger.error(f"Payment status polling failed for {reference}: {exc}")

    return Response({
        'status': True,
        'payment_status': payment.status,
        'is_completed': payment.status == 'completed',
        'reference': reference,
        'amount': float(payment.net_amount),
        'employee_name': payment.employee.name if payment.employee else None,
        'payment_date': payment.payment_date.isoformat() if payment.payment_date else None,
        # ADD THESE FIELDS:
        'paystack_otp_required': payment.status == 'pending_paystack_otp',
        'paystack_transfer_code': payment.paystack_transfer_code if payment.status == 'pending_paystack_otp' else None,
    }, status=status.HTTP_200_OK)


# ─────────────────────────────────────────
# USER VIEWSET
# ─────────────────────────────────────────

class UserViewSet(viewsets.ModelViewSet):
    queryset = User.objects.all().order_by('id')
    serializer_class = UserSerializer

    def get_permissions(self):
        if self.action == "export_csv":
            return [AllowAny()]
        if self.action == "create":
            return [IsAdmin()]
        if self.request.user.is_authenticated:
            if self.request.user.role in ['staff', 'guard']:
                if self.action in ['list', 'retrieve']:
                    return [IsAuthenticated()]
                return [IsAdmin()]
        return [IsAuthenticated()]

    def destroy(self, request, *args, **kwargs):
        if not (request.user.is_superuser or getattr(request.user, "is_employee_admin", False)):
            return Response(
                {"error": "Only admins can delete users"},
                status=status.HTTP_403_FORBIDDEN
            )
        return super().destroy(request, *args, **kwargs)

    def get_queryset(self):
        user = self.request.user
        if user.is_superuser:
            return User.objects.all().order_by('id')
        if user.role == 'admin':
            return User.objects.filter(role__in=['staff', 'guard']).order_by('id')
        if getattr(user, 'is_hr_admin', False):
             return User.objects.all().order_by('id')
        return User.objects.filter(id=user.id).order_by('id')

    @action(detail=False, methods=['get'], permission_classes=[IsAuthenticated])
    def me(self, request):
        serializer = self.get_serializer(request.user)
        return Response(serializer.data)


# ─────────────────────────────────────────
# EMPLOYEE VIEWSET
# ─────────────────────────────────────────

class EmployeeViewSet(viewsets.ModelViewSet):
    authentication_classes = [JWTAuthentication, SessionAuthentication, BasicAuthentication]
    queryset = Employee.objects.all().order_by('-created_at')
    serializer_class = EmployeeSerializer
    filterset_fields = ['type', 'status', 'location']
    search_fields = ['name', 'employee_id', 'email']

    def get_permissions(self):
        user = self.request.user
        if self.action == 'create':
            return [IsAuthenticated(), CanCreateEmployee()]
        if user.is_authenticated and user.role in ['staff', 'guard']:
            if self.action in ['list', 'retrieve']:
                return [IsAuthenticated()]
            return [IsAdmin()]
        return [IsAuthenticated()]

    def destroy(self, request, *args, **kwargs):
        employee = self.get_object()
        with transaction.atomic():
            employee.status = 'terminated'
            employee.save()
            employee.user.is_active = False
            employee.user.save()
            SackedEmployee.objects.create(
                employee=employee,
                date_sacked=timezone.now().date(),
                offense='Deleted by admin',
                terminated_by=request.user
            )
            Notification.objects.create(
                user=employee.user,
                message=f"Employee {employee.employee_id} - {employee.name} has been terminated (deleted by admin).",
                type='warning'
            )
        return Response(
            {'message': 'Employee has been terminated and moved to sacked list'},
            status=status.HTTP_200_OK
        )

    def get_queryset(self):
        user = self.request.user
        if user.is_superuser or user.role == 'admin' or getattr(user, 'is_hr_admin', False) or getattr(user, 'is_employee_admin', False):
            return Employee.objects.filter(status__in=['active', 'pending']).order_by('-created_at')
        return Employee.objects.filter(user=user).order_by('-created_at')

    def create(self, request, *args, **kwargs):
        logger.info("Employee create requested by user_id=%s", getattr(request.user, "id", None))
        return super().create(request, *args, **kwargs)

    def get_throttles(self):
        if self.action in ['request_export', 'export_csv']:
            return [ExportThrottle()]
        return []

    @action(detail=True, methods=['post'],
            permission_classes=[IsAuthenticated, IsSackAdmin])
    def terminate(self, request, pk=None):
        employee = self.get_object()
        offense = request.data.get('offense')

        if not offense:
            return Response({'error': 'Offense reason required'}, status=400)

        with transaction.atomic():
            SackedEmployee.objects.create(
                employee=employee,
                date_sacked=timezone.now().date(),
                offense=offense,
                terminated_by=request.user
            )
            employee.status = 'terminated'
            employee.save()
            employee.user.is_active = False
            employee.user.save()

            Notification.objects.create(
                user=employee.user,
                message=f"Employee {employee.employee_id} - {employee.name} has been terminated. Reason: {offense}",
                type='warning'
            )

        logger.info(f"{request.user.username} terminated {employee.name}. Offense: {offense}")
        return Response({'message': 'Employee terminated successfully'})

    @action(detail=True, methods=['post'],
            permission_classes=[IsAuthenticated, IsSackAdmin])
    def resign(self, request, pk=None):
        """Process employee resignation"""
        employee = self.get_object()
        reason = request.data.get('reason', 'Resigned')

        with transaction.atomic():
            SackedEmployee.objects.create(
                employee=employee,
                date_sacked=timezone.now().date(),
                offense=f"Resigned: {reason}",
                terminated_by=request.user
            )
            employee.status = 'resigned'
            employee.save()
            employee.user.is_active = False
            employee.user.save()

            Notification.objects.create(
                user=employee.user,
                message=f"Resignation processed for {employee.name}. Reason: {reason}",
                type='info'
            )

        logger.info(f"Admin {request.user.username} approved resignation for {employee.name}")
        return Response({'message': 'Resignation processed successfully'})

    @action(detail=True, methods=['post'], permission_classes=[IsAdmin])
    def resend_confirmation(self, request, pk=None):
        """Resend registration HTML emails to admin and employee"""
        employee = self.get_object()
        auth_views.send_registration_notifications(employee, request)
        
        log_audit(
            request.user,
            f"Admin resent registration confirmation email for employee {employee.name} (ID: {employee.employee_id})",
            request,
            extra={'employee_id': str(employee.id), 'employee_name': employee.name}
        )
        return Response({'message': 'Confirmation emails resent successfully'})

    @action(detail=True, methods=['post'], permission_classes=[IsAdmin])
    def approve(self, request, pk=None):
        """Approve a self-registered employee"""
        employee = self.get_object()
        if employee.status != 'pending':
            return Response({'error': 'Only pending employees can be approved'}, status=status.HTTP_400_BAD_REQUEST)

        with transaction.atomic():
            employee.status = 'active'
            employee.save()
            
            user = employee.user
            user.is_active = True
            user.save()

            Notification.objects.create(
                user=user,
                message=f"Welcome! Your account (ID: {employee.employee_id}) has been approved and is now active.",
                type='success'
            )

        logger.info(f"Admin {request.user.username} approved employee {employee.employee_id}")
        return Response({'message': 'Employee approved and account activated successfully'})

    @action(detail=False, methods=['post'], permission_classes=[IsAdmin])
    def bulk_approve(self, request):
        """Approve multiple self-registered employees at once"""
        ids = request.data.get('ids', [])
        if not ids:
            return Response({'error': 'No employee IDs provided'}, status=status.HTTP_400_BAD_REQUEST)
        
        with transaction.atomic():
            employees = Employee.objects.filter(id__in=ids, status='pending')
            count = employees.count()
            for employee in employees:
                employee.status = 'active'
                employee.save()
                
                user = employee.user
                user.is_active = True
                user.save()

                Notification.objects.create(
                    user=user,
                    message=f"Welcome! Your account (ID: {employee.employee_id}) has been approved.",
                    type='success'
                )
        return Response({'message': f'Successfully approved {count} employees'})

    @action(detail=False, methods=['get'], permission_classes=[IsAuthenticated])
    def dashboard_stats(self, request):
        """Get dashboard statistics"""
        # Unified logic: Stats only count 'active' employees. Sacked/Resigned IDs remain locked.
        active_qs = Employee.objects.filter(status='active')
        
        # Location filtering
        location = request.query_params.get('location')
        if location:
            active_qs = active_qs.filter(location=location)

        total_staff = active_qs.filter(type='staff').count()
        total_guards = active_qs.filter(type='guard').count()
        total_self_registered = active_qs.filter(is_self_registered=True).count()

        # Calculate exact financial totals for the current month
        today = timezone.now().date()
        deduction_qs = Deduction.objects.filter(
            status='applied',
            date__year=today.year,
            date__month=today.month,
        )
        if location:
            deduction_qs = deduction_qs.filter(employee__location=location)
        
        # Added safety for aggregation
        deduction_agg = deduction_qs.aggregate(total=Sum('amount'))
        total_deductions = deduction_agg['total'] or 0

        # Attendance today
        attendance_qs = Attendance.objects.filter(date=today)
        if location:
            attendance_qs = attendance_qs.filter(employee__location=location)
            
        attendance_stats = {
            'present': attendance_qs.filter(status='present').count(),
            'absent': attendance_qs.filter(status='absent').count(),
            'leave': attendance_qs.filter(status='leave').count(),
        }

        current_month = timezone.now().strftime('%Y-%m')
        payment_qs = Payment.objects.filter(
            payment_month=current_month,
            status='completed'
        )
        if location:
            payment_qs = payment_qs.filter(employee__location=location)
        payment_agg = payment_qs.aggregate(total=Sum('net_amount'))
        total_paid_this_month = payment_agg['total'] or 0

        # Monthly Salary Summary (Last 6 Months)
        salary_summary = []
        curr_month = today.replace(day=1)
        for i in range(5, -1, -1):
            m = curr_month.month - i
            y = curr_month.year
            while m <= 0:
                m += 12
                y -= 1
            
            target_date = curr_month.replace(year=y, month=m)
            month_str = target_date.strftime('%b')
            month_key = target_date.strftime('%Y-%m')
            
            summary_payment_qs = Payment.objects.filter(payment_month=month_key, status='completed')
            if location:
                summary_payment_qs = summary_payment_qs.filter(employee__location=location)
            amount = summary_payment_qs.aggregate(Sum('net_amount'))['net_amount__sum'] or 0
            salary_summary.append({'month': month_str, 'amount': float(amount)})

        recent_payments_qs = Payment.objects.all()
        if location:
            recent_payments_qs = recent_payments_qs.filter(employee__location=location)

        return Response({
            'total_staff': total_staff,
            'total_guards': total_guards,
            'total_self_registered': total_self_registered,
            'total_deductions': total_deductions,
            'total_payments': total_paid_this_month,
            'attendance_today': attendance_stats,
            'salary_summary': salary_summary,
            'recent_employees': EmployeeSerializer(active_qs.order_by('-created_at')[:5], many=True).data,
            'recent_payments': PaymentSerializer(recent_payments_qs.order_by('-created_at')[:5], many=True).data
        })

    @action(detail=True, methods=['get'], permission_classes=[IsAuthenticated])
    def net_salary(self, request, pk=None):
        """Get specific net salary for an employee after applied deductions this month"""
        employee = self.get_object()
        month_key = timezone.now().strftime('%Y-%m')
        applied = applied_deductions_for_month(employee, month_key).aggregate(Sum('amount'))['amount__sum'] or 0
        return Response({
            'base_salary': float(employee.salary),
            'pending_deductions': float(applied),
            'applied_deductions': float(applied),
            'net_salary': float(employee.salary - applied)
        })

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated])
    def request_export(self, request):
        """Request export token for employee data"""
        password = request.data.get('password')
        filters = request.data.get('filters', {})

        if not password or not request.user.check_password(password):
            return Response({'error': 'Invalid password'}, status=status.HTTP_403_FORBIDDEN)

        user = request.user
        if not (user.is_superuser or user.role == 'admin'):
            return Response({'error': 'Insufficient permissions'}, status=status.HTTP_403_FORBIDDEN)

        token = secrets.token_urlsafe(32)
        otp = ''.join(random.choices(string.digits, k=6))
        
        export_token = ExportToken.objects.create(
            user=user,
            token=token,
            data_type='employees',
            filters=filters,
            expires_at=timezone.now() + timezone.timedelta(minutes=10),
            otp_code=otp
        )

        send_mail(
            'Export Verification Code',
            f'Your 2FA code for employee data export is: {otp}. Valid for 10 minutes.',
            settings.DEFAULT_FROM_EMAIL,
            [user.email],
            fail_silently=False,
        )

        logger.info(f"Export token created and 2FA sent for {user.username}")
        return Response({'token': token, '2fa_required': True})

    @action(detail=False, methods=['get'], permission_classes=[IsAuthenticated],
            authentication_classes=[JWTAuthentication, SessionAuthentication, BasicAuthentication])
    def export_csv(self, request):
        """Export employee data as CSV using token"""
        token = request.query_params.get('token')
        if not token:
            return Response({'error': 'Token required'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            export_token = ExportToken.objects.get(token=token, is_used=False, user=request.user, is_2fa_verified=True)
            if export_token.is_expired():
                return Response({'error': 'Token expired'}, status=status.HTTP_400_BAD_REQUEST)

            export_token.is_used = True
            export_token.save()

            queryset = Employee.objects.all()
            filters = export_token.filters

            if filters.get('type'):
                queryset = queryset.filter(type=filters['type'])
            if filters.get('status'):
                queryset = queryset.filter(status=filters['status'])
            if filters.get('location'):
                queryset = queryset.filter(location=filters['location'])

            response = HttpResponse(content_type='text/csv')
            response['Content-Disposition'] = 'attachment; filename="employees.csv"'

            writer = csv.writer(response)
            writer.writerow([
                'Employee ID', 'Name', 'Type', 'Location', 'Salary',
                'Email', 'Phone', 'Bank Name', 'Account Number',
                'Bank Code', 'Status', 'Join Date'
            ])

            for employee in queryset:
                writer.writerow([
                    employee.employee_id,
                    employee.name,
                    employee.type,
                    employee.location,
                    employee.salary,
                    employee.email or '',
                    employee.phone or '',
                    employee.bank_name,
                    employee.account_number,
                    getattr(employee, 'bank_code', ''),
                    employee.status,
                    employee.join_date
                ])

            # Log the bulk employee export
            DownloadLog.objects.create(
                user=request.user,
                employee=None,
                doc_type='employee_csv',
                reference=f"Token: {token[:8]}...",
                ip_address=get_client_ip(request)
            )

            logger.info(f"Employee export completed for {export_token.user.username}")
            return response

        except ExportToken.DoesNotExist:
            return Response({'error': 'Invalid or unverified token'}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated])
    def verify_2fa(self, request):
        token = request.data.get('token')
        otp = request.data.get('otp')
        try:
            export_token = ExportToken.objects.get(token=token, user=request.user, otp_code=otp)
            if export_token.is_expired():
                return Response({'error': 'Token expired'}, status=400)
            export_token.is_2fa_verified = True
            export_token.save()
            return Response({'success': True})
        except ExportToken.DoesNotExist:
            return Response({'error': 'Invalid verification code'}, status=400)


# ─────────────────────────────────────────
# ATTENDANCE VIEWSET
# ─────────────────────────────────────────

class AttendanceViewSet(viewsets.ModelViewSet):
    queryset = Attendance.objects.all().order_by('id')
    serializer_class = AttendanceSerializer
    filterset_fields = ['employee', 'date', 'status']
    throttle_classes = [AttendanceThrottle]

    def get_queryset(self):
        user = self.request.user
        if not user.is_authenticated:
            return Attendance.objects.none()
        if user.is_superuser or user.role == 'admin':
            return Attendance.objects.all().order_by('id')
        try:
            employee = Employee.objects.get(user=user)
            return Attendance.objects.filter(employee=employee).order_by('id')
        except Employee.DoesNotExist:
            return Attendance.objects.none()

    def get_permissions(self):
        return [IsAuthenticated()]

    def get_throttles(self):
        if self.action in ['clock_in_with_photo', 'clock_out_with_photo',
                            'clock_in', 'clock_out', 'create', 'update', 'partial_update']:
            return [AttendanceThrottle()]
        return []

    def perform_create(self, serializer):
        serializer.save()

    def _get_employee(self, request):
        employee_id = request.data.get('employee_id') or request.data.get('employee')
        can_select_employee = (
            request.user.is_superuser
            or request.user.role == 'admin'
            or getattr(request.user, 'is_employee_admin', False)
            or getattr(request.user, 'is_staff', False)
        )
        if can_select_employee:
            if employee_id:
                return Employee.objects.get(
                    Q(id=employee_id) | Q(employee_id=employee_id),
                    status='active'
                )
        return Employee.objects.get(user=request.user)

    @staticmethod
    def _decode_photo(photo_data):
        if not photo_data:
            raise ValueError("No photo provided")
        if ';base64,' in photo_data:
            header, imgstr = photo_data.split(';base64,', 1)
            ext = header.split('/')[-1] if '/' in header else 'jpg'
            ext = ext.replace('jpeg', 'jpg')
        elif 'base64' in photo_data:
            parts = photo_data.split('base64', 1)
            if len(parts) == 2:
                imgstr = parts[1].lstrip(',;:')
                ext = 'jpg'
            else:
                raise ValueError("Invalid photo format")
        else:
            imgstr = photo_data
            ext = 'jpg'
        try:
            return ext, base64.b64decode(imgstr)
        except Exception:
            raise ValueError("Invalid base64 data")

    @staticmethod
    def _photo_content_file(photo_data):
        try:
            return compress_and_validate_image(photo_data)
        except ValidationError as exc:
            message = exc.messages[0] if hasattr(exc, 'messages') and exc.messages else str(exc)
            raise ValueError(message)

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated])
    def clock_in(self, request):
        try:
            employee = self._get_employee(request)
        except Employee.DoesNotExist:
            return Response({'error': 'Employee profile not found'}, status=status.HTTP_404_NOT_FOUND)

        attendance, created = Attendance.objects.get_or_create(
            employee=employee, date=timezone.now().date()
        )
        if attendance.clock_in_timestamp:
            return Response({'error': 'Already clocked in today'}, status=status.HTTP_400_BAD_REQUEST)

        attendance.clock_in_timestamp = timezone.now()
        attendance.clock_in = timezone.now().time()
        attendance.status = 'present'

        attendance.clock_method = 'boxmark'  # Default boxmark for no-photo
        attendance.save()
        logger.info(f"Clock-in (BOXMARK) recorded for {employee.name} by {request.user.username}")
        return Response({'message': 'Clocked in (boxmark) successfully', 'status': 'present'})
    
    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated])
    def clock_out_boxmark(self, request):
        try:
            employee = self._get_employee(request)
        except Employee.DoesNotExist:
            return Response({'error': 'Employee profile not found'}, status=status.HTTP_404_NOT_FOUND)

        try:
            attendance = Attendance.objects.get(employee=employee, date=timezone.now().date())
        except Attendance.DoesNotExist:
            return Response({'error': 'No clock-in record found for today'}, status=status.HTTP_404_NOT_FOUND)

        if attendance.clock_out_timestamp:
            return Response({'error': 'Already clocked out today'}, status=status.HTTP_400_BAD_REQUEST)

        attendance.clock_out_timestamp = timezone.now()
        attendance.clock_out = timezone.now().time()
        attendance.clock_method = 'boxmark'
        attendance.save()
        logger.info(f"{request.user.username} clocked out BOXMARK")
        return Response({'message': 'Clocked out (boxmark) successfully'})


    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated])
    def clock_in_with_photo(self, request):
        try:
            employee = self._get_employee(request)
            photo_data = request.data.get('photo')
            if not photo_data:
                return Response({'error': 'Photo is required for attendance'}, status=status.HTTP_400_BAD_REQUEST)

            attendance, created = Attendance.objects.get_or_create(
                employee=employee, date=timezone.now().date()
            )
            if attendance.clock_in_timestamp:
                return Response({'error': 'Already clocked in today'}, status=status.HTTP_400_BAD_REQUEST)

            photo_file = self._photo_content_file(photo_data)
            attendance.clock_in_photo.save(
                f'clockin_{employee.id}_{timezone.now().strftime("%Y%m%d%H%M%S")}.jpg',
                photo_file, save=False
            )
            attendance.clock_in_timestamp = timezone.now()
            attendance.clock_in = timezone.now().time()
            attendance.status = 'present'
            attendance.clock_method = 'selfie'
            attendance.save()
            logger.info(f"{request.user.username} clocked in with photo")
            return Response({
                'message': 'Clocked in successfully',
                'status': 'present',
                'photo_url': attendance.clock_in_photo.url if attendance.clock_in_photo else None,
            })
        except Employee.DoesNotExist:
            return Response({'error': 'Employee profile not found'}, status=status.HTTP_404_NOT_FOUND)
        except ValueError as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as exc:
            logger.error(f"Clock-in with photo failed: {exc}", exc_info=True)
            return Response({'error': 'Failed to save attendance photo'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated])
    def clock_out(self, request):
        try:
            employee = self._get_employee(request)
        except Employee.DoesNotExist:
            return Response({'error': 'Employee profile not found'}, status=status.HTTP_404_NOT_FOUND)

        try:
            attendance = Attendance.objects.get(employee=employee, date=timezone.now().date())
        except Attendance.DoesNotExist:
            return Response({'error': 'No clock-in record found for today'}, status=status.HTTP_404_NOT_FOUND)

        if attendance.clock_out_timestamp:
            return Response({'error': 'Already clocked out today'}, status=status.HTTP_400_BAD_REQUEST)

        attendance.clock_out_timestamp = timezone.now()
        attendance.clock_out = timezone.now().time()
        attendance.clock_method = 'boxmark'
        attendance.save()
        logger.info(f"Clock-out (BOXMARK) recorded for {employee.name} by {request.user.username}")
        return Response({'message': 'Clocked out successfully'})

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated])
    def clock_out_with_photo(self, request):
        try:
            employee = self._get_employee(request)
            attendance = Attendance.objects.get(employee=employee, date=timezone.now().date())

            if attendance.clock_out_timestamp:
                return Response({'error': 'Already clocked out today'}, status=status.HTTP_400_BAD_REQUEST)

            photo_data = request.data.get('photo')
            if not photo_data:
                return Response({'error': 'Photo is required for clock out'}, status=status.HTTP_400_BAD_REQUEST)

            photo_file = self._photo_content_file(photo_data)
            attendance.clock_out_photo.save(
                f'clockout_{employee.id}_{timezone.now().strftime("%Y%m%d%H%M%S")}.jpg',
                photo_file, save=False
            )
            attendance.clock_out_timestamp = timezone.now()
            attendance.clock_out = timezone.now().time()
            attendance.status = 'present'
            attendance.clock_method = 'selfie'
            attendance.save()
            logger.info(f"{request.user.username} clocked out with photo")
            return Response({
                'message': 'Clocked out successfully',
                'photo_url': attendance.clock_out_photo.url if attendance.clock_out_photo else None,
            })
        except Employee.DoesNotExist:
            return Response({'error': 'Employee profile not found'}, status=status.HTTP_404_NOT_FOUND)
        except Attendance.DoesNotExist:
            return Response({'error': 'No clock-in record found for today'}, status=status.HTTP_404_NOT_FOUND)
        except ValueError as exc:
            return Response({'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception as exc:
            logger.error(f"Clock-out with photo failed: {exc}", exc_info=True)
            return Response({'error': 'Failed to save attendance photo'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated])
    def mark_leave(self, request):
        employee_id = request.data.get('employee_id')
        start_date = request.data.get('start_date')
        end_date = request.data.get('end_date')
        reason = request.data.get('reason', '')

        if not all([employee_id, start_date, end_date]):
            return Response(
                {'error': 'employee_id, start_date, and end_date are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            employee = Employee.objects.get(id=employee_id)
        except Employee.DoesNotExist:
            return Response({'error': 'Employee not found'}, status=status.HTTP_404_NOT_FOUND)

        try:
            start = datetime.strptime(start_date, '%Y-%m-%d').date()
            end = datetime.strptime(end_date, '%Y-%m-%d').date()
        except ValueError:
            return Response({'error': 'Invalid date format. Use YYYY-MM-DD'}, status=status.HTTP_400_BAD_REQUEST)

        if start > end:
            return Response({'error': 'Start date cannot be after end date'}, status=status.HTTP_400_BAD_REQUEST)

        leave_records = []
        current = start
        while current <= end:
            attendance, created = Attendance.objects.get_or_create(
                employee=employee,
                date=current,
                defaults={
                    'status': 'leave', 
                    'clock_in': None, 
                    'clock_out': None,
                    'leave_start': start,
                    'leave_end': end
                }
            )
            if not created and not attendance.clock_in_timestamp:
                attendance.status = 'leave'
                attendance.leave_start = start
                attendance.leave_end = end
                attendance.save()

            leave_records.append({'date': current.isoformat(), 'status': attendance.status})
            current += timedelta(days=1)

        Notification.objects.create(
            user=employee.user,
            message=f"Leave marked from {start_date} to {end_date}. Reason: {reason}",
            type='info'
        )

        return Response({'message': f'Leave marked for {len(leave_records)} days', 'records': leave_records})

# ─────────────────────────────────────────
# PAYMENT VIEWSET
# ─────────────────────────────────────────

class PaymentViewSet(viewsets.ModelViewSet):
    queryset = Payment.objects.all().order_by('id')
    serializer_class = PaymentSerializer
    filterset_fields = ['employee', 'status', 'payment_date']
    throttle_classes = [PaymentThrottle]

    def get_permissions(self):
        if self.action in ["initiate_payment", "create", "update", "partial_update", "destroy"]:
            return [IsAuthenticated(), IsPayrollAdmin()]
        if  self.action in ["hr_approve", "bulk_hr_approve"]:
            return [IsAuthenticated(), IsHRAdmin()]
        return [IsAuthenticated()]

    def get_throttles(self):
        if self.action == 'bulk_payment':
            return [BulkPaymentThrottle()]
        elif self.action in ['initiate_payment', 'create']:
            return [PaymentThrottle()]
        return []

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated, IsPayrollAdmin])
    def sync_processing_payments(self, request):
        """Backend logic to check all processing payments against Paystack API"""
        processing_payments = Payment.objects.filter(status='processing')
        updated_count = 0
        paystack = PaystackAPI()

        for payment in processing_payments:
            try:
                res = paystack.verify_transfer(payment.transaction_reference)
                if res.get('status'):
                    data = res.get('data', {})
                    if data.get('status') == 'success':
                        with transaction.atomic():
                            payment = Payment.objects.select_for_update().get(pk=payment.pk)
                            _apply_paystack_transfer_result(payment, data)
                        updated_count += 1
                    elif data.get('status') in ['failed', 'reversed']:
                        with transaction.atomic():
                            payment = Payment.objects.select_for_update().get(pk=payment.pk)
                            _apply_paystack_transfer_result(payment, data)
                        updated_count += 1
            except Exception as e:
                logger.error(f"Sync error for {payment.transaction_reference}: {e}")

        return Response({
            'message': f'Sync complete. {updated_count} payments updated.',
            'checked': processing_payments.count()
        })

    def get_queryset(self):
        user = self.request.user
        if user.is_superuser or user.role == 'admin' or getattr(user, 'is_hr_admin', False):
            return Payment.objects.all().order_by('id')
        if getattr(user, 'is_payment_admin', False):
             return Payment.objects.all().order_by('id')
        return Payment.objects.filter(employee__user=user).order_by('id')

    @action(detail=False, methods=['get'], permission_classes=[IsAuthenticated, IsPayrollAdmin])
    def paystack_balance(self, request):
        """
        NEW: Check Paystack wallet balance before running payroll.
        Warn admin if balance is insufficient.
        """
        paystack = PaystackAPI()
        result = paystack.get_transfer_balance()

        if result.get('status'):
            balances = result.get('data', [])
            ngn_balance = next(
                (b for b in balances if b.get('currency') == 'NGN'), None
            )
            if ngn_balance:
                balance_kobo = ngn_balance.get('balance', 0)
                balance_naira = balance_kobo / 100
                return Response({
                    'balance': balance_naira,
                    'balance_formatted': f"₦{balance_naira:,.2f}",
                    'currency': 'NGN'
                })

        return Response(
            {'error': 'Could not fetch balance', 'detail': result.get('message')},
            status=status.HTTP_400_BAD_REQUEST
        )

    def _get_or_create_paystack_recipient(self, employee, paystack):
        """
        Helper to ensure employee has a Paystack recipient code.
        Raises ValueError if creation fails.
        """
        recipient_code = getattr(employee, 'paystack_recipient_code', None)
        if recipient_code:
            return recipient_code

        bank_code = get_employee_bank_code(employee)
        if not bank_code:
            raise ValueError(f"Employee {employee.name} bank_code is missing.")
            
        recipient_result = paystack.create_recipient(
            name=employee.name,
            account_number=employee.account_number,
            bank_code=bank_code
        )
        if not recipient_result.get('status'):
            raise ValueError(f"Paystack recipient creation failed: {recipient_result.get('message')}")
        
        recipient_code = recipient_result.get('data', {}).get('recipient_code') or recipient_result.get('recipient_code')
        if not recipient_code:
            raise ValueError('Paystack recipient creation failed: missing recipient code')
        
        employee.paystack_recipient_code = recipient_code
        employee.save(update_fields=['paystack_recipient_code'])
        return recipient_code

    def _execute_paystack_transfer(self, payment, employee, bank_code):
        """
        Helper to handle the actual Paystack recipient creation and transfer initiation.
        Returns (success_bool, message_or_data)
        """
        paystack = PaystackAPI()

        try:
            recipient_code = self._get_or_create_paystack_recipient(employee, paystack)
        except ValueError as e:
            payment.status = 'failed'
            payment.save(update_fields=['status', 'updated_at'])
            return False, str(e)

        # 2. Initiate the actual transfer
        transfer_result = paystack.initiate_transfer(
            amount=int(payment.net_amount * 100),
            recipient_code=recipient_code,
            reference=payment.transaction_reference,
            reason=f"Salary - {employee.name} ({employee.employee_id})"
        )

        if transfer_result.get('status'):
            data = transfer_result.get('data', {})
            _apply_paystack_transfer_result(payment, data)
            return True, {
                'message': 'Payment confirmed by Paystack.' if payment.status == 'completed' else 'Payment initiated on Paystack.',
                'paystack_otp_required': payment.status == 'pending_paystack_otp',
                'status': payment.status
            }
        else:
            payment.status = 'failed'
            payment.save(update_fields=['status', 'updated_at'])
            return False, f"Paystack API error: {transfer_result.get('message')}"


    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated, IsPayrollAdmin, IsAdmin])
    def initiate_payment(self, request):
        """
        Initiate salary payment (Full or Partial)
        """
        employee_id = request.data.get('employee_id')
        custom_amount = request.data.get('custom_amount')

        if not employee_id:
            return Response({'error': 'Employee ID required'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            employee = Employee.objects.get(id=employee_id, status='active')
        except Employee.DoesNotExist:
            return Response({'error': 'Employee not found or not active'}, status=status.HTTP_404_NOT_FOUND)

        # Validate bank details
        if not employee.account_number or not employee.bank_name:
            return Response(
                {'error': 'Employee has no bank account details'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # bank_code is required for Paystack transfers
        bank_code = get_employee_bank_code(employee)
        if not bank_code:
            return Response(
                {'error': 'Employee bank_code is missing. Update employee record first.'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # RESTRICTION: Payroll admin cannot pay themselves without HR/Superuser approval
        if str(employee.user.id) == str(request.user.id):
            if not (request.user.is_superuser or getattr(request.user, 'is_hr_admin', False)):
                return Response({'error': 'Self-payment requires HR Admin or Superuser approval'}, 
                                status=status.HTTP_403_FORBIDDEN)

        with transaction.atomic():
            # Prevent double payment per employee per month (unless failed)
            payment_month = None
            is_partial = False
            total_deductions = 0

            # Set initial status based on role
            initial_status = 'pending'
            if not (request.user.is_superuser or getattr(request.user, 'is_hr_admin', False)):
                initial_status = 'pending_hr'

            if custom_amount:
                try:
                    net_salary = Decimal(str(custom_amount))
                    is_partial = True
                    if net_salary <= 0:
                        raise ValueError
                except (ValueError, InvalidOperation):
                    return Response({'error': 'Invalid custom amount'}, status=status.HTTP_400_BAD_REQUEST)
            else:
                payment_month = timezone.now().strftime('%Y-%m')
                existing_payment = Payment.objects.filter(
                    employee=employee,
                    payment_month=payment_month,
                ).first()

                if existing_payment:
                    # FIX 1 + FIX 2: Allow retry if previous payment failed or stuck in OTP state
                    if existing_payment.status in ['failed', 'pending_paystack_otp']:
                        if existing_payment.status == 'pending_paystack_otp':
                            # FIX 2: Check if OTP is still valid with Paystack
                            if _is_paystack_otp_still_valid(existing_payment):
                                return Response({
                                    'error': 'Payment awaiting Paystack OTP. Use the OTP modal to complete.',
                                    'status': 'pending_paystack_otp',
                                    'reference': existing_payment.transaction_reference,
                                    'paystack_transfer_code': existing_payment.paystack_transfer_code,
                                }, status=status.HTTP_400_BAD_REQUEST)
                            else:
                                # OTP expired or transfer failed on Paystack side - allow retry
                                old_ref = existing_payment.transaction_reference
                                existing_payment.delete()
                                logger.info(f"Auto-cleaned expired OTP payment for {employee.name}. Old ref: {old_ref}")
                        else:
                            # Failed payment - delete and allow retry
                            old_ref = existing_payment.transaction_reference
                            existing_payment.delete()
                            logger.info(f"Retrying payment for {employee.name}. Old ref {old_ref} was failed")
                    else:
                        return Response(
                            {
                                'error': f'Full salary already initiated for {payment_month}',
                                'status': existing_payment.status,
                                'reference': existing_payment.transaction_reference,
                            },
                            status=status.HTTP_400_BAD_REQUEST
                        )

                total_deductions = applied_deductions_for_month(
                    employee, payment_month
                ).aggregate(Sum('amount'))['amount__sum'] or 0
                net_salary = employee.salary - total_deductions

            if net_salary <= 0:
                return Response(
                    {'error': 'Net salary is zero or negative after deductions'},
                    status=status.HTTP_400_BAD_REQUEST
                )

            try:
                payment = Payment.objects.create(
                    employee=employee,
                    base_salary=employee.salary,
                    total_deductions=total_deductions,
                    net_amount=net_salary,
                    transaction_reference=str(uuid.uuid4()),
                    payment_date=timezone.now().date(),
                    payment_month=payment_month,
                    processed_by=request.user,
                    status=initial_status,
                    is_partial=is_partial,
                    payment_method='bank_transfer'
                )
            except ValidationError as exc:
                return Response({'error': exc.message_dict if hasattr(exc, 'message_dict') else exc.messages}, status=status.HTTP_400_BAD_REQUEST)
            
            if initial_status == 'pending_hr':
                hr_admins = User.objects.filter(
                    Q(is_superuser=True) | Q(is_hr_admin=True)
                )
                for hr in hr_admins:
                    Notification.objects.create(
                        user=hr,
                        message=f"Payment for {employee.name} ({employee.employee_id}) requires HR approval. Amount: ₦{net_salary:,.2f}",
                        type='warning'
                    )

            # Since Internal OTP flow is removed, trigger Paystack immediately only
            # when this payment does not need HR approval.
            if initial_status == 'pending':
                success, result = self._execute_paystack_transfer(payment, employee, bank_code)
                if success:
                    return Response({
                        'message': result['message'],
                        'reference': payment.transaction_reference,
                        'paystack_reference': payment.paystack_reference,
                        'paystack_transfer_code': payment.paystack_transfer_code,
                        'amount': float(net_salary),
                        'status': result['status'],
                        'paystack_otp_required': result['paystack_otp_required'],
                        'employee': employee.name
                    })
                else:
                    return Response({'error': result}, status=status.HTTP_400_BAD_REQUEST)

            return Response({
                'message': 'Payment initiated and awaiting HR approval.',
                'reference': payment.transaction_reference,
                'amount': float(net_salary),
                'employee': employee.name,
                'bank': employee.bank_name,
                'account': employee.account_number,
            })

    @action(detail=True, methods=['post'], permission_classes=[IsAuthenticated, IsHRAdmin])
    def hr_approve(self, request, pk=None):
        """
        HR Admin action to approve a payment that was initiated by a payroll user.
        """
        # Remove the manual superuser/HR check — permission_classes handles it
        payment = self.get_object()
        if payment.status != 'pending_hr':
            return Response({'error': 'Payment is not awaiting HR approval'}, 
                            status=status.HTTP_400_BAD_REQUEST)
            
        employee = payment.employee
        bank_code = get_employee_bank_code(employee)
        
        with transaction.atomic():
            payment.status = 'pending'
            payment.hr_approved = True
            payment.hr_approved_by = request.user
            payment.save(update_fields=['status', 'hr_approved', 'hr_approved_by', 'updated_at'])
            
            success, result = self._execute_paystack_transfer(payment, employee, bank_code)
            if success:
                return Response({
                    'message': f"Payment approved. {result['message']}",
                    'reference': payment.transaction_reference,
                    'status': result['status'],
                    'paystack_otp_required': result['paystack_otp_required']
                })
            else:
                return Response({'error': result}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated, IsHRAdmin])
    def bulk_hr_approve(self, request):
        """
        HR Admin action to approve multiple pending payments at once.
        """
        payment_ids = request.data.get('payment_ids', [])
        if not payment_ids:
            return Response({'error': 'No payments selected'}, status=status.HTTP_400_BAD_REQUEST)

        approved_count = 0
        errors = []
        
        for pid in payment_ids:
            try:
                payment = Payment.objects.get(id=pid, status='pending_hr')
                employee = payment.employee
                bank_code = get_employee_bank_code(employee)
                
                with transaction.atomic():
                    payment.status = 'pending'
                    payment.hr_approved = True
                    payment.hr_approved_by = request.user
                    payment.save(update_fields=['status', 'hr_approved', 'hr_approved_by', 'updated_at'])
                    
                    success, result = self._execute_paystack_transfer(payment, employee, bank_code)
                    if success:
                        approved_count += 1
                    else:
                        errors.append(f"{employee.name}: {result}")
            except Payment.DoesNotExist:
                errors.append(f"Payment {pid} not found or not awaiting HR approval")
            except Exception as e:
                errors.append(f"Error processing payment {pid}: {str(e)}")

        return Response({
            'message': f'Approved {approved_count} payments.',
            'errors': errors
        })

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated, IsPayrollAdmin])
    def bulk_payment(self, request):
        """
        Initiate multiple transfers.

        Internal OTP authorization has been removed; security is handled by:
        - authenticated access (IsPayrollAdmin)
        - Paystack transfer status + webhook confirmation
        """

        employee_ids = request.data.get('employee_ids', [])
        if not employee_ids:
            return Response({'error': 'No employees selected'}, status=status.HTTP_400_BAD_REQUEST)

        paystack = PaystackAPI()
        payments_created = []
        local_payments = []
        transfers_payload = []
        errors = []
        total_amount = 0
        current_month = timezone.now().strftime('%Y-%m')

        for emp_id in employee_ids:
            try:
                employee = Employee.objects.get(id=emp_id, status='active')

                # Prevent double payment in bulk
                existing_payment = Payment.objects.filter(
                    employee=employee, 
                    payment_month=current_month
                ).first()
                
                if existing_payment:
                    errors.append(f"{employee.name}: payment already exists for {current_month} ({existing_payment.status})")
                    continue

                bank_code = get_employee_bank_code(employee)
                if not bank_code:
                    errors.append(f"{employee.name}: missing bank_code")
                    continue

                pending_deductions = applied_deductions_for_month(
                    employee, current_month
                ).aggregate(Sum('amount'))['amount__sum'] or 0

                net_amount = employee.salary - pending_deductions
                total_amount += float(net_amount)

                payment = Payment.objects.create(
                    employee=employee,
                    base_salary=employee.salary,
                    total_deductions=pending_deductions,
                    net_amount=net_amount,
                    transaction_reference=str(uuid.uuid4()),
                    payment_date=timezone.now().date(),
                    payment_month=current_month,
                    processed_by=request.user,
                    status='processing',
                    payment_method='bank_transfer'
                )


                # Get or create recipient
                recipient_code = getattr(employee, 'paystack_recipient_code', None)
                if not recipient_code:
                    recipient_result = paystack.create_recipient(
                        name=employee.name,
                        account_number=employee.account_number,
                        bank_code=bank_code
                    )
                    if not recipient_result.get('status'):
                        payment.status = 'failed'
                        payment.save()
                        errors.append(
                            f"{employee.name}: recipient creation failed - "
                            f"{recipient_result.get('message')}"
                        )
                        continue

                    recipient_code = recipient_result.get('data', {}).get('recipient_code') or recipient_result.get('recipient_code')
                    if hasattr(employee, 'paystack_recipient_code'):
                        employee.paystack_recipient_code = recipient_code
                        employee.save(update_fields=['paystack_recipient_code'])

                transfers_payload.append({
                    "amount": int(net_amount * 100),
                    "recipient": recipient_code,
                    "reference": payment.transaction_reference,
                    "reason": f"Salary - {employee.name} ({employee.employee_id})"
                })

                payments_created.append({
                    'employee_id': employee.employee_id,
                    'employee_name': employee.name,
                    'bank': f"{employee.bank_name} - {employee.account_number}",
                    'net_salary': float(net_amount),
                    'reference': payment.transaction_reference,
                })
                local_payments.append(payment)

            except Employee.DoesNotExist:
                errors.append(f"Employee ID {emp_id} not found or not active")
            except Exception as e:
                errors.append(f"Error for employee ID {emp_id}: {str(e)}")

        # Fire bulk transfer in one API call
        if transfers_payload:
            bulk_result = paystack.bulk_transfer(transfers_payload)
            if not bulk_result.get('status'):
                logger.error(f"Bulk transfer API error: {bulk_result.get('message')}")
                errors.append(f"Bulk transfer error: {bulk_result.get('message')}")
                failed_ids = [payment.id for payment in local_payments]
                Payment.objects.filter(id__in=failed_ids, status='processing').update(status='failed')
                payments_created = []
                total_amount = 0

        return Response({
            'message': f'Initiated {len(payments_created)} salary transfers',
            'total_amount': total_amount,
            'total_employees': len(payments_created),
            'payments': payments_created,
            'errors': errors,
            'note': 'Payments will be confirmed automatically via webhook'
        })

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated])
    def verify_payment(self, request):
        """
        Handles two scenarios:
        1. Initial payment initiation with internal OTP (legacy flow)
        2. Submit Paystack OTP to finalize a transfer that requires it
        """
        reference = request.data.get('reference')
        otp_code = request.data.get('otp')
        paystack_otp = request.data.get('paystack_otp')

        if not reference:
            return Response({'error': 'Reference required'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            payment = Payment.objects.get(transaction_reference=reference)
        except Payment.DoesNotExist:
            return Response({'error': 'Payment not found'}, status=status.HTTP_404_NOT_FOUND)

        # SCENARIO 1: Paystack OTP submission (payment is in pending_paystack_otp state)
        if paystack_otp and payment.status == PaymentStatus.PENDING_PAYSTACK_OTP:
            if not payment.paystack_transfer_code:
                return Response({
                    'error': 'No Paystack transfer code found for this payment'
                }, status=status.HTTP_400_BAD_REQUEST)

            paystack = PaystackAPI()
            finalize_result = paystack.finalize_transfer(
                payment.paystack_transfer_code, 
                paystack_otp
            )

            if finalize_result.get('status'):
                finalize_status = finalize_result.get('data', {}).get('status')
                if finalize_status == 'success':
                    with transaction.atomic():
                        payment.status = PaymentStatus.COMPLETED
                        payment.paystack_reference = str(finalize_result.get('data', {}).get('id', '') or '')
                        payment.save()

                        Notification.objects.create(
                            user=payment.employee.user,
                            message=(
                                f"Payment credited for {payment.employee.employee_id} - "
                                f"{payment.employee.name}: ₦{payment.net_amount}"
                            ),
                            type='success'
                        )
                    return Response({
                        'message': 'Payment finalized and completed successfully',
                        'payment_completed': True,
                        'status': 'completed'
                    })

                elif finalize_status in ['failed', 'reversed']:
                    payment.status = PaymentStatus.FAILED
                    payment.save()
                    return Response({
                        'error': 'Paystack transfer failed during finalization',
                        'payment_failed': True,
                        'status': 'failed'
                    }, status=status.HTTP_400_BAD_REQUEST)

                else:  # still processing
                    payment.status = PaymentStatus.PROCESSING
                    payment.save()
                    return Response({
                        'message': 'Paystack transfer finalized, awaiting confirmation',
                        'payment_processing': True,
                        'status': 'processing'
                    })

            else:
                payment.status = PaymentStatus.FAILED
                payment.save()
                return Response({
                    'error': f"Paystack finalization failed: {finalize_result.get('message')}"
                }, status=status.HTTP_400_BAD_REQUEST)

        # SCENARIO 2: Internal OTP verification (legacy flow - only if payment is pending)
        if payment.status == PaymentStatus.PENDING and otp_code:
            try:
                otp = OTP.objects.get(reference=reference, code=otp_code, is_used=False)
                if otp.has_expired():
                    return Response({'error': 'OTP has expired'}, status=status.HTTP_400_BAD_REQUEST)
                if otp.attempt_count >= 3:
                    return Response({'error': 'Too many failed OTP attempts'}, status=status.HTTP_400_BAD_REQUEST)
                
                otp.is_used = True
                otp.save()

                # Now initiate Paystack transfer
                paystack = PaystackAPI()
                employee = payment.employee
                bank_code = get_employee_bank_code(employee)
                
                if not bank_code:
                    return Response({'error': 'Employee bank_code is missing.'}, status=status.HTTP_400_BAD_REQUEST)

                # Get or create recipient
                recipient_code = getattr(employee, 'paystack_recipient_code', None)
                if not recipient_code:
                    recipient_result = paystack.create_recipient(
                        name=employee.name, 
                        account_number=employee.account_number, 
                        bank_code=bank_code
                    )
                    if not recipient_result or not recipient_result.get('status'):
                        payment.status = PaymentStatus.FAILED
                        payment.save()
                        return Response({
                            'error': f"Failed to create recipient: {recipient_result.get('message')}"
                        }, status=status.HTTP_400_BAD_REQUEST)
                    recipient_code = recipient_result.get('recipient_code')
                    employee.paystack_recipient_code = recipient_code
                    employee.save(update_fields=['paystack_recipient_code'])

                # Initiate transfer
                transfer_result = paystack.initiate_transfer(
                    amount=int(payment.net_amount * 100),
                    recipient_code=recipient_code,
                    reference=payment.transaction_reference,
                    reason=f"Salary - {employee.name} ({employee.employee_id})"
                )

                if transfer_result.get('status'):
                    transfer_data = transfer_result.get('data', {})
                    paystack_transfer_status = transfer_data.get('status')
                    paystack_transfer_code = transfer_data.get('transfer_code')
                    
                    _apply_paystack_transfer_result(payment, transfer_data)

                    if paystack_transfer_status == 'otp':
                        # Paystack requires OTP - return instructions to frontend
                        return Response({
                            'message': 'Paystack requires OTP to finalize transfer.',
                            'paystack_otp_required': True,
                            'paystack_transfer_code': paystack_transfer_code,
                            'reference': reference,
                            'status': 'pending_paystack_otp'
                        }, status=status.HTTP_200_OK)

                    elif paystack_transfer_status == 'success':
                        return Response({
                            'message': 'Payment initiated and completed successfully',
                            'payment_completed': True,
                            'status': 'completed'
                        })

                    elif paystack_transfer_status in ['failed', 'reversed']:
                        return Response({
                            'error': 'Paystack transfer failed',
                            'payment_failed': True,
                            'status': 'failed'
                        }, status=status.HTTP_400_BAD_REQUEST)

                    else:  # processing/pending
                        return Response({
                            'message': 'Payment initiated, awaiting Paystack confirmation',
                            'payment_processing': True,
                            'status': 'processing'
                        })
                else:
                    payment.status = PaymentStatus.FAILED
                    payment.save()
                    return Response({
                        'error': f"Paystack transfer initiation failed: {transfer_result.get('message')}"
                    }, status=status.HTTP_400_BAD_REQUEST)

            except OTP.DoesNotExist:
                return Response({'error': 'Invalid OTP'}, status=status.HTTP_400_BAD_REQUEST)

        # If payment is already in pending_paystack_otp but no paystack_otp provided
        if payment.status == PaymentStatus.PENDING_PAYSTACK_OTP:
            return Response({
                'message': 'This payment requires a Paystack OTP to complete.',
                'paystack_otp_required': True,
                'paystack_transfer_code': payment.paystack_transfer_code,
                'reference': reference,
                'status': 'pending_paystack_otp'
            }, status=status.HTTP_200_OK)

        # Default: just return current status
        return Response({
            'status': payment.status,
            'reference': reference,
            'is_completed': payment.status == PaymentStatus.COMPLETED,
            'amount': float(payment.net_amount),
            'employee_name': payment.employee.name if payment.employee else None,
        }, status=status.HTTP_200_OK)

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated, IsPayrollAdmin])
    def finalize_paystack_transfer(self, request):
        """
        Finalize a Paystack transfer that is pending an OTP from Paystack.
        This is called after the admin enters the OTP received from Paystack.
        """
        reference = request.data.get('reference')
        paystack_otp = request.data.get('paystack_otp')

        if not reference or not paystack_otp:
            return Response({'error': 'Reference and Paystack OTP are required'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            payment = Payment.objects.get(transaction_reference=reference, status='pending_paystack_otp')
            if not payment.paystack_transfer_code:
                payment.status = 'failed'
                payment.save()
                return Response({'error': 'No Paystack transfer code found for this payment'}, status=status.HTTP_400_BAD_REQUEST)

            paystack = PaystackAPI()
            finalize_result = paystack.finalize_transfer(payment.paystack_transfer_code, paystack_otp)

            if finalize_result.get('status'):
                finalize_status = finalize_result.get('data', {}).get('status')
                if finalize_status == 'success':
                    with transaction.atomic():
                        payment.status = 'completed'
                        payment.paystack_reference = str(finalize_result.get('data', {}).get('id', '') or '')
                        payment.save()

                        Notification.objects.create(
                            user=payment.employee.user,
                            message=(
                                f"Payment credited for {payment.employee.employee_id} - "
                                f"{payment.employee.name}: ₦{payment.net_amount}"
                            ),
                            type='success')
                    logger.info(f"Paystack transfer finalized and completed for {payment.employee.name} (Ref: {reference})")
                    return Response({'message': 'Payment finalized and completed successfully', 'payment_completed': True})

                elif finalize_status in ['failed', 'reversed']:
                    payment.status = 'failed'
                    payment.save()
                    logger.error(f"Paystack transfer failed during finalization for {payment.employee.name} (Ref: {reference})")
                    return Response({'error': 'Paystack transfer failed during finalization', 'payment_failed': True}, status=status.HTTP_400_BAD_REQUEST)

                else:  # pending/processing
                    payment.status = 'processing'
                    payment.save()
                    return Response({'message': 'Paystack transfer finalized, awaiting confirmation', 'payment_processing': True})

            else:
                # FIX 3: Distinguish between invalid OTP (retryable) and permanent failures
                error_msg = finalize_result.get('message', '').lower()
                if 'otp' in error_msg or 'invalid' in error_msg or 'incorrect' in error_msg:
                    # DON'T mark as failed - let user retry with correct OTP
                    logger.warning(f"Invalid OTP attempt for {payment.employee.name} (Ref: {reference}): {finalize_result.get('message')}")
                    return Response({
                        'error': f"Invalid OTP: {finalize_result.get('message')}",
                        'paystack_otp_required': True,
                        'paystack_transfer_code': payment.paystack_transfer_code,
                        'reference': reference,
                        'status': 'pending_paystack_otp'
                    }, status=status.HTTP_400_BAD_REQUEST)
                else:
                    # Permanent failure - mark as failed
                    payment.status = 'failed'
                    payment.save()
                    logger.error(f"Paystack finalization failed permanently for {payment.employee.name} (Ref: {reference}): {finalize_result.get('message')}")
                    return Response({'error': f"Paystack finalization failed: {finalize_result.get('message')}"}, status=status.HTTP_400_BAD_REQUEST)

        except Payment.DoesNotExist:
            return Response({'error': 'Payment not found or not in pending_paystack_otp status'}, status=status.HTTP_404_NOT_FOUND)
        except Exception as e:
            logger.error(f"Error finalizing Paystack transfer: {e}")
            return Response({'error': 'An error occurred during Paystack transfer finalization'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated])
    def resend_otp(self, request):
        reference = request.data.get('reference')
        if not reference:
            return Response({'error': 'Reference required'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            payment = Payment.objects.get(transaction_reference=reference)

            # OTP is sent to the admin who initiated the payment
            if not request.user.email:
                return Response({'error': 'Your user account has no email configured to send OTPs.'}, status=status.HTTP_400_BAD_REQUEST)

            otp_code = ''.join(random.choices(string.digits, k=6))
            OTP.objects.create(
                email=request.user.email,
                code=otp_code,
                reference=reference,
                expires_at=timezone.now() + timezone.timedelta(minutes=5)
            )
            try:
                send_mail(
                    'Internal Payment Verification OTP - Resent',
                    f'Your new OTP for payment verification is: {otp_code}\n\nExpires in 5 minutes.',
                    settings.DEFAULT_FROM_EMAIL,
                    [request.user.email],
                    fail_silently=False,
                )
                return Response({'message': 'OTP sent successfully'})
            except Exception as e:
                logger.error(f"Failed to send OTP email: {e}")
                return Response({'error': 'Failed to send OTP'}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

        except Payment.DoesNotExist:
            return Response({'error': 'Payment not found'}, status=status.HTTP_404_NOT_FOUND)
    
    def _is_paystack_otp_still_valid(payment):
        """Check if a pending_paystack_otp payment can still be finalized"""
        if not payment.paystack_transfer_code:
            return False
        try:
            result = PaystackAPI().verify_transfer(payment.transaction_reference)
            if result.get('status'):
                data = result.get('data', {})
                # If Paystack says it's failed or reversed, it's not valid
                if data.get('status') in ['failed', 'reversed', 'cancelled']:
                    return False
                # If Paystack says success, update it directly
                if data.get('status') == 'success':
                    _apply_paystack_transfer_result(payment, data)
                    return False  # Now completed, no need for OTP
            return True
        except Exception:
            return False  # Assume invalid on error

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated])
    def generate_payslip(self, request):
        employee_id = request.data.get('employee_id')
        month = request.data.get('month')

        if not employee_id or not month:
            return Response(
                {'error': 'employee_id and month are required'},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            employee = Employee.objects.get(id=employee_id)
        except Employee.DoesNotExist:
            return Response({'error': 'Employee not found'}, status=status.HTTP_404_NOT_FOUND)

        try:
            year, month_num = map(int, month.split('-'))
            from calendar import monthrange
            last_day = monthrange(year, month_num)[1]
            start_date = f"{year}-{month_num:02d}-01"
            end_date = f"{year}-{month_num:02d}-{last_day}"
        except Exception:
            return Response(
                {'error': 'Invalid month format. Use YYYY-MM'},
                status=status.HTTP_400_BAD_REQUEST
            )

        # Find the payment record to get Paystack refs. Prefer the latest record,
        # then sync in-flight transfers before generating the document.
        payment_record = Payment.objects.filter(
            employee=employee, 
            payment_month=month,
        ).order_by('-created_at').first()
        if payment_record:
            payment_record = _sync_payment_with_paystack(payment_record)

        month_deductions = Deduction.objects.filter(
            employee=employee, date__range=[start_date, end_date], status='applied'
        )
        total_deductions = month_deductions.aggregate(Sum('amount'))['amount__sum'] or 0
        net_salary = employee.salary - total_deductions

        trans_ref = payment_record.transaction_reference if payment_record else "Not generated"
        paystack_ref = (
            payment_record.paystack_reference
            or payment_record.paystack_transfer_code
            or "Awaiting Paystack confirmation"
        ) if payment_record else "Not generated"
        payment_status = payment_record.status.replace('_', ' ').title() if payment_record else 'Not Paid'
        logo_url = request.build_absolute_uri(settings.STATIC_URL + 'no_bggg.png')

        month_payments = Payment.objects.filter(
            employee=employee,
            payment_date__range=[start_date, end_date],
            status='completed'
        )

        payslip_data = {
            'employee': {
                'name': employee.name,
                'employee_id': employee.employee_id,
                'type': employee.type,
                'location': employee.location,
                'bank_name': employee.bank_name,
                'account_number': employee.account_number,
            },
            'month': month,
            'earnings': {
                'base_salary': float(employee.salary),
                'allowances': 0,
                'gross_salary': float(employee.salary)
            },
            'deductions': {
                'total': float(total_deductions),
                'items': [
                    {
                        'date': d.date.isoformat(),
                        'amount': float(d.amount),
                        'reason': d.reason,
                        'status': d.status
                    } for d in month_deductions
                ]
            },
            'transaction_reference': trans_ref,
            'paystack_reference': paystack_ref,
            'net_salary': float(net_salary),
            'payment_status': payment_status,
            'generated_at': timezone.now().isoformat()
        }

        payslip_html = f"""
        <div class="payslip-container" style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; border: 2px solid #333; position: relative; overflow: hidden; background: #fff;">
            <img src="{escape(logo_url)}" alt="" style="position: absolute; top: 50%; left: 50%; width: 360px; max-width: 70%; transform: translate(-50%, -50%); opacity: 0.06; z-index: 0; pointer-events: none;">
            <div style="position: relative; z-index: 1;">
            <div class="header" style="text-align: center; border-bottom: 2px solid #117e62; padding-bottom: 20px; margin-bottom: 30px;">
                <h1 style="color: #117e62; margin: 0;">FOTASCO SECURITY SERVICES</h1>
                <h2 style="margin: 10px 0;">PAYSLIP</h2>
                <p style="margin: 5px 0;">Month: {month}</p>
                <div style="font-size: 0.8em; color: #666; margin-top: 5px;">
                    Ref: {escape(trans_ref)} | Paystack: {escape(paystack_ref)} | Status: {escape(payment_status)}
                </div>
            </div>
            <div class="employee-info" style="margin-bottom: 30px;">
                <h3 style="color: #117e62; border-bottom: 1px solid #ccc;">Employee Information</h3>
                <table style="width: 100%;">
                    <tr><td><strong>Name:</strong></td><td>{escape(employee.name)}</td></tr>
                    <tr><td><strong>Employee ID:</strong></td><td>{escape(employee.employee_id)}</td></tr>
                    <tr><td><strong>Type:</strong></td><td>{escape(employee.type.title())}</td></tr>
                    <tr><td><strong>Location:</strong></td><td>{escape(employee.location)}</td></tr>
                    <tr><td><strong>Bank:</strong></td><td>{escape(employee.bank_name)}</td></tr>
                    <tr><td><strong>Account:</strong></td><td>{escape(employee.account_number)}</td></tr>
                </table>
            </div>
            <div class="earnings" style="margin-bottom: 30px;">
                <h3 style="color: #117e62; border-bottom: 1px solid #ccc;">Earnings</h3>
                <table style="width: 100%;">
                    <tr><td>Base Salary</td><td style="text-align: right;">₦{employee.salary:,.2f}</td></tr>
                    <tr style="font-weight: bold; font-size: 1.2em;"><td>Net Salary</td><td style="text-align: right;">₦{net_salary:,.2f}</td></tr>
                </table>
            </div>
            <div class="deductions" style="margin-bottom: 30px;">
                <h3 style="color: #117e62; border-bottom: 1px solid #ccc;">Deductions</h3>
                <table style="width: 100%;">
                    {"".join([f"<tr><td>{d.reason} ({d.date})</td><td style='text-align: right;'>₦{d.amount:,.2f}</td></tr>" for d in month_deductions])}
                    <tr style="font-weight: bold;"><td>Total Deductions</td><td style="text-align: right;">₦{total_deductions:,.2f}</td></tr>
                </table>
            </div>
            <div class="footer" style="margin-top: 50px; text-align: center; font-size: 0.9em; color: #666;">
                <p>Generated on {timezone.now().strftime('%Y-%m-%d %H:%M')}</p>
                <p>This is a computer-generated document and does not require signature.</p>
            </div>
            </div>
        </div>
        """

        return Response({'payslip_data': payslip_data, 'payslip_html': payslip_html})

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated, IsPayrollAdmin])
    def bulk_preview(self, request):
        """Preview total cost before payment"""
        ids = request.data.get('employee_ids', [])
        employees = Employee.objects.filter(id__in=ids)
        total = 0
        count = 0
        for e in employees:
            pending = applied_deductions_for_month(e, timezone.now().strftime('%Y-%m')).aggregate(Sum('amount'))['amount__sum'] or 0
            total += (e.salary - pending)
            count += 1
        return Response({'total_amount': float(total), 'count': count})

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated, IsPayrollAdmin])
    def request_payslip_export(self, request):
        """Request a secure token for PDF payslip download"""
        password = request.data.get('password')
        employee_id = request.data.get('employee_id')
        month = request.data.get('month')

        if not request.user.check_password(password):
            return Response({'error': 'Invalid password'}, status=status.HTTP_403_FORBIDDEN)

        token = secrets.token_urlsafe(32)
        ExportToken.objects.create(
            user=request.user,
            token=token,
            data_type='payslip',
            filters={'employee_id': employee_id, 'month': month},
            expires_at=timezone.now() + timedelta(minutes=10),
            is_2fa_verified=True # Single doc exports are authorized via password
        )
        return Response({'token': token})

    @action(detail=False, methods=['get'], permission_classes=[IsAuthenticated])
    def download_payslip_pdf(self, request):
        """Generate and stream the PDF payslip using ReportLab"""
        token = request.query_params.get('token')
        try:
            export_token = ExportToken.objects.get(token=token, is_used=False, data_type='payslip', user=request.user, is_2fa_verified=True)
            if export_token.is_expired():
                return Response({'error': 'Token expired'}, status=400)

            export_token.is_used = True
            export_token.save()

            employee_id = export_token.filters.get('employee_id')
            month = export_token.filters.get('month')
            employee = Employee.objects.get(id=employee_id)
            
            payment_record = Payment.objects.filter(employee=employee, payment_month=month).order_by('-created_at').first()
            if payment_record:
                payment_record = _sync_payment_with_paystack(payment_record)

            # Calculate financial data again on the backend for security
            year, month_num = map(int, month.split('-'))
            total_deductions = Deduction.objects.filter(
                employee=employee, 
                date__year=year, 
                date__month=month_num,
                status='applied'
            ).aggregate(Sum('amount'))['amount__sum'] or 0
            net_salary = employee.salary - total_deductions

            # Generate PDF
            buffer = io.BytesIO()
            doc = SimpleDocTemplate(buffer, pagesize=letter)
            styles = getSampleStyleSheet()
            elements = []

            elements.append(Paragraph("FOTASCO SECURITY SERVICES", styles['Title']))
            elements.append(Paragraph(f"PAYSLIP - {month}", styles['Heading2']))
            if payment_record:
                paystack_ref = (
                    payment_record.paystack_reference
                    or payment_record.paystack_transfer_code
                    or 'Awaiting Paystack confirmation'
                )
                elements.append(Paragraph(f"Trans ID: {payment_record.transaction_reference}", styles['Normal']))
                elements.append(Paragraph(f"Paystack Ref: {paystack_ref}", styles['Normal']))
                elements.append(Paragraph(f"Payment Status: {payment_record.status.replace('_', ' ').title()}", styles['Normal']))
            elements.append(Spacer(1, 12))

            # Employee Info Table
            emp_data = [
                ["Employee ID:", employee.employee_id, "Name:", employee.name],
                ["Location:", employee.location, "Bank:", employee.bank_name],
                ["Account No:", employee.account_number, "Role:", employee.type.title()]
            ]
            t = Table(emp_data, colWidths=[100, 150, 100, 150])
            t.setStyle(TableStyle([('GRID', (0,0), (-1,-1), 0.5, colors.grey)]))
            elements.append(t)
            elements.append(Spacer(1, 24))

            # Salary Table
            sal_data = [
                ["Description", "Amount (NGN)"],
                ["Base Salary", f"{employee.salary:,.2f}"],
                ["Total Deductions", f"({total_deductions:,.2f})"],
                ["NET SALARY", f"{net_salary:,.2f}"]
            ]
            ts = Table(sal_data, colWidths=[300, 200])
            ts.setStyle(TableStyle([
                ('BACKGROUND', (0,0), (1,0), colors.HexColor("#117e62")),
                ('TEXTCOLOR', (0,0), (1,0), colors.whitesmoke),
                ('GRID', (0,0), (-1,-1), 0.5, colors.grey),
                ('FONTNAME', (0,3), (1,3), 'Helvetica-Bold')
            ]))
            elements.append(ts)
            
            # Log the download
            DownloadLog.objects.create(
                user=request.user,
                employee=employee,
                doc_type='payslip',
                reference=month,
                ip_address=get_client_ip(request)
            )

            doc.build(elements, onLaterPages=draw_watermark, onFirstPage=draw_watermark)
            buffer.seek(0)
            response = HttpResponse(buffer, content_type='application/pdf')
            response['Content-Disposition'] = f'attachment; filename="payslip_{employee.employee_id}_{month}.pdf"'
            return response

        except Exception as e:
            return Response({'error': str(e)}, status=400)

    @action(detail=True, methods=['post'], permission_classes=[IsAuthenticated, IsPayrollAdmin])
    def request_receipt_export(self, request, pk=None):
        """Securely request a token for a payment receipt"""
        password = request.data.get('password')
        if not request.user.check_password(password):
            return Response({'error': 'Invalid password'}, status=status.HTTP_403_FORBIDDEN)

        token = secrets.token_urlsafe(32)
        ExportToken.objects.create(
            user=request.user,
            token=token,
            data_type='receipt',
            filters={'payment_id': str(pk)},
            expires_at=timezone.now() + timedelta(minutes=10),
            is_2fa_verified=True # Single doc exports are authorized via password
        )
        return Response({'token': token})

    @action(detail=False, methods=['get'], permission_classes=[IsAuthenticated])
    def download_receipt_pdf(self, request):
        """Generate and stream a professional Payment Receipt PDF"""
        token = request.query_params.get('token')
        try:
            export_token = ExportToken.objects.get(token=token, is_used=False, data_type='receipt', user=request.user, is_2fa_verified=True)
            if export_token.is_expired():
                return Response({'error': 'Token expired'}, status=400)

            export_token.is_used = True
            export_token.save()

            payment_id = export_token.filters.get('payment_id')
            payment = Payment.objects.get(id=payment_id)
            employee = payment.employee
            
            # Log the download
            DownloadLog.objects.create(
                user=request.user,
                employee=employee,
                doc_type='receipt',
                reference=payment.transaction_reference,
                ip_address=get_client_ip(request)
            )

            buffer = generate_receipt_pdf_buffer(payment)
            response = HttpResponse(buffer, content_type='application/pdf')
            filename = f"receipt_{employee.employee_id}_{payment.transaction_reference[:8]}.pdf"
            response['Content-Disposition'] = f'attachment; filename="{filename}"'
            return response

        except Exception as e:
            logger.error(f"Receipt Generation Error: {e}")
            return Response({'error': str(e)}, status=400)

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated, IsPayrollAdmin])
    def request_export(self, request):
        """Securely request an export token for payments"""
        password = request.data.get('password')
        if not password or not request.user.check_password(password):
            return Response({'error': 'Invalid password'}, status=status.HTTP_403_FORBIDDEN)
        
        token = secrets.token_urlsafe(32)
        export_token = ExportToken.objects.create(
            user=request.user,
            token=token,
            data_type='payment',
            filters=request.data.get('filters', {}),
            expires_at=timezone.now() + timezone.timedelta(minutes=10)
        )
        return Response({'token': token, 'expires_at': export_token.expires_at})

    @action(detail=False, methods=['get'], permission_classes=[IsAuthenticated],
            authentication_classes=[SessionAuthentication, BasicAuthentication])
    def export_csv(self, request):
        """Stream the CSV file from the server using the token"""
        token = request.query_params.get('token')
        try:
            export_token = ExportToken.objects.get(token=token, is_used=False, user=request.user)
            if export_token.is_expired():
                return Response({'error': 'Token expired'}, status=400)

            export_token.is_used = True
            export_token.save()

            response = HttpResponse(content_type='text/csv')
            response['Content-Disposition'] = 'attachment; filename="payment_history.csv"'

            writer = csv.writer(response)
            writer.writerow([
                'Date', 'Employee ID', 'Name', 'Bank', 'Account', 
                'Amount', 'Method', 'Reference', 'Status'
            ])

            queryset = Payment.objects.all().order_by('-payment_date')
            # Apply optional filters from token if needed
            
            for p in queryset:
                writer.writerow([
                    p.payment_date,
                    p.employee.employee_id if p.employee else 'N/A',
                    p.employee.name if p.employee else 'N/A',
                    p.employee.bank_name if p.employee else 'N/A',
                    p.employee.account_number if p.employee else 'N/A',
                    p.net_amount,
                    p.payment_method,
                    p.transaction_reference,
                    p.status
                ])

            # Log the payment history export
            DownloadLog.objects.create(
                user=request.user,
                employee=None,
                doc_type='payment_csv',
                reference=f"Token: {token[:8]}...",
                ip_address=get_client_ip(request)
            )

            return response
        except ExportToken.DoesNotExist:
            return Response({'error': 'Invalid token'}, status=400)

    def update(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.status == "completed":
            return Response(
                {"error": "Completed payments cannot be modified"},
                status=status.HTTP_400_BAD_REQUEST
            )
        return super().update(request, *args, **kwargs)

# ─────────────────────────────────────────
# DEDUCTION VIEWSET
# ─────────────────────────────────────────

class DeductionViewSet(viewsets.ModelViewSet):
    queryset = Deduction.objects.all().order_by('id')
    serializer_class = DeductionSerializer
    filterset_fields = ["employee", "status", "date"]

    def get_permissions(self):
        if self.action in ["create", "update", "partial_update", "destroy"]:
            return [IsAuthenticated(), IsDeductionAdmin()]
        return [IsAuthenticated()]

    def get_queryset(self):
        user = self.request.user
        if user.is_superuser or user.role == 'admin' or getattr(user, "is_deduction_admin", False):
            return Deduction.objects.all().order_by('id')
        if user.role in ["staff", "guard"]:
            return Deduction.objects.filter(employee__user=user).order_by('id')
        return Deduction.objects.none()

    @action(detail=False, methods=['post'], permission_classes=[IsAuthenticated, IsDeductionAdmin])
    def bulk_approve(self, request):
        """Approve all pending deductions for a specific month (YYYY-MM)"""
        month_str = request.data.get('month')
        if not month_str:
            return Response({'error': 'Month (YYYY-MM) is required'}, status=status.HTTP_400_BAD_REQUEST)
        
        try:
            year, month = map(int, month_str.split('-'))
            with transaction.atomic():
                queryset = Deduction.objects.filter(
                    status='pending',
                    date__year=year,
                    date__month=month
                )
                count = queryset.count()
                queryset.update(status='applied')
            return Response({'message': f'Successfully approved {count} deductions for {month_str}'})
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)

    @action(detail=True, methods=['post'], permission_classes=[IsAuthenticated])
    def hr_approve(self, request, pk=None):
        """Action for HR Admin to approve a deduction awaiting clearance"""
        if not (request.user.is_superuser or getattr(request.user, 'is_hr_admin', False)):
            return Response({'error': 'Only HR Admin can approve deductions'}, status=403)
            
        deduction = self.get_object()
        if deduction.status != 'pending_hr':
            return Response({'error': 'Deduction is not awaiting HR approval'}, status=400)
            
        with transaction.atomic():
            deduction.hr_approved = True
            deduction.hr_approved_by = request.user
            deduction.status = 'applied'
            deduction.save()
            
        log_audit(request.user, f"HR Approved deduction for {deduction.employee.name}", request)
        return Response({'status': 'Approved and applied by HR'})

    def perform_create(self, serializer):
        # Determine status based on user role
        status_val = 'applied'
        if not (self.request.user.is_superuser or getattr(self.request.user, 'is_hr_admin', False)):
            status_val = 'pending_hr'
            
        deduction = serializer.save(status=status_val)
        
        # Logic to check if deduction is heavy (>40% of salary)
        threshold = deduction.employee.salary * Decimal('0.4')
        is_heavy = deduction.amount > threshold
        
        msg = (f"Deduction of ₦{deduction.amount:,.2f} recorded for {deduction.employee.name}. "
               f"Status: {deduction.status}.")
        
        if is_heavy:
            # Create a specific notification for admin review
            Notification.objects.create(
                user=None, # Global/Admin notification
                message=f"CRITICAL: High deduction (₦{deduction.amount:,.2f}) applied to {deduction.employee.name}. Please verify net salary impact.",
                type='warning'
            )

        Notification.objects.create(
            user=deduction.employee.user,
            message=msg,
            type='warning'
        )
        return deduction

    @action(detail=True, methods=['put'], permission_classes=[IsAuthenticated, IsDeductionAdmin])
    def update_status(self, request, pk=None):
        deduction = self.get_object()
        new_status = request.data.get('status')

        # RESTRICTION: Admin cannot cancel their own deductions
        if str(deduction.employee.user.id) == str(request.user.id) and new_status in ['cancelled', 'terminated']:
            return Response({'error': 'Admins cannot cancel or terminate their own deductions.'}, 
                            status=status.HTTP_403_FORBIDDEN)

        if new_status not in ['pending', 'applied', 'cancelled', 'terminated']:
            return Response(
                {'error': 'Invalid status. Must be: pending, applied, cancelled, or terminated'},
                status=status.HTTP_400_BAD_REQUEST
            )

        deduction.status = new_status
        deduction.save()

        Notification.objects.create(
            user=deduction.employee.user,
            message=f"Deduction status updated to {new_status} for ₦{deduction.amount}. Reason: {deduction.reason}",
            type='info' if new_status == 'applied' else 'warning'
        )

        return Response({
            'message': f'Deduction status updated to {new_status}',
            'deduction': DeductionSerializer(deduction).data
        })


# ─────────────────────────────────────────
# SACKED EMPLOYEE VIEWSET
# ─────────────────────────────────────────

class SackedEmployeeViewSet(viewsets.ModelViewSet):
    queryset = SackedEmployee.objects.all().order_by('id')
    serializer_class = SackedEmployeeSerializer

    def get_permissions(self):
        if self.action in ['create', 'update', 'partial_update', 'destroy']:
            return [IsAuthenticated(), IsSackAdmin()]
        return [IsAuthenticated()]

    @action(detail=True, methods=['post'], permission_classes=[IsAuthenticated, IsSackAdmin])
    def reinstate(self, request, pk=None):
        sacked_record = self.get_object()
        employee = sacked_record.employee

        with transaction.atomic():
            employee.status = 'active'
            employee.save()
            sacked_record.delete()

            Notification.objects.create(
                user=employee.user,
                message=f"Employee {employee.employee_id} - {employee.name} has been reinstated.",
                type='success'
            )
            logger.info(f"{request.user.username} reinstated {employee.name}")

        return Response({'message': 'Employee reinstated successfully'})


# ─────────────────────────────────────────
# NOTIFICATION VIEWSET
# ─────────────────────────────────────────

class NotificationViewSet(viewsets.ModelViewSet):
    serializer_class = NotificationSerializer
    permission_classes = [IsAuthenticated, CanEditNotification]
    queryset = Notification.objects.all().order_by('id')

    def get_queryset(self):
        user = self.request.user
        if user.is_superuser or user.role == 'admin' or getattr(user, 'is_notification_admin', False):
            return Notification.objects.all().order_by('id')
        return Notification.objects.filter(user=user).order_by('id')

    @action(detail=False, methods=['post'])
    def mark_all_read(self, request):
        self.get_queryset().update(is_read=True)
        return Response({'message': 'All notifications marked as read'})


# ─────────────────────────────────────────
# COMPANY VIEWSET
# ─────────────────────────────────────────


class CompanyViewSet(viewsets.ModelViewSet):
    queryset = Company.objects.all().order_by('id')
    serializer_class = CompanySerializer
    permission_classes = [CanViewAndEditCompany]

    def destroy(self, request, *args, **kwargs):
        """Soft delete: change status to Not Active and save reason."""
        instance = self.get_object()
        reason = request.data.get('reason', 'Contract manually terminated')
        instance.status = 'terminated'
        instance.termination_reason = reason
        instance.save()
        return Response({'message': 'Company marked as not active'}, status=status.HTTP_200_OK)

    def get_queryset(self):
        user = self.request.user
        if user.is_superuser or user.role == 'admin':
            return Company.objects.all().order_by('id')
        if user.role in ['staff', 'guard']:
            return Company.objects.filter(
                assigned_guards__user=user
            ).distinct().order_by('id')
        return Company.objects.none()

    def create(self, request, *args, **kwargs):
        """Auto-update if company with same name exists, otherwise create."""
        name = request.data.get('name')
        instance = Company.objects.filter(name__iexact=name).first()
        if instance:
            serializer = self.get_serializer(instance, data=request.data, partial=True)
            serializer.is_valid(raise_exception=True)
            serializer.save()
            return Response(serializer.data, status=status.HTTP_200_OK)
        return super().create(request, *args, **kwargs)

    @action(detail=True, methods=['get'], permission_classes=[IsAuthenticated])
    def profit(self, request, pk=None):
        """Explicit endpoint for company profit breakdown"""
        company = self.get_object()
        return Response({
            'payment_to_us': float(company.payment_to_us),
            'total_to_guards': float(company.total_payment_to_guards),
            'profit': float(company.profit)
        })

    @action(detail=True, methods=['post'], permission_classes=[IsAuthenticated, CanViewAndEditCompany])
    def renew_contract(self, request, pk=None):
        company = self.get_object()
        company.status = 'renewed'
        company.contract_start = timezone.now().date()
        company.contract_end = timezone.now().date() + timezone.timedelta(days=365)
        company.save()
        return Response({'message': 'Contract renewed', 'company': CompanySerializer(company).data})

    @action(detail=True, methods=['post'], permission_classes=[IsAuthenticated, CanViewAndEditCompany])
    def terminate_contract(self, request, pk=None):
        company = self.get_object()
        company.status = 'terminated'
        company.save()
        return Response({'message': 'Contract terminated', 'company': CompanySerializer(company).data})


# ─────────────────────────────────────────
# EMPLOYEE REQUEST VIEWSET
# ─────────────────────────────────────────

class EmployeeRequestViewSet(viewsets.ModelViewSet):
    queryset = EmployeeRequest.objects.all().order_by('-created_at')
    serializer_class = EmployeeRequestSerializer
    filterset_fields = ['employee', 'request_type', 'status']

    def get_permissions(self):
        if self.action == 'create':
            return [IsAuthenticated()]
        if self.action in ['approve', 'decline', 'download_attachments']:
            return [IsAuthenticated(), IsRequestAdmin()]  # Use IsRequestAdmin instead of IsAdmin
        if self.request.user.is_superuser or getattr(self.request.user, 'is_request_admin', False):
            return [IsAuthenticated()]
        if self.action in ['list', 'retrieve']:
            return [IsAuthenticated()]
        return [IsAuthenticated(), IsAdmin()]

    def get_queryset(self):
        user = self.request.user
        if user.is_superuser or getattr(user, 'is_request_admin', False):
            return EmployeeRequest.objects.all().order_by('-created_at')
        try:
            employee = Employee.objects.get(user=user)
            return EmployeeRequest.objects.filter(employee=employee).order_by('-created_at')
        except Employee.DoesNotExist:
            return EmployeeRequest.objects.none()

    def perform_create(self, serializer):
        # Ensure employee is linked to the requesting user
        employee = getattr(self.request.user, 'employee_profile', None)
        if not employee:
            # If user is an admin/superuser without a profile, we must return a clear error
            raise serializers.ValidationError({
                "detail": "Requests can only be submitted by users with an active Employee Profile."
            })
        
        # Save the request
        req = serializer.save(employee=employee, status='pending')
        
        # Handle multiple proof photos
        for f in self.request.FILES.getlist('proof_photos'):
            EmployeeRequestAttachment.objects.create(request=req, file=f, file_type='proof')
            
        # Handle multiple receipt files
        for f in self.request.FILES.getlist('receipt_files'):
            EmployeeRequestAttachment.objects.create(request=req, file=f, file_type='receipt')

        Notification.objects.create(
            user=self.request.user,
            message=f"Your request for {serializer.instance.request_type} has been submitted.",
            type='info'
        )

    @action(detail=True, methods=['post'], permission_classes=[IsAuthenticated, IsAdmin])
    def approve(self, request, pk=None):
        req = self.get_object()
        if req.status != 'pending':
            return Response({'error': 'Request is not pending'}, status=status.HTTP_400_BAD_REQUEST)
        req.status = 'approved'
        req.action_by = request.user
        req.save()
        Notification.objects.create(
            user=req.employee.user,
            message=f"Your request for {req.request_type} has been approved.",
            type='success'
        )
        return Response({'message': 'Request approved', 'status': 'approved'})

    @action(detail=True, methods=['post'], permission_classes=[IsAuthenticated, IsAdmin])
    def decline(self, request, pk=None):
        req = self.get_object()
        reason = request.data.get('reason', 'No reason provided')
        req.status = 'declined'
        req.action_by = request.user
        req.decline_reason = reason
        req.save()
        Notification.objects.create(
            user=req.employee.user,
            message=f"Your request for {req.request_type} has been declined. Reason: {reason}",
            type='error'
        )
        return Response({'message': 'Request declined', 'status': 'declined'})

    @action(detail=True, methods=['post'], permission_classes=[IsAuthenticated, IsAdmin])
    def download_attachments(self, request, pk=None):
        """Download all attachments for a request as a ZIP file"""
        password = request.data.get('password')
        if not password or not request.user.check_password(password):
            return Response({'error': 'Invalid password'}, status=status.HTTP_403_FORBIDDEN)

        req = self.get_object()
        attachments = req.attachments.all()
        
        if not attachments:
            return Response({'error': 'No attachments found'}, status=404)
            
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as zip_file:
            for attachment in attachments:
                if attachment.file:
                    # Get the actual file name from the path
                    file_name = os.path.basename(attachment.file.name)
                    # Read file content and write to zip
                    try:
                        with attachment.file.open('rb') as f:
                            zip_file.writestr(f"{attachment.file_type}_{file_name}", f.read())
                    except Exception as e:
                        logger.error(f"Error adding file {file_name} to zip: {e}")

        buffer.seek(0)
        DownloadLog.objects.create(
            user=request.user,
            employee=req.employee,
            doc_type='attachments',
            reference=str(req.id),
            ip_address=get_client_ip(request)
        )
        response = HttpResponse(buffer, content_type='application/zip')
        filename = f"attachments_{req.employee.employee_id}_{req.id[:8]}.zip"
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
        return response


def frontend(request):
    return render(request, "frontend/index.html")


class DownloadLogViewSet(viewsets.ReadOnlyModelViewSet):
    """
    ViewSet for administrators to monitor document download history.
    """
    queryset = DownloadLog.objects.all().order_by('-created_at')
    serializer_class = DownloadLogSerializer
    permission_classes = [IsAdmin]
    filterset_fields = ['doc_type', 'employee']
    search_fields = ['employee__name', 'employee__employee_id', 'reference', 'user__username']

@api_view(['GET'])
@permission_classes([IsAuthenticated])
def system_health_check(request):
    """
    Monitor Paystack connectivity and pending transfer counts.
    Only accessible to administrators.
    """
    paystack = PaystackAPI()
    
    # Check counts of transfers in the queue (by model status)
    pending_count = Payment.objects.filter(status='pending').count()
    processing_count = Payment.objects.filter(status='processing').count()
    
    health_data = {
        'status': 'healthy',
        'environment': 'Production' if not settings.DEBUG else 'Development',
        'timestamp': timezone.now().isoformat(),
        'paystack_connection': 'unknown',
        'queue': {
            'pending_transfers': pending_count,
            'processing_transfers': processing_count,
        }
    }
    
    # Check Paystack API connection by trying to fetch transfer balance
    try:
        balance_res = paystack.get_transfer_balance()
        if balance_res.get('status'):
            health_data['paystack_connection'] = 'connected'
        else:
            health_data['paystack_connection'] = 'failed'
            health_data['status'] = 'degraded'
            health_data['paystack_error'] = balance_res.get('message')
    except Exception as e:
        health_data['paystack_connection'] = 'error'
        health_data['status'] = 'unhealthy'
        health_data['error_detail'] = str(e)
        
    return Response(health_data)
