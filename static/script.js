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
  clientPayments: [],
  notifications: [],
  reminders: [],
  attendance: [],
  downloadLogs: [],
  currentUser: null,
  accessToken: null,
  refreshToken: null,
  refreshAccessTokenPromise: null,
  currentPaymentReference: null,
  currentEditingDeductionId: null,
  currentEditingCompanyId: null,
  cameraStream: null,
  capturedImageBlob: null,
  otpTimerInterval: null,
  loginAttempts: 0,
  loginLockedUntil: null,
  selectedEmployeesForBulk: new Set(),
  pendingBulkPaymentPayload: null,
  bankList: [],
  bankListPromise: null,
  lastVerifiedAccountKey: null,
  globalLoadingCount: 0, // ADDED: Counter for global loading operations
  activeToasts: new Map(),
  networkMessageVisible: false,
  tokenRefreshNetworkFailed: false,
  pendingAccountVerificationKey: null,

  // ADDED: single-flight de-duplication for resolve-account GET
  // Key: `${bankCode}:${accountNumber}` -> Promise
  inFlightAccountVerifications: new Map(),
  accountVerificationSoftFailures: new Map(),
  accountVerificationGlobalFailureUntil: 0,
  accountVerificationAbortController: null,
  lastAccountVerificationRequestKey: null,

  paymentPollInterval: null,
  bulkPollInterval: null,
  isPolling: false,
  currentSection: "dashboard",
  autoRefreshTimer: null,
  autoRefreshVisibilityBound: false,
  pendingRefreshTimer: null,
  lastSectionRefresh: {},
  sectionRefreshInFlight: new Map(),

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
const ACCOUNT_VERIFICATION_MIN_COOLDOWN_MS = 30 * 1000;
const ACCOUNT_VERIFICATION_DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const ACCOUNT_VERIFICATION_DEBOUNCE_MS = 800;
const SECTION_STALE_MS = 30 * 1000;
const AUTO_REFRESH_DELAY_MS = 350;
const BACKGROUND_REFRESH_INTERVAL_MS = 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function escapeHtml(text) {
  if (typeof text !== "string") return text;
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function searchEmployees(query) {
    if (!query || query.length < 2) return;
    const res = await apiRequest(`/api/employees/?search=${encodeURIComponent(query)}`, 'GET');
    if (res) renderEmployeeTable(res.results || res);
}
async function searchPayments(query) {
    if (!query || query.length < 2) return;
    const res = await apiRequest(`/api/payments/?search=${encodeURIComponent(query)}`, 'GET');
    if (res) renderPaymentTable(res.results || res);
}
async function searchDeductions(query) {
    if (!query || query.length < 2) return;
    const res = await apiRequest(`/api/deductions/?search=${encodeURIComponent(query)}`, 'GET');
    if (res) renderDeductionTable(res.results || res);
}
async function filterRequests(status) {
    const res = await apiRequest(`/api/requests/?status=${status}`, 'GET');
    if (res) renderRequestTable(res.results || res);
}
async function searchCompanies(query) {
    if (!query || query.length < 2) return;
    const res = await apiRequest(`/api/companies/?search=${encodeURIComponent(query)}`, 'GET');
    if (res) renderCompanyTable(res.results || res);
}
function togglePartialPayment() {
    const cb = document.getElementById('isPartialPayment');
    const input = document.getElementById('customAmount');
    input.style.display = cb.checked ? 'block' : 'none';
    input.disabled = !cb.checked;
}

function togglePartialPaymentIndividual() {
  const cb = document.getElementById('isPartialPaymentIndividual');
  const container = document.getElementById('partialFieldsIndividual');
  const preview = document.getElementById('paymentPreview');
  if (!container || !cb || !preview) return;
  
  container.style.display = cb.checked ? 'block' : 'none';

  const updatePartialCalc = () => {
    const netPayable = parseFloat(preview.dataset.netSalary || 0);
    const payNow = parseFloat(document.getElementById('partialAmountIndividual').value || 0);
    const remaining = Math.max(0, netPayable - payNow);
    const partialDisplay = document.getElementById('partialAmountDisplay');
    const remainingDisplay = document.getElementById('remainingBalanceDisplay');
    if (partialDisplay) partialDisplay.textContent = formatCurrency(payNow);
    if (remainingDisplay) remainingDisplay.textContent = formatCurrency(remaining);
  };
  document.getElementById('partialAmountIndividual').oninput = updatePartialCalc;
}

function toggleBulkPartial() {
  const cb = document.getElementById('bulkPartialToggle');
  const controls = document.getElementById('bulkPartialControls');
  if (!controls || !cb) return;

  const enabled = cb.checked;
  controls.style.display = enabled ? 'block' : 'none';

  // Enable/disable per-row inputs
  document
    .querySelectorAll('.bulk-partial-amount, .bulk-partial-reason')
    .forEach((el) => {
      el.disabled = !enabled;
      if (!enabled) el.value = '';
    });

  updateBulkTotal();
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

function formatDateTime(dateString) {
  if (!dateString) return "-";
  try {
    return new Date(dateString).toLocaleString("en-NG");
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
    const spinner = spinnerEl || document.getElementById("globalSpinner");
    if (spinner) {
      // Ensure we have a reference to the global spinner element
      AppState.elements.globalSpinner = spinner;
      // Increment global loading counter when showing spinner without a button
      if (!btn) {
        AppState.globalLoadingCount = (AppState.globalLoadingCount || 0) + 1;
      }
      spinner.classList.remove("hidden");
    }
    // Ensure individual element spinners (if any) are shown
    if (btn && btn.id) {
        const loader = document.getElementById(`${btn.id}-loading`);
        if (loader) loader.style.display = 'inline-block';
    }
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
    const spinner = spinnerEl || document.getElementById("globalSpinner");
    if (spinner) {
      if (!btn)
        AppState.globalLoadingCount = Math.max(
          0,
          AppState.globalLoadingCount - 1,
        ); // Decrement global counter

      if (AppState.globalLoadingCount === 0 && !AppState.isPolling) {
        spinner.classList.add("hidden");
      }
    }
    // Ensure individual element spinners are hidden
    if (btn && btn.id) {
        const loader = document.getElementById(`${btn.id}-loading`);
        if (loader) loader.style.display = 'none';
    }
  } catch (error) {
    console.error("Error in hideLoading:", error);
  }
}

/**
 * Toggle and populate the expandable details row for a bulk table employee.
 * Fetches net-salary and deductions for the employee and renders them.
 */
async function toggleBulkDetails(empId) {
  try {
    const detailsRow = document.getElementById(`details-row-${empId}`);
    const contentEl = document.getElementById(`details-content-${empId}`);
    if (!detailsRow || !contentEl) return;

    const isHidden = detailsRow.style.display === 'none' || !detailsRow.style.display;
    if (!isHidden) {
      detailsRow.style.display = 'none';
      return;
    }

    // Show row
    detailsRow.style.display = '';

    // Avoid refetching if already loaded
    if (contentEl.dataset && contentEl.dataset.loaded) return;

    // Show skeleton while loading
    contentEl.innerHTML = `<div class="skeleton" style="height:80px;"></div>`;

    // Fetch net salary and deductions in parallel
    const [netRes, dedRes] = await Promise.allSettled([
      apiRequest(`/api/employees/${empId}/net-salary/`),
      apiRequest(`/api/deductions/?employee=${empId}`),
    ]);

    let html = `<div class="bulk-details-header">Per-employee breakdown</div><table class="bulk-details-table">`;

    if (netRes.status === 'fulfilled' && netRes.value && netRes.value.success && netRes.value.data) {
      const d = netRes.value.data;
      html += `<tr><td>Base Salary</td><td style="text-align:right">${formatCurrency(d.base_salary || 0)}</td></tr>`;
      html += `<tr><td>Deductions</td><td style="text-align:right">${formatCurrency(d.pending_deductions || 0)}</td></tr>`;
      html += `<tr><td>Adjustments (IOU/Bonus)</td><td style="text-align:right">${formatCurrency(d.approved_adjustments || 0)}</td></tr>`;
      html += `<tr><td>Previous Balance</td><td style="text-align:right">${formatCurrency(d.previous_outstanding_balance || 0)}</td></tr>`;
      html += `<tr><td><strong>Net Payable</strong></td><td style="text-align:right"><strong>${formatCurrency(d.net_salary || 0)}</strong></td></tr>`;
    } else {
      html += `<tr><td colspan="2">Could not load salary breakdown</td></tr>`;
    }

    // Deductions list
    if (dedRes.status === 'fulfilled' && dedRes.value && dedRes.value.success) {
      const data = dedRes.value.data;
      const items = Array.isArray(data) ? data : (data.results || []);
      if (items.length) {
        html += `<tr><td colspan="2"><strong>Pending Deductions</strong></td></tr>`;
        items.forEach((it) => {
          const reason = it.reason || it.title || 'Deduction';
          const amt = it.amount || it.value || 0;
          html += `<tr><td>${escapeHtml(reason)}</td><td style="text-align:right">${formatCurrency(amt)}</td></tr>`;
        });
      } else {
        html += `<tr><td colspan="2">No pending deductions</td></tr>`;
      }
    } else {
      html += `<tr><td colspan="2">Could not load deductions</td></tr>`;
    }

    html += `</table>`;
    contentEl.innerHTML = html;
    contentEl.dataset.loaded = '1';
  } catch (err) {
    console.error('Failed to load details for', empId, err);
    const contentEl = document.getElementById(`details-content-${empId}`);
    if (contentEl) contentEl.innerHTML = 'Failed to load details';
  }
}

let lastToastInfo = { message: "", time: 0 };

function friendlyToastMessage(message) {
  const text = String(message || "").trim();
  if (!text) return "Something went wrong. Please try again.";
  if (/^\s*[\[{]/.test(text) || /traceback|stack trace|exception|html>|paystack_last_response/i.test(text)) {
    return "Something went wrong. Please try again.";
  }
  if (/token expired/i.test(text)) {
    return "Session expired. Please login again.";
  }
  if (/failed to fetch|networkerror|load failed|connection|offline/i.test(text)) {
    return "Connection problem. Please check your internet and try again.";
  }
  return text;
}

function isNetworkError(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return (
    !navigator.onLine ||
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("load failed") ||
    message.includes("connection")
  );
}

function setNetworkMessage(visible) {
  AppState.networkMessageVisible = visible;
  if (visible) {
    showToast("Connection problem. Please check your internet and try again.", "warning", 0, {
      key: "network-status",
    });
    return;
  }

  const toast = AppState.activeToasts.get("network-status");
  if (toast) closeToast(toast);
  AppState.networkMessageVisible = false;
}

window.addEventListener("online", () => setNetworkMessage(false));
window.addEventListener("offline", () => setNetworkMessage(true));

function showToast(message, type = "info", duration = CONFIG.TOAST_DURATION, options = {}) {
  message = friendlyToastMessage(message);
  const now = Date.now();
  const toastKey = options.key || `${type}:${message}`;
  if (AppState.activeToasts.has(toastKey)) return;
  // Prevent showing the exact same message repeatedly during rapid retries.
  if (message === lastToastInfo.message && now - lastToastInfo.time < 4000)
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
  toast.dataset.toastKey = toastKey;

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
  AppState.activeToasts.set(toastKey, toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  if (duration > 0) setTimeout(() => closeToast(toast), duration);
}

function closeToast(toast) {
  if (!toast) return;
  const toastKey = toast.dataset?.toastKey;
  if (toastKey && AppState.activeToasts.get(toastKey) === toast) {
    AppState.activeToasts.delete(toastKey);
  }
  if (toastKey === "network-status") {
    AppState.networkMessageVisible = false;
  }
  toast.classList.remove("show");
  setTimeout(() => toast?.remove(), 300);
}

function ensureDialogModal() {
  let modal = document.getElementById("appDialogModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "appDialogModal";
  modal.className = "modal";
  modal.style.display = "none";
  modal.innerHTML = `
    <div class="modal-content" style="max-width: 420px;">
      <div class="modal-header">
        <h3 id="appDialogTitle">Confirm Action</h3>
        <button type="button" class="modal-close" id="appDialogClose" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body">
        <p id="appDialogMessage" style="margin-bottom: 12px;"></p>
        <input id="appDialogInput" class="form-control" style="display:none;" />
      </div>
      <div class="modal-footer" style="display:flex; gap:10px; justify-content:flex-end;">
        <button type="button" class="btn btn-secondary" id="appDialogCancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="appDialogOk">Continue</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function appDialog({ title = "Confirm Action", message = "", input = false, defaultValue = "" } = {}) {
  const modal = ensureDialogModal();
  const titleEl = modal.querySelector("#appDialogTitle");
  const messageEl = modal.querySelector("#appDialogMessage");
  const inputEl = modal.querySelector("#appDialogInput");
  const okBtn = modal.querySelector("#appDialogOk");
  const cancelBtn = modal.querySelector("#appDialogCancel");
  const closeBtn = modal.querySelector("#appDialogClose");

  titleEl.textContent = title;
  messageEl.textContent = message;
  inputEl.style.display = input ? "block" : "none";
  inputEl.value = defaultValue || "";

  return new Promise((resolve) => {
    const cleanup = (value) => {
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      closeBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      modal.style.display = "none";
      modal.classList.remove("active");
      resolve(value);
    };
    const onOk = () => cleanup(input ? inputEl.value : true);
    const onCancel = () => cleanup(input ? null : false);
    const onBackdrop = (event) => {
      if (event.target === modal) onCancel();
    };

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    closeBtn.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    modal.style.display = "flex";
    modal.classList.add("active");
    if (input) inputEl.focus();
  });
}

function appConfirm(message, title = "Confirm Action") {
  return appDialog({ title, message });
}

function appPrompt(message, defaultValue = "", title = "Input Required") {
  return appDialog({ title, message, input: true, defaultValue });
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

const SECTION_LABELS = {
  dashboard: "dashboard",
  employees: "employees",
  attendance: "attendance",
  deductions: "deductions",
  "iou-management": "IOU records",
  "bonus-management": "bonus records",
  payments: "payments",
  payslips: "payslips",
  companies: "companies",
  accounts: "accounts",
  history: "payment history",
  requests: "requests",
  sacked: "sacked employees",
  notifications: "notifications",
  reminders: "reminders",
  "audit-logs": "audit logs",
  "company-payments": "company payments",
};

async function refreshSectionData(id = AppState.currentSection, options = {}) {
  const { showSpinner = false, force = false } = options;
  if (!id || !AppState.currentUser) return false;

  const lastRefresh = AppState.lastSectionRefresh[id] || 0;
  if (!force && Date.now() - lastRefresh < SECTION_STALE_MS) return true;

  if (AppState.sectionRefreshInFlight.has(id)) {
    return AppState.sectionRefreshInFlight.get(id);
  }

  const loaders = {
    dashboard: async () => {
      await updateDashboardStats();
      await loadNotifications();
    },
    employees: async () => {
      await loadEmployees();
      updateUIAfterEmployeeLoad();
    },
    attendance: loadAttendance,
    deductions: async () => {
      await loadDeductions();
      await loadEmployees();
      updateUIAfterEmployeeLoad();
    },
    "iou-management": () => loadAdjustments("iou"),
    "bonus-management": () => loadAdjustments("bonus"),
    payments: async () => {
      await loadEmployees();
      await loadPaymentHistory();
      populatePaymentsTable();
    },
    payslips: async () => {
      await loadEmployees();
      populateEmployeeSelect("payslipEmployee");
    },
    companies: loadCompanies,
    accounts: async () => {
      await loadEmployees();
      await loadNigerianBanks();
    },
    history: loadPaymentHistory,
    requests: loadRequests,
    sacked: loadSackedEmployees,
    notifications: loadNotifications,
    reminders: loadReminders,
    "audit-logs": loadDownloadLogs,
    "company-payments": loadClientPayments,
  };

  const loader = loaders[id];
  if (!loader) return false;

  const refreshPromise = (async () => {
    try {
      if (showSpinner) {
        updateLoadingProgress(`Loading ${SECTION_LABELS[id] || "section"}...`);
        showLoading();
      }
      await loader();
      AppState.lastSectionRefresh[id] = Date.now();
      return true;
    } catch (err) {
      console.error(`Failed to refresh section ${id}:`, err);
      if (showSpinner && !isNetworkError(err)) {
        showToast(`Failed to refresh ${SECTION_LABELS[id] || "section"}`, "error");
      }
      return false;
    } finally {
      if (showSpinner) {
        updateLoadingProgress("Loading...");
        hideLoading();
      }
      AppState.sectionRefreshInFlight.delete(id);
    }
  })();

  AppState.sectionRefreshInFlight.set(id, refreshPromise);
  return refreshPromise;
}

function shouldRefreshAfterMutation(url, method) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) return false;

  const normalizedUrl = String(url || "");
  return ![
    "/token/refresh/",
    "/login/",
    "/logout/",
    "/request-reset/",
    "/bulk_preview/",
    "/request-export/",
    "/request_export/",
    "/request-payslip-export/",
    "/request_receipt_export/",
    "/download_",
    "/export_csv/",
    "/verify_2fa/",
  ].some((path) => normalizedUrl.includes(path));
}

function scheduleVisibleSectionRefresh(reason = "mutation") {
  if (!AppState.currentUser) return;
  if (AppState.pendingRefreshTimer) clearTimeout(AppState.pendingRefreshTimer);

  AppState.pendingRefreshTimer = setTimeout(async () => {
    AppState.pendingRefreshTimer = null;
    try {
      await refreshSectionData(AppState.currentSection, { force: true, showSpinner: false });
      if (AppState.currentSection !== "dashboard") {
        await updateDashboardStats();
      }
    } catch (err) {
      console.warn(`Automatic refresh after ${reason} failed:`, err);
    }
  }, AUTO_REFRESH_DELAY_MS);
}

function initAutoRefresh() {
  if (AppState.autoRefreshTimer) return;

  AppState.autoRefreshTimer = setInterval(() => {
    if (!AppState.currentUser || document.hidden) return;
    refreshSectionData(AppState.currentSection, { force: true, showSpinner: false });
  }, BACKGROUND_REFRESH_INTERVAL_MS);

  if (!AppState.autoRefreshVisibilityBound) {
    AppState.autoRefreshVisibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && AppState.currentUser) {
        refreshSectionData(AppState.currentSection, { force: true, showSpinner: false });
      }
    });
  }
}

async function showSection(id) {
  if (AppState.currentUser && !getAllowedSectionsForUser(AppState.currentUser).has(id)) {
    showToast("You do not have access to that section.", "warning");
    id = "dashboard";
  }
  updateLoadingProgress(`Loading ${SECTION_LABELS[id] || "section"}...`);
  showLoading();
  AppState.currentSection = id;
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

  try {
    await refreshSectionData(id, { showSpinner: false });
  } finally {
    updateLoadingProgress("Loading...");
    hideLoading();
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

function formatApiError(data, fallback) {
  if (!data || typeof data !== "object") return fallback;

  const labels = {
    username: "Username",
    password: "Password",
    full_name: "Full name",
    role: "Role",
    type: "Role",
    email: "Email address",
    phone: "Phone number",
    salary: "Salary",
    bank_name: "Bank name",
    bank_code: "Bank code",
    account_number: "Account number",
    account_holder: "Account holder",
    employee_id: "Employee",
    partial_amount: "Payment amount",
    otp: "OTP",
    reference: "Reference",
  };

  const cleanText = (value) => {
    if (Array.isArray(value)) return value.map(cleanText).filter(Boolean).join(", ");
    if (value && typeof value === "object") return formatApiError(value, "");
    const text = String(value || "").replace(/[\[\]{}"]/g, "").trim();
    if (/traceback|stack trace|exception|paystack_last_response|^html>/i.test(text)) {
      console.error("Technical API error hidden from user:", value);
      return "";
    }
    return text;
  };

  const fieldMessage = (field, value) => {
    const label = labels[field] || String(field).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const text = cleanText(value);
    if (!text) return "";
    const lower = text.toLowerCase();
    if (lower.includes("required") || lower.includes("blank") || lower.includes("missing")) return `${label} is required.`;
    if (lower.includes("invalid")) return `${label} is invalid.`;
    if (lower.includes("already") || lower.includes("exists") || lower.includes("unique")) return `${label} already exists.`;
    return `${label}: ${text}`;
  };

  const direct = data.detail || data.error || data.message;
  if (direct) {
    const directText = cleanText(direct);
    if (!directText) return fallback;
    if (/csrf|forbidden|permission denied|authentication failed/i.test(directText)) {
      return "Permission denied or session invalid. Please refresh the page and try again.";
    }
    return directText || fallback;
  }

  const fieldErrors = Object.entries(data)
    .map(([field, value]) => fieldMessage(field, value))
    .filter(Boolean)
    .join("; ");

  if (/csrf|forbidden|permission denied/i.test(fieldErrors)) {
    return "Permission denied or session invalid. Please refresh the page and try again.";
  }

  return fieldErrors || fallback;
}
window.formatApiError = formatApiError;

function sanitizePaymentError(message) {
  const text = String(message || "").trim();
  if (!text) return "Payment could not be completed. Please try again later.";

  const lower = text.toLowerCase();
  if (
    lower.includes("blacklisted") ||
    lower.includes("blacklistedrecipients") ||
    lower.includes("invalid recipient") ||
    lower.includes("recipient code") ||
    lower.includes("recipient_not_found")
  ) {
    return "This employee's bank details need to be refreshed before payment can continue.";
  }
  if (
    lower.includes("account could not be verified") ||
    lower.includes("couldn't verify") ||
    lower.includes("could not validate") ||
    lower.includes("invalid account")
  ) {
    return "The bank account could not be verified. Please contact your administrator.";
  }
  if (/^\s*[\[{]/.test(text) || /status['"]?\s*:|traceback|exception|stack|paystack_last_response/i.test(text)) {
    return "Payment could not be completed. Please try again later.";
  }

  return text;
}
window.sanitizePaymentError = sanitizePaymentError;

function validateEmailInput(value, required = true) {
  const email = String(value || "").trim().toLowerCase();
  if (!email) return required ? "Email address is required." : "";
  if (!EMAIL_PATTERN.test(email)) return "Enter a valid email address.";
  return "";
}

function formatBulkPaymentSummary(results, selectedCount) {
  const summary = results?.summary || {};
  const totalEmployees = summary.total_employees ?? selectedCount ?? 0;
  const successful = summary.successful ?? 0;
  const failed = summary.failed ?? (Array.isArray(results?.errors) ? results.errors.length : 0);
  const pending = summary.pending ?? 0;
  const totalPaid = summary.total_amount_paid ?? 0;
  return `Total Employees: ${totalEmployees}. Successful: ${successful}. Failed: ${failed}. Pending: ${pending}. Total Amount Paid: ${formatCurrency(totalPaid)}.`;
}

async function apiRequest(url, options = {}) {
  // FIXED: Ensure proper URL construction
  const baseUrl = window.location.origin;
  const fullUrl = url.startsWith("http")
    ? url
    : `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;

  let token = options.auth === false ? null : AppState.accessToken;

  // NEW: Proactively refresh token if expired to avoid unnecessary 401 logs and extra roundtrips
  if (options.auth !== false && token && isJwtExpired(token) && !url.includes("/token/refresh/") && !url.includes("/login/")) {
    const refreshed = await refreshAccessToken();
    if (!refreshed && AppState.tokenRefreshNetworkFailed) {
      setNetworkMessage(true);
      return {
        success: false,
        networkError: true,
        message: "Connection problem. Please check your internet and try again.",
      };
    }
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
    setNetworkMessage(false);

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
      if (options._authRetried) {
        const errorData = await response.json().catch(() => ({}));
        logout();
        let authErrorMessage =
          formatApiError(errorData, "Session expired. Please login again.");
        return {
          success: false,
          status: response.status,
          data: errorData,
          message: authErrorMessage,
        };
      }

      const refreshed = await refreshAccessToken();
      if (refreshed) return apiRequest(url, { ...options, _authRetried: true });
      if (AppState.tokenRefreshNetworkFailed) {
        setNetworkMessage(true);
        return {
          success: false,
          status: response.status,
          networkError: true,
          message: "Connection problem. Please check your internet and try again.",
        };
      }
      logout();
      showToast("Session expired. Please login again.", "error");
      return {
        success: false,
        status: response.status,
        message: "Session expired. Please login again.",
      };
    }

    if (response.status === 403) {
      const errorData = await response.json().catch(() => ({}));
      const serverMessage = formatApiError(errorData, "");
      return {
        success: false,
        status: response.status,
        data: errorData,
        message:
          serverMessage ||
          "Permission denied. Please refresh the page and try again. If the problem persists, contact your administrator.",
      };
    }

    if (response.status === 429) {
      const errorData = await response.json().catch(() => ({}));
      const retryAfter = Number(errorData.retry_after || errorData.data?.retry_after);
      const waitTime = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.max(1, Math.ceil(retryAfter / 60))
        : null;
      const serverMessage = formatApiError(errorData, "");
      return {
        success: false,
        status: response.status,
        message: serverMessage || (
          waitTime
            ? `Verification service is temporarily unavailable. Please try again in ${waitTime} minute${waitTime === 1 ? "" : "s"}.`
            : "Verification service is temporarily unavailable. Please try again shortly."
        ),
        data: errorData,
      };
    }

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      let message = formatApiError(data, `Request failed (${response.status})`);
      if (response.status >= 500) {
        const hasServerMessage = data && (data.detail || data.error || data.message);
        if (!hasServerMessage) {
          message = 'Server error. Please try again later.';
        }
      }
      return {
        success: false,
        status: response.status,
        data,
        message,
      };
    }

    if (shouldRefreshAfterMutation(url, fetchOptions.method)) {
      scheduleVisibleSectionRefresh("data change");
    }

    return { success: true, status: response.status, data };
  } catch (err) {
    console.error("API Error:", err);
    if (isNetworkError(err)) {
      setNetworkMessage(true);
      return {
        success: false,
        networkError: true,
        message: "Connection problem. Please check your internet and try again.",
      };
    }
    return {
      success: false,
      message: friendlyToastMessage(err.message || "Request failed. Please try again."),
    };
  }
}

/**
 * Refreshes the JWT access token using the stored refresh token.
 * Improved to handle session expiry and state cleanup.
 */
async function refreshAccessToken() {
  if (AppState.refreshAccessTokenPromise) {
    return AppState.refreshAccessTokenPromise;
  }

  const refreshPromise = (async () => {
    try {
      AppState.tokenRefreshNetworkFailed = false;
      // IMPORTANT: refresh_token is HttpOnly, so JS cannot read it.
      // Use the cookie-backed refresh flow and keep tokens in memory only.
      const refreshToken = AppState.refreshToken;
      const refreshBody = refreshToken ? { refresh: refreshToken } : null;

      const fetchOptions = {
        method: "POST",
        headers: {},
      };

      if (refreshBody) {
        fetchOptions.headers["Content-Type"] = "application/json";
        fetchOptions.body = JSON.stringify(refreshBody);
      }

      const response = await fetch("/token/refresh/", {
        ...fetchOptions,
        credentials: "same-origin",
      });
      setNetworkMessage(false);

      if (response.status === 401 || response.status === 403) {
        throw new Error("AUTH_EXPIRED");
      }

      if (!response.ok) throw new Error("Refresh request failed");

      const data = await response.json();
      AppState.accessToken = data.access;

      if (data.refresh) {
        AppState.refreshToken = data.refresh;
      }

      return true;
    } catch (err) {
      if (err.message === "AUTH_EXPIRED") {
        AppState.tokenRefreshNetworkFailed = false;
        console.warn("Session expired.");
      } else if (isNetworkError(err)) {
        AppState.tokenRefreshNetworkFailed = true;
        setNetworkMessage(true);
        console.warn("Token refresh delayed by network error:", err);
      } else {
        AppState.tokenRefreshNetworkFailed = false;
        console.error("Token refresh network error:", err);
      }
      return false;
    }
  })();

  AppState.refreshAccessTokenPromise = refreshPromise;
  try {
    return await refreshPromise;
  } finally {
    if (AppState.refreshAccessTokenPromise === refreshPromise) {
      AppState.refreshAccessTokenPromise = null;
    }
  }
}

// ==========================================
// NIGERIAN BANKS AUTO-LOADING
// ==========================================


async function loadNigerianBanks() {
  if (AppState.bankList.length) {
    populateBankSelects();
    return AppState.bankList;
  }
  if (AppState.bankListPromise) return AppState.bankListPromise;

  AppState.bankListPromise = (async () => {
  try {
    const res = await apiRequest("/paystack/banks/", { auth: false });
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
      { name: "Opay", code: "999992" },
    ];
    populateBankSelects();
  }
  return AppState.bankList;
  })();

  try {
    return await AppState.bankListPromise;
  } finally {
    AppState.bankListPromise = null;
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

function getSelectedBankCode(bankSelect) {
  if (!bankSelect || bankSelect.tagName !== "SELECT") return "";
  const selectedOption = bankSelect.selectedOptions?.[0] || bankSelect.options?.[bankSelect.selectedIndex];
  return selectedOption?.dataset?.code || "";
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

function getAccountVerificationCooldownMs(data = {}) {
  const retryAfter = Number(data.retry_after || data.data?.retry_after);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.max(ACCOUNT_VERIFICATION_MIN_COOLDOWN_MS, Math.ceil(retryAfter) * 1000);
  }
  return ACCOUNT_VERIFICATION_DEFAULT_COOLDOWN_MS;
}

function getAccountVerificationBusyMessage(cooldownMs) {
  const minutes = Math.max(1, Math.ceil(cooldownMs / 60000));
  return `Verification service busy. Enter manually or try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function formatPaymentStatus(status) {
  return String(status || "-").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function getPaymentStatusClass(status) {
  if (status === "completed") return "text-success";
  if (status === "failed" || status === "cancelled") return "text-danger";
  if (status === "pending_paystack_otp") return "text-warning";
  if (status === "processing") return "text-info";
  return "text-warning";
}

function renderPaymentAction(payment) {
  const reference = payment.transaction_reference || payment.id;
  const viewButton = `<button type="button" class="btn btn-sm btn-info" onclick="viewPaymentDetail('${payment.id}')" title="View Details">
              <i class="fas fa-eye"></i>
            </button>`;
  if (payment.status === "completed") {
    return `${viewButton}
            <span class="text-success"><i class="fas fa-check"></i> Paid</span>
            <button type="button" class="btn btn-sm btn-outline-success" onclick="exportReceipt('${payment.id}')" title="Download Receipt">
              <i class="fas fa-file-invoice"></i>
            </button>`;
  }
  if (payment.status === "pending_paystack_otp") {
    return `${viewButton} <button type="button" class="btn btn-sm btn-warning" onclick="showPaystackOtpModal('${reference}', '${payment.paystack_transfer_code || ""}')">OTP</button>`;
  }
  if (payment.status === "pending") {
    return `${viewButton} <button type="button" class="btn btn-sm btn-warning" onclick="showInternalOtpModal('${reference}')">Authorize</button>`;
  }
  if (payment.status === "processing") {
    return `${viewButton} <button type="button" class="btn btn-sm btn-info" onclick="retryPayment('${reference}')">Sync</button>`;
  }
  if (payment.status === "pending_hr") {
    return `${viewButton} <span class="text-warning">Awaiting HR</span>`;
  }
  if (payment.status === "failed") {
    return `${viewButton} <span class="text-danger">Failed</span>`;
  }
  return `${viewButton} <button type="button" class="btn btn-sm btn-info" onclick="retryPayment('${reference}')">Check</button>`;
}

function showInternalOtpModal(reference) {
  AppState.currentPaymentReference = reference;
  showOTPModal(
    "Authorize Payment",
    "Enter the internal OTP sent to your email to authorize this payment."
  );
}

async function verifyBankAccountFields({
  accountInput, bankSelect, holderInput, statusEl, manual = false
}) {
  const accountNumber = accountInput?.value?.trim();
  const bankCode = getSelectedBankCode(bankSelect);
  
  if (holderInput) {
    holderInput.readOnly = true;
    holderInput.disabled = false;
  }

  if (!/^\d{10}$/.test(accountNumber || "")) {
    setAccountVerificationStatus(statusEl, "Enter a valid 10-digit account number", "text-muted");
    return false;
  }
  if (!bankCode) {
    setAccountVerificationStatus(statusEl, "Select a valid bank before verification", "text-warning");
    return false;
  }
  
  const key = `${bankCode}:${accountNumber}`;
  
  // Block if already verifying this exact key
  if (AppState.pendingAccountVerificationKey === key) return false;

  // Check if we already verified this successfully
  if (AppState.lastVerifiedAccountKey === key && holderInput?.value && holderInput.value !== "Verifying...") {
    return true;
  }

  const cachedAccountName = _autoVerifiedKeys.get(key);
  if (cachedAccountName) {
    if (holderInput) {
      holderInput.value = cachedAccountName;
      holderInput.readOnly = true;
      holderInput.disabled = false;
      holderInput.style.background = "#d4edda";
    }
    AppState.lastVerifiedAccountKey = key;
    setAccountVerificationStatus(statusEl, `Verified: ${cachedAccountName}`, "text-success");
    return true;
  }

  if (AppState.lastAccountVerificationRequestKey === key) {
    return false;
  }

  if (AppState.accountVerificationAbortController) {
    AppState.accountVerificationAbortController.abort();
  }

  AppState.pendingAccountVerificationKey = key;
  AppState.lastAccountVerificationRequestKey = key;
  const abortController = new AbortController();
  AppState.accountVerificationAbortController = abortController;
  
  if (holderInput) {
    holderInput.value = "Verifying...";
    holderInput.disabled = false;
    holderInput.readOnly = true;
    holderInput.style.background = "#fff3cd";
  }
  if (statusEl) {
    statusEl.textContent = "Verifying...";
    statusEl.className = "text-info";
  }

  try {
    const response = await fetch(
      `/paystack/resolve-account/?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
      { method: "GET", signal: abortController.signal },
    );
    const data = await response.json().catch(() => ({}));

    if (abortController.signal.aborted) {
      return false;
    }

    if (!response.ok) {
      throw new Error(data.message || data.detail || "Account verification is temporarily unavailable.");
    }

    if (data.verified === false) {
      if (holderInput) {
        holderInput.value = "";
        holderInput.readOnly = true;
        holderInput.disabled = false;
        holderInput.placeholder = "Auto-filled after verification";
        holderInput.style.background = "#f8f9fa";
      }
      setAccountVerificationStatus(statusEl, data.message || "Invalid account details", "text-danger");
      return false;
    }

    const accountName = data.account_name;
    
    if (accountName) {
      if (holderInput) {
        holderInput.value = accountName;
        holderInput.readOnly = true;
        holderInput.disabled = false;
        holderInput.style.background = "#d4edda";
      }
      _autoVerifiedKeys.set(key, accountName);
      AppState.lastVerifiedAccountKey = key;
      if (statusEl) {
        statusEl.textContent = `Verified: ${accountName}`;
        statusEl.className = "text-success";
      }
      return true;
    }
    
    throw new Error("Account not found");
    
  } catch (err) {
    if (err.name === "AbortError") {
      if (AppState.lastAccountVerificationRequestKey === key) {
        AppState.lastAccountVerificationRequestKey = null;
      }
      return false;
    }
    if (holderInput) {
      holderInput.value = "";
      holderInput.disabled = false;
      holderInput.readOnly = true;
      holderInput.placeholder = "Auto-filled after verification";
      holderInput.style.background = "#fff3cd";
    }
    if (statusEl) {
      statusEl.textContent = err.message || "Verification failed. Please try again.";
      statusEl.className = "text-warning";
    }
    return false;
  } finally {
    if (AppState.pendingAccountVerificationKey === key) {
      AppState.pendingAccountVerificationKey = null;
    }
    if (AppState.accountVerificationAbortController === abortController) {
      AppState.accountVerificationAbortController = null;
    }
  }
}


function setupAccountVerification({ accountInputId, bankSelectId, holderInputId, statusId }) {
  const accountInput = document.getElementById(accountInputId);
  const bankSelect = document.getElementById(bankSelectId);
  const holderInput = document.getElementById(holderInputId);
  const statusEl = document.getElementById(statusId);

  if (!accountInput || !bankSelect || !holderInput || bankSelect.tagName !== "SELECT") return;
  if (accountInput.dataset.accountVerificationBound === "true") return;
  accountInput.dataset.accountVerificationBound = "true";
  bankSelect.dataset.accountVerificationBound = "true";

  holderInput.readOnly = true;

  const verifyWhenReady = () => {
    const acc = accountInput.value.trim();
    const bankCode = getSelectedBankCode(bankSelect);
    if (acc.length === 10 && bankCode) {
      verifyBankAccountFields({ accountInput, bankSelect, holderInput, statusEl });
    }
  };

  const debouncedVerify = debounce(verifyWhenReady, ACCOUNT_VERIFICATION_DEBOUNCE_MS);

  accountInput.addEventListener("input", () => {
    const acc = accountInput.value.trim();
    const bankCode = getSelectedBankCode(bankSelect);
    const key = `${bankCode || "none"}:${acc}`;
    if (AppState.pendingAccountVerificationKey && AppState.pendingAccountVerificationKey !== key) {
      AppState.accountVerificationAbortController?.abort();
    }
    
    // Clear verified state if changed
    if (AppState.lastVerifiedAccountKey && AppState.lastVerifiedAccountKey !== key) {
      AppState.lastVerifiedAccountKey = null;
      holderInput.value = "";
      holderInput.readOnly = true;
      holderInput.placeholder = "Auto-filled after verification";
      holderInput.style.background = "#f8f9fa";
    }
    
    if (acc.length === 10 && bankCode) {
      debouncedVerify();
    } else {
      AppState.accountVerificationAbortController?.abort();
      AppState.pendingAccountVerificationKey = null;
      AppState.lastAccountVerificationRequestKey = null;
    }
  });

  bankSelect.addEventListener("change", () => {
    const acc = accountInput.value.trim();
    const bankCode = getSelectedBankCode(bankSelect);
    AppState.accountVerificationAbortController?.abort();
    AppState.lastVerifiedAccountKey = null;
    AppState.lastAccountVerificationRequestKey = null;
    holderInput.value = "";
    holderInput.readOnly = true;
    holderInput.placeholder = "Auto-filled after verification";
    holderInput.style.background = "#f8f9fa";
    if (acc.length === 10 && bankCode) {
      verifyWhenReady();
    }
  });
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
    !(await appConfirm(
      "Clear all cached bank verification details? This will force new lookups for all employees.",
    ))
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
    showToast("Username or Employee ID and password are required", "error");
    return;
  }

  if (username.includes("@")) {
    showToast("Use your username or employee ID to login.", "error");
    return;
  }

  try {
    showLoading(btn);
    const csrfToken = getCookie("csrftoken");
    const response = await fetch("/login/", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(csrfToken ? { "X-CSRFToken": csrfToken } : {}),
      },
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

    document.getElementById("loginPage")?.classList.add("hidden");
    document.getElementById("dashboardPage")?.classList.remove("hidden");

    await loadDashboard();
    initAutoRefresh();

    showToast("Login successful", "success");
  } catch (err) {
    console.error("Login error:", err);
    if (isNetworkError(err)) {
      setNetworkMessage(true);
    } else {
      showToast("Login failed. Please try again.", "error");
    }
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
    phone: document.getElementById("signupPhone")?.value.trim(),
    bank_name: document.getElementById("signupBankName")?.value.trim(),
    bank_code: getSelectedBankCode(document.getElementById("signupBankName")),
    account_number: document.getElementById("signupAccountNumber")?.value.trim(),
    account_holder: document.getElementById("signupAccountHolder")?.value.trim(),
  };

  const missing = [];
  if (!payload.username) missing.push("Username");
  if (!payload.password || payload.password.length < 8) missing.push("Password (min 8 chars)");
  if (!payload.full_name || payload.full_name.split(/\s+/).length < 2) missing.push("Full Name (min 2 names)");
  if (!payload.role) missing.push("Role");
  if (!payload.location) missing.push("Location");
  if (!payload.bank_name || !payload.bank_code) missing.push("Valid Bank Selection");
  if (!payload.account_number || !/^\d{10}$/.test(payload.account_number)) missing.push("10-digit Account Number");
  if (!payload.account_holder) missing.push("Verified Account Holder Name");

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
    await fetch(`${window.location.origin}/logout/`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(AppState.accessToken ? { Authorization: `Bearer ${AppState.accessToken}` } : {}),
      },
      body: JSON.stringify({}),
    }).catch(() => {}); // Ignore errors on logout
  } catch (err) {
    console.error("Logout error:", err);
  } finally {
    AppState.accessToken = null;
    AppState.refreshToken = null;
    AppState.refreshAccessTokenPromise = null;
    AppState.currentUser = null;
    if (AppState.autoRefreshTimer) {
      clearInterval(AppState.autoRefreshTimer);
      AppState.autoRefreshTimer = null;
    }
    if (AppState.pendingRefreshTimer) {
      clearTimeout(AppState.pendingRefreshTimer);
      AppState.pendingRefreshTimer = null;
    }
    AppState.sectionRefreshInFlight.clear();
    AppState.lastSectionRefresh = {};
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
  const email = await appPrompt("Please enter your registered email address:", "", "Password Reset");
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

  // Prefer first_name, fallback to username
  const firstName = user.first_name || user.username || "User";

  const nameEl = document.getElementById("currentUserName");
  if (nameEl) {
    // Display Welcome + First Name behind the dropdown
    nameEl.textContent = "Welcome, " + firstName;
  }

  const welcomeEl = document.getElementById("welcomeUserName");
  if (welcomeEl) {
    // Display Welcome + First Name
    welcomeEl.textContent = "Welcome, " + firstName;
  }

  // Mapping backend flags to UI visibility
  const permissions = [
    {
      id: "admin-controls-employee",
      allowed:
        user.is_superuser || user.is_employee_admin,
    },
    {
      id: "admin-controls-sacked",
      allowed:
        user.is_superuser || user.is_employee_admin,
    },
    {
      id: "admin-controls-companies",
      allowed:
        user.is_superuser || user.is_company_admin,
    },
    { id: "accounts", allowed: user.is_superuser },
    {
      id: "requests-admin-view",
      allowed:
        user.is_superuser || user.is_request_admin,
    },
    {
      id: "payments",
      allowed:
        user.is_superuser || user.is_payment_admin,
    },
    {
      id: "deductions-section",
      allowed:
        user.is_superuser || user.is_deduction_admin,
    },
    {
      id: "hr-admin-view",  // Add this ID to your HTML for HR-specific sections
      allowed: user.is_superuser || user.is_hr_admin,
    },
    {
      id: "payment-approval-buttons",  // For approve/reject payment buttons
      allowed: user.is_superuser || user.is_hr_admin,
    },
  ];

  permissions.forEach(({ id, allowed }) => {
    const element = document.getElementById(id);
    if (element) element.style.display = allowed ? "" : "none";
  });

  applyNavigationPermissions(user);
}

function getAllowedSectionsForUser(user) {
  const base = new Set(["dashboard", "attendance", "payslips", "history", "notifications", "reminders", "requests"]);
  if (!user) return base;
  if (user.is_superuser || user.role === "admin") {
    return new Set([
      "dashboard", "employees", "attendance", "deductions", "iou-management",
      "bonus-management", "payments", "payslips", "companies", "accounts",
      "history", "requests", "sacked", "notifications", "reminders",
    ]);
  }
  if (user.is_employee_admin) {
    base.add("employees");
    base.add("sacked");
  }
  if (user.is_deduction_admin) base.add("deductions");
  if (user.is_payment_admin || user.is_hr_admin) {
    base.add("payments");
    base.add("iou-management");
    base.add("bonus-management");
  }
  if (user.is_company_admin) base.add("companies");
  if (user.is_request_admin) base.add("requests");
  if (user.is_notification_admin) base.add("notifications");
  return base;
}

function applyNavigationPermissions(user) {
  const allowedSections = getAllowedSectionsForUser(user);
  document.querySelectorAll(".sidebar-menu a").forEach((link) => {
    const onclick = link.getAttribute("onclick") || "";
    const match = onclick.match(/showSection\('([^']+)'\)/);
    if (!match) return;
    const item = link.closest("li");
    const allowed = allowedSections.has(match[1]);
    if (item) item.style.display = allowed ? "" : "none";
  });

  if (!allowedSections.has(AppState.currentSection)) {
    AppState.currentSection = "dashboard";
  }
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
  let employee = AppState.employees.find((e) => idsMatch(e.id, employeeId));
  if (!employee) {
    const detailRes = await apiRequest(`/api/employees/${employeeId}/`);
    if (detailRes.success) {
      employee = detailRes.data;
    } else {
      showToast(detailRes.message || "Employee details could not be loaded.", "error");
      return;
    }
  }

  const content = document.getElementById("employeeDetailContent");
  if (!content) return;

  showLoading(); // Global spinner for modal content loading
  const res = await apiRequest(`/api/employees/${employeeId}/net_salary/`);
  const d = res.success ? res.data : employee.salary_breakdown;

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
                    <tr><td><strong>Base Salary:</strong></td><td>${formatCurrency(d?.base_salary ?? employee.salary ?? 0)}</td></tr>
                    <tr><td><strong>IOU Deduction:</strong></td><td class="text-danger">${formatCurrency(d?.iou_deduction ?? 0)}</td></tr>
                    <tr><td><strong>Other Deductions:</strong></td><td class="text-danger">${formatCurrency(d?.other_deductions ?? 0)}</td></tr>
                    <tr><td><strong>Bonus:</strong></td><td class="text-success">${formatCurrency(d?.bonus ?? 0)}</td></tr>
                    <tr><td><strong>Prev. Month Balance Added:</strong></td><td class="text-info">${formatCurrency(d?.previous_balance ?? 0)}</td></tr>
                    <tr><td><strong>Total Monthly Payable:</strong></td><td><strong>${formatCurrency(d?.final_net_salary ?? employee.salary ?? 0)}</strong></td></tr>
                    <tr><td><strong>Total Paid This Month:</strong></td><td>${formatCurrency(d?.total_paid ?? 0)}</td></tr>
                    <tr><td><strong>Outstanding Balance:</strong></td><td class="text-success font-bold">${formatCurrency(d?.outstanding_balance ?? 0)}</td></tr>
                </table>
            </div>
        </div>
    `;

  openModal("employeeDetailModal");
  hideLoading(); // Global spinner
}

async function resignEmployee(empId) {
  const reason = await appPrompt("Enter resignation details/reason:", "", "Employee Resignation");
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
  if (!(await appConfirm("Are you sure you want to approve this employee registration?")))
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

async function bulkUpdateBankCodes() {
  if (!(await appConfirm("Are you sure you want to attempt resolving missing bank codes for all employees? This will look up Paystack codes based on existing bank names."))) return;
  
  try {
    showLoading();
    const res = await apiRequest("/api/employees/bulk_update_bank_codes/", { method: "POST" });
    if (res.success) {
      showToast(res.data.message, "success");
      // Refresh the employee list to show updated codes
      await loadEmployees();
      if (typeof updateUIAfterEmployeeLoad === 'function') updateUIAfterEmployeeLoad();
    } else {
      showToast(res.message || "Failed to update bank codes", "error");
    }
  } catch (err) {
    showToast("An error occurred during bulk update", "error");
  } finally {
    hideLoading();
  }
}

async function bulkApproveEmployees() {
  const checkboxes = document.querySelectorAll(".employee-checkbox:checked");
  const ids = Array.from(checkboxes).map((cb) => cb.value);

  if (!ids.length) {
    showToast("Select at least one pending employee", "warning");
    return;
  }

  if (!(await appConfirm(`Are you sure you want to approve ${ids.length} employees?`)))
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
            <td>${formatCurrency(emp.salary_breakdown.outstanding_balance)}</td>
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
                <button type="button" class="btn btn-sm btn-outline-success" onclick="goToPaymentsForEmployee('${emp.id}')">
                    <i class="fas fa-money-bill-wave"></i> Go to Payments
                </button>
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
    bank_code: getSelectedBankCode(document.getElementById("newEmployeeBankName")),
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
  const emailError = validateEmailInput(payload.email, true);
  if (emailError) missingFields.push(emailError);
  if (!payload.phone) missingFields.push("Phone");
  if (!payload.bank_name || !payload.bank_code) missingFields.push("Valid Bank Selection");
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
  if (!(await appConfirm("Are you sure you want to delete this employee?"))) return;

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
  const generatedEmployeeId =
    document.getElementById("generatedEmployeeIdInput")?.value?.trim() || "";

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
    bank_code: getSelectedBankCode(document.getElementById("accountBankName")),
    account_number: document.getElementById("accountNumber")?.value.trim(),
    account_holder: document.getElementById("accountHolderName")?.value.trim(),
    employee_id: /^FSS-\d{3,}-(STAFF|GUARD)$/.test(generatedEmployeeId)
      ? generatedEmployeeId
      : "",
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
  const emailError = validateEmailInput(payload.email, true);
  if (emailError) missing.push(emailError);

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
    const isTerminated = company.status === "terminated";

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
                <button type="button" class="btn btn-sm btn-info" onclick="showCompanyPaymentVerifyModal('${company.id}')">Verify Payment</button>
                ${isTerminated
                  ? `<button type="button" class="btn btn-sm btn-success" onclick="reactivateCompany('${company.id}')">Re-enable</button>`
                  : `<button type="button" class="btn btn-sm btn-danger" onclick="deleteCompany('${company.id}')">Deactivate</button>`}
            </td>
        `;
    tbody.appendChild(row);
  });
}

async function reactivateCompany(companyId) {
  if (!(await appConfirm("Re-enable this company for a new or resumed contract?"))) return;
  try {
    showLoading();
    const res = await apiRequest(`/api/companies/${companyId}/reactivate/`, {
      method: "POST",
      body: { contract_start: new Date().toISOString().split("T")[0] },
    });
    if (!res.success) throw new Error(res.message || "Failed to re-enable company");
    showToast("Company re-enabled", "success");
    await loadCompanies();
  } catch (err) {
    showToast(err.message || "Failed to re-enable company", "error");
  } finally {
    hideLoading();
  }
}

async function showCompanyPaymentVerifyModal(companyId) {
  const company = AppState.companies.find((c) => String(c.id) === String(companyId));
  if (!company) {
    showToast("Company not found", "error");
    return;
  }

  await loadClientPayments();

  const currentMonth = new Date().toISOString().slice(0, 7);
  const existingPayment = (AppState.clientPayments || []).find(
    (p) => String(p.client) === String(companyId) && p.month_key === currentMonth,
  );
  const expectedAmount = Number(company.payment_to_us || 0);
  const amountPaid = Number(existingPayment?.amount_paid || 0);

  document.getElementById("verifyCompanyId").value = company.id;
  document.getElementById("verifyCompanyName").value = company.name || "";
  document.getElementById("verifyCompanyMonth").value = existingPayment?.month_key || currentMonth;
  document.getElementById("verifyCompanyExpected").value = expectedAmount.toFixed(2);
  document.getElementById("verifyCompanyAmountPaid").value = amountPaid.toFixed(2);
  document.getElementById("verifyCompanyStatus").value =
    existingPayment?.status || (amountPaid >= expectedAmount && expectedAmount > 0 ? "paid" : amountPaid > 0 ? "partial" : "unpaid");
  document.getElementById("verifyCompanyNotes").value = existingPayment?.notes || "";

  openModal("companyPaymentVerifyModal");
}

function syncCompanyPaymentStatusFromAmount() {
  const expected = Number(document.getElementById("verifyCompanyExpected")?.value || 0);
  const paid = Number(document.getElementById("verifyCompanyAmountPaid")?.value || 0);
  const statusEl = document.getElementById("verifyCompanyStatus");
  if (!statusEl) return;
  if (paid <= 0) statusEl.value = "unpaid";
  else if (paid >= expected) statusEl.value = "paid";
  else statusEl.value = "partial";
}

async function saveCompanyPaymentVerification(e) {
  e.preventDefault();
  const btn = document.getElementById("saveCompanyPaymentVerifyBtn");
  const client = document.getElementById("verifyCompanyId")?.value;
  const month = document.getElementById("verifyCompanyMonth")?.value;
  const expected = Number(document.getElementById("verifyCompanyExpected")?.value || 0);
  const amountPaid = Number(document.getElementById("verifyCompanyAmountPaid")?.value || 0);
  let statusValue = document.getElementById("verifyCompanyStatus")?.value || "unpaid";
  const notes = document.getElementById("verifyCompanyNotes")?.value || "";

  if (!client || !month) {
    showToast("Company and month are required", "warning");
    return;
  }
  if (!Number.isFinite(amountPaid) || amountPaid < 0) {
    showToast("Enter a valid payment amount", "warning");
    return;
  }
  if (amountPaid <= 0) statusValue = "unpaid";
  else if (amountPaid >= expected) statusValue = "paid";
  else statusValue = "partial";

  try {
    showLoading(btn);
    const res = await apiRequest("/api/client-payments/", {
      method: "POST",
      body: {
        client,
        month_key: month,
        status: statusValue,
        amount_paid: Math.round(amountPaid * 100) / 100,
        payment_date: new Date().toISOString().split("T")[0],
        notes,
      },
    });
    if (!res.success) throw new Error(res.message || "Failed to verify company payment");
    showToast("Company payment verification saved", "success");
    closeModal("companyPaymentVerifyModal");
    await loadClientPayments();
  } catch (err) {
    showToast(err.message || "Failed to verify company payment", "error");
  } finally {
    hideLoading(btn);
  }
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
  const reason = await appPrompt("Enter reason for marking this company as Not Active:", "", "Company Status");
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
  if (!(await appConfirm("Renew this contract for another year?"))) return;
  const res = await apiRequest(`/api/companies/${companyId}/renew_contract/`, {
    method: "POST",
  });
  if (res.success) {
    showToast("Contract renewed successfully", "success");
    await loadCompanies();
  }
}

async function terminateCompanyContract(companyId) {
  if (!(await appConfirm("Terminate this contract immediately?"))) return;
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
    const displayStatus = ded.display_status || (ded.status === "applied" ? "settled" : ded.status || "pending");
    const statusLabel = displayStatus === "settled"
      ? "Settled"
      : displayStatus === "pending"
        ? "Pending"
        : displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1);
    const statusClass =
      displayStatus === "settled"
        ? "text-success"
        : displayStatus === "cancelled" || displayStatus === "terminated"
          ? "text-danger"
          : "text-warning";

    row.innerHTML = `
            <td>${escapeHtml(ded.date || "-")}</td>
            <td>${escapeHtml(ded.employee_id || ded.employee || "-")}</td>
            <td>${escapeHtml(ded.employee_name || "-")}</td>
            <td>${formatCurrency(ded.amount)}</td>
            <td>${escapeHtml(ded.reason || "-")}</td>
            <td><span class="${statusClass}">${escapeHtml(statusLabel)}</span></td>
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
  const month = await appPrompt(
    "Enter month to approve (YYYY-MM):",
    new Date().toISOString().slice(0, 7),
    "Approve Deductions"
  );
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
  if (!(await appConfirm("Are you sure you want to delete this deduction?"))) return;

  try {
    showLoading(null, AppState.elements.globalSpinner); // Global spinner
    const res = await apiRequest(`/api/deductions/${id}/`, {
      method: "DELETE",
    });
    if (!res.success) throw new Error(res.message);

    showToast("Deduction deleted successfully", "success");
    await loadDeductions();
    updateDashboardStats();
  } catch (err) {
    showToast(`Failed to delete deduction: ${err.message}`, "error");
  } finally {
    hideLoading(null, AppState.elements.globalSpinner);
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
    AppState.sackedEmployees = list;
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
  if (!res.success) return;
  const d = res.data;

  preview.dataset.netSalary = d.outstanding_balance;
  document.getElementById("previewBaseSalary").textContent = formatCurrency(d.base_salary);
  document.getElementById("previewIOUDeductions").textContent = formatCurrency(d.iou_deduction);
  document.getElementById("previewDeductions").textContent = formatCurrency(d.other_deductions);
  document.getElementById("previewBonus").textContent = formatCurrency(d.bonus);
  document.getElementById("previewPrevBalance").textContent = formatCurrency(d.previous_balance);
  
  // New modal enhancement fields (initial render)
  document.getElementById("previewTotalPayable").textContent = formatCurrency(d.final_net_salary);
  document.getElementById("previewTotalPaid").textContent = formatCurrency(d.total_paid);
  document.getElementById("previewNetAmount").textContent = formatCurrency(d.outstanding_balance);
  if (document.getElementById('previewRemainingBalance')) {
    document.getElementById('previewRemainingBalance').textContent = formatCurrency(d.outstanding_balance);
  }

  if (document.getElementById('partialAmountDisplay')) document.getElementById('partialAmountDisplay').textContent = formatCurrency(0);
  if (document.getElementById('remainingBalanceDisplay')) document.getElementById('remainingBalanceDisplay').textContent = formatCurrency(d.outstanding_balance);

  document.getElementById("previewBank").textContent = employee.bank_name || "-";
  document.getElementById("previewAccount").textContent = employee.account_number || "-";
  preview.style.display = "block";
}

async function loadPaymentHistory() {
  const tbody =
    AppState.elements.historyTbody ||
    document.getElementById("historyTableBody");
  if (!tbody) return;

  try {
    const res = await apiRequest("/api/payments/");
    if (!res.success) throw new Error(res.message);

    const list = res.data?.results || res.data || [];
    AppState.payments = list;
    
    // AUTO-SHOW OTP MODAL if any payment needs Paystack OTP
    const pendingOtpPayment = list.find(p => p.status === 'pending_paystack_otp');
    // Only show OTP modal when backend still expects OTP.
    if (pendingOtpPayment && pendingOtpPayment.paystack_otp_required && !document.getElementById('paystackOtpModal')?.classList.contains('active')) {
        showPaystackOtpModal(
            pendingOtpPayment.transaction_reference, 
            pendingOtpPayment.paystack_transfer_code || ''
        );
    }

    
    tbody.innerHTML = "";

    if (!list.length) {
      tbody.innerHTML =
        '<tr><td colspan="8" class="text-center">No payment history found</td></tr>';
      return;
    }

    list.forEach((payment) => {
      const row = document.createElement("tr");
      const statusClass = getPaymentStatusClass(payment.status);

      const actionHtml = renderPaymentAction(payment);

      row.innerHTML = `
                <td>${escapeHtml(payment.payment_date || "-")}</td>
                <td>${escapeHtml(payment.employee_id || payment.employee || "-")}</td>
                <td>${escapeHtml(payment.employee_name || "-")}</td>
                <td>${escapeHtml(payment.bank_account || "-")}</td>
                <td>
                    <div style="line-height: 1.2;">
                        <span class="font-bold">${formatCurrency(payment.net_amount)}</span><br>
                        <small class="text-danger">IOU: ${formatCurrency(payment.iou_amount)}</small> | 
                        <small class="text-success">Bonus: ${formatCurrency(payment.bonus_amount)}</small> |
                        <small class="text-muted">Ded: ${formatCurrency(payment.total_deductions)}</small>
                    </div>
                </td>
                <td>${escapeHtml(payment.payment_method || "Paystack")}</td>
                <td>
                    <span class="${statusClass}">${escapeHtml(formatPaymentStatus(payment.status))}</span>
                    ${payment.is_partial ? `<br><small class="text-info">Paid: ${formatCurrency(payment.amount_paid)}</small>` : ""}
                    ${payment.remaining_balance > 0 ? `<br><small class="text-danger" title="Outstanding Balance">Bal: ${formatCurrency(payment.remaining_balance)}</small>` : ""}
                </td>
                <td>${actionHtml}</td>
            `;
      tbody.appendChild(row);
    });

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

async function viewPaymentDetail(paymentId) {
  let payment = (AppState.payments || []).find((p) => idsMatch(p.id, paymentId));
  if (!payment) {
    const res = await apiRequest(`/api/payments/${paymentId}/`);
    if (!res.success) {
      showToast(res.message || "Payment details could not be loaded", "error");
      return;
    }
    payment = res.data;
  }

  const content = document.getElementById("paymentDetailContent");
  if (!content) return;

  content.innerHTML = `
    <div class="detail-grid">
      <div class="detail-section">
        <h4>Transaction</h4>
        <table class="detail-table">
          <tr><td><strong>Reference</strong></td><td>${escapeHtml(payment.transaction_reference || "-")}</td></tr>
          <tr><td><strong>Status</strong></td><td>${escapeHtml(formatPaymentStatus(payment.status))}</td></tr>
          <tr><td><strong>Amount</strong></td><td>${formatCurrency(payment.amount_paid ?? payment.net_amount ?? 0)}</td></tr>
          <tr><td><strong>Payment Date</strong></td><td>${formatDate(payment.payment_date || payment.created_at)}</td></tr>
          <tr><td><strong>Recorded</strong></td><td>${formatDateTime(payment.created_at)}</td></tr>
          <tr><td><strong>Updated</strong></td><td>${formatDateTime(payment.updated_at)}</td></tr>
          <tr><td><strong>Transfer Code</strong></td><td>${escapeHtml(payment.paystack_transfer_code || "-")}</td></tr>
          <tr><td><strong>Gateway Status</strong></td><td>${escapeHtml(payment.paystack_last_status || "-")}</td></tr>
          <tr><td><strong>Failure Reason</strong></td><td>${escapeHtml(payment.failure_reason || "-")}</td></tr>
        </table>
      </div>
      <div class="detail-section">
        <h4>Payment Party</h4>
        <table class="detail-table">
          <tr><td><strong>Employee</strong></td><td>${escapeHtml(payment.employee_name || "-")} (${escapeHtml(payment.employee_id || "-")})</td></tr>
          <tr><td><strong>Recipient</strong></td><td>${escapeHtml(payment.recipient_name || "-")}</td></tr>
          <tr><td><strong>Bank</strong></td><td>${escapeHtml(payment.bank_account || "-")}</td></tr>
          <tr><td><strong>Method</strong></td><td>${escapeHtml(payment.payment_method || "-")}</td></tr>
          <tr><td><strong>Processed By</strong></td><td>${escapeHtml(payment.processed_by_name || "-")}</td></tr>
          <tr><td><strong>Approved By</strong></td><td>${escapeHtml(payment.hr_approved_by_name || "-")}</td></tr>
          <tr><td><strong>HR Approved</strong></td><td>${payment.hr_approved ? "Yes" : "No"}</td></tr>
        </table>
      </div>
      <div class="detail-section">
        <h4>Balance</h4>
        <table class="detail-table">
          <tr><td><strong>Paid Amount</strong></td><td>${formatCurrency(payment.amount_paid ?? payment.net_amount ?? 0)}</td></tr>
          <tr><td><strong>Remaining Balance</strong></td><td>${formatCurrency(payment.remaining_balance || 0)}</td></tr>
          <tr><td><strong>Partial</strong></td><td>${payment.is_partial ? "Yes" : "No"}</td></tr>
          <tr><td><strong>Previous Balance</strong></td><td>${formatCurrency(payment.previous_balance || 0)}</td></tr>
        </table>
      </div>
    </div>
  `;
  openModal("paymentDetailModal");
}

async function processBulkPayment(confirmed = false) {
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
    // If bulk partial payments enabled, collect per-employee partials
    const bulkPartialEnabled = document.getElementById('bulkPartialToggle')?.checked;
    const bulkDefaultAmount = parseFloat(document.getElementById('bulkDefaultPartialAmount')?.value || 0);
    const bulkDefaultReason = document.getElementById('bulkDefaultPartialReason')?.value || '';

    let body = { employee_ids: checked };
    if (bulkPartialEnabled) {
      const partials = [];
      for (const empId of checked) {
        const amtEl = document.querySelector(`.bulk-partial-amount[data-emp-id="${empId}"]`);
        const reasonEl = document.querySelector(`.bulk-partial-reason[data-emp-id="${empId}"]`);
        let amt = amtEl ? parseFloat(amtEl.value || 0) : 0;
        const reason = (reasonEl && reasonEl.value) || bulkDefaultReason || '';
        if (!amt && bulkDefaultAmount) amt = bulkDefaultAmount;
        if (amt && amt > 0) {
          partials.push({ employee_id: empId, partial_amount: Math.round(amt * 100) / 100, partial_reason: reason });
        }
      }
      if (partials.length === 0) {
        hideLoading(btn);
        showToast('No partial amounts provided. Either enter per-employee amounts or set a default.', 'warning');
        return;
      }
      body.partials = partials;
    }

    if (!confirmed) {
      AppState.pendingBulkPaymentPayload = { body, checked };
      await showBulkPaymentConfirmationPreview(body, checked);
      return;
    }

    const res = await apiRequest('/api/payments/bulk_payment/', {
      method: 'POST',
      body,
    });

    if (!res.success) {
      throw new Error(sanitizePaymentError(res.message || "Bulk payment failed"));
    }

    const results = res.data || {};
    const payments = results.payments || [];
    const errors = results.errors || [];

    if (results.internal_otp_required) {
        AppState.currentPaymentReference = results.reference;
        showOTPModal(
          "Authorize Bulk Payment",
          "A security verification code has been sent to your email. Enter it to authorize this bulk payment."
        );
        closeModal("bulkPaymentModal");
        showToast(`${results.message || "Internal OTP sent"} ${formatBulkPaymentSummary(results, checked.length)}`, "info");
        return;
    }

    // Handle Paystack OTP requirement for bulk transfer after internal OTP.
    if (res.data.paystack_otp_required) {
        showPaystackOtpModal(res.data.reference, res.data.paystack_transfer_code);
        closeModal("bulkPaymentModal");
        return;
    }

    // Show initial summary
    let message = formatBulkPaymentSummary(results, checked.length);
    if (errors.length > 0) {
      console.warn("Bulk payment employee-level failures:", errors);
      message += ` Some payments need attention.`;
    }
    showToast(message, (results.summary?.successful || payments.length) > 0 ? "success" : "error");

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
    showToast(sanitizePaymentError(err.message || "Bulk payment failed"), "error");
  } finally {
    hideLoading(btn);
  }
}

async function showBulkPaymentConfirmationPreview(body, checked) {
  const content = document.getElementById("bulkPaymentPreviewContent");
  if (!content) return;

  const previewRes = await apiRequest("/api/payments/bulk_preview/", {
    method: "POST",
    body,
  });

  const selectedRows = checked.map((employeeId) => {
    const employee = AppState.employees.find((emp) => idsMatch(emp.id, employeeId)) || {};
    const partial = (body.partials || []).find((item) => idsMatch(item.employee_id, employeeId));
    const netText = document.getElementById(`net-${employeeId}`)?.textContent || formatCurrency(employee.salary || 0);
    return {
      employee_id: employee.employee_id || "-",
      name: employee.name || "-",
      bank: `${employee.bank_name || "-"} - ${employee.account_number || "-"}`,
      amount: partial?.partial_amount ? formatCurrency(partial.partial_amount) : netText,
      type: partial?.partial_amount ? "Partial" : "Full",
      reason: partial?.partial_reason || "Salary payment",
      warning: !employee.bank_code ? "Missing bank code" : "",
    };
  });

  const warnings = selectedRows.filter((row) => row.warning);
  const totalAmount = previewRes.success ? previewRes.data.total_amount : 0;
  const totalCount = previewRes.success ? previewRes.data.count : selectedRows.length;

  content.innerHTML = `
    <div class="summary-grid">
      <div class="summary-card"><h4>Employees</h4><p>${totalCount}</p></div>
      <div class="summary-card"><h4>Total</h4><p>${formatCurrency(totalAmount)}</p></div>
      <div class="summary-card"><h4>Payment Type</h4><p>Salary</p></div>
      <div class="summary-card"><h4>Mode</h4><p>${body.partials?.length ? "Full & Partial" : "Full"}</p></div>
    </div>
    ${warnings.length ? `<div class="alert alert-warning"><i class="fas fa-triangle-exclamation"></i> ${warnings.length} selected employee(s) need attention before Paystack can process successfully.</div>` : ""}
    <div class="table-responsive">
      <table class="data-table">
        <thead>
          <tr>
            <th>Employee</th>
            <th>Bank</th>
            <th>Payment</th>
            <th>Amount</th>
            <th>Reason</th>
            <th>Warning</th>
          </tr>
        </thead>
        <tbody>
          ${selectedRows.map((row) => `
            <tr>
              <td>${escapeHtml(row.employee_id)}<br><small>${escapeHtml(row.name)}</small></td>
              <td>${escapeHtml(row.bank)}</td>
              <td>${escapeHtml(row.type)}</td>
              <td>${escapeHtml(row.amount)}</td>
              <td>${escapeHtml(row.reason)}</td>
              <td>${row.warning ? `<span class="text-warning">${escapeHtml(row.warning)}</span>` : "-"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
  openModal("bulkPaymentPreviewModal");
}

async function confirmBulkPaymentSubmission() {
  if (!AppState.pendingBulkPaymentPayload) {
    showToast("Bulk payment preview has expired. Please review again.", "warning");
    closeModal("bulkPaymentPreviewModal");
    return;
  }
  closeModal("bulkPaymentPreviewModal");
  await processBulkPayment(true);
}

async function startBulkPaymentPolling(
  payments,
  maxAttempts = 30,
  interval = 3000,
) {
  let attempts = 0;
  let currentDelay = interval;
  const total = payments.length;
  if (AppState.bulkPollInterval) {
    clearTimeout(AppState.bulkPollInterval);
    AppState.bulkPollInterval = null;
  }

  AppState.isPolling = true;
  showLoading(null, AppState.elements.globalSpinner);
  updateLoadingProgress(`Processing Bulk Payments: 0% (0/${total})`);

  const stopPolling = async () => {
    AppState.isPolling = false;
    if (AppState.bulkPollInterval) {
      clearTimeout(AppState.bulkPollInterval);
      AppState.bulkPollInterval = null;
    }
    updateLoadingProgress("Loading...");
    hideLoading(null, AppState.elements.globalSpinner);
    await loadDashboard();
  };

  const poll = async () => {
    attempts++;
    const pending = payments.filter((p) => !p.done);

    try {
      for (const p of pending) {
        const res = await apiRequest(`/api/payments/verify-payment/${p.reference}/`);
        if (
          res.success &&
          (res.data.is_completed || ["failed", "pending_paystack_otp"].includes(res.data.payment_status))
        ) {
          p.done = true;
          if (res.data.payment_status === "pending_paystack_otp") {
            showPaystackOtpModal(p.reference, res.data.paystack_transfer_code || "");
            showToast(`${p.employee_name}: Paystack OTP required`, "warning");
          } else {
            showToast(
              `${p.employee_name}: ${res.data.payment_status}`,
              res.data.is_completed ? "success" : "error",
            );
          }
        }
      }

      const completedCount = payments.filter((p) => p.done).length;
      const percentage = Math.round((completedCount / total) * 100);
      updateLoadingProgress(
        `Processing Bulk Payments: ${percentage}% (${completedCount}/${total})`,
      );

      if (payments.every((p) => p.done) || attempts >= maxAttempts) {
        await stopPolling();
        return;
      }

      currentDelay = Math.min(currentDelay * 1.5, 30000);
      AppState.bulkPollInterval = setTimeout(poll, currentDelay);
    } catch (err) {
      console.error('Bulk payment polling error:', err);
      showToast('Bulk payment status polling failed. Please sync manually.', 'error');
      await stopPolling();
    }
  };

  AppState.bulkPollInterval = setTimeout(poll, currentDelay);
}

async function initiateIndividualPayment(empId) {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const employee = AppState.employees.find((e) => String(e.id) === String(empId));
    const outstanding = employee?.salary_breakdown?.outstanding_balance || 0;

    const existingPayment = AppState.payments?.find(
        (p) => String(p.employee) === String(empId) && p.payment_month === currentMonth,
    );

    if (existingPayment) {
        const status = existingPayment.status;
        if (outstanding <= 0) {
            showToast("Salary already paid for this month", "info");
            return;
        }
        if (['processing', 'pending', 'pending_hr'].includes(status)) {
            showToast(`Payment already ${status}. Checking status...`, "info");
            startPaymentStatusPolling(existingPayment.transaction_reference);
            return;
        }
        if (status !== 'failed') {
            showToast(`Payment already initiated (${status}). Cannot re-initiate.`, "warning");
            if (status === 'pending_paystack_otp') {
                showPaystackOtpModal(
                    existingPayment.transaction_reference,
                    existingPayment.paystack_transfer_code || '',
                );
            }
            return;
        }
    }

    const btn = document.querySelector(
        `button[onclick="initiateIndividualPayment('${empId}')"]`,
    );

    try {
        showLoading(btn);

        const isPartial = document.getElementById('isPartialPaymentIndividual')?.checked;
        const body = { employee_id: empId };
        if (isPartial) {
            const amt = parseFloat(document.getElementById('partialAmountIndividual')?.value || 0);
            const reason = document.getElementById('partialReasonIndividual')?.value || '';
            if (!amt || amt <= 0) {
                showToast('Enter a valid partial amount', 'error');
                return;
            }
            body.partial = true;
            body.partial_amount = Math.round(amt * 100) / 100;
            body.partial_reason = reason;
        }

        if (employee && (!employee.bank_code || !employee.account_number)) {
            showToast('Employee bank details incomplete. Please update account before initiating payment.', 'warning', 8000);
            try {
                editEmployee(empId);
            } catch (e) {
                console.warn('Could not open employee edit modal', e);
            }
            return;
        }

        const res = await apiRequest('/api/payments/initiate_payment/', {
            method: 'POST',
            body,
        });

        if (!res.success) {
            const detail = sanitizePaymentError(formatApiError(res.data, res.message || "Failed to initiate payment"));
            const err = new Error(detail || "Failed to initiate payment");
            err.raw = res;
            throw err;
        }

        const reference = res.data.reference;
        AppState.currentPaymentReference = reference;

        if (res.data.internal_otp_required) {
            showOTPModal(
              "Authorize Payment",
              "A security verification code has been sent to your email. Enter it to authorize this payment."
            );
            showToast(res.data.message || "Internal OTP sent", "info");
            return;
        }

        if (res.data.paystack_otp_required) {
            showPaystackOtpModal(reference, res.data.paystack_transfer_code);
            return;
        }

        showToast(res.data.message || "Payment initiated", "success");
        await loadPaymentHistory();
        await loadEmployees();
        await updateDashboardStats();
        startPaymentStatusPolling(reference);
    } catch (err) {
        let errorMsg = sanitizePaymentError(err.message || "Failed to initiate payment");

        if (errorMsg.includes("bank_code is missing")) {
            showToast("Bank Code missing. Redirecting to edit employee record...", "warning", 5000);
            setTimeout(() => editEmployee(empId), 1500);
            return;
        }

        showToast(errorMsg, "error", 8000);
    } finally {
        hideLoading(btn);
    }
}


// NEW: Show Paystack OTP modal
function showPaystackOtpModal(reference, transferCode) {
    // GUARD: Don't show modal without a valid reference
    if (!reference) {
        console.warn("showPaystackOtpModal called without reference");
        return;
    }

    const modal = document.getElementById("paystackOtpModal");
    const input = document.getElementById("paystackOtpInput");
    if (!modal) return;

    // Ensure OTP modal is always above other modals (z-index + stacking context hardening)
    // This also prevents it from being hidden "behind" the individual payment modal.
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.right = '0';
    modal.style.bottom = '0';
    // Ensure this modal always sits above any other modal stacking context
    modal.style.zIndex = '200000';
    modal.style.display = "flex";
    modal.classList.add("active");

    // Bring to front by moving to document.body and forcing a full z-index top layer.
    // Also reduce any other open modal z-index briefly so stacking contexts don't fight.
    const openModals = document.querySelectorAll('.modal.active');
    openModals.forEach(m => {
      if (m !== modal) m.style.zIndex = '999';
    });

    if (modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }
    modal.style.zIndex = String(Math.max(20000, 1000 + openModals.length + 1));


    AppState.currentPaymentReference = reference;
    AppState.currentPaystackTransferCode = transferCode;

    if (input) {
        input.value = "";
        input.focus();
    }
}

function isModalActive(id) {
  const el = document.getElementById(id);
  return !!(el && el.classList.contains('active') && el.style.display !== 'none');
}

function showPaystackOtpResendUI(opts = {}) {
    const { canResend = true } = opts;
    const resendBtn = document.getElementById('resendPaystackOtpBtn');
    if (!resendBtn) return;
    resendBtn.disabled = !canResend;
    resendBtn.style.opacity = resendBtn.disabled ? 0.6 : 1;
}

async function resendPaystackOtp(e) {
    e?.preventDefault?.();

    const reference = AppState.currentPaymentReference;
    if (!reference) {
        showToast('Reference missing. Start payment again.', 'warning');
        return;
    }

    const btn = document.getElementById('resendPaystackOtpBtn');
    try {
        showLoading(btn);
        const res = await apiRequest('/api/payments/resend_otp/', {
            method: 'POST',
            body: { reference }
        });
        if (!res.success) throw new Error(res.message || 'Failed to resend OTP');

        showToast(res.data?.message || 'OTP resent successfully', 'success');

        // Reset input so user retypes OTP
        const input = document.getElementById('paystackOtpInput');
        if (input) {
            input.value = '';
            input.focus();
        }

        // Expire current OTP UI locally and disable resend briefly
        showPaystackOtpResendUI({ canResend: false });
        startPaystackOtpCountdown(30);
    } catch (err) {
        showToast(err.message || 'Failed to resend OTP', 'error');
    } finally {
        hideLoading(btn);
    }
}

let paystackOtpCountdownInterval = null;
function startPaystackOtpCountdown(seconds = 30) {
    const timerEl = document.getElementById('paystackOtpTimer');
    if (!timerEl) return;

    let time = Number(seconds) || 30;
    timerEl.textContent = time;

    const resendBtn = document.getElementById('resendPaystackOtpBtn');
    if (resendBtn) resendBtn.disabled = true;

    if (paystackOtpCountdownInterval) clearInterval(paystackOtpCountdownInterval);
    paystackOtpCountdownInterval = setInterval(() => {
        time -= 1;
        timerEl.textContent = Math.max(0, time);
        if (time <= 0) {
            clearInterval(paystackOtpCountdownInterval);
            paystackOtpCountdownInterval = null;
            showPaystackOtpResendUI({ canResend: true });
            showToast('OTP expired. You can resend now.', 'warning');
        }
    }, 1000);
}

function closePaystackOtpModal() {
    stopPaymentPolling();
    const modal = document.getElementById('paystackOtpModal');
    if (!modal) return;

    modal.classList.remove('active');
    modal.style.display = 'none';

    // Expire OTP locally
    if (paystackOtpCountdownInterval) {
        clearInterval(paystackOtpCountdownInterval);
        paystackOtpCountdownInterval = null;
    }

    const input = document.getElementById('paystackOtpInput');
    if (input) {
        input.value = '';
    }

    AppState.currentPaymentReference = null;
    AppState.currentPaystackTransferCode = null;

    // Disable resend until next valid showPaystackOtpModal
    showPaystackOtpResendUI({ canResend: false });
}

// NEW: Handle Paystack OTP submission
async function submitPaystackOtp(e) {
    e.preventDefault();

    const otp = document.getElementById("paystackOtpInput")?.value.trim();
    const reference = AppState.currentPaymentReference;

    if (!reference) {
        showToast("Reference missing. Start payment again.", "warning");
        return;
    }

    // If OTP input is empty, use the normal GET polling endpoint.\r\n    if (!otp) {\r\n        closeModal("paystackOtpModal");\r\n        startPaymentStatusPolling(reference);\r\n        return;\r\n    }

    const btn = e.target.querySelector('button[type="submit"]');

    try {
        showLoading(btn);

        // Correct endpoint for Paystack OTP finalization
        const res = await apiRequest("/api/payments/finalize-transfer/", {
            method: "POST",
            body: {
                reference: reference,
                paystack_otp: otp
            }
        });

        if (res.success) {
            if (res.data?.payment_completed) {
                stopPaymentPolling();
                showToast("Payment completed successfully!", "success");
                closeModal("paystackOtpModal");
                await loadPaymentHistory();
                await updateDashboardStats();
            } else if (res.data?.payment_processing) {
                showToast("Payment is processing. You'll be notified when complete.", "info");
                closeModal("paystackOtpModal");
                startPaymentStatusPolling(reference);
            } else {
                // fallback: poll
                closeModal("paystackOtpModal");
                startPaymentStatusPolling(reference);
            }
        } else {
            if (res.data?.paystack_otp_required) {
                showToast(sanitizePaymentError(res.message || "Invalid OTP. Please try again."), "error");
                document.getElementById("paystackOtpInput").value = "";
                document.getElementById("paystackOtpInput").focus();
            } else {
                showToast(sanitizePaymentError(res.message || "OTP verification failed"), "error");
                closeModal("paystackOtpModal");
            }
        }
    } catch (err) {
        showToast(sanitizePaymentError(err.message || "Failed to verify OTP"), "error");
    } finally {
        hideLoading(btn);
    }
}


async function startPaymentStatusPolling(
  reference,
  maxAttempts = 30,
  interval = 3000,
) {
  let attempts = 0;
  let currentDelay = interval;

  if (AppState.paymentPollTimeout) {
    clearTimeout(AppState.paymentPollTimeout);
    AppState.paymentPollTimeout = null;
  }

  const updatePaymentPreviewFromPolling = (data) => {
    const preview = document.getElementById('paymentPreview');
    if (!preview) return;

    // Ensure preview is visible once polling starts
    preview.style.display = 'block';

    // Backend fields: total_amount_due, amount_paid, outstanding_balance, payment_status
    const totalDue = data.total_amount_due ?? data.net_amount;
    const amountPaid = data.amount_paid ?? data.total_paid;
    const outstanding =
      data.outstanding_balance ??
      data.remaining_balance ??
      data.outstanding_balance;

    // New modal enhancement fields
    if (typeof totalDue !== 'undefined' && document.getElementById('previewTotalPayable')) {
      document.getElementById('previewTotalPayable').textContent = formatCurrency(totalDue);
    }

    if (typeof amountPaid !== 'undefined' && document.getElementById('previewTotalPaid')) {
      document.getElementById('previewTotalPaid').textContent = formatCurrency(amountPaid);
    }

    // Outstanding + Remaining are the same figure in this model
    if (typeof outstanding !== 'undefined' && document.getElementById('previewNetAmount')) {
      document.getElementById('previewNetAmount').textContent = formatCurrency(outstanding);
    }
    if (typeof outstanding !== 'undefined' && document.getElementById('previewRemainingBalance')) {
      document.getElementById('previewRemainingBalance').textContent = formatCurrency(outstanding);
    }

    // Payment status text
    if (document.getElementById('previewPaymentStatus')) {
      document.getElementById('previewPaymentStatus').textContent =
        String(data.payment_status || data.payment_status_text || '-');
    }

    // Backward-compatible (older nodes if present)
    const partialDisplay = document.getElementById('partialAmountDisplay');
    const remainingDisplay = document.getElementById('remainingBalanceDisplay');
    if (partialDisplay && typeof amountPaid !== 'undefined') partialDisplay.textContent = formatCurrency(amountPaid);
    if (remainingDisplay && typeof outstanding !== 'undefined') remainingDisplay.textContent = formatCurrency(outstanding);
  };


  const poll = async () => {
    attempts++; // No spinner here, as it's a background poll
    const res = await apiRequest(`/api/payments/verify-payment/${reference}/`);

    if (res.success && res.data) {
      updatePaymentPreviewFromPolling(res.data);

      if (res.data.payment_status === 'pending_paystack_otp') {
        showPaystackOtpModal(reference, res.data.paystack_transfer_code || "");
        showToast("Paystack OTP required", "warning");
        stopPaymentPolling();
        return;
      }

      if (res.data.is_completed || res.data.payment_status === 'failed') {
        showToast(
          `Payment ${res.data.payment_status}`,
          res.data.is_completed ? 'success' : 'error',
        );
        await loadDashboard();
        // Ensure modal polling stops
        stopPaymentPolling();
        return;
      }
    }

    if (attempts < maxAttempts) {
      currentDelay = Math.min(currentDelay * 1.5, 30000);
      if (AppState.paymentPollTimeout) clearTimeout(AppState.paymentPollTimeout);
      AppState.paymentPollTimeout = setTimeout(poll, currentDelay);
    } else {
      showToast("Payment is still processing. Use Sync to refresh status.", "info");
      await loadDashboard();
      stopPaymentPolling();
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
    } else {
      showToast(res.message || "Failed to sync payments. Please try again.", "error");
    }
  } catch (err) {
    console.error('Sync payments error:', err);
    showToast(err.message || "Failed to sync payments. Please try again.", "error");
  } finally {
    hideLoading(btn);
  }
}

// ADD this helper to stop polling when modal closes:
function stopPaymentPolling() {
  if (AppState.paymentPollTimeout) {
    clearTimeout(AppState.paymentPollTimeout);
    AppState.paymentPollTimeout = null;
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

  const partials = [];
  const bulkPartialEnabled = document.getElementById('bulkPartialToggle')?.checked;
  const bulkDefaultAmount = parseFloat(document.getElementById('bulkDefaultPartialAmount')?.value || 0);
  const bulkDefaultReason = document.getElementById('bulkDefaultPartialReason')?.value || '';

  if (bulkPartialEnabled) {
    for (const empId of selectedIds) {
      const amtEl = document.querySelector(`.bulk-partial-amount[data-emp-id="${empId}"]`);
      const reasonEl = document.querySelector(`.bulk-partial-reason[data-emp-id="${empId}"]`);
      let amt = amtEl ? parseFloat(amtEl.value || 0) : 0;
      const reason = (reasonEl && reasonEl.value) || bulkDefaultReason || '';
      if (!amt && bulkDefaultAmount) amt = bulkDefaultAmount;
      if (amt && amt > 0) {
        partials.push({ employee_id: empId, partial_amount: Math.round(amt * 100) / 100, partial_reason: reason });
      }
    }
  }

  const body = { employee_ids: selectedIds };
  if (partials.length) body.partials = partials;

  const res = await apiRequest("/api/payments/bulk_preview/", {
    method: "POST",
    body,
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
                    <button type="button" class="btn btn-sm btn-info" onclick="viewEmployeeDetail('${record.employee}')">
                        <i class="fas fa-eye"></i> View
                    </button>
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
  if (!(await appConfirm("Are you sure you want to reinstate this employee?"))) return;

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
    const params = {
      search: document.getElementById("notificationSearch")?.value || "",
      type: document.getElementById("notificationTypeFilter")?.value || "",
      is_read: document.getElementById("notificationReadFilter")?.value || "",
      ordering: "-created_at",
    };
    Object.keys(params).forEach((key) => {
      if (!params[key]) delete params[key];
    });
    const res = await apiRequest(buildUrl("/api/notifications/", params));
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

      item.className = `notification ${type} ${notification.is_read ? "is-read" : "is-unread"}`;
      item.tabIndex = 0;
      item.onclick = () => viewNotificationDetail(notification.id);
      item.innerHTML = `
                <strong>${escapeHtml(type.charAt(0).toUpperCase() + type.slice(1))}</strong>
                ${notification.is_read ? '<span class="badge badge-secondary">Read</span>' : '<span class="badge badge-warning">Unread</span>'}
                <p>${escapeHtml(notification?.message || "")}</p>
                ${notification.employee_id ? `<small class="text-muted">Employee: ${escapeHtml(notification.employee_id)}</small>` : ""}
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

async function viewNotificationDetail(notificationId) {
  let notification = (AppState.notifications || []).find((item) => idsMatch(item.id, notificationId));
  if (!notification) {
    const res = await apiRequest(`/api/notifications/${notificationId}/`);
    if (!res.success) {
      showToast(res.message || "Notification could not be loaded", "error");
      return;
    }
    notification = res.data;
  }

  const content = document.getElementById("notificationDetailContent");
  if (!content) return;
  content.innerHTML = `
    <div class="detail-section">
      <table class="detail-table">
        <tr><td><strong>Type</strong></td><td>${escapeHtml(notification.type || "-")}</td></tr>
        <tr><td><strong>Status</strong></td><td>${notification.is_read ? "Read" : "Unread"}</td></tr>
        <tr><td><strong>Time</strong></td><td>${formatDateTime(notification.created_at)}</td></tr>
        <tr><td><strong>User</strong></td><td>${escapeHtml(notification.user_name || "-")}</td></tr>
        <tr><td><strong>Employee</strong></td><td>${escapeHtml(notification.employee_id || "-")}</td></tr>
      </table>
      <p class="notification-detail-message">${escapeHtml(notification.message || "")}</p>
    </div>
  `;
  openModal("notificationDetailModal");

  if (!notification.is_read) {
    const res = await apiRequest(`/api/notifications/${notification.id}/mark_read/`, { method: "POST" });
    if (res.success) {
      notification.is_read = true;
      await loadNotifications();
    }
  }
}

async function exportNotificationHistory() {
  let password = "";
  const isAdmin =
    AppState.currentUser?.is_superuser ||
    AppState.currentUser?.role === "admin" ||
    AppState.currentUser?.is_notification_admin;
  if (!isAdmin) {
    password = await appPrompt("Enter your password to download your notification history:", "", "Export Notifications");
    if (!password) return;
  }

  try {
    const response = await fetch(`${CONFIG.API_BASE_URL}/api/notifications/export_history/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(AppState.accessToken ? { Authorization: `Bearer ${AppState.accessToken}` } : {}),
        ...(getCookie("csrftoken") ? { "X-CSRFToken": getCookie("csrftoken") } : {}),
      },
      body: JSON.stringify({ password }),
    });
    if (!response.ok) throw new Error("Notification export failed");
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "notification_history.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    showToast("Notification history download started", "success");
  } catch (err) {
    showToast(err.message || "Failed to export notifications", "error");
  }
}

// ==========================================
// REMINDERS
// ==========================================

async function loadReminders() {
  const tbody = document.getElementById("remindersTableBody");
  if (!tbody) return;

  const params = {
    search: document.getElementById("reminderSearch")?.value || "",
    is_complete: document.getElementById("reminderStatusFilter")?.value || "",
    ordering: "remind_at",
  };
  Object.keys(params).forEach((key) => {
    if (!params[key]) delete params[key];
  });

  try {
    const res = await apiRequest(buildUrl("/api/reminders/", params));
    if (!res.success) throw new Error(res.message);
    const list = res.data?.results || res.data || [];
    AppState.reminders = list;
    tbody.innerHTML = "";

    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center">No reminders found</td></tr>';
      return;
    }

    list.forEach((reminder) => {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>${formatDateTime(reminder.remind_at)}</td>
        <td>
          <strong>${escapeHtml(reminder.title || "-")}</strong><br>
          <small>${escapeHtml(reminder.purpose || "")}</small>
        </td>
        <td><span class="badge ${reminder.is_complete ? "badge-success" : "badge-warning"}">${reminder.is_complete ? "Complete" : "Open"}</span></td>
        <td>
          ${reminder.is_complete ? "-" : `<button type="button" class="btn btn-sm btn-success" onclick="completeReminder('${reminder.id}')"><i class="fas fa-check"></i> Complete</button>`}
        </td>
      `;
      tbody.appendChild(row);
    });
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-danger">Failed to load reminders</td></tr>';
    showToast(err.message || "Failed to load reminders", "error");
  }
}

function showReminderModal() {
  const form = document.getElementById("reminderForm");
  if (form) form.reset();
  const input = document.getElementById("reminderAt");
  if (input) {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    soon.setMinutes(soon.getMinutes() - soon.getTimezoneOffset());
    input.value = soon.toISOString().slice(0, 16);
  }
  openModal("reminderModal");
}

async function handleReminderSubmit(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  const title = document.getElementById("reminderTitle")?.value.trim();
  const purpose = document.getElementById("reminderPurpose")?.value.trim();
  const remindAt = document.getElementById("reminderAt")?.value;

  if (!title || !purpose || !remindAt) {
    showToast("Reminder title, date/time, and purpose are required", "warning");
    return;
  }

  try {
    showLoading(btn);
    const res = await apiRequest("/api/reminders/", {
      method: "POST",
      body: {
        title,
        purpose,
        remind_at: new Date(remindAt).toISOString(),
      },
    });
    if (!res.success) throw new Error(res.message || "Failed to save reminder");
    closeModal("reminderModal");
    showToast("Reminder created", "success");
    await loadReminders();
  } catch (err) {
    showToast(err.message || "Failed to save reminder", "error");
  } finally {
    hideLoading(btn);
  }
}

async function completeReminder(reminderId) {
  const res = await apiRequest(`/api/reminders/${reminderId}/complete/`, { method: "POST" });
  if (res.success) {
    showToast("Reminder marked complete", "success");
    await loadReminders();
    await loadNotifications();
  } else {
    showToast(res.message || "Failed to update reminder", "error");
  }
}

// ==========================================
// MODAL FUNCTIONS
// ==========================================

function showIndividualPaymentModal() {
  populateEmployeeSelect("paymentEmployee");
  document.getElementById("paymentPreview").style.display = "none";
  openModal("individualPaymentModal");
}

async function goToPaymentsForEmployee(employeeId) {
  await showSection("payments");
  showIndividualPaymentModal();
  const select = document.getElementById("paymentEmployee");
  if (select && employeeId) {
    select.value = String(employeeId);
    await updatePaymentPreview();
  }
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
    const pendingApprovals = stats.pending_approvals || 0;
    if (pendingApprovals > 0) {
      pendingAlert.classList.remove("hidden");
      document.getElementById("pendingCount").textContent =
        pendingApprovals;
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
  const amount = await appPrompt(
    "Enter available amount to pay (Leave blank for full amount):",
    "",
    "Partial Payment"
  );
  if (amount === null) {
    return; // user cancelled
  }
  const trimmed = String(amount).trim();
  const body = { employee_id: empId };
  let successMessage = "Payment initiated";

  if (trimmed !== "") {
    const parsed = parseFloat(trimmed);
    if (Number.isNaN(parsed) || parsed <= 0) {
      showToast("Enter a valid amount", "error");
      return;
    }
    body.custom_amount = Math.round(parsed * 100) / 100;
    successMessage = `Partial payment of ${formatCurrency(body.custom_amount)} initiated`;
  }

  const res = await apiRequest("/api/payments/initiate_payment/", {
    // No spinner here, caller manages
    method: "POST",
    body,
  });
  if (res.success) {
    showToast(successMessage, "success");
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
  populatePaymentsTable();
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
          <td id="net-${emp.id}">${formatCurrency(netSalary)}</td>
          <td id="iou-${emp.id}">-</td>
          <td id="other-${emp.id}">-</td>
          <td id="adjustments-${emp.id}">-</td>
          <td id="previous-${emp.id}">-</td>
          <td><input type="number" class="bulk-partial-amount form-control" data-emp-id="${emp.id}" disabled min="0" step="0.01" placeholder="₦" onchange="updateBulkTotal()"></td>
          <td><input type="text" class="bulk-partial-reason form-control" data-emp-id="${emp.id}" disabled placeholder="Reason" onchange="updateBulkTotal()"></td>
        `;
    tbody.appendChild(row);
  });

  // Fetch detailed breakdowns for each visible employee in parallel
  (async () => {
    try {
      const promises = activeEmployees.map((emp) =>
        apiRequest(`/api/employees/${emp.id}/net-salary/`, { method: 'GET' }),
      );
      const results = await Promise.all(promises);
      results.forEach((res, idx) => {
        const emp = activeEmployees[idx];
        if (res && res.success && res.data) {
          const d = res.data;
          const iouEl = document.getElementById(`iou-${emp.id}`);
          const otherEl = document.getElementById(`other-${emp.id}`);
          const adjustmentsEl = document.getElementById(`adjustments-${emp.id}`);
          const previousEl = document.getElementById(`previous-${emp.id}`);
          const netEl = document.getElementById(`net-${emp.id}`);
          if (iouEl) {
              iouEl.textContent = formatCurrency(d.iou_deduction);
              iouEl.className = 'text-danger';
          }
          if (otherEl) {
              otherEl.textContent = formatCurrency(d.other_deductions);
              otherEl.className = 'text-danger';
          }
          if (adjustmentsEl) {
              adjustmentsEl.textContent = formatCurrency(d.bonus);
              adjustmentsEl.className = 'text-success';
          }
          if (previousEl) {
              previousEl.innerHTML = `${formatCurrency(d.previous_balance)}${d.previous_balance > 0 ? '<br><small class="text-info">Prev. Bal</small>' : ''}`;
              previousEl.className = 'text-info';
          }
          if (netEl) {
              netEl.textContent = formatCurrency(d.outstanding_balance);
              netEl.classList.add('font-bold');
          }
        }
      });
    } catch (e) {
      console.warn('Failed to load per-employee salary breakdowns', e);
    } finally {
      updateBulkTotal();
    }
  })();
}

// ==========================================
// IOU & BONUS MANAGEMENT
// ==========================================

async function loadAdjustments(type, search = "", status = "") {
    const tbodyId = type === 'iou' ? 'iouTableBody' : 'bonusTableBody';
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    // Reset select all checkbox
    const selectAllId = type === 'iou' ? 'selectAllIOU' : 'selectAllBonus';
    const selectAll = document.getElementById(selectAllId);
    if (selectAll) selectAll.checked = false;

    try {
        let url = `/api/salary-adjustments/?type=${type}`;
        if (search) url += `&search=${encodeURIComponent(search)}`;
        if (status) url += `&status=${status}`;

        const res = await apiRequest(url);
        if (!res.success) throw new Error(res.message);
        
        const list = res.data?.results || res.data || [];
        tbody.innerHTML = "";

        if (!list.length) {
            tbody.innerHTML = `<tr><td colspan="8" class="text-center">No ${type.toUpperCase()} records found</td></tr>`;
            return;
        }

        list.forEach(adj => {
            const row = document.createElement("tr");
            const canApprove = adj.status === 'pending';
            row.innerHTML = `
                <td>${canApprove ? `<input type="checkbox" class="${type}-checkbox" value="${adj.id}">` : ''}</td>
                <td>${formatDate(adj.date_added)}</td>
                <td>${escapeHtml(adj.employee_name)}</td>
                <td>${formatCurrency(adj.amount)}</td>
                <td>${escapeHtml(adj.reason)}</td>
                <td><span class="badge status-${adj.status}">${adj.status.toUpperCase()}</span></td>
                <td>${escapeHtml(adj.added_by_name || 'System')}</td>
                <td>
                    ${adj.status === 'pending' ? `
                        <button class="btn btn-sm btn-success" onclick="approveAdjustment('${adj.id}', '${type}')">Approve</button>
                        <button class="btn btn-sm btn-danger" onclick="deleteAdjustment('${adj.id}', '${type}')">Delete</button>
                    ` : '-'}
                </td>
            `;
            tbody.appendChild(row);
        });
    } catch (err) {
        showToast(`Failed to load ${type}s`, "error");
    }
}

async function approveAdjustment(id, type) {
    if (!(await appConfirm(`Approve this ${type}?`))) return;
    const res = await apiRequest(`/api/salary-adjustments/${id}/approve/`, { method: 'POST' });
    if (res.success) {
        showToast(`${type.toUpperCase()} approved`, "success");
        loadAdjustments(type);
        updateDashboardStats();
    }
}

async function deleteAdjustment(id, type) {
    if (!(await appConfirm(`Delete this ${type}?`))) return;
    const res = await apiRequest(`/api/salary-adjustments/${id}/`, { method: 'DELETE' });
    if (res.success) {
        showToast(`${type.toUpperCase()} deleted`, "success");
        loadAdjustments(type);
        updateDashboardStats();
    }
}

async function searchAdjustments(type) {
    const search = document.getElementById(`${type}Search`)?.value || "";
    const status = document.getElementById(`${type}StatusFilter`)?.value || "";
    loadAdjustments(type, search, status);
}

function showAddAdjustmentModal(type) {
    const form = document.getElementById("addAdjustmentForm");
    if (form) form.reset();
    
    document.getElementById("adjustmentType").value = type;
    document.getElementById("adjustmentModalTitle").textContent = type === 'iou' ? 'Add New IOU' : 'Add New Bonus';
    document.getElementById("adjustmentDate").value = new Date().toISOString().split('T')[0];
    
    populateEmployeeSelect("adjustmentEmployee");
    openModal("addAdjustmentModal");
}

async function handleAddAdjustment(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    
    const type = document.getElementById("adjustmentType").value;
    const payload = {
        employee: document.getElementById("adjustmentEmployee").value,
        amount: parseFloat(document.getElementById("adjustmentAmount").value),
        date_added: document.getElementById("adjustmentDate").value,
        reason: document.getElementById("adjustmentReason").value,
        type: type
    };
    
    if (!payload.employee || !payload.amount || !payload.date_added || !payload.reason) {
        showToast("Please fill all required fields", "warning");
        return;
    }
    
    try {
        showLoading(btn);
        const res = await apiRequest("/api/salary-adjustments/", {
            method: "POST",
            body: payload
        });
        
        if (res.success) {
            showToast(`${type.toUpperCase()} added successfully`, "success");
            closeModal("addAdjustmentModal");
            loadAdjustments(type);
            updateDashboardStats();
        } else {
            showToast(res.message || "Failed to add adjustment", "error");
        }
    } catch (err) {
        showToast("An error occurred", "error");
    } finally {
        hideLoading(btn);
    }
}

function toggleAllAdjustments(type) {
    const selectAllId = type === 'iou' ? 'selectAllIOU' : 'selectAllBonus';
    const selectAll = document.getElementById(selectAllId);
    const checkboxes = document.querySelectorAll(`.${type}-checkbox`);
    if (selectAll) {
        checkboxes.forEach(cb => cb.checked = selectAll.checked);
    }
}

async function bulkApproveAdjustments(type) {
    const checkboxes = document.querySelectorAll(`.${type}-checkbox:checked`);
    const ids = Array.from(checkboxes).map(cb => cb.value);

    if (!ids.length) {
        showToast(`Please select at least one pending ${type} to approve`, "warning");
        return;
    }

    if (!(await appConfirm(`Are you sure you want to approve ${ids.length} selected ${type}(s)?`))) return;

    try {
        showLoading();
        const res = await apiRequest("/api/salary-adjustments/bulk_approve/", {
            method: "POST",
            body: { ids }
        });

        if (res.success) {
            showToast(res.data.message || `${type.toUpperCase()}s approved successfully`, "success");
            loadAdjustments(type);
            updateDashboardStats();
        } else {
            showToast(res.message || "Failed to approve adjustments", "error");
        }
    } catch (err) {
        showToast("An error occurred during bulk approval", "error");
    } finally {
        hideLoading();
    }
}

// ==========================================
// COMPANY PAYMENT STATUS
// ==========================================

async function loadClientPayments() {
    const tbody = document.getElementById("clientPaymentsTableBody");

    try {
        const res = await apiRequest("/api/client-payments/");
        if (!res.success) throw new Error(res.message);
        
        const list = res.data?.results || res.data || [];
        AppState.clientPayments = list;
        if (!tbody) return true;
        tbody.innerHTML = "";

        list.forEach(cp => {
            const row = document.createElement("tr");
            const statusClass = 
                cp.status === 'paid' ? 'bg-success' : 
                cp.status === 'partial' ? 'bg-warning' : 'bg-danger';
            
            row.innerHTML = `
                <td>${escapeHtml(cp.month_key)}</td>
                <td>${escapeHtml(cp.client_name)}</td>
                <td>${formatCurrency(cp.amount_paid)}</td>
                <td>${formatCurrency(cp.outstanding_balance)}</td>
                <td><span class="badge ${statusClass}">${cp.status.toUpperCase()}</span></td>
                <td>${formatDate(cp.payment_date)}</td>
                <td>
                    <button class="btn btn-sm btn-primary" onclick="editClientPayment('${cp.id}')">Update</button>
                </td>
            `;
            tbody.appendChild(row);
        });
        return true;
    } catch (err) {
        AppState.clientPayments = [];
        showToast("Failed to load company payments", "error");
        return false;
    }
}

async function cancelStuckPayment(paymentId) {
    if (!(await appConfirm("Cancel this stuck payment? You can retry afterwards."))) return;
    
    try {
        showLoading();
        const res = await apiRequest(`/api/payments/${paymentId}/`, {
            method: "DELETE"
        });
        if (res.success) {
            showToast("Payment cancelled. You can now retry.", "success");
            await loadPaymentHistory();
            populatePaymentsTable();
        }
    } catch (err) {
        showToast(err.message || "Failed to cancel payment", "error");
    } finally {
        hideLoading();
    }
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
  const currentMonth = new Date().toISOString().slice(0, 7);

  activeEmployees.forEach((emp) => {
    const d = emp.salary_breakdown;
    const isPaidFully = d.outstanding_balance <= 0;

    let statusBadge = '';
    let actionBtn = '';

    const monthlyPayment = (AppState.payments || []).find(
        (p) => idsMatch(p.employee, emp.id) && p.payment_month === currentMonth,
    );

    if (monthlyPayment && ['pending', 'processing', 'pending_paystack_otp', 'pending_hr'].includes(monthlyPayment.status)) {
        if (monthlyPayment.status === 'pending_paystack_otp' && monthlyPayment.paystack_otp_required) {
            statusBadge = '<span class="badge bg-warning">AWAITING OTP</span>';
            actionBtn = `
                <button type="button" class="btn btn-sm btn-warning" onclick="showPaystackOtpModal('${monthlyPayment.transaction_reference}', '${monthlyPayment.paystack_transfer_code || ''}')">OTP</button>
                <button type="button" class="btn btn-sm btn-danger" onclick="cancelStuckPayment('${monthlyPayment.id}')">×</button>`;
        } else if (monthlyPayment.status === 'pending_hr') {
            statusBadge = '<span class="badge bg-warning">AWAITING HR</span>';
            actionBtn = '<span class="text-warning">HR approval required</span>';
        } else {
            statusBadge = `<span class="badge bg-info">${escapeHtml(formatPaymentStatus(monthlyPayment.status))}</span>`;
            actionBtn = `<button type="button" class="btn btn-sm btn-info" onclick="retryPayment('${monthlyPayment.transaction_reference}')">Sync</button>`;
        }
    } else if (isPaidFully) {
        statusBadge = '<span class="badge bg-success">PAID</span>';
        actionBtn = '<span class="text-success"><i class="fas fa-check-circle"></i> Settled</span>';
    } else {
        statusBadge = d.total_paid > 0 ? '<span class="badge bg-info">PARTIAL</span>' : '<span class="badge bg-secondary">UNPAID</span>';
        actionBtn = `<button type="button" class="btn btn-sm btn-success" onclick="initiateIndividualPayment('${emp.id}')">Pay ${d.total_paid > 0 ? 'Bal' : ''}</button>`;
    }

    const row = document.createElement("tr");
    row.innerHTML = `
            <td><input type="checkbox" value="${emp.id}" class="payment-checkbox" onchange="updatePaymentSelection()"></td>
            <td>${escapeHtml(emp.employee_id || "-")}</td>
            <td>${escapeHtml(emp.name)}</td>
            <td>${escapeHtml(emp.bank_name || "-")} - ${escapeHtml(emp.account_number || "-")}</td>
            <td>${formatCurrency(d.base_salary)}</td>
            <td class="text-danger">${formatCurrency(d.iou_deduction)}</td>
            <td class="text-danger">${formatCurrency(d.other_deductions)}</td>
            <td class="text-success">${formatCurrency(d.bonus)}</td>
            <td class="text-info">
                ${formatCurrency(d.previous_balance || 0)}
                ${(d.previous_balance || 0) > 0 ? '<br><small class="text-muted" style="font-size: 0.7em;">Prev. Month Unpaid Bal</small>' : ''}
            </td>
            <td class="font-bold" title="Outstanding Balance = Total Due - Total Paid">${formatCurrency(d.outstanding_balance)}</td>
            <td>${statusBadge}</td>
            <td>${actionBtn}</td>
        `;
    tbody.appendChild(row);
  });

  // Update Pending Payments Count (Unpaid or Partial)
  const pendingCount = activeEmployees.filter(e => e.salary_breakdown.outstanding_balance > 0).length;
  const pendingEl = document.getElementById("pendingPayments");
  if (pendingEl) pendingEl.textContent = pendingCount;
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
  if (selectAllCheckbox) {
    checkboxes.forEach((cb) => (cb.checked = selectAllCheckbox.checked));
  }
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

  if (modal) {
    modal.style.display = "flex";
    modal.classList.add("active");
  }
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
        closeModal("otpModal");
        showPaystackOtpModal(
          res.data.reference || AppState.currentPaymentReference,
          res.data.paystack_transfer_code || ""
        );
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
      if (res.data?.payments?.length) {
        startBulkPaymentPolling(res.data.payments);
      } else if (res.data?.payment_processing || res.data?.status === "processing") {
        startPaymentStatusPolling(res.data.reference || AppState.currentPaymentReference);
      }
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
  if (!AppState.currentPaymentReference) {
    showToast("Reference missing. Start payment again.", "warning");
    return;
  }

  const btn = document.getElementById("resendOtpBtn");
  try {
    showLoading(btn);
    const res = await apiRequest("/api/payments/resend-otp/", {
      method: "POST",
      body: { reference: AppState.currentPaymentReference },
    });
    if (!res.success) throw new Error(res.message || "Failed to resend OTP");
    showToast(res.data?.message || "OTP sent successfully", "success");
    startOtpCountdown();
  } catch (err) {
    showToast(err.message || "Failed to resend OTP", "error");
  } finally {
    hideLoading(btn);
  }
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

function downloadPayslip(html, employeeId, month) {
  const modal = document.getElementById("exportPasswordModal");
  if (!modal) {
    showToast("Export password modal is missing", "error");
    return;
  }

  modal.dataset.exportType = "payslip";
  modal.dataset.employeeId = employeeId;
  modal.dataset.month = month;
  delete modal.dataset.paymentId;

  const usernameInput = document.getElementById("exportUsername");
  if (usernameInput) usernameInput.value = AppState.currentUser?.username || "";

  const passwordInput = document.getElementById("exportPassword");
  if (passwordInput) passwordInput.value = "";

  const prompt = document.getElementById("exportPasswordPrompt");
  if (prompt) prompt.textContent = "Enter password to download payslip PDF";

  openModal("exportPasswordModal");
}

function downloadPayslip(html, employeeId, month) {
    const passwordModal = document.getElementById('exportPasswordModal');
    if (passwordModal) {
        passwordModal.dataset.pendingPayslipHtml = html;
        passwordModal.dataset.exportType = 'payslip';
        passwordModal.dataset.employeeId = employeeId;
        passwordModal.dataset.month = month;
        openModal('exportPasswordModal');
    }
}

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
    delete modal.dataset.employeeId;
    delete modal.dataset.month;
    delete modal.dataset.paymentId;
    // Populate username for password manager autofill
    const usernameInput = document.getElementById("exportUsername");
    if (usernameInput)
      usernameInput.value = AppState.currentUser?.username || "";
    const passwordInput = document.getElementById("exportPassword");
    if (passwordInput) passwordInput.value = "";
    const prompt = document.getElementById("exportPasswordPrompt");
    if (prompt) prompt.textContent = "Enter password to export employee data";
  }
  openModal("exportPasswordModal");
}

function exportPaymentHistory() {
  const modal = document.getElementById("exportPasswordModal");
  if (modal) {
    modal.dataset.exportType = "payments";
    delete modal.dataset.employeeId;
    delete modal.dataset.month;
    delete modal.dataset.paymentId;
    // Populate username for password manager autofill
    const usernameInput = document.getElementById("exportUsername");
    if (usernameInput)
      usernameInput.value = AppState.currentUser?.username || "";
    const passwordInput = document.getElementById("exportPassword");
    if (passwordInput) passwordInput.value = "";
    const prompt = document.getElementById("exportPasswordPrompt");
    if (prompt) prompt.textContent = "Enter password to export payment history";
  }
  openModal("exportPasswordModal");
}


// REPLACE the existing triggerSecureDownload function
async function triggerSecureDownload(url, token, filename, { method = null } = {}) {
  try {
    showLoading(null, AppState.elements.globalSpinner);
    const accessToken = AppState.accessToken;

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
async function confirmExport(e) {
  if (e && typeof e.preventDefault === "function") {
    e.preventDefault();
  }

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

  let url =
    type === "payments"
      ? "/api/payments/request-export/"
      : type === "employees"
        ? "/api/employees/request_export/"
          : type === "payslip"
          ? "/api/payments/request-payslip-export/"
          : type === "receipt"
            ? `/api/payments/${modal.dataset.paymentId}/request-receipt-export/`
            : "/api/employees/request_export/";
  let payload = { password };
  let downloadFilename = type === "payments" ? "payment_history.csv" : "employees.csv";


  if (type === "payslip") {
    url = "/api/payments/request-payslip-export/";

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
      const otp = await appPrompt("A verification code has been sent to your email. Enter it to continue:", "", "Verification Code");
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
    url = "/api/payments/request-payslip-export/";
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
//       const otp = await appPrompt("A verification code has been sent to your email. Enter it to continue:", "", "Verification Code");
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

function initAdjustmentSearch() {
    ['iou', 'bonus'].forEach(type => {
        const searchInput = document.getElementById(`${type}Search`);
        const statusFilter = document.getElementById(`${type}StatusFilter`);
        
        if (searchInput) {
            searchInput.addEventListener("input", debounce(() => searchAdjustments(type), 300));
        }
        if (statusFilter) {
            statusFilter.addEventListener("change", () => searchAdjustments(type));
        }
    });
}

function initNotificationAndReminderFilters() {
  ["notificationSearch", "notificationTypeFilter", "notificationReadFilter"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.filterBound === "true") return;
    el.dataset.filterBound = "true";
    const eventName = el.tagName === "INPUT" ? "input" : "change";
    el.addEventListener(eventName, debounce(loadNotifications, 300));
  });

  ["reminderSearch", "reminderStatusFilter"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.filterBound === "true") return;
    el.dataset.filterBound = "true";
    const eventName = el.tagName === "INPUT" ? "input" : "change";
    el.addEventListener(eventName, debounce(loadReminders, 300));
  });
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
  initAdjustmentSearch();
  initNotificationAndReminderFilters();
  setupEmployeeIdGeneration();
  setupBankCodeTracking(); // Fixed: Ensure bank code tracking is set up
  setupBankVerification();
  const verifyAccountBtn = document.getElementById("verifyAccountBtn");
  if (verifyAccountBtn && verifyAccountBtn.dataset.clickHandlerBound !== "true") {
    verifyAccountBtn.dataset.clickHandlerBound = "true";
    verifyAccountBtn.addEventListener("click", verifyBankAccountManual);
  }

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
  document
    .getElementById("companyPaymentVerifyForm")
    ?.addEventListener("submit", saveCompanyPaymentVerification);
  document
    .getElementById("verifyCompanyAmountPaid")
    ?.addEventListener("input", syncCompanyPaymentStatusFromAmount);
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
    { id: "addAdjustmentForm", handler: handleAddAdjustment },
    { id: "reminderForm", handler: handleReminderSubmit },
    // FIX: Ensure export confirm submit actually triggers confirmExport()
    { id: "exportPasswordForm", handler: confirmExport },
    { id: "paystackOtpForm", handler: submitPaystackOtp },
  ];
  const selfSignupForm = document.getElementById("selfSignupForm");
  if (selfSignupForm && selfSignupForm.dataset.submitHandlerBound !== "true") {
    selfSignupForm.dataset.submitHandlerBound = "true";
    selfSignupForm.addEventListener("submit", handleSelfSignup);
  }

  forms.forEach(({ id, handler }) => {
    const form = document.getElementById(id);
    if (!form) return;
    if (form.dataset.submitHandlerBound === "true") return;
    form.dataset.submitHandlerBound = "true";

    // DEBUG/SAFETY: ensure submit handlers are called without triggering default form navigation.
    form.addEventListener("submit", (e) => {
      if (e && typeof e.preventDefault === "function") {
        e.preventDefault();
      }
      try {
        handler(e);
      } catch (err) {
        console.error(`Submit handler failed for #${id}:`, err);
        showToast(err.message || "Form submission failed", "error");
      }
    });
  });
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
  const password = await appPrompt("Enter your login password to download attachments:", "", "Download Attachments");
  if (!password) return;

  showLoading(); // Global spinner
  try {
    const token = AppState.accessToken;
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
  if (!(await appConfirm("Are you sure you want to submit this request?"))) return;

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
  if (!(await appConfirm("Approve this request?"))) return;

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
        loadReminders(),
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
      const now = Date.now();
      ["dashboard", "employees", "attendance", "deductions", "requests", "sacked", "notifications", "reminders"].forEach((sectionId) => {
        AppState.lastSectionRefresh[sectionId] = now;
      });
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
    
    // CLEAR stale payment state to prevent any modal popups
    AppState.currentPaymentReference = null;
    AppState.currentPaystackTransferCode = null;
    if (AppState.paymentPollInterval) {
        clearInterval(AppState.paymentPollInterval);
        AppState.paymentPollInterval = null;
    }
    if (AppState.bulkPollInterval) {
        clearInterval(AppState.bulkPollInterval);
        AppState.bulkPollInterval = null;
    }
    
    // Force-close all modals
    document.querySelectorAll('.modal').forEach(modal => {
        modal.classList.remove("active");
        modal.style.display = "none";
    });
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
    loadNigerianBanks();

    // FEATURE: Check for Reset Password link in URL immediately
    const urlParams = new URLSearchParams(window.location.search);
    if (
      urlParams.get("action") === "reset-password" &&
      urlParams.get("uid") &&
      urlParams.get("token")
    ) {
      openModal("resetPasswordModal");
    }

    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      console.log("No active session found, showing login page");
      showLoginPage();
      setupEventListeners();
      return;
    }

    // Step 2: verify current user (at most 2 attempts total)
    console.log("Verifying token on page load...");
    const res = await apiRequest("/current-user/");

    if (res.success && res.data) {
      console.log("Token valid, loading dashboard");
      AppState.currentUser = res.data;
      await loadDashboard();
      initAutoRefresh();
      initHealthPoller();
    } else {
      console.log("Token invalid, attempting refresh once...");
      const refreshed = await refreshAccessToken();
      if (!refreshed) throw new Error("Cannot refresh token");

      const retryRes = await apiRequest("/current-user/");
      if (retryRes.success && retryRes.data) {
        AppState.currentUser = retryRes.data;
        await loadDashboard();
        initAutoRefresh();
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
  bulkUpdateBankCodes,
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
  reactivateCompany,
  populateCompanyGuards,
  showCompanyPaymentVerifyModal,
  saveCompanyPaymentVerification,
  loadClientPayments,

  // Deductions
  loadDeductions,
  renderDeductions,
  addDeduction,
  updateDeduction,
  deleteDeduction,
  editDeduction,

  // Adjustments
  searchAdjustments,
  showAddAdjustmentModal,
  toggleAllAdjustments,
  bulkApproveAdjustments,

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
  goToPaymentsForEmployee,
  // updateinitiateIndividualPayment,
  updatePaymentPreview, // Fixed: Ensure updatePaymentPreview is exposed
  // handleIndividualpayment,
  handleIndividualPaymentSubmit,
  processBulkPayment,
  confirmBulkPaymentSubmission,
  updateBulkTotal, // Fixed: Ensure updateBulkTotal is exposed
  toggleAllBulkPayments,
  populateBulkTable,
  showPaystackOtpModal,
  submitPaystackOtp,
  showInternalOtpModal,
  retryPayment, // Fixed: Ensure retryPayment is exposed
  cancelStuckPayment,


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
  viewNotificationDetail,
  exportNotificationHistory,

  // Reminders
  loadReminders,
  showReminderModal,
  handleReminderSubmit,
  completeReminder,

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
  verifyOTP,
  resendOTP,
  startOtpCountdown,

  // Bank verification
  verifyBankAccountManual,
  verifyNewEmployeeBankManual,
  setupBankVerification,
  clearBankCache,
  setupBankCodeTracking,
  viewEmployeeDetail,
  viewPaymentDetail,

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
    delete modal.dataset.employeeId;
    delete modal.dataset.month;
    const usernameInput = document.getElementById("exportUsername");
    if (usernameInput)
      usernameInput.value = AppState.currentUser?.username || "";
    const passwordInput = document.getElementById("exportPassword");
    if (passwordInput) passwordInput.value = "";
    const prompt = document.getElementById("exportPasswordPrompt");
    if (prompt) prompt.textContent = "Enter password to download receipt PDF";
  }
  openModal("exportPasswordModal"); // Fixed: Open export password modal
}

async function retryPayment(transactionReferenceOrId) {
  try {
      if (!transactionReferenceOrId) {
          showToast("Missing payment reference for retry", "error");
          return;
      }

      const res = await apiRequest(`/api/payments/verify-payment/${transactionReferenceOrId}/`);
      if (!res.success) {
          showToast(res.message || "Retry not available yet. Please try again later.", "warning");
          return;
      }

      const status = res.data?.payment_status;
      if (!status) {
          showToast("Payment status could not be determined. Please try again later.", "warning");
          return;
      }

      if (status === "pending_paystack_otp") {
          const payment = AppState.payments.find(
              (p) => p.transaction_reference === transactionReferenceOrId || String(p.id) === String(transactionReferenceOrId),
          );
          const transferCode = res.data.paystack_transfer_code || payment?.paystack_transfer_code || '';
          showPaystackOtpModal(transactionReferenceOrId, transferCode);
          showToast("Paystack OTP required. Please enter the OTP.", "warning");
          return;
      }

      await loadPaymentHistory();
      populatePaymentsTable();
      updateDashboardStats();
      showToast(`Payment status: ${status}`, status === "completed" ? "success" : "info", 4000);
      return;
  } catch (err) {
      console.error("retryPayment error:", err);
      showToast(err.message || "Retry failed", "error");
  }
}
