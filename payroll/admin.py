# payroll/admin.py — PRODUCTION READY (Updated UserAdmin)
from django.contrib import admin, messages
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.core.cache import cache
from django.contrib.auth.forms import AuthenticationForm
from django import forms
from django.db.models import ProtectedError, RestrictedError
from .models import (
    User, Employee, Attendance, Deduction, 
    Payment, Company, SackedEmployee, Notification, 
    OTP, ExportToken, EmployeeRequest, EmployeeRequestAttachment,
    DownloadLog, AuditLog
)

# ─────────────────────────────────────────────
# USER ADMIN (SAFE DELETE)
# ─────────────────────────────────────────────

class EmailAuthenticationForm(AuthenticationForm):
    """Custom admin login form that accepts email or username"""
    username = forms.CharField(
        label="Email / Username",
        widget=forms.TextInput(attrs={"autofocus": True})
    )
    
    def clean(self):
        username = self.cleaned_data.get('username')
        password = self.cleaned_data.get('password')
        
        if username and password:
            # Try to find user by email first, then username
            try:
                user = User.objects.get(email__iexact=username)
                username = user.username  # Get the actual username for authenticate()
            except User.DoesNotExist:
                pass  # Keep original username
            
            self.cleaned_data['username'] = username
            
        return super().clean()

class CustomAdminSite(admin.AdminSite):
    login_form = EmailAuthenticationForm
    site_header = "Fotasco Payroll Administration"
    site_title = "Fotasco Admin"

# Use custom admin site
admin_site = CustomAdminSite(name='customadmin')

# Or override the default admin login form
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
                'is_company_admin', 'is_employee_admin',
                'is_payment_admin', 'is_deduction_admin',
                'is_hr_admin', 'is_request_admin',
                'is_notification_admin', 'is_password_admin',
            )
        }),
        ('Contact Info', {'fields': ('phone',)}),
    )
    
    #  ('Custom Fields', {'fields': ('role', 'phone', 'is_company_admin', 'is_notification_admin', 
                                    #    'is_payment_admin', 'is_deduction_admin', 'is_employee_admin',
                                    #    'is_request_admin', 'is_hr_admin')}),
    # )
    
    # Prevent bulk delete — handle one at a time with proper error messaging
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
                if employee:
                    related_issues = []
                    
                count = user.processed_payments.count()
                if count:
                    related_issues.append(f"{count}  processed payments")
                
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
                
                if user.auditlog_set.exists():
                    related_issues.append(f"{user.auditlog_set.count()} audit logs")
                
                if user.download_logs.exists():
                    related_issues.append(f"{user.download_logs.count()} download logs")
                
                if user.export_tokens.exists():
                    related_issues.append(f"{user.export_tokens.count()} export tokens")
                
                if related_issues:
                    # Option 1: Cascade delete everything (DANGEROUS — use with caution)
                    # Option 2: Skip and warn (SAFER — default)
                    errors.append(f"Skipped {user.username}: linked to {', '.join(related_issues)}")
                    skipped += 1
                    continue
                
                # If no blocking relations, delete
                user.delete()
                deleted += 1
                
            except (ProtectedError, RestrictedError) as e:
                errors.append(f"Cannot delete {user.username}: protected by database constraint")
                skipped += 1
            except Exception as e:
                errors.append(f"Error deleting {user.username}: {str(e)}")
                skipped += 1
        
        # Report results
        if deleted:
            self.message_user(request, f"Successfully deleted {deleted} user(s).", messages.SUCCESS)
        if skipped:
            self.message_user(request, f"Skipped {skipped} user(s) due to related data.", messages.WARNING)
        if errors:
            for error in errors[:5]:  # Show first 5 errors
                self.message_user(request, error, messages.ERROR)
            if len(errors) > 5:
                self.message_user(request, f"... and {len(errors) - 5} more issues.", messages.ERROR)

    def delete_model(self, request, obj):
        """Override single delete to catch errors gracefully."""
        try:
            # Check for Employee profile first — most common blocker
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
        """Allow delete permission — we'll handle errors in delete_model."""
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
    readonly_fields = ['employee_id', 'id_sequence', 'created_at', 'updated_at', 'user']  # Employee ID should not be editable after creation
    actions = ['clear_verification_cache']

    @admin.action(description='Clear Paystack verification cache for selected employees')
    def clear_verification_cache(self, request, queryset):
        count = 0
        for emp in queryset:
            bank_code = emp.bank_code or ""
            key = f"paystack:resolve:{bank_code}:{emp.account_number}"
            if cache.delete(key):
                count += 1
        self.message_user(request, f"Cleared verification cache for {count} employees.")


# ─────────────────────────────────────────────
# ATTENDANCE ADMIN
# ─────────────────────────────────────────────
@admin.register(Attendance)
class AttendanceAdmin(admin.ModelAdmin):
    list_display = ['employee', 'date', 'status', 'clock_in', 'clock_out', 'clock_method']
    list_filter = ['status', 'clock_method', 'date']
    autocomplete_fields = ['employee']
    search_fields = ['employee__name', 'employee__employee_id']
    date_hierarchy = 'date'


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
        'payment_month', 'payment_method', 'payment_date'
    ]
    list_filter = ['status', 'hr_approved', 'payment_month', 'payment_method', 'payment_date']
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
    list_display = ['request', 'file_type', 'file']
    list_filter = ['file_type']

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
        
        
        