import os
import sys

def check_production_env():
    """Sanity check for Fotasco Payroll production environment variables."""
    print("--- Starting Production Environment Sanity Check ---")
    
    required_vars = [
        'SECRET_KEY', 
        'DATABASE_URL', 
        'REDIS_URL', 
        'PAYSTACK_SECRET_KEY',
        'EMAIL_HOST_USER', 
        'EMAIL_HOST_PASSWORD',
        'FRONTEND_URL'
    ]
    
    missing = []
    for var in required_vars:
        if not os.environ.get(var):
            missing.append(var)
            
    if missing:
        print(f"❌ CRITICAL MISSING VARIABLES: {', '.join(missing)}")
    else:
        print("✅ All required environment variables are present.")

    # 1. DEBUG Checkl
    debug_val = os.environ.get('DEBUG', 'False')
    if debug_val.lower() in ['true', '1', 't']:
        print("❌ SECURITY WARNING: DEBUG is set to TRUE. This must be FALSE in production.")
    else:
        print("✅ DEBUG is False.")

    # 2. Paystack Key Check
    paystack_key = os.environ.get('PAYSTACK_SECRET_KEY', '')
    if paystack_key.startswith('sk_test'):
        print("⚠️  WARNING: You are using a Paystack TEST key (sk_test...). Transfers will not use real money.")
    elif paystack_key.startswith('sk_live'):
        print("✅ Paystack LIVE key detected. Real transactions will be processed.")
    else:
        print("⚠️  WARNING: Paystack key format looks unusual.")

    # 3. Database Check
    db_url = os.environ.get('DATABASE_URL', '')
    if db_url.startswith('postgres://') or db_url.startswith('postgresql://'):
        print("✅ DATABASE_URL uses PostgreSQL.")
    elif db_url:
        print("⚠️  WARNING: DATABASE_URL does not appear to be a standard PostgreSQL string.")

    # 4. Secret Key Strength
    secret = os.environ.get('SECRET_KEY', '')
    if len(secret) < 30:
        print("⚠️  WARNING: SECRET_KEY is very short. Use a long random string for production.")

    print("--- Check Complete ---")
    
    if missing or debug_val.lower() in ['true', '1', 't']:
        print("\nConclusion: 🛑 CRITICAL ERRORS FOUND. FIX BEFORE DEPLOYING.")
        sys.exit(1)
    
if __name__ == "__main__":
    check_production_env()