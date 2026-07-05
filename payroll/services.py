import logging
import hashlib
from decimal import Decimal, InvalidOperation
import uuid
import calendar
from datetime import date
from django.db import transaction
from django.db.models import Sum
from django.core.cache import cache
from django.utils import timezone
from .models import (
    Payment,
    Employee,
    Deduction,
    DeductionStatus,
    Notification,
    AuditLog,
    EmployeeBalanceLedger,
    EmployeeSalaryAdjustment,
    AdjustmentType,
)
from .paystack import PaystackAPI, NIGERIAN_BANKS, is_invalid_recipient_error

# l
logger = logging.getLogger(__name__)


def paystack_recipient_fingerprint_key(employee):
    return f"paystack:recipient:fingerprint:{employee.id}"


def paystack_recipient_fingerprint(bank_code, account_number):
    value = f"{str(bank_code or '').strip()}:{str(account_number or '').strip()}"
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def is_valid_paystack_bank_code(bank_code):
    bank_code = str(bank_code or '').strip()
    return bank_code in NIGERIAN_BANKS


def paystack_bank_name(bank_code):
    return NIGERIAN_BANKS.get(str(bank_code or '').strip(), '')


def paystack_bank_code_for_name(bank_name):
    normalized_name = (bank_name or '').strip().lower()
    if not normalized_name:
        return None
    for code, name in NIGERIAN_BANKS.items():
        target_name = (name or '').strip().lower()
        if normalized_name == target_name or normalized_name in target_name or target_name in normalized_name:
            return code
    return None


def employee_recipient_matches_current_bank_details(employee, bank_code=None):
    bank_code = str(bank_code or getattr(employee, 'bank_code', '') or '').strip()
    account_number = str(getattr(employee, 'account_number', '') or '').strip()
    expected = paystack_recipient_fingerprint(bank_code, account_number)
    return cache.get(paystack_recipient_fingerprint_key(employee)) == expected


def remember_employee_recipient_bank_details(employee, bank_code=None):
    bank_code = str(bank_code or getattr(employee, 'bank_code', '') or '').strip()
    account_number = str(getattr(employee, 'account_number', '') or '').strip()
    cache.set(
        paystack_recipient_fingerprint_key(employee),
        paystack_recipient_fingerprint(bank_code, account_number),
        None,
    )

def get_employee_bank_code(employee):
    """Return a valid Paystack bank_code for an employee.

    Priority:
      1) employee.bank_code if it is non-empty and matches known Paystack bank codes
      2) derive from employee.bank_name
    """

    stored_code = (getattr(employee, 'bank_code', None) or '').strip()
    derived_code = paystack_bank_code_for_name(getattr(employee, 'bank_name', ''))

    if derived_code:
        if stored_code != derived_code:
            logger.info(
                "Refreshing employee Paystack bank_code from bank_name employee_id=%s bank_name=%s old_bank_code=%s new_bank_code=%s",
                getattr(employee, 'id', None),
                getattr(employee, 'bank_name', ''),
                stored_code,
                derived_code,
            )
            try:
                if hasattr(employee, 'bank_code'):
                    employee.bank_code = derived_code
                    employee.save(update_fields=['bank_code'])
            except Exception:
                pass
        return derived_code

    if stored_code and stored_code in NIGERIAN_BANKS:
        return stored_code

    if stored_code:
        logger.warning(
            "Rejected invalid stored bank_code employee_id=%s bank_name=%s bank_code=%s",
            getattr(employee, 'id', None),
            getattr(employee, 'bank_name', ''),
            stored_code,
        )

    return None



ACTIVE_DEDUCTION_STATUSES = [
    # Only deductions that have been approved/applied or are partially recovered
    # should reduce the employee's salary. Pending deductions are not yet active.
    DeductionStatus.PARTIAL,
    DeductionStatus.APPLIED,
]


def _month_end_date(month_key):
    year, month = map(int, month_key.split('-'))
    return date(year, month, calendar.monthrange(year, month)[1])


def _next_month_key(month_key):
    year, month = map(int, month_key.split('-'))
    if month == 12:
        return f"{year + 1:04d}-01"
    return f"{year:04d}-{month + 1:02d}"


def applied_deductions_for_month(employee, month_key):
    """Return active deductions whose remaining balance should affect this payroll month."""
    year, month = map(int, month_key.split('-'))
    month_end = _month_end_date(month_key)
    return Deduction.objects.filter(
        employee=employee,
        status__in=ACTIVE_DEDUCTION_STATUSES,
        date__lte=month_end,
    ).exclude(
        status=DeductionStatus.APPLIED,
        date__lt=date(year, month, 1),
    )


def active_deduction_balance_for_month(employee, month_key):
    total = Decimal('0')
    for deduction in applied_deductions_for_month(employee, month_key):
        remaining = deduction.remaining_balance
        if remaining in [None, 0] and deduction.amount_paid == 0:
            remaining = deduction.amount
        total += Decimal(str(remaining or 0))
    return total


def _audit_deduction_payment(user, action, deduction, payment, amount):
    if not user:
        return
    AuditLog.objects.create(
        user=user,
        action=action,
        extra_data={
            'deduction_id': str(deduction.id),
            'payment_id': str(payment.id),
            'employee_id': str(deduction.employee_id),
            'amount': str(amount),
            'remaining_balance': str(deduction.remaining_balance),
        },
    )


def settle_deductions_for_payment(payment):
    """Apply the deduction portion of a completed payment to active deduction balances."""
    if not payment or payment.status != 'completed':
        return []
    if not payment.total_deductions or payment.total_deductions <= 0:
        return []

    already_processed = AuditLog.objects.filter(
        action__in=['Deduction partially paid', 'Deduction settled'],
        extra_data__payment_id=str(payment.id),
    ).exists()
    if already_processed:
        return []

    deduction_pool = Decimal(str(payment.total_deductions or 0))
    if payment.is_partial and payment.amount_paid and payment.net_amount and payment.net_amount > 0:
        ratio = Decimal(str(payment.amount_paid)) / Decimal(str(payment.net_amount))
        deduction_pool = (deduction_pool * ratio).quantize(Decimal('0.01'))

    if deduction_pool <= 0:
        return []

    updates = []
    with transaction.atomic():
        deductions = Deduction.objects.select_for_update().filter(
            employee=payment.employee,
            status__in=ACTIVE_DEDUCTION_STATUSES,
            remaining_balance__gt=0,
        ).order_by('date', 'created_at', 'id')

        for deduction in deductions:
            if deduction_pool <= 0:
                break

            amount_to_apply = min(Decimal(str(deduction.remaining_balance or 0)), deduction_pool)
            if amount_to_apply <= 0:
                continue

            deduction.amount_paid = min(
                Decimal(str(deduction.amount)),
                Decimal(str(deduction.amount_paid or 0)) + amount_to_apply,
            )
            deduction.remaining_balance = max(
                Decimal('0'),
                Decimal(str(deduction.amount)) - Decimal(str(deduction.amount_paid)),
            )

            if deduction.remaining_balance == 0:
                deduction.status = DeductionStatus.SETTLED
                deduction.settled_at = timezone.now()
                action = 'Deduction settled'
            else:
                deduction.status = DeductionStatus.PARTIAL
                action = 'Deduction partially paid'

            deduction.save(update_fields=['amount_paid', 'remaining_balance', 'status', 'settled_at', 'updated_at'])
            _audit_deduction_payment(payment.processed_by, action, deduction, payment, amount_to_apply)
            updates.append((deduction.id, action, amount_to_apply))
            deduction_pool -= amount_to_apply

    return updates


def approved_adjustment_totals_for_month(employee, month_key):
    """Calculates additive (bonuses) and subtractive (loans/ious) adjustments.

    This implementation treats adjustments as affecting the month they were added.
    """
    qs = EmployeeSalaryAdjustment.objects.filter(
        employee=employee,
        status=EmployeeSalaryAdjustment.STATUS_APPROVED,
        date_added__year=int(month_key.split('-')[0]),
        date_added__month=int(month_key.split('-')[1]),
    )
    
    try:
        additions = qs.filter(type__in=[AdjustmentType.BONUS, AdjustmentType.EXTRA_PAYMENT]).aggregate(total=Sum('amount'))['total'] or Decimal('0')
        subtractions = qs.filter(type__in=[AdjustmentType.LOAN, AdjustmentType.SALARY_ADVANCE, AdjustmentType.IOU]).aggregate(total=Sum('amount'))['total'] or Decimal('0')
    except:
        additions = Decimal('0')
        subtractions = Decimal('0')
    
    return additions, subtractions


def _monthly_salary_components(employee, month_key, previous_balance):
    base_salary = Decimal(str(employee.salary))
    other_deductions = active_deduction_balance_for_month(employee, month_key)

    try:
        year, m = map(int, month_key.split('-'))
    except Exception:
        year, m = timezone.now().year, timezone.now().month

    adj_qs = EmployeeSalaryAdjustment.objects.filter(
        employee=employee,
        status=EmployeeSalaryAdjustment.STATUS_APPROVED,
        date_added__year=year,
        date_added__month=m,
    )

    try:
        bonus = adj_qs.filter(type__in=[AdjustmentType.BONUS, AdjustmentType.EXTRA_PAYMENT]).aggregate(total=Sum('amount'))['total'] or Decimal('0')
        iou = adj_qs.filter(type__in=[AdjustmentType.IOU, AdjustmentType.LOAN, AdjustmentType.SALARY_ADVANCE]).aggregate(total=Sum('amount'))['total'] or Decimal('0')
    except Exception:
        bonus = Decimal('0')
        iou = Decimal('0')

    total_due = (base_salary + bonus + previous_balance) - (iou + other_deductions)
    if total_due < 0:
        total_due = Decimal('0')

    return {
        'base_salary': base_salary,
        'other_deductions': other_deductions,
        'bonus': bonus,
        'iou': iou,
        'total_due': total_due,
    }


def outstanding_previous_balance_for_month(employee, month_key):
    """Return the outstanding balance that should be carried into this month."""
    row = EmployeeBalanceLedger.objects.filter(
        employee=employee,
        month_key=month_key,
    ).first()
    if row:
        return row.outstanding_balance

    anchor = EmployeeBalanceLedger.objects.filter(
        employee=employee,
        month_key__lt=month_key,
    ).order_by('-month_key').first()
    if not anchor:
        return Decimal('0')

    balance = Decimal(str(anchor.outstanding_balance or 0))
    cursor = anchor.month_key
    while cursor < month_key:
        components = _monthly_salary_components(employee, cursor, balance)
        paid = Payment.objects.filter(
            employee=employee,
            payment_month=cursor,
            status='completed',
        ).aggregate(total=Sum('amount_paid'))['total'] or Decimal('0')
        balance = max(Decimal('0'), components['total_due'] - Decimal(str(paid)))
        cursor = _next_month_key(cursor)
    return balance


def compute_total_salary_payable(employee, month_key):
    """Compute detailed breakdown and net payable for the month."""
    prev_balance = outstanding_previous_balance_for_month(employee, month_key)
    components = _monthly_salary_components(employee, month_key, prev_balance)
    base_salary = components['base_salary']
    other_deductions = components['other_deductions']
    bonus = components['bonus']
    iou = components['iou']
    final_net_salary = components['total_due']

    # Sum of all 'completed' payments for this specific month
    total_paid = Payment.objects.filter(
        employee=employee,
        payment_month=month_key,
        status='completed'
    ).aggregate(total=Sum('amount_paid'))['total'] or Decimal('0')
    
    outstanding = max(0, final_net_salary - total_paid)

    return {
        'base_salary': base_salary,
        'iou_deduction': iou,
        'other_deductions': other_deductions,
        'bonus': bonus,
        'previous_balance': prev_balance,
        'final_net_salary': final_net_salary,
        'total_paid': total_paid,
        'outstanding_balance': outstanding,
        # Compatibility
        'total_deductions': other_deductions + iou,
        'total_payable': final_net_salary,
        'previous_outstanding_balance': prev_balance,
    }


class PaystackService:
    def __init__(self):
        self.paystack = PaystackAPI()

    def _validate_paystack_bank_code(self, bank_code, employee):
        bank_code_str = str(bank_code).strip()
        if not is_valid_paystack_bank_code(bank_code_str):
            raise ValueError(
                f"Invalid bank code for {employee.name}. Please select a supported Paystack bank and try again."
            )
        return bank_code_str

    def invalidate_recipient(self, employee, reason=''):
        recipient_code = getattr(employee, 'paystack_recipient_code', None)
        employee.paystack_recipient_code = None
        employee.save(update_fields=['paystack_recipient_code'])
        cache.delete_many([
            f"paystack:recipient:{employee.id}",
            f"paystack_recipient_{employee.id}",
            paystack_recipient_fingerprint_key(employee),
        ])
        logger.warning(
            "Invalidated Paystack recipient employee_id=%s recipient_code=%s reason=%s",
            employee.id,
            recipient_code,
            reason,
        )

    def get_or_create_recipient(self, employee):
        recipient_code = getattr(employee, 'paystack_recipient_code', None)
        bank_code = get_employee_bank_code(employee)

        if not bank_code:
            bank_name = (getattr(employee, 'bank_name', None) or '').strip()
            if bank_name:
                derived = get_employee_bank_code(employee)
                if derived:
                    bank_code = derived

            if not bank_code:
                raise ValueError(f"Employee {employee.name} bank code is missing or unsupported.")

        bank_code_str = self._validate_paystack_bank_code(bank_code, employee)

        if recipient_code and not employee_recipient_matches_current_bank_details(employee, bank_code_str):
            self.invalidate_recipient(employee, reason='stale_bank_details')
            recipient_code = None

        if not recipient_code:
            result = self.paystack.create_recipient(

                name=employee.name,
                account_number=employee.account_number,
                bank_code=bank_code_str,
            )
            if not result or not result.get('status'):
                raise Exception(
                    f"Failed to create recipient: {result.get('message') if result else 'Unknown error'}"
                )

            recipient_code = result.get('data', {}).get('recipient_code') or result.get('recipient_code')
            if not recipient_code:
                raise Exception("Failed to create recipient: missing recipient code")
            employee.paystack_recipient_code = recipient_code
            employee.save(update_fields=['paystack_recipient_code'])
            remember_employee_recipient_bank_details(employee, bank_code_str)
        return recipient_code


    def initiate_salary_transfer(self, employee, custom_amount=None, processed_by=None):
        with transaction.atomic():
            payment_month = timezone.now().strftime('%Y-%m')
            is_partial = False
            total_deductions = 0
            amount_paid = None

            if custom_amount:
                try:
                    amount_paid = Decimal(str(custom_amount))
                    is_partial = True
                    if amount_paid <= 0:
                        raise ValueError("Invalid custom amount")
                except (ValueError, InvalidOperation):
                    raise ValueError("Invalid custom amount")

            total_deductions = applied_deductions_for_month(
                employee, payment_month
            ).aggregate(Sum('amount'))['amount__sum'] or 0
            net_salary = employee.salary - total_deductions

            if amount_paid is not None and amount_paid >= net_salary:
                is_partial = False
            remaining_balance = max(Decimal('0'), net_salary - (amount_paid or net_salary))

            if net_salary <= 0:
                raise ValueError("Net salary is zero or negative after deductions")

            payment = Payment.objects.create(
                employee=employee,
                base_salary=employee.salary,
                total_deductions=total_deductions,
                net_amount=net_salary,
                transaction_reference=str(uuid.uuid4()),
                payment_date=timezone.now().date(),
                payment_month=payment_month,
                processed_by=processed_by,
                status='processing',
                is_partial=is_partial,
                amount_paid=amount_paid,
                remaining_balance=remaining_balance,
                payment_method='bank_transfer'
            )

            recipient_code = self.get_or_create_recipient(employee)
            
            transfer_result = self.paystack.initiate_transfer(
                amount=int((amount_paid or net_salary) * 100),
                recipient_code=recipient_code,
                reference=payment.transaction_reference,
                reason=f"Salary - {employee.name} ({employee.employee_id})"
            )

            if not transfer_result.get('status') and is_invalid_recipient_error(transfer_result):
                self.invalidate_recipient(employee, reason='paystack_invalid_recipient')
                recipient_code = self.get_or_create_recipient(employee)
                transfer_result = self.paystack.initiate_transfer(
                    amount=int((amount_paid or net_salary) * 100),
                    recipient_code=recipient_code,
                    reference=payment.transaction_reference,
                    reason=f"Salary - {employee.name} ({employee.employee_id})"
                )

            if not transfer_result.get('status'):
                if is_invalid_recipient_error(transfer_result):
                    self.invalidate_recipient(employee, reason='paystack_invalid_recipient_after_refresh')
                payment.change_status('failed')
                raise Exception("Transfer failed. Please try again or contact your administrator.")
            
            return payment, transfer_result

    def process_bulk_payroll(self, employee_ids, processed_by):
        payments_created = []
        transfers_payload = []
        errors = []
        total_amount = 0
        current_month = timezone.now().strftime('%Y-%m')

        for emp_id in employee_ids:
            try:
                employee = Employee.objects.get(id=emp_id, status='active')
                recipient_code = self.get_or_create_recipient(employee)
                
                pending_deductions = applied_deductions_for_month(
                    employee, current_month
                ).aggregate(Sum('amount'))['amount__sum'] or 0
                net_amount = employee.salary - pending_deductions
                total_amount += float(net_amount)

                payment = Payment.objects.create(
                    employee=employee,
                    base_salary=employee.salary,
                    total_deductions=pending_deductions,
                    net_amount=net_amount,
                    transaction_reference=str(uuid.uuid4()),
                    payment_date=timezone.now().date(),
                    payment_month=current_month,
                    processed_by=processed_by,
                    status='processing',
                    payment_method='bank_transfer'
                )
#l
                transfers_payload.append({
                    "amount": int(net_amount * 100),
                    "recipient": recipient_code,
                    "reference": payment.transaction_reference,
                    "reason": f"Salary - {employee.name} ({employee.employee_id})"
                })
                payments_created.append(payment)

            except Exception as e:
                errors.append(f"Error for ID {emp_id}: {str(e)}")

        if transfers_payload:
            bulk_result = self.paystack.bulk_transfer(transfers_payload)
            if not bulk_result.get('status') and is_invalid_recipient_error(bulk_result):
                refreshed_payload = []
                for payment in payments_created:
                    employee = payment.employee
                    self.invalidate_recipient(employee, reason='paystack_bulk_invalid_recipient')
                    recipient_code = self.get_or_create_recipient(employee)
                    refreshed_payload.append({
                        "amount": int(payment.net_amount * 100),
                        "recipient": recipient_code,
                        "reference": payment.transaction_reference,
                        "reason": f"Salary - {employee.name} ({employee.employee_id})"
                    })
                bulk_result = self.paystack.bulk_transfer(refreshed_payload)
                if not bulk_result.get('status') and is_invalid_recipient_error(bulk_result):
                    for payment in payments_created:
                        self.invalidate_recipient(
                            payment.employee,
                            reason='paystack_bulk_invalid_recipient_after_refresh',
                        )
            return payments_created, total_amount, errors, bulk_result
        return [], 0, errors, None

    def verify_and_sync_payment(self, payment):
        """Verifies status with Paystack and updates model."""
        if payment.status == 'completed':
            return payment.status

        if payment.payment_method == 'bank_transfer':
            verification = self.paystack.verify_transfer(payment.transaction_reference)
        else:
            verification = self.paystack.verify_transaction(payment.transaction_reference)

        data = verification.get('data', {}) if isinstance(verification.get('data'), dict) else {}
        paystack_status = data.get('status')

        if verification.get('status') is True:
            if paystack_status == 'success':
                if payment.change_status('completed'):
                    payment.paystack_reference = str(data.get('id') or data.get('transfer_code') or data.get('reference') or '')
                    payment.paystack_transfer_code = str(data.get('transfer_code') or payment.paystack_transfer_code or '')
                    payment.save()
                    Notification.objects.create(
                        user=payment.employee.user,
                        message=f"Salary payment of ₦{payment.net_amount:,.2f} confirmed.",
                        type='success'
                    )
            elif paystack_status in ['failed', 'reversed']:
                payment.change_status('failed')
        
        return payment.status
