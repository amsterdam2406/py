from celery import shared_task
from django.utils import timezone
from datetime import timedelta
from .models import Payment
from .services import PaystackService
from .paystack import PaystackAPI
from django.core.cache import cache
from django.core.mail import send_mail
from django.conf import settings
import logging

logger = logging.getLogger(__name__)

@shared_task
def verify_processing_payments():
    """
    Task to automatically verify payments stuck in 'processing' status
    that haven't received a webhook update within 30 minutes.
    """
    threshold = timezone.now() - timedelta(minutes=30)
    stale_payments = Payment.objects.filter(
        status='processing',
        updated_at__lt=threshold
    )
    
    if not stale_payments.exists():
        return "No stale payments to verify."

    service = PaystackService()
    count = 0
    for payment in stale_payments:
        try:
            new_status = service.verify_and_sync_payment(payment)
            if new_status != 'processing':
                count += 1
        except Exception as e:
            logger.error(f"Error verifying stale payment {payment.transaction_reference}: {e}")
            
    return f"Verified {count} stale payments."

@shared_task
def monitor_paystack_health():
    """
    Task to monitor Paystack connectivity.
    Alerts admins if connection is degraded for > 5 minutes.
    """
    paystack = PaystackAPI()
    is_healthy = False
    
    try:
        res = paystack.get_transfer_balance()
        is_healthy = res.get('status') is True
    except Exception:
        is_healthy = False

    fail_count = cache.get('paystack_health_fail_count', 0)

    if not is_healthy:
        fail_count += 1
        cache.set('paystack_health_fail_count', fail_count, 600)
        
        if fail_count == 5: # 5 minutes threshold (assuming task runs every 1 min)
            send_mail(
                "CRITICAL: Paystack Connection Alert",
                "Paystack connection has been degraded for over 5 minutes. Payroll transfers may be affected.",
                settings.DEFAULT_FROM_EMAIL,
                [a[1] for a in settings.ADMINS] if hasattr(settings, 'ADMINS') else [settings.DEFAULT_FROM_EMAIL]
            )
    else:
        cache.set('paystack_health_fail_count', 0)