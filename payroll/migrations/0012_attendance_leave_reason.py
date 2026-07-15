from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('payroll', '0011_widen_verification_code_fields'),
    ]

    operations = [
        migrations.AddField(
            model_name='attendance',
            name='leave_reason',
            field=models.TextField(blank=True, null=True),
        ),
    ]
