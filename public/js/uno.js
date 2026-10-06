'use strict';

const PROFILE_TOKEN_KEY = 'chill-thrill:profile-token';
const PROFILE_RECOVERY_KEY = 'chill-thrill:profile-recovery';
const existingProfileToken = localStorage.getItem(PROFILE_TOKEN_KEY);
const socket = io({ auth: existingProfileToken ? { profileToken: existingProfileToken } : {} });
const $ = id => document.getElementById(id);
const colors = ['red', 'yellow', 'green', 'blue'];
const colorNames = { red: 'Đỏ', yellow: 'Vàng', green: 'Xanh lá', blue: 'Xanh dương' };
const symbolNames = { skip: 'BỎ', reverse: 'ĐỔI', draw2: '+2', wild: 'WILD', wild4: '+4' };
let state = null, selectedColor = 'red', roomCode = '', playerId = '';

function rememberProfile(payload) {
  if (!payload?.profile) return;
  if (payload.profileToken) localStorage.setItem(PROFILE_TOKEN_KEY, payload.profileToken);
  if (payload.recoveryCode) localStorage.setItem(PROFILE_RECOVERY_KEY, payload.recoveryCode);
  if (!$('name').value.trim()) $('name').value = payload.profile.displayName || '';
  if (payload.profile.avatar) $('avatar').value = payload.profile.avatar;
}

function escapeHtml(value) { const element = document.createElement('div'); element.textContent = value || ''; return element.innerHTML; }
function show(view) { ['home-view', 'room-view', 'game-view'].forEach(id => { $(id).hidden = id !== view; }); }
function notice(message) { $('notice').textContent = message || ''; }
function id() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function credentialsKey(code) { return `chill-thrill:uno:${code}`; }
function send(action, extra = {}) {
  if (!state) return;
  socket.emit('game_action', { roomCode, action, actionId: id(), expectedRevision: state.revision, ...extra });
}
function cardText(card) { return typeof card.symbol === 'number' ? String(card.symbol) : symbolNames[card.symbol] || card.symbol; }
function playerById(id) { return state?.players.find(player => player.id === id); }
function timerText(deadline) { const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)); return `${seconds}s`; }

function renderPlayers(target, game = false) {
  target.innerHTML = '';
  state.players.forEach(player => {
    const item = document.createElement('article'); item.dataset.playerId = player.id; item.className = `player${player.id === state.currentPlayerId ? ' current' : ''}${player.id === playerId ? ' me' : ''}`;
    const role = player.isHost ? ' · chủ phòng' : '';
    const turn = game && player.id === state.currentPlayerId ? ' · đang lượt' : '';
    const leave = player.leaveAfterHand ? ' · rời sau ván' : '';
    item.innerHTML = `<span class="player-name">${escapeHtml(player.avatar)} ${escapeHtml(player.name)}</span><span class="player-meta">${player.connected ? '● online' : '○ mất kết nối'}${game ? ` · ${player.handCount} lá${turn}${leave}` : `${role}${player.ready ? ' · sẵn sàng' : ''}`}</span>`;
    target.appendChild(item);
  });
}
function renderRoom() {
  show('room-view'); $('room-title').textContent = state.roomCode;
  renderPlayers($('room-players'));
  const me = playerById(playerId), allReady = state.players.length >= 2 && state.players.every(player => player.ready && player.connected);
  $('ready').textContent = me?.ready ? 'Bỏ sẵn sàng' : 'Sẵn sàng';
  $('start').hidden = !me?.isHost; $('start').disabled = !allReady;
  $('room-status').textContent = state.players.length < 2 ? 'Cần thêm ít nhất một người.' : allReady ? 'Mọi người đã sẵn sàng.' : 'Đợi mọi người bấm Sẵn sàng.';
}
function renderGame() {
  show('game-view'); $('game-room').textContent = state.roomCode; renderPlayers($('players'), true);
  $('game-leave').textContent = state.phase === 'RESULT' ? 'Rời phòng' : 'Rời phòng · hủy ván';
  const top = state.discardTop; $('draw-count').textContent = `${state.drawPileCount} lá`;
  const discard = $('discard-pile'); discard.className = `pile discard-pile ${top?.color || (top?.symbol?.startsWith('wild') ? 'wild' : '')}`;
  discard.textContent = top ? cardText(top) : '?'; $('current-color').textContent = `Màu hiện tại: ${colorNames[state.currentColor] || '-'}`; $('direction').textContent = state.direction === 1 ? '↻ Theo chiều kim đồng hồ' : '↺ Ngược chiều kim đồng hồ';
  const current = playerById(state.currentPlayerId); let banner = state.paused ? 'Ván tạm dừng: đang chờ người chơi kết nối lại.' : current ? `Đến lượt ${current.name}.` : 'Ván đã kết thúc.';
  if (state.reactionDeadlineAt) banner += ` Cửa sổ phản ứng: ${timerText(state.reactionDeadlineAt)}.`; $('phase-banner').textContent = banner;
  renderColours(); renderReaction(); renderHand(); renderResult();
  $('log').innerHTML = ''; state.log.slice(0, 8).forEach(entry => { const li = document.createElement('li'); li.textContent = entry.message; $('log').appendChild(li); });
}
function renderColours() {
  const target = $('colour-picker'); target.innerHTML = '';
  colors.forEach(color => { const button = document.createElement('button'); button.type = 'button'; button.className = `${color}${selectedColor === color ? ' selected' : ''}`; button.title = colorNames[color]; button.addEventListener('click', () => { selectedColor = color; renderColours(); }); target.appendChild(button); });
}
function renderReaction() {
  const target = $('reaction'); target.innerHTML = '';
  const me = playerById(playerId), isCurrent = state.currentPlayerId === playerId;
  const add = (label, action, extra = {}) => { const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', () => send(action, extra)); target.appendChild(button); };
  if (state.phase === 'TURN' && isCurrent && !state.paused) {
    if (state.myHand.length === 2 && !state.unoDeclaredForTurn) add('Gọi UNO', 'declare_uno');
    if (!state.drawnCardId) add('Rút 1 lá', 'draw'); else add('Không đánh lá vừa rút', 'pass');
  } else if (state.phase === 'UNO_WINDOW') {
    const targetPlayer = playerById(state.pendingUno?.targetId); if (state.pendingUno?.targetId !== playerId) add(`Bắt lỗi UNO (${targetPlayer?.name || ''})`, 'catch_uno'); else target.textContent = 'Bạn đã quên gọi UNO — chờ người khác bắt lỗi.';
  } else if (state.phase === 'WDF_CHALLENGE' && state.pendingWdf?.targetId === playerId) { add('Chấp nhận +4', 'accept_wdf'); add('Phản đối +4', 'challenge_wdf'); }
  else if (state.phase === 'DRAW_PENALTY' && state.pendingDraw?.targetId === playerId) add(`Rút ${state.pendingDraw.count} lá`, 'draw_penalty');
  if (!target.childNodes.length && !target.textContent) target.textContent = me?.id === state.currentPlayerId ? 'Chọn một lá hoặc xử lý hành động bắt buộc.' : 'Đang chờ lượt của bạn.';
}
let lastUnoMatchId = null;
function renderHand() {
  const target = $('hand'); target.innerHTML = ''; $('hand-count').textContent = `(${state.myHand.length} lá)`;
  const mayPlay = state.phase === 'TURN' && state.currentPlayerId === playerId && !state.paused;
  const isNewDeal = state.matchId && state.matchId !== lastUnoMatchId && state.phase !== 'WAITING' && state.phase !== 'RESULT';
  if (isNewDeal) lastUnoMatchId = state.matchId;
  state.myHand.forEach((card, index) => {
    const button = document.createElement('button'); button.className = `uno-card ${card.color || 'wild'}`; button.textContent = cardText(card);
    button.disabled = !mayPlay || (state.drawnCardId && state.drawnCardId !== card.id);
    button.title = card.color ? `${colorNames[card.color]} ${cardText(card)}` : `${cardText(card)} — chọn màu ở trên`;
    button.addEventListener('click', () => send('play', { cardId: card.id, ...(card.color ? {} : { color: selectedColor }) })); target.appendChild(button);
    if (isNewDeal) {
      button.animate([
        { opacity: 0, transform: 'translateY(-26px) scale(0.9)' },
        { opacity: 1, transform: 'none' }
      ], { duration: 240, delay: Math.min(index * 25, 260), easing: 'cubic-bezier(0.2, 0.85, 0.3, 1.1)' });
    }
  });
}
function renderResult() {
  const target = $('result'); if (!state.result) { target.hidden = true; return; }
  target.hidden = false; const me = playerById(playerId); target.innerHTML = `<h2>${state.result.winnerId === playerId ? 'Bạn thắng!' : `${escapeHtml(state.result.winnerName)} đã thắng`}</h2><p>Ván kết thúc khi người thắng đánh hết bài. Chưa có chip hay điểm tích lũy trong UNO.</p>`;
  if (me?.isHost) { const button = document.createElement('button'); button.className = 'primary'; button.textContent = 'Chơi lại cùng phòng'; button.addEventListener('click', () => send('play_again')); target.appendChild(button); }
}
function render() {
  if (!state) return;
  if (state.phase === 'WAITING') renderRoom(); else renderGame();
  const active = ['TURN', 'UNO_WINDOW', 'WDF_CHALLENGE', 'DRAW_PENALTY'].includes(state.phase);
  const queued = playerById(playerId)?.leaveAfterHand;
  $('game-leave-after-hand').hidden = !active || !!queued;
  $('game-leave-after-hand').textContent = queued ? 'Rời sau ván đã xếp lịch' : 'Rời sau ván';
  $('game-leave').textContent = state.phase === 'RESULT' ? 'Rời phòng' : 'Hủy ván & rời';
}

function requestRoom(event) {
  const name = $('name').value.trim(); if (!name) return notice('Hãy nhập tên trước.');
  const data = { playerName: name, avatar: $('avatar').value, ...(event === 'create_room' ? { gameId: 'uno' } : { roomCode: $('room-code').value.trim().toUpperCase() }) };
  if (event === 'join_room' && data.roomCode.length !== 4) return notice('Mã phòng cần 4 ký tự.'); socket.emit(event, data);
}
$('create').addEventListener('click', () => requestRoom('create_room')); $('join').addEventListener('click', () => requestRoom('join_room'));
$('room-code').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase(); }); $('room-code').addEventListener('keydown', event => { if (event.key === 'Enter') requestRoom('join_room'); });
$('ready').addEventListener('click', () => { const me = playerById(playerId); socket.emit('set_ready', { roomCode, ready: !me?.ready }); }); $('start').addEventListener('click', () => socket.emit('start_game', { roomCode }));
async function copyCode() { try { await navigator.clipboard.writeText(roomCode); notice('Đã sao chép mã phòng.'); } catch { notice(`Mã phòng: ${roomCode}`); } }
$('copy-code').addEventListener('click', copyCode); $('leave').addEventListener('click', () => socket.emit('leave_room', { roomCode })); $('game-leave').addEventListener('click', () => socket.emit('leave_room', { roomCode })); $('game-leave').title = 'Hủy ván hiện tại và rời phòng ngay.'; $('game-leave-after-hand').addEventListener('click', () => send('leave_after_hand')); $('draw-pile').addEventListener('click', () => { if (state?.phase === 'TURN' && state.currentPlayerId === playerId && !state.drawnCardId) send('draw'); });

function storeCredentials(payload) { roomCode = payload.roomCode; playerId = payload.playerId; rememberProfile(payload); localStorage.setItem(credentialsKey(roomCode), JSON.stringify(payload)); }
socket.on('room_created', payload => { storeCredentials(payload); notice('Đã tạo phòng UNO.'); }); socket.on('room_joined', payload => { storeCredentials(payload); notice('Đã vào phòng UNO.'); }); socket.on('room_resumed', payload => { storeCredentials(payload); notice('Đã khôi phục ghế UNO.'); });
socket.on('game_state', next => { if (next.gameId !== 'uno') return; state = next; roomCode = next.roomCode; playerId = next.myId; window.TablePreferences?.updateTablePreferences('#game-view', state, { before: '#players' }); render(); }); socket.on('game_error', payload => notice(payload.message)); socket.on('join_error', payload => notice(payload.message)); socket.on('resume_error', payload => { notice(payload.message); show('home-view'); }); socket.on('room_left', () => { state = null; roomCode = ''; playerId = ''; lastUnoMatchId = null; show('home-view'); });
socket.on('profile_state', rememberProfile);
socket.on('connect', () => { socket.emit('profile_status', {}); const code = new URLSearchParams(location.search).get('room')?.trim().toUpperCase(); if (!code || code.length !== 4) return; const saved = localStorage.getItem(credentialsKey(code)); if (saved) { try { const credentials = JSON.parse(saved); socket.emit('resume_room', credentials); return; } catch {} } $('room-code').value = code; notice('Nhập tên để vào phòng UNO từ lời mời.'); });
setInterval(() => { if (state?.reactionDeadlineAt) render(); }, 1000);
