(() => {
  function ensureModal() {
    return document.getElementById('signup-modal') || createSignupModal();
  }

  function createSignupModal() {
    const modal = document.createElement('div');
    modal.id = 'signup-modal';
    modal.className = 'modal';

    modal.innerHTML = `
      <section class="content-section" id="accounts">
        <div class="section-header">
          <h2><i class="fas fa-user-plus"></i> Create Employee Accounts</h2>
        </div>
        <div class="account-creation-form">
          <form id="createAccountForm">
            <div class="form-row">
              <div class="form-group">
                <label for="accountType">Employee Type</label>
                <select id="accountType" class="form-control" required>
                  <option value="">Select Type</option>
                  <option value="staff">Staff</option>
                  <option value="guard">Guard</option>
                </select>
              </div>
              <div class="form-group">
                <label for="accountName">Full Name</label>
                <input type="text" id="accountName" class="form-control" required>
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label for="accountUsername">Username</label>
                <input type="text" id="accountUsername" name="username" class="form-control" required autocomplete="username">
              </div>
              <div class="form-group">
                <label for="accountPassword">Password</label>
                <input type="password" id="accountPassword" class="form-control" required autocomplete="new-password">
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label for="accountLocation">Location/Role</label>
                <input type="text" id="accountLocation" class="form-control" required>
              </div>
              <div class="form-group">
                <label for="accountSalary">Monthly Salary (₦)</label>
                <input type="number" id="accountSalary" class="form-control" required>
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label for="accountPhone">Phone Number</label>
                <input type="tel" id="accountPhone" class="form-control">
              </div>
              <div class="form-group">
                <label for="accountEmail">Email</label>
                <input type="email" id="accountEmail" class="form-control">
              </div>
            </div>

            <h3>Bank Account Details (Nigerian Banks - Naira)</h3>

            <div class="form-row">
              <div class="form-group">
                <label for="accountBankName">Bank Name</label>
                <select id="accountBankName" class="form-control" required>
                  <option value="">Select Bank</option>
                  <!-- Banks loaded dynamically from Paystack in script.js (if available) -->
                </select>
                <small class="text-muted">Select bank to enable auto-verification</small>
              </div>

              <div class="form-group">
                <label for="accountNumber">Account Number</label>
                <div style="display: flex; gap: 10px;">
                  <input type="text" id="accountNumber" class="form-control" maxlength="10" required
                    placeholder="Enter 10-digit number" style="flex: 1;">
                  <button type="button" id="verifyAccountBtn" class="btn btn-secondary" style="white-space: nowrap;">
                    <i class="fas fa-check-circle"></i> Verify
                  </button>
                </div>
                <small id="verificationStatus" class="text-muted">Enter 10-digit account number to auto-verify</small>
              </div>
            </div>

            <div class="form-group">
              <label for="accountHolderName">Account Holder Name</label>
              <input type="text" id="accountHolderName" class="form-control" required
                placeholder="Auto-filled after verification" readonly style="background: #f8f9fa;">
              <small class="text-muted">This will be auto-filled when account is verified</small>
            </div>

            <div class="generated-id-display">
              <p style="margin: 0; font-size: 16px;">
                Generated Employee ID:
                <strong id="generatedEmployeeId" style="color: #007bff; font-size: 18px;">-</strong>
              </p>
            </div>

            <button type="submit" id="createAccountBtn" class="btn btn-primary btn-block">
              <i class="fas fa-user-plus"></i> Create Account
            </button>
          </form>
        </div>
      </section>
    `;

    document.body.appendChild(modal);

    // Close handler: click on the backdrop only
    modal.addEventListener('click', (ev) => {
      if (ev.target === modal) modal.style.display = 'none';
    });

    // Safety: avoid crashes if an expected close button doesn't exist.
    // (prevents runtime errors like: Cannot set properties of null (setting 'onclick')).
    const closeBtn = modal.querySelector('.close, [data-modal-close]');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
      });
    }

    // Ensure the modal is hidden until explicitly opened.
    modal.style.display = 'none';

    const form = modal.querySelector('#createAccountForm');
    if (form) form.addEventListener('submit', handleSelfSignup);

    return modal;
  }


  function showSelfSignupModal() {
    const modal = ensureModal();
    modal.style.display = 'block';
  }

  async function handleSelfSignup(e) {
    e.preventDefault();

    const accountType = document.getElementById('accountType')?.value;
    const fullName = document.getElementById('accountName')?.value?.trim();
    const username = document.getElementById('accountUsername')?.value?.trim();
    const password = document.getElementById('accountPassword')?.value;
    const location = document.getElementById('accountLocation')?.value?.trim();
    const salary = document.getElementById('accountSalary')?.value;
    const phone = document.getElementById('accountPhone')?.value;
    const email = document.getElementById('accountEmail')?.value;
    const bankName = document.getElementById('accountBankName')?.value;
    const bankCode = document.getElementById('accountBankName')?.selectedOptions?.[0]?.dataset?.code || '';
    const accountNumber = document.getElementById('accountNumber')?.value?.trim();
    const accountHolder = document.getElementById('accountHolderName')?.value?.trim();

    const missing = [];
    if (!accountType) missing.push('Employee Type');
    if (!fullName) missing.push('Full Name');
    if (!username) missing.push('Username');
    if (!password) missing.push('Password');
    if (!location) missing.push('Location/Role');
    if (!salary) missing.push('Monthly Salary');
    if (!email) missing.push('Email');
    if (!bankName) missing.push('Bank Name');
    if (!accountNumber) missing.push('Account Number');
    if (!accountHolder) missing.push('Account Holder Name');

    if (missing.length) {
      const msg = 'Missing fields: ' + missing.join(', ');
      if (typeof window.showToast === 'function') window.showToast(msg, 'warning');
      else alert(msg);
      return;
    }

    const payload = {
      username,
      password,
      full_name: fullName,
      role: accountType,
      email,
      location,
      salary,
      phone,
      bank_name: bankName,
      bank_code: bankCode,
      account_number: accountNumber,
      account_holder: accountHolder,
    };

    const btn = document.getElementById('createAccountBtn');
    try {
      if (typeof window.showLoading === 'function' && btn) window.showLoading(btn);

      const response = await fetch('/api/self-register/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = await response.json().catch(() => ({}));

      const show = typeof window.showToast === 'function'
        ? window.showToast
        : (msg, _type = 'info') => alert(msg);

      if (response.ok) {
        show(result.message || 'Registration successful. Waiting for admin approval.', 'success');

        const modalEl = document.getElementById('signup-modal');
        if (modalEl) modalEl.style.display = 'none';

        // Refresh admin dashboard stats/tables if those functions exist
        if (typeof window.loadEmployees === 'function') {
          await window.loadEmployees();
        }
        if (typeof window.loadDeductions === 'function') {
          await window.loadDeductions();
        }
        if (typeof window.updateDashboardStats === 'function') {
          window.updateDashboardStats();
        }

      } else {
        show('Error: ' + (result.error || result.message || 'Self signup failed'), 'error');
      }
    } catch (error) {
      const show = typeof window.showToast === 'function'
        ? window.showToast
        : (msg, _type = 'info') => alert(msg);
      show('Network error: ' + (error?.message || error), 'error');
    } finally {
      if (typeof window.hideLoading === 'function' && btn) window.hideLoading(btn);
    }
  }

  // Expose globals expected by inline handlers
  window.showSelfSignupModal = showSelfSignupModal;

  document.addEventListener('DOMContentLoaded', () => {
    const signupBtn = document.getElementById('signup-btn');
    if (signupBtn) signupBtn.addEventListener('click', showSelfSignupModal);
  });
})();
