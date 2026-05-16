from rest_framework.throttling import UserRateThrottle, AnonRateThrottle, ScopedRateThrottle


# ---------------------------------------------------------------------------
# LOGIN
# ------------------------------------------------------------------------

class LoginThrottle(AnonRateThrottle):
    """Throttle unauthenticated login attempts by IP."""
    scope = 'login'
    rate = '5/min'

class BankVerifyThrottle(UserRateThrottle):
    """Throttle bank account verification lookups."""
    scope = 'bank_verify'
    rate = '30/min'


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
    scope = 'exports'
    rate = '10/hour'