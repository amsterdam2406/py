"""
Custom password validators for production-ready password policies
"""
import re
from django.core.exceptions import ValidationError
from django.utils.translation import gettext as _


class ComplexPasswordValidator:
    """
    Enforce complex password requirements:
    - Minimum 8 characters
    - At least 1 uppercase letter
    - At least 1 lowercase letter
    - At least 1 number
    - At least 1 special character
    - Cannot contain username
    """
    
    def validate(self, password, user=None):
        errors = []
        
        # Minimum lngth check
        if len(password) < 8:
            errors.append(
                ValidationError(
                    _("This password must contain at least 8 characters."),
                    code='password_too_short',
                )
            )
        
        # Uppercase letter check
        if not re.search(r'[A-Z]', password):
            errors.append(
                ValidationError(
                    _("This password must contain at least one uppercase letter (A-Z)."),
                    code='password_no_upper',
                )
            )
        
        # Lowercase letter check
        if not re.search(r'[a-z]', password):
            errors.append(
                ValidationError(
                    _("This password must contain at least one lowercase letter (a-z)."),
                    code='password_no_lower',
                )
            )
        
        # Number check
        if not re.search(r'[0-9]', password):
            errors.append(
                ValidationError(
                    _("This password must contain at least one number (0-9)."),
                    code='password_no_number',
                )
            )
        
        # Special character check
        if not re.search(r'[!@#$%^&*()_+\-=\[\]{};:\'",.<>?/\\|`~]', password):
            errors.append(
                ValidationError(
                    _("This password must contain at least one special character (!@#$%^&* etc)."),
                    code='password_no_special',
                )
            )
        
        # Username check (if user is provided)
        if user and hasattr(user, 'username'):
            if user.username.lower() in password.lower():
                errors.append(
                    ValidationError(
                        _("The password cannot contain your username."),
                        code='password_contains_username',
                    )
                )
        
        if errors:
            raise ValidationError(errors)
    
    def get_help_text(self):
        return _(
            "Your password must contain at least 8 characters, including "
            "at least one uppercase letter, one lowercase letter, one number, "
            "and one special character. It cannot contain your username."
        )
