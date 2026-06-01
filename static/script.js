/**
 * Fotasco Payroll - Production Ready JavaScript
 * DRF API Integration with JWT Authentication
 * Version: 5.0.0 - All Critical Fixes Applied
 */

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
  API_BASE_URL: window.location.origin, // FIXED: Dynamic base URL
  TOKEN_REFRESH_INTERVAL: 14 * 60 * 1000, // FIXED: Refreshes at 14 mins (Before 15 min expiry)
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_DURATION: 15 * 60 * 1000,
  DEBOUNCE_DELAY: 300,
  CAMERA_QUALITY: 0.8,
  TOAST_DURATION: 5000,
  PAGE_SIZE: 20,
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
  downloadLogs: [],
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
  rateLimitedKeys: new Map(),
  lastVerifiedAccountKey: null,
  globalLoadingCount: 0, // ADDED: Counter for global loading operations
  pendingAccountVerificationKey: null,
  paymentPollInterval: null,
  bulkPollInterval: null,
  isPolling: false,

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
    globalSpinner: null,
  },
};

const _autoVerifiedKeys = new Map();

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

/**
 * Standard cookie reader for CSRF tokens and session management
 */
function getCookie(name) {
  if (!name) return null;
  const cookieString = document.cookie || "";
  if (!cookieString) return null;

  const cookies = cookieString.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    if (!cookie) continue;
    const [key, ...rest] = cookie.split("=");
    if (key === name) return decodeURIComponent(rest.join("=") || "");
  }
  return null;
}

function escapeHtml(text) {
  if (typeof text !== "string") return text;
  const div = document.createElement("div");
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

/**
 * Updates the text message in the global loading spinner.
 */
function updateLoadingProgress(message) {
  const spinner =
    AppState.elements.globalSpinner || document.getElementById("globalSpinner");
  if (!spinner) return;

  let textEl = spinner.querySelector(".spinner-text");
  if (!textEl) {
    textEl =
      Array.from(spinner.querySelectorAll("div, span, p")).find((el) =>
        el.textContent.toLowerCase().includes("loading"),
      ) || spinner;
  }

  if (textEl)
    textEl.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(message)}`;
}

function formatCurrency(amount, currency = "₦") {
  const num = Number(amount) || 0;
  return `${currency}${num.toLocaleString("en-NG")}`;
}

function formatEmployeeType(type) {
  const labels = {
    staff: "Staff",
    guard: "Guard",
    employee: "Employee",
  };
  return labels[type] || "Employee";
}

function formatDate(dateString) {
  if (!dateString) return "-";
  try {
    return new Date(dateString).toLocaleDateString("en-NG");
  } catch {
    return dateString;
  }
}

function buildUrl(url, params = {}) {
  const query = new URLSearchParams(params).toString();
  return query ? `${url}?${query}` : url;
}

/**
 * Client-side image compression using Canvas
 */
async function compressImage(
  file,
  maxWidth = 1280,
  maxHeight = 720,
  quality = 0.7,
) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxWidth) {
            height *= maxWidth / width;
            width = maxWidth;
          }
        } else {
          if (height > maxHeight) {
            width *= maxHeight / height;
            height = maxHeight;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
      };
    };
  });
}

function idsMatch(left, right) {
  return String(left) === String(right);
}

function isJwtExpired(token) {
  if (!token) return true;
  try {
    const [, payload] = token.split(".");
    if (!payload) return true;
    const normalizedPayload = payload.replace(/-/g, "+").replace(/_/g, "/");
    const paddedPayload = normalizedPayload.padEnd(
      Math.ceil(normalizedPayload.length / 4) * 4,
      "=",
    );
    const data = JSON.parse(atob(paddedPayload));
    return !data.exp || Date.now() >= data.exp * 1000 - 30000;
  } catch (err) {
    console.warn("Could not parse JWT expiry:", err);
    return true;
  }
}

// ==========================================
// UI HELPERS
// ==========================================

function showLoading(btn, spinnerEl) {
  try {
    if (btn) {
      btn.disabled = true;
      if (!btn.dataset.originalText) btn.dataset.originalText = btn.innerHTML;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';
    }
    const spinner =
      spinnerEl ||
      AppState.elements.globalSpinner ||
      document.getElementById("globalSpinner");
    if (spinner) spinner.classList.remove("hidden");
  } catch (error) {
    console.error("Error in showLoading:", error);
  }
}

function hideLoading(btn, spinnerEl) {
  try {
    if (btn) {
      btn.disabled = false;
      if (btn.dataset.originalText) {
        btn.innerHTML = btn.dataset.originalText;
        delete btn.dataset.originalText;
      }
    }
    const spinner =
      spinnerEl ||
      AppState.elements.globalSpinner ||
      document.getElementById("globalSpinner");
    if (spinner) {
      if (!btn)
        AppState.globalLoadingCount = Math.max(
          0,
          AppState.globalLoadingCount - 1,
        ); // Decrement global counter
      if (AppState.globalLoadingCount === 0 && !AppState.isPolling)
        spinner.classList.add("hidden");
    }
  } catch (error) {
    console.error("Error in hideLoading:", error);
  }
}

let lastToastInfo = { message: "", time: 0 };

function showToast(message, type = "info", duration = CONFIG.TOAST_DURATION) {
  const now = Date.now();
  // Prevent showing the exact same message twice within 1 second
  if (message === lastToastInfo.message && now - lastToastInfo.time < 1000)
    return;
  lastToastInfo = { message, time: now };

  const container =
    AppState.elements.toastContainer ||
    document.getElementById("toastContainer");
  if (!container) {
    console.warn("Toast container not found:", message);
    return;
  } // Fixed: Ensure toast container exists
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  // Fixed styling to ensure content visibility
  toast.style.cssText =
    "display: flex; flex-direction: row; align-items: center; justify-content: space-between; padding: 12px; margin-bottom: 10px; border-radius: 4px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); background: #fff; z-index: 10000; position: relative; border-left: 5px solid;";

  const colors = {
    success: "#28a745",
    error: "#dc3545",
    warning: "#ffc107",
    info: "#17a2b8",
  };
  toast.style.borderLeftColor = colors[type] || colors.info;

  toast.innerHTML = `
        <div class="toast-content">
            <div class="toast-message">${escapeHtml(message)}</div>
        </div>
        <button class="toast-close" aria-label="Close">×</button>
    `;
  toast
    .querySelector(".toast-close")
    .addEventListener("click", () => closeToast(toast));
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  if (duration > 0) setTimeout(() => closeToast(toast), duration);
}

function closeToast(toast) {
  if (!toast) return;
  toast.classList.remove("show");
  setTimeout(() => toast?.remove(), 300);
}

/**
 * Toggle the user Account dropdown menu
 */
function toggleUserMenu(event) {
  if (event) event.stopPropagation();
  const dropdown = document.querySelector(
    ".user-menu-dropdown .dropdown-content",
  );
  if (dropdown) {
    dropdown.classList.toggle("show");
  }
}

// Global click listener to close the Account dropdown when clicking outside
document.addEventListener("click", (e) => {
  const dropdown = document.querySelector(
    ".user-menu-dropdown .dropdown-content",
  );
  const button = document.querySelector(".dropbtn-custom");

  if (dropdown && dropdown.classList.contains("show")) {
    if (!dropdown.contains(e.target) && !button.contains(e.target)) {
      dropdown.classList.remove("show");
    }
  }
});

function showSection(id) {
  document
    .querySelectorAll(".content-section")
    .forEach((sec) => sec.classList.remove("active"));
  const section = document.getElementById(id);
  if (section) section.classList.add("active");
  const sidebar = document.getElementById("sidebar");
  if (sidebar && window.innerWidth <= 768) sidebar.classList.remove("active");
  document.querySelectorAll(".sidebar-menu a").forEach((link) => {
    const isActive = link.getAttribute("onclick")?.includes(`'${id}'`);
    link.classList.toggle("active", isActive);
  });

  // Load data for specific sections
  if (id === "payments") {
    populatePaymentsTable();
  }
  if (id === "requests") {
    loadRequests();
  }
  if (id === "audit-logs") {
    loadDownloadLogs();
  }
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) {
    console.warn(`Modal not found: ${id}`);
    return;
  }
  modal.style.display = "flex";
  modal.classList.add("active");
  if (id === "clockInModal") {
    startCamera();
    document
      .getElementById("markWithoutSelfie")
      ?.addEventListener("change", toggleCamera);
    toggleCamera();
  }
  if (id === "addCompanyModal" || id === "signup-modal") {
    AppState.currentEditingCompanyId = null;
    populateCompanyGuards(); // Fixed: Ensure guards are populated
    populateBankSelects(); // Ensure banks are loaded for signup
  }
  if (id === "bulkPaymentModal") {
    populateBulkTable();
    updateBulkTotal(); // ADDED: Calculate initial total
  }
  if (id === "individualPaymentModal") {
    populateEmployeeSelect("paymentEmployee");
    document.getElementById("paymentPreview").style.display = "none"; // Fixed: Hide preview initially
    fetchPaystackBalance(); // Check balance when opening payment modal
    updatePaymentPreview().catch(console.error);
  }
  if (id === "bulkPaymentModal") {
    populateBulkTable();
    fetchPaystackBalance(); // Check balance
  }
  // ADDED: Initialize leave modal dates
  if (id === "leaveModal") {
    const today = new Date().toISOString().split("T")[0];
    document.getElementById("leaveStartDate").value = today;
    document.getElementById("leaveEndDate").value = today;
    populateEmployeeSelect("leaveEmployee");
  }
}

function closeModal(id) {
  if (
    (id === "clockInModal" || id === "requestModal") &&
    AppState.cameraStream
  ) {
    AppState.cameraStream.getTracks().forEach((track) => track.stop());
    AppState.cameraStream = null;
  }

  if (id === "individualPaymentModal" || id === "bulkPaymentModal") {
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
  if (modal) {
    modal.classList.remove("active");
    modal.style.display = "none";
  }
}

// ==========================================
// IMAGE PREVIEWER
// ==========================================

function showImagePreview(src) {
  let overlay = document.getElementById("imagePreviewOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "imagePreviewOverlay";
    overlay.className = "image-preview-overlay";
    overlay.innerHTML = `
            <div class="preview-content">
                <span class="close-preview">&times;</span>
                <img id="previewImageFull" src="" alt="Preview">
            </div>
        `;
    document.body.appendChild(overlay);
    overlay.querySelector(".close-preview").onclick = () =>
      overlay.classList.remove("active");
    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.classList.remove("active");
    };
  }

  const img = document.getElementById("previewImageFull");
  if (img) {
    img.src = src;
    overlay.classList.add("active");
  }
}

// ==========================================
// API COMMUNICATION
// ==========================================

async function apiRequest(url, options = {}) {
  // FIXED: Ensure proper URL construction
  const baseUrl = window.location.origin;
  const fullUrl = url.startsWith("http")
    ? url
    : `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;

  let token = AppState.accessToken || localStorage.getItem("accessToken");

  // NEW: Proactively refresh token if expired to avoid unnecessary 401 logs and extra roundtrips
  if (token && isJwtExpired(token) && !url.includes("/token/refresh/") && !url.includes("/login/")) {
    const refreshed = await refreshAccessToken();
    if (refreshed) token = AppState.accessToken;
  }

  const csrfToken = getCookie("csrftoken");

  const headers = {
    ...(options.body instanceof FormData
      ? {}
      : { "Content-Type": "application/json" }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(csrfToken ? { "X-CSRFToken": csrfToken } : {}),
    ...options.headers,
  };

  const fetchOptions = {
    method: options.method || "GET",
    headers,
    body:
      options.body instanceof FormData
        ? options.body
        : options.body
          ? JSON.stringify(options.body)
          : null,
  };

  try {
    const response = await fetch(fullUrl, fetchOptions);

    if (response.status === 401) {
      // Prevent infinite loops on auth endpoints
      if (
        url.includes("/login/") ||
        url.includes("/logout/") ||
        url.includes("/token/refresh/")
      ) {
        return {
          success: false,
          status: response.status,
          message: "Auth failed",
        };
      }
      const refreshed = await refreshAccessToken();
      if (refreshed) return apiRequest(url, options);
      logout();
      showToast("Session expired. Please login again.", "error");
      return {
        success: false,
        status: response.status,
        message: "Session expired. Please login again.",
      };
    }

    if (response.status === 429) {
      const errorData = await response.json().catch(() => ({}));
      const waitTime = errorData.detail?.match(/\d+/)?.[0] || "unknown";
      return {
        success: false,
        status: response.status,
        message: "Verification service is temporarily unavailable. Please try again in 5 minutes.",
        data: errorData,
      };
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        success: false,
        status: response.status,
        data,
        message:
          data.detail ||
          data.error ||
          data.message ||
          `Request failed (${response.status})`,
      };
    }

    return { success: true, status: response.status, data };
  } catch (err) {
    console.error("API Error:", err);
    return {
      success: false,
      message: err.message || "Network error. Check connection.",
    };
  }
}

/**
 * Refreshes the JWT access token using the stored refresh token.
 * Improved to handle session expiry and state cleanup.
 */
async function refreshAccessToken() {
  try {
    // IMPORTANT: refresh_token cookie is HttpOnly, so JS cannot read it.
    // Rely only on localStorage (and in-memory AppState) for SPA bootstrapping.
    const refreshToken =
      AppState.refreshToken || localStorage.getItem("refreshToken");

    if (!refreshToken) return false;

    // Prefer HttpOnly cookie refresh (DRF reads refresh_token cookie server-side).
    // Send refresh token in body only if we explicitly have it.
    const refreshBody = refreshToken ? { refresh: refreshToken } : null;

    const fetchOptions = {
      method: "POST",
      headers: {},
    };

    if (refreshBody) {
      fetchOptions.headers["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(refreshBody);
    }

    const response = await fetch("/token/refresh/", fetchOptions);

    if (response.status === 401 || response.status === 403) {
      throw new Error("AUTH_EXPIRED");
    }

    if (!response.ok) throw new Error("Refresh request failed");

    const data = await response.json();
    AppState.accessToken = data.access;
    localStorage.setItem("accessToken", data.access);

    if (data.refresh) {
      AppState.refreshToken = data.refresh;
      localStorage.setItem("refreshToken", data.refresh);
    }

    return true;
  } catch (err) {
    if (err.message === "AUTH_EXPIRED") {
      console.warn("Session expired. Cleaning up...");
      logout();
    } else {
      console.error("Token refresh network error:", err);
    }
    return false;
  }
}

// ==========================================
// NIGERIAN BANKS AUTO-LOADING
// ==========================================

// ==========================================
// FIXED: NIGERIAN BANKS AUTO-LOADING
// ==========================================

async function loadNigerianBanks() {
  try {
    const res = await apiRequest("/paystack/banks/");
    if (res.success && res.data?.data) {
      AppState.bankList = res.data.data;
      populateBankSelects();
    }
  } catch (err) {
    console.warn("Failed to load Nigerian banks, using fallback:", err);
    // Use fallback list with proper codes
    AppState.bankList = [
      { name: "Access Bank", code: "044" },
      { name: "GTBank", code: "058" },
      { name: "First Bank of Nigeria", code: "011" },
      { name: "United Bank for Africa", code: "033" },
      { name: "Zenith Bank", code: "057" },
      { name: "Fidelity Bank", code: "070" },
      { name: "Union Bank of Nigeria", code: "032" },
      { name: "Sterling Bank", code: "232" },
      { name: "Stanbic IBTC Bank", code: "221" },
      { name: "Polaris Bank", code: "076" },
      { name: "Wema Bank", code: "035" },
      { name: "Ecobank Nigeria", code: "050" },
      { name: "First City Monument Bank", code: "214" },
      { name: "Keystone Bank", code: "082" },
    ];
    populateBankSelects();
  }
}

function populateBankSelects() {
  const bankSelects = [
    document.getElementById("accountBankName"),
    document.getElementById("newEmployeeBankName"),
    document.getElementById("signupBankName"),
  ];

  bankSelects.forEach((select) => {
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = '<option value="">Select Bank</option>';

    AppState.bankList.forEach((bank) => {
      const option = document.createElement("option");
      option.value = bank.name;
      option.textContent = bank.name;
      option.dataset.code = bank.code; // Store Paystack code directly
      select.appendChild(option);
    });

    if (
      currentValue &&
      AppState.bankList.find((b) => b.name === currentValue)
    ) {
      select.value = currentValue;
    }
  });
}

function setAccountVerificationStatus(
  statusEl,
  message,
  className = "text-muted",
) {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = className;
}

async function verifyBankAccountFields({
  accountInput,
  bankSelect,
  holderInput,
  statusEl,
  manual = false,
  attempt = 2,
}) {
  const accountNumber = accountInput?.value?.trim();
  const selectedOption = bankSelect?.options[bankSelect.selectedIndex];
  const bankCode = selectedOption?.dataset?.code;

  if (!accountNumber || !bankCode) return false;

  const verificationKey = `${bankCode || "none"}:${accountNumber}`;

  const safeHolderInput =
    holderInput && holderInput !== statusEl ? holderInput : null;

  // Check for local rate limit cooldown
  const cooldownUntil = AppState.rateLimitedKeys.get(verificationKey);
  if (cooldownUntil && Date.now() < cooldownUntil) {
    if (!manual) return false; // Don't annoy with toasts on auto-verify
    const remainingSecs = Math.ceil((cooldownUntil - Date.now()) / 1000);
    setAccountVerificationStatus(statusEl, `Rate limited. Please wait ${remainingSecs}s.`, "text-warning");
    return false;
  }

  if (AppState.lastVerifiedAccountKey === verificationKey && safeHolderInput?.value) return true;

  if (!accountNumber || !/^\d{10}$/.test(accountNumber)) {
    if (manual) showToast("Enter valid 10-digit account number", "error");
    return false;
  }
  if (!bankCode) {
    if (manual) showToast("Select a valid bank first", "error");
    return false;
  }
  if (AppState.pendingAccountVerificationKey === verificationKey) {
    return false;
  }
  if (
    AppState.lastVerifiedAccountKey === verificationKey &&
    safeHolderInput?.value.trim()
  ) {
    // If we already verified this key earlier and the UI still has a holder name,
    // reuse it to avoid re-calling Paystack (prevents 429 bursts).
    setAccountVerificationStatus(
      statusEl,
      `Verified: ${safeHolderInput.value.trim()}`,
      "text-success",
    );
    return true;
  }


  AppState.pendingAccountVerificationKey = verificationKey;
  AppState.pendingAccountVerificationRunId =
    (AppState.pendingAccountVerificationRunId || 0) + 1;
  const runId = AppState.pendingAccountVerificationRunId;

  if (safeHolderInput) {
    safeHolderInput.value = "Verifying...";
    safeHolderInput.disabled = true;
    safeHolderInput.readOnly = true;
    safeHolderInput.style.background = "#f8f9fa";
  }
  setAccountVerificationStatus(
    statusEl,
    "Verifying with Paystack...",
    "text-info",
  );

  try {
    // Use GET endpoint with query parameters for account resolution
    const res = await apiRequest(buildUrl("/paystack/resolve-account/", {
      account_number: accountNumber,
      bank_code: bankCode
    }));

    if (
      AppState.pendingAccountVerificationRunId !== runId ||
      AppState.pendingAccountVerificationKey !== verificationKey
    ) {
      return false;
    }

    if (res.status === 429 || res.data?.error_code === 'rate_limited') {
      let retryAfter = parseInt(res.data?.retry_after, 10);
      
      // If DRF throttle hit, parse seconds from the "detail" string
      if (isNaN(retryAfter) && res.data?.detail) {
        const match = res.data.detail.match(/\d+/);
        if (match) retryAfter = parseInt(match[0], 10);
      }

    // Reduce local cooldown to 30s to allow faster recovery
    const cooldownMs = (retryAfter || 30) * 1000;
      AppState.rateLimitedKeys.set(verificationKey, Date.now() + cooldownMs);

      let displayMsg =
        res.message ||
        res.data?.message ||
        res.data?.detail ||
        "Verification service is temporarily unavailable. Please try again in 5 minutes.";

      if (!isNaN(retryAfter) && retryAfter > 0 && !displayMsg.includes("5 minutes")) {
        const minutes = Math.max(1, Math.round(retryAfter / 60));
        displayMsg =
          minutes <= 1
            ? "Verification service is temporarily unavailable. Please try again in 1 minute."
            : `Verification service is temporarily unavailable. Please try again in ${minutes} minutes.`;
      }

      if (safeHolderInput) {
        safeHolderInput.value = "";
        safeHolderInput.style.background = "#f8f9fa";
      }

      AppState.lastVerifiedAccountKey = null;

      setAccountVerificationStatus(statusEl, displayMsg, "text-warning");
      if (manual) showToast(displayMsg, "warning");
      return false;
    }

    const accountName =
      res.data?.data?.account_name ||   
      res.data?.account_name ||          
      res.data?.data?.account_holder ||  
      res.data?.account_holder ||
      null;
    const isVerifiedOk =
      res.success && accountName && accountName.trim().length > 0;
    // ──────────────────────────────────────────────────────────────────────

    if (isVerifiedOk) {
      if (safeHolderInput) {
        // Capture the name first, then apply all DOM changes together
        const nameToSet = accountName.trim();
        safeHolderInput.disabled = false;
        safeHolderInput.readOnly = true;
        safeHolderInput.style.background = "#d4edda";
        safeHolderInput.value = nameToSet;          // set value AFTER disabled=false
      }
      AppState.lastVerifiedAccountKey = verificationKey;
      setAccountVerificationStatus(
        statusEl,
        `Verified: ${accountName.trim()}`,
        "text-success",
      );
      if (manual) showToast("Account verified successfully", "success");
      return true;
    }

    if (safeHolderInput) {
      safeHolderInput.value = "";
      safeHolderInput.style.background = "#f8d7da";
    }
    AppState.lastVerifiedAccountKey = null;

    const errorMsg =
      res.message || res.data?.message || "Account could not be verified.";

    setAccountVerificationStatus(statusEl, errorMsg, "text-danger");
    if (manual) showToast(errorMsg, "error");
    return false;
  } catch (err) {
    if (safeHolderInput) {
      safeHolderInput.value = "";
      safeHolderInput.style.background = "#f8d7da";
    }
    AppState.lastVerifiedAccountKey = null;
    setAccountVerificationStatus(
      statusEl,
      "Verification service unavailable. Try again later.",
      "text-warning",
    );
    if (manual) showToast("Verification service unavailable", "error");
    return false;
  } finally {
    if (
      AppState.pendingAccountVerificationRunId === runId &&
      AppState.pendingAccountVerificationKey === verificationKey
    ) {
      AppState.pendingAccountVerificationKey = null;
    }

    if (safeHolderInput) {
      safeHolderInput.disabled = false;
      if (safeHolderInput.value === "Verifying..." || !AppState.lastVerifiedAccountKey) {
         safeHolderInput.value = "";
      }
    }
  }
}


function setupAccountVerification({
  accountInputId,
  bankSelectId,
  holderInputId,
  statusId,
}) {
  const accountInput = document.getElementById(accountInputId);
  const bankSelect = document.getElementById(bankSelectId);
  const holderInput = document.getElementById(holderInputId);
  const statusEl = document.getElementById(statusId);

  if (!accountInput || !bankSelect || !holderInput) return null;

  holderInput.readOnly = true;
  holderInput.style.background = "#f8f9fa";

  const verifyCurrentAccount = debounce(
    () =>
      verifyBankAccountFields({
        accountInput,
        bankSelect,
        holderInput,
        statusEl,
      }),
    1200,
  );

  const mapKey = accountInputId;

  accountInput.addEventListener("input", () => {
    const v = accountInput.value.trim();
    const selectedOption = bankSelect?.options[bankSelect.selectedIndex];
    const bankCode = selectedOption?.dataset?.code;
    const key = `${bankCode || "none"}:${v}`;

    // Only clear if the user actually changed the digits/bank to something unverified
    if (key !== AppState.lastVerifiedAccountKey && !AppState.pendingAccountVerificationKey) {
      holderInput.value = "";
      holderInput.style.background = "#f8f9fa";
    }

    if (v.length === 10 && /^\d{10}$/.test(v)) {
      const currentKey = `${bankCode || "none"}:${v}`;
      if (
        currentKey &&
        currentKey !== _autoVerifiedKeys.get(mapKey) &&
        currentKey !== AppState.pendingAccountVerificationKey
      ) {
        _autoVerifiedKeys.set(mapKey, currentKey);
        verifyCurrentAccount();
      }
    } else {
      setAccountVerificationStatus(
        statusEl,
        "Enter 10-digit account number to auto-verify",
        "text-muted",
      );
    }
  });

  bankSelect.addEventListener("change", () => {
    if (!AppState.lastVerifiedAccountKey) {
        holderInput.value = "";
        holderInput.style.background = "#f8f9fa";
    }
    setAccountVerificationStatus(
      statusEl,
      "Enter 10-digit account number to auto-verify",
      "text-muted",
    );

    const v = accountInput.value.trim();
    if (v.length === 10 && /^\d{10}$/.test(v)) {
      const selectedOption = bankSelect?.options[bankSelect.selectedIndex];
      const bankCode = selectedOption?.dataset?.code;
      const key = `${bankCode || "none"}:${v}`;
      if (
        key &&
        key !== _autoVerifiedKeys.get(mapKey) &&
        key !== AppState.pendingAccountVerificationKey
      ) {
        _autoVerifiedKeys.set(mapKey, key);
        verifyCurrentAccount();
      }
    }
  });

  return { accountInput, bankSelect, holderInput, statusEl };
}

async function verifyBankAccountManual() {
  const accountInput = document.getElementById("accountNumber");
  const bankSelect = document.getElementById("accountBankName");
  const holderInput = document.getElementById("accountHolderName");
  const statusEl = document.getElementById("verificationStatus");
  const btn = document.getElementById("verifyAccountBtn");
  showLoading(btn); // Button spinner
  try {
    return await verifyBankAccountFields({
      accountInput,
      bankSelect,
      holderInput,
      statusEl,
      manual: true,
    });
  } finally {
    hideLoading(btn);
  }
}

async function verifyNewEmployeeBankManual() {
  const accountInput = document.getElementById("newEmployeeAccountNumber");
  const bankSelect = document.getElementById("newEmployeeBankName");
  const holderInput = document.getElementById("newEmployeeAccountHolder");
  const statusEl = document.getElementById("newEmployeeVerificationStatus");
  const btn = document.getElementById("verifyNewEmployeeBtn"); // Assuming this ID for the new button
  showLoading(btn);
  try {
    return await verifyBankAccountFields({
      accountInput,
      bankSelect,
      holderInput,
      statusEl,
      manual: true,
    });
  } finally {
    hideLoading(btn);
  }
}

async function clearBankCache() {
  if (
    !confirm(
      "Clear all cached bank verification details? This will force new lookups for all employees.",
    )
  )
    return;

  try {
    showLoading();
    const res = await apiRequest("/paystack/clear-cache/", { method: "POST" });
    if (res.success) {
      showToast(res.data.message || "Cache cleared", "success");
    } else {
      showToast(res.message || "Failed to clear cache", "error");
    }
  } finally {
    hideLoading(); // Global spinner
  }
}

// ==========================================
// FIXED: AUTO BANK VERIFICATION & NAME FILL
// ==========================================

function setupBankVerification() {
  setupAccountVerification({
    accountInputId: "accountNumber",
    bankSelectId: "accountBankName",
    holderInputId: "accountHolderName",
    statusId: "verificationStatus",
  });
  setupAccountVerification({
    accountInputId: "newEmployeeAccountNumber",
    bankSelectId: "newEmployeeBankName",
    holderInputId: "newEmployeeAccountHolder",
    statusId: "newEmployeeVerificationStatus",
  });
  setupAccountVerification({
    accountInputId: "signupAccountNumber",
    bankSelectId: "signupBankName",
    holderInputId: "signupAccountHolder",
    statusId: "signupVerificationStatus",
  });
}

// ==========================================
// AUTHENTICATION
// ==========================================

async function handleLogin(e) {
  e.preventDefault();

  const btn = document.getElementById("loginBtn");
  if (AppState.loginLockedUntil && Date.now() < AppState.loginLockedUntil) {
    const remaining = Math.ceil(
      (AppState.loginLockedUntil - Date.now()) / 1000 / 60,
    );
    showToast(`Account locked. Try again in ${remaining} minutes.`, "error");
    return;
  }

  const username = document.getElementById("loginUsername")?.value.trim();
  const password = document.getElementById("loginPassword")?.value;

  if (!username || !password) {
    showToast("Username and password are required", "error");
    return;
  }

  try {
    showLoading(btn);
    const response = await fetch("/login/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    let data = {};
    try {
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        data = await response.json();
      }
    } catch (parseErr) {
      console.warn("Could not parse error response as JSON");
    }

    if (!response.ok) {
      AppState.loginAttempts++;

      if (response.status === 500) {
        showToast(
          "Server error (500). Please check Render backend logs.",
          "error",
        );
        return;
      }

      if (AppState.loginAttempts >= CONFIG.MAX_LOGIN_ATTEMPTS) {
        AppState.loginLockedUntil = Date.now() + CONFIG.LOCKOUT_DURATION;
        showToast(
          "Too many failed attempts. Account locked for 15 minutes.",
          "error",
        );
      } else if (response.status === 500) {
        showToast("Server error. Please check backend logs.", "error");
      } else {
        showToast(data.error || "Invalid credentials", "error");
      }
      return;
    }

    AppState.loginAttempts = 0;
    AppState.loginLockedUntil = null;

    // FIXED: Store both tokens
    AppState.accessToken = data.access;
    AppState.refreshToken = data.refresh;
    AppState.currentUser = data.user;

    localStorage.setItem("accessToken", data.access);
    localStorage.setItem("refreshToken", data.refresh); // ADDED
    sessionStorage.setItem("accessToken", data.access);
    sessionStorage.setItem("isLoggedIn", "true");

    document.getElementById("loginPage")?.classList.add("hidden");
    document.getElementById("dashboardPage")?.classList.remove("hidden");

    await loadDashboard();

    showToast("Login successful", "success");
  } catch (err) {
    console.error("Login error:", err);
    showToast("Login failed. Please try again.", "error");
  } finally {
    hideLoading(btn);
  }
}

async function handleSelfSignup(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');

  const payload = {
    username: document.getElementById("signupUsername")?.value.trim(),
    password: document.getElementById("signupPassword")?.value,
    full_name: document.getElementById("signupFullName")?.value.trim(),
    role: document.getElementById("signupRole")?.value,
    location: document.getElementById("signupLocation")?.value.trim(),
    salary: 0,
    email: document.getElementById("signupEmail")?.value.trim(),
    phone: "",
    bank_name: "",
    bank_code: "",
    account_number: "",
    account_holder: "",
  };

  const missing = [];
  if (!payload.username) missing.push("Username");
  if (!payload.password || payload.password.length < 8) missing.push("Password (min 8 chars)");
  if (!payload.full_name || payload.full_name.split(/\s+/).length < 2) missing.push("Full Name (min 2 names)");
  if (!payload.role) missing.push("Role");
  if (!payload.location) missing.push("Location");

  if (missing.length) {
    showToast("Missing or invalid fields: " + missing.join(", "), "warning");
    return;
  }

  try {
    showLoading(btn);
    const res = await apiRequest("/self-register/", {
      method: "POST",
      body: payload,
    });

    if (!res.success) {
      throw new Error(res.message || "Self-registration failed");
    }

    showToast(res.data?.message || "Registration successful! Awaiting admin approval.", "success");
    closeSelfSignupModal();
    document.getElementById("selfSignupForm")?.reset();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    hideLoading(btn);
  }
}

async function logout(silent = false) {
  try {
    if (!silent) showLoading(null, AppState.elements.globalSpinner);
    const refresh =
      AppState.refreshToken || localStorage.getItem("refreshToken");
    // If tokens are already gone, don't even try the network request to avoid noise
    if (refresh) {
      await fetch(`${window.location.origin}/logout/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh }),
      }).catch(() => {}); // Ignore errors on logout
    }
  } catch (err) {
    console.error("Logout error:", err);
  } finally {
    AppState.accessToken = null;
    AppState.refreshToken = null;
    AppState.currentUser = null;
    localStorage.clear();
    sessionStorage.clear();
    if (!silent) hideLoading(null, AppState.elements.globalSpinner);
    showLoginPage();
  }

  if (AppState.cameraStream) {
    AppState.cameraStream.getTracks().forEach((track) => track.stop());
    AppState.cameraStream = null;
  }
}
async function handleForgotPassword(e) {
  if (e) e.preventDefault();
  const email = prompt("Please enter your registered email address:");
  if (!email) return;

  try {
    showLoading(); // Global spinner
    const res = await apiRequest("/request-reset/", {
      method: "POST",
      body: { email },
    });
    if (res.success) {
      showToast(res.data.message, "success");
    } else {
      showToast(res.message, "error");
    }
  } finally {
    hideLoading(); // Global spinner
  }
}

/**
 * Handle the submission of the Forgot Password form
 */
async function submitForgotPassword(e) {
  e.preventDefault();
  const email = document.getElementById("forgotEmail")?.value.trim();
  if (!email) {
    showToast("Email is required", "error");
    return;
  }

  const btn = e.target.querySelector('button[type="submit"]');
  try {
    showLoading(btn);
    const res = await apiRequest("/request-reset/", {
      method: "POST",
      body: { email },
    });
    if (res.success) {
      showToast(
        res.data.message || "If an account exists, a reset link has been sent.",
        "success",
      );
      closeModal("forgotPasswordModal");
    } else {
      showToast(res.message || "Failed to initiate password reset", "error");
    }
  } finally {
    hideLoading(btn);
  }
}

/**
 * Handle the submission of the Reset Password form (using uid and token from URL)
 */
async function handleResetPassword(e) {
  e.preventDefault();
  const password = document.getElementById("resetNewPassword")?.value;
  const confirmPassword = document.getElementById(
    "resetConfirmPassword",
  )?.value;

  const urlParams = new URLSearchParams(window.location.search);
  const uid = urlParams.get("uid");
  const token = urlParams.get("token");

  if (!password || !confirmPassword) {
    showToast("Please fill in all fields", "error");
    return;
  }
  if (password !== confirmPassword) {
    showToast("Passwords do not match", "error");
    return;
  }

  const btn = e.target.querySelector('button[type="submit"]');
  try {
    showLoading(btn);
    // The endpoint defined in urls.py is /reset-password/confirm/<uidb64>/<token>/
    const res = await apiRequest(`/reset-password/confirm/${uid}/${token}/`, {
      method: "POST",
      body: { password }, // auth_views.py reset_password_confirm expects 'password'
    });

    if (res.success) {
      showToast("Password reset successful! You can now login.", "success");
      closeModal("resetPasswordModal");
      window.history.replaceState({}, document.title, "/"); // Clear the URL parameters
      showLoginPage();
    } else {
      showToast(
        res.message || "Password reset failed. The link may be expired.",
        "error",
      );
    }
  } finally {
    hideLoading(btn);
  }
}

async function loadCurrentUser() {
  try {
    const res = await apiRequest("/current-user/");
    if (!res.success) throw new Error(res.message);

    AppState.currentUser = res.data;

    // FIXED: Use correct element ID that exists in HTML
    const el = document.getElementById("currentUserName");
    if (el) {
      const displayName = AppState.currentUser.name || AppState.currentUser.username || "User";
      el.textContent = escapeHtml(displayName);
    }

    // Also update any other places that might show the user name
    const welcomeEl = document.getElementById("welcomeUserName");
    if (welcomeEl) {
      const displayName = AppState.currentUser.name || AppState.currentUser.username || "User";
      welcomeEl.textContent = `Welcome, ${escapeHtml(displayName)}`;
    }

    applyRolePermissions(AppState.currentUser);
    return true;
  } catch (err) {
    console.error("Failed to load user:", err);
    return false;
  }
}


// ==========================================
// AUTHORIZATION
// ==========================================

function applyRolePermissions(user) {
  if (!user) return;

  // Mapping backend flags to UI visibility
  const permissions = [
    {
      id: "admin-controls-employee",
      allowed:
        user.is_superuser || user.role === "admin" || user.is_employee_admin,
    },
    {
      id: "admin-controls-sacked",
      allowed:
        user.is_superuser || user.role === "admin" || user.is_employee_admin,
    },
    {
      id: "admin-controls-companies",
      allowed:
        user.is_superuser || user.role === "admin" || user.is_company_admin,
    },
    { id: "accounts", allowed: user.is_superuser || user.role === "admin" },
    {
      id: "requests-admin-view",
      allowed:
        user.is_superuser || user.role === "admin" || user.is_request_admin,
    },
    {
      id: "payments",
      allowed:
        user.is_superuser || user.role === "admin" || user.is_payment_admin,
    },
    {
      id: "deductions-section",
      allowed:
        user.is_superuser || user.role === "admin" || user.is_deduction_admin,
    },
  ];

  permissions.forEach(({ id, allowed }) => {
    const element = document.getElementById(id);
    if (element) element.style.display = allowed ? "" : "none";
  });
}

// ==========================================
// EMPLOYEE MANAGEMENT
// ==========================================

async function loadEmployees(page = 1) {
  try {
    const res = await apiRequest(buildUrl("/api/employees/", { page })); // No spinner here, caller manages
    if (!res.success) throw new Error(res.message);

    AppState.employees = res.data?.results || res.data || [];
    renderEmployees(AppState.employees);
    updateUIAfterEmployeeLoad();
    return true;
  } catch (err) {
    showToast(`Failed to load employees: ${err.message}`, "error");
    return false;
  }
}

// ==========================================
// ADDED: EMPLOYEE DETAIL VIEW
// ==========================================

async function viewEmployeeDetail(employeeId) {
  const employee = AppState.employees.find((e) => idsMatch(e.id, employeeId));
  if (!employee) {
    showToast("Employee not found", "error");
    return;
  }

  const content = document.getElementById("employeeDetailContent");
  if (!content) return;

  showLoading(); // Global spinner for modal content loading
  const res = await apiRequest(`/api/employees/${employeeId}/net_salary/`); // No spinner for this small API call

  const netData = res.success
    ? res.data
    : { pending_deductions: 0, net_salary: employee.salary };

  content.innerHTML = `
        <div class="detail-grid">
            <div class="detail-section">
                <h4>Basic Information</h4>
                <table class="detail-table">
                    <tr><td><strong>Employee ID:</strong></td><td>${escapeHtml(employee.employee_id || "N/A")}</td></tr>
                    <tr><td><strong>Full Name:</strong></td><td>${escapeHtml(employee.name || "N/A")}</td></tr>
                    <tr><td><strong>Type:</strong></td><td>${escapeHtml(employee.type || "N/A")}</td></tr>
                    <tr><td><strong>Status:</strong></td><td><span class="badge ${employee.status === "active" ? "bg-success" : "bg-danger"}">${escapeHtml(employee.status || "Active")}</span></td></tr>
                    <tr><td><strong>Location:</strong></td><td>${escapeHtml(employee.location || "N/A")}</td></tr>
                </table>
            </div>
            
            <div class="detail-section">
                <h4>Contact Information</h4>
                <table class="detail-table">
                    <tr><td><strong>Email:</strong></td><td>${escapeHtml(employee.email || "N/A")}</td></tr>
                    <tr><td><strong>Phone:</strong></td><td>${escapeHtml(employee.phone || "N/A")}</td></tr>
                </table>
            </div>
            
            <div class="detail-section">
                <h4>Bank Details</h4>
                <table class="detail-table">
                    <tr><td><strong>Bank Name:</strong></td><td>${escapeHtml(employee.bank_name || "N/A")}</td></tr>
                    <tr><td><strong>Account Number:</strong></td><td>${escapeHtml(employee.account_number || "N/A")}</td></tr>
                    <tr><td><strong>Account Holder:</strong></td><td>${escapeHtml(employee.account_holder || "N/A")}</td></tr>
                </table>
            </div>
            
            <div class="detail-section">
                <h4>Salary Information</h4>
                <table class="detail-table">
                    <tr><td><strong>Base Salary:</strong></td><td>${formatCurrency(employee.salary)}</td></tr>
                    <tr><td><strong>Pending Deductions:</strong></td><td class="text-danger">${formatCurrency(netData.pending_deductions)}</td></tr>
                    <tr><td><strong>Net Salary:</strong></td><td class="text-success font-bold">${formatCurrency(netData.net_salary)}</td></tr>
                </table>
            </div>
        </div>
    `;

  openModal("employeeDetailModal");
  hideLoading(); // Global spinner
}

async function resignEmployee(empId) {
  const reason = prompt("Enter resignation details/reason:");
  if (reason === null) return;

  try {
    showLoading(); // Global spinner
    const res = await apiRequest(`/api/employees/${empId}/resign/`, {
      method: "POST",
      body: { reason: reason || "Voluntary Resignation" },
    });

    if (!res.success) throw new Error(res.message);

    showToast("Resignation processed successfully", "success");
    await loadEmployees();
    await loadSackedEmployees();
    updateDashboardStats();
  } catch (err) {
    showToast(err.message || "Failed to process resignation", "error");
  } finally {
    hideLoading(); // Global spinner
    try {
      updateUIAfterEmployeeLoad();
    } catch (uiErr) {
      console.warn("UI refresh after resignation failed:", uiErr);
    }
  }
}

async function approveEmployee(empId) {
  if (!confirm("Are you sure you want to approve this employee registration?"))
    return;

  try {
    showLoading(); // Global spinner
    const res = await apiRequest(`/api/employees/${empId}/approve/`, {
      method: "POST",
    });

    if (!res.success) throw new Error(res.message);

    showToast("Employee approved successfully", "success");
    await loadEmployees();
    updateDashboardStats();
  } catch (err) {
    showToast(err.message || "Failed to approve employee", "error");
  } finally {
    hideLoading(); // Global spinner
  }
}

async function bulkApproveEmployees() {
  const checkboxes = document.querySelectorAll(".employee-checkbox:checked");
  const ids = Array.from(checkboxes).map((cb) => cb.value);

  if (!ids.length) {
    showToast("Select at least one pending employee", "warning");
    return;
  }

  if (!confirm(`Are you sure you want to approve ${ids.length} employees?`))
    return;

  try {
    showLoading(); // Global spinner
    const res = await apiRequest("/api/employees/bulk_approve/", {
      method: "POST",
      body: { ids },
    });

    if (!res.success) throw new Error(res.message);

    showToast(res.data.message || "Employees approved", "success");
    await loadEmployees();
    updateDashboardStats();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    hideLoading(); // Global spinner
  }
}

function renderEmployees(list = []) {
  const tableBody =
    AppState.elements.tbody || document.getElementById("employeeTableBody");
  if (!tableBody) return;

  tableBody.innerHTML = "";
  const selectAll = document.getElementById("selectAllEmployees");
  if (selectAll) selectAll.checked = false; // Uncheck "Select All" on re-render

  if (!list.length) {
    tableBody.innerHTML =
      '<tr><td colspan="8" class="text-center">No employees found</td></tr>';
    return;
  }

  const isAdmin =
    AppState.currentUser?.is_superuser ||
    AppState.currentUser?.role === "admin";

  list.forEach((emp) => {
    if (!emp) return;
    const row = document.createElement("tr");
    const isPending = emp.status === "pending"; // Fixed: Only pending employees can be bulk approved

    row.innerHTML = `
            <td>${isPending && isAdmin ? `<input type="checkbox" class="employee-checkbox" value="${emp.id}">` : ""}</td>
            <td>${escapeHtml(emp.employee_id ?? emp.id ?? "-")}</td>
            <td>${escapeHtml(emp.name ?? "-")}</td>
            <td>${escapeHtml(emp.type ?? "-")}</td>
            <td>${escapeHtml(emp.location ?? "-")}</td>
            <td>${escapeHtml(emp.bank_name ?? "-")}</td>
            <td>${formatCurrency(emp.salary)}</td>
            <td><span class="badge ${emp.status === "active" ? "bg-success" : emp.status === "pending" ? "bg-warning" : "bg-danger"}">${escapeHtml(emp.status || "Active")}</span></td>
            <td>
                <button type="button" class="btn btn-sm btn-info" onclick="viewEmployeeDetail('${emp.id}')">
                    <i class="fas fa-eye"></i> View
                </button>
                ${
                  emp.status === "pending"
                    ? `
                    <button type="button" class="btn btn-sm btn-success" onclick="approveEmployee('${emp.id}')">
                        <i class="fas fa-user-check"></i> Approve
                    </button>
                    <button type="button" class="btn btn-sm btn-outline-info" onclick="resendConfirmationMail('${emp.id}')">
                        <i class="fas fa-envelope"></i> Resend Mail
                    </button>
                `
                    : `
                <button type="button" class="btn btn-sm btn-success" onclick="initiateIndividualPayment('${emp.id}')">Pay</button>
                `
                }
                <button type="button" class="btn btn-sm btn-info" onclick="resignEmployee('${emp.id}')">Resign</button>
                <button type="button" class="btn btn-sm btn-warning" onclick="showSackEmployeeModal('${emp.id}')">Sack</button>
                <button type="button" class="btn btn-sm btn-danger" onclick="handleDelete('${emp.id}')">Delete</button>
            </td>
        `;
    tableBody.appendChild(row);
  });
}

async function fetchNextEmployeeId(type) {
  const res = await apiRequest(buildUrl("/next-employee-id/", { type }));
  if (res.success && res.data?.next_id) return res.data.next_id;
  return "";
}

function validateEmployeePayload(payload) {
  const required = ["name", "type", "location"];
  for (const field of required) {
    if (!payload[field])
      throw new Error(
        `${field.charAt(0).toUpperCase() + field.slice(1)} is required`,
      );
  }
  if (!payload.salary || isNaN(payload.salary) || payload.salary <= 0) {
    throw new Error("Valid salary is required");
  }
}

async function handleCreateEmployee(e) {
  e.preventDefault();

  const btn =
    document.getElementById("createEmployeeBtn") ||
    e.target.querySelector('button[type="submit"]');

  function parseMoney(value) {
    return Number(String(value).replace(/,/g, "").trim()) || 0;
  }

  const payload = {
    name: document.getElementById("newEmployeeName")?.value.trim(),
    type: document.getElementById("newEmployeeType")?.value.trim(),
    location: document.getElementById("newEmployeeLocation")?.value.trim(),
    salary: parseMoney(document.getElementById("newEmployeeSalary")?.value),
    email: document.getElementById("newEmployeeEmail")?.value.trim(),
    phone: document.getElementById("newEmployeePhone")?.value.trim(),
    bank_name: document.getElementById("newEmployeeBankName")?.value.trim(),
    bank_code: document.getElementById("newEmployeeBankName")?.selectedOptions?.[0]?.dataset?.code || "",
    account_number: document.getElementById("newEmployeeAccountNumber")?.value.trim(),
    account_holder: document.getElementById("newEmployeeAccountHolder")?.value.trim(),
    employee_id: document.getElementById("newEmployeeId")?.value?.trim() || "",
};

  // Hybrid validation
  const missingFields = [];
  if (!payload.name) missingFields.push("Name");
  if (!payload.type) missingFields.push("Type");
  if (!payload.location) missingFields.push("Location");
  if (!payload.salary) missingFields.push("Valid Salary");
  if (!payload.email) missingFields.push("Email");
  if (!payload.phone) missingFields.push("Phone");
  if (!payload.bank_name) missingFields.push("Bank Name");
  if (!payload.account_number || payload.account_number.length !== 10)
    missingFields.push("Valid 10-digit Account Number");
  if (!payload.account_holder) missingFields.push("Account Holder Name");

  if (missingFields.length) {
    showToast(`Missing fields: ${missingFields.join(", ")}`, "error");
    return;
  }

  try {
    showLoading(btn);

    const res = await apiRequest("/api/employees/", {
      method: "POST",
      body: payload,
    });

    if (!res.success) {
      // Improved error handling: display specific backend validation errors
      let errorMessage = res.message || "Failed to create employee";
      if (res.data && typeof res.data === "object") {
        const fieldErrors = Object.keys(res.data)
          .map(
            (key) =>
              `${key}: ${Array.isArray(res.data[key]) ? res.data[key].join(", ") : res.data[key]}`,
          )
          .join("; ");
        if (fieldErrors) errorMessage = `Validation Error: ${fieldErrors}`;
      }
      throw new Error(errorMessage);
    }

    showToast("Employee created successfully!", "success");

    await loadEmployees();
    updateDashboardStats();
    updateUIAfterEmployeeLoad();

    closeModal("addEmployeeModal");
    document.getElementById("addEmployeeForm")?.reset();
  } catch (err) {
    console.error(err);
    showToast(`Error creating employee: ${err.message}`, "error");
  } finally {
    hideLoading(btn);
  }
}

async function handleDelete(id) {
  if (!confirm("Are you sure you want to delete this employee?")) return;

  try {
    const res = await apiRequest(`/api/employees/${id}/`, { method: "DELETE" });
    if (!res.success) throw new Error(res.message);

    await loadEmployees();
    updateDashboardStats();
    showToast("Employee deleted successfully", "success");
  } catch (err) {
    showToast(`Failed to delete employee: ${err.message}`, "error");
  }
}

async function resendConfirmationMail(empId) {
  try {
    showLoading();
    const res = await apiRequest(
      `/api/employees/${empId}/resend_confirmation/`,
      {
        // Global spinner
        method: "POST",
      },
    );

    if (!res.success) throw new Error(res.message);

    showToast("Confirmation emails resent successfully", "success");
  } catch (err) {
    showToast(err.message || "Failed to resend emails", "error");
  } finally {
    hideLoading();
  }
}

// ==========================================
// ACCOUNT CREATION - FIXED ID GENERATION
// ==========================================

/**
 * Evaluates password strength based on length, casing, numbers, and symbols.
 */
function checkPasswordStrength(password) {
  let strength = 0;
  if (password.length >= 8) strength++;
  if (password.match(/[a-z]/) && password.match(/[A-Z]/)) strength++;
  if (password.match(/\d/)) strength++;
  if (password.match(/[^a-zA-Z\d]/)) strength++;
  return strength;
}

/**
 * Updates the UI feedback for password strength.
 */
function updatePasswordUI(password) {
  const meter = document.getElementById("passwordStrength");
  const feedback = document.getElementById("passwordFeedback");
  if (!meter) return;

  const strength = checkPasswordStrength(password);
  const colors = ["#dc3545", "#ffc107", "#17a2b8", "#28a745"];
  const texts = ["Very Weak", "Weak", "Good", "Strong"];

  meter.style.width = (password.length > 0 ? strength * 25 : 0) + "%";
  meter.style.backgroundColor = colors[strength - 1] || "#eee";
  if (feedback) {
    feedback.textContent = password
      ? `Strength: ${texts[strength - 1] || "Too short"}`
      : "Min 8 chars, uppercase, number & symbol";
    feedback.style.color = colors[strength - 1] || "#6c757d";
  }
}

/**
 * Unified handler for both Admin User creation and Public Self-Signup.
 */
async function handleRegistration(e, isSelfSignup = false) {
  e.preventDefault();
  const btn = document.getElementById("createAccountBtn");
  const endpoint = isSelfSignup ? "/self-register/" : "/register/";

  function parseMoney(value) {
    return Number(String(value).replace(/,/g, "").trim()) || 0;
  }
  const payload = {
    username: document.getElementById("accountUsername")?.value.trim(),
    password: document.getElementById("accountPassword")?.value,
    full_name: document.getElementById("accountName")?.value.trim(),
    role: document.getElementById("accountType")?.value,
    location: document.getElementById("accountLocation")?.value.trim(),
    salary: parseMoney(document.getElementById("accountSalary")?.value),
    phone: document.getElementById("accountPhone")?.value.trim(),
    email: document.getElementById("accountEmail")?.value.trim(),
    bank_name: document.getElementById("accountBankName")?.value,
    bank_code: document.getElementById("accountBankName")?.selectedOptions?.[0]?.dataset?.code || "",
    account_number: document.getElementById("accountNumber")?.value.trim(),
    account_holder: document.getElementById("accountHolderName")?.value.trim(),
    employee_id: document.getElementById("generatedEmployeeIdInput")?.value || document.getElementById("generatedEmployeeId")?.textContent.trim() || "",
};

  // Password Strength Check
  const strength = checkPasswordStrength(payload.password || "");
  if (strength < 3) {
    showToast(
      "Password is too weak. Please use uppercase, numbers and symbols.",
      "error",
    );
    return;
  }

  const missing = [];
  if (!payload.username) missing.push("Username");
  if (!payload.password || payload.password.length < 8)
    missing.push("Password (min 8 chars)");
  if (!payload.full_name || payload.full_name.split(/\s+/).length < 2)
    missing.push("Full Name (min 2 names)");
  if (!payload.role) missing.push("Employee Type");

  if (payload.role !== "admin") {
    if (!payload.salary) missing.push("Salary");
    if (!payload.location) missing.push("Location");
    if (!payload.bank_name || !payload.bank_code)
      missing.push("Valid Bank Selection");
    if (!payload.account_number || !/^\d{10}$/.test(payload.account_number))
      missing.push("10-digit Account Number");
    if (!payload.account_holder) missing.push("Verified Account Holder Name");
  }

  if (missing.length) {
    showToast("Missing or invalid fields: " + missing.join(", "), "warning");
    return;
  }

  try {
    showLoading(btn);
    const res = await apiRequest(endpoint, {
      method: "POST",
      body: payload,
    });

    if (!res.success) {
      throw new Error(res.message || "Registration failed");
    }

    showToast(res.data?.message || "Registration successful", "success");

    if (isSelfSignup) {
      closeModal("signup-modal");
      return;
    }

    document.getElementById("createAccountForm")?.reset();
    await loadDashboard();
    showSection("employees");
  } catch (err) {
    console.error(err);
    showToast(err.message, "error");
  } finally {
    hideLoading(btn);
  }
}

// ==========================================
// COMPANY MANAGEMENT
// ==========================================

async function loadCompanies() {
  try {
    const res = await apiRequest("/api/companies/");
    if (!res.success) {
      throw new Error(res.message);
    } // No spinner here, caller manages

    AppState.companies = res.data?.results || res.data || [];
    renderCompanies(AppState.companies);
    return true;
  } catch (err) {
    showToast(`Failed to load companies: ${err.message}`, "error");
    return false;
    // No hideLoading here, as it's part of loadDashboard or another context
  }
}

function renderCompanies(list) {
  const tbody =
    AppState.elements.companiesTbody ||
    document.getElementById("companiesTableBody");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!list.length) {
    tbody.innerHTML =
      '<tr><td colspan="12" class="text-center">No companies found</td></tr>';
    return;
  }

  list.forEach((company) => {
    const guardsCount = Array.isArray(company.assigned_guards)
      ? company.assigned_guards.length
      : company.guards_count || 0;
    const totalToGuards = Number(company.total_payment_to_guards) || 0;
    const profit = Number(company.profit) || 0;

    const row = document.createElement("tr");
    row.innerHTML = `
            <td>${escapeHtml(company.name)}</td>
            <td>${escapeHtml(company.email || "-")}</td>
            <td>${escapeHtml(company.phone || "-")}</td>
            <td>${escapeHtml(company.location)}</td>
            <td>
                <span class="badge ${company.status === "active" ? "bg-success" : "bg-danger"}" title="${escapeHtml(company.termination_reason || "")}">
                    ${escapeHtml(company.status === "terminated" ? "Not Active" : company.status || "Active")}
                </span>
                ${company.status === "terminated" && company.termination_reason ? `<br><small class="reason-text">${escapeHtml(company.termination_reason)}</small>` : ""}
            </td>
            <td>${formatDate(company.contract_start)}</td>
            <td>${formatDate(company.contract_end)}</td>
            <td>${guardsCount}</td>
            <td>${formatCurrency(company.payment_to_us)}</td>
            <td>${formatCurrency(totalToGuards)}</td>
            <td class="${profit >= 0 ? "text-success" : "text-danger"}">${formatCurrency(profit)}</td>
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
    document.querySelectorAll(
      '#companyAssignedGuardsContainer input[name="assigned_guards"]:checked',
    ),
  ).map((cb) => cb.value);

  const name = document.getElementById("companyName")?.value.trim();

  // Auto-detect existing company by name if not in explicit edit mode
  let targetId = AppState.currentEditingCompanyId;
  if (!targetId && name) {
    const existing = AppState.companies.find(
      (c) => c.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) targetId = existing.id;
  }

  const payload = {
    name: name,
    location: document.getElementById("companyLocation")?.value.trim(),
    email: document.getElementById("companyEmail")?.value.trim() || null,
    phone: document.getElementById("companyPhone")?.value.trim() || null,
    contract_start: document.getElementById("companyStartDate")?.value || null,
    contract_end: document.getElementById("companyEndDate")?.value || null,
    guards_count:
      parseInt(document.getElementById("companyGuardsCount")?.value) || 0,
    payment_to_us:
      parseFloat(document.getElementById("companyPaymentToUs")?.value) || 0,
    payment_per_guard:
      parseFloat(document.getElementById("companyPaymentPerGuard")?.value) || 0,
    assigned_guards: selectedGuards,
  };

  if (!payload.name || !payload.location || payload.guards_count < 1) {
    showToast(
      "Please fill all required company fields (Name, Location, and at least 1 Guard)",
      "error",
    );
    return;
  }

  try {
    showLoading(btn);

    const url = targetId ? `/api/companies/${targetId}/` : "/api/companies/";
    const method = targetId ? "PUT" : "POST";

    const res = await apiRequest(url, { method, body: payload });
    if (!res.success) throw new Error(res.message);

    showToast(
      AppState.currentEditingCompanyId
        ? "Company updated successfully"
        : "Company created successfully",
      "success",
    );

    document.getElementById("addCompanyForm")?.reset();
    AppState.currentEditingCompanyId = null;
    closeModal("addCompanyModal");

    await loadCompanies();
  } catch (err) {
    showToast(err.message || "Failed to save company", "error");
  } finally {
    hideLoading(btn);
  }
}

async function deleteCompany(companyId) {
  const reason = prompt("Enter reason for marking this company as Not Active:");
  if (reason === null) return;
  showLoading(); // Global spinner
  try {
    const res = await apiRequest(`/api/companies/${companyId}/`, {
      method: "DELETE",
      body: { reason: reason || "Contract ended" },
    });
    if (!res.success) throw new Error(res.message);

    showToast("Company status updated to Not Active", "success");
    await loadCompanies();
  } catch (err) {
    showToast(err.message || "Failed to delete company", "error");
  }
}

function editCompany(companyId) {
  const company = AppState.companies.find((c) => c.id === companyId);
  if (!company) {
    showToast("Company not found", "error");
    return;
  }

  AppState.currentEditingCompanyId = company.id;
  document.getElementById("companyName").value = company.name || "";
  document.getElementById("companyLocation").value = company.location || "";
  document.getElementById("companyEmail").value = company.email || "";
  document.getElementById("companyPhone").value = company.phone || "";
  document.getElementById("companyStartDate").value =
    company.contract_start || "";
  document.getElementById("companyEndDate").value = company.contract_end || "";
  document.getElementById("companyGuardsCount").value =
    company.guards_count || 0;
  document.getElementById("companyPaymentToUs").value =
    company.payment_to_us || 0;
  document.getElementById("companyPaymentPerGuard").value =
    company.payment_per_guard || 0;

  const title = document.getElementById("companyModalTitle");
  const btn = document.getElementById("saveCompanyBtn");
  if (title) title.textContent = "Edit Company";
  if (btn) btn.textContent = "Update Company";

  populateCompanyGuards();

  if (Array.isArray(company.assigned_guards)) {
    company.assigned_guards.forEach((guardId) => {
      const checkbox = document.querySelector(
        `#companyAssignedGuardsContainer input[value="${guardId}"]`,
      );
      if (checkbox) checkbox.checked = true;
    });
  }

  openModal("addCompanyModal");
}

async function renewCompanyContract(companyId) {
  if (!confirm("Renew this contract for another year?")) return;
  const res = await apiRequest(`/api/companies/${companyId}/renew_contract/`, {
    method: "POST",
  });
  if (res.success) {
    showToast("Contract renewed successfully", "success");
    await loadCompanies();
  }
}

async function terminateCompanyContract(companyId) {
  if (!confirm("Terminate this contract immediately?")) return;
  const res = await apiRequest(
    `/api/companies/${companyId}/terminate_contract/`,
    { method: "POST" },
  );
  if (res.success) {
    showToast("Contract terminated", "warning");
    await loadCompanies();
  }
}

// ==========================================
// DEDUCTIONS MANAGEMENT - FIXED STATUS CONTROL
// ==========================================

async function loadDeductions() {
  try {
    const res = await apiRequest("/api/deductions/");
    if (!res.success) {
      throw new Error(res.message);
    } // No spinner here, caller manages

    AppState.deductions = res.data?.results || res.data || [];
    renderDeductions(AppState.deductions);
    updateDashboardStats();
    return true;
  } catch (err) {
    showToast(`Failed to load deductions: ${err.message}`, "error");
    // No hideLoading here, as it's part of loadDashboard or another context
    return false;
  }
}

function renderDeductions(list) {
  const tbody =
    AppState.elements.deductionsTbody ||
    document.getElementById("deductionsTableBody");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!list.length) {
    tbody.innerHTML =
      '<tr><td colspan="7" class="text-center">No deductions found</td></tr>';
    return;
  }

  list.forEach((ded) => {
    const row = document.createElement("tr");
    const statusClass =
      ded.status === "applied"
        ? "text-success"
        : ded.status === "cancelled"
          ? "text-danger"
          : "text-warning";

    row.innerHTML = `
            <td>${escapeHtml(ded.date || "-")}</td>
            <td>${escapeHtml(ded.employee_id || ded.employee || "-")}</td>
            <td>${escapeHtml(ded.employee_name || "-")}</td>
            <td>${formatCurrency(ded.amount)}</td>
            <td>${escapeHtml(ded.reason || "-")}</td>
            <td><span class="${statusClass}">${escapeHtml(ded.status || "Pending")}</span></td>
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
  const btn = document.getElementById("addDeductionBtn");

  const employeeId = document.getElementById("deductionEmployee")?.value;
  const amount = Number(document.getElementById("deductionAmount")?.value);
  const reason = document.getElementById("deductionReason")?.value.trim();
  const date = new Date().toISOString().split("T")[0];

  if (!employeeId || !Number.isFinite(amount) || amount <= 0 || !reason) {
    showToast("All fields are required", "warning");
    return;
  }

  try {
    showLoading(btn);

    const res = await apiRequest("/api/deductions/", {
      method: "POST",
      body: { employee: employeeId, amount, reason, date, status: "applied" },
    });

    if (!res.success) throw new Error(res.message);

    showToast("Deduction added successfully", "success");
    closeModal("addDeductionModal");
    document.getElementById("addDeductionForm")?.reset();
    await loadDeductions();
    await loadEmployees();
    populatePaymentsTable();
    populateBulkTable();
    await updateDashboardStats();
  } catch (err) {
    showToast(`Failed to add deduction: ${err.message}`, "error");
  } finally {
    hideLoading(btn);
  }
}

async function updateDeduction(e) {
  e.preventDefault();
  if (!AppState.currentEditingDeductionId) return;

  const btn = document.getElementById("editDeductionBtn");
  const employeeId = document.getElementById("editDeductionEmployee")?.value;
  const amount = Number(document.getElementById("editDeductionAmount")?.value);
  const reason = document.getElementById("editDeductionReason")?.value.trim();
  const status =
    document.getElementById("editDeductionStatus")?.value || "pending"; // ADDED: Status control
  const existingDeduction = AppState.deductions.find(
    (d) => d.id === AppState.currentEditingDeductionId,
  );

  if (
    !employeeId ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    !reason ||
    !existingDeduction
  ) {
    showToast("All fields are required", "warning");
    return;
  }

  try {
    showLoading(btn);

    const res = await apiRequest(
      `/api/deductions/${AppState.currentEditingDeductionId}/`,
      {
        method: "PUT",
        body: {
          employee: employeeId,
          amount,
          reason,
          date: existingDeduction.date,
          status: status, // Use selected status
        },
      },
    );

    if (!res.success) throw new Error(res.message);

    showToast("Deduction updated successfully", "success");
    closeModal("editDeductionModal");
    AppState.currentEditingDeductionId = null;
    await loadDeductions();
    await loadEmployees();
    populatePaymentsTable();
    populateBulkTable();
    await updateDashboardStats();
  } catch (err) {
    showToast(`Failed to update deduction: ${err.message}`, "error");
  } finally {
    hideLoading(btn);
  }
}

async function bulkApproveDeductions() {
  const month = prompt(
    "Enter month to approve (YYYY-MM):",
    new Date().toISOString().slice(0, 7),
  ); // No spinner for prompt
  if (!month) return;
  const res = await apiRequest("/api/deductions/bulk_approve/", {
    method: "POST",
    body: { month },
  });
  if (res.success) {
    showToast(res.data.message, "success");
    await loadDeductions();
  }
}

async function deleteDeduction(id) {
  if (!confirm("Are you sure you want to delete this deduction?")) return;

  showLoading(); // Global spinner
  try {
    const res = await apiRequest(`/api/deductions/${id}/`, {
      method: "DELETE",
    });
    if (!res.success) throw new Error(res.message);

    showToast("Deduction deleted successfully", "success");
    await loadDeductions();
    updateDashboardStats();
  } catch (err) {
    showToast(`Failed to delete deduction: ${err.message}`, "error");
  }
}

function editDeduction(id) {
  AppState.currentEditingDeductionId = id;
  const deduction = AppState.deductions.find((d) => d.id === id);
  if (!deduction) return;

  populateEmployeeSelect("editDeductionEmployee");
  openModal("editDeductionModal");

  document.getElementById("editDeductionEmployee").value = deduction.employee;
  document.getElementById("editDeductionAmount").value = deduction.amount;
  document.getElementById("editDeductionReason").value = deduction.reason;
  document.getElementById("editDeductionStatus").value =
    deduction.status || "pending"; // ADDED
}

// ==========================================
// ATTENDANCE - FIXED WITH LEAVE SUPPORT
// ==========================================

function toggleCamera() {
  const markWithoutSelfie =
    document.getElementById("markWithoutSelfie")?.checked;
  const cameraSection = document.getElementById("cameraSection");
  const cameraButtons = document.getElementById("cameraButtons");
  const submitBtn = document.getElementById("submitClockBtn");

  if (markWithoutSelfie) {
    if (cameraSection) cameraSection.style.display = "none";
    if (cameraButtons) cameraButtons.style.display = "none";
    if (submitBtn) submitBtn.disabled = false;
  } else {
    if (cameraSection) cameraSection.style.display = "block";
    if (cameraButtons) cameraButtons.style.display = "flex";
    if (submitBtn) submitBtn.disabled = true;
  }
}

async function loadAttendance() {
  try {
    const res = await apiRequest("/api/attendance/"); // No spinner here, caller manages
    if (!res.success) throw new Error(res.message);

    const list = res.data?.results || res.data || [];
    AppState.attendance = list; // Store for stats
    const tbody =
      AppState.elements.attendanceTbody ||
      document.getElementById("attendanceTableBody");
    if (!tbody) return;

    tbody.innerHTML = "";

    if (!list.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="text-center">No attendance records found</td></tr>';
      updateAttendanceStats(0, 0, 0);
      return;
    }
    list.forEach((att) => {
      const row = document.createElement("tr");
      const photoUrl = att.clock_in_photo
        ? att.clock_in_photo.replace(/^\/media\//, "/media/")
        : null;

      const statusText =
        att.status === "leave" && att.leave_start && att.leave_end
          ? `Leave (${att.leave_start} to ${att.leave_end})`
          : `${att.status || "-"}${att.clock_method ? ` (${att.clock_method})` : ""}`;

      row.innerHTML = `
                <td>${escapeHtml(att.date || "-")}</td>
                <td>${escapeHtml(att.employee_id || "-")}</td>
                <td>${escapeHtml(att.employee_name || "-")}</td>
                <td>${escapeHtml(att.clock_in_display || att.clock_in || "-")}</td>
                <td>${escapeHtml(att.clock_out_display || att.clock_out || "-")}</td>
                <td><span class="badge ${att.status === "present" ? "bg-success" : att.status === "leave" ? "bg-warning" : "bg-danger"}">${escapeHtml(statusText)}</span></td>
                <td>
                    ${
                      photoUrl
                        ? `<img src="${escapeHtml(photoUrl)}" width="40" alt="clock in" class="img-thumbnail" 
                            onerror="this.style.display='none'; this.parentElement.innerHTML='-'">`
                        : "-"
                    }
                </td>
            `;
      tbody.appendChild(row);
    });
  } catch (err) {
    console.error("Load attendance error:", err);
    showToast(err.message || "Failed to load attendance", "error");
    // No hideLoading here, as it's part of loadDashboard or another context
  }
}

function updateAttendanceStats(present, absent, leave) {
  const presentEl = document.getElementById("presentToday");
  const absentEl = document.getElementById("absentToday");
  const leaveEl = document.getElementById("onLeave");

  if (presentEl) presentEl.textContent = present;
  if (absentEl) absentEl.textContent = absent;
  if (leaveEl) leaveEl.textContent = leave;
}

async function handleMarkLeave(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');

  const employeeId = document.getElementById("leaveEmployee")?.value;
  const startDate = document.getElementById("leaveStartDate")?.value;
  const endDate = document.getElementById("leaveEndDate")?.value;
  const reason = document.getElementById("leaveReason")?.value.trim();

  if (!employeeId || !startDate || !endDate) {
    showToast("Please fill all required fields", "warning");
    return;
  }

  try {
    showLoading(btn);

    // FIXED: Use dedicated mark_leave endpoint instead of generic attendance
    const res = await apiRequest("/api/attendance/mark_leave/", {
      method: "POST",
      body: {
        employee_id: employeeId,
        start_date: startDate,
        end_date: endDate,
        reason: reason,
      },
    });

    if (!res.success) {
      throw new Error(res.message || "Failed to mark leave");
    }

    showToast(
      `Leave marked for ${res.data?.records?.length || 0} day(s)`,
      "success",
    );
    closeModal("leaveModal");
    await loadAttendance();
  } catch (err) {
    showToast(err.message || "Failed to mark leave", "error");
  } finally {
    hideLoading(btn);
  }
}

async function startCamera() {
  const video = document.getElementById("cameraVideo");
  if (!video) return;

  try {
    if (AppState.cameraStream) {
      AppState.cameraStream.getTracks().forEach((track) => track.stop());
    }

    AppState.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: true,
    });
    video.srcObject = AppState.cameraStream;

    const captureBtn = document.getElementById("captureBtn");
    if (captureBtn) captureBtn.disabled = false;
  } catch (err) {
    console.error("Camera error:", err);
    showToast("Camera access denied or not available", "error");
  }
}

function capturePhoto() {
  const video = document.getElementById("cameraVideo");
  const canvas = document.getElementById("cameraCanvas");
  const preview = document.getElementById("capturedImage");
  const submitBtn = document.getElementById("submitClockBtn");

  if (!video || !canvas || !preview) {
    showToast("Camera setup error", "error");
    return;
  }

  if (video.videoWidth === 0 || video.videoHeight === 0) {
    showToast("Camera not ready yet", "warning");
    return;
  }

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  canvas.toBlob(
    (blob) => {
      if (!blob) {
        showToast("Failed to capture image", "error");
        return;
      }

      AppState.capturedImageBlob = blob;

      const img = document.createElement("img");
      const url = URL.createObjectURL(blob);
      img.src = url;
      img.style.width = "100%";
      img.style.borderRadius = "8px";
      img.dataset.objectUrl = url;

      preview.innerHTML = "";
      preview.appendChild(img);

      if (submitBtn) submitBtn.disabled = false;
    },
    "image/jpeg",
    CONFIG.CAMERA_QUALITY,
  );
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

  const action = document.getElementById("clockAction")?.value;
  const employeeId = document.getElementById("clockEmployee")?.value;
  const markWithoutSelfie =
    document.getElementById("markWithoutSelfie")?.checked;

  if (!employeeId) {
    showToast("Please select an employee", "warning");
    return;
  }

  if (!markWithoutSelfie && !AppState.capturedImageBlob) {
    showToast("Please capture a photo first", "warning");
    return;
  }

  let url =
    action === "out"
      ? "/api/attendance/clock_out/"
      : "/api/attendance/clock_in/";
  let body = {
    employee: employeeId,
    employee_id: employeeId,
    date: new Date().toISOString().split("T")[0],
  };

  if (!markWithoutSelfie) {
    url =
      action === "out"
        ? "/api/attendance/clock_out_with_photo/"
        : "/api/attendance/clock_in_with_photo/";
    const photo = await blobToDataUrl(AppState.capturedImageBlob);
    body.photo = photo;
  }

  const submitBtn = document.getElementById("submitClockBtn");

  try {
    showLoading(submitBtn);

    const res = await apiRequest(url, {
      method: "POST",
      body,
    });

    if (!res.success)
      throw new Error(res.message || "Attendance recording failed");

    showToast(
      res.data?.message || "Attendance recorded successfully",
      "success",
    );

    AppState.capturedImageBlob = null;
    const preview = document.getElementById("capturedImage");
    if (preview) {
      const img = preview.querySelector("img");
      if (img?.dataset.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);
      preview.innerHTML = "";
    }

    document.getElementById("captureBtn").disabled = true;
    document.getElementById("submitClockBtn").disabled = true;

    closeModal("clockInModal");
    await loadAttendance();
  } catch (err) {
    console.error("Clock in error:", err);
    showToast(err.message || "Attendance error", "error");
  } finally {
    hideLoading(submitBtn);
  }
}

// ==========================================
// PAYMENTS - FIXED PAYSTACK INTEGRATION
// ==========================================

// ADDED: Update payment preview when employee selected
async function updatePaymentPreview() {
  const employeeId = document.getElementById("paymentEmployee")?.value;
  const preview = document.getElementById("paymentPreview");

  if (!employeeId || !preview) {
    if (preview) preview.style.display = "none";
    return;
  }

  const employee = AppState.employees.find((e) => idsMatch(e.id, employeeId));
  if (!employee) {
    preview.style.display = "none";
    return;
  }

  const res = await apiRequest(`/api/employees/${employeeId}/net_salary/`);
  const netData = res.success
    ? res.data
    : { pending_deductions: 0, net_salary: employee.salary };

  document.getElementById("previewBaseSalary").textContent = formatCurrency(
    employee.salary,
  );
  document.getElementById("previewDeductions").textContent = formatCurrency(
    netData.pending_deductions,
  );
  document.getElementById("previewNetAmount").textContent = formatCurrency(
    netData.net_salary,
  );
  document.getElementById("previewBank").textContent =
    employee.bank_name || "-";
  document.getElementById("previewAccount").textContent =
    employee.account_number || "-";

  preview.style.display = "block";
}

async function loadPaymentHistory() {
  const tbody =
    AppState.elements.historyTbody ||
    document.getElementById("historyTableBody");
  if (!tbody) {
    return;
  } // No spinner here, caller manages

  try {
    const res = await apiRequest("/api/payments/");
    if (!res.success) throw new Error(res.message);

    const list = res.data?.results || res.data || [];
    AppState.payments = list;
    tbody.innerHTML = "";

    if (!list.length) {
      tbody.innerHTML =
        '<tr><td colspan="8" class="text-center">No payment history found</td></tr>';
      return;
    }

    list.forEach((payment) => {
      const row = document.createElement("tr");
      const statusClass =
        payment.status === "completed"
          ? "text-success"
          : payment.status === "failed"
            ? "text-danger"
            : "text-warning";

      const isCompleted = payment.status === "completed";

      row.innerHTML = `
                <td>${escapeHtml(payment.payment_date || "-")}</td>
                <td>${escapeHtml(payment.employee_id || payment.employee || "-")}</td>
                <td>${escapeHtml(payment.employee_name || "-")}</td>
                <td>${escapeHtml(payment.bank_account || "-")}</td>
                <td>${formatCurrency(payment.net_amount)}</td>
                <td>${escapeHtml(payment.payment_method || "Paystack")}</td>
                <td><span class="${statusClass}">${escapeHtml(payment.status || "-")}</span></td>
                <td>
                    ${
                      isCompleted
                        ? `<span class="text-success"><i class="fas fa-check"></i> Paid</span>
                           <button type="button" class="btn btn-sm btn-outline-success" onclick="exportReceipt('${payment.id}')" title="Download Receipt">
                             <i class="fas fa-file-invoice"></i>
                           </button>`
                        : `<button type="button" class="btn btn-sm btn-primary" onclick="retryPayment('${payment.transaction_reference || payment.id}')">Retry</button>`
                    }
                </td>
            `;
      tbody.appendChild(row);
    });

    // Update pending payments count
    const pending = list.filter(
      (p) => p.status === "pending" || p.status === "processing",
    ).length;
    const pendingEl = document.getElementById("pendingPayments");
    if (pendingEl) pendingEl.textContent = pending;
  } catch (err) {
    console.error("Payment history load error:", err);
    const tbody = document.getElementById("historyTableBody");
    if (tbody) {
      tbody.innerHTML =
        '<tr><td colspan="8" class="text-center text-danger">Failed to load payment history. Server error.</td></tr>';
    }
    showToast("Payment history unavailable. Please try again later.", "error");
    // Update pending count to show error state
    const pendingEl = document.getElementById("pendingPayments");
    if (pendingEl) pendingEl.textContent = "Error";
    // No hideLoading here, as it's part of loadDashboard or another context
  }
}

async function processBulkPayment() {
  const checked = Array.from(
    document.querySelectorAll(
      "#bulkPaymentModal tbody input[type=checkbox]:checked",
    ),
  ).map((chk) => chk.value);

  if (!checked.length) {
    showToast("Select at least one employee", "warning");
    return;
  }

  if (checked.length > 50) {
    showToast("Maximum 50 employees per batch. Please select fewer.", "error");
    return;
  }

  const btn = document.querySelector("#bulkPaymentModal .btn-primary");

  try {
    showLoading(btn);

    const res = await apiRequest("/api/payments/bulk_payment/", {
      method: "POST",
      body: { employee_ids: checked },
    });

    if (!res.success) {
      throw new Error(res.message || "Bulk payment failed");
    }

    const results = res.data || {};
    const payments = results.payments || [];
    const errors = results.errors || [];

    // Show initial summary
    let message = `Initiated ${payments.length}/${checked.length} transfers.`;
    if (errors.length > 0) {
      message += ` ${errors.length} errors.`;
    }
    showToast(message, payments.length > 0 ? "success" : "error");

    // Close modal and refresh tables
    closeModal("bulkPaymentModal");
    await loadPaymentHistory();
    populatePaymentsTable();

    // START BULK POLLING for all successful initiations
    if (payments.length > 0) {
      startBulkPaymentPolling(payments);
    }
  } catch (err) {
    console.error("Bulk payment error:", err);
    showToast(err.message || "Bulk payment failed", "error");
  } finally {
    hideLoading(btn);
  }
}

async function startBulkPaymentPolling(
  payments,
  maxAttempts = 30,
  interval = 3000,
) {
  let attempts = 0;
  let currentDelay = interval;
  const total = payments.length;
  if (AppState.bulkPollInterval) clearTimeout(AppState.bulkPollInterval);

  // Ensure global spinner is visible and showing initial progress
  AppState.isPolling = true;
  showLoading(null, AppState.elements.globalSpinner);
  updateLoadingProgress(`Processing Bulk Payments: 0% (0/${total})`);

  const poll = async () => {
    attempts++;
    const pending = payments.filter((p) => !p.done);

    for (const p of pending) {
      const res = await apiRequest(`/payments/verify-payment/${p.reference}/`);
      if (
        res.success &&
        (res.data.is_completed || res.data.payment_status === "failed")
      ) {
        p.done = true;
        showToast(
          `${p.employee_name}: ${res.data.payment_status}`,
          res.data.is_completed ? "success" : "error",
        );
      }
    }

    const completedCount = payments.filter((p) => p.done).length;
    const percentage = Math.round((completedCount / total) * 100);
    updateLoadingProgress(
      `Processing Bulk Payments: ${percentage}% (${completedCount}/${total})`,
    );

    if (payments.every((p) => p.done) || attempts >= maxAttempts) {
      AppState.isPolling = false;
      updateLoadingProgress("Loading..."); // Reset for next use
      hideLoading(null, AppState.elements.globalSpinner);
      await loadDashboard(); // Reloading dashboard updates stats automatically
      return;
    }

    // Optimized Polling: Increase delay by 50% each time (Exponential Backoff) to save mobile data
    currentDelay = Math.min(currentDelay * 1.5, 30000);
    AppState.bulkPollInterval = setTimeout(poll, currentDelay);
  };
  AppState.bulkPollInterval = setTimeout(poll, currentDelay);
}

async function initiateIndividualPayment(empId) {
  try {
    const btn = document.querySelector(
      `button[onclick="initiateIndividualPayment('${empId}')"]`,
    );
    showLoading(btn);
    const res = await apiRequest("/api/payments/initiate_payment/", {
      method: "POST",
      body: { employee_id: empId },
    });

    if (!res.success) {
      throw new Error(res.message || "Failed to initiate payment");
    }

    // Store the reference for polling
    const reference = res.data.reference;
    AppState.currentPaymentReference = reference;

    // INTERNAL OTP FLOW REMOVED -> just poll until webhook/verify marks completed/failed
    showToast(res.data.message || "Payment initiated", "success");
    await loadPaymentHistory();
    await updateDashboardStats();
    startPaymentStatusPolling(reference);
  } catch (err) {
    showToast(err.message || "Failed to initiate payment", "error");
  } finally {
    hideLoading(
      document.querySelector(
        `button[onclick="initiateIndividualPayment('${empId}')"]`,
      ),
    );
  }
}

async function startPaymentStatusPolling(
  reference,
  maxAttempts = 30,
  interval = 3000,
) {
  let attempts = 0;
  let currentDelay = interval;

  const poll = async () => {
    attempts++; // No spinner here, as it's a background poll
    const res = await apiRequest(`/payments/verify-payment/${reference}/`);

    if (
      res.success &&
      (res.data.is_completed || res.data.payment_status === "failed")
    ) {
      showToast(
        `Payment ${res.data.payment_status}`,
        res.data.is_completed ? "success" : "error",
      );
      await loadDashboard();
      return;
    }
    if (attempts < maxAttempts) {
      currentDelay = Math.min(currentDelay * 1.5, 30000);
      setTimeout(poll, currentDelay);
    }
  };
  poll();
}

async function syncPaymentsWithPaystack() {
  const btn = document.getElementById("syncPaymentsBtn");
  try {
    showLoading(btn);
    const res = await apiRequest("/api/payments/sync_processing_payments/", {
      method: "POST",
    });
    if (res.success) {
      showToast(res.data.message, "success");
      await loadPaymentHistory();
      await updateDashboardStats();
    }
  } finally {
    hideLoading(btn);
  }
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
  const employeeId = document.getElementById("paymentEmployee")?.value;
  if (!employeeId) {
    showToast("Please select an employee", "warning");
    return;
  }
  await initiateIndividualPayment(employeeId);
}

async function updateBulkTotal() {
  const checkboxes = document.querySelectorAll(
    '#bulkPaymentModal tbody input[type="checkbox"]:checked',
  );
  const selectedIds = Array.from(checkboxes).map((cb) => cb.value);

  if (selectedIds.length === 0) {
    document.getElementById("bulkTotalAmount").textContent = formatCurrency(0);
    document.getElementById("bulkTotalEmployees").textContent = 0;
    return;
  }

  const res = await apiRequest("/api/payments/bulk_preview/", {
    method: "POST",
    body: { employee_ids: selectedIds },
  });

  if (res.success) {
    document.getElementById("bulkTotalAmount").textContent = formatCurrency(
      res.data.total_amount,
    );
    document.getElementById("bulkTotalEmployees").textContent = res.data.count;
  }
}

// ==========================================
// DOWNLOAD LOGS (AUDIT)
// ==========================================

async function loadDownloadLogs(search = "") {
  const tbody = document.getElementById("downloadLogsTableBody");
  if (!tbody) return;

  try {
    const url = search
      ? buildUrl("/api/download-logs/", { search })
      : "/api/download-logs/";
    const res = await apiRequest(url);

    if (!res.success) throw new Error(res.message);

    const list = res.data?.results || res.data || [];
    AppState.downloadLogs = list;

    tbody.innerHTML = "";
    if (!list.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="text-center">No download records found</td></tr>';
      return;
    }

    list.forEach((log) => {
      const row = document.createElement("tr");
      const employeeDisplay = log.employee_name
        ? `<strong>${escapeHtml(log.employee_name)}</strong><br><small>${escapeHtml(log.employee_id)}</small>`
        : `<span class="text-muted"><em>Bulk/System Export</em></span>`;

      row.innerHTML = `
                <td>${formatDate(log.timestamp)} ${new Date(log.timestamp).toLocaleTimeString()}</td>
                <td>${escapeHtml(log.user_username || "System")}</td>
                <td>${employeeDisplay}</td>
                <td><span class="badge bg-info">${log.doc_type.toUpperCase()}</span></td>
                <td><code>${escapeHtml(log.reference)}</code></td>
                <td><small>${escapeHtml(log.ip_address || "-")}</small></td>
            `;
      tbody.appendChild(row);
    });
  } catch (err) {
    showToast("Failed to load audit logs", "error");
    // No hideLoading here, as it's part of loadDashboard or another context
  }
}

function filterDownloadLogs() {
  const query = document.getElementById("auditLogSearch")?.value;
  loadDownloadLogs(query);
}

// ==========================================
// SACKED EMPLOYEES
// ==========================================

async function loadSackedEmployees() {
  try {
    const res = await apiRequest("/api/sacked-employees/");
    if (!res.success) throw new Error(res.message);

    const list = res.data?.results || res.data || [];
    const tbody =
      AppState.elements.sackedTbody ||
      document.getElementById("sackedTableBody");
    if (!tbody) return;

    tbody.innerHTML = "";

    if (!list.length) {
      tbody.innerHTML =
        '<tr><td colspan="7" class="text-center">No sacked employees found</td></tr>';
      return;
    }

    list.forEach((record) => {
      const row = document.createElement("tr");
      row.innerHTML = `
                <td>${escapeHtml(record.employee_id || "-")}</td>
                <td>${escapeHtml(record.employee_name || "-")}</td>
                <td>${escapeHtml(record.employee_type || "-")}</td>
                <td>${escapeHtml(record.date_sacked || "-")}</td>
                <td>${escapeHtml(record.offense || "-")}</td>
                <td>${escapeHtml(record.terminated_by_name || "-")}</td>
                <td>
                    <button type="button" onclick="reinstateEmployee('${record.id}')" class="btn btn-sm btn-success">Reinstate</button>
                </td>
            `;
      tbody.appendChild(row);
    });
  } catch (err) {
    showToast(`Failed to load sacked employees: ${err.message}`, "error");
    // No hideLoading here, as it's part of loadDashboard or another context
  }
}

async function handleSackEmployee(e) {
  e.preventDefault();
  const btn =
    document.getElementById("confirmSackBtn") ||
    e.target.querySelector('button[type="submit"]');

  const employeeId = document.getElementById("sackEmployeeId")?.value;
  const offense = document.getElementById("sackReason")?.value.trim();

  if (!employeeId || !offense) {
    showToast("Employee and offense reason are required", "error");
    return;
  }

  try {
    showLoading(btn);

    const res = await apiRequest(`/api/employees/${employeeId}/terminate/`, {
      method: "POST",
      body: { offense },
    });

    if (!res.success) throw new Error(res.message);

    showToast("Employee terminated successfully", "success");
    closeModal("sackEmployeeModal");

    // FIXED: Immediately reload all relevant data
    await loadEmployees();
    await loadSackedEmployees();
    updateDashboardStats();
    updateUIAfterEmployeeLoad();
  } catch (err) {
    showToast(err.message || "Failed to terminate employee", "error");
  } finally {
    hideLoading(btn);
  }
}

async function reinstateEmployee(sackedId) {
  if (!confirm("Are you sure you want to reinstate this employee?")) return;

  try {
    const res = await apiRequest(
      `/api/sacked-employees/${sackedId}/reinstate/`,
      {
        // Global spinner
        method: "POST",
      },
    );

    if (!res.success) throw new Error(res.message);

    showToast("Employee reinstated successfully", "success");

    // Reload relevant data
    await loadEmployees();
    await loadSackedEmployees();
    updateDashboardStats();
    updateUIAfterEmployeeLoad();
  } catch (err) {
    showToast(err.message || "Failed to reinstate employee", "error");
  }
}

// ==========================================
// NOTIFICATIONS
// ==========================================

async function loadNotifications() {
  const container =
    AppState.elements.notificationsContainer ||
    document.getElementById("notificationsList");
  if (!container) return;

  try {
    // No spinner here, caller manages
    const res = await apiRequest("/api/notifications/");
    if (!res.success) throw new Error(res.message);

    const list = res.data?.results || res.data || [];
    AppState.notifications = list;
    container.innerHTML = "";

    if (!list.length) {
      container.innerHTML = '<p class="text-muted">No notifications yet.</p>';
      return;
    }

    list.forEach((notification) => {
      const item = document.createElement("div");
      const type = notification?.type || "info";
      const createdAt = notification?.created_at
        ? new Date(notification.created_at).toLocaleString()
        : "";

      item.className = `notification ${type}`;
      item.innerHTML = `
                <strong>${escapeHtml(type.charAt(0).toUpperCase() + type.slice(1))}</strong>
                <p>${escapeHtml(notification?.message || "")}</p>
                ${createdAt ? `<div class="time text-muted">${escapeHtml(createdAt)}</div>` : ""}
            `;
      container.appendChild(item);
    });
  } catch (err) {
    container.innerHTML =
      '<p class="text-danger">Failed to load notifications.</p>';
    showToast(`Failed to load notifications: ${err.message}`, "error");
    // No hideLoading here, as it's part of loadDashboard or another context
  }
}

async function markAllNotificationsAsRead() {
  showLoading(); // Global spinner
  try {
    const res = await apiRequest("/api/notifications/mark_all_read/", {
      method: "POST",
    });
    if (!res.success) throw new Error(res.message);
    await loadNotifications();
    showToast("All notifications marked as read", "success");
  } catch (err) {
    showToast(`Failed to update notifications: ${err.message}`, "error");
  } finally {
    hideLoading();
  } // Global spinner
}

// ==========================================
// MODAL FUNCTIONS
// ==========================================

function showIndividualPaymentModal() {
  populateEmployeeSelect("paymentEmployee");
  document.getElementById("paymentPreview").style.display = "none";
  openModal("individualPaymentModal");
}

function showBulkPaymentModal() {
  populateBulkTable();
  openModal("bulkPaymentModal");
}

function showAddEmployeeModal() {
  openModal("addEmployeeModal");
}

function showAddDeductionModal() {
  populateEmployeeSelect("deductionEmployee");
  openModal("addDeductionModal");
}

function showAddCompanyModal() {
  AppState.currentEditingCompanyId = null;
  const form = document.getElementById("addCompanyForm");
  if (form) form.reset();

  const title = document.getElementById("companyModalTitle");
  const btn = document.getElementById("saveCompanyBtn");
  if (title) title.textContent = "Add Company";
  if (btn) btn.textContent = "Save Company";

  populateCompanyGuards();
  openModal("addCompanyModal");
}

function showClockInModal() {
  openModal("clockInModal");
}

// ADDED: Show leave modal
function showLeaveModal() {
  openModal("leaveModal");
}

function showSackEmployeeModal(empId) {
  const emp = AppState.employees.find((e) => idsMatch(e.id, empId));
  if (!emp) {
    showToast("Employee not found", "error");
    return;
  }

  const idField = document.getElementById("sackEmployeeId");
  const nameField = document.getElementById("sackEmployeeName");
  const dateField = document.getElementById("sackDate");
  const reasonField = document.getElementById("sackReason");

  if (idField) idField.value = emp.id;
  if (nameField) nameField.value = emp.name;
  if (dateField) dateField.value = new Date().toISOString().split("T")[0];
  if (reasonField) reasonField.value = "";

  openModal("sackEmployeeModal");
}

let salaryChart = null;

async function renderSalaryChart(data = []) {
  const ctx = document.getElementById("salarySummaryChart")?.getContext("2d");
  if (!ctx) return;

  if (salaryChart) salaryChart.destroy();

  salaryChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map((d) => d.month),
      datasets: [
        {
          label: "Salary Expenditure (₦)",
          data: data.map((d) => d.amount),
          borderColor: "#117e62",
          backgroundColor: "rgba(17, 126, 98, 0.1)",
          fill: true,
          tension: 0.4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } },
    },
  });
}

async function updateDashboardStats() {
  const res = await apiRequest("/api/employees/dashboard_stats/");
  if (!res.success) {
    return;
  } // No spinner here, caller manages

  const stats = res.data;

  // Update Chart
  if (stats.salary_summary) renderSalaryChart(stats.salary_summary);

  const elements = {
    totalStaff: document.getElementById("totalStaff"),
    totalGuards: document.getElementById("totalGuards"),
    totalSelfRegistered: document.getElementById("totalSelfRegistered"),
    totalPayments: document.getElementById("totalPayments"),
    totalDeductions: document.getElementById("totalDeductions"),
    monthlyPayments: document.getElementById("monthlyPayments"),
  };

  if (elements.totalStaff)
    elements.totalStaff.textContent = (stats.total_staff || 0).toLocaleString();
  if (elements.totalGuards)
    elements.totalGuards.textContent = (
      stats.total_guards || 0
    ).toLocaleString();
  if (elements.totalSelfRegistered)
    elements.totalSelfRegistered.textContent = (
      stats.total_self_registered || 0
    ).toLocaleString();
  if (elements.totalPayments)
    elements.totalPayments.textContent = formatCurrency(
      stats.total_payments || 0,
    );
  if (elements.totalDeductions)
    elements.totalDeductions.textContent = formatCurrency(
      stats.total_deductions || 0,
    );
  if (elements.monthlyPayments)
    elements.monthlyPayments.textContent = formatCurrency(
      stats.total_payments || 0,
    );

  const pendingAlert = document.getElementById("pendingApprovalsAlert");
  if (pendingAlert) {
    if (stats.total_self_registered > 0) {
      pendingAlert.classList.remove("hidden");
      document.getElementById("pendingCount").textContent =
        stats.total_self_registered;
    } else {
      pendingAlert.classList.add("hidden");
    }
  }

  if (stats.attendance_today) {
    updateAttendanceStats(
      stats.attendance_today.present,
      stats.attendance_today.absent,
      stats.attendance_today.leave,
    );
  }

  updateRecentActivity(stats.recent_employees, stats.recent_payments);
}

async function syncPaymentsWithPaystack() {
  const btn = document.getElementById("syncPaymentsBtn");
  try {
    showLoading(btn);
    const res = await apiRequest("/api/payments/sync_processing_payments/", {
      method: "POST",
    }); // Button spinner
    if (res.success) {
      showToast(res.data.message, "success");
      await loadPaymentHistory();
      await updateDashboardStats();
    }
  } finally {
    hideLoading(btn);
  }
}

/**
 * Periodically check system health (Paystack connectivity)
 */
function initHealthPoller() {
  // Check every 2 minutes (no spinner for background task)
  setInterval(async () => {
    const res = await apiRequest("/health-check/");
    if (res.success) updateHealthStatusUI(res.data);
  }, 120000);
}

function updateHealthStatusUI(data) {
  const indicator = document.getElementById("paystackHealthIndicator");
  if (!indicator) return;

  const isHealthy = data.paystack_connection === "connected";
  indicator.className = `health-badge ${isHealthy ? "healthy" : "degraded"}`;
  indicator.innerHTML = `
        <i class="fas fa-circle"></i> 
        Paystack: ${data.paystack_connection.toUpperCase()} 
        ${data.queue.pending_transfers > 0 ? `(${data.queue.pending_transfers} in queue)` : ""}
    `;
}

async function initiatePartialPayment(empId) {
  const amount = prompt(
    "Enter available amount to pay (Leave blank for full amount):",
  );
  const res = await apiRequest("/api/payments/initiate_payment/", {
    // No spinner here, caller manages
    method: "POST",
    body: { employee_id: empId, custom_amount: amount },
  });
  if (res.success) {
    showToast(
      `Partial payment of ${formatCurrency(amount)} initiated`,
      "success",
    );
    loadPaymentHistory();
  }
}
function updateRecentActivity(recentEmployees = [], recentPayments = []) {
  const container = document.getElementById("recentActivityList");
  if (!container) return;

  const activities = [];

  recentEmployees.forEach((e) => {
    activities.push({
      text: `${formatEmployeeType(e.type)} added: ${e.name}`,
      date: formatDate(e.created_at),
      type: "success",
    });
  });

  recentPayments.forEach((p) => {
    activities.push({
      text: `Payment ${p.status}: ${p.employee_name || "Unknown"}`,
      date: formatDate(p.payment_date),
      type: p.status === "completed" ? "success" : "warning",
    });
  });

  if (!activities.length) {
    container.innerHTML = '<p class="text-muted">No recent activity</p>';
    return;
  }

  container.innerHTML = activities
    .map(
      (act) => `
        <div class="activity-item ${act.type}">
            <span class="activity-text">${escapeHtml(act.text)}</span>
            <span class="activity-date">${act.date}</span>
        </div>
    `,
    )
    .join("");
}

function updateUIAfterEmployeeLoad() {
  [
    "clockEmployee",
    "deductionEmployee",
    "paymentEmployee",
    "payslipEmployee",
    "leaveEmployee",
  ].forEach((id) => {
    populateEmployeeSelect(id);
  });
  updateDashboardStats();
}

async function fetchPaystackBalance() {
  const res = await apiRequest("/api/payments/paystack_balance/");
  const balanceEl = document.getElementById("paystackWalletBalance"); // No spinner here, caller manages
  if (res.success && balanceEl) {
    balanceEl.textContent = `Balance: ${res.data.balance_formatted}`;
    balanceEl.classList.toggle("text-danger", res.data.balance < 1000); // Highlight if low
  }
}

function populateEmployeeSelect(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;

  const currentValue = select.value;
  select.innerHTML = '<option value="">Select Employee</option>';

  AppState.employees.forEach((emp) => {
    const option = document.createElement("option");
    option.value = emp.id;
    option.textContent = `${escapeHtml(emp.name)} (${escapeHtml(emp.employee_id || "No ID")})`;
    select.appendChild(option);
  });

  if (
    currentValue &&
    AppState.employees.find((e) => idsMatch(e.id, currentValue))
  ) {
    select.value = currentValue;
  }
}

function populateCompanyGuards() {
  const container = document.getElementById("companyAssignedGuardsContainer");
  const select = document.getElementById("companyAssignedGuards");

  if (!container) return;

  container.innerHTML = "";

  if (!AppState.employees.length) {
    container.innerHTML =
      '<p class="text-muted">No employees available. Add guards first.</p>';
    return;
  }

  const guards = AppState.employees.filter((emp) => emp.type === "guard");

  if (!guards.length) {
    container.innerHTML =
      '<p class="text-muted">No guards found. Create guard accounts first.</p>';
    return;
  }

  guards.forEach((emp) => {
    const div = document.createElement("div");
    div.className = "guard-checkbox-item";
    div.innerHTML = `
            <label class="checkbox-label">
                <input type="checkbox" name="assigned_guards" value="${emp.id}" class="guard-checkbox">
                <span>${escapeHtml(emp.name)} (${escapeHtml(emp.employee_id || "No ID")})</span>
            </label>
        `;
    container.appendChild(div);
  });

  if (select) {
    select.innerHTML = "";
    select.style.display = "none";
    guards.forEach((emp) => {
      const option = document.createElement("option");
      option.value = emp.id;
      option.textContent = emp.name;
      select.appendChild(option);
    });
  }
}

// FIXED: Proper bulk table with correct columns and event listeners
function populateBulkTable() {
  const tbody = document.getElementById("bulkPaymentTableBody");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!AppState.employees.length) {
    tbody.innerHTML =
      '<tr><td colspan="9" class="text-center">No employees available</td></tr>';
    return;
  }

  const activeEmployees = AppState.employees.filter(
    (e) => e.status === "active" || !e.status,
  );
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

  activeEmployees.forEach((emp) => {
    // Find if a payment exists for this employee in the current month
    const monthlyPayment = (AppState.payments || []).find(
      (p) => idsMatch(p.employee, emp.id) && p.payment_month === currentMonth,
    );
    const baseSalary = Number(emp.salary || 0);
    const netSalary =
      emp.net_salary != null && Number.isFinite(Number(emp.net_salary))
        ? Number(emp.net_salary)
        : baseSalary;

    const row = document.createElement("tr");
    row.innerHTML = `
            <td><input type="checkbox" value="${emp.id}" onchange="updateBulkTotal()"></td>
            <td>${escapeHtml(emp.employee_id || "-")}</td>
            <td>${escapeHtml(emp.name)}</td>
            <td>${escapeHtml(emp.bank_name || "-")} - ${escapeHtml(emp.account_number || "-")}</td>
            <td>${formatCurrency(netSalary)}</td>
        `;
    tbody.appendChild(row);
  });

  updateBulkTotal();
}

function populatePaymentsTable() {
  const tbody = document.getElementById("paymentsTableBody");
  if (!tbody) return;

  tbody.innerHTML = "";

  if (!AppState.employees.length) {
    tbody.innerHTML =
      '<tr><td colspan="9" class="text-center">No employees available</td></tr>';
    return;
  }

  const activeEmployees = AppState.employees.filter(
    (e) => e.status === "active" || !e.status,
  );
  const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM

  activeEmployees.forEach((emp) => {
    // Find if a payment exists for this employee in the current month
    const monthlyPayment = (AppState.payments || []).find(
      (p) => idsMatch(p.employee, emp.id) && p.payment_month === currentMonth,
    );
    const baseSalary = Number(emp.salary || 0);
    const netSalary =
      emp.net_salary !== null &&
      emp.net_salary !== undefined &&
      Number.isFinite(Number(emp.net_salary))
        ? Number(emp.net_salary)
        : baseSalary;
    const deductions = Number.isFinite(Number(emp.applied_deductions))
      ? Number(emp.applied_deductions)
      : Math.max(baseSalary - netSalary, 0);

    let statusBadge = '<span class="badge bg-secondary">Not Paid</span>';
    let actionBtn = `<button type="button" class="btn btn-sm btn-success" onclick="initiateIndividualPayment('${emp.id}')">Pay</button>`;

    if (monthlyPayment) {
      const s = monthlyPayment.status;
      const statusClass =
        s === "completed"
          ? "bg-success"
          : s === "failed"
            ? "bg-danger"
            : "bg-warning";
      statusBadge = `<span class="badge ${statusClass}">${s.toUpperCase()}</span>`;

      if (s === "completed") {
        actionBtn =
          '<span class="text-success"><i class="fas fa-check-circle"></i> Paid</span>';
      } else if (s === "processing" || s === "pending") {
        actionBtn = `<button type="button" class="btn btn-sm btn-info" onclick="retryPayment('${monthlyPayment.transaction_reference}')">Checking...</button>`;
      }
    }

    const row = document.createElement("tr");
    row.innerHTML = `
            <td><input type="checkbox" value="${emp.id}" class="payment-checkbox" onchange="updatePaymentSelection()"></td>
            <td>${escapeHtml(emp.employee_id || "-")}</td>
            <td>${escapeHtml(emp.name)}</td>
            <td>${escapeHtml(emp.bank_name || "-")} - ${escapeHtml(emp.account_number || "-")}</td>
            <td>${formatCurrency(baseSalary)}</td>
            <td>${formatCurrency(deductions)}</td>
            <td>${formatCurrency(netSalary)}</td>
            <td>${statusBadge}</td>
            <td>${actionBtn}</td>
        `;
    tbody.appendChild(row);
  });
}

function updatePaymentSelection() {
  const checkboxes = document.querySelectorAll(".payment-checkbox:checked");
  const selectedCount = checkboxes.length;
  // Update any UI elements that show selected count if needed
  console.log(`Selected ${selectedCount} employees for payment`);
}

function toggleAllPayments() {
  const selectAllCheckbox = document.getElementById("selectAllPayments");
  const checkboxes = document.querySelectorAll(".payment-checkbox");
  checkboxes.forEach((cb) => (cb.checked = selectAllCheckbox.checked));
  updatePaymentSelection();
}

function toggleAllEmployees() {
  const selectAllCheckbox = document.getElementById("selectAllEmployees");
  const checkboxes = document.querySelectorAll(".employee-checkbox");
  checkboxes.forEach((cb) => (cb.checked = selectAllCheckbox?.checked));
}

// ==========================================
// OTP MODAL
// ==========================================

function showOTPModal(
  title = "Authorize Internal Payment",
  message = "A security verification code has been sent to your email. Please enter it to authorize this payment initiation.",
) {
  const modal = document.getElementById("otpModal");
  const input = document.getElementById("otpInput");
  const otpTitle = document.getElementById("otpModalTitle");
  const otpMessage = document.getElementById("otpModalMessage");

  if (otpTitle) otpTitle.textContent = title;
  if (otpMessage) otpMessage.textContent = message;

  if (modal) modal.classList.add("active");
  if (input) input.value = "";
  startOtpCountdown();
}

function startOtpCountdown() {
  const timerEl = document.getElementById("otpTimer"); // Fixed: Ensure timer element exists
  const verifyBtn = document.querySelector("#otpModal .btn-primary"); // Fixed: Ensure verify button exists
  const resendBtn = document.getElementById("resendOtpBtn"); // Fixed: Ensure resend button exists

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
      showToast("OTP expired. You can resend now.", "warning");
    }
  }, 1000);
}

async function verifyOTP(e, isPaystackOtp = false) {
  // Fixed: Pass event object
  const otp = document.getElementById("otpInput")?.value.trim();
  if (!otp || !AppState.currentPaymentReference) {
    showToast("OTP or reference missing", "warning");
    return;
  }

  const endpoint = isPaystackOtp
    ? "/api/payments/finalize_paystack_transfer/"
    : "/api/payments/verify_payment/";
  const body = isPaystackOtp
    ? { reference: AppState.currentPaymentReference, paystack_otp: otp }
    : { reference: AppState.currentPaymentReference, otp: otp };

  const btn = document.querySelector("#otpModal .btn-primary");
  if (e) e.preventDefault(); // Fixed: Prevent default form submission

  try {
    showLoading(btn);

    const res = await apiRequest(endpoint, {
      method: "POST",
      body: body, // Fixed: Ensure body is passed
    });

    if (res.success) {
      if (res.data?.paystack_otp_required) {
        // Transition to Paystack OTP verification
        showOTPModal(
          "Paystack Transfer Authorization",
          "This transfer requires a second-level authorization from Paystack. Please enter the OTP sent to your registered business phone or email.",
        );

        const otpForm = document.getElementById("otpForm");
        if (otpForm) {
          // Remove old listener and attach Paystack-specific one
          const newForm = otpForm.cloneNode(true);
          otpForm.parentNode.replaceChild(newForm, otpForm);
          newForm.addEventListener("submit", (e) => {
            e.preventDefault();
            verifyOTP(e, true);
          });
        }
        return;
      }

      showToast(
        res.data?.message || "Payment verified successfully",
        "success",
      );
      closeModal("otpModal");
      closeModal("individualPaymentModal"); // Fixed: Close individual payment modal
      await loadPaymentHistory();
      await updateDashboardStats();
    } else {
      showToast(res.message || "Verification failed", "error");
    }
  } catch (err) {
    showToast("OTP verification failed", "error");
  } finally {
    hideLoading(btn); // Fixed: Hide loading in finally block
  }
}

async function resendOTP() {
  // INTERNAL OTP FLOW REMOVED (no longer used for initiating/authorizing transfers)
  showToast(
    "Resend OTP is disabled. Payments are verified via Paystack confirmation.",
    "warning",
  );
}

// ADDED: Function to handle password change submission
async function handleChangePassword(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');

  const oldPassword = document.getElementById("oldPassword")?.value;
  const newPassword = document.getElementById("newPassword")?.value;
  const confirmPassword = document.getElementById("confirmPassword")?.value;

  if (!oldPassword || !newPassword || !confirmPassword) {
    showToast("All password fields are required", "error");
    return;
  }

  if (newPassword !== confirmPassword) {
    showToast("New passwords do not match", "error");
    return;
  }

  if (newPassword.length < 8) {
    showToast("New password must be at least 8 characters long", "error");
    return;
  }

  try {
    showLoading(btn);
    const res = await apiRequest("/change-password/", {
      method: "POST",
      body: {
        old_password: oldPassword,
        new_password: newPassword,
        confirm_password: confirmPassword,
      },
    });

    if (!res.success) throw new Error(res.message);

    showToast(
      res.data?.message ||
        "Password changed successfully. Please log in again.",
      "success",
    );
    closeModal("changePasswordModal");
    setTimeout(() => logout(), 1200);
  } catch (err) {
    showToast(err.message || "Failed to change password", "error");
  } finally {
    hideLoading(btn);
  }
}

// ==========================================
// PAYSIPS
// ==========================================

async function generatePayslip() {
  const employeeId = document.getElementById("payslipEmployee")?.value;
  const month = document.getElementById("payslipMonth")?.value;

  if (!employeeId || !month) {
    showToast("Please select employee and month", "warning");
    return;
  }

  const btn = document.querySelector(
    '#payslips button[onclick="generatePayslip()"]',
  );

  try {
    showLoading(btn); // Button spinner

    const res = await apiRequest("/api/payments/generate_payslip/", {
      method: "POST",
      body: { employee_id: employeeId, month },
    });

    if (!res.success) throw new Error(res.message);

    const preview = document.getElementById("payslipPreview");
    if (preview && res.data?.payslip_html) {
      preview.innerHTML = res.data.payslip_html;

      const downloadBtn = document.createElement("button");
      downloadBtn.className = "btn btn-success mt-3";
      downloadBtn.innerHTML = '<i class="fas fa-download"></i> Download PDF';
      downloadBtn.onclick = () =>
        downloadPayslip(res.data.payslip_html, employeeId, month);
      preview.appendChild(downloadBtn);
    }

    showToast("Payslip generated successfully", "success");
  } catch (err) {
    showToast(err.message || "Failed to generate payslip", "error");
  } finally {
    hideLoading(btn); // Button spinner
  }
}

async function downloadPayslip(html, employeeId, month) {
  // Server-side PDF generation (ReportLab) to avoid blank/white PDF issues
  // caused by client-side html2pdf/html2canvas rendering.
  try {
    // Re-use existing export password modal if present.
    // If password is missing, backend will reject with 401.
    const exportPassword = document.getElementById("exportPassword")?.value || "";

    const tokenRes = await apiRequest(
      "/api/payments/request_payslip_export/",
      {
        method: "POST",
        body: {
          password: exportPassword,
          employee_id: employeeId,
          month: month,
        },
      },
    );

    if (!tokenRes.success) throw new Error(tokenRes.message);

    const downloadToken = tokenRes.data?.token;
    if (!downloadToken) throw new Error("Missing export token");

    await triggerSecureDownload(
      "/api/payments/download_payslip_pdf/",
      downloadToken,
      `payslip_${employeeId}_${month}.pdf`,
      { method: "GET" },
    );

    showToast("Payslip downloaded successfully", "success");
  } catch (err) {
    console.error("Payslip download error:", err);
    showToast("Failed to download payslip PDF: " + (err.message || err), "error");
  }
}

// function downloadPayslip(html, employeeId, month) {
//     // Show password modal for payslip download
//     const passwordModal = document.getElementById('exportPasswordModal');
//     if (passwordModal) {
//         // Store the HTML temporarily for after password verification
//         passwordModal.dataset.pendingPayslipHtml = html;
//         passwordModal.dataset.exportType = 'payslip';
//         passwordModal.dataset.employeeId = employeeId;
//         passwordModal.dataset.month = month;
//         openModal('exportPasswordModal');
//     } else {
//         // Fallback if modal doesn't exist
//         const element = document.createElement('div');
//         element.innerHTML = html;
//         element.style.padding = '20px';
//         document.body.appendChild(element);

//         const opt = {
//             margin: 1,
//             filename: `payslip_${employeeId}_${month}.pdf`,
//             image: { type: 'jpeg', quality: 0.98 },
//             html2canvas: { scale: 2 },
//             jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
//         };

//         html2pdf().set(opt).from(element).save().then(() => {
//             element.remove();
//         });
//     }
// }

// ADDED: Print payslip
function printPayslip() {
  const preview = document.getElementById("payslipPreview");
  if (!preview || !preview.innerHTML.trim()) {
    showToast("Generate a payslip first", "warning");
    return;
  }

  const printWindow = window.open("", "_blank");
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
  const modal = document.getElementById("exportPasswordModal");
  if (modal) {
    modal.dataset.exportType = "employees";
    // Populate username for password manager autofill
    const usernameInput = document.getElementById("exportUsername");
    if (usernameInput)
      usernameInput.value = AppState.currentUser?.username || "";
  }
  openModal("exportPasswordModal");
}

function exportPaymentHistory() {
  const modal = document.getElementById("exportPasswordModal");
  if (modal) {
    modal.dataset.exportType = "payments";
    // Populate username for password manager autofill
    const usernameInput = document.getElementById("exportUsername");
    if (usernameInput)
      usernameInput.value = AppState.currentUser?.username || "";
  }
  openModal("exportPasswordModal");
}

// REPLACE the existing triggerSecureDownload function
async function triggerSecureDownload(url, token, filename, { method = null } = {}) {
  try {
    showLoading(null, AppState.elements.globalSpinner);
    const accessToken =
      AppState.accessToken || localStorage.getItem("accessToken");

    // Employees + payments CSV endpoints expect `token` as a query param (GET action).
    // Payslip/receipt PDF endpoints also expect `token` as a query param.
    const finalMethod = method || "GET";

    let fullUrl = `${window.location.origin}${url}`;
    if (finalMethod.toUpperCase() === "GET") {
      fullUrl = `${fullUrl}${fullUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    }

    const response = await fetch(fullUrl, {
      method: finalMethod,
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      ...(finalMethod.toUpperCase() === "POST"
        ? { body: JSON.stringify({ token: token }) }
        : {}),
    });

    if (!response.ok) {
      const errorData = await response
        .json()
        .catch(() => ({}));
      throw new Error(
        errorData.detail ||
          errorData.error ||
          errorData.message ||
          `Export failed (${response.status})`,
      );
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(downloadUrl);
    a.remove();
    showToast("Download started successfully", "success");
  } catch (err) {
    console.error("Download error:", err);
    showToast("Download Error: " + err.message, "error");
    throw err; // Re-throw so caller knows it failed
  } finally {
    hideLoading(null, AppState.elements.globalSpinner);
  }
}

// REPLACE the existing finishDownload function
async function finishDownload(token, type, modal, url, downloadFilename) {
  // FIXED: Explicit endpoints - ensure these match your Django URL patterns exactly
  const downloadEndpoints = {
    payslip: "/api/payments/download_payslip_pdf/",
    receipt: "/api/payments/download_receipt_pdf/",
    payments: "/api/payments/export_csv/",
    employees: "/api/employees/export_csv/"
  };
  
  const downloadEndpoint = downloadEndpoints[type];
  if (!downloadEndpoint) {
    showToast(`Unknown export type: ${type}`, "error");
    return;
  }

  try {
    await triggerSecureDownload(downloadEndpoint, token, downloadFilename);
    closeModal("exportPasswordModal");
    // Clear the form
    const form = document.getElementById("exportPasswordForm");
    if (form) form.reset();
  } catch (err) {
    // Error already shown in triggerSecureDownload
    console.error("finishDownload failed:", err);
  }
}

// REPLACE the existing confirmExport function
async function confirmExport() {
  const password = document.getElementById("exportPassword")?.value;
  const modal = document.getElementById("exportPasswordModal");
  const type = modal?.dataset.exportType;

  if (!password) {
    showToast("Password is required", "warning");
    return;
  }

  if (!type) {
    showToast("Export type not specified", "error");
    return;
  }

  let url = type === "payments" ? "/api/payments/request_export/" : "/api/employees/request_export/";
  let payload = { password };
  let downloadFilename = type === "payments" ? "payment_history.csv" : "employees.csv";

  if (type === "payslip") {
    url = "/api/payments/request_payslip_export/";
    payload.employee_id = modal.dataset.employeeId;
    payload.month = modal.dataset.month;
    downloadFilename = `payslip_${modal.dataset.month}.pdf`;
  } else if (type === "receipt") {
    url = `/api/payments/${modal.dataset.paymentId}/request_receipt_export/`;
    downloadFilename = `receipt_${(modal.dataset.paymentId || "").slice(0, 8)}.pdf`;
  }

  const btn = modal?.querySelector('button[type="submit"]');
  
  try {
    showLoading(btn);
    
    const res = await apiRequest(url, { method: "POST", body: payload });

    if (!res.success) {
      showToast(res.message || "Verification failed", "error");
      return; // hideLoading called in finally
    }

    // Handle 2FA if required
    if (res.data && res.data["2fa_required"]) {
      const otp = prompt("A verification code has been sent to your email. Enter it to continue:");
      if (!otp) return; // User cancelled

      const vRes = await apiRequest("/api/employees/verify_2fa/", {
        method: "POST",
        body: { token: res.data.token, otp },
      });

      if (!vRes.success) {
        showToast("Invalid 2FA code", "error");
        return;
      }

      await finishDownload(res.data.token, type, modal, url, downloadFilename);
      return;
    }

    // No 2FA required
    await finishDownload(res.data.token, type, modal, url, downloadFilename);
    
  } catch (err) {
    console.error("confirmExport error:", err);
    showToast(err.message || "Export failed unexpectedly", "error");
  } finally {
    hideLoading(btn);
    // Clear password field for security
    const pwdField = document.getElementById("exportPassword");
    if (pwdField) pwdField.value = "";
  }
}

// async function confirmExport() {
//   const password = document.getElementById("exportPassword")?.value;
//   const modal = document.getElementById("exportPasswordModal");
//   const type = modal?.dataset.exportType;

//   if (!password) {
//     showToast("Password is required", "warning");
//     return;
//   }

//   let url =
//     type === "payments"
//       ? "/api/payments/request_export/"
//       : "/api/employees/request_export/";
//   let payload = { password };
//   let downloadFilename =
//     type === "payments" ? "payment_history.csv" : "employees.csv";

//   if (type === "payslip") {
//     url = "/api/payments/request_payslip_export/";
//     payload.employee_id = modal.dataset.employeeId;
//     payload.month = modal.dataset.month;
//     downloadFilename = `payslip_${modal.dataset.month}.pdf`;
//   } else if (type === "receipt") {
//     url = `/api/payments/${modal.dataset.paymentId}/request_receipt_export/`;
//     downloadFilename = `receipt_${modal.dataset.paymentId.slice(0, 8)}.pdf`;
//   }

//   // Disable all buttons inside the modal while downloading to avoid double submits
//   const btn =
//     modal?.querySelector('button[type="submit"], .btn-primary') ||
//     document.getElementById("confirmExportBtn");
//   try {
//     showLoading(btn);
//     const res = await apiRequest(url, { method: "POST", body: payload }); // Button spinner

//     if (!res.success) {
//       showToast(res.message || "Verification failed", "error");
//       return;
//     }

//     // 2FA required only for the token-based employee export flow
//     if (res.data && res.data["2fa_required"]) {
//       const otp = prompt(
//         "A verification code has been sent to your email. Enter it to continue:",
//       );
//       if (!otp) return;

//       const vRes = await apiRequest("/api/employees/verify_2fa/", {
//         method: "POST",
//         body: { token: res.data.token, otp },
//       });

//       if (!vRes.success) {
//         showToast("Invalid 2FA code", "error");
//         return;
//       }

//       await finishDownload(res.data.token, type, modal, url, downloadFilename);
//       return;
//     }

//     // No 2FA for payslips/receipts/payments exports
//     await finishDownload(res.data.token, type, modal, url, downloadFilename);
//   } finally {
//     hideLoading(btn);
//   }
// }

// async function finishDownload(token, type, modal, url, downloadFilename) {
//   // Explicit endpoints to avoid silent failures from URL string replacement mismatches.
//   const downloadEndpoint =
//     type === "payslip"
//       ? "/api/payments/download_payslip_pdf/"
//       : type === "receipt"
//         ? "/api/payments/download_receipt_pdf/"
//         : type === "payments"
//           ? "/api/payments/export_csv/"
//           : "/api/employees/export_csv/";

//   await triggerSecureDownload(downloadEndpoint, token, downloadFilename);
//   showToast("Download started", "success");
//   closeModal("exportPasswordModal");
// }

// ==========================================
// FILTER FUNCTIONS
// ==========================================

function filterHistory() {
  const search = document.getElementById("historySearch")?.value.toLowerCase();
  const fromDate = document.getElementById("historyDateFrom")?.value;
  const toDate = document.getElementById("historyDateTo")?.value;

  let filtered = AppState.payments || [];

  if (search) {
    filtered = filtered.filter(
      (p) =>
        (p.employee_name || "").toLowerCase().includes(search) ||
        (p.employee_id || "").toLowerCase().includes(search),
    );
  }

  if (fromDate) {
    filtered = filtered.filter((p) => p.payment_date >= fromDate);
  }

  if (toDate) {
    filtered = filtered.filter((p) => p.payment_date <= toDate);
  }

  // Re-render with filtered data
  const tbody = document.getElementById("historyTableBody");
  if (!tbody) return;

  tbody.innerHTML = "";
  if (!filtered.length) {
    tbody.innerHTML =
      '<tr><td colspan="12" class="text-center">No companies found</td></tr>';
    return;
  }

  filtered.forEach((payment) => {
    const row = document.createElement("tr");
    row.innerHTML = `
            <td>${escapeHtml(payment.payment_date || "-")}</td>
            <td>${escapeHtml(payment.employee_id || "-")}</td>
            <td>${escapeHtml(payment.employee_name || "-")}</td>
            <td>${escapeHtml(payment.bank_account || "-")}</td>
            <td>${formatCurrency(payment.net_amount)}</td>
            <td>${escapeHtml(payment.payment_method || "Paystack")}</td>
            <td>${escapeHtml(payment.status || "-")}</td>
            <td>-</td>
        `;
    tbody.appendChild(row);
  });

  showToast(`Showing ${filtered.length} records`, "info");
}

function toggleAllBulkPayments() {
  const selectAll = document.getElementById("selectAllBulk")?.checked;
  const checkboxes = document.querySelectorAll(
    '#bulkPaymentModal tbody input[type="checkbox"]',
  );
  checkboxes.forEach((cb) => (cb.checked = selectAll));
  updateBulkTotal();
}

// ==========================================
// EMPLOYEE ID GENERATION - FIXED
// ==========================================

function setupEmployeeIdGeneration() {
  const typeSelect = document.getElementById("accountType");
  const nameInput = document.getElementById("accountName");
  const displayEl = document.getElementById("generatedEmployeeId");
  const form = document.getElementById("createAccountForm");
  const passwordInput = document.getElementById("accountPassword");

  if (passwordInput) {
    passwordInput.addEventListener("input", (e) =>
      updatePasswordUI(e.target.value),
    );
  }

  const generateId = async () => {
    const type = typeSelect?.value;
    const name = nameInput?.value?.trim();

    if (!type || !name) {
      if (displayEl) {
        displayEl.textContent = "-";
        displayEl.style.color = "#007bff";
      }
      const hiddenInput = document.getElementById("generatedEmployeeIdInput");
      if (hiddenInput) hiddenInput.value = "";
      return;
    }

    // Show loading state
    if (displayEl) displayEl.textContent = "Generating...";

    const nextId = await fetchNextEmployeeId(type);

    if (displayEl) {
      displayEl.textContent = nextId || "Will be assigned on create";
      displayEl.style.color = nextId ? "#28a745" : "#6c757d";
    }

    // Update hidden input
    let hiddenInput = document.getElementById("generatedEmployeeIdInput");
    if (!hiddenInput) {
        hiddenInput = document.createElement("input");
        hiddenInput.type = "hidden";
        hiddenInput.id = "generatedEmployeeIdInput";
        hiddenInput.name = "employee_id";
        const form = document.getElementById("createAccountForm");
        if (form) form.appendChild(hiddenInput);
    }
    if (hiddenInput) hiddenInput.value = nextId || "";
  };

  if (typeSelect) typeSelect.addEventListener("change", generateId);
  if (nameInput) {
    nameInput.addEventListener("blur", generateId);
    nameInput.addEventListener("input", debounce(generateId, 800));
  }
  form?.addEventListener("reset", () => {
    setTimeout(() => {
      if (displayEl) {
        displayEl.textContent = "-";
        displayEl.style.color = "#007bff";
      }
      const hiddenInput = document.getElementById("generatedEmployeeIdInput");
      if (hiddenInput) hiddenInput.value = "";
    }, 0);
  });
}

// ==========================================
// EVENT LISTENERS & SETUP
// ==========================================

function initEmployeeSearch() {
  const searchInput = document.getElementById("employeeSearch");
  const typeFilter = document.getElementById("employeeTypeFilter");

  const filterEmployees = () => {
    // Fixed: Debounce filterEmployees
    const query = searchInput?.value.toLowerCase() || "";
    const type = typeFilter?.value || "all";

    let filtered = AppState.employees;

    if (type !== "all") {
      filtered = filtered.filter((emp) => emp.type === type);
    }

    if (query) {
      filtered = filtered.filter(
        (emp) =>
          (emp.name || "").toLowerCase().includes(query) ||
          (emp.employee_id || "").toLowerCase().includes(query) ||
          (emp.location || "").toLowerCase().includes(query),
      );
    }

    renderEmployees(filtered);
  };

  if (searchInput)
    searchInput.addEventListener("input", debounce(filterEmployees, 300)); // Fixed: Debounce search input
  if (typeFilter) typeFilter.addEventListener("change", filterEmployees);
}

function setupBankCodeTracking() {
  const bankSelects = [
    document.getElementById("accountBankName"),
    document.getElementById("newEmployeeBankName"),
  ];

  bankSelects.forEach((select) => {
    if (!select) return;
    select.addEventListener("change", () => {
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
  setupBankCodeTracking(); // Fixed: Ensure bank code tracking is set up
  setupBankVerification();
  document
    .getElementById("verifyAccountBtn")
    ?.addEventListener("click", verifyBankAccountManual);

  // Bulk Approval "Check All" Listener
  // document.getElementById('selectAllEmployees')?.addEventListener('change', toggleAllEmployees);

  // Bulk Actions Listeners
  document
    .getElementById("bulkApproveDeductionsBtn")
    ?.addEventListener("click", bulkApproveDeductions);
  document
    .getElementById("bulkApproveEmployeesBtn")
    ?.addEventListener("click", bulkApproveEmployees);
  document.getElementById("resendOtpBtn")?.addEventListener("click", resendOTP);
  document
    .getElementById("otpForm")
    ?.addEventListener("submit", (e) => verifyOTP(e, false)); // Fixed: Add event listener for internal OTP form
  // Hamburger menu
  const hamburger = document.getElementById("hamburgerBtn");
  const sidebar = document.getElementById("sidebar");

  if (hamburger && sidebar) {
    hamburger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      sidebar.classList.toggle("active");
    });

    document.addEventListener("click", (e) => {
      if (
        window.innerWidth <= 768 &&
        sidebar.classList.contains("active") &&
        !sidebar.contains(e.target) &&
        !hamburger.contains(e.target)
      ) {
        sidebar.classList.remove("active");
      }
    });
  }

  // Form submissions
  const forms = [
    { id: "loginForm", handler: handleLogin },
    { id: "clockInForm", handler: handleClockIn },
    { id: "individualPaymentForm", handler: handleIndividualPaymentSubmit },
    { id: "sackEmployeeForm", handler: handleSackEmployee }, // Fixed: Add event listener for sack employee form
    { id: "addCompanyForm", handler: handleCreateCompany },
    { id: "addDeductionForm", handler: addDeduction },
    { id: "editDeductionForm", handler: updateDeduction },
    { id: "addEmployeeForm", handler: handleCreateEmployee },
    { id: "createAccountForm", handler: (e) => handleRegistration(e, false) },
    { id: "changePasswordForm", handler: handleChangePassword }, // ADDED
    { id: "forgotPasswordForm", handler: submitForgotPassword },
    { id: "resetPasswordForm", handler: handleResetPassword },
    { id: "leaveForm", handler: handleMarkLeave }, // ADDED
    { id: "requestForm", handler: handleCreateRequest },
    // FIX: Ensure export confirm submit actually triggers confirmExport()
    { id: "exportPasswordForm", handler: confirmExport },
  ];
  document.getElementById("selfSignupForm")?.addEventListener("submit", handleSelfSignup);

  forms.forEach(({ id, handler }) => {
    const form = document.getElementById(id);
    if (!form) return;

    // DEBUG/SAFETY: ensure confirmExport handlers are correctly invoked.
    form.addEventListener("submit", (e) => {
      try {
        handler(e);
      } catch (err) {
        console.error(`Submit handler failed for #${id}:`, err);
        showToast(err.message || "Export failed", "error");
      }
    });
  });
}

/** Select or deselect all employee checkboxes for bulk approval */
function toggleAllEmployees() {
  const selectAllCheckbox = document.getElementById("selectAllEmployees");
  const checkboxes = document.querySelectorAll(".employee-checkbox");
  checkboxes.forEach((cb) => (cb.checked = selectAllCheckbox?.checked));
}
// ==========================================
// DASHBOARD & INITIALIZATION
// ==========================================

async function loadRequests() {
  const tbody = document.getElementById("requestsTableBody");
  if (!tbody) return;

  const renderGallery = (attachments, type) => {
    if (!attachments || !attachments.length) return "-";
    const filtered = attachments.filter((a) => a.file_type === type);
    if (!filtered.length) return "-";
    return `<div class="attachment-gallery" style="display: flex; gap: 4px; flex-wrap: wrap;">
            ${filtered
              .map(
                (a) => `
                <img src="${a.file}" 
                     style="width: 35px; height: 35px; object-fit: cover; border-radius: 4px; border: 1px solid #ddd; cursor: pointer;" 
                     onclick="showImagePreview('${a.file}')">
            `,
              )
              .join("")}
        </div>`;
  };

  const res = await apiRequest("/api/requests/"); // No spinner here, caller manages
  if (res.success) {
    const list = res.data?.results || res.data || [];
    tbody.innerHTML = list.length
      ? ""
      : '<tr><td colspan="8">No requests found</td></tr>';
    list.forEach((req) => {
      const isAdmin =
        AppState.currentUser?.is_superuser ||
        AppState.currentUser?.is_request_admin;
      const hasAttachments = req.attachments && req.attachments.length > 0;

      const row = document.createElement("tr");
      row.innerHTML = `
                <td>${formatDate(req.created_at)}</td>
                <td>${escapeHtml(req.employee_name)}</td>
                <td>${escapeHtml(req.request_type)}</td>
                <td>${formatCurrency(req.amount)}</td>
                <td>${renderGallery(req.attachments, "proof")}</td>
                <td>${renderGallery(req.attachments, "receipt")}</td>
                <td><span class="badge status-${req.status}">${req.status}</span></td>
                <td>
                    ${
                      isAdmin && req.status === "pending"
                        ? `
                        <button class="btn btn-sm btn-success" onclick="approveRequest('${req.id}')">Approve</button>
                        <button class="btn btn-sm btn-danger" onclick="showDeclineModal('${req.id}')">Decline</button>
                    `
                        : "-"
                    }
                    ${
                      isAdmin && hasAttachments
                        ? `
                        <button class="btn btn-sm btn-outline-primary" title="Download ZIP" onclick="downloadRequestAttachments('${req.id}')">
                            <i class="fas fa-file-archive"></i>
                        </button>
                    `
                        : ""
                    }
                </td>
            `;
      tbody.appendChild(row);
    });
  }
  // No hideLoading here, as it's part of loadDashboard or another context
}

async function downloadRequestAttachments(requestId) {
  const password = prompt("Enter your login password to download attachments:");
  if (!password) return;

  showLoading(); // Global spinner
  try {
    const token = AppState.accessToken || localStorage.getItem("accessToken");
    const response = await fetch(
      `${window.location.origin}/api/requests/${requestId}/download_attachments/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ password }),
      },
    );

    if (!response.ok) throw new Error("Download failed");

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attachments_${requestId.slice(0, 8)}.zip`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
    showToast("Attachments downloaded successfully", "success");
  } catch (err) {
    showToast("Failed to download ZIP: " + err.message, "error");
  }
}

// ==========================================
// SELF SIGNUP
// ==========================================

function showSignupModal() {
  openModal("signup-modal");
}

let requestPhotoBlobs = [];

function updateCharCount(textarea) {
  const counter = document.getElementById("charCounter");
  if (counter)
    counter.textContent = `${textarea.value.length} / 500 characters`;
}

async function startRequestCamera() {
  const video = document.getElementById("reqVideo");
  const section = document.getElementById("requestCameraSection");
  if (section) section.style.display = "block";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    AppState.cameraStream = stream;
  } catch (err) {
    console.warn("Request camera failed");
  }
}

function captureRequestPhoto() {
  const video = document.getElementById("reqVideo");
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);

  canvas.toBlob(
    async (rawBlob) => {
      const compressedBlob = await compressImage(rawBlob);
      requestPhotoBlobs.push(compressedBlob);

      const previewContainer = document.getElementById("reqCapturedImage");
      const imgWrapper = document.createElement("div");
      imgWrapper.style.display = "inline-block";
      imgWrapper.style.position = "relative";
      imgWrapper.style.margin = "5px";

      imgWrapper.innerHTML = `
            <img src="${URL.createObjectURL(compressedBlob)}" style="width: 100px; height: 100px; object-fit: cover; border-radius: 4px;">
            <span style="position: absolute; top: 0; right: 0; background: red; color: white; border-radius: 50%; width: 20px; height: 20px; text-align: center; cursor: pointer; line-height: 20px;" onclick="this.parentElement.remove(); requestPhotoBlobs.splice(${requestPhotoBlobs.length - 1}, 1);">×</span>
        `;
      previewContainer.appendChild(imgWrapper);
    },
    "image/jpeg",
    0.8,
  );
}

function clearCapturedPhotos() {
  requestPhotoBlobs = [];
  document.getElementById("reqCapturedImage").innerHTML = "";
}

async function handleCreateRequest(e) {
  e.preventDefault();
  if (!confirm("Are you sure you want to submit this request?")) return;

  const btn = e.target.querySelector('button[type="submit"]');
  const formData = new FormData();
  formData.append("request_type", document.getElementById("reqType").value);

  const amount = document.getElementById("reqAmount").value;
  if (amount) formData.append("amount", amount);
  formData.append(
    "description",
    document.getElementById("reqDescription").value,
  );

  requestPhotoBlobs.forEach((blob, i) =>
    formData.append("proof_photos", blob, `proof_${i}.jpg`),
  );

  const receiptFiles = document.getElementById("reqReceipt").files;
  const compressedReceipts = await Promise.all(
    Array.from(receiptFiles).map((file) => compressImage(file)),
  );

  compressedReceipts.forEach((blob, i) => {
    formData.append("receipt_files", blob, `receipt_${i}.jpg`);
  });

  try {
    showLoading(btn); // Button spinner
    const res = await apiRequest("/api/requests/", {
      method: "POST",
      body: formData,
    });
    if (res.success) {
      showToast("Request and attachments submitted successfully", "success");
      closeModal("requestModal");
      clearCapturedPhotos();
      loadRequests();
    } else {
      showToast(res.message || "Failed to submit request", "error");
    }
  } finally {
    hideLoading(btn); // Button spinner
  }
}

async function approveRequest(id) {
  if (!confirm("Approve this request?")) return;

  showLoading(); // Global spinner
  try {
    const res = await apiRequest(`/api/requests/${id}/approve/`, {
      method: "POST",
    });
    if (res.success) {
      showToast("Approved");
      loadRequests();
    }
  } finally {
    hideLoading(); // Global spinner
  }
}

let pendingDeclineId = null;
function showDeclineModal(id) {
  pendingDeclineId = id;
  openModal("declineReasonModal");
}

async function submitDeclineRequest() {
  const reason = document.getElementById("declineReasonText").value;
  if (!reason) return showToast("Reason required", "warning");

  const btn = document.querySelector("#declineReasonModal button.btn-danger");
  try {
    showLoading(btn); // Button spinner
    const res = await apiRequest(`/api/requests/${pendingDeclineId}/decline/`, {
      method: "POST",
      body: { reason },
    });
    if (res.success) {
      showToast("Request declined successfully", "success");
      closeModal("declineReasonModal");
      document.getElementById("declineReasonText").value = "";
      loadRequests();
    } else {
      showToast(res.message || "Failed to decline request", "error");
    }
  } finally {
    hideLoading(btn); // Button spinner
  }
}

function showRequestModal() {
  openModal("requestModal");
}

async function loadDashboard() {
  if (!AppState.currentUser) {
    await loadCurrentUser();
  }
  if (!AppState.currentUser) return;

  showDashboardPage();
  applyRolePermissions(AppState.currentUser);

  let loadError = null;

  try {
    showLoading();
    try {
      // Step 1: Critical data (sequential)
      await loadEmployees();
      await loadDeductions();
      await loadRequests();

      // Step 2: Medium priority (parallel but limited)
      await Promise.all([
        loadAttendance(),
        loadSackedEmployees(),
        loadNotifications(),
      ]);

      // Step 3: Admin-only
      if (
        AppState.currentUser?.is_superuser ||
        AppState.currentUser?.role === "admin" ||
        AppState.currentUser?.is_company_admin
      ) {
        await loadCompanies();
      }

      // Step 4: Delay heavy endpoints
      if (
        AppState.currentUser?.is_superuser ||
        AppState.currentUser?.role === "admin"
      ) {
        setTimeout(loadPaymentHistory, 1500);
      }

      // Step 5: Non-critical
      setTimeout(loadNigerianBanks, 2000);
    } catch (innerErr) {
      loadError = innerErr;
      throw innerErr; // Re-throw so outer catch gets it
    } finally {
      // FIX: Wrap hideLoading so it NEVER throws
      try {
        hideLoading();
      } catch (hideErr) {
        console.error("hideLoading failed in finally:", hideErr);
      }
    }
  } catch (err) {
    console.error("Dashboard load error:", err);
    // Show user-facing error if critical data failed
    if (loadError) {
      showToast(
        "Dashboard failed to load fully. Some data may be missing.",
        "warning",
      );
    }
  }
}

function showLoginPage() {
  document.getElementById("dashboardPage")?.classList.add("hidden");
  document.getElementById("loginPage")?.classList.remove("hidden");
}

function showDashboardPage() {
  document.getElementById("loginPage")?.classList.add("hidden");
  document.getElementById("dashboardPage")?.classList.remove("hidden");
}

// ==========================================
// INITIALIZATION
// ==========================================

let AUTH_BOOTSTRAP_IN_FLIGHT = false;
let AUTH_BOOTSTRAP_DONE = false;

document.addEventListener("DOMContentLoaded", async () => {
  if (AUTH_BOOTSTRAP_DONE || AUTH_BOOTSTRAP_IN_FLIGHT) return;

  AUTH_BOOTSTRAP_IN_FLIGHT = true;
  try {
    console.log("DOM Content Loaded - Initializing Application");

    // Cache DOM elements
    AppState.elements.tbody = document.getElementById("employeeTableBody");
    AppState.elements.deductionsTbody = document.getElementById(
      "deductionsTableBody",
    );
    AppState.elements.attendanceTbody = document.getElementById(
      "attendanceTableBody",
    );
    AppState.elements.companiesTbody =
      document.getElementById("companiesTableBody");
    AppState.elements.sackedTbody = document.getElementById("sackedTableBody");
    AppState.elements.historyTbody =
      document.getElementById("historyTableBody");
    AppState.elements.notificationsContainer =
      document.getElementById("notificationsList");
    AppState.elements.toastContainer =
      document.getElementById("toastContainer");
    AppState.elements.globalSpinner = document.getElementById("globalSpinner");

    // FEATURE: Check for Reset Password link in URL immediately
    const urlParams = new URLSearchParams(window.location.search);
    if (
      urlParams.get("action") === "reset-password" &&
      urlParams.get("uid") &&
      urlParams.get("token")
    ) {
      openModal("resetPasswordModal");
    }

    const storedToken =
      localStorage.getItem("accessToken") ||
      sessionStorage.getItem("accessToken");
    const storedRefresh = localStorage.getItem("refreshToken");

    if (!storedToken) {
      console.log("No token found, showing login page");
      showLoginPage();
      setupEventListeners();
      return;
    }

    AppState.accessToken = storedToken;
    if (storedRefresh) AppState.refreshToken = storedRefresh;

    if (isJwtExpired(AppState.accessToken)) {
      // No spinner for internal token check
      console.log(
        "Stored access token expired, refreshing before verification...",
      );
      const refreshed = await refreshAccessToken();
      if (!refreshed) throw new Error("Cannot refresh token");
    }

    // Step 2: verify current user (at most 2 attempts total)
    console.log("Verifying token on page load...");
    const res = await apiRequest("/current-user/");

    if (res.success && res.data) {
      console.log("Token valid, loading dashboard");
      AppState.currentUser = res.data;
      await loadDashboard();
      initHealthPoller();
    } else {
      console.log("Token invalid, attempting refresh once...");
      const refreshed = await refreshAccessToken();
      if (!refreshed) throw new Error("Cannot refresh token");

      const retryRes = await apiRequest("/current-user/");
      if (retryRes.success && retryRes.data) {
        AppState.currentUser = retryRes.data;
        await loadDashboard();
      } else {
        throw new Error("Token refresh failed - user data missing");
      }
    }
  } catch (err) {
    console.error("Auth bootstrap failed:", err.message);
    // Clear local storage and show login without calling apiRequest recursively
    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
    AppState.accessToken = null;
    AppState.refreshToken = null;
    showLoginPage();
  } finally {
    // No hideLoading here, as it's the very first load
    AUTH_BOOTSTRAP_DONE = true;
    AUTH_BOOTSTRAP_IN_FLIGHT = false;
    setupEventListeners();
    console.log("Application initialization complete");
  }
});

// ==========================================
// GLOBAL EXPORTS - MUST BE AT END OF FILE
// ==========================================

const EXPOSED_FUNCTIONS = {
  // Auth
  handleLogin,
  logout,
  refreshAccessToken,
  handleForgotPassword,
  submitForgotPassword,
  handleResetPassword,
  handleRegistration,

  handleChangePassword, // ADDED
  // Navigation
  showSection, // Fixed: Ensure showSection is exposed
  openModal,
  closeModal,
  showSignupModal, // ADD

  // Employees
  loadEmployees,
  renderEmployees,
  handleCreateEmployee,
  handleDelete,
  bulkApproveEmployees,
  resendConfirmationMail,
  approveEmployee,
  fetchNextEmployeeId, // Fixed: Ensure fetchNextEmployeeId is exposed
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
  startCamera, // Fixed: Ensure startCamera is exposed
  capturePhoto,
  toggleUserMenu,
  handleMarkLeave,
  updateAttendanceStats,

  // Payments
  loadPaymentHistory,
  initiateIndividualPayment,
  handleIndividualPaymentSubmit,
  processBulkPayment,
  updatePaymentPreview,
  updateBulkTotal, // Fixed: Ensure updateBulkTotal is exposed
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
  markAllNotificationsAsRead,

  // Audit Logs
  loadDownloadLogs,
  filterDownloadLogs,
  syncPaymentsWithPaystack,

  // Exports
  exportAllEmployees, // Fixed: Ensure exportAllEmployees is exposed
  exportPaymentHistory,
  exportReceipt,
  confirmExport,

  // Filters
  filterHistory,
  toggleAllEmployees,

  // OTP
  showOTPModal,
  verifyOTP, // Fixed: Ensure verifyOTP is exposed
  resendOTP,
  startOtpCountdown,

  // Bank verification
  verifyBankAccountManual,
  verifyNewEmployeeBankManual,
  setupBankVerification,
  clearBankCache,
  setupBankCodeTracking,
  viewEmployeeDetail,

  // Requests
  showRequestModal,
  loadRequests,
  approveRequest,
  showDeclineModal,
  submitDeclineRequest,
  startRequestCamera, // Fixed: Ensure startRequestCamera is exposed
  captureRequestPhoto,

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
  initEmployeeSearch, // Fixed: Ensure initEmployeeSearch is exposed
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
  const modal = document.getElementById("changePasswordModal");
  if (!modal) {
    showToast("Change password modal not found", "error");
    return;
  }

  const usernameInput = document.getElementById("changePasswordUsername");
  if (usernameInput) {
    usernameInput.value =
      AppState.currentUser?.username || AppState.currentUser?.email || "";
  }

  document.getElementById("oldPassword").value = "";
  document.getElementById("newPassword").value = "";
  document.getElementById("confirmPassword").value = "";
  modal.style.display = "flex";
  modal.classList.add("active");
}

function showChangePasswordModal() {
  // Fixed: Ensure showChangePasswordModal is exposed
  openChangePasswordModal();
}

// Expose all functions to window
Object.keys(EXPOSED_FUNCTIONS).forEach((key) => {
  window[key] = EXPOSED_FUNCTIONS[key];
});

function exportReceipt(paymentId) {
  const modal = document.getElementById("exportPasswordModal");
  if (modal) {
    modal.dataset.exportType = "receipt";
    modal.dataset.paymentId = paymentId;
    const usernameInput = document.getElementById("exportUsername");
    if (usernameInput)
      usernameInput.value = AppState.currentUser?.username || "";
  }
  openModal("exportPasswordModal"); // Fixed: Open export password modal
}

async function retryPayment(transactionReferenceOrId) {
  try {
    if (!transactionReferenceOrId) {
      showToast("Missing payment reference for retry", "error");
      return;
    }
    const res = await apiRequest(
      `/payments/verify-payment/${transactionReferenceOrId}/`,
    );
    if (res.success && res.data?.payment_status) {
      await loadPaymentHistory();
      populatePaymentsTable();
      updateDashboardStats();
      showToast(
        `Payment status: ${res.data.payment_status}`,
        res.data.payment_status === "completed" ? "success" : "info",
        4000,
      );
      return;
    }
    showToast("Retry not available yet. Please try again later.", "warning");
  } catch (err) {
    console.error("retryPayment error:", err);
    showToast(err.message || "Retry failed", "error");
  }
}
