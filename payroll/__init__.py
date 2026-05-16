# payroll/__init_.py

def __getattr__(name):
    """Lazy import to avoid circular dependencies"""
    if name == 'UserSerializer':
        from .serializers import UserSerializer
        return UserSerializer
    elif name == 'EmployeeSerializer':
        from .serializers import EmployeeSerializer
        return EmployeeSerializer
    elif name == 'AttendanceSerializer':
        from .serializers import AttendanceSerializer
        return AttendanceSerializer
    elif name == 'DeductionSerializer':
        from .serializers import DeductionSerializer
        return DeductionSerializer
    elif name == 'PaymentSerializer':
        from .serializers import PaymentSerializer
        return PaymentSerializer
    elif name == 'CompanySerializer':
        from .serializers import CompanySerializer
        return CompanySerializer
    elif name == 'SackedEmployeeSerializer':
        from .serializers import SackedEmployeeSerializer
        return SackedEmployeeSerializer
    elif name == 'NotificationSerializer':
        from .serializers import NotificationSerializer
        return NotificationSerializer
    elif name == 'OTPSerializer':
        from .serializers import OTPSerializer
        return OTPSerializer
    elif name == 'ExportTokenSerializer':
        from .serializers import ExportTokenSerializer
        return ExportTokenSerializer
    elif name == 'AttendanceViewSet':
        from .views import AttendanceViewSet
        return AttendanceViewSet
    elif name == 'EmployeeViewSet':
        from .views import EmployeeViewSet
        return EmployeeViewSet
    elif name == 'UserViewSet':
        from .views import UserViewSet
        return UserViewSet
    raise AttributeError(f"module 'payroll' has no attribute '{name}'")

__all__ = [
    'UserSerializer', 'EmployeeSerializer', 'AttendanceSerializer',
    'DeductionSerializer', 'PaymentSerializer', 'CompanySerializer',
    'SackedEmployeeSerializer', 'NotificationSerializer', 'OTPSerializer',
    'ExportTokenSerializer', 'AttendanceViewSet', 'EmployeeViewSet', 'UserViewSet',
]