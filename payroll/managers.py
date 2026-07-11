# payroll/managers.py
from django.contrib.auth.models import BaseUserManager
from django.utils.translation import gettext_lazy as _


class UserManager(BaseUserManager):
    """Custom user manager for username-based authentication."""
    
    use_in_migrations = True

    def _create_user(self, username, password, email=None, **extra_fields):
        """Create and save a user with the given username and password."""
        if not username:
            raise ValueError(_('The Username must be set'))
        email = self.normalize_email(email) if email else ''
        if 'full_name' not in extra_fields or not extra_fields['full_name']:
            extra_fields['full_name'] = extra_fields.get('full_name') or username
        user = self.model(username=username, email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_user(self, username, password=None, email=None, **extra_fields):
        """Create regular user."""
        extra_fields.setdefault('is_staff', False)
        extra_fields.setdefault('is_superuser', False)
        return self._create_user(username, password, email=email, **extra_fields)

    def create_superuser(self, username, password, email=None, **extra_fields):
        """Create superuser."""
        extra_fields.setdefault('is_staff', True)
        extra_fields.setdefault('is_superuser', True)
        extra_fields.setdefault('role', 'admin')

        if extra_fields.get('is_staff') is not True:
            raise ValueError(_('Superuser must have is_staff=True.'))
        if extra_fields.get('is_superuser') is not True:
            raise ValueError(_('Superuser must have is_superuser=True.'))

        return self._create_user(username, password, email=email, **extra_fields)
