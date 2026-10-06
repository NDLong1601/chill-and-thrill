'use strict';

const PROFILE_TOKEN_KEY = 'chill-thrill:profile-token';
const PROFILE_RECOVERY_KEY = 'chill-thrill:profile-recovery';
const socket = io({ auth: localStorage.getItem(PROFILE_TOKEN_KEY) ? { profileToken: localStorage.getItem(PROFILE_TOKEN_KEY) } : {} });
const $ = id => document.getElementById(id);
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['S', 'C', 'D', 'H'];
const SUIT_LABELS = { S: '♠', C: '♣', D: '♦', H: '♥' };
let state = null, roomCode = '', playerId = '', selected = new Set(), bySuit = false;

function rememberProfile(payload) { if (!payload?.profile) return; if (payload.profileToken) localStorage.setItem(PROFILE_TOKEN_KEY, payload.profileToken); if (payload.recoveryCode) localStorage.setItem(PROFILE_RECOVERY_KEY, payload.recoveryCode); if (!$('name').value.trim()) $('name').value = payload.profile.displayName || ''; if (payload.profile.avatar) $('avatar').value = payload.profile.avatar; }
function escapeHtml(value) { const node = document.createElement('div'); node.textContent = value || ''; return node.innerHTML; }
function notice(message) { $('notice').textContent = message || ''; }
function show(id) { ['home-view', 'room-view', 'game-view'].forEach(view => { $(view).hidden = view !== id; }); }
function actionId() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function credentialsKey(code) { return `chill-thrill:tien-len:${code}`; }
function player(id) { return state?.players.find(item => item.id === id); }
function cardText(card) { return `${card.rank}${SUIT_LABELS[card.suit] || ''}`; }
function send(action, extra = {}) { if (state) socket.emit('game_action', { roomCode, action, actionId: actionId(), expectedRevision: state.revision, ...extra }); }
function rank(card) { return RANKS.indexOf(card.rank); }
function suit(card) { return SUITS.indexOf(card.suit); }
function sorted(cards) { return [...cards].sort((left, right) => bySuit ? suit(left) - suit(right) || rank(left) - rank(right) : rank(left) - rank(right) || suit(left) - suit(right)); }
function describe(cards) {
  if (!cards.length) return 'Chọn một hoặc nhiều lá.';
  const ordered = [...cards].sort((a, b) => rank(a) - rank(b) || suit(a) - suit(b)); const counts = new Map(); ordered.forEach(card => counts.set(rank(card), (counts.get(rank(card)) || 0) + 1)); const keys = [...counts.keys()].sort((a, b) => a - b); const contiguous = keys.every((value, index) => !index || value === keys[index - 1] + 1);
  if (ordered.length === 1) return `Rác · ${cardText(ordered[0])}`;
  if (counts.size === 1 && ordered.length <= 4) return ['','', 'Đôi', 'Sám', 'Tứ quý'][ordered.length];
  if (ordered.length >= 3 && counts.size === ordered.length && keys.at(-1) < 12 && contiguous) return `Sảnh ${ordered.length} lá`;
  if (ordered.length >= 6 && ordered.length % 2 === 0 && counts.size === ordered.length / 2 && [...counts.values()].every(value => value === 2) && keys.at(-1) < 12 && contiguous) return `${ordered.length / 2} đôi thông`;
  return 'Tổ hợp chưa hợp lệ';
}
function renderPlayers(target, game = false) {
  target.innerHTML = ''; state.players.forEach(item => { const el = document.createElement('article'); el.className = `player${item.id === state.currentPlayerId ? ' current' : ''}${item.id === playerId ? ' me' : ''}`; const detail = game ? ` · ${item.handCount} lá${item.id === state.currentPlayerId ? ' · đang lượt' : ''}${item.leaveAfterHand ? ' · rời sau ván' : ''}` : `${item.isHost ? ' · chủ bàn' : ''}${item.ready ? ' · sẵn sàng' : ''}`; el.innerHTML = `<span class="player-name">${escapeHtml(item.avatar)} ${escapeHtml(item.name)}</span><span class="player-meta">${item.connected ? '● online' : '○ mất kết nối'}${detail}</span>`; target.appendChild(el); });
}
function renderRoom() { show('room-view'); $('room-title').textContent = state.roomCode; renderPlayers($('room-players')); const me = player(playerId), allReady = state.players.length >= 2 && state.players.every(item => item.ready && item.connected), economy = GameValues.describeEconomy(state); $('ready').textContent = me?.ready ? 'Bỏ sẵn sàng' : 'Sẵn sàng'; $('start').hidden = !me?.isHost; $('start').disabled = !allReady; $('room-status').textContent = state.players.length < 2 ? `Cần thêm ít nhất một người. ${economy}.` : allReady ? `Mọi người đã sẵn sàng. ${economy} trước khi chia bài.` : `Đợi mọi người bấm Sẵn sàng. ${economy}.`; }
function renderTable() { const cards = state.topPlay?.cards || []; $('table-cards').innerHTML = cards.map(card => `<span class="table-card has-card-art ${card.suit === 'H' || card.suit === 'D' ? 'red' : ''}" aria-label="${cardText(card)}">${GameArt.cardMarkup(card)}</span>`).join('') || '<span class="empty-table">Đang chờ người dẫn vòng.</span>'; $('table-combo').textContent = cards.length ? `Tổ hợp: ${describe(cards)}` : 'Vòng mới: người dẫn được đánh tổ hợp hợp lệ bất kỳ.'; }
function renderActions() { const target = $('actions'); target.innerHTML = ''; const me = player(playerId); const myTurn = state.phase === 'TURN' && state.currentPlayerId === playerId && !state.paused; const add = (label, fn, primary = false) => { const button = document.createElement('button'); button.textContent = label; if (primary) button.className = 'primary'; button.addEventListener('click', fn); target.appendChild(button); };
  if (myTurn) { add(`Đánh ${selected.size ? `(${selected.size} lá)` : ''}`, () => { if (!playSelectionReason()) send('play', { cardIds: [...selected] }); }, true);
    const playButton = target.lastElementChild; playButton.disabled = Boolean(playSelectionReason()); playButton.title = playSelectionReason(); playButton.setAttribute('aria-describedby', 'selection-info'); if (state.topPlay && state.leaderId !== playerId) add('Bỏ lượt', () => send('pass')); if (me?.isHost && !state.playedAny) add(`Hủy ván và hoàn ${currencyUnit()}`, () => send('cancel_before_first_play')); }
  else target.textContent = state.paused ? `Ván tạm dừng để giữ bài và ${currencyUnit()}; chờ người chơi kết nối lại.` : state.phase === 'RESULT' ? 'Ván đã thanh toán xong.' : `Đang chờ ${player(state.currentPlayerId)?.name || 'người chơi'} thao tác.`;
}
function selectionInfo() {
  const cards = (state.myHand || []).filter(card => selected.has(card.id));
  const reason = playSelectionReason();
  $('selection-info').textContent = cards.length ? (reason || describe(cards)) : 'Chạm một lá hoặc vuốt ngang để chọn nhiều lá. Có thể chọn trước khi chờ lượt.';
}
function playSelectionReason() {
  const cards = (state.myHand || []).filter(card => selected.has(card.id));
  if (!cards.length) return 'Chọn bài để đánh';
  const formation = TienLenRules.classify(cards);
  if (!formation) return 'Tổ hợp chưa hợp lệ';
  if (!state.playedAny && state.initialRequiredCardId && !selected.has(state.initialRequiredCardId)) return 'Lượt mở ván phải có lá thấp nhất được đánh dấu';
  if (state.topPlay && !TienLenRules.canBeat(formation, TienLenRules.classify(state.topPlay.cards))) return 'Bài đã chọn chưa đè được tổ hợp trên bàn';
  return '';
}
function renderHand() {
  const cards = sorted(state.myHand || []), validIds = new Set(cards.map(card => card.id));
  selected = new Set([...selected].filter(id => validIds.has(id)));
  $('hand-count').textContent = `(${cards.length} lá)`; selectionInfo();
  const active = state.phase === 'TURN' && !state.paused;
  HandInteraction.render({ target: $('hand'), cards, selected,
    disabled: () => !active, marked: card => state.initialRequiredCardId === card.id,
    title: card => state.initialRequiredCardId === card.id ? 'Lá thấp nhất: lượt mở ván phải có lá này.' : cardText(card),
    onChange: next => { selected = next; selectionInfo(); renderActions(); }
  });
}
function renderResult() { const target = $('result'); if (!state.result) { target.hidden = true; return; } target.hidden = false; const outcome = state.result.outcomes.find(item => item.playerId === playerId), me = player(playerId); target.innerHTML = `<h2>${state.result.winnerId === playerId ? 'Bạn thắng!' : `${escapeHtml(state.result.winnerName)} thắng ván`}</h2><p>${escapeHtml(state.result.reason)} · pot ${GameValues.formatAmount(state.result.pot)} ${currencyUnit()}. ${outcome ? `Kết quả ví của bạn: ${outcome.delta >= 0 ? '+' : ''}${GameValues.formatAmount(outcome.delta)} ${currencyUnit()}.` : ''}</p>`; target.appendChild(GameValues.createEconomySummary(state)); if (me?.isHost) { const button = document.createElement('button'); button.className = 'primary'; button.textContent = 'Chia ván tiếp'; button.addEventListener('click', () => send('play_again')); target.appendChild(button); } }
function renderGame() { show('game-view'); GameValues.applyEconomy(state, document); $('game-room').textContent = state.roomCode; $('pot').textContent = GameValues.formatAmount(state.phase === 'RESULT' ? state.result?.pot || 0 : state.players.length * state.stake); renderPlayers($('players'), true); const current = player(state.currentPlayerId); $('phase-banner').textContent = state.paused ? 'Ván tạm dừng: đang chờ mọi người kết nối lại.' : state.phase === 'RESULT' ? 'Kết quả đã chốt và pot đã thanh toán.' : state.topPlay ? `Đến lượt ${current?.name || ''}; cần chặt bài trên bàn hoặc bỏ lượt.` : `Đến lượt ${current?.name || ''}; được dẫn vòng mới.`; renderTable(); renderHand(); renderActions(); renderResult(); $('log').innerHTML = ''; state.log.slice(0, 10).forEach(entry => { const li = document.createElement('li'); li.textContent = entry.message; $('log').appendChild(li); }); }
function render() { if (!state) return; state.phase === 'WAITING' ? renderRoom() : renderGame(); }
function requestRoom(event) { const name = $('name').value.trim(); if (!name) return notice('Hãy nhập tên trước.'); const data = { playerName: name, avatar: $('avatar').value, ...(event === 'create_room' ? { gameId: 'tien-len' } : { roomCode: $('room-code').value.trim().toUpperCase() }) }; if (event === 'join_room' && data.roomCode.length !== 4) return notice('Mã bàn cần 4 ký tự.'); socket.emit(event, data); }
$('create').addEventListener('click', () => requestRoom('create_room')); $('join').addEventListener('click', () => requestRoom('join_room')); $('room-code').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase(); }); $('room-code').addEventListener('keydown', event => { if (event.key === 'Enter') requestRoom('join_room'); }); $('ready').addEventListener('click', () => socket.emit('set_ready', { roomCode, ready: !player(playerId)?.ready })); $('start').addEventListener('click', () => socket.emit('start_game', { roomCode })); $('leave').addEventListener('click', () => socket.emit('leave_room', { roomCode })); $('game-leave').addEventListener('click', () => socket.emit('leave_room', { roomCode })); $('sort').addEventListener('click', () => { bySuit = !bySuit; $('sort').textContent = bySuit ? 'Sắp theo giá trị' : 'Sắp theo chất'; $('sort').setAttribute('aria-label', $('sort').textContent); $('sort').title = $('sort').textContent; renderHand(); }); $('copy-code').addEventListener('click', async () => { try { await navigator.clipboard.writeText(roomCode); notice('Đã sao chép mã bàn.'); } catch { notice(`Mã bàn: ${roomCode}`); } });
function storeCredentials(payload) { roomCode = payload.roomCode; playerId = payload.playerId; rememberProfile(payload); localStorage.setItem(credentialsKey(roomCode), JSON.stringify(payload)); }
socket.on('room_created', payload => { storeCredentials(payload); notice('Đã tạo bàn Tiến lên.'); }); socket.on('room_joined', payload => { storeCredentials(payload); notice('Đã vào bàn Tiến lên.'); }); socket.on('room_resumed', payload => { storeCredentials(payload); notice('Đã khôi phục ghế Tiến lên.'); }); socket.on('game_state', next => { if (next.gameId !== 'tien-len') return; if (state?.matchId !== next.matchId || state?.roomCode !== next.roomCode) selected.clear(); state = next; roomCode = next.roomCode; playerId = next.myId; window.TablePreferences?.updateTablePreferences('#game-view', state, { before: '#players' }); render(); }); socket.on('game_error', payload => notice(payload.message)); socket.on('join_error', payload => notice(payload.message)); socket.on('resume_error', payload => { notice(payload.message); show('home-view'); }); socket.on('room_left', () => { state = null; roomCode = ''; playerId = ''; selected.clear(); show('home-view'); }); socket.on('profile_state', rememberProfile); socket.on('connect', () => { socket.emit('profile_status', {}); const code = new URLSearchParams(location.search).get('room')?.trim().toUpperCase(); if (!code || code.length !== 4) return; const saved = localStorage.getItem(credentialsKey(code)); if (saved) { try { socket.emit('resume_room', JSON.parse(saved)); return; } catch {} } $('room-code').value = code; notice('Nhập tên để vào bàn từ lời mời.'); });

function currencyUnit() { return GameValues.currencyLabel(state); }
