'use strict';

const PROFILE_TOKEN_KEY = 'chill-thrill:profile-token';
const PROFILE_RECOVERY_KEY = 'chill-thrill:profile-recovery';
const socket = io({ auth: localStorage.getItem(PROFILE_TOKEN_KEY) ? { profileToken: localStorage.getItem(PROFILE_TOKEN_KEY) } : {} });
const $ = id => document.getElementById(id), RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'], SUITS = ['S', 'C', 'D', 'H'], SUIT_LABELS = { S: '♠', C: '♣', D: '♦', H: '♥' };
let state = null, roomCode = '', playerId = '', selected = new Set(), bySuit = false, draftMelds = [], draftSends = [];
function rememberProfile(payload) { if (!payload?.profile) return; if (payload.profileToken) localStorage.setItem(PROFILE_TOKEN_KEY, payload.profileToken); if (payload.recoveryCode) localStorage.setItem(PROFILE_RECOVERY_KEY, payload.recoveryCode); if (!$('name').value.trim()) $('name').value = payload.profile.displayName || ''; if (payload.profile.avatar) $('avatar').value = payload.profile.avatar; }
function notice(message) { $('notice').textContent = message || ''; }
function show(id) { ['home-view', 'room-view', 'game-view'].forEach(view => { $(view).hidden = view !== id; }); }
function actionId() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function credentialsKey(code) { return `chill-thrill:phom:${code}`; }
function player(id) { return state?.players.find(item => item.id === id); }
function cardText(card) { return `${card.rank}${SUIT_LABELS[card.suit] || ''}`; }
function rank(card) { return RANKS.indexOf(card.rank); }
function suit(card) { return SUITS.indexOf(card.suit); }
function send(action, extra = {}) { if (state) socket.emit('game_action', { roomCode, action, actionId: actionId(), expectedRevision: state.revision, ...extra }); }
function sorted(cards) { return [...cards].sort((left, right) => bySuit ? suit(left) - suit(right) || rank(left) - rank(right) : rank(left) - rank(right) || suit(left) - suit(right)); }
function resetDrafts() { draftMelds = []; draftSends = []; selected.clear(); }
function draftedIds() { return new Set([...draftMelds.flat(), ...draftSends.map(item => item.cardId)]); }
function renderPlayers(target, game = false) { target.innerHTML = ''; state.players.forEach(item => { const el = document.createElement('article'); el.className = `player${item.id === state.currentPlayerId ? ' current' : ''}${item.id === playerId ? ' me' : ''}`; const details = game ? ` · ${item.handCount} lá${item.laid ? ' · đã hạ' : ''}${item.id === state.currentPlayerId ? ' · đang lượt' : ''}${item.leaveAfterHand ? ' · rời sau ván' : ''}` : `${item.isHost ? ' · chủ bàn' : ''}${item.ready ? ' · sẵn sàng' : ''}`; const name = document.createElement('span'), meta = document.createElement('span'); name.className = 'player-name'; meta.className = 'player-meta'; name.textContent = `${item.avatar} ${item.name}`; meta.textContent = `${item.connected ? '● online' : '○ mất kết nối'}${details}`; el.append(name, meta); target.appendChild(el); }); }
function renderRoom() { show('room-view'); $('room-title').textContent = state.roomCode; renderPlayers($('room-players')); const me = player(playerId), allReady = state.players.length >= 2 && state.players.every(item => item.ready && item.connected), economy = GameValues.describeEconomy(state); $('ready').textContent = me?.ready ? 'Bỏ sẵn sàng' : 'Sẵn sàng'; $('start').hidden = !me?.isHost; $('start').disabled = !allReady; $('room-status').textContent = state.players.length < 2 ? `Cần thêm ít nhất một người. ${economy}.` : `Bắt đầu sẽ ${economy} để bao phủ trường hợp đền.`; }
function renderTable() { const card = state.discardTop; $('stock-count').textContent = state.stockCount; $('table-cards').innerHTML = ''; if (card) { const el = document.createElement('span'); el.className = `table-card ${card.suit === 'H' || card.suit === 'D' ? 'red' : ''}`; el.textContent = cardText(card); GameArt.paintCard(el, card); $('table-cards').appendChild(el); } else $('table-cards').innerHTML = '<span class="empty-table">Chưa có lá đánh.</span>'; const by = player(state.discardById); $('table-info').textContent = card ? `${by?.name || 'Người chơi'} vừa đánh ${cardText(card)}.${state.chotEligible ? ' Đây là lá chốt: ăn lá này tính 2 đơn vị.' : ''}` : 'Người đầu tiên đang chọn lá đánh.'; }
function renderPublicMelds() {
  const target = $('meld-list'); target.replaceChildren();
  const all = state.publicMelds || []; if (!all.length) { target.textContent = 'Chưa ai hạ bài.'; return; }
  all.forEach(item => {
    const group = document.createElement('div'), heading = document.createElement('p');
    heading.textContent = `${item.name}${item.score === 150 ? ' · móm' : ` · rác ${item.score} điểm`}`; group.append(heading);
    item.melds.forEach((meld, index) => {
      const title = document.createElement('p'), row = document.createElement('div');
      title.textContent = `#${index + 1} ${meld.kind === 'set' ? 'Bộ' : 'Dây'}`; row.className = 'public-meld-cards';
      meld.cards.forEach(card => { const face = document.createElement('span'); face.className = 'table-card'; row.append(GameArt.paintCard(face, card)); });
      group.append(title, row);
    });
    target.append(group);
  });
}
function renderDrafts() { const panel = $('drafts'), target = $('draft-list'); if (state?.phase !== 'LAYDOWN' || state.currentPlayerId !== playerId) { panel.hidden = true; return; } panel.hidden = false; target.innerHTML = ''; const groups = draftMelds.map((group, index) => `Phỏm nháp #${index + 1}: ${group.map(id => cardText(state.myHand.find(card => card.id === id) || { rank: id, suit: '' })).join(' ')}`); const sends = draftSends.map(item => `Gửi ${cardText(state.myHand.find(card => card.id === item.cardId) || { rank: item.cardId, suit: '' })} vào phỏm #${item.targetMeldIndex + 1}`); target.textContent = [...groups, ...sends].join(' · ') || 'Chưa chọn phỏm hay lá gửi.'; }
function addButton(target, label, fn, primary = false) { const button = document.createElement('button'); button.textContent = label; if (primary) button.className = 'primary'; button.addEventListener('click', fn); target.appendChild(button); }
function renderActions() {
  const target = $('actions'); target.innerHTML = ''; const me = player(playerId), myTurn = state.currentPlayerId === playerId, selectedCards = state.myHand.filter(card => selected.has(card.id));
  if (state.paused) { target.textContent = `Ván tạm dừng để giữ bài và ${currencyUnit()}; chờ mọi người kết nối lại.`; return; }
  if (state.phase === 'DRAW_OR_EAT') {
    target.textContent = myTurn ? `Chọn bốc nọc, hoặc chọn các lá trên tay để ghép với ${state.discardTop ? cardText(state.discardTop) : 'lá vừa đánh'} rồi ăn.` : `Đang chờ ${player(state.currentPlayerId)?.name || 'người chơi'} bốc hoặc ăn.`;
    if (myTurn) { addButton(target, 'Bốc nọc', () => send('draw'), true); if (state.discardTop) addButton(target, `Ăn ${cardText(state.discardTop)}${selectedCards.length ? ` + ${selectedCards.length} lá chọn` : ''}`, () => send('eat', { melds: [[...selected, state.discardTop.id]] })); }
    return;
  }
  if (state.phase === 'DISCARD') {
    target.textContent = myTurn ? 'Chọn đúng một lá trên tay để đánh, hoặc báo ù nếu toàn bộ bài đã thành phỏm.' : `Đang chờ ${player(state.currentPlayerId)?.name || 'người chơi'} đánh bài.`;
    if (myTurn) { addButton(target, `Đánh${selectedCards.length === 1 ? ` ${cardText(selectedCards[0])}` : ''}`, () => { if (selected.size !== 1) return notice('Hãy chọn đúng một lá để đánh.'); send('discard', { cardId: [...selected][0] }); }, true); target.lastElementChild.disabled = selectedCards.length !== 1; addButton(target, 'Báo ù', () => send('declare_u')); if (me?.isHost && !state.playedAny) addButton(target, `Hủy ván và hoàn ${currencyUnit()}`, () => send('cancel_before_first_discard')); }
    return;
  }
  if (state.phase === 'LAYDOWN') {
    target.textContent = myTurn ? 'Tạo các phỏm từ lá đã chọn; sau đó có thể gửi lá rác vào phỏm công khai đã hạ trước đó.' : `Đang chờ ${player(state.currentPlayerId)?.name || 'người chơi'} hạ bài.`;
    if (!myTurn) return;
    addButton(target, 'Ghép phỏm', () => { if (selected.size < 3) return notice('Phỏm cần ít nhất 3 lá.'); draftMelds.push([...selected]); selected.clear(); renderHand(); renderActions(); renderDrafts(); });
    if (state.mySuggestion?.melds?.length) addButton(target, 'Gợi ý', () => { draftMelds = state.mySuggestion.melds.map(group => [...group]); draftSends = []; selected.clear(); renderHand(); renderActions(); renderDrafts(); });
    const destinations = (state.publicMelds || []).flatMap(owner => owner.melds.map((meld, index) => ({ playerId: owner.playerId, index, label: `${owner.name} #${index + 1}` })));
    if (destinations.length) {
      const select = document.createElement('select'); select.className = 'send-meld-target'; select.setAttribute('aria-label', 'Chọn phỏm để gửi bài');
      destinations.forEach((item, i) => select.append(new Option(item.label, String(i)))); target.append(select);
      addButton(target, 'Gửi', () => { if (!selected.size) return notice('Chọn lá rác muốn gửi trước.'); const destination = destinations[Number(select.value)]; for (const cardId of selected) draftSends.push({ cardId, targetPlayerId: destination.playerId, targetMeldIndex: destination.index }); selected.clear(); renderHand(); renderActions(); renderDrafts(); });
    }
    addButton(target, 'Xóa nháp', () => { resetDrafts(); renderHand(); renderActions(); renderDrafts(); });
    addButton(target, 'Hạ bài', () => send('lay_down', { melds: draftMelds, sends: draftSends }), true);
    return;
  }
  target.textContent = state.phase === 'RESULT' ? 'Ván đã thanh toán xong trên server.' : 'Đang chờ trạng thái ván.';
}
function selectionInfo() {
  const cards = state.myHand.filter(card => selected.has(card.id));
  $('selection-info').textContent = cards.length ? `Đã chọn: ${cards.map(cardText).join(' ')}` : 'Chạm / vuốt chọn bài. Lá đã ăn được giữ để bảo toàn phỏm khi đánh.';
}
function renderHand() {
  const cards = sorted(state.myHand || []), validIds = new Set(cards.map(card => card.id)), used = draftedIds();
  const discarding = state.phase === 'DISCARD' && state.currentPlayerId === playerId;
  selected = new Set([...selected].filter(id => validIds.has(id) && !used.has(id) && (!discarding || state.myDiscardableCardIds.includes(id))));
  $('hand-count').textContent = `(${cards.length} lá)`; selectionInfo();
  const active = ['DRAW_OR_EAT', 'DISCARD', 'LAYDOWN'].includes(state.phase) && !state.paused;
  const locked = card => discarding && !state.myDiscardableCardIds.includes(card.id);
  HandInteraction.render({ target: $('hand'), cards, selected,
    disabled: card => !active || used.has(card.id) || locked(card), marked: card => used.has(card.id),
    title: card => locked(card) ? 'Giữ lá này để bảo toàn phỏm của lá đã ăn' : cardText(card),
    onChange: next => { selected = next; selectionInfo(); renderActions(); }
  });
}
function renderResult() { const target = $('result'); if (!state.result) { target.hidden = true; return; } target.hidden = false; target.innerHTML = ''; const heading = document.createElement('h2'), summary = document.createElement('p'), scores = document.createElement('p'), outcome = state.result.outcomes.find(item => item.playerId === playerId), me = player(playerId); heading.textContent = state.result.kind === 'U' ? `${state.result.winnerId === playerId ? 'Bạn ù!' : `${state.result.winnerName} ù`}` : state.result.kind === 'DEN' ? 'Kết quả đền' : state.result.winnerId === playerId ? 'Bạn ít điểm nhất!' : 'Kết quả Phỏm'; summary.textContent = `${state.result.reason} ${outcome ? `Ví của bạn: ${outcome.delta >= 0 ? '+' : ''}${GameValues.formatAmount(outcome.delta)} ${currencyUnit()}.` : ''}`; scores.textContent = state.result.scores.map(item => `${item.name}: ${item.mom ? 'móm' : `${item.score} điểm`}`).join(' · '); target.append(heading, summary, scores, GameValues.createEconomySummary(state)); if (state.result.transfers?.length) { const detail = document.createElement('p'); detail.className = 'small'; detail.textContent = state.result.transfers.map(item => `${player(item.fromPlayerId)?.name || 'Người chơi'} → ${player(item.toPlayerId)?.name || 'người chơi'} ${GameValues.formatAmount(item.amount)}${currencyUnit() ? ` ${currencyUnit()}` : ''} (${item.kind})`).join(' · '); target.appendChild(detail); } if (me?.isHost) addButton(target, 'Chia ván tiếp', () => send('play_again'), true); }
function renderGame() { show('game-view'); GameValues.applyEconomy(state, document); $('game-room').textContent = state.roomCode; const economy = GameValues.readEconomy(state); $('max-loss').textContent = economy.maxLoss === null ? '—' : GameValues.formatAmount(economy.maxLoss); renderPlayers($('players'), true); const current = player(state.currentPlayerId); $('phase-banner').textContent = state.paused ? 'Ván tạm dừng: đang chờ mọi người kết nối lại.' : state.phase === 'DRAW_OR_EAT' ? `Đến lượt ${current?.name || ''}: bốc hoặc ăn.` : state.phase === 'DISCARD' ? `Đến lượt ${current?.name || ''}: đánh bài.` : state.phase === 'LAYDOWN' ? `Đến lượt ${current?.name || ''}: hạ/gửi bài.` : state.phase === 'RESULT' ? `Kết quả đã chốt và ${currencyUnit()} đã thanh toán.` : ''; renderTable(); renderPublicMelds(); renderHand(); renderActions(); renderDrafts(); renderResult(); $('log').innerHTML = ''; state.log.slice(0, 10).forEach(entry => { const li = document.createElement('li'); li.textContent = entry.message; $('log').appendChild(li); }); }
function render() { if (!state) return; state.phase === 'WAITING' ? renderRoom() : renderGame(); }
function requestRoom(event) { const name = $('name').value.trim(); if (!name) return notice('Hãy nhập tên trước.'); const data = { playerName: name, avatar: $('avatar').value, ...(event === 'create_room' ? { gameId: 'phom' } : { roomCode: $('room-code').value.trim().toUpperCase() }) }; if (event === 'join_room' && data.roomCode.length !== 4) return notice('Mã bàn cần 4 ký tự.'); socket.emit(event, data); }
function storeCredentials(payload) { roomCode = payload.roomCode; playerId = payload.playerId; rememberProfile(payload); localStorage.setItem(credentialsKey(roomCode), JSON.stringify(payload)); }
$('create').addEventListener('click', () => requestRoom('create_room')); $('join').addEventListener('click', () => requestRoom('join_room')); $('room-code').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase(); }); $('room-code').addEventListener('keydown', event => { if (event.key === 'Enter') requestRoom('join_room'); }); $('ready').addEventListener('click', () => socket.emit('set_ready', { roomCode, ready: !player(playerId)?.ready })); $('start').addEventListener('click', () => socket.emit('start_game', { roomCode })); $('leave').addEventListener('click', () => socket.emit('leave_room', { roomCode })); $('game-leave').addEventListener('click', () => socket.emit('leave_room', { roomCode })); $('sort').addEventListener('click', () => { bySuit = !bySuit; $('sort').textContent = bySuit ? 'Sắp theo giá trị' : 'Sắp theo chất'; $('sort').setAttribute('aria-label', $('sort').textContent); $('sort').title = $('sort').textContent; renderHand(); }); $('copy-code').addEventListener('click', async () => { try { await navigator.clipboard.writeText(roomCode); notice('Đã sao chép mã bàn.'); } catch { notice(`Mã bàn: ${roomCode}`); } });
socket.on('room_created', payload => { storeCredentials(payload); notice('Đã tạo bàn Phỏm.'); }); socket.on('room_joined', payload => { storeCredentials(payload); notice('Đã vào bàn Phỏm.'); }); socket.on('room_resumed', payload => { storeCredentials(payload); notice('Đã khôi phục ghế Phỏm.'); }); socket.on('game_state', next => { if (next.gameId !== 'phom') return; const wasMyLaydown = state?.phase === 'LAYDOWN' && state.currentPlayerId === playerId; if (state?.matchId !== next.matchId || state?.roomCode !== next.roomCode) resetDrafts(); state = next; roomCode = next.roomCode; playerId = next.myId; if (wasMyLaydown && (next.phase !== 'LAYDOWN' || next.currentPlayerId !== playerId)) resetDrafts(); window.TablePreferences?.updateTablePreferences('#game-view', state, { before: '#players' }); render(); }); socket.on('game_error', payload => notice(payload.message)); socket.on('join_error', payload => notice(payload.message)); socket.on('resume_error', payload => { notice(payload.message); show('home-view'); }); socket.on('room_left', () => { state = null; roomCode = ''; playerId = ''; resetDrafts(); show('home-view'); }); socket.on('profile_state', rememberProfile); socket.on('connect', () => { socket.emit('profile_status', {}); const code = new URLSearchParams(location.search).get('room')?.trim().toUpperCase(); if (!code || code.length !== 4) return; const saved = localStorage.getItem(credentialsKey(code)); if (saved) { try { socket.emit('resume_room', JSON.parse(saved)); return; } catch {} } $('room-code').value = code; notice('Nhập tên để vào bàn từ lời mời.'); });

function currencyUnit() { return GameValues.currencyLabel(state); }
