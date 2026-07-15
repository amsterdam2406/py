from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('payroll', '0012_attendance_leave_reason'),
    ]

    operations = [
        migrations.AddField(
            model_name='user',
            name='is_attendance_admin',
            field=models.BooleanField(default=False),
        ),
    ]
