import os, django, json
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'fotasco_payroll.settings')
django.setup()
from django.urls import get_resolver, URLPattern, URLResolver
from django.test import Client
resolver = get_resolver(None)

def walk(patterns, prefix=''):
    for p in patterns:
        if isinstance(p, URLPattern):
            yield prefix + str(p.pattern), getattr(p, 'name', None), p.callback
        elif isinstance(p, URLResolver):
            yield from walk(p.url_patterns, prefix + str(p.pattern))

print('=== ROUTES ===')
for path, name, callback in walk(resolver.url_patterns):
    if 'request-payslip-export' in path or 'request_payslip_export' in path or 'request_export' in path:
        print(repr(path), '->', name, '->', callback)

print('=== RESOLVE TEST ===')
for p in ['api/payments/request-payslip-export/', '/api/payments/request-payslip-export/', 'api/payments/request-export/', '/api/payments/request-export/']:
    try:
        r = resolver.resolve(p)
        print('resolve ok', p, '->', r.func, r.kwargs)
    except Exception as e:
        print('resolve fail', p, repr(e))

client = Client(HTTP_HOST='localhost')
for method in ['get', 'post']:
    func = getattr(client, method)
    status = func('/api/payments/request-payslip-export/', data=json.dumps({'dummy':'x'}) if method == 'post' else None, content_type='application/json' if method == 'post' else 'application/json').status_code
    print(method.upper(), 'status', status)
