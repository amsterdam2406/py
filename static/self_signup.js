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

      // Basic client-side validation for missing fields
      const requiredBank = ['bank_name', 'bank_code', 'account_number', 'account_holder'];
      const missingBank = requiredBank.filter((k) => !payload[k]);
      if (missingBank.length) {
        alert(`Missing required bank/account fields: ${missingBank.join(', ')}`);
        return;
      }

      // Block submission if account holder was not verified/finalized
      if ((payload.account_holder || '').trim().length < 2) {
        alert('Account holder name is required and must be verified. Please verify the account first.');
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
          alert(data?.error || 'Self-registration failed. Please try again.');
          return;
        }

        alert(data?.message || 'Account created! Your registration is pending admin approval.');
        closeSelfSignupModal();
        // Reset form to avoid resubmission with old bank values
        form.reset();
      } catch (err) {
        console.error(err);
        alert('Self-registration failed due to a network/server error.');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initSelfSignupModal();
    submitSelfSignup();
  });
})();

