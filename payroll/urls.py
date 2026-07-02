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
router.register(r'salary-adjustments', views.EmployeeSalaryAdjustmentViewSet)
router.register(r'client-payments', views.ClientMonthlyPaymentViewSet)
router.register(r'employee-balances', views.EmployeeBalanceLedgerViewSet, basename='employee-balances')

urlpatterns = [
    path('', views.frontend, name='frontend'),
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
    path('approve-transfer/', views.approve_paystack_transfer, name='approve_paystack_transfer'),
    path('paystack/clear-cache/', views.clear_paystack_cache, name='clear_paystack_cache'),
    path('paystack/webhook/', views.paystack_webhook, name='paystack_webhook'),

    # Other
    path('verify-password/', auth_views.verify_password, name='verify_password'),
    path('change-password/', auth_views.change_password, name='change_password'),
    path('next-employee-id/', auth_views.get_next_employee_id, name='next_employee_id'),
    path('payments/verify-payment/<str:reference>/', views.verify_payment_status, name='verify_payment_status'),
    path('api/payments/verify-payment/<str:reference>/', views.verify_payment_status, name='api_verify_payment_status'),
    path('health-check/', views.system_health_check, name='health_check'),

    # === MISSING ENDPOINTS ADDED ===
    # Attendance Actions
    path('api/attendance/clock-in/', views.AttendanceViewSet.as_view({'post': 'clock_in'}), name='clock_in'),
    path('api/attendance/clock-out/', views.AttendanceViewSet.as_view({'post': 'clock_out'}), name='clock_out'),
    path('api/attendance/clock-in-photo/', views.AttendanceViewSet.as_view({'post': 'clock_in_with_photo'}), name='clock_in_with_photo'),
    path('api/attendance/clock-out-photo/', views.AttendanceViewSet.as_view({'post': 'clock_out_with_photo'}), name='clock_out_with_photo'),
    path('api/attendance/clock-out-boxmark/', views.AttendanceViewSet.as_view({'post': 'clock_out_boxmark'}), name='clock_out_boxmark'),
    path('api/attendance/mark-leave/', views.AttendanceViewSet.as_view({'post': 'mark_leave'}), name='mark_leave'),

    # Employee Actions
    path('api/employees/<uuid:pk>/terminate/', views.EmployeeViewSet.as_view({'post': 'terminate'}), name='employee_terminate'),
    path('api/employees/<uuid:pk>/resign/', views.EmployeeViewSet.as_view({'post': 'resign'}), name='employee_resign'),
    path('api/employees/<uuid:pk>/approve/', views.EmployeeViewSet.as_view({'post': 'approve'}), name='employee_approve'),
    path('api/employees/<uuid:pk>/resend-confirmation/', views.EmployeeViewSet.as_view({'post': 'resend_confirmation'}), name='employee_resend_confirmation'),
    path('api/employees/bulk-approve/', views.EmployeeViewSet.as_view({'post': 'bulk_approve'}), name='employee_bulk_approve'),
    path('api/employees/dashboard-stats/', views.EmployeeViewSet.as_view({'get': 'dashboard_stats'}), name='dashboard_stats'),
    path('api/employees/<uuid:pk>/net-salary/', views.EmployeeViewSet.as_view({'get': 'net_salary'}), name='net_salary'),
    path('api/employees/request-export/', views.EmployeeViewSet.as_view({'post': 'request_export'}), name='request_export'),
    path('api/employees/export-csv/', views.EmployeeViewSet.as_view({'get': 'export_csv'}), name='export_csv'),
    path('api/employees/verify-2fa/', views.EmployeeViewSet.as_view({'post': 'verify_2fa'}), name='verify_2fa'),

    # Payment Actions
    path('api/payments/sync-processing/', views.PaymentViewSet.as_view({'post': 'sync_processing_payments'}), name='sync_processing_payments'),
    path('api/payments/sync_processing/', views.PaymentViewSet.as_view({'post': 'sync_processing_payments'}), name='sync_processing_payments_underscore'),
    path('api/payments/paystack-balance/', views.PaymentViewSet.as_view({'get': 'paystack_balance'}), name='paystack_balance'),
    path('api/payments/paystack_balance/', views.PaymentViewSet.as_view({'get': 'paystack_balance'}), name='paystack_balance_underscore'),
    path('api/payments/initiate_payment/', views.PaymentViewSet.as_view({'post': 'initiate_payment'}), name='initiate_payment'),
    path('api/payments/initiate-payment/', views.PaymentViewSet.as_view({'post': 'initiate_payment'}), name='initiate_payment_hyphen'),
    path('api/payments/<uuid:pk>/hr-approve/', views.PaymentViewSet.as_view({'post': 'hr_approve'}), name='payment_hr_approve'),
    path('api/payments/bulk-hr-approve/', views.PaymentViewSet.as_view({'post': 'bulk_hr_approve'}), name='payment_bulk_hr_approve'),
    path('api/payments/bulk-payment/', views.PaymentViewSet.as_view({'post': 'bulk_payment'}), name='bulk_payment'),
    path('api/payments/bulk_payment/', views.PaymentViewSet.as_view({'post': 'bulk_payment'}), name='bulk_payment_underscore'),
    path('api/payments/verify-payment/', views.PaymentViewSet.as_view({'post': 'verify_payment'}), name='verify_payment'),
    path('api/payments/verify_payment/', views.PaymentViewSet.as_view({'post': 'verify_payment'}), name='verify_payment_underscore'),
    path('api/payments/finalize-transfer/', views.PaymentViewSet.as_view({'post': 'finalize_paystack_transfer'}), name='finalize_paystack_transfer'),
    path('api/payments/finalize_paystack_transfer/', views.PaymentViewSet.as_view({'post': 'finalize_paystack_transfer'}), name='finalize_paystack_transfer_underscore'),
    path('api/payments/resend-otp/', views.PaymentViewSet.as_view({'post': 'resend_otp'}), name='resend_otp'),
    path('api/payments/resend_otp/', views.PaymentViewSet.as_view({'post': 'resend_otp'}), name='resend_otp_underscore'),
    path('api/payments/generate-payslip/', views.PaymentViewSet.as_view({'post': 'generate_payslip'}), name='generate_payslip'),
    path('api/payments/generate_payslip/', views.PaymentViewSet.as_view({'post': 'generate_payslip'}), name='generate_payslip_underscore'),
    path('api/payments/bulk-preview/', views.PaymentViewSet.as_view({'post': 'bulk_preview'}), name='bulk_preview'),
    path('api/payments/bulk_preview/', views.PaymentViewSet.as_view({'post': 'bulk_preview'}), name='bulk_preview_underscore'),
    path('api/payments/request-payslip-export/', views.PaymentViewSet.as_view({'post': 'request_payslip_export'}), name='request_payslip_export'),
    path('api/payments/request_payslip_export/', views.PaymentViewSet.as_view({'post': 'request_payslip_export'}), name='request_payslip_export_underscore'),
    path('api/payments/download-payslip-pdf/', views.PaymentViewSet.as_view({'get': 'download_payslip_pdf'}), name='download_payslip_pdf'),
    path('api/payments/<uuid:pk>/request-receipt-export/', views.PaymentViewSet.as_view({'post': 'request_receipt_export'}), name='request_receipt_export'),
    path('api/payments/download-receipt-pdf/', views.PaymentViewSet.as_view({'get': 'download_receipt_pdf'}), name='download_receipt_pdf'),
    path('api/payments/request-export/', views.PaymentViewSet.as_view({'post': 'request_export'}), name='payment_request_export'),
    path('api/payments/export-csv/', views.PaymentViewSet.as_view({'get': 'export_csv'}), name='payment_export_csv'),

    # Deduction Actions
    path('api/deductions/bulk-approve/', views.DeductionViewSet.as_view({'post': 'bulk_approve'}), name='deduction_bulk_approve'),
    path('api/deductions/<uuid:pk>/hr-approve/', views.DeductionViewSet.as_view({'post': 'hr_approve'}), name='deduction_hr_approve'),
    path('api/deductions/<uuid:pk>/update-status/', views.DeductionViewSet.as_view({'put': 'update_status'}), name='deduction_update_status'),

    # Sacked Employee Actions
    path('api/sacked-employees/<uuid:pk>/reinstate/', views.SackedEmployeeViewSet.as_view({'post': 'reinstate'}), name='sacked_reinstate'),

    # Notification Actions
    path('api/notifications/mark-all-read/', views.NotificationViewSet.as_view({'post': 'mark_all_read'}), name='mark_all_read'),

    # Company Actions
    path('api/companies/<uuid:pk>/profit/', views.CompanyViewSet.as_view({'get': 'profit'}), name='company_profit'),
    path('api/companies/<uuid:pk>/renew-contract/', views.CompanyViewSet.as_view({'post': 'renew_contract'}), name='company_renew'),
    path('api/companies/<uuid:pk>/terminate-contract/', views.CompanyViewSet.as_view({'post': 'terminate_contract'}), name='company_terminate'),

    # Request Actions
    path('api/requests/<uuid:pk>/approve/', views.EmployeeRequestViewSet.as_view({'post': 'approve'}), name='request_approve'),
    path('api/requests/<uuid:pk>/decline/', views.EmployeeRequestViewSet.as_view({'post': 'decline'}), name='request_decline'),
    path('api/requests/<uuid:pk>/download-attachments/', views.EmployeeRequestViewSet.as_view({'post': 'download_attachments'}), name='request_download_attachments'),
    path('api/', include(router.urls)),
]
