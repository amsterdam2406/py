(() => {
  // Use the EXISTING static modal from index.html (#selfSignupModal)
  function showSelfSignupModal() {
    const modal = document.getElementById('selfSignupModal');
    if (!modal) return;
    if (typeof window.loadNigerianBanks === 'function') {
      window.loadNigerianBanks();
    }
    modal.style.display = 'flex';
    modal.classList.add('active');
  }

  function closeSelfSignupModal() {
    const modal = document.getElementById('selfSignupModal');
    if (!modal) return;
    modal.style.display = 'none';
    modal.classList.remove('active');
  }

  function notify(message, type = 'info') {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
      return;
    }
    console[type === 'error' ? 'error' : 'log'](message);
  }

  function formatSignupError(data, fallback) {
    if (!data || typeof data !== 'object') return fallback;
    if (typeof window.formatApiError === 'function') {
      return window.formatApiError(data, fallback);
    }

    const labels = {
      username: 'Username',
      password: 'Password',
      full_name: 'Full name',
      role: 'Role',
      email: 'Email address',
      phone: 'Phone number',
      salary: 'Salary',
      bank_name: 'Bank name',
      bank_code: 'Bank code',
      account_number: 'Account number',
      account_holder: 'Account holder'
    };
    const direct = data.detail || data.error || data.message;
    if (typeof direct === 'string') return direct;
    if (direct && typeof direct === 'object') return formatSignupError(direct, fallback);

    const message = Object.entries(data)
      .map(([field, value]) => {
        const label = labels[field] || field.replace(/_/g, ' ');
        const text = Array.isArray(value) ? value.join(', ') : String(value || '');
        const lower = text.toLowerCase();
        if (lower.includes('required') || lower.includes('missing')) return `${label} is required.`;
        if (lower.includes('invalid')) return `${label} is invalid.`;
        if (lower.includes('already') || lower.includes('exists')) return `${label} already exists.`;
        return `${label}: ${text}`;
      })
      .join('; ');
    return message || fallback;
  }

  function validateSignupEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    if (!email) return 'Email address is required.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.';
    return '';
  }

  // Wire up the static modal's close button and backdrop click
  function initSelfSignupModal() {
    const modal = document.getElementById('selfSignupModal');
    if (!modal) return;

    // Close on X button
    const closeBtn = modal.querySelector('.close');
    if (closeBtn) {
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        closeSelfSignupModal();
      };
    }

    // Close on backdrop click (but NOT when clicking inside modal-content)
    modal.onclick = (e) => {
      if (e.target === modal) closeSelfSignupModal();
    };

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('active')) {
        closeSelfSignupModal();
      }
    });
  }

  // Expose globally for inline onclick handlers
  window.showSelfSignupModal = showSelfSignupModal;
  window.closeSelfSignupModal = closeSelfSignupModal;

  async function submitSelfSignup() {
    const form = document.getElementById('selfSignupForm');
    if (!form) return;
    if (form.dataset.submitHandlerBound === 'true') return;
    if (form.dataset.selfSignupSubmitBound === 'true') return;
    form.dataset.selfSignupSubmitBound = 'true';
    form.dataset.submitHandlerBound = 'true';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const getVal = (id) => (document.getElementById(id)?.value || '').trim();
      const bankSelect = document.getElementById('signupBankName');
      const selectedBank = bankSelect?.selectedOptions?.[0] || bankSelect?.options?.[bankSelect?.selectedIndex];
      const bankCode = selectedBank?.dataset?.code || '';

      const payload = {
        username: getVal('signupUsername'),
        password: getVal('signupPassword'),
        full_name: getVal('signupFullName'),
        role: getVal('signupRole'),
        email: getVal('signupEmail'),
        location: getVal('signupLocation'),
        salary: Number(getVal('signupSalary') || '0'),
        phone: getVal('signupPhone'),

        bank_name: getVal('signupBankName'),
        bank_code: bankCode,
        account_number: getVal('signupAccountNumber'),
        account_holder: getVal('signupAccountHolder')
      };

      const emailError = validateSignupEmail(payload.email);
      if (emailError) {
        notify(emailError, 'warning');
        return;
      }

      // Basic client-side validation for missing fields
      const requiredBank = ['bank_name', 'bank_code', 'account_number', 'account_holder'];
      const missingBank = requiredBank.filter((k) => !payload[k]);
      if (missingBank.length) {
        notify(`Missing required bank/account fields: ${missingBank.join(', ')}`, 'warning');
        return;
      }

      // Block submission if account holder was not verified/finalized
      if ((payload.account_holder || '').trim().length < 2) {
        notify('Account holder name is required and must be verified. Please verify the account first.', 'warning');
        return;
      }


      try {
        const res = await fetch('/self-register/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          notify(formatSignupError(data, 'Self-registration failed. Please try again.'), 'error');
          return;
        }

        notify(data?.message || 'Account created! Your registration is pending admin approval.', 'success');
        closeSelfSignupModal();
        // Reset form to avoid resubmission with old bank values
        form.reset();
      } catch (err) {
        console.error(err);
        notify('Self-registration failed due to a network/server error.', 'error');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initSelfSignupModal();
    submitSelfSignup();
  });
})();

