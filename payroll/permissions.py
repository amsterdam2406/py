from rest_framework.permissions import BasePermission

SAFE_METHODS = ('GET', 'HEAD', 'OPTIONS')


def is_super_admin(user):
    return bool(user and user.is_authenticated and user.is_superuser)


def has_employee_permission(user):
    return bool(
        is_super_admin(user) or
        (
            user and user.is_authenticated and
            getattr(user, 'is_employee_admin', False)
        )
    )


def has_attendance_permission(user):
    return bool(
        is_super_admin(user) or
        (
            user and user.is_authenticated and (
                getattr(user, 'is_attendance_admin', False) or
                getattr(user, 'is_hr_admin', False) or
                getattr(user, 'is_employee_admin', False)
            )
        )
    )


def has_payroll_permission(user):
    return bool(
        is_super_admin(user) or
        (user and user.is_authenticated and getattr(user, 'is_payment_admin', False))
    )


def has_deduction_permission(user):
    return bool(
        is_super_admin(user) or
        (user and user.is_authenticated and getattr(user, 'is_deduction_admin', False))
    )


def has_company_permission(user):
    return bool(
        is_super_admin(user) or
        (user and user.is_authenticated and getattr(user, 'is_company_admin', False))
    )


def has_notification_permission(user):
    return bool(
        is_super_admin(user) or
        (user and user.is_authenticated and getattr(user, 'is_notification_admin', False))
    )


def has_request_permission(user):
    return bool(
        is_super_admin(user) or
        (user and user.is_authenticated and getattr(user, 'is_request_admin', False))
    )


def has_hr_permission(user):
    return bool(
        is_super_admin(user) or
        (user and user.is_authenticated and getattr(user, 'is_hr_admin', False))
    )


class IsAdmin(BasePermission):
    """Super Admin only. Module admins should use module-specific permissions."""
    def has_permission(self, request, view):
        return is_super_admin(request.user)

class CanCreateEmployee(BasePermission):
    """Users with employee-management capability can create employees."""
    def has_permission(self, request, view):
        if request.method in SAFE_METHODS:
            return True
        return has_employee_permission(request.user)

class IsSackAdmin(BasePermission):
    """Users with employee-management capability can terminate/reinstate employees."""
    def has_permission(self, request, view):
        return has_employee_permission(request.user)


class IsAttendanceAdmin(BasePermission):
    """Users with attendance-management capability can administer attendance/leave."""
    def has_permission(self, request, view):
        return has_attendance_permission(request.user)

class IsPayrollAdmin(BasePermission):
    """Users with payroll/payment capability can write payment records."""
    def has_permission(self, request, view):
        return has_payroll_permission(request.user)

class IsDeductionAdmin(BasePermission):
    """Users with deduction-management capability can write deductions."""
    def has_permission(self, request, view):
        return has_deduction_permission(request.user)

class CanEditNotification(BasePermission):
    """Everyone can read their scoped notifications; notification admins can write."""
    def has_permission(self, request, view):
        user = request.user
        if not user.is_authenticated:
            return False
        if request.method in SAFE_METHODS:
            return True
        return has_notification_permission(user)

class CanViewAndEditCompany(BasePermission):
    """Only company admins and Super Admin can access company management."""
    def has_permission(self, request, view):
        return has_company_permission(request.user)

class IsHRAdmin(BasePermission):
    """Only users with HR capability can access HR functions."""
    def has_permission(self, request, view):
        return has_hr_permission(request.user)

class IsRequestAdmin(BasePermission):
    """Only users with request-management capability can manage employee requests."""
    def has_permission(self, request, view):
        return has_request_permission(request.user)
