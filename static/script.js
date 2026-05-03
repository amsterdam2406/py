/**
 * Fotasco Payroll - Production Ready JavaScript
 * DRF API Integration with JWT Authentication
 * Version: 5.0.0 - All Critical Fixes Applied
 */

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
    API_BASE_URL: window.location.origin,  // FIXED: Dynamic base URL
    TOKEN_REFRESH_INTERVAL: 25 * 60 * 1000, // FIXED: Match 30min token - 5min buffer
    MAX_LOGIN_ATTEMPTS: 5,
    LOCKOUT_DURATION: 15 * 60 * 1000,
    DEBOUNCE_DELAY: 300,
    CAMERA_QUALITY: 0.8,
    TOAST_DURATION: 5000,
    PAGE_SIZE: 20
};

// ==========================================
// STATE MANAGEMENT
// ==========================================
const AppState = {
    employees: [],
    companies: [],
    deductions: [],
    payments: [],
    notifications: [],
    attendance: [],
    currentUser: null,
    accessToken: null,
    refreshToken: null,
    currentPaymentReference: null,
    currentEditingDeductionId: null,
    currentEditingCompanyId: null,
    cameraStream: null,
    capturedImageBlob: null,
    otpTimerInterval: null,
    loginAttempts: 0,
    loginLockedUntil: null,
    selectedEmployeesForBulk: new Set(),
    bankList: [],
    lastVerifiedAccountKey: null,
    pendingAccountVerificationKey: null,
    paymentPollInterval: null,
    paymentPollInterval: null,
    bulkPollInterval: null,
    
    elements: {
        tbody: null,
        deductionsTbody: null,
        attendanceTbody: null,
        companiesTbody: null,
        sackedTbody: null,
        paymentsTbody: null,
        historyTbody: null,
        notificationsContainer: null,
        toastContainer: null,
        globalSpinner: null
    }
};

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

function escapeHtml(text) {
    if (typeof text !== 'string') return text;
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function debounce(fn, delay = CONFIG.DEBOUNCE_DELAY) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), delay);
    };
}

function formatCurrency(amount, currency = '₦') {
    const num = Number(amount) || 0;
    return `${currency}${num.toLocaleString('en-NG')}`;
}

function formatDate(dateString) {
    if (!dateString) return '-';
    try {
        return new Date(dateString).toLocaleDateString('en-NG');
    } catch {
        return dateString;
    }
}

function buildUrl(url, params = {}) {
    const query = new URLSearchParams(params).toString();
    return query ? `${url}?${query}` : url;
}

function idsMatch(left, right) {
    return String(left) === String(right);
}

function isJwtExpired(token) {
    if (!token) return true;
    try {
        const [, payload] = token.split('.');
        if (!payload) return true;
        const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/');
        const paddedPayload = normalizedPayload.padEnd(Math.ceil(normalizedPayload.length / 4) * 4, '=');
        const data = JSON.parse(atob(paddedPayload));
        return !data.exp || Date.now() >= (data.exp * 1000) - 30000;
    } catch (err) {
        console.warn('Could not parse JWT expiry:', err);
        return true;
    }
}

// ==========================================
// UI HELPERS
// ==========================================

function showLoading(btn, spinnerEl) {
    try {
        if (btn && !btn.disabled) {
            btn.disabled = true;
            btn.dataset.originalText = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
        }
        const spinner = spinnerEl || AppState.elements.globalSpinner;
        if (spinner) spinner.classList.remove('hidden');
    } catch (error) {
        console.error('Error in showLoading:', error);
    }
}

function hideLoading(btn, spinnerEl) {
    try {
        if (btn && btn.disabled) {
            btn.disabled = false;
            if (btn.dataset.originalText) {
                btn.innerHTML = btn.dataset.originalText;
                delete btn.dataset.originalText;
            }
        }
        const spinner = spinnerEl || AppState.elements.globalSpinner;
        if (spinner) spinner.classList.add('hidden');
    } catch (error) {
        console.error('Error in hideLoading:', error);
    }
}

function showToast(message, type = 'info', duration = CONFIG.TOAST_DURATION) {
    const container = AppState.elements.toastContainer || document.getElementById('toastContainer');
    if (!container) {
        console.warn('Toast container not found:', message);
        return;
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <div class="toast-content">
            <div class="toast-message">${escapeHtml(message)}</div>
        </div>
        <button class="toast-close" aria-label="Close">×</button>
    `;
    toast.querySelector('.toast-close').addEventListener('click', () => closeToast(toast));
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    if (duration > 0) setTimeout(() => closeToast(toast), duration);
}

function closeToast(toast) {
    if (!toast) return;
    toast.classList.remove('show');
    setTimeout(() => toast?.remove(), 300);
}

function showSection(id) {
    document.querySelectorAll('.content-section').forEach(sec => sec.classList.remove('active'));
    const section = document.getElementById(id);
    if (section) section.classList.add('active');
    const sidebar = document.getElementById('sidebar');
    if (sidebar && window.innerWidth <= 768) sidebar.classList.remove('active');
    document.querySelectorAll('.sidebar-menu a').forEach(link => {
        const isActive = link.getAttribute('onclick')?.includes(`'${id}'`);
        link.classList.toggle('active', isActive);
    });

    // Load data for specific sections
    if (id === 'payments') {
        populatePaymentsTable();
    }
}

function openModal(id) {
    const modal = document.getElementById(id);
    if (!modal) {
        console.warn(`Modal not found: ${id}`);
        return;
    }
    modal.classList.add('active');
    if (id === 'clockInModal') {
        startCamera();
        document.getElementById('markWithoutSelfie')?.addEventListener('change', toggleCamera);
        toggleCamera();
    }
    if (id === 'addCompanyModal') {
        AppState.currentEditingCompanyId = null;
        populateCompanyGuards();
    }
    if (id === 'bulkPaymentModal') {
        populateBulkTable();
        updateBulkTotal(); // ADDED: Calculate initial total
    }
    if (id === 'individualPaymentModal') {
        populateEmployeeSelect('paymentEmployee');
        document.getElementById('paymentPreview').style.display = 'none';
    }
    // ADDED: Initialize leave modal dates
    if (id === 'leaveModal') {
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('leaveStartDate').value = today;
        document.getElementById('leaveEndDate').value = today;
        populateEmployeeSelect('leaveEmployee');
    }
}

function closeModal(id) {
    if (id === 'clockInModal' && AppState.cameraStream) {
        AppState.cameraStream.getTracks().forEach(track => track.stop());
        AppState.cameraStream = null;
    }
    
    // Stop payment polling when closing payment modals
    if (id === 'individualPaymentModal' || id === 'bulkPaymentModal') {
        if (AppState.paymentPollInterval) {
            clearInterval(AppState.paymentPollInterval);
            AppState.paymentPollInterval = null;
        }
        if (AppState.bulkPollInterval) {
            clearInterval(AppState.bulkPollInterval);
            AppState.bulkPollInterval = null;
        }
    }
    
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('active');
}

// ==========================================
// API COMMUNICATION
// ==========================================

async function apiRequest(url, options = {}) {
    // FIXED: Ensure proper URL construction
    const baseUrl = window.location.origin;
    const fullUrl = url.startsWith('http') ? url : `${baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
    
    const token = AppState.accessToken || localStorage.getItem('accessToken');
    
    const headers = {
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...options.headers
    };

    const fetchOptions = {
        method: options.method || 'GET',
        headers,
        body: options.body instanceof FormData 
            ? options.body 
            : (options.body ? JSON.stringify(options.body) : null)
    };

    try {
        const response = await fetch(fullUrl, fetchOptions);

        if (response.status === 401) {
            if (url.includes('/login/')) {
                return { success: false, status: response.status, message: 'Invalid credentials' };
            }
            const refreshed = await refreshAccessToken();
            if (refreshed) return apiRequest(url, options);
            logout();
            showToast('Session expired. Please login again.', 'error');
            return { success: false, status: response.status, message: 'Session expired. Please login again.' };
        }

        if (response.status === 429) {
            const errorData = await response.json().catch(() => ({}));
            const waitTime = errorData.detail?.match(/\d+/)?.[0] || 'unknown';
            return { 
                success: false, 
                status: response.status,
                message: `Too many requests. Please wait ${waitTime} seconds.` 
            };
        }

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            return { 
                success: false, 
                status: response.status,
                data,
                message: data.detail || data.error || data.message || `Request failed (${response.status})` 
            };
        }

        return { success: true, status: response.status, data };

    } catch (err) {
        console.error('API Error:', err);
        return { success: false, message: err.message || 'Network error. Check connection.' };
    }
}

async function refreshAccessToken() {
    try {
        // FIXED: Try localStorage first, then cookie
        const refreshToken = AppState.refreshToken || 
                            localStorage.getItem('refreshToken') || 
                            getCookie('refresh_token');
        
        if (!refreshToken) return false;

        const response = await fetch('/api/token/refresh/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh: refreshToken })
        });

        if (!response.ok) {
            localStorage.removeItem('refreshToken');
            return false;
        }

        const data = await response.json();
        AppState.accessToken = data.access;
        localStorage.setItem('accessToken', data.access);
        sessionStorage.setItem('accessToken', data.access);
        
        // If new refresh token returned, update it
        if (data.refresh) {
            AppState.refreshToken = data.refresh;
            localStorage.setItem('refreshToken', data.refresh);
        }
        
        return true;

    } catch (err) {
        return false;
    }
}

// ADDED: Helper to get cookie value
function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return parts.pop().split(';').shift();
    return null;
}

// ==========================================
// NIGERIAN BANKS AUTO-LOADING
// ==========================================

// ==========================================
// FIXED: NIGERIAN BANKS AUTO-LOADING
// ==========================================

async function loadNigerianBanks() {
    try {
        const res = await apiRequest('/api/paystack/banks/');
        if (res.success && res.data?.data) {
            AppState.bankList = res.data.data;
            populateBankSelects();
        }
    } catch (err) {
        console.warn('Failed to load Nigerian banks, using fallback:', err);
        // Use fallback list with proper codes
        AppState.bankList = [
            {name: 'Access Bank', code: '044'},
            {name: 'GTBank', code: '058'},
            {name: 'First Bank of Nigeria', code: '011'},
            {name: 'United Bank for Africa', code: '033'},
            {name: 'Zenith Bank', code: '057'},
            {name: 'Fidelity Bank', code: '070'},
            {name: 'Union Bank of Nigeria', code: '032'},
            {name: 'Sterling Bank', code: '232'},
            {name: 'Stanbic IBTC Bank', code: '221'},
            {name: 'Polaris Bank', code: '076'},
            {name: 'Wema Bank', code: '035'},
            {name: 'Ecobank Nigeria', code: '050'},
            {name: 'First City Monument Bank', code: '214'},
            {name: 'Keystone Bank', code: '082'}
        ];
        populateBankSelects();
    }
}

function populateBankSelects() {
    const bankSelects = [
        document.getElementById('accountBankName'),
        document.getElementById('newEmployeeBankName')
    ];
    
    bankSelects.forEach(select => {
        if (!select) return;
        const currentValue = select.value;
        select.innerHTML = '<option value="">Select Bank</option>';
        
        AppState.bankList.forEach(bank => {
            const option = document.createElement('option');
            option.value = bank.name;
            option.textContent = bank.name;
            option.dataset.code = bank.code; // Store Paystack code directly
            select.appendChild(option);
        });
        
        if (currentValue && AppState.bankList.find(b => b.name === currentValue)) {
            select.value = currentValue;
        }
    });
}

function setAccountVerificationStatus(statusEl, message, className = 'text-muted') {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = className;
}

async function verifyBankAccountFields({ accountInput, bankSelect, holderInput, statusEl, manual = false }) {
    const accountNumber = accountInput?.value.trim();
    const selectedOption = bankSelect?.options[bankSelect.selectedIndex];
    const bankCode = selectedOption?.dataset?.code;
    const verificationKey = `${bankCode || ''}:${accountNumber || ''}`;

    if (!accountNumber || !/^\d{10}$/.test(accountNumber)) {
        if (manual) showToast('Enter valid 10-digit account number', 'error');
        return false;
    }
    if (!bankCode) {
        if (manual) showToast('Select a valid bank first', 'error');
        return false;
    }
    if (AppState.pendingAccountVerificationKey === verificationKey) {
        if (manual) showToast('Verification already in progress', 'info');
        return false;
    }
    if (AppState.lastVerifiedAccountKey === verificationKey && holderInput?.value.trim()) {
        setAccountVerificationStatus(statusEl, `Verified: ${holderInput.value.trim()}`, 'text-success');
        return true;
    }

    AppState.pendingAccountVerificationKey = verificationKey;
    holderInput.value = 'Verifying...';
    holderInput.disabled = true;
    holderInput.readOnly = true;
    holderInput.style.background = '#f8f9fa';
    setAccountVerificationStatus(statusEl, 'Verifying with Paystack...', 'text-info');

    try {
        const res = await apiRequest('/api/paystack/verify-account/', {
            method: 'POST',
            body: { account_number: accountNumber, bank_code: bankCode }
        });

        if (res.success && res.data?.status === true && res.data?.data?.account_name) {
            holderInput.value = res.data.data.account_name;
            holderInput.style.background = '#d4edda';
            AppState.lastVerifiedAccountKey = verificationKey;
            setAccountVerificationStatus(statusEl, `Verified: ${res.data.data.account_name}`, 'text-success');
            if (manual) showToast('Account verified successfully', 'success');
            return true;
        }

        holderInput.value = '';
        holderInput.style.background = '#f8d7da';
        AppState.lastVerifiedAccountKey = null;
        setAccountVerificationStatus(
            statusEl,
            res.message || res.data?.message || 'Account could not be verified. Check bank and account number.',
            'text-danger'
        );
        if (manual) showToast(res.message || res.data?.message || 'Verification failed', 'error');
        return false;
    } catch (err) {
        holderInput.value = '';
        holderInput.style.background = '#f8d7da';
        AppState.lastVerifiedAccountKey = null;
        setAccountVerificationStatus(statusEl, 'Verification service unavailable. Try again later.', 'text-warning');
        if (manual) showToast('Verification service unavailable', 'error');
        return false;
    } finally {
        AppState.pendingAccountVerificationKey = null;
        holderInput.disabled = false;
        holderInput.readOnly = true;
        holderInput.placeholder = 'Auto-filled after verification';
    }
}

function setupAccountVerification({ accountInputId, bankSelectId, holderInputId, statusId }) {
    const accountInput = document.getElementById(accountInputId);
    const bankSelect = document.getElementById(bankSelectId);
    const holderInput = document.getElementById(holderInputId);
    const statusEl = document.getElementById(statusId);

    if (!accountInput || !bankSelect || !holderInput) return null;

    holderInput.readOnly = true;
    const verifyCurrentAccount = debounce(() => verifyBankAccountFields({
        accountInput, bankSelect, holderInput, statusEl
    }), 800);

    accountInput.addEventListener('input', () => {
        holderInput.value = '';
        holderInput.style.background = '#f8f9fa';
        AppState.lastVerifiedAccountKey = null;
        if (accountInput.value.trim().length === 10) {
            verifyCurrentAccount();
        } else {
            setAccountVerificationStatus(statusEl, 'Enter 10-digit account number to auto-verify', 'text-muted');
        }
    });

    bankSelect.addEventListener('change', () => {
        holderInput.value = '';
        holderInput.style.background = '#f8f9fa';
        AppState.lastVerifiedAccountKey = null;
        setAccountVerificationStatus(statusEl, 'Enter 10-digit account number to auto-verify', 'text-muted');
        if (accountInput.value.trim().length === 10) verifyCurrentAccount();
    });

    return { accountInput, bankSelect, holderInput, statusEl };
}

// ==========================================
// FIXED: AUTO BANK VERIFICATION & NAME FILL
// ==========================================

function setupBankVerification() {
    setupAccountVerification({
        accountInputId: 'accountNumber',
        bankSelectId: 'accountBankName',
        holderInputId: 'accountHolderName',
        statusId: 'verificationStatus'
    });
    setupAccountVerification({
        accountInputId: 'newEmployeeAccountNumber',
        bankSelectId: 'newEmployeeBankName',
        holderInputId: 'newEmployeeAccountHolder',
        statusId: 'newEmployeeVerificationStatus'
    });
    return;

    const accountInput = document.getElementById('accountNumber');
    const bankSelect = document.getElementById('accountBankName');
    const holderInput = document.getElementById('accountHolderName');
    const statusEl = document.getElementById('verificationStatus');
    
    if (!accountInput || !bankSelect || !holderInput) return;

    const verifyCurrentAccount = debounce(async () => {
        const accountNumber = accountInput.value.trim();
        const selectedOption = bankSelect.options[bankSelect.selectedIndex];
        const bankCode = selectedOption?.dataset?.code;
        const verificationKey = `${bankCode || ''}:${accountNumber}`;
        
        if (accountNumber.length !== 10 || !bankCode) return;
        if (AppState.lastVerifiedAccountKey === verificationKey) return;
        if (AppState.pendingAccountVerificationKey === verificationKey) return;
        AppState.pendingAccountVerificationKey = verificationKey;
        
        // Show verifying state
        holderInput.placeholder = 'Verifying account...';
        holderInput.disabled = true;
        if (statusEl) {
            statusEl.textContent = 'Verifying account...';
            statusEl.className = 'text-info';
        }
        
        try {
            const res = await apiRequest('/api/paystack/verify-account/', {
                method: 'POST',
                body: {
                    account_number: accountNumber,
                    bank_code: bankCode
                }
            });
            
            // FIXED: Check Paystack response format properly
            if (res.success && res.data?.status === true && res.data?.data?.account_name) {
                holderInput.value = res.data.data.account_name;
                holderInput.style.background = '#d4edda'; // Light green
                AppState.lastVerifiedAccountKey = verificationKey;
                if (statusEl) {
                    statusEl.textContent = `Verified: ${res.data.data.account_name}`;
                    statusEl.className = 'text-success';
                }
                showToast(`✓ Verified: ${res.data.data.account_name}`, 'success');
            } else {
                holderInput.value = '';
                holderInput.style.background = '#f8d7da'; // Light red
                const msg = res.message || res.data?.message || 'Account could not be verified. Check bank and account number.';
                AppState.lastVerifiedAccountKey = null;
                if (statusEl) {
                    statusEl.textContent = msg;
                    statusEl.className = 'text-warning';
                }
                holderInput.readOnly = true;
            }
        } catch (err) {
            console.error('Verification error:', err);
            holderInput.value = '';
            holderInput.readOnly = true;
            AppState.lastVerifiedAccountKey = null;
            if (statusEl) {
                statusEl.textContent = 'Verification service unavailable. Try again later.';
                statusEl.className = 'text-warning';
            }
        } finally {
            AppState.pendingAccountVerificationKey = null;
            holderInput.disabled = false;
            holderInput.placeholder = 'Account Holder Name';
        }
    }, 800);

    accountInput.addEventListener('input', verifyCurrentAccount);
    bankSelect.addEventListener('change', () => {
        AppState.lastVerifiedAccountKey = null;
        holderInput.value = '';
        holderInput.style.background = '';
        if (statusEl) {
            statusEl.textContent = 'Enter account number and leave field to auto-verify';
            statusEl.className = 'text-muted';
        }
        if (accountInput.value.trim().length === 10) {
            verifyCurrentAccount();
        }
    });
}

// FIXED: Manual verify button function
async function verifyBankAccountManual() {
    const accountInput = document.getElementById('accountNumber');
    const bankSelect = document.getElementById('accountBankName');
    const holderInput = document.getElementById('accountHolderName');
    const statusEl = document.getElementById('verificationStatus');
    return verifyBankAccountFields({ accountInput, bankSelect, holderInput, statusEl, manual: true });
    
    const accountNumber = accountInput?.value.trim();
    const selectedOption = bankSelect?.options[bankSelect.selectedIndex];
    const bankCode = selectedOption?.dataset?.code;
    const verificationKey = `${bankCode || ''}:${accountNumber || ''}`;
    
    if (!accountNumber || accountNumber.length !== 10) {
        showToast('Enter valid 10-digit account number', 'error');
        return;
    }
    if (!bankCode) {
        showToast('Select a valid bank first', 'error');
        return;
    }
    
    holderInput.value = 'Verifying...';
    holderInput.disabled = true;
    statusEl.textContent = 'Verifying with Paystack...';
    statusEl.className = 'text-info';
    
    try {
        const res = await apiRequest('/api/paystack/verify-account/', {
            method: 'POST',
            body: { account_number: accountNumber, bank_code: bankCode }
        });
        
        // FIXED: Proper Paystack response parsing
        if (res.success && res.data?.status === true && res.data?.data?.account_name) {
            holderInput.value = res.data.data.account_name;
            holderInput.style.background = '#d4edda';
            AppState.lastVerifiedAccountKey = verificationKey;
            statusEl.textContent = `✓ Verified: ${res.data.data.account_name}`;
            statusEl.className = 'text-success';
            statusEl.textContent = `Verified: ${res.data.data.account_name}`;
            showToast('Account verified successfully', 'success');
        } else {
            holderInput.value = '';
            holderInput.style.background = '#f8d7da';
            AppState.lastVerifiedAccountKey = null;
            AppState.lastVerifiedAccountKey = null;
            AppState.lastVerifiedAccountKey = null;
            AppState.lastVerifiedAccountKey = null;
            const errorMsg = res.data?.message || 'Verification failed';
            statusEl.textContent = errorMsg;
            statusEl.className = 'text-danger';
            statusEl.textContent = res.message || res.data?.message || 'Verification failed';
            holderInput.readOnly = true;
            showToast(errorMsg, 'error');
        }
    } catch (err) {
        holderInput.value = '';
        holderInput.readOnly = true;
        AppState.lastVerifiedAccountKey = null;
        statusEl.textContent = 'Error verifying account. Try again later.';
        statusEl.className = 'text-warning';
        showToast('Verification service unavailable', 'error');
    } finally {
        AppState.pendingAccountVerificationKey = null;
        holderInput.disabled = false;
    }
}



// ==========================================
// AUTHENTICATION
// ==========================================

async function handleLogin(e) {
    e.preventDefault();

    if (AppState.loginLockedUntil && Date.now() < AppState.loginLockedUntil) {
        const remaining = Math.ceil((AppState.loginLockedUntil - Date.now()) / 1000 / 60);
        showToast(`Account locked. Try again in ${remaining} minutes.`, 'error');
        return;
    }

    const username = document.getElementById('loginUsername')?.value.trim();
    const password = document.getElementById('loginPassword')?.value;

    if (!username || !password) {
        showToast('Username and password are required', 'error');
        return;
    }

    try {
        const response = await fetch(`${window.location.origin}/api/login/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const data = await response.json();

        if (!response.ok) {
            AppState.loginAttempts++;
            if (AppState.loginAttempts >= CONFIG.MAX_LOGIN_ATTEMPTS) {
                AppState.loginLockedUntil = Date.now() + CONFIG.LOCKOUT_DURATION;
                showToast('Too many failed attempts. Account locked for 15 minutes.', 'error');
            } else {
                showToast(data.error || 'Invalid credentials', 'error');
            }
            return;
        }

        AppState.loginAttempts = 0;
        AppState.loginLockedUntil = null;

        // FIXED: Store both tokens
        AppState.accessToken = data.access;
        AppState.refreshToken = data.refresh;
        AppState.currentUser = data.user;
        
        localStorage.setItem('accessToken', data.access);
        localStorage.setItem('refreshToken', data.refresh); // ADDED
        sessionStorage.setItem('accessToken', data.access);
        sessionStorage.setItem('isLoggedIn', 'true');

        document.getElementById('loginPage')?.classList.add('hidden');
        document.getElementById('dashboardPage')?.classList.remove('hidden');

        await loadDashboard();

        showToast('Login successful', 'success');

    } catch (err) {
        console.error('Login error:', err);
        showToast('Login failed. Please try again.', 'error');
    }
}

function logout() {
    // Call backend logout to blacklist token
    apiRequest('/api/logout/', { method: 'POST' }).catch(() => {});
    
    AppState.accessToken = null;
    AppState.refreshToken = null; // ADDED
    AppState.currentUser = null;
    AppState.employees = [];
    AppState.companies = [];
    AppState.deductions = [];
    AppState.payments = [];

    if (AppState.cameraStream) {
        AppState.cameraStream.getTracks().forEach(track => track.stop());
        AppState.cameraStream = null;
    }

    if (AppState.otpTimerInterval) clearInterval(AppState.otpTimerInterval);

    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken'); // ADDED
    localStorage.removeItem('isLoggedIn');
    sessionStorage.removeItem('accessToken');
    sessionStorage.removeItem('isLoggedIn');

    document.getElementById('dashboardPage')?.classList.add('hidden');
    document.getElementById('loginPage')?.classList.remove('hidden');
}

async function loadCurrentUser() {
    try {
        const res = await apiRequest('/api/current-user/');
        if (!res.success) throw new Error(res.message);

        AppState.currentUser = res.data;
        
        const el = document.getElementById('currentUserName');
        if (el) {
            el.textContent = `Welcome, ${escapeHtml(AppState.currentUser.first_name || AppState.currentUser.username)}`;
        }
        
        applyRolePermissions(AppState.currentUser);
        return true;
    } catch (err) {
        console.error('Failed to load user:', err);
        return false;
    }
}

// ==========================================
// AUTHORIZATION
// ==========================================

function applyRolePermissions(user) {
    if (!user) return;

    const permissions = [
        { id: 'admin-controls-employee', allowed: user.is_superuser || user.role === 'admin' || user.is_employee_admin },
        { id: 'admin-controls-sacked', allowed: user.is_superuser || user.role === 'admin' || user.is_employee_admin },
        { id: 'admin-controls-companies', allowed: user.is_superuser || user.role === 'admin' || user.is_company_admin },
        { id: 'accounts', allowed: user.is_superuser || user.role === 'admin' },
        { id: 'payments', allowed: user.is_superuser || user.role === 'admin' || user.is_payment_admin },
        { id: 'deductions-section', allowed: user.is_superuser || user.role === 'admin' || user.is_deduction_admin }
    ];

    permissions.forEach(({ id, allowed }) => {
        const element = document.getElementById(id);
        if (element) element.style.display = allowed ? '' : 'none';
    });
}

// ==========================================
// EMPLOYEE MANAGEMENT
// ==========================================

async function loadEmployees(page = 1) {
    try {
        const res = await apiRequest(buildUrl('/api/employees/', { page }));
        if (!res.success) throw new Error(res.message);

        AppState.employees = res.data?.results || res.data || [];
        renderEmployees(AppState.employees);
        updateUIAfterEmployeeLoad();
        return true;
    } catch (err) {
        showToast(`Failed to load employees: ${err.message}`, 'error');
        return false;
    }
}

// ==========================================
// ADDED: EMPLOYEE DETAIL VIEW
// ==========================================

function viewEmployeeDetail(employeeId) {
    const employee = AppState.employees.find(e => idsMatch(e.id, employeeId));
    if (!employee) {
        showToast('Employee not found', 'error');
        return;
    }

    const content = document.getElementById('employeeDetailContent');
    if (!content) return;

    // Calculate pending deductions
    const pendingDeductions = AppState.deductions
        .filter(d => idsMatch(d.employee, employeeId) && d.status === 'pending')
        .reduce((sum, d) => sum + Number(d.amount || 0), 0);

    const netSalary = Number(employee.salary || 0) - pendingDeductions;

    content.innerHTML = `
        <div class="detail-grid">
            <div class="detail-section">
                <h4>Basic Information</h4>
                <table class="detail-table">
                    <tr><td><strong>Employee ID:</strong></td><td>${escapeHtml(employee.employee_id || 'N/A')}</td></tr>
                    <tr><td><strong>Full Name:</strong></td><td>${escapeHtml(employee.name || 'N/A')}</td></tr>
                    <tr><td><strong>Type:</strong></td><td>${escapeHtml(employee.type || 'N/A')}</td></tr>
                    <tr><td><strong>Status:</strong></td><td><span class="badge ${employee.status === 'active' ? 'bg-success' : 'bg-danger'}">${escapeHtml(employee.status || 'Active')}</span></td></tr>
                    <tr><td><strong>Location:</strong></td><td>${escapeHtml(employee.location || 'N/A')}</td></tr>
                </table>
            </div>
            
            <div class="detail-section">
                <h4>Contact Information</h4>
                <table class="detail-table">
                    <tr><td><strong>Email:</strong></td><td>${escapeHtml(employee.email || 'N/A')}</td></tr>
                    <tr><td><strong>Phone:</strong></td><td>${escapeHtml(employee.phone || 'N/A')}</td></tr>
                </table>
            </div>
            
            <div class="detail-section">
                <h4>Bank Details</h4>
                <table class="detail-table">
                    <tr><td><strong>Bank Name:</strong></td><td>${escapeHtml(employee.bank_name || 'N/A')}</td></tr>
                    <tr><td><strong>Account Number:</strong></td><td>${escapeHtml(employee.account_number || 'N/A')}</td></tr>
                    <tr><td><strong>Account Holder:</strong></td><td>${escapeHtml(employee.account_holder || 'N/A')}</td></tr>
                </table>
            </div>
            
            <div class="detail-section">
                <h4>Salary Information</h4>
                <table class="detail-table">
                    <tr><td><strong>Base Salary:</strong></td><td>${formatCurrency(employee.salary)}</td></tr>
                    <tr><td><strong>Pending Deductions:</strong></td><td class="text-danger">${formatCurrency(pendingDeductions)}</td></tr>
                    <tr><td><strong>Net Salary:</strong></td><td class="text-success font-bold">${formatCurrency(netSalary)}</td></tr>
                </table>
            </div>
        </div>
    `;
    
    openModal('employeeDetailModal');
}

function renderEmployees(list = []) {
    const tableBody = AppState.elements.tbody || document.getElementById('employeeTableBody');
    if (!tableBody) return;

    tableBody.innerHTML = '';
    
    if (!list.length) {
        tableBody.innerHTML = '<tr><td colspan="8" class="text-center">No employees found</td></tr>';
        return;
    }

    list.forEach(emp => {
        if (!emp) return;
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${escapeHtml(emp.employee_id ?? emp.id ?? '-')}</td>
            <td>${escapeHtml(emp.name ?? '-')}</td>
            <td>${escapeHtml(emp.type ?? '-')}</td>
            <td>${escapeHtml(emp.location ?? '-')}</td>
            <td>${escapeHtml(emp.bank_name ?? '-')}</td>
            <td>${formatCurrency(emp.salary)}</td>
            <td><span class="badge ${emp.status === 'active' ? 'bg-success' : 'bg-danger'}">${escapeHtml(emp.status || 'Active')}</span></td>
            <td>
                <button type="button" class="btn btn-sm btn-info" onclick="viewEmployeeDetail('${emp.id}')">
                    <i class="fas fa-eye"></i> View
                </button>
                <button type="button" class="btn btn-sm btn-success" onclick="initiateIndividualPayment('${emp.id}')">Pay</button>
                <button type="button" class="btn btn-sm btn-warning" onclick="showSackEmployeeModal('${emp.id}')">Sack</button>
                <button type="button" class="btn btn-sm btn-danger" onclick="handleDelete('${emp.id}')">Delete</button>
            </td>
        `;
        tableBody.appendChild(row);
    });
}

function validateEmployeePayload(payload) {
    const required = ['name', 'type', 'location'];
    for (const field of required) {
        if (!payload[field]) throw new Error(`${field.charAt(0).toUpperCase() + field.slice(1)} is required`);
    }
    if (!payload.salary || isNaN(payload.salary) || payload.salary <= 0) {
        throw new Error('Valid salary is required');
    }
}

async function handleCreateEmployee(e) {
    e.preventDefault();

    const btn = document.getElementById('createEmployeeBtn') 
        || e.target.querySelector('button[type="submit"]');

    function parseMoney(value) {
        return Number(String(value).replace(/,/g, '').trim()) || 0;
    }

        // Generate employee ID first
    const generatedId = await fetchNextEmployeeId(
        document.getElementById('newEmployeeType')?.value.trim()
    );

    const payload = {
        name: document.getElementById('newEmployeeName')?.value.trim(),
        type: document.getElementById('newEmployeeType')?.value.trim(),
        location: document.getElementById('newEmployeeLocation')?.value.trim(),
        salary: parseMoney(document.getElementById('newEmployeeSalary')?.value),
        email: document.getElementById('newEmployeeEmail')?.value.trim(),
        phone: document.getElementById('newEmployeePhone')?.value.trim(),
        bank_name: document.getElementById('newEmployeeBankName')?.value.trim(),
        bank_code: document.getElementById('newEmployeeBankName')?.selectedOptions?.[0]?.dataset?.code || '',
        account_number: document.getElementById('newEmployeeAccountNumber')?.value.trim(),
        account_holder: document.getElementById('newEmployeeAccountHolder')?.value.trim(),
        employee_id: generatedId  // ← ADD THIS LINE
    };

    // Hybrid validation
    const missingFields = [];
    if (!payload.name) missingFields.push('Name');
    if (!payload.type) missingFields.push('Type');
    if (!payload.location) missingFields.push('Location');
    if (!payload.salary) missingFields.push('Valid Salary');
    if (!payload.email) missingFields.push('Email');
    if (!payload.phone) missingFields.push('Phone');
    if (!payload.bank_name) missingFields.push('Bank Name');
    if (!payload.account_number || payload.account_number.length !== 10)
        missingFields.push('Valid 10-digit Account Number');
    if (!payload.account_holder) missingFields.push('Account Holder Name');

    if (missingFields.length) {
        showToast(`Missing fields: ${missingFields.join(', ')}`, 'error');
        return;
    }

    try {
        showLoading(btn);

        const res = await apiRequest('/api/employees/', {
            method: 'POST',
            body: payload
        });

        if (!res.success) {
            throw new Error(res.message || 'Failed to create employee');
        }

        showToast('Employee created successfully!', 'success');

        await loadEmployees();
        updateDashboardStats();
        updateUIAfterEmployeeLoad();

        closeModal('addEmployeeModal');
        document.getElementById('addEmployeeForm')?.reset();

    } catch (err) {
        console.error(err);
        showToast(`Error creating employee: ${err.message}`, 'error');
    } finally {
        hideLoading(btn);
    }
}

async function handleDelete(id) {
    if (!confirm('Are you sure you want to delete this employee?')) return;
    
    try {
        const res = await apiRequest(`/api/employees/${id}/`, { method: 'DELETE' });
        if (!res.success) throw new Error(res.message);
        
        await loadEmployees();
        updateDashboardStats();
        showToast('Employee deleted successfully', 'success');
    } catch (err) {
        showToast(`Failed to delete employee: ${err.message}`, 'error');
    }
}

// ==========================================
// ACCOUNT CREATION - FIXED ID GENERATION
// ==========================================

async function createAccount(e) {
    e.preventDefault();
    const btn = document.getElementById('createAccountBtn');
    showLoading(btn);

    function parseMoney(value) {
        return Number(String(value).replace(/,/g, '').trim()) || 0;
    }

    let generatedId = document.getElementById('generatedEmployeeIdInput')?.value;

    // Ensure ID exists
    if (!generatedId) {
        const role = document.getElementById('accountType')?.value;
        generatedId = await fetchNextEmployeeId(role);
    }

    const payload = {
        username: document.getElementById('accountUsername')?.value.trim(),
        password: document.getElementById('accountPassword')?.value,
        full_name: document.getElementById('accountName')?.value.trim(),
        role: document.getElementById('accountType')?.value,
        location: document.getElementById('accountLocation')?.value.trim(),
        salary: parseMoney(document.getElementById('accountSalary')?.value),
        phone: document.getElementById('accountPhone')?.value.trim(),
        email: document.getElementById('accountEmail')?.value.trim(),
        bank_name: document.getElementById('accountBankName')?.value,
        bank_code: document.getElementById('accountBankName')?.selectedOptions?.[0]?.dataset?.code || '',
        account_number: document.getElementById('accountNumber')?.value.trim(),
        account_holder: document.getElementById('accountHolderName')?.value.trim(),
        employee_id: generatedId
    };

    const validations = [
        { check: !payload.username, msg: 'Username is required' },
        { check: !payload.password || payload.password.length < 8, msg: 'Password must be at least 8 characters' },
        { check: !payload.full_name, msg: 'Full name is required' },
        { check: !payload.role, msg: 'Employee type is required' }
    ];

    if (payload.role !== 'admin') {
        validations.push(
            { check: !payload.salary, msg: 'Valid salary is required' },
            { check: !payload.location, msg: 'Location is required' },
            { check: !payload.bank_name, msg: 'Bank name is required' },
            { check: !payload.account_number || !/^\d{10}$/.test(payload.account_number), msg: 'Valid 10-digit account number required' }
        );
    }

    for (const v of validations) {
        if (v.check) {
            showToast(v.msg, 'error');
            hideLoading(btn);
            return;
        }
    }

    try {
        const res = await apiRequest('/api/register/', {
            method: 'POST',
            body: payload
        });

        if (!res.success) {
            throw new Error(res.message || res.data?.error || 'Registration failed');
        }

        const empId = res.data?.employee?.employee_id || generatedId;
        const createdEmployee = res.data?.employee
            ? {
                ...res.data.employee,
                location: payload.location,
                salary: payload.salary,
                phone: payload.phone,
                email: payload.email,
                bank_name: payload.bank_name,
                bank_code: payload.bank_code,
                account_number: payload.account_number,
                account_holder: payload.account_holder,
                status: 'active'
            }
            : null;

        showToast(`Account created! ID: ${empId}`, 'success');

        document.getElementById('generatedEmployeeId').textContent = empId;
        document.getElementById('createAccountForm')?.reset();
        const hiddenInput = document.getElementById('generatedEmployeeIdInput');
        if (hiddenInput) hiddenInput.value = '';
        if (createdEmployee) {
            AppState.employees = [
                createdEmployee,
                ...AppState.employees.filter(emp => !idsMatch(emp.id, createdEmployee.id))
            ];
            renderEmployees(AppState.employees);
        }

        await loadEmployees();
        updateDashboardStats();
        updateUIAfterEmployeeLoad();
        showSection('employees');

    } catch (err) {
        console.error(err);
        showToast(err.message, 'error');
    } finally {
        hideLoading(btn);
    }
}

// ==========================================
// FIXED: EMPLOYEE ID GENERATION
// ==========================================

async function fetchNextEmployeeId(type) {
    try {
        const res = await apiRequest(`/api/next-employee-id/?type=${type}`);
        if (res.success && res.data?.next_id) {
            return res.data.next_id;
        }
    } catch (e) {
        console.warn('Server ID generation failed, using local fallback:', e);
    }
    
    // FIXED: Better local fallback using actual employee data
    const prefix = type === 'staff' ? 'STAFF' : 'GRD';
    const prefixPattern = new RegExp(`^FSS-(\\\\d+)-${prefix}$`);
    
    let maxNum = 0;
    AppState.employees.forEach(emp => {
        if (emp.employee_id && emp.type === type) {
            const match = emp.employee_id.match(prefixPattern);
            if (match) {
                const num = parseInt(match[1], 10);
                if (num > maxNum) maxNum = num;
            }
        }
    });
    
    const nextSeq = maxNum + 1;
    return `FSS-${String(nextSeq).padStart(3, '0')}-${prefix}`;
}

function setupEmployeeIdGeneration() {
    const typeSelect = document.getElementById('accountType');
    const nameInput = document.getElementById('accountName');
    const displayEl = document.getElementById('generatedEmployeeId');

    const generateId = async () => {
        const type = typeSelect?.value;
        const name = nameInput?.value?.trim();
        
        if (!type || !name) {
            if (displayEl) {
                displayEl.textContent = '-';
                displayEl.style.color = '#007bff';
            }
            return;
        }

        if (displayEl) displayEl.textContent = 'Generating...';
        
        const nextId = await fetchNextEmployeeId(type);
        
        if (displayEl) {
            displayEl.textContent = nextId;
            displayEl.style.color = '#28a745';
        }
        
        // Update hidden input
        let hiddenInput = document.getElementById('generatedEmployeeIdInput');
        if (!hiddenInput) {
            hiddenInput = document.createElement('input');
            hiddenInput.type = 'hidden';
            hiddenInput.id = 'generatedEmployeeIdInput';
            hiddenInput.name = 'employee_id';
            document.getElementById('createAccountForm')?.appendChild(hiddenInput);
        }
        hiddenInput.value = nextId;
    };

    // Generate on both change and blur for better UX
    if (typeSelect) typeSelect.addEventListener('change', generateId);
    if (nameInput) {
        nameInput.addEventListener('blur', generateId);
        nameInput.addEventListener('input', debounce(generateId, 500));
    }
}


// ==========================================
// COMPANY MANAGEMENT
// ==========================================

async function loadCompanies() {
    try {
        const res = await apiRequest('/api/companies/');
        if (!res.success) throw new Error(res.message);

        AppState.companies = res.data?.results || res.data || [];
        renderCompanies(AppState.companies);
        return true;
    } catch (err) {
        showToast(`Failed to load companies: ${err.message}`, 'error');
        return false;
    }
}

function renderCompanies(list) {
    const tbody = AppState.elements.companiesTbody || document.getElementById('companiesTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    
    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center">No companies found</td></tr>';
        return;
    }

    list.forEach(company => {
        const guardsCount = Array.isArray(company.assigned_guards) ? company.assigned_guards.length : (company.guards_count || 0);
        const paymentToUs = Number(company.payment_to_us) || 0;
        const paymentPerGuard = Number(company.payment_per_guard) || 0;
        const totalToGuards = paymentPerGuard * guardsCount;
        const profit = paymentToUs - totalToGuards;

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${escapeHtml(company.name)}</td>
            <td>${escapeHtml(company.location)}</td>
            <td>${guardsCount}</td>
            <td>${formatCurrency(paymentToUs)}</td>
            <td>${formatCurrency(totalToGuards)}</td>
            <td class="${profit >= 0 ? 'text-success' : 'text-danger'}">${formatCurrency(profit)}</td>
            <td>
                <button type="button" class="btn btn-sm btn-primary" onclick="editCompany('${company.id}')">Edit</button>
                <button type="button" class="btn btn-sm btn-danger" onclick="deleteCompany('${company.id}')">Delete</button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

async function handleCreateCompany(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');

    const selectedGuards = Array.from(
        document.querySelectorAll('#companyAssignedGuardsContainer input[name="assigned_guards"]:checked')
    ).map(cb => cb.value);

    const payload = {
        name: document.getElementById('companyName')?.value.trim(),
        location: document.getElementById('companyLocation')?.value.trim(),
        guards_count: Number(document.getElementById('companyGuardsCount')?.value),
        payment_to_us: Number(document.getElementById('companyPaymentToUs')?.value),
        payment_per_guard: Number(document.getElementById('companyPaymentPerGuard')?.value),
        assigned_guards: selectedGuards
    };

    if (!payload.name || !payload.location || !Number.isFinite(payload.guards_count) || payload.guards_count <= 0) {
        showToast('Please fill all company fields correctly', 'error');
        return;
    }

    try {
        showLoading(btn);
        
        const url = AppState.currentEditingCompanyId 
            ? `/api/companies/${AppState.currentEditingCompanyId}/`
            : '/api/companies/';
        const method = AppState.currentEditingCompanyId ? 'PUT' : 'POST';

        const res = await apiRequest(url, { method, body: payload });
        if (!res.success) throw new Error(res.message);

        showToast(AppState.currentEditingCompanyId ? 'Company updated successfully' : 'Company created successfully', 'success');
        
        document.getElementById('addCompanyForm')?.reset();
        AppState.currentEditingCompanyId = null;
        closeModal('addCompanyModal');
        
        await loadCompanies();
    } catch (err) {
        showToast(err.message || 'Failed to save company', 'error');
    } finally {
        hideLoading(btn);
    }
}

async function deleteCompany(companyId) {
    if (!confirm('Are you sure you want to delete this company contract?')) return;

    try {
        const res = await apiRequest(`/api/companies/${companyId}/`, { method: 'DELETE' });
        if (!res.success) throw new Error(res.message);
        
        showToast('Company deleted successfully', 'success');
        await loadCompanies();
    } catch (err) {
        showToast(err.message || 'Failed to delete company', 'error');
    }
}

function editCompany(companyId) {
    const company = AppState.companies.find(c => c.id === companyId);
    if (!company) {
        showToast('Company not found', 'error');
        return;
    }

    AppState.currentEditingCompanyId = company.id;
    document.getElementById('companyName').value = company.name || '';
    document.getElementById('companyLocation').value = company.location || '';
    document.getElementById('companyGuardsCount').value = company.guards_count || 0;
    document.getElementById('companyPaymentToUs').value = company.payment_to_us || 0;
    document.getElementById('companyPaymentPerGuard').value = company.payment_per_guard || 0;

    populateCompanyGuards();
    
    if (Array.isArray(company.assigned_guards)) {
        company.assigned_guards.forEach(guardId => {
            const checkbox = document.querySelector(`#companyAssignedGuardsContainer input[value="${guardId}"]`);
            if (checkbox) checkbox.checked = true;
        });
    }

    openModal('addCompanyModal');
}

// ==========================================
// DEDUCTIONS MANAGEMENT - FIXED STATUS CONTROL
// ==========================================

async function loadDeductions() {
    try {
        const res = await apiRequest('/api/deductions/');
        if (!res.success) throw new Error(res.message);

        AppState.deductions = res.data?.results || res.data || [];
        renderDeductions(AppState.deductions);
        updateDashboardStats();
        return true;
    } catch (err) {
        showToast(`Failed to load deductions: ${err.message}`, 'error');
        return false;
    }
}

function renderDeductions(list) {
    const tbody = AppState.elements.deductionsTbody || document.getElementById('deductionsTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    
    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center">No deductions found</td></tr>';
        return;
    }

    list.forEach(ded => {
        const row = document.createElement('tr');
        const statusClass = ded.status === 'applied' ? 'text-success' : 
                            ded.status === 'cancelled' ? 'text-danger' : 'text-warning';
        
        row.innerHTML = `
            <td>${escapeHtml(ded.date || '-')}</td>
            <td>${escapeHtml(ded.employee_id || ded.employee || '-')}</td>
            <td>${escapeHtml(ded.employee_name || '-')}</td>
            <td>${formatCurrency(ded.amount)}</td>
            <td>${escapeHtml(ded.reason || '-')}</td>
            <td><span class="${statusClass}">${escapeHtml(ded.status || 'Pending')}</span></td>
            <td>
                <button type="button" onclick="editDeduction('${ded.id}')" class="btn btn-sm btn-warning">Edit</button>
                <button type="button" onclick="deleteDeduction('${ded.id}')" class="btn btn-sm btn-danger">Delete</button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

async function addDeduction(e) {
    e.preventDefault();
    const btn = document.getElementById('addDeductionBtn');

    const employeeId = document.getElementById('deductionEmployee')?.value;
    const amount = Number(document.getElementById('deductionAmount')?.value);
    const reason = document.getElementById('deductionReason')?.value.trim();
    const date = new Date().toISOString().split('T')[0];

    if (!employeeId || !Number.isFinite(amount) || amount <= 0 || !reason) {
        showToast('All fields are required', 'warning');
        return;
    }

    try {
        showLoading(btn);

        const res = await apiRequest('/api/deductions/', {
            method: 'POST',
            body: { employee: employeeId, amount, reason, date, status: 'pending' } // Always pending initially
        });

        if (!res.success) throw new Error(res.message);

        showToast('Deduction added successfully', 'success');
        closeModal('addDeductionModal');
        document.getElementById('addDeductionForm')?.reset();
        await loadDeductions();
    } catch (err) {
        showToast(`Failed to add deduction: ${err.message}`, 'error');
    } finally {
        hideLoading(btn);
    }
}

async function updateDeduction(e) {
    e.preventDefault();
    if (!AppState.currentEditingDeductionId) return;

    const btn = document.getElementById('editDeductionBtn');
    const employeeId = document.getElementById('editDeductionEmployee')?.value;
    const amount = Number(document.getElementById('editDeductionAmount')?.value);
    const reason = document.getElementById('editDeductionReason')?.value.trim();
    const status = document.getElementById('editDeductionStatus')?.value || 'pending'; // ADDED: Status control
    const existingDeduction = AppState.deductions.find(d => d.id === AppState.currentEditingDeductionId);

    if (!employeeId || !Number.isFinite(amount) || amount <= 0 || !reason || !existingDeduction) {
        showToast('All fields are required', 'warning');
        return;
    }

    try {
        showLoading(btn);

        const res = await apiRequest(`/api/deductions/${AppState.currentEditingDeductionId}/`, {
            method: 'PUT',
            body: {
                employee: employeeId,
                amount,
                reason,
                date: existingDeduction.date,
                status: status // Use selected status
            }
        });

        if (!res.success) throw new Error(res.message);

        showToast('Deduction updated successfully', 'success');
        closeModal('editDeductionModal');
        AppState.currentEditingDeductionId = null;
        await loadDeductions();
    } catch (err) {
        showToast(`Failed to update deduction: ${err.message}`, 'error');
    } finally {
        hideLoading(btn);
    }
}

async function deleteDeduction(id) {
    if (!confirm('Are you sure you want to delete this deduction?')) return;

    try {
        const res = await apiRequest(`/api/deductions/${id}/`, { method: 'DELETE' });
        if (!res.success) throw new Error(res.message);

        showToast('Deduction deleted successfully', 'success');
        await loadDeductions();
        updateDashboardStats();
    } catch (err) {
        showToast(`Failed to delete deduction: ${err.message}`, 'error');
    }
}

function editDeduction(id) {
    AppState.currentEditingDeductionId = id;
    const deduction = AppState.deductions.find(d => d.id === id);
    if (!deduction) return;

    populateEmployeeSelect('editDeductionEmployee');
    openModal('editDeductionModal');

    document.getElementById('editDeductionEmployee').value = deduction.employee;
    document.getElementById('editDeductionAmount').value = deduction.amount;
    document.getElementById('editDeductionReason').value = deduction.reason;
    document.getElementById('editDeductionStatus').value = deduction.status || 'pending'; // ADDED
}

// ==========================================
// ATTENDANCE - FIXED WITH LEAVE SUPPORT
// ==========================================

function toggleCamera() {
    const markWithoutSelfie = document.getElementById('markWithoutSelfie')?.checked;
    const cameraSection = document.getElementById('cameraSection');
    const cameraButtons = document.getElementById('cameraButtons');
    const submitBtn = document.getElementById('submitClockBtn');
    
    if (markWithoutSelfie) {
        if (cameraSection) cameraSection.style.display = 'none';
        if (cameraButtons) cameraButtons.style.display = 'none';
        if (submitBtn) submitBtn.disabled = false;
    } else {
        if (cameraSection) cameraSection.style.display = 'block';
        if (cameraButtons) cameraButtons.style.display = 'flex';
        if (submitBtn) submitBtn.disabled = true;
    }
}

async function loadAttendance() {
    try {
        const res = await apiRequest('/api/attendance/');
        if (!res.success) throw new Error(res.message);

        const list = res.data?.results || res.data || [];
        AppState.attendance = list; // Store for stats
        const tbody = AppState.elements.attendanceTbody || document.getElementById('attendanceTableBody');
        if (!tbody) return;

        tbody.innerHTML = '';
        
        if (!list.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center">No attendance records found</td></tr>';
            updateAttendanceStats(0, 0, 0);
            return;
        }

        // Calculate stats
        const today = new Date().toISOString().split('T')[0];
        const todayRecords = list.filter(a => a.date === today);
        const present = todayRecords.filter(a => a.status === 'present').length;
        const absent = todayRecords.filter(a => a.status === 'absent').length;
        const onLeave = todayRecords.filter(a => a.status === 'leave').length;
        updateAttendanceStats(present, absent, onLeave);

        list.forEach(att => {
            const row = document.createElement('tr');
            const photoUrl = att.clock_in_photo ? att.clock_in_photo.replace(/^\/media\//, '/media/') : null;
            
            row.innerHTML = `
                <td>${escapeHtml(att.date || '-')}</td>
                <td>${escapeHtml(att.employee_id || '-')}</td>
                <td>${escapeHtml(att.employee_name || '-')}</td>
                <td>${escapeHtml(att.clock_in_display || att.clock_in || '-')}</td>
                <td>${escapeHtml(att.clock_out_display || att.clock_out || '-')}</td>
                <td><span class="badge ${att.status === 'present' ? 'bg-success' : att.status === 'leave' ? 'bg-warning' : 'bg-danger'}">${escapeHtml(att.status || '-')}</span></td>
                <td>
                    ${photoUrl 
                        ? `<img src="${escapeHtml(photoUrl)}" width="40" alt="clock in" class="img-thumbnail" 
                            onerror="this.style.display='none'; this.parentElement.innerHTML='-'">`
                        : '-'
                    }
                </td>
            `;
            tbody.appendChild(row);
        });
    } catch (err) {
        console.error('Load attendance error:', err);
        showToast(err.message || 'Failed to load attendance', 'error');
    }
}

function updateAttendanceStats(present, absent, leave) {
    const presentEl = document.getElementById('presentToday');
    const absentEl = document.getElementById('absentToday');
    const leaveEl = document.getElementById('onLeave');
    
    if (presentEl) presentEl.textContent = present;
    if (absentEl) absentEl.textContent = absent;
    if (leaveEl) leaveEl.textContent = leave;
}

async function handleMarkLeave(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    
    const employeeId = document.getElementById('leaveEmployee')?.value;
    const startDate = document.getElementById('leaveStartDate')?.value;
    const endDate = document.getElementById('leaveEndDate')?.value;
    const reason = document.getElementById('leaveReason')?.value.trim();

    if (!employeeId || !startDate || !endDate) {
        showToast('Please fill all required fields', 'warning');
        return;
    }

    try {
        showLoading(btn);
        
        // FIXED: Use dedicated mark_leave endpoint instead of generic attendance
        const res = await apiRequest('/api/attendance/mark_leave/', {
            method: 'POST',
            body: {
                employee_id: employeeId,
                start_date: startDate,
                end_date: endDate,
                reason: reason
            }
        });

        if (!res.success) {
            throw new Error(res.message || 'Failed to mark leave');
        }

        showToast(`Leave marked for ${res.data?.records?.length || 0} day(s)`, 'success');
        closeModal('leaveModal');
        await loadAttendance();
    } catch (err) {
        showToast(err.message || 'Failed to mark leave', 'error');
    } finally {
        hideLoading(btn);
    }
}

async function startCamera() {
    const video = document.getElementById('cameraVideo');
    if (!video) return;

    try {
        if (AppState.cameraStream) {
            AppState.cameraStream.getTracks().forEach(track => track.stop());
        }

        AppState.cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = AppState.cameraStream;
        
        const captureBtn = document.getElementById('captureBtn');
        if (captureBtn) captureBtn.disabled = false;
        
    } catch (err) {
        console.error('Camera error:', err);
        showToast('Camera access denied or not available', 'error');
    }
}

function capturePhoto() {
    const video = document.getElementById('cameraVideo');
    const canvas = document.getElementById('cameraCanvas');
    const preview = document.getElementById('capturedImage');
    const submitBtn = document.getElementById('submitClockBtn');

    if (!video || !canvas || !preview) {
        showToast('Camera setup error', 'error');
        return;
    }

    if (video.videoWidth === 0 || video.videoHeight === 0) {
        showToast('Camera not ready yet', 'warning');
        return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
        if (!blob) {
            showToast('Failed to capture image', 'error');
            return;
        }

        AppState.capturedImageBlob = blob;

        const img = document.createElement('img');
        const url = URL.createObjectURL(blob);
        img.src = url;
        img.style.width = '100%';
        img.style.borderRadius = '8px';
        img.dataset.objectUrl = url;

        preview.innerHTML = '';
        preview.appendChild(img);

        if (submitBtn) submitBtn.disabled = false;
    }, 'image/jpeg', CONFIG.CAMERA_QUALITY);
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function handleClockIn(e) {
    e.preventDefault();

    const action = document.getElementById('clockAction')?.value;
    const employeeId = document.getElementById('clockEmployee')?.value;
    const markWithoutSelfie = document.getElementById('markWithoutSelfie')?.checked;

    if (!employeeId) {
        showToast('Please select an employee', 'warning');
        return;
    }

    if (!markWithoutSelfie && !AppState.capturedImageBlob) {
        showToast('Please capture a photo first', 'warning');
        return;
    }

    let url = action === 'out' ? '/api/attendance/clock_out/' : '/api/attendance/clock_in/';
    let body = { employee: employeeId, employee_id: employeeId, date: new Date().toISOString().split('T')[0] };

    if (!markWithoutSelfie) {
        url = action === 'out'
            ? '/api/attendance/clock_out_with_photo/'
            : '/api/attendance/clock_in_with_photo/';
        const photo = await blobToDataUrl(AppState.capturedImageBlob);
        body.photo = photo;
    }

    const submitBtn = document.getElementById('submitClockBtn');
    
    try {
        showLoading(submitBtn);

        const res = await apiRequest(url, {
            method: 'POST',
            body
        });

        if (!res.success) throw new Error(res.message || 'Attendance recording failed');

        showToast(res.data?.message || 'Attendance recorded successfully', 'success');

        AppState.capturedImageBlob = null;
        const preview = document.getElementById('capturedImage');
        if (preview) {
            const img = preview.querySelector('img');
            if (img?.dataset.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);
            preview.innerHTML = '';
        }
        
        document.getElementById('captureBtn').disabled = true;
        document.getElementById('submitClockBtn').disabled = true;

        closeModal('clockInModal');
        await loadAttendance();

    } catch (err) {
        console.error('Clock in error:', err);
        showToast(err.message || 'Attendance error', 'error');
    } finally {
        hideLoading(submitBtn);
    }
}

// ==========================================
// PAYMENTS - FIXED PAYSTACK INTEGRATION
// ==========================================

// ADDED: Update payment preview when employee selected
function updatePaymentPreview() {
    const employeeId = document.getElementById('paymentEmployee')?.value;
    const preview = document.getElementById('paymentPreview');
    
    if (!employeeId || !preview) {
        if (preview) preview.style.display = 'none';
        return;
    }

    const employee = AppState.employees.find(e => idsMatch(e.id, employeeId));
    if (!employee) {
        preview.style.display = 'none';
        return;
    }

    const deductions = AppState.deductions
        .filter(d => idsMatch(d.employee, employeeId) && d.status === 'pending')
        .reduce((sum, d) => sum + Number(d.amount || 0), 0);
    
    const netAmount = Number(employee.salary || 0) - deductions;

    document.getElementById('previewBaseSalary').textContent = formatCurrency(employee.salary);
    document.getElementById('previewDeductions').textContent = formatCurrency(deductions);
    document.getElementById('previewNetAmount').textContent = formatCurrency(netAmount);
    document.getElementById('previewBank').textContent = employee.bank_name || '-';
    document.getElementById('previewAccount').textContent = employee.account_number || '-';
    
    preview.style.display = 'block';
}

async function loadPaymentHistory() {
    const tbody = AppState.elements.historyTbody || document.getElementById('historyTableBody');
    if (!tbody) return;

    try {
        const res = await apiRequest('/api/payments/');
        if (!res.success) throw new Error(res.message);

        const list = res.data?.results || res.data || [];
        AppState.payments = list;
        tbody.innerHTML = '';

        if (!list.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center">No payment history found</td></tr>';
            return;
        }

        list.forEach(payment => {
            const row = document.createElement('tr');
            const statusClass = payment.status === 'completed' ? 'text-success' : 
                                payment.status === 'failed' ? 'text-danger' : 'text-warning';
            
            row.innerHTML = `
                <td>${escapeHtml(payment.payment_date || '-')}</td>
                <td>${escapeHtml(payment.employee_id || payment.employee || '-')}</td>
                <td>${escapeHtml(payment.employee_name || '-')}</td>
                <td>${escapeHtml(payment.bank_account || '-')}</td>
                <td>${formatCurrency(payment.net_amount)}</td>
                <td>${escapeHtml(payment.payment_method || 'Paystack')}</td>
                <td><span class="${statusClass}">${escapeHtml(payment.status || '-')}</span></td>
                <td>
                    ${payment.status === 'completed' 
                        ? '<span class="text-success"><i class="fas fa-check"></i> Paid</span>' 
                        : `<button class="btn btn-sm btn-primary" onclick="retryPayment('${payment.id}')">Retry</button>`
                    }
                </td>
            `;
            tbody.appendChild(row);
        });
        
        // Update pending payments count
        const pending = list.filter(p => p.status === 'pending' || p.status === 'processing').length;
        const pendingEl = document.getElementById('pendingPayments');
        if (pendingEl) pendingEl.textContent = pending;
        
    } catch (err) {
        console.error('Payment history load error:', err);
        const tbody = document.getElementById('historyTableBody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-danger">Failed to load payment history. Server error.</td></tr>';
        }
        showToast('Payment history unavailable. Please try again later.', 'error');        
        // Update pending count to show error state
        const pendingEl = document.getElementById('pendingPayments');
        if (pendingEl) pendingEl.textContent = 'Error';
    }
}

async function processBulkPayment() {
    const checked = Array.from(
        document.querySelectorAll('#bulkPaymentModal tbody input[type=checkbox]:checked')
    ).map(chk => chk.value);
    
    if (!checked.length) {
        showToast('Select at least one employee', 'warning');
        return;
    }

    if (checked.length > 50) {
        showToast('Maximum 50 employees per batch. Please select fewer.', 'error');
        return;
    }

    const btn = document.querySelector('#bulkPaymentModal .btn-primary');
    
    try {
        showLoading(btn);
        
        const res = await apiRequest('/api/payments/bulk_payment/', {
            method: 'POST',
            body: { employee_ids: checked }
        });

        if (!res.success) {
            throw new Error(res.message || 'Bulk payment failed');
        }

        const results = res.data || {};
        const payments = results.payments || [];
        const errors = results.errors || [];
        
        // Show initial summary
        let message = `Initiated ${payments.length}/${checked.length} transfers.`;
        if (errors.length > 0) {
            message += ` ${errors.length} errors.`;
        }
        showToast(message, payments.length > 0 ? 'success' : 'error');
        
        // Close modal and refresh tables
        closeModal('bulkPaymentModal');
        await loadPaymentHistory();
        populatePaymentsTable();
        
        // START BULK POLLING for all successful initiations
        if (payments.length > 0) {
            startBulkPaymentPolling(payments);
        }
        
    } catch (err) {
        console.error('Bulk payment error:', err);
        showToast(err.message || 'Bulk payment failed', 'error');
    } finally {
        hideLoading(btn);
    }
}

function startBulkPaymentPolling(payments, maxAttempts = 40, interval = 3000) {
    // payments = [{reference, employee_name, employee_id, net_salary, bank}, ...]
    
    const pendingRefs = new Map(); // reference -> {employee_name, status}
    const completedRefs = new Set();
    const failedRefs = new Set();
    
    payments.forEach(p => {
        pendingRefs.set(p.reference, {
            employee_name: p.employee_name,
            employee_id: p.employee_id,
            net_salary: p.net_salary,
            status: 'processing'
        });
    });
    
    let attempts = 0;
    
    // Clear any existing bulk poll
    if (AppState.bulkPollInterval) {
        clearInterval(AppState.bulkPollInterval);
    }
    
    // Show progress toast initially
    showToast(`Checking status for ${pendingRefs.size} payments...`, 'info');
    
    const pollAll = async () => {
        attempts++;
        
        // Poll all pending references in parallel
        const pollPromises = Array.from(pendingRefs.keys()).map(async (reference) => {
            try {
                const res = await apiRequest(`/api/payments/verify-payment/${reference}/`);
                
                if (!res.success) return { reference, status: null };
                
                const paymentStatus = res.data.payment_status;
                const paymentInfo = pendingRefs.get(reference);
                
                if (paymentStatus === 'completed') {
                    completedRefs.add(reference);
                    pendingRefs.delete(reference);
                    showToast(`Paid: ${paymentInfo.employee_name} — ₦${paymentInfo.net_salary?.toLocaleString?.() || paymentInfo.net_salary}`, 'success', 3000);
                    
                } else if (paymentStatus === 'failed') {
                    failedRefs.add(reference);
                    pendingRefs.delete(reference);
                    showToast(`Failed: ${paymentInfo.employee_name}`, 'error', 3000);
                }
                
                return { reference, status: paymentStatus };
                
            } catch (err) {
                console.error(`Poll error for ${reference}:`, err);
                return { reference, status: null };
            }
        });
        
        await Promise.all(pollPromises);
        
        // Calculate progress
        const total = payments.length;
        const completed = completedRefs.size;
        const failed = failedRefs.size;
        const remaining = pendingRefs.size;
        
        // Show progress toast every 3 attempts (every ~9 seconds)
        if (attempts % 3 === 0 && remaining > 0) {
            showToast(`Progress: ${completed} paid, ${failed} failed, ${remaining} pending...`, 'info', 2000);
        }
        
        // Refresh tables to show updated statuses
        if (completedRefs.size > 0 || failedRefs.size > 0) {
            await loadPaymentHistory();
            populatePaymentsTable();
            updateDashboardStats();
        }
        
        // Check if all done
        if (pendingRefs.size === 0) {
            clearInterval(AppState.bulkPollInterval);
            AppState.bulkPollInterval = null;
            
            const finalMsg = `Bulk payment complete! ${completed} successful, ${failed} failed.`;
            showToast(finalMsg, failed > 0 ? 'warning' : 'success', 8000);
            
            // Final refresh
            await loadPaymentHistory();
            populatePaymentsTable();
            updateDashboardStats();
            
        } else if (attempts >= maxAttempts) {
            clearInterval(AppState.bulkPollInterval);
            AppState.bulkPollInterval = null;
            
            const remainingNames = Array.from(pendingRefs.values()).map(p => p.employee_name).join(', ');
            showToast(`Timeout: ${pendingRefs.size} payments still pending. Refresh later to check.`, 'warning', 10000);
        }
    };
    pollAll();
    AppState.bulkPollInterval = setInterval(pollAll, interval);
}

// REPLACE your current initiateIndividualPayment function with this:
async function initiateIndividualPayment(empId) {
    try {
        const res = await apiRequest('/api/payments/initiate_payment/', {
            method: 'POST',
            body: { employee_id: empId }
        });

        if (!res.success) {
            throw new Error(res.message || 'Failed to initiate payment');
        }

        // Store the reference for polling
        const reference = res.data.reference;
        AppState.currentPaymentReference = reference;

        if (res.data.authorization_url) {
            // Open Paystack payment page
            window.open(res.data.authorization_url, '_blank');
            showToast('Payment initiated. Complete in the new window.', 'info');
            
            // START POLLING for status update
            startPaymentStatusPolling(reference);
            
        } else if (res.data.otp_sent) {
            showOTPModal();
        } else {
            showToast(res.data.message || 'Payment initiated', 'success');
            await loadPaymentHistory();
            updateDashboardStats();
        }
    } catch (err) {
        showToast(err.message || 'Failed to initiate payment', 'error');
    }
}

// ADD this new function for polling:

function startPaymentStatusPolling(reference, maxAttempts = 30, interval = 3000) {
    let attempts = 0;
    
    showToast('Checking payment status...', 'info');
    
    const pollInterval = setInterval(async () => {
        attempts++;
        
        try {
            const res = await apiRequest(`/api/payments/verify-payment/${reference}/`);
            
            if (!res.success) {
                console.warn('Status check failed:', res.message);
                if (attempts >= maxAttempts) {
                    clearInterval(pollInterval);
                    showToast('Payment status check timed out. Please refresh to see updates.', 'warning');
                }
                return;
            }
            
            const paymentStatus = res.data.payment_status;
            
            // Update UI based on status
            if (paymentStatus === 'completed') {
                clearInterval(pollInterval);
                showToast('Payment successful!', 'success');
                await loadPaymentHistory();  // Refresh the table
                updateDashboardStats();
                populatePaymentsTable();  // Refresh payments page table
                
            } else if (paymentStatus === 'failed') {
                clearInterval(pollInterval);
                showToast('Payment failed or was declined.', 'error');
                await loadPaymentHistory();
                populatePaymentsTable();
                
            } else if (paymentStatus === 'pending' || paymentStatus === 'processing') {
                // Still waiting, continue polling
                if (attempts >= maxAttempts) {
                    clearInterval(pollInterval);
                    showToast('Payment is still processing. Check back later.', 'info');
                }
            }
            
        } catch (err) {
            console.error('Polling error:', err);
            if (attempts >= maxAttempts) {
                clearInterval(pollInterval);
                showToast('Could not verify payment status. Please refresh.', 'warning');
            }
        }
    }, interval);
}

// ADD this helper to stop polling when modal closes:
function stopPaymentPolling() {
    if (AppState.paymentPollInterval) {
        clearInterval(AppState.paymentPollInterval);
        AppState.paymentPollInterval = null;
    }
}

async function handleIndividualPaymentSubmit(e) {
    e.preventDefault();
    const employeeId = document.getElementById('paymentEmployee')?.value;
    if (!employeeId) {
        showToast('Please select an employee', 'warning');
        return;
    }
    await initiateIndividualPayment(employeeId);
}

// ADDED: Calculate and display bulk total dynamically
function updateBulkTotal() {
    const checkboxes = document.querySelectorAll('#bulkPaymentModal tbody input[type="checkbox"]');
    const selected = Array.from(checkboxes).filter(cb => cb.checked);
    
    let total = 0;
    selected.forEach(cb => {
        const empId = cb.value;
        const employee = AppState.employees.find(e => idsMatch(e.id, empId));
        if (employee) {
            const deductions = AppState.deductions
                .filter(d => d.employee === empId && d.status === 'pending')
                .reduce((sum, d) => sum + Number(d.amount || 0), 0);
            total += Number(employee.salary || 0) - deductions;
        }
    });
    
    document.getElementById('bulkTotalAmount').textContent = formatCurrency(total);
    document.getElementById('bulkTotalEmployees').textContent = selected.length;
}

// ==========================================
// SACKED EMPLOYEES
// ==========================================

async function loadSackedEmployees() {
    try {
        const res = await apiRequest('/api/sacked-employees/');
        if (!res.success) throw new Error(res.message);

        const list = res.data?.results || res.data || [];
        const tbody = AppState.elements.sackedTbody || document.getElementById('sackedTableBody');
        if (!tbody) return;

        tbody.innerHTML = '';
        
        if (!list.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center">No sacked employees found</td></tr>';
            return;
        }

        list.forEach(record => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${escapeHtml(record.employee_id || '-')}</td>
                <td>${escapeHtml(record.employee_name || '-')}</td>
                <td>${escapeHtml(record.employee_type || '-')}</td>
                <td>${escapeHtml(record.date_sacked || '-')}</td>
                <td>${escapeHtml(record.offense || '-')}</td>
                <td>${escapeHtml(record.terminated_by_name || '-')}</td>
                <td>
                    <button type="button" onclick="reinstateEmployee('${record.id}')" class="btn btn-sm btn-success">Reinstate</button>
                </td>
            `;
            tbody.appendChild(row);
        });
    } catch (err) {
        showToast(`Failed to load sacked employees: ${err.message}`, 'error');
    }
}

async function handleSackEmployee(e) {
    e.preventDefault();
    const btn = document.getElementById('confirmSackBtn') || e.target.querySelector('button[type="submit"]');

    const employeeId = document.getElementById('sackEmployeeId')?.value;
    const offense = document.getElementById('sackReason')?.value.trim();

    if (!employeeId || !offense) {
        showToast('Employee and offense reason are required', 'error');
        return;
    }

    try {
        showLoading(btn);
        
        const res = await apiRequest(`/api/employees/${employeeId}/terminate/`, {
            method: 'POST',
            body: { offense }
        });

        if (!res.success) throw new Error(res.message);

        showToast('Employee terminated successfully', 'success');
        closeModal('sackEmployeeModal');
        
        // FIXED: Immediately reload all relevant data
        await loadEmployees();
        await loadSackedEmployees();
        updateDashboardStats();
        updateUIAfterEmployeeLoad();
        
    } catch (err) {
        showToast(err.message || 'Failed to terminate employee', 'error');
    } finally {
        hideLoading(btn);
    }
}

async function reinstateEmployee(sackedId) {
    if (!confirm('Are you sure you want to reinstate this employee?')) return;

    try {
        const res = await apiRequest(`/api/sacked-employees/${sackedId}/reinstate/`, {
            method: 'POST'
        });

        if (!res.success) throw new Error(res.message);

        showToast('Employee reinstated successfully', 'success');
        
        // Reload relevant data
        await loadEmployees();
        await loadSackedEmployees();
        updateDashboardStats();
        updateUIAfterEmployeeLoad();
        
    } catch (err) {
        showToast(err.message || 'Failed to reinstate employee', 'error');
    }
}

// ==========================================
// NOTIFICATIONS
// ==========================================

async function loadNotifications() {
    const container = AppState.elements.notificationsContainer || document.getElementById('notificationsList');
    if (!container) return;

    try {
        const res = await apiRequest('/api/notifications/');
        if (!res.success) throw new Error(res.message);

        const list = res.data?.results || res.data || [];
        AppState.notifications = list;
        container.innerHTML = '';

        if (!list.length) {
            container.innerHTML = '<p class="text-muted">No notifications yet.</p>';
            return;
        }

        list.forEach(notification => {
            const item = document.createElement('div');
            const type = notification?.type || 'info';
            const createdAt = notification?.created_at 
                ? new Date(notification.created_at).toLocaleString() 
                : '';

            item.className = `notification ${type}`;
            item.innerHTML = `
                <strong>${escapeHtml(type.charAt(0).toUpperCase() + type.slice(1))}</strong>
                <p>${escapeHtml(notification?.message || '')}</p>
                ${createdAt ? `<div class="time text-muted">${escapeHtml(createdAt)}</div>` : ''}
            `;
            container.appendChild(item);
        });
    } catch (err) {
        container.innerHTML = '<p class="text-danger">Failed to load notifications.</p>';
        showToast(`Failed to load notifications: ${err.message}`, 'error');
    }
}

function clearAllNotifications() {
    const list = document.getElementById('notificationsList');
    if (list) list.innerHTML = '<p class="text-muted">No notifications yet.</p>';
    AppState.notifications = [];
}

// ==========================================
// MODAL FUNCTIONS
// ==========================================

function showIndividualPaymentModal() {
    populateEmployeeSelect('paymentEmployee');
    document.getElementById('paymentPreview').style.display = 'none';
    openModal('individualPaymentModal');
}

function showBulkPaymentModal() {
    populateBulkTable();
    openModal('bulkPaymentModal');
}

function showAddEmployeeModal() {
    openModal('addEmployeeModal');
}

function showAddDeductionModal() {
    populateEmployeeSelect('deductionEmployee');
    openModal('addDeductionModal');
}

function showAddCompanyModal() {
    AppState.currentEditingCompanyId = null;
    document.getElementById('addCompanyForm')?.reset();
    populateCompanyGuards();
    openModal('addCompanyModal');
}

function showClockInModal() {
    openModal('clockInModal');
}

// ADDED: Show leave modal
function showLeaveModal() {
    openModal('leaveModal');
}

function showSackEmployeeModal(empId) {
    const emp = AppState.employees.find(e => idsMatch(e.id, empId));
    if (!emp) {
        showToast('Employee not found', 'error');
        return;
    }

    const idField = document.getElementById('sackEmployeeId');
    const nameField = document.getElementById('sackEmployeeName');
    const dateField = document.getElementById('sackDate');
    const reasonField = document.getElementById('sackReason');
    
    if (idField) idField.value = emp.id;
    if (nameField) nameField.value = emp.name;
    if (dateField) dateField.value = new Date().toISOString().split('T')[0];
    if (reasonField) reasonField.value = '';
    
    openModal('sackEmployeeModal');
}

// ==========================================
// UI UPDATES & HELPERS
// ==========================================

function updateDashboardStats() {
    // FIXED: Recalculate from actual data, don't rely on stale state
    const activeEmployees = AppState.employees.filter(e => 
        e.status === 'active' || e.status === undefined || e.status === null
    );
    
    const totalStaff = activeEmployees.filter(e => e.type === 'staff').length;
    const totalGuards = activeEmployees.filter(e => e.type === 'guard').length;
    
    // Calculate total deductions (pending only)
    const totalDeductions = (AppState.deductions || []).reduce((sum, d) => {
        return d.status === 'pending' ? sum + Number(d.amount || 0) : sum;
    }, 0);
    
    // Calculate total payments (net salaries after pending deductions)
    const totalPayments = activeEmployees.reduce((sum, emp) => {
        const salary = Number(String(emp.salary).replace(/,/g, '').trim()) || 0;
        const empDeductions = (AppState.deductions || [])
            .filter(d => d.employee === emp.id && d.status === 'pending')
            .reduce((sum, d) => sum + Number(d.amount || 0), 0);
        return sum + (salary - empDeductions);
    }, 0);

    const elements = {
        totalStaff: document.getElementById('totalStaff'),
        totalGuards: document.getElementById('totalGuards'),
        totalPayments: document.getElementById('totalPayments'),
        totalDeductions: document.getElementById('totalDeductions')
    };

    if (elements.totalStaff) elements.totalStaff.textContent = totalStaff.toLocaleString();
    if (elements.totalGuards) elements.totalGuards.textContent = totalGuards.toLocaleString();
    if (elements.totalPayments) elements.totalPayments.textContent = formatCurrency(totalPayments);
    if (elements.totalDeductions) elements.totalDeductions.textContent = formatCurrency(totalDeductions);

    // FIXED: Also update monthly payments display
    const monthlyEl = document.getElementById('monthlyPayments');
    if (monthlyEl) monthlyEl.textContent = formatCurrency(totalPayments);

    updateRecentActivity();
}

function updateRecentActivity() {
    const container = document.getElementById('recentActivityList');
    if (!container) return;

    const activities = [];
    
    // Add recent employees
    (AppState.employees || []).slice(-3).forEach(e => {
        activities.push({
            text: `${e.type === 'staff' ? 'Staff' : 'Guard'} added: ${e.name}`,
            date: new Date().toLocaleDateString(),
            type: 'success'
        });
    });
    
    // Add recent payments
    (AppState.payments || []).slice(-3).forEach(p => {
        activities.push({
            text: `Payment ${p.status}: ${p.employee_name || 'Unknown'}`,
            date: p.payment_date,
            type: p.status === 'completed' ? 'success' : 'warning'
        });
    });
    
    // Add recent deductions
    (AppState.deductions || []).slice(-3).forEach(d => {
        activities.push({
            text: `Deduction ${d.status}: ${d.employee_name || 'Unknown'}`,
            date: d.date,
            type: d.status === 'applied' ? 'success' : 'warning'
        });
    });

    activities.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);

    if (!activities.length) {
        container.innerHTML = '<p class="text-muted">No recent activity</p>';
        return;
    }

    container.innerHTML = activities.map(act => `
        <div class="activity-item ${act.type}">
            <span class="activity-text">${escapeHtml(act.text)}</span>
            <span class="activity-date">${act.date}</span>
        </div>
    `).join('');
}

function updateUIAfterEmployeeLoad() {
    ['clockEmployee', 'deductionEmployee', 'paymentEmployee', 'payslipEmployee', 'leaveEmployee'].forEach(id => {
        populateEmployeeSelect(id);
    });
    updateDashboardStats();
}

function populateEmployeeSelect(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;

    const currentValue = select.value;
    select.innerHTML = '<option value="">Select Employee</option>';
    
    AppState.employees.forEach(emp => {
        const option = document.createElement('option');
        option.value = emp.id;
        option.textContent = `${escapeHtml(emp.name)} (${escapeHtml(emp.employee_id || 'No ID')})`;
        select.appendChild(option);
    });
    
    if (currentValue && AppState.employees.find(e => idsMatch(e.id, currentValue))) {
        select.value = currentValue;
    }
}

function populateCompanyGuards() {
    const container = document.getElementById('companyAssignedGuardsContainer');
    const select = document.getElementById('companyAssignedGuards');
    
    if (!container) return;

    container.innerHTML = '';
    
    if (!AppState.employees.length) {
        container.innerHTML = '<p class="text-muted">No employees available. Add guards first.</p>';
        return;
    }

    const guards = AppState.employees.filter(emp => emp.type === 'guard');
    
    if (!guards.length) {
        container.innerHTML = '<p class="text-muted">No guards found. Create guard accounts first.</p>';
        return;
    }

    guards.forEach(emp => {
        const div = document.createElement('div');
        div.className = 'guard-checkbox-item';
        div.innerHTML = `
            <label class="checkbox-label">
                <input type="checkbox" name="assigned_guards" value="${emp.id}" class="guard-checkbox">
                <span>${escapeHtml(emp.name)} (${escapeHtml(emp.employee_id || 'No ID')})</span>
            </label>
        `;
        container.appendChild(div);
    });

    if (select) {
        select.innerHTML = '';
        select.style.display = 'none';
        guards.forEach(emp => {
            const option = document.createElement('option');
            option.value = emp.id;
            option.textContent = emp.name;
            select.appendChild(option);
        });
    }
}

// FIXED: Proper bulk table with correct columns and event listeners
function populateBulkTable() {
    const tbody = document.getElementById('bulkPaymentTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    
    if (!AppState.employees.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center">No employees available</td></tr>';
        return;
    }
    
    const activeEmployees = AppState.employees.filter(e => e.status === 'active' || !e.status);
    
    activeEmployees.forEach(emp => {
        const deductions = AppState.deductions
            .filter(d => d.employee === emp.id && d.status === 'pending')
            .reduce((sum, d) => sum + Number(d.amount || 0), 0);
        const netSalary = Number(emp.salary || 0) - deductions;
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><input type="checkbox" value="${emp.id}" onchange="updateBulkTotal()"></td>
            <td>${escapeHtml(emp.employee_id || '-')}</td>
            <td>${escapeHtml(emp.name)}</td>
            <td>${escapeHtml(emp.bank_name || '-')} - ${escapeHtml(emp.account_number || '-')}</td>
            <td>${formatCurrency(netSalary)}</td>
        `;
        tbody.appendChild(row);
    });
    
    updateBulkTotal();
}

function populatePaymentsTable() {
    const tbody = document.getElementById('paymentsTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';
    
    if (!AppState.employees.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center">No employees available</td></tr>';
        return;
    }
    
    const activeEmployees = AppState.employees.filter(e => e.status === 'active' || !e.status);
    
    activeEmployees.forEach(emp => {
        const deductions = AppState.deductions
            .filter(d => d.employee === emp.id && d.status === 'pending')
            .reduce((sum, d) => sum + Number(d.amount || 0), 0);
        const baseSalary = Number(emp.salary || 0);
        const netSalary = baseSalary - deductions;
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><input type="checkbox" value="${emp.id}" class="payment-checkbox" onchange="updatePaymentSelection()"></td>
            <td>${escapeHtml(emp.employee_id || '-')}</td>
            <td>${escapeHtml(emp.name)}</td>
            <td>${escapeHtml(emp.bank_name || '-')} - ${escapeHtml(emp.account_number || '-')}</td>
            <td>${formatCurrency(baseSalary)}</td>
            <td>${formatCurrency(deductions)}</td>
            <td>${formatCurrency(netSalary)}</td>
            <td>
                <button type="button" class="btn btn-sm btn-success" onclick="initiateIndividualPayment('${emp.id}')">Pay</button>
            </td>
        `;
        tbody.appendChild(row);
    });
}

function updatePaymentSelection() {
    const checkboxes = document.querySelectorAll('.payment-checkbox:checked');
    const selectedCount = checkboxes.length;
    // Update any UI elements that show selected count if needed
    console.log(`Selected ${selectedCount} employees for payment`);
}

function toggleAllPayments() {
    const selectAllCheckbox = document.getElementById('selectAllPayments');
    const checkboxes = document.querySelectorAll('.payment-checkbox');
    checkboxes.forEach(cb => cb.checked = selectAllCheckbox.checked);
    updatePaymentSelection();
}

// ==========================================
// OTP MODAL
// ==========================================

function showOTPModal() {
    const modal = document.getElementById('otpModal');
    const input = document.getElementById('otpInput');
    if (modal) modal.classList.add('active');
    if (input) input.value = '';
    startOtpCountdown();
}

function startOtpCountdown() {
    const timerEl = document.getElementById('otpTimer');
    const verifyBtn = document.querySelector('#otpModal .btn-primary');
    const resendBtn = document.getElementById('resendOtpBtn');
    
    if (!timerEl) return;
    
    let time = 30;
    timerEl.textContent = time;
    
    if (verifyBtn) verifyBtn.disabled = false;
    if (resendBtn) resendBtn.disabled = true;
    
    clearInterval(AppState.otpTimerInterval);
    
    AppState.otpTimerInterval = setInterval(() => {
        time -= 1;
        timerEl.textContent = time;
        if (time <= 0) {
            clearInterval(AppState.otpTimerInterval);
            if (verifyBtn) verifyBtn.disabled = true;
            if (resendBtn) resendBtn.disabled = false;
            showToast('OTP expired. You can resend now.', 'warning');
        }
    }, 1000);
}

async function verifyOTP() {
    const otp = document.getElementById('otpInput')?.value.trim();
    if (!otp || !AppState.currentPaymentReference) {
        showToast('OTP or reference missing', 'warning');
        return;
    }

    const btn = document.querySelector('#otpModal .btn-primary');
    
    try {
        showLoading(btn);
        
        const res = await apiRequest('/api/payments/verify_payment/', {
            method: 'POST',
            body: { reference: AppState.currentPaymentReference, otp }
        });

        showToast(res.data?.message || 'Payment verified successfully', 'success');
        closeModal('otpModal');
        closeModal('individualPaymentModal');
        await loadPaymentHistory();
    } catch (err) {
        showToast('OTP verification failed', 'error');
    } finally {
        hideLoading(btn);
    }
}

// ==========================================
// PAYSIPS
// ==========================================

async function generatePayslip() {
    const employeeId = document.getElementById('payslipEmployee')?.value;
    const month = document.getElementById('payslipMonth')?.value;

    if (!employeeId || !month) {
        showToast('Please select employee and month', 'warning');
        return;
    }

    const btn = document.querySelector('#payslips button[onclick="generatePayslip()"]');
    
    try {
        showLoading(btn);
        
        const res = await apiRequest('/api/payments/generate_payslip/', {
            method: 'POST',
            body: { employee_id: employeeId, month }
        });

        if (!res.success) throw new Error(res.message);

        const preview = document.getElementById('payslipPreview');
        if (preview && res.data?.payslip_html) {
            preview.innerHTML = res.data.payslip_html;
            
            const downloadBtn = document.createElement('button');
            downloadBtn.className = 'btn btn-success mt-3';
            downloadBtn.innerHTML = '<i class="fas fa-download"></i> Download PDF';
            downloadBtn.onclick = () => downloadPayslip(res.data.payslip_html, employeeId, month);
            preview.appendChild(downloadBtn);
        }

        showToast('Payslip generated successfully', 'success');
    } catch (err) {
        showToast(err.message || 'Failed to generate payslip', 'error');
    } finally {
        hideLoading(btn);
    }
}

function downloadPayslip(html, employeeId, month) {
    // Show password modal for payslip download
    const passwordModal = document.getElementById('exportPasswordModal');
    if (passwordModal) {
        // Store the HTML temporarily for after password verification
        passwordModal.dataset.pendingPayslipHtml = html;
        passwordModal.dataset.pendingEmployeeId = employeeId;
        passwordModal.dataset.pendingMonth = month;
        openModal('exportPasswordModal');
    } else {
        // Fallback if modal doesn't exist
        const element = document.createElement('div');
        element.innerHTML = html;
        element.style.padding = '20px';
        document.body.appendChild(element);
        
        const opt = {
            margin: 1,
            filename: `payslip_${employeeId}_${month}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { scale: 2 },
            jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
        };

        html2pdf().set(opt).from(element).save().then(() => {
            element.remove();
        });
    }
}

// ADDED: Print payslip
function printPayslip() {
    const preview = document.getElementById('payslipPreview');
    if (!preview || !preview.innerHTML.trim()) {
        showToast('Generate a payslip first', 'warning');
        return;
    }
    
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <html>
            <head>
                <title>Print Payslip</title>
                <style>
                    body { font-family: Arial, sans-serif; padding: 20px; }
                    @media print { .no-print { display: none; } }
                </style>
            </head>
            <body>
                ${preview.innerHTML}
                <div class="no-print" style="margin-top: 20px; text-align: center;">
                    <button onclick="window.print()">Print</button>
                    <button onclick="window.close()">Close</button>
                </div>
            </body>
        </html>
    `);
    printWindow.document.close();
}

// ==========================================
// EXPORTS
// ==========================================

function exportAllEmployees() {
    const modal = document.getElementById('exportPasswordModal');
    if (modal) {
        modal.dataset.exportType = 'employees';
    }
    openModal('exportPasswordModal');
}

function exportPaymentHistory() {
    const modal = document.getElementById('exportPasswordModal');
    if (modal) {
        modal.dataset.exportType = 'payments';
    }
    openModal('exportPasswordModal');
}

function exportPaymentHistory() {
    const modal = document.getElementById('exportPasswordModal');
    if (modal) {
        modal.dataset.exportType = 'payments';
    }
    openModal('exportPasswordModal');
}

function confirmExport() {
    const password = document.getElementById('exportPassword')?.value;
    if (!password) {
        showToast('Password required', 'error');
        return;
    }

    apiRequest('/api/verify-password/', {
        method: 'POST',
        body: { password }
    }).then(res => {
        if (res.valid) {
            const modal = document.getElementById('exportPasswordModal');
            const exportType = modal?.dataset.exportType || 'employees';
            
            // Check if this is for payslip download
            if (modal && modal.dataset.pendingPayslipHtml) {
                const html = modal.dataset.pendingPayslipHtml;
                const employeeId = modal.dataset.pendingEmployeeId;
                const month = modal.dataset.pendingMonth;
                
                // Clear the temporary data
                delete modal.dataset.pendingPayslipHtml;
                delete modal.dataset.pendingEmployeeId;
                delete modal.dataset.pendingMonth;
                
                // Download the payslip
                const element = document.createElement('div');
                element.innerHTML = html;
                element.style.padding = '20px';
                document.body.appendChild(element);
                
                const opt = {
                    margin: 1,
                    filename: `payslip_${employeeId}_${month}.pdf`,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: { scale: 2 },
                    jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
                };

                html2pdf().set(opt).from(element).save().then(() => {
                    element.remove();
                });
                
                showToast('Payslip downloaded successfully', 'success');
                closeModal('exportPasswordModal');
                return;
            }
            
            // Handle different export types
            if (exportType === 'payments') {
                // Export payment history
                if (!AppState.payments.length) {
                    showToast('No payments to export', 'warning');
                    closeModal('exportPasswordModal');
                    return;
                }
                
                const csvContent = [
                    ['Date', 'Employee ID', 'Name', 'Bank Account', 'Amount', 'Method', 'Status'],
                    ...AppState.payments.map(p => [
                        p.payment_date,
                        p.employee_id,
                        p.employee_name,
                        p.bank_account,
                        p.net_amount,
                        p.payment_method || 'Paystack',
                        p.status
                    ])
                ].map(row => row.map(field => `"${String(field).replace(/"/g, '""')}"`).join(',')).join('\n');
                
                downloadCSV(csvContent, 'payment_history.csv');
                showToast('Payment history export successful', 'success');
            } else {
                // Export employees
                if (!AppState.employees.length) {
                    showToast('No employees to export', 'warning');
                    closeModal('exportPasswordModal');
                    return;
                }
                
                const csvContent = [
                    ['Employee ID', 'Name', 'Type', 'Location', 'Bank', 'Account Number', 'Salary', 'Status'],
                    ...AppState.employees.map(emp => [
                        emp.employee_id,
                        emp.name,
                        emp.type,
                        emp.location,
                        emp.bank_name,
                        emp.account_number,
                        emp.salary,
                        emp.status || 'Active'
                    ])
                ].map(row => row.map(field => `"${String(field).replace(/"/g, '""')}"`).join(',')).join('\n');
                
                downloadCSV(csvContent, 'employees_export.csv');
                showToast('Employee export successful', 'success');
            }
            
            closeModal('exportPasswordModal');
        } else {
            showToast('Invalid password', 'error');
        }
    }).catch(err => {
        showToast('Password verification failed', 'error');
    });
}

function downloadCSV(content, filename) {
    const blob = new Blob(['\ufeff' + content], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}

// ==========================================
// FILTER FUNCTIONS
// ==========================================

function filterHistory() {
    const search = document.getElementById('historySearch')?.value.toLowerCase();
    const fromDate = document.getElementById('historyDateFrom')?.value;
    const toDate = document.getElementById('historyDateTo')?.value;

    let filtered = AppState.payments || [];
    
    if (search) {
        filtered = filtered.filter(p => 
            (p.employee_name || '').toLowerCase().includes(search) ||
            (p.employee_id || '').toLowerCase().includes(search)
        );
    }
    
    if (fromDate) {
        filtered = filtered.filter(p => p.payment_date >= fromDate);
    }
    
    if (toDate) {
        filtered = filtered.filter(p => p.payment_date <= toDate);
    }
    
    // Re-render with filtered data
    const tbody = document.getElementById('historyTableBody');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center">No matching records</td></tr>';
        return;
    }
    
    filtered.forEach(payment => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${escapeHtml(payment.payment_date || '-')}</td>
            <td>${escapeHtml(payment.employee_id || '-')}</td>
            <td>${escapeHtml(payment.employee_name || '-')}</td>
            <td>${escapeHtml(payment.bank_account || '-')}</td>
            <td>${formatCurrency(payment.net_amount)}</td>
            <td>${escapeHtml(payment.payment_method || 'Paystack')}</td>
            <td>${escapeHtml(payment.status || '-')}</td>
            <td>-</td>
        `;
        tbody.appendChild(row);
    });
    
    showToast(`Showing ${filtered.length} records`, 'info');
}

function toggleAllBulkPayments() {
    const selectAll = document.getElementById('selectAllBulk')?.checked;
    const checkboxes = document.querySelectorAll('#bulkPaymentModal tbody input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = selectAll);
    updateBulkTotal(); // ADDED: Update total when toggling all
}

function resendOTP() {
    showToast('OTP resent', 'info');
    startOtpCountdown();
}

// ==========================================
// EMPLOYEE ID GENERATION - FIXED
// ==========================================

function setupEmployeeIdGeneration() {
    const typeSelect = document.getElementById('accountType');
    const nameInput = document.getElementById('accountName');
    const displayEl = document.getElementById('generatedEmployeeId');
    const form = document.getElementById('createAccountForm');

    const generateId = async () => {
        const type = typeSelect?.value;
        const name = nameInput?.value?.trim();
        
        if (!type || !name) {
            if (displayEl) {
                displayEl.textContent = '-';
                displayEl.style.color = '#007bff';
            }
            const hiddenInput = document.getElementById('generatedEmployeeIdInput');
            if (hiddenInput) hiddenInput.value = '';
            return;
        }

        // Show loading state
        if (displayEl) displayEl.textContent = 'Generating...';
        
        const nextId = await fetchNextEmployeeId(type);
        
        if (displayEl) {
            displayEl.textContent = nextId;
            displayEl.style.color = '#28a745'; // Green to indicate success
        }
        
        // Update hidden input
        let hiddenInput = document.getElementById('generatedEmployeeIdInput');
        if (!hiddenInput) {
            hiddenInput = document.createElement('input');
            hiddenInput.type = 'hidden';
            hiddenInput.id = 'generatedEmployeeIdInput';
            hiddenInput.name = 'employee_id';
            document.getElementById('createAccountForm')?.appendChild(hiddenInput);
        }
        hiddenInput.value = nextId;
    };

    if (typeSelect) typeSelect.addEventListener('change', generateId);
    if (nameInput) {
        nameInput.addEventListener('blur', generateId);
        nameInput.addEventListener('input', debounce(generateId, 300));
    }
    form?.addEventListener('reset', () => {
        setTimeout(() => {
            if (displayEl) {
                displayEl.textContent = '-';
                displayEl.style.color = '#007bff';
            }
            const hiddenInput = document.getElementById('generatedEmployeeIdInput');
            if (hiddenInput) hiddenInput.value = '';
        }, 0);
    });
}


// ==========================================
// EVENT LISTENERS & SETUP
// ==========================================

function initEmployeeSearch() {
    const searchInput = document.getElementById('employeeSearch');
    const typeFilter = document.getElementById('employeeTypeFilter');
    
    const filterEmployees = () => {
        const query = searchInput?.value.toLowerCase() || '';
        const type = typeFilter?.value || 'all';
        
        let filtered = AppState.employees;
        
        if (type !== 'all') {
            filtered = filtered.filter(emp => emp.type === type);
        }
        
        if (query) {
            filtered = filtered.filter(emp => 
                (emp.name || '').toLowerCase().includes(query) ||
                (emp.employee_id || '').toLowerCase().includes(query) ||
                (emp.location || '').toLowerCase().includes(query)
            );
        }
        
        renderEmployees(filtered);
    };

    if (searchInput) searchInput.addEventListener('input', debounce(filterEmployees, 300));
    if (typeFilter) typeFilter.addEventListener('change', filterEmployees);
}

function setupBankCodeTracking() {
    const bankSelects = [
        document.getElementById('accountBankName'),
        document.getElementById('newEmployeeBankName')
    ];

    bankSelects.forEach(select => {
        if (!select) return;
        select.addEventListener('change', () => {
            const option = select.options[select.selectedIndex];
            if (option?.dataset?.code) {
                select.dataset.bankCode = option.dataset.code;
            } else {
                delete select.dataset.bankCode;
            }
        });
    });
}

function setupEventListeners() {
    initEmployeeSearch();
    setupEmployeeIdGeneration();
    setupBankCodeTracking();
    setupBankVerification();
    document.getElementById('verifyAccountBtn')?.addEventListener('click', verifyBankAccountManual);
    
    // Hamburger menu
    const hamburger = document.getElementById('hamburgerBtn');
    const sidebar = document.getElementById('sidebar');
    
    if (hamburger && sidebar) {
        hamburger.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            sidebar.classList.toggle('active');
        });
        
        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 && 
                sidebar.classList.contains('active') &&
                !sidebar.contains(e.target) && 
                !hamburger.contains(e.target)) {
                sidebar.classList.remove('active');
            }
        });
    }
    
    // Form submissions
    const forms = [
        { id: 'loginForm', handler: handleLogin },
        { id: 'clockInForm', handler: handleClockIn },
        { id: 'individualPaymentForm', handler: handleIndividualPaymentSubmit },
        { id: 'sackEmployeeForm', handler: handleSackEmployee },
        { id: 'addCompanyForm', handler: handleCreateCompany },
        { id: 'addDeductionForm', handler: addDeduction },
        { id: 'editDeductionForm', handler: updateDeduction },
        { id: 'addEmployeeForm', handler: handleCreateEmployee },
        { id: 'createAccountForm', handler: createAccount },
        { id: 'leaveForm', handler: handleMarkLeave } // ADDED
    ];

    forms.forEach(({ id, handler }) => {
        const form = document.getElementById(id);
        if (form) {
            form.addEventListener('submit', handler);
            console.log(`Attached handler to form: ${id}`);
        } else {
            console.warn(`Form not found: ${id}`);
        }
    });
}

// ==========================================
// DASHBOARD & INITIALIZATION
// ==========================================

async function loadDashboard() {
    if (!AppState.currentUser) {
        await loadCurrentUser();
    }
    if (!AppState.currentUser) return;

    showDashboardPage();
    applyRolePermissions(AppState.currentUser);

    try {
        // Step 1: Critical data (sequential)
        await loadEmployees();
        await loadDeductions();

        // Step 2: Medium priority (parallel but limited)
        await Promise.all([
            loadAttendance(),
            loadSackedEmployees(),
            loadNotifications()
        ]);

        // Step 3: Admin-only
        if (AppState.currentUser?.is_superuser || 
            AppState.currentUser?.role === 'admin' || 
            AppState.currentUser?.is_company_admin) {
            await loadCompanies();
        }

        // Step 4: Delay heavy endpoints
        if (AppState.currentUser?.is_superuser || AppState.currentUser?.role === 'admin') {
            setTimeout(loadPaymentHistory, 1500);
        }

        // Step 5: Non-critical
        setTimeout(loadNigerianBanks, 2000);

    } catch (err) {
        console.error('Dashboard load error:', err);
    }
}

function showLoginPage() {
    document.getElementById('dashboardPage')?.classList.add('hidden');
    document.getElementById('loginPage')?.classList.remove('hidden');
}

function showDashboardPage() {
    document.getElementById('loginPage')?.classList.add('hidden');
    document.getElementById('dashboardPage')?.classList.remove('hidden');
}

// ==========================================
// INITIALIZATION
// ==========================================

document.addEventListener('DOMContentLoaded', async () => {
    console.log('DOM Content Loaded - Initializing Application');
    
    // Cache DOM elements
    AppState.elements.tbody = document.getElementById('employeeTableBody');
    AppState.elements.deductionsTbody = document.getElementById('deductionsTableBody');
    AppState.elements.attendanceTbody = document.getElementById('attendanceTableBody');
    AppState.elements.companiesTbody = document.getElementById('companiesTableBody');
    AppState.elements.sackedTbody = document.getElementById('sackedTableBody');
    AppState.elements.historyTbody = document.getElementById('historyTableBody');
    AppState.elements.notificationsContainer = document.getElementById('notificationsList');
    AppState.elements.toastContainer = document.getElementById('toastContainer');
    AppState.elements.globalSpinner = document.getElementById('globalSpinner');

    const storedToken = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken');
    const storedRefresh = localStorage.getItem('refreshToken');
    
    if (!storedToken) {
        console.log('No token found, showing login page');
        showLoginPage();
        setupEventListeners();
        return;
    }

    AppState.accessToken = storedToken;
    if (storedRefresh) AppState.refreshToken = storedRefresh;

        try {
        if (isJwtExpired(AppState.accessToken)) {
            console.log('Stored access token expired, refreshing before verification...');
            const refreshed = await refreshAccessToken();
            if (!refreshed) throw new Error('Cannot refresh token');
        }

        console.log('Verifying token on page load...');
        const res = await apiRequest('/api/current-user/');
        
        if (res.success && res.data) {
            console.log('Token valid, loading dashboard');
            AppState.currentUser = res.data;
            await loadDashboard();
        } else {
            console.log('Token invalid, attempting refresh...');
            const refreshed = await refreshAccessToken();
            
            if (refreshed) {
                const retryRes = await apiRequest('/api/current-user/');
                if (retryRes.success && retryRes.data) {
                    AppState.currentUser = retryRes.data;
                    await loadDashboard();
                } else {
                    throw new Error('Token refresh failed - user data missing');
                }
            } else {
                throw new Error('Cannot refresh token');
            }
        }
    } catch (err) {
        console.error('Auth failed:', err.message);
        logout();
        showLoginPage();
    }
    
    setupEventListeners();
    console.log('Application initialization complete');
});

async function verifyBankAccountManual() {
    const accountInput = document.getElementById('accountNumber');
    const bankSelect = document.getElementById('accountBankName');
    const holderInput = document.getElementById('accountHolderName');
    const statusEl = document.getElementById('verificationStatus');
    return verifyBankAccountFields({ accountInput, bankSelect, holderInput, statusEl, manual: true });
    
    const accountNumber = accountInput?.value.trim();
    const selectedOption = bankSelect?.options[bankSelect.selectedIndex];
    const bankCode = selectedOption?.dataset?.code;
    const verificationKey = `${bankCode || ''}:${accountNumber}`;
    
    if (!accountNumber || accountNumber.length !== 10) {
        showToast('Enter valid 10-digit account number', 'error');
        return;
    }
    if (!bankCode) {
        showToast('Select a valid bank first', 'error');
        return;
    }
    if (AppState.pendingAccountVerificationKey === verificationKey) {
        showToast('Verification already in progress', 'info');
        return;
    }
    if (AppState.lastVerifiedAccountKey === verificationKey && holderInput?.value.trim()) {
        statusEl.textContent = `Verified: ${holderInput.value.trim()}`;
        statusEl.className = 'text-success';
        return;
    }
    
    AppState.pendingAccountVerificationKey = verificationKey;
    holderInput.value = 'Verifying...';
    holderInput.disabled = true;
    statusEl.textContent = 'Verifying with Paystack...';
    statusEl.className = 'text-info';
    
    try {
        const res = await apiRequest('/api/paystack/verify-account/', {
            method: 'POST',
            body: { account_number: accountNumber, bank_code: bankCode }
        });
        
        if (res.success && res.data?.status === true && res.data?.data?.account_name) {
            holderInput.value = res.data.data.account_name;
            holderInput.style.background = '#d4edda';
            statusEl.textContent = `✓ Verified: ${res.data.account_name}`;
            statusEl.className = 'text-success';
            statusEl.textContent = `Verified: ${res.data.data.account_name}`;
            AppState.lastVerifiedAccountKey = verificationKey;
            showToast('Account verified successfully', 'success');
        } else {
            holderInput.value = '';
            holderInput.style.background = '#f8d7da';
            statusEl.textContent = 'Verification failed';
            statusEl.className = 'text-danger';
            statusEl.textContent = res.message || res.data?.message || 'Verification failed';
            holderInput.readOnly = true;
            showToast(res.message || res.data?.message || 'Verification failed', 'error');
            AppState.lastVerifiedAccountKey = null;
        }
    } catch (err) {
        holderInput.value = '';
        holderInput.readOnly = true;
        AppState.lastVerifiedAccountKey = null;
        statusEl.textContent = 'Error verifying account. Try again later.';
        statusEl.className = 'text-warning';
        showToast('Verification service unavailable', 'error');
    } finally {
        AppState.pendingAccountVerificationKey = null;
        holderInput.disabled = false;
    }
}


// ==========================================
// GLOBAL EXPORTS - MUST BE AT END OF FILE
// ==========================================

const EXPOSED_FUNCTIONS = {
    // Auth
    handleLogin,
    logout,
    refreshAccessToken,
    
    // Navigation
    showSection,
    openModal,
    closeModal,
    
    // Employees
    loadEmployees,
    renderEmployees,
    handleCreateEmployee,
    handleDelete,
    createAccount,
    fetchNextEmployeeId,
    setupEmployeeIdGeneration,
    
    // Companies
    loadCompanies,
    renderCompanies,
    handleCreateCompany,
    editCompany,
    deleteCompany,
    populateCompanyGuards,
    
    // Deductions
    loadDeductions,
    renderDeductions,
    addDeduction,
    updateDeduction,
    deleteDeduction,
    editDeduction,
    
    // Attendance
    loadAttendance,
    handleClockIn,
    startCamera,
    capturePhoto,
    handleMarkLeave,
    updateAttendanceStats,
    
    // Payments
    loadPaymentHistory,
    initiateIndividualPayment,
    handleIndividualPaymentSubmit,
    processBulkPayment,
    updatePaymentPreview,
    updateBulkTotal,
    toggleAllBulkPayments,
    populateBulkTable,
    
    // Payslips
    generatePayslip,
    printPayslip,
    downloadPayslip,
    
    // Sacked
    loadSackedEmployees,
    handleSackEmployee,
    showSackEmployeeModal,
    
    // Notifications
    loadNotifications,
    clearAllNotifications,
    
    // Exports
    exportAllEmployees,        // <-- THIS WAS MISSING
    exportPaymentHistory,
    confirmExport,
    
    // Filters
    filterHistory,
    
    // OTP
    showOTPModal,
    verifyOTP,
    resendOTP,
    startOtpCountdown,
    
    // Bank verification
    verifyBankAccountManual,
    setupBankVerification,
    setupBankCodeTracking,
    viewEmployeeDetail,
    
    // Misc
    showToast,
    showLoading,
    hideLoading,
    showIndividualPaymentModal,
    showBulkPaymentModal,
    showAddEmployeeModal,
    showAddDeductionModal,
    showAddCompanyModal,
    showClockInModal,
    showLeaveModal,
    applyRolePermissions,
    loadCurrentUser,
    loadDashboard,
    loadNigerianBanks,
    populateBankSelects,
    populateEmployeeSelect,
    updateDashboardStats,
    updateRecentActivity,
    updateUIAfterEmployeeLoad,
    initEmployeeSearch,
    setupEventListeners,
    debounce,
    formatCurrency,
    formatDate,
    escapeHtml,
    buildUrl,
    apiRequest,
    getCookie,
    blobToDataUrl,
};

function openChangePasswordModal() {
    const modal = document.getElementById('changePasswordModal');
    if (!modal) {
        showToast('Change password modal not found', 'error');
        return;
    }
    document.getElementById('oldPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    modal.classList.add('active');
}

function showChangePasswordModal() {
    openChangePasswordModal();
}

// Expose all functions to window
Object.keys(EXPOSED_FUNCTIONS).forEach(key => {
    window[key] = EXPOSED_FUNCTIONS[key];
});
window.showChangePasswordModal = showChangePasswordModal;
window.openChangePasswordModal = openChangePasswordModal;

console.log('All functions exported to window object:', Object.keys(EXPOSED_FUNCTIONS));
