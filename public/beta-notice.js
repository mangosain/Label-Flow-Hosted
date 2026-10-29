"use strict";
// Shown on every page load, including refreshes; deliberately not stored in
// localStorage/IndexedDB. This notice is informational and is auto-dismissed.
(function showBetaNotice() {
  const dialog = document.getElementById("beta-notice");
  const close = document.getElementById("beta-notice-close");
  const confirm = document.getElementById("beta-notice-confirm");
  const countdown = document.getElementById("beta-seconds");
  if (!dialog || !close || !confirm) return;

  let expiryTimeout;
  let secondsInterval;
  const start = performance.now();
  const duration = 5000;
  function dismiss() {
    clearTimeout(expiryTimeout);
    clearInterval(secondsInterval);
    if (dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }
  close.addEventListener("click", dismiss);
  confirm.addEventListener("click", dismiss);
  dialog.addEventListener("close", dismiss);
  // Native modal provides focus containment and Escape dismissal.
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    confirm.focus();
  } else {
    // Fallback for browsers without <dialog>. Still allow the notice to close.
    dialog.setAttribute("open", "");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
  }
  expiryTimeout = setTimeout(dismiss, duration);
  secondsInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((duration - (performance.now() - start)) / 1000));
    if (countdown) countdown.textContent = String(remaining);
  }, 250);
})();
