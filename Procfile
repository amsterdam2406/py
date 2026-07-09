web: gunicorn fotasco_payroll.wsgi:application \
    --workers=3 \
    --timeout=120 \
    --worker-tmp-dir=/dev/shm \
    --max-requests=1000 \
    --max-requests-jitter=100 \
    --access-logfile=-
worker: celery -A fotasco_payroll worker --loglevel=info --concurrency=2
beat: celery -A fotasco_payroll beat --loglevel=info --scheduler django_celery_beat.schedulers:DatabaseScheduler
