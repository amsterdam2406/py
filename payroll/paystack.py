import requests
import logging
import math
import re
import time
from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)
PAYSTACK_RESOLVE_GLOBAL_COOLDOWN_KEY = "paystack:resolve:global_temporary_unavailable"
PAYSTACK_ACCOUNT_RESOLVE_TTL_SECONDS = 60 * 60 * 24


def _mask_account_number(account_number):
    value = str(account_number or "")
    if len(value) <= 4:
        return "****"
    return f"{'*' * (len(value) - 4)}{value[-4:]}"


def _is_live_secret_key(secret_key):
    return str(secret_key or '').startswith('sk_live_')

def _paystack_error_response(exc, fallback_status='failed'):
    error_payload = None
    response = getattr(exc, 'response', None)
    if response is not None:
        try:
            error_payload = response.json()
        except ValueError:
            error_payload = {'raw': response.text}

    message = (
        error_payload.get('message')
        if isinstance(error_payload, dict) and error_payload.get('message')
        else str(exc)
    )
    return {
        'status': False,
        'message': message,
        'data': error_payload if error_payload is not None else {'status': fallback_status},
    }


class PaystackAccountResolutionService:
    """Resolve Nigerian bank accounts through Paystack with cache and network retries."""

    BASE_URL = "https://api.paystack.co"
    SUCCESS_TTL_SECONDS = PAYSTACK_ACCOUNT_RESOLVE_TTL_SECONDS
    REQUEST_TIMEOUT_SECONDS = 8
    MAX_NETWORK_ATTEMPTS = 3
    NETWORK_RETRY_BACKOFF_SECONDS = (0.25, 0.75)
    _session = requests.Session()

    def __init__(self):
        self.secret_key = getattr(settings, 'PAYSTACK_SECRET_KEY', '')
        self.request_timeout = max(1, int(getattr(settings, 'PAYSTACK_ACCOUNT_RESOLVE_TIMEOUT_SECONDS', self.REQUEST_TIMEOUT_SECONDS)))
        self.max_network_attempts = max(1, int(getattr(settings, 'PAYSTACK_ACCOUNT_RESOLVE_ATTEMPTS', self.MAX_NETWORK_ATTEMPTS)))
        self.headers = {
            'Authorization': f'Bearer {self.secret_key}',
            'Content-Type': 'application/json',
        }
        if not self.secret_key:
            logger.error("PAYSTACK_SECRET_KEY not configured in settings!")

    def _live_mode_error_payload(self, account_number, bank_code):
        logger.error(
            "Paystack account resolve blocked because PAYSTACK_SECRET_KEY is not a live key bank_code=%s account=%s",
            bank_code,
            _mask_account_number(account_number),
        )
        return self._temporary_failure_payload(
            account_number,
            bank_code,
            'Live Paystack secret key is required for production bank account verification.',
            error_code='paystack_live_key_required',
        )

    @staticmethod
    def cache_key(bank_code, account_number):
        return f"paystack:resolve:{bank_code}:{account_number}"

    @staticmethod
    def legacy_cache_key(bank_code, account_number):
        return f"paystack_resolve_{bank_code}_{account_number}"

    def global_cooldown_key(self):
        mode = 'live' if _is_live_secret_key(self.secret_key) else 'test'
        return f"{PAYSTACK_RESOLVE_GLOBAL_COOLDOWN_KEY}:{mode}"

    @staticmethod
    def _invalid_payload(account_number, bank_code, message):
        return {
            'verified': False,
            'account_name': '',
            'account_number': account_number,
            'bank_code': bank_code,
            'status': False,
            'message': message,
            'error_code': 'invalid_account',
        }

    @staticmethod
    def _success_payload(account_number, bank_code, account_name):
        return {
            'verified': True,
            'account_name': account_name,
            'account_number': account_number,
            'bank_code': bank_code,
            'status': True,
            'message': 'Account resolved successfully.',
            'data': {
                'account_name': account_name,
                'account_number': account_number,
                'bank_code': bank_code,
            },
        }

    @staticmethod
    def _temporary_failure_payload(account_number, bank_code, message, error_code='verification_unavailable', retry_after=None):
        payload = {
            'verified': False,
            'account_name': '',
            'account_number': account_number,
            'bank_code': bank_code,
            'status': False,
            'message': message,
            'error_code': error_code,
            'temporary': True,
        }
        if retry_after:
            payload['retry_after'] = retry_after
        return payload

    @classmethod
    def to_legacy_paystack_result(cls, payload):
        if payload.get('verified'):
            return {
                'status': True,
                'message': payload.get('message') or 'Account resolved successfully.',
                'data': {
                    'account_name': payload.get('account_name'),
                    'account_number': payload.get('account_number'),
                    'bank_code': payload.get('bank_code'),
                },
            }
        return {
            'status': False,
            'message': payload.get('message') or 'Account could not be verified.',
            'error_code': payload.get('error_code'),
            'retry_after': payload.get('retry_after'),
            'data': None,
        }

    def resolve(self, account_number, bank_code):
        account_number = str(account_number or '').strip()
        bank_code = str(bank_code or '').strip()
        masked_account = _mask_account_number(account_number)

        if not re.fullmatch(r'\d{10}', account_number) or not re.fullmatch(r'\d{3,6}', bank_code):
            logger.info(
                "Paystack account resolve rejected invalid input bank_code=%s account=%s",
                bank_code,
                masked_account,
            )
            return self._invalid_payload(
                account_number,
                bank_code,
                'A valid 10-digit account number and Paystack bank code are required.',
            )

        if not _is_live_secret_key(self.secret_key):
            return self._live_mode_error_payload(account_number, bank_code)

        cache_key = self.cache_key(bank_code, account_number)
        legacy_cache_key = self.legacy_cache_key(bank_code, account_number)

        global_cooldown = cache.get(self.global_cooldown_key())
        if global_cooldown:
            payload = dict(global_cooldown)
            payload['account_number'] = account_number
            payload['bank_code'] = bank_code
            logger.info(
                "Paystack account resolve global cooldown hit bank_code=%s account=%s error_code=%s",
                bank_code,
                masked_account,
                payload.get('error_code'),
            )
            return payload

        cached = cache.get(cache_key) or cache.get(legacy_cache_key)
        if cached:
            normalized = self._normalize_cached_payload(cached, account_number, bank_code)
            if normalized.get('verified'):
                cache.set(cache_key, normalized, self.SUCCESS_TTL_SECONDS)
                logger.info(
                    "Paystack account resolve cache hit bank_code=%s account=%s",
                    bank_code,
                    masked_account,
                )
                return normalized

        logger.info(
            "Paystack account resolve cache miss bank_code=%s account=%s",
            bank_code,
            masked_account,
        )

        lock_key = f"paystack:resolve:lock:{bank_code}:{account_number}"
        acquired = cache.add(lock_key, True, 10)
        if not acquired:
            time.sleep(0.35)
            cached_after_wait = cache.get(cache_key) or cache.get(legacy_cache_key)
            if cached_after_wait:
                normalized = self._normalize_cached_payload(cached_after_wait, account_number, bank_code)
                if normalized.get('verified'):
                    logger.info(
                        "Paystack account resolve cache hit after wait bank_code=%s account=%s",
                        bank_code,
                        masked_account,
                    )
                    return normalized

        try:
            return self._resolve_from_paystack(account_number, bank_code, masked_account, cache_key, legacy_cache_key)
        finally:
            if acquired:
                try:
                    cache.delete(lock_key)
                except Exception:
                    pass

    def _resolve_from_paystack(self, account_number, bank_code, masked_account, cache_key, legacy_cache_key):
        url = f"{self.BASE_URL}/bank/resolve"
        params = {'account_number': account_number, 'bank_code': bank_code}
        last_error = None

        for attempt in range(1, self.max_network_attempts + 1):
            try:
                response = self._session.get(
                    url,
                    headers=self.headers,
                    params=params,
                    timeout=self.request_timeout,
                )
                response_payload = self._response_json(response)
                logger.info(
                    "Paystack account resolve response bank_code=%s account=%s status_code=%s paystack_status=%s message=%s",
                    bank_code,
                    masked_account,
                    response.status_code,
                    response_payload.get('status') if isinstance(response_payload, dict) else None,
                    response_payload.get('message') if isinstance(response_payload, dict) else '',
                )

                if response.status_code == 429:
                    paystack_message = self._paystack_message(response_payload)
                    retry_after = self._retry_after_seconds(response, paystack_message)
                    logger.warning(
                        "Paystack account resolve rate limited bank_code=%s account=%s retry_after=%s message=%s",
                        bank_code,
                        masked_account,
                        retry_after,
                        paystack_message,
                    )
                    payload = self._temporary_failure_payload(
                        account_number,
                        bank_code,
                        paystack_message or 'Account verification is temporarily rate limited. Please try again shortly.',
                        error_code='rate_limited',
                        retry_after=retry_after,
                    )
                    cache.set(self.global_cooldown_key(), payload, retry_after)
                    return payload

                if response.status_code >= 500:
                    return self._temporary_failure_payload(
                        account_number,
                        bank_code,
                        'Account verification service is temporarily unavailable.',
                    )

                if response.status_code >= 400:
                    return self._invalid_payload(
                        account_number,
                        bank_code,
                        self._paystack_message(response_payload) or 'Invalid account details.',
                    )

                if isinstance(response_payload, dict) and response_payload.get('status'):
                    data = response_payload.get('data') if isinstance(response_payload.get('data'), dict) else {}
                    account_name = str(data.get('account_name') or '').strip()
                    if account_name:
                        payload = self._success_payload(account_number, bank_code, account_name)
                        cache.set(cache_key, payload, self.SUCCESS_TTL_SECONDS)
                        cache.set(legacy_cache_key, payload, self.SUCCESS_TTL_SECONDS)
                        return payload

                return self._invalid_payload(
                    account_number,
                    bank_code,
                    self._paystack_message(response_payload) or 'Invalid account details.',
                )

            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as exc:
                last_error = exc
                logger.warning(
                    "Paystack account resolve network failure attempt=%s bank_code=%s account=%s error=%s",
                    attempt,
                    bank_code,
                    masked_account,
                    exc,
                )
                if attempt < self.max_network_attempts:
                    time.sleep(min(2, 0.25 * (2 ** (attempt - 1))))
                    continue
                break
            except requests.exceptions.RequestException as exc:
                logger.error(
                    "Paystack account resolve request failure bank_code=%s account=%s error=%s",
                    bank_code,
                    masked_account,
                    exc,
                )
                return self._temporary_failure_payload(
                    account_number,
                    bank_code,
                    'Account verification failed due to a temporary network error.',
                )

        logger.error(
            "Paystack account resolve network exhausted bank_code=%s account=%s error=%s",
            bank_code,
            masked_account,
            last_error,
        )
        return self._temporary_failure_payload(
            account_number,
            bank_code,
            'Account verification failed due to a temporary network error.',
        )

    @staticmethod
    def _response_json(response):
        try:
            payload = response.json()
            return payload if isinstance(payload, dict) else {}
        except ValueError:
            return {}

    @staticmethod
    def _paystack_message(payload):
        if isinstance(payload, dict):
            return str(payload.get('message') or '').strip()
        return ''

    @staticmethod
    def _retry_after_seconds(response, message=''):
        if 'daily limit' in str(message or '').lower():
            return 60 * 60 * 24
        retry_after = response.headers.get('Retry-After') if response is not None else None
        try:
            return max(30, int(math.ceil(float(retry_after))))
        except (TypeError, ValueError):
            return 300

    @classmethod
    def _normalize_cached_payload(cls, cached, account_number, bank_code):
        if isinstance(cached, dict) and 'verified' in cached:
            return cached
        if isinstance(cached, dict) and cached.get('status'):
            data = cached.get('data') if isinstance(cached.get('data'), dict) else {}
            account_name = str(data.get('account_name') or cached.get('account_name') or '').strip()
            if account_name:
                return cls._success_payload(account_number, bank_code, account_name)
        return {}


class PaystackAPI:
    """Paystack Payment Gateway Integration"""
    
    BASE_URL = "https://api.paystack.co"  # FXD: 
    
    def __init__(self):
        self.secret_key = getattr(settings, 'PAYSTACK_SECRET_KEY', '')
        if not self.secret_key:
            logger.error("PAYSTACK_SECRET_KEY not configured in settings!")
        
        # ADD THIS LINE:
        self.env_label = "LIVE" if self.secret_key.startswith('sk_live_') else "TEST"
        
        self.headers = {
            'Authorization': f'Bearer {self.secret_key}',
            'Content-Type': 'application/json'
        }
        self.request_timeout = max(1, int(getattr(settings, 'PAYSTACK_REQUEST_TIMEOUT_SECONDS', 8)))
        self.transfer_timeout = max(1, int(getattr(settings, 'PAYSTACK_TRANSFER_TIMEOUT_SECONDS', 10)))
        self.bulk_transfer_timeout = max(1, int(getattr(settings, 'PAYSTACK_BULK_TRANSFER_TIMEOUT_SECONDS', 12)))

    def _require_live_mode(self, operation):
        if _is_live_secret_key(self.secret_key):
            return None
        message = f"Live Paystack secret key is required for production {operation}."
        logger.error("Paystack %s blocked because PAYSTACK_SECRET_KEY is not a live key", operation)
        return {
            'status': False,
            'message': message,
            'error_code': 'paystack_live_key_required',
            'data': None,
        }
    
    def initialize_transaction(self, email, amount, reference, metadata=None):
        """Initialize a payment transaction"""
        url = f"{self.BASE_URL}/transaction/initialize"
        
        # Safe callback URL construction
        allowed_hosts = getattr(settings, 'ALLOWED_HOSTS', [])
        if allowed_hosts and allowed_hosts[0] != '*':
            host = allowed_hosts[0]
        else:
            host = getattr(settings, 'PAYSTACK_CALLBACK_HOST', 'localhost:8000')
        
        callback_url = getattr(
            settings, 
            'PAYSTACK_CALLBACK_URL',
            f"https://{host}/api/payments/verify_payment/"
        )
        
        payload = {
            'email': email,
            'amount': int(amount),
            'reference': reference,
            'currency': 'NGN',
            'callback_url': callback_url,
        }
        
        if metadata:
            payload['metadata'] = metadata
        
        try:
            response = requests.post(url, json=payload, headers=self.headers, timeout=self.request_timeout)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"Paystack initialize error: {e}")
            return {'status': False, 'message': str(e), 'data': None}
        except Exception as e:
            logger.error(f"Paystack initialize unexpected error: {e}")
            return {'status': False, 'message': str(e), 'data': None}
    
    def verify_transaction(self, reference):
        """Verify a payment transaction - NEVER returns None"""
        url = f"{self.BASE_URL}/transaction/verify/{reference}"
        try:
            response = requests.get(url, headers=self.headers, timeout=self.request_timeout)
            response.raise_for_status()
            result = response.json()
            if not isinstance(result, dict):
                return {'status': False, 'message': 'Invalid response format', 'data': {'status': 'failed'}}
            if 'data' not in result:
                result['data'] = {'status': 'failed'}
            if 'status' not in result:
                result['status'] = False
            return result
        except requests.exceptions.RequestException as e:
            logger.error(f"Paystack verify error: {e}")
            return {'status': False, 'message': str(e), 'data': {'status': 'failed'}}
        except Exception as e:
            logger.error(f"Paystack verify unexpected error: {e}")
            return {'status': False, 'message': str(e), 'data': {'status': 'failed'}}
    
    def create_recipient(self, name, account_number, bank_code):
        """Create a transfer recipient for bank transfer"""
        live_mode_error = self._require_live_mode('recipient creation')
        if live_mode_error:
            return live_mode_error

        url = f"{self.BASE_URL}/transferrecipient"
        payload = {
            "type": "nuban",
            "name": name,
            "account_number": account_number,
            "bank_code": bank_code,
            "currency": "NGN"
        }
        logger.info(
            "[Paystack %s] Creating recipient: %s, Acc: %s, Bank: %s",
            self.env_label,
            name,
            _mask_account_number(account_number),
            bank_code,
        )
        
        response = None
        try:
            response = requests.post(url, json=payload, headers=self.headers, timeout=self.request_timeout)
            response.raise_for_status()
            data = response.json()
            if data.get("status"):
                recipient_code = data.get("data", {}).get("recipient_code")
                return {"status": True, "recipient_code": recipient_code, "data": data.get("data", {})}
            return {"status": False, "message": data.get("message")}
        except requests.exceptions.RequestException as e:
            logger.error(f"Paystack create recipient error: {e}")
            return _paystack_error_response(e)
        except Exception as e:
            logger.error(f"Paystack create recipient error: {e}")
            return {"status": False, "message": str(e)}
        finally:
            if response is not None:
                response.close()
    
    def get_banks(self):
        """Get list of Nigerian banks"""
        url = f"{self.BASE_URL}/bank?country=nigeria"
        cache_key = "paystack:banks:nigeria"
        cached = cache.get(cache_key)
        if cached:
            return cached
        response = None
        try:
            response = requests.get(url, headers=self.headers, timeout=self.request_timeout)
            response.raise_for_status()
            result = response.json()
            cache.set(cache_key, result, 60 * 60 * 12)
            return result
        except Exception as e:
            logger.error(f"Paystack get banks error: {e}")
            return {'status': False, 'message': str(e), 'data': []}
    
    def verify_account(self, account_number, bank_code):
        payload = PaystackAccountResolutionService().resolve(account_number, bank_code)
        return PaystackAccountResolutionService.to_legacy_paystack_result(payload)


    def get_transfer_balance(self):
        """Get Paystack transfer wallet balance."""
        url = f"{self.BASE_URL}/balance"
        cache_key = "paystack:balance"
        cached = cache.get(cache_key)
        if cached:
            return cached
        try:
            response = requests.get(url, headers=self.headers, timeout=self.request_timeout)
            response.raise_for_status()
            result = response.json()
            cache.set(cache_key, result, 60)  # Cache for 60 seconds
            return result
        except requests.exceptions.RequestException as e:
            logger.error(f"Paystack balance error: {e}")
            return {'status': False, 'message': str(e), 'data': []}
        except Exception as e:
            logger.error(f"Paystack balance unexpected error: {e}")
            return {'status': False, 'message': str(e), 'data': []}
        finally:
            if response is not None:
                response.close()

    def initiate_transfer(self, amount, recipient_code, reference, reason='Salary payment'):
        """Initiate a single Paystack transfer."""
        live_mode_error = self._require_live_mode('transfer initiation')
        if live_mode_error:
            return live_mode_error

        url = f"{self.BASE_URL}/transfer"
        payload = {
            "source": "balance",
            "amount": int(amount),
            "recipient": recipient_code,
            "reference": reference,
            "reason": reason,
        }
        
        logger.info(f"[Paystack {self.env_label}] Initiating transfer to {recipient_code}. Amount: {amount/100} NGN. Ref: {reference}")

        response = None
        try:
            response = requests.post(url, json=payload, headers=self.headers, timeout=self.transfer_timeout)
            logger.debug(f"[Paystack {self.env_label}] Raw Response: {response.text}")
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            result = _paystack_error_response(e)
            logger.error(f"Paystack initiate transfer error: {result.get('message')} data={result.get('data')}")
            return result
        except Exception as e:
            logger.error(f"Paystack initiate transfer unexpected error: {e}")
            return {'status': False, 'message': str(e), 'data': None}
        finally:
            if response is not None:
                response.close()

    def bulk_transfer(self, transfers):
        """Initiate multiple Paystack transfers."""
        live_mode_error = self._require_live_mode('bulk transfer initiation')
        if live_mode_error:
            return live_mode_error

        url = f"{self.BASE_URL}/transfer/bulk"
        payload = {"currency": "NGN", "source": "balance", "transfers": transfers}
        response = None
        try:
            response = requests.post(url, json=payload, headers=self.headers, timeout=self.bulk_transfer_timeout)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            result = _paystack_error_response(e)
            logger.error(f"Paystack bulk transfer error: {result.get('message')} payload={result.get('data')}")
            return result
        except Exception as e:
            logger.error(f"Paystack bulk transfer unexpected error: {e}")
            return {'status': False, 'message': str(e), 'data': None}
        finally:
            if response is not None:
                response.close()

    def verify_transfer(self, reference):
        """Verify a Paystack transfer by reference."""
        url = f"{self.BASE_URL}/transfer/verify/{reference}"
        response = None
        try:
            response = requests.get(url, headers=self.headers, timeout=self.request_timeout)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            result = _paystack_error_response(e)
            logger.error(f"Paystack verify transfer error: {result.get('message')} data={result.get('data')}")
            return result
        except Exception as e:
            logger.error(f"Paystack verify transfer unexpected error: {e}")
            return {'status': False, 'message': str(e), 'data': {'status': 'failed'}}
        finally:
            if response is not None:
                response.close()
        
    def finalize_transfer(self, transfer_code, otp):
        """
        Finalizes a transfer that requires an OTP from Paystack.
        https://paystack.com/docs/api/transfer/#finalize-transfer
        """
        live_mode_error = self._require_live_mode('transfer finalization')
        if live_mode_error:
            return live_mode_error

        url = f"{self.BASE_URL}/transfer/finalize_transfer"
        headers = {
            "Authorization": f"Bearer {self.secret_key}",
            "Content-Type": "application/json"
        }
        payload = {
            "transfer_code": transfer_code,
            "otp": otp
        }
        response = None
        try:
            response = requests.post(url, headers=headers, json=payload, timeout=self.transfer_timeout)
            response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"Paystack finalize transfer error for transfer_code {transfer_code}: {e}")
            # Return a structured error response, including message from Paystack API if available
            error_message = str(e)
            if hasattr(e, 'response') and e.response is not None:
                try:
                    error_json = e.response.json()
                    error_message = error_json.get('message', error_message)
                except ValueError: # Not a JSON response
                    pass
            return {"status": False, "message": error_message, "error_code": "PAYSTACK_API_ERROR"}
        finally:
            if response is not None:
                response.close()

        
# Nigerian Bank Codes for Paystack
NIGERIAN_BANKS = {
    '044': 'Access Bank',
    '058': 'GTBank',
    '011': 'First Bank of Nigeria',
    '033': 'United Bank for Africa (UBA)',
    '057': 'Zenith Bank',
    '070': 'Fidelity Bank',
    '032': 'Union Bank of Nigeria',
    '232': 'Sterling Bank',
    '221': 'Stanbic IBTC Bank',
    '076': 'Polaris Bank',
    '035': 'Wema Bank',
    '050': 'Ecobank Nigeria',
    '214': 'First City Monument Bank (FCMB)',
    '082': 'Keystone Bank',
    '215': 'Unity Bank',
    '101': 'Providus Bank',
    '301': 'Jaiz Bank',
    '100': 'SunTrust Bank',
    '102': 'Titan Trust Bank',
    '608': 'CEMCS Microfinance Bank',
    '030': 'Heritage Bank',
    '302': 'Eartholeum',
    '307': 'Amju Unique Microfinance Bank',
    '512': 'eTranzact',
    '313': 'Mkudi',
    '314': 'FET',
    '315': 'GTMobile',
    '317': 'Cellulant',
    '318': 'FortisMicro',
    '319': 'Haggle Online',
    '320': 'TeasyMobile',
    '321': 'MoneyBox',
    '323': 'Access Money',
    '324': 'Hedonmark',
    '325': 'ZenithMobile',
    '326': 'Fortis Mobile',
    '327': 'TagPay',
    '328': 'PayAttitude Online',
    '329': 'Innovectives Kesh',
    '330': 'EcoMobile',
    '331': 'FCMB Easy Account',
    '332': 'Contec Global',
    '333': 'PalmPay',
    '334': 'Zenith Eazy Wallet',
    '335': 'eTranzact',
    '336': 'Stanbic Mobile Money',
    '337': 'VoguePay',
    '338': 'VTNetworks',
    '339': 'Paga',
    '401': 'Airtel Money',
    '402': 'Eyowo',
    '403': 'PalmPay',
    '404': 'Opay',
    '405': 'Kuda Bank',
    '406': 'FairMoney',
    '407': 'Carbon',
    '408': 'Branch',
    '409': 'Rubies Bank',
    '410': 'VBank',
    '411': 'Sparkle Bank',
    '412': 'Moniepoint',
    '413': 'Sudo',
    '414': 'Titan Paystack',
    '415': 'Yello Digital',
    '416': 'MoMo Payment',
    '417': 'ChamsMobile',
    '418': 'Paycom',
    '419': 'Quickteller',
    '420': 'FETS',
    '421': 'SystemSpecs',
    '422': 'Kudi Money',
    '423': 'Migo',
    '424': 'Paystack-Titan',
    '501': 'Parallex Bank',
    '502': 'Titan Trust Bank',
    '503': 'Globus Bank',
    '504': 'Premium Trust Bank',
    '505': 'Sunrise Microfinance Bank',
    '506': 'Baobab Microfinance Bank',
    '507': 'Microvis Microfinance Bank',
    '508': 'Fidelity Mobile',
    '509': 'MoneyTrust Microfinance Bank',
    '510': 'FBN Mortgages',
    '511': 'Imperial Homes Mortgage Bank',
    '513': 'New Prudential Bank',
    '514': 'Omega Microfinance Bank',
    '515': 'Gash Microfinance Bank',
    '516': 'Empire Trust Microfinance Bank',
    '517': 'IBank Microfinance Bank',
    '518': 'AltSchool Africa',
    '519': 'Rephidim Microfinance Bank',
    '520': 'Mainstreet Microfinance Bank',
    '521': 'Rehoboth Microfinance Bank',
    '522': 'Unical Microfinance Bank',
    '523': 'Aggressive Microfinance Bank',
    '524': 'Corestep Microfinance Bank',
    '525': 'Firmus Microfinance Bank',
    '526': 'Cedar Microfinance Bank',
    '527': 'Orokam Microfinance Bank',
    '528': 'Branch International Finance',
    '529': 'QuickCash Microfinance Bank',
    '530': 'Nova Merchant Bank',
    '531': 'VFD Microfinance Bank',
    '532': 'Lobrem Microfinance Bank',
    '533': 'Raven Bank',
    '534': 'Revenue Catalyst',
    '535': 'Chapel Hill Denham',
    '536': 'Safe Haven Microfinance Bank',
    '537': 'Assets Microfinance Bank',
    '538': 'FSDH Merchant Bank',
    '539': 'Coronation Merchant Bank',
    '540': 'Trustbanc J6 Microfinance Bank',
    '541': 'FBNQuest Merchant Bank',
    '542': 'Optimus Bank',
    '543': 'Platinum Mortgage Bank',
    '544': 'Aso Savings and Loans',
    '545': 'Gateway Mortgage Bank',
    '546': 'Brent Mortgage Bank',
    '547': 'Jubilee Life Mortgage Bank',
    '548': 'New Dawn Microfinance Bank',
    '549': 'Sterling Alternative Finance',
    '550': 'FSDH Merchant Bank',
    '551': 'CEMCS Microfinance Bank',
    '552': 'NPF Microfinance Bank',
    '553': 'NIRSAL Microfinance Bank',
    '554': 'AG Mortgage Bank',
    '555': 'Lagos Building Investment Company',
    '556': 'Akwa Savings and Loans',
    '557': 'Abbey Mortgage Bank',
    '558': 'Infinity Trust Mortgage Bank',
    '559': 'Mayfresh Mortgage Bank',
    '560': 'Resort Savings and Loans',
    '561': 'Coop Mortgage Bank',
    '562': 'Safetrust Mortgage Bank',
    '563': 'Trustbond Mortgage Bank',
    '564': 'Jubilee Life',
    '565': 'New Prudential Bank',
    '566': 'Imperial Homes',
    '567': 'Omega Bank',
    '568': 'Stanbic IBTC Bank',
    '569': 'Rand Merchant Bank',
    '570': 'Citi Bank',
    '571': 'Ecobank',
    '572': 'Heritage Banking Company',
    '573': 'Keystone Bank',
    '574': 'Providus Bank',
    '575': 'SunTrust Bank',
    '576': 'Union Bank',
    '577': 'Wema Bank',
    '578': 'Zenith Bank',
    '579': 'First Bank',
    '580': 'First City Monument Bank',
    '581': 'Guaranty Trust Bank',
    '582': 'United Bank for Africa',
    '583': 'Access Bank',
    '584': 'Diamond Bank',
    '585': 'Enterprise Bank',
    '586': 'MainStreet Bank',
    '587': 'Fidelity Bank',
    '588': 'Polaris Bank',
    '589': 'Unity Bank',
    '590': 'Jaiz Bank',
    '591': 'Sterling Bank',
    '592': 'Standard Chartered Bank',
    '593': 'Bank of Industry',
    '594': 'Bank of Agriculture',
    '595': 'Development Bank of Nigeria',
    '596': 'Family Homes Fund',
    '597': 'Federal Mortgage Bank of Nigeria',
    '598': 'Nigeria Export-Import Bank',
    '599': 'Nigeria Mortgage Refinance Company',
    '600': 'African Development Bank',
    '601': 'Arab Bank for Economic Development',
    '602': 'Bank of the North',
    '603': 'Central Bank of Nigeria',
    '604': 'Citibank Nigeria',
    '605': 'Ecobank Nigeria',
    '606': 'Fidelity Bank Nigeria',
    '607': 'First Bank of Nigeria',
    '608': 'First City Monument Bank',
    '609': 'Guaranty Trust Bank',
    '610': 'Heritage Banking Company',
    '611': 'Jaiz Bank',
    '612': 'Keystone Bank',
    '613': 'Polaris Bank',
    '614': 'Providus Bank',
    '615': 'Stanbic IBTC Bank',
    '616': 'Standard Chartered Bank',
    '617': 'Sterling Bank',
    '618': 'SunTrust Bank',
    '619': 'Union Bank of Nigeria',
    '620': 'United Bank for Africa',
    '621': 'Unity Bank',
    '622': 'Wema Bank',
    '623': 'Zenith Bank',
    '624': 'Access Bank',
    '625': 'Diamond Bank',
    '626': 'Enterprise Bank',
    '627': 'MainStreet Bank',
    '628': 'Fidelity Bank',
    '629': 'Polaris Bank',
    '630': 'Unity Bank',
    '631': 'Jaiz Bank',
    '632': 'Sterling Bank',
    '633': 'Standard Chartered Bank',
    '634': 'Bank of Industry',
    '635': 'Bank of Agriculture',
    '636': 'Development Bank of Nigeria',
    '637': 'Family Homes Fund',
    '638': 'Federal Mortgage Bank of Nigeria',
    '639': 'Nigeria Export-Import Bank',
    '640': 'Nigeria Mortgage Refinance Company',
    '641': 'African Development Bank',
    '642': 'Arab Bank for Economic Development',
    '643': 'Bank of the North',
    '644': 'Central Bank of Nigeria',
    '645': 'Citibank Nigeria',
    '646': 'Ecobank Nigeria',
    '647': 'Fidelity Bank Nigeria',
    '648': 'First Bank of Nigeria',
    '649': 'First City Monument Bank',
    '650': 'Guaranty Trust Bank',
    '651': 'Heritage Banking Company',
    '652': 'Jaiz Bank',
    '653': 'Keystone Bank',
    '654': 'Polaris Bank',
    '655': 'Providus Bank',
    '656': 'Stanbic IBTC Bank',
    '657': 'Standard Chartered Bank',
    '658': 'Sterling Bank',
    '659': 'SunTrust Bank',
    '660': 'Union Bank of Nigeria',
    '661': 'United Bank for Africa',
    '662': 'Unity Bank',
    '663': 'Wema Bank',
    '664': 'Zenith Bank',
    '665': 'Access Bank',
    '666': 'Diamond Bank',
    '667': 'Enterprise Bank',
    '668': 'MainStreet Bank',
    '669': 'Fidelity Bank',
    '670': 'Polaris Bank',
    '671': 'Unity Bank',
    '672': 'Jaiz Bank',
    '673': 'Sterling Bank',
    '674': 'Standard Chartered Bank',
    '675': 'Bank of Industry',
    '676': 'Bank of Agriculture',
    '677': 'Development Bank of Nigeria',
    '678': 'Family Homes Fund',
    '679': 'Federal Mortgage Bank of Nigeria',
    '680': 'Nigeria Export-Import Bank',
    '681': 'Nigeria Mortgage Refinance Company',
    '682': 'African Development Bank',
    '683': 'Arab Bank for Economic Development',
    '684': 'Bank of the North',
    '685': 'Central Bank of Nigeria',
    '686': 'Citibank Nigeria',
    '687': 'Ecobank Nigeria',
    '688': 'Fidelity Bank Nigeria',
    '689': 'First Bank of Nigeria',
    '690': 'First City Monument Bank',
    '691': 'Guaranty Trust Bank',
    '692': 'Heritage Banking Company',
    '693': 'Jaiz Bank',
    '694': 'Keystone Bank',
    '695': 'Polaris Bank',
    '696': 'Providus Bank',
    '697': 'Stanbic IBTC Bank',
    '698': 'Standard Chartered Bank',
    '699': 'Sterling Bank',
    '700': 'SunTrust Bank',
    '701': 'Union Bank of Nigeria',
    '702': 'United Bank for Africa',
    '703': 'Unity Bank',
    '704': 'Wema Bank',
    '705': 'Zenith Bank',
    '706': 'Access Bank',
    '707': 'Diamond Bank',
    '708': 'Enterprise Bank',
    '709': 'MainStreet Bank',
    '710': 'Fidelity Bank',
    '711': 'Polaris Bank',
    '712': 'Unity Bank',
    '713': 'Jaiz Bank',
    '714': 'Sterling Bank',
    '715': 'Standard Chartered Bank',
    '716': 'Bank of Industry',
    '717': 'Bank of Agriculture',
    '718': 'Development Bank of Nigeria',
    '719': 'Family Homes Fund',
    '720': 'Federal Mortgage Bank of Nigeria',
    '721': 'Nigeria Export-Import Bank',
    '722': 'Nigeria Mortgage Refinance Company',
    '723': 'African Development Bank',
    '724': 'Arab Bank for Economic Development',
    '725': 'Bank of the North',
    '726': 'Central Bank of Nigeria',
    '727': 'Citibank Nigeria',
    '728': 'Ecobank Nigeria',
    '729': 'Fidelity Bank Nigeria',
    '730': 'First Bank of Nigeria',
    '731': 'First City Monument Bank',
    '732': 'Guaranty Trust Bank',
    '733': 'Heritage Banking Company',
    '734': 'Jaiz Bank',
    '735': 'Keystone Bank',
    '736': 'Polaris Bank',
    '737': 'Providus Bank',
    '738': 'Stanbic IBTC Bank',
    '739': 'Standard Chartered Bank',
    '740': 'Sterling Bank',
    '741': 'SunTrust Bank',
    '742': 'Union Bank of Nigeria',
    '743': 'United Bank for Africa',
    '744': 'Unity Bank',
    '745': 'Wema Bank',
    '746': 'Zenith Bank',
    '747': 'Access Bank',
    '748': 'Diamond Bank',
    '749': 'Enterprise Bank',
    '750': 'MainStreet Bank',
    '751': 'Fidelity Bank',
    '752': 'Polaris Bank',
    '753': 'Unity Bank',
    '754': 'Jaiz Bank',
    '755': 'Sterling Bank',
    '756': 'Standard Chartered Bank',
    '757': 'Bank of Industry',
    '758': 'Bank of Agriculture',
    '759': 'Development Bank of Nigeria',
    '760': 'Family Homes Fund',
    '761': 'Federal Mortgage Bank of Nigeria',
    '762': 'Nigeria Export-Import Bank',
    '763': 'Nigeria Mortgage Refinance Company',
    '764': 'African Development Bank',
    '765': 'Arab Bank for Economic Development',
    '766': 'Bank of the North',
    '767': 'Central Bank of Nigeria',
    '768': 'Citibank Nigeria',
    '769': 'Ecobank Nigeria',
    '770': 'Fidelity Bank Nigeria',
    '771': 'First Bank of Nigeria',
    '772': 'First City Monument Bank',
    '773': 'Guaranty Trust Bank',
    '774': 'Heritage Banking Company',
    '775': 'Jaiz Bank',
    '776': 'Keystone Bank',
    '777': 'Polaris Bank',
    '778': 'Providus Bank',
    '779': 'Stanbic IBTC Bank',
    '780': 'Standard Chartered Bank',
    '781': 'Sterling Bank',
    '782': 'SunTrust Bank',
    '783': 'Union Bank of Nigeria',
    '784': 'United Bank for Africa',
    '785': 'Unity Bank',
    '786': 'Wema Bank',
    '787': 'Zenith Bank',
    '788': 'Access Bank',
    '789': 'Diamond Bank',
    '790': 'Enterprise Bank',
    '791': 'MainStreet Bank',
    '792': 'Fidelity Bank',
    '793': 'Polaris Bank',
    '794': 'Unity Bank',
    '795': 'Jaiz Bank',
    '796': 'Sterling Bank',
    '797': 'Standard Chartered Bank',
    '798': 'Bank of Industry',
    '799': 'Bank of Agriculture',
    '800': 'Development Bank of Nigeria',
    '801': 'Family Homes Fund',
    '802': 'Federal Mortgage Bank of Nigeria',
    '803': 'Nigeria Export-Import Bank',
    '804': 'Nigeria Mortgage Refinance Company',
    '805': 'African Development Bank',
    '806': 'Arab Bank for Economic Development',
    '807': 'Bank of the North',
    '808': 'Central Bank of Nigeria',
    '809': 'Citibank Nigeria',
    '810': 'Ecobank Nigeria',
    '811': 'Fidelity Bank Nigeria',
    '812': 'First Bank of Nigeria',
    '813': 'First City Monument Bank',
    '814': 'Guaranty Trust Bank',
    '815': 'Heritage Banking Company',
    '816': 'Jaiz Bank',
    '817': 'Keystone Bank',
    '818': 'Polaris Bank',
    '819': 'Providus Bank',
    '820': 'Stanbic IBTC Bank',
    '821': 'Standard Chartered Bank',
    '822': 'Sterling Bank',
    '823': 'SunTrust Bank',
    '824': 'Union Bank of Nigeria',
    '825': 'United Bank for Africa',
    '826': 'Unity Bank',
    '827': 'Wema Bank',
    '828': 'Zenith Bank',
    '829': 'Access Bank',
    '830': 'Diamond Bank',
    '831': 'Enterprise Bank',
    '832': 'MainStreet Bank',
    '833': 'Fidelity Bank',
    '834': 'Polaris Bank',
    '835': 'Unity Bank',
    '836': 'Jaiz Bank',
    '837': 'Sterling Bank',
    '838': 'Standard Chartered Bank',
    '839': 'Bank of Industry',
    '840': 'Bank of Agriculture',
    '841': 'Development Bank of Nigeria',
    '842': 'Family Homes Fund',
    '843': 'Federal Mortgage Bank of Nigeria',
    '844': 'Nigeria Export-Import Bank',
    '845': 'Nigeria Mortgage Refinance Company',
    '846': 'African Development Bank',
    '847': 'Arab Bank for Economic Development',
    '848': 'Bank of the North',
    '849': 'Central Bank of Nigeria',
    '850': 'Citibank Nigeria',
    '851': 'Ecobank Nigeria',
    '852': 'Fidelity Bank Nigeria',
    '853': 'First Bank of Nigeria',
    '854': 'First City Monument Bank',
    '855': 'Guaranty Trust Bank',
    '856': 'Heritage Banking Company',
    '857': 'Jaiz Bank',
    '858': 'Keystone Bank',
    '859': 'Polaris Bank',
    '860': 'Providus Bank',
    '861': 'Stanbic IBTC Bank',
    '862': 'Standard Chartered Bank',
    '863': 'Sterling Bank',
    '864': 'SunTrust Bank',
    '865': 'Union Bank of Nigeria',
    '866': 'United Bank for Africa',
    '867': 'Unity Bank',
    '868': 'Wema Bank',
    '869': 'Zenith Bank',
    '870': 'Access Bank',
    '871': 'Diamond Bank',
    '872': 'Enterprise Bank',
    '873': 'MainStreet Bank',
    '874': 'Fidelity Bank',
    '875': 'Polaris Bank',
    '876': 'Unity Bank',
    '877': 'Jaiz Bank',
    '878': 'Sterling Bank',
    '879': 'Standard Chartered Bank',
    '880': 'Bank of Industry',
    '881': 'Bank of Agriculture',
    '882': 'Development Bank of Nigeria',
    '883': 'Family Homes Fund',
    '884': 'Federal Mortgage Bank of Nigeria',
    '885': 'Nigeria Export-Import Bank',
    '886': 'Nigeria Mortgage Refinance Company',
    '887': 'African Development Bank',
    '888': 'Arab Bank for Economic Development',
    '889': 'Bank of the North',
    '890': 'Central Bank of Nigeria',
    '891': 'Citibank Nigeria',
    '892': 'Ecobank Nigeria',
    '893': 'Fidelity Bank Nigeria',
    '894': 'First Bank of Nigeria',
    '895': 'First City Monument Bank',
    '896': 'Guaranty Trust Bank',
    '897': 'Heritage Banking Company',
    '898': 'Jaiz Bank',
    '899': 'Keystone Bank',
    '900': 'Polaris Bank',
    '901': 'Providus Bank',
    '902': 'Stanbic IBTC Bank',
    '903': 'Standard Chartered Bank',
    '904': 'Sterling Bank',
    '905': 'SunTrust Bank',
    '906': 'Union Bank of Nigeria',
    '907': 'United Bank for Africa',
    '908': 'Unity Bank',
    '909': 'Wema Bank',
    '910': 'Zenith Bank',
    '911': 'Access Bank',
    '912': 'Diamond Bank',
    '913': 'Enterprise Bank',
    '914': 'MainStreet Bank',
    '915': 'Fidelity Bank',
    '916': 'Polaris Bank',
    '917': 'Unity Bank',
    '918': 'Jaiz Bank',
    '919': 'Sterling Bank',
    '920': 'Standard Chartered Bank',
    '921': 'Bank of Industry',
    '922': 'Bank of Agriculture',
    '923': 'Development Bank of Nigeria',
    '924': 'Family Homes Fund',
    '925': 'Federal Mortgage Bank of Nigeria',
    '926': 'Nigeria Export-Import Bank',
    '927': 'Nigeria Mortgage Refinance Company',
    '928': 'African Development Bank',
    '929': 'Arab Bank for Economic Development',
    '930': 'Bank of the North',
    '931': 'Central Bank of Nigeria',
    '932': 'Citibank Nigeria',
    '933': 'Ecobank Nigeria',
    '934': 'Fidelity Bank Nigeria',
    '935': 'First Bank of Nigeria',
    '936': 'First City Monument Bank',
    '937': 'Guaranty Trust Bank',
    '938': 'Heritage Banking Company',
    '939': 'Jaiz Bank',
    '940': 'Keystone Bank',
    '941': 'Polaris Bank',
    '942': 'Providus Bank',
    '943': 'Stanbic IBTC Bank',
    '944': 'Standard Chartered Bank',
    '945': 'Sterling Bank',
    '946': 'SunTrust Bank',
    '947': 'Union Bank of Nigeria',
    '948': 'United Bank for Africa',
    '949': 'Unity Bank',
    '950': 'Wema Bank',
    '951': 'Zenith Bank',
    '952': 'Access Bank',
    '953': 'Diamond Bank',
    '954': 'Enterprise Bank',
    '955': 'MainStreet Bank',
    '956': 'Fidelity Bank',
    '957': 'Polaris Bank',
    '958': 'Unity Bank',
    '959': 'Jaiz Bank',
    '960': 'Sterling Bank',
    '961': 'Standard Chartered Bank',
    '962': 'Bank of Industry',
    '963': 'Bank of Agriculture',
    '964': 'Development Bank of Nigeria',
    '965': 'Family Homes Fund',
    '966': 'Federal Mortgage Bank of Nigeria',
    '967': 'Nigeria Export-Import Bank',
    '968': 'Nigeria Mortgage Refinance Company',
    '969': 'African Development Bank',
    '970': 'Arab Bank for Economic Development',
    '971': 'Bank of the North',
    '972': 'Central Bank of Nigeria',
    '973': 'Citibank Nigeria',
    '974': 'Ecobank Nigeria',
    '975': 'Fidelity Bank Nigeria',
    '976': 'First Bank of Nigeria',
    '977': 'First City Monument Bank',
    '978': 'Guaranty Trust Bank',
    '979': 'Heritage Banking Company',
    '980': 'Jaiz Bank',
    '981': 'Keystone Bank',
    '982': 'Polaris Bank',
    '983': 'Providus Bank',
    '984': 'Stanbic IBTC Bank',
    '985': 'Standard Chartered Bank',
    '986': 'Sterling Bank',
    '987': 'SunTrust Bank',
    '988': 'Union Bank of Nigeria',
    '989': 'United Bank for Africa',
    '990': 'Unity Bank',
    '991': 'Wema Bank',
    '992': 'Zenith Bank',
    '993': 'Access Bank',
    '994': 'Diamond Bank',
    '995': 'Enterprise Bank',
    '996': 'MainStreet Bank',
    '997': 'Fidelity Bank',
    '998': 'Polaris Bank',
    '999': 'Unity Bank',
}
