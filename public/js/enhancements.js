'use strict';

// Keep the existing casino table and extend its rendering with server-owned state.
const prefs = {
  read(key, fallback, session = false) { try { return JSON.parse((session ? sessionStorage : localStorage).getItem(key)) ?? fallback; } catch { return fallback; } },
  write(key, value, session = false) { try { (session ? sessionStorage : localStorage).setItem(key, JSON.stringify(value)); } catch {} },
  remove(key, session = false) { try { (session ? sessionStorage : localStorage).removeItem(key); } catch {} }
};
let cardsHidden = prefs.read('gang.hiddenCards', false);
let shareAddresses = [];
let shareRoomCode = '';
let toastTimer;
let tutorialStep = 0;
let tutorialAnswered = false;
let activeCardsIndex = 0;
const modeLabels = { BASIC: 'Cơ bản', ADVANCED: 'Nâng cao', EXPERT: 'Chuyên nghiệp', MASTER_THIEF: 'Siêu trộm' };
soundEnabled = prefs.read('gang.sound', true);
$('btn-sound-toggle').textContent = soundEnabled ? '🔊' : '🔇';
$('btn-sound-toggle').addEventListener('click', () => prefs.write('gang.sound', soundEnabled));
$('inp-name').value = prefs.read('gang.playerName', '');
const invitation = new URLSearchParams(location.search).get('room');
if (/^[A-Z2-9]{4}$/i.test(invitation || '')) $('inp-code').value = invitation.toUpperCase();

const touchDevice = navigator.maxTouchPoints > 0 || window.matchMedia('(any-pointer: coarse)').matches;
document.body.classList.toggle('touch-device', touchDevice);
const phonePortrait = window.matchMedia('(max-width: 600px) and (orientation: portrait)');
let focusBeforeRotation = null;
function updateRotationRequirement() {
  const overlay = $('rotate-device-overlay');
  const required = touchDevice && phonePortrait.matches && $('screen-game').classList.contains('active');
  const wasRequired = !overlay.hidden;
  overlay.hidden = !required;
  document.body.classList.toggle('needs-landscape', required);
  document.querySelectorAll('.screen, .modal-backdrop').forEach(element => { element.inert = required; });
  if (required && !wasRequired) {
    focusBeforeRotation = document.activeElement;
    focusBeforeRotation?.blur();
    overlay.focus({ preventScroll: true });
  } else if (!required && wasRequired) {
    if (focusBeforeRotation?.isConnected && focusBeforeRotation.getClientRects().length) focusBeforeRotation.focus({ preventScroll: true });
    focusBeforeRotation = null;
  }
}
const baseShowScreen = showScreen;
showScreen = function(screenId) { baseShowScreen(screenId); updateRotationRequirement(); };
phonePortrait.addEventListener('change', updateRotationRequirement);
window.addEventListener('resize', updateRotationRequirement);
window.addEventListener('orientationchange', updateRotationRequirement);
updateRotationRequirement();

function toast(message) {
  clearTimeout(toastTimer); $('app-toast').textContent = message; $('app-toast').classList.remove('hidden');
  toastTimer = setTimeout(() => $('app-toast').classList.add('hidden'), 5000);
}
async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const input = document.createElement('textarea'); input.value = value; input.style.position = 'fixed'; input.style.opacity = '0';
      document.body.append(input); input.select(); const copied = document.execCommand('copy'); input.remove();
      if (!copied) throw new Error('Không sao chép được');
    }
    toast('Đã sao chép.');
  } catch { toast('Không sao chép tự động được. Bạn có thể chọn và sao chép địa chỉ hiển thị trong phòng.'); }
}
function getShareLink() { return `${$('share-address').value || location.origin}/?room=${roomCode}`; }

const emitOriginal = socket.emit.bind(socket);
socket.emit = function(event, data = {}, ...rest) {
  if (!socket.connected) { toast('Đang mất kết nối. Chờ nối lại trước khi thao tác.'); return socket; }
  return emitOriginal(event, { ...data, phaseKey: data.phaseKey || lastState?.phaseKey }, ...rest);
};
function send(event, data = {}) { socket.emit(event, { roomCode, ...data }); }

function connectionStatus(message) {
  $('connection-banner').textContent = message; $('connection-banner').classList.toggle('hidden', !message);
  document.body.classList.toggle('is-offline', !socket.connected);
}
for (const event of ['room_created', 'room_joined', 'room_resumed']) socket.on(event, data => {
  prefs.write('gang.session', data, true); prefs.write('gang.playerName', $('inp-name').value.trim());
  roomCode = data.roomCode; myId = data.playerId; connectionStatus('');
});
socket.on('connect', () => {
  const session = prefs.read('gang.session', null, true);
  if (session) { connectionStatus('Đang khôi phục ghế, bài và chip…'); emitOriginal('resume_room', session); }
  else connectionStatus('');
});
socket.on('disconnect', () => connectionStatus('📶 Mất kết nối — đang tự nối lại. Bài và chip được giữ trên máy chủ.'));
socket.on('connect_error', () => connectionStatus('Không kết nối được máy chủ. Kiểm tra WiFi và máy đang chạy npm start.'));
socket.on('resume_error', ({ message }) => {
  connectionStatus(message);
  if (message.includes('hết hạn')) { prefs.remove('gang.session', true); lastState = null; roomCode = ''; myId = null; showScreen('screen-lobby'); toast(message); connectionStatus(''); }
});
socket.on('room_left', () => {
  prefs.remove('gang.session', true); lastState = null; roomCode = ''; myId = null; isHost = false;
  document.querySelectorAll('.modal-backdrop').forEach(el => el.classList.add('hidden'));
  showScreen('screen-lobby'); shareRoomCode = ''; connectionStatus('');
});
socket.off('game_error'); socket.on('game_error', ({ message }) => toast(message));
window.addEventListener('online', () => socket.connect());
document.addEventListener('visibilitychange', () => { if (!document.hidden && socket.connected && roomCode) send('sync_state'); });

function cardButton(card, index, callback) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'card-choice';
  button.setAttribute('aria-label', `Chọn lá ${index + 1}`);
  button.appendChild(cardsHidden ? createCardBackEl('sm') : createCardEl(card, 'sm'));
  const label = document.createElement('span'); label.textContent = `Lá ${index + 1}`; button.appendChild(label);
  button.onclick = callback; return button;
}
const baseWaiting = renderWaitingRoom;
renderWaitingRoom = function(state) {
  baseWaiting(state);
  const me = state.players.find(p => p.id === myId);
  const ready = state.players.filter(p => p.ready && p.connected).length;
  $('btn-ready').textContent = me.ready ? '↩ HỦY SẴN SÀNG' : '✓ SẴN SÀNG';
  $('btn-ready').classList.toggle('is-ready', me.ready);
  $('btn-start-game').disabled = ready !== state.players.length || ready < 2 || state.paused;
  $('btn-start-game').textContent = `▶ BẮT ĐẦU (${ready}/${state.players.length} SẴN SÀNG)`;
  $('wait-client-hint').textContent = `${ready}/${state.players.length} đã sẵn sàng. Chủ phòng sẽ bắt đầu khi cả đội chuẩn bị xong.`;
  $('strict-chat').checked = state.strictChat; $('strict-chat').disabled = !isHost;
  [...$('wait-player-grid').children].forEach((element, index) => {
    const status = document.createElement('span'), p = state.players[index];
    status.className = 'ready-status'; status.textContent = !p.connected ? '📶 Đang nối lại' : p.ready ? '✓ Sẵn sàng' : 'Chưa sẵn sàng'; element.append(status);
  });
  if (shareRoomCode !== state.roomCode) { shareRoomCode = state.roomCode; loadShareAddresses(); }
  if (!$('modal-management').classList.contains('hidden')) renderManagement();
};
async function loadShareAddresses() {
  try {
    const response = await fetch('/api/network'); if (!response.ok) throw new Error();
    shareAddresses = (await response.json()).addresses;
    if (!shareAddresses.some(a => a.url === location.origin)) shareAddresses.push({ name: 'Địa chỉ đang mở', url: location.origin, local: /localhost|127\.0\.0\.1/.test(location.hostname) });
    const recommended = /localhost|127\.0\.0\.1/.test(location.hostname) ? shareAddresses.find(a => !a.local)?.url : location.origin;
    $('share-address').replaceChildren(...shareAddresses.map(a => { const option = document.createElement('option'); option.value = a.url; option.textContent = `${a.name}: ${a.url}`; return option; }));
    $('share-address').value = recommended || location.origin; renderShare();
  } catch { toast('Không đọc được địa chỉ mạng. Thử lại khi máy chủ kết nối.'); shareRoomCode = ''; }
}
function renderShare() {
  $('share-link').textContent = getShareLink(); $('share-link').href = getShareLink();
  $('room-qr').src = `/api/rooms/${roomCode}/qr?origin=${encodeURIComponent($('share-address').value)}`;
}
$('share-address').onchange = renderShare;
$('room-qr').onerror = () => toast('Không tải được QR. Bạn vẫn có thể dùng đường dẫn vào phòng.');
$('btn-ready').onclick = () => send('set_ready', { ready: !lastState.players.find(p => p.id === myId).ready });
$('strict-chat').onchange = () => send('set_chat_mode', { strict: $('strict-chat').checked });
$('btn-leave-waiting').onclick = () => send('leave_room');

const baseArena = renderGameArena;
renderGameArena = function(state) {
  baseArena(state);
  const stopped = state.paused || state.disconnected.length > 0;
  $('game-status-banner').classList.toggle('hidden', !stopped);
  $('game-status-banner').textContent = state.disconnected.length ? `📶 Chờ ${state.disconnected.join(', ')} nối lại. Chủ phòng có thể đưa cả đội về phòng chờ để đổi người.` : '⏸ Chủ phòng đã tạm dừng ván.';
  renderSpecialist(state); renderShowdown(state); renderChatPolicy(state);
  if (!$('modal-management').classList.contains('hidden')) renderManagement();
};

const baseStation = renderMyStation;
renderMyStation = function(state) {
  baseStation(state);
  const me = state.players.find(p => p.id === myId), active = ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'].includes(state.phase);
  const blocked = state.paused || state.disconnected.length > 0 || ['PASS', 'VIEW', 'SELECT_CARD', 'DISCARD'].includes(state.specialistState?.stage) || !!state.specialistState?.proposal;
  const confirmed = state.players.filter(p => p.roundConfirmed).length;
  $('round-chip-status').textContent = `${confirmed}/${state.players.length} chốt chip · thay đổi chip sẽ hủy xác nhận cả đội`;
  $('btn-confirm-round').classList.toggle('hidden', !active);
  $('btn-confirm-round').textContent = me.roundConfirmed ? '↩ HỦY CHỐT CHIP' : '✓ CHỐT CHIP';
  $('btn-confirm-round').disabled = blocked || me.chips[state.currentRoundChipColor] === null;
  $('btn-advance-phase').disabled = blocked || confirmed !== state.players.length;
  if (state.phase === 'FLOP' && [...state.activeChallenges, state.permanentChallenge].some(c => c?.id === 5)) $('btn-advance-phase').textContent = 'BỎ CHIP CAM → MỞ RIVER';
  $('btn-return-my-chip').disabled = blocked || me.lockedChip;
  $('btn-return-my-chip').textContent = me.lockedChip ? '🔒 Chip đã khóa' : '↩ Trả chip vòng này';
  if (cardsHidden) $('my-cards-row').replaceChildren(...me.privateCards.map(() => createCardBackEl('lg')));
  $('btn-hide-cards').textContent = cardsHidden ? '👁 Hiện bài' : '🙈 Che bài';
  $('btn-hide-cards').setAttribute('aria-pressed', String(cardsHidden));
  $('my-hand-hint-txt').textContent = cardsHidden ? 'Bài đang được che' : `${state.myHand?.nameVi || 'Đang chờ bài'}${me.extraNote ? ` · ${me.extraNote}` : ''}`;
};
$('btn-hide-cards').onclick = () => {
  cardsHidden = !cardsHidden; prefs.write('gang.hiddenCards', cardsHidden);
  if (lastState) { renderMyStation(lastState); $('specialist-panel').dataset.key = ''; renderSpecialist(lastState); }
};
$('btn-confirm-round').onclick = () => send('confirm_round', { confirmed: !lastState.players.find(p => p.id === myId).roundConfirmed });

const basePool = renderCenterChipPool;
renderCenterChipPool = function(state) {
  basePool(state);
  const me = state.players.find(p => p.id === myId);
  const blocked = !socket.connected || state.paused || state.disconnected.length || me.lockedChip || ['PASS', 'VIEW', 'SELECT_CARD', 'DISCARD'].includes(state.specialistState?.stage) || !!state.specialistState?.proposal;
  $('center-chip-rack').classList.toggle('blocked-controls', !!blocked);
  $('center-chip-rack').querySelectorAll('.poker-chip').forEach(chip => { chip.setAttribute('role', 'button'); chip.tabIndex = blocked ? -1 : 0; chip.setAttribute('aria-disabled', String(!!blocked)); chip.onkeydown = event => { if (!blocked && ['Enter', ' '].includes(event.key)) { event.preventDefault(); chip.click(); } }; });
};
const baseAction = openPlayerActionPopover;
openPlayerActionPopover = function(target, state) {
  baseAction(target, state);
  const me = state.players.find(p => p.id === myId);
  $('btn-snatch-chip-action').disabled ||= !target.connected || target.lockedChip || me.lockedChip || state.paused || !!state.disconnected.length || ['PASS', 'VIEW', 'SELECT_CARD', 'DISCARD'].includes(state.specialistState?.stage) || !!state.specialistState?.proposal;
  document.querySelectorAll('.btn-emote').forEach(button => { button.disabled = state.strictChat && !['WAITING', 'RESULT', 'GAME_OVER'].includes(state.phase); });
};
renderPinnedChallenge = function(state) {
  const cards = [...state.activeChallenges, state.permanentChallenge, state.activeSpecialist].filter(Boolean);
  $('pinned-challenge-btn').classList.toggle('hidden', !cards.length);
  if (cards.length) {
    $('pinned-challenge-title').textContent = cards.map(c => `${c.icon} #${c.id} ${c.title}`).join(' · ');
    $('pinned-challenge-btn').onclick = () => { showCardSpotlight(cards[activeCardsIndex++ % cards.length]); };
  }
};
socket.off('spotlight_cards');
socket.on('spotlight_cards', ({ cards }) => { if (cards?.length) { activeCardsIndex = 0; showCardSpotlight(cards[0]); if (cards.length > 1) toast(`${cards.length} thẻ đang hoạt động. Nhấn thẻ ghim để lần lượt xem từng thẻ.`); } });

function renderChatPolicy(state) {
  const strict = state.strictChat && !['WAITING', 'RESULT', 'GAME_OVER'].includes(state.phase);
  $('inp-chat-msg').disabled = strict; $('chat-form').querySelector('button').disabled = strict;
  $('inp-chat-msg').placeholder = strict ? 'Chỉ dùng câu nhanh theo luật' : 'Tin nhắn cho cả đội…';
  const box = document.querySelector('.quick-chips-scroll');
  if (box && box.dataset.policy !== String(state.strictChat)) {
    box.dataset.policy = String(state.strictChat); box.replaceChildren(...state.quickChat.map(text => {
      const button = document.createElement('button'); button.className = 'qc-btn'; button.textContent = text; button.onclick = () => send('send_chat', { text }); return button;
    }));
  }
}
const baseAppendChat = appendChatMessage;
appendChatMessage = function(message) {
  const container = $('chat-messages-container');
  if (message.messageId && [...container.children].some(el => el.dataset.messageId === message.messageId)) return;
  baseAppendChat(message); container.lastElementChild.dataset.messageId = message.messageId || '';
  while (container.children.length > 50) container.firstElementChild.remove();
};
socket.on('game_state', state => {
  connectionStatus('');
  (state.chatLog || []).forEach(appendChatMessage);
  const cached = prefs.read('gang.history', { heists: [], matches: [] });
  for (const h of state.history) if (!cached.heists.some(x => x.matchId === h.matchId && x.heistNumber === h.heistNumber)) cached.heists.unshift({ ...h, roomCode: state.roomCode });
  for (const m of state.matches) if (!cached.matches.some(x => x.matchId === m.matchId)) cached.matches.unshift(m);
  cached.heists = cached.heists.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 100); cached.matches = cached.matches.slice(0, 100);
  prefs.write('gang.history', cached);
});

function renderSpecialist(state) {
  const panel = $('specialist-panel'), expert = state.activeSpecialist, s = state.specialistState;
  const active = ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'].includes(state.phase);
  const insights = state.privateInsights;
  panel.classList.toggle('hidden', !active || (!expert && !insights.length));
  if (!active || (!expert && !insights.length)) return;
  const key = JSON.stringify([s, expert?.id, cardsHidden, insights, state.players.map(p => [p.id, p.connected]), state.paused]);
  if (panel.dataset.key === key) return;
  panel.dataset.key = key; panel.replaceChildren();
  if (expert) {
    const title = document.createElement('strong'); title.textContent = `${expert.icon} ${expert.title}`; panel.append(title);
    const note = document.createElement('p'); note.textContent = expert.summary; panel.append(note);
  }
  const name = id => state.players.find(p => p.id === id)?.name || 'Đồng đội';
  const me = state.players.find(p => p.id === myId);
  const button = (label, data) => { const b = document.createElement('button'); b.className = 'btn btn-primary btn-sm'; b.textContent = label; b.disabled = state.paused || !!state.disconnected.length; b.onclick = () => send('specialist_action', data); panel.append(b); };
  if (s?.stage === 'PASS') {
    const next = state.players[(state.players.findIndex(p => p.id === myId) + 1) % state.players.length];
    const text = document.createElement('p'); text.textContent = `Chọn 1 lá để chuyển cho ${next.name}. ${s.selectedIds.length}/${state.players.length} đã chọn; chuyển đồng thời khi đủ người.`; panel.append(text);
    me.privateCards.forEach((card, i) => panel.append(cardButton(card, i, () => send('specialist_action', { action: 'select', cardIndex: i }))));
  } else if (s?.stage === 'VIEW') {
    const text = document.createElement('p'); text.textContent = `Ghi nhớ bài trước khi chia lại. ${s.seenIds.length}/${state.players.length} đã xem.`; panel.append(text);
    button(s.seenIds.includes(myId) ? '✓ Đã xem — đang chờ cả đội' : 'Tôi đã xem và nhớ bài', { action: 'seen' });
  } else if (s?.proposal) {
    const proposal = s.proposal, text = document.createElement('p');
    text.textContent = `Đề xuất: ${name(proposal.actorId)} sử dụng thẻ${proposal.recipientId ? ` cho ${name(proposal.recipientId)} xem một lá` : ''}${proposal.value ? `, công bố số lá ${valName(proposal.value)}` : ''}. ${proposal.approvals.length}/${state.players.length} đồng ý.`; panel.append(text);
    button(proposal.approvals.includes(myId) ? '✓ Bạn đã đồng ý' : 'Đồng ý', { action: 'approve' }); button('Đề nghị chọn lại', { action: 'reject' });
  } else if (s?.stage === 'AVAILABLE') {
    const actor = document.createElement('select'); actor.className = 'form-select'; actor.id = 'expert-actor'; actor.setAttribute('aria-label', 'Người sử dụng chuyên gia');
    for (const p of state.players) { const option = document.createElement('option'); option.value = p.id; option.textContent = p.name; actor.append(option); } actor.value = myId; panel.append(actor);
    let recipient, value;
    if (expert.id === 1) { recipient = actor.cloneNode(true); recipient.id = 'expert-recipient'; recipient.setAttribute('aria-label', 'Người xem bài'); recipient.value = state.players.find(p => p.id !== myId).id; panel.append(recipient); }
    if (expert.id === 4) { value = makeValueSelect('expert-value'); panel.append(value); }
    const propose = document.createElement('button'); propose.className = 'btn btn-gold btn-sm'; propose.textContent = 'Đề xuất cho cả đội'; propose.disabled = state.paused || !!state.disconnected.length;
    propose.onclick = () => send('specialist_action', { action: 'propose', actorId: actor.value, recipientId: recipient?.value, value: value ? Number(value.value) : undefined }); panel.append(propose);
  } else if (['SELECT_CARD', 'DISCARD'].includes(s?.stage)) {
    const text = document.createElement('p'); text.textContent = s.usedBy === myId ? (s.stage === 'DISCARD' ? 'Chọn 1 lá để bỏ (có thể bỏ lá vừa nhận).' : `Chọn đúng 1 lá cho ${name(s.recipientId)} xem bí mật.`) : `Chờ ${name(s.usedBy)} chọn lá bài.`; panel.append(text);
    if (s.usedBy === myId) me.privateCards.forEach((card, i) => panel.append(cardButton(card, i, () => send('specialist_action', { action: 'select', cardIndex: i }))));
  } else if (expert) { const text = document.createElement('p'); text.textContent = '✓ Hiệu ứng chuyên gia đã được áp dụng.'; panel.append(text); }
  for (const insight of insights) {
    const box = document.createElement('div'); box.className = 'private-insight';
    const label = document.createElement('span'); label.textContent = `${insight.fromName} cho riêng bạn xem:`;
    box.append(label, cardsHidden ? createCardBackEl('sm') : createCardEl(insight.card, 'sm')); panel.append(box);
  }
}
function makeValueSelect(id) {
  const select = document.createElement('select'); select.id = id; select.className = 'form-select'; select.setAttribute('aria-label', 'Giá trị bài');
  for (let n = 2; n <= 14; n++) { const option = document.createElement('option'); option.value = n; option.textContent = valName(n); select.append(option); } return select;
}
function makeRankSelect() {
  const select = document.createElement('select'); select.id = 'guess-rank'; select.className = 'form-select'; select.setAttribute('aria-label', 'Thứ hạng bài');
  const ranks = ['Bài cao', 'Một đôi', 'Hai đôi', 'Bộ ba', 'Sảnh', 'Thùng', 'Cù lũ', 'Tứ quý', 'Thùng phá sảnh', 'Sảnh chúa'];
  ranks.forEach((rank, i) => { const option = document.createElement('option'); option.value = i + 1; option.textContent = rank; select.append(option); }); return select;
}
function renderShowdown(state) {
  const panel = $('showdown-panel'), sd = state.showdown;
  panel.classList.toggle('hidden', state.phase !== 'SHOWDOWN'); if (state.phase !== 'SHOWDOWN') return;
  const priorValue = $('guess-value')?.value, priorRank = $('guess-rank')?.value;
  panel.innerHTML = '<strong>⚖️ So bài — lật từ chip đỏ thấp đến cao</strong>';
  sd.order.forEach((id, index) => {
    const p = state.players.find(p => p.id === id), row = document.createElement('div'); row.className = 'showdown-step';
    const text = document.createElement('span'); text.textContent = `${index + 1}⭐ ${p.name} · ${index < sd.revealedCount ? p.handNameVi : 'Chưa lật'}`; row.append(text);
    if (index < sd.revealedCount) p.best5.forEach(card => row.append(createCardEl(card, 'sm'))); panel.append(row);
  });
  const guessing = sd.revealedCount === sd.order.length - 1 && (sd.needsValue || sd.needsRank);
  if (guessing) {
    const note = document.createElement('p'); note.textContent = 'Cả đội (trừ người giữ chip cao nhất) chọn cùng dự đoán. Người cuối không được gợi ý.'; panel.append(note);
    if (myId !== sd.order.at(-1)) {
      if (sd.needsValue) { const select = makeValueSelect('guess-value'); select.value = priorValue || sd.votes[myId]?.value || '2'; panel.append(select); }
      if (sd.needsRank) { const select = makeRankSelect(); select.value = priorRank || sd.votes[myId]?.rank || '1'; panel.append(select); }
      const button = document.createElement('button'); button.className = 'btn btn-primary btn-sm'; button.textContent = 'Gửi / đổi dự đoán'; button.disabled = state.paused || !!state.disconnected.length;
      button.onclick = () => send('submit_guess', { value: sd.needsValue ? Number($('guess-value').value) : undefined, rank: sd.needsRank ? Number($('guess-rank').value) : undefined }); panel.append(button);
    }
    const voteText = document.createElement('p'); voteText.textContent = `${Object.keys(sd.votes).length}/${state.players.length - 1} đã chọn · ${Object.keys(sd.guesses).length ? 'Đã thống nhất' : 'Chưa thống nhất'}`; panel.append(voteText);
    for (const [id, vote] of Object.entries(sd.votes)) { const line = document.createElement('small'); line.className = 'vote-detail'; line.textContent = `${state.players.find(p => p.id === id)?.name}: ${vote.value ? `giá trị ${valName(vote.value)}` : ''} ${vote.rank ? `hạng ${vote.rank}` : ''}`; panel.append(line); }
  }
  if (isHost) {
    const button = document.createElement('button'); button.id = 'btn-reveal-next'; button.className = 'btn btn-gold'; button.textContent = `Lật bài người thứ ${sd.revealedCount + 1}`;
    button.disabled = state.paused || !!state.disconnected.length || (guessing && !Object.keys(sd.guesses).length);
    button.onclick = () => { button.disabled = true; send('reveal_next', { expectedCount: sd.revealedCount }); }; panel.append(button);
  }
}

const baseResult = renderResultModal;
renderResultModal = function(state) {
  baseResult(state);
  [...$('res-showdown-rows').children].forEach((row, index) => {
    const p = state.lastResult.playerResults[index], column = row.lastElementChild;
    row.classList.toggle('order-error', !p.orderCorrect);
    const cards = document.createElement('div'); cards.className = 'best-five'; p.best5.forEach(c => cards.append(createCardEl(c, 'sm')));
    const explanation = document.createElement('small'); explanation.textContent = p.comparison;
    column.append(cards, explanation);
  });
  $('btn-result-to-lobby').classList.toggle('hidden', !isHost);
};
const baseGameOver = renderGameOverModal;
renderGameOverModal = function(state) {
  baseGameOver(state);
  $('btn-go-lobby').classList.toggle('hidden', !isHost);
  if (!$('btn-final-details')) {
    const button = document.createElement('button'); button.id = 'btn-final-details'; button.className = 'btn btn-outline btn-block'; button.textContent = 'Xem bài và giải thích vụ cướp cuối';
    button.onclick = () => { $('modal-gameover').classList.add('hidden'); openHistory(); }; document.querySelector('.gameover-actions').append(button);
  }
};

function openManagement() { renderManagement(); $('modal-management').classList.remove('hidden'); }
function renderManagement() {
  const box = $('management-content'); box.replaceChildren(); if (!lastState) return;
  const button = (label, event, data = {}) => { const b = document.createElement('button'); b.className = 'btn btn-outline btn-sm'; b.textContent = label; b.onclick = () => send(event, data); return b; };
  if (isHost) {
    box.append(button(lastState.paused ? '▶ Tiếp tục' : '⏸ Tạm dừng', 'set_paused', { paused: !lastState.paused }));
    if (lastState.phase !== 'WAITING') {
      const lobby = button('🏠 Đưa cả đội về phòng chờ', 'return_to_lobby');
      lobby.onclick = () => { if (['RESULT', 'GAME_OVER'].includes(lastState.phase) || confirm('Vụ cướp hiện tại sẽ kết thúc mà không tính điểm. Đưa cả đội về phòng chờ?')) send('return_to_lobby'); }; box.append(lobby);
    }
  }
  for (const p of lastState.players) {
    const row = document.createElement('div'); row.className = 'management-row';
    const label = document.createElement('span'); label.textContent = `${p.avatar} ${p.name}${p.isHost ? ' 👑' : ''} · ${p.connected ? 'Đang kết nối' : 'Mất kết nối'}`; row.append(label);
    if (isHost && p.id !== myId) {
      if (p.connected) row.append(button('Trao chủ phòng', 'transfer_host', { targetId: p.id }));
      if (['WAITING', 'RESULT', 'GAME_OVER'].includes(lastState.phase)) row.append(button('Mời ra', 'remove_player', { targetId: p.id }));
    }
    box.append(row);
  }
  if (['WAITING', 'RESULT', 'GAME_OVER'].includes(lastState.phase)) box.append(button('Rời phòng', 'leave_room'));
  const note = document.createElement('p'); note.textContent = 'Ghế được giữ khi mất WiFi. Khi đang chơi, chủ phòng chuyển về phòng chờ để thay người. Phòng không có người kết nối được lưu tối đa 12 giờ.'; box.append(note);
}
$('btn-manage-waiting').onclick = openManagement; $('btn-manage-game').onclick = openManagement;

function openHistory() {
  const cached = prefs.read('gang.history', { heists: [], matches: [] });
  const heists = [...cached.heists], matches = [...cached.matches];
  for (const h of lastState?.history || []) if (!heists.some(x => x.matchId === h.matchId && x.heistNumber === h.heistNumber)) heists.unshift(h);
  for (const m of lastState?.matches || []) if (!matches.some(x => x.matchId === m.matchId)) matches.unshift(m);
  const box = $('history-content'); box.replaceChildren();
  const intro = document.createElement('p'); intro.textContent = 'Lịch sử cả đội trong phòng và các kết quả đã xem trên thiết bị này (100 vụ cướp gần nhất).'; box.append(intro);
  const table = document.createElement('table'); table.className = 'stats-table';
  table.innerHTML = '<thead><tr><th>Chế độ</th><th>Trận thắng / tổng</th><th>Vụ cướp thành công</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const [mode, label] of Object.entries(modeLabels)) {
    const ms = matches.filter(m => m.mode === mode), hs = heists.filter(h => h.mode === mode), row = document.createElement('tr');
    for (const text of [label, `${ms.filter(m => m.won).length}/${ms.length}`, hs.length ? `${Math.round(hs.filter(h => h.success).length / hs.length * 100)}% (${hs.length} vụ)` : 'Chưa chơi']) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); } body.append(row);
  }
  table.append(body); box.append(table);
  if (!heists.length) { const empty = document.createElement('p'); empty.textContent = 'Chưa có vụ cướp hoàn tất. Kết quả sẽ được lưu tự động sau khi so bài.'; box.append(empty); }
  for (const h of heists) {
    const details = document.createElement('details'); details.className = 'history-entry';
    const summary = document.createElement('summary'); summary.textContent = `${h.success ? '🔓' : '🚨'} ${modeLabels[h.mode]} · vụ ${h.heistNumber} · ${new Date(h.date).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`; details.append(summary);
    const reason = document.createElement('p'); reason.textContent = h.reason; details.append(reason);
    for (const p of h.playerResults) {
      const row = document.createElement('div'); row.className = 'history-hand';
      const text = document.createElement('p'); text.textContent = `${p.chip}⭐ ${p.name}: ${p.handNameVi}`; row.append(text);
      p.best5.forEach(c => row.append(createCardEl(c, 'sm')));
      const explanation = document.createElement('small'); explanation.textContent = p.comparison || ''; row.append(explanation); details.append(row);
    }
    box.append(details);
  }
  if (heists.length) {
    const button = document.createElement('button'); button.className = 'btn btn-outline'; button.textContent = 'Tải lịch sử JSON';
    button.onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify({ heists, matches }, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'the-gang-history.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }; box.append(button);
  }
  $('modal-history').classList.remove('hidden');
}
for (const id of ['btn-history-lobby', 'btn-history-waiting', 'btn-history-game']) $(id).onclick = openHistory;

function renderTutorial() {
  const box = $('tutorial-content'); box.replaceChildren();
  const title = document.createElement('h4'); title.textContent = tutorialStep < 4 ? `Vòng ${tutorialStep + 1}/4 — ${['Pre-Flop', 'Flop', 'Turn', 'River'][tutorialStep]}` : 'So bài: cả đội cùng thắng'; box.append(title);
  const note = document.createElement('p'); note.textContent = 'Trong luyện tập bạn được xem bài cả hai người. Khi chơi thật, chỉ được xem bài của mình và giao tiếp bằng chip.'; box.append(note);
  const card = (value, suit) => ({ value, suit });
  const my = [card(2, 'spades'), card(2, 'hearts')], other = [card(13, 'hearts'), card(12, 'diamonds')];
  const board = [card(3, 'clubs'), card(7, 'spades'), card(10, 'hearts'), card(13, 'clubs'), card(13, 'diamonds')];
  for (const [label, cards] of [['Bạn', my], ['Đồng đội', other], ['Bài chung', board.slice(0, [0, 3, 4, 5, 5][tutorialStep])]]) {
    const row = document.createElement('div'); row.className = 'tutorial-cards'; const text = document.createElement('strong'); text.textContent = label; row.append(text); cards.forEach(c => row.append(createCardEl(c, 'sm'))); box.append(row);
  }
  if (tutorialStep < 4) {
    const question = document.createElement('p'); question.textContent = 'Bạn chọn chip nào? 1⭐ yếu hơn, 2⭐ mạnh hơn đồng đội.'; box.append(question);
    for (const value of [1, 2]) {
      const button = document.createElement('button'); button.className = 'btn btn-gold'; button.textContent = `Chọn ${value}⭐`;
      button.onclick = () => {
        const correct = value === [2, 2, 1, 1][tutorialStep];
        $('tutorial-feedback').textContent = correct ? '✓ Đúng! Chốt chip khi cả đội thống nhất. Nếu đổi chip, cả đội chốt lại.' : 'Thử lại: trước Turn đôi 2 mạnh hơn bài cao; từ Turn đồng đội có đôi K rồi bộ ba K.';
        tutorialAnswered = correct; $('btn-tutorial-next').disabled = !correct;
      }; box.append(button);
    }
    const feedback = document.createElement('p'); feedback.id = 'tutorial-feedback'; feedback.setAttribute('aria-live', 'polite'); box.append(feedback);
    const next = document.createElement('button'); next.id = 'btn-tutorial-next'; next.className = 'btn btn-primary'; next.textContent = 'Chốt chip & tiếp tục →'; next.disabled = !tutorialAnswered;
    next.onclick = () => { tutorialStep++; tutorialAnswered = false; renderTutorial(); }; box.append(next);
  } else {
    const result = document.createElement('p'); result.textContent = '🔓 Bạn giữ chip đỏ 1⭐: hai đôi K và 2. Đồng đội giữ 2⭐: bộ ba K. Thứ tự tăng dần nên vụ cướp thành công. Nếu hai bộ 5 lá mạnh bằng nhau, thứ tự giữa hai người đều hợp lệ.'; box.append(result);
    const restart = document.createElement('button'); restart.className = 'btn btn-primary'; restart.textContent = 'Luyện tập lại'; restart.onclick = () => { tutorialStep = 0; tutorialAnswered = false; renderTutorial(); }; box.append(restart);
  }
}
$('btn-tutorial').onclick = () => { tutorialStep = 0; tutorialAnswered = false; renderTutorial(); $('modal-tutorial').classList.remove('hidden'); };
document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelectorAll('.modal-backdrop').forEach(el => el.classList.add('hidden')); });
