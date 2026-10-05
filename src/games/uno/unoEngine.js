'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { COLORS, COLOR_NAMES, createUnoDeck, shuffle, cardLabel } = require('./unoDeck');

const AVATARS = ['🕶️', '🥷', '💻', '🔓', '🎲', '🏎️'];
const ACTIVE_PHASES = new Set(['TURN', 'UNO_WINDOW', 'WDF_CHALLENGE', 'DRAW_PENALTY']);
const cleanName = value => String(value || '').trim().slice(0, 18) || 'Player';
const now = () => Date.now();

class UnoManager {
  constructor(io, options = {}) {
    this.io = io;
    this.rooms = new Map();
    this.playerRoom = new Map();
    this.storageFile = options.storageFile || null;
    this.graceMs = options.graceMs ?? 120000;
    this.codeTaken = typeof options.codeTaken === 'function' ? options.codeTaken : () => false;
    this.profileForSocket = typeof options.profileForSocket === 'function' ? options.profileForSocket : () => null;
    this.onMatchCompleted = typeof options.onMatchCompleted === 'function' ? options.onMatchCompleted : null;
    this.load();
    this.cleanupTimer = setInterval(() => this.cleanup(), 1000);
    this.cleanupTimer.unref();
  }

  error(socket, message) { socket.emit('game_error', { message }); return { error: message }; }
  close() { clearInterval(this.cleanupTimer); clearTimeout(this.saveTimer); this.flush(); }
  phaseKey(room) { return `${room.matchId}:${room.revision}:${room.phase}`; }
  code() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
    while (this.rooms.has(code) || this.codeTaken(code));
    return code;
  }
  newPlayer(socket, name, avatar, isHost = false) {
    const profile = this.profileForSocket(socket);
    return {
      id: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'), socketId: socket.id,
      profileId: profile?.id || null, name: profile?.displayName || cleanName(name), avatar: profile?.avatar || (AVATARS.includes(avatar) ? avatar : AVATARS[0]), isHost,
      connected: true, disconnectedAt: null, ready: false, hand: [],
    };
  }
  credentials(room, player) { return { roomCode: room.code, playerId: player.id, sessionToken: player.token, gameId: 'uno' }; }
  bind(socket, room, player) {
    this.playerRoom.set(socket.id, room.code); socket.join(room.code);
    player.socketId = socket.id; player.connected = true; player.disconnectedAt = null;
    if (!room.players.some(p => !p.connected)) this.resumeClock(room);
  }
  player(room, socket) { return room?.players.find(p => p.socketId === socket.id && p.connected); }
  access(socket, code, phases) {
    const room = this.rooms.get(code), player = this.player(room, socket);
    if (!room || !player) return this.error(socket, 'Bạn không còn ở trong phòng UNO này.');
    if (phases && !phases.includes(room.phase)) return this.error(socket, 'Thao tác không phù hợp với giai đoạn hiện tại.');
    if (ACTIVE_PHASES.has(room.phase) && (room.paused || room.players.some(p => !p.connected))) return this.error(socket, 'Ván đang tạm dừng do có người mất kết nối.');
    return { room, player };
  }
  touch(room) { room.revision++; room.updatedAt = now(); this.saveSoon(); }
  addLog(room, message) { room.log.unshift({ id: crypto.randomUUID(), message, at: new Date().toISOString() }); room.log = room.log.slice(0, 60); }

  createRoom(socket, name, avatar) {
    if (this.playerRoom.has(socket.id)) return { error: 'Hãy rời phòng hiện tại trước khi tạo phòng mới.' };
    const player = this.newPlayer(socket, name, avatar, true);
    const room = {
      code: this.code(), gameId: 'uno', phase: 'WAITING', matchId: crypto.randomUUID(), revision: 0,
      players: [player], direction: 1, currentPlayerId: null, currentColor: null,
      drawPile: [], discardPile: [], pendingDraw: null, pendingUno: null, pendingWdf: null,
      actionIds: {}, result: null, history: [], log: [], paused: false, pausedClock: null,
      updatedAt: now(), startedAt: null,
    };
    this.rooms.set(room.code, room); this.bind(socket, room, player);
    this.addLog(room, `${player.name} tạo phòng UNO ${room.code}.`); this.touch(room);
    return this.credentials(room, player);
  }

  joinRoom(socket, code, name, avatar) {
    if (this.playerRoom.has(socket.id)) return { error: 'Bạn đang ở trong một phòng khác.' };
    const room = this.rooms.get(code);
    if (!room) return { error: 'Không tìm thấy phòng UNO.' };
    if (room.phase !== 'WAITING') return { error: 'Ván UNO đang diễn ra. Chỉ người cũ mới có thể khôi phục ghế.' };
    if (room.players.length >= 6) return { error: 'Phòng UNO đã đủ 6 người.' };
    const profile = this.profileForSocket(socket);
    if (profile && room.players.some(p => p.profileId === profile.id)) return { error: 'Hồ sơ này đã có ghế trong phòng. Hãy khôi phục ghế cũ.' };
    if (room.players.some(p => p.name.toLowerCase() === cleanName(name).toLowerCase())) return { error: 'Tên này đã được dùng trong phòng.' };
    const player = this.newPlayer(socket, name, avatar);
    room.players.push(player); this.bind(socket, room, player); this.addLog(room, `${player.name} tham gia.`); this.touch(room); this.broadcast(room.code);
    return this.credentials(room, player);
  }

  resumeRoom(socket, code, token) {
    const room = this.rooms.get(code), player = room?.players.find(p => typeof token === 'string' && p.token === token);
    if (!player) return { error: 'Phiên UNO đã hết hạn hoặc phòng không còn tồn tại.' };
    const profile = this.profileForSocket(socket);
    if (player.profileId && player.profileId !== profile?.id) return { error: 'Ghế này thuộc về một hồ sơ khác.' };
    const existing = this.playerRoom.get(socket.id);
    if (existing && existing !== code) return { error: 'Bạn đang ở phòng khác.' };
    if (player.connected && player.socketId !== socket.id) return { error: 'Ghế này đang mở ở cửa sổ khác.' };
    this.bind(socket, room, player); this.ensureHost(room); this.addLog(room, `${player.name} đã nối lại.`); this.touch(room); this.broadcast(code);
    return this.credentials(room, player);
  }

  ensureHost(room) {
    if (room.players.some(p => p.isHost && p.connected)) return;
    const next = room.players.find(p => p.connected) || room.players[0];
    room.players.forEach(p => { p.isHost = p === next; });
  }
  setReady(socket, code, ready) {
    const ctx = this.access(socket, code, ['WAITING']); if (!ctx || ctx.error) return ctx;
    ctx.player.ready = !!ready; this.touch(ctx.room); this.broadcast(code);
  }
  startGame(socket, code) {
    const ctx = this.access(socket, code, ['WAITING']); if (!ctx || ctx.error) return ctx;
    const { room, player } = ctx;
    if (!player.isHost) return this.error(socket, 'Chỉ chủ phòng được bắt đầu ván.');
    if (room.players.length < 2) return this.error(socket, 'UNO cần từ 2 đến 6 người.');
    if (room.players.some(p => !p.ready || !p.connected)) return this.error(socket, 'Tất cả người chơi đang kết nối cần bấm Sẵn sàng.');
    this.startRound(room); this.broadcast(code);
  }

  startRound(room) {
    room.matchId = crypto.randomUUID(); room.revision = 0; room.direction = 1; room.pendingDraw = null; room.pendingUno = null; room.pendingWdf = null;
    room.result = null; room.paused = false; room.pausedClock = null; room.startedAt = now(); room.drawPile = shuffle(createUnoDeck()); room.discardPile = [];
    room.players.forEach(p => { p.hand = []; p.ready = false; });
    for (let i = 0; i < 7; i++) room.players.forEach(player => player.hand.push(this.takeCard(room)));
    let opening = this.takeCard(room);
    // A Wild Draw Four is never a valid opening card in this local ruleset.
    while (opening.symbol === 'wild4') { room.drawPile.unshift(opening); opening = this.takeCard(room); }
    room.discardPile.push(opening); room.currentColor = opening.color || COLORS[crypto.randomInt(COLORS.length)];
    const starterIndex = crypto.randomInt(room.players.length);
    room.currentPlayerId = room.players[starterIndex].id; room.phase = 'TURN';
    this.addLog(room, `Bắt đầu ván UNO. Lá mở đầu: ${cardLabel(opening)}${opening.color ? ` ${COLOR_NAMES[opening.color]}` : `, màu ${COLOR_NAMES[room.currentColor]}`}.`);
    this.applyOpeningCard(room, opening);
    this.touch(room);
  }
  applyOpeningCard(room, card) {
    if (card.symbol === 'reverse') { room.direction *= -1; if (room.players.length === 2) this.advanceFrom(room, room.currentPlayerId, 2); }
    if (card.symbol === 'skip') this.advanceFrom(room, room.currentPlayerId);
    if (card.symbol === 'draw2') {
      const target = room.currentPlayerId; this.drawCards(room, this.byId(room, target), 2); this.advanceFrom(room, target);
      this.addLog(room, 'Lá mở đầu +2: người đi đầu rút 2 lá và mất lượt.');
    }
  }
  takeCard(room) {
    if (!room.drawPile.length) this.recycleDiscard(room);
    if (!room.drawPile.length) throw new Error('Không còn lá UNO để rút.');
    return room.drawPile.pop();
  }
  recycleDiscard(room) {
    if (room.discardPile.length <= 1) return;
    const top = room.discardPile.pop(); room.drawPile = shuffle(room.discardPile); room.discardPile = [top];
    this.addLog(room, 'Đã xáo lại chồng bài bỏ.');
  }
  drawCards(room, player, count) { for (let i = 0; i < count; i++) player.hand.push(this.takeCard(room)); }
  byId(room, id) { return room.players.find(p => p.id === id); }
  indexOf(room, id) { return room.players.findIndex(p => p.id === id); }
  nextPlayerId(room, id, steps = 1) {
    const index = this.indexOf(room, id);
    return room.players[(index + room.direction * steps + room.players.length * 10) % room.players.length].id;
  }
  advanceFrom(room, id, steps = 1) {
    room.currentPlayerId = this.nextPlayerId(room, id, steps); room.phase = 'TURN';
    room.pendingDraw = null; room.pendingWdf = null; room.pendingUno = null;
  }
  isPlayable(room, player, card) {
    const top = room.discardPile.at(-1);
    // A Wild Draw Four can be attempted even with the current colour.  The
    // target's challenge is what checks that hidden fact; rejecting it here
    // would make a successful challenge impossible to represent or test.
    if (card.symbol === 'wild' || card.symbol === 'wild4') return true;
    return card.color === room.currentColor || card.symbol === top.symbol;
  }
  verifyAction(room, data) {
    if (!Number.isInteger(data.expectedRevision) || data.expectedRevision !== room.revision) return 'Trạng thái đã thay đổi. Vui lòng thao tác lại.';
    if (typeof data.actionId !== 'string' || data.actionId.length < 8 || data.actionId.length > 128) return 'Thiếu mã thao tác hợp lệ.';
    if (room.actionIds[data.actionId]) return 'duplicate';
    return null;
  }
  rememberAction(room, actionId) {
    room.actionIds[actionId] = true;
    const ids = Object.keys(room.actionIds);
    if (ids.length > 200) ids.slice(0, ids.length - 200).forEach(id => delete room.actionIds[id]);
  }
  action(socket, code, data) {
    const ctx = this.access(socket, code); if (!ctx || ctx.error) return ctx;
    const { room, player } = ctx, invalid = this.verifyAction(room, data || {});
    if (invalid === 'duplicate') return; // idempotent retry: state was already emitted.
    if (invalid) return this.error(socket, invalid);
    let result;
    switch (data.action) {
      case 'play': result = this.play(socket, room, player, data); break;
      case 'draw': result = this.draw(socket, room, player); break;
      case 'pass': result = this.pass(socket, room, player); break;
      case 'declare_uno': result = this.declareUno(socket, room, player); break;
      case 'catch_uno': result = this.catchUno(socket, room, player); break;
      case 'challenge_wdf': result = this.challengeWdf(socket, room, player); break;
      case 'accept_wdf': result = this.acceptWdf(socket, room, player); break;
      case 'draw_penalty': result = this.drawPenalty(socket, room, player); break;
      case 'play_again': result = this.playAgain(socket, room, player); break;
      default: return this.error(socket, 'Hành động UNO không hợp lệ.');
    }
    if (result === false) return;
    this.rememberAction(room, data.actionId); this.touch(room); this.broadcast(code);
  }
  requireCurrent(socket, room, player) {
    if (room.currentPlayerId !== player.id) { this.error(socket, 'Chưa đến lượt của bạn.'); return false; }
    return true;
  }
  play(socket, room, player, data) {
    if (room.phase !== 'TURN' || !this.requireCurrent(socket, room, player)) return false;
    const card = player.hand.find(c => c.id === data.cardId);
    if (!card || !this.isPlayable(room, player, card)) { this.error(socket, 'Lá bài này không thể đánh lúc này.'); return false; }
    if (room.drawnCardId && card.id !== room.drawnCardId) { this.error(socket, 'Sau khi rút, bạn chỉ được đánh lá vừa rút hoặc kết thúc lượt.'); return false; }
    if ((card.symbol === 'wild' || card.symbol === 'wild4') && !COLORS.includes(data.color)) { this.error(socket, 'Hãy chọn màu mới.'); return false; }
    const previousColor = room.currentColor;
    player.hand = player.hand.filter(c => c.id !== card.id); room.discardPile.push(card); room.currentColor = card.color || data.color; room.drawnCardId = null;
    const declared = !!room.unoDeclaredForTurn; room.unoDeclaredForTurn = false;
    this.addLog(room, `${player.name} đánh ${cardLabel(card)}${card.color ? ` ${COLOR_NAMES[card.color]}` : `, chọn ${COLOR_NAMES[room.currentColor]}`}.`);
    room.pendingResolution = { actorId: player.id, cardSymbol: card.symbol, originalColor: previousColor, directionBefore: room.direction,
      winner: !player.hand.length ? { playerId: player.id, card } : null };
    if (!player.hand.length) { this.resolveAfterPlay(room); return true; }
    if (player.hand.length === 1 && !declared) {
      room.phase = 'UNO_WINDOW'; room.pendingUno = { targetId: player.id, deadlineAt: now() + 12000 };
      this.addLog(room, `${player.name} còn một lá nhưng chưa gọi UNO.`); return true;
    }
    this.resolveAfterPlay(room); return true;
  }
  draw(socket, room, player) {
    if (room.phase !== 'TURN' || !this.requireCurrent(socket, room, player)) return false;
    if (room.drawnCardId) { this.error(socket, 'Bạn đã rút bài trong lượt này.'); return false; }
    const card = this.takeCard(room); player.hand.push(card); room.drawnCardId = card.id; room.unoDeclaredForTurn = false;
    this.addLog(room, `${player.name} rút một lá.`); return true;
  }
  pass(socket, room, player) {
    if (room.phase !== 'TURN' || !this.requireCurrent(socket, room, player)) return false;
    if (!room.drawnCardId) { this.error(socket, 'Bạn cần rút bài trước khi kết thúc lượt.'); return false; }
    room.drawnCardId = null; room.unoDeclaredForTurn = false; this.advanceFrom(room, player.id); this.addLog(room, `${player.name} kết thúc lượt.`); return true;
  }
  declareUno(socket, room, player) {
    if (room.phase !== 'TURN' || !this.requireCurrent(socket, room, player)) return false;
    if (player.hand.length !== 2) { this.error(socket, 'Bạn chỉ gọi UNO ngay trước khi đánh lá áp chót.'); return false; }
    room.unoDeclaredForTurn = true; this.addLog(room, `${player.name} gọi UNO!`); return true;
  }
  catchUno(socket, room, player) {
    if (room.phase !== 'UNO_WINDOW' || !room.pendingUno || player.id === room.pendingUno.targetId) { this.error(socket, 'Không có người nào để bắt lỗi UNO lúc này.'); return false; }
    const target = this.byId(room, room.pendingUno.targetId); this.drawCards(room, target, 2); this.addLog(room, `${player.name} bắt lỗi UNO; ${target.name} rút 2 lá.`); room.pendingUno = null; this.resolveAfterPlay(room); return true;
  }
  resolveAfterPlay(room) {
    const pending = room.pendingResolution; room.pendingResolution = null;
    if (!pending) return;
    const actor = this.byId(room, pending.actorId), symbol = pending.cardSymbol, finish = () => this.finish(room, this.byId(room, pending.winner.playerId), pending.winner.card);
    if (pending.winner && !['draw2', 'wild4'].includes(symbol)) return finish();
    if (symbol === 'reverse') {
      room.direction *= -1;
      if (room.players.length === 2) { this.advanceFrom(room, actor.id, 2); return; }
      this.advanceFrom(room, actor.id); return;
    }
    if (symbol === 'skip') { this.advanceFrom(room, actor.id, 2); return; }
    const targetId = this.nextPlayerId(room, actor.id);
    if (symbol === 'draw2') { room.phase = 'DRAW_PENALTY'; room.currentPlayerId = targetId; room.pendingDraw = { targetId, count: 2, winner: pending.winner }; return; }
    if (symbol === 'wild4') { room.phase = 'WDF_CHALLENGE'; room.currentPlayerId = targetId; room.pendingWdf = { targetId, offenderId: actor.id, deadlineAt: now() + 12000, offenderHadColor: actor.hand.some(c => c.color === pending.originalColor), winner: pending.winner }; return; }
    this.advanceFrom(room, actor.id);
  }
  finishUnoWindow(room) { if (room.phase === 'UNO_WINDOW') { room.pendingUno = null; this.resolveAfterPlay(room); } }
  drawPenalty(socket, room, player) {
    if (room.phase !== 'DRAW_PENALTY' || !room.pendingDraw || room.pendingDraw.targetId !== player.id) { this.error(socket, 'Bạn không có phạt rút bài cần xử lý.'); return false; }
    const winner = room.pendingDraw.winner;
    this.drawCards(room, player, room.pendingDraw.count); this.addLog(room, `${player.name} rút ${room.pendingDraw.count} lá và mất lượt.`);
    if (winner) this.finish(room, this.byId(room, winner.playerId), winner.card); else this.advanceFrom(room, player.id);
    return true;
  }
  acceptWdf(socket, room, player) {
    if (room.phase !== 'WDF_CHALLENGE' || !room.pendingWdf || room.pendingWdf.targetId !== player.id) { this.error(socket, 'Bạn không có lá +4 cần quyết định.'); return false; }
    const winner = room.pendingWdf.winner;
    this.drawCards(room, player, 4); this.addLog(room, `${player.name} chấp nhận +4 và mất lượt.`);
    if (winner) this.finish(room, this.byId(room, winner.playerId), winner.card); else this.advanceFrom(room, player.id);
    return true;
  }
  challengeWdf(socket, room, player) {
    if (room.phase !== 'WDF_CHALLENGE' || !room.pendingWdf || room.pendingWdf.targetId !== player.id) { this.error(socket, 'Bạn không thể phản đối lá +4 lúc này.'); return false; }
    const pending = room.pendingWdf, offender = this.byId(room, pending.offenderId), finish = () => this.finish(room, this.byId(room, pending.winner.playerId), pending.winner.card);
    if (pending.offenderHadColor) {
      this.drawCards(room, offender, 4); this.addLog(room, `Phản đối thành công: ${offender.name} có màu ${COLOR_NAMES[room.currentColor]} và rút 4 lá.`);
      if (pending.winner) finish(); else { room.pendingWdf = null; room.phase = 'TURN'; room.currentPlayerId = player.id; }
    } else {
      this.drawCards(room, player, 6); this.addLog(room, `Phản đối không thành: ${player.name} rút 6 lá và mất lượt.`);
      if (pending.winner) finish(); else this.advanceFrom(room, player.id);
    }
    return true;
  }
  finish(room, winner, card) {
    room.phase = 'RESULT'; room.currentPlayerId = null; room.pendingDraw = null; room.pendingUno = null; room.pendingWdf = null; room.pendingResolution = null;
    const result = { matchId: room.matchId, winnerId: winner.id, winnerName: winner.name, finalCard: card, completedAt: new Date().toISOString(), durationMs: now() - room.startedAt };
    room.result = result; room.history.unshift(result); room.history = room.history.slice(0, 50);
    if (this.onMatchCompleted) this.onMatchCompleted({
      matchId: room.matchId, gameId: 'uno', roomCode: room.code, completedAt: result.completedAt,
      players: room.players.map(player => ({ profileId: player.profileId, outcome: player.id === winner.id ? 'WIN' : 'LOSS' })),
      result: { winnerProfileId: winner.profileId || null, winnerName: winner.name, durationMs: result.durationMs },
    });
    this.addLog(room, `${winner.name} đánh hết bài và thắng ván UNO.`); return true;
  }
  playAgain(socket, room, player) {
    if (room.phase !== 'RESULT' || !player.isHost) { this.error(socket, 'Chỉ chủ phòng được chơi lại sau khi ván kết thúc.'); return false; }
    room.players.forEach(p => { p.ready = true; }); this.startRound(room); return true;
  }
  pauseClock(room) {
    if (!['UNO_WINDOW', 'WDF_CHALLENGE'].includes(room.phase) || room.pausedClock) return;
    const deadline = room.phase === 'UNO_WINDOW' ? room.pendingUno?.deadlineAt : room.pendingWdf?.deadlineAt;
    if (!deadline) return;
    room.pausedClock = { phase: room.phase, remainingMs: Math.max(0, deadline - now()) };
    if (room.pendingUno) room.pendingUno.deadlineAt = null;
    if (room.pendingWdf) room.pendingWdf.deadlineAt = null;
  }
  resumeClock(room) {
    if (!room.pausedClock) { room.paused = false; return; }
    const deadlineAt = now() + room.pausedClock.remainingMs;
    if (room.phase === 'UNO_WINDOW' && room.pendingUno) room.pendingUno.deadlineAt = deadlineAt;
    if (room.phase === 'WDF_CHALLENGE' && room.pendingWdf) room.pendingWdf.deadlineAt = deadlineAt;
    room.pausedClock = null; room.paused = false;
  }
  handleDisconnect(socket) {
    const code = this.playerRoom.get(socket.id), room = this.rooms.get(code), player = this.player(room, socket); this.playerRoom.delete(socket.id);
    if (!player) return;
    player.connected = false; player.socketId = null; player.disconnectedAt = now(); this.ensureHost(room);
    if (ACTIVE_PHASES.has(room.phase)) { room.paused = true; this.pauseClock(room); }
    this.addLog(room, `${player.name} mất kết nối; ván tạm dừng để giữ ghế.`); this.touch(room); this.broadcast(code);
  }
  leaveRoom(socket, code) {
    const ctx = this.access(socket, code, ['WAITING', 'RESULT']); if (!ctx || ctx.error) return ctx;
    const { room, player } = ctx; room.players = room.players.filter(p => p !== player); this.playerRoom.delete(socket.id); socket.leave(code);
    socket.emit('room_left');
    if (!room.players.length) { this.rooms.delete(code); this.saveSoon(); return; }
    this.ensureHost(room); this.addLog(room, `${player.name} rời phòng.`); this.touch(room); this.broadcast(code);
  }
  syncState(socket, code) { const ctx = this.access(socket, code); if (ctx && !ctx.error) socket.emit('game_state', this.buildStateFor(ctx.room, ctx.player.id)); return ctx; }
  cleanup() {
    for (const room of this.rooms.values()) {
      if (room.phase === 'UNO_WINDOW' && room.pendingUno?.deadlineAt && room.pendingUno.deadlineAt <= now()) { this.addLog(room, 'Hết thời gian bắt lỗi UNO.'); this.finishUnoWindow(room); this.touch(room); this.broadcast(room.code); }
      if (room.phase === 'WDF_CHALLENGE' && room.pendingWdf?.deadlineAt && room.pendingWdf.deadlineAt <= now()) {
        const pending = room.pendingWdf, target = this.byId(room, pending.targetId); if (target) { this.drawCards(room, target, 4); this.addLog(room, `${target.name} không phản hồi +4, rút 4 lá và mất lượt.`); if (pending.winner) this.finish(room, this.byId(room, pending.winner.playerId), pending.winner.card); else this.advanceFrom(room, target.id); this.touch(room); this.broadcast(room.code); }
      }
      if (!room.players.some(p => p.connected) && now() - room.updatedAt > 12 * 3600000) this.rooms.delete(room.code);
      if (room.phase === 'WAITING') {
        const expired = room.players.filter(p => !p.connected && now() - p.disconnectedAt > this.graceMs);
        if (expired.length) { room.players = room.players.filter(p => !expired.includes(p)); this.ensureHost(room); this.touch(room); if (room.players.length) this.broadcast(room.code); else this.rooms.delete(room.code); }
      }
    }
  }
  broadcast(code) {
    const room = this.rooms.get(code); if (!room) return;
    room.updatedAt = now();
    for (const player of room.players) {
      const socket = this.io.sockets.sockets.get(player.socketId);
      if (socket && player.connected) socket.emit('game_state', this.buildStateFor(room, player.id));
    }
    this.saveSoon();
  }
  buildStateFor(room, playerId) {
    const me = this.byId(room, playerId), top = room.discardPile.at(-1), pendingUno = room.pendingUno;
    return {
      gameId: 'uno', roomCode: room.code, myId: playerId, phase: room.phase, phaseKey: this.phaseKey(room), revision: room.revision,
      matchId: room.matchId, direction: room.direction, currentPlayerId: room.currentPlayerId, currentColor: room.currentColor,
      discardTop: top || null, drawPileCount: room.drawPile.length, paused: room.paused,
      reactionDeadlineAt: pendingUno?.deadlineAt || room.pendingWdf?.deadlineAt || null,
      pendingUno: pendingUno ? { targetId: pendingUno.targetId } : null,
      pendingWdf: room.pendingWdf ? { targetId: room.pendingWdf.targetId, offenderId: room.pendingWdf.offenderId } : null,
      pendingDraw: room.pendingDraw ? { targetId: room.pendingDraw.targetId, count: room.pendingDraw.count } : null,
      myHand: me?.hand || [], drawnCardId: me?.id === room.currentPlayerId ? room.drawnCardId || null : null,
      unoDeclaredForTurn: me?.id === room.currentPlayerId ? !!room.unoDeclaredForTurn : false,
      players: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, isHost: p.isHost, ready: p.ready, connected: p.connected, handCount: p.hand.length })),
      result: room.result, history: room.history, log: room.log,
    };
  }
  load() {
    if (!this.storageFile || !fs.existsSync(this.storageFile)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.storageFile, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.rooms)) throw new Error('Định dạng lưu UNO không hợp lệ');
      for (const room of saved.rooms) {
        if (now() - room.updatedAt > 12 * 3600000) continue;
        room.players.forEach(p => { p.connected = false; p.socketId = null; p.disconnectedAt = now(); });
        room.paused = ACTIVE_PHASES.has(room.phase); this.pauseClock(room); this.rooms.set(room.code, room);
      }
    } catch (error) { console.error('Không đọc được dữ liệu phòng UNO:', error.message); this.storageError = true; }
  }
  saveSoon() {
    if (!this.storageFile || this.storageError || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 100); this.saveTimer.unref();
  }
  flush() {
    if (!this.storageFile || this.storageError) return;
    try {
      fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
      fs.writeFileSync(`${this.storageFile}.tmp`, JSON.stringify({ version: 1, rooms: [...this.rooms.values()] }), { mode: 0o600 });
      fs.renameSync(`${this.storageFile}.tmp`, this.storageFile);
    } catch (error) { console.error('Không lưu được dữ liệu phòng UNO:', error.message); }
  }
}

module.exports = { UnoManager };
