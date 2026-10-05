'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { leaveCompletedSeats, loadFixedRooms } = require('../../platform/completedRoom');
const { createSamLocDeck, shuffle, compareCards, classify, formationName, canBeat, labelCard } = require('./samLocDeck');

const AVATARS = ['🕶️', '🥷', '💻', '🔓', '🎲', '🏎️'];
const ACTIVE_PHASES = new Set(['SAM_DECLARATION', 'TURN', 'SAM_PLAY']);
const STAKE = 20;
const SAM_WINDOW_MS = 60000;
const now = () => Date.now();
const cleanName = value => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 18) || 'Player';
const maxLoss = (playerCount, stake = STAKE) => 2 * stake * Math.max(1, playerCount - 1);

class SamLocManager {
  constructor(io, options = {}) {
    this.io = io; this.rooms = new Map(); this.playerRoom = new Map(); this.storageFile = options.storageFile || null;
    this.graceMs = options.graceMs ?? 120000; this.codeTaken = typeof options.codeTaken === 'function' ? options.codeTaken : () => false;
    this.profileForSocket = typeof options.profileForSocket === 'function' ? options.profileForSocket : () => null;
    this.profileStore = options.profileStore; this.onMatchCompleted = typeof options.onMatchCompleted === 'function' ? options.onMatchCompleted : null;
    this.shuffle = typeof options.shuffle === 'function' ? options.shuffle : shuffle;
    this.load(); this.cleanupTimer = setInterval(() => this.cleanup(), 1000); this.cleanupTimer.unref();
  }

  error(socket, message) { socket.emit('game_error', { message }); return { error: message }; }
  close() { clearInterval(this.cleanupTimer); clearTimeout(this.saveTimer); this.flush(); }
  code() { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code; do { code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (this.rooms.has(code) || this.codeTaken(code)); return code; }
  newPlayer(socket, name, avatar, isHost = false) {
    const profile = this.profileForSocket(socket);
    return { id: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'), socketId: socket.id, profileId: profile?.id || null,
      name: profile?.displayName || cleanName(name), avatar: profile?.avatar || (AVATARS.includes(avatar) ? avatar : AVATARS[0]),
      isHost, connected: true, disconnectedAt: null, ready: false, hand: [], leaveAfterHand: false };
  }
  credentials(room, player) { return { roomCode: room.code, playerId: player.id, sessionToken: player.token, gameId: 'sam-loc' }; }
  player(room, socket) { return room?.players.find(item => item.socketId === socket.id && item.connected); }
  byId(room, id) { return room.players.find(item => item.id === id); }
  bind(socket, room, player) {
    this.playerRoom.set(socket.id, room.code); socket.join(room.code); player.socketId = socket.id; player.connected = true; player.disconnectedAt = null;
    if (room.paused && !room.players.some(item => !item.connected)) { room.paused = false; this.addLog(room, 'Mọi người đã kết nối lại; ván tiếp tục.'); this.touch(room); }
  }
  access(socket, code, phases) {
    const room = this.rooms.get(code), player = this.player(room, socket);
    if (!room || !player) return this.error(socket, 'Bạn không còn ở trong phòng Sâm lốc này.');
    if (phases && !phases.includes(room.phase)) return this.error(socket, 'Thao tác không phù hợp với giai đoạn hiện tại.');
    if (ACTIVE_PHASES.has(room.phase) && (room.paused || room.players.some(item => !item.connected))) return this.error(socket, 'Ván đang tạm dừng do có người mất kết nối.');
    return { room, player };
  }
  ensureHost(room) { if (room.players.some(item => item.isHost && item.connected)) return; const next = room.players.find(item => item.connected) || room.players[0]; room.players.forEach(item => { item.isHost = item === next; }); }
  touch(room) { room.revision = (room.revision || 0) + 1; room.updatedAt = now(); this.saveSoon(); }
  addLog(room, message) { room.log.unshift({ id: crypto.randomUUID(), message, at: new Date().toISOString() }); room.log = room.log.slice(0, 60); }
  nextPlayerId(room, id) { const index = room.players.findIndex(player => player.id === id); return room.players[(index + 1) % room.players.length].id; }

  createRoom(socket, name, avatar) {
    if (this.playerRoom.has(socket.id)) return { error: 'Hãy rời phòng hiện tại trước khi tạo phòng mới.' };
    if (!this.profileForSocket(socket)) return { error: 'Sâm lốc cần hồ sơ để giữ chip an toàn.' };
    const player = this.newPlayer(socket, name, avatar, true);
    const room = { code: this.code(), gameId: 'sam-loc', phase: 'WAITING', rulesVersion: 'local-v1', stake: STAKE, maxLoss: maxLoss(2), matchId: null, revision: 0,
      players: [player], deck: [], currentPlayerId: null, leaderId: null, topPlay: null, passedIds: [], initialRequiredCardId: null, playedAny: false,
      samResponses: {}, samDeadlineAt: null, samDeclarerId: null, oneCall: null, actionIds: {}, reservations: [], result: null, history: [], log: [], paused: false, createdAt: now(), updatedAt: now() };
    this.rooms.set(room.code, room); this.bind(socket, room, player); this.addLog(room, `${player.name} tạo bàn Sâm lốc ${room.code} · cược cơ bản ${STAKE} chip.`); this.touch(room);
    return this.credentials(room, player);
  }
  joinRoom(socket, code, name, avatar) {
    if (this.playerRoom.has(socket.id)) return { error: 'Bạn đang ở trong một phòng khác.' };
    const room = this.rooms.get(code); if (!room) return { error: 'Không tìm thấy phòng Sâm lốc.' };
    if (!this.profileForSocket(socket)) return { error: 'Sâm lốc cần hồ sơ để giữ chip an toàn.' };
    if (room.phase !== 'WAITING') return { error: 'Ván đang diễn ra. Chỉ người cũ mới có thể khôi phục ghế.' };
    if (room.players.length >= 5) return { error: 'Bàn Sâm lốc đã đủ 5 người.' };
    const profile = this.profileForSocket(socket); if (room.players.some(item => item.profileId === profile.id)) return { error: 'Hồ sơ này đã có ghế trong bàn. Hãy khôi phục ghế cũ.' };
    const player = this.newPlayer(socket, name, avatar); room.players.push(player); room.maxLoss = maxLoss(room.players.length, room.stake); this.bind(socket, room, player); this.addLog(room, `${player.name} tham gia bàn.`); this.touch(room); this.broadcast(code);
    return this.credentials(room, player);
  }
  resumeRoom(socket, code, token) {
    const room = this.rooms.get(code), player = room?.players.find(item => typeof token === 'string' && item.token === token);
    if (!player) return { error: 'Phiên Sâm lốc đã hết hạn hoặc phòng không còn tồn tại.' };
    const profile = this.profileForSocket(socket); if (player.profileId && player.profileId !== profile?.id) return { error: 'Ghế này thuộc về một hồ sơ khác.' };
    const active = this.playerRoom.get(socket.id); if (active && active !== code) return { error: 'Bạn đang ở phòng khác.' };
    if (player.connected && player.socketId !== socket.id) return { error: 'Ghế này đang mở ở cửa sổ khác.' };
    this.bind(socket, room, player); this.ensureHost(room); this.addLog(room, `${player.name} đã nối lại.`); this.maybeCloseSamWindow(room); this.touch(room); this.broadcast(code); return this.credentials(room, player);
  }
  setReady(socket, code, ready) { const ctx = this.access(socket, code, ['WAITING']); if (!ctx || ctx.error) return ctx; ctx.player.ready = !!ready; this.touch(ctx.room); this.broadcast(code); }
  startGame(socket, code) {
    const ctx = this.access(socket, code, ['WAITING']); if (!ctx || ctx.error) return ctx;
    const { room, player } = ctx;
    if (!player.isHost) return this.error(socket, 'Chỉ chủ phòng được bắt đầu ván.');
    if (room.players.length < 2 || room.players.length > 5) return this.error(socket, 'Sâm lốc cần từ 2 đến 5 người.');
    if (room.players.some(item => !item.ready || !item.connected)) return this.error(socket, 'Tất cả người chơi đang kết nối cần bấm Sẵn sàng.');
    try { this.startRound(room); this.broadcast(code); return { ok: true }; } catch (error) { return this.error(socket, error.message || 'Không thể giữ chip để bắt đầu ván.'); }
  }
  startRound(room) {
    const matchId = crypto.randomUUID(), heldAmount = maxLoss(room.players.length, room.stake);
    const hold = this.profileStore.reserveMany({ reservations: room.players.map(player => ({ profileId: player.profileId, amount: heldAmount })), operationKey: `sam-loc:reserve:${matchId}`, roomCode: room.code, matchId });
    room.matchId = matchId; room.reservations = hold.held; room.maxLoss = heldAmount; room.result = null; room.deck = this.shuffle(createSamLocDeck()); room.paused = false; room.topPlay = null; room.passedIds = []; room.playedAny = false; room.oneCall = null; room.actionIds = {};
    room.players.forEach((player, index) => { player.hand = room.deck.slice(index * 10, index * 10 + 10).sort(compareCards); player.ready = false; player.leaveAfterHand = false; });
    room.samResponses = Object.fromEntries(room.players.map(player => [player.id, null])); room.samDeadlineAt = now() + SAM_WINDOW_MS; room.samDeclarerId = null; room.currentPlayerId = null; room.leaderId = null; room.phase = 'SAM_DECLARATION'; room.revision = 0;
    this.addLog(room, `Đã giữ tối đa ${heldAmount} chip/người trước khi chia. Mọi người chọn Báo Sâm hoặc Không báo trong 60 giây.`); this.touch(room); this.flush();
  }
  verifyAction(room, data) {
    if (!Number.isInteger(data?.expectedRevision) || data.expectedRevision !== room.revision) return 'Trạng thái đã thay đổi. Vui lòng thao tác lại.';
    if (typeof data?.actionId !== 'string' || data.actionId.length < 8 || data.actionId.length > 128) return 'Thiếu mã thao tác hợp lệ.';
    if (room.actionIds[data.actionId]) return 'duplicate'; return null;
  }
  rememberAction(room, actionId) { room.actionIds[actionId] = true; const ids = Object.keys(room.actionIds); if (ids.length > 200) ids.slice(0, ids.length - 200).forEach(key => delete room.actionIds[key]); }
  action(socket, code, data) {
    const room = this.rooms.get(code); if (room && this.maybeCloseSamWindow(room)) { this.touch(room); this.broadcast(code); }
    const ctx = this.access(socket, code); if (!ctx || ctx.error) return ctx;
    const invalid = this.verifyAction(ctx.room, data); if (invalid === 'duplicate') return; if (invalid) return this.error(socket, invalid);
    let completed = false;
    if (data.action === 'declare_sam') completed = this.respondSam(socket, ctx.room, ctx.player, true);
    else if (data.action === 'pass_sam') completed = this.respondSam(socket, ctx.room, ctx.player, false);
    else if (data.action === 'play') completed = this.play(socket, ctx.room, ctx.player, data);
    else if (data.action === 'pass') completed = this.pass(socket, ctx.room, ctx.player);
    else if (data.action === 'cancel_before_first_play') completed = this.cancelBeforeFirstPlay(socket, ctx.room, ctx.player);
    else if (data.action === 'play_again') completed = this.playAgain(socket, ctx.room, ctx.player);
    else return this.error(socket, 'Hành động Sâm lốc không hợp lệ.');
    if (completed === false) return;
    this.rememberAction(ctx.room, data.actionId); this.touch(ctx.room); this.broadcast(code);
  }
  maybeCloseSamWindow(room) {
    if (room.phase !== 'SAM_DECLARATION') return false;
    const allAnswered = room.players.every(player => room.samResponses?.[player.id] !== null);
    if (!allAnswered && now() < room.samDeadlineAt) return false;
    this.closeSamWindow(room, allAnswered ? 'Mọi người đã phản hồi.' : 'Hết thời hạn đăng ký; phản hồi thiếu được tính là không báo.');
    return true;
  }
  respondSam(socket, room, player, declared) {
    if (room.phase !== 'SAM_DECLARATION') return this.error(socket, 'Cửa sổ Báo Sâm đã đóng.');
    if (now() >= room.samDeadlineAt) { this.maybeCloseSamWindow(room); return this.error(socket, 'Đã hết thời hạn Báo Sâm.'); }
    if (room.samResponses[player.id] !== null) return this.error(socket, 'Bạn đã chọn cho lượt Báo Sâm này.');
    room.samResponses[player.id] = declared ? 'DECLARE' : 'PASS'; this.addLog(room, `${player.name} đã khóa lựa chọn Báo Sâm.`); this.maybeCloseSamWindow(room); return true;
  }
  closeSamWindow(room, reason) {
    const declarer = room.players.find(player => room.samResponses?.[player.id] === 'DECLARE');
    room.samDeadlineAt = null; room.samResponses = {};
    if (declarer) {
      room.samDeclarerId = declarer.id; room.phase = 'SAM_PLAY'; room.currentPlayerId = declarer.id; room.leaderId = declarer.id; room.topPlay = null; room.passedIds = [];
      this.addLog(room, `${reason} ${declarer.name} được ưu tiên Báo Sâm theo thứ tự ghế và dẫn lượt.`); return;
    }
    const dealt = room.players.flatMap((player, index) => player.hand.map(card => ({ player, index, card }))).sort((left, right) => compareCards(left.card, right.card) || left.index - right.index);
    const opener = dealt[0]; room.phase = 'TURN'; room.currentPlayerId = opener.player.id; room.leaderId = opener.player.id; room.initialRequiredCardId = opener.card.id; room.topPlay = null; room.passedIds = [];
    this.addLog(room, `${reason} Không ai Báo Sâm. ${opener.player.name} mở lượt với lá thấp nhất đã chia (${labelCard(opener.card)}).`);
  }
  requireTurn(socket, room, player) { if (room.currentPlayerId !== player.id) { this.error(socket, 'Chưa đến lượt của bạn.'); return false; } return true; }
  play(socket, room, player, data) {
    if (!['TURN', 'SAM_PLAY'].includes(room.phase) || !this.requireTurn(socket, room, player)) return false;
    if (!Array.isArray(data.cardIds) || !data.cardIds.length || data.cardIds.length > 10 || new Set(data.cardIds).size !== data.cardIds.length) return this.error(socket, 'Hãy chọn một tổ hợp bài hợp lệ.');
    const cards = data.cardIds.map(id => player.hand.find(card => card.id === id)); if (cards.some(card => !card)) return this.error(socket, 'Bạn chỉ có thể đánh bài trên tay mình.');
    const formation = classify(cards); if (!formation) return this.error(socket, 'Tổ hợp không hợp lệ theo luật Sâm lốc local v1.');
    if (room.phase === 'TURN' && !room.playedAny && !cards.some(card => card.id === room.initialRequiredCardId)) return this.error(socket, 'Lượt mở ván phải có lá thấp nhất được chia.');
    if (room.topPlay && !canBeat(formation, room.topPlay.formation)) return this.error(socket, 'Tổ hợp này chưa đè được bài trên bàn.');
    const blocksOne = room.oneCall?.nextPlayerId === player.id && player.hand.length === cards.length ? room.oneCall.playerId : null;
    if (room.oneCall?.nextPlayerId === player.id) room.oneCall = null;
    player.hand = player.hand.filter(card => !data.cardIds.includes(card.id)); room.topPlay = { playerId: player.id, formation, cards }; room.leaderId = player.id; room.playedAny = true; room.passedIds = [];
    this.addLog(room, `${player.name} đánh ${formationName(formation)}.`);
    if (!player.hand.length) {
      if (room.phase === 'SAM_PLAY' && player.id === room.samDeclarerId) { this.finishSam(room, player, true, 'Báo Sâm thành công: đánh hết 10 lá.'); return true; }
      if (room.phase === 'SAM_PLAY') { this.finishSam(room, this.byId(room, room.samDeclarerId), false, `${player.name} chặn Sâm bằng cách đánh hết bài.`); return true; }
      this.finishNormal(room, player, blocksOne, blocksOne ? 'Chặn Báo một bằng cách đánh hết bài.' : 'Đánh hết bài'); return true;
    }
    if (player.hand.length === 1) { room.oneCall = { playerId: player.id, nextPlayerId: this.nextPlayerId(room, player.id) }; this.addLog(room, `${player.name} báo một; người kế tiếp có thể chặn bằng cách đánh hết bài.`); }
    room.currentPlayerId = this.nextPlayerId(room, player.id); return true;
  }
  pass(socket, room, player) {
    if (!['TURN', 'SAM_PLAY'].includes(room.phase) || !this.requireTurn(socket, room, player)) return false;
    if (!room.topPlay || room.leaderId === player.id) return this.error(socket, 'Người dẫn vòng phải đánh bài, không thể bỏ lượt.');
    if (room.oneCall?.nextPlayerId === player.id) room.oneCall = null;
    if (room.phase === 'SAM_PLAY' && player.id === room.samDeclarerId) { this.finishSam(room, player, false, 'Người Báo Sâm không đè được bài trên bàn.'); return true; }
    room.passedIds.push(player.id); this.addLog(room, `${player.name} bỏ lượt.`);
    const others = room.players.filter(item => item.id !== room.leaderId);
    if (others.every(item => room.passedIds.includes(item.id))) { const leader = this.byId(room, room.leaderId); room.currentPlayerId = leader.id; room.topPlay = null; room.passedIds = []; this.addLog(room, `${leader.name} được dẫn vòng mới.`); }
    else room.currentPlayerId = this.nextPlayerId(room, player.id);
    return true;
  }
  settle(room, deltas, kind, winner, reason) {
    if (room.phase === 'RESULT') return;
    const settlement = this.profileStore.settleReservations({ reservations: room.reservations, outcomes: room.players.map(player => ({ profileId: player.profileId, delta: deltas.get(player.id) || 0 })), operationKey: `sam-loc:settle:${room.matchId}`, roomCode: room.code, matchId: room.matchId, note: `Sâm lốc: ${reason}` });
    const completedAt = new Date().toISOString(); room.phase = 'RESULT'; room.currentPlayerId = null; room.passedIds = [];
    room.result = { matchId: room.matchId, kind, winnerId: winner.id, winnerName: winner.name, reason, stake: room.stake, maxLoss: room.maxLoss, completedAt,
      outcomes: room.players.map(player => ({ playerId: player.id, name: player.name, delta: deltas.get(player.id) || 0 })), settled: Boolean(settlement.outcomes) };
    room.history.unshift(room.result); room.history = room.history.slice(0, 50); this.addLog(room, `${winner.name}: ${reason}`); this.flush();
    if (this.onMatchCompleted) this.onMatchCompleted({ matchId: room.matchId, gameId: 'sam-loc', roomCode: room.code, completedAt,
      players: room.players.map(player => ({ profileId: player.profileId, outcome: player.id === winner.id ? 'WIN' : 'LOSS' })), result: room.result });
    leaveCompletedSeats(this, room, 'sam-loc');
    room.maxLoss = maxLoss(room.players.length || 2, room.stake); this.flush();
  }
  finishNormal(room, winner, blockedOnePlayerId, reason) {
    const deltas = new Map(room.players.map(player => [player.id, player.id === winner.id ? room.stake * (room.players.length - 1) : -room.stake]));
    if (blockedOnePlayerId && blockedOnePlayerId !== winner.id) { deltas.set(blockedOnePlayerId, deltas.get(blockedOnePlayerId) - room.stake); deltas.set(winner.id, deltas.get(winner.id) + room.stake); }
    this.settle(room, deltas, blockedOnePlayerId ? 'BAO_MOT_BLOCKED' : 'NORMAL', winner, reason);
  }
  finishSam(room, declarer, success, reason) {
    const amount = 2 * room.stake, deltas = new Map();
    for (const player of room.players) deltas.set(player.id, player.id === declarer.id ? (success ? amount * (room.players.length - 1) : -amount * (room.players.length - 1)) : (success ? -amount : amount));
    const winner = success ? declarer : this.byId(room, room.topPlay?.playerId) || room.players.find(player => player.id !== declarer.id);
    this.settle(room, deltas, success ? 'SAM_SUCCESS' : 'SAM_FAILED', winner, reason);
  }
  cancelBeforeFirstPlay(socket, room, player) {
    if (!ACTIVE_PHASES.has(room.phase) || !player.isHost || room.playedAny) return this.error(socket, 'Chỉ chủ phòng có thể hủy trước lá đánh đầu tiên.');
    this.profileStore.releaseReservations({ reservations: room.reservations, operationKey: `sam-loc:cancel:${room.matchId}`, roomCode: room.code, matchId: room.matchId, note: 'Hoàn chip: chủ phòng hủy trước lá đầu Sâm lốc' });
    room.phase = 'WAITING'; room.reservations = []; room.matchId = null; room.deck = []; room.players.forEach(item => { item.hand = []; item.ready = false; }); room.currentPlayerId = null; room.leaderId = null; room.topPlay = null; room.passedIds = []; room.playedAny = false; room.samResponses = {}; room.samDeadlineAt = null; room.oneCall = null; this.addLog(room, 'Ván đã hủy trước lá đầu; toàn bộ chip giữ đã được hoàn.'); this.flush(); return true;
  }
  playAgain(socket, room, player) {
    if (room.phase !== 'RESULT' || !player.isHost) return this.error(socket, 'Chỉ chủ bàn có thể mở phòng chờ cho ván tiếp.');
    room.phase = 'WAITING'; room.matchId = null; room.reservations = []; room.deck = []; room.currentPlayerId = null; room.leaderId = null; room.topPlay = null; room.passedIds = []; room.initialRequiredCardId = null; room.playedAny = false; room.samResponses = {}; room.samDeadlineAt = null; room.samDeclarerId = null; room.oneCall = null; room.result = null; room.actionIds = {};
    room.players.forEach(item => { item.hand = []; item.ready = false; item.leaveAfterHand = false; }); this.addLog(room, 'Trở về phòng chờ. Mỗi người cần sẵn sàng lại; số dư được kiểm tra trước ván mới.'); return true;
  }
  leaveRoom(socket, code) {
    const ctx = this.access(socket, code); if (!ctx || ctx.error) return ctx; const { room, player } = ctx;
    if (ACTIVE_PHASES.has(room.phase)) { player.leaveAfterHand = true; this.addLog(room, `${player.name} sẽ rời bàn sau ván này.`); this.touch(room); this.broadcast(code); return { queued: true }; }
    room.players = room.players.filter(item => item !== player); this.playerRoom.delete(socket.id); socket.leave(code); socket.emit('room_left');
    if (!room.players.length) { this.rooms.delete(code); this.saveSoon(); return; }
    room.maxLoss = maxLoss(room.players.length, room.stake); this.ensureHost(room); this.addLog(room, `${player.name} rời phòng.`); this.touch(room); this.broadcast(code);
  }
  syncState(socket, code) { const ctx = this.access(socket, code); if (ctx && !ctx.error) socket.emit('game_state', this.buildStateFor(ctx.room, ctx.player.id)); return ctx; }
  handleDisconnect(socket) {
    const code = this.playerRoom.get(socket.id), room = this.rooms.get(code), player = this.player(room, socket); this.playerRoom.delete(socket.id); if (!player) return;
    player.connected = false; player.socketId = null; player.disconnectedAt = now(); this.ensureHost(room); if (ACTIVE_PHASES.has(room.phase)) room.paused = true;
    this.addLog(room, `${player.name} mất kết nối; ván tạm dừng để giữ bài và chip.`); this.touch(room); this.broadcast(code);
  }
  buildStateFor(room, playerId) {
    const me = this.byId(room, playerId), declarer = this.byId(room, room.samDeclarerId);
    return { gameId: 'sam-loc', roomCode: room.code, phase: room.phase, rulesVersion: room.rulesVersion, stake: room.stake, maxLoss: room.maxLoss, revision: room.revision, matchId: room.matchId,
      myId: playerId, currentPlayerId: room.currentPlayerId, leaderId: room.leaderId, paused: room.paused, playedAny: room.playedAny,
      initialRequiredCardId: !room.playedAny && me?.hand.some(card => card.id === room.initialRequiredCardId) ? room.initialRequiredCardId : null,
      samWindow: room.phase === 'SAM_DECLARATION' ? { deadlineAt: room.samDeadlineAt, responseCount: room.players.filter(player => room.samResponses?.[player.id] !== null).length, total: room.players.length, myResponse: room.samResponses?.[playerId] || null } : null,
      samDeclarer: declarer ? { id: declarer.id, name: declarer.name } : null, oneCall: room.oneCall ? { playerId: room.oneCall.playerId, nextPlayerId: room.oneCall.nextPlayerId } : null,
      topPlay: room.topPlay ? { playerId: room.topPlay.playerId, formation: { kind: room.topPlay.formation.kind, length: room.topPlay.formation.length, power: room.topPlay.formation.power }, cards: room.topPlay.cards } : null,
      passedIds: room.passedIds, myHand: me?.hand || [], result: room.result, log: room.log,
      players: room.players.map(player => ({ id: player.id, name: player.name, avatar: player.avatar, isHost: player.isHost, ready: player.ready, connected: player.connected, handCount: player.hand.length, leaveAfterHand: player.leaveAfterHand })) };
  }
  broadcast(code) { const room = this.rooms.get(code); if (!room) return; room.updatedAt = now(); for (const player of room.players) { const socket = this.io.sockets.sockets.get(player.socketId); if (socket && player.connected) socket.emit('game_state', this.buildStateFor(room, player.id)); } this.saveSoon(); }
  cleanup() {
    for (const room of this.rooms.values()) {
      if (this.maybeCloseSamWindow(room)) { this.touch(room); this.broadcast(room.code); }
      if (room.phase === 'WAITING') { const expired = room.players.filter(player => !player.connected && now() - player.disconnectedAt > this.graceMs); if (expired.length) { room.players = room.players.filter(player => !expired.includes(player)); this.ensureHost(room); room.maxLoss = maxLoss(room.players.length || 2, room.stake); if (!room.players.length) this.rooms.delete(room.code); else { this.touch(room); this.broadcast(room.code); } } }
      if (ACTIVE_PHASES.has(room.phase) && !room.players.some(player => player.connected) && now() - room.updatedAt > 12 * 3600000) {
        try { this.profileStore.expireFixedRoom({ gameId: 'sam-loc', roomCode: room.code, matchId: room.matchId }); } catch (error) { console.error('Không hoàn chip phòng Sâm lốc hết hạn:', error.message); continue; }
        this.rooms.delete(room.code); this.saveSoon();
      }
      if (room.phase === 'RESULT' && !room.players.some(player => player.connected) && now() - room.updatedAt > 12 * 3600000) { this.rooms.delete(room.code); this.saveSoon(); }
    }
  }
  load() { loadFixedRooms(this, 'sam-loc', room => { room.paused = ACTIVE_PHASES.has(room.phase); room.samResponses ||= {}; room.actionIds ||= {}; room.history ||= []; room.log ||= []; }); }
  saveSoon() { if (!this.storageFile || this.storageError || this.saveTimer) return; this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 100); this.saveTimer.unref(); }
  flush() { if (!this.storageFile || this.storageError) return; try { fs.mkdirSync(path.dirname(this.storageFile), { recursive: true }); fs.writeFileSync(`${this.storageFile}.tmp`, JSON.stringify({ version: 1, rooms: [...this.rooms.values()] }), { mode: 0o600 }); fs.renameSync(`${this.storageFile}.tmp`, this.storageFile); } catch (error) { console.error('Không lưu được dữ liệu phòng Sâm lốc:', error.message); } }
}

module.exports = { SamLocManager, STAKE, maxLoss, SAM_WINDOW_MS };
