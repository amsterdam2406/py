from django.core.validators import RegexValidator, MinValueValidator, MaxValueValidator
from django.db import models
from django.contrib.auth.models import AbstractUser
import uuid
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from django.core.exceptions import ValidationError


# ==================== USER ====================

class User(AbstractUser):
    """Custom User Model with role-based permissions."""

    ROLE_ADMIN = 'admin'
    ROLE_STAFF = 'staff'
    ROLE_GUARD = 'guard'

    ROLE_CHOICES = [
        (ROLE_ADMIN, 'Admin'),
        (ROLE_STAFF, 'Staff'),
        (ROLE_GUARD, 'Guard'),
    ]

    role = models.CharField(
        max_length=10, 
        choices=ROLE_CHOICES, 
        default='staff'
    )
    phone = models.CharField(max_length=15, blank=True, null=True)

    # Admin permission flags
    is_company_admin = models.BooleanField(default=False)
    is_notification_admin = models.BooleanField(default=False)
    is_employee_admin = models.BooleanField(default=False)
    is_payment_admin = models.BooleanField(default=False)
    is_deduction_admin = models.BooleanField(default=False)
    is_password_admin = models.BooleanField(default=False)
    is_hr_admin = models.BooleanField(default=False)
    is_request_admin = models.BooleanField(default=False)

    def save(self, *args, **kwargs):
        self.is_staff = (self.role == self.ROLE_ADMIN)
        super().save(*args, **kwargs)

    class Meta:
        db_table = 'users'
        verbose_name = 'User'
        verbose_name_plural = 'Users'


# ==================== EMPLOYEE ====================

class Employee(models.Model):
    """Employee Model — Staff, Guard, and Employee records with ID generation."""

    TYPE_CHOICES = [
        ('staff', 'Staff'),
        ('guard', 'Guard'),
        ('employee', 'Employee'),
    ]

    STATUS_CHOICES = [
        ('active', 'Active'),
        ('terminated', 'Terminated'),
        ('sacked', 'Sacked'),
        ('resigned', 'Resigned'),
        ('pending', 'Pending'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    id_sequence = models.PositiveIntegerField(
        editable=False, 
        null=True, 
        blank=True,
        help_text='Auto-incrementing sequence per employee type for ID generation.'
    )
    employee_id = models.CharField(max_length=20, unique=True)
    user = models.OneToOneField(
        User, 
        on_delete=models.CASCADE, 
        related_name='employee_profile'
    )
    name = models.CharField(max_length=200)
    type = models.CharField(max_length=10, choices=TYPE_CHOICES)
    location = models.CharField(max_length=200)
    salary = models.DecimalField(
        max_digits=10, 
        decimal_places=2, 
        validators=[MinValueValidator(0)]
    )
    phone = models.CharField(max_length=15, blank=True, null=True)
    email = models.EmailField(blank=True, null=True)

    # Bank Details (Nigerian Banks — Naira)
    bank_name = models.CharField(max_length=100)
    bank_code = models.CharField(max_length=20, blank=True, null=True)
    paystack_recipient_code = models.CharField(max_length=100, blank=True, null=True)
    account_number = models.CharField(max_length=10)
    account_holder = models.CharField(max_length=200)

    is_self_registered = models.BooleanField(default=False)
    status = models.CharField(
        max_length=15, 
        choices=STATUS_CHOICES, 
        default='pending'
    )
    join_date = models.DateField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'employees'
        ordering = ['-created_at']
        verbose_name = 'Employee'
        verbose_name_plural = 'Employees'
        indexes = [
            models.Index(fields=['type', 'status'], name='emp_type_status_idx'),
            models.Index(fields=['employee_id'], name='emp_id_idx'),
            models.Index(fields=['status'], name='emp_status_idx'),
        ]
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
        """Generate unique employee ID with separate sequences per type.

        Staff & Guard: Auto-generated with format FSS-001-STAFF, FSS-001-GRD
        Employee: Must be manually input (no auto-generation)
        """
        with transaction.atomic():
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

            suffix = 'STAFF' if self.type == 'staff' else 'GRD' if self.type == 'guard' else 'EMP'
            employee_id = f"FSS-{str(next_sequence).zfill(3)}-{suffix}"

            while Employee.objects.filter(employee_id=employee_id).exists():
                next_sequence += 1
                employee_id = f"FSS-{str(next_sequence).zfill(3)}-{suffix}"

            self.id_sequence = next_sequence
            return employee_id

    def save(self, *args, **kwargs):
        # Auto-generate ID only for staff and guard types
        # Employee type must input ID manually
        if not self.employee_id and self.type in ('staff', 'guard'):
            self.employee_id = self.generate_employee_id()
        super().save(*args, **kwargs)


# ==================== ATTENDANCE ====================

class Attendance(models.Model):
    """Attendance Model with selfie capture and timestamp tracking."""

    STATUS_CHOICES = [
        ('present', 'Present'),
        ('absent', 'Absent'),
        ('leave', 'Leave'),
    ]

    CLOCK_METHOD_CHOICES = [
        ('selfie', 'Selfie'),
        ('boxmark', 'Boxmark'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(
        Employee, 
        on_delete=models.CASCADE, 
        related_name='attendances'
    )
    date = models.DateField()

    clock_in = models.TimeField(blank=True, null=True)
    clock_in_timestamp = models.DateTimeField(blank=True, null=True)
    clock_in_photo = models.ImageField(
        upload_to='attendance/clock_in/%Y/%m/', 
        blank=True, 
        null=True
    )

    clock_out = models.TimeField(blank=True, null=True)
    clock_out_timestamp = models.DateTimeField(blank=True, null=True)
    clock_out_photo = models.ImageField(
        upload_to='attendance/clock_out/%Y/%m/', 
        blank=True, 
        null=True
    )

    clock_method = models.CharField(
        max_length=10, 
        choices=CLOCK_METHOD_CHOICES, 
        blank=True, 
        null=True
    )

    leave_start = models.DateField(blank=True, null=True)
    leave_end = models.DateField(blank=True, null=True)
    status = models.CharField(
        max_length=10, 
        choices=STATUS_CHOICES, 
        default='present'
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'attendance'
        ordering = ['-date']
        verbose_name = 'Attendance Record'
        verbose_name_plural = 'Attendance Records'
        indexes = [
            models.Index(fields=['employee', 'date'], name='att_emp_date_idx'),
            models.Index(fields=['date', 'status'], name='att_date_status_idx'),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['employee', 'date'],
                name='unique_employee_daily_attendance'
            )
        ]

    def __str__(self):
        return f"{self.employee.employee_id} - {self.date}"


# ==================== DEDUCTION ====================

class Deduction(models.Model):
    """Deduction Model for salary deductions and penalties."""

    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('applied', 'Applied'),
        ('cancelled', 'Cancelled'),
        ('terminated', 'Terminated'),
        ('pending_hr', 'Pending HR Approval'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(
        Employee, 
        on_delete=models.CASCADE, 
        related_name='deductions'
    )
    amount = models.DecimalField(
        max_digits=10, 
        decimal_places=2, 
        validators=[MinValueValidator(0)]
    )
    reason = models.TextField()
    date = models.DateField()
    status = models.CharField(
        max_length=20, 
        choices=STATUS_CHOICES, 
        default='pending'
    )
    hr_approved = models.BooleanField(default=False)
    hr_approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, 
        on_delete=models.SET_NULL, 
        null=True, 
        blank=True, 
        related_name='hr_approved_deductions'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'deductions'
        ordering = ['-date']
        verbose_name = 'Deduction'
        verbose_name_plural = 'Deductions'
        indexes = [
            models.Index(fields=['employee', 'status'], name='ded_emp_status_idx'),
            models.Index(fields=['date'], name='ded_date_idx'),
        ]

    def __str__(self):
        return f"{self.employee.employee_id} - ₦{self.amount}"


# ==================== PAYMENT ====================

class Payment(models.Model):
    """Payment Model for salary processing with Paystack integration."""

    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('processing', 'Processing'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
        ('pending_paystack_otp', 'Awaiting Paystack OTP'),
        ('pending_hr', 'Pending HR Approval'),
    ]

    STATUS_TRANSITIONS = {
        'pending': ['processing', 'failed', 'pending_paystack_otp'],
        'processing': ['completed', 'failed', 'pending_paystack_otp'],
        'pending_paystack_otp': ['completed', 'failed', 'processing'],
        'failed': ['processing'],
        'completed': [],
        'pending_hr': ['pending', 'failed', 'cancelled'],
    }

    METHOD_CHOICES = [
        ('card', 'Card Payment'),
        ('bank_transfer', 'Bank Transfer'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(
        Employee, 
        on_delete=models.CASCADE, 
        related_name='payments'
    )
    payment_month = models.CharField(
        max_length=7, 
        help_text='Format: YYYY-MM', 
        null=True, 
        blank=True
    )
    base_salary = models.DecimalField(max_digits=10, decimal_places=2)
    total_deductions = models.DecimalField(
        max_digits=10, 
        decimal_places=2, 
        default=0
    )
    net_amount = models.DecimalField(max_digits=10, decimal_places=2)
    amount_paid = models.DecimalField(
        max_digits=10, 
        decimal_places=2, 
        null=True, 
        blank=True
    )
    is_partial = models.BooleanField(default=False)
    payment_method = models.CharField(max_length=20, choices=METHOD_CHOICES)
    transaction_reference = models.CharField(max_length=100, unique=True)
    paystack_reference = models.CharField(max_length=100, blank=True, null=True)
    paystack_transfer_code = models.CharField(max_length=100, blank=True, null=True)
    status = models.CharField(
        max_length=25, 
        choices=STATUS_CHOICES, 
        default='pending'
    )
    hr_approved = models.BooleanField(default=False)
    hr_approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, 
        on_delete=models.SET_NULL, 
        null=True, 
        blank=True, 
        related_name='hr_approved_payments'
    )
    payment_date = models.DateField()
    processed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, 
        on_delete=models.SET_NULL, 
        null=True, 
        related_name='processed_payments'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'payments'
        ordering = ['-payment_date']
        verbose_name = 'Payment'
        verbose_name_plural = 'Payments'
        indexes = [
            models.Index(fields=['employee', 'payment_month'], name='pay_emp_month_idx'),
            models.Index(fields=['status', 'payment_date'], name='pay_status_date_idx'),
            models.Index(fields=['transaction_reference'], name='pay_ref_idx'),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['employee', 'payment_month'],
                name='unique_payment_per_employee_per_month'
            )
        ]

    def change_status(self, new_status):
        """Centralized state machine transition logic.

        Args:
            new_status: Target status to transition to.

        Returns:
            bool: True if status changed, False if already same status.

        Raises:
            ValueError: If transition is not allowed.
        """
        if new_status == self.status:
            return False
        allowed = self.STATUS_TRANSITIONS.get(self.status, [])
        if new_status not in allowed:
            raise ValueError(
                f"Illegal status transition from {self.status} to {new_status}"
            )
        self.status = new_status
        self.save(update_fields=['status', 'updated_at'])
        return True

    def can_transition_to(self, new_status):
        """Check if a status transition is allowed without executing it."""
        if new_status == self.status:
            return False
        return new_status in self.STATUS_TRANSITIONS.get(self.status, [])

    def get_allowed_transitions(self):
        """Return list of allowed next statuses from current state."""
        return self.STATUS_TRANSITIONS.get(self.status, [])

    def mark_as_paid(self, amount=None):
        """Mark payment as completed with optional amount tracking."""
        if amount is not None:
            self.amount_paid = amount
            self.is_partial = (amount < self.net_amount)
        else:
            self.amount_paid = self.net_amount
            self.is_partial = False
        return self.change_status('completed')

    def retry_payment(self):
        """Retry a failed payment."""
        if self.status != 'failed':
            raise ValueError(f"Cannot retry payment with status: {self.status}")
        return self.change_status('processing')

    def __str__(self):
        return f"{self.employee.employee_id} - ₦{self.net_amount}"


# ==================== COMPANY ====================

class Company(models.Model):
    """Company/Client Model for guard assignments and profit tracking."""

    STATUS_CHOICES = [
        ('active', 'Active'),
        ('terminated', 'Terminated'),
        ('reactivated', 'Reactivated'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    location = models.CharField(max_length=200)
    email = models.EmailField(blank=True, null=True)
    phone = models.CharField(max_length=15, blank=True, null=True)
    status = models.CharField(
        max_length=15, 
        choices=STATUS_CHOICES, 
        default='active'
    )
    termination_reason = models.TextField(blank=True, null=True)
    contract_start = models.DateField(null=True, blank=True)
    contract_end = models.DateField(null=True, blank=True)
    guards_count = models.IntegerField(
        validators=[MinValueValidator(0)], 
        default=0,
        help_text='Expected number of guards. Can be 0 if not yet assigned.'
    )
    payment_to_us = models.DecimalField(
        max_digits=10, 
        decimal_places=2, 
        validators=[MinValueValidator(0)]
    )
    payment_per_guard = models.DecimalField(
        max_digits=10, 
        decimal_places=2, 
        validators=[MinValueValidator(0)]
    )
    total_payment_to_guards = models.DecimalField(
        max_digits=10, 
        decimal_places=2, 
        null=True, 
        blank=True
    )
    profit = models.DecimalField(
        max_digits=10, 
        decimal_places=2, 
        null=True, 
        blank=True
    )
    assigned_guards = models.ManyToManyField(
        Employee, 
        related_name='assigned_companies', 
        blank=True
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'companies'
        ordering = ['-created_at']
        verbose_name = 'Company'
        verbose_name_plural = 'Companies'
        indexes = [
            models.Index(fields=['status'], name='comp_status_idx'),
            models.Index(fields=['name'], name='comp_name_idx'),
        ]

    def __str__(self):
        return self.name

    def clean(self):
        """Validate contract dates and guard count consistency."""
        if self.contract_end and self.contract_start and self.contract_end < self.contract_start:
            raise ValidationError("Contract end date must be after start date.")
        super().clean()

    def calculate_financials(self):
        """Calculate total payment to guards and profit based on current state."""
        assigned_count = self.assigned_guards.count()
        effective_count = max(assigned_count, self.guards_count)
        self.total_payment_to_guards = effective_count * self.payment_per_guard
        self.profit = self.payment_to_us - self.total_payment_to_guards
        return self.total_payment_to_guards, self.profit

    def save(self, *args, **kwargs):
        self.calculate_financials()
        super().save(*args, **kwargs)

    def reactivate(self):
        """Reactivate a terminated company."""
        if self.status != 'terminated':
            raise ValueError(f"Cannot reactivate company with status: {self.status}")
        self.status = 'reactivated'
        self.termination_reason = None
        self.save()

    def terminate(self, reason=''):
        """Terminate an active company."""
        if self.status not in ['active', 'reactivated']:
            raise ValueError(f"Cannot terminate company with status: {self.status}")
        self.status = 'terminated'
        self.termination_reason = reason
        self.save()


# ==================== SACKED EMPLOYEE ====================

class SackedEmployee(models.Model):
    """Archive for terminated/sacked employees."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(
        Employee, 
        on_delete=models.CASCADE, 
        related_name='termination_records'
    )
    date_sacked = models.DateField()
    offense = models.TextField()
    terminated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, 
        on_delete=models.SET_NULL, 
        null=True
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'sacked_employees'
        ordering = ['-date_sacked']
        verbose_name = 'Terminated Employee'
        verbose_name_plural = 'Terminated Employees'
        indexes = [
            models.Index(fields=['employee'], name='sack_emp_idx'),
            models.Index(fields=['date_sacked'], name='sack_date_idx'),
        ]

    def __str__(self):
        return f"{self.employee.employee_id} - Terminated on {self.date_sacked}"


# ==================== NOTIFICATION ====================

class Notification(models.Model):
    """Notification Model for user alerts."""

    TYPE_CHOICES = [
        ('info', 'Info'),
        ('success', 'Success'),
        ('warning', 'Warning'),
        ('error', 'Error'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, 
        on_delete=models.CASCADE, 
        related_name='notifications', 
        null=True, 
        blank=True
    )
    message = models.TextField()
    type = models.CharField(
        max_length=10, 
        choices=TYPE_CHOICES, 
        default='info'
    )
    is_read = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'notifications'
        ordering = ['-created_at']
        verbose_name = 'Notification'
        verbose_name_plural = 'Notifications'
        indexes = [
            models.Index(fields=['user', 'is_read'], name='notif_user_read_idx'),
            models.Index(fields=['created_at'], name='notif_date_idx'),
        ]

    def __str__(self):
        return f"{self.type}: {self.message[:50]}"

    def mark_as_read(self):
        """Mark notification as read."""
        if not self.is_read:
            self.is_read = True
            self.save(update_fields=['is_read'])


# ==================== EMPLOYEE REQUEST ====================

class EmployeeRequest(models.Model):
    """Model for employee requests — loans, advances, expenses."""

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
    employee = models.ForeignKey(
        Employee, 
        on_delete=models.CASCADE, 
        related_name='requests'
    )
    request_type = models.CharField(max_length=20, choices=REQUEST_TYPES)
    amount = models.DecimalField(
        max_digits=10, 
        decimal_places=2, 
        null=True, 
        blank=True
    )
    description = models.TextField()
    proof_photo = models.ImageField(
        upload_to='requests/proof/%Y/%m/', 
        blank=True, 
        null=True
    )
    receipt_file = models.ImageField(
        upload_to='requests/receipts/%Y/%m/', 
        blank=True, 
        null=True
    )
    status = models.CharField(
        max_length=10, 
        choices=STATUS_CHOICES, 
        default='pending'
    )
    decline_reason = models.TextField(blank=True, null=True)
    action_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, 
        on_delete=models.SET_NULL, 
        null=True, 
        blank=True, 
        related_name='handled_requests'
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'employee_requests'
        ordering = ['-created_at']
        verbose_name = 'Employee Request'
        verbose_name_plural = 'Employee Requests'
        indexes = [
            models.Index(fields=['employee', 'status'], name='req_emp_status_idx'),
            models.Index(fields=['request_type'], name='req_type_idx'),
        ]

    def __str__(self):
        return f"{self.employee.name} - {self.request_type} ({self.status})"

    def approve(self, approved_by):
        """Approve the request."""
        if self.status != 'pending':
            raise ValueError(f"Cannot approve request with status: {self.status}")
        self.status = 'approved'
        self.action_by = approved_by
        self.save(update_fields=['status', 'action_by', 'updated_at'])

    def decline(self, declined_by, reason=''):
        """Decline the request with reason."""
        if self.status != 'pending':
            raise ValueError(f"Cannot decline request with status: {self.status}")
        self.status = 'declined'
        self.decline_reason = reason
        self.action_by = declined_by
        self.save(update_fields=['status', 'decline_reason', 'action_by', 'updated_at'])


# ==================== EMPLOYEE REQUEST ATTACHMENT ====================

class EmployeeRequestAttachment(models.Model):
    """Model for multiple file attachments per request."""

    FILE_TYPE_CHOICES = [('proof', 'Proof'), ('receipt', 'Receipt')]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    request = models.ForeignKey(
        EmployeeRequest, 
        on_delete=models.CASCADE, 
        related_name='attachments'
    )
    file = models.FileField(upload_to='requests/attachments/%Y/%m/')
    file_type = models.CharField(max_length=10, choices=FILE_TYPE_CHOICES)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'employee_request_attachments'
        verbose_name = 'Request Attachment'
        verbose_name_plural = 'Request Attachments'
        indexes = [
            models.Index(fields=['request', 'file_type'], name='att_req_type_idx'),
        ]

    def __str__(self):
        return f"{self.file_type.title()} for {self.request}"


# ==================== OTP ====================

class OTP(models.Model):
    """OTP Model for payment verification and secure operations."""

    email = models.EmailField(db_index=True)
    code = models.CharField(
        max_length=6,
        validators=[RegexValidator(r'^\d{6}$', 'OTP must be a 6-digit number.')]
    )
    reference = models.CharField(max_length=100, db_index=True)
    is_used = models.BooleanField(default=False)
    expires_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)
    attempt_count = models.IntegerField(default=0)
    max_attempts = models.IntegerField(default=3)

    class Meta:
        db_table = 'otps'
        ordering = ['-created_at']
        verbose_name = 'OTP'
        verbose_name_plural = 'OTPs'
        indexes = [
            models.Index(fields=['email', 'is_used'], name='otp_email_used_idx'),
            models.Index(fields=['reference', 'is_used'], name='otp_ref_used_idx'),
            models.Index(fields=['expires_at'], name='otp_expiry_idx'),
        ]

    def __str__(self):
        return f"OTP for {self.email} - {self.reference}"

    def has_expired(self):
        """Check if OTP has passed expiry time."""
        return timezone.now() > self.expires_at

    def increment_attempt(self):
        """Increment attempt count and check if max reached."""
        self.attempt_count += 1
        self.save(update_fields=['attempt_count'])
        return self.attempt_count >= self.max_attempts

    def verify(self, input_code):
        """Verify OTP code with attempt tracking."""
        if self.has_expired():
            return False, 'expired'
        if self.is_used:
            return False, 'already_used'
        if self.attempt_count >= self.max_attempts:
            return False, 'max_attempts_exceeded'
        if self.code != input_code:
            max_reached = self.increment_attempt()
            return False, 'max_attempts_reached' if max_reached else 'invalid'
        self.is_used = True
        self.save(update_fields=['is_used'])
        return True, 'success'


# ==================== EXPORT TOKEN ====================

class ExportToken(models.Model):
    """Export Token Model for secure data exports."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, 
        on_delete=models.CASCADE
    )
    token = models.CharField(max_length=64, unique=True)
    data_type = models.CharField(max_length=50)
    filters = models.JSONField(default=dict)
    expires_at = models.DateTimeField()
    otp_code = models.CharField(max_length=6, blank=True, null=True)
    is_2fa_verified = models.BooleanField(default=False)
    is_used = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'export_tokens'
        ordering = ['-created_at']
        verbose_name = 'Export Token'
        verbose_name_plural = 'Export Tokens'
        indexes = [
            models.Index(fields=['token'], name='exp_token_idx'),
            models.Index(fields=['user', 'is_used'], name='exp_user_used_idx'),
        ]

    def __str__(self):
        return f"Export token for {self.user.username} - {self.data_type}"

    def is_expired(self):
        """Check if export token has expired."""
        return timezone.now() > self.expires_at

    def verify_2fa(self, code):
        """Verify 2FA code for export token."""
        if self.is_2fa_verified:
            return False, 'already_verified'
        if self.otp_code != code:
            return False, 'invalid'
        self.is_2fa_verified = True
        self.save(update_fields=['is_2fa_verified'])
        return True, 'success'


# ==================== DOWNLOAD LOG ====================

class DownloadLog(models.Model):
    """Log of sensitive document downloads for audit trail."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, 
        on_delete=models.SET_NULL, 
        null=True
    )
    employee = models.ForeignKey(
        Employee, 
        on_delete=models.CASCADE, 
        related_name='download_logs', 
        null=True, 
        blank=True
    )
    doc_type = models.CharField(max_length=20)
    reference = models.CharField(max_length=100)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'download_logs'
        ordering = ['-timestamp']
        verbose_name = 'Download Log'
        verbose_name_plural = 'Download Logs'
        indexes = [
            models.Index(fields=['user', 'timestamp'], name='dl_user_time_idx'),
            models.Index(fields=['employee', 'doc_type'], name='dl_emp_doc_idx'),
        ]

    def __str__(self):
        return f"{self.doc_type} downloaded by {self.user}"


# ==================== AUDIT LOG ====================

class AuditLog(models.Model):
    """Model to track administrative and security actions."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, 
        on_delete=models.SET_NULL, 
        null=True
    )
    action = models.CharField(max_length=255)
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    extra_data = models.JSONField(default=dict, blank=True)
    timestamp = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'audit_logs'
        ordering = ['-timestamp']
        verbose_name = 'Audit Log'
        verbose_name_plural = 'Audit Logs'
        indexes = [
            models.Index(fields=['user', 'timestamp'], name='audit_user_time_idx'),
            models.Index(fields=['action'], name='audit_action_idx'),
        ]

    def __str__(self):
        return f"{self.user} - {self.action} at {self.timestamp}"

    @classmethod
    def log_action(cls, user, action, ip_address=None, extra_data=None):
        """Class method to create audit log entry."""
        return cls.objects.create(
            user=user,
            action=action,
            ip_address=ip_address,
            extra_data=extra_data or {}
        )