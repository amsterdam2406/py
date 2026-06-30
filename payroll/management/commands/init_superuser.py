from django.core.management.base import BaseCommand
from django.contrib.auth import get_user_model
import os

User = get_user_model()


class Command(BaseCommand):
    help = 'Create or update superuser'

    def handle(self, *args, **options):
        username = os.environ.get('DJANGO_SUPERUSER_USERNAME', 'admin')
        email = os.environ.get('DJANGO_SUPERUSER_EMAIL', 'admin@example.com')
        password = os.environ.get('DJANGO_SUPERUSER_PASSWORD')
        if not password and not User.objects.filter(username=username).exists():
            self.stdout.write(self.style.WARNING(
                'DJANGO_SUPERUSER_PASSWORD is not set; skipping initial superuser creation.'
            ))
            return
        
        # Use get() to avoid the messy if/else logic
        user, created = User.objects.get_or_create(
            username=username,
            defaults={
                'email': email,
                'full_name': username,  # Use the variable, not string literal
                'is_staff': True,
                'is_superuser': True,
                'is_active': True,
                'role': 'admin',
            }
        )

        if created:
            user.set_password(password)
            user.save()
            self.stdout.write(self.style.SUCCESS(f'Superuser "{username}" created successfully'))
        else:
            # Update existing user
            user.email = email
            user.full_name = username
            user.is_staff = True
            user.is_superuser = True
            user.is_active = True
            user.role = 'admin'
            if password:
                user.set_password(password)
            user.save()
            self.stdout.write(self.style.WARNING(f'Superuser "{username}" updated successfully'))
#         else:
#             self.stdout.write(self.style.NOTICE(f'Superuser "{username}" already exists'))


