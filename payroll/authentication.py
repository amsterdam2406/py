from django.contrib.auth.backends import ModelBackend
from django.contrib.auth import get_user_model
from .models import Employee

User = get_user_model()

class UsernameOrEmployeeIDBackend(ModelBackend):
    def authenticate(self, request, username=None, password=None, **kwargs):
        if not username or not password or '@' in str(username):
            return None

        try:
            user = User.objects.get(username__iexact=username)
        except User.DoesNotExist:
            try:
                employee = Employee.objects.select_related('user').get(employee_id__iexact=username)
                user = employee.user
            except Employee.DoesNotExist:
                User().set_password(password)
                return None

        if user.check_password(password) and self.user_can_authenticate(user):
            return user
        return None

    def get_user(self, user_id):
        try:
            return User.objects.get(pk=user_id)
        except User.DoesNotExist:
            return None
