(() => {
  'use strict';

  const button = document.getElementById('portal-watch');
  if (!button) return;
  button.addEventListener('click', () => {
    const code = String(document.getElementById('portal-room-code')?.value || '').trim().toUpperCase();
    if (!/^[A-Z2-9]{4}$/.test(code)) {
      const error = document.getElementById('portal-error');
      if (error) {
        error.textContent = 'Nhập mã phòng 4 ký tự để mở chế độ khán giả.';
        error.classList.remove('hidden');
      }
      return;
    }
    location.assign(`/spectate/${encodeURIComponent(code)}`);
  });
})();
