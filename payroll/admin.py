# payroll/admin.py — PRODUCTION READY (Updated UserAdmin)
from django.contrib import admin, messages
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.core.cache import cache
from django.db import models
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
@admin.register(User)
class UserAdmin(BaseUserAdmin):
    list_display = ('username', 'email', 'role', 'is_staff', 'is_active')
    list_filter = ('role', 'is_staff', 'is_active', 'is_superuser')
    
    fieldsets = BaseUserAdmin.fieldsets + (
        ('Role & Permissions', {
            'fields': (
                'role', 'employee_id',
                'is_company_admin', 'is_employee_admin',
                'is_payment_admin', 'is_deduction_admin',
                'is_hr_admin', 'is_request_admin',
                'is_notification_admin', 'is_password_admin',
            )
        }),
        ('Contact Info', {'fields': ('phone',)}),
    )
    
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
                # Check for critical related objects that would block deletion
                related_issues = []
                
                if hasattr(user, 'employee_profile'):
                    related_issues.append(f"Employee profile ({user.employee_profile.employee_id})")
                
                if user.processed_payments.exists():
                    related_issues.append(f"{user.processed_payments.count()} processed payments")
                
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
    list_display = ['employee_id', 'name', 'type', 'status', 'location', 'salary']
    list_filter = ['type', 'status', 'location']
    search_fields = ['employee_id', 'name', 'email', 'phone']
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
    search_fields = ['employee__name', 'employee__employee_id']
    date_hierarchy = 'date'


# ─────────────────────────────────────────────
# DEDUCTION ADMIN
# ─────────────────────────────────────────────
@admin.register(Deduction)
class DeductionAdmin(admin.ModelAdmin):
    list_display = ['employee', 'amount', 'date', 'status', 'hr_approved', 'hr_approved_by']
    list_filter = ['status', 'hr_approved', 'date']
    search_fields = ['employee__name', 'employee__employee_id', 'reason']
    date_hierarchy = 'date'


# ─────────────────────────────────────────────
# PAYMENT ADMIN
# ─────────────────────────────────────────────
@admin.register(Payment)
class PaymentAdmin(admin.ModelAdmin):
    list_display = [
        'employee', 'net_amount', 'status', 'hr_approved',
        'payment_month', 'payment_method', 'payment_date'
    ]
    list_filter = ['status', 'hr_approved', 'payment_method', 'payment_date']
    search_fields = ['employee__name', 'employee__employee_id', 'transaction_reference']
    date_hierarchy = 'payment_date'


# ─────────────────────────────────────────────
# COMPANY ADMIN
# ─────────────────────────────────────────────
@admin.register(Company)
class CompanyAdmin(admin.ModelAdmin):
    list_display = ['name', 'location', 'status', 'guards_count', 'profit']
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
    list_display = ['user', 'employee', 'doc_type', 'reference', 'ip_address', 'timestamp']
    list_filter = ['doc_type']
    search_fields = ['user__username', 'employee__name', 'reference']
    date_hierarchy = 'timestamp'


# ─────────────────────────────────────────────
# AUDIT LOG ADMIN
# ─────────────────────────────────────────────
@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = ['user', 'action', 'ip_address', 'timestamp']
    search_fields = ['user__username', 'action']
    date_hierarchy = 'timestamp'