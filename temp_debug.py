import os, django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'fotasco_payroll.settings')
django.setup()
from django.urls import get_resolver, URLPattern, URLResolver
resolver = get_resolver(None)
print('TOP LEVEL PATTERNS:')
for idx, p in enumerate(resolver.url_patterns):
    kind = type(p).__name__
    pat = str(p.pattern)
    print(idx, kind, pat, getattr(p, 'name', None))
    if isinstance(p, URLResolver):
        print('  includes', len(p.url_patterns), 'subpatterns')

print('\nMATCH PATHS:')
for path in ['/api/payments/request-payslip-export/', 'api/payments/request-payslip-export/']:
    try:
        r = resolver.resolve(path)
        print('resolved', path, '->', r.func, r.kwargs)
        print('  actions', getattr(r.func, 'actions', None))
    except Exception as e:
        print('failed', path, e)
