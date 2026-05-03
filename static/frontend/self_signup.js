// Self-signup modal logic
document.addEventListener('DOMContentLoaded', () => {
  const signupBtn = document.getElementById('signup-btn');
  if (signupBtn) {
    signupBtn.addEventListener('click', showSignupModal);
  }
  // Add global function for direct onclick calls from index.html
  window.showSelfSignupModal = showSelfSignupModal;
});

function showSignupModal() {
  const modal = document.getElementById('signup-modal') || createSignupModal();
  modal.style.display = 'block';
}

function showSelfSignupModal() {
  const modal = document.getElementById('signup-modal') || createSignupModal();
  modal.style.display = 'block';
}

function createSignupModal() {
  const modal = document.createElement('div');
  modal.id = 'signup-modal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content">
      <span class="close">&times;</span>
      <h2>Create Employee Account</h2>
      <form id="signup-form">
        <div class="form-row">
          <div class="form-group">
            <label>Full Name</label>
            <input type="text" id="full_name" placeholder="Enter full name" required>
          </div>
          <div class="form-group">
            <label>Email Address</label>
            <input type="email" id="email" placeholder="employee@company.com" required>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Department/Location</label>
            <input type="text" id="location" placeholder="e.g., Main Gate, Lagos Branch" required>
          </div>
          <div class="form-group">
            <label>Employee Type</label>
            <select id="role" required>
              <option value="">Select Role</option>
              <option value="staff">Staff (Admin/Office)</option>
              <option value="guard">Security Guard</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Monthly Salary (₦)</label>
            <input type="number" id="salary" placeholder="50000" min="0" step="1000">
          </div>
          <div class="form-group">
            <label>Phone Number</label>
            <input type="tel" id="phone" placeholder="08012345678">
          </div>
        </div>
        <h3>Bank Account Details</h3>
        <div class="form-row">
          <div class="form-group">
            <label>Bank Name</label>
            <select id="bank_name">
              <option value="">Select Bank</option>
              <option value="Access Bank">Access Bank</option>
              <option value="GTBank">GTBank</option>
              <option value="First Bank">First Bank</option>
              <option value="UBA">UBA</option>
              <option value="Zenith Bank">Zenith Bank</option>
            </select>
          </div>
          <div class="form-group">
            <label>Account Number</label>
            <input type="text" id="account_number" placeholder="1234567890" maxlength="10">
          </div>
        </div>
        <div class="form-group">
          <label>Account Name</label>
          <input type="text" id="account_holder" placeholder="Auto-filled after verification" readonly>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Username</label>
            <input type="text" id="username" placeholder="Choose username" required>
          </div>
          <div class="form-group">
            <label>Password</label>
            <input type="password" id="password" placeholder="Minimum 8 characters" required minlength="8">
          </div>
        </div>
        <button type="submit">
          <i class="fas fa-user-plus"></i> Create My Account
        </button>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('.close').onclick = () => {
    modal.style.display = 'none';
    document.body.classList.remove('modal-open');
  };
  // Load CSS if not present
  if (!document.getElementById('self-signup-styles')) {
    const link = document.createElement('link');
    link.id = 'self-signup-styles';
    link.rel = 'stylesheet';
    link.href = '{% static "frontend/self_signup.css" %}';
    document.head.appendChild(link);
  }
  document.getElementById('signup-form').onsubmit = handleSignup;
  return modal;
}

async function handleSignup(e) {
  e.preventDefault();
  const formData = {
    full_name: document.getElementById('full_name').value,
    email: document.getElementById('email').value,
    location: document.getElementById('location').value,
    role: document.getElementById('role').value,
    salary: document.getElementById('salary').value,
    phone: document.getElementById('phone').value,
    bank_name: document.getElementById('bank_name').value,
    account_number: document.getElementById('account_number').value,
    account_holder: document.getElementById('account_holder').value,
    username: document.getElementById('username').value,
    password: document.getElementById('password').value
  };

  try {
    const response = await fetch('/api/self-register/', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(formData)
    });
    const result = await response.json();
    
    if (response.ok) {
      alert(`Success! Employee ID: ${result.employee_id}\nLogin now!`);
      document.getElementById('signup-modal').style.display = 'none';
    } else {
      alert('Error: ' + result.error);
    }
  } catch (error) {
    alert('Network error: ' + error);
  }
}

