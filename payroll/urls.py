from django.urls import path, include
from rest_framework.routers import DefaultRouter
from . import views
from . import auth_views

router = DefaultRouter()
router.register(r'users', views.UserViewSet)
router.register(r'employees', views.EmployeeViewSet)
router.register(r'attendance', views.AttendanceViewSet)
router.register(r'deductions', views.DeductionViewSet)
router.register(r'payments', views.PaymentViewSet)
router.register(r'companies', views.CompanyViewSet)
router.register(r'sacked-employees', views.SackedEmployeeViewSet)
router.register(r'notifications', views.NotificationViewSet)
router.register(r'requests', views.EmployeeRequestViewSet)
router.register(r'download-logs', views.DownloadLogViewSet, basename='download-logs')

urlpatterns = [
    path('', views.frontend, name='frontend'),
    path('api/', include(router.urls)),
    
    # Auth
    path('login/', auth_views.login_view, name='login'),
    path('logout/', auth_views.logout_view, name='logout'),
    path('token/refresh/', auth_views.CookieTokenRefreshView.as_view(), name='token_refresh'),
    path('current-user/', auth_views.CurrentUserView.as_view(), name='current_user'),
    path('register/', auth_views.register_view, name='register'),
    path('self-register/', auth_views.self_register_employee, name='self_register'),



    path('request-reset/', auth_views.request_password_reset, name='request_reset'),
    path('reset-password/confirm/<uidb64>/<token>/', auth_views.reset_password_confirm, name='password_reset_confirm'),
    
    # Paystack
    path('paystack/banks/', views.paystack_banks, name='paystack_banks'),
    path('paystack/verify-account/', views.PaystackVerifyAccountView.as_view(), name='paystack_verify_account'),
    path('paystack/resolve-account/', views.paystack_resolve_account, name='paystack_resolve_account'),

    path('paystack/clear-cache/', views.clear_paystack_cache, name='clear_paystack_cache'),

    
    # WEBHOOK: Only ONE endpoint. Paystack should point here:
    path('paystack/webhook/', views.paystack_webhook, name='paystack_webhook'),
    
    # Other
    path('verify-password/', auth_views.verify_password, name='verify_password'),
    path('change-password/', auth_views.change_password, name='change_password'),
    path('next-employee-id/', auth_views.get_next_employee_id, name='next_employee_id'),
    path('payments/verify-payment/<str:reference>/', views.verify_payment_status, name='verify_payment_status'),
    path('health-check/', views.system_health_check, name='health_check'),
]