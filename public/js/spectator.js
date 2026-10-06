(() => {
  'use strict';

  const code = (decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1) || '')).trim().toUpperCase();
  const labels = {
    'the-gang': 'The Gang', uno: 'UNO', 'tien-len': 'Tiến lên', 'sam-loc': 'Sâm lốc',
    phom: 'Phỏm', poker: 'Poker', bang: 'BANG!',
  };
  const phases = {
    WAITING: 'Phòng chờ', TURN: 'Đang đánh', SAM_DECLARATION: 'Cửa sổ báo Sâm', SAM_PLAY: 'Đang đánh',
    DISCARD: 'Lượt đánh', DRAW: 'Lượt rút', HAND: 'Đang chia bài', PLAYING: 'Đang chơi',
    RESULT: 'Kết quả', SHOWDOWN: 'Lật bài', GAME_OVER: 'Ván kết thúc', UNO_WINDOW: 'Cửa sổ UNO',
    WDF_CHALLENGE: 'Thử thách +4', CANCELLED: 'Đã dừng',
    PRE_FLOP: 'Pre-flop', PREFLOP: 'Pre-flop', FLOP: 'Flop', RIVER: 'River',
  };
  const colors = { white: 'Trắng', yellow: 'Vàng', orange: 'Cam', red: 'Đỏ', green: 'Xanh lá', blue: 'Xanh dương', black: 'Đen' };
  const symbols = { skip: 'Bỏ lượt', reverse: 'Đổi chiều', draw2: '+2', wild: 'Đổi màu', wild4: '+4' };
  const phaseLabel = state => state.gameId === 'the-gang' && state.phase === 'TURN' ? 'Turn' : phases[state.phase] || state.phase || '—';
  const roleLabels = { SHERIFF: 'Sheriff', DEPUTY: 'Deputy', OUTLAW: 'Outlaw', RENEGADE: 'Renegade' };
  const accessCard = document.querySelector('#access-card');
  const watchView = document.querySelector('#watch-view');
  const form = document.querySelector('#spectator-form');
  const password = document.querySelector('#room-password');
  const connectionMessage = document.querySelector('#connection-message');
  const liveMessage = document.querySelector('#live-message');
  const roomCodeLabel = document.querySelector('#room-code-label');
  const playerList = document.querySelector('#player-list');
  const boardDetails = document.querySelector('#board-details');
  const publicCards = document.querySelector('#public-cards');
  const socket = typeof window.io === 'function' ? window.io({ autoConnect: false, auth: {} }) : null;
  let requested = false;
  let roomPassword = '';

  roomCodeLabel.textContent = code || '—';
  if (!/^[A-Z0-9_-]{1,32}$/.test(code)) {
    connectionMessage.textContent = 'Mã phòng không hợp lệ.';
    form.querySelector('button').disabled = true;
  }

  function setMessage(node, message, error = false) {
    node.textContent = message;
    node.classList.toggle('is-error', error);
  }

  function requestJoin() {
    if (!socket || !requested || !socket.connected) return;
    socket.timeout(4000).emit('spectator:join', { roomCode: code, password: roomPassword }, (error, response) => {
      if (error) return setMessage(connectionMessage, 'Máy chủ chưa phản hồi. Hãy thử lại.', true);
      if (!response?.ok) {
        watchView.hidden = true;
        accessCard.hidden = false;
        return setMessage(connectionMessage, response?.message || 'Không thể mở chế độ xem.', true);
      }
      accessCard.hidden = true;
      watchView.hidden = false;
      password.value = '';
      setMessage(liveMessage, response.policy?.message || 'Bạn đang xem ở chế độ chỉ đọc.');
      render(response.state);
    });
  }

  function appendDetail(label, value) {
    if (value === null || value === undefined || value === '' || value === false) return;
    const term = document.createElement('dt'); term.textContent = label;
    const description = document.createElement('dd'); description.textContent = String(value);
    boardDetails.append(term, description);
  }

  function cardLabel(card) {
    if (!card || typeof card !== 'object') return '';
    if (card.label || card.name) return String(card.label || card.name);
    const join = values => values.filter(value => value !== null && value !== undefined && value !== '').join(' ');
    if (card.rank !== undefined || card.suit) return join([card.rank, card.suit]);
    const face = card.symbol ?? card.value ?? card.type;
    return join([symbols[face] || face, colors[card.color] || card.color]);
  }

  function addCardGroup(label, cards) {
    if (!Array.isArray(cards) || !cards.length) return;
    const group = document.createElement('div'); group.className = 'card-group';
    const caption = document.createElement('p'); caption.className = 'card-caption'; caption.textContent = label;
    const row = document.createElement('div'); row.className = 'card-row';
    for (const card of cards) {
      const face = cardLabel(card);
      if (!face) continue;
      const tile = document.createElement('span'); tile.className = 'card-tile'; tile.textContent = face;
      row.append(tile);
    }
    if (row.childElementCount) { group.append(caption, row); publicCards.append(group); }
  }

  function renderPlayers(state) {
    playerList.replaceChildren();
    const players = Array.isArray(state.players) ? state.players : [];
    document.querySelector('#seat-count').textContent = `${players.length} ghế`;
    for (const player of players) {
      const item = document.createElement('li'); item.className = 'player-row';
      const avatar = document.createElement('span'); avatar.className = 'player-avatar'; avatar.textContent = player.avatar || '🎲';
      const identity = document.createElement('div'); identity.className = 'player-identity';
      const name = document.createElement('strong'); name.textContent = player.name || 'Người chơi';
      const status = document.createElement('span');
      status.textContent = player.connected ? (player.ready ? 'Đã sẵn sàng' : 'Đang kết nối') : 'Mất kết nối';
      identity.append(name, status);
      const markers = document.createElement('div'); markers.className = 'player-markers';
      if (player.isHost) markers.append(makePill('Chủ bàn'));
      if (player.seatId === state.currentSeatId) markers.append(makePill('Lượt hiện tại'));
      if (Number.isInteger(player.handCount)) markers.append(makePill(`${player.handCount} lá`));
      if (player.role) markers.append(makePill(roleLabels[player.role] || player.role));
      if (player.dead) markers.append(makePill('Đã bị loại'));
      if (player.folded) markers.append(makePill('Đã fold'));
      if (Number.isInteger(player.stack)) markers.append(makePill(`${player.stack} chip`));
      item.append(avatar, identity, markers);
      playerList.append(item);
      if (Array.isArray(player.revealedCards) && player.revealedCards.length) addCardGroup(`${player.name} · bài đã công khai`, player.revealedCards);
      if (Array.isArray(player.equipment) && player.equipment.length) addCardGroup(`${player.name} · trang bị ngửa`, player.equipment);
    }
  }

  function makePill(label) {
    const pill = document.createElement('span'); pill.className = 'mini-pill'; pill.textContent = label; return pill;
  }

  function renderBoard(state) {
    const board = state.board || {};
    boardDetails.replaceChildren();
    publicCards.replaceChildren();
    appendDetail('Trạng thái', phaseLabel(state));
    if (state.paused) appendDetail('Kết nối', 'Bàn đang tạm dừng');
    if (board.street) appendDetail('Vòng Poker', board.street === 'TURN' ? 'Turn' : phases[board.street] || board.street);
    if (board.currentColor) appendDetail('Màu UNO', colors[board.currentColor] || board.currentColor);
    if (board.direction) appendDetail('Chiều đánh', board.direction === 'clockwise' || board.direction === 1 ? 'Thuận' : 'Ngược');
    if (Number.isInteger(board.pendingDraw) && board.pendingDraw > 0) appendDetail('Bài phạt đang chờ', `${board.pendingDraw} lá`);
    if (Number.isInteger(board.drawPileCount)) appendDetail('Bài rút còn', board.drawPileCount);
    if (Number.isInteger(board.stockCount)) appendDetail('Nọc còn', board.stockCount);
    if (Number.isInteger(board.discardCount)) appendDetail('Bài bỏ', board.discardCount);
    if (Number.isInteger(board.roundNumber)) appendDetail('Vòng', board.roundNumber);
    if (Number.isInteger(board.heistNumber)) appendDetail('Vụ trộm', board.heistNumber);
    if (Number.isInteger(board.score)) appendDetail('Điểm', board.score);
    if (Number.isInteger(board.pot)) appendDetail('Pot', `${board.pot} chip`);
    if (Number.isInteger(board.currentBet)) appendDetail('Mức cược hiện tại', `${board.currentBet} chip`);
    if (typeof board.gameOver === 'boolean' && board.gameOver) appendDetail('Ván', board.gameWon ? 'Đã thắng' : 'Đã kết thúc');
    if (board.currentRoundChipColor) appendDetail('Màu chip vòng này', colors[board.currentRoundChipColor] || board.currentRoundChipColor);
    if (board.topPlay) appendDetail('Tổ hợp trên bàn', board.topPlay.formation?.kind || 'Bài vừa đánh');
    if (board.discardTop) addCardGroup('Lá bỏ trên cùng', [board.discardTop]);
    if (board.topCard) addCardGroup('Lá ngửa trên cùng', [board.topCard]);
    addCardGroup('Bài chung', board.communityCards);
    if (board.topPlay?.cards?.length) addCardGroup('Bài vừa đánh', board.topPlay.cards);
    for (const meld of board.publicMelds || []) {
      for (const set of meld.melds || []) addCardGroup(`${meld.name || 'Người chơi'} · ${set.kind || 'Phỏm'}`, set.cards);
    }
    for (const reveal of board.revealedShowdown || []) addCardGroup(`Bài ngửa · ${reveal.seatId}`, reveal.cards);
  }

  function render(state) {
    if (!state || state.schemaVersion !== 1) return;
    const title = labels[state.gameId] || 'Bàn công khai';
    document.querySelector('#game-label').textContent = `${title.toLocaleUpperCase('vi')} · ${state.roomCode}`;
    document.querySelector('#table-title').textContent = `${title} · ${state.phase === 'WAITING' ? 'phòng chờ' : 'đang diễn ra'}`;
    document.querySelector('#phase-label').textContent = phaseLabel(state);
    document.querySelector('#policy-note').textContent = state.phase === 'WAITING'
      ? 'Bạn đang xem ở chế độ chỉ đọc. Muốn vào ghế, hãy rời chế độ xem rồi vào bàn bằng luồng thông thường; máy chủ vẫn kiểm tra mật khẩu và số ghế.'
      : 'Bạn đang xem ở chế độ chỉ đọc. Chỉ có thể vào ghế khi phòng chờ; bài kín và vai chưa công khai được ẩn.';
    renderBoard(state);
    renderPlayers(state);
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!socket) return setMessage(connectionMessage, 'Không tải được kết nối trực tiếp của máy chủ.', true);
    requested = true;
    roomPassword = password.value;
    setMessage(connectionMessage, 'Đang kết nối kênh khán giả…');
    if (socket.connected) requestJoin(); else socket.connect();
  });

  document.querySelector('#leave-button').addEventListener('click', () => {
    if (socket?.connected) socket.timeout(1500).emit('spectator:leave', {}, () => {});
    socket?.disconnect();
    requested = false;
    roomPassword = '';
    watchView.hidden = true;
    accessCard.hidden = false;
    setMessage(connectionMessage, 'Đã rời chế độ xem.');
  });

  if (socket) {
    socket.on('connect', requestJoin);
    socket.on('connect_error', () => setMessage(connectionMessage, 'Không kết nối được máy chủ. Hãy thử lại.', true));
    socket.on('spectator:state', render);
    socket.on('spectator:unavailable', () => {
      requested = false;
      roomPassword = '';
      watchView.hidden = true;
      accessCard.hidden = false;
      setMessage(connectionMessage, 'Phòng đã đóng hoặc không còn trạng thái công khai.', true);
    });
    socket.on('spectator:role_error', message => setMessage(liveMessage, message?.message || 'Hãy rời chế độ xem trước khi vào ghế.', true));
  }
})();
