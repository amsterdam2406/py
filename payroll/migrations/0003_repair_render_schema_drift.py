# Generated manually to repair production databases whose migration history
# drifted from the physical schema during Render deploys.

from django.db import migrations


REPAIR_MODELS = [
    'CompanyMonthlyPayment',
    'EmployeeBalanceLedger',
    'EmployeeSalaryAdjustment',
]

REPAIR_COLUMNS = {
    'Payment': [
        'payment_month',
        'amount_paid',
        'bonus_amount',
        'iou_amount',
        'is_partial',
        'partial_reason',
        'paystack_reference',
        'paystack_transfer_code',
        'remaining_balance',
        'previous_balance',
        'hr_approved',
        'hr_approved_by',
    ],
    'HistoricalPayment': [
        'payment_month',
        'amount_paid',
        'bonus_amount',
        'iou_amount',
        'is_partial',
        'partial_reason',
        'paystack_reference',
        'paystack_transfer_code',
        'remaining_balance',
        'previous_balance',
        'hr_approved',
        'hr_approved_by',
    ],
}


def _table_names(schema_editor):
    with schema_editor.connection.cursor() as cursor:
        return set(schema_editor.connection.introspection.table_names(cursor))


def _column_names(schema_editor, table_name):
    with schema_editor.connection.cursor() as cursor:
        return {
            column.name
            for column in schema_editor.connection.introspection.get_table_description(cursor, table_name)
        }


def repair_render_schema_drift(apps, schema_editor):
    tables = _table_names(schema_editor)

    for model_name in REPAIR_MODELS:
        model = apps.get_model('payroll', model_name)
        if model._meta.db_table not in tables:
            schema_editor.create_model(model)
            tables.add(model._meta.db_table)

    for model_name, field_names in REPAIR_COLUMNS.items():
        model = apps.get_model('payroll', model_name)
        table_name = model._meta.db_table

        if table_name not in tables:
            schema_editor.create_model(model)
            tables.add(table_name)
            continue

        existing_columns = _column_names(schema_editor, table_name)
        for field_name in field_names:
            field = model._meta.get_field(field_name)
            if field.column not in existing_columns:
                schema_editor.add_field(model, field)
                existing_columns.add(field.column)


class Migration(migrations.Migration):

    dependencies = [
        ('payroll', '0002_alter_user_options_and_more'),
    ]

    operations = [
        migrations.RunPython(repair_render_schema_drift, migrations.RunPython.noop),
    ]
