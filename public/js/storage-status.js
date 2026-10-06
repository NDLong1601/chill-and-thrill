'use strict';

(() => {
  const warningText = status => {
    if (status?.canStartWager === false) return status.blockedReason || 'Chưa thể bắt đầu ván cược mới vì nguồn lưu trữ chưa an toàn.';
    const warning = status?.warnings?.[0];
    if (!warning) return '';
    if (warning.code?.includes('EXPORT')) return 'Bản lưu SQLite đã an toàn, nhưng chưa xuất được bản JSON tương thích. Chủ máy nên kiểm tra dung lượng và quyền ghi.';
    if (warning.code === 'HELD_AUDIT_UNAVAILABLE') return 'Chưa đối soát được các khoản đang giữ. Ván cược mới sẽ tạm thời bị từ chối cho đến khi kiểm tra lưu trữ thành công.';
    if (warning.code === 'LEGACY_ROOM_READ_FAILED') return 'Không đọc được một bản phòng cũ; hãy kiểm tra lưu trữ trước khi tiếp tục.';
    return 'Lưu trữ đang có cảnh báo. Nếu bắt đầu ván cược mới không được, hãy kiểm tra trạng thái máy chủ.';
  };

  function render(container, status) {
    if (!container) return;
    const text = warningText(status);
    container.textContent = text;
    container.hidden = !text;
    container.dataset.level = status?.canStartWager === false ? 'blocked' : 'warning';
    container.setAttribute('aria-live', status?.canStartWager === false ? 'assertive' : 'polite');
  }

  async function refresh(container, fetcher = globalThis.fetch?.bind(globalThis)) {
    if (!container || typeof fetcher !== 'function') return null;
    try {
      const response = await fetcher('/api/storage/status', { cache: 'no-store' });
      if (!response.ok) throw new Error('status unavailable');
      const status = await response.json();
      render(container, status);
      return status;
    } catch {
      render(container, { canStartWager: true, warnings: [{ code: 'STATUS_UNAVAILABLE' }] });
      return null;
    }
  }

  window.StorageStatus = { refresh, render };
})();
