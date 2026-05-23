from typing import Optional, Dict, Any
from .models import AuditLog  # optional(or keep inside function)

def get_client_ip(request):
    x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded_for:
        ip_list = [ip.strip() for ip in x_forwarded_for.split(',')]
        return ip_list[0]
    return request.META.get('REMOTE_ADDR')


def log_audit(user, action: str, request, extra: Optional[Dict[str, Any]] = None):
    AuditLog.objects.create(
        user=user,
        action=action,
        ip_address=get_client_ip(request),
        extra_data=extra or {}
    )