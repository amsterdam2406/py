"""
Celery application bootstrap for the FOTASCO payroll project.

This module is intentionally small: Django settings remain the source of truth
for CELERY_* configuration, while Celery owns task discovery and worker logging.
"""

import os
from logging.config import dictConfig

from celery import Celery
from celery.signals import beat_init, setup_logging, worker_init
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "fotasco_payroll.settings")

app = Celery("fotasco_payroll")
app.config_from_object("django.conf:settings", namespace="CELERY")
app.autodiscover_tasks()


def _require_redis_broker(**_kwargs):
    if not app.conf.broker_url:
        raise ImproperlyConfigured(
            "REDIS_URL is required before starting Celery worker or beat."
        )


@setup_logging.connect
def configure_celery_logging(**_kwargs):
    dictConfig(settings.LOGGING)


worker_init.connect(_require_redis_broker)
beat_init.connect(_require_redis_broker)
