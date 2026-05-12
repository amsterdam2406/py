# payroll/admin.py - MINIMAL VERSION
from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.core.cache import cache
from .models import (
    User, Employee, Attendance, Deduction, 
    Payment, Company, SackedEmployee, Notification, OTP, ExportToken
)

@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ('username', 'email', 'role', 'is_staff', 'is_active')
    list_filter = ('role', 'is_staff', 'is_active', 'is_superuser')
    fieldsets = BaseUserAdmin.fieldsets + (
        ('Role & Permissions', {
            'fields': (
                'role', 'employee_id', 'is_company_admin', 'is_employee_admin',
                'is_payment_admin', 'is_deduction_admin', 'is_request_admin'
            )
        }),
        ('Contact Info', {'fields': ('phone',)}),
    )

@admin.register(Employee)
class EmployeeAdmin(admin.ModelAdmin):
    list_display = ['employee_id', 'name', 'type', 'status']
    actions = ['clear_verification_cache']

    @admin.action(description='Clear Paystack verification cache for selected employees')
    def clear_verification_cache(self, request, queryset):
        count = 0
        for emp in queryset:
            # Reconstruct the key used in paystack.py
            bank_code = emp.bank_code or ""
            key = f"paystack:resolve:{bank_code}:{emp.account_number}"
            if cache.delete(key):
                count += 1
        self.message_user(request, f"Cleared verification cache for {count} employees.")

@admin.register(Attendance)
class AttendanceAdmin(admin.ModelAdmin):
    list_display = ['employee', 'date', 'status']

@admin.register(Deduction)
class DeductionAdmin(admin.ModelAdmin):
    list_display = ['employee', 'amount', 'date', 'status']

@admin.register(Payment)
class PaymentAdmin(admin.ModelAdmin):
    list_display = ['employee', 'net_amount', 'status']

@admin.register(Company)
class CompanyAdmin(admin.ModelAdmin):
    list_display = ['name', 'location']

@admin.register(SackedEmployee)
class SackedEmployeeAdmin(admin.ModelAdmin):
    list_display = ['employee', 'date_sacked']

@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ['user', 'type', 'is_read']

@admin.register(OTP)
class OTPAdmin(admin.ModelAdmin):
    list_display = ['email', 'code', 'is_used']

@admin.register(ExportToken)
class ExportTokenAdmin(admin.ModelAdmin):
    list_display = ['user', 'data_type', 'is_used']