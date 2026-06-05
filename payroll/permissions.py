from rest_framework.permissions import BasePermission
# lj

class IsAdmin(BasePermission):
    """Authenticated user with role='admin' or superuser."""
    def has_permission(self, request, view):
        user = request.user
        return (
            user.is_authenticated and
            (user.role == 'admin' or user.is_superuser)
        )


class CanCreateEmployee(BasePermission):
    """Only superuser / admin / is_employee_admin can create employees."""
    def has_permission(self, request, view):
        if request.method in ('GET', 'HEAD', 'OPTIONS'):
            return True
        if request.method == 'POST':
            return (
                request.user.is_superuser or
                request.user.role == 'admin' or
                getattr(request.user, 'is_employee_admin', False)
            )
        return True


class IsSackAdmin(BasePermission):
    """Only superuser / admin / is_employee_admin can terminate employees."""
    def has_permission(self, request, view):
        user = request.user
        if not user.is_authenticated:
            return False
        return (
            user.is_superuser or
            user.role == 'admin' or
            getattr(user, 'is_employee_admin', False)
        )


class IsPayrollAdmin(BasePermission):
    """Only superuser / admin / is_payment_admin can write payments."""
    def has_permission(self, request, view):
        user = request.user
        if not user.is_authenticated:
            return False
        return (
            user.is_superuser or
            user.role == 'admin' or
            getattr(user, 'is_payment_admin', False)
        )


class IsDeductionAdmin(BasePermission):
    """Only superuser / admin / is_deduction_admin can write deductions."""
    def has_permission(self, request, view):
        user = request.user
        if not user.is_authenticated:
            return False
        return (
            user.is_superuser or
            user.role == 'admin' or
            getattr(user, 'is_deduction_admin', False)
        )


class CanEditNotification(BasePermission):
    """Everyone can read; only superuser / is_notification_admin can write."""
    def has_permission(self, request, view):
        user = request.user
        if not user.is_authenticated:
            return False
        if request.method in ('GET', 'HEAD', 'OPTIONS'):
            return True
        return user.is_superuser or getattr(user, 'is_notification_admin', False)


class CanViewAndEditCompany(BasePermission):
    """Everyone authenticated can read; only admin / is_company_admin can write."""
    def has_permission(self, request, view):
        user = request.user
        if not user.is_authenticated:
            return False
        if request.method in ('GET', 'HEAD', 'OPTIONS'):
            return True
        return (
            user.is_superuser or
            user.role == 'admin' or
            getattr(user, 'is_company_admin', False)
        )
        
class IsHRAdmin(BasePermission):
    """Only superuser / is_hr_admin can access HR functions."""
    def has_permission(self, request, view):
        user = request.user
        if not user.is_authenticated:
            return False
        return (
            user.is_superuser or
            getattr(user, 'is_hr_admin', False)
        )


class IsRequestAdmin(BasePermission):
    """Only superuser / is_request_admin can manage employee requests."""
    def has_permission(self, request, view):
        user = request.user
        if not user.is_authenticated:
            return False
        return (
            user.is_superuser or
            getattr(user, 'is_request_admin', False)
        )
        
        