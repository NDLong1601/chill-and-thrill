'use strict';

/* M1 portal shell. It owns navigation and catalog rendering; The Gang's
   existing table controller remains mounted only after the server sends a room state. */
(function portalShell() {
  const PREFERENCE_KEY = 'chill-thrill:portal-home-preferences';
  const PREFERENCE_VERSION = 1;
  const $ = id => document.getElementById(id);
  const gameApi = window.ChillThrillGameApi.createGameApiClient({ socket, timeoutMs: 10000 });
  const state = { catalog: null, avatar: '🕶️', currentGame: null, inviteCode: '', categoryFilter: null, profile: null,
    identityDirty: { name: false, avatar: false }, identityRevision: { name: 0, avatar: 0 },
    preferences: { favorites: [], recent: [] }, preferencesLoaded: false, preferenceNotice: '' };
  document.body.dataset.activeTab = 'lobby';
  let leavingForGame = false;
  let leavingSavedRoom = false;
  let profileRequestId = 0;
  let profileSaveChain = Promise.resolve();
  let ensureProfilePromise = null;
  const safeRead = (key, fallback) => { try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const safeWrite = (key, value) => { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const writeName = name => GameValues.writeName(name);
  const cleanCode = value => String(value || '').trim().toUpperCase();
  const escText = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const profileToken = () => { try { return localStorage.getItem('chill-thrill:profile-token') || localStorage.getItem('gang.profileToken') || ''; } catch { return ''; } };
  const storeProfileToken = token => { try { if (token) { localStorage.setItem('chill-thrill:profile-token', token); localStorage.setItem('gang.profileToken', token); socket.auth = { profileToken: token }; } } catch {} };
  const profileHeaders = token => token ? { 'X-Profile-Token': token } : {};
  const formatChip = value => Number.isInteger(value) ? `${value.toLocaleString('vi-VN')} chip` : '—';

  function registryGameIds() {
    return new Set((state.catalog?.games || []).map(game => game.gameId));
  }

  function loadPortalPreferences() {
    if (state.preferencesLoaded) return;
    state.preferencesLoaded = true;
    try {
      const raw = localStorage.getItem(PREFERENCE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved || saved.version !== PREFERENCE_VERSION || typeof saved !== 'object') {
        state.preferenceNotice = 'Tùy chọn game đã lưu không đúng phiên bản; đang dùng danh sách mới.';
        return;
      }
      const validIds = registryGameIds();
      const uniqueValid = list => [...new Set(Array.isArray(list) ? list.filter(id => typeof id === 'string' && validIds.has(id)) : [])];
      state.preferences = { favorites: uniqueValid(saved.favorites), recent: uniqueValid(saved.recent).slice(0, 6) };
    } catch {
      state.preferenceNotice = 'Không đọc được tùy chọn game trên thiết bị; danh sách chỉ dùng trong phiên này.';
    }
  }

  function savePortalPreferences() {
    try {
      localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ version: PREFERENCE_VERSION,
        favorites: state.preferences.favorites, recent: state.preferences.recent }));
      state.preferenceNotice = '';
    } catch {
      state.preferenceNotice = 'Trình duyệt đang chặn lưu tùy chọn; danh sách chỉ được giữ trong phiên này.';
    }
    renderPreferenceStatus();
  }

  function renderPreferenceStatus() {
    const target = $('portal-preference-status');
    if (!target) return;
    target.textContent = state.preferenceNotice;
    target.hidden = !state.preferenceNotice;
  }

  function toggleFavorite(gameId) {
    if (!registryGameIds().has(gameId)) return;
    const favorites = state.preferences.favorites;
    state.preferences.favorites = favorites.includes(gameId)
      ? favorites.filter(id => id !== gameId)
      : [gameId, ...favorites];
    savePortalPreferences();
    renderCatalog();
  }

  function recordRecentGame(gameId) {
    const game = state.catalog?.games.find(item => item.gameId === gameId && item.status === 'playable');
    if (!game) return;
    state.preferences.recent = [gameId, ...state.preferences.recent.filter(id => id !== gameId)].slice(0, 6);
    savePortalPreferences();
    renderCatalog();
  }

  function setError(message, target = 'portal-error') {
    const box = $(target); if (!box) return;
    box.textContent = message || ''; box.classList.toggle('hidden', !message);
  }

  function nameValue() {
    return GameValues.cleanDisplayName($('portal-player-name')?.value || $('inp-name')?.value || '');
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
    window.CurrencyWallet?.render(profile);
    const displayName = state.identityDirty.name ? nameValue() : profile?.name;
    const displayAvatar = state.identityDirty.avatar ? state.avatar : profile?.avatar;
    if ($('portal-profile-label')) $('portal-profile-label').textContent = profile ? `${displayAvatar} ${displayName}` : 'Chưa tạo';
    if ($('portal-profile-scope')) $('portal-profile-scope').textContent = profile ? 'Ổn định trên server local' : 'Tạo khi bạn vào phòng';
    if ($('portal-wallet-available')) $('portal-wallet-available').textContent = formatChip(wallet?.available);
    if ($('portal-wallet-reserved')) $('portal-wallet-reserved').textContent = formatChip(wallet?.reserved);
    if ($('portal-wallet-ingame')) $('portal-wallet-ingame').textContent = formatChip(wallet?.inGame);
    if ($('portal-wallet-note')) $('portal-wallet-note').textContent = profile ? 'Chip Poker · coin · gem trên server local' : 'Tiền tệ chỉ dùng trong chế độ kịch tính';
    if ($('portal-nav-chip')) $('portal-nav-chip').textContent = Number.isInteger(wallet?.available) ? wallet.available.toLocaleString('vi-VN') : '—';
    if ($('portal-nav-avatar')) $('portal-nav-avatar').textContent = displayAvatar || state.avatar;
    if ($('portal-nav-name')) $('portal-nav-name').textContent = displayName || nameValue() || 'Hồ sơ & Ví';
    renderMissions(state.profile?.missions || []);
    renderWalletHistory(state.profile?.history || []);
  }

  function hydrateIdentity(payload, revisions = state.identityRevision) {
    const profile = payload?.profile;
    if (!profile) return;
    if (!state.identityDirty.name && revisions.name === state.identityRevision.name) {
      const name = GameValues.cleanDisplayName(profile.name);
      $('portal-player-name').value = name;
      $('profile-display-name').value = name;
      if ($('portal-nav-name')) $('portal-nav-name').textContent = name || 'Hồ sơ & Ví';
      writeName(name);
    }
    if (!state.identityDirty.avatar && revisions.avatar === state.identityRevision.avatar && profile.avatar) {
      state.avatar = profile.avatar;
      syncAvatarPickers();
      if (typeof selectedAvatar !== 'undefined') selectedAvatar = state.avatar;
      if ($('portal-nav-avatar')) $('portal-nav-avatar').textContent = state.avatar;
    }
  }

  function syncAvatarPickers() {
    document.querySelectorAll('[data-avatar]').forEach(button => button.classList.toggle('active', button.dataset.avatar === state.avatar));
  }

  function chooseAvatar(avatar) {
    state.avatar = avatar;
    state.identityDirty.avatar = true; state.identityRevision.avatar++;
    syncAvatarPickers();
    if (typeof selectedAvatar !== 'undefined') selectedAvatar = state.avatar;
    if ($('portal-nav-avatar')) $('portal-nav-avatar').textContent = state.avatar;
    if (profileToken()) saveIdentity().catch(error => setError(error.message));
  }

  function applyProfile(payload, revisions = state.identityRevision) {
    hydrateIdentity(payload, revisions);
    renderAccount(payload);
  }

  async function patchIdentity() {
    const token = profileToken();
    if (!token) return;
    const fields = {};
    const revisions = { ...state.identityRevision };
    if (state.identityDirty.name) fields.name = nameValue();
    if (state.identityDirty.avatar) fields.avatar = state.avatar;
    if (!Object.keys(fields).length) return;
    const requestId = ++profileRequestId;
    const response = await fetch('/api/profile', { method: 'PATCH', headers: { ...profileHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
    const profile = await response.json();
    if (!response.ok) throw new Error(profile.error || 'Không lưu được hồ sơ.');
    for (const field of Object.keys(fields)) {
      if (state.identityRevision[field] === revisions[field]) state.identityDirty[field] = false;
    }
    if (requestId === profileRequestId && token === profileToken()) applyProfile({ profile, missions: state.profile?.missions || [], history: state.profile?.history || [] });
  }

  function saveIdentity() {
    if (!profileToken()) return Promise.resolve();
    const pending = profileSaveChain.then(async () => {
      while (profileToken() && (state.identityDirty.name || state.identityDirty.avatar)) await patchIdentity();
    });
    profileSaveChain = pending.catch(() => {});
    return pending;
  }

  function renderMissions(missions) {
    const target = $('portal-missions'); if (!target) return;
    if (!missions.length) { target.innerHTML = '<p class="portal-muted">Tạo hồ sơ để xem nhiệm vụ.</p>'; return; }
    target.innerHTML = missions.map(mission => {
      const progress = mission.locked ? 'Đang khóa' : `${mission.progress}/${mission.target}`;
      const status = mission.locked ? mission.lockReason : mission.claimed ? 'Đã nhận' : mission.completed ? 'Có thể nhận' : mission.kind === 'tutorial' ? `Thưởng một lần · ${progress}` : `Hôm nay · ${progress}`;
      const action = mission.completed && !mission.claimed && !mission.locked
        ? `<button type="button" class="btn btn-gold" data-claim-mission="${escText(mission.missionId)}" data-claim-version="${mission.version}" data-claim-period="${escText(mission.periodKey)}">${GameArt.icon('coin')} NHẬN ${mission.reward} coin</button>` : mission.kind === 'tutorial' && !mission.claimed ? '<a class="btn btn-outline" href="/tutorial">HỌC HƯỚNG DẪN</a>' : '';
      return `<div class="portal-mission ${mission.locked ? 'is-locked' : ''}"><div class="portal-mission-copy"><strong>${GameArt.icon('coin')}${escText(mission.title)} · +${mission.reward} coin</strong><small>${escText(mission.description)} · ${escText(status)}</small></div>${action}</div>`;
    }).join('');
    target.querySelectorAll('[data-claim-mission]').forEach(button => button.addEventListener('click', () => claimMission(button)));
  }

  function renderWalletHistory(history) {
    const target = $('portal-wallet-history'); if (!target) return;
    if (!history.length) { target.innerHTML = '<p class="portal-muted">Chưa có giao dịch.</p>'; return; }
    target.innerHTML = history.slice(0, 12).map(entry => {
      const delta = entry.availableDelta || 0;
      const unit = entry.currency || 'chip';
      const label = delta > 0 ? `+${delta.toLocaleString('vi-VN')} ${unit}` : delta < 0 ? `${delta.toLocaleString('vi-VN')} ${unit}` : 'Nội bộ';
      return `<div class="portal-ledger-row"><div class="portal-ledger-copy"><strong>${escText(entry.reason)}</strong><small>${new Date(entry.createdAt).toLocaleString('vi-VN')}</small></div><span class="portal-ledger-amount ${delta < 0 ? 'is-negative' : ''}">${label}</span></div>`;
    }).join('');
  }

  async function loadAccount() {
    const token = profileToken();
    if (!token) return renderAccount(null);
    try { await profileSaveChain; } catch {}
    if (token !== profileToken()) return;
    const requestId = ++profileRequestId;
    const revisions = { ...state.identityRevision };
    try {
      const response = await fetch('/api/profile', { headers: profileHeaders(token) });
      if (!response.ok) {
        if (response.status === 401 && requestId === profileRequestId && token === profileToken()) { localStorage.removeItem('gang.profileToken'); localStorage.removeItem('chill-thrill:profile-token'); socket.auth = {}; }
        throw new Error();
      }
      const payload = await response.json();
      if (requestId === profileRequestId && token === profileToken()) applyProfile(payload, revisions);
    } catch {
      if (requestId === profileRequestId && token === profileToken()) renderAccount(null);
    }
  }

  async function loadStorageStatus() {
    try {
      const response = await fetch('/api/storage/status');
      const status = await response.json();
      const note = $('portal-account-note'); if (!note) return;
      note.textContent = status.error ? 'Có lỗi lưu trữ. Hãy liên hệ người mở bàn để kiểm tra.' : 'Tên, số dư và lịch sử chơi của bạn.';
      note.classList.toggle('has-error', !!status.error);
    } catch { const note = $('portal-account-note'); if (note) note.textContent = 'Không đọc được trạng thái lưu trữ. Kiểm tra máy chủ local.'; }
  }

  async function ensureLocalProfile() {
    if (ensureProfilePromise) return ensureProfilePromise;
    ensureProfilePromise = (async () => {
      await saveIdentity();
      let token = profileToken();
      if (token) {
        const response = await fetch('/api/profile', { headers: profileHeaders(token) });
        if (!response.ok) throw new Error('Phiên hồ sơ local đã hết hạn. Hãy tải lại trang để tạo lại hồ sơ.');
        const payload = await response.json();
        if (token === profileToken()) applyProfile(payload);
        await saveIdentity();
        return token;
      }
      const revisions = { ...state.identityRevision };
      const response = await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nameValue(), avatar: state.avatar }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Không tạo được hồ sơ local.');
      token = payload.profileToken; storeProfileToken(token);
      if (payload.recoveryCode) localStorage.setItem('chill-thrill:profile-recovery', payload.recoveryCode);
      state.identityDirty.name = state.identityRevision.name !== revisions.name;
      state.identityDirty.avatar = state.identityRevision.avatar !== revisions.avatar;
      profileRequestId++;
      applyProfile(payload, revisions);
      await saveIdentity();
      return token;
    })();
    try { return await ensureProfilePromise; }
    finally { ensureProfilePromise = null; }
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
    const favorite = state.preferences.favorites.includes(game.gameId);
    return `<article class="portal-game-card ${playable ? 'is-playable' : 'is-coming'}" data-game-card="${escText(game.gameId)}">
      <div class="portal-game-card-top"><span class="portal-game-icon">${game.category === 'casual' ? (game.gameId === 'the-gang' ? '🏦' : '🎲') : GameArt.icon(game.gameId === 'poker' ? 'chip' : 'coin')}</span><div class="portal-card-tools"><span class="portal-game-status ${playable ? 'playable' : ''}">${status}</span><button type="button" class="portal-favorite-toggle" data-favorite-toggle="${escText(game.gameId)}" aria-pressed="${favorite}" aria-label="${favorite ? 'Bỏ' : 'Thêm'} ${escText(game.name)} ${favorite ? 'khỏi' : 'vào'} yêu thích">${favorite ? '★' : '☆'}</button></div></div>
      <h3>${escText(game.name)}</h3><p>${escText(game.shortDescription)}</p><div class="portal-game-meta"><span>${variants}</span></div>
      <div class="portal-game-actions">${playable ? `<button type="button" class="btn btn-gold" data-game-quick-action="${escText(game.gameId)}">TẠO PHÒNG</button>` : ''}<button type="button" class="btn btn-outline" data-game-card-action="${escText(game.gameId)}">${playable ? 'LUẬT & CẤU HÌNH' : 'XEM LỘ TRÌNH'}</button></div>
    </article>`;
  }

  function shortcutCard(game, kind) {
    const favorite = state.preferences.favorites.includes(game.gameId);
    const label = kind === 'recent' ? 'Đã chơi gần đây' : 'Game yêu thích';
    return `<article class="portal-shortcut-card" data-game-card="${escText(game.gameId)}">
      <div class="portal-shortcut-copy"><span class="portal-shortcut-icon" aria-hidden="true">${game.category === 'casual' ? (game.gameId === 'the-gang' ? '🏦' : '🎲') : GameArt.icon(game.gameId === 'poker' ? 'chip' : 'coin')}</span><div><h4>${escText(game.name)}</h4><span>${label} · ${game.category === 'casual' ? 'Giải trí' : 'Kịch tính'}</span></div></div>
      <button type="button" class="portal-favorite-toggle" data-favorite-toggle="${escText(game.gameId)}" aria-pressed="${favorite}" aria-label="${favorite ? 'Bỏ' : 'Thêm'} ${escText(game.name)} ${favorite ? 'khỏi' : 'vào'} yêu thích">${favorite ? '★' : '☆'}</button>
      <div class="portal-shortcut-actions"><button type="button" class="btn btn-gold" data-game-quick-action="${escText(game.gameId)}">TẠO PHÒNG</button><button type="button" class="btn btn-outline" data-game-shortcut-detail="${escText(game.gameId)}">CHI TIẾT</button></div>
    </article>`;
  }

  function renderPersonalList(containerId, ids, kind) {
    const target = $(containerId); if (!target) return;
    const games = ids.map(id => state.catalog.games.find(game => game.gameId === id))
      .filter(game => game && game.status === 'playable' && (!state.categoryFilter || game.category === state.categoryFilter));
    if (!games.length) {
      const hasItems = ids.some(id => state.catalog.games.some(game => game.gameId === id));
      const message = hasItems && state.categoryFilter
        ? 'Không có game trong bộ lọc này.'
        : kind === 'favorites' ? 'Chưa có game yêu thích. Nhấn dấu sao trên một thẻ game để lưu.' : 'Các game bạn tạo hoặc vào sẽ xuất hiện ở đây.';
      target.innerHTML = `<p class="portal-shortcut-empty">${message}</p>`;
      return;
    }
    target.innerHTML = games.map(game => shortcutCard(game, kind === 'favorites' ? 'favorite' : 'recent')).join('');
  }

  function bindCatalogActions() {
    document.querySelectorAll('[data-favorite-toggle]').forEach(button => button.addEventListener('click', () => toggleFavorite(button.dataset.favoriteToggle)));
    document.querySelectorAll('[data-game-card-action]').forEach(button => button.addEventListener('click', () => route(`/games/${encodeURIComponent(button.dataset.gameCardAction)}`)));
    document.querySelectorAll('[data-game-shortcut-detail]').forEach(button => button.addEventListener('click', () => route(`/games/${encodeURIComponent(button.dataset.gameShortcutDetail)}`)));
    document.querySelectorAll('[data-game-quick-action]').forEach(button => button.addEventListener('click', () => openQuickCreate(button.dataset.gameQuickAction)));
    document.querySelectorAll('[data-game-card]').forEach(card => card.addEventListener('dblclick', event => {
      if (event.target.closest('button')) return;
      route(`/games/${encodeURIComponent(card.dataset.gameCard)}`);
    }));
  }

  function renderCatalog() {
    if (!state.catalog) return;
    loadPortalPreferences();
    for (const category of ['casual', 'thrill']) {
      const section = document.querySelector(`[data-category-section="${category}"]`);
      if (section) section.hidden = !!state.categoryFilter && state.categoryFilter !== category;
      const target = $(`${category}-games`); if (!target) continue;
      const games = state.catalog.games.filter(game => game.category === category);
      target.innerHTML = games.map(gameCard).join('');
    }
    document.querySelectorAll('[data-category-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.categoryFilter === (state.categoryFilter || 'all'))));
    renderPersonalList('portal-favorite-games', state.preferences.favorites, 'favorites');
    renderPersonalList('portal-recent-games', state.preferences.recent, 'recent');
    bindCatalogActions();
    renderPreferenceStatus();
    if ($('portal-tagline')) $('portal-tagline').textContent = `${state.catalog.portalName} · chọn bàn, mời bạn bè, chơi trong LAN.`;
  }

  function openQuickCreate(gameId) {
    const game = state.catalog?.games.find(item => item.gameId === gameId && item.status === 'playable');
    if (!game) return;
    route(`/games/${encodeURIComponent(gameId)}?quick=create`);
    requestAnimationFrame(() => {
      $('detail-create-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const firstRequired = game.currency === 'coin' ? $('detail-stake') : game.gameId === 'uno' ? $('detail-uno-variant') : $('detail-room-name');
      firstRequired?.focus({ preventScroll: true });
    });
  }

  function renderContinue() {
    const session = (() => { try { return JSON.parse(localStorage.getItem('chill-thrill:last-room')); } catch { return null; } })() || safeRead('gang.session', null);
    const valid = session && /^[A-Z2-9]{4}$/.test(session.roomCode || '') && session.sessionToken;
    $('portal-continue')?.classList.toggle('hidden', !valid);
    if (valid && $('portal-continue-code')) $('portal-continue-code').textContent = session.roomCode;
  }

  function detailRules(game) {
    if (game.gameId === 'the-gang') return '<p>Cùng đồng đội mở két qua bốn vòng. Mỗi người giữ bài bí mật và chọn chip để xếp sức mạnh bài từ thấp đến cao.</p><ul><li>Không nói lộ lá bài; giao tiếp bằng chip và các câu theo luật.</li><li>Chốt chip khi cả đội đồng ý. Đổi chip thì cả đội chốt lại.</li><li>Lật bài theo thứ tự chip đỏ; xếp đúng thì mở được két.</li></ul>';
    if (game.gameId === 'uno') return '<p>Mỗi người nhận 7 lá. Đánh lá cùng màu, số hoặc biểu tượng; Wild cho phép chọn màu.</p><ul><li>Chọn bộ 112 lá (2–4 người) hoặc 108 lá (2–6 người).</li><li>Không cộng dồn phạt và không đánh nhiều lá cùng lúc.</li><li>Gọi UNO khi còn 1 lá. Người hết bài trước thắng ván.</li></ul>';
    const info = game.gameId === 'poker' ? `Blinds ${game.blinds.small}/${game.blinds.big} chip · buy-in ${game.buyIn.min}–${game.buyIn.max} chip.`
      : game.currency === 'coin' ? 'Chọn mức cược bên dưới. Mức giữ tối đa sẽ hiển thị tại phòng chờ.' : 'Vai ẩn, nhân vật và bộ cơ bản BANG!.';
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
    $('detail-meta').innerHTML = `<span>${game.minPlayers}–${game.maxPlayers} người</span><span>${game.capabilities.usesWallet ? game.currency === 'chip' ? 'Chip Poker' : 'Coin' : 'Chơi cùng bạn bè'}</span>`;
    $('detail-rules-version').textContent = '';
    $('detail-tutorial-wrap').hidden = gameId !== 'the-gang';
    $('detail-rules').innerHTML = detailRules(game);
    let practiceLink = $('detail-practice');
    if (!practiceLink) {
      practiceLink = document.createElement('a');
      practiceLink.id = 'detail-practice';
      practiceLink.className = 'btn btn-outline';
      practiceLink.textContent = 'Luyện tập với bot';
      $('detail-rules').after(practiceLink);
    }
    practiceLink.hidden = !['uno', 'tien-len'].includes(gameId);
    practiceLink.href = `/practice?game=${gameId}&variant=${gameId === 'uno' ? 'classic-local-v1' : 'south-v1'}`;
    const playable = game.status === 'playable';
    $('detail-create-panel').classList.toggle('hidden', !playable);
    $('detail-coming-soon').classList.toggle('hidden', playable);
    const isUno = game.gameId === 'uno';
    const integrated = ['the-gang', 'uno'].includes(game.gameId);
    $('detail-room-name').value = `${game.name} · Phòng LAN`;
    $('detail-difficulty-field').classList.toggle('hidden', game.gameId !== 'the-gang');
    for (const id of ['detail-room-name', 'detail-max-players', 'detail-visibility', 'detail-password']) $(id).closest('label').classList.remove('hidden');
    $('detail-password').value = '';
    let stakeField = $('detail-stake');
    if (!stakeField) {
      const label = document.createElement('label'); label.id = 'detail-stake-field';
      label.innerHTML = 'Mức cược coin<input id="detail-stake" class="form-input" type="text" inputmode="text" maxlength="24" autocomplete="off" placeholder="500, 1.000, 10k, 10tr"><small>k = 1.000 · tr = 1.000.000 coin</small>';
      $('detail-create-panel').querySelector('.portal-form-grid').append(label); stakeField = $('detail-stake');
      stakeField.setAttribute('aria-describedby', 'detail-stake-summary');
      stakeField.addEventListener('blur', () => { try { stakeField.value = GameValues.formatAmount(parseDetailStake(stakeField.value)); } catch (error) { setError(error.message, 'detail-error'); } });
      stakeField.addEventListener('input', updateDetailStakePreview);
      const preview = document.createElement('small'); preview.id = 'detail-stake-summary'; preview.setAttribute('role', 'status'); label.append(preview);
    }
    $('detail-stake-field').hidden = game.currency !== 'coin';
    const defaultStake = game.stakeRules?.defaultStake ?? game.stake;
    stakeField.value = Number.isSafeInteger(defaultStake) ? GameValues.formatAmount(defaultStake) : '';
    $('detail-variant-note').textContent = isUno
      ? '112 lá · 2–4 người. Người hết bài trước thắng ván.'
      : 'Chọn mức thử thách phù hợp với cấp độ của đội chơi.';
    if (!integrated) $('detail-variant-note').textContent = game.capabilities.usesWallet ? `Dùng ví ${game.currency === 'chip' ? 'chip Poker' : 'coin'} trong cùng hồ sơ. Mức cược được hiển thị tại phòng chờ.` : 'Bộ cơ bản BANG! · 4–7 người · không dùng tiền tệ.';
    $('detail-create').textContent = `TẠO PHÒNG ${game.name.toUpperCase()}`;
    let variantField = $('detail-uno-variant');
    if (!variantField) {
      const label = document.createElement('label'); label.id = 'detail-uno-variant-field'; label.innerHTML = 'Biến thể UNO<select id="detail-uno-variant" class="form-select"><option value="classic-local-v1">112 lá · 2–4 người</option><option value="classic-108-v1">108 lá · 2–6 người</option></select>';
      $('detail-create-panel').querySelector('.portal-form-grid').append(label); variantField = $('detail-uno-variant');
      variantField.addEventListener('change', () => { const max = variantField.value === 'classic-local-v1' ? 4 : 6; $('detail-max-players').innerHTML = Array.from({ length: max - 1 }, (_, i) => `<option value="${i + 2}" ${i + 2 === max ? 'selected' : ''}>${i + 2}</option>`).join('');
        $('detail-variant-note').textContent = variantField.value === 'classic-local-v1' ? '112 lá · 2–4 người.' : '108 lá · 2–6 người.'; updateDetailStakePreview(); });
    }
    $('detail-uno-variant-field').classList.toggle('hidden', !isUno);
    variantField.value = 'classic-local-v1';
    const maximum = isUno ? 4 : game.maxPlayers;
    $('detail-max-players').innerHTML = Array.from({ length: maximum - game.minPlayers + 1 }, (_, index) => {
      const count = game.minPlayers + index;
      return `<option value="${count}" ${count === maximum ? 'selected' : ''}>${count}</option>`;
    }).join('');
    updateDetailStakePreview();
    showPortalScreen('screen-game-detail');
    if (new URLSearchParams(location.search).get('quick') === 'create') requestAnimationFrame(() => {
      $('detail-create-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const firstRequired = game.currency === 'coin' ? $('detail-stake') : isUno ? $('detail-uno-variant') : $('detail-room-name');
      firstRequired?.focus({ preventScroll: true });
    });
  }

  function updateDetailStakePreview() {
    const target = $('detail-stake-summary'), game = state.currentGame;
    if (!target || game?.currency !== 'coin') return;
    const count = Number($('detail-max-players')?.value);
    const stakeRules = game.stakeRules;
    const capacityRules = stakeRules?.limitsByPlayerCount?.[count] || stakeRules?.limitsByPlayerCount?.[String(count)];
    const minStake = Number.isSafeInteger(stakeRules?.minStake) && stakeRules.minStake > 0 ? stakeRules.minStake : 1;
    const maxStake = Number.isSafeInteger(capacityRules?.maxStake) && capacityRules.maxStake >= minStake ? capacityRules.maxStake : null;
    try {
      const amount = GameValues.parseAmount($('detail-stake').value, { min: minStake, ...(maxStake === null ? {} : { max: maxStake }) });
      const preview = GameValues.describeEconomy({ currency: game.currency, stake: amount }, { includeMaxLoss: false });
      const holdFactor = Number.isSafeInteger(capacityRules?.holdFactor) && capacityRules.holdFactor > 0 ? capacityRules.holdFactor : null;
      const hold = holdFactor === null ? 'khoản giữ do máy chủ xác nhận' : `giữ tối đa ${GameValues.formatAmount(amount * holdFactor)} coin/người · tối đa với ${count} người`;
      target.textContent = `${preview} · ${hold}${maxStake === null ? '.' : ` · cược tối đa ${GameValues.formatAmount(maxStake)} coin với ${count} người.`}`;
      $('detail-stake').placeholder = maxStake === null ? 'Máy chủ xác nhận giới hạn' : `Tối đa ${GameValues.formatAmount(maxStake)} coin`;
    } catch {
      target.textContent = maxStake === null
        ? 'Nhập mức cược hợp lệ; máy chủ xác nhận khoản giữ và giới hạn.'
        : `Nhập mức cược từ ${GameValues.formatAmount(minStake)} đến ${GameValues.formatAmount(maxStake)} coin · tối đa với ${count} người.`;
      $('detail-stake').placeholder = maxStake === null ? 'Máy chủ xác nhận giới hạn' : `Tối đa ${GameValues.formatAmount(maxStake)} coin`;
    }
  }

  function parseDetailStake(value) {
    const game = state.currentGame;
    const count = Number($('detail-max-players')?.value);
    const stakeRules = game?.stakeRules;
    const capacityRules = stakeRules?.limitsByPlayerCount?.[count] || stakeRules?.limitsByPlayerCount?.[String(count)];
    const min = Number.isSafeInteger(stakeRules?.minStake) && stakeRules.minStake > 0 ? stakeRules.minStake : 1;
    const max = Number.isSafeInteger(capacityRules?.maxStake) && capacityRules.maxStake >= min ? capacityRules.maxStake : Number.MAX_SAFE_INTEGER;
    return GameValues.parseAmount(value, { min, max });
  }

  function renderInvite(code) {
    state.categoryFilter = null;
    state.inviteCode = cleanCode(code);
    if ($('portal-room-code')) $('portal-room-code').value = state.inviteCode;
    if ($('portal-tagline')) $('portal-tagline').textContent = `Bạn được mời vào phòng ${state.inviteCode}. Chọn tên rồi vào đúng game của phòng.`;
    showPortalScreen('screen-home');
  }

  function switchTab(name) {
    const isProfile = name === 'profile';
    const activeTab = isProfile ? 'profile' : 'lobby';
    document.body.dataset.activeTab = activeTab;
    $('btn-tab-lobby')?.classList.toggle('active', !isProfile);
    $('btn-tab-lobby')?.setAttribute('aria-selected', String(!isProfile));
    $('btn-tab-profile')?.classList.toggle('active', isProfile);
    $('btn-tab-profile')?.setAttribute('aria-selected', String(isProfile));
    $('btn-toggle-profile')?.classList.toggle('active', isProfile);
    if (isProfile) {
      loadAccount();
    }
  }

  function switchAccountPanel(name) {
    const tabs = [...document.querySelectorAll('[data-account-tab]')];
    const selected = tabs.find(tab => tab.dataset.accountTab === name) || tabs[0];
    if (!selected) return;
    for (const tab of tabs) {
      const active = tab === selected;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !active;
    }
  }

  function renderRoute() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/missions') {
      state.categoryFilter = null;
      renderCatalog();
      showPortalScreen('screen-home');
      switchTab('profile');
      switchAccountPanel('missions');
      loadAccount();
      return;
    }
    if (path === '/') {
      state.categoryFilter = null;
      renderCatalog();
      const invite = new URLSearchParams(location.search).get('room');
      if (invite) {
        switchTab('lobby');
        renderInvite(invite);
      } else {
        renderContinue();
        loadAccount();
        showPortalScreen('screen-home');
      }
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

  let joining = false;
  async function enterRoom(code, password = '') {
    try {
      syncLegacyIdentity();
      const token = await ensureLocalProfile();
      if (!socket.connected) throw new Error('Chưa kết nối máy chủ. Kiểm tra WiFi rồi thử lại.');
      const response = await gameApi.joinRoom({ roomCode: code, playerName: nameValue(), avatar: state.avatar, password, profileToken: token });
      if (!response.ok) throw new Error(response.error?.message || 'Không vào được phòng.');
      route(`/rooms/${code}`);
      return response.data;
    } catch (error) {
      const message = error.message || 'Không vào được phòng.';
      setError(message);
      if (window.RoomAccess?.open) RoomAccess.fail(message);
      return null;
    }
  }

  async function joinRoom() {
    if (joining) return;
    const code = cleanCode($('portal-room-code')?.value);
    const name = nameValue();
    if (!name) return setError('Nhập tên hiển thị trước khi vào phòng.');
    if (!/^[A-Z2-9]{4}$/.test(code)) return setError('Mã phòng phải có đúng 4 ký tự.');
    setError('');
    joining = true; $('portal-join').disabled = true;
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
      if (!response.ok) throw new Error('Không tìm thấy phòng.');
      const room = await response.json();
      const game = state.catalog?.games.find(item => item.gameId === room.gameId);
      if (!game || game.status !== 'playable') throw new Error('Phòng này thuộc game chưa phát hành.');
      if (room.requiresPassword) RoomAccess.prompt(code, password => enterRoom(code, password));
      else await enterRoom(code);
    } catch (error) { setError(error.message || 'Không vào được phòng.'); }
    finally { joining = false; $('portal-join').disabled = false; }
  }


  async function createRoom() {
    const game = state.currentGame;
    const name = nameValue();
    if (!game || game.status !== 'playable') return;
    if (!name) return setError('Nhập tên hiển thị trước khi tạo phòng.', 'detail-error');
    const password = $('detail-password').value;
    if (password && !/^\d{6}$/.test(password)) return setError('Mật khẩu phòng cần đúng 6 chữ số, hoặc để trống.', 'detail-error');
    let stake;
    if (game.currency === 'coin') { try { stake = parseDetailStake($('detail-stake').value); } catch (error) { return setError(error.message, 'detail-error'); } }
    setError('', 'detail-error');
    syncLegacyIdentity();
    const config = { ...(stake === undefined ? {} : { stake }),
      roomName: $('detail-room-name').value.trim(), maxPlayers: Number($('detail-max-players').value),
      visibility: $('detail-visibility').value, password,
      ...(game.gameId === 'uno' ? { variant: $('detail-uno-variant').value } : {}),
    };
    if (!socket.connected) return setError('Chưa kết nối server. Kiểm tra máy chủ và WiFi rồi thử lại.', 'detail-error');
    setError('');
    try {
      const token = await ensureLocalProfile();
      const response = await gameApi.createRoom({ gameId: game.gameId, category: game.category, difficulty: $('detail-difficulty').value, playerName: name, avatar: state.avatar, profileToken: token, config });
      if (!response.ok) throw new Error(response.error?.message || 'Không tạo được phòng.');
    } catch (error) { setError(error.message || 'Không tạo được hồ sơ local.', 'detail-error'); }
  }

  async function resumeRoom() {
    const session = (() => { try { return JSON.parse(localStorage.getItem('chill-thrill:last-room')); } catch { return null; } })() || safeRead('gang.session', null);
    if (!session?.roomCode || !session.sessionToken) return;
    syncLegacyIdentity();
    if (/^\/(uno|tien-len|poker|sam-loc|phom|bang)$/.test(session.entryPath || '')) {
      localStorage.setItem(`chill-thrill:${session.gameId}:${session.roomCode}`, JSON.stringify({ ...session, handoff: true }));
      socket.disconnect(); location.assign(`${session.entryPath}?room=${encodeURIComponent(session.roomCode)}&returnTo=portal`); return;
    }
    route(`/rooms/${session.roomCode}`);
    try {
      const response = await gameApi.resumeRoom({ roomCode: session.roomCode, gameId: session.gameId, sessionToken: session.sessionToken, profileToken: profileToken(), handoff: true });
      if (!response.ok) setError(response.error?.message || 'Không khôi phục được phòng.');
    } catch (error) { setError(error.message || 'Không khôi phục được phòng.'); }
  }

  function leaveSavedRoom() {
    const session = (() => { try { return JSON.parse(localStorage.getItem('chill-thrill:last-room')); } catch { return null; } })() || safeRead('gang.session', null);
    if (!session?.roomCode || !session.sessionToken) return;
    if (!socket.connected) return setError('Chưa kết nối server. Kiểm tra máy chủ và WiFi rồi thử lại.');
    if (roomCode === session.roomCode && lastState) return socket.emit('leave_room', { roomCode: session.roomCode });
    leavingSavedRoom = true;
    socket.emit('room:resume', { roomCode: session.roomCode, sessionToken: session.sessionToken, profileToken: profileToken() }, result => {
      if (result?.error) {
        leavingSavedRoom = false;
        if (result.error.includes('hết hạn')) {
          sessionStorage.removeItem('gang.session');
          const last = (() => { try { return JSON.parse(localStorage.getItem('chill-thrill:last-room')); } catch { return null; } })();
          if (last?.roomCode === session.roomCode) localStorage.removeItem('chill-thrill:last-room');
          renderContinue();
        }
        return setError(result.error);
      }
      socket.emit('leave_room', { roomCode: session.roomCode });
    });
  }

  function bind() {
    const identity = document.querySelector('.portal-identity-controls');
    const profileIdentity = identity.cloneNode(true);
    profileIdentity.innerHTML = profileIdentity.innerHTML.replaceAll('portal-player-name', 'profile-display-name').replaceAll('portal-avatar-picker', 'profile-avatar-picker');
    identity.replaceWith(profileIdentity);
    $('portal-entry-identity').append(identity);
    const nameInputs = [$('portal-player-name'), $('profile-display-name')];
    for (const field of nameInputs) {
      field.addEventListener('input', () => {
        nameInputs.forEach(other => { if (other !== field) other.value = field.value; });
        state.identityDirty.name = true; state.identityRevision.name++;
        syncLegacyIdentity();
        if ($('portal-nav-name')) $('portal-nav-name').textContent = nameValue() || 'Hồ sơ & Ví';
      });
      field.addEventListener('change', () => { if (profileToken()) saveIdentity().catch(error => setError(error.message)); });
    }
    document.addEventListener('currency-wallet:updated', event => renderAccount(event.detail));
    $('btn-tab-lobby')?.addEventListener('click', () => switchTab('lobby'));
    $('btn-tab-profile')?.addEventListener('click', () => switchTab('profile'));
    $('btn-toggle-profile')?.addEventListener('click', () => switchTab('profile'));
    $('portal-nav-balances-btn')?.addEventListener('click', () => switchTab('profile'));
    const accountTablist = document.querySelector('.portal-account-subtabs');
    const accountTabs = [...(accountTablist?.querySelectorAll('[data-account-tab]') || [])];
    switchAccountPanel(accountTabs.find(tab => tab.getAttribute('aria-selected') === 'true')?.dataset.accountTab || 'overview');
    const setAccountTabOrientation = () => accountTablist?.setAttribute('aria-orientation', matchMedia('(max-width: 760px)').matches ? 'horizontal' : 'vertical');
    setAccountTabOrientation();
    window.addEventListener('resize', setAccountTabOrientation);
    accountTablist?.addEventListener('click', event => {
      const tab = event.target.closest('[data-account-tab]');
      if (tab) switchAccountPanel(tab.dataset.accountTab);
    });
    accountTablist?.addEventListener('keydown', event => {
      const current = accountTabs.indexOf(event.target.closest('[data-account-tab]'));
      if (current < 0) return;
      const horizontal = accountTablist.getAttribute('aria-orientation') === 'horizontal';
      const previous = horizontal ? 'ArrowLeft' : 'ArrowUp';
      const next = horizontal ? 'ArrowRight' : 'ArrowDown';
      let index = current;
      if (event.key === previous) index = (current - 1 + accountTabs.length) % accountTabs.length;
      else if (event.key === next) index = (current + 1) % accountTabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = accountTabs.length - 1;
      else return;
      event.preventDefault();
      switchAccountPanel(accountTabs[index].dataset.accountTab);
      accountTabs[index].focus();
    });
    $('btn-profile-exit')?.addEventListener('click', () => {
      switchTab('lobby');
      if (location.pathname === '/missions') route('/', true);
    });
    ['focusin', 'input'].forEach(event => {
      $('wallet-exchange')?.addEventListener(event, () => switchTab('profile'));
    });
    document.querySelectorAll('[data-nav-target]').forEach(link => {
      link.addEventListener('click', event => {
        switchTab('lobby');
        const targetId = link.getAttribute('href')?.replace('#', '');
        const targetEl = targetId ? document.getElementById(targetId) : null;
        if (targetEl) {
          event.preventDefault();
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
    document.querySelectorAll('[data-category-filter]').forEach(button => button.addEventListener('click', () => {
      const category = button.dataset.categoryFilter;
      route(category === 'all' ? '/' : `/play/${category}`);
    }));
    document.querySelectorAll('.portal-avatar, .avatar-opt').forEach(button => button.addEventListener('click', () => chooseAvatar(button.dataset.avatar)));
    const initialName = GameValues.readName();
    $('portal-player-name').value = initialName;
    $('profile-display-name').value = initialName;
    if (initialName && $('portal-nav-name')) $('portal-nav-name').textContent = initialName;
    $('portal-player-name').addEventListener('input', () => {
      if ($('portal-nav-name')) $('portal-nav-name').textContent = nameValue() || 'Hồ sơ & Ví';
    });
    $('portal-room-code').addEventListener('input', event => { event.target.value = cleanCode(event.target.value).slice(0, 4); });
    $('portal-join').addEventListener('click', joinRoom);
    $('portal-room-code').addEventListener('keydown', event => { if (event.key === 'Enter') joinRoom(); });
    $('portal-resume').addEventListener('click', resumeRoom);
    $('portal-leave').addEventListener('click', leaveSavedRoom);
    $('portal-account-refresh')?.addEventListener('click', loadAccount);
    $('detail-create').addEventListener('click', createRoom);
    $('detail-max-players').addEventListener('change', updateDetailStakePreview);
    $('btn-detail-tutorial')?.addEventListener('click', () => {
      $('btn-tutorial')?.click();
    });
    $('btn-back-home')?.addEventListener('click', () => route('/'));
    document.querySelectorAll('[data-portal-home]').forEach(button => button.addEventListener('click', () => route('/')));
    const openExternal = result => {
      if (!result?.entryPath || !/^\/(uno|tien-len|poker|sam-loc|phom|bang)$/.test(result.entryPath)) return false;
      if (leavingSavedRoom) return true;
      if (leavingForGame) return true;
      leavingForGame = true;
      storeProfileToken(result.profileToken);
      localStorage.setItem(`chill-thrill:${result.gameId}:${result.roomCode}`, JSON.stringify({ ...result, handoff: true }));
      localStorage.setItem('chill-thrill:last-room', JSON.stringify(result));
      socket.disconnect();
      location.assign(`${result.entryPath}?room=${encodeURIComponent(result.roomCode)}&returnTo=portal`); return true;
    };
    const trackSuccessfulEntry = result => {
      if (result?.roomCode && result?.sessionToken && typeof result.gameId === 'string') recordRecentGame(result.gameId);
    };
    for (const event of ['room_created', 'room_joined', 'room_resumed']) socket.on(event, result => { trackSuccessfulEntry(result); openExternal(result); });
    socket.on('room:created', result => { trackSuccessfulEntry(result); if (!openExternal(result) && result?.roomCode) route(`/rooms/${result.roomCode}`); });
    for (const event of ['room:created', 'room:joined', 'room:resumed']) socket.on(event, result => {
      trackSuccessfulEntry(result);
      if (result?.profileToken) storeProfileToken(result.profileToken);
      if (result?.roomCode && result?.sessionToken) { safeWrite('gang.session', result); writeName(nameValue()); openExternal(result); }
    });
    socket.on('room:error', result => {
      const message = result?.message || 'Không thực hiện được thao tác.';
      setError(message, $('screen-game-detail').classList.contains('active') ? 'detail-error' : 'portal-error');
      toast(message);
    });
    socket.on('join_error', result => setError(result?.message || 'Không vào được phòng.'));
    socket.on('resume_error', result => setError(result?.message || 'Không khôi phục được phòng.'));
    socket.on('room_left', () => {
      leavingSavedRoom = false;
      state.inviteCode = ''; $('portal-room-code').value = ''; setError(''); setError('', 'detail-error');
      route('/', true);
    });
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
