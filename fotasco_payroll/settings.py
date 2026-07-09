"""
Django settings for fotasco_payroll project.
"""

import os
import sys
from pathlib import Path
from decouple import config
from datetime import timedelta
import importlib
import dj_database_url
import socket
from django.core.exceptions import ImproperlyConfigured

# Force IPv4 for Supabase (Render has IPv6 issues)
_original_getaddrinfo = socket.getaddrinfo
def _getaddrinfo_ipv4(host, port, family=0, type=0, proto=0, flags=0, **kwargs):
    socktype = kwargs.pop("socktype", type)
    return _original_getaddrinfo(host, port, socket.AF_INET, socktype, proto, flags)
socket.getaddrinfo = _getaddrinfo_ipv4


import psycopg2

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent

# Quick-start development settings - unsuitable for production
SECRET_KEY = config('SECRET_KEY')
def _safe_debug_bool(value):
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "f", "no", "n", "off", "release", "production", "prod", ""}:
        return False
    return False

DEBUG = config('DEBUG', default=False, cast=_safe_debug_bool)

# ==================
# CLOUDINARY SETUP (Safe)
# =======================

CLOUDINARY_CLOUD_NAME = os.environ.get('CLOUDINARY_CLOUD_NAME', '')
CLOUDINARY_API_KEY = os.environ.get('CLOUDINARY_API_KEY', '')
CLOUDINARY_API_SECRET = os.environ.get('CLOUDINARY_API_SECRET', '')

# Try to import and configure Cloudinary
cloudinary_available = False
try:
    import cloudinary
    import cloudinary.uploader
    import cloudinary.api
    
    if CLOUDINARY_CLOUD_NAME and CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET:
        cloudinary.config(
            cloud_name=CLOUDINARY_CLOUD_NAME,
            api_key=CLOUDINARY_API_KEY,
            api_secret=CLOUDINARY_API_SECRET,
            secure=True
        )
        cloudinary_available = True
        print("Cloudinary configured successfully")
    else:
        print("Cloudinary env vars missing - using local storage")
except ImportError:
    print("[warning]Cloudinary not installed - using local storage")

# ============================================
# FILE STORAGE CONFIGURATION
# ============================================

MEDIA_URL = '/media/'
MEDIA_ROOT = os.path.join(BASE_DIR, 'media')

# Django 5.x STORAGES configuration
if CLOUDINARY_CLOUD_NAME and CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET:
    STORAGES = {
        "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
        "default": {"BACKEND": "cloudinary_storage.storage.MediaCloudinaryStorage"},
    }
else:
    STORAGES = {
        "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
        "default": {
            "BACKEND": "django.core.files.storage.FileSystemStorage",
            "OPTIONS": {"location": MEDIA_ROOT, "base_url": MEDIA_URL},
        },
    }

# Static Files
STATIC_URL = '/static/'
STATICFILES_DIRS = [BASE_DIR / "static"]
STATIC_ROOT = os.path.join(BASE_DIR, 'staticfiles')

# Compatibility for django-cloudinary-storage 0.3.0, whose collectstatic
# command still reads Django's pre-4.2 storage setting names.
STATICFILES_STORAGE = "whitenoise.storage.CompressedManifestStaticFilesStorage"
DEFAULT_FILE_STORAGE = STORAGES["default"]["BACKEND"]

WHITENOISE_MAX_AGE = 31536000

ALLOWED_HOSTS = [
    'fot-pyroll.onrender.com',
    '.onrender.com',
    'localhost',
    '127.0.0.1',
]

# Application definition
INSTALLED_APPS = [
    'django.contrib.admin',
    'corsheaders',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'simple_history',
    
    # Third-party apps
    'rest_framework',
    'rest_framework_simplejwt',
    'django_filters',
    'rest_framework_simplejwt.token_blacklist',
    'csp',
    
    # Local apps
    'payroll',
    'django_extensions',
    'django_celery_beat',
]

# Cloudinary is used for uploaded media only. Do not add cloudinary_storage to
# INSTALLED_APPS here because its collectstatic command overrides Django's and
# breaks WhiteNoise static manifest processing on Render.
if cloudinary_available:
    INSTALLED_APPS.insert(0, 'cloudinary')

MIDDLEWARE = [
    'simple_history.middleware.HistoryRequestMiddleware',
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'csp.middleware.CSPMiddleware',
    'whitenoise.middleware.WhiteNoiseMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'fotasco_payroll.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [
            os.path.join(BASE_DIR, 'front_admin', 'templates'),
            BASE_DIR / 'templates',
        ],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'fotasco_payroll.wsgi.application'

# Custom CSRF failure handler
CSRF_FAILURE_VIEW = 'payroll.views.csrf_failure'

# ============================================
# DATABASE (Supabase PostgreSQL)
# ============================================

DATABASE_URL = config("DATABASE_URL", default=None)


if DATABASE_URL:
    DATABASES = {
        "default": dj_database_url.config(
            default=DATABASE_URL,
            conn_max_age=300,
            conn_health_checks=False,
            ssl_require=True,
        )
    }

    DATABASES["default"]["OPTIONS"] = {
        "connect_timeout": 10,
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        }
    }

if len(sys.argv) > 1 and sys.argv[1] == 'test':
    TEST_DATABASE_URL = config("TEST_DATABASE_URL", default=None)
    if TEST_DATABASE_URL:
        DATABASES["default"] = dj_database_url.parse(TEST_DATABASE_URL, conn_max_age=0)
    else:
        DATABASES["default"] = {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "test_db.sqlite3",
        }


# ============================================
# REDIS & CELERY
# ============================================

REDIS_URL = os.environ.get('REDIS_URL')

if REDIS_URL and 'localhost' not in REDIS_URL and '127.0.0.1' not in REDIS_URL:
    CACHES = {
        'default': {
            'BACKEND': 'django_redis.cache.RedisCache',
            'LOCATION': REDIS_URL,
            'OPTIONS': {
                'CLIENT_CLASS': 'django_redis.client.DefaultClient',
                'IGNORE_EXCEPTIONS': True,
            },
            'TIMEOUT': 300,
        }
    }
else:
    CACHES = {
        "default": {
            "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        }
    }

CELERY_BROKER_URL = REDIS_URL
CELERY_RESULT_BACKEND = REDIS_URL
CELERY_ACCEPT_CONTENT = ['json']
CELERY_TASK_SERIALIZER = 'json'
CELERY_RESULT_SERIALIZER = 'json'
CELERY_TASK_TRACK_STARTED = True
CELERY_TASK_TIME_LIMIT = 30 * 60
CELERY_TASK_SOFT_TIME_LIMIT = 25 * 60
CELERY_TIMEZONE = 'Africa/Lagos'
CELERY_ENABLE_UTC = True
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True
CELERY_TASK_ACKS_LATE = True
CELERY_TASK_REJECT_ON_WORKER_LOST = True
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_WORKER_HIJACK_ROOT_LOGGER = False
CELERY_BROKER_TRANSPORT_OPTIONS = {
    'visibility_timeout': 60 * 60,
    'socket_keepalive': True,
    'health_check_interval': 30,
}
CELERY_RESULT_BACKEND_TRANSPORT_OPTIONS = {
    'retry_policy': {
        'timeout': 5.0,
    },
}

CELERY_BEAT_SCHEDULE = {
    'monitor-paystack-health-every-minute': {
        'task': 'payroll.tasks.monitor_paystack_health',
        'schedule': 60.0,
    },
    'verify-stale-payments-every-10-minutes': {
        'task': 'payroll.tasks.verify_processing_payments',
        'schedule': 600.0,
    },
}

# ============================================
# AUTH & REST FRAMEWORK
# ============================================

AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'payroll.password_validators.ComplexPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
        'OPTIONS': {'min_length': 8}
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]

AUTHENTICATION_BACKENDS = [
    'payroll.authentication.EmailOrUsernameBackend',
]

AUTH_USER_MODEL = 'payroll.User'

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
    'DEFAULT_RENDERER_CLASSES': [
        'rest_framework.renderers.JSONRenderer',
    ],
    'DEFAULT_FILTER_BACKENDS': [
        'django_filters.rest_framework.DjangoFilterBackend',
        'rest_framework.filters.SearchFilter',
        'rest_framework.filters.OrderingFilter',
    ],
    'DEFAULT_THROTTLE_CLASSES': [
        'rest_framework.throttling.AnonRateThrottle',
        'rest_framework.throttling.UserRateThrottle',
        'rest_framework.throttling.ScopedRateThrottle',
    ],
    'DEFAULT_THROTTLE_RATES': {
        'anon': '100/min',
        'user': '60/min',
        'login': '5/min',
        'attendance': '10/min',
        'payment': '20/hour',
        'bulk_payment': '5/hour',
        'register': '30/hour',
        'verify_password': '5/min',
        'otp': '10/hour',
        'export': '10/hour',
        'bank_verify': '20/min',
    },
    'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
    'PAGE_SIZE': 20,
}

SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=15),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=7),
    'ROTATE_REFRESH_TOKENS': False,
    'BLACKLIST_AFTER_ROTATION': False,
    'AUTH_HEADER_TYPES': ('Bearer',),
    'AUTH_TOKEN_CLASSES': ('rest_framework_simplejwt.tokens.AccessToken',),
    'ALGORITHM': 'HS256',
}

PASSWORD_RESET_TIMEOUT = 86400

# ============================================
# CORS & SECURITY
# ============================================

CORS_ALLOWED_ORIGINS = [
    "https://fot-pyroll.onrender.com",
]

CSRF_TRUSTED_ORIGINS = [
    'https://fot-pyroll.onrender.com',
]

CORS_ALLOW_CREDENTIALS = True

# Paystack
PAYSTACK_SECRET_KEY = config('PAYSTACK_SECRET_KEY', default='')
PAYSTACK_PUBLIC_KEY = config('PAYSTACK_PUBLIC_KEY', default='')
PAYSTACK_CALLBACK_URL = config('PAYSTACK_CALLBACK_URL', default='https://fot-pyroll.onrender.com/api/payments/callback/')
PAYSTACK_BASE_URL = 'https://api.paystack.co'
PAYSTACK_REQUEST_TIMEOUT_SECONDS = config('PAYSTACK_REQUEST_TIMEOUT_SECONDS', default=8, cast=int)
PAYSTACK_TRANSFER_TIMEOUT_SECONDS = config('PAYSTACK_TRANSFER_TIMEOUT_SECONDS', default=10, cast=int)
PAYSTACK_BULK_TRANSFER_TIMEOUT_SECONDS = config('PAYSTACK_BULK_TRANSFER_TIMEOUT_SECONDS', default=12, cast=int)
PAYSTACK_ACCOUNT_RESOLVE_TIMEOUT_SECONDS = config('PAYSTACK_ACCOUNT_RESOLVE_TIMEOUT_SECONDS', default=4, cast=int)
PAYSTACK_ACCOUNT_RESOLVE_ATTEMPTS = config('PAYSTACK_ACCOUNT_RESOLVE_ATTEMPTS', default=2, cast=int)

# Email
EMAIL_BACKEND = 'payroll.email_backend.ResendEmailBackend'
RESEND_API_KEY = config('RESEND_API_KEY', default='')
RESEND_API_URL = config('RESEND_API_URL', default='https://api.resend.com/emails')
RESEND_SENDER_EMAIL = config('RESEND_SENDER_EMAIL', default='')
RESEND_SENDER_NAME = config('RESEND_SENDER_NAME', default='FOTASCO Payroll NoReply')
RESEND_REPLY_TO = config('RESEND_REPLY_TO', default='')
RESEND_EMAIL_CONNECT_TIMEOUT_SECONDS = config('RESEND_EMAIL_CONNECT_TIMEOUT_SECONDS', default=2, cast=int)
RESEND_EMAIL_READ_TIMEOUT_SECONDS = config('RESEND_EMAIL_READ_TIMEOUT_SECONDS', default=5, cast=int)
RESEND_EMAIL_RETRIES = config('RESEND_EMAIL_RETRIES', default=1, cast=int)
RESEND_EMAIL_WORKERS = config('RESEND_EMAIL_WORKERS', default=2, cast=int)
RESEND_EMAIL_MAX_QUEUED_TASKS = config('RESEND_EMAIL_MAX_QUEUED_TASKS', default=100, cast=int)
DEFAULT_FROM_EMAIL = f"{RESEND_SENDER_NAME} <{RESEND_SENDER_EMAIL}>"
INTERNAL_PAYMENT_OTP_EXPIRY_SECONDS = config('INTERNAL_PAYMENT_OTP_EXPIRY_SECONDS', default=60, cast=int)
PAYSTACK_TRANSFER_OTP_ENABLED = config('PAYSTACK_TRANSFER_OTP_ENABLED', default=False, cast=bool)

if EMAIL_BACKEND == 'payroll.email_backend.ResendEmailBackend':
    _is_validation_command = len(sys.argv) > 1 and sys.argv[1] in {'check', 'test', 'makemigrations', 'shell'}
    missing_resend_settings = [
        name for name, value in {
            'RESEND_API_KEY': RESEND_API_KEY,
            'RESEND_SENDER_EMAIL': RESEND_SENDER_EMAIL,
        }.items()
        if not str(value or '').strip()
    ]
    if missing_resend_settings and not _is_validation_command:
        raise ImproperlyConfigured(
            "Resend email configuration is incomplete. Missing required environment variable(s): "
            + ", ".join(missing_resend_settings)
        )


# ============================================
# INTERNATIONALIZATION
# ============================================

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'Africa/Lagos'
USE_I18N = True
USE_TZ = True

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# ============================================
# PRODUCTION SECURITY
# ============================================

if not DEBUG:
    SECURE_SSL_REDIRECT = True

    # HTTP Strict Transport Security (HSTS)
    SECURE_HSTS_SECONDS = 31536000          # 1 year
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True

    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SECURE_CONTENT_TYPE_NOSNIFF = True
    X_FRAME_OPTIONS = 'DENY'
    SECURE_REFERRER_POLICY = 'strict-origin-when-cross-origin'
    CSRF_COOKIE_HTTPONLY = True
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SESSION_COOKIE_SAMESITE = 'Lax'
    CSRF_COOKIE_SAMESITE = 'Lax'
    SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin"
    SESSION_ENGINE = 'django.contrib.sessions.backends.db'
    SESSION_COOKIE_AGE = 1209600
    SESSION_SAVE_EVERY_REQUEST = True

PAYSTACK_OTP_EXPIRY_MINUTES = 30
PAYSTACK_STALE_MINUTES = 60

# ============================================
# CONTENT SECURITY POLICY
# ============================================

CONTENT_SECURITY_POLICY = {
    'DIRECTIVES': {
        'default-src': ("'self'",),
        'style-src': (
            "'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"
        ),
        'script-src': (
            "'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"
        ),
        'font-src': (
            "'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"
        ),
        'img-src': (
            "'self'", "data:", "blob:", "https://cdn.paystack.com", "https://res.cloudinary.com"
        ),
        'media-src': ("'self'", "blob:"),
        'frame-src': ("'self'", "https://js.paystack.co"),
        'connect-src': ("'self'", "https://api.paystack.co", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"),
    }
}

# ============================================
# LOGGING
# ============================================

LOGS_DIR = os.path.join(BASE_DIR, 'logs')
if not os.path.exists(LOGS_DIR):
    os.makedirs(LOGS_DIR, exist_ok=True)

LOG_LEVEL = 'DEBUG' if DEBUG else 'INFO'

LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {
        'verbose': {
            'format': '{levelname} {asctime} {module} {process:d} {thread:d} {message}',
            'style': '{',
        },
        'simple': {
            'format': '{levelname} {asctime} {message}',
            'style': '{',
        },
    },
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
            'level': LOG_LEVEL,
            'formatter': 'simple',
        },
        'file': {
            'class': 'logging.handlers.RotatingFileHandler',
            'filename': os.path.join(BASE_DIR, 'logs', 'django.log'),
            'maxBytes': 10485760,
            'backupCount': 5,
            'formatter': 'verbose',
        },
    },
    'root': {
        'handlers': ['console', 'file'],
        'level': LOG_LEVEL,
    },
    'loggers': {
        'django': {
            'handlers': ['console', 'file'],
            'level': 'INFO',
            'propagate': False,
        },
        'payroll': {
            'handlers': ['console', 'file'],
            'level': 'INFO',
            'propagate': False,
        },
        'payroll.webhook': {
            'handlers': ['console', 'file'],
            'level': 'DEBUG',
            'propagate': False,
        },
        'celery': {
            'handlers': ['console', 'file'],
            'level': 'INFO',
            'propagate': False,
        },
        'kombu': {
            'handlers': ['console', 'file'],
            'level': 'WARNING',
            'propagate': False,
        },
    },
}
