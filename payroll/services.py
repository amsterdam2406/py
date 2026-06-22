import logging
from decimal import Decimal, InvalidOperation
import uuid
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone
from .models import (
    Payment,
    Employee,
    Deduction,
    Notification,
    EmployeeBalanceLedger,
    EmployeeSalaryAdjustment,
    AdjustmentType,
)
from .paystack import PaystackAPI, NIGERIAN_BANKS

# l
logger = logging.getLogger(__name__)

def get_employee_bank_code(employee):
    """Return a valid Paystack bank_code for an employee.

    Priority:
      1) employee.bank_code if it is non-empty and matches known Paystack bank codes
      2) derive from employee.bank_name
    """

    # 1) Prefer stored bank_code, but normalize + validate it
    stored_code = (getattr(employee, 'bank_code', None) or '').strip()
    if stored_code:
        # Ensure it's a known Paystack code key
        if stored_code in NIGERIAN_BANKS:
            return stored_code

    # 2) Derive from bank_name
    normalized_name = (getattr(employee, 'bank_name', '') or '').strip().lower()
    for code, name in NIGERIAN_BANKS.items():
        target_name = (name or '').strip().lower()
        # Match exact or if the stored name is a substring of the official name (e.g. "GTB" -> "Guaranty Trust Bank")
        if normalized_name == target_name or normalized_name in target_name or target_name in normalized_name:
            try:
                if hasattr(employee, 'bank_code'):
                    employee.bank_code = code
                    employee.save(update_fields=['bank_code'])
            except Exception:
                # Keep going even if saving bank_code fails
                pass
            return code

    return None



def applied_deductions_for_month(employee, month_key):
    year, month = map(int, month_key.split('-'))
    return Deduction.objects.filter(
        employee=employee,
        status='applied',
        date__year=year,
        date__month=month,
    )


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


def outstanding_previous_balance_for_month(employee, month_key):
    """Return the outstanding balance that should be carried into this month."""
    # Ledger stores month_key for the ledgered balance of that month.
    # Carry into current month from previous month ledger row.
    year, month = map(int, month_key.split('-'))
    if month == 1:
        prev_year, prev_month = year - 1, 12
    else:
        prev_year, prev_month = year, month - 1

    prev_month_key = f"{prev_year:04d}-{prev_month:02d}"
    row = EmployeeBalanceLedger.objects.filter(
        employee=employee,
        month_key=prev_month_key,
    ).first()
    return row.outstanding_balance if row else Decimal('0')


def compute_total_salary_payable(employee, month_key):
    """Compute detailed breakdown and net payable for the month."""
    base_salary = Decimal(str(employee.salary))

    # Other Deductions (from Deduction model)
    other_deductions = applied_deductions_for_month(employee, month_key).aggregate(
        total=Sum('amount')
    )['total'] or Decimal('0')

    # Adjustments (IOU, Bonus, etc.)
    try:
        year, m = map(int, month_key.split('-'))
    except:
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
    except:
        bonus = Decimal('0')
        iou = Decimal('0')
    
    prev_balance = outstanding_previous_balance_for_month(employee, month_key)

    # Total Monthly Due = Base Salary + Bonus + Prev Month Balance (Unpaid)
    # Deductions are subtracted to get the final net payable
    final_net_salary = (base_salary + bonus + prev_balance) - (iou + other_deductions)
    
    if final_net_salary < 0:
        final_net_salary = Decimal('0')

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
        if not bank_code_str.isdigit() or len(bank_code_str) != 3:
            raise ValueError(
                f"Invalid bank_code for {employee.name}. Expected 3-digit Paystack bank_code, got '{bank_code_str}'."
            )
        return bank_code_str

    def get_or_create_recipient(self, employee):
        recipient_code = getattr(employee, 'paystack_recipient_code', None)
        if not recipient_code:
            bank_code = get_employee_bank_code(employee)

            if not bank_code:
                # If employee.bank_code isn't set (or wasn't recognized), try deriving it from bank_name.
                # This prevents blocking transfers due to stale/missing bank_code.
                bank_name = (getattr(employee, 'bank_name', None) or '').strip()
                if bank_name:
                    derived = get_employee_bank_code(employee)
                    if derived:
                        bank_code = derived

                if not bank_code:
                    raise ValueError(f"Employee {employee.name} bank_code is missing.")

            bank_code_str = self._validate_paystack_bank_code(bank_code, employee)

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

            if not transfer_result.get('status'):
                payment.change_status('failed')
                raise Exception(f"Transfer failed: {transfer_result.get('message')}")
            
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
