import os, django
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

print('=== URLS WITH payslip OR export ===')
for path, name, callback in walk(resolver.url_patterns):
    if 'payslip' in path or 'export' in path:
        print(path, '->', name, '->', callback)

print('=== RESOLVE TEST ===')
try:
    r = resolver.resolve('api/payments/request-payslip-export/')
    print('resolve found:', r.func, 'kwargs:', r.kwargs)
except Exception as e:
    print('resolve error:', repr(e))

client = Client()
print('GET status:', client.get('/api/payments/request-payslip-export/').status_code)
print('POST status without auth:', client.post('/api/payments/request-payslip-export/', {'dummy': 'x'}).status_code)
