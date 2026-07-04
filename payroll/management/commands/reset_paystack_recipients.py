# from django.core.cache import cache
# from django.core.management.base import BaseCommand, CommandError
# from payroll.models import Employee
# from payroll.paystack import PaystackAccountResolutionService
# from payroll.services import paystack_recipient_fingerprint_key


# class Command(BaseCommand):
#     help = "Clear stored Paystack recipient codes so fresh recipients are created on the next transfer."

#     def add_arguments(self, parser):
#         target = parser.add_mutually_exclusive_group(required=True)
#         target.add_argument("--employee-id", dest="employee_id", help="Reset one employee by UUID.")
#         target.add_argument("--all", action="store_true", help="Reset recipient codes for all employees.")

#     def handle(self, *args, **options):
#         if options["employee_id"]:
#             employees = Employee.objects.filter(id=options["employee_id"])
#             if not employees.exists():
#                 raise CommandError("Employee not found.")
#         else:
#             employees = Employee.objects.exclude(paystack_recipient_code__isnull=True).exclude(
#                 paystack_recipient_code=""
#             )

#         reset_count = 0
#         for employee in employees:
#             cache.delete_many(self._cache_keys(employee))
#             if employee.paystack_recipient_code:
#                 employee.paystack_recipient_code = None
#                 employee.save(update_fields=["paystack_recipient_code"])
#                 reset_count += 1

#         self.stdout.write(self.style.SUCCESS(f"Reset Paystack recipient codes for {reset_count} employee(s)."))

#     @staticmethod
#     def _cache_keys(employee):
#         keys = [
#             f"paystack:recipient:{employee.id}",
#             f"paystack_recipient_{employee.id}",
#             paystack_recipient_fingerprint_key(employee),
#         ]
#         account_number = str(employee.account_number or "").strip()
#         bank_code = str(employee.bank_code or "").strip()
#         if account_number and bank_code:
#             keys.extend([
#                 PaystackAccountResolutionService.cache_key(bank_code, account_number),
#                 PaystackAccountResolutionService.legacy_cache_key(bank_code, account_number),
#             ])
#         return keys
