'use strict';

/* M1 portal shell. It owns navigation and catalog rendering; The Gang's
   existing table controller remains mounted only after the server sends a room state. */
(function portalShell() {
  const $ = id => document.getElementById(id);
  const state = { catalog: null, avatar: '🕶️', currentGame: null, inviteCode: '', categoryFilter: null, profile: null };
  let leavingForGame = false;
  const safeRead = (key, fallback) => { try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const safeWrite = (key, value) => { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const writeName = name => { try { localStorage.setItem('gang.playerName', name); } catch {} };
  const cleanCode = value => String(value || '').trim().toUpperCase();
  const escText = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const profileToken = () => { try { return localStorage.getItem('chill-thrill:profile-token') || localStorage.getItem('gang.profileToken') || ''; } catch { return ''; } };
  const storeProfileToken = token => { try { if (token) { localStorage.setItem('chill-thrill:profile-token', token); localStorage.setItem('gang.profileToken', token); socket.auth = { profileToken: token }; } } catch {} };
  const profileHeaders = token => token ? { 'X-Profile-Token': token } : {};
  const formatChip = value => Number.isInteger(value) ? `${value.toLocaleString('vi-VN')} ⭐` : '—';

  function setError(message, target = 'portal-error') {
    const box = $(target); if (!box) return;
    box.textContent = message || ''; box.classList.toggle('hidden', !message);
  }

  function nameValue() {
    return ($('portal-player-name')?.value || $('inp-name')?.value || '').trim();
  }

  function syncLegacyIdentity() {
    const name = nameValue();
    if ($('inp-name')) $('inp-name').value = name;
    if (typeof selectedAvatar !== 'undefined') selectedAvatar = state.avatar;
    writeName(name);
  }

  function renderAccount(payload = null) {
    state.profile = payload;
    const profile = state.profile?.profile;
    const wallet = profile?.wallet;
    if ($('portal-profile-label')) $('portal-profile-label').textContent = profile ? `${profile.avatar} ${profile.name}` : 'Chưa tạo';
    if ($('portal-profile-scope')) $('portal-profile-scope').textContent = profile ? 'Ổn định trên server local' : 'Tạo khi bạn vào phòng';
    if ($('portal-wallet-available')) $('portal-wallet-available').textContent = formatChip(wallet?.available);
    if ($('portal-wallet-reserved')) $('portal-wallet-reserved').textContent = formatChip(wallet?.reserved);
    if ($('portal-wallet-ingame')) $('portal-wallet-ingame').textContent = formatChip(wallet?.inGame);
    if ($('portal-wallet-note')) $('portal-wallet-note').textContent = profile ? `${formatChip(wallet?.available)} khả dụng · server local` : 'Ví chip và nhiệm vụ hoạt động trên server local';
    renderMissions(state.profile?.missions || []);
    renderWalletHistory(state.profile?.history || []);
  }

  function renderMissions(missions) {
    const target = $('portal-missions'); if (!target) return;
    if (!missions.length) { target.innerHTML = '<p class="portal-muted">Tạo hồ sơ để xem nhiệm vụ.</p>'; return; }
    target.innerHTML = missions.map(mission => {
      const progress = mission.locked ? 'Đang khóa' : `${mission.progress}/${mission.target}`;
      const status = mission.locked ? mission.lockReason : mission.claimed ? 'Đã nhận' : mission.completed ? 'Có thể nhận' : `Hôm nay · ${progress}`;
      const action = mission.completed && !mission.claimed && !mission.locked
        ? `<button type="button" class="btn btn-gold" data-claim-mission="${escText(mission.missionId)}" data-claim-version="${mission.version}" data-claim-period="${escText(mission.periodKey)}">NHẬN ${mission.reward} ⭐</button>` : '';
      return `<div class="portal-mission ${mission.locked ? 'is-locked' : ''}"><div class="portal-mission-copy"><strong>${escText(mission.title)} · +${mission.reward} ⭐</strong><small>${escText(mission.description)} · ${escText(status)}</small></div>${action}</div>`;
    }).join('');
    target.querySelectorAll('[data-claim-mission]').forEach(button => button.addEventListener('click', () => claimMission(button)));
  }

  function renderWalletHistory(history) {
    const target = $('portal-wallet-history'); if (!target) return;
    if (!history.length) { target.innerHTML = '<p class="portal-muted">Chưa có giao dịch.</p>'; return; }
    target.innerHTML = history.slice(0, 12).map(entry => {
      const delta = entry.availableDelta || 0;
      const label = delta > 0 ? `+${delta.toLocaleString('vi-VN')} ⭐` : delta < 0 ? `${delta.toLocaleString('vi-VN')} ⭐` : 'Nội bộ';
      return `<div class="portal-ledger-row"><div class="portal-ledger-copy"><strong>${escText(entry.reason)}</strong><small>${escText(entry.sourceType)} · ${new Date(entry.createdAt).toLocaleString('vi-VN')}</small></div><span class="portal-ledger-amount ${delta < 0 ? 'is-negative' : ''}">${label}</span></div>`;
    }).join('');
  }

  async function loadAccount() {
    const token = profileToken();
    if (!token) return renderAccount(null);
    try {
      const response = await fetch('/api/profile', { headers: profileHeaders(token) });
      if (!response.ok) {
        if (response.status === 401) { localStorage.removeItem('gang.profileToken'); localStorage.removeItem('chill-thrill:profile-token'); socket.auth = {}; }
        throw new Error();
      }
      renderAccount(await response.json());
    } catch {
      renderAccount(null);
    }
  }

  async function loadStorageStatus() {
    try {
      const response = await fetch('/api/storage/status');
      const status = await response.json();
      const note = $('portal-account-note'); if (!note) return;
      note.textContent = status.error ? `⚠ ${status.error} Hãy dừng server và khôi phục theo hướng dẫn M3.` : `Dữ liệu chỉ nằm trên server LAN này · SQLite schema v${status.schemaVersion} · integrity OK.`;
      note.classList.toggle('has-error', !!status.error);
    } catch { const note = $('portal-account-note'); if (note) note.textContent = 'Không đọc được trạng thái lưu trữ. Kiểm tra máy chủ local.'; }
  }

  async function ensureLocalProfile() {
    let token = profileToken();
    if (token) {
      const response = await fetch('/api/profile', { headers: profileHeaders(token) });
      if (!response.ok) throw new Error('Phiên hồ sơ local đã hết hạn. Hãy tải lại trang để tạo lại hồ sơ.');
      const payload = await response.json();
      state.profile = payload; renderAccount(payload);
      const name = nameValue();
      if (name && (name !== payload.profile.name || state.avatar !== payload.profile.avatar)) {
        const updated = await fetch('/api/profile', { method: 'PATCH', headers: { ...profileHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ name, avatar: state.avatar }) });
        if (updated.ok) renderAccount({ profile: await updated.json(), missions: payload.missions, history: payload.history });
      }
      return token;
    }
    const response = await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameValue(), avatar: state.avatar }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Không tạo được hồ sơ local.');
    token = payload.profileToken; storeProfileToken(token);
    if (payload.recoveryCode) localStorage.setItem('chill-thrill:profile-recovery', payload.recoveryCode);
    renderAccount(payload); return token;
  }

  async function claimMission(button) {
    const token = profileToken(); if (!token) return;
    button.disabled = true;
    try {
      const response = await fetch(`/api/missions/${encodeURIComponent(button.dataset.claimMission)}/claim`, { method: 'POST', headers: { ...profileHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ version: Number(button.dataset.claimVersion), periodKey: button.dataset.claimPeriod }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Chưa thể nhận thưởng.');
      await loadAccount();
    } catch (error) { button.disabled = false; setError(error.message); }
  }

  function route(path, replace = false) {
    const method = replace ? 'replaceState' : 'pushState';
    history[method]({}, '', path);
    renderRoute();
  }

  function showPortalScreen(id) {
    if (typeof showScreen === 'function') showScreen(id);
    else document.querySelectorAll('.screen').forEach(screen => screen.classList.toggle('active', screen.id === id));
  }

  function gameCard(game) {
    const playable = game.status === 'playable';
    const status = playable ? 'Có thể chơi' : 'Sắp có';
    const variants = game.gameId === 'the-gang' ? '4 độ khó · 2–6 người' : `${game.minPlayers}–${game.maxPlayers} người`;
    const buttonLabel = playable ? 'XEM CHI TIẾT →' : 'XEM LỘ TRÌNH →';
    return `<article class="portal-game-card ${playable ? 'is-playable' : 'is-coming'}" data-game-card="${escText(game.gameId)}">
      <div class="portal-game-card-top"><span class="portal-game-icon">${game.gameId === 'the-gang' ? '🏦' : game.category === 'casual' ? '🎲' : '♠️'}</span><span class="portal-game-status ${playable ? 'playable' : ''}">${status}</span></div>
      <h3>${escText(game.name)}</h3><p>${escText(game.shortDescription)}</p><div class="portal-game-meta"><span>${variants}</span><span>Luật v${game.rulesVersion}</span></div>
      <button type="button" class="btn ${playable ? 'btn-gold' : 'btn-outline'}" data-game-card-action="${escText(game.gameId)}">${buttonLabel}</button>
    </article>`;
  }

  function renderCatalog() {
    if (!state.catalog) return;
    for (const category of ['casual', 'thrill']) {
      const section = document.querySelector(`[data-category-section="${category}"]`);
      if (section) section.hidden = !!state.categoryFilter && state.categoryFilter !== category;
      const target = $(`${category}-games`); if (!target) continue;
      const games = state.catalog.games.filter(game => game.category === category);
      target.innerHTML = games.map(gameCard).join('');
    }
    document.querySelectorAll('[data-game-card-action]').forEach(button => button.addEventListener('click', () => route(`/games/${button.dataset.gameCardAction}`)));
    document.querySelectorAll('[data-game-card]').forEach(card => card.addEventListener('dblclick', () => route(`/games/${card.dataset.gameCard}`)));
    if ($('portal-tagline')) $('portal-tagline').textContent = `${state.catalog.portalName} · chọn bàn, mời bạn bè, chơi trong LAN.`;
  }

  function renderContinue() {
    const session = safeRead('gang.session', null) || (() => { try { return JSON.parse(localStorage.getItem('chill-thrill:last-room')); } catch { return null; } })();
    const valid = session && /^[A-Z2-9]{4}$/.test(session.roomCode || '') && session.sessionToken;
    $('portal-continue')?.classList.toggle('hidden', !valid);
    if (valid && $('portal-continue-code')) $('portal-continue-code').textContent = session.roomCode;
  }

  function detailRules(game) {
    if (game.gameId === 'the-gang') return '<p>Chia bài bí mật cho từng người, cùng chọn chip xếp hạng qua bốn vòng, rồi lật bài theo thứ tự chip đỏ để mở két.</p><ul><li>BASIC, ADVANCED, EXPERT và MASTER_THIEF là độ khó.</li><li>Bài, chip xếp hạng và lịch sử do server giữ; không phải ví chip.</li><li>Mất kết nối giữ ghế và cho phép khôi phục bằng token phiên.</li></ul>';
    if (game.gameId === 'uno') return '<p>UNO cổ điển local v1 dùng một bộ 112 lá, chia 7 lá mỗi người và hỗ trợ 2–4 người. Đánh theo màu, số hoặc biểu tượng; Wild chọn màu.</p><ul><li>Không cộng dồn phạt, không nhảy lượt, không đánh nhiều lá.</li><li>+4 có cửa sổ phản đối do server giữ thời hạn; gọi UNO và bắt lỗi cũng có cửa sổ rõ ràng.</li><li>Một ván kết thúc khi một người hết bài; chưa tính đua điểm 500 nhiều ván.</li></ul>';
    const info = game.gameId === 'poker' ? `Blinds ${game.blinds.small}/${game.blinds.big} chip · buy-in ${game.buyIn.min}–${game.buyIn.max} chip.`
      : game.stake ? `Đơn vị chip: ${game.stake}. Bàn chơi hiển thị khoản giữ và cách thanh toán trước khi bắt đầu.` : 'Vai ẩn, nhân vật và bộ cơ bản BANG!.';
    return `<p>${escText(game.shortDescription)}</p><p>${escText(info)}</p><a href="${escText(game.rulesPath)}" target="_blank" rel="noopener">Xem luật và bảng kết quả</a>`;
  }

  function renderDetail(gameId) {
    const game = state.catalog?.games.find(item => item.gameId === gameId);
    if (!game) { showPortalScreen('screen-not-found'); return; }
    state.currentGame = game;
    $('detail-category').textContent = game.category === 'casual' ? 'GIẢI TRÍ' : 'KỊCH TÍNH';
    $('detail-title').textContent = game.name;
    $('detail-description').textContent = game.shortDescription;
    $('detail-status').textContent = game.status === 'playable' ? '● Có thể chơi' : '◌ Sắp có';
    $('detail-status').className = `portal-detail-status ${game.status === 'playable' ? 'is-playable' : 'is-coming'}`;
    $('detail-meta').innerHTML = `<span>${game.minPlayers}–${game.maxPlayers} người</span><span>Luật v${game.rulesVersion}</span><span>${game.capabilities.usesWallet ? 'Chip ảo trên server local' : 'Không dùng ví chip'}</span>`;
    $('detail-rules-version').textContent = `Version ${game.rulesVersion}`;
    $('detail-rules').innerHTML = detailRules(game);
    const playable = game.status === 'playable';
    $('detail-create-panel').classList.toggle('hidden', !playable);
    $('detail-coming-soon').classList.toggle('hidden', playable);
    const isUno = game.gameId === 'uno';
    const integrated = ['the-gang', 'uno'].includes(game.gameId);
    $('detail-room-name').value = `${game.name} · Phòng LAN`;
    $('detail-difficulty-field').classList.toggle('hidden', game.gameId !== 'the-gang');
    for (const id of ['detail-room-name', 'detail-max-players', 'detail-visibility', 'detail-password']) $(id).closest('label').classList.toggle('hidden', !integrated);
    $('detail-variant-note').textContent = isUno
      ? 'Cổ điển local v1: 2–4 người, một ván kết thúc khi có người hết bài; không dùng ví chip.'
      : 'BASIC / ADVANCED / EXPERT / MASTER_THIEF là độ khó riêng của The Gang, không phải category hay game variant.';
    if (!integrated) $('detail-variant-note').textContent = game.capabilities.usesWallet ? 'Dùng cùng hồ sơ và ví chip. Mức chip được hiển thị tại phòng chờ trước khi bắt đầu.' : 'Bộ cơ bản BANG! · 4–7 người · không cược chip.';
    $('detail-create').textContent = `TẠO PHÒNG ${game.name.toUpperCase()}`;
    let variantField = $('detail-uno-variant');
    if (!variantField) {
      const label = document.createElement('label'); label.id = 'detail-uno-variant-field'; label.innerHTML = 'Biến thể UNO<select id="detail-uno-variant" class="form-select"><option value="classic-local-v1">112 lá · 2–4 người</option><option value="classic-108-v1">108 lá · 2–6 người</option></select>';
      $('detail-create-panel').querySelector('.portal-form-grid').append(label); variantField = $('detail-uno-variant');
      variantField.addEventListener('change', () => { const max = variantField.value === 'classic-local-v1' ? 4 : 6; $('detail-max-players').innerHTML = Array.from({ length: max - 1 }, (_, i) => `<option value="${i + 2}" ${i + 2 === max ? 'selected' : ''}>${i + 2}</option>`).join('');
        $('detail-variant-note').textContent = variantField.value === 'classic-local-v1' ? '112 lá, 2–4 người; luật cổ điển local v1.' : '108 lá, 2–6 người; luật bản đang có trong thư mục mới. Bạn sẽ vào bàn UNO riêng.'; });
    }
    $('detail-uno-variant-field').classList.toggle('hidden', !isUno);
    variantField.value = 'classic-local-v1';
    const maximum = isUno ? 4 : game.maxPlayers;
    $('detail-max-players').innerHTML = Array.from({ length: maximum - game.minPlayers + 1 }, (_, index) => {
      const count = game.minPlayers + index;
      return `<option value="${count}" ${count === maximum ? 'selected' : ''}>${count}</option>`;
    }).join('');
    showPortalScreen('screen-game-detail');
  }

  function renderInvite(code) {
    state.categoryFilter = null;
    state.inviteCode = cleanCode(code);
    if ($('portal-room-code')) $('portal-room-code').value = state.inviteCode;
    if ($('portal-tagline')) $('portal-tagline').textContent = `Bạn được mời vào phòng ${state.inviteCode}. Chọn tên rồi vào đúng game của phòng.`;
    showPortalScreen('screen-home');
  }

  function renderRoute() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/missions') { state.categoryFilter = null; renderCatalog(); showPortalScreen('screen-home'); loadAccount(); $('portal-account')?.scrollIntoView({ block: 'start' }); return; }
    if (path === '/') {
      state.categoryFilter = null;
      const invite = new URLSearchParams(location.search).get('room');
      if (invite) renderInvite(invite); else { renderContinue(); loadAccount(); showPortalScreen('screen-home'); }
      return;
    }
    const detailMatch = path.match(/^\/games\/([^/]+)$/);
    if (detailMatch) { renderDetail(detailMatch[1]); return; }
    const categoryMatch = path.match(/^\/play\/(casual|thrill)$/);
    if (categoryMatch) { state.categoryFilter = categoryMatch[1]; renderCatalog(); renderContinue(); showPortalScreen('screen-home'); return; }
    const roomMatch = path.match(/^\/rooms\/([A-Z2-9]{4})$/i);
    if (roomMatch) { renderInvite(roomMatch[1]); return; }
    showPortalScreen('screen-not-found');
  }

  async function joinRoom() {
    const code = cleanCode($('portal-room-code')?.value);
    const name = nameValue();
    if (!name) return setError('Nhập tên hiển thị trước khi vào phòng.');
    if (!/^[A-Z2-9]{4}$/.test(code)) return setError('Mã phòng phải có đúng 4 ký tự.');
    setError('');
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
      if (!response.ok) throw new Error('Không tìm thấy phòng.');
      const room = await response.json();
      const game = state.catalog?.games.find(item => item.gameId === room.gameId);
      if (!game || game.status !== 'playable') throw new Error('Phòng này thuộc game chưa phát hành.');
      const password = $('portal-room-password')?.value || '';
      if (room.requiresPassword && !password) return setError('Phòng riêng cần mật khẩu. Mã phòng không thay thế cho mật khẩu.');
      syncLegacyIdentity();
      const token = await ensureLocalProfile();
      if (!socket.connected) return setError('Chưa kết nối server. Kiểm tra máy chủ và WiFi rồi thử lại.');
      route(`/rooms/${code}`);
      socket.emit('join_room', { roomCode: code, playerName: name, avatar: state.avatar, password, profileToken: token });
    } catch (error) { setError(error.message || 'Không vào được phòng.'); }
  }

  async function createRoom() {
    const game = state.currentGame;
    const name = nameValue();
    if (!game || game.status !== 'playable') return;
    if (!name) return setError('Nhập tên hiển thị trước khi tạo phòng.', 'detail-error');
    syncLegacyIdentity();
    const config = {
      roomName: $('detail-room-name').value.trim(), maxPlayers: Number($('detail-max-players').value),
      visibility: $('detail-visibility').value, password: $('detail-password').value,
      ...(game.gameId === 'uno' ? { variant: $('detail-uno-variant').value } : {}),
    };
    if (!socket.connected) return setError('Chưa kết nối server. Kiểm tra máy chủ và WiFi rồi thử lại.', 'detail-error');
    setError('');
    try { const token = await ensureLocalProfile(); socket.emit('room:create', { gameId: game.gameId, category: game.category, difficulty: $('detail-difficulty').value, variant: 'standard', playerName: name, avatar: state.avatar, profileToken: token, config }); }
    catch (error) { setError(error.message || 'Không tạo được hồ sơ local.', 'detail-error'); }
  }

  function resumeRoom() {
    const session = safeRead('gang.session', null) || (() => { try { return JSON.parse(localStorage.getItem('chill-thrill:last-room')); } catch { return null; } })();
    if (!session?.roomCode || !session.sessionToken) return;
    syncLegacyIdentity(); route(`/rooms/${session.roomCode}`);
    socket.emit('room:resume', { roomCode: session.roomCode, gameId: session.gameId, sessionToken: session.sessionToken, profileToken: profileToken() });
  }

  function bind() {
    document.querySelectorAll('.portal-avatar').forEach(button => button.addEventListener('click', () => {
      document.querySelectorAll('.portal-avatar').forEach(item => item.classList.remove('active'));
      button.classList.add('active'); state.avatar = button.dataset.avatar;
      if (profileToken()) fetch('/api/profile', { method: 'PATCH', headers: { ...profileHeaders(profileToken()), 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: state.avatar }) }).then(loadAccount).catch(() => {});
    }));
    $('portal-player-name').value = (() => { try { return localStorage.getItem('gang.playerName') || ''; } catch { return ''; } })();
    $('portal-room-code').addEventListener('input', event => { event.target.value = cleanCode(event.target.value).slice(0, 4); });
    $('portal-join').addEventListener('click', joinRoom);
    $('portal-room-code').addEventListener('keydown', event => { if (event.key === 'Enter') joinRoom(); });
    $('portal-resume').addEventListener('click', resumeRoom);
    $('portal-account-refresh')?.addEventListener('click', loadAccount);
    $('portal-player-name').addEventListener('change', () => { if (profileToken()) fetch('/api/profile', { method: 'PATCH', headers: { ...profileHeaders(profileToken()), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameValue(), avatar: state.avatar }) }).then(loadAccount).catch(() => {}); });
    $('detail-create').addEventListener('click', createRoom);
    $('portal-tutorial').addEventListener('click', () => { route('/games/the-gang'); setTimeout(() => { showPortalScreen('screen-lobby'); $('btn-tutorial')?.click(); }, 0); });
    $('btn-back-home')?.addEventListener('click', () => route('/'));
    document.querySelectorAll('[data-portal-home]').forEach(button => button.addEventListener('click', () => route('/')));
    const openExternal = result => {
      if (!result?.entryPath || !/^\/(uno|tien-len|poker|sam-loc|phom|bang)$/.test(result.entryPath)) return false;
      if (leavingForGame) return true;
      leavingForGame = true;
      storeProfileToken(result.profileToken);
      localStorage.setItem(`chill-thrill:${result.gameId}:${result.roomCode}`, JSON.stringify(result));
      localStorage.setItem('chill-thrill:last-room', JSON.stringify(result));
      location.assign(`${result.entryPath}?room=${encodeURIComponent(result.roomCode)}`); return true;
    };
    for (const event of ['room_created', 'room_joined', 'room_resumed']) socket.on(event, result => openExternal(result));
    socket.on('room:created', result => { if (!openExternal(result) && result?.roomCode) route(`/rooms/${result.roomCode}`); });
    for (const event of ['room:created', 'room:joined', 'room:resumed']) socket.on(event, result => {
      if (result?.profileToken) storeProfileToken(result.profileToken);
      if (result?.roomCode && result?.sessionToken) { safeWrite('gang.session', result); writeName(nameValue()); openExternal(result); }
    });
    socket.on('room:error', result => setError(result?.message || 'Không thực hiện được thao tác.'));
    socket.on('join_error', result => setError(result?.message || 'Không vào được phòng.'));
    socket.on('resume_error', result => setError(result?.message || 'Không khôi phục được phòng.'));
    window.addEventListener('popstate', renderRoute);
    window.addEventListener('storage', renderContinue);
    loadAccount();
    loadStorageStatus();
  }

  fetch('/api/registry').then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(catalog => {
    state.catalog = catalog; renderCatalog(); renderRoute();
  }).catch(() => {
    state.catalog = { games: [] }; if ($('casual-games')) $('casual-games').innerHTML = '<div class="portal-loading">Không tải được danh mục từ server.</div>';
    if ($('thrill-games')) $('thrill-games').innerHTML = '<div class="portal-loading">Không tải được danh mục từ server.</div>';
    renderRoute();
  });
  bind();
})();
