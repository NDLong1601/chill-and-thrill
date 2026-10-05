'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { leaveCompletedSeats, loadFixedRooms } = require('../../platform/completedRoom');
const { createTienLenDeck, shuffle, compareCards, classify, formationName, canBeat, whiteWin, labelCard } = require('./tienLenDeck');

const AVATARS = ['🕶️', '🥷', '💻', '🔓', '🎲', '🏎️'];
const ACTIVE_PHASES = new Set(['TURN']);
const STAKE = 100;
const now = () => Date.now();
const cleanName = value => String(value || '').trim().slice(0, 18) || 'Player';

class TienLenManager {
  constructor(io, options = {}) {
    this.io = io;
    this.rooms = new Map();
    this.playerRoom = new Map();
    this.storageFile = options.storageFile || null;
    this.graceMs = options.graceMs ?? 120000;
    this.codeTaken = typeof options.codeTaken === 'function' ? options.codeTaken : () => false;
    this.profileForSocket = typeof options.profileForSocket === 'function' ? options.profileForSocket : () => null;
    this.profileStore = options.profileStore;
    this.onMatchCompleted = typeof options.onMatchCompleted === 'function' ? options.onMatchCompleted : null;
    this.shuffle = typeof options.shuffle === 'function' ? options.shuffle : shuffle;
    this.load();
    this.cleanupTimer = setInterval(() => this.cleanup(), 30000);
    this.cleanupTimer.unref();
  }

  error(socket, message) { socket.emit('game_error', { message }); return { error: message }; }
  close() { clearInterval(this.cleanupTimer); clearTimeout(this.saveTimer); this.flush(); }
  code() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code;
    do { code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (this.rooms.has(code) || this.codeTaken(code));
    return code;
  }
  newPlayer(socket, name, avatar, isHost = false) {
    const profile = this.profileForSocket(socket);
    return { id: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'), socketId: socket.id, profileId: profile?.id || null,
      name: profile?.displayName || cleanName(name), avatar: profile?.avatar || (AVATARS.includes(avatar) ? avatar : AVATARS[0]),
      isHost, connected: true, disconnectedAt: null, ready: false, hand: [], leaveAfterHand: false };
  }
  credentials(room, player) { return { roomCode: room.code, playerId: player.id, sessionToken: player.token, gameId: 'tien-len' }; }
  player(room, socket) { return room?.players.find(item => item.socketId === socket.id && item.connected); }
  byId(room, id) { return room.players.find(item => item.id === id); }
  bind(socket, room, player) {
    this.playerRoom.set(socket.id, room.code); socket.join(room.code); player.socketId = socket.id; player.connected = true; player.disconnectedAt = null;
    if (room.paused && !room.players.some(item => !item.connected)) { room.paused = false; this.addLog(room, 'Mọi người đã kết nối lại; ván tiếp tục.'); this.touch(room); }
  }
  access(socket, code, phases) {
    const room = this.rooms.get(code), player = this.player(room, socket);
    if (!room || !player) return this.error(socket, 'Bạn không còn ở trong phòng Tiến lên này.');
    if (phases && !phases.includes(room.phase)) return this.error(socket, 'Thao tác không phù hợp với giai đoạn hiện tại.');
    if (ACTIVE_PHASES.has(room.phase) && (room.paused || room.players.some(item => !item.connected))) return this.error(socket, 'Ván đang tạm dừng do có người mất kết nối.');
    return { room, player };
  }
  ensureHost(room) { if (room.players.some(item => item.isHost && item.connected)) return; const next = room.players.find(item => item.connected) || room.players[0]; room.players.forEach(item => { item.isHost = item === next; }); }
  touch(room) { room.revision = (room.revision || 0) + 1; room.updatedAt = now(); this.saveSoon(); }
  addLog(room, message) { room.log.unshift({ id: crypto.randomUUID(), message, at: new Date().toISOString() }); room.log = room.log.slice(0, 60); }

  createRoom(socket, name, avatar) {
    if (this.playerRoom.has(socket.id)) return { error: 'Hãy rời phòng hiện tại trước khi tạo phòng mới.' };
    if (!this.profileForSocket(socket)) return { error: 'Tiến lên cần hồ sơ để giữ chip an toàn.' };
    const player = this.newPlayer(socket, name, avatar, true);
    const room = { code: this.code(), gameId: 'tien-len', phase: 'WAITING', rulesVersion: 'south-v1', stake: STAKE, matchId: null, revision: 0,
      players: [player], deck: [], currentPlayerId: null, leaderId: null, topPlay: null, passedIds: [], initialRequiredCardId: null, playedAny: false,
      actionIds: {}, reservations: [], result: null, history: [], log: [], paused: false, createdAt: now(), updatedAt: now() };
    this.rooms.set(room.code, room); this.bind(socket, room, player); this.addLog(room, `${player.name} tạo bàn Tiến lên ${room.code} · cược cố định ${STAKE} chip.`); this.touch(room);
    return this.credentials(room, player);
  }
  joinRoom(socket, code, name, avatar) {
    if (this.playerRoom.has(socket.id)) return { error: 'Bạn đang ở trong một phòng khác.' };
    const room = this.rooms.get(code); if (!room) return { error: 'Không tìm thấy phòng Tiến lên.' };
    if (!this.profileForSocket(socket)) return { error: 'Tiến lên cần hồ sơ để giữ chip an toàn.' };
    if (room.phase !== 'WAITING') return { error: 'Ván đang diễn ra. Chỉ người cũ mới có thể khôi phục ghế.' };
    if (room.players.length >= 4) return { error: 'Bàn Tiến lên đã đủ 4 người.' };
    const profile = this.profileForSocket(socket);
    if (room.players.some(item => item.profileId === profile.id)) return { error: 'Hồ sơ này đã có ghế trong bàn. Hãy khôi phục ghế cũ.' };
    const player = this.newPlayer(socket, name, avatar); room.players.push(player); this.bind(socket, room, player); this.addLog(room, `${player.name} tham gia bàn.`); this.touch(room); this.broadcast(code);
    return this.credentials(room, player);
  }
  resumeRoom(socket, code, token) {
    const room = this.rooms.get(code), player = room?.players.find(item => typeof token === 'string' && item.token === token);
    if (!player) return { error: 'Phiên Tiến lên đã hết hạn hoặc phòng không còn tồn tại.' };
    const profile = this.profileForSocket(socket);
    if (player.profileId && player.profileId !== profile?.id) return { error: 'Ghế này thuộc về một hồ sơ khác.' };
    const active = this.playerRoom.get(socket.id); if (active && active !== code) return { error: 'Bạn đang ở phòng khác.' };
    if (player.connected && player.socketId !== socket.id) return { error: 'Ghế này đang mở ở cửa sổ khác.' };
    this.bind(socket, room, player); this.ensureHost(room); this.addLog(room, `${player.name} đã nối lại.`); this.touch(room); this.broadcast(code); return this.credentials(room, player);
  }
  setReady(socket, code, ready) { const ctx = this.access(socket, code, ['WAITING']); if (!ctx || ctx.error) return ctx; ctx.player.ready = !!ready; this.touch(ctx.room); this.broadcast(code); }
  startGame(socket, code) {
    const ctx = this.access(socket, code, ['WAITING']); if (!ctx || ctx.error) return ctx;
    const { room, player } = ctx;
    if (!player.isHost) return this.error(socket, 'Chỉ chủ phòng được bắt đầu ván.');
    if (room.players.length < 2 || room.players.length > 4) return this.error(socket, 'Tiến lên cần từ 2 đến 4 người.');
    if (room.players.some(item => !item.ready || !item.connected)) return this.error(socket, 'Tất cả người chơi đang kết nối cần bấm Sẵn sàng.');
    try { this.startRound(room); this.broadcast(code); return { ok: true }; } catch (error) { return this.error(socket, error.message || 'Không thể giữ chip để bắt đầu ván.'); }
  }
  startRound(room) {
    const matchId = crypto.randomUUID();
    const hold = this.profileStore.reserveMany({ reservations: room.players.map(player => ({ profileId: player.profileId, amount: room.stake })), operationKey: `tien-len:reserve:${matchId}`, roomCode: room.code, matchId });
    room.matchId = matchId; room.reservations = hold.held; room.result = null; room.deck = this.shuffle(createTienLenDeck()); room.paused = false; room.topPlay = null; room.passedIds = []; room.playedAny = false; room.actionIds = {};
    room.players.forEach((player, index) => { player.hand = room.deck.slice(index * 13, index * 13 + 13).sort(compareCards); player.ready = false; player.leaveAfterHand = false; });
    const allCards = room.players.flatMap(player => player.hand.map(card => ({ player, card }))).sort((left, right) => compareCards(left.card, right.card));
    room.initialRequiredCardId = allCards[0].card.id; room.currentPlayerId = allCards[0].player.id; room.leaderId = allCards[0].player.id; room.phase = 'TURN'; room.revision = 0;
    const whites = room.players.map((player, index) => ({ player, index, win: whiteWin(player.hand) })).filter(item => item.win).sort((left, right) => right.win.priority - left.win.priority || left.index - right.index);
    if (whites.length) { this.addLog(room, `${whites[0].player.name} tới trắng: ${whites[0].win.label}.`); this.finish(room, whites[0].player, `Tới trắng: ${whites[0].win.label}`); return; }
    this.addLog(room, `Đã giữ ${room.stake} chip/người trước khi chia bài. ${allCards[0].player.name} mở lượt với lá thấp nhất ${labelCard(allCards[0].card)}.`); this.touch(room); this.flush();
  }
  verifyAction(room, data) {
    if (!Number.isInteger(data?.expectedRevision) || data.expectedRevision !== room.revision) return 'Trạng thái đã thay đổi. Vui lòng thao tác lại.';
    if (typeof data?.actionId !== 'string' || data.actionId.length < 8 || data.actionId.length > 128) return 'Thiếu mã thao tác hợp lệ.';
    if (room.actionIds[data.actionId]) return 'duplicate'; return null;
  }
  rememberAction(room, actionId) { room.actionIds[actionId] = true; const ids = Object.keys(room.actionIds); if (ids.length > 200) ids.slice(0, ids.length - 200).forEach(key => delete room.actionIds[key]); }
  action(socket, code, data) {
    const ctx = this.access(socket, code); if (!ctx || ctx.error) return ctx;
    const invalid = this.verifyAction(ctx.room, data); if (invalid === 'duplicate') return; if (invalid) return this.error(socket, invalid);
    let completed = false;
    if (data.action === 'play') completed = this.play(socket, ctx.room, ctx.player, data);
    else if (data.action === 'pass') completed = this.pass(socket, ctx.room, ctx.player);
    else if (data.action === 'cancel_before_first_play') completed = this.cancelBeforeFirstPlay(socket, ctx.room, ctx.player);
    else if (data.action === 'play_again') completed = this.playAgain(socket, ctx.room, ctx.player);
    else return this.error(socket, 'Hành động Tiến lên không hợp lệ.');
    if (completed === false) return;
    this.rememberAction(ctx.room, data.actionId); this.touch(ctx.room); this.broadcast(code);
  }
  requireTurn(socket, room, player) { if (room.currentPlayerId !== player.id) { this.error(socket, 'Chưa đến lượt của bạn.'); return false; } return true; }
  play(socket, room, player, data) {
    if (room.phase !== 'TURN' || !this.requireTurn(socket, room, player)) return false;
    if (!Array.isArray(data.cardIds) || !data.cardIds.length || data.cardIds.length > 13 || new Set(data.cardIds).size !== data.cardIds.length) return this.error(socket, 'Hãy chọn một tổ hợp bài hợp lệ.');
    const cards = data.cardIds.map(id => player.hand.find(card => card.id === id));
    if (cards.some(card => !card)) return this.error(socket, 'Bạn chỉ có thể đánh bài trên tay mình.');
    const formation = classify(cards); if (!formation) return this.error(socket, 'Tổ hợp không hợp lệ theo luật local v1.');
    if (!room.playedAny && !cards.some(card => card.id === room.initialRequiredCardId)) return this.error(socket, 'Lượt mở ván phải có lá thấp nhất được chia.');
    if (room.topPlay && !canBeat(formation, room.topPlay.formation)) return this.error(socket, 'Tổ hợp này chưa chặt được bài trên bàn.');
    const previous = room.topPlay?.formation;
    const chopsTwo = previous && ((previous.kind === 'single' || previous.kind === 'pair') && previous.power === 12 && formation.kind !== previous.kind);
    const chopsFour = previous?.kind === 'four' && formation.kind === 'pair-run';
    player.hand = player.hand.filter(card => !data.cardIds.includes(card.id)); room.topPlay = { playerId: player.id, formation, cards }; room.leaderId = player.id; room.playedAny = true; room.passedIds = [];
    this.addLog(room, `${player.name} đánh ${formationName(formation)}.`);
    if (!player.hand.length) { this.finish(room, player, 'Đánh hết bài'); return true; }
    // A successful cut closes the current trick; the cutter immediately leads
    // a fresh trick.  This local rule removes the ambiguous post-cut sequence.
    if (chopsTwo || chopsFour) { room.topPlay = null; room.passedIds = []; room.currentPlayerId = player.id; this.addLog(room, `${player.name} chặt thành công và được dẫn vòng mới.`); return true; }
    room.currentPlayerId = this.nextPlayerId(room, player.id); return true;
  }
  nextPlayerId(room, id) { const index = room.players.findIndex(player => player.id === id); return room.players[(index + 1) % room.players.length].id; }
  pass(socket, room, player) {
    if (room.phase !== 'TURN' || !this.requireTurn(socket, room, player)) return false;
    if (!room.topPlay || room.leaderId === player.id) return this.error(socket, 'Người dẫn vòng phải đánh bài, không thể bỏ lượt.');
    room.passedIds.push(player.id); this.addLog(room, `${player.name} bỏ lượt.`);
    const others = room.players.filter(item => item.id !== room.leaderId);
    if (others.every(item => room.passedIds.includes(item.id))) {
      const leader = this.byId(room, room.leaderId); room.currentPlayerId = leader.id; room.topPlay = null; room.passedIds = []; this.addLog(room, `${leader.name} được dẫn vòng mới.`);
    } else room.currentPlayerId = this.nextPlayerId(room, player.id);
    return true;
  }
  cancelBeforeFirstPlay(socket, room, player) {
    if (room.phase !== 'TURN' || !player.isHost || room.playedAny) return this.error(socket, 'Chỉ chủ phòng có thể hủy trước lá đánh đầu tiên.');
    this.profileStore.releaseReservations({ reservations: room.reservations, operationKey: `tien-len:cancel:${room.matchId}`, roomCode: room.code, matchId: room.matchId, note: 'Hoàn chip: chủ phòng hủy trước lá đầu' });
    room.phase = 'WAITING'; room.reservations = []; room.matchId = null; room.deck = []; room.players.forEach(item => { item.hand = []; item.ready = false; }); room.currentPlayerId = null; room.topPlay = null; room.passedIds = []; room.playedAny = false; this.addLog(room, 'Ván đã hủy trước lá đầu; toàn bộ chip giữ đã được hoàn.'); this.flush(); return true;
  }
  playAgain(socket, room, player) {
    if (room.phase !== 'RESULT' || !player.isHost) return this.error(socket, 'Chỉ chủ bàn có thể mở phòng chờ cho ván tiếp.');
    room.phase = 'WAITING'; room.matchId = null; room.reservations = []; room.deck = []; room.currentPlayerId = null; room.leaderId = null; room.topPlay = null; room.passedIds = []; room.initialRequiredCardId = null; room.playedAny = false; room.result = null; room.actionIds = {};
    room.players.forEach(item => { item.hand = []; item.ready = false; item.leaveAfterHand = false; }); this.addLog(room, 'Trở về phòng chờ. Mỗi người cần sẵn sàng lại; số dư sẽ được kiểm tra trước ván mới.'); return true;
  }
  finish(room, winner, reason) {
    const settlement = this.profileStore.settleWinnerTakesPot({ reservations: room.reservations, winnerProfileId: winner.profileId, operationKey: `tien-len:settle:${room.matchId}`, roomCode: room.code, matchId: room.matchId });
    const completedAt = new Date().toISOString();
    room.phase = 'RESULT'; room.currentPlayerId = null; room.passedIds = [];
    room.result = { matchId: room.matchId, winnerId: winner.id, winnerName: winner.name, reason, stake: room.stake, pot: settlement.pot, completedAt,
      outcomes: room.players.map(player => ({ playerId: player.id, name: player.name, delta: player.id === winner.id ? settlement.pot - room.stake : -room.stake })) };
    room.history.unshift(room.result); room.history = room.history.slice(0, 50); this.addLog(room, `${winner.name} thắng (${reason}) và nhận pot ${settlement.pot} chip.`); this.flush();
    if (this.onMatchCompleted) this.onMatchCompleted({ matchId: room.matchId, gameId: 'tien-len', roomCode: room.code, completedAt,
      players: room.players.map(player => ({ profileId: player.profileId, outcome: player.id === winner.id ? 'WIN' : 'LOSS' })), result: { winnerProfileId: winner.profileId, winnerName: winner.name, reason, stake: room.stake, pot: settlement.pot } });
    leaveCompletedSeats(this, room, 'tien-len'); this.flush();
  }
  leaveRoom(socket, code) {
    const ctx = this.access(socket, code); if (!ctx || ctx.error) return ctx;
    const { room, player } = ctx;
    if (room.phase === 'TURN') { player.leaveAfterHand = true; this.addLog(room, `${player.name} sẽ rời bàn sau ván này.`); this.touch(room); this.broadcast(code); return { queued: true }; }
    room.players = room.players.filter(item => item !== player); this.playerRoom.delete(socket.id); socket.leave(code); socket.emit('room_left');
    if (!room.players.length) { this.rooms.delete(code); this.saveSoon(); return; }
    this.ensureHost(room); this.addLog(room, `${player.name} rời phòng.`); this.touch(room); this.broadcast(code);
  }
  syncState(socket, code) { const ctx = this.access(socket, code); if (ctx && !ctx.error) socket.emit('game_state', this.buildStateFor(ctx.room, ctx.player.id)); return ctx; }
  handleDisconnect(socket) {
    const code = this.playerRoom.get(socket.id), room = this.rooms.get(code), player = this.player(room, socket); this.playerRoom.delete(socket.id); if (!player) return;
    player.connected = false; player.socketId = null; player.disconnectedAt = now(); this.ensureHost(room); if (ACTIVE_PHASES.has(room.phase)) room.paused = true;
    this.addLog(room, `${player.name} mất kết nối; ván tạm dừng để giữ bài và chip.`); this.touch(room); this.broadcast(code);
  }
  buildStateFor(room, playerId) {
    const me = this.byId(room, playerId);
    return { gameId: 'tien-len', roomCode: room.code, phase: room.phase, rulesVersion: room.rulesVersion, stake: room.stake, revision: room.revision, matchId: room.matchId,
      myId: playerId, currentPlayerId: room.currentPlayerId, leaderId: room.leaderId, paused: room.paused, playedAny: room.playedAny,
      // The opener itself may highlight its required card.  Sending that ID to
      // every seat would disclose one otherwise-private opponent card.
      initialRequiredCardId: !room.playedAny && me?.hand.some(card => card.id === room.initialRequiredCardId) ? room.initialRequiredCardId : null,
      topPlay: room.topPlay ? { playerId: room.topPlay.playerId, formation: { kind: room.topPlay.formation.kind, length: room.topPlay.formation.length, power: room.topPlay.formation.power }, cards: room.topPlay.cards } : null,
      passedIds: room.passedIds, myHand: me?.hand || [], result: room.result, log: room.log,
      players: room.players.map(player => ({ id: player.id, name: player.name, avatar: player.avatar, isHost: player.isHost, ready: player.ready, connected: player.connected, handCount: player.hand.length, leaveAfterHand: player.leaveAfterHand })) };
  }
  broadcast(code) { const room = this.rooms.get(code); if (!room) return; room.updatedAt = now(); for (const player of room.players) { const socket = this.io.sockets.sockets.get(player.socketId); if (socket && player.connected) socket.emit('game_state', this.buildStateFor(room, player.id)); } this.saveSoon(); }
  cleanup() {
    for (const room of this.rooms.values()) {
      if (room.phase === 'WAITING') { const expired = room.players.filter(player => !player.connected && now() - player.disconnectedAt > this.graceMs); if (expired.length) { room.players = room.players.filter(player => !expired.includes(player)); this.ensureHost(room); if (!room.players.length) this.rooms.delete(room.code); else { this.touch(room); this.broadcast(room.code); } } }
      if (room.phase === 'TURN' && !room.players.some(player => player.connected) && now() - room.updatedAt > 12 * 3600000) {
        try { this.profileStore.expireFixedRoom({ gameId: 'tien-len', roomCode: room.code, matchId: room.matchId }); } catch (error) { console.error('Không hoàn chip phòng Tiến lên hết hạn:', error.message); continue; }
        this.rooms.delete(room.code); this.saveSoon();
      }
      if (room.phase === 'RESULT' && !room.players.some(player => player.connected) && now() - room.updatedAt > 12 * 3600000) { this.rooms.delete(room.code); this.saveSoon(); }
    }
  }
  load() { loadFixedRooms(this, 'tien-len', room => { room.paused = ACTIVE_PHASES.has(room.phase); }); }
  saveSoon() { if (!this.storageFile || this.storageError || this.saveTimer) return; this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 100); this.saveTimer.unref(); }
  flush() { if (!this.storageFile || this.storageError) return; try { fs.mkdirSync(path.dirname(this.storageFile), { recursive: true }); fs.writeFileSync(`${this.storageFile}.tmp`, JSON.stringify({ version: 1, rooms: [...this.rooms.values()] }), { mode: 0o600 }); fs.renameSync(`${this.storageFile}.tmp`, this.storageFile); } catch (error) { console.error('Không lưu được dữ liệu phòng Tiến lên:', error.message); } }
}

module.exports = { TienLenManager, STAKE };
