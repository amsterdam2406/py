from django.test import TestCase
from django.utils import timezone
from django.contrib.auth import get_user_model
from rest_framework.test import APIClient
from rest_framework import status
from .models import Employee, Payment, Deduction, Attendance
from decimal import Decimal
import uuid

User = get_user_model()

class DashboardStatsTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.admin_user = User.objects.create_superuser(
            username='admin', password='password123', email='admin@test.com'
        )
        self.client.force_authenticate(user=self.admin_user)
        
        # Create sample employees
        self.staff = Employee.objects.create(
            user=User.objects.create_user(username='staff1', role='staff'),
            name='Staff One',
            type='staff',
            location='Lagos',
            salary=Decimal('50000.00'),
            status='active',
            join_date=timezone.now().date()
        )
        
        self.guard = Employee.objects.create(
            user=User.objects.create_user(username='guard1', role='guard'),
            name='Guard One',
            type='guard',
            location='Abuja',
            salary=Decimal('30000.00'),
            status='active',
            join_date=timezone.now().date()
        )

    def test_dashboard_stats_counts(self):
        """Verify that staff and guard counts are accurate"""
        response = self.client.get('/api/employees/dashboard_stats/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['total_staff'], 1)
        self.assertEqual(response.data['total_guards'], 1)

    def test_monthly_salary_summary(self):
        """Verify monthly salary summary calculation for the last 6 months"""
        today = timezone.now()
        current_month_key = today.strftime('%Y-%m')
        
        # Create a completed payment for the current month
        Payment.objects.create(
            employee=self.staff,
            base_salary=self.staff.salary,
            net_amount=Decimal('45000.00'),
            payment_month=current_month_key,
            payment_date=today.date(),
            status='completed',
            transaction_reference=str(uuid.uuid4())
        )
        
        response = self.client.get('/api/employees/dashboard_stats/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        
        summary = response.data['salary_summary']
        self.assertEqual(len(summary), 6)
        
        # The last item in summary should be the current month
        current_month_summary = summary[-1]
        self.assertEqual(current_month_summary['amount'], 45000.0)
        
        # Check that total payments for current month match
        self.assertEqual(response.data['total_payments'], 45000.0)

    def test_dashboard_stats_location_filter(self):
        """Verify that location filtering works correctly"""
        # Statistics for Lagos (Staff One)
        response = self.client.get('/api/employees/dashboard_stats/?location=Lagos')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['total_staff'], 1)
        self.assertEqual(response.data['total_guards'], 0)
        self.assertEqual(len(response.data['recent_employees']), 1)
        self.assertEqual(response.data['recent_employees'][0]['name'], 'Staff One')

        # Statistics for Abuja (Guard One)
        response = self.client.get('/api/employees/dashboard_stats/?location=Abuja')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['total_staff'], 0)
        self.assertEqual(response.data['total_guards'], 1)
        self.assertEqual(len(response.data['recent_employees']), 1)
        self.assertEqual(response.data['recent_employees'][0]['name'], 'Guard One')

    def test_dashboard_stats_deduction_location_filter(self):
        """Verify that deductions are correctly filtered by location"""
        # Create a pending deduction for Lagos staff
        Deduction.objects.create(
            employee=self.staff,
            amount=Decimal('500.00'),
            reason='Lagos Deduction',
            date=timezone.now().date(),
            status='pending'
        )
        
        # Create a pending deduction for Abuja guard
        Deduction.objects.create(
            employee=self.guard,
            amount=Decimal('200.00'),
            reason='Abuja Deduction',
            date=timezone.now().date(),
            status='pending'
        )

        # Statistics for Lagos (should only show Lagos deduction)
        response = self.client.get('/api/employees/dashboard_stats/?location=Lagos')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['total_deductions'], 500.0)

        # Statistics for Abuja (should only show Abuja deduction)
        response = self.client.get('/api/employees/dashboard_stats/?location=Abuja')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['total_deductions'], 200.0)

        # Global statistics (should show both)
        response = self.client.get('/api/employees/dashboard_stats/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['total_deductions'], 700.0)

    def test_dashboard_stats_attendance_location_filter(self):
        """Verify attendance stats are filtered by location"""
        today = timezone.now().date()
        Attendance.objects.create(employee=self.staff, date=today, status='present')
        Attendance.objects.create(employee=self.guard, date=today, status='absent')

        # Stats for Lagos (Staff One)
        response = self.client.get('/api/employees/dashboard_stats/?location=Lagos')
        self.assertEqual(response.data['attendance_today']['present'], 1)
        self.assertEqual(response.data['attendance_today']['absent'], 0)

        # Stats for Abuja (Guard One)
        response = self.client.get('/api/employees/dashboard_stats/?location=Abuja')
        self.assertEqual(response.data['attendance_today']['present'], 0)
        self.assertEqual(response.data['attendance_today']['absent'], 1)

    def test_dashboard_stats_self_signup_count(self):
        """Verify that self-registered employees are counted correctly"""
        self.staff.is_self_registered = True
        self.staff.save()

        response = self.client.get('/api/employees/dashboard_stats/')
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data['total_self_registered'], 1)