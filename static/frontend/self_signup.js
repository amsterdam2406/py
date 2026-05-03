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
        <input type="text" id="full_name" placeholder="Full Name" required>
        <input type="email" id="email" placeholder="Email" required>
        <input type="text" id="location" placeholder="Location" required>
        <select id="role" required>
          <option value="">Select Role</option>
          <option value="staff">Staff</option>
          <option value="guard">Guard</option>
        </select>
        <input type="number" id="salary" placeholder="Salary">
        <input type="text" id="phone" placeholder="Phone">
        <input type="text" id="bank_name" placeholder="Bank Name">
        <input type="text" id="account_number" placeholder="Account Number">
        <input type="text" id="account_holder" placeholder="Account Holder">
        <input type="text" id="username" placeholder="Username" required>
        <input type="password" id="password" placeholder="Password" required>
        <button type="submit">Create Account</button>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('.close').onclick = () => modal.style.display = 'none';
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

