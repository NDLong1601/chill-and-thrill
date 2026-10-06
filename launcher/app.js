'use strict';

(() => {
  const $ = selector => document.querySelector(selector);
  const stateNames = {
    idle: ['Chưa xác nhận trạng thái', 'Chưa khởi động qua launcher'],
    starting: ['Đang khởi động…', 'Đang chờ tiến trình tự khởi động và mở cổng game.'],
    running: ['Máy chủ đang chạy', 'Người chơi có thể dùng địa chỉ hoặc quét QR bên dưới.'],
    stopping: ['Đang dừng an toàn…', 'Đang chờ server đóng dữ liệu và tiến trình thoát.'],
    stopped: ['Đã dừng an toàn', 'Tiến trình đã xác nhận đóng sạch và đã thoát. Có thể sao lưu.'],
    'stop-failed': ['Chưa dừng an toàn', 'Tiến trình chưa được buộc tắt. Bạn có thể thử Dừng lại.'],
    'start-timeout': ['Chưa nhận xác nhận khởi động', 'Tiến trình vẫn còn tồn tại. Kiểm tra trạng thái hoặc thử Dừng.'],
    failed: ['Máy chủ chưa sẵn sàng', 'Xem lý do bên dưới rồi thử lại khi phù hợp.'],
  };
  let csrf = '';
  let statusData = null;
  let authenticated = false;
  let busy = false;
  let toastTimer = null;

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
  }

  async function request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.method === 'POST' && url.startsWith('/api/') && url !== '/api/session' && url !== '/api/session/refresh') {
      headers.set('X-CT-CSRF', csrf);
    }
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const error = new Error(data.error || `Yêu cầu thất bại (${response.status}).`);
      error.code = data.code;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function setAuthenticated(value) {
    authenticated = value;
    $('#access-panel').hidden = value;
    document.querySelectorAll('button').forEach(button => { button.disabled = !value || busy; });
  }

  function setText(selector, value) { $(selector).textContent = value || '—'; }

  function renderPaths(paths) {
    if (!paths) return;
    setText('#database-path', paths.databaseFile);
    setText('#rooms-path', paths.roomFile);
    setText('#backup-path', paths.backupDirectory);
    setText('#project-path', paths.projectRoot);
    const list = $('#manager-files');
    list.replaceChildren();
    for (const file of Object.values(paths.managerFiles || {})) {
      const item = document.createElement('li');
      item.textContent = file;
      list.append(item);
    }
  }

  function renderAddresses(urls = []) {
    const container = $('#addresses');
    container.replaceChildren();
    const localAddress = urls.find(address => address.local) || urls[urls.length - 1];
    const adminShortcut = $('#admin-shortcut');
    if (localAddress?.url) {
      $('#admin-link').href = `${localAddress.url.replace(/\/$/, '')}/admin`;
      adminShortcut.hidden = false;
    } else {
      adminShortcut.hidden = true;
    }
    if (!urls.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'Khởi động máy chủ để xem địa chỉ và mã QR.';
      container.append(empty);
      return;
    }
    for (const address of urls) {
      const card = document.createElement('article');
      card.className = 'address-item';
      if (address.qrDataUrl) {
        const image = document.createElement('img');
        image.src = address.qrDataUrl;
        image.alt = `Mã QR mở ${address.url}`;
        card.append(image);
      }
      const copy = document.createElement('div');
      copy.className = 'address-copy';
      const label = document.createElement('p');
      label.className = 'address-label';
      label.textContent = address.local ? 'Chơi trên máy chủ' : `Mạng LAN · ${address.name}`;
      const link = document.createElement('a');
      link.className = 'address-url';
      link.href = address.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = address.url;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Sao chép địa chỉ';
      button.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(address.url); showToast('Đã sao chép địa chỉ.'); }
        catch { showToast(`Địa chỉ: ${address.url}`); }
      });
      copy.append(label, link, button);
      card.append(copy);
      container.append(card);
    }
  }

  function renderServer(server, maintenance) {
    const state = server?.state || 'idle';
    const [title, detail] = stateNames[state] || stateNames.failed;
    const titleNode = $('#server-state');
    const detailNode = $('#state-detail');
    const pill = $('#state-pill');
    titleNode.textContent = title;
    detailNode.textContent = server?.lastError?.message || (maintenance ? `Đang ${maintenance.operation === 'backup' ? 'tạo backup' : 'khôi phục dữ liệu'}…` : detail);
    pill.textContent = maintenance ? (maintenance.operation === 'backup' ? 'ĐANG BACKUP' : 'ĐANG KHÔI PHỤC') : state.toUpperCase();
    pill.className = `state-pill ${maintenance || ['starting', 'stopping'].includes(state) ? 'busy' : state === 'running' || state === 'stopped' ? 'running' : ['failed', 'stop-failed', 'start-timeout'].includes(state) ? 'failed' : ''}`;
    const errorPanel = $('#error-panel');
    errorPanel.hidden = !server?.lastError;
    errorPanel.textContent = server?.lastError ? `${server.lastError.code}: ${server.lastError.message}` : '';
    renderAddresses(server?.urls || []);

    const processKnown = Boolean(server?.managedProcess);
    $('#start-button').disabled = busy || maintenance || state === 'running' || state === 'starting' || state === 'stopping' || processKnown;
    $('#stop-button').disabled = busy || maintenance || !processKnown || state === 'starting' || state === 'stopping';
    const safeForDataAction = state === 'stopped' || processKnown;
    $('#backup-button').disabled = busy || Boolean(maintenance) || !safeForDataAction;
    $('#restore-button').disabled = busy || Boolean(maintenance) || !safeForDataAction;
    document.querySelectorAll('[data-folder]').forEach(button => { button.disabled = busy || Boolean(maintenance); });
  }

  async function refreshStatus() {
    if (!authenticated) return;
    const data = await request('/api/status');
    statusData = data;
    renderPaths(data.paths);
    renderServer(data.server, data.maintenance);
  }

  async function withBusy(work, successMessage) {
    if (busy) return;
    busy = true;
    if (statusData) renderServer(statusData.server, statusData.maintenance);
    try {
      const result = await work();
      if (successMessage) showToast(typeof successMessage === 'function' ? successMessage(result) : successMessage);
      await refreshStatus();
      return result;
    } catch (error) {
      showToast(error.message);
      try { await refreshStatus(); } catch { /* keep the original action error visible */ }
      return null;
    } finally {
      busy = false;
      if (statusData) renderServer(statusData.server, statusData.maintenance);
    }
  }

  $('#start-button').addEventListener('click', () => withBusy(async () => {
    const data = await request('/api/server/start', { method: 'POST', body: '{}' });
    return data.result?.alreadyRunning ? 'Máy chủ đã chạy.' : 'Máy chủ đã khởi động.';
  }, result => result));

  $('#stop-button').addEventListener('click', () => withBusy(async () => {
    await request('/api/server/stop', { method: 'POST', body: '{}' });
    return 'Máy chủ đã xác nhận đóng sạch và tiến trình đã thoát.';
  }, result => result));

  $('#backup-button').addEventListener('click', () => withBusy(async () => {
    const data = await request('/api/backup', { method: 'POST', body: '{}' });
    return `Backup đã xác minh: ${data.directory}`;
  }, result => result));

  $('#restore-button').addEventListener('click', () => withBusy(async () => {
    const backupDirectory = $('#restore-path').value.trim();
    if (!backupDirectory) throw new Error('Nhập đường dẫn thư mục backup trước.');
    if (!window.confirm('Launcher sẽ xác minh backup rồi tạo thư mục khôi phục mới. Dữ liệu đang dùng không bị thay thế. Tiếp tục?')) return null;
    const data = await request('/api/restore', { method: 'POST', body: JSON.stringify({ backupDirectory }) });
    return `Đã khôi phục vào thư mục mới: ${data.directory}`;
  }, result => result || 'Đã hủy thao tác khôi phục.'));

  document.querySelectorAll('[data-folder]').forEach(button => button.addEventListener('click', () => withBusy(async () => {
    const data = await request('/api/open-folder', { method: 'POST', body: JSON.stringify({ key: button.dataset.folder }) });
    return `Đã mở thư mục: ${data.directory}`;
  }, result => result)));

  async function boot() {
    try {
      const capability = new URLSearchParams(location.hash.slice(1)).get('cap');
      if (capability) {
        history.replaceState(null, document.title, location.pathname);
        const data = await request('/api/session', { method: 'POST', body: JSON.stringify({ capability }) });
        csrf = data.csrf;
      } else {
        const data = await request('/api/session/refresh', { method: 'POST', body: '{}' });
        csrf = data.csrf;
      }
      setAuthenticated(true);
      $('#connection').classList.add('online');
      $('#connection').innerHTML = '<i></i> Đã kết nối';
      await refreshStatus();
      setInterval(() => refreshStatus().catch(() => {
        $('#connection').classList.remove('online');
        $('#connection').classList.add('offline');
        $('#connection').innerHTML = '<i></i> Mất kết nối';
      }), 5000);
    } catch (error) {
      setAuthenticated(false);
      $('#connection').classList.add('offline');
      $('#connection').innerHTML = '<i></i> Chưa mở phiên';
      showToast(error.message);
    }
  }

  void boot();
})();
