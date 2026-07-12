from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('payroll', '0010_deduction_created_by'),
    ]

    operations = [
        migrations.AlterField(
            model_name='otp',
            name='code',
            field=models.CharField(max_length=128),
        ),
        migrations.AlterField(
            model_name='exporttoken',
            name='otp_code',
            field=models.CharField(blank=True, max_length=128, null=True),
        ),
    ]
