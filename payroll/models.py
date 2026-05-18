from django.core.validators import RegexValidator
from django.db import models
import re
from django.db import models
from django.contrib.auth.models import AbstractUser
from django.core.validators import MinValueValidator, MaxValueValidator
import uuid
from  django.conf import settings
from django.db import transaction
from django.utils import timezone
from rest_framework.permissions import BasePermission
# from encrypted_model_fields.fields import EncryptedCharField


class User(AbstractUser):
    """Custom User Model"""
    ROLE_ADMIN ='admin'
    ROLE_STAFF = 'staff'
    ROLE_GUARD = 'guard'
    
    ROLE_CHOICES = [
        (ROLE_ADMIN,'admin'),
        (ROLE_STAFF, 'Staff'),
        (ROLE_GUARD, 'Guard'),
    ]
    
    role = models.CharField(
        max_length=10, 
        choices=ROLE_CHOICES, 
        default='staff'
    )
    phone = models.CharField(max_length=15, blank=True, null=True)
    employee_id = models.CharField(max_length=20, unique=True, blank=True, null=True)
        # Flag for admins allowed to manage companies
    is_company_admin = models.BooleanField(default=False)
    is_notification_admin = models.BooleanField(default=False)
    is_employee_admin = models.BooleanField(default=False)
    is_payment_admin = models.BooleanField(default=False)
    is_deduction_admin = models.BooleanField(default=False)
    is_password_admin = models.BooleanField(default=False)
    is_hr_admin = models.BooleanField(default=False)
    is_request_admin = models.BooleanField(default=False)
    
    def save(self, *args, **kwargs):
        if self.role == self.ROLE_ADMIN:
            self.is_staff = True
        super().save(*args, **kwargs)

    class Meta:
        db_table = 'users'

class Employee(models.Model):
    """Employee Model"""
    TYPE_CHOICES = [
        ('staff', 'Staff'),
        ('guard', 'Guard'),
    ]
    
    STATUS_CHOICES = [
        ('active', 'Active'),
        ('terminated', 'Terminated'),
        ('sacked', 'Sacked'),
        ('resigned', 'Resigned'),
    ]
    
    id_sequence = models.PositiveIntegerField(editable=False, null=True, blank=True)
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee_id = models.CharField(max_length=20, unique=True)
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='employee_profile')
    name = models.CharField(max_length=200)
    type = models.CharField(max_length=10, choices=TYPE_CHOICES)
    location = models.CharField(max_length=200)
    salary = models.DecimalField(max_digits=10, decimal_places=2, validators=[MinValueValidator(0)])
    phone = models.CharField(max_length=15, blank=True, null=True)
    email = models.EmailField(blank=True, null=True)
    
    # Bank Details (Nigerian Banks - Naira)
    bank_name = models.CharField(max_length=100)
    bank_code = models.CharField(max_length=20, blank=True, null=True)
    paystack_recipient_code = models.CharField(max_length=100, blank=True, null=True)
    account_number = models.CharField(max_length=10)
    account_holder = models.CharField(max_length=200)
    
    is_self_registered = models.BooleanField(default=False)
    status = models.CharField(max_length=15, choices=STATUS_CHOICES, default='pending')
    join_date = models.DateField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'employees'
        ordering = ['-created_at']
        constraints = [
            models.UniqueConstraint(
                fields=['employee_id'],
                name='unique_employee_id',
                violation_error_message='Employee ID must be unique.'
            ),
        ]
    
    def __str__(self):
        return f"{self.employee_id} - {self.name}"
    
    def generate_employee_id(self):
        """Generate unique employee ID format with separate sequences per type.

        Examples:
        - Staff: FSS-001-STAFF, FSS-002-STAFF...
        - Guard: FSS-001-GRD,   FSS-002-GRD...
        """
        with transaction.atomic():
            # Lock last rows for the *same type* so staff and guards don't share numbering.
            # Note: id_sequence is shared by the model, but we treat it as per-type sequence.
            type_sequence_qs = (
                Employee.objects.select_for_update()
                .filter(type=self.type)
                .exclude(id_sequence__isnull=True)
                .order_by('-id_sequence')
            )
            last_employee = type_sequence_qs.first()

            if last_employee and last_employee.id_sequence:
                next_sequence = last_employee.id_sequence + 1
            else:
                next_sequence = 1

            if self.type == 'staff':
                suffix = 'STAFF'
            elif self.type == 'guard':
                suffix = 'GRD'
            else:
                suffix = 'EMP'

            employee_id = f"FSS-{str(next_sequence).zfill(3)}-{suffix}"

            # Safety check in case of legacy/previous data inconsistencies.
            while Employee.objects.filter(employee_id=employee_id).exists():
                next_sequence += 1
                employee_id = f"FSS-{str(next_sequence).zfill(3)}-{suffix}"

            self.id_sequence = next_sequence
            return employee_id
    
    def save(self, *args, **kwargs):
        # Only generate ID if not set (prevents regeneration on updates)
        if not self.employee_id:
            self.employee_id = self.generate_employee_id()
        super().save(*args, **kwargs)

class Attendance(models.Model):
    """Attendance Model with Selfie Capture and Timestamp Tracking"""
    class Meta:
        db_table = 'attendance'
        ordering = ['-date']
        constraints = [
            models.UniqueConstraint(
                fields=['employee', 'date'],
                name='unique_employee_daily_attendance'
            )
        ]
    

    STATUS_CHOICES = [
        ('present', 'Present'),
        ('absent', 'Absent'),
        ('leave', 'Leave'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name='attendances')
    date = models.DateField()
    
    # Store both time and full timestamp for accurate tracking
    clock_in = models.TimeField(blank=True, null=True)
    clock_in_timestamp = models.DateTimeField(blank=True, null=True)
    clock_in_photo = models.ImageField(upload_to='attendance/clock_in/%Y/%m/', blank=True, null=True)
    
    clock_out = models.TimeField(blank=True, null=True)
    clock_out_timestamp = models.DateTimeField(blank=True, null=True)

    clock_out_photo = models.ImageField(upload_to='attendance/clock_out/%Y/%m/', blank=True, null=True)
    
    CLOCK_METHOD_CHOICES = [
        ('selfie', 'Selfie'),
        ('boxmark', 'Boxmark'),
    ]
    
    clock_method = models.CharField(
        max_length=10, 
        choices=CLOCK_METHOD_CHOICES, 
        blank=True, null=True
    )
    
    leave_start = models.DateField(blank=True, null=True)
    leave_end = models.DateField(blank=True, null=True)
# later max_lenght
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default='present')
    
    # Track if attendance qualifies for deduction (commented out for future use)

    # is_eligible_for_deduction = models.BooleanField(default=False)
    # deduction_applied = models.BooleanField(default=False)
    # deduction_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0, null=True, blank=True)
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


    def __str__(self):
        return f"{self.employee.employee_id} - {self.date}"

class Deduction(models.Model):
    """Deduction Model"""
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('applied', 'Applied'),
        ('cancelled', 'Cancelled'),      # ADDED: For manual cancellation
        ('terminated', 'Terminated'),    # ADDED: For terminated employees
        ('pending_hr', 'Pending HR Approval'),
    ]
    
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name='deductions')
    amount = models.DecimalField(max_digits=10, decimal_places=2, validators=[MinValueValidator(0)])
    reason = models.TextField()
    date = models.DateField()
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default='pending')
    hr_approved = models.BooleanField(default=False)
    hr_approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='hr_approved_deductions')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'deductions'
        ordering = ['-date']
    
    def __str__(self):
        return f"{self.employee.employee_id} - ₦{self.amount}"

class Payment(models.Model):

    """Payment Model"""
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('processing', 'Processing'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
        ('pending_paystack_otp', 'Awaiting Paystack OTP'),
        ('pending_hr', 'Pending HR Approval'),
    ]    
    # Stalte Machine Definition
    STATUS_TRANSITIONS = { # Corrected transitions
        'pending': ['processing', 'failed', 'pending_paystack_otp'], 
        'processing': ['completed', 'failed', 'pending_paystack_otp'], 
        'pending_paystack_otp': ['completed', 'failed', 'processing'],
        'failed': ['processing'], # Allow retry
        'completed': [] # Terminal state
    }
    # Transitions for HR Approval
    STATUS_TRANSITIONS['pending_hr'] = ['pending', 'failed', 'cancelled']

    METHOD_CHOICES = [
        ('card', 'Card Payment'),
        ('bank_transfer', 'Bank Transfer'),
    ]

    def change_status(self, new_status):
        """
        Centralized state machine transition logic.
        Raises ValidationError if transition is illegal.
        """
        if new_status == self.status:
            return False
            
        allowed = self.STATUS_TRANSITIONS.get(self.status, [])
        if new_status not in allowed:
            raise ValueError(f"Illegal status transition from {self.status} to {new_status}")
            
        self.status = new_status
        self.save(update_fields=['status', 'updated_at'])
        return True


    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name='payments')

    # Salarymonth marker (prevents double salary payments per employee per month)
    # Format: YYYY-MM (e.g. 2026-05)
    payment_month = models.CharField(max_length=7, help_text='Format: YYYY-MM', null=True, blank=True)

    base_salary = models.DecimalField(max_digits=10, decimal_places=2)
    total_deductions = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    net_amount = models.DecimalField(max_digits=10, decimal_places=2)
    amount_paid = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    is_partial = models.BooleanField(default=False)

    
    payment_method = models.CharField(max_length=20, choices=METHOD_CHOICES)
    transaction_reference = models.CharField(max_length=100, unique=True)
    paystack_reference = models.CharField(max_length=100, blank=True, null=True)
    paystack_transfer_code = models.CharField(max_length=100, blank=True, null=True)
    
    status = models.CharField(max_length=25, choices=STATUS_CHOICES, default='pending')
    hr_approved = models.BooleanField(default=False)
    hr_approved_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='hr_approved_payments')
    payment_date = models.DateField()
    processed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, related_name='processed_payments')
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'payments'
        ordering = ['-payment_date']
        constraints = [
            models.UniqueConstraint(
                fields=['employee', 'payment_month'],
                name='unique_payment_per_employee_per_month'
            )
        ]

    
    def save(self, *args, **kwargs):
        # Status-based automation remove to ensure all payroll side-effects require admin approval
        super().save(*args, **kwargs)
    
    def __str__(self):
        return f"{self.employee.employee_id} - ₦{self.net_amount}"

class Company(models.Model):
    """Company/Client Model"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    location = models.CharField(max_length=200)
    email = models.EmailField(blank=True, null=True)
    phone = models.CharField(max_length=15, blank=True, null=True)

    STATUS_CHOICES = [
        ('active', 'Active'),
        ('terminated', 'Not Active'),
    ]
    status = models.CharField(max_length=15, choices=STATUS_CHOICES, default='active')
    termination_reason = models.TextField(blank=True, null=True)

    contract_start = models.DateField(null=True, blank=True)
    contract_end = models.DateField(null=True, blank=True)
    guards_count = models.IntegerField(validators=[MinValueValidator(1)])
    payment_to_us = models.DecimalField(max_digits=10, decimal_places=2, validators=[MinValueValidator(0)])

    payment_per_guard = models.DecimalField(max_digits=10, decimal_places=2, validators=[MinValueValidator(0)])
    total_payment_to_guards = models.DecimalField(max_digits=10, decimal_places=2, blank=True)
    profit = models.DecimalField(max_digits=10, decimal_places=2, blank=True)
    
    assigned_guards = models.ManyToManyField(Employee, related_name='assigned_companies', blank=True)
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    class Meta:
        db_table = 'companies'
        ordering = ['-created_at']
    
    def __str__(self):
        return self.name
    
    def save(self, *args, **kwargs):
        self.total_payment_to_guards = self.guards_count * self.payment_per_guard
        self.profit = self.payment_to_us - self.total_payment_to_guards
        super().save(*args, **kwargs)


class SackedEmployee(models.Model):
    """Archive for Terminated Employees"""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name='termination_records')
    date_sacked = models.DateField()
    offense = models.TextField()
    terminated_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True)
    
    created_at = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        db_table = 'sacked_employees'
        ordering = ['-date_sacked']
    
    def __str__(self):
        return f"{self.employee.employee_id} - Terminated on {self.date_sacked}"

class Notification(models.Model):
    """Notification Model"""
    TYPE_CHOICES = [
        ('info', 'Info'),
        ('success', 'Success'),
        ('warning', 'Warning'),
        ('error', 'Error'),
    ]
    
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='notifications', null=True, blank=True)
    message = models.TextField()
    type = models.CharField(max_length=10, choices=TYPE_CHOICES, default='info')
    is_read = models.BooleanField(default=False)
    
    created_at = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        db_table = 'notifications'
        ordering = ['-created_at']
    
    def __str__(self):
        return f"{self.type}: {self.message[:50]}"

class EmployeeRequest(models.Model):
    """Model for Employee Requests (Loans, Advances, Company Usage)"""
    REQUEST_TYPES = [
        ('salary_advance', 'Salary Advance'),
        ('loan', 'Loan'),
        ('company_expense', 'Company Expense'),
        ('other', 'Other'),
    ]
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('approved', 'Approved'),
        ('declined', 'Declined'),
    ]
    
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name='requests')
    request_type = models.CharField(max_length=20, choices=REQUEST_TYPES)
    amount = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    description = models.TextField()
    proof_photo = models.ImageField(upload_to='requests/proof/%Y/%m/', blank=True, null=True)
    receipt_file = models.ImageField(upload_to='requests/receipts/%Y/%m/', blank=True, null=True)
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default='pending')
    decline_reason = models.TextField(blank=True, null=True)
    action_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True, blank=True, related_name='handled_requests')
    
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'employee_requests'
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.employee.name} - {self.request_type} ({self.status})"

class EmployeeRequestAttachment(models.Model):
    """Model to support multiple attachments for a single request"""
    FILE_TYPE_CHOICES = [('proof', 'Proof'), ('receipt', 'Receipt')]
    request = models.ForeignKey(EmployeeRequest, on_delete=models.CASCADE, related_name='attachments')
    file = models.FileField(upload_to='requests/attachments/%Y/%m/')
    file_type = models.CharField(max_length=10, choices=FILE_TYPE_CHOICES)
    
    class Meta:
        db_table = 'employee_request_attachments'

class OTP(models.Model):
    """OTP Model (legacy: may still be used for some flows).

    NOTE: For internal payment verification we no longer rely on creating multiple OTP rows
    per payment reference.
    """
    email = models.EmailField()
    code = models.CharField(
        max_length=6,
        validators=[RegexValidator(r'^\d{6}$', 'OTP must be a 6-digit number.')]
    )
    reference = models.CharField(max_length=100)  # not unique (prevents UNIQUE constraint crashes)
    is_used = models.BooleanField(default=False)
    expires_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)
    attempt_count = models.IntegerField(default=0)
    max_attempts = models.IntegerField(default=3)

    class Meta:
        db_table = 'otps'
        ordering = ['-created_at']
    
    def __str__(self):
        return f"OTP for {self.email} - {self.reference}"
    
    def has_expired(self):
        return timezone.now() > self.expires_at


class ExportToken(models.Model):
    """Export Token Model for secure data exports"""
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    token = models.CharField(max_length=64, unique=True)
    data_type = models.CharField(max_length=50)  # 'employees', 'payments', etc.
    filters = models.JSONField(default=dict)  # Store filter parameters
    expires_at = models.DateTimeField()
    otp_code = models.CharField(max_length=6, blank=True, null=True)
    is_2fa_verified = models.BooleanField(default=False)
    is_used = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    
    class Meta:
        db_table = 'export_tokens'
        ordering = ['-created_at']
    
    def __str__(self):
        return f"Export token for {self.user.username} - {self.data_type}"
    
    def is_expired(self):
        return timezone.now() > self.expires_at

class DownloadLog(models.Model):
    """Log of sensitive document downloads"""
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True)
    employee = models.ForeignKey(Employee, on_delete=models.CASCADE, related_name='download_logs', null=True, blank=True)
    doc_type = models.CharField(max_length=20) # 'payslip' or 'receipt'
    reference = models.CharField(max_length=100)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'download_logs'
        ordering = ['-timestamp']


class AuditLog(models.Model):
    """Model to track administrative and security actions"""
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, null=True)
    action = models.CharField(max_length=255)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    extra_data = models.JSONField(default=dict, blank=True)
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'audit_logs'
        ordering = ['-timestamp']

    def __str__(self):
        return f"{self.user} - {self.action} at {self.timestamp}"
# Create your models here.
