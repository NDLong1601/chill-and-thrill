'use strict';

(() => {
  function mount() {
    if (!window.StorageStatus || window.StorageWarning) return;
    let container = document.getElementById('storage-status');
    if (!container) {
      container = document.createElement('aside');
      container.id = 'storage-status';
      container.className = 'storage-status';
      container.hidden = true;
      container.setAttribute('role', 'status');
      const notice = document.getElementById('notice');
      if (notice?.parentNode) notice.before(container);
      else {
        // The portal replaces its active screen; keep the warning outside it.
        Object.assign(container.style, {
          position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
          width: 'min(640px, calc(100% - 24px))', zIndex: '1500', boxSizing: 'border-box',
          pointerEvents: 'none',
        });
        document.body.prepend(container);
      }
    }
    let busy = false;
    let lastAttempt = 0;
    async function refresh() {
      if (busy || document.hidden) return null;
      busy = true;
      lastAttempt = Date.now();
      try {
        const status = await window.StorageStatus.refresh(container);
        if (!status) {
          container.textContent = 'Tạm thời chưa đọc được trạng thái lưu trữ. Máy chủ vẫn kiểm tra an toàn trước mỗi ván cược.';
          container.hidden = false;
          container.dataset.level = 'unknown';
        }
        return status;
      } finally { busy = false; }
    }
    window.StorageWarning = { refresh };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.addEventListener('online', refresh);
    try {
      if (typeof socket !== 'undefined' && socket?.on) {
        socket.on('connect', refresh);
        socket.on('game_state', () => { if (Date.now() - lastAttempt >= 5000) refresh(); });
      }
    } catch { /* Pages without a game socket still poll the same public API. */ }
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
