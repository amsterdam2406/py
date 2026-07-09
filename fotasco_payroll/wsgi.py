"""
WSGI config for the fotasco_payroll project.

This exposes Django's WSGI callable as ``application``. It remains the current
production entry point for the Render Gunicorn web service.
"""

import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'fotasco_payroll.settings')

application = get_wsgi_application()
