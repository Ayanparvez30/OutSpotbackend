// Confirmation modal for destructive actions
document.addEventListener('DOMContentLoaded', () => {
  const confirmModal = document.getElementById('confirmModal');
  if (!confirmModal) return;

  const modal = new bootstrap.Modal(confirmModal);
  const confirmBtn = document.getElementById('confirmBtn');
  const confirmMessage = document.getElementById('confirmMessage');

  document.querySelectorAll('[data-confirm]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const message = el.getAttribute('data-confirm') || 'Are you sure?';
      confirmMessage.textContent = message;

      // For form submit buttons
      const form = el.closest('form');
      if (form) {
        confirmBtn.onclick = () => {
          modal.hide();
          // form.submit() does NOT include the clicked submit button's name/value.
          // Multi-action forms (e.g. report Warn/Ban/Deactivate, which all post
          // `action=...` from one form) relied on it, so the server saw no action
          // and did nothing. Inject the button's name/value as a hidden field first.
          // Single-action buttons (no `name`, e.g. user Ban/Delete) are unaffected.
          if (el.tagName === 'BUTTON' && el.name) {
            let hidden = form.querySelector('input[data-confirm-injected]');
            if (!hidden) {
              hidden = document.createElement('input');
              hidden.type = 'hidden';
              hidden.setAttribute('data-confirm-injected', '');
              form.appendChild(hidden);
            }
            hidden.name = el.name;
            hidden.value = el.value;
          }
          form.submit();
        };
      }

      // For links
      if (el.tagName === 'A') {
        confirmBtn.onclick = () => {
          modal.hide();
          window.location.href = el.href;
        };
      }

      modal.show();
    });
  });

  // Auto-dismiss alerts after 5 seconds
  document.querySelectorAll('.alert-dismissible').forEach((alert) => {
    setTimeout(() => {
      const bsAlert = bootstrap.Alert.getOrCreateInstance(alert);
      if (bsAlert) bsAlert.close();
    }, 5000);
  });
});
