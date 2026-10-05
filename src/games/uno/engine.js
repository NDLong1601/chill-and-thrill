'use strict';

const crypto = require('node:crypto');

const COLORS = ['red', 'blue', 'green', 'yellow'];
const CARD_TYPES = ['number', 'skip', 'reverse', 'draw2', 'wild', 'wild4'];
const REACTION_WINDOW_MS = 15000;
const UNO_WINDOW_MS = 5000;

const clone = value => JSON.parse(JSON.stringify(value));
const isColor = value => COLORS.includes(value);
const isWild = card => card?.type === 'wild' || card?.type === 'wild4';
const nextIndex = (match, playerId, steps = 1) => {
  const index = match.players.indexOf(playerId);
  if (index < 0) return -1;
  const delta = match.direction * steps;
  return (index + delta + match.players.length * 10) % match.players.length;
};
const nextPlayer = (match, playerId, steps = 1) => {
  const index = nextIndex(match, playerId, steps);
  return index < 0 ? null : match.players[index];
};

function shuffle(cards, rng = Math.random) {
  const output = cards.slice();
  for (let i = output.length - 1; i > 0; i -= 1) {
    const index = Math.floor(rng() * (i + 1));
    [output[i], output[index]] = [output[index], output[i]];
  }
  return output;
}

function makeCard(id, color, type, value = null) {
  return { id, color, type, value };
}

function createDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push(makeCard(`${color}-0`, color, 'number', 0));
    for (let value = 1; value <= 9; value += 1) {
      deck.push(makeCard(`${color}-${value}-a`, color, 'number', value));
      deck.push(makeCard(`${color}-${value}-b`, color, 'number', value));
    }
    for (const type of ['draw2', 'reverse', 'skip']) {
      for (let copy = 0; copy < 2; copy += 1) deck.push(makeCard(`${color}-${type}-${copy}`, color, type));
    }
  }
  for (let copy = 0; copy < 8; copy += 1) deck.push(makeCard(`wild-${copy}`, null, 'wild'));
  for (let copy = 0; copy < 4; copy += 1) deck.push(makeCard(`wild4-${copy}`, null, 'wild4'));
  return deck;
}

function emptyHands(playerIds) {
  return Object.fromEntries(playerIds.map(id => [id, []]));
}

function drawCards(match, playerId, count, rng = Math.random) {
  const hand = match.hands[playerId];
  if (!hand) return [];
  const drawn = [];
  for (let i = 0; i < count; i += 1) {
    if (!match.drawPile.length) recycleDiscard(match, rng);
    const card = match.drawPile.pop();
    if (!card) break;
    hand.push(card); drawn.push(card);
  }
  return drawn;
}

function recycleDiscard(match, rng = Math.random) {
  if (match.discardPile.length <= 1) return;
  const top = match.discardPile.at(-1);
  match.drawPile = shuffle(match.discardPile.slice(0, -1), rng);
  match.discardPile = [top];
}

function cardMatches(card, match) {
  const top = match.discardPile.at(-1);
  if (!card || !top) return false;
  if (isWild(card)) return true;
  if (card.color === match.currentColor) return true;
  if (card.type === 'number' && top.type === 'number' && card.value === top.value) return true;
  return card.type !== 'number' && card.type === top.type;
}

function hasMatchingColor(hand, color) {
  return hand.some(card => !isWild(card) && card.color === color);
}

function setRevision(match) {
  match.revision = Number.isInteger(match.revision) ? match.revision + 1 : 1;
  match.updatedAt = Date.now();
}

function closeUnoWindow(match) {
  match.unoWindow = null;
}

function advanceAfter(match, playerId) {
  match.currentPlayerId = nextPlayer(match, playerId);
  match.drawChoice = null;
}

function applyCardEffect(match, card, sourceId) {
  if (card.type === 'reverse') {
    match.direction *= -1;
    // Local two-player clarification: Reverse behaves like Skip, as in the
    // two-handed UNO convention. This is documented in docs/rules/uno.md.
    match.currentPlayerId = match.players.length === 2 ? sourceId : nextPlayer(match, sourceId);
  } else if (card.type === 'skip') {
    match.currentPlayerId = nextPlayer(match, sourceId, 2);
  } else if (card.type === 'draw2') {
    match.pendingDraw = 2;
    match.pendingTargetId = nextPlayer(match, sourceId);
    match.currentPlayerId = match.pendingTargetId;
  } else {
    match.currentPlayerId = nextPlayer(match, sourceId);
  }
}

function finishResult(match, winnerId, reason = 'Một người chơi đã hết bài.', now = Date.now()) {
  match.phase = 'RESULT';
  match.result = {
    resultId: crypto.randomUUID(), matchId: match.matchId, winnerId, reason,
    finalCard: match.lastPlayedCard ? clone(match.lastPlayedCard) : null,
    cardCounts: Object.fromEntries(match.players.map(id => [id, match.hands[id].length])),
    endedAt: now,
  };
  match.reactionWindow = null;
  match.unoWindow = null;
  match.pendingDraw = 0;
  match.pendingTargetId = null;
  match.drawChoice = null;
}

function resolveDrawFour(match, accepted = false, now = Date.now(), rng = Math.random) {
  const reaction = match.reactionWindow;
  if (!reaction) return { ok: false, error: { code: 'INVALID_ACTION', message: 'Không có cửa sổ phản đối +4.' } };
  const targetId = reaction.targetId;
  const winnerId = reaction.winnerId;
  const offenderId = reaction.sourceId;
  const guilty = hasMatchingColor(match.hands[offenderId], reaction.matchingColor);
  if (accepted) {
    drawCards(match, targetId, 4, rng);
    match.reactionWindow = null;
    if (winnerId) finishResult(match, winnerId, 'Lá cuối +4 đã được xử lý; người kế tiếp rút 4 lá.', now);
    else advanceAfter(match, targetId);
    return { ok: true, guilty: false, drawnBy: targetId, drawn: 4 };
  }
  if (guilty) {
    drawCards(match, offenderId, 4, rng);
    match.reactionWindow = null;
    if (winnerId) finishResult(match, winnerId, 'Phản đối +4 thành công; người đánh sai rút 4 lá.', now);
    else match.currentPlayerId = targetId;
    return { ok: true, guilty: true, drawnBy: offenderId, drawn: 4 };
  }
  drawCards(match, targetId, 6, rng);
  match.reactionWindow = null;
  if (winnerId) finishResult(match, winnerId, 'Phản đối +4 không thành công; người phản đối rút 6 lá.', now);
  else advanceAfter(match, targetId);
  return { ok: true, guilty: false, drawnBy: targetId, drawn: 6 };
}

function setupOpening(match, top, rng) {
  match.currentColor = top.color;
  match.currentPlayerId = match.players[0];
  if (top.type === 'reverse') {
    match.direction = -1;
    if (match.players.length === 2) match.currentPlayerId = match.players[0];
  } else if (top.type === 'skip') {
    match.currentPlayerId = nextPlayer(match, match.players[0], 2);
  } else if (top.type === 'draw2') {
    const target = nextPlayer(match, match.players[0]);
    drawCards(match, target, 2, rng);
    match.currentPlayerId = nextPlayer(match, target);
  } else if (top.type === 'wild') {
    match.currentColor = null;
    match.openingColorPending = true;
  }
}

function createMatch({ playerIds, matchId = crypto.randomUUID(), roundNumber = 1, now = Date.now(), rng = Math.random }) {
  if (!Array.isArray(playerIds) || playerIds.length < 2 || playerIds.length > 4) throw new Error('UNO hỗ trợ từ 2 đến 4 người trong bản local v1.');
  const deck = shuffle(createDeck(), rng);
  const hands = emptyHands(playerIds);
  for (let cardIndex = 0; cardIndex < 7; cardIndex += 1) {
    for (const playerId of playerIds) hands[playerId].push(deck.pop());
  }
  let top = deck.pop();
  while (top?.type === 'wild4') {
    deck.unshift(top);
    top = deck.pop();
  }
  const match = {
    version: 1, matchId, roundNumber, phase: 'PLAYING', revision: 0, startedAt: now, updatedAt: now,
    players: playerIds.slice(), hands, drawPile: deck, discardPile: [top], direction: 1,
    currentColor: null, currentPlayerId: playerIds[0], pendingDraw: 0, pendingTargetId: null,
    drawChoice: null, openingColorPending: false, reactionWindow: null, unoWindow: null,
    lastPlayedCard: null, result: null, actionReceipts: [], log: [],
  };
  setupOpening(match, top, rng);
  return match;
}

function resetForNextRound(previous, { matchId = crypto.randomUUID(), now = Date.now(), rng = Math.random } = {}) {
  return createMatch({ playerIds: previous.players, matchId, roundNumber: (previous.roundNumber || 1) + 1, now, rng });
}

function expireWindows(match, now = Date.now(), rng = Math.random) {
  let changed = false;
  if (match.reactionWindow && match.reactionWindow.deadlineAt <= now) {
    resolveDrawFour(match, true, now, rng);
    changed = true;
  }
  if (match.unoWindow && match.unoWindow.deadlineAt <= now) {
    closeUnoWindow(match);
    changed = true;
  }
  return changed;
}

function actionError(code, message) { return { ok: false, error: { code, message } }; }

function applyAction(match, { playerId, type, payload = {}, now = Date.now(), rng = Math.random, isHost = false }) {
  expireWindows(match, now, rng);
  if (!match.players.includes(playerId)) return actionError('ROOM_ACCESS', 'Ghế UNO không hợp lệ.');
  if (match.phase === 'RESULT' && type !== 'start_next_round') return actionError('GAME_OVER', 'Ván UNO đã kết thúc.');
  if (type === 'start_next_round') {
    if (match.phase !== 'RESULT') return actionError('INVALID_ACTION', 'Chưa thể bắt đầu ván UNO mới.');
    if (!isHost) return actionError('HOST_REQUIRED', 'Chỉ chủ phòng được bắt đầu ván tiếp theo.');
    return { ok: true, nextRound: true };
  }
  if (match.phase !== 'PLAYING') return actionError('INVALID_ACTION', 'Ván UNO chưa ở trạng thái chơi.');

  if (type === 'catch_uno') {
    if (!match.unoWindow || match.unoWindow.deadlineAt <= now) return actionError('REACTION_CLOSED', 'Cửa sổ bắt lỗi UNO đã đóng.');
    if (match.unoWindow.playerId === playerId) return actionError('INVALID_ACTION', 'Bạn không thể tự bắt lỗi UNO của mình.');
    const targetId = match.unoWindow.playerId;
    drawCards(match, targetId, 2, rng);
    closeUnoWindow(match);
    setRevision(match);
    match.log.unshift({ type: 'uno_catch', playerId, targetId, at: now });
    return { ok: true, event: 'UNO_CAUGHT', targetId, drawn: 2 };
  }

  if (type === 'call_uno') {
    if (!match.unoWindow || match.unoWindow.playerId !== playerId || match.unoWindow.deadlineAt <= now) return actionError('INVALID_ACTION', 'Bạn không có cửa sổ gọi UNO đang mở.');
    closeUnoWindow(match);
    setRevision(match);
    return { ok: true, event: 'UNO_CALLED' };
  }

  if (match.unoWindow && match.unoWindow.playerId !== playerId) closeUnoWindow(match);

  if (match.openingColorPending) {
    if (type !== 'choose_color' || playerId !== match.currentPlayerId || !isColor(payload.color)) return actionError('INVALID_ACTION', 'Người bắt đầu phải chọn màu cho lá Wild mở đầu.');
    match.currentColor = payload.color;
    match.openingColorPending = false;
    setRevision(match);
    return { ok: true, event: 'COLOR_CHOSEN' };
  }

  if (match.reactionWindow) {
    if (playerId !== match.reactionWindow.targetId) return actionError('NOT_YOUR_TURN', 'Chờ người bị +4 phản ứng.');
    if (type === 'challenge_draw_four') {
      const result = resolveDrawFour(match, false, now, rng); setRevision(match); return result;
    }
    if (type === 'draw_penalty') {
      const result = resolveDrawFour(match, true, now, rng); setRevision(match); return result;
    }
    return actionError('INVALID_ACTION', 'Chỉ được rút 4 hoặc phản đối lá +4.');
  }

  if (match.pendingDraw) {
    if (playerId !== match.pendingTargetId) return actionError('NOT_YOUR_TURN', 'Chờ người chơi kế tiếp xử lý lá phạt.');
    if (type !== 'draw_penalty') return actionError('INVALID_ACTION', 'Bản UNO local v1 không cộng dồn lá phạt; hãy rút bài.');
    const amount = match.pendingDraw;
    drawCards(match, playerId, amount, rng);
    match.pendingDraw = 0; match.pendingTargetId = null;
    advanceAfter(match, playerId);
    setRevision(match);
    return { ok: true, event: 'PENALTY_DRAWN', drawn: amount };
  }

  if (playerId !== match.currentPlayerId) return actionError('NOT_YOUR_TURN', 'Chưa tới lượt bạn.');
  const hand = match.hands[playerId];
  if (type === 'draw_card') {
    if (match.drawChoice) return actionError('INVALID_ACTION', 'Bạn đã rút một lá; hãy đánh lá đó hoặc bỏ lượt.');
    const card = drawCards(match, playerId, 1, rng)[0];
    if (!card) return actionError('DECK_EMPTY', 'Không còn bài để rút.');
    if (cardMatches(card, match)) match.drawChoice = card.id;
    else advanceAfter(match, playerId);
    setRevision(match);
    return { ok: true, event: 'CARD_DRAWN', cardPlayable: !!match.drawChoice };
  }

  if (type === 'pass_draw') {
    if (!match.drawChoice) return actionError('INVALID_ACTION', 'Bạn chưa rút lá nào có thể bỏ lượt.');
    match.drawChoice = null; advanceAfter(match, playerId); setRevision(match);
    return { ok: true, event: 'DRAW_PASSED' };
  }

  if (type !== 'play_card' && type !== 'play_drawn') return actionError('INVALID_ACTION', 'Thao tác UNO không được hỗ trợ.');
  const cardId = String(payload.cardId || '');
  if (type === 'play_drawn' && match.drawChoice !== cardId) return actionError('INVALID_ACTION', 'Chỉ được đánh lá vừa rút.');
  const index = hand.findIndex(card => card.id === cardId);
  if (index < 0) return actionError('INVALID_ACTION', 'Lá bài không thuộc tay bạn.');
  const card = hand[index];
  if (!cardMatches(card, match)) return actionError('INVALID_ACTION', 'Lá bài không khớp màu, số hoặc biểu tượng.');
  if (card.type === 'wild4' && hasMatchingColor(hand, match.currentColor)) return actionError('INVALID_WILD_DRAW_FOUR', 'Bạn còn lá cùng màu nên chưa được đánh +4.');
  if (isWild(card) && !isColor(payload.chosenColor)) return actionError('COLOR_REQUIRED', 'Hãy chọn màu sau lá Wild.');
  const previousColor = match.currentColor;
  if (hand.length === 2 && !payload.callUno && card.type !== 'wild4' && card.type !== 'draw2') {
    // Not an error: the player may be caught until the next player's action.
  }
  if (payload.callUno && hand.length !== 2) return actionError('INVALID_ACTION', 'Chỉ gọi UNO khi lá vừa đánh khiến bạn còn đúng 1 lá.');

  hand.splice(index, 1); match.discardPile.push(card); match.lastPlayedCard = clone(card); match.drawChoice = null;
  match.currentColor = isWild(card) ? payload.chosenColor : card.color;
  if (hand.length === 0) {
    const targetId = nextPlayer(match, playerId);
    if (card.type === 'wild4') {
      match.reactionWindow = { type: 'draw_four', sourceId: playerId, targetId, winnerId: playerId, matchingColor: previousColor, deadlineAt: now + REACTION_WINDOW_MS };
      match.currentPlayerId = targetId;
    } else {
      if (card.type === 'draw2') drawCards(match, targetId, 2, rng);
      finishResult(match, playerId, card.type === 'draw2' ? 'Lá cuối +2 đã được xử lý.' : 'Người chơi đã hết bài.', now);
    }
  } else {
    if (hand.length === 1) {
      if (payload.callUno) closeUnoWindow(match);
      else match.unoWindow = { playerId, deadlineAt: now + UNO_WINDOW_MS };
    }
    if (card.type === 'wild4') {
      match.reactionWindow = { type: 'draw_four', sourceId: playerId, targetId: nextPlayer(match, playerId), winnerId: null,
        matchingColor: previousColor, deadlineAt: now + REACTION_WINDOW_MS };
      match.currentPlayerId = match.reactionWindow.targetId;
    } else applyCardEffect(match, card, playerId);
  }
  setRevision(match);
  return { ok: true, event: 'CARD_PLAYED', cardId: card.id, cardType: card.type };
}

function availableActions(match, playerId, now = Date.now()) {
  expireWindows(match, now);
  if (!match.players.includes(playerId) || match.phase !== 'PLAYING') return [];
  const actions = [];
  if (match.unoWindow && match.unoWindow.playerId === playerId) actions.push({ type: 'call_uno' });
  if (match.unoWindow && match.unoWindow.playerId !== playerId) actions.push({ type: 'catch_uno', targetId: match.unoWindow.playerId });
  if (match.openingColorPending && match.currentPlayerId === playerId) return [...actions, { type: 'choose_color' }];
  if (match.reactionWindow) {
    if (match.reactionWindow.targetId === playerId) return [...actions, { type: 'challenge_draw_four' }, { type: 'draw_penalty' }];
    return actions;
  }
  if (match.pendingDraw) return match.pendingTargetId === playerId ? [...actions, { type: 'draw_penalty' }] : actions;
  if (match.currentPlayerId !== playerId) return actions;
  if (match.drawChoice) {
    return [...actions, { type: 'play_drawn', cardId: match.drawChoice }, { type: 'pass_draw' }];
  }
  for (const card of match.hands[playerId]) if (cardMatches(card, match)) actions.push({ type: 'play_card', cardId: card.id });
  actions.push({ type: 'draw_card' });
  return actions;
}

function visibleState(match, playerId, players, room, now = Date.now()) {
  expireWindows(match, now);
  const hand = match.hands[playerId] || [];
  const result = match.result ? clone(match.result) : null;
  return {
    roomCode: room.code, myId: playerId, seatId: playerId, gameId: 'uno', category: 'casual', rulesVersion: 1,
    variant: 'classic-local-v1', phase: match.phase, matchId: match.matchId, revision: match.revision, serverTime: now,
    roomName: room.config?.roomName || 'UNO · Phòng LAN', maxPlayers: room.config?.maxPlayers || 4,
    visibility: room.config?.visibility || 'public', requiresPassword: !!room.config?.passwordHash,
    direction: match.direction === 1 ? 'clockwise' : 'counterclockwise', currentColor: match.currentColor,
    currentPlayerId: match.currentPlayerId, pendingDraw: match.pendingDraw, pendingTargetId: match.pendingTargetId,
    drawPileCount: match.drawPile.length, discardPileCount: match.discardPile.length, topCard: clone(match.discardPile.at(-1)),
    reactionWindow: match.reactionWindow ? { type: match.reactionWindow.type, targetId: match.reactionWindow.targetId, deadlineAt: match.reactionWindow.deadlineAt } : null,
    unoWindow: match.unoWindow ? clone(match.unoWindow) : null, drawChoice: match.drawChoice && hand.find(card => card.id === match.drawChoice) ? clone(hand.find(card => card.id === match.drawChoice)) : null,
    availableActions: availableActions(match, playerId, now), myHand: clone(hand), result,
    disconnected: players.filter(player => !player.connected).map(player => player.name),
    strictChat: false, quickChat: [], chatLog: room.chatLog || [], log: clone(match.log || []).slice(0, 40),
    players: players.map(player => ({ id: player.id, name: player.name, avatar: player.avatar, isHost: player.isHost,
      connected: player.connected, ready: player.ready, cardCount: match.hands[player.id]?.length || 0,
      isCurrent: player.id === match.currentPlayerId, unoCalled: !match.unoWindow || match.unoWindow.playerId !== player.id })),
  };
}

module.exports = {
  COLORS, CARD_TYPES, REACTION_WINDOW_MS, UNO_WINDOW_MS, createDeck, shuffle, createMatch,
  resetForNextRound, applyAction, availableActions, visibleState, expireWindows, drawCards,
};
