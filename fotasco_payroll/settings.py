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

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent

# Quick-start development settings - unsuitable for production
SECRET_KEY = config('SECRET_KEY')
DEBUG = config('DEBUG', default=False, cast=bool)

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

# Add cloudinary_storage only if available
if cloudinary_available:
    INSTALLED_APPS.insert(0, 'cloudinary_storage')  # Must be before django.contrib.staticfiles
    INSTALLED_APPS.insert(1, 'cloudinary')

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

# ============================================
# DATABASE (Supabase PostgreSQL)
# ============================================

DATABASE_URL = os.environ.get("DATABASE_URL")

if DATABASE_URL:
    try:
        DATABASES = {
            'default': dj_database_url.config(
                default=DATABASE_URL,
                conn_max_age=600,
                conn_health_checks=True,
                ssl_require=not DEBUG,
            )
        }
        print("✅ Connected to PostgreSQL database")
    except Exception as e:
        import warnings
        warnings.warn(f"DATABASE_URL parse failed: {e}. Falling back to SQLite.")
        DATABASES = {
            'default': {
                'ENGINE': 'django.db.backends.sqlite3',
                'NAME': os.path.join(BASE_DIR, 'db.sqlite3'),
            }
        }
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': os.path.join(BASE_DIR, 'db.sqlite3'),
        }
    }

# ============================================
# REDIS & CELERY
# ============================================

REDIS_URL = os.environ.get('REDIS_URL', 'redis://127.0.0.1:6379/0')

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
CELERY_TIMEZONE = 'Africa/Lagos'
CELERY_ENABLE_UTC = True

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
    'django.contrib.auth.backends.ModelBackend',
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

# Email
EMAIL_BACKEND = 'django.core.mail.backends.smtp.EmailBackend'
EMAIL_HOST = config('EMAIL_HOST', default='smtp.gmail.com')
EMAIL_PORT = config('EMAIL_PORT', default=587, cast=int)
EMAIL_USE_TLS = config('EMAIL_USE_TLS', default=True, cast=bool)
EMAIL_HOST_USER = config('EMAIL_HOST_USER')
EMAIL_HOST_PASSWORD = config('EMAIL_HOST_PASSWORD')
DEFAULT_FROM_EMAIL = config('DEFAULT_FROM_EMAIL', default='noreply@fotasco.com')

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
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SECURE_CONTENT_TYPE_NOSNIFF = True
    X_FRAME_OPTIONS = 'DENY'
    SECURE_REFERRER_POLICY = 'strict-origin-when-cross-origin'
    CSRF_COOKIE_HTTPONLY = True
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_BROWSER_XSS_FILTER = True
    SESSION_COOKIE_SAMESITE = 'Lax'
    CSRF_COOKIE_SAMESITE = 'Lax'
    SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin"
    SESSION_ENGINE = 'django.contrib.sessions.backends.db'
    SESSION_COOKIE_AGE = 1209600
    SESSION_SAVE_EVERY_REQUEST = True

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
    },
}