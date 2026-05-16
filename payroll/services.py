import logging
from decimal import Decimal, InvalidOperation
import uuid
from django.db import transaction
from django.db.models import Sum
from django.utils import timezone
from .models import Payment, Employee, Deduction, Notification
from .paystack import PaystackAPI, NIGERIAN_BANKS

# l
logger = logging.getLogger(__name__)

def get_employee_bank_code(employee):
    bank_code = getattr(employee, 'bank_code', None)
    if bank_code:
        return bank_code

    normalized_name = (employee.bank_name or '').strip().lower()
    for code, name in NIGERIAN_BANKS.items():
        if normalized_name == (name or '').strip().lower():
            if hasattr(employee, 'bank_code'):
                employee.bank_code = code
                employee.save(update_fields=['bank_code'])
            return code
    return None

class PaystackService:
    def __init__(self):
        self.paystack = PaystackAPI()

    def get_or_create_recipient(self, employee):
        recipient_code = getattr(employee, 'paystack_recipient_code', None)
        if not recipient_code:
            bank_code = get_employee_bank_code(employee)
            if not bank_code:
                raise ValueError(f"Employee {employee.name} bank_code is missing.")
            
            result = self.paystack.create_recipient(
                name=employee.name,
                account_number=employee.account_number,
                bank_code=bank_code
            )
            if not result or not result.get('status'):
                raise Exception(f"Failed to create recipient: {result.get('message') if result else 'Unknown error'}")
            
            recipient_code = result.get('data', {}).get('recipient_code')
            employee.paystack_recipient_code = recipient_code
            employee.save(update_fields=['paystack_recipient_code'])
        return recipient_code

    def initiate_salary_transfer(self, employee, custom_amount=None, processed_by=None):
        with transaction.atomic():
            payment_month = None
            is_partial = False
            total_deductions = 0

            if custom_amount:
                try:
                    net_salary = Decimal(str(custom_amount))
                    is_partial = True
                    if net_salary <= 0:
                        raise ValueError("Invalid custom amount")
                except (ValueError, InvalidOperation):
                    raise ValueError("Invalid custom amount")
            else:
                payment_month = timezone.now().strftime('%Y-%m')
                total_deductions = Deduction.objects.filter(
                    employee=employee, status='pending'
                ).aggregate(Sum('amount'))['amount__sum'] or 0
                net_salary = employee.salary - total_deductions

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
                payment_method='bank_transfer'
            )

            recipient_code = self.get_or_create_recipient(employee)
            
            transfer_result = self.paystack.initiate_transfer(
                amount=int(net_salary * 100),
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
                
                pending_deductions = Deduction.objects.filter(
                    employee=employee, status='pending'
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
                    payment.paystack_reference = str(data.get('id', '') or data.get('reference', ''))
                    payment.save()
                    Notification.objects.create(
                        user=payment.employee.user,
                        message=f"Salary payment of ₦{payment.net_amount:,.2f} confirmed.",
                        type='success'
                    )
            elif paystack_status in ['failed', 'reversed']:
                payment.change_status('failed')
        
        return payment.status