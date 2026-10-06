(() => {
  'use strict';

  const STORAGE_KEY = 'chill-thrill:practice-session:v1';
  const UNO_COLORS = ['red', 'blue', 'green', 'yellow'];
  const COLOR_NAMES = { red: 'Đỏ', blue: 'Xanh dương', green: 'Xanh lá', yellow: 'Vàng' };
  const UNO_NAMES = { skip: 'Bỏ lượt', reverse: 'Đổi chiều', draw2: '+2', wild: 'Wild', wild4: '+4' };
  const elements = Object.fromEntries(['setup-card', 'practice-form', 'player-name', 'game-choice', 'table-card', 'table-title', 'variant-label', 'table-icon', 'practice-label', 'human-wins', 'bot-wins', 'session-clock', 'table-status', 'board', 'action-area', 'new-session', 'close-session', 'bot-status', 'notice'].map(id => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));
  let session = null;
  let state = null;
  let busy = false;
  let selectedTienCards = new Set();
  let callUnoNext = false;
  let pendingWildPlay = null;
  const requested = new URLSearchParams(location.search);
  const requestedChoice = `${requested.get('game')}|${requested.get('variant')}`;
  const supportedChoice = [...elements.gameChoice.options].find(option => option.value === requestedChoice && !option.disabled);
  if (supportedChoice) elements.gameChoice.value = supportedChoice.value;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function showNotice(message) {
    elements.notice.textContent = message;
    elements.notice.hidden = !message;
    if (message) window.setTimeout(() => { elements.notice.hidden = true; }, 5200);
  }

  function capabilityHeaders() {
    return session ? { Authorization: `Bearer ${session.capability}` } : {};
  }

  async function api(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...capabilityHeaders(), ...(options.headers || {}) };
    const response = await fetch(path, { ...options, headers, cache: 'no-store' });
    let payload;
    try { payload = await response.json(); } catch { payload = { ok: false, error: { message: 'Server trả dữ liệu không hợp lệ.' } }; }
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error?.message || `Yêu cầu thất bại (${response.status}).`);
      error.code = payload.error?.code;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function saveSession() {
    try {
    if (!session) { sessionStorage.removeItem(STORAGE_KEY); return; }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch { showNotice('Trình duyệt không lưu được phiên; hãy giữ tab này mở để tiếp tục luyện tập.'); }
  }

  function loadSession() {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
      if (parsed && typeof parsed.id === 'string' && typeof parsed.capability === 'string') return parsed;
    } catch { /* A damaged tab-local session can safely be replaced. */ }
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
    return null;
  }

  function showSetup() {
    elements.setupCard.hidden = false;
    elements.tableCard.hidden = true;
    state = null;
    selectedTienCards.clear();
    pendingWildPlay = null;
  }

  function updateSessionClock() {
    if (!state?.expiresAt) { elements.sessionClock.textContent = ''; return; }
    const remaining = Math.max(0, state.expiresAt - Date.now());
    const minutes = Math.ceil(remaining / 60000);
    elements.sessionClock.textContent = `Phiên còn khoảng ${minutes} phút`;
  }

  async function restoreSession() {
    session = loadSession();
    if (!session) return;
    try {
      const result = await api(`/api/practice/sessions/${encodeURIComponent(session.id)}`);
      render(result.state);
    } catch (error) {
      try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
      session = null;
      if (error.code !== 'SESSION_NOT_FOUND' && error.code !== 'SESSION_EXPIRED') showNotice(error.message);
    }
  }

  async function endCurrentSession() {
    if (!session) return;
    const current = session;
    session = null;
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
    try {
      await fetch(`/api/practice/sessions/${encodeURIComponent(current.id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${current.capability}` },
        keepalive: true,
      });
    } catch { /* Server expiry also removes abandoned in-memory sessions. */ }
  }

  async function createSession() {
    const [gameId, variant] = elements.gameChoice.value.split('|');
    const response = await fetch('/api/practice/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, variant, playerName: elements.playerName.value.trim() }),
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) throw new Error(payload.error?.message || 'Không tạo được phiên luyện tập.');
    session = { id: payload.session.id, capability: payload.session.capability };
    saveSession();
    busy = false;
    render(payload.state);
  }

  async function startFreshSession() {
    if (busy) return;
    busy = true;
    try {
      await endCurrentSession();
      await createSession();
    } catch (error) { showNotice(error.message); }
    finally { busy = false; }
  }

  function render(stateValue) {
    state = stateValue;
    selectedTienCards.clear();
    pendingWildPlay = null;
    callUnoNext = false;
    elements.setupCard.hidden = true;
    elements.tableCard.hidden = false;
    elements.tableTitle.textContent = state.gameId === 'uno' ? 'UNO 112 lá' : 'Tiến lên miền Nam';
    elements.variantLabel.textContent = state.gameId === 'uno' ? 'Luật UNO 112 lá' : 'Luật Tiến lên miền Nam';
    elements.tableIcon.textContent = state.gameId === 'uno' ? '🃏' : '♠';
    elements.practiceLabel.textContent = state.practice.label;
    elements.humanWins.textContent = state.practice.humanWins;
    elements.botWins.textContent = state.practice.botWins;
    elements.botStatus.textContent = state.botStatus === 'ready' ? 'Bot sẵn sàng' : state.botStatus === 'step-limit' ? 'Bot đã chạm giới hạn lượt an toàn' : `Bot: ${state.botStatus}`;
    updateSessionClock();
    renderStatus();
    state.gameId === 'uno' ? renderUno() : renderTienLen();
  }

  function renderStatus() {
    const publicState = state.publicState;
    const current = publicState.players.find(player => player.id === publicState.currentPlayerId);
    if (state.phase === 'RESULT') {
      const winner = publicState.result?.winnerName || publicState.players.find(player => player.id === publicState.result?.winnerId)?.name || 'Ván đã kết thúc';
      elements.tableStatus.textContent = `${winner} thắng ván luyện tập. Điểm này không đổi tài sản trong ví.`;
      return;
    }
    if (publicState.currentPlayerId === state.player.id) elements.tableStatus.textContent = 'Đến lượt bạn.';
    else if (current) elements.tableStatus.textContent = `${current.name} đang suy nghĩ…`;
    else elements.tableStatus.textContent = 'Đang chia bài…';
  }

  function renderSeats() {
    const seats = node('div', 'seats');
    for (const player of state.publicState.players) {
      const seat = node('div', `seat${player.id === state.publicState.currentPlayerId ? ' is-current' : ''}`);
      seat.append(node('strong', '', player.name + (player.id === state.player.id ? ' · Bạn' : '')));
      seat.append(node('small', '', `${player.cardCount} lá${player.unoCalled === false ? ' · chưa gọi UNO' : ''}`));
      seats.append(seat);
    }
    return seats;
  }

  function unoCardText(card) {
    if (!card) return '—';
    return typeof card.value === 'number' ? String(card.value) : UNO_NAMES[card.type] || String(card.type);
  }

  function unoCardClass(card) {
    if (!card?.color) return 'uno-wild';
    return `uno-${card.color}`;
  }

  function renderUno() {
    const board = elements.board;
    board.replaceChildren();
    const line = node('div', 'board-topline');
    line.append(node('span', '', `Màu hiện tại: ${COLOR_NAMES[state.publicState.currentColor] || 'chọn màu'}`));
    line.append(node('span', '', `${state.publicState.drawPileCount} lá để rút`));
    board.append(line, renderSeats());

    const center = node('div', 'center-card');
    const top = node('span', `uno-card ${unoCardClass(state.publicState.topCard)}`, unoCardText(state.publicState.topCard));
    center.append(top);
    const details = node('span', 'table-hint', state.publicState.pendingDraw ? `Đang chờ rút ${state.publicState.pendingDraw} lá.` : state.publicState.reactionWindow ? 'Có phản ứng +4 đang mở.' : 'Lá trên cùng và số lá của mỗi ghế là thông tin công khai.');
    center.append(details);
    board.append(center);

    const handHeading = node('div', 'hand-heading');
    handHeading.append(node('span', '', `Bài của bạn · ${state.player.hand.length} lá`));
    handHeading.append(node('small', '', 'Server kiểm tra lại mọi nước đi'));
    elements.actionArea.replaceChildren();
    elements.actionArea.append(handHeading);

    const legalCardIds = new Set(state.player.availableActions.filter(action => action.type === 'play_card').map(action => action.cardId));
    const hand = node('div', 'cards');
    for (const card of state.player.hand) {
      const button = node('button', `hand-card ${unoCardClass(card)}`, unoCardText(card));
      button.type = 'button'; button.setAttribute('aria-label', `${card.color || 'Wild'} ${unoCardText(card)}`);
      button.dataset.cardId = card.id;
      button.disabled = !legalCardIds.has(card.id) || state.busy === true || state.phase === 'RESULT';
      button.addEventListener('click', () => startUnoPlay('play_card', card.id, card));
      hand.append(button);
    }
    elements.actionArea.append(hand);
    renderUnoControls();
  }

  function addActionButton(label, callback, className = '') {
    const button = node('button', `action-button ${className}`.trim(), label);
    button.type = 'button'; button.disabled = busy;
    button.addEventListener('click', callback);
    elements.actionArea.append(button);
    return button;
  }

  function renderUnoControls() {
    const actions = state.player.availableActions;
    const has = type => actions.some(action => action.type === type);
    if (has('call_uno')) addActionButton('Gọi UNO', () => sendUnoAction('call_uno', {}));
    if (has('catch_uno')) addActionButton('Bắt lỗi UNO', () => sendUnoAction('catch_uno', {}), 'warning');
    if (has('choose_color')) renderColorChoice(color => sendUnoAction('choose_color', { color }), 'Chọn màu mở đầu');
    if (has('challenge_draw_four')) addActionButton('Phản đối +4', () => sendUnoAction('challenge_draw_four', {}), 'secondary');
    if (has('draw_penalty')) addActionButton(state.publicState.reactionWindow ? 'Chấp nhận +4' : `Rút ${state.publicState.pendingDraw || 4} lá`, () => sendUnoAction('draw_penalty', {}));
    if (has('draw_card')) addActionButton('Rút một lá', () => sendUnoAction('draw_card', {}), 'secondary');
    const drawnAction = actions.find(action => action.type === 'play_drawn');
    if (drawnAction) {
      const drawn = state.publicState.drawChoice;
      addActionButton(`Đánh lá vừa rút · ${unoCardText(drawn)}`, () => startUnoPlay('play_drawn', drawnAction.cardId, drawn));
    }
    if (has('pass_draw')) addActionButton('Bỏ lượt', () => sendUnoAction('pass_draw', {}), 'secondary');
    if (state.phase === 'RESULT') addActionButton('Chia ván luyện tập mới', () => sendUnoAction('start_next_round', {}));
    if (state.player.hand.length === 2 && state.publicState.currentPlayerId === state.player.id && actions.some(action => action.type === 'play_card')) {
      addActionButton(callUnoNext ? '✓ Gọi UNO cho lá kế' : 'Gọi UNO cho lá kế', () => { callUnoNext = !callUnoNext; renderUno(); }, callUnoNext ? '' : 'secondary');
    }
    if (pendingWildPlay) renderColorChoice(color => {
      const pending = pendingWildPlay;
      pendingWildPlay = null;
      sendUnoAction(pending.type, { cardId: pending.cardId, chosenColor: color, callUno: callUnoNext });
    }, 'Chọn màu mới');
  }

  function startUnoPlay(type, cardId, card) {
    if (busy) return;
    if (card?.type === 'wild' || card?.type === 'wild4') {
      pendingWildPlay = { type, cardId };
      renderUno();
      return;
    }
    sendUnoAction(type, { cardId, callUno: callUnoNext });
  }

  function renderColorChoice(onChoose, label) {
    const row = node('div', 'color-choice');
    row.append(node('span', '', label));
    for (const color of UNO_COLORS) {
      const button = node('button', `color-button color-${color}`);
      button.type = 'button'; button.title = COLOR_NAMES[color]; button.setAttribute('aria-label', COLOR_NAMES[color]);
      button.addEventListener('click', () => onChoose(color));
      row.append(button);
    }
    elements.actionArea.append(row);
  }

  function renderTienLen() {
    const board = elements.board;
    board.replaceChildren();
    const topLine = node('div', 'board-topline');
    topLine.append(node('span', '', state.publicState.playedAny ? 'Ván đang diễn ra · Tiến lên miền Nam local v1' : 'Lượt mở phải đánh lá thấp nhất đã chia'));
    topLine.append(node('span', '', `Vòng dẫn: ${state.publicState.players.find(player => player.id === state.publicState.leaderId)?.name || 'chưa có'}`));
    board.append(topLine, renderSeats());
    const center = node('div', 'center-card');
    if (state.publicState.topPlay) {
      const cards = node('div', 'cards');
      for (const card of state.publicState.topPlay.cards) cards.append(node('span', `hand-card ${card.suit === 'H' || card.suit === 'D' ? 'uno-red' : 'uno-blue'}`, `${card.rank}${suitSymbol(card.suit)}`));
      center.append(cards, node('span', 'table-hint', `${state.publicState.topPlay.formation.kind} · ${state.publicState.players.find(player => player.id === state.publicState.topPlay.playerId)?.name || ''}`));
    } else center.append(node('span', 'table-hint', 'Chưa có bài trên bàn.'));
    board.append(center);

    const heading = node('div', 'hand-heading');
    heading.append(node('span', '', `Bài của bạn · ${state.player.hand.length} lá`));
    heading.append(node('small', '', 'Tổ hợp sẽ được validator server kiểm tra'));
    elements.actionArea.replaceChildren(heading);
    const isTurn = state.publicState.currentPlayerId === state.player.id && state.phase !== 'RESULT';
    const cards = node('div', 'cards');
    for (const card of state.player.hand) {
      const button = node('button', `hand-card ${card.suit === 'H' || card.suit === 'D' ? 'uno-red' : 'uno-blue'}${selectedTienCards.has(card.id) ? ' selected' : ''}`, `${card.rank}${suitSymbol(card.suit)}`);
      button.type = 'button'; button.disabled = !isTurn || busy;
      button.dataset.cardId = card.id;
      button.setAttribute('aria-pressed', String(selectedTienCards.has(card.id)));
      button.addEventListener('click', () => { selectedTienCards.has(card.id) ? selectedTienCards.delete(card.id) : selectedTienCards.add(card.id); renderTienLen(); });
      cards.append(button);
    }
    elements.actionArea.append(cards);

    const selection = selectedTienCards.size ? state.player.hand.filter(card => selectedTienCards.has(card.id)) : [];
    const formation = selection.length ? window.TienLenRules.classify(selection) : null;
    const hasRequired = !state.publicState.initialRequiredCardId || selection.some(card => card.id === state.publicState.initialRequiredCardId);
    const canBeat = !state.publicState.topPlay || window.TienLenRules.canBeat(formation, state.publicState.topPlay.formation);
    const selectionLabel = selection.length === 0 ? 'Chọn một tổ hợp. Nếu không chặt được, bạn có thể bỏ lượt.' : !formation ? 'Các lá đã chọn chưa tạo thành tổ hợp hợp lệ.' : !hasRequired ? 'Lượt mở phải có lá được yêu cầu.' : !canBeat ? 'Tổ hợp này chưa chặt được bài trên bàn.' : `Có thể đánh: ${window.TienLenRules.formationName(formation)}.`;
    elements.actionArea.append(node('p', 'selection-help', selectionLabel));
    if (state.player.availableActions.includes('play')) {
      const play = addActionButton('Đánh tổ hợp đã chọn', () => sendTienAction('play', selection.map(card => card.id)), '');
      play.disabled = busy || !formation || !hasRequired || !canBeat;
    }
    if (state.player.availableActions.includes('pass')) addActionButton('Bỏ lượt', () => sendTienAction('pass'), 'secondary');
    if (state.player.availableActions.includes('play_again')) addActionButton('Chia ván luyện tập mới', () => sendTienAction('play_again'), '');
  }

  function suitSymbol(suit) { return ({ S: '♠', C: '♣', D: '♦', H: '♥' })[suit] || suit; }

  async function sendUnoAction(type, payload) {
    if (!state || busy) return;
    await sendAction({ matchId: state.matchId, expectedRevision: state.revision, actionId: crypto.randomUUID(), type, payload });
  }

  async function sendTienAction(action, cardIds) {
    if (!state || busy) return;
    await sendAction({ matchId: state.matchId, expectedRevision: state.revision, actionId: crypto.randomUUID(), action, ...(cardIds ? { cardIds } : {}) });
  }

  async function sendAction(envelope) {
    if (!session) return;
    busy = true;
    elements.actionArea.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      const response = await api(`/api/practice/sessions/${encodeURIComponent(session.id)}/actions`, { method: 'POST', body: JSON.stringify(envelope) });
      busy = false;
      render(response.state);
      if (response.bot?.status === 'step-limit') showNotice('Bot đã chạm giới hạn lượt an toàn. Hãy chia ván luyện tập mới.');
    } catch (error) {
      if (error.code === 'SESSION_EXPIRED' || error.code === 'SESSION_NOT_FOUND') { await endCurrentSession(); showSetup(); }
      showNotice(error.message);
      if (session) {
        try { const fresh = await api(`/api/practice/sessions/${encodeURIComponent(session.id)}`); busy = false; render(fresh.state); } catch { /* The error is already shown. */ }
      }
    } finally { busy = false; }
  }

  elements.practiceForm.addEventListener('submit', event => { event.preventDefault(); startFreshSession(); });
  elements.newSession.addEventListener('click', () => {
    if (busy) return;
    showSetup();
    elements.gameChoice.focus();
  });
  elements.closeSession.addEventListener('click', async () => { await endCurrentSession(); showSetup(); });
  window.setInterval(updateSessionClock, 10000);
  window.addEventListener('DOMContentLoaded', () => {
    if (requestedChoice === 'uno|classic-108-v1') showNotice('UNO 108 (classic-108-v1) chưa hỗ trợ luyện tập. Chọn UNO 112 (classic-local-v1) để bắt đầu.');
    restoreSession();
  }, { once: true });
})();
