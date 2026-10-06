'use strict';

(() => {
  const form = document.getElementById('history-filters');
  const list = document.getElementById('history-list');
  const status = document.getElementById('history-status');
  const empty = document.getElementById('history-empty');
  const auth = document.getElementById('history-auth');
  const more = document.getElementById('history-more');
  const count = document.getElementById('history-count');
  const memoryStorage = new Map();
  function readStorage(key) {
    try {
      const value = globalThis.localStorage?.getItem(key);
      if (value !== null && value !== undefined) return value;
    } catch {}
    return memoryStorage.get(key) || null;
  }
  const token = readStorage('chill-thrill:profile-token') || readStorage('gang.profileToken');
  const gameNames = Object.freeze({ 'the-gang': 'The Gang', uno: 'UNO', 'tien-len': 'Tiến lên', poker: 'Poker', 'sam-loc': 'Sâm lốc', phom: 'Phỏm', bang: 'BANG!' });
  const groups = Object.freeze({ match: 'Kết quả ván', hold: 'Giữ tiền', refund: 'Hoàn tiền', settlement: 'Thanh toán', exchange: 'Quy đổi', reward: 'Thưởng', grant: 'Cấp số dư', other: 'Giao dịch khác' });
  const currencyNames = Object.freeze({ chip: 'Chip', coin: 'Coin', gem: 'Gem' });
  const sourceNames = Object.freeze({ reservation: 'Giữ vào bàn', release: 'Hoàn khoản giữ', settlement: 'Thanh toán ván', exchange: 'Quy đổi', mission: 'Nhiệm vụ', bootstrap: 'Khởi tạo ví', coin_bootstrap: 'Khởi tạo coin', poker_cashout: 'Rút stack Poker' });
  const outcomes = Object.freeze({ WIN: 'Thắng', LOSS: 'Thua', TIE: 'Hòa', DRAW: 'Hòa', CANCELLED: 'Đã hủy' });
  const format = value => Number(value).toLocaleString('vi-VN');
  const signed = value => `${value > 0 ? '+' : ''}${format(value)}`;
  let cursor = null;
  let requestId = 0;
  let loadedCount = 0;
  let seen = new Set();
  let loading = false;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }
  function displayDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Thời gian chưa rõ';
    return new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' }).format(date);
  }
  function gameLabel(gameId) { return gameNames[gameId] || (gameId ? `Game (${gameId})` : 'Game chưa rõ'); }
  function currencyLabel(currency) { return currencyNames[currency] || `Đơn vị tiền (${currency || 'chưa rõ'})`; }
  function appendMeta(container, label, value) {
    if (value === null || value === undefined || value === '') return;
    container.appendChild(node('span', '', `${label}: ${value}`));
  }
  function badge(text, extra = '') { return node('span', `history-badge ${extra}`.trim(), text); }
  function sourceLabel(value) { return sourceNames[value] || (value ? `Nguồn (${value})` : 'Nguồn chưa rõ'); }

  function renderMatch(item) {
    const card = node('li', 'history-item');
    const heading = node('div', 'history-item-head');
    const title = node('h3', 'history-item-title', `Kết quả ván · ${gameLabel(item.gameId)}`);
    heading.append(title, node('time', 'history-date', displayDate(item.createdAt)));
    card.appendChild(heading);
    const meta = node('div', 'history-meta');
    if (item.gameId === 'uno') appendMeta(meta, 'Biến thể', item.variant === 'classic-local-v1' ? '112 lá' : item.variant === 'classic-108-v1' ? '108 lá' : 'Biến thể UNO chưa lưu');
    appendMeta(meta, 'Phòng', item.roomCode || 'Mã phòng chưa lưu');
    appendMeta(meta, 'Ván', item.matchId || 'Mã ván chưa lưu');
    card.appendChild(meta);
    const outcome = outcomes[item.outcome] || 'Kết quả của hồ sơ chưa phân loại';
    card.appendChild(badge(outcome, item.outcome === 'WIN' ? 'is-win' : item.outcome === 'LOSS' ? 'is-loss' : ''));
    const summary = item.result && typeof item.result === 'object' ? item.result : {};
    const details = [];
    if (typeof summary.winnerName === 'string') details.push(`Người thắng: ${summary.winnerName}`);
    if (typeof summary.reason === 'string') details.push(summary.reason);
    if (typeof summary.message === 'string') details.push(summary.message);
    const unit = ['chip', 'coin', 'gem'].includes(summary.currency) ? summary.currency : '(đơn vị chưa lưu)';
    if (Number.isSafeInteger(summary.stake)) details.push(`Mức cược ${format(summary.stake)} ${unit}`);
    if (Number.isSafeInteger(summary.pot)) details.push(`Pot ${format(summary.pot)} ${unit}`);
    if (Number.isSafeInteger(summary.score)) details.push(`Điểm ${format(summary.score)}`);
    if (Number.isSafeInteger(summary.durationMs)) details.push(`Thời lượng ~${Math.max(1, Math.round(summary.durationMs / 60000))} phút`);
    for (const detail of details) card.appendChild(node('p', 'history-result', detail));
    return card;
  }

  function renderTransaction(item) {
    const card = node('li', 'history-item');
    const heading = node('div', 'history-item-head');
    heading.append(node('h3', 'history-item-title', item.label || groups[item.group] || 'Biến động ví'),
      node('time', 'history-date', displayDate(item.createdAt)));
    card.appendChild(heading);
    const meta = node('div', 'history-meta');
    appendMeta(meta, 'Nhóm', groups[item.group] || 'Giao dịch khác');
    if (item.gameId) appendMeta(meta, 'Game', gameLabel(item.gameId));
    appendMeta(meta, 'Phòng', item.roomCode || null);
    appendMeta(meta, 'Ván', item.matchId || null);
    card.appendChild(meta);

    const currencies = Array.isArray(item.receipt?.currencies) ? item.receipt.currencies : [];
    if (!currencies.length) {
      card.appendChild(node('p', 'history-result', 'Máy chủ chưa gửi chi tiết biến động của giao dịch này.'));
    } else {
      const receipt = node('div', 'receipt');
      for (const detail of currencies) {
        const group = node('section', 'receipt-currency');
        group.appendChild(node('h4', 'currency-title', currencyLabel(detail.currency)));
        const lines = node('div', 'delta-lines');
        const knownDeltas = Number.isSafeInteger(detail.availableDelta) && Number.isSafeInteger(detail.reservedDelta);
        if (knownDeltas) {
          const total = Number.isSafeInteger(detail.totalAssetDelta) ? detail.totalAssetDelta : detail.availableDelta + detail.reservedDelta;
          const move = (label, amount) => {
            const value = node('div', 'delta');
            value.append(node('small', '', label), node('strong', '', signed(amount)));
            lines.appendChild(value);
          };
          move('Khả dụng thay đổi', detail.availableDelta);
          move('Đang giữ thay đổi', detail.reservedDelta);
          move('Tổng tài sản thay đổi', total);
          group.appendChild(lines);
          if (item.group === 'settlement') group.appendChild(badge(total > 0 ? 'Thắng' : total < 0 ? 'Thua' : 'Không đổi', total > 0 ? 'is-win' : total < 0 ? 'is-loss' : ''));
        } else group.appendChild(node('p', 'history-result', 'Máy chủ chưa gửi đủ ba số delta.'));
        const sources = Array.isArray(detail.sources) ? detail.sources : [];
        if (sources.length) group.appendChild(node('p', 'sources', `Nguồn: ${sources.map(sourceLabel).join(' · ')}`));
        const notes = Array.isArray(detail.notes) ? detail.notes : [];
        for (const note of notes) if (typeof note === 'string' && note) group.appendChild(node('p', 'receipt-note', note));
        receipt.appendChild(group);
      }
      card.appendChild(receipt);
    }
    if (item.receipt?.idempotentByOperationKey === true) card.appendChild(node('p', 'receipt-idempotency', 'Biên nhận được ghi một lần theo khóa giao dịch; lần gửi lại không cộng hoặc trừ lần nữa.'));
    return card;
  }

  function renderItem(item) {
    if (!item || typeof item !== 'object') return node('li', 'history-item', 'Hoạt động không có đủ dữ liệu hiển thị.');
    if (item.type === 'match') return renderMatch(item);
    if (item.type === 'transaction') return renderTransaction(item);
    return node('li', 'history-item', 'Loại hoạt động chưa được nhận diện; dữ liệu ví được giữ nguyên.');
  }

  function selectedFilters() {
    const data = new FormData(form);
    const query = new URLSearchParams({ limit: '20' });
    for (const key of ['gameId', 'from', 'to', 'roomCode', 'group', 'currency']) {
      const value = String(data.get(key) || '').trim();
      if (value) query.set(key, value);
    }
    return query;
  }

  async function loadPage({ append = false } = {}) {
    if (loading && append) return;
    if (!token) {
      status.hidden = true; auth.hidden = false; empty.hidden = true; more.hidden = true;
      return;
    }
    if (append && !cursor) return;
    const id = ++requestId;
    const query = selectedFilters();
    if (append) query.set('cursor', cursor);
    loading = true; more.disabled = true; empty.hidden = true; auth.hidden = true;
    if (!append) { list.replaceChildren(); seen = new Set(); loadedCount = 0; cursor = null; count.textContent = ''; }
    status.hidden = false; status.textContent = append ? 'Đang tải thêm…' : 'Đang tải lịch sử…';
    try {
      const response = await fetch(`/api/history?${query}`, { headers: { 'X-Profile-Token': token }, cache: 'no-store' });
      let result = {};
      try { result = await response.json(); } catch {}
      if (id !== requestId) return;
      if (!response.ok) {
        if (response.status === 401) { status.hidden = true; auth.hidden = false; more.hidden = true; return; }
        throw new Error(result.error || 'Không tải được lịch sử.');
      }
      const items = Array.isArray(result.items) ? result.items : [];
      for (const item of items) {
        if (item?.id && seen.has(item.id)) continue;
        if (item?.id) seen.add(item.id);
        list.appendChild(renderItem(item)); loadedCount++;
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      more.hidden = !cursor; more.disabled = false;
      count.textContent = loadedCount ? `${loadedCount.toLocaleString('vi-VN')} mục đã tải` : '';
      empty.hidden = loadedCount !== 0;
      status.textContent = loadedCount ? (cursor ? 'Đã tải xong trang này.' : 'Đã tải hết kết quả phù hợp.') : 'Không tìm thấy hoạt động phù hợp.';
    } catch (error) {
      if (id !== requestId) return;
      more.hidden = !append || !cursor; more.disabled = false;
      status.textContent = error?.message || 'Không tải được lịch sử. Kiểm tra kết nối rồi thử lại.';
      if (!append && loadedCount === 0) empty.hidden = true;
    } finally {
      if (id === requestId) { loading = false; more.disabled = false; }
    }
  }

  form.addEventListener('submit', event => { event.preventDefault(); loadPage(); });
  document.getElementById('history-reset').addEventListener('click', () => { form.reset(); loadPage(); });
  more.addEventListener('click', () => loadPage({ append: true }));
  loadPage();
})();
