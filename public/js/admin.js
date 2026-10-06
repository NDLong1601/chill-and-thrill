(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const form = $('#auth-form');
  const secretInput = $('#admin-secret');
  const authMessage = $('#auth-message');
  const dashboard = $('#dashboard');
  const signOutButton = $('#sign-out');
  const addressObjectUrls = new Set();
  let adminSecret = '';
  let refreshTimer = null;
  let busy = false;

  const gameLabels = {
    'the-gang': 'The Gang', uno: 'UNO', 'tien-len': 'Tiến lên', poker: 'Poker',
    'sam-loc': 'Sâm lốc', phom: 'Phỏm', bang: 'BANG!',
  };
  const variantLabels = {
    standard: 'Chuẩn', 'classic-local-v1': 'UNO 112 lá', 'classic-108-v1': 'UNO 108 lá', unknown: 'Chưa xác định',
  };
  const phaseLabels = { WAITING: 'Phòng chờ', PLAYING: 'Đang chơi', RESULT: 'Kết quả', FINISHED: 'Đã kết thúc' };

  function setMessage(node, message, kind = '') {
    node.textContent = message || '';
    node.classList.toggle('error', kind === 'error');
    node.classList.toggle('success', kind === 'success');
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${adminSecret}`);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    return fetch(path, {
      ...options,
      headers,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'same-origin',
    });
  }

  async function readJson(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || 'Không tải được dữ liệu quản trị.');
      error.code = body.code;
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function revokeQrImages() {
    for (const url of addressObjectUrls) URL.revokeObjectURL(url);
    addressObjectUrls.clear();
  }

  function formatTime(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' }).format(date) : '—';
  }

  function setCount(selector, value) {
    $(selector).textContent = Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('vi-VN') : '—';
  }

  function renderStatus(status) {
    const server = status.server || {};
    setCount('#connection-count', server.connectionCount);
    setCount('#room-count', server.roomCount);
    $('#connected-player-count').textContent = `${Number.isSafeInteger(server.connectedPlayers) ? server.connectedPlayers.toLocaleString('vi-VN') : '—'} người đang kết nối`;

    const maintenance = server.maintenance === true;
    $('#maintenance-state').textContent = maintenance ? 'Bảo trì' : 'Đang mở';
    $('#maintenance-detail').textContent = maintenance ? 'Đang từ chối bàn mới' : 'Bàn hiện có tiếp tục hoạt động';
    $('#maintenance-toggle').textContent = maintenance ? 'Tiếp nhận bàn mới' : 'Bật bảo trì';
    $('#maintenance-toggle').classList.toggle('primary', maintenance);

    renderStorage(status.storage || {});
    renderRooms(Array.isArray(status.rooms) ? status.rooms : []);
    renderAddresses(Array.isArray(status.addresses) ? status.addresses : []);
    renderReceipts(Array.isArray(status.recentActions) ? status.recentActions : []);
    dashboard.hidden = false;
    signOutButton.hidden = false;
  }

  function renderStorage(storage) {
    const state = ['ok', 'warning', 'unsafe'].includes(storage.status) ? storage.status : 'unknown';
    const label = { ok: 'Ổn định', warning: 'Có cảnh báo', unsafe: 'Cần xử lý', unknown: 'Chưa rõ' }[state];
    $('#storage-state').textContent = label;
    $('#storage-detail').textContent = storage.canStartWager === true ? 'Ván cược mới được phép' : storage.canStartWager === false ? 'Đã chặn ván cược mới' : 'Chưa xác nhận an toàn';
    const badge = $('#storage-badge');
    badge.textContent = label;
    badge.className = `state-pill ${state}`;

    const items = [
      ['Cơ sở dữ liệu', storage.database?.kind || 'unknown'],
      ['Schema', Number.isSafeInteger(storage.database?.schemaVersion) ? storage.database.schemaVersion : '—'],
      ['Kiểm tra toàn vẹn', storage.database?.integrity || 'unknown'],
      ['Đối soát khoản giữ', storage.heldAudit?.state === 'ok' ? `${storage.heldAudit.needsAttention ?? '—'} cần xem` : 'Chưa xác nhận'],
    ];
    const summary = $('#storage-summary');
    summary.replaceChildren();
    for (const [labelText, value] of items) {
      const item = document.createElement('div'); item.className = 'storage-item';
      const label = document.createElement('span'); label.textContent = labelText;
      const strong = document.createElement('strong'); strong.textContent = String(value);
      item.append(label, strong); summary.append(item);
    }
    const issues = [...(storage.failures || []), ...(storage.warnings || [])].slice(0, 12);
    const issueList = $('#storage-issues'); issueList.replaceChildren();
    for (const issue of issues) {
      const li = document.createElement('li');
      const area = issue.gameId || issue.sourceId || 'Lưu trữ';
      const operation = issue.operation ? ` · ${issue.operation}` : '';
      li.textContent = `${area}${operation}: ${issue.code || 'Cần kiểm tra'}`;
      issueList.append(li);
    }
  }

  function renderRooms(rooms) {
    $('#room-total').textContent = `${rooms.length.toLocaleString('vi-VN')} phòng`;
    const body = $('#room-list'); body.replaceChildren();
    if (!rooms.length) {
      const row = document.createElement('tr'); const cell = document.createElement('td');
      cell.colSpan = 5; cell.className = 'empty-state'; cell.textContent = 'Chưa có phòng.';
      row.append(cell); body.append(row); return;
    }
    for (const room of rooms) {
      const row = document.createElement('tr');
      const code = document.createElement('td'); code.className = 'room-code'; code.textContent = room.code || '—';
      const game = document.createElement('td');
      const gameName = gameLabels[room.gameId] || 'Game'; const variant = variantLabels[room.variant] || room.variant || '';
      game.textContent = variant ? `${gameName} · ${variant}` : gameName;
      const phase = document.createElement('td'); phase.textContent = phaseLabels[room.phase] || room.phase || '—';
      const people = document.createElement('td');
      const count = Number.isSafeInteger(room.playerCount) ? room.playerCount : 0;
      const connected = Number.isSafeInteger(room.connectedCount) ? room.connectedCount : 0;
      people.textContent = `${connected}/${count}${Number.isSafeInteger(room.maxPlayers) ? ` · tối đa ${room.maxPlayers}` : ''}`;
      const visibility = document.createElement('td'); visibility.textContent = room.visibility === 'invite' ? 'Theo lời mời' : 'Công khai';
      row.append(code, game, phase, people, visibility); body.append(row);
    }
  }

  function isLocalAddress(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && (url.hostname === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname === '::1');
    } catch { return false; }
  }

  async function renderAddresses(addresses) {
    revokeQrImages();
    const root = $('#addresses'); root.replaceChildren();
    if (!addresses.length) {
      const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = 'Chưa tìm thấy địa chỉ mạng.'; root.append(empty); return;
    }
    addresses.forEach((address, index) => {
      const card = document.createElement('article'); card.className = 'address-card';
      const copy = document.createElement('div');
      const name = document.createElement('h3'); name.textContent = address.name || 'Mạng LAN';
      const link = document.createElement('a');
      if (isLocalAddress(address.url)) { link.href = address.url; link.textContent = address.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      else link.textContent = 'Địa chỉ bị từ chối';
      const hint = document.createElement('p'); hint.textContent = address.local === true ? 'Chỉ mở trên máy chủ' : 'Người chơi trong mạng nội bộ có thể quét mã';
      copy.append(name, link, document.createElement('br'), hint);
      const placeholder = document.createElement('span'); placeholder.className = 'qr-placeholder'; placeholder.textContent = 'Đang tạo QR…';
      card.append(copy, placeholder); root.append(card);
      request(`/api/admin/network-qr/${index}.svg`).then(response => {
        if (!response.ok) throw new Error('QR unavailable');
        return response.blob();
      }).then(blob => {
        const objectUrl = URL.createObjectURL(blob); addressObjectUrls.add(objectUrl);
        const image = document.createElement('img'); image.className = 'qr-image'; image.alt = `Mã QR ${address.name || ''}`; image.src = objectUrl;
        placeholder.replaceWith(image);
      }).catch(() => { placeholder.textContent = 'QR chưa sẵn sàng'; });
    });
  }

  function renderReceipts(receipts) {
    const root = $('#receipts'); root.replaceChildren();
    if (!receipts.length) {
      const empty = document.createElement('p'); empty.className = 'empty-state'; empty.textContent = 'Chưa có thao tác trong phiên này.'; root.append(empty); return;
    }
    for (const receipt of receipts) {
      const row = document.createElement('div'); row.className = 'receipt-row';
      const description = document.createElement('strong');
      description.textContent = receipt.action === 'maintenance-enabled' ? 'Bật bảo trì' : receipt.action === 'maintenance-disabled' ? 'Tiếp nhận bàn mới' : 'Thao tác quản trị';
      const metadata = document.createElement('time'); metadata.dateTime = receipt.createdAt || ''; metadata.textContent = `${formatTime(receipt.createdAt)} · ${receipt.receiptId || ''}`;
      row.append(description, metadata); root.append(row);
    }
  }

  async function loadStatus(force = false) {
    if (!adminSecret || (busy && !force)) return;
    try {
      const status = await readJson(await request('/api/admin/status'));
      renderStatus(status);
      setMessage(authMessage, 'Đã xác thực với máy chủ nội bộ.', 'success');
    } catch (error) {
      if (error.status === 401 || error.status === 404) clearSession('Secret sai hoặc API quản trị chưa được cấu hình.');
      else setMessage(authMessage, error.message || 'Không tải được trạng thái máy chủ.', 'error');
    }
  }

  function startRefresh() {
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!document.hidden) loadStatus(); }, 15000);
  }

  function clearSession(message = 'Secret đã được xóa khỏi trang.') {
    clearInterval(refreshTimer); refreshTimer = null;
    revokeQrImages(); adminSecret = ''; secretInput.value = '';
    dashboard.hidden = true; signOutButton.hidden = true;
    setMessage(authMessage, message, '');
  }

  function newOperationId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    adminSecret = secretInput.value;
    setMessage(authMessage, 'Đang xác thực…');
    await loadStatus();
    if (!dashboard.hidden) startRefresh();
  });

  signOutButton.addEventListener('click', () => clearSession());
  $('#refresh').addEventListener('click', () => loadStatus());
  $('#maintenance-toggle').addEventListener('click', async event => {
    if (!adminSecret || busy) return;
    const button = event.currentTarget;
    busy = true; button.disabled = true;
    setMessage($('#action-message'), 'Đang cập nhật…');
    try {
      const current = await readJson(await request('/api/admin/status'));
      const result = await readJson(await request('/api/admin/maintenance', {
        method: 'POST', body: JSON.stringify({ enabled: current.server?.maintenance !== true, operationId: newOperationId() }),
      }));
      setMessage($('#action-message'), `Đã ghi biên nhận ${result.receipt?.receiptId || ''}.`, 'success');
      await loadStatus(true);
    } catch (error) {
      setMessage($('#action-message'), error.message || 'Không đổi được chế độ bảo trì.', 'error');
    } finally {
      busy = false; button.disabled = false;
    }
  });
})();
