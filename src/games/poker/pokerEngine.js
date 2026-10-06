'use strict';

const { notifyRoomCommitted } = require('../../platform/roomCommitEvents');

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { runStorageOperation } = require('../../platform/storageDiagnostics');
const { getBestHand } = require('../../handEvaluator');
const { createPokerDeck, shuffle, labelCard } = require('./pokerDeck');
const { installTurnClock, standardTurn } = require('../../platform/turnClock');
const { DEFAULT_RECONNECT_GRACE_MS, markDisconnected, markConnected, restoreDisconnectedSeats, isReconnectExpired, reconnectWaiters, isServerActionSocket, serverActionPlayer, runServerAction } = require('../../platform/reconnectGrace');

const AVATARS = ['🕶️', '🥷', '💻', '🔓', '🎲', '🏎️'];
const ACTIVE_PHASES = new Set(['HAND']);
const SMALL_BLIND = 5;
const BIG_BLIND = 10;
const MIN_BUY_IN = 200;
const MAX_BUY_IN = 1000;
const MIN_TO_START = BIG_BLIND;
const now = () => Date.now();
const cleanName = value => require('../../../public/js/game-values').cleanDisplayName(value) || 'Player';

function validAmount(value) { return Number.isSafeInteger(value) && value > 0; }
function contributionPots(players) {
  const levels = [...new Set(players.map(player => player.totalContribution).filter(Boolean))].sort((a, b) => a - b);
  let prior = 0;
  const pots = [];
  for (const level of levels) {
    const contributors = players.filter(player => player.totalContribution >= level);
    const amount = (level - prior) * contributors.length;
    const eligible = contributors.filter(player => !player.folded);
    if (amount && eligible.length) pots.push({ amount, level, contributors: contributors.map(player => player.id), eligible: eligible.map(player => player.id) });
    // A level with no eligible player consists only of folded chips.  It is
    // still money already called; award it with the closest lower live pot.
    else if (amount && pots.length) pots[pots.length - 1].amount += amount;
    prior = level;
  }
  return pots;
}

function refundUncalled(players) {
  const refunds = [];
  for (const player of players) {
    const otherMaximum = Math.max(0, ...players.filter(other => other !== player).map(other => other.totalContribution));
    if (player.totalContribution > otherMaximum) {
      const amount = player.totalContribution - otherMaximum;
      player.totalContribution -= amount;
      player.stack += amount;
      refunds.push({ playerId: player.id, amount });
    }
  }
  return refunds;
}

class PokerManager {
  constructor(io, options = {}) {
    this.io = io;
    this.rooms = new Map();
    this.playerRoom = new Map();
    this.storageFile = options.storageFile || null;
    this.graceMs = options.graceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.codeTaken = typeof options.codeTaken === 'function' ? options.codeTaken : () => false;
    this.profileForSocket = typeof options.profileForSocket === 'function' ? options.profileForSocket : () => null;
    this.profileStore = options.profileStore;
    this.onMatchCompleted = typeof options.onMatchCompleted === 'function' ? options.onMatchCompleted : null;
    this.shuffle = typeof options.shuffle === 'function' ? options.shuffle : shuffle;
    this.storageDiagnostics = options.storageDiagnostics || this.profileStore?.storageDiagnostics || null;
    this.load();
    // Poker waits only for seats that can still affect this hand. Keep this
    // decision in the clock callback as well as in access/disconnect paths so
    // irrelevant offline seats never freeze the saved turn deadline.
    installTurnClock(this, { getTurn: room => {
      this.updatePaused(room);
      return standardTurn(room);
    }, timeoutAction: (room, player) => {
      const action = room.currentBet === player.roundBet ? 'check' : 'fold';
      const result = runServerAction(this, room, player, { action });
      if (!result?.error) this.addLog(room, `${player.name} hết 30 giây; server ${action} theo lượt Poker.`);
      return result;
    } });
    this.cleanupTimer = setInterval(() => this.cleanup(), 1000);
    this.cleanupTimer.unref();
  }

  error(socket, message) { this.afterCommit(() => socket.emit('game_error', { message })); return { error: message }; }
  afterCommit(effect) { if (this.mutationDepth) this.pendingEffects.push(effect); else effect(); }
  persistRoom(room) {
    if (!this.profileStore?.saveGameSnapshot || this.mutationDepth) return;
    if (room.players.length) this.profileStore.saveGameSnapshot({ gameId: 'poker', room });
    else this.profileStore.closeGameRoom('poker', room.code);
  }
  commitRoom(room, work) {
    if (this.mutationDepth || !this.profileStore?.saveGameSnapshot) return work();
    const previous = structuredClone(room), bindings = new Map(this.playerRoom), existed = this.rooms.has(room.code);
    this.mutationDepth = 1; this.pendingEffects = []; this.flushPending = false;
    let result;
    try {
      result = this.profileStore.transaction(() => {
        const value = work();
        if (room.players.length) this.profileStore.saveGameSnapshot({ gameId: 'poker', room });
        else this.profileStore.closeGameRoom('poker', room.code);
        return value;
      });
    } catch (error) {
      for (const key of Object.keys(room)) delete room[key];
      Object.assign(room, previous); this.playerRoom = bindings;
      if (existed) this.rooms.set(room.code, room); else this.rooms.delete(room.code);
      this.pendingEffects = []; this.flushPending = false; throw error;
    } finally { this.mutationDepth = 0; }
    const effects = this.pendingEffects; this.pendingEffects = [];
    for (const effect of effects) effect();
    if (JSON.stringify(room) !== JSON.stringify(previous)) notifyRoomCommitted(this, room.code);
    if (this.flushPending) this.flush(); else this.saveSoon();
    return result;
  }
  close() { clearInterval(this.cleanupTimer); clearTimeout(this.saveTimer); this.flush(); }
  code() { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code; do { code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (this.rooms.has(code) || this.codeTaken(code)); return code; }
  newPlayer(socket, name, avatar, isHost = false) {
    const profile = this.profileForSocket(socket);
    return { id: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'), socketId: socket.id, profileId: profile?.id || null,
      name: cleanName(profile?.displayName || name), avatar: profile?.avatar || (AVATARS.includes(avatar) ? avatar : AVATARS[0]),
      isHost, connected: true, disconnectedAt: null, ready: false, stack: 0, reservations: [], holeCards: [], inHand: false,
      folded: false, allIn: false, roundBet: 0, totalContribution: 0, lastActionBet: null, handStartingStack: 0, leaveAfterHand: false };
  }
  credentials(room, player) { return { roomCode: room.code, playerId: player.id, sessionToken: player.token, gameId: 'poker' }; }
  player(room, socket) { return serverActionPlayer(this, room, socket) || room?.players.find(item => item.socketId === socket.id && item.connected); }
  byId(room, id) { return room.players.find(item => item.id === id); }
  reconnectAffects(room, player) { return room.phase === 'HAND' && player.inHand && !player.folded; }
  reconnectWaiters(room, at = now()) { return reconnectWaiters(room, at, this.graceMs, player => this.reconnectAffects(room, player)); }
  updatePaused(room, at = now()) {
    const wasPaused = !!room.paused;
    const waiting = this.reconnectWaiters(room, at);
    room.paused = waiting.length > 0;
    return { wasPaused, waiting };
  }
  bind(socket, room, player) {
    player.name = cleanName(this.profileForSocket(socket)?.displayName || player.name);
    this.playerRoom.set(socket.id, room.code); socket.join(room.code); player.socketId = socket.id; markConnected(player);
    const { wasPaused, waiting } = this.updatePaused(room);
    if (wasPaused && !waiting.length) { this.addLog(room, 'Mọi người còn ảnh hưởng đến hand đã kết nối lại; hand tiếp tục.'); this.touch(room); }
  }
  access(socket, code, phases) {
    const room = this.rooms.get(code), player = this.player(room, socket);
    if (!room || !player) return this.error(socket, 'Bạn không còn ở bàn Poker này.');
    if (phases && !phases.includes(room.phase)) return this.error(socket, 'Thao tác không phù hợp với giai đoạn hiện tại.');
    const { waiting } = this.updatePaused(room);
    if (!isServerActionSocket(this, socket) && ACTIVE_PHASES.has(room.phase) && waiting.length) return this.error(socket, `Hand đang tạm dừng; cần chờ ${waiting.map(item => item.name).join(', ')} kết nối lại.`);
    return { room, player };
  }
  ensureHost(room) { if (room.players.some(player => player.isHost && player.connected)) return; const next = room.players.find(player => player.connected) || room.players[0]; room.players.forEach(player => { player.isHost = player === next; }); }
  touch(room) { room.revision = (room.revision || 0) + 1; room.updatedAt = now(); this.persistRoom(room); this.saveSoon(); }
  addLog(room, message) { room.log.unshift({ id: crypto.randomUUID(), message, at: new Date().toISOString() }); room.log = room.log.slice(0, 80); }
  createRoom(socket, name, avatar) {
    if (this.playerRoom.has(socket.id)) return { error: 'Hãy rời phòng hiện tại trước khi tạo bàn.' };
    if (!this.profileForSocket(socket)) return { error: 'Poker cần hồ sơ để quản lý ví và stack.' };
    const player = this.newPlayer(socket, name, avatar, true);
    const room = { code: this.code(), gameId: 'poker', phase: 'WAITING', rulesVersion: 'holdem-nl-v1', revision: 0, players: [player],
      buttonPlayerId: null, currentPlayerId: null, street: null, deck: [], community: [], currentBet: 0, lastFullRaise: BIG_BLIND,
      matchId: null, actionIds: {}, result: null, history: [], log: [], paused: false, createdAt: now(), updatedAt: now() };
    this.rooms.set(room.code, room); this.bind(socket, room, player); this.addLog(room, `${player.name} tạo bàn Texas Hold’em No-Limit ${room.code} · blind ${SMALL_BLIND}/${BIG_BLIND}.`); this.touch(room);
    return this.credentials(room, player);
  }
  joinRoom(socket, code, name, avatar) {
    if (this.playerRoom.has(socket.id)) return { error: 'Bạn đang ở một phòng khác.' };
    const room = this.rooms.get(code); if (!room) return { error: 'Không tìm thấy bàn Poker.' };
    if (!this.profileForSocket(socket)) return { error: 'Poker cần hồ sơ để quản lý ví và stack.' };
    if (room.players.length >= 6) return { error: 'Bàn Poker đã đủ 6 ghế.' };
    const profile = this.profileForSocket(socket); if (room.players.some(item => item.profileId === profile.id)) return { error: 'Hồ sơ này đã có ghế; hãy khôi phục ghế cũ.' };
    const player = this.newPlayer(socket, name, avatar); room.players.push(player); this.bind(socket, room, player);
    this.addLog(room, `${player.name} vào bàn${room.phase === 'HAND' ? ' và ngồi ngoài đến hand kế tiếp' : ''}.`); this.touch(room); this.broadcast(code);
    return this.credentials(room, player);
  }
  resumeRoom(socket, code, token) {
    const room = this.rooms.get(code), player = room?.players.find(item => typeof token === 'string' && item.token === token);
    if (!player) return { error: 'Phiên Poker đã hết hạn hoặc bàn không còn tồn tại.' };
    const profile = this.profileForSocket(socket); if (player.profileId && player.profileId !== profile?.id) return { error: 'Ghế này thuộc về một hồ sơ khác.' };
    const active = this.playerRoom.get(socket.id); if (active && active !== code) return { error: 'Bạn đang ở phòng khác.' };
    if (player.connected && player.socketId !== socket.id) return { error: 'Ghế này đang mở ở cửa sổ khác.' };
    this.bind(socket, room, player); this.ensureHost(room); this.addLog(room, `${player.name} đã nối lại.`); this.touch(room); this.broadcast(code); return this.credentials(room, player);
  }
  setReady(socket, code, ready) {
    const ctx = this.access(socket, code, ['WAITING', 'RESULT']); if (!ctx || ctx.error) return ctx;
    if (ready && ctx.player.stack < MIN_TO_START) return this.error(socket, `Cần stack tối thiểu ${MIN_TO_START} chip để nhận hand mới.`);
    ctx.player.ready = !!ready; this.touch(ctx.room); this.broadcast(code);
  }
  eligible(room) { return room.players.filter(player => player.connected && player.ready && player.stack >= MIN_TO_START && !player.leaveAfterHand); }
  startGame(socket, code) {
    const ctx = this.access(socket, code, ['WAITING']); if (!ctx || ctx.error) return ctx;
    if (!ctx.player.isHost) return this.error(socket, 'Chỉ chủ bàn được bắt đầu hand.');
    const seats = this.eligible(ctx.room); if (seats.length < 2) return this.error(socket, `Cần ít nhất 2 người sẵn sàng với stack từ ${MIN_TO_START} chip.`);
    this.startHand(ctx.room, seats); this.broadcast(code); return { ok: true };
  }
  moveButton(room, seats) {
    const oldIndex = room.buttonPlayerId ? room.players.findIndex(player => player.id === room.buttonPlayerId) : -1;
    for (let step = 1; step <= room.players.length; step++) {
      const player = room.players[(oldIndex + step + room.players.length) % room.players.length];
      if (seats.includes(player)) return player;
    }
    return seats[0];
  }
  nextSeat(room, id, predicate = () => true) {
    const index = room.players.findIndex(player => player.id === id);
    for (let step = 1; step <= room.players.length; step++) {
      const candidate = room.players[(index + step + room.players.length) % room.players.length];
      if (predicate(candidate)) return candidate;
    }
    return null;
  }
  startHand(room, seats) {
    return this.commitRoom(room, () => this.applyStartHand(room, seats));
  }
  applyStartHand(room, seats) {
    room.reconnectPolicyVersion = 2; room.phase = 'HAND'; room.matchId = crypto.randomUUID(); room.result = null; room.actionIds = {}; room.deck = this.shuffle(createPokerDeck()); room.community = []; room.street = 'PREFLOP'; room.currentBet = BIG_BLIND; room.lastFullRaise = BIG_BLIND; room.paused = false;
    const button = this.moveButton(room, seats); room.buttonPlayerId = button.id;
    room.players.forEach(player => {
      player.inHand = seats.includes(player); player.holeCards = []; player.folded = !player.inHand; player.allIn = false; player.roundBet = 0; player.totalContribution = 0; player.lastActionBet = null; player.handStartingStack = player.stack; player.leaveAfterHand = false;
    });
    // First card goes to the small blind, which is also the button heads-up.
    const smallBlind = seats.length === 2 ? button : this.nextSeat(room, button.id, player => player.inHand);
    const bigBlind = this.nextSeat(room, smallBlind.id, player => player.inHand);
    for (let round = 0; round < 2; round++) for (const player of this.clockwiseFrom(room, smallBlind.id, item => item.inHand)) player.holeCards.push(room.deck.shift());
    this.post(room, smallBlind, SMALL_BLIND); this.post(room, bigBlind, BIG_BLIND);
    room.smallBlindPlayerId = smallBlind.id; room.bigBlindPlayerId = bigBlind.id;
    const preflopStart = seats.length === 2 ? button : this.nextSeat(room, bigBlind.id, player => player.inHand);
    room.currentPlayerId = this.firstPendingStarting(room, preflopStart.id)?.id || null;
    this.addLog(room, `Hand mới: ${button.name} có button; ${smallBlind.name} đăng SB ${Math.min(SMALL_BLIND, smallBlind.handStartingStack)}, ${bigBlind.name} đăng BB ${Math.min(BIG_BLIND, bigBlind.handStartingStack)}.`);
    this.touch(room); this.flush(); this.advanceIfNeeded(room, null);
  }
  clockwiseFrom(room, startId, predicate) {
    const result = [], index = room.players.findIndex(player => player.id === startId);
    for (let step = 0; step < room.players.length; step++) { const player = room.players[(index + step) % room.players.length]; if (predicate(player)) result.push(player); }
    return result;
  }
  post(room, player, amount) { this.wagerTo(room, player, player.roundBet + Math.min(amount, player.stack)); }
  wagerTo(room, player, target) { const delta = target - player.roundBet; player.stack -= delta; player.roundBet = target; player.totalContribution += delta; if (!player.stack) player.allIn = true; }
  verifyAction(room, data) {
    if (!Number.isInteger(data?.expectedRevision) || data.expectedRevision !== room.revision) return 'Trạng thái đã thay đổi. Vui lòng thao tác lại.';
    if (typeof data?.actionId !== 'string' || data.actionId.length < 8 || data.actionId.length > 128) return 'Thiếu mã thao tác hợp lệ.';
    return room.actionIds[data.actionId] ? 'duplicate' : null;
  }
  rememberAction(room, actionId) { room.actionIds[actionId] = true; const ids = Object.keys(room.actionIds); if (ids.length > 250) ids.slice(0, ids.length - 250).forEach(id => delete room.actionIds[id]); }
  action(socket, code, data) {
    const ctx = this.access(socket, code); if (!ctx || ctx.error) return ctx;
    const invalid = this.verifyAction(ctx.room, data); if (invalid === 'duplicate') return; if (invalid) return this.error(socket, invalid);
    try { return this.commitRoom(ctx.room, () => this.applyAction(socket, code, data, ctx)); }
    catch (error) { return this.error(socket, error.message || 'Không thể lưu thao tác Poker.'); }
  }
  applyAction(socket, code, data, ctx) {
    let ok = false;
    if (data.action === 'buy_in') ok = this.buyIn(socket, ctx.room, ctx.player, data);
    else if (data.action === 'sit_out') ok = this.sitOut(socket, ctx.room, ctx.player);
    else if (data.action === 'start_next_hand') ok = this.startNextHand(socket, ctx.room, ctx.player);
    else if (['fold', 'check', 'call', 'bet', 'raise', 'all_in'].includes(data.action)) ok = this.bettingAction(socket, ctx.room, ctx.player, data);
    else return this.error(socket, 'Hành động Poker không hợp lệ.');
    if (ok === false || ok?.error) return ok;
    this.rememberAction(ctx.room, data.actionId); this.touch(ctx.room); this.broadcast(code);
  }
  buyIn(socket, room, player, data) {
    return this.commitRoom(room, () => this.applyBuyIn(socket, room, player, data));
  }
  applyBuyIn(socket, room, player, data) {
    if (!['WAITING', 'RESULT'].includes(room.phase)) return this.error(socket, 'Chỉ buy-in hoặc top-up giữa các hand.');
    let amount; try { amount = require('../../../public/js/game-values').parseAmount(data.amount, { max: MAX_BUY_IN }); } catch (error) { return this.error(socket, error.message); } if (!validAmount(amount) || amount % BIG_BLIND !== 0) return this.error(socket, `Buy-in phải là bội số ${BIG_BLIND} chip.`);
    if (player.stack === 0 && (amount < MIN_BUY_IN || amount > MAX_BUY_IN)) return this.error(socket, `Buy-in đầu tiên từ ${MIN_BUY_IN} đến ${MAX_BUY_IN} chip.`);
    if (player.stack > 0 && player.stack + amount > MAX_BUY_IN) return this.error(socket, `Stack tối đa là ${MAX_BUY_IN} chip.`);
    try {
      const hold = this.profileStore.reserveMany({ reservations: [{ profileId: player.profileId, amount }], operationKey: `poker:buyin:${room.code}:${player.profileId}:${data.actionId}`, roomCode: room.code, matchId: room.matchId || null });
      if (hold.idempotent) return false;
      this.rememberAction(room, data.actionId);
      player.stack += amount; player.reservations.push(...hold.held); this.addLog(room, `${player.name} ${player.stack === amount ? 'buy-in' : 'top-up'} ${amount} chip vào stack.`); return true;
    } catch (error) { return this.error(socket, error.message || 'Không thể buy-in.'); }
  }
  sitOut(socket, room, player) {
    if (!['WAITING', 'RESULT'].includes(room.phase)) return this.error(socket, 'Chỉ đổi trạng thái ngồi ngoài giữa các hand.');
    player.ready = false; this.addLog(room, `${player.name} ngồi ngoài hand kế tiếp.`); return true;
  }
  startNextHand(socket, room, player) {
    if (room.phase !== 'RESULT' || !player.isHost) return this.error(socket, 'Chỉ chủ bàn mở hand tiếp theo sau kết quả.');
    const seats = this.eligible(room); if (seats.length < 2) return this.error(socket, `Cần 2 người có stack từ ${MIN_TO_START} chip để chơi tiếp.`);
    this.startHand(room, seats); return true;
  }
  requireTurn(socket, room, player) { if (room.phase !== 'HAND' || room.currentPlayerId !== player.id || !player.inHand || player.folded || player.allIn) { this.error(socket, 'Chưa đến lượt hành động của bạn.'); return false; } return true; }
  bettingAction(socket, room, player, data) {
    if (!this.requireTurn(socket, room, player)) return false;
    const toCall = Math.max(0, room.currentBet - player.roundBet);
    const action = data.action;
    if (action === 'fold') { player.folded = true; player.lastActionBet = room.currentBet; this.addLog(room, `${player.name} fold.`); this.advanceIfNeeded(room, player.id); return true; }
    if (action === 'check') { if (toCall) return this.error(socket, `Bạn cần theo thêm ${toCall} chip hoặc fold.`); player.lastActionBet = room.currentBet; this.addLog(room, `${player.name} check.`); this.advanceIfNeeded(room, player.id); return true; }
    if (action === 'call') { if (!toCall) return this.error(socket, 'Không có cược để theo; hãy check.'); const target = player.roundBet + Math.min(toCall, player.stack); this.wagerTo(room, player, target); player.lastActionBet = room.currentBet; this.addLog(room, `${player.name} ${player.allIn ? `all-in ${target}` : `call ${toCall}`}.`); this.advanceIfNeeded(room, player.id); return true; }
    let target;
    if (action === 'all_in') target = player.roundBet + player.stack;
    else {
      try { target = require('../../../public/js/game-values').parseAmount(data.total, { max: player.roundBet + player.stack }); } catch (error) { return this.error(socket, error.message); }
      if (!Number.isSafeInteger(target)) return this.error(socket, 'Tổng cược phải là số chip nguyên.');
      if (action === 'bet' && room.currentBet !== 0) return this.error(socket, 'Vòng này đã có cược; hãy tố đến tổng mới.');
      if (action === 'raise' && room.currentBet === 0) return this.error(socket, 'Chưa có cược; hãy bet hoặc all-in.');
    }
    // An all-in can be a short call rather than a raise.  Its button remains
    // useful in that case, but it must not create an illegal raise.
    if (action === 'all_in' && target <= room.currentBet && target > player.roundBet) {
      this.wagerTo(room, player, target); player.lastActionBet = room.currentBet;
      this.addLog(room, `${player.name} all-in ${target}${target < room.currentBet ? ' (call thiếu)' : ''}.`); this.advanceIfNeeded(room, player.id); return true;
    }
    if (target <= room.currentBet || target <= player.roundBet || target > player.roundBet + player.stack) return this.error(socket, 'Mức cược không nằm trong stack hoặc chưa cao hơn cược hiện tại.');
    const priorBet = room.currentBet, increase = target - priorBet, full = priorBet === 0 ? target >= BIG_BLIND : increase >= room.lastFullRaise;
    if (!full && target !== player.roundBet + player.stack) return this.error(socket, `Tố tối thiểu đến tổng ${room.currentBet + room.lastFullRaise}, trừ khi all-in.`);
    const facedIncrease = player.lastActionBet === null ? Infinity : room.currentBet - player.lastActionBet;
    if (player.lastActionBet !== null && facedIncrease < room.lastFullRaise) return this.error(socket, 'All-in ngắn chưa mở lại quyền tố; bạn chỉ có thể call hoặc fold.');
    this.wagerTo(room, player, target); room.currentBet = target;
    if (full) { room.lastFullRaise = priorBet === 0 ? target : increase; room.players.forEach(item => { item.lastActionBet = null; }); }
    player.lastActionBet = target;
    this.addLog(room, `${player.name} ${player.allIn ? 'all-in' : action === 'bet' ? 'bet' : 'raise'} đến tổng ${target}${full ? '' : ' (all-in ngắn)'}.`);
    this.advanceIfNeeded(room, player.id); return true;
  }
  needsAction(room, player) { return player.inHand && !player.folded && !player.allIn && (player.lastActionBet === null || player.roundBet < room.currentBet); }
  firstPendingStarting(room, startId) {
    const index = room.players.findIndex(player => player.id === startId);
    for (let step = 0; step < room.players.length; step++) { const player = room.players[(index + step) % room.players.length]; if (this.needsAction(room, player)) return player; }
    return null;
  }
  nextPending(room, afterId) {
    const index = room.players.findIndex(player => player.id === afterId);
    for (let step = 1; step <= room.players.length; step++) { const player = room.players[(index + step) % room.players.length]; if (this.needsAction(room, player)) return player; }
    return null;
  }
  advanceIfNeeded(room, afterId) {
    const alive = room.players.filter(player => player.inHand && !player.folded);
    if (alive.length === 1) { this.finishHand(room, { kind: 'fold', winner: alive[0] }); return; }
    const pending = afterId ? this.nextPending(room, afterId) : room.currentPlayerId ? this.firstPendingStarting(room, room.currentPlayerId) : null;
    if (pending) { room.currentPlayerId = pending.id; return; }
    if (room.street === 'RIVER') { this.finishHand(room, { kind: 'showdown' }); return; }
    this.advanceStreet(room);
  }
  advanceStreet(room) {
    if (room.street === 'PREFLOP') { room.community.push(room.deck.shift(), room.deck.shift(), room.deck.shift()); room.street = 'FLOP'; }
    else if (room.street === 'FLOP') { room.community.push(room.deck.shift()); room.street = 'TURN'; }
    else { room.community.push(room.deck.shift()); room.street = 'RIVER'; }
    room.players.forEach(player => { player.roundBet = 0; player.lastActionBet = null; }); room.currentBet = 0; room.lastFullRaise = BIG_BLIND;
    const start = this.nextSeat(room, room.buttonPlayerId, player => player.inHand);
    room.currentPlayerId = this.firstPendingStarting(room, start.id)?.id || null;
    this.addLog(room, `${room.street}: ${room.community.map(labelCard).join(' ')}.`);
    this.advanceIfNeeded(room, null);
  }
  resolvePots(room, contenders) {
    const pots = contributionPots(room.players), payouts = new Map(room.players.map(player => [player.id, 0]));
    const scores = new Map(contenders.map(player => [player.id, getBestHand(player.holeCards, room.community)]));
    for (const pot of pots) {
      const eligible = pot.eligible.map(id => this.byId(room, id));
      const bestScore = Math.max(...eligible.map(player => scores.get(player.id).score));
      const winners = eligible.filter(player => scores.get(player.id).score === bestScore);
      const share = Math.floor(pot.amount / winners.length), remainder = pot.amount % winners.length;
      winners.forEach(player => payouts.set(player.id, payouts.get(player.id) + share));
      const firstLeftOfButton = this.nextSeat(room, room.buttonPlayerId, player => winners.includes(player));
      const ordered = this.clockwiseFrom(room, firstLeftOfButton.id, player => winners.includes(player));
      for (let index = 0; index < remainder; index++) payouts.set(ordered[index].id, payouts.get(ordered[index].id) + 1);
      pot.winners = winners.map(player => player.id); pot.hand = scores.get(winners[0].id).nameVi;
    }
    return { pots, payouts, scores };
  }
  finishHand(room, outcome) {
    return this.commitRoom(room, () => this.applyFinishHand(room, outcome));
  }
  applyFinishHand(room, outcome) {
    const refunds = refundUncalled(room.players);
    let pots, payouts, scores = new Map();
    if (outcome.kind === 'fold') {
      const amount = room.players.reduce((sum, player) => sum + player.totalContribution, 0); pots = amount ? [{ amount, level: null, contributors: room.players.filter(player => player.totalContribution).map(player => player.id), eligible: [outcome.winner.id], winners: [outcome.winner.id], hand: 'Thắng khi mọi người khác fold' }] : [];
      payouts = new Map(room.players.map(player => [player.id, player === outcome.winner ? amount : 0]));
    } else ({ pots, payouts, scores } = this.resolvePots(room, room.players.filter(player => player.inHand && !player.folded)));
    for (const player of room.players) player.stack += payouts.get(player.id) || 0;
    const completedAt = new Date().toISOString();
    const soleWinnerId = pots.length === 1 && pots[0].winners.length === 1 ? pots[0].winners[0] : (outcome.kind === 'fold' ? outcome.winner.id : null);
    room.players.forEach(p => { p.winStreak = (soleWinnerId && p.id === soleWinnerId) ? (p.winStreak || 0) + 1 : 0; });
    const result = { matchId: room.matchId, completedAt, reason: outcome.kind === 'fold' ? `${outcome.winner.name} thắng do mọi người khác fold` : 'Showdown',
      community: [...room.community], pot: pots.reduce((sum, pot) => sum + pot.amount, 0), refunds, pots: pots.map(pot => ({ ...pot, winnerNames: pot.winners.map(id => this.byId(room, id)?.name || '') })),
      showdown: outcome.kind === 'showdown' ? room.players.filter(player => player.inHand && !player.folded).map(player => ({ playerId: player.id, cards: player.holeCards, hand: scores.get(player.id)?.nameVi, score: scores.get(player.id)?.score })) : [],
      outcomes: room.players.filter(player => player.inHand).map(player => ({ playerId: player.id, name: player.name, stackBefore: player.handStartingStack, stackAfter: player.stack, delta: player.stack - player.handStartingStack, payout: payouts.get(player.id) || 0, folded: player.folded })) };
    room.phase = 'RESULT'; room.currentPlayerId = null; room.result = result; room.history.unshift(result); room.history = room.history.slice(0, 50);
    this.addLog(room, `${result.reason}. Pot ${result.pot} chip đã chia trên stack; chưa tự cash-out về ví.`);
    if (this.onMatchCompleted) this.onMatchCompleted({ matchId: room.matchId, gameId: 'poker', roomCode: room.code, completedAt,
      players: result.outcomes.map(item => ({ profileId: this.byId(room, item.playerId).profileId, outcome: item.payout ? (pots.some(pot => pot.winners.length > 1 && pot.winners.includes(item.playerId)) ? 'TIE' : 'WIN') : 'LOSS' })), result });
    for (const player of [...room.players]) if (player.leaveAfterHand) {
      const socket = this.io.sockets.sockets.get(player.socketId), state = this.buildStateFor(room, player.id);
      if (socket && player.connected) this.afterCommit(() => socket.emit('game_state', state));
      this.cashOutAndRemove(room, player, socket);
    }
    this.touch(room); this.flush();
  }
  cashOutAndRemove(room, player, socket = null) {
    return this.commitRoom(room, () => this.applyCashOutAndRemove(room, player, socket || this.io.sockets.sockets.get(player.socketId)));
  }
  applyCashOutAndRemove(room, player, socket) {
    if (player.reservations.length) this.profileStore.settlePokerSeat({ reservations: player.reservations, profileId: player.profileId, stack: player.stack, operationKey: `poker:cashout:${room.code}:${player.id}:${room.matchId || 'table'}`, roomCode: room.code, matchId: room.matchId || null });
    if (room.buttonPlayerId === player.id && room.players.length > 1) {
      const index = room.players.indexOf(player);
      for (let step = 1; step < room.players.length; step++) {
        const previous = room.players[(index - step + room.players.length) % room.players.length];
        if (previous !== player) { room.buttonPlayerId = previous.id; break; }
      }
    }
    player.stack = 0; player.reservations = []; room.players = room.players.filter(item => item !== player);
    if (player.socketId) this.playerRoom.delete(player.socketId);
    if (socket) this.afterCommit(() => { socket.leave(room.code); socket.emit('room_left'); });
    this.profileStore.markMemberLeft?.({ gameId: 'poker', roomCode: room.code, playerId: player.id });
    if (!room.players.length) this.rooms.delete(room.code);
    this.ensureHost(room); this.addLog(room, `${player.name} cash-out và rời bàn.`);
  }
  leaveRoom(socket, code) {
    const room = this.rooms.get(code), player = this.player(room, socket); if (!room || !player || isServerActionSocket(this, socket)) return this.error(socket, 'Bạn không còn ở bàn Poker này.');
    if (room.phase === 'HAND' && player.inHand) { player.leaveAfterHand = true; this.addLog(room, `${player.name} sẽ cash-out và rời sau hand.`); this.touch(room); this.broadcast(code); return { queued: true }; }
    try { this.cashOutAndRemove(room, player, socket); if (!room.players.length) { this.rooms.delete(room.code); this.saveSoon(); } else { this.touch(room); this.broadcast(code); } return { ok: true }; } catch (error) { return this.error(socket, error.message || 'Không thể cash-out an toàn.'); }
  }
  syncState(socket, code) { const ctx = this.access(socket, code); if (ctx && !ctx.error) socket.emit('game_state', this.buildStateFor(ctx.room, ctx.player.id)); return ctx; }
  handleDisconnect(socket) {
    const code = this.playerRoom.get(socket.id), room = this.rooms.get(code), player = this.player(room, socket); this.playerRoom.delete(socket.id); if (!player) return;
    markDisconnected(player, now(), this.graceMs); this.ensureHost(room);
    const { waiting } = this.updatePaused(room);
    this.addLog(room, `${player.name} mất kết nối; có 120 giây để khôi phục ghế${waiting.includes(player) ? '; hand đang chờ người còn ảnh hưởng.' : '; hand tiếp tục theo các ghế còn cần hành động.'}`); this.touch(room); this.broadcast(code); this.flush();
  }
  legalActions(room, player) {
    if (!player || room.phase !== 'HAND' || room.currentPlayerId !== player.id || this.updatePaused(room).waiting.length) return null;
    const toCall = Math.max(0, room.currentBet - player.roundBet), maxTotal = player.roundBet + player.stack;
    const canRaise = player.lastActionBet === null || room.currentBet - player.lastActionBet >= room.lastFullRaise;
    return { toCall, callAmount: Math.min(toCall, player.stack), canFold: true, canCheck: toCall === 0, canCall: toCall > 0, canBet: room.currentBet === 0 && player.stack > 0,
      canRaise: toCall > 0 && canRaise && maxTotal > room.currentBet, canAllIn: player.stack > 0, minBetTotal: BIG_BLIND, minRaiseTotal: room.currentBet + room.lastFullRaise, maxTotal, raiseReopened: canRaise };
  }
  buildStateFor(room, playerId) {
    const me = this.byId(room, playerId), wallet = me?.profileId ? this.profileStore.publicProfile(me.profileId)?.wallet || null : null;
    return { gameId: 'poker', roomCode: room.code, phase: room.phase, rulesVersion: room.rulesVersion, revision: room.revision, matchId: room.matchId, paused: room.paused,
      blinds: { small: SMALL_BLIND, big: BIG_BLIND }, buyIn: { min: MIN_BUY_IN, max: MAX_BUY_IN, minToStart: MIN_TO_START }, myId: playerId, buttonPlayerId: room.buttonPlayerId,
      smallBlindPlayerId: room.smallBlindPlayerId || null, bigBlindPlayerId: room.bigBlindPlayerId || null, currentPlayerId: room.currentPlayerId, street: room.street, currentBet: room.currentBet,
      lastFullRaise: room.lastFullRaise, community: room.community, myHoleCards: me?.holeCards || [], myStack: me?.stack || 0, wallet, legalActions: this.legalActions(room, me),
      pot: room.players.reduce((sum, player) => sum + player.totalContribution, 0), sidePots: contributionPots(room.players).map(pot => ({ amount: pot.amount, eligiblePlayerIds: pot.eligible })), result: room.result, log: room.log,
      players: room.players.map(player => ({ id: player.id, name: cleanName(player.name), avatar: player.avatar, isHost: player.isHost, ready: player.ready, connected: player.connected, stack: player.stack, balance: player.stack,
        inHand: player.inHand, folded: player.folded, allIn: player.allIn, roundBet: player.roundBet, totalContribution: player.totalContribution, leaveAfterHand: player.leaveAfterHand, winStreak: player.winStreak || 0, revealedHand: room.phase === 'RESULT' ? (player.inHand && !player.folded ? player.holeCards : undefined) : undefined })) };
  }
  broadcast(code) { const room = this.rooms.get(code); if (!room) return; room.updatedAt = now(); this.persistRoom(room); this.afterCommit(() => { for (const player of room.players) { const socket = this.io.sockets.sockets.get(player.socketId); if (socket && player.connected) socket.emit('game_state', this.buildStateFor(room, player.id)); } notifyRoomCommitted(this, code); this.saveSoon(); }); }
  expireRoom(room) {
    return this.commitRoom(room, () => {
      // An abandoned hand is cancelled: return every wager, including folded
      // contributions, before cashing out the table's redistributed stacks.
      if (room.phase === 'HAND') for (const player of room.players) {
        player.stack += player.totalContribution; player.totalContribution = 0; player.roundBet = 0;
      }
      room.phase = 'CANCELLED'; room.currentPlayerId = null;
      for (const player of [...room.players]) this.cashOutAndRemove(room, player);
      this.rooms.delete(room.code); this.flush();
    });
  }
  cleanup() {
    const at = now();
    for (const room of [...this.rooms.values()]) {
      this.updatePaused(room);
      if (room.phase === 'HAND' && room.reconnectPolicyVersion !== 2 && !room.players.some(player => player.inHand && player.connected) && at - room.updatedAt > 12 * 3600000) {
        try { this.expireRoom(room); } catch (error) { console.error('Không thể cash-out bàn Poker hết hạn:', error.message); }
      } else if (room.phase !== 'HAND') {
        const expired = room.players.filter(player => isReconnectExpired(player, at, this.graceMs));
        try { expired.forEach(player => this.cashOutAndRemove(room, player)); if (!room.players.length) this.rooms.delete(room.code); else if (expired.length) { this.touch(room); this.broadcast(room.code); } } catch (error) { console.error('Không thể cash-out ghế Poker hết hạn:', error.message); }
      }
    }
  }
  load() {
    const recovered = new Map();
    if (this.storageFile && fs.existsSync(this.storageFile)) {
      try {
        const saved = runStorageOperation(this.storageDiagnostics, 'manager:poker-json', 'read', 'legacy-json-read', () => {
          const data = JSON.parse(fs.readFileSync(this.storageFile, 'utf8'));
          if (data.version !== 1 || !Array.isArray(data.rooms)) throw new Error('Định dạng lưu Poker không hợp lệ');
          return data;
        }, { recoveryVerified: true, failureCode: 'LEGACY_ROOM_READ_FAILED' });
        for (const room of saved.rooms) recovered.set(room.code, room);
      } catch (error) { console.error('Không đọc được tệp Poker:', error.message); this.storageError = true; }
    }
    // A committed database snapshot wins even if the JSON export is missing,
    // older, or contains a room already closed by a committed cash-out.
    for (const saved of this.profileStore?.gameSnapshots?.('poker') || []) {
      if (saved.closedAt) recovered.delete(saved.roomCode);
      else recovered.set(saved.roomCode, JSON.parse(saved.stateJson));
    }
    for (const room of recovered.values()) {
      restoreDisconnectedSeats(room.players, now(), this.graceMs);
      this.rooms.set(room.code, room); this.updatePaused(room);
    }
    for (const room of [...this.rooms.values()]) {
      try {
        if (now() - room.updatedAt > 12 * 3600000 && room.reconnectPolicyVersion !== 2) this.expireRoom(room);
        else this.persistRoom(room);
      } catch (error) { console.error('Không thể khôi phục an toàn bàn Poker:', error.message); this.storageError = true; }
    }
  }
  saveSoon() { if (!this.storageFile || this.storageError || this.saveTimer) return; this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 100); this.saveTimer.unref(); }
  flush() { if (this.mutationDepth) { this.flushPending = true; return; } if (!this.storageFile || this.storageError) return; try { runStorageOperation(this.storageDiagnostics, 'export:poker', 'export', 'room-json-export', () => { fs.mkdirSync(path.dirname(this.storageFile), { recursive: true }); fs.writeFileSync(`${this.storageFile}.tmp`, JSON.stringify({ version: 1, rooms: [...this.rooms.values()] }), { mode: 0o600 }); fs.renameSync(`${this.storageFile}.tmp`, this.storageFile); }, { failureCode: 'ROOM_JSON_EXPORT_FAILED' }); } catch (error) { console.error('Không lưu được dữ liệu phòng Poker:', error.message); } }
}

module.exports = { PokerManager, SMALL_BLIND, BIG_BLIND, MIN_BUY_IN, MAX_BUY_IN, contributionPots, refundUncalled };
