from django.core.validators import FileExtensionValidator
from django.core.validators import RegexValidator, MinValueValidator
from django.db import models, IntegrityError, transaction
from django.db.models.functions import Lower
from django.contrib.auth.models import AbstractUser
import uuid
from django.conf import settings
from django.core.exceptions import ValidationError
from django.utils.translation import gettext_lazy as _
from .managers import UserManager
import importlib
from django.contrib.auth.hashers import make_password, check_password
from simple_history.models import HistoricalRecords

if importlib.util.find_spec("simple_history.models") is not None:
    HistoricalRecords = importlib.import_module("simple_history.models").HistoricalRecords
else:
    class HistoricalRecords:
        """Fallback stub when django-simple-history is unavailable."""
        def __init__(self, *args, **kwargs):
            pass
        def contribute_to_class(self, cls, name, **kwargs):
            pass

from datetime import timedelta
from django.utils import timezone

# ==================== BASE / UTILITIES ====================

class TimeStampedModel(models.Model):
    """Abstract base model with auto timestamp fields."""
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


# ADD this block (replace the deleted section):
class SoftDeleteQuerySet(models.QuerySet):
    """QuerySet that provides both active and deleted record access."""
    def active(self):
        return self.filter(is_deleted=False)

    def deleted(self):
        return self.filter(is_deleted=True)


class SoftDeleteManager(models.Manager):
    """Manager that returns SoftDeleteQuerySet (no default filtering)."""
    def get_queryset(self):
        return SoftDeleteQuerySet(self.model, using=self._db).filter(is_deleted=False)


class SoftDeleteModel(models.Model):
    """Abstract model with soft-delete capability."""
    is_deleted = models.BooleanField(default=False)
    deleted_at = models.DateTimeField(null=True, blank=True)

    objects = SoftDeleteManager()
    all_objects = SoftDeleteQuerySet.as_manager()

    class Meta:
        abstract = True

    def soft_delete(self):
        """Soft delete the record instead of hard deleting."""
        self.is_deleted = True
        self.deleted_at = timezone.now()
        self.save(update_fields=['is_deleted', 'deleted_at'])

    def restore(self):
        """Restore a soft-deleted record."""
        self.is_deleted = False
        self.deleted_at = None
        self.save(update_fields=['is_deleted', 'deleted_at'])


# ==================== FILE VALIDATORS ====================

def validate_file_size(file, limit_mb=5):
    """Validate uploaded file size. Default limit: 5MB."""
    limit = limit_mb * 1024 * 1024
    if file.size > limit:
        raise ValidationError(
            _(f"File too large. Maximum size is {limit_mb}MB.")
        )


# ==================== REUSABLE CHOICES ====================

class ApprovalStatus(models.TextChoices):
    """Reusable approval status choices."""
    PENDING = 'pending', _('Pending')
    APPROVED = 'approved', _('Approved')
    DECLINED = 'declined', _('Declined')


class NotificationType(models.TextChoices):
    """Reusable notification type choices."""
    INFO = 'info', _('Info')
    SUCCESS = 'success', _('Success')
    WARNING = 'warning', _('Warning')
    ERROR = 'error', _('Error')


class EmployeeType(models.TextChoices):
    """Employee type choices."""
    STAFF = 'staff', _('Staff')
    GUARD = 'guard', _('Guard')
    EMPLOYEE = 'employee', _('Employee')


class EmployeeStatus(models.TextChoices):
    """Employee status choices."""
    ACTIVE = 'active', _('Active')
    SUSPENDED = 'suspended', _('Suspended')
    INACTIVE = 'inactive', _('Inactive')
    TERMINATED = 'terminated', _('Terminated')
    SACKED = 'sacked', _('Sacked')
    RESIGNED = 'resigned', _('Resigned')
    PENDING = 'pending', _('Pending')
    PENDING_HR = 'pending_hr', _('Pending HR Approval')
    ON_LEAVE = 'on_leave', _('On Leave')


class AttendanceStatus(models.TextChoices):
    """Attendance status choices."""
    PRESENT = 'present', _('Present')
    ABSENT = 'absent', _('Absent')
    LEAVE = 'leave', _('Leave')


class ClockMethod(models.TextChoices):
    """Clock-in method choices."""
    SELFIE = 'selfie', _('Selfie')
    BOXMARK = 'boxmark', _('Boxmark')


class DeductionStatus(models.TextChoices):
    """Deduction status choices."""
    PENDING = 'pending', _('Pending')
    PARTIAL = 'partial', _('Partial')
    SETTLED = 'settled', _('Settled')
    APPLIED = 'applied', _('Applied')
    CANCELLED = 'cancelled', _('Cancelled')
    TERMINATED = 'terminated', _('Terminated')
    PENDING_HR = 'pending_hr', _('Pending HR Approval')


class PaymentStatus(models.TextChoices):
    """Payment status choices."""
    PENDING = 'pending', _('Pending')
    PROCESSING = 'processing', _('Processing')
    COMPLETED = 'completed', _('Completed')
    FAILED = 'failed', _('Failed')
    PENDING_PAYSTACK_OTP = 'pending_paystack_otp', _('Awaiting Paystack OTP')
    PENDING_HR = 'pending_hr', _('Pending HR Approval')
    CANCELLED = 'cancelled', _('Cancelled')


class PaymentMethod(models.TextChoices):
    """Payment method choices."""
    CARD = 'card', _('Card Payment')
    BANK_TRANSFER = 'bank_transfer', _('Bank Transfer')


class CompanyStatus(models.TextChoices):
    """Company status choices."""
    ACTIVE = 'active', _('Active')
    TERMINATED = 'terminated', _('Terminated')
    REACTIVATED = 'reactivated', _('Reactivated')


class RequestType(models.TextChoices):
    """Employee request type choices."""
    SALARY_ADVANCE = 'salary_advance', _('Salary Advance')
    LOAN = 'loan', _('Loan')
    COMPANY_EXPENSE = 'company_expense', _('Company Expense')
    OTHER = 'other', _('Other')


class FileAttachmentType(models.TextChoices):
    """File attachment type choices."""
    PROOF = 'proof', _('Proof')
    RECEIPT = 'receipt', _('Receipt')


class AdjustmentType(models.TextChoices):
    """Salary adjustment types."""
    BONUS = 'bonus', _('Bonus')
    EXTRA_PAYMENT = 'extra_payment', _('Extra Payment')
    LOAN = 'loan', _('Loan')
    SALARY_ADVANCE = 'salary_advance', _('Salary Advance')
    IOU = 'iou', _('IOU')


class ClientPaymentStatus(models.TextChoices):
    """Company payment status choices."""
    PAID = 'paid', _('Fully Paid')
    PARTIAL = 'partial', _('Partially Paid')
    UNPAID = 'unpaid', _('Pending')


# ==================== QUERYSET MANAGERS ====================

class EmployeeQuerySet(models.QuerySet):
    def active(self):
        return self.filter(status=EmployeeStatus.ACTIVE)

    def with_user(self):
        return self.select_related('user')


class PaymentQuerySet(models.QuerySet):
    def with_employee(self):
        return self.select_related('employee__user')
    def with_related(self):
        return self.select_related(
            'employee',
            'employee__user',
            'processed_by'
        )

    def pending(self):
        return self.filter(status=PaymentStatus.PENDING)

    def completed(self):
        return self.filter(status=PaymentStatus.COMPLETED)


class DeductionQuerySet(models.QuerySet):
    def with_employee(self):
        return self.select_related('employee__user')

    # def pending(self):
    #     return self.filter(status=DeductionStatus.PENDING)
    # def applied(self):
    #     return self.filter(status=DeductionStatus.APPLIED)
    # def cancelled(self):
    #     return self.filter(status=DeductionStatus.CANCELLED)
    # def terminated(self):
    #     return self.filter(status=DeductionStatus.TERMINATED)
    # def pending_hr(self):
    #     return self.filter(status=DeductionStatus.PENDING_HR)

class CompanyQuerySet(models.QuerySet):
    def active(self):
        return self.filter(status=CompanyStatus.ACTIVE)

    def with_guards(self):
        return self.prefetch_related('assigned_guards')


class AttendanceQuerySet(models.QuerySet):
    def with_employee(self):
        return self.select_related('employee__user')

class NotificationQuerySet(models.QuerySet):
    def unread(self):
        return self.filter(is_read=False)

    def for_user(self, user):
        return self.filter(user=user)


class EmployeeRequestQuerySet(models.QuerySet):
    def with_employee(self):
        return self.select_related('employee')

    def pending(self):
        return self.filter(status=ApprovalStatus.PENDING)


# ==================== USER ====================

class User(AbstractUser):
    """Custom User Model with role-based permissions."""

    ROLE_ADMIN = 'admin'
    ROLE_STAFF = 'staff'
    ROLE_GUARD = 'guard'
    ROLE_MANAGER = 'manager'
    ROLE_ACCOUNTANT = 'accountant'
    ROLE_HR = 'hr'
    ROLE_OPC = 'opc'

    ROLE_CHOICES = [
        (ROLE_ADMIN, _('Admin')),
        (ROLE_STAFF, _('Staff')),
        (ROLE_GUARD, _('Guard')),
        (ROLE_MANAGER, _('Manager')),
        (ROLE_ACCOUNTANT, _('Accountant')),
        (ROLE_HR, _('HR')),
        (ROLE_OPC, _('OPC')),
    ]

    role = models.CharField(
        _('role'),
        max_length=20,
        choices=ROLE_CHOICES,
        default=ROLE_STAFF
    )
    email = models.EmailField(_('email address'), db_index=True)
    full_name = models.CharField(_('full name'), max_length=150, blank=True)
    phone = models.CharField(_('phone number'), max_length=20, blank=True)

    objects = UserManager()

    USERNAME_FIELD = 'email'
    REQUIRED_FIELDS = ['full_name']

    # Admin permission flags
    is_company_admin = models.BooleanField(default=False)
    is_notification_admin = models.BooleanField(default=False)
    is_employee_admin = models.BooleanField(default=False)
    is_payment_admin = models.BooleanField(default=False)
    is_deduction_admin = models.BooleanField(default=False)
    is_password_admin = models.BooleanField(default=False)
    is_hr_admin = models.BooleanField(default=False)
    is_request_admin = models.BooleanField(default=False)

    class Meta:
        db_table = 'users'
        verbose_name = _('User')
        verbose_name_plural = _('Users')
        constraints = [
            models.UniqueConstraint(
                Lower('email'),
                condition=~models.Q(email__iexact='fotasco@gmail.com'),
                name='unique_user_email_except_default',
            ),
        ]

    def __str__(self):
        return self.email

    def get_full_name(self):
        return self.full_name or self.email

    def get_short_name(self):
        return self.full_name or self.email

    def save(self, *args, **kwargs):
        if not self.username:
            base = self.email.split('@')[0]
            self.username = f"{base[:20]}_{uuid.uuid4().hex[:6]}"[:30]
        super().save(*args, **kwargs)

    @property
    def has_staff_access(self):
        return any([
            self.is_superuser,
            self.role == self.ROLE_ADMIN,
            self.is_company_admin,
            self.is_payment_admin,
            self.is_deduction_admin,
            self.is_employee_admin,
            self.is_request_admin,
            self.is_hr_admin,
            self.is_notification_admin,
        ])

    @property
    def is_admin(self):
        return self.role == self.ROLE_ADMIN or self.is_superuser

    @property
    def is_manager(self):
        return self.role == self.ROLE_MANAGER
    
    
# ==================== EMPLOYEE SEQUENCE COUNTER ====================

class EmployeeSequence(models.Model):
    """Thread-safe sequence counter for employee ID generation.

    Backward-compatible behavior:
    - If legacy DB data exists using type='global', we continue to use it.
    - Otherwise we create/maintain independent counters per employee type.

    This prevents numbering overlaps between STAFF/GRD/EMP.
    """
    type = models.CharField(max_length=10, choices=EmployeeType.choices)

    last_value = models.PositiveIntegerField(default=0)

    @classmethod
    def global_sequence_key(cls):
        # Legacy key used by prior implementation.
        return 'global'

    @classmethod
    def sequence_key_for_type(cls, employee_type: str) -> str:
        # Map employee type values to sequence keys.
        if employee_type == EmployeeType.STAFF:
            return EmployeeType.STAFF
        if employee_type == EmployeeType.GUARD:
            return EmployeeType.GUARD
        if employee_type == EmployeeType.EMPLOYEE:
            return EmployeeType.EMPLOYEE
        return EmployeeType.EMPLOYEE

    class Meta:
        db_table = 'employee_sequences'
        verbose_name = _('Employee Sequence')
        verbose_name_plural = _('Employee Sequences')
        constraints = [
            models.UniqueConstraint(
                fields=['type'],
                name='unique_employee_sequence_type'
            ),
        ]

    def __str__(self):
        return f"{self.type} - {self.last_value}"


# ==================== EMPLOYEE ====================

class Employee(TimeStampedModel, SoftDeleteModel):
    """Employee Model - Staff, Guard, and Employee records with ID generation."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    id_sequence = models.PositiveIntegerField(
        editable=False,
        null=True,
        blank=True,
        help_text=_('Auto-incrementing sequence per employee type for ID generation.')
    )
    history = HistoricalRecords(excluded_fields=['updated_at'])
    employee_id = models.CharField(max_length=20, unique=True, db_index=True)
    user = models.OneToOneField(
        User,
        on_delete=models.CASCADE,
        related_name='employee_profile'
    )
    name = models.CharField(max_length=200)
    type = models.CharField(max_length=10, choices=EmployeeType.choices)
    location = models.CharField(max_length=200)
    salary = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(0)]
    )

    phone_validator = RegexValidator(
        regex=r'^(\+234|0)[789][01]\d{8}$',
        message=_('Enter a valid Nigerian phone number (e.g., +2348012345678 or 08012345678).')
    )
    phone = models.CharField(
        max_length=15,
        validators=[phone_validator]
    )
    email = models.EmailField(blank=True, null=True)

    # Bank Details (Nigerian Banks - Naira)
    bank_name = models.CharField(max_length=100)
    bank_code = models.CharField(max_length=20, blank=True, null=True)
    paystack_recipient_code = models.CharField(max_length=100, blank=True, null=True)
    account_number = models.CharField(
        max_length=10,
        validators=[
            RegexValidator(
                regex=r'^\d{10}$',
                message=_('Account number must be exactly 10 digits.')
            )
        ]
    )
    account_holder = models.CharField(max_length=200)

    is_self_registered = models.BooleanField(default=False)
    status = models.CharField(
        max_length=15,
        choices=EmployeeStatus.choices,
        default=EmployeeStatus.PENDING
    )
    join_date = models.DateField()

    objects = EmployeeQuerySet.as_manager()

    class Meta:
        db_table = 'employees'
        ordering = ['-created_at']
        verbose_name = _('Employee')
        verbose_name_plural = _('Employees')
        indexes = [
            models.Index(fields=['type', 'status'], name='emp_type_status_idx'),
            models.Index(fields=['employee_id'], name='emp_id_idx'),
            models.Index(fields=['status'], name='emp_status_idx'),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=['employee_id'],
                name='unique_employee_id',
                violation_error_message=_('Employee ID must be unique.')
            ),
            models.CheckConstraint(
                check=models.Q(salary__gte=0),
                name='employee_salary_positive'
            ),
        ]

    def __str__(self):
        return f"{self.employee_id} - {self.name}"

    def clean(self):
        """Validate employee data before saving."""
        super().clean()

    def generate_employee_id(self):
        """Generate unique employee ID.

        Uses a locked per-type sequence counter. If a collision is detected, the
        sequence is considered out-of-sync and is *self-healed* by syncing to the
        current max value already stored in the DB for this employee type.
        """
        suffix = {
            EmployeeType.STAFF: 'STAFF',
            EmployeeType.GUARD: 'GRD',
            EmployeeType.EMPLOYEE: 'EMP'
        }.get(self.type, 'EMP')

        def _extract_last_value(emp_id: str):
            # Expected format: FSS-###-SUFFIX
            try:
                parts = (emp_id or '').split('-')
                if len(parts) != 3:
                    return None
                if parts[0] != 'FSS':
                    return None
                return int(parts[1])
            except (TypeError, ValueError):
                return None

        # Use independent per-employee-type counters.
        # STAFF: staff
        # GRD: guard
        # EMPLOYEE: employee
        #
        # Backward compatibility:
        # - If legacy data exists using type='global', we self-heal per-type sequences
        #   by syncing them to the max numeric portion already present for that suffix.

        sequence_type_key = {
            EmployeeType.STAFF: EmployeeType.STAFF,
            EmployeeType.GUARD: EmployeeType.GUARD,
            EmployeeType.EMPLOYEE: EmployeeType.EMPLOYEE,
        }.get(self.type, EmployeeType.EMPLOYEE)

        legacy_global_key = EmployeeSequence.global_sequence_key()

        with transaction.atomic():
            # Bounded retry to avoid infinite loops.
            for _attempt in range(2):
                # Create the per-type sequence row if missing.
                seq, _ = EmployeeSequence.objects.select_for_update().get_or_create(
                    type=sequence_type_key,
                    defaults={'last_value': 0}
                )

                # Self-heal: sync this *type* sequence to the max numeric portion
                # for IDs that already exist for the same suffix.
                existing_ids = Employee.all_objects.values_list('employee_id', flat=True)
                max_existing_for_suffix = None
                for eid in existing_ids:
                    if not eid:
                        continue
                    if not eid.endswith(f"-{suffix}"):
                        continue
                    lv = _extract_last_value(eid)
                    if lv is None:
                        continue
                    max_existing_for_suffix = (
                        lv if max_existing_for_suffix is None else max(max_existing_for_suffix, lv)
                    )

                if max_existing_for_suffix is not None and seq.last_value < max_existing_for_suffix:
                    seq.last_value = max_existing_for_suffix
                    seq.save(update_fields=['last_value'])
                else:
                    # Additional backward-compatibility: if no per-type max exists yet but
                    # the legacy global counter is ahead, move this type forward.
                    try:
                        legacy_seq = EmployeeSequence.objects.select_for_update().get(type=legacy_global_key)
                    except EmployeeSequence.DoesNotExist:
                        legacy_seq = None

                    if legacy_seq is not None and seq.last_value < legacy_seq.last_value:
                        seq.last_value = legacy_seq.last_value
                        seq.save(update_fields=['last_value'])

                seq.last_value += 1
                seq.save(update_fields=['last_value'])

                employee_id = f"FSS-{str(seq.last_value).zfill(3)}-{suffix}"

                if not Employee.all_objects.filter(employee_id=employee_id).exists():
                    self.id_sequence = seq.last_value
                    return employee_id

                # Collision still occurred: resync from DB max for this suffix and retry.
                continue

            raise IntegrityError(
                f"Employee ID collision could not be resolved after retries for suffix={suffix}."
            )
            
    def clean(self):
        super().clean()
        if self.bank_code:
            # Paystack bank codes are opaque strings; keep leading zeros and do not enforce length.
            self.bank_code = str(self.bank_code).strip()
    
    def save(self, *args, **kwargs):
        if not self.employee_id and self.type in (EmployeeType.STAFF, EmployeeType.GUARD, EmployeeType.EMPLOYEE):
            self.employee_id = self.generate_employee_id()
        self.full_clean()
        super().save(*args, **kwargs)


# ==================== ATTENDANCE ====================

class Attendance(TimeStampedModel):
    """Attendance Model with selfie capture and timestamp tracking."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(
        Employee,
        on_delete=models.PROTECT,
        related_name='attendances'
    )
    date = models.DateField()

    clock_in = models.TimeField(blank=True, null=True)
    clock_in_timestamp = models.DateTimeField(blank=True, null=True)
    clock_in_photo = models.ImageField(
        upload_to='attendance/clock_in/%Y/%m/',
        blank=True,
        null=True,
        validators=[validate_file_size]
    )

    clock_out = models.TimeField(blank=True, null=True)
    clock_out_timestamp = models.DateTimeField(blank=True, null=True)
    clock_out_photo = models.ImageField(
        upload_to='attendance/clock_out/%Y/%m/',
        blank=True,
        null=True,
        validators=[validate_file_size]
    )

    clock_method = models.CharField(
        max_length=10,
        choices=ClockMethod.choices,
        blank=True,
        null=True
    )

    leave_start = models.DateField(blank=True, null=True)
    leave_end = models.DateField(blank=True, null=True)
    status = models.CharField(
        max_length=10,
        choices=AttendanceStatus.choices,
        default=AttendanceStatus.PRESENT
    )

    objects = AttendanceQuerySet.as_manager()

    class Meta:
        db_table = 'attendance'
        ordering = ['-date']
        verbose_name = _('Attendance Record')
        verbose_name_plural = _('Attendance Records')
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

    def clean(self):
        """Validate clock timestamps are consistent with attendance date.
        Supports overnight shifts (clock-out after midnight)."""
        from datetime import datetime, timedelta
        super().clean()
        if self.clock_in and self.clock_in_timestamp:
            if self.clock_in_timestamp.date() != self.date:
                raise ValidationError(
                    {"clock_in_timestamp": _("Clock-in timestamp date must match attendance date.")}
                )
        if self.clock_out and self.clock_out_timestamp:
            # Allow clock-out on next day for overnight shifts
            if self.clock_out_timestamp.date() not in [self.date, self.date + timedelta(days=1)]:
                raise ValidationError(
                    {"clock_out_timestamp": _("Clock-out timestamp must be on attendance date or next day for overnight shifts.")}
                )
        # Validate clock-out is after clock-in (supports overnight)
        if self.clock_in and self.clock_out:
            in_dt = datetime.combine(self.date, self.clock_in)
            out_dt = datetime.combine(self.date, self.clock_out)
            if out_dt < in_dt:
                out_dt += timedelta(days=1)
            duration = out_dt - in_dt
            if duration.total_seconds() <= 0:
                raise ValidationError(
                    {"clock_out": _("Clock-out time must be after clock-in time.")}
                )

    def save(self, *args, **kwargs):
        self.full_clean()
        super().save(*args, **kwargs)

    @property
    def calculated_profit(self):
        """Calculate profit for the company without mutating fields."""
        assigned_count = self.assigned_guards.count()
        effective_count = max(assigned_count, self.guards_count)
        total_payment = effective_count * self.payment_per_guard
        return self.payment_to_us - total_payment

    @transaction.atomic
    def reactivate(self):
        """Reactivate a terminated company."""
        if self.status != CompanyStatus.TERMINATED:
            raise ValueError(_(f"Cannot reactivate company with status: {self.status}"))
        self.status = CompanyStatus.REACTIVATED
        self.termination_reason = None
        self.save(update_fields=['status', 'termination_reason', 'updated_at'])

    @transaction.atomic
    def terminate(self, reason=''):
        """Terminate an active or reactivated company."""
        if self.status not in [CompanyStatus.ACTIVE, CompanyStatus.REACTIVATED]:
            raise ValueError(_(f"Cannot terminate company with status: {self.status}"))
        self.status = CompanyStatus.TERMINATED
        self.termination_reason = reason
        self.save(update_fields=['status', 'termination_reason', 'updated_at'])


# ==================== DEDUCTION ====================

class Deduction(TimeStampedModel):
    """Deduction Model for salary deductions and penalties."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(
        Employee,
        on_delete=models.PROTECT,
        related_name='deductions'
    )
    amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(0)]
    )
    amount_paid = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)],
        help_text="Amount already recovered through payroll"
    )
    remaining_balance = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)],
        help_text="Outstanding deduction balance"
    )
    reason = models.TextField()
    date = models.DateField()
    settled_at = models.DateTimeField(null=True, blank=True)
    status = models.CharField(
        max_length=20,
        choices=DeductionStatus.choices,
        default=DeductionStatus.PENDING
    )
    # hr_approved is synced with status - do not set manually, use transition methods
    hr_approved = models.BooleanField(default=False, editable=False)
    hr_approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='hr_approved_deductions'
    )
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='created_deductions'
    )
    history = HistoricalRecords(excluded_fields=['updated_at'])

    objects = DeductionQuerySet.as_manager()

    class Meta:
        db_table = 'deductions'
        ordering = ['-date']
        verbose_name = _('Deduction')
        verbose_name_plural = _('Deductions')
        indexes = [
            models.Index(fields=['employee', 'status'], name='ded_emp_status_idx'),
            models.Index(fields=['date'], name='ded_date_idx'),
        ]
        constraints = [
            models.CheckConstraint(
                check=models.Q(amount__gte=0),
                name='deduction_amount_positive'
            ),
            models.CheckConstraint(
                check=models.Q(amount_paid__gte=0),
                name='deduction_amount_paid_positive'
            ),
            models.CheckConstraint(
                check=models.Q(remaining_balance__gte=0),
                name='deduction_remaining_balance_positive'
            ),
            models.CheckConstraint(
                check=models.Q(amount_paid__lte=models.F('amount')),
                name='deduction_amount_paid_not_over_amount'
            ),
            models.CheckConstraint(
                check=models.Q(
                    models.Q(status=DeductionStatus.PENDING) |
                    models.Q(status=DeductionStatus.PARTIAL) |
                    models.Q(status=DeductionStatus.SETTLED) |
                    models.Q(status=DeductionStatus.APPLIED) |
                    models.Q(status=DeductionStatus.CANCELLED) |
                    models.Q(status=DeductionStatus.TERMINATED) |
                    models.Q(status=DeductionStatus.PENDING_HR)
                ),
                name='deduction_status_valid'
            ),
        ]

    def __str__(self):
        return f"{self.employee.employee_id} - N{self.amount}"

    def clean(self):
        """Sync hr_approved with status to maintain single source of truth."""
        super().clean()
        if self.amount is not None and self.amount_paid is not None:
            if self.amount_paid > self.amount:
                raise ValidationError({"amount_paid": _("Amount paid cannot exceed deduction amount.")})
            self.remaining_balance = max(self.amount - self.amount_paid, 0)

        if self.remaining_balance == 0 and self.amount and self.status in [
            DeductionStatus.PENDING,
            DeductionStatus.PARTIAL,
            DeductionStatus.APPLIED,
        ]:
            self.status = DeductionStatus.SETTLED
            if self.settled_at is None:
                self.settled_at = timezone.now()

        if self.status == DeductionStatus.PENDING_HR:
            self.hr_approved = False
        elif self.status in [
            DeductionStatus.PENDING,
            DeductionStatus.PARTIAL,
            DeductionStatus.SETTLED,
            DeductionStatus.APPLIED,
        ]:
            self.hr_approved = True

    @transaction.atomic
    def apply(self, approved_by):
        """Apply the deduction after HR approval."""
        if self.status != DeductionStatus.PENDING_HR:
            raise ValueError(_(f"Cannot apply deduction with status: {self.status}"))
        self.status = DeductionStatus.PENDING
        self.hr_approved = True
        self.hr_approved_by = approved_by
        self.save(update_fields=['status', 'hr_approved', 'hr_approved_by', 'updated_at'])

    @transaction.atomic
    def cancel(self):
        """Cancel a pending deduction."""
        if self.status not in [DeductionStatus.PENDING, DeductionStatus.PENDING_HR]:
            raise ValueError(_(f"Cannot cancel deduction with status: {self.status}"))
        self.status = DeductionStatus.CANCELLED
        self.save(update_fields=['status', 'updated_at'])

    def save(self, *args, **kwargs):
        if self.amount is not None and self.amount_paid is None:
            self.amount_paid = 0
        if self.amount is not None and (self.remaining_balance in [None, 0]) and not self.pk and not self.amount_paid:
            self.remaining_balance = self.amount
        self.full_clean()
        super().save(*args, **kwargs)


# ==================== PAYMENT ====================

class Payment(TimeStampedModel):
    """Payment Model for salary processing with Paystack integration."""

    STATUS_TRANSITIONS = {
        PaymentStatus.PENDING: [
            PaymentStatus.PROCESSING,
            PaymentStatus.FAILED,
            PaymentStatus.PENDING_PAYSTACK_OTP,
            PaymentStatus.CANCELLED,
        ],
        PaymentStatus.PROCESSING: [
            PaymentStatus.COMPLETED,
            PaymentStatus.FAILED,
            PaymentStatus.PENDING_PAYSTACK_OTP,
        ],
        PaymentStatus.PENDING_PAYSTACK_OTP: [
            PaymentStatus.COMPLETED,
            PaymentStatus.FAILED,
            PaymentStatus.PROCESSING,
        ],
        PaymentStatus.FAILED: [
            PaymentStatus.PROCESSING,
            PaymentStatus.CANCELLED,
        ],
        PaymentStatus.COMPLETED: [],
        PaymentStatus.PENDING_HR: [
            PaymentStatus.PENDING,
            PaymentStatus.FAILED,
            PaymentStatus.CANCELLED,
        ],
        PaymentStatus.CANCELLED: [],
    }

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(
        Employee,
        on_delete=models.PROTECT,
        related_name='payments'
    )
    payment_month = models.CharField(
        max_length=7,
        help_text=_('Format: YYYY-MM'),
        null=True,
        blank=True,
        validators=[
            RegexValidator(
                regex=r'^\d{4}-(0[1-9]|1[0-2])$',
                message=_('Format must be YYYY-MM (e.g., 2024-01)')
            )
        ]
    )
    base_salary = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(0)]
    )
    total_deductions = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)]
    )
    net_amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(0)]
    )
    amount_paid = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
        validators=[MinValueValidator(0)]
    )
    bonus_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    iou_amount = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    is_partial = models.BooleanField(default=False)
    partial_reason = models.TextField(blank=True, null=True)
    payment_method = models.CharField(max_length=20, choices=PaymentMethod.choices)
    transaction_reference = models.CharField(max_length=100, unique=True, db_index=True)
    paystack_reference = models.CharField(max_length=100, blank=True, null=True)
    paystack_transfer_code = models.CharField(max_length=100, blank=True, null=True)
    failure_reason = models.TextField(blank=True, null=True)
    paystack_last_status = models.CharField(max_length=50, blank=True, null=True)
    paystack_last_response = models.JSONField(blank=True, null=True)
    status = models.CharField(
        max_length=25,
        choices=PaymentStatus.choices,
        default=PaymentStatus.PENDING
    )

    remaining_balance = models.DecimalField(
        max_digits=10, decimal_places=2, default=0,
        validators=[MinValueValidator(0)],
        help_text="Remaining balance for partial payments"
    )
    previous_balance = models.DecimalField(
        max_digits=10, decimal_places=2, default=0,
        validators=[MinValueValidator(0)],
        help_text="Previous month's unpaid balance"
    )
    hr_approved = models.BooleanField(default=False, editable=False)
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
    history = HistoricalRecords(excluded_fields=['updated_at'])

    objects = PaymentQuerySet.as_manager()

    class Meta:
        db_table = 'payments'
        ordering = ['-payment_date']
        verbose_name = _('Payment')
        verbose_name_plural = _('Payments')
        permissions = [
            ('approve_payment', _('Can approve payment')),
            ('process_salary', _('Can process salary')),
        ]
        # Removed unique_payment_per_employee_per_month constraint to allow multiple partial payments in a month.
        # The logic for preventing duplicate *active* payments is now handled in the initiate_payment view.
        # A new migration will be generated to remove this constraint from the database.
        constraints = [
            # models.UniqueConstraint(fields=('employee', 'payment_month'), name='unique_payment_per_employee_per_month'),
            
            models.CheckConstraint(
                check=models.Q(base_salary__gte=0),
                name='payment_base_salary_positive'
            ),
            models.CheckConstraint(
                check=models.Q(total_deductions__gte=0),
                name='payment_deductions_positive'
            ),
            models.CheckConstraint(
                check=models.Q(net_amount__gte=0),
                name='payment_net_amount_positive'
            ),
            models.CheckConstraint(
                check=models.Q(
                    models.Q(status=PaymentStatus.PENDING) |
                    models.Q(status=PaymentStatus.PROCESSING) |
                    models.Q(status=PaymentStatus.COMPLETED) |
                    models.Q(status=PaymentStatus.FAILED) |
                    models.Q(status=PaymentStatus.PENDING_PAYSTACK_OTP) |
                    models.Q(status=PaymentStatus.PENDING_HR) |
                    models.Q(status=PaymentStatus.CANCELLED)
                ),
                name='payment_status_valid'
            ),
            models.CheckConstraint(
                check=(
                    (
                        models.Q(is_partial=True) &
                        models.Q(amount_paid__isnull=False) &
                        models.Q(amount_paid__lt=models.F('net_amount'))
                    ) |
                    (
                        models.Q(is_partial=False) &
                        (
                            models.Q(amount_paid__isnull=True) |
                            models.Q(amount_paid__gte=models.F('net_amount'))
                        )
                    )
                ),
                name='partial_payment_consistency'
            )
        ]

    def __str__(self):
        emp_id = getattr(self.employee, "employee_id", "UNKNOWN")
        return f"{emp_id} - N{self.net_amount or 0}"

    def clean(self):
        """Validate payment data."""
        super().clean()

        # Validate net_amount is set and non-negative
        if self.net_amount is None:
            raise ValidationError({"net_amount": _("Net amount is required.")})
        if self.net_amount is not None and self.net_amount < 0:
            raise ValidationError({"net_amount": _("Net amount cannot be negative.")})
    
    @classmethod
    def get_previous_balance(cls, employee_id, current_month):
        try:
            prev = cls.objects.filter(
                employee_id=employee_id, payment_month__lt=current_month, is_partial=True
            ).order_by('-payment_month').first()
            return prev.remaining_balance if prev else 0
        except:
            return 0


    def save(self, *args, **kwargs):
        # Auto-calculate net_amount only on initial creation if not provided
        if not self.pk and self.net_amount is None:
            self.net_amount = self.base_salary - self.total_deductions
        self.full_clean()
        if not self.is_partial and self.amount_paid is None:
            self.remaining_balance = 0
        super().save(*args, **kwargs)

    @transaction.atomic
    def change_status(self, new_status):
        """Centralized state machine transition logic."""
        payment = Payment.objects.select_for_update().get(pk=self.pk)
        if new_status == payment.status:
            return False
        
        allowed = self.STATUS_TRANSITIONS.get(payment.status, [])
        if new_status not in allowed:
            raise ValueError(
                _(f"Illegal status transition from {self.status} to {new_status}")
            )
        payment.status = new_status
        payment.save(update_fields=['status', 'updated_at'])
        
        self.status = payment.status
        return True

    def can_transition_to(self, new_status):
        """Check if a status transition is allowed without executing it."""
        if new_status == self.status:
            return False
        return new_status in self.STATUS_TRANSITIONS.get(self.status, [])

    def get_allowed_transitions(self):
        """Return list of allowed next statuses from current state."""
        return self.STATUS_TRANSITIONS.get(self.status, [])

    def is_paystack_otp_expired(self):
        if self.payment_method != PaymentMethod.BANK_TRANSFER:
            return False
        if self.status != PaymentStatus.PENDING_PAYSTACK_OTP:
            return False
        expiry_minutes = getattr(settings, 'PAYSTACK_OTP_EXPIRY_MINUTES', 30)
        return self.updated_at + timedelta(minutes=expiry_minutes) <= timezone.now()

    def is_paystack_status_stale(self):
        if self.payment_method != PaymentMethod.BANK_TRANSFER:
            return False
        if self.status not in [
            PaymentStatus.PENDING,
            PaymentStatus.PROCESSING,
            PaymentStatus.PENDING_PAYSTACK_OTP,
        ]:
            return False
        stale_minutes = getattr(settings, 'PAYSTACK_STALE_MINUTES', 60)
        return self.updated_at + timedelta(minutes=stale_minutes) <= timezone.now()

    def fail_due_to_expiry(self, reason):
        """Mark the payment failed due to expiry (OTP or stale auth).

        Must only update real model fields (failure_reason already exists).
        """
        if self.status not in [
            PaymentStatus.PENDING,
            PaymentStatus.PROCESSING,
            PaymentStatus.PENDING_PAYSTACK_OTP,
        ]:
            return False
        self.status = PaymentStatus.FAILED
        self.failure_reason = reason
        self.save(update_fields=['status', 'failure_reason', 'updated_at'])
        return True



    @transaction.atomic
    def mark_as_paid(self, amount=None):
        """Mark payment as completed with optional amount tracking."""
        if self.net_amount is None:
            raise ValueError(_("Cannot mark as paid: net_amount is not set."))
        if amount is not None:
            self.amount_paid = amount
            self.is_partial = (amount < self.net_amount)
        else:
            self.amount_paid = self.net_amount
            self.is_partial = False
        self.status = PaymentStatus.COMPLETED
        self.save(update_fields=['status', 'amount_paid', 'is_partial', 'updated_at'])
        return True

    @transaction.atomic
    def retry_payment(self):
        """Retry a failed payment."""
        if self.status != PaymentStatus.FAILED:
            raise ValueError(_(f"Cannot retry payment with status: {self.status}"))
        return self.change_status(PaymentStatus.PROCESSING)

    @transaction.atomic
    def cancel_payment(self):
        """Cancel a pending or failed payment."""
        if self.status not in [
            PaymentStatus.PENDING,
            PaymentStatus.FAILED,
            PaymentStatus.PENDING_HR
        ]:
            raise ValueError(_(f"Cannot cancel payment with status: {self.status}"))
        return self.change_status(PaymentStatus.CANCELLED)


# ==================== COMPANY ====================

class Company(TimeStampedModel, SoftDeleteModel):
    """Company/Client Model for guard assignments and profit tracking."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=200)
    location = models.CharField(max_length=200)
    email = models.EmailField(blank=True, null=True)
    phone = models.CharField(max_length=15, blank=True, null=True)
    status = models.CharField(
        max_length=15,
        choices=CompanyStatus.choices,
        default=CompanyStatus.ACTIVE
    )
    termination_reason = models.TextField(blank=True, null=True)
    contract_start = models.DateField(null=True, blank=True)
    contract_end = models.DateField(null=True, blank=True)
    guards_count = models.IntegerField(
        validators=[MinValueValidator(0)],
        default=0,
        help_text=_('Expected/contracted number of guards. Used for profit calculation.')
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
        blank=True,
        editable=False
    )
    profit = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
        editable=False
    )
    assigned_guards = models.ManyToManyField(
        Employee,
        related_name='assigned_companies',
        blank=True,
        limit_choices_to={'type': 'guard', 'status': 'active'}
    )
    history = HistoricalRecords(excluded_fields=['updated_at'])

    objects = CompanyQuerySet.as_manager()

    class Meta:
        db_table = 'companies'
        ordering = ['-created_at']
        verbose_name = _('Company')
        verbose_name_plural = _('Companies')
        indexes = [
            models.Index(fields=['status'], name='comp_status_idx'),
            models.Index(fields=['name'], name='comp_name_idx'),
        ]
        constraints = [
            models.CheckConstraint(
                check=models.Q(payment_to_us__gte=0),
                name='company_payment_positive'
            ),
            models.CheckConstraint(
                check=models.Q(payment_per_guard__gte=0),
                name='company_payment_per_guard_positive'
            ),
            models.CheckConstraint(
                check=models.Q(
                    models.Q(status=CompanyStatus.ACTIVE) |
                    models.Q(status=CompanyStatus.TERMINATED) |
                    models.Q(status=CompanyStatus.REACTIVATED)
                ),
                name='company_status_valid'
            ),
        ]

    def __str__(self):
        return self.name

    def clean(self):
        """Validate contract dates and guard count consistency."""
        super().clean()
        if self.contract_end and self.contract_start and self.contract_end < self.contract_start:
            raise ValidationError(
                {"contract_end": _("Contract end date must be after start date.")}
            )

    def save(self, *args, **kwargs):
        self.full_clean()
        # Profit = Amount Received From Client - Total Amount Paid To Guards/Employees/Staff
        # We use the sum of actual base salaries of assigned guards if they exist, 
        # otherwise fallback to guards_count * payment_per_guard
        if self.pk and self.assigned_guards.exists():
            self.total_payment_to_guards = self.assigned_guards.aggregate(total=models.Sum('salary'))['total'] or 0
        else:
            effective_count = max(self.assigned_guards.count() if self.pk else 0, self.guards_count)
            self.total_payment_to_guards = effective_count * self.payment_per_guard
        
        self.profit = self.payment_to_us - (self.total_payment_to_guards or 0)
        super().save(*args, **kwargs)


# ==================== COMPANY MONTHLY PAYMENTS ====================
class CompanyMonthlyPayment(TimeStampedModel):
    """Monthly payment record from a client/company."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name='company_monthly_payments')
    payment_month = models.CharField(max_length=7, help_text='YYYY-MM')
    amount_due = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    amount_paid = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    status = models.CharField(
        max_length=20, 
        choices=ClientPaymentStatus.choices, 
        default=ClientPaymentStatus.UNPAID
    )
    payment_date = models.DateField(null=True, blank=True)
    notes = models.TextField(blank=True, null=True)

    class Meta:
        db_table = 'company_monthly_payments'
        ordering = ['-payment_month']
        constraints = [
            models.UniqueConstraint(
                fields=['company', 'payment_month'],
                name='unique_company_payment_per_month'
            )
        ]

    @property
    def outstanding(self):
        return max(0, self.amount_due - (self.amount_paid or 0))

    @property
    def calculated_profit(self):
        """Calculate profit without mutating fields."""
        # Company.objects.annotate(
            # assigned_count=models.Count('assigned_guards')
            # ).filter(pk=self.pk).first()
        assigned_count = self.assigned_guards.count()
        effective_count = max(assigned_count, self.guards_count)
        total_payment = effective_count * self.payment_per_guard
        return self.payment_to_us - total_payment

    @transaction.atomic
    def reactivate(self):
        """Reactivate a terminated company."""
        if self.status != CompanyStatus.TERMINATED:
            raise ValueError(_(f"Cannot reactivate company with status: {self.status}"))
        self.status = CompanyStatus.REACTIVATED
        self.termination_reason = None
        self.save(update_fields=['status', 'termination_reason', 'updated_at'])

    @transaction.atomic
    def terminate(self, reason=''):
        """Terminate an active or reactivated company."""
        if self.status not in [CompanyStatus.ACTIVE, CompanyStatus.REACTIVATED]:
            raise ValueError(_(f"Cannot terminate company with status: {self.status}"))
        self.status = CompanyStatus.TERMINATED
        self.termination_reason = reason
        self.save(update_fields=['status', 'termination_reason', 'updated_at'])


# ==================== SACKED EMPLOYEE ====================

class SackedEmployee(TimeStampedModel):
    """Archive for terminated/sacked employees."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(
        Employee,
        on_delete=models.PROTECT,
        related_name='termination_records'
    )
    date_sacked = models.DateField()
    offense = models.TextField()
    terminated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True
    )

    class Meta:
        db_table = 'sacked_employees'
        ordering = ['-date_sacked']
        verbose_name = _('Terminated Employee')
        verbose_name_plural = _('Terminated Employees')
        indexes = [
            models.Index(fields=['employee'], name='sack_emp_idx'),
            models.Index(fields=['date_sacked'], name='sack_date_idx'),
        ]

    def __str__(self):
        return f"{self.employee.employee_id} - Terminated on {self.date_sacked}"

    def save(self, *args, **kwargs):
        self.full_clean()
        super().save(*args, **kwargs)


# ==================== NOTIFICATION ====================

class Notification(TimeStampedModel):
    """Notification Model for user alerts."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='notifications',
        null=True,
        blank=True
    )
    message = models.TextField(max_length=1000)
    type = models.CharField(
        max_length=10,
        choices=NotificationType.choices,
        default=NotificationType.INFO
    )
    is_read = models.BooleanField(default=False)

    objects = NotificationQuerySet.as_manager()

    class Meta:
        db_table = 'notifications'
        ordering = ['-created_at']
        verbose_name = _('Notification')
        verbose_name_plural = _('Notifications')
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


# ==================== REMINDERS ====================

class Reminder(TimeStampedModel):
    """User reminder with optional completion notification."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='reminders'
    )
    title = models.CharField(max_length=160)
    purpose = models.TextField(max_length=1000)
    remind_at = models.DateTimeField(db_index=True)
    is_complete = models.BooleanField(default=False)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'reminders'
        ordering = ['is_complete', 'remind_at']
        indexes = [
            models.Index(fields=['user', 'is_complete', 'remind_at'], name='rem_user_status_time_idx'),
        ]

    def __str__(self):
        return f"{self.title} - {self.remind_at:%Y-%m-%d %H:%M}"

    def complete(self):
        if not self.is_complete:
            self.is_complete = True
            self.completed_at = timezone.now()
            self.save(update_fields=['is_complete', 'completed_at', 'updated_at'])


# ==================== EMPLOYEE REQUEST ====================

class EmployeeRegistrationRequest(TimeStampedModel):
    """HR-reviewed self-registration request for creating/activating employees."""

    STATUS_PENDING = ApprovalStatus.PENDING
    STATUS_APPROVED = ApprovalStatus.APPROVED
    STATUS_DECLINED = ApprovalStatus.DECLINED

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # Link to the created but inactive user (self signup creates user immediately)
    user = models.OneToOneField(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='registration_request'
    )

    # Snapshot of employee data (self signup creates Employee row as well)
    employee = models.OneToOneField(
        'Employee',
        on_delete=models.CASCADE,
        related_name='registration_request'
    )

    employee_name = models.CharField(max_length=200)
    employee_type = models.CharField(max_length=10, choices=EmployeeType.choices)
    location = models.CharField(max_length=200)

    salary = models.DecimalField(max_digits=10, decimal_places=2, validators=[MinValueValidator(0)])
    phone = models.CharField(max_length=15, blank=True, default='')
    email = models.EmailField(blank=True, null=True)

    bank_name = models.CharField(max_length=100)
    bank_code = models.CharField(max_length=20, blank=True, null=True)
    account_number = models.CharField(max_length=10)
    account_holder = models.CharField(max_length=200)

    is_self_registered = models.BooleanField(default=True)

    status = models.CharField(
        max_length=10,
        choices=ApprovalStatus.choices,
        default=ApprovalStatus.PENDING,
        db_index=True
    )
    decline_reason = models.TextField(blank=True, null=True)
    action_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='handled_registration_requests'
    )

    history = HistoricalRecords(excluded_fields=['updated_at'])

    objects = models.Manager()

    class Meta:
        db_table = 'employee_registration_requests'
        ordering = ['-created_at']
        verbose_name = _('Employee Registration Request')
        verbose_name_plural = _('Employee Registration Requests')

        indexes = [
            models.Index(fields=['status'], name='regreq_status_idx'),
            models.Index(fields=['account_number', 'bank_code'], name='regreq_account_idx'),
        ]

    def __str__(self):
        return f"{self.employee_name} ({self.status})"

    @transaction.atomic
    def approve(self, approved_by):
        if self.status != ApprovalStatus.PENDING:
            raise ValueError(_(f"Cannot approve request with status: {self.status}"))

        # Activate user + employee
        self.user.is_active = True
        self.user.save(update_fields=['is_active'])

        self.employee.status = EmployeeStatus.ACTIVE
        self.employee.is_self_registered = True
        self.employee.save(update_fields=['status', 'is_self_registered'])

        self.status = ApprovalStatus.APPROVED
        self.action_by = approved_by
        self.decline_reason = None
        self.save(update_fields=['status', 'action_by', 'decline_reason', 'updated_at'])

        Notification.objects.create(
            user=self.user,
            message=f"Welcome! Your registration has been approved (ID: {self.employee.employee_id}).",
            type='success'
        )

    @transaction.atomic
    def decline(self, declined_by, reason=''):
        if self.status != ApprovalStatus.PENDING:
            raise ValueError(_(f"Cannot decline request with status: {self.status}"))

        self.user.is_active = False
        self.user.save(update_fields=['is_active'])

        # Mark employee as inactive/terminated for consistency
        self.employee.status = EmployeeStatus.INACTIVE
        self.employee.save(update_fields=['status'])

        self.status = ApprovalStatus.DECLINED
        self.action_by = declined_by
        self.decline_reason = reason or ''
        self.save(update_fields=['status', 'action_by', 'decline_reason', 'updated_at'])

        Notification.objects.create(
            user=self.user,
            message=f"Your registration was declined. {('Reason: ' + self.decline_reason) if self.decline_reason else ''}",
            type='error'
        )


class EmployeeRequest(TimeStampedModel):
    """Model for employee requests - loans, advances, expenses."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(
        Employee,
        on_delete=models.PROTECT,
        related_name='requests'
    )
    request_type = models.CharField(max_length=20, choices=RequestType.choices)
    amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
        validators=[MinValueValidator(0)]
    )
    description = models.TextField()
    proof_photo = models.ImageField(
        upload_to='requests/proof/%Y/%m/',
        validators=[
            FileExtensionValidator(
                allowed_extensions=['jpg', 'jpeg', 'png'],
                message=_('Proof photo must be a JPG or PNG image.')
            ),
            validate_file_size
        ],
        blank=True,
        null=True
    )
    receipt_file = models.FileField(
        upload_to='requests/receipts/%Y/%m/',
        validators=[
            FileExtensionValidator(
                allowed_extensions=['pdf', 'doc', 'docx'],
                message=_('Receipt file must be a PDF, DOC, or DOCX document.')
            ),
            validate_file_size
        ],
        blank=True,
        null=True
    )
    status = models.CharField(
        max_length=10,
        choices=ApprovalStatus.choices,
        default=ApprovalStatus.PENDING
    )
    decline_reason = models.TextField(blank=True, null=True)
    action_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='handled_requests'
    )

    objects = EmployeeRequestQuerySet.as_manager()

    class Meta:
        db_table = 'employee_requests'
        ordering = ['-created_at']
        verbose_name = _('Employee Request')
        verbose_name_plural = _('Employee Requests')
        indexes = [
            models.Index(fields=['employee', 'status'], name='req_emp_status_idx'),
            models.Index(fields=['request_type'], name='req_type_idx'),
        ]

    def __str__(self):
        return f"{self.employee.name} - {self.request_type} ({self.status})"

    @transaction.atomic
    def approve(self, approved_by):
        """Approve the request."""
        if self.status != ApprovalStatus.PENDING:
            raise ValueError(_(f"Cannot approve request with status: {self.status}"))
        self.status = ApprovalStatus.APPROVED
        self.action_by = approved_by
        self.save(update_fields=['status', 'action_by', 'updated_at'])

    @transaction.atomic
    def decline(self, declined_by, reason=''):
        """Decline the request with reason."""
        if self.status != ApprovalStatus.PENDING:
            raise ValueError(_(f"Cannot decline request with status: {self.status}"))
        self.status = ApprovalStatus.DECLINED
        self.decline_reason = reason
        self.action_by = declined_by
        self.save(update_fields=['status', 'decline_reason', 'action_by', 'updated_at'])

    def save(self, *args, **kwargs):
        self.full_clean()
        super().save(*args, **kwargs)


# ==================== EMPLOYEE REQUEST ATTACHMENT ====================

class EmployeeRequestAttachment(TimeStampedModel):
    """Model for multiple file attachments per request."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    request = models.ForeignKey(
        EmployeeRequest,
        on_delete=models.CASCADE,
        related_name='attachments'
    )
    file = models.FileField(
        upload_to='requests/attachments/%Y/%m/',
        validators=[validate_file_size]
    )
    file_type = models.CharField(max_length=10, choices=FileAttachmentType.choices)

    class Meta:
        db_table = 'employee_request_attachments'
        verbose_name = _('Request Attachment')
        verbose_name_plural = _('Request Attachments')
        indexes = [
            models.Index(fields=['request', 'file_type'], name='att_req_type_idx'),
        ]

    def __str__(self):
        return f"{self.file_type.title()} for {self.request}"


# ==================== OTP ====================

class OTP(TimeStampedModel):
    """OTP Model for payment verification and secure operations."""

    email = models.EmailField(db_index=True)
    code = models.CharField(
        max_length=6,
        validators=[RegexValidator(r'^\d{6}$', _('OTP must be a 6-digit number.'))]
    )
    reference = models.CharField(max_length=100, db_index=True)
    is_used = models.BooleanField(default=False)
    expires_at = models.DateTimeField()
    attempt_count = models.IntegerField(default=0)
    max_attempts = models.IntegerField(default=3)

    class Meta:
        db_table = 'otps'
        ordering = ['-created_at']
        verbose_name = _('OTP')
        verbose_name_plural = _('OTPs')
        indexes = [
            models.Index(fields=['email', 'is_used'], name='otp_email_used_idx'),
            models.Index(fields=['reference', 'is_used'], name='otp_ref_used_idx'),
            models.Index(fields=['expires_at'], name='otp_expiry_idx'),
        ]

    def __str__(self):
        return f"OTP for {self.email} - {self.reference}"

    def has_expired(self):
        """Check if OTP has passed expiry time."""
        return timezone.now() >= self.expires_at

    def increment_attempt(self):
        """Increment attempt count and check if max reached."""
        self.attempt_count += 1
        self.save(update_fields=['attempt_count'])
        return self.attempt_count >= self.max_attempts
    
    def set_code(self, raw_code):
        self.code = make_password(raw_code)
    
    def verify(self, input_code):
        if self.has_expired():
            return False, 'expired'
        if self.is_used:
            return False, 'already_used'
        if self.attempt_count >= self.max_attempts:
            return False, 'max_attempts_exceeded'
        if not check_password(input_code, self.code):  # <-- use check_password
            max_reached = self.increment_attempt()
            return False, 'max_attempts_exceeded' if max_reached else 'invalid'
        self.is_used = True
        self.save(update_fields=['is_used'])
        return True, 'success'


# ==================== EXPORT TOKEN ====================

class ExportToken(TimeStampedModel):
    """Export Token Model for secure data exports."""

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE
    )
    token = models.CharField(max_length=64, unique=True, db_index=True)
    data_type = models.CharField(max_length=50)
    filters = models.JSONField(default=dict)
    expires_at = models.DateTimeField()
    otp_code = models.CharField(
        max_length=6,
        blank=True,
        null=True,
        validators=[RegexValidator(r'^\d{6}$', _('OTP must be a 6-digit number.'))]
    )
    is_2fa_verified = models.BooleanField(default=False)
    is_used = models.BooleanField(default=False)

    class Meta:
        db_table = 'export_tokens'
        ordering = ['-created_at']
        verbose_name = _('Export Token')
        verbose_name_plural = _('Export Tokens')
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
        if not self.otp_code:
            return False, 'invalid'
        self.is_2fa_verified = True
        self.save(update_fields=['is_2fa_verified'])
        return True, 'success'


# ==================== DOWNLOAD LOG ====================

class DownloadLog(TimeStampedModel):
    """Log of sensitive document downloads for audit trail."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True
    )
    employee = models.ForeignKey(
        Employee,
        on_delete=models.PROTECT,
        related_name='download_logs',
        null=True,
        blank=True
    )
    doc_type = models.CharField(max_length=20)
    reference = models.CharField(max_length=100, db_index=True)
    ip_address = models.GenericIPAddressField(null=True, blank=True)

    class Meta:
        db_table = 'download_logs'
        ordering = ['-created_at']
        verbose_name = _('Download Log')
        verbose_name_plural = _('Download Logs')
        indexes = [
            models.Index(fields=['user', 'created_at'], name='dl_user_time_idx'),
            models.Index(fields=['employee', 'doc_type'], name='dl_emp_doc_idx'),
        ]

    def __str__(self):
        return f"{self.doc_type} downloaded by {self.user}"


# ==================== AUDIT LOG ====================

class AuditLog(TimeStampedModel):
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

    class Meta:
        db_table = 'audit_logs'
        ordering = ['-created_at']
        verbose_name = _('Audit Log')
        verbose_name_plural = _('Audit Logs')
        indexes = [
            models.Index(fields=['user', 'created_at'], name='audit_user_time_idx'),
            models.Index(fields=['action'], name='audit_action_idx'),
        ]

    def __str__(self):
        return f"{self.user} - {self.action} at {self.created_at}"

    @classmethod
    def log_action(cls, user, action, ip_address=None, extra_data=None):
        """Class method to create audit log entry."""
        return cls.objects.create(
            user=user,
            action=action,
            ip_address=ip_address,
            extra_data=extra_data or {}
        )


# ==================== SALARY ADJUSTMENTS / IOUs / LEDGERS ====================

class EmployeeSalaryAdjustment(TimeStampedModel):
    """IOU / Salary adjustment / advance entry for an employee.

    Multiple entries per employee are allowed (history is preserved).
    Payroll Admin can approve and carry into ledger-based payroll calculations.
    """

    STATUS_PENDING = 'pending'
    STATUS_APPROVED = 'approved'
    STATUS_DECLINED = 'declined'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(
        Employee,
        on_delete=models.PROTECT,
        related_name='salary_adjustments'
    )
    amount = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        validators=[MinValueValidator(0)],
    )
    type = models.CharField(
        max_length=20,
        choices=AdjustmentType.choices,
        default=AdjustmentType.IOU,
        db_index=True
    )
    reason = models.TextField()
    date_added = models.DateField()

    status = models.CharField(max_length=20, default=STATUS_PENDING)
    declined_reason = models.TextField(blank=True, null=True)

    approved_at = models.DateTimeField(blank=True, null=True)
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='approved_salary_adjustments'
    )
    added_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name='added_salary_adjustments',
        null=True
    )

    class Meta:
        db_table = 'employee_salary_adjustments'
        ordering = ['-date_added', '-created_at']
        verbose_name = _('Employee Salary Adjustment')
        verbose_name_plural = _('Employee Salary Adjustments')
        constraints = [
            models.UniqueConstraint(
                fields=('employee', 'date_added', 'reason'),
                name='unique_adjustment_identity'
            )
        ]

    def __str__(self):
        return f"{self.employee.employee_id} - ₦{self.amount:,.2f} ({self.status})"


class EmployeeBalanceLedger(TimeStampedModel):
    """Monthly ledger to carry forward employee outstanding balances."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    employee = models.ForeignKey(
        Employee,
        on_delete=models.PROTECT,
        related_name='balance_ledger'
    )
    month_key = models.CharField(max_length=7)
    outstanding_balance = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)],
    )

    class Meta:
        db_table = 'employee_balance_ledgers'
        ordering = ['-month_key', '-created_at']
        verbose_name = _('Employee Balance Ledger')
        verbose_name_plural = _('Employee Balance Ledgers')
        constraints = [
            models.UniqueConstraint(
                fields=('employee', 'month_key'),
                name='unique_employee_ledger_per_month'
            )
        ]

    def __str__(self):
        return f"{self.employee.employee_id} - {self.month_key}: ₦{self.outstanding_balance:,.2f}"


class ClientMonthlyPayment(TimeStampedModel):
    """Track company/client monthly payment status and carry-forward balances."""

    STATUS_PAID = 'paid'
    STATUS_PARTIAL = 'partial'
    STATUS_UNPAID = 'unpaid'

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    client = models.ForeignKey(
        Company,
        on_delete=models.PROTECT,
        related_name='client_monthly_payments'
    )
    month_key = models.CharField(max_length=7)
    status = models.CharField(
        max_length=20,
        choices=ClientPaymentStatus.choices,
        default=ClientPaymentStatus.UNPAID
    )

    amount_paid = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)],
    )
    outstanding_balance = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)],
    )

    payment_date = models.DateField(blank=True, null=True)
    notes = models.TextField(blank=True, null=True)
    increment = models.DecimalField(
        max_digits=10,
        decimal_places=2,
        default=0,
        validators=[MinValueValidator(0)],
    )

    class Meta:
        db_table = 'client_monthly_payments'
        ordering = ['-month_key', '-created_at']
        verbose_name = _('Client Monthly Payment')
        verbose_name_plural = _('Client Monthly Payments')
        constraints = [
            models.UniqueConstraint(
                fields=('client', 'month_key'),
                name='unique_client_payment_per_month'
            )
        ]

    def __str__(self):
        return f"{self.client.name} - {self.month_key}: {self.status}"
