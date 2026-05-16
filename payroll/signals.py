from django.contrib.auth.signals import user_logged_in
from django.dispatch import receiver
from django.core.mail import send_mail
from django.conf import settings
# l

@receiver(user_logged_in)
def login_alert(sender, request, user, **kwargs):
    from .utils import get_client_ip, log_audit

    ip = get_client_ip(request)

    send_mail(
        "Login Alert",
        f"New login detected from IP: {ip}",
        settings.DEFAULT_FROM_EMAIL,
        [user.email]
    )

    log_audit(user, "User Logged In", request)