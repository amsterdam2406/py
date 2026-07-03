from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("payroll", "0004_remove_deduction_deduction_status_valid_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="payment",
            name="failure_reason",
            field=models.TextField(blank=True, null=True),
        ),
    ]