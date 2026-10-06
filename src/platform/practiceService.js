'use strict';

const crypto = require('node:crypto');
const UnoEngine = require('../games/uno/engine');
const { TienLenManager } = require('../games/tien-len/tienLenEngine');
const TienLenDeck = require('../games/tien-len/tienLenDeck');
const { chooseUnoAction, chooseTienLenAction } = require('./practiceBotPolicy');

const UNO_VARIANT = 'classic-local-v1';
const UNO108_VARIANT = 'classic-108-v1';
const TIEN_LEN_VARIANT = 'south-v1';
const CAPABILITY_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
const ACTION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const BOT_FORBIDDEN_KEYS = new Set(['room', 'match', 'hands', 'drawPile', 'discardPile', 'profileId', 'profileToken', 'wallet', 'ledger', 'reservations']);
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const immediate = () => new Promise(resolve => setImmediate(resolve));

class PracticeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

function seededRandom(seed) {
  const bytes = crypto.createHash('sha256').update(String(seed)).digest();
  let state = bytes.readUInt32LE(0) || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function shuffled(cards, rng) {
  const result = cards.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function cleanPracticeName(value, fallback) {
  const raw = typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40) : '';
  return raw || fallback;
}

function capabilityHash(token) {
  return crypto.createHash('sha256').update(token).digest();
}

function sameCapability(token, expectedHash) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
  return crypto.timingSafeEqual(capabilityHash(token), expectedHash);
}

function validateActionId(actionId) {
  return typeof actionId === 'string' && ACTION_ID_PATTERN.test(actionId);
}

function publicUnoPlayers(players, match, now) {
  return players.map(player => ({
    id: player.id,
    name: player.name,
    isHost: !!player.isHost,
    cardCount: match.hands[player.id]?.length || 0,
    isCurrent: player.id === match.currentPlayerId,
    unoCalled: !match.unoWindow || match.unoWindow.playerId !== player.id,
  }));
}

function createUnoBotProjection(match, players, botId, now = Date.now()) {
  const visible = UnoEngine.visibleState(match, botId, players, {}, now);
  const projection = {
    schemaVersion: 1,
    gameId: 'uno',
    variant: UNO_VARIANT,
    matchId: match.matchId,
    revision: match.revision,
    seatId: botId,
    ownHand: clone(visible.myHand),
    legalActions: clone(visible.availableActions),
    publicState: {
      phase: visible.phase,
      currentColor: visible.currentColor,
      currentPlayerId: visible.currentPlayerId,
      direction: visible.direction,
      pendingDraw: visible.pendingDraw,
      pendingTargetId: visible.pendingTargetId,
      openingColorPending: match.openingColorPending,
      drawChoiceId: visible.drawChoice?.id || null,
      reactionWindow: visible.reactionWindow ? { type: visible.reactionWindow.type, targetId: visible.reactionWindow.targetId } : null,
      unoWindow: visible.unoWindow ? { playerId: visible.unoWindow.playerId } : null,
      topCard: clone(visible.topCard),
      drawPileCount: visible.drawPileCount,
      players: publicUnoPlayers(players, match, now),
    },
  };
  assertSafeBotProjection(projection);
  return projection;
}

function publicTienLenPlayers(room) {
  return room.players.map(player => ({ id: player.id, name: player.name, handCount: player.hand.length, isCurrent: player.id === room.currentPlayerId, isHost: !!player.isHost }));
}

function createTienLenBotProjection(room, botId) {
  const bot = room.players.find(player => player.id === botId);
  if (!bot) throw new PracticeError('ROOM_ACCESS', 'Bot không có ghế trong ván luyện tập.', 403);
  const ownHand = clone(bot.hand);
  const projection = {
    schemaVersion: 1,
    gameId: 'tien-len',
    variant: TIEN_LEN_VARIANT,
    matchId: room.matchId,
    revision: room.revision,
    seatId: botId,
    ownHand,
    publicState: {
      phase: room.phase,
      currentPlayerId: room.currentPlayerId,
      leaderId: room.leaderId,
      playedAny: !!room.playedAny,
      initialRequiredCardId: !room.playedAny && ownHand.some(card => card.id === room.initialRequiredCardId) ? room.initialRequiredCardId : null,
      topPlay: room.topPlay ? {
        playerId: room.topPlay.playerId,
        formation: clone(room.topPlay.formation),
        cards: clone(room.topPlay.cards),
      } : null,
      passedIds: room.passedIds.slice(),
      players: publicTienLenPlayers(room),
    },
  };
  assertSafeBotProjection(projection);
  return projection;
}

function assertSafeBotProjection(projection) {
  for (const key of BOT_FORBIDDEN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(projection, key)) throw new TypeError(`Bot projection contains forbidden field: ${key}`);
  }
  const allowedRoot = new Set(['schemaVersion', 'gameId', 'variant', 'matchId', 'revision', 'seatId', 'ownHand', 'legalActions', 'publicState']);
  if (Object.keys(projection).some(key => !allowedRoot.has(key))) throw new TypeError('Bot projection has an unexpected root field.');
}

function sandboxReservationStore() {
  // The manager expects the production store contract. This session-local
  // fixture has no persistence, real profile IDs, wallet, or ledger.
  return {
    preflightFixedGameStart({ profileIds = [] } = {}) {
      if (profileIds.some(id => typeof id !== 'string' || !id.startsWith('practice-profile:'))) {
        throw new PracticeError('SANDBOX_PROFILE_REQUIRED', 'Phiên luyện tập chỉ dùng ghế sandbox.', 500);
      }
      return { ok: true, fixture: 'practice-memory' };
    },
    reserveMany({ reservations = [] } = {}) {
      return { held: reservations.map(item => ({ ...item, currency: 'practice-point', reservationId: `practice-hold:${crypto.randomUUID()}` })) };
    },
    settleWinnerTakesPot() { return { pot: 0, fixture: 'practice-memory' }; },
    releaseReservations() { return { released: true, fixture: 'practice-memory' }; },
    reservationCurrency() { return 'practice-point'; },
    walletForUpdate() { return null; },
    publicProfile() { return null; },
    markMemberLeft() { return true; },
    closeGameRoom() { return true; },
  };
}

function fakePracticeSocket(id) {
  return {
    id,
    events: [],
    emit(event, payload) { this.events.push({ event, payload }); },
    join() {},
    leave() {},
  };
}

function errorResult(code, message, state) {
  return { ok: false, error: { code, message }, ...(state ? { state } : {}) };
}

class PracticeService {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? 60 * 60 * 1000;
    this.maxSessions = options.maxSessions ?? 64;
    this.maxBotSteps = options.maxBotSteps ?? 64;
    this.botYieldEvery = options.botYieldEvery ?? 4;
    this.sessions = new Map();
    if (!Number.isSafeInteger(this.sessionTtlMs) || this.sessionTtlMs < 1000 || this.sessionTtlMs > 24 * 60 * 60 * 1000) throw new TypeError('sessionTtlMs must be between 1 second and 24 hours.');
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > 1000) throw new TypeError('maxSessions must be between 1 and 1000.');
    if (!Number.isSafeInteger(this.maxBotSteps) || this.maxBotSteps < 1 || this.maxBotSteps > 1000) throw new TypeError('maxBotSteps must be between 1 and 1000.');
    if (!Number.isSafeInteger(this.botYieldEvery) || this.botYieldEvery < 1 || this.botYieldEvery > 64) throw new TypeError('botYieldEvery must be between 1 and 64.');
  }

  async createSession(input = {}) {
    this.cleanup();
    try {
      const gameId = input.gameId;
      const variant = input.variant;
      if (gameId === 'uno' && variant === UNO108_VARIANT) {
        throw new PracticeError('UNSUPPORTED_VARIANT', 'UNO 108 (classic-108-v1) chưa có chế độ luyện tập. Hãy chọn UNO 112 (classic-local-v1).', 422);
      }
      if (!((gameId === 'uno' && variant === UNO_VARIANT) || (gameId === 'tien-len' && variant === TIEN_LEN_VARIANT))) {
        throw new PracticeError('UNSUPPORTED_VARIANT', 'Hãy chọn rõ game và biến thể được hỗ trợ để tạo phiên luyện tập.', 422);
      }
      if (this.sessions.size >= this.maxSessions) throw new PracticeError('CAPACITY_LIMIT', 'Máy đang có quá nhiều phiên luyện tập. Hãy đóng một phiên rồi thử lại.', 429);

      const id = crypto.randomUUID();
      const capability = crypto.randomBytes(CAPABILITY_BYTES).toString('base64url');
      const seed = input.seed === undefined ? crypto.randomBytes(16).toString('hex') : String(input.seed).slice(0, 128);
      const rng = seededRandom(seed);
      const humanId = `practice-seat:${crypto.randomUUID()}`;
      const botId = `practice-seat:${crypto.randomUUID()}`;
      const session = {
        id,
        capabilityHash: capabilityHash(capability),
        createdAt: this.now(),
        expiresAt: this.now() + this.sessionTtlMs,
        gameId,
        variant,
        humanId,
        botId,
        humanName: cleanPracticeName(input.playerName, 'Bạn'),
        botName: 'Bot luyện tập',
        score: { humanWins: 0, botWins: 0, scoredMatchIds: new Set() },
        botStatus: 'ready',
        queue: Promise.resolve(),
        disposed: false,
        runtime: null,
      };
      session.runtime = gameId === 'uno' ? this.createUnoRuntime(session, rng) : this.createTienLenRuntime(session, rng);
      this.sessions.set(id, session);
      await this.runBots(session);
      this.updateScore(session);
      return { ok: true, session: { id, capability, expiresAt: session.expiresAt }, state: this.stateFor(session) };
    } catch (error) {
      if (error instanceof PracticeError) return { ok: false, error: { code: error.code, message: error.message }, status: error.status };
      throw error;
    }
  }

  createUnoRuntime(session, rng) {
    const players = [
      { id: session.humanId, name: session.humanName, isHost: true, connected: true, ready: true, leaveAfterHand: false },
      { id: session.botId, name: session.botName, isHost: false, connected: true, ready: true, leaveAfterHand: false },
    ];
    const matchId = crypto.randomUUID();
    const match = UnoEngine.createMatch({ playerIds: players.map(player => player.id), matchId, now: this.now(), rng });
    return { kind: 'uno112', match, players, rng, receipts: new Map() };
  }

  createTienLenRuntime(session, rng) {
    const humanSocket = fakePracticeSocket(`practice-socket:${crypto.randomUUID()}`);
    const botSocket = fakePracticeSocket(`practice-socket:${crypto.randomUUID()}`);
    const memoryStore = sandboxReservationStore();
    const io = { sockets: { sockets: new Map() } };
    const manager = new TienLenManager(io, {
      storageFile: null,
      profileStore: memoryStore,
      profileForSocket: () => null,
      shuffle: cards => shuffled(cards, rng),
    });
    const now = this.now();
    const human = { id: session.humanId, profileId: `practice-profile:${crypto.randomUUID()}`, socketId: humanSocket.id, name: session.humanName, avatar: '🎲', isHost: true, connected: true, ready: true, hand: [], leaveAfterHand: false };
    const bot = { id: session.botId, profileId: `practice-profile:${crypto.randomUUID()}`, socketId: botSocket.id, name: session.botName, avatar: '🤖', isHost: false, connected: true, ready: true, hand: [], leaveAfterHand: false };
    const room = {
      code: `PRACTICE-${session.id.slice(0, 8)}`, gameId: 'tien-len', currency: 'practice-point', phase: 'WAITING', rulesVersion: TIEN_LEN_VARIANT,
      stake: 0, matchId: null, revision: 0, players: [human, bot], deck: [], currentPlayerId: null, leaderId: null,
      topPlay: null, passedIds: [], initialRequiredCardId: null, playedAny: false, actionIds: {}, reservations: [], result: null,
      history: [], log: [], paused: false, createdAt: now, updatedAt: now,
    };
    manager.rooms.set(room.code, room);
    manager.playerRoom.set(humanSocket.id, room.code);
    manager.playerRoom.set(botSocket.id, room.code);
    manager.startRound(room);
    return { kind: 'tien-len', manager, room, humanSocket, botSocket, rng, receipts: new Map(), memoryStore };
  }

  sessionLookup(id, capability) {
    const session = this.sessions.get(id);
    if (!session || session.disposed) return { error: { code: 'SESSION_NOT_FOUND', message: 'Phiên luyện tập không còn tồn tại.' } };
    if (!sameCapability(capability, session.capabilityHash)) return { error: { code: 'UNAUTHORIZED', message: 'Không có quyền truy cập phiên luyện tập này.' } };
    if (this.now() >= session.expiresAt) {
      this.disposeSession(session);
      return { error: { code: 'SESSION_EXPIRED', message: 'Phiên luyện tập đã hết hạn. Hãy bắt đầu phiên mới.' } };
    }
    return { session };
  }

  enqueue(session, task) {
    const result = session.queue.then(async () => {
      if (session.disposed || this.now() >= session.expiresAt) {
        if (!session.disposed) this.disposeSession(session);
        return { ok: false, error: { code: 'SESSION_EXPIRED', message: 'Phiên luyện tập đã hết hạn. Hãy bắt đầu phiên mới.' } };
      }
      return task();
    });
    session.queue = result.catch(() => undefined);
    return result;
  }

  getState(id, capability) {
    const access = this.sessionLookup(id, capability);
    if (access.error) return Promise.resolve({ ok: false, error: access.error });
    return this.enqueue(access.session, async () => ({ ok: true, state: this.stateFor(access.session) }));
  }

  async act(id, capability, envelope = {}) {
    const access = this.sessionLookup(id, capability);
    if (access.error) return { ok: false, error: access.error };
    return this.enqueue(access.session, async () => {
      const session = access.session;
      const action = this.applyHumanAction(session, envelope);
      if (!action.ok) return { ...action, state: this.stateFor(session) };
      const automation = await this.runBots(session);
      this.updateScore(session);
      return { ok: true, duplicate: !!action.duplicate, bot: automation, state: this.stateFor(session) };
    });
  }

  deleteSession(id, capability) {
    const access = this.sessionLookup(id, capability);
    if (access.error) return Promise.resolve({ ok: false, error: access.error });
    return this.enqueue(access.session, async () => {
      this.disposeSession(access.session);
      return { ok: true };
    });
  }

  validateEnvelope(session, envelope, gameId) {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return { code: 'INVALID_ACTION', message: 'Dữ liệu thao tác không hợp lệ.' };
    const allowed = gameId === 'uno'
      ? new Set(['matchId', 'expectedRevision', 'actionId', 'type', 'payload'])
      : new Set(['matchId', 'expectedRevision', 'actionId', 'action', 'cardIds']);
    if (Object.keys(envelope).some(key => !allowed.has(key))) return { code: 'INVALID_ACTION', message: 'Phiên luyện tập không nhận trường thao tác bổ sung.' };
    if (!validateActionId(envelope.actionId)) return { code: 'INVALID_ACTION', message: 'Thiếu mã thao tác hợp lệ.' };
    const runtime = session.runtime;
    const matchId = gameId === 'uno' ? runtime.match.matchId : runtime.room.matchId;
    const revision = gameId === 'uno' ? runtime.match.revision : runtime.room.revision;
    if (envelope.matchId !== matchId) return { code: 'MATCH_NOT_FOUND', message: 'Ván đã đổi; hãy lấy trạng thái mới.' };
    if (!Number.isInteger(envelope.expectedRevision) || envelope.expectedRevision !== revision) return { code: 'STALE_REVISION', message: 'Trạng thái đã thay đổi; hãy thao tác lại trên bàn mới nhất.' };
    return null;
  }

  applyHumanAction(session, envelope) {
    if (!validateActionId(envelope?.actionId)) return errorResult('INVALID_ACTION', 'Thiếu mã thao tác hợp lệ.');
    const cached = session.runtime.receipts.get(`${session.humanId}:${envelope.actionId}`);
    if (cached) {
      if (!cached.ok) return errorResult(cached.error?.code || 'INVALID_ACTION', cached.error?.message || 'Thao tác trước đó không hợp lệ.');
      return { ok: true, duplicate: true, event: cached.event || 'DUPLICATE_ACTION' };
    }
    const validation = this.validateEnvelope(session, envelope, session.gameId);
    const runtime = session.runtime;
    const humanId = session.humanId;
    if (validation) return errorResult(validation.code, validation.message);
    if (session.gameId === 'uno') return this.applyUnoAction(session, humanId, envelope);
    return this.applyTienLenAction(session, humanId, envelope);
  }

  applyUnoAction(session, seatId, envelope) {
    const runtime = session.runtime;
    const receiptKey = `${seatId}:${envelope.actionId}`;
    if (runtime.receipts.has(receiptKey)) return { ok: true, duplicate: true };
    const match = runtime.match;
    if (!runtime.players.some(player => player.id === seatId)) return errorResult('ROOM_ACCESS', 'Ghế luyện tập không hợp lệ.');
    const outcome = UnoEngine.applyAction(match, {
      playerId: seatId,
      type: envelope.type,
      payload: envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {},
      now: this.now(),
      rng: runtime.rng,
      isHost: seatId === session.humanId,
    });
    runtime.receipts.set(receiptKey, { ok: outcome.ok, error: outcome.error || null, event: outcome.event || null, revision: match.revision });
    if (!outcome.ok) return errorResult(outcome.error?.code || 'INVALID_ACTION', outcome.error?.message || 'Thao tác không hợp lệ.');
    if (outcome.nextRound) {
      runtime.match = UnoEngine.resetForNextRound(match, { matchId: crypto.randomUUID(), now: this.now(), rng: runtime.rng });
    }
    return { ok: true, event: outcome.event || (outcome.nextRound ? 'NEXT_ROUND' : 'ACTION_APPLIED') };
  }

  applyTienLenAction(session, seatId, envelope) {
    const runtime = session.runtime;
    const receiptKey = `${seatId}:${envelope.actionId}`;
    if (runtime.receipts.has(receiptKey)) return { ok: true, duplicate: true };
    const socket = seatId === session.humanId ? runtime.humanSocket : runtime.botSocket;
    const beforeRevision = runtime.room.revision;
    socket.events.length = 0;
    runtime.manager.action(socket, runtime.room.code, {
      ...(envelope.action === 'play' ? { action: 'play', cardIds: envelope.cardIds } : { action: envelope.action }),
      actionId: envelope.actionId,
      expectedRevision: envelope.expectedRevision,
    });
    const emitted = socket.events.find(event => event.event === 'game_error');
    if (emitted) return errorResult('INVALID_ACTION', String(emitted.payload?.message || 'Thao tác không hợp lệ.'));
    if (runtime.room.revision === beforeRevision) return errorResult('INVALID_ACTION', 'Server không áp dụng được thao tác này.');
    runtime.receipts.set(receiptKey, { ok: true, revision: runtime.room.revision });
    return { ok: true, event: 'ACTION_APPLIED' };
  }

  async runBots(session) {
    let steps = 0;
    session.botStatus = 'ready';
    while (steps < this.maxBotSteps && !session.disposed && this.now() < session.expiresAt) {
      let decision;
      let envelope;
      if (session.gameId === 'uno') {
        const runtime = session.runtime;
        const projection = createUnoBotProjection(runtime.match, runtime.players, session.botId, this.now());
        decision = chooseUnoAction(projection);
        if (!decision) break;
        envelope = {
          matchId: runtime.match.matchId,
          expectedRevision: runtime.match.revision,
          actionId: `bot_${crypto.randomBytes(18).toString('base64url')}`,
          type: decision.type,
          payload: decision.payload || {},
        };
        const validation = this.validateEnvelope(session, envelope, 'uno');
        if (validation) { session.botStatus = 'error'; break; }
        const result = this.applyUnoAction(session, session.botId, envelope);
        if (!result.ok) { session.botStatus = 'error'; break; }
      } else {
        const runtime = session.runtime;
        const projection = createTienLenBotProjection(runtime.room, session.botId);
        decision = chooseTienLenAction(projection);
        if (!decision) break;
        envelope = {
          matchId: runtime.room.matchId,
          expectedRevision: runtime.room.revision,
          actionId: `bot_${crypto.randomBytes(18).toString('base64url')}`,
          ...decision,
        };
        const validation = this.validateEnvelope(session, envelope, 'tien-len');
        if (validation) { session.botStatus = 'error'; break; }
        const result = this.applyTienLenAction(session, session.botId, envelope);
        if (!result.ok) { session.botStatus = 'error'; break; }
      }
      steps += 1;
      this.updateScore(session);
      if (steps % this.botYieldEvery === 0) await immediate();
    }
    if (steps >= this.maxBotSteps && this.botCanAct(session)) session.botStatus = 'step-limit';
    return { steps, status: session.botStatus };
  }

  botCanAct(session) {
    if (session.gameId === 'uno') {
      const match = session.runtime.match;
      if (match.phase === 'RESULT') return false;
      const projection = createUnoBotProjection(match, session.runtime.players, session.botId, this.now());
      return chooseUnoAction(projection) !== null;
    }
    return session.runtime.room.phase !== 'RESULT' && session.runtime.room.currentPlayerId === session.botId;
  }

  updateScore(session) {
    const result = session.gameId === 'uno' ? session.runtime.match.result : session.runtime.room.result;
    const matchId = session.gameId === 'uno' ? session.runtime.match.matchId : session.runtime.room.matchId;
    if (!result || !matchId || session.score.scoredMatchIds.has(matchId)) return;
    session.score.scoredMatchIds.add(matchId);
    if (result.winnerId === session.humanId) session.score.humanWins += 1;
    else if (result.winnerId === session.botId) session.score.botWins += 1;
  }

  stateFor(session) {
    this.updateScore(session);
    const common = {
      schemaVersion: 1,
      sessionId: session.id,
      gameId: session.gameId,
      variant: session.variant,
      matchId: session.gameId === 'uno' ? session.runtime.match.matchId : session.runtime.room.matchId,
      revision: session.gameId === 'uno' ? session.runtime.match.revision : session.runtime.room.revision,
      expiresAt: session.expiresAt,
      botStatus: session.botStatus,
      practice: {
        label: 'Điểm luyện tập · chỉ trong phiên, không có giá trị và không vào ví',
        humanWins: session.score.humanWins,
        botWins: session.score.botWins,
      },
    };
    return session.gameId === 'uno' ? { ...common, ...this.unoState(session) } : { ...common, ...this.tienLenState(session) };
  }

  unoState(session) {
    const runtime = session.runtime;
    const match = runtime.match;
    const visible = UnoEngine.visibleState(match, session.humanId, runtime.players, {}, this.now());
    return {
      phase: visible.phase,
      player: { id: session.humanId, name: session.humanName, hand: clone(visible.myHand), availableActions: clone(visible.availableActions) },
      publicState: {
        currentColor: visible.currentColor,
        currentPlayerId: visible.currentPlayerId,
        direction: visible.direction,
        pendingDraw: visible.pendingDraw,
        pendingTargetId: visible.pendingTargetId,
        drawPileCount: visible.drawPileCount,
        topCard: clone(visible.topCard),
        reactionWindow: visible.reactionWindow ? { type: visible.reactionWindow.type, targetId: visible.reactionWindow.targetId, deadlineAt: visible.reactionWindow.deadlineAt } : null,
        unoWindow: visible.unoWindow ? { playerId: visible.unoWindow.playerId, deadlineAt: visible.unoWindow.deadlineAt } : null,
        drawChoice: clone(visible.drawChoice),
        players: publicUnoPlayers(runtime.players, match, this.now()),
        result: match.result ? { winnerId: match.result.winnerId, reason: match.result.reason, cardCounts: clone(match.result.cardCounts) } : null,
      },
    };
  }

  tienLenState(session) {
    const room = session.runtime.room;
    const human = room.players.find(player => player.id === session.humanId);
    return {
      phase: room.phase,
      player: { id: session.humanId, name: session.humanName, hand: clone(human?.hand || []), availableActions: this.tienLenAvailableActions(room, session.humanId) },
      publicState: {
        currentPlayerId: room.currentPlayerId,
        leaderId: room.leaderId,
        playedAny: !!room.playedAny,
        initialRequiredCardId: !room.playedAny && human?.hand.some(card => card.id === room.initialRequiredCardId) ? room.initialRequiredCardId : null,
        topPlay: room.topPlay ? { playerId: room.topPlay.playerId, formation: clone(room.topPlay.formation), cards: clone(room.topPlay.cards) } : null,
        passedIds: room.passedIds.slice(),
        players: publicTienLenPlayers(room),
        result: room.result ? { winnerId: room.result.winnerId, winnerName: room.result.winnerName, reason: room.result.reason } : null,
      },
    };
  }

  tienLenAvailableActions(room, seatId) {
    if (room.phase === 'RESULT') return room.players.some(player => player.id === seatId && player.isHost) ? ['play_again'] : [];
    if (room.currentPlayerId !== seatId) return [];
    const actions = ['play'];
    if (room.topPlay && room.leaderId !== seatId) actions.push('pass');
    return actions;
  }

  inspectSessionCount() { return this.sessions.size; }

  cleanup(at = this.now()) {
    let removed = 0;
    for (const session of this.sessions.values()) {
      if (session.expiresAt <= at) { this.disposeSession(session); removed += 1; }
    }
    return removed;
  }

  disposeSession(session) {
    if (!session || session.disposed) return false;
    session.disposed = true;
    if (session.runtime?.kind === 'tien-len') {
      session.runtime.manager.close();
      session.runtime.manager.rooms.clear();
      session.runtime.manager.playerRoom.clear();
      session.runtime.room.players.forEach(player => { player.hand = []; player.profileId = null; });
      session.runtime.memoryStore = null;
    } else if (session.runtime?.kind === 'uno112') {
      session.runtime.match.hands = {};
      session.runtime.match.drawPile = [];
      session.runtime.match.discardPile = [];
      session.runtime.match.actionReceipts = [];
      session.runtime.players.length = 0;
    }
    session.capabilityHash.fill(0);
    session.score.scoredMatchIds.clear();
    this.sessions.delete(session.id);
    return true;
  }

  close() {
    for (const session of [...this.sessions.values()]) this.disposeSession(session);
  }
}

module.exports = {
  PracticeService,
  PracticeError,
  createUnoBotProjection,
  createTienLenBotProjection,
  seededRandom,
};
