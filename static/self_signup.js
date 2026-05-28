(() => {
  // Use the EXISTING static modal from index.html (#selfSignupModal)
  function showSelfSignupModal() {
    const modal = document.getElementById('selfSignupModal');
    if (!modal) return;
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

  document.addEventListener('DOMContentLoaded', () => {
    initSelfSignupModal();
  });
})();