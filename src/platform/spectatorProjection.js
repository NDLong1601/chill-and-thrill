'use strict';

const SUPPORTED_GAMES = new Set(['the-gang', 'uno', 'tien-len', 'sam-loc', 'phom', 'poker', 'bang']);
const BANG_ROLES = new Set(['SHERIFF', 'DEPUTY', 'OUTLAW', 'RENEGADE']);

function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function text(value, max = 80) { return typeof value === 'string' ? value.slice(0, max) : ''; }
function number(value) { return Number.isFinite(value) ? value : null; }
function integer(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function bool(value) { return value === true; }
function list(value, max = 64) { return Array.isArray(value) ? value.slice(0, max) : []; }

// Card values are only read from public board locations selected below. Never
// copy an engine card object wholesale: card IDs and future properties stay out.
function publicCard(value) {
  const card = record(value);
  if (!Object.keys(card).length) return null;
  const result = {};
  for (const key of ['label', 'name', 'type', 'color', 'suit', 'rank', 'value', 'symbol']) {
    const item = card[key];
    if (typeof item === 'string') result[key] = item.slice(0, 40);
    else if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
  }
  return Object.keys(result).length ? result : null;
}
function publicCards(values, max = 52) { return list(values, max).map(publicCard).filter(Boolean); }
function seatFor(id, seats) { return typeof id === 'string' ? (seats.get(id) || null) : null; }
function publicMelds(values, seats) {
  return list(values, 16).map(item => {
    const meld = record(item);
    return {
      seatId: seatFor(meld.playerId, seats),
      name: text(meld.name, 64),
      laid: true,
      score: number(meld.score),
      melds: list(meld.melds, 8).map(raw => {
        const part = record(raw);
        return { kind: text(part.kind, 24), cards: publicCards(part.cards, 13) };
      }).filter(part => part.cards.length),
    };
  }).filter(item => item.seatId && item.melds.length);
}

function roomIdentity(gm, code) {
  const manager = gm?.managerForCode?.(code);
  const room = manager?.rooms?.get(code);
  if (!manager || !room || room.code !== code) return null;
  const gameId = gm.gameIdForRoom?.(code) || room.gameId || (manager === gm.gang ? 'the-gang' : '');
  if (!SUPPORTED_GAMES.has(gameId)) return null;
  // Some state builders expire in-memory timers while constructing a view.
  // Build on a detached copy so a read-only spectator request cannot mutate play.
  const stateRoom = structuredClone(room);
  const source = manager.buildStateFor?.(stateRoom, null);
  if (!source || typeof source !== 'object') return null;
  return { manager, room, gameId, source: record(source) };
}

function projectSpectatorState(gm, roomCode) {
  const code = text(typeof roomCode === 'string' ? roomCode.trim().toUpperCase() : '', 32);
  if (!code) return null;
  let identity;
  try { identity = roomIdentity(gm, code); } catch { return null; }
  if (!identity) return null;
  const { room, gameId, source } = identity;
  const rawPlayers = list(source.players, 16).map(record);
  const seats = new Map();
  rawPlayers.forEach((player, index) => {
    if (typeof player.id === 'string') seats.set(player.id, `seat-${index + 1}`);
  });
  const phase = text(source.phase || room.phase, 32);
  const players = rawPlayers.map(player => {
    const view = {
      seatId: seatFor(player.id, seats),
      name: text(player.name || 'Người chơi', 64),
      avatar: text(player.avatar, 24),
      isHost: bool(player.isHost),
      ready: bool(player.ready),
      connected: bool(player.connected),
    };
    if (gameId === 'uno') view.handCount = integer(player.handCount ?? player.cardCount);
    else if (['tien-len', 'sam-loc', 'phom', 'poker', 'bang'].includes(gameId)) view.handCount = integer(player.handCount);

    if (gameId === 'poker') {
      for (const key of ['stack', 'inHand', 'folded', 'allIn', 'roundBet', 'totalContribution']) {
        const value = player[key];
        if (typeof value === 'boolean') view[key] = value;
        else if (Number.isSafeInteger(value) && value >= 0) view[key] = value;
      }
    }
    if (gameId === 'bang') {
      view.dead = bool(player.dead);
      view.hp = integer(player.hp);
      view.maxHp = integer(player.maxHp);
      const allowedReveal = player.role === 'SHERIFF' || player.dead || phase === 'RESULT';
      if (allowedReveal && BANG_ROLES.has(player.role)) view.role = player.role;
      const character = record(player.character);
      if (typeof character.id === 'string') view.character = {
        name: text(character.name, 48), ability: text(character.ability, 180),
      };
      view.equipment = publicCards(player.equipment, 8);
    }
    if (gameId === 'the-gang' && Array.isArray(player.best5) && player.best5.length) {
      // The engine only fills best5 for seats whose cards have been revealed.
      view.revealedCards = publicCards(player.best5, 5);
      view.handName = text(player.handNameVi || player.handName, 48);
    }
    return view;
  }).filter(player => player.seatId);

  const board = {};
  const currentSeatId = seatFor(source.currentPlayerId, seats);
  const revision = integer(source.revision);
  const paused = bool(source.paused);

  if (gameId === 'the-gang') {
    for (const key of ['mode', 'currentRoundChipColor']) if (typeof source[key] === 'string') board[key] = text(source[key], 32);
    for (const key of ['roundNumber', 'heistNumber', 'score', 'maxVaults', 'maxAlarms']) {
      if (Number.isSafeInteger(source[key])) board[key] = source[key];
    }
    board.gameOver = bool(source.gameOver);
    board.gameWon = bool(source.gameWon);
    board.communityCards = publicCards(source.communityCards, 12);
  } else if (gameId === 'uno') {
    for (const key of ['direction', 'currentColor']) if (typeof source[key] === 'string') board[key] = text(source[key], 24);
    for (const key of ['pendingDraw', 'drawPileCount', 'discardPileCount']) {
      const value = integer(source[key]);
      if (value !== null) board[key] = value;
    }
    board.topCard = publicCard(source.topCard || source.discardTop);
    board.pendingTargetSeatId = seatFor(source.pendingTargetId, seats);
    const reaction = record(source.reactionWindow);
    if (typeof reaction.type === 'string') board.reaction = {
      type: text(reaction.type, 24), targetSeatId: seatFor(reaction.targetId, seats),
    };
    const unoWindow = record(source.unoWindow);
    if (typeof unoWindow.playerId === 'string') board.unoCallWindowSeatId = seatFor(unoWindow.playerId, seats);
  } else if (gameId === 'tien-len' || gameId === 'sam-loc') {
    const top = record(source.topPlay);
    if (Object.keys(top).length) board.topPlay = {
      seatId: seatFor(top.playerId, seats),
      formation: {
        kind: text(record(top.formation).kind, 24),
        length: integer(record(top.formation).length),
      },
      cards: publicCards(top.cards, 13),
    };
    board.leaderSeatId = seatFor(source.leaderId, seats);
    board.passedSeatIds = list(source.passedIds, 8).map(id => seatFor(id, seats)).filter(Boolean);
    if (gameId === 'sam-loc') {
      const declarer = record(source.samDeclarer);
      if (typeof declarer.id === 'string') board.samDeclarerSeatId = seatFor(declarer.id, seats);
      const oneCall = record(source.oneCall);
      if (typeof oneCall.playerId === 'string') board.oneCallSeatId = seatFor(oneCall.playerId, seats);
    }
  } else if (gameId === 'phom') {
    board.stockCount = integer(source.stockCount);
    board.chotEligible = bool(source.chotEligible);
    board.drawTurns = integer(source.drawTurns);
    board.maxDrawTurns = integer(source.maxDrawTurns);
    board.discardTop = publicCard(source.discardTop);
    board.discardBySeatId = seatFor(source.discardById, seats);
    board.publicMelds = publicMelds(source.publicMelds, seats);
  } else if (gameId === 'poker') {
    for (const key of ['street']) if (typeof source[key] === 'string') board[key] = text(source[key], 16);
    for (const key of ['currentBet', 'pot']) {
      const value = integer(source[key]);
      if (value !== null) board[key] = value;
    }
    board.communityCards = publicCards(source.community, 5);
    board.buttonSeatId = seatFor(source.buttonPlayerId, seats);
    board.smallBlindSeatId = seatFor(source.smallBlindPlayerId, seats);
    board.bigBlindSeatId = seatFor(source.bigBlindPlayerId, seats);
    board.sidePots = list(source.sidePots, 8).map(item => {
      const pot = record(item);
      return { amount: integer(pot.amount), eligibleSeatIds: list(pot.eligiblePlayerIds, 8).map(id => seatFor(id, seats)).filter(Boolean) };
    }).filter(pot => pot.amount !== null);
    if (phase === 'RESULT') {
      const result = record(source.result);
      board.revealedShowdown = list(result.showdown, 8).map(item => {
        const reveal = record(item);
        const seatId = seatFor(reveal.playerId, seats);
        const cards = publicCards(reveal.cards, 2);
        return seatId && cards.length ? { seatId, cards, hand: text(reveal.hand, 48) } : null;
      }).filter(Boolean);
    }
  } else if (gameId === 'bang') {
    board.deckCount = integer(source.deckCount);
    board.discardCount = integer(source.discardCount);
    board.discardTop = publicCard(source.discardTop);
  }

  return {
    schemaVersion: 1,
    gameId,
    variant: text(room.variant || room.config?.variant || source.variant || (gameId === 'uno'
      ? (identity.manager === gm.uno ? 'classic-108-v1' : 'classic-local-v1')
      : 'standard'), 40),
    roomCode: code,
    phase,
    revision,
    paused,
    currentSeatId,
    players,
    board,
  };
}

module.exports = { SUPPORTED_GAMES, projectSpectatorState };
