'use strict';

// Forms keep native focus and scrolling, including installed iOS web apps.
(function mobileUI() {
  const editable = node => node?.matches?.('input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable=true]') && node.getClientRects().length > 0;
  const touchDevice = navigator.maxTouchPoints > 0 || matchMedia('(any-pointer: coarse)').matches;
  let portrait = matchMedia('(orientation: portrait)').matches;
  function orientation(force = false) {
    if (typeof window.orientation === 'number') portrait = Math.abs(window.orientation) !== 90;
    else if (force || !editable(document.activeElement)) portrait = matchMedia('(orientation: portrait)').matches;
  }
  window.MobileUI = {
    isPhonePortrait() {
      const physicalPortrait = typeof window.orientation === 'number' ? Math.abs(window.orientation) !== 90 : portrait;
      return touchDevice && matchMedia('(max-width: 600px)').matches && physicalPortrait;
    },
    isEditing() { return editable(document.activeElement); },
    isStandalone() { return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; },
    async fullscreen() {
      if (this.isStandalone()) return;
      const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
      if (!request) throw new Error('Trình duyệt chưa hỗ trợ toàn màn hình. Trên iPhone, dùng Chia sẻ → Thêm vào Màn hình chính, rồi mở biểu tượng ứng dụng.');
      await request.call(document.documentElement);
      try { await screen.orientation?.lock?.('landscape'); } catch { /* Keep manual rotation available. */ }
    }
  };
  orientation();
  addEventListener('resize', () => orientation());
  addEventListener('orientationchange', () => orientation(true));
  document.addEventListener('focusin', event => {
    if (editable(event.target)) document.body.classList.add('editing-field');
  });
  document.addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      if (!editable(document.activeElement)) document.body.classList.remove('editing-field');
    });
  });
})();
