from django.core.management.base import BaseCommand
from django.contrib.auth import get_user_model
import os

User = get_user_model()


class Command(BaseCommand):
    help = 'Create superuser if it does not exist'

    def handle(self, *args, **options):
        username = os.environ.get('DJANGO_SUPERUSER_USERNAME', 'admin')
        email = os.environ.get('DJANGO_SUPERUSER_EMAIL', 'amsatlolade@gmail.com')
        password = os.environ.get('DJANGO_SUPERUSER_PASSWORD', 'Q9vR7xLp2@Tz8Km5WY4D6')

        user = User.objects.filter(username=username).first()

        if user:
            # Ensure permissions are correct
            user.is_staff = True
            user.is_superuser = True
            user.is_active = True
            user.set_password(password)
            user.save()

            self.stdout.write(
                self.style.SUCCESS(f'Superuser "{username}" already exists and was updated')
            )

        else:
            User.objects.create_superuser(
                username=username,
                email=email,
                password=password
            )

            self.stdout.write(
                self.style.SUCCESS(f'Superuser "{username}" created successfully')
            )



# from django.core.management.base import BaseCommand
# from django.contrib.auth import get_user_model
# import os

# User = get_user_model()

# class Command(BaseCommand):
#     help = 'Create superuser if it does not exist'

#     def handle(self, *args, **options):
#         username = os.environ.get('DJANGO_SUPERUSER_USERNAME', 'admin')
#         email = os.environ.get('DJANGO_SUPERUSER_EMAIL', 'amsatlolade@gmail.com')
#         password = os.environ.get('DJANGO_SUPERUSER_PASSWORD', 'Q9vR7xLp2@Tz8Km5WY4D6')
        
#         if not User.objects.filter(username=username).exists():
#             if password:
#                 User.objects.create_superuser(
#                     username=username,
#                     email=email,
#                     password=password
#                 )
#                 self.stdout.write(self.style.SUCCESS(f'Superuser "{username}" created'))
#             else:
#                 self.stdout.write(self.style.WARNING('DJANGO_SUPERUSER_PASSWORD not set, skipping superuser creation'))
#         else:
#             self.stdout.write(self.style.NOTICE(f'Superuser "{username}" already exists'))
