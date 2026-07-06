from django.db import migrations, models
from django.db.models.functions import Lower


class Migration(migrations.Migration):

    dependencies = [
        ('payroll', '0007_historicalpayment_failure_reason_and_more'),
    ]

    operations = [
        migrations.AlterField(
            model_name='user',
            name='email',
            field=models.EmailField(db_index=True, max_length=254, verbose_name='email address'),
        ),
        migrations.AddConstraint(
            model_name='user',
            constraint=models.UniqueConstraint(
                Lower('email'),
                condition=~models.Q(email__iexact='fotasco@gmail.com'),
                name='unique_user_email_except_default',
            ),
        ),
    ]
