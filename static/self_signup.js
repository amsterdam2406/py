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
                <!-- Password Strength Indicator -->
                <div class="strength-meter-container" style="height: 4px; background: #eee; margin-top: 5px; border-radius: 2px; overflow: hidden;">
                    <div id="passwordStrength" style="height: 100%; width: 0; transition: all 0.3s ease;"></div>
                </div>
                <small id="passwordFeedback" class="form-text text-muted">Min 8 chars, uppercase, number & symbol</small>
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

    // Close handlclick on the backdrop only
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

    // CONSOLIDATED: Link to the unified handler in script.js
    const form = modal.querySelector('#createAccountForm');
    if (form) form.addEventListener('submit', (e) => window.handleRegistration(e, true));

    // Ensure Bank verification is wired up for this dynamic modal
    setTimeout(() => {
        if (typeof window.setupBankVerification === 'function') {
            window.setupBankVerification();
        }
        if (typeof window.setupEmployeeIdGeneration === 'function') {
            window.setupEmployeeIdGeneration();
        }
    }, 100);

    return modal;
  }


  function showSelfSignupModal() {
    const modal = ensureModal();
    modal.style.display = 'block';
  }

  // Expose globals expected by inline handlers
  window.showSelfSignupModal = showSelfSignupModal;

  document.addEventListener('DOMContentLoaded', () => {
    const signupBtn = document.getElementById('signup-btn');
    if (signupBtn) signupBtn.addEventListener('click', showSelfSignupModal);
  });
})();
