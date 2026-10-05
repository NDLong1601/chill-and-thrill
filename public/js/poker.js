'use strict';

const PROFILE_TOKEN_KEY = 'chill-thrill:profile-token';
const PROFILE_RECOVERY_KEY = 'chill-thrill:profile-recovery';
const socket = io({ auth: localStorage.getItem(PROFILE_TOKEN_KEY) ? { profileToken: localStorage.getItem(PROFILE_TOKEN_KEY) } : {} });
const $ = id => document.getElementById(id);
const SUITS = { S: '♠', C: '♣', D: '♦', H: '♥' };
let state = null, roomCode = '', playerId = '';

function rememberProfile(payload) { if (!payload?.profile) return; if (payload.profileToken) localStorage.setItem(PROFILE_TOKEN_KEY, payload.profileToken); if (payload.recoveryCode) localStorage.setItem(PROFILE_RECOVERY_KEY, payload.recoveryCode); if (!$('name').value.trim()) $('name').value = payload.profile.displayName || ''; if (payload.profile.avatar) $('avatar').value = payload.profile.avatar; }
function escapeHtml(value) { const node = document.createElement('div'); node.textContent = value || ''; return node.innerHTML; }
function notice(message) { $('notice').textContent = message || ''; }
function show(id) { ['home-view', 'room-view', 'game-view'].forEach(view => { $(view).hidden = view !== id; }); }
function actionId() { return globalThis.crypto?.randomUUID?.() || `poker-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function credentialsKey(code) { return `chill-thrill:poker:${code}`; }
function me() { return state?.players.find(player => player.id === playerId); }
function player(id) { return state?.players.find(item => item.id === id); }
function cardText(card) { return `${card.rank}${card.suitLabel || SUITS[card.suit] || ''}`; }
function cardMarkup(card) { if (!card) return ''; const red = card.suit === 'H' || card.suit === 'D' ? ' red' : ''; return `<span class="playing-card${red}">${escapeHtml(cardText(card))}</span>`; }
function send(action, extra = {}) { if (!state) return; socket.emit('game_action', { roomCode, action, actionId: actionId(), expectedRevision: state.revision, ...extra }); }
function updateWallet() { $('wallet-available').textContent = state.wallet?.available ?? 0; $('wallet-reserved').textContent = state.wallet?.reserved ?? 0; $('room-stack').textContent = state.myStack ?? 0; }

function renderPlayers(target, game = false) {
  target.innerHTML = '';
  state.players.forEach(item => {
    const el = document.createElement('article'); const tags = [];
    if (item.id === state.buttonPlayerId) tags.push('D'); if (item.id === state.smallBlindPlayerId) tags.push('SB'); if (item.id === state.bigBlindPlayerId) tags.push('BB');
    if (game && item.id === state.currentPlayerId) tags.push('đang lượt'); if (item.allIn) tags.push('all-in'); if (item.folded) tags.push('fold'); if (!item.inHand && state.phase === 'HAND') tags.push('ngồi ngoài'); if (item.leaveAfterHand) tags.push('rời sau hand');
    el.className = `player${item.id === state.currentPlayerId ? ' current' : ''}${item.id === playerId ? ' me' : ''}${item.folded ? ' folded' : ''}`;
    const detail = game ? `stack ${item.stack} · cược vòng ${item.roundBet}${tags.length ? ` · ${tags.join(' · ')}` : ''}` : `${item.isHost ? 'chủ bàn · ' : ''}${item.ready ? 'sẵn sàng' : 'chưa sẵn sàng'} · stack ${item.stack}`;
    el.innerHTML = `<span class="player-name">${escapeHtml(item.avatar)} ${escapeHtml(item.name)}</span><span class="player-meta">${item.connected ? '● online' : '○ mất kết nối'} · ${escapeHtml(detail)}</span>`; target.appendChild(el);
  });
}

function renderRoom() {
  show('room-view'); $('room-title').textContent = state.roomCode; $('qr').src = `/api/rooms/${encodeURIComponent(state.roomCode)}/qr`; updateWallet(); renderPlayers($('room-players'));
  const self = me(), canStart = state.players.filter(item => item.ready && item.connected && item.stack >= state.buyIn.minToStart).length >= 2;
  $('ready').textContent = self?.ready ? 'Bỏ sẵn sàng' : `Sẵn sàng (cần ≥${state.buyIn.minToStart} stack)`; $('ready').disabled = state.myStack < state.buyIn.minToStart; $('start').hidden = !self?.isHost; $('start').disabled = !canStart;
  $('sit-out').disabled = !self?.ready; $('room-status').textContent = canStart ? 'Có thể bắt đầu: chỉ người sẵn sàng với đủ stack sẽ nhận hand.' : `Buy-in tối thiểu ${state.buyIn.min}; cần tối thiểu 2 người sẵn sàng và stack từ ${state.buyIn.minToStart}.`;
  const isFirstBuyIn = state.myStack === 0; $('buyin-amount').min = isFirstBuyIn ? state.buyIn.min : 10; $('buyin-amount').max = Math.max(10, state.buyIn.max - state.myStack); $('buyin').disabled = state.myStack >= state.buyIn.max;
}

function renderTable() { $('community').innerHTML = state.community.length ? state.community.map(cardMarkup).join('') : '<span class="empty-cards">Chờ action preflop.</span>'; const side = state.sidePots || []; $('side-pots').textContent = side.length > 1 ? `Side pot: ${side.slice(1).map((pot, index) => `#${index + 1} ${pot.amount} (${pot.eligiblePlayerIds.length} người đủ quyền)`).join(' · ')}` : 'Chưa có side pot.'; }
function addButton(target, label, callback, primary = false) { const button = document.createElement('button'); button.textContent = label; if (primary) button.className = 'primary'; button.addEventListener('click', callback); target.appendChild(button); }
function renderActions() {
  const target = $('actions'); target.innerHTML = ''; const legal = state.legalActions;
  if (!legal) { target.textContent = state.paused ? 'Hand đang tạm dừng để bảo vệ bài và stack.' : state.phase === 'RESULT' ? 'Hand đã chốt trên stack; bạn có thể top-up, chơi tiếp hoặc cash-out.' : `Đang chờ ${player(state.currentPlayerId)?.name || 'người chơi'} hành động.`; return; }
  if (legal.canFold) addButton(target, 'Fold', () => send('fold'));
  if (legal.canCheck) addButton(target, 'Check', () => send('check'), true);
  if (legal.canCall) addButton(target, legal.callAmount < legal.toCall ? `All-in ${legal.callAmount} (thiếu call ${legal.toCall})` : `Call ${legal.callAmount}`, () => send('call'), true);
  if (legal.canBet || legal.canRaise) {
    const minimum = legal.canBet ? legal.minBetTotal : legal.minRaiseTotal; const wrap = document.createElement('label'); wrap.className = 'raise-control'; wrap.textContent = legal.canBet ? 'Cược đến tổng' : 'Tố đến tổng';
    const input = document.createElement('input'); input.type = 'number'; input.inputMode = 'numeric'; input.min = minimum; input.max = legal.maxTotal; input.step = '1'; input.value = Math.min(minimum, legal.maxTotal); wrap.appendChild(input); const hint = document.createElement('span'); hint.className = 'small';
    const explain = () => { const total = Number(input.value) || 0; hint.textContent = `Thêm ${Math.max(0, total - (me()?.roundBet || 0))} chip · tối thiểu ${minimum}, tối đa ${legal.maxTotal}.`; }; input.addEventListener('input', explain); explain(); target.append(wrap, hint);
    addButton(target, legal.canBet ? 'Bet' : 'Raise', () => send(legal.canBet ? 'bet' : 'raise', { total: Number(input.value) }));
  }
  if (legal.canAllIn) addButton(target, `All-in đến ${legal.maxTotal}`, () => send('all_in'));
  if (!legal.raiseReopened && legal.toCall) { const hint = document.createElement('p'); hint.className = 'small full-row'; hint.textContent = 'All-in ngắn chưa mở lại quyền tố: chỉ call hoặc fold.'; target.appendChild(hint); }
}
function renderResult() {
  const target = $('result'), result = state.result; if (!result) { target.hidden = true; return; } target.hidden = false;
  const mine = result.outcomes.find(item => item.playerId === playerId), refunds = result.refunds?.filter(item => item.playerId === playerId).reduce((sum, item) => sum + item.amount, 0) || 0;
  target.innerHTML = `<h2>${escapeHtml(result.reason)}</h2><p>Pot đã chia: ${result.pot} chip.${mine ? ` Stack của bạn: ${mine.stackBefore} → ${mine.stackAfter} (${mine.delta >= 0 ? '+' : ''}${mine.delta}).` : ''}${refunds ? ` Hoàn cược không ai theo: ${refunds}.` : ''}</p><ul>${result.pots.map((pot, index) => `<li>${index ? 'Side pot' : 'Main pot'} ${pot.amount}: ${pot.winnerNames.map(escapeHtml).join(', ')} · ${escapeHtml(pot.hand)}</li>`).join('')}</ul>${result.showdown?.length ? `<p class="showdown">${result.showdown.map(item => `${escapeHtml(player(item.playerId)?.name || '')}: ${item.cards.map(cardText).join(' ')} · ${escapeHtml(item.hand)}`).join('<br>')}</p>` : ''}`;
  const self = me(); const buyIn = document.createElement('div'); buyIn.className = 'result-buyin'; const input = document.createElement('input'); input.type = 'number'; input.inputMode = 'numeric'; input.min = state.myStack ? 10 : state.buyIn.min; input.max = Math.max(10, state.buyIn.max - state.myStack); input.step = '10'; input.value = input.min; const topUp = document.createElement('button'); topUp.textContent = state.myStack ? 'Top-up trước hand' : 'Buy-in để chơi tiếp'; topUp.disabled = state.myStack >= state.buyIn.max; topUp.addEventListener('click', () => send('buy_in', { amount: Number(input.value) })); buyIn.append(input, topUp); target.appendChild(buyIn);
  addButton(target, self?.ready ? 'Ngồi ngoài hand sau' : 'Sẵn sàng hand sau', () => self?.ready ? send('sit_out') : socket.emit('set_ready', { roomCode, ready: true })); if (self?.isHost) addButton(target, 'Mở hand tiếp theo', () => send('start_next_hand'), true);
}
function renderGame() {
  show('game-view'); $('game-room').textContent = state.roomCode; $('street').textContent = state.phase === 'RESULT' ? 'KẾT QUẢ' : state.street || 'CHỜ'; $('pot').textContent = state.phase === 'RESULT' ? state.result?.pot || 0 : state.pot;
  $('game-stack').textContent = state.myStack; $('my-round').textContent = `Đã vào vòng: ${me()?.roundBet || 0} · Ví: ${state.wallet?.available ?? 0} dùng được / ${state.wallet?.reserved ?? 0} đang giữ`;
  $('phase-banner').textContent = state.paused ? 'Hand tạm dừng: chờ người trong hand kết nối lại.' : state.phase === 'RESULT' ? 'Đã settlement một lần vào stack; cash-out là bước riêng.' : state.currentPlayerId === playerId ? 'Đến lượt bạn — chỉ các nút hợp lệ từ server được mở.' : `Đang chờ ${player(state.currentPlayerId)?.name || 'hệ thống'} hành động.`;
  renderPlayers($('players'), true); renderTable(); $('hole-cards').innerHTML = (state.myHoleCards || []).map(cardMarkup).join('') || '<span class="empty-cards">Bạn ngồi ngoài hand này.</span>'; renderActions(); renderResult();
  $('log').innerHTML = ''; state.log.slice(0, 12).forEach(entry => { const li = document.createElement('li'); li.textContent = entry.message; $('log').appendChild(li); });
}
function render() { if (!state) return; state.phase === 'WAITING' ? renderRoom() : renderGame(); }
function requestRoom(event) { const name = $('name').value.trim(); if (!name) return notice('Hãy nhập tên trước.'); const data = { playerName: name, avatar: $('avatar').value, ...(event === 'create_room' ? { gameId: 'poker' } : { roomCode: $('room-code').value.trim().toUpperCase() }) }; if (event === 'join_room' && data.roomCode.length !== 4) return notice('Mã bàn cần 4 ký tự.'); socket.emit(event, data); }
function storeCredentials(payload) { roomCode = payload.roomCode; playerId = payload.playerId; rememberProfile(payload); localStorage.setItem(credentialsKey(roomCode), JSON.stringify(payload)); }

$('create').addEventListener('click', () => requestRoom('create_room')); $('join').addEventListener('click', () => requestRoom('join_room')); $('room-code').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase(); }); $('room-code').addEventListener('keydown', event => { if (event.key === 'Enter') requestRoom('join_room'); });
$('buyin').addEventListener('click', () => send('buy_in', { amount: Number($('buyin-amount').value) })); $('ready').addEventListener('click', () => socket.emit('set_ready', { roomCode, ready: !me()?.ready })); $('sit-out').addEventListener('click', () => send('sit_out')); $('start').addEventListener('click', () => socket.emit('start_game', { roomCode })); $('leave').addEventListener('click', () => socket.emit('leave_room', { roomCode })); $('game-leave').addEventListener('click', () => socket.emit('leave_room', { roomCode }));
$('copy-code').addEventListener('click', async () => { try { await navigator.clipboard.writeText(roomCode); notice('Đã sao chép mã bàn.'); } catch { notice(`Mã bàn: ${roomCode}`); } });
socket.on('room_created', payload => { storeCredentials(payload); notice('Đã tạo bàn Poker. Buy-in trước khi sẵn sàng.'); }); socket.on('room_joined', payload => { storeCredentials(payload); notice('Đã vào bàn Poker.'); }); socket.on('room_resumed', payload => { storeCredentials(payload); notice('Đã khôi phục ghế Poker.'); });
socket.on('game_state', next => { if (next.gameId !== 'poker') return; state = next; roomCode = next.roomCode; playerId = next.myId; render(); }); socket.on('game_error', payload => notice(payload.message)); socket.on('join_error', payload => notice(payload.message)); socket.on('resume_error', payload => { notice(payload.message); show('home-view'); }); socket.on('room_left', () => { state = null; roomCode = ''; playerId = ''; show('home-view'); }); socket.on('profile_state', rememberProfile);
socket.on('connect', () => { socket.emit('profile_status', {}); const code = new URLSearchParams(location.search).get('room')?.trim().toUpperCase(); if (!code || code.length !== 4) return; const saved = localStorage.getItem(credentialsKey(code)); if (saved) { try { socket.emit('resume_room', JSON.parse(saved)); return; } catch {} } $('room-code').value = code; notice('Nhập tên để vào bàn từ lời mời.'); });
