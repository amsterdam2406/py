"""
ASGI config for the fotasco_payroll project.

This exposes Django's HTTP ASGI callable as ``application``. The production
Render web service currently uses WSGI/Gunicorn, so this file is kept ready for
future ASGI servers or Django Channels without changing today's deployment.
"""

import os

from django.core.asgi import get_asgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'fotasco_payroll.settings')

application = get_asgi_application()
