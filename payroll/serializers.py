import logging
from decimal import Decimal

from rest_framework import serializers
from .models import (
    Employee, Attendance, Deduction, Payment, Company, 
    SackedEmployee, Notification, OTP, ExportToken, EmployeeRequest, EmployeeRequestAttachment,
    EmployeeSalaryAdjustment, EmployeeBalanceLedger, ClientMonthlyPayment
)

DEFAULT_SHARED_EMAIL = 'fotasco@gmail.com'


def _is_default_shared_email(value):
    return str(value or '').strip().lower() == DEFAULT_SHARED_EMAIL


from .services import compute_total_salary_payable

from django.contrib.auth import get_user_model
import base64
from django.core.files.base import ContentFile
from .image_utils import compress_and_validate_image
from django.utils import timezone
from django.db import transaction, IntegrityError
from django.db.models import Sum
import re
from .paystack import PaystackAPI

User = get_user_model()
logger = logging.getLogger(__name__)


def _name_tokens(value):
    return {
        token for token in re.sub(r'[^a-zA-Z\s]', ' ', value or '').lower().split()
        if len(token) > 1
    }


def _verify_employee_bank_account(full_name, account_number, bank_code, submitted_holder=None):
    result = PaystackAPI().verify_account(account_number, bank_code)
    verified_name = (result.get('data') or {}).get('account_name') if isinstance(result.get('data'), dict) else None

    # PRODUCTION: If Paystack is rate-limiting, don't block saving the employee.
    # Fallback to the submitted holder name so the user can proceed.
    if result.get('error_code') == 'rate_limited':
        return submitted_holder

    if not result.get('status') or not verified_name:
        raise serializers.ValidationError({
            'account_holder': result.get('message') or 'Bank account could not be verified with Paystack.'
        })

    employee_tokens = _name_tokens(full_name)
    account_tokens = _name_tokens(verified_name)

    if len(employee_tokens) < 2:
        raise serializers.ValidationError({
            'name': 'Enter at least two names. One name cannot create an employee account.'
        })

    # Employee name must match (at least) the verified holder.
    if len(employee_tokens.intersection(account_tokens)) < 2:
        raise serializers.ValidationError({
            'account_holder': f'Employee name must match verified account holder name: {verified_name}'
        })

    # Always store the Paystack-verified account holder name.
    # If the client submitted a holder name, we keep mismatch protection
    # to prevent accidental bypasses, but we never trust it for storage.
    if submitted_holder is not None and submitted_holder != '':
        if _name_tokens(submitted_holder) != account_tokens:
            raise serializers.ValidationError({
                'account_holder': 'Account holder name must match Paystack verification.'
            })

    return verified_name



class UserSerializer(serializers.ModelSerializer):
    employee_id = serializers.SerializerMethodField(read_only=True)
    name = serializers.SerializerMethodField(read_only=True)

    class Meta:
        model = User
        fields = [
            'id', 'username', 'email', 'role', 'phone', 'employee_id', 'name',
            'is_company_admin', 'is_notification_admin', 'is_payment_admin',
            'is_deduction_admin', 'is_employee_admin', 'is_request_admin', 'is_hr_admin',
            'first_name', 'last_name',
            'is_superuser', 'is_staff', 'is_active',
            'date_joined', 'last_login', 'groups', 'user_permissions',
        ]
        read_only_fields = ['id']

    def get_employee_id(self, obj):
        if hasattr(obj, 'employee_profile'):
            return obj.employee_profile.employee_id
        return None

    def get_name(self, obj):
        if hasattr(obj, 'employee_profile') and obj.employee_profile.name:
            return obj.employee_profile.name
        full_name = f"{obj.first_name} {obj.last_name}".strip()
        return full_name or obj.username

    def validate_email(self, value):
        if not value or not value.strip():
            raise serializers.ValidationError("email is required")
        value = value.lower()
        if _is_default_shared_email(value):
            return value
        if User.objects.filter(email=value).exclude(
            id=self.instance.id if self.instance else None
        ).exists():
            raise serializers.ValidationError("Email already exists")
        return value

    def validate_phone(self, value):
        if not re.match(r'^[\d\s\-\+\(\)]{10,20}$', value):
            raise serializers.ValidationError("Invalid phone format")
        return value

    def validate_role(self, value):
        request = self.context.get("request")
        if not request:
            return value
        if request.user.is_superuser:
            return value
        if value in ['admin', 'is_superuser']:
            raise serializers.ValidationError("Not allowed to assign this role")
        return value


class EmployeeSerializer(serializers.ModelSerializer):
    applied_deductions = serializers.SerializerMethodField(read_only=True)
    net_salary = serializers.SerializerMethodField(read_only=True)
    salary_breakdown = serializers.SerializerMethodField(read_only=True)
    user = serializers.PrimaryKeyRelatedField(
        queryset=User.objects.all(), required=False, allow_null=True, write_only=True
    )
    # REMOVED: user field that was causing serialization issues
    # The user relationship is handled internally, not exposed in API

    class Meta:
        model = Employee
        fields = [
            'id', 'user', 'employee_id', 'name', 'type', 'location',
            'salary', 'phone', 'email', 'bank_name', 'bank_code', 'account_number',
            'account_holder', 'status', 'join_date', 'id_sequence', 'applied_deductions',
            'net_salary', 'salary_breakdown', 'created_at', 'updated_at'
        ]
        read_only_fields = ['employee_id', 'id_sequence', 'created_at', 'updated_at', 'id', 'join_date']

    def get_applied_deductions(self, obj):
        month_key = timezone.now().strftime('%Y-%m')
        year, month = map(int, month_key.split('-'))
        total = obj.deductions.filter(
            status='applied',
            date__year=year,
            date__month=month,
        ).aggregate(total=Sum('amount'))['total'] or 0
        return float(total)

    def get_net_salary(self, obj):
        month_key = timezone.now().strftime('%Y-%m')
        salary_data = compute_total_salary_payable(obj, month_key)
        return float(salary_data['total_payable'])

    def get_salary_breakdown(self, obj):
        month_key = timezone.now().strftime('%Y-%m')
        salary_data = compute_total_salary_payable(obj, month_key)
        return {k: float(v) if isinstance(v, Decimal) else v for k, v in salary_data.items()}

    def validate_name(self, value):
        if not value or not value.strip():
            raise serializers.ValidationError("Employee name cannot be empty")
        if len(_name_tokens(value)) < 2:
            raise serializers.ValidationError("Enter at least two names. One name cannot create an employee account.")
        return value

    def validate_salary(self, value):
        if value < 0:
            raise serializers.ValidationError("Salary cannot be negative")
        return value

    def validate_account_number(self, value):
        if not value:
            return value
        if not value.isdigit():
            raise serializers.ValidationError("Account number must contain only digits")
        
        # Check for duplicates excluding current instance (for updates)
        queryset = Employee.objects.filter(account_number=value, status__in=['active', 'pending'])
        if self.instance:
            queryset = queryset.exclude(pk=self.instance.pk)
        if queryset.exists():
            raise serializers.ValidationError("This account number is already registered")
        
        return value
    
    def validate_email(self, value):
        if not value:
            return value
        value = value.strip().lower()
        if _is_default_shared_email(value):
            return value
        # Check for duplicates
        queryset = Employee.objects.filter(email__iexact=value, status__in=['active', 'terminated'])
        if self.instance:
            queryset = queryset.exclude(pk=self.instance.pk)
        if queryset.exists():
            raise serializers.ValidationError("This email is already registered")
        return value

    def validate(self, attrs):
        bank_fields = ['bank_name', 'bank_code', 'account_number', 'account_holder']
        if any(attrs.get(field) for field in bank_fields):
            bank_values = {
                field: attrs.get(field) or (getattr(self.instance, field, None) if self.instance else None)
                for field in bank_fields
            }
            missing = [field for field in bank_fields if not bank_values.get(field)]
            if missing:
                raise serializers.ValidationError({
                    field: 'This field is required for bank verification.' for field in missing
                })
            attrs['account_holder'] = _verify_employee_bank_account(
                attrs.get('name') or (self.instance.name if self.instance else ''),
                bank_values.get('account_number'),
                bank_values.get('bank_code'),
                bank_values.get('account_holder')
            )
        return attrs

    def create(self, validated_data):
        provided_user = validated_data.pop('user', None)
        if not validated_data.get('join_date'):
            validated_data['join_date'] = timezone.now().date()

        if provided_user:
            return Employee.objects.create(user=provided_user, **validated_data)

        username_base = (
            validated_data.get('email', '').split('@')[0]
            or validated_data.get('employee_id')
            or validated_data.get('name', 'employee').lower().replace(' ', '_')
        )
        username = username_base
        counter = 1
        while User.objects.filter(username=username).exists():
            counter += 1
            username = f"{username_base}{counter}"

        with transaction.atomic():
            employee_type = validated_data.get('type') or 'staff'
            user = User(
                username=username,
                email=validated_data.get('email') or '',
                role=employee_type if employee_type in ['staff', 'guard'] else 'staff',
                phone=validated_data.get('phone') or '',
            )
            user.set_unusable_password()
            user.save()
            try:
                # The employee_id is generatd in the model's save method
                employee = Employee.objects.create(user=user, **validated_data)
            except IntegrityError as e:
                # Catch potential unique constraint violations, e.g., on employee_id if generation fails
                # or if another unique field (like email/account_number) somehow slipped through serializer validation
                if 'employee_id' in str(e):
                    raise serializers.ValidationError({"employee_id": "A unique employee ID could not be generated. Please try again."})
                elif 'account_number' in str(e):
                    raise serializers.ValidationError({"account_number": "This account number is already registered."})
                elif 'email' in str(e):
                    raise serializers.ValidationError({"email": "This email is already registered for another employee."})
                else:
                    logger.error(f"Unhandled IntegrityError during employee creation: {e}")
                    raise serializers.ValidationError({"detail": "A database integrity error occurred. Please contact support."})
            return employee

class SelfSignupSerializer(serializers.ModelSerializer):
    username = serializers.CharField(write_only=True)
    password = serializers.CharField(write_only=True, min_length=8)
    full_name = serializers.CharField(write_only=True)

    class Meta:
        model = Employee
        fields = [
            'username', 'password', 'full_name', 'email', 
            'type', 'location', 'salary', 'phone', 
            'bank_name', 'account_number', 'account_holder'
        ]

    def validate_username(self, value):
        if User.objects.filter(username=value).exists():
            raise serializers.ValidationError("Username already taken.")
        return value

    def create(self, validated_data):
        username = validated_data.pop('username')
        password = validated_data.pop('password')
        full_name = validated_data.pop('full_name')
        
        with transaction.atomic():
            user = User.objects.create_user(
                username=username,
                password=password,
                email=validated_data.get('email', '').lower(),
                role=validated_data.get('type', 'staff'),
                is_active=False  # Pending admin approval
            )
            
            employee = Employee.objects.create(
                user=user,
                name=full_name,
                is_self_registered=True,
                status='pending',
                join_date=timezone.now().date(),
                **validated_data
            )
        return employee


class AttendanceSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source='employee.name', read_only=True)
    employee_id = serializers.CharField(source='employee.employee_id', read_only=True)
    clock_in_display = serializers.SerializerMethodField()
    clock_out_display = serializers.SerializerMethodField()
    clock_in_photo_base64 = serializers.CharField(write_only=True, required=False, allow_blank=True)
    clock_out_photo_base64 = serializers.CharField(write_only=True, required=False, allow_blank=True)
    
    class Meta:
        model = Attendance
        fields = [
            'id', 'employee', 'employee_id', 'employee_name', 'date', 'status',
            'clock_in', 'clock_out', 'clock_in_timestamp', 'clock_out_timestamp', 'clock_in_photo', 'clock_out_photo',
            'clock_in_display', 'clock_out_display', 'clock_in_photo_base64', 'clock_out_photo_base64',
            'clock_method', 'leave_start', 'leave_end', 'created_at', 'updated_at'
        ]
        read_only_fields = [
            'id', 'created_at', 'updated_at',
            'clock_in_timestamp', 'clock_out_timestamp', 
            'clock_in_photo', 'clock_out_photo', 'clock_in_display', 'clock_out_display', 'status', 'clock_in_photo_base64', 'clock_out_photo_base64'
        ]

    def get_clock_in_display(self, obj):
        return obj.clock_in_timestamp.strftime('%Y-%m-%d %H:%M:%S') if obj.clock_in_timestamp else None

    def get_clock_out_display(self, obj):
        return obj.clock_out_timestamp.strftime('%Y-%m-%d %H:%M:%S') if obj.clock_out_timestamp else None

    def validate(self, attrs):
        employee = attrs.get('employee')
        date = attrs.get('date')
        if not employee:
            raise serializers.ValidationError("Employee is required")
        if not date:
            raise serializers.ValidationError("Date is required")
        if self.instance is None and Attendance.objects.filter(employee=employee, date=date).exists():
            raise serializers.ValidationError("Attendance already exists for this employee on this date")
        for field_value, field_name in [
            (attrs.get('clock_in_photo_base64'), "Clock-in photo"),
            (attrs.get('clock_out_photo_base64'), "Clock-out photo"),
        ]:
            if field_value:
                try:
                    base64.b64decode(field_value, validate=True)
                except Exception:
                    raise serializers.ValidationError(f"{field_name} must be valid base64")
        if attrs.get('clock_out') and attrs.get('clock_in'):
            if attrs['clock_out'] < attrs['clock_in']:
                raise serializers.ValidationError("Clock-out cannot be before clock-in")
        return attrs

    def update(self, instance, validated_data):
        if instance.clock_in and validated_data.get('clock_in'):
            raise serializers.ValidationError("Already clocked in")
        if instance.clock_out and validated_data.get('clock_out'):
            raise serializers.ValidationError("Already clocked out")
        clock_in_b64 = validated_data.pop('clock_in_photo_base64', None)
        clock_out_b64 = validated_data.pop('clock_out_photo_base64', None)
        if validated_data.get('clock_in') and not instance.clock_in_timestamp:
            validated_data['clock_in_timestamp'] = timezone.now()
        if validated_data.get('clock_out') and not instance.clock_out_timestamp:
            validated_data['clock_out_timestamp'] = timezone.now()
        with transaction.atomic():
            for attr, value in validated_data.items():
                setattr(instance, attr, value)
            if clock_in_b64:
                instance.clock_in_photo = compress_and_validate_image(clock_in_b64)
            if clock_out_b64:
                instance.clock_out_photo = compress_and_validate_image(clock_out_b64)
            instance.save()
        return instance

    def create(self, validated_data):
        clock_in_b64 = validated_data.pop('clock_in_photo_base64', None)
        clock_out_b64 = validated_data.pop('clock_out_photo_base64', None)
        if validated_data.get('clock_in'):
            validated_data['clock_in_timestamp'] = timezone.now()
        if validated_data.get('clock_out'):
            validated_data['clock_out_timestamp'] = timezone.now()
        clock_in_img = compress_and_validate_image(clock_in_b64) if clock_in_b64 else None
        clock_out_img = compress_and_validate_image(clock_out_b64) if clock_out_b64 else None
        with transaction.atomic():
            attendance = Attendance.objects.create(**validated_data)
            if clock_in_img:
                attendance.clock_in_photo = clock_in_img
            if clock_out_img:
                attendance.clock_out_photo = clock_out_img
            attendance.save()
        return attendance


class DeductionSerializer(serializers.ModelSerializer):
    employee_id = serializers.CharField(source='employee.employee_id', read_only=True)
    employee_name = serializers.CharField(source='employee.name', read_only=True)
    display_status = serializers.SerializerMethodField()
    
    class Meta:
        model = Deduction
        fields = ['id', 'employee', 'employee_id', 'employee_name', 'amount', 'reason', 'status', 'display_status', 'date', 'created_at']
        read_only_fields = ['id', 'created_at']
        extra_kwargs = {
            'employee': {'required': True},
            'amount': {'required': True},
            'reason': {'required': True},
            'status': {'required': False},
            'date': {'required': False},
        }

    def validate_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError("Deduction must be greater than 0")
        return value

    def get_display_status(self, obj):
        if obj.status == 'applied':
            return 'settled'
        if obj.status in ['pending', 'pending_hr']:
            return 'pending'
        return obj.status
    
    def validate(self, attrs):
        if attrs['amount'] > attrs['employee'].salary:
            raise serializers.ValidationError("Deduction amount cannot exceed employee's salary.")
        if not attrs.get('reason') or not attrs['reason'].strip():
            raise serializers.ValidationError({"reason": "A valid deduction reason is required."})
        return attrs


class PaymentSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source='employee.name', read_only=True)
    employee_id = serializers.CharField(source='employee.employee_id', read_only=True)
    bank_account = serializers.SerializerMethodField()
    paystack_otp_required = serializers.SerializerMethodField()

    class Meta:
        model = Payment
        fields = [
            'id',
            'employee',
            'employee_id',
            'employee_name',
            'payment_month',
            'base_salary',
            'total_deductions',
            'iou_amount',
            'bonus_amount',
            'net_amount',
            'is_partial',
            'amount_paid',
            'remaining_balance',
            'previous_balance',
            'partial_reason',
            'payment_method',
            'transaction_reference',
            'paystack_reference',
            'paystack_transfer_code',
            'paystack_otp_required',
            'status',
            'payment_date',
            'processed_by',
            'bank_account',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['created_at', 'updated_at', 'transaction_reference']


    def get_bank_account(self, obj):
        if not obj.employee:
            return "-"
        return f"{obj.employee.bank_name} - {obj.employee.account_number}"

    def get_paystack_otp_required(self, obj):
        return obj.status == 'pending_paystack_otp'

    def validate_net_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError("Payment amount must be greater than 0")
        return value

    def validate(self, attrs):
        if not attrs.get('employee'):
            raise serializers.ValidationError("Employee is required")
        return attrs


class CompanySerializer(serializers.ModelSerializer):
    assigned_guards_details = serializers.SerializerMethodField()
    profit_calculated = serializers.SerializerMethodField()
    
    class Meta:
        model = Company
        fields = [
            'id', 'name', 'location', 'email', 'phone', 'status', 'termination_reason', 
            'contract_start', 'contract_end', 'guards_count', 'payment_to_us', 'payment_per_guard', 
            'total_payment_to_guards', 'profit',
            'assigned_guards', 'assigned_guards_details', 'profit_calculated',
            'created_at', 'updated_at'
        ]
        read_only_fields = [
            'total_payment_to_guards', 'profit', 'created_at', 'updated_at',
            'profit_calculated'
        ]
        
        extra_kwargs = {
            'name': {'required': True},
            'location': {'required': True},
            'guards_count': {'required': True},
            'payment_to_us': {'required': True},
            'payment_per_guard': {'required': True},
            'assigned_guards': {'required': False},
        }

    def get_assigned_guards_details(self, obj):
        """Return detailed info about assigned guards"""
        return [
            {
                'id': str(g.id),
                'name': g.name,
                'employee_id': g.employee_id
            } for g in obj.assigned_guards.all()
        ]
    
    def get_profit_calculated(self, obj):
        """Return calculated profit"""
        return float(obj.profit) if obj.profit else 0

    def validate_name(self, value):
        if not value or not value.strip():
            raise serializers.ValidationError("Company name cannot be empty")
        return value


class SackedEmployeeSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source='employee.name', read_only=True)
    employee_id = serializers.CharField(source='employee.employee_id', read_only=True)
    employee_type = serializers.CharField(source='employee.type', read_only=True)
    terminated_by_name = serializers.SerializerMethodField()

    def get_terminated_by_name(self, obj):
        if obj.terminated_by:
            user = obj.terminated_by
            # Preferred: Full Name, Fallback: Username
            display_name = user.get_full_name().strip() or user.username
            
            # Attempt to retrieve Employee ID (from User model or related Employee Profile)
            emp_id = getattr(user, 'employee_id', None)
            if not emp_id and hasattr(user, 'employee_profile'):
                emp_id = user.employee_profile.employee_id
            
            if emp_id:
                return f"{display_name} ({emp_id})"
            return display_name
        return '-'

    class Meta:
        model = SackedEmployee
        fields = '__all__'
        read_only_fields = ['created_at']


class NotificationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Notification
        fields = '__all__'
        read_only_fields = ['created_at']


class OTPSerializer(serializers.ModelSerializer):
    class Meta:
        model = OTP
        fields = ['email', 'code', 'reference', 'expires_at']
        read_only_fields = ['code', 'expires_at']

    def validate_email(self, value):
        if not value or not value.strip():
            raise serializers.ValidationError("Email is required")
        return value.lower()

    def validate(self, attrs):
        if self.instance and self.instance.expires_at < timezone.now():
            raise serializers.ValidationError("OTP has expired")
        return attrs


class PaystackResolveAccountSerializer(serializers.Serializer):
    account_number = serializers.RegexField(
        regex=r'^\d{10}$',
        error_messages={'invalid': 'A valid 10-digit account number is required.'},
    )
    bank_code = serializers.RegexField(
        regex=r'^\d{3,6}$',
        error_messages={'invalid': 'A valid Paystack bank code is required.'},
    )


class ExportTokenSerializer(serializers.ModelSerializer):
    class Meta:
        model = ExportToken
        fields = ['token', 'data_type', 'filters', 'expires_at']
        read_only_fields = ['token', 'expires_at']

    def validate_data_type(self, value):
        if value not in ['attendance', 'payment', 'deduction', 'employees', 'payslip']:
            raise serializers.ValidationError("Invalid data type")
        return value

class EmployeeRequestAttachmentSerializer(serializers.ModelSerializer):
    class Meta:
        model = EmployeeRequestAttachment
        fields = '__all__'

class EmployeeRequestSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source='employee.name', read_only=True)
    employee_id = serializers.CharField(source='employee.employee_id', read_only=True)
    action_by_name = serializers.CharField(source='action_by.username', read_only=True)
    attachments = EmployeeRequestAttachmentSerializer(many=True, read_only=True)

    class Meta:
        model = EmployeeRequest
        fields = '__all__'
        read_only_fields = ['id', 'employee', 'status', 'decline_reason', 'action_by', 'created_at', 'updated_at', 'attachments']


class EmployeeSalaryAdjustmentSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source='employee.name', read_only=True)
    employee_id = serializers.CharField(source='employee.employee_id', read_only=True)
    added_by_name = serializers.CharField(source='added_by.username', read_only=True)
    approved_by_name = serializers.CharField(source='approved_by.username', read_only=True)

    class Meta:
        model = EmployeeSalaryAdjustment
        fields = [
            'id',
            'employee',
            'employee_id',
            'employee_name',
            'type',
            'amount',
            'reason',
            'date_added',
            'status',
            'declined_reason',
            'approved_at',
            'approved_by',
            'approved_by_name',
            'added_by',
            'added_by_name',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'status', 'declined_reason', 'approved_at', 'approved_by', 'added_by', 'created_at', 'updated_at']

    def validate_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError('Amount must be greater than 0')
        return value

    def validate(self, attrs):
        employee = attrs.get('employee')
        if not employee:
            raise serializers.ValidationError({'employee': 'Employee is required'})
        return attrs


class EmployeeBalanceLedgerSerializer(serializers.ModelSerializer):
    employee_name = serializers.CharField(source='employee.name', read_only=True)
    employee_id = serializers.CharField(source='employee.employee_id', read_only=True)

    class Meta:
        model = EmployeeBalanceLedger
        fields = ['id', 'employee', 'employee_id', 'employee_name', 'month_key', 'outstanding_balance', 'created_at', 'updated_at']
        read_only_fields = ['id', 'employee', 'outstanding_balance', 'created_at', 'updated_at']


class ClientMonthlyPaymentSerializer(serializers.ModelSerializer):
    client_name = serializers.CharField(source='client.name', read_only=True)
    class Meta:
        model = ClientMonthlyPayment
        fields = [
            'id',
            'client',
            'client_name',
            'month_key',
            'status',
            'amount_paid',
            'outstanding_balance',
            'payment_date',
            'notes',
            'increment',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'outstanding_balance', 'created_at', 'updated_at']

    def validate_amount_paid(self, value):
        if value < 0:
            raise serializers.ValidationError('Amount paid cannot be negative')
        return value
