# payroll/admin.py — PRODUCTION READY (Updated UserAdmin)
from django.contrib import admin, messages
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.core.cache import cache
from django.contrib.auth.forms import AuthenticationForm
from django import forms
from django.db.models import ProtectedError, RestrictedError
from django.urls import reverse
from .models import (
    User, Employee, Attendance, Deduction, 
    Payment, Company, SackedEmployee, Notification, 
    OTP, ExportToken, EmployeeRequest, EmployeeRequestAttachment,
    DownloadLog, AuditLog, EmployeeBalanceLedger
)
from .paystack import PaystackAccountResolutionService
from .services import paystack_recipient_fingerprint_key
from django.utils.html import format_html
from urllib.parse import quote


def private_media_admin_url(file_field):
    name = getattr(file_field, 'name', '')
    if not name:
        return ''
    return reverse('private_media', kwargs={'path': quote(name)})

# ─────────────────────────────────────────────
# USER ADMIN (SAFE DELETE)
# ─────────────────────────────────────────────

class EmailAuthenticationForm(AuthenticationForm):
    """Custom admin login form that accepts username only."""
    username = forms.CharField(
        label="Username",
        widget=forms.TextInput(attrs={"autofocus": True})
    )

class CustomAdminSite(admin.AdminSite):
    login_form = EmailAuthenticationForm
    site_header = "Fotasco Payroll Administration"
    site_title = "Fotasco Admin"

admin_site = CustomAdminSite(name='customadmin')
admin.site.login_form = EmailAuthenticationForm
admin.site.site_header = "Fotasco Payroll Administration"
admin.site.site_title = "Fotasco Admin"



@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ['username', 'email', 'role', 'is_staff', 'is_superuser', 'date_joined']
    list_filter = ['role', 'is_superuser', 'is_active']
    search_fields = ['username', 'email', 'first_name', 'last_name']
    ordering = ['-date_joined']

    fieldsets = BaseUserAdmin.fieldsets + (
        ('Role & Permissions', {
            'fields': (
                'role',
                'is_company_admin', 'is_employee_admin', 'is_attendance_admin',
                'is_payment_admin', 'is_deduction_admin',
                'is_hr_admin', 'is_request_admin',
                'is_notification_admin', 'is_password_admin',
            )
        }),
        ('Contact Info', {'fields': ('phone',)}),
    )

    actions = ['safe_delete_users']

    @admin.action(description='Safely delete selected users (handles related data)')
    def safe_delete_users(self, request, queryset):
        """Delete users one by one, catching protected/restricted errors."""
        deleted = 0
        skipped = 0
        errors = []

        for user in queryset:
            try:
                employee = user.employee_profile
            except Employee.DoesNotExist:
                employee = None

            try:
                related_issues = []  # FIX: Initialize the variable

                if employee:
                    count = user.processed_payments.count()
                    if count:
                        related_issues.append(f"{count} processed payments")

                    if user.hr_approved_payments.exists():
                        related_issues.append(f"{user.hr_approved_payments.count()} HR-approved payments")

                    if user.hr_approved_deductions.exists():
                        related_issues.append(f"{user.hr_approved_deductions.count()} HR-approved deductions")

                    if user.handled_requests.exists():
                        related_issues.append(f"{user.handled_requests.count()} handled requests")

                    if user.termination_records.exists():
                        related_issues.append(f"{user.termination_records.count()} termination records")

                if user.notifications.exists():
                    related_issues.append(f"{user.notifications.count()} notifications")

                if hasattr(user, 'auditlog_set') and user.auditlog_set.exists():
                    related_issues.append(f"{user.auditlog_set.count()} audit logs")

                if hasattr(user, 'download_logs') and user.download_logs.exists():
                    related_issues.append(f"{user.download_logs.count()} download logs")

                if hasattr(user, 'export_tokens') and user.export_tokens.exists():
                    related_issues.append(f"{user.export_tokens.count()} export tokens")

                if related_issues:
                    errors.append(f"Skipped {user.username}: linked to {', '.join(related_issues)}")
                    skipped += 1
                    continue

                user.delete()
                deleted += 1

            except (ProtectedError, RestrictedError) as e:
                errors.append(f"Cannot delete {user.username}: protected by database constraint")
                skipped += 1
            except Exception as e:
                errors.append(f"Error deleting {user.username}: {str(e)}")
                skipped += 1

        if deleted:
            self.message_user(request, f"Successfully deleted {deleted} user(s).", messages.SUCCESS)
        if skipped:
            self.message_user(request, f"Skipped {skipped} user(s) due to related data.", messages.WARNING)
        if errors:
            for error in errors[:5]:
                self.message_user(request, error, messages.ERROR)
            if len(errors) > 5:
                self.message_user(request, f"... and {len(errors) - 5} more issues.", messages.ERROR)

    def delete_model(self, request, obj):
        """Override single delete to catch errors gracefully."""
        try:
            if hasattr(obj, 'employee_profile'):
                self.message_user(
                    request,
                    f"Cannot delete {obj.username}: they have an Employee profile ({obj.employee_profile.employee_id}). "
                    "Delete the Employee record first, or change the Employee's user link.",
                    messages.ERROR
                )
                return

            obj.delete()
            self.message_user(request, f"User {obj.username} deleted successfully.", messages.SUCCESS)

        except (ProtectedError, RestrictedError) as e:
            self.message_user(
                request,
                f"Cannot delete {obj.username}: protected by database constraints. "
                "This user is linked to other records (payments, deductions, audit logs, etc.).",
                messages.ERROR
            )
        except Exception as e:
            self.message_user(
                request,
                f"Error deleting {obj.username}: {str(e)}",
                messages.ERROR
            )

    def has_delete_permission(self, request, obj=None):
        return True


# ─────────────────────────────────────────────
# EMPLOYEE ADMIN
# ─────────────────────────────────────────────
@admin.register(Employee)
class EmployeeAdmin(admin.ModelAdmin):
    list_display = ['employee_id', 'name', 'type', 'location', 'salary', 'status', 'join_date']
    list_filter = ['type', 'status', 'location', 'join_date']
    search_fields = ['employee_id', 'name', 'email', 'phone']
    date_hierarchy = 'join_date'
    readonly_fields = ['employee_id', 'id_sequence', 'created_at', 'updated_at', 'user']
    actions = ['clear_verification_cache', 'reset_paystack_recipient_codes']

    @admin.action(description='Clear Paystack verification cache for selected employees')
    def clear_verification_cache(self, request, queryset):
        count = 0
        for emp in queryset:
            bank_code = emp.bank_code or ""
            account_number = emp.account_number or ""
            cache.delete_many([
                PaystackAccountResolutionService.cache_key(bank_code, account_number),
                PaystackAccountResolutionService.legacy_cache_key(bank_code, account_number),
            ])
            count += 1
        self.message_user(request, f"Cleared verification cache for {count} employees.")

    @admin.action(description='Reset Paystack recipient codes for selected employees')
    def reset_paystack_recipient_codes(self, request, queryset):
        count = 0
        for emp in queryset:
            account_number = str(emp.account_number or "").strip()
            bank_code = str(emp.bank_code or "").strip()
            keys = [
                f"paystack:recipient:{emp.id}",
                f"paystack_recipient_{emp.id}",
                paystack_recipient_fingerprint_key(emp),
            ]
            if account_number and bank_code:
                keys.extend([
                    PaystackAccountResolutionService.cache_key(bank_code, account_number),
                    PaystackAccountResolutionService.legacy_cache_key(bank_code, account_number),
                ])
            cache.delete_many(keys)
            if emp.paystack_recipient_code:
                emp.paystack_recipient_code = None
                emp.save(update_fields=['paystack_recipient_code'])
                count += 1
        self.message_user(request, f"Reset Paystack recipient codes for {count} employees.")


# ─────────────────────────────────────────────
# ATTENDANCE ADMIN
# ─────────────────────────────────────────────
@admin.register(Attendance)
class AttendanceAdmin(admin.ModelAdmin):
    list_display = ['employee', 'date', 'status', 'clock_in', 'clock_out', 'clock_method', 'clock_in_photo_url', 'clock_out_photo_url']
    list_filter = ['status', 'clock_method', 'date']
    autocomplete_fields = ['employee']
    search_fields = ['employee__name', 'employee__employee_id']
    date_hierarchy = 'date'
    
    def clock_in_photo_url(self, obj):
        if obj.clock_in_photo:
            return format_html('<a href="{}" target="_blank">View</a>', private_media_admin_url(obj.clock_in_photo))
        return "-"
    clock_in_photo_url.short_description = 'Clock In Photo'

    def clock_out_photo_url(self, obj):
        if obj.clock_out_photo:
            return format_html('<a href="{}" target="_blank">View</a>', private_media_admin_url(obj.clock_out_photo))
        return "-"
    clock_out_photo_url.short_description = 'Clock Out Photo'


# ─────────────────────────────────────────────
# DEDUCTION ADMIN
# ─────────────────────────────────────────────
@admin.register(Deduction)
class DeductionAdmin(admin.ModelAdmin):
    list_display = ['employee', 'amount', 'date', 'status', 'hr_approved', 'hr_approved_by']
    list_filter = ['status', 'hr_approved', 'date']
    autocomplete_fields = ['employee']
    search_fields = ['employee__name', 'employee__employee_id', 'reason']
    date_hierarchy = 'date'


# ─────────────────────────────────────────────
# PAYMENT ADMIN
# ─────────────────────────────────────────────
@admin.register(Payment)
class PaymentAdmin(admin.ModelAdmin):
    list_display = [
        'employee', 'transaction_reference', 'net_amount', 'status', 'hr_approved',
        'payment_month', 'payment_method', 'payment_date', 'is_partial'
    ]
    list_filter = ['status', 'hr_approved', 'payment_month', 'payment_method', 'payment_date', 'is_partial']
    search_fields = ['employee__name', 'employee__employee_id', 'transaction_reference']
    list_select_related = ['employee']
    date_hierarchy = 'payment_date'
    autocomplete_fields = ['employee']

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


# ─────────────────────────────────────────────
# COMPANY ADMIN
# ─────────────────────────────────────────────
@admin.register(EmployeeBalanceLedger)
class EmployeeBalanceLedgerAdmin(admin.ModelAdmin):
    list_display = ['employee', 'month_key', 'outstanding_balance', 'created_at', 'updated_at']
    list_filter = ['month_key']
    search_fields = ['employee__employee_id', 'employee__name', 'employee__email']
    readonly_fields = ['created_at', 'updated_at']


@admin.register(Company)
class CompanyAdmin(admin.ModelAdmin):
    list_display = ['name', 'location', 'status', 'guards_count', 'payment_to_us', 'profit']
    list_filter = ['status']
    search_fields = ['name', 'location']
    filter_horizontal = ['assigned_guards']


# ─────────────────────────────────────────────
# SACKED EMPLOYEE ADMIN
# ─────────────────────────────────────────────
@admin.register(SackedEmployee)
class SackedEmployeeAdmin(admin.ModelAdmin):
    list_display = ['employee', 'date_sacked', 'terminated_by']
    list_filter = ['date_sacked']
    search_fields = ['employee__name', 'employee__employee_id']
    date_hierarchy = 'date_sacked'
    autocomplete_fields = ['employee']


# ─────────────────────────────────────────────
# NOTIFICATION ADMIN
# ─────────────────────────────────────────────
@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ['user', 'type', 'is_read', 'created_at']
    list_filter = ['type', 'is_read']
    search_fields = ['user__username', 'message']
    date_hierarchy = 'created_at'


# ─────────────────────────────────────────────
# OTP ADMIN
# ─────────────────────────────────────────────
@admin.register(OTP)
class OTPAdmin(admin.ModelAdmin):
    list_display = ['email', 'code', 'reference', 'is_used', 'expires_at', 'created_at']
    list_filter = ['is_used']
    search_fields = ['email', 'reference']
    date_hierarchy = 'created_at'

    def masked_code(self, obj):
        return f"***{obj.code[-2:]}"


# ─────────────────────────────────────────────
# EXPORT TOKEN ADMIN
# ─────────────────────────────────────────────
@admin.register(ExportToken)
class ExportTokenAdmin(admin.ModelAdmin):
    list_display = ['user', 'data_type', 'is_used', 'is_2fa_verified', 'expires_at']
    list_filter = ['is_used', 'is_2fa_verified', 'data_type']
    search_fields = ['user__username']
    date_hierarchy = 'created_at'


# ─────────────────────────────────────────────
# EMPLOYEE REQUEST ADMIN
# ─────────────────────────────────────────────
@admin.register(EmployeeRequest)
class EmployeeRequestAdmin(admin.ModelAdmin):
    list_display = ['employee', 'request_type', 'amount', 'status', 'created_at']
    list_filter = ['status', 'request_type']
    search_fields = ['employee__name', 'employee__employee_id', 'description']
    date_hierarchy = 'created_at'
    autocomplete_fields = ['employee']


# ─────────────────────────────────────────────
# EMPLOYEE REQUEST ATTACHMENT ADMIN
# ─────────────────────────────────────────────
@admin.register(EmployeeRequestAttachment)
class EmployeeRequestAttachmentAdmin(admin.ModelAdmin):
    list_display = ['request', 'file_type', 'file', 'file_url', 'created_at']
    list_filter = ['file_type']
    
    def file_url(self, obj):
        if obj.file:
            return format_html('<a href="{}" target="_blank">Download</a>', private_media_admin_url(obj.file))
        return "-"
    file_url.short_description = 'File'

# ─────────────────────────────────────────────
# DOWNLOAD LOG ADMIN
# ─────────────────────────────────────────────
@admin.register(DownloadLog)
class DownloadLogAdmin(admin.ModelAdmin):
    list_display = ['user', 'employee', 'doc_type', 'reference', 'ip_address', 'created_at']
    list_filter = ['doc_type']
    search_fields = ['user__username', 'employee__name', 'reference']
    date_hierarchy = 'created_at'
    readonly_fields = ('user', 'created_at')
    autocomplete_fields = ['employee']

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


# ─────────────────────────────────────────────
# AUDIT LOG ADMIN
# ─────────────────────────────────────────────
@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = ['user', 'action', 'ip_address', 'created_at']
    search_fields = ['user__username', 'action']
    date_hierarchy = 'created_at'
    readonly_fields = [field.name for field in AuditLog._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
