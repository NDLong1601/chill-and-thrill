'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { runStorageOperation } = require('../../platform/storageDiagnostics');
const { createPhomDeck, shuffle, compareCards, cardPoints, labelCard, classifyMeld, bestMeldPlan, canDiscard, validateMeldGroups } = require('./phomDeck');
const { leaveCompletedSeats, loadFixedRooms } = require('../../platform/completedRoom');
const { DEFAULT_RECONNECT_GRACE_MS, markDisconnected, markConnected, isReconnectExpired, reconnectWaiters, isServerActionSocket, serverActionPlayer } = require('../../platform/reconnectGrace');

const AVATARS = ['🕶️', '🥷', '💻', '🔓', '🎲', '🏎️'];
const ACTIVE_PHASES = new Set(['DRAW_OR_EAT', 'DISCARD', 'LAYDOWN']);
const STAKE = 10;
const DEN_MULTIPLIER = 6;
const MOM_SCORE = 150;
const now = () => Date.now();
const cleanName = value => require('../../../public/js/game-values').cleanDisplayName(value) || 'Player';
const maxLoss = (playerCount, stake = STAKE) => DEN_MULTIPLIER * stake * Math.max(1, playerCount - 1);

class PhomManager {
  constructor(io, options = {}) {
    this.io = io; this.rooms = new Map(); this.playerRoom = new Map(); this.storageFile = options.storageFile || null;
    this.graceMs = options.graceMs ?? DEFAULT_RECONNECT_GRACE_MS; this.codeTaken = typeof options.codeTaken === 'function' ? options.codeTaken : () => false;
    this.profileForSocket = typeof options.profileForSocket === 'function' ? options.profileForSocket : () => null;
    this.profileStore = options.profileStore; this.onMatchCompleted = typeof options.onMatchCompleted === 'function' ? options.onMatchCompleted : null;
    this.shuffle = typeof options.shuffle === 'function' ? options.shuffle : shuffle;
    this.storageDiagnostics = options.storageDiagnostics || this.profileStore?.storageDiagnostics || null;
    this.load();
    require('../../platform/turnTimeouts').attachGameClock(this, 'phom');
    require('../../platform/coinRoomTransactions').installCoinRoomTransactions(this, 'phom'); this.cleanupTimer = setInterval(() => this.cleanup(), 1000); this.cleanupTimer.unref();
  }
  close() { clearInterval(this.cleanupTimer); clearTimeout(this.saveTimer); this.flush(); }
  error(socket, message) { socket.emit('game_error', { message }); return { error: message }; }
  code() { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code; do { code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (this.rooms.has(code) || this.codeTaken(code)); return code; }
  newPlayer(socket, name, avatar, isHost = false) { const profile = this.profileForSocket(socket); return { id: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'), socketId: socket.id, profileId: profile?.id || null, name: cleanName(profile?.displayName || name), avatar: profile?.avatar || (AVATARS.includes(avatar) ? avatar : AVATARS[0]), isHost, connected: true, disconnectedAt: null, ready: false, hand: [], melds: [], eatenCardIds: [], eatCount: 0, laid: false, score: null, leaveAfterHand: false }; }
  credentials(room, player) { return { roomCode: room.code, playerId: player.id, sessionToken: player.token, gameId: 'phom' }; }
  player(room, socket) { return serverActionPlayer(this, room, socket) || room?.players.find(item => item.socketId === socket.id && item.connected); }
  byId(room, id) { return room.players.find(item => item.id === id); }
  nextPlayerId(room, id) { const index = room.players.findIndex(player => player.id === id); return room.players[(index + 1) % room.players.length].id; }
  refreshReconnectState(room, at = now()) {
    const wasPaused = !!room.paused, waiting = reconnectWaiters(room, at, this.graceMs);
    room.reconnectPaused = waiting.length > 0; room.paused = ACTIVE_PHASES.has(room.phase) && room.reconnectPaused;
    return { wasPaused, waiting };
  }
  bind(socket, room, player) {
    player.name = cleanName(this.profileForSocket(socket)?.displayName || player.name); this.playerRoom.set(socket.id, room.code); socket.join(room.code); player.socketId = socket.id; markConnected(player); const { wasPaused, waiting } = this.refreshReconnectState(room); if (wasPaused && !waiting.length) { this.addLog(room, 'Mọi người đã kết nối lại; ván tiếp tục.'); this.touch(room); } }
  access(socket, code, phases) { const room = this.rooms.get(code), player = this.player(room, socket); if (!room || !player) return this.error(socket, 'Bạn không còn ở trong phòng Phỏm này.'); if (phases && !phases.includes(room.phase)) return this.error(socket, 'Thao tác không phù hợp với giai đoạn hiện tại.'); const { waiting } = this.refreshReconnectState(room); if (!isServerActionSocket(this, socket) && ACTIVE_PHASES.has(room.phase) && waiting.length) return this.error(socket, `Ván đang tạm dừng; chờ ${waiting.map(item => item.name).join(', ')} kết nối lại.`); return { room, player }; }
  ensureHost(room) { if (room.players.some(player => player.isHost && player.connected)) return; const next = room.players.find(player => player.connected) || room.players[0]; room.players.forEach(player => { player.isHost = player === next; }); }
  touch(room) { room.revision = (room.revision || 0) + 1; room.updatedAt = now(); this.saveSoon(); }
  addLog(room, message) { room.log.unshift({ id: crypto.randomUUID(), message, at: new Date().toISOString() }); room.log = room.log.slice(0, 60); }

  createRoom(socket, name, avatar, config = {}) {
    if (this.playerRoom.has(socket.id)) return { error: 'Hãy rời phòng hiện tại trước khi tạo phòng mới.' };
    if (!this.profileForSocket(socket)) return { error: 'Phỏm cần hồ sơ để giữ coin an toàn.' };
    const stake = require('../../platform/gameRegistry').validateStake('phom', config.stake, config.maxPlayers);
    const player = this.newPlayer(socket, name, avatar, true);
    const room = { code: this.code(), gameId: 'phom', currency: 'coin', phase: 'WAITING', rulesVersion: 'local-v1', stake, maxLoss: maxLoss(2, stake), matchId: null, revision: 0, players: [player], deck: [], discardPile: [], currentPlayerId: null, firstPlayerId: null, drawTurns: 0, maxDrawTurns: 0, chotEligible: false, finishAfterDiscard: false, playedAny: false, eatenEvents: [], denPlayerId: null, reservations: [], result: null, history: [], actionIds: {}, log: [], paused: false, createdAt: now(), updatedAt: now() };
    this.rooms.set(room.code, room); this.bind(socket, room, player); this.addLog(room, `${player.name} tạo bàn Phỏm ${room.code} · đơn vị ${stake} coin.`); this.touch(room); return this.credentials(room, player);
  }
  joinRoom(socket, code, name, avatar) {
    if (this.playerRoom.has(socket.id)) return { error: 'Bạn đang ở trong một phòng khác.' };
    const room = this.rooms.get(code); if (!room) return { error: 'Không tìm thấy phòng Phỏm.' }; if (!this.profileForSocket(socket)) return { error: 'Phỏm cần hồ sơ để giữ coin an toàn.' };
    if (room.phase !== 'WAITING') return { error: 'Ván đang diễn ra. Chỉ người cũ mới có thể khôi phục ghế.' }; if (room.players.length >= 4) return { error: 'Bàn Phỏm đã đủ 4 người.' };
    const profile = this.profileForSocket(socket); if (room.players.some(item => item.profileId === profile.id)) return { error: 'Hồ sơ này đã có ghế trong bàn. Hãy khôi phục ghế cũ.' };
    const player = this.newPlayer(socket, name, avatar); room.players.push(player); room.maxLoss = maxLoss(room.players.length, room.stake); this.bind(socket, room, player); this.addLog(room, `${player.name} tham gia bàn.`); this.touch(room); this.broadcast(code); return this.credentials(room, player);
  }
  resumeRoom(socket, code, token) {
    const room = this.rooms.get(code), player = room?.players.find(item => typeof token === 'string' && item.token === token); if (!player) return { error: 'Phiên Phỏm đã hết hạn hoặc phòng không còn tồn tại.' };
    const profile = this.profileForSocket(socket); if (player.profileId && player.profileId !== profile?.id) return { error: 'Ghế này thuộc về một hồ sơ khác.' };
    const active = this.playerRoom.get(socket.id); if (active && active !== code) return { error: 'Bạn đang ở phòng khác.' }; if (player.connected && player.socketId !== socket.id) return { error: 'Ghế này đang mở ở cửa sổ khác.' };
    this.bind(socket, room, player); this.ensureHost(room); this.addLog(room, `${player.name} đã nối lại.`); this.touch(room); this.broadcast(code); return this.credentials(room, player);
  }
  setReady(socket, code, ready) { const ctx = this.access(socket, code, ['WAITING']); if (!ctx || ctx.error) return ctx; ctx.player.ready = !!ready; this.touch(ctx.room); this.broadcast(code); }
  startGame(socket, code) {
    const ctx = this.access(socket, code, ['WAITING']); if (!ctx || ctx.error) return ctx; const { room, player } = ctx;
    if (!player.isHost) return this.error(socket, 'Chỉ chủ phòng được bắt đầu ván.'); if (room.players.length < 2 || room.players.length > 4) return this.error(socket, 'Phỏm local v1 cần từ 2 đến 4 người.'); if (room.players.some(item => !item.ready || !item.connected)) return this.error(socket, 'Tất cả người chơi đang kết nối cần bấm Sẵn sàng.');
    try { this.startRound(room); this.broadcast(code); return { ok: true }; } catch (error) { return this.error(socket, error.message || 'Không thể giữ coin để bắt đầu ván.'); }
  }
  startRound(room) {
    room.reconnectPolicyVersion = 2;
    this.profileStore.preflightFixedGameStart({ gameId: 'phom', stake: room.stake, profileIds: room.players.map(player => player.profileId) });
    const matchId = crypto.randomUUID(), heldAmount = maxLoss(room.players.length, room.stake), hold = this.profileStore.reserveMany({ reservations: room.players.map(player => ({ profileId: player.profileId, amount: heldAmount })), operationKey: `phom:reserve:${matchId}`, roomCode: room.code, matchId, currency: 'coin' });
    room.matchId = matchId; room.reservations = hold.held; room.maxLoss = heldAmount; room.deck = this.shuffle(createPhomDeck()); room.discardPile = []; room.firstPlayerId = room.players[0].id; room.currentPlayerId = room.firstPlayerId; room.phase = 'DISCARD'; room.drawTurns = 0; room.maxDrawTurns = room.players.length * 4 - 1; room.chotEligible = false; room.finishAfterDiscard = false; room.playedAny = false; room.eatenEvents = []; room.denPlayerId = null; room.result = null; room.actionIds = {}; room.paused = false; room.revision = 0;
    let cursor = 0; room.players.forEach((player, index) => { const count = index === 0 ? 10 : 9; player.hand = room.deck.slice(cursor, cursor + count).sort(compareCards); cursor += count; player.ready = false; player.melds = []; player.eatenCardIds = []; player.eatCount = 0; player.laid = false; player.score = null; player.leaveAfterHand = false; }); room.deck = room.deck.slice(cursor);
    this.addLog(room, `Đã giữ tối đa ${heldAmount} coin/người trước khi chia. ${this.byId(room, room.firstPlayerId).name} đánh lá đầu tiên.`); this.touch(room); this.flush();
  }
  verifyAction(room, data) { if (!Number.isInteger(data?.expectedRevision) || data.expectedRevision !== room.revision) return 'Trạng thái đã thay đổi. Vui lòng thao tác lại.'; if (typeof data?.actionId !== 'string' || data.actionId.length < 8 || data.actionId.length > 128) return 'Thiếu mã thao tác hợp lệ.'; return room.actionIds[data.actionId] ? 'duplicate' : null; }
  rememberAction(room, actionId) { room.actionIds[actionId] = true; const ids = Object.keys(room.actionIds); if (ids.length > 200) ids.slice(0, ids.length - 200).forEach(id => delete room.actionIds[id]); }
  action(socket, code, data) {
    const ctx = this.access(socket, code); if (!ctx || ctx.error) return ctx; const invalid = this.verifyAction(ctx.room, data); if (invalid === 'duplicate') return; if (invalid) return this.error(socket, invalid);
    let completed = false;
    if (data.action === 'draw') completed = this.draw(socket, ctx.room, ctx.player);
    else if (data.action === 'eat') completed = this.eat(socket, ctx.room, ctx.player, data);
    else if (data.action === 'discard') completed = this.discard(socket, ctx.room, ctx.player, data.cardId);
    else if (data.action === 'declare_u') completed = this.declareU(socket, ctx.room, ctx.player);
    else if (data.action === 'lay_down') completed = this.layDown(socket, ctx.room, ctx.player, data);
    else if (data.action === 'cancel_before_first_discard') completed = this.cancelBeforeFirstDiscard(socket, ctx.room, ctx.player);
    else if (data.action === 'play_again') completed = this.playAgain(socket, ctx.room, ctx.player);
    else return this.error(socket, 'Hành động Phỏm không hợp lệ.');
    if (completed === false || completed?.error) return; this.rememberAction(ctx.room, data.actionId); this.touch(ctx.room); this.broadcast(code);
  }
  requireTurn(socket, room, player) { if (room.currentPlayerId !== player.id) { this.error(socket, 'Chưa đến lượt của bạn.'); return false; } return true; }
  draw(socket, room, player) {
    if (room.phase !== 'DRAW_OR_EAT' || !this.requireTurn(socket, room, player)) return false; if (!room.deck.length) return this.error(socket, 'Chồng bài đã hết; ván chuyển sang hạ bài.');
    const card = room.deck.shift(); player.hand.push(card); player.hand.sort(compareCards); room.drawTurns += 1; room.finishAfterDiscard = room.drawTurns >= room.maxDrawTurns; room.phase = 'DISCARD'; room.chotEligible = false; this.addLog(room, `${player.name} bốc một lá từ nọc.`); return true;
  }
  eat(socket, room, player, data) {
    if (room.phase !== 'DRAW_OR_EAT' || !this.requireTurn(socket, room, player)) return false; const discard = room.discardPile.at(-1); if (!discard) return this.error(socket, 'Không có lá vừa đánh để ăn.');
    const candidate = [...player.hand, discard.card], checked = validateMeldGroups(candidate, data.melds, [discard.card.id]); if (!checked || !bestMeldPlan(candidate, [...player.eatenCardIds, discard.card.id])) return this.error(socket, 'Lá ăn và các lá đã ăn phải thuộc các phỏm hợp lệ, không chồng lấn.');
    room.discardPile.pop(); player.hand.push(discard.card); player.hand.sort(compareCards); player.eatenCardIds.push(discard.card.id); player.eatCount += 1; const amount = room.chotEligible ? room.stake * 2 : room.stake;
    room.eatenEvents.push({ eaterId: player.id, discardedById: discard.playerId, cardId: discard.card.id, amount, chot: room.chotEligible }); if (player.eatCount >= 3) room.denPlayerId = player.id;
    room.drawTurns += 1; room.finishAfterDiscard = room.drawTurns >= room.maxDrawTurns; room.phase = 'DISCARD'; room.chotEligible = false; this.addLog(room, `${player.name} ăn ${labelCard(discard.card)}${amount > room.stake ? ' (ăn chốt)' : ''}; lá này phải nằm trong phỏm khi hạ.`); return true;
  }
  discard(socket, room, player, cardId) {
    if (room.phase !== 'DISCARD' || !this.requireTurn(socket, room, player)) return false; if (typeof cardId !== 'string') return this.error(socket, 'Hãy chọn đúng một lá để đánh.'); const card = player.hand.find(item => item.id === cardId); if (!card) return this.error(socket, 'Bạn chỉ có thể đánh bài trên tay mình.');
    if (!canDiscard(player.hand, cardId, player.eatenCardIds)) return this.error(socket, 'Không thể đánh lá đã ăn hoặc phá phỏm bắt buộc của lá đã ăn.');
    player.hand = player.hand.filter(item => item.id !== cardId); room.discardPile.push({ card, playerId: player.id }); room.playedAny = true; this.addLog(room, `${player.name} đánh ${labelCard(card)}.`);
    if (room.finishAfterDiscard) { this.beginLaydown(room); return true; }
    room.currentPlayerId = this.nextPlayerId(room, player.id); room.phase = 'DRAW_OR_EAT'; room.chotEligible = room.drawTurns === room.maxDrawTurns - 1; return true;
  }
  declareU(socket, room, player) {
    if (room.phase !== 'DISCARD' || !this.requireTurn(socket, room, player)) return false; const plan = bestMeldPlan(player.hand, player.eatenCardIds); if (!plan || plan.leftoverCards.length) return this.error(socket, 'Chỉ được báo ù khi toàn bộ bài trên tay tạo thành phỏm hợp lệ.'); player.melds = plan.melds.map(cards => ({ kind: classifyMeld(cards).kind, cards })); player.laid = true; player.score = 0; this.finishRound(room, player, 'Ù: toàn bộ bài tạo thành phỏm.'); return true;
  }
  beginLaydown(room) { room.phase = 'LAYDOWN'; room.currentPlayerId = room.firstPlayerId; room.chotEligible = false; room.finishAfterDiscard = false; this.addLog(room, 'Đã hết vòng bốc/ăn. Mọi người lần lượt hạ phỏm và gửi bài vào phỏm đã hạ.'); }
  layDown(socket, room, player, data) {
    if (room.phase !== 'LAYDOWN' || !this.requireTurn(socket, room, player)) return false; const checked = validateMeldGroups(player.hand, data.melds || [], player.eatenCardIds); if (!checked) return this.error(socket, 'Các phỏm hạ không hợp lệ hoặc còn thiếu lá đã ăn.');
    const ownMelds = checked.melds.map(meld => ({ kind: meld.kind, cards: meld.cards })), sent = new Set(), pendingTargets = new Map();
    if (!Array.isArray(data.sends)) return this.error(socket, 'Dữ liệu gửi bài không hợp lệ.');
    for (const item of data.sends) {
      if (!item || typeof item.cardId !== 'string' || typeof item.targetPlayerId !== 'string' || !Number.isInteger(item.targetMeldIndex) || sent.has(item.cardId) || checked.usedIds.has(item.cardId)) return this.error(socket, 'Gửi bài không hợp lệ hoặc trùng lá.');
      const card = player.hand.find(candidate => candidate.id === item.cardId), target = this.byId(room, item.targetPlayerId), targetMeld = target?.melds?.[item.targetMeldIndex]; if (!card || !target || target.id === player.id || !target.laid || !targetMeld) return this.error(socket, 'Chỉ được gửi vào phỏm hợp lệ đã hạ trước đó.');
      const key = `${target.id}:${item.targetMeldIndex}`, current = pendingTargets.get(key)?.meld || targetMeld, extended = classifyMeld([...current.cards, card]); if (!extended) return this.error(socket, `Không thể gửi ${labelCard(card)} vào phỏm đã chọn.`); pendingTargets.set(key, { targetMeld, meld: extended }); sent.add(card.id);
    }
    for (const { targetMeld, meld } of pendingTargets.values()) { targetMeld.cards = meld.cards; targetMeld.kind = meld.kind; }
    player.melds = ownMelds; player.hand = player.hand.filter(card => !sent.has(card.id)); player.laid = true; const meldIds = new Set(player.melds.flatMap(meld => meld.cards.map(card => card.id))); player.score = player.melds.length ? player.hand.filter(card => !meldIds.has(card.id)).reduce((sum, card) => sum + cardPoints(card), 0) : MOM_SCORE;
    this.addLog(room, `${player.name} hạ ${player.melds.length} phỏm${sent.size ? ` và gửi ${sent.size} lá` : ''}${player.melds.length ? `; rác còn ${player.score} điểm.` : '; móm.'}`);
    const remaining = room.players.filter(item => !item.laid); if (!remaining.length) { this.finishRound(room, null, 'Hết vòng: tính điểm rác và các khoản ăn bài.'); return true; }
    room.currentPlayerId = this.nextPlayerId(room, player.id); while (this.byId(room, room.currentPlayerId).laid) room.currentPlayerId = this.nextPlayerId(room, room.currentPlayerId); return true;
  }
  buildTransfers(room, uWinner) {
    const deltas = new Map(room.players.map(player => [player.id, 0])), transfers = [];
    const add = (from, to, amount, kind) => { if (!amount || from === to) return; deltas.set(from, deltas.get(from) - amount); deltas.set(to, deltas.get(to) + amount); transfers.push({ fromPlayerId: from, toPlayerId: to, amount, kind }); };
    if (room.denPlayerId) {
      const offender = this.byId(room, room.denPlayerId); for (const player of room.players) if (player.id !== offender.id) add(offender.id, player.id, DEN_MULTIPLIER * room.stake, 'DEN');
      for (const event of room.eatenEvents) if (event.eaterId !== offender.id) add(event.eaterId, event.discardedById, event.amount, event.chot ? 'EAT_CHOT' : 'EAT');
      return { deltas, transfers, kind: 'DEN', winner: null, reason: `${offender.name} ăn ba lá: đền ${DEN_MULTIPLIER} cược cho mỗi đối thủ; thay thế tiền ăn và điểm của người này.` };
    }
    for (const event of room.eatenEvents) add(event.eaterId, event.discardedById, event.amount, event.chot ? 'EAT_CHOT' : 'EAT');
    if (uWinner) { for (const player of room.players) if (player.id !== uWinner.id) add(player.id, uWinner.id, 4 * room.stake, 'U'); return { deltas, transfers, kind: 'U', winner: uWinner, reason: `${uWinner.name} ù; tiền ù thay thế tiền xếp điểm, còn tiền ăn đã phát sinh vẫn được đối soát.` }; }
    for (let i = 0; i < room.players.length; i++) for (let j = i + 1; j < room.players.length; j++) { const left = room.players[i], right = room.players[j]; if (left.score < right.score) add(right.id, left.id, room.stake, 'SCORE'); else if (right.score < left.score) add(left.id, right.id, room.stake, 'SCORE'); }
    const lowest = Math.min(...room.players.map(player => player.score)); const winners = room.players.filter(player => player.score === lowest); return { deltas, transfers, kind: 'SCORE', winner: winners.length === 1 ? winners[0] : null, reason: winners.length === 1 ? `${winners[0].name} ít điểm rác nhất (${lowest}).` : `Đồng điểm thấp nhất (${lowest}); không có tiền xếp hạng giữa người đồng điểm.` };
  }
  finishRound(room, uWinner, fallbackReason) {
    if (room.phase === 'RESULT') return; if (!uWinner) room.players.forEach(player => { if (player.score === null) { const meldIds = new Set(player.melds.flatMap(meld => meld.cards.map(card => card.id))); player.score = player.melds.length ? player.hand.filter(card => !meldIds.has(card.id)).reduce((sum, card) => sum + cardPoints(card), 0) : MOM_SCORE; } });
    const settlement = this.buildTransfers(room, uWinner), completedAt = new Date().toISOString(); this.profileStore.settleReservations({ reservations: room.reservations, outcomes: room.players.map(player => ({ profileId: player.profileId, delta: settlement.deltas.get(player.id) || 0 })), operationKey: `phom:settle:${room.matchId}`, roomCode: room.code, matchId: room.matchId, note: `Phỏm: ${settlement.reason}` });
    room.phase = 'RESULT'; room.currentPlayerId = null;
    const roundWinnerId = settlement.winner?.id || null;
    room.players.forEach(p => { p.winStreak = (roundWinnerId && p.id === roundWinnerId) ? (p.winStreak || 0) + 1 : 0; });
    room.result = { matchId: room.matchId, kind: settlement.kind, reason: settlement.reason || fallbackReason, completedAt, stake: room.stake, maxLoss: room.maxLoss, winnerId: settlement.winner?.id || null, winnerName: settlement.winner?.name || null, scores: room.players.map(player => ({ playerId: player.id, name: player.name, score: player.score, mom: player.score === MOM_SCORE, meldCount: player.melds.length })), transfers: settlement.transfers, outcomes: room.players.map(player => ({ playerId: player.id, name: player.name, delta: settlement.deltas.get(player.id) || 0 })) }; room.history.unshift(room.result); room.history = room.history.slice(0, 50); this.addLog(room, room.result.reason || fallbackReason); this.flush();
    if (this.onMatchCompleted) this.onMatchCompleted({ matchId: room.matchId, gameId: 'phom', currency: 'coin', roomCode: room.code, completedAt, players: room.players.map(player => ({ profileId: player.profileId, outcome: player.id === settlement.winner?.id ? 'WIN' : 'LOSS' })), result: room.result });
    leaveCompletedSeats(this, room, 'phom');
    room.maxLoss = maxLoss(room.players.length || 2, room.stake); this.flush();
  }
  cancelBeforeFirstDiscard(socket, room, player) { if (!ACTIVE_PHASES.has(room.phase) || !player.isHost || room.playedAny) return this.error(socket, 'Chỉ chủ phòng có thể hủy trước lá đánh đầu tiên.'); this.profileStore.releaseReservations({ reservations: room.reservations, operationKey: `phom:cancel:${room.matchId}`, roomCode: room.code, matchId: room.matchId, note: 'Hoàn coin: chủ phòng hủy trước lá đầu Phỏm' }); this.resetWaiting(room); this.addLog(room, 'Ván đã hủy trước lá đầu; toàn bộ coin giữ đã được hoàn.'); this.flush(); return true; }
  resetWaiting(room) { room.phase = 'WAITING'; room.matchId = null; room.reservations = []; room.deck = []; room.discardPile = []; room.currentPlayerId = null; room.firstPlayerId = null; room.drawTurns = 0; room.maxDrawTurns = 0; room.chotEligible = false; room.finishAfterDiscard = false; room.playedAny = false; room.eatenEvents = []; room.denPlayerId = null; room.result = null; room.actionIds = {}; room.players.forEach(player => { player.hand = []; player.ready = false; player.melds = []; player.eatenCardIds = []; player.eatCount = 0; player.laid = false; player.score = null; player.leaveAfterHand = false; }); }
  playAgain(socket, room, player) {
    if (room.phase !== 'RESULT' || !player.isHost) return this.error(socket, 'Chỉ chủ bàn được chia ván tiếp.');
    if (room.players.length < 2) return this.error(socket, 'Cần ít nhất 2 người để chơi tiếp.');
    if (room.players.some(item => !item.connected)) return this.error(socket, 'Đang chờ người chơi kết nối lại để chia ván tiếp.');
    try { this.startRound(room); return true; }
    catch (error) { return this.error(socket, error.message || 'Không đủ coin để chia ván tiếp.'); }
  }
  leaveRoom(socket, code) { const room = this.rooms.get(code), player = this.player(room, socket); if (!room || !player || isServerActionSocket(this, socket)) return this.error(socket, 'Bạn không còn ở trong phòng Phỏm này.'); if (ACTIVE_PHASES.has(room.phase)) { player.leaveAfterHand = true; this.addLog(room, `${player.name} sẽ rời bàn sau ván này.`); this.touch(room); this.broadcast(code); return { queued: true }; } room.players = room.players.filter(item => item !== player); this.playerRoom.delete(socket.id); socket.leave(code); socket.emit('room_left'); if (!room.players.length) { this.rooms.delete(code); this.saveSoon(); return; } room.maxLoss = maxLoss(room.players.length, room.stake); this.ensureHost(room); this.addLog(room, `${player.name} rời phòng.`); this.touch(room); this.broadcast(code); }
  syncState(socket, code) { const ctx = this.access(socket, code); if (ctx && !ctx.error) socket.emit('game_state', this.buildStateFor(ctx.room, ctx.player.id)); return ctx; }
  handleDisconnect(socket) { const code = this.playerRoom.get(socket.id), room = this.rooms.get(code), player = this.player(room, socket); this.playerRoom.delete(socket.id); if (!player) return; markDisconnected(player, now(), this.graceMs); this.ensureHost(room); this.refreshReconnectState(room); this.addLog(room, `${player.name} mất kết nối; có 120 giây để khôi phục ghế${ACTIVE_PHASES.has(room.phase) ? ', sau đó server tự đi hành động hợp lệ theo luật Phỏm.' : '.'}`); this.touch(room); this.broadcast(code); this.flush(); }
  buildStateFor(room, playerId) {
    const me = this.byId(room, playerId), top = room.discardPile.at(-1), suggestion = me && ACTIVE_PHASES.has(room.phase) ? bestMeldPlan(me.hand, me.eatenCardIds) : null;
    return { gameId: 'phom', currency: this.profileStore.reservationCurrency(room.reservations), wallet: me?.profileId ? this.profileStore.walletForUpdate(me.profileId, this.profileStore.reservationCurrency(room.reservations)) : null, roomCode: room.code, phase: room.phase, rulesVersion: room.rulesVersion, stake: room.stake, maxLoss: room.maxLoss, revision: room.revision, matchId: room.matchId, myId: playerId, currentPlayerId: room.currentPlayerId, firstPlayerId: room.firstPlayerId, paused: room.paused, playedAny: room.playedAny, stockCount: room.deck.length, discardTop: top?.card || null, discardById: top?.playerId || null, chotEligible: room.chotEligible, drawTurns: room.drawTurns, maxDrawTurns: room.maxDrawTurns, myHand: me?.hand || [], myEatenCardIds: me?.eatenCardIds || [], myDiscardableCardIds: me && room.phase === 'DISCARD' ? me.hand.filter(card => canDiscard(me.hand, card.id, me.eatenCardIds)).map(card => card.id) : [], mySuggestion: suggestion ? { melds: suggestion.melds.map(cards => cards.map(card => card.id)), points: suggestion.points } : null, publicMelds: room.players.filter(player => player.laid).map(player => ({ playerId: player.id, name: player.name, melds: player.melds.map(meld => ({ kind: meld.kind, cards: meld.cards })), score: player.score })), result: room.result, log: room.log, players: room.players.map(player => ({ id: player.id, name: cleanName(player.name), avatar: player.avatar, isHost: player.isHost, ready: player.ready, connected: player.connected, handCount: player.hand.length, laid: player.laid, leaveAfterHand: player.leaveAfterHand, winStreak: player.winStreak || 0, balance: this.profileStore?.publicProfile(player.profileId)?.balances?.[this.profileStore.reservationCurrency(room.reservations) || 'coin']?.available ?? 1000, revealedHand: room.phase === 'RESULT' ? (player.hand || []) : undefined })) };
  }
  broadcast(code) { const room = this.rooms.get(code); if (!room) return; room.updatedAt = now(); for (const player of room.players) { const socket = this.io.sockets.sockets.get(player.socketId); if (socket && player.connected) socket.emit('game_state', this.buildStateFor(room, player.id)); } this.saveSoon(); }
  cleanup() {
    const at = now();
    for (const room of this.rooms.values()) {
      const { wasPaused, waiting } = this.refreshReconnectState(room, at);
      if (wasPaused && !waiting.length && ACTIVE_PHASES.has(room.phase)) { this.addLog(room, 'Hết thời gian khôi phục; ván tiếp tục, server sẽ tự đi hành động hợp lệ theo luật khi ghế vắng đến lượt.'); this.touch(room); this.broadcast(room.code); }
      if (['WAITING', 'RESULT'].includes(room.phase)) {
        const expired = room.players.filter(player => isReconnectExpired(player, at, this.graceMs));
        if (expired.length) {
          room.players = room.players.filter(player => !expired.includes(player));
          expired.forEach(player => this.profileStore.markMemberLeft?.({ gameId: 'phom', roomCode: room.code, playerId: player.id }));
          this.ensureHost(room); room.maxLoss = maxLoss(room.players.length || 2, room.stake);
          if (!room.players.length) this.rooms.delete(room.code); else { this.touch(room); this.broadcast(room.code); }
        }
      }
      if (ACTIVE_PHASES.has(room.phase) && room.reconnectPolicyVersion !== 2 && !room.players.some(player => player.connected) && at - room.updatedAt > 12 * 3600000) { try { this.profileStore.expireFixedRoom({ gameId: 'phom', currency: 'coin', roomCode: room.code, matchId: room.matchId }); } catch (error) { console.error('Không hoàn coin phòng Phỏm hết hạn:', error.message); continue; } this.rooms.delete(room.code); this.saveSoon(); }
      if (room.phase === 'RESULT' && !room.players.some(player => player.connected) && at - room.updatedAt > 12 * 3600000) { this.rooms.delete(room.code); this.saveSoon(); }
    }
  }
  load() { loadFixedRooms(this, 'phom', room => { room.players.forEach(player => { player.melds ||= []; player.eatenCardIds ||= []; player.eatCount ||= 0; player.laid ||= false; }); room.discardPile ||= []; room.actionIds ||= {}; room.eatenEvents ||= []; room.history ||= []; room.log ||= []; this.refreshReconnectState(room); }); }
  saveSoon() { if (!this.storageFile || this.storageError || this.saveTimer) return; this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 100); this.saveTimer.unref(); }
  flush() { if (!this.storageFile || this.storageError) return; try { runStorageOperation(this.storageDiagnostics, 'export:phom', 'export', 'room-json-export', () => { fs.mkdirSync(path.dirname(this.storageFile), { recursive: true }); fs.writeFileSync(`${this.storageFile}.tmp`, JSON.stringify({ version: 1, rooms: [...this.rooms.values()] }), { mode: 0o600 }); fs.renameSync(`${this.storageFile}.tmp`, this.storageFile); }, { failureCode: 'ROOM_JSON_EXPORT_FAILED' }); } catch (error) { console.error('Không lưu được dữ liệu phòng Phỏm:', error.message); } }
}

module.exports = { PhomManager, STAKE, DEN_MULTIPLIER, MOM_SCORE, maxLoss };
