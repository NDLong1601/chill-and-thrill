'use strict';

/* UNO client: renders only the server-redacted view and sends revisioned
   action envelopes. It never decides whether a card is legal. */
(function unoClient() {
  const $ = id => document.getElementById(id);
  let current = null;
  let pendingWild = null;
  const colors = ['red', 'blue', 'green', 'yellow'];
  const colorNames = { red: 'Đỏ', blue: 'Xanh dương', green: 'Xanh lá', yellow: 'Vàng' };
  const symbols = { skip: '⛔', reverse: '↔', draw2: '+2', wild: '★', wild4: '+4' };

  const escText = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const action = (type, payload = {}) => {
    if (!current || !current.matchId) return;
    socket.emit('game:action', { actionId: crypto.randomUUID(), roomCode, matchId: current.matchId, seatId: myId, expectedRevision: current.revision, type, payload });
  };
  const hasAction = (type, cardId) => (current?.availableActions || []).some(item => item.type === type && (!cardId || item.cardId === cardId));
  const playerName = id => current?.players.find(player => player.id === id)?.name || 'Người chơi';

  function cardLabel(card) {
    if (!card) return '';
    return card.type === 'number' ? String(card.value) : symbols[card.type];
  }

  function cardElement(card, selected = false) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `uno-card uno-card-${card.color || 'wild'} ${selected ? 'is-selected' : ''}`;
    button.setAttribute('aria-label', `${cardLabel(card)}${card.color ? ` ${colorNames[card.color]}` : ''}`);
    button.innerHTML = `<span class="uno-card-value">${escText(cardLabel(card))}</span><small>${escText(card.color ? colorNames[card.color] : 'Wild')}</small>`;
    return button;
  }

  function renderUnoWaiting(state) {
    $('disp-room-code').textContent = state.roomCode;
    $('disp-room-name').textContent = state.roomName || 'UNO · Phòng LAN';
    $('disp-room-visibility').textContent = state.visibility === 'invite' ? '🔒 Chỉ qua lời mời' : `🌐 Công khai trong LAN · ${state.players.length}/${state.maxPlayers} ghế`;
    $('disp-member-count').textContent = state.players.length;
    $('disp-member-max').textContent = state.maxPlayers;
    $('disp-member-hint').textContent = `Cần từ 2 đến ${state.maxPlayers} người chơi`;
    $('disp-mode-title').textContent = 'UNO · Cổ điển local v1';
    $('disp-mode-desc').textContent = '2–4 người · bộ 112 lá · không cộng dồn phạt · một ván một người hết bài.';
    $('sel-change-mode').classList.add('hidden');
    $('strict-chat').closest('label')?.classList.add('hidden');
    const readyCount = state.players.filter(player => player.ready && player.connected).length;
    $('btn-start-game').classList.toggle('hidden', !isHost);
    $('btn-start-game').disabled = !isHost || readyCount !== state.players.length || readyCount < 2;
    $('btn-start-game').textContent = isHost ? '▶ BẮT ĐẦU UNO' : 'Đang chờ chủ phòng bắt đầu UNO…';
    $('wait-client-hint').textContent = `${readyCount}/${state.players.length} đã sẵn sàng. Chủ phòng sẽ bắt đầu khi mọi người sẵn sàng.`;
  }

  function renderPlayers() {
    const list = $('uno-player-list'); list.replaceChildren();
    current.players.forEach(player => {
      const row = document.createElement('div'); row.className = `uno-player ${player.isCurrent ? 'is-current' : ''}`;
      row.innerHTML = `<span class="uno-player-avatar">${escText(player.avatar || '🎴')}</span><span class="uno-player-main"><strong>${escText(player.name)}</strong><small>${player.isCurrent ? 'ĐANG ĐI' : player.connected ? 'Đã kết nối' : 'Đang nối lại'}</small></span><span class="uno-player-count">${player.cardCount} lá</span>`;
      list.appendChild(row);
    });
  }

  function sendCard(card, cardId = card.id) {
    if (card.type === 'wild' || card.type === 'wild4') {
      pendingWild = { cardId, type: hasAction('play_drawn', cardId) ? 'play_drawn' : 'play_card' };
      renderColorPicker(); return;
    }
    action(hasAction('play_drawn', cardId) ? 'play_drawn' : 'play_card', { cardId });
  }

  function renderColorPicker() {
    const box = $('uno-color-picker'); box.replaceChildren(); box.classList.toggle('hidden', !pendingWild);
    if (!pendingWild) return;
    const title = document.createElement('span'); title.textContent = 'Chọn màu tiếp theo:'; box.appendChild(title);
    colors.forEach(color => {
      const button = document.createElement('button'); button.type = 'button'; button.className = `uno-color-button uno-color-${color}`; button.textContent = colorNames[color];
      button.onclick = () => { const selected = pendingWild; pendingWild = null; box.classList.add('hidden'); action(selected.type, { cardId: selected.cardId, chosenColor: color }); };
      box.appendChild(button);
    });
  }

  function renderHand() {
    const hand = $('uno-hand'); hand.replaceChildren();
    $('uno-hand-count').textContent = `${current.myHand.length} lá`;
    current.myHand.forEach(card => {
      const playable = hasAction('play_card', card.id) || hasAction('play_drawn', card.id);
      const button = cardElement(card, pendingWild?.cardId === card.id);
      button.disabled = !playable;
      button.onclick = () => { if (playable) sendCard(card); };
      hand.appendChild(button);
    });
  }

  function renderActions() {
    const box = $('uno-actions'); box.replaceChildren();
    const add = (label, type, payload = {}, disabled = false) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-primary'; button.textContent = label; button.disabled = disabled; button.onclick = () => action(type, payload); box.appendChild(button); };
    if (hasAction('draw_card')) add('RÚT 1 LÁ', 'draw_card');
    if (hasAction('pass_draw')) add('BỎ LƯỢT SAU KHI RÚT', 'pass_draw');
    if (hasAction('call_uno')) add('📣 GỌI UNO', 'call_uno');
    if (hasAction('catch_uno')) add(`BẮT LỖI UNO · ${playerName(current.unoWindow.playerId)}`, 'catch_uno');
    if (hasAction('draw_penalty')) add(`RÚT ${current.reactionWindow ? 4 : current.pendingDraw} LÁ`, 'draw_penalty');
    if (hasAction('challenge_draw_four')) add('⚖️ PHẢN ĐỐI +4', 'challenge_draw_four');
    if (hasAction('choose_color')) colors.forEach(color => add(`MÀU ${colorNames[color]}`, 'choose_color', { color }));
    if (!box.children.length && current.phase === 'PLAYING') { const hint = document.createElement('span'); hint.className = 'uno-action-hint'; hint.textContent = current.currentPlayerId === myId ? 'Chọn lá bài hợp lệ hoặc rút một lá.' : `Chờ ${playerName(current.currentPlayerId)} đi.`; box.appendChild(hint); }
  }

  function renderResult() {
    const box = $('uno-result'); box.replaceChildren(); box.classList.toggle('hidden', current.phase !== 'RESULT');
    if (current.phase !== 'RESULT') return;
    const winner = playerName(current.result?.winnerId);
    box.innerHTML = `<strong>🏁 ${escText(winner)} đã hết bài!</strong><span>${escText(current.result?.reason || 'Ván UNO đã kết thúc.')}</span>`;
    if (isHost) { const next = document.createElement('button'); next.className = 'btn btn-gold'; next.textContent = '🎴 CHƠI VÁN TIẾP'; next.onclick = () => action('start_next_round'); box.appendChild(next); }
    else { const wait = document.createElement('span'); wait.textContent = 'Đang chờ chủ phòng bắt đầu ván tiếp theo hoặc đưa cả đội về sảnh.'; box.appendChild(wait); }
    const leave = document.createElement('button'); leave.className = 'btn btn-outline'; leave.textContent = 'VỀ PHÒNG CHỜ'; leave.onclick = () => socket.emit('return_to_lobby', { roomCode }); box.appendChild(leave);
  }

  function renderUnoState(state) {
    current = state; pendingWild = null; $('uno-room-label').textContent = `${state.roomCode} · ${state.players.length} người`;
    $('uno-turn-label').textContent = state.phase === 'RESULT' ? 'KẾT QUẢ VÁN' : `Lượt: ${playerName(state.currentPlayerId)}`;
    $('uno-direction').textContent = state.direction === 'clockwise' ? '↻ Theo chiều kim đồng hồ' : '↺ Ngược chiều kim đồng hồ';
    $('uno-pile-count').textContent = `Chồng rút: ${state.drawPileCount} · Bỏ: ${state.discardPileCount}`;
    $('uno-status').textContent = state.disconnected.length ? `📶 Đang chờ nối lại: ${state.disconnected.join(', ')}` : state.phase === 'RESULT' ? 'Ván đã kết thúc.' : state.currentPlayerId === myId ? 'Đến lượt bạn.' : `Đang chờ ${playerName(state.currentPlayerId)}.`;
    $('uno-status').className = `uno-status ${state.currentPlayerId === myId ? 'is-mine' : ''}`;
    renderPlayers();
    const discard = $('uno-discard'); discard.replaceChildren(); if (state.topCard) discard.appendChild(cardElement(state.topCard));
    $('uno-color-label').textContent = state.currentColor ? `Màu hiện hành: ${colorNames[state.currentColor]}` : 'Chờ chọn màu';
    $('uno-draw-pile').disabled = !hasAction('draw_card');
    $('uno-draw-pile').onclick = () => action('draw_card');
    const reaction = $('uno-reaction'); reaction.replaceChildren();
    if (state.reactionWindow) { const seconds = Math.max(0, Math.ceil((state.reactionWindow.deadlineAt - state.serverTime) / 1000)); reaction.textContent = `Cửa sổ +4 · ${playerName(state.reactionWindow.targetId)} xử lý · còn khoảng ${seconds}s`; }
    else if (state.unoWindow) reaction.textContent = `${playerName(state.unoWindow.playerId)} còn cửa sổ gọi/bắt UNO.`;
    else if (state.pendingDraw) reaction.textContent = `${playerName(state.pendingTargetId)} phải rút ${state.pendingDraw} lá; không cộng dồn.`;
    renderHand(); renderColorPicker(); renderActions(); renderResult();
  }

  $('uno-rules-btn').onclick = () => { $('uno-rules-panel').open = !$('uno-rules-panel').open; $('uno-rules-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); };
  $('uno-leave-btn').onclick = () => socket.emit('leave_room', { roomCode });
  socket.on('game:action_result', result => { if (!result?.ok && result?.error) { $('uno-status').textContent = `${result.error.message} (${result.error.code})`; $('uno-status').classList.add('has-error'); } });
  socket.on('game_state', state => { if (state?.gameId === 'uno' && state.phase !== 'WAITING') renderUnoState(state); });
  window.renderUnoWaiting = renderUnoWaiting;
  window.renderUnoState = renderUnoState;
})();
