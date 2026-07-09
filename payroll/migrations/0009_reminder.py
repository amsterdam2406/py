from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ('payroll', '0008_allow_default_shared_user_email'),
    ]

    operations = [
        migrations.CreateModel(
            name='Reminder',
            fields=[
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('id', models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ('title', models.CharField(max_length=160)),
                ('purpose', models.TextField(max_length=1000)),
                ('remind_at', models.DateTimeField(db_index=True)),
                ('is_complete', models.BooleanField(default=False)),
                ('completed_at', models.DateTimeField(blank=True, null=True)),
                ('user', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='reminders', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'db_table': 'reminders',
                'ordering': ['is_complete', 'remind_at'],
            },
        ),
        migrations.AddIndex(
            model_name='reminder',
            index=models.Index(fields=['user', 'is_complete', 'remind_at'], name='rem_user_status_time_idx'),
        ),
    ]
