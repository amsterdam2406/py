from rest_framework.throttling import UserRateThrottle, AnonRateThrottle, ScopedRateThrottle
from rest_framework.throttling import SimpleRateThrottle


# ---------------------------------------------------------------------------
# LOGIN
# ------------------------------------------------------------------------

class LoginThrottle(AnonRateThrottle):
    """Throttle unauthenticated login attempts by IP."""
    scope = 'login'
    rate = '5/min'

class BankVerifyThrottle(SimpleRateThrottle):
    scope = 'bank_verify'
    rate = '5/min'
    
    def get_cache_key(self, request, view):
        # Use IP as the base identifier
        ident = self.get_ident(request)
        return self.cache_format % {
            'scope': self.scope,
            'ident': ident
        }
    
    def allow_request(self, request, view):
        from django.core.cache import cache
        acc = request.GET.get('account_number') or request.data.get('account_number')
        bank = request.GET.get('bank_code') or request.data.get('bank_code')
        if acc and bank:
            bank = str(bank).strip()
            acc = str(acc).strip()
            cache_keys = [
                f"paystack:resolve:{bank}:{acc}",
                f"paystack_resolve_{bank}_{acc}",
            ]
            if any(cache.get(cache_key) for cache_key in cache_keys):
                return True
        return super().allow_request(request, view)


# ---------------------------------------------------------------------------
# ATTENDANCE
# ---------------------------------------------------------------------------

class AttendanceThrottle(UserRateThrottle):
    """Throttle clock-in / clock-out actions per authenticated user."""
    scope = 'attendance'
    rate = '10/min'


# ---------------------------------------------------------------------------
# PAYMENT
# ---------------------------------------------------------------------------

class PaymentThrottle(ScopedRateThrottle):
    """Throttle payment initiation per authenticated user."""
    scope = 'payment'
    rate = '20/hour'


# ---------------------------------------------------------------------------
# BULK PAYMENT
# ---------------------------------------------------------------------------

class BulkPaymentThrottle(ScopedRateThrottle):
    """Stricter throttle for bulk_payment action."""
    scope = 'bulk_payment'
    rate = '5/hour'


# ---------------------------------------------------------------------------
# REGISTRATION
# ---------------------------------------------------------------------------

class RegisterThrottle(UserRateThrottle):
    """Throttle account creation per authenticated admin."""
    scope = 'register'
    rate = '30/hour'


# ---------------------------------------------------------------------------
# PASSWORD VERIFICATION
# ---------------------------------------------------------------------------

class VerifyPasswordThrottle(UserRateThrottle):
    """Throttle the /verify-password/ endpoint."""
    scope = 'verify_password'
    rate = '5/min'


# ---------------------------------------------------------------------------
# OTP / RESEND OTP
# ---------------------------------------------------------------------------

class OTPThrottle(UserRateThrottle):
    """Throttle OTP verification and resend attempts per user."""
    scope = 'otp'
    rate = '10/hour'


# ---------------------------------------------------------------------------
# EXPORT TOKEN REQUEST
# ---------------------------------------------------------------------------

class ExportTokenThrottle(UserRateThrottle):
    """Throttle export-token generation per admin user."""
    scope = 'export'
    rate = '10/hour'


# ---------------------------------------------------------------------------
# EXPORT (for CSV downloads via token)
# ---------------------------------------------------------------------------

class ExportThrottle(ScopedRateThrottle):
    """Throttle for export CSV downloads."""
    scope = 'export'
    rate = '10/hour'
