from django.core.management.base import BaseCommand
from django.db import connection


class Command(BaseCommand):
    help = 'Fix partial migration state by adding missing columns and tables manually'

    def add_column_if_not_exists(self, table, column, definition):
        with connection.cursor() as cursor:
            cursor.execute("""
                SELECT column_name FROM information_schema.columns 
                WHERE table_name = %s AND column_name = %s
            """, [table, column])
            if not cursor.fetchone():
                self.stdout.write(self.style.WARNING(f'Adding {column} to {table}...'))
                cursor.execute(f'ALTER TABLE {table} ADD COLUMN {column} {definition}')
                return True
            else:
                self.stdout.write(self.style.NOTICE(f'{column} already exists in {table}'))
                return False

    def table_exists(self, table_name):
        with connection.cursor() as cursor:
            cursor.execute("""
                SELECT table_name FROM information_schema.tables 
                WHERE table_name = %s
            """, [table_name])
            return cursor.fetchone() is not None

    def handle(self, *args, **options):
        # Create missing tables FIRST (before adding columns to them)
        with connection.cursor() as cursor:
            # otp table (from 0006)
            if not self.table_exists('otps'):
                self.stdout.write(self.style.WARNING('Creating otps table...'))
                cursor.execute("""
                    CREATE TABLE otps (
                        id BIGSERIAL PRIMARY KEY,
                        email VARCHAR(254) NOT NULL,
                        code VARCHAR(6) NOT NULL,
                        reference VARCHAR(100) NOT NULL,
                        is_used BOOLEAN DEFAULT FALSE,
                        expires_at TIMESTAMP NOT NULL,
                        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        attempt_count INTEGER DEFAULT 0,
                        max_attempts INTEGER DEFAULT 3
                    )
                """)

            # export_tokens table (from 0006)
            if not self.table_exists('export_tokens'):
                self.stdout.write(self.style.WARNING('Creating export_tokens table...'))
                cursor.execute("""
                    CREATE TABLE export_tokens (
                        id BIGSERIAL PRIMARY KEY,
                        token VARCHAR(64) NOT NULL UNIQUE,
                        data_type VARCHAR(50) NOT NULL,
                        filters JSONB DEFAULT '{}',
                        expires_at TIMESTAMP NOT NULL,
                        otp_code VARCHAR(6) NULL,
                        is_2fa_verified BOOLEAN DEFAULT FALSE,
                        is_used BOOLEAN DEFAULT FALSE,
                        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE
                    )
                """)

            # audit_logs table (from 0018)
            if not self.table_exists('audit_logs'):
                self.stdout.write(self.style.WARNING('Creating audit_logs table...'))
                cursor.execute("""
                    CREATE TABLE audit_logs (
                        id BIGSERIAL PRIMARY KEY,
                        action VARCHAR(255) NOT NULL,
                        ip_address INET NULL,
                        extra_data JSONB DEFAULT '{}',
                        timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
                        user_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL
                    )
                """)
                cursor.execute("CREATE INDEX audit_logs_timestamp_idx ON audit_logs(timestamp DESC)")

            # employee_requests table (from 0016)
            if not self.table_exists('employee_requests'):
                self.stdout.write(self.style.WARNING('Creating employee_requests table...'))
                cursor.execute("""
                    CREATE TABLE employee_requests (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        request_type VARCHAR(20) NOT NULL,
                        amount NUMERIC(10, 2) NULL,
                        description TEXT NOT NULL,
                        proof_photo VARCHAR(100) NULL,
                        receipt_file VARCHAR(100) NULL,
                        status VARCHAR(10) DEFAULT 'pending',
                        decline_reason TEXT NULL,
                        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
                        action_by_id BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
                        employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE
                    )
                """)

            # employee_request_attachments table (from 0020)
            if not self.table_exists('employee_request_attachments'):
                if self.table_exists('employee_requests'):
                    self.stdout.write(self.style.WARNING('Creating employee_request_attachments table...'))
                    cursor.execute("""
                        CREATE TABLE employee_request_attachments (
                            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                            file VARCHAR(100) NOT NULL,
                            file_type VARCHAR(10) NOT NULL,
                            request_id UUID NOT NULL REFERENCES employee_requests(id) ON DELETE CASCADE
                        )
                    """)
                else:
                    self.stdout.write(self.style.ERROR('Skipping employee_request_attachments - employee_requests table missing!'))

        # Now add missing columns
        self.add_column_if_not_exists('employees', 'is_self_registered', 'BOOLEAN DEFAULT FALSE')
        self.add_column_if_not_exists('payments', 'amount_paid', 'NUMERIC(10, 2) NULL')
        self.add_column_if_not_exists('payments', 'is_partial', 'BOOLEAN DEFAULT FALSE')
        self.add_column_if_not_exists('attendance', 'clock_method', 'VARCHAR(10) NULL')
        self.add_column_if_not_exists('attendance', 'leave_start', 'DATE NULL')
        self.add_column_if_not_exists('attendance', 'leave_end', 'DATE NULL')
        self.add_column_if_not_exists('attendance', 'clock_in_photo', 'VARCHAR(100) NULL')
        self.add_column_if_not_exists('attendance', 'clock_out_photo', 'VARCHAR(100) NULL')
        self.add_column_if_not_exists('otps', 'attempt_count', 'INTEGER DEFAULT 0')  # FIXED: was 'otp'
        self.add_column_if_not_exists('otps', 'max_attempts', 'INTEGER DEFAULT 3')   # FIXED: was 'otp'
        self.add_column_if_not_exists('deductions', 'hr_approved', 'BOOLEAN DEFAULT FALSE')
        self.add_column_if_not_exists('deductions', 'hr_approved_by_id', 'BIGINT NULL')
        self.add_column_if_not_exists('payments', 'hr_approved', 'BOOLEAN DEFAULT FALSE')
        self.add_column_if_not_exists('payments', 'hr_approved_by_id', 'BIGINT NULL')
        self.add_column_if_not_exists('payments', 'paystack_transfer_code', 'VARCHAR(100) NULL')
        self.add_column_if_not_exists('payments', 'payment_month', 'VARCHAR(7) NULL')
        self.add_column_if_not_exists('companies', 'email', 'VARCHAR(254) NULL')
        self.add_column_if_not_exists('companies', 'phone', 'VARCHAR(15) NULL')
        self.add_column_if_not_exists('companies', 'status', "VARCHAR(15) DEFAULT 'active'")
        self.add_column_if_not_exists('companies', 'termination_reason', 'TEXT NULL')
        self.add_column_if_not_exists('companies', 'contract_start', 'DATE NULL')
        self.add_column_if_not_exists('companies', 'contract_end', 'DATE NULL')
        self.add_column_if_not_exists('users', 'is_request_admin', 'BOOLEAN DEFAULT FALSE')
        
        # Fix migration history - mark all as applied
        with connection.cursor() as cursor:
            migrations_to_ensure = [
                '0001_initial',
                '0002_remove_user_employee_id',
                '0003_alter_attendance_unique_together_and_more',
                '0004_user_employee_id_alter_user_role',
                '0005_user_is_company_admin_user_is_deduction_admin_and_more',
                '0006_otp_exporttoken',
                '0007_attendance_clock_in_timestamp_and_more',
                '0008_otp_attempt_count_otp_max_attempts_alter_otp_code',
                '0009_alter_deduction_status',
                '0010_employee_id_sequence_alter_employee_status_and_more',
                '0011_company_contact_email_company_contact_number',
                '0012_employee_bank_code_recipient',
                '0013_attendance_clock_method_attendance_leave_end_and_more',
                '0014_payment_payment_month_and_more',
                '0015_rename_contact_email_company_email_and_more',
                '0016_user_is_request_admin_employeerequest',
                '0017_employee_is_self_registered_payment_amount_paid_and_more',
                '0018_auditlog',
                '0019_alter_company_profit_and_more',
                '0020_employeerequestattachment',
                '0021_exporttoken_is_2fa_verified_exporttoken_otp_code_and_more',
                '0022_payment_paystack_transfer_code_alter_otp_code_and_more',
                '0023_deduction_hr_approved_deduction_hr_approved_by_and_more',
                '0024_alter_otp_reference',
                '0025_alter_employee_status',
            ]
            
            for migration in migrations_to_ensure:
                cursor.execute("""
                    INSERT INTO django_migrations (app, name, applied)
                    SELECT 'payroll', %s, NOW()
                    WHERE NOT EXISTS (
                        SELECT 1 FROM django_migrations 
                        WHERE app = 'payroll' AND name = %s
                    )
                """, [migration, migration])
        
        self.stdout.write(self.style.SUCCESS('All missing columns/tables added and migration history fixed!'))