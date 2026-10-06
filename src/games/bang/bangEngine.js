'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { leaveCompletedSeats } = require('../../platform/completedRoom');
const { DEFAULT_RECONNECT_GRACE_MS, markDisconnected, markConnected, restoreDisconnectedSeats, isReconnectExpired, reconnectWaiters, isServerActionSocket, serverActionPlayer } = require('../../platform/reconnectGrace');
const { runStorageOperation } = require('../../platform/storageDiagnostics');
const {
  CHARACTERS, ROLE_SETS, ROLE_LABELS, CARD_META, createBangDeck, shuffle, isRed, isHeart, isDynamiteHit, cardLabel,
} = require('./bangDeck');

const AVATARS = ['🤠', '🕶️', '🥷', '💻', '🎲', '🏜️'];
const ACTIVE_PHASES = new Set(['DRAW', 'MAIN', 'DISCARD']);
const now = () => Date.now();
const cleanName = value => require('../../../public/js/game-values').cleanDisplayName(value) || 'Player';
const characterById = id => CHARACTERS.find(character => character.id === id);
const isWeapon = card => Number.isInteger(card?.weaponRange);

class BangManager {
  constructor(io, options = {}) {
    this.io = io; this.rooms = new Map(); this.playerRoom = new Map(); this.storageFile = options.storageFile || null;
    this.storageDiagnostics = options.storageDiagnostics || options.profileStore?.storageDiagnostics || null;
    this.graceMs = options.graceMs ?? DEFAULT_RECONNECT_GRACE_MS; this.codeTaken = typeof options.codeTaken === 'function' ? options.codeTaken : () => false;
    this.profileForSocket = typeof options.profileForSocket === 'function' ? options.profileForSocket : () => null;
    this.profileStore = options.profileStore;
    this.onMatchCompleted = typeof options.onMatchCompleted === 'function' ? options.onMatchCompleted : null;
    this.shuffle = typeof options.shuffle === 'function' ? options.shuffle : shuffle;
    this.load();
    require('../../platform/turnTimeouts').attachGameClock(this, 'bang');
    const { installGameStateTransactions, wrapGameStateMutations } = require('../../platform/gameStateTransactions');
    installGameStateTransactions(this, ['bang'], () => 'bang');
    wrapGameStateMutations(this, this, ['createRoom', 'joinRoom', 'resumeRoom', 'setReady', 'startGame', 'startRound',
      'action', 'finish', 'playAgain', 'handleDisconnect', 'leaveRoom', 'cleanup', 'broadcast']);
    this.cleanupTimer = setInterval(() => this.cleanup(), 1000); this.cleanupTimer.unref();
  }

  close() { clearInterval(this.cleanupTimer); clearTimeout(this.saveTimer); this.flush(); }
  error(socket, message) { socket.emit('game_error', { message }); return { error: message }; }
  code() { const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code; do { code = Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join(''); } while (this.rooms.has(code) || this.codeTaken(code)); return code; }
  newPlayer(socket, name, avatar, isHost = false) {
    const profile = this.profileForSocket(socket);
    return { id: crypto.randomUUID(), token: crypto.randomBytes(32).toString('hex'), socketId: socket.id, profileId: profile?.id || null,
      name: cleanName(profile?.displayName || name), avatar: profile?.avatar || (AVATARS.includes(avatar) ? avatar : AVATARS[0]),
      isHost, connected: true, disconnectedAt: null, reconnectDeadlineAt: null, ready: false, role: null, characterId: null, hp: 0, maxHp: 0,
      hand: [], equipment: [], dead: false, bangCount: 0, leaveAfterHand: false };
  }
  credentials(room, player) { return { roomCode: room.code, playerId: player.id, sessionToken: player.token, gameId: 'bang' }; }
  byId(room, id) { return room?.players.find(player => player.id === id); }
  player(room, socket) { return serverActionPlayer(this, room, socket) || room?.players.find(player => player.connected && player.socketId === socket.id); }
  refreshReconnectState(room, at = now()) {
    const wasPaused = !!room.paused, waiting = reconnectWaiters(room, at, this.graceMs);
    room.reconnectPaused = waiting.length > 0; room.paused = ACTIVE_PHASES.has(room.phase) && room.reconnectPaused;
    return { wasPaused, waiting };
  }
  living(room) { return room.players.filter(player => !player.dead); }
  bind(socket, room, player) {
    player.name = cleanName(this.profileForSocket(socket)?.displayName || player.name);
    this.playerRoom.set(socket.id, room.code); socket.join(room.code); player.socketId = socket.id; markConnected(player);
    const { wasPaused, waiting } = this.refreshReconnectState(room);
    if (wasPaused && !waiting.length) { this.addLog(room, 'Mọi người đã kết nối lại; ván tiếp tục.'); this.touch(room); }
  }
  ensureHost(room) { if (room.players.some(player => player.isHost && player.connected)) return; const next = room.players.find(player => player.connected) || room.players[0]; room.players.forEach(player => { player.isHost = player === next; }); }
  addLog(room, message) { room.log.unshift({ id: crypto.randomUUID(), message, at: new Date().toISOString() }); room.log = room.log.slice(0, 80); }
  touch(room) { room.revision = (room.revision || 0) + 1; room.updatedAt = now(); this.saveSoon(); }
  access(socket, code, phases) {
    const room = this.rooms.get(code), player = this.player(room, socket);
    if (!room || !player) return this.error(socket, 'Bạn không còn ở trong phòng BANG! này.');
    if (phases && !phases.includes(room.phase)) return this.error(socket, 'Thao tác không phù hợp với giai đoạn hiện tại.');
    const { waiting } = this.refreshReconnectState(room);
    if (!isServerActionSocket(this, socket) && ACTIVE_PHASES.has(room.phase) && waiting.length) return this.error(socket, `Ván đang tạm dừng; chờ ${waiting.map(item => item.name).join(', ')} kết nối lại.`);
    return { room, player };
  }

  createRoom(socket, name, avatar) {
    if (this.playerRoom.has(socket.id)) return { error: 'Hãy rời phòng hiện tại trước khi tạo phòng mới.' };
    const player = this.newPlayer(socket, name, avatar, true);
    const room = { code: this.code(), gameId: 'bang', rulesVersion: 'base-4th-edition-v1', phase: 'WAITING', revision: 0, matchId: null,
      players: [player], deck: [], discard: [], currentPlayerId: null, pending: null, result: null, actionIds: {}, log: [], paused: false, createdAt: now(), updatedAt: now() };
    this.rooms.set(room.code, room); this.bind(socket, room, player); this.addLog(room, `${player.name} tạo bàn BANG! ${room.code}.`); this.touch(room); return this.credentials(room, player);
  }
  joinRoom(socket, code, name, avatar) {
    if (this.playerRoom.has(socket.id)) return { error: 'Bạn đang ở trong một phòng khác.' };
    const room = this.rooms.get(code); if (!room) return { error: 'Không tìm thấy phòng BANG!.' }; if (room.phase !== 'WAITING') return { error: 'Ván đang diễn ra. Chỉ người cũ mới có thể khôi phục ghế.' };
    if (room.players.length >= 7) return { error: 'Bàn BANG! đã đủ 7 người.' };
    const profile = this.profileForSocket(socket); if (profile && room.players.some(item => item.profileId === profile.id)) return { error: 'Hồ sơ này đã có ghế trong bàn. Hãy khôi phục ghế cũ.' };
    const player = this.newPlayer(socket, name, avatar); room.players.push(player); this.bind(socket, room, player); this.addLog(room, `${player.name} tham gia bàn.`); this.touch(room); this.broadcast(code); return this.credentials(room, player);
  }
  resumeRoom(socket, code, token) {
    const room = this.rooms.get(code), player = room?.players.find(item => typeof token === 'string' && item.token === token);
    if (!player) return { error: 'Phiên BANG! đã hết hạn hoặc phòng không còn tồn tại.' };
    const profile = this.profileForSocket(socket); if (player.profileId && player.profileId !== profile?.id) return { error: 'Ghế này thuộc về một hồ sơ khác.' };
    const active = this.playerRoom.get(socket.id); if (active && active !== code) return { error: 'Bạn đang ở phòng khác.' }; if (player.connected && player.socketId !== socket.id) return { error: 'Ghế này đang mở ở cửa sổ khác.' };
    this.bind(socket, room, player); this.ensureHost(room); this.addLog(room, `${player.name} đã nối lại.`); this.touch(room); this.broadcast(code); return this.credentials(room, player);
  }
  setReady(socket, code, ready) { const ctx = this.access(socket, code, ['WAITING']); if (!ctx || ctx.error) return ctx; ctx.player.ready = !!ready; this.touch(ctx.room); this.broadcast(code); return { ok: true }; }
  startGame(socket, code) {
    const ctx = this.access(socket, code, ['WAITING']); if (!ctx || ctx.error) return ctx; const { room, player } = ctx;
    if (!player.isHost) return this.error(socket, 'Chỉ chủ phòng được bắt đầu ván.');
    if (room.players.length < 4 || room.players.length > 7) return this.error(socket, 'BANG! bộ cơ bản cần từ 4 đến 7 người.');
    if (room.players.some(item => !item.ready || !item.connected)) return this.error(socket, 'Tất cả người chơi đang kết nối cần bấm Sẵn sàng.');
    this.startRound(room); this.broadcast(code); return { ok: true };
  }
  startRound(room) {
    room.reconnectPolicyVersion = 2; room.matchId = crypto.randomUUID(); room.deck = this.shuffle(createBangDeck()); room.discard = []; room.result = null; room.pending = null; room.actionIds = {}; room.paused = false; room.reconnectPaused = false;
    const roles = this.shuffle(ROLE_SETS[room.players.length]), characters = this.shuffle(CHARACTERS);
    room.players.forEach((player, index) => {
      const character = characters[index], sheriff = roles[index] === 'SHERIFF'; player.role = roles[index]; player.characterId = character.id; player.maxHp = character.maxHp + (sheriff ? 1 : 0); player.hp = player.maxHp; player.hand = []; player.equipment = []; player.dead = false; player.bangCount = 0; player.ready = false; player.leaveAfterHand = false;
    });
    room.players.forEach(player => this.drawToHand(room, player, player.hp));
    const sheriff = room.players.find(player => player.role === 'SHERIFF'); room.currentPlayerId = sheriff.id; room.phase = 'DRAW';
    this.addLog(room, `Đã chia vai, nhân vật và bài. ${sheriff.name} là Sheriff và đi trước.`); this.startTurn(room); this.touch(room); this.flush();
  }
  verifyAction(room, data) { if (!Number.isInteger(data?.expectedRevision) || data.expectedRevision !== room.revision) return 'Trạng thái đã thay đổi. Vui lòng thao tác lại.'; if (typeof data?.actionId !== 'string' || data.actionId.length < 8 || data.actionId.length > 128) return 'Thiếu mã thao tác hợp lệ.'; return room.actionIds[data.actionId] ? 'duplicate' : null; }
  rememberAction(room, id) { room.actionIds[id] = true; const ids = Object.keys(room.actionIds); if (ids.length > 250) ids.slice(0, ids.length - 250).forEach(key => delete room.actionIds[key]); }
  action(socket, code, data) {
    const ctx = this.access(socket, code); if (!ctx || ctx.error) return ctx; const invalid = this.verifyAction(ctx.room, data); if (invalid === 'duplicate') return; if (invalid) return this.error(socket, invalid);
    let result;
    if (data.action === 'sid_heal') result = this.sidHeal(socket, ctx.room, ctx.player, data);
    else if (ctx.room.pending) result = this.respond(socket, ctx.room, ctx.player, data);
    else if (data.action === 'draw_cards') result = this.drawCards(socket, ctx.room, ctx.player, data);
    else if (data.action === 'play_card') result = this.playCard(socket, ctx.room, ctx.player, data);
    else if (data.action === 'end_turn') result = this.endTurn(socket, ctx.room, ctx.player, data);
    else if (data.action === 'play_again') result = this.playAgain(socket, ctx.room, ctx.player);
    else return this.error(socket, 'Hành động BANG! không hợp lệ.');
    if (result === false || result?.error) return result;
    this.rememberAction(ctx.room, data.actionId); this.touch(ctx.room); this.broadcast(code); return { ok: true };
  }
  requireCurrent(socket, room, player, phase) {
    if (room.currentPlayerId !== player.id || player.dead || (phase && room.phase !== phase)) { this.error(socket, 'Chưa đến lượt hoặc không đúng giai đoạn của bạn.'); return false; }
    return true;
  }

  // Draw pile helpers recycle only cards that are publicly discarded.  Cards
  // in a General Store offer and all private hands remain outside the pool.
  drawCard(room) {
    if (!room.deck.length && room.discard.length) { room.deck = this.shuffle(room.discard); room.discard = []; this.addLog(room, 'Đã xáo lại chồng bỏ thành chồng rút.'); }
    return room.deck.shift() || null;
  }
  drawToHand(room, player, count = 1) { for (let index = 0; index < count; index += 1) { const card = this.drawCard(room); if (!card) break; player.hand.push(card); } this.checkSuzy(room, player); }
  discardCard(room, card) { if (card) room.discard.push(card); }
  removeHand(player, cardId) { const index = player.hand.findIndex(card => card.id === cardId); return index < 0 ? null : player.hand.splice(index, 1)[0]; }
  equipmentOf(player, type) { return player.equipment.find(card => card.type === type); }
  baseDistance(room, fromId, toId) {
    const alive = this.living(room), from = alive.findIndex(player => player.id === fromId), to = alive.findIndex(player => player.id === toId);
    if (from < 0 || to < 0 || from === to || alive.length < 2) return Infinity;
    const clockwise = (to - from + alive.length) % alive.length; return Math.min(clockwise, alive.length - clockwise);
  }
  distance(room, fromId, toId) {
    const from = this.byId(room, fromId), to = this.byId(room, toId); if (!from || !to || from.dead || to.dead) return Infinity;
    const scope = (this.equipmentOf(from, 'SCOPE') ? 1 : 0) + (from.characterId === 'ROSE_DOOLAN' ? 1 : 0);
    const mustang = (this.equipmentOf(to, 'MUSTANG') ? 1 : 0) + (to.characterId === 'PAUL_REGRET' ? 1 : 0);
    return Math.max(1, this.baseDistance(room, fromId, toId) - scope + mustang);
  }
  weaponRange(player) { return player.equipment.find(isWeapon)?.weaponRange || 1; }
  nextAlive(room, fromId) { const start = room.players.findIndex(player => player.id === fromId); for (let offset = 1; offset <= room.players.length; offset += 1) { const candidate = room.players[(start + offset) % room.players.length]; if (!candidate.dead) return candidate; } return null; }

  startTurn(room) {
    const player = this.byId(room, room.currentPlayerId); if (!player || player.dead || room.result) return;
    player.bangCount = 0; room.phase = 'DRAW';
    const dynamite = this.equipmentOf(player, 'DYNAMITE'); if (dynamite) { this.startDrawCheck(room, player, 'DYNAMITE', { type: 'DYNAMITE_CHECK', playerId: player.id, cardId: dynamite.id }); return; }
    const jail = this.equipmentOf(player, 'JAIL'); if (jail) { this.startDrawCheck(room, player, 'JAIL', { type: 'JAIL_CHECK', playerId: player.id, cardId: jail.id }); return; }
    this.beginDrawPhase(room, player);
  }
  beginDrawPhase(room, player) {
    if (player.characterId === 'KIT_CARLSON') {
      const options = []; for (let index = 0; index < 3; index += 1) { const card = this.drawCard(room); if (card) options.push(card); }
      room.pending = { id: crypto.randomUUID(), kind: 'KIT_DRAW', waitingId: player.id, options, message: 'Kit Carlson: chọn đúng 2 trong 3 lá.' }; return;
    }
    room.phase = 'DRAW'; this.addLog(room, `Đến lượt ${player.name}: rút bài.`);
  }
  drawCards(socket, room, player, data) {
    if (!this.requireCurrent(socket, room, player, 'DRAW')) return false;
    if (player.characterId === 'JESSE_JONES' && data.targetId) {
      const target = this.byId(room, data.targetId); if (!target || target.dead || target.id === player.id || !target.hand.length) return this.error(socket, 'Jesse chỉ có thể lấy lá đầu từ tay một người chơi còn sống đang có bài.');
      { const index = crypto.randomInt(target.hand.length); player.hand.push(target.hand.splice(index, 1)[0]); this.addLog(room, `${player.name} dùng Jesse Jones rút lá đầu từ tay ${target.name}.`); }
      this.drawToHand(room, player, 1); room.phase = 'MAIN'; this.checkSuzy(room, player); return true;
    }
    if (player.characterId === 'PEDRO_RAMIREZ' && data.from === 'discard' && room.discard.length) { player.hand.push(room.discard.pop()); this.drawToHand(room, player, 1); room.phase = 'MAIN'; this.addLog(room, `${player.name} dùng Pedro Ramirez lấy lá đầu từ chồng bỏ.`); this.checkSuzy(room, player); return true; }
    const first = this.drawCard(room), second = this.drawCard(room); if (first) player.hand.push(first); if (second) player.hand.push(second);
    if (player.characterId === 'BLACK_JACK' && second && isRed(second)) { this.drawToHand(room, player, 1); this.addLog(room, `${player.name} lật ${cardLabel(second)} đỏ bằng Black Jack và rút thêm 1 lá.`); }
    room.phase = 'MAIN'; this.checkSuzy(room, player); this.addLog(room, `${player.name} đã rút bài và có thể chơi.`); return true;
  }

  playCard(socket, room, player, data) {
    if (!this.requireCurrent(socket, room, player, 'MAIN')) return false; if (typeof data.cardId !== 'string') return this.error(socket, 'Hãy chọn một lá bài trên tay.');
    const card = player.hand.find(item => item.id === data.cardId); if (!card) return this.error(socket, 'Bạn chỉ được chơi bài trên tay mình.');
    const target = data.targetId ? this.byId(room, data.targetId) : null;
    if (['BARREL', 'SCOPE', 'MUSTANG'].includes(card.type)) {
      if (this.equipmentOf(player, card.type)) return this.error(socket, 'Không thể có hai trang bị cùng tên trước mặt.');
      this.removeHand(player, card.id); player.equipment.push(card); this.addLog(room, `${player.name} trang bị ${card.name}.`); this.checkSuzy(room, player); return true;
    }
    if (isWeapon(card)) {
      this.removeHand(player, card.id); const old = player.equipment.find(isWeapon); if (old) { player.equipment = player.equipment.filter(item => item !== old); this.discardCard(room, old); }
      player.equipment.push(card); this.addLog(room, `${player.name} trang bị ${card.name} (tầm ${card.weaponRange}).`); this.checkSuzy(room, player); return true;
    }
    if (card.type === 'DYNAMITE') {
      if (this.equipmentOf(player, 'DYNAMITE')) return this.error(socket, 'Bạn đã có Dynamite trước mặt.'); this.removeHand(player, card.id); player.equipment.push(card); this.addLog(room, `${player.name} đặt Dynamite trước mặt.`); this.checkSuzy(room, player); return true;
    }
    if (card.type === 'JAIL') {
      if (!target || target.dead || target.role === 'SHERIFF') return this.error(socket, 'Jail cần một mục tiêu còn sống không phải Sheriff.'); if (this.equipmentOf(target, 'JAIL')) return this.error(socket, 'Mục tiêu đã có Jail.');
      this.removeHand(player, card.id); target.equipment.push(card); this.addLog(room, `${player.name} bỏ ${target.name} vào Jail.`); this.checkSuzy(room, player); return true;
    }
    if (card.type === 'BANG') return this.playBang(socket, room, player, card, target);
    if (card.type === 'BEER') {
      if (this.living(room).length <= 2 || player.hp >= player.maxHp) return this.error(socket, 'Beer hiện không có tác dụng.'); this.removeHand(player, card.id); this.discardCard(room, card); player.hp += 1; this.addLog(room, `${player.name} uống Beer và hồi 1 máu.`); this.checkSuzy(room, player); return true;
    }
    if (card.type === 'SALOON') { this.removeHand(player, card.id); this.discardCard(room, card); this.living(room).forEach(item => { item.hp = Math.min(item.maxHp, item.hp + 1); }); this.addLog(room, `${player.name} mở Saloon: mọi người hồi 1 máu.`); this.checkSuzy(room, player); return true; }
    if (card.type === 'STAGECOACH' || card.type === 'WELLS_FARGO') { this.removeHand(player, card.id); this.discardCard(room, card); this.drawToHand(room, player, card.type === 'STAGECOACH' ? 2 : 3); this.addLog(room, `${player.name} dùng ${card.name}.`); return true; }
    if (card.type === 'CAT_BALOU' || card.type === 'PANIC') return this.playStealDiscard(socket, room, player, card, target, data.targetCardId);
    if (card.type === 'DUEL') {
      if (!target || target.dead || target.id === player.id) return this.error(socket, 'Duel cần một mục tiêu còn sống khác.'); this.removeHand(player, card.id); this.discardCard(room, card); this.setDuel(room, player.id, target.id); this.checkSuzy(room, player); return true;
    }
    if (card.type === 'GATLING') { this.removeHand(player, card.id); this.discardCard(room, card); this.startAttack(room, { actorId: player.id, source: 'GATLING', targetIds: this.living(room).filter(item => item.id !== player.id).map(item => item.id), index: 0 }); this.checkSuzy(room, player); return true; }
    if (card.type === 'INDIANS') { this.removeHand(player, card.id); this.discardCard(room, card); this.startIndians(room, player.id, this.living(room).filter(item => item.id !== player.id).map(item => item.id), 0); this.checkSuzy(room, player); return true; }
    if (card.type === 'GENERAL_STORE') { this.removeHand(player, card.id); this.discardCard(room, card); this.startGeneralStore(room, player.id); this.checkSuzy(room, player); return true; }
    return this.error(socket, 'Lá bài này chưa có hiệu ứng hợp lệ.');
  }
  playBang(socket, room, player, card, target) {
    if (!target || target.dead || target.id === player.id) return this.error(socket, 'BANG! cần một mục tiêu còn sống khác.');
    if (player.bangCount >= 1 && !this.equipmentOf(player, 'VOLCANIC') && player.characterId !== 'WILLY_THE_KID') return this.error(socket, 'Mỗi lượt chỉ được chơi một BANG! nếu không có Volcanic hoặc Willy the Kid.');
    if (this.distance(room, player.id, target.id) > this.weaponRange(player)) return this.error(socket, `Mục tiêu ở khoảng cách ${this.distance(room, player.id, target.id)}, ngoài tầm súng ${this.weaponRange(player)}.`);
    this.removeHand(player, card.id); this.discardCard(room, card); player.bangCount += 1;
    const missesNeeded = player.characterId === 'SLAB_THE_KILLER' ? 2 : 1; this.startAttack(room, { actorId: player.id, source: 'BANG', targetIds: [target.id], index: 0, missesNeeded }); this.checkSuzy(room, player); return true;
  }
  playStealDiscard(socket, room, player, card, target, targetCardId) {
    if (!target || target.dead || target.id === player.id) return this.error(socket, `${card.name} cần mục tiêu còn sống khác.`);
    if (card.type === 'PANIC' && this.distance(room, player.id, target.id) > 1) return this.error(socket, 'Panic! chỉ nhắm mục tiêu ở khoảng cách 1.');
    this.removeHand(player, card.id); this.discardCard(room, card);
    let stolen = null;
    if (targetCardId) { const equipment = target.equipment.find(item => item.id === targetCardId); if (!equipment) return this.error(socket, 'Chỉ được chọn trang bị đang công khai trước mặt mục tiêu.'); target.equipment = target.equipment.filter(item => item !== equipment); stolen = equipment; }
    else if (target.hand.length) { stolen = target.hand.splice(crypto.randomInt(target.hand.length), 1)[0]; }
    if (stolen) { if (card.type === 'PANIC') { player.hand.push(stolen); this.addLog(room, `${player.name} dùng Panic! lấy 1 lá từ ${target.name}.`); } else { this.discardCard(room, stolen); this.addLog(room, `${player.name} dùng Cat Balou bỏ 1 lá của ${target.name}.`); } }
    else this.addLog(room, `${player.name} dùng ${card.name} nhưng ${target.name} không còn lá để tác động.`);
    this.checkSuzy(room, player); this.checkSuzy(room, target); return true;
  }

  startAttack(room, attack) {
    const targetId = attack.targetIds[attack.index]; if (!targetId) { room.pending = null; return; }
    const target = this.byId(room, targetId); if (!target || target.dead) { attack.index += 1; this.startAttack(room, attack); return; }
    const actor = this.byId(room, attack.actorId), naturalBarrels = (this.equipmentOf(target, 'BARREL') ? 1 : 0) + (target.characterId === 'JOURDONNAIS' ? 1 : 0);
    room.pending = { id: crypto.randomUUID(), kind: 'ATTACK', waitingId: target.id, actorId: actor?.id || null, targetId: target.id, source: attack.source, attack, missesNeeded: attack.missesNeeded || 1, barrelAttempts: naturalBarrels, message: `${target.name} phải chặn ${attack.source === 'GATLING' ? 'Gatling' : 'BANG!'} hoặc mất 1 máu.` };
  }
  finishAttack(room, attack) { attack.index += 1; this.startAttack(room, attack); }
  startIndians(room, actorId, targetIds, index) {
    const targetId = targetIds[index]; if (!targetId) { room.pending = null; return; } const target = this.byId(room, targetId); if (!target || target.dead) return this.startIndians(room, actorId, targetIds, index + 1);
    room.pending = { id: crypto.randomUUID(), kind: 'INDIANS', waitingId: target.id, actorId, targetId: target.id, targetIds, index, message: `${target.name}: bỏ một BANG! hoặc mất 1 máu.` };
  }
  finishIndians(room, pending) { this.startIndians(room, pending.actorId, pending.targetIds, pending.index + 1); }
  setDuel(room, actorId, targetId) { room.pending = { id: crypto.randomUUID(), kind: 'DUEL', waitingId: targetId, actorId, targetId, message: `${this.byId(room, targetId).name} phải bỏ BANG! trong Duel hoặc mất 1 máu.` }; }
  startGeneralStore(room, actorId) {
    const order = []; let cursor = this.byId(room, actorId); for (let index = 0; index < this.living(room).length; index += 1) { order.push(cursor.id); cursor = this.nextAlive(room, cursor.id); }
    const cards = []; for (let index = 0; index < order.length; index += 1) { const card = this.drawCard(room); if (card) cards.push(card); }
    if (!cards.length) return; room.pending = { id: crypto.randomUUID(), kind: 'GENERAL_STORE', actorId, waitingId: order[0], order, index: 0, cards, message: 'General Store: chọn một lá mở.' };
  }

  respond(socket, room, player, data) {
    const pending = room.pending; if (pending.waitingId !== player.id) return this.error(socket, 'Không phải bạn cần phản ứng lúc này.');
    if (pending.kind === 'ATTACK') return this.respondAttack(socket, room, player, pending, data);
    if (pending.kind === 'INDIANS') return this.respondIndians(socket, room, player, pending, data);
    if (pending.kind === 'DUEL') return this.respondDuel(socket, room, player, pending, data);
    if (pending.kind === 'GENERAL_STORE') return this.respondStore(socket, room, player, pending, data);
    if (pending.kind === 'KIT_DRAW') return this.respondKit(socket, room, player, pending, data);
    if (pending.kind === 'DRAW_CHECK') return this.respondDrawCheck(socket, room, player, pending, data);
    if (pending.kind === 'LETHAL') return this.respondLethal(socket, room, player, pending, data);
    return this.error(socket, 'Phản ứng này không hợp lệ.');
  }
  isMissCard(player, card) { return card?.type === 'MISSED' || (player.characterId === 'CALAMITY_JANET' && card?.type === 'BANG'); }
  isBangCard(player, card) { return card?.type === 'BANG' || (player.characterId === 'CALAMITY_JANET' && card?.type === 'MISSED'); }
  respondAttack(socket, room, player, pending, data) {
    if (data.response === 'miss') {
      const card = player.hand.find(item => item.id === data.cardId); if (!this.isMissCard(player, card)) return this.error(socket, 'Cần một Missed! hợp lệ để chặn BANG!.');
      this.removeHand(player, card.id); this.discardCard(room, card); pending.missesNeeded -= 1; this.checkSuzy(room, player);
      if (pending.missesNeeded <= 0) { this.addLog(room, `${player.name} chặn được ${pending.source}.`); this.finishAttack(room, pending.attack); } return true;
    }
    if (data.response === 'barrel') {
      if (pending.barrelAttempts <= 0) return this.error(socket, 'Bạn không còn Barrel để thử.'); pending.barrelAttempts -= 1; this.startDrawCheck(room, player, 'BARREL', { type: 'BARREL_CHECK', attack: { ...pending } }); return true;
    }
    if (data.response === 'take') { this.applyDamage(room, player.id, 1, pending.actorId, pending.source, { type: 'ATTACK_DONE', attack: pending.attack }); return true; }
    return this.error(socket, 'Chọn Missed!, Barrel hoặc nhận sát thương.');
  }
  respondIndians(socket, room, player, pending, data) {
    if (data.response === 'bang') { const card = player.hand.find(item => item.id === data.cardId); if (!this.isBangCard(player, card)) return this.error(socket, 'Cần một BANG! hợp lệ để chặn Indians!.'); this.removeHand(player, card.id); this.discardCard(room, card); this.checkSuzy(room, player); this.finishIndians(room, pending); return true; }
    if (data.response === 'take') { this.applyDamage(room, player.id, 1, pending.actorId, 'INDIANS', { type: 'INDIANS_DONE', pending }); return true; }
    return this.error(socket, 'Chọn bỏ BANG! hoặc nhận sát thương.');
  }
  respondDuel(socket, room, player, pending, data) {
    if (data.response === 'bang') { const card = player.hand.find(item => item.id === data.cardId); if (!this.isBangCard(player, card)) return this.error(socket, 'Duel cần bỏ một BANG! hợp lệ.'); this.removeHand(player, card.id); this.discardCard(room, card); this.checkSuzy(room, player); const next = player.id === pending.actorId ? pending.targetId : pending.actorId; const opponent = this.byId(room, next); if (!opponent || opponent.dead) { room.pending = null; return true; } pending.waitingId = next; pending.message = `${opponent.name} phải bỏ BANG! trong Duel hoặc mất 1 máu.`; return true; }
    if (data.response === 'take') { this.applyDamage(room, player.id, 1, pending.actorId, 'DUEL', { type: 'CLEAR_PENDING' }); return true; }
    return this.error(socket, 'Chọn bỏ BANG! hoặc nhận sát thương.');
  }
  respondStore(socket, room, player, pending, data) {
    const card = pending.cards.find(item => item.id === data.cardId); if (!card) return this.error(socket, 'Hãy chọn một lá đang mở trong General Store.');
    pending.cards = pending.cards.filter(item => item !== card); player.hand.push(card); this.checkSuzy(room, player); pending.index += 1;
    if (pending.index >= pending.order.length || !pending.cards.length) { pending.cards.forEach(item => this.discardCard(room, item)); room.pending = null; return true; }
    pending.waitingId = pending.order[pending.index]; pending.message = `${this.byId(room, pending.waitingId).name} chọn một lá trong General Store.`; return true;
  }
  respondKit(socket, room, player, pending, data) {
    const ids = Array.isArray(data.cardIds) ? data.cardIds : []; if (ids.length !== 2 || new Set(ids).size !== 2 || !ids.every(id => pending.options.some(card => card.id === id))) return this.error(socket, 'Kit Carlson phải chọn đúng 2 lá trong 3 lá mở.');
    const chosen = pending.options.filter(card => ids.includes(card.id)), leftover = pending.options.find(card => !ids.includes(card.id)); player.hand.push(...chosen); if (leftover) room.deck.unshift(leftover); room.pending = null; room.phase = 'MAIN'; this.checkSuzy(room, player); this.addLog(room, `${player.name} chọn 2 lá bằng Kit Carlson.`); return true;
  }
  startDrawCheck(room, player, reason, after) {
    const count = player.characterId === 'LUCKY_DUKE' ? 2 : 1, options = []; for (let index = 0; index < count; index += 1) { const card = this.drawCard(room); if (card) { options.push(card); this.discardCard(room, card); } }
    if (!options.length) { this.resolveDrawCheck(room, player, null, reason, after); return; }
    room.pending = { id: crypto.randomUUID(), kind: 'DRAW_CHECK', waitingId: player.id, reason, options, after, message: reason === 'BARREL' ? `${player.name} rút kiểm tra Barrel.` : `${player.name} rút kiểm tra ${reason === 'DYNAMITE' ? 'Dynamite' : 'Jail'}.` };
  }
  respondDrawCheck(socket, room, player, pending, data) {
    const index = Number.isInteger(data.choiceIndex) ? data.choiceIndex : 0; if (index < 0 || index >= pending.options.length) return this.error(socket, 'Hãy chọn một kết quả rút kiểm tra hợp lệ.');
    room.pending = null; this.resolveDrawCheck(room, player, pending.options[index], pending.reason, pending.after); return true;
  }
  resolveDrawCheck(room, player, card, reason, after) {
    const success = reason === 'DYNAMITE' ? isDynamiteHit(card) : isHeart(card);
    if (after.type === 'BARREL_CHECK') { const attack = after.attack; if (success) attack.missesNeeded -= 1; if (attack.missesNeeded <= 0) { this.addLog(room, `${player.name} chặn ${attack.source} bằng Barrel.`); this.finishAttack(room, attack.attack); } else { attack.id = crypto.randomUUID(); attack.kind = 'ATTACK'; attack.waitingId = player.id; attack.barrelAttempts = attack.barrelAttempts; room.pending = attack; } return; }
    if (after.type === 'DYNAMITE_CHECK') {
      const dynamite = player.equipment.find(item => item.id === after.cardId); if (dynamite) player.equipment = player.equipment.filter(item => item !== dynamite);
      if (success) { this.discardCard(room, dynamite); this.addLog(room, `Dynamite nổ dưới chân ${player.name}.`); this.applyDamage(room, player.id, 3, null, 'DYNAMITE', { type: 'DYNAMITE_RESOLVED', playerId: player.id }); }
      else { const next = this.nextAlive(room, player.id); if (next && dynamite) next.equipment.push(dynamite); this.addLog(room, `Dynamite không nổ và được chuyền sang ${next?.name || 'người kế tiếp'}.`); this.afterDynamite(room, player.id); }
      return;
    }
    if (after.type === 'JAIL_CHECK') {
      const jail = player.equipment.find(item => item.id === after.cardId); if (jail) { player.equipment = player.equipment.filter(item => item !== jail); this.discardCard(room, jail); }
      if (success) { this.addLog(room, `${player.name} trốn Jail thành công.`); this.beginDrawPhase(room, player); }
      else { this.addLog(room, `${player.name} không trốn được Jail và bỏ lượt.`); this.advanceTurn(room); }
    }
  }
  respondLethal(socket, room, player, pending, data) {
    if (data.response === 'beer') {
      if (this.living(room).length <= 2) return this.error(socket, 'Beer không có tác dụng khi chỉ còn 2 người chơi.'); const card = player.hand.find(item => item.id === data.cardId && item.type === 'BEER'); if (!card) return this.error(socket, 'Cần một Beer để tự cứu.');
      this.removeHand(player, card.id); this.discardCard(room, card); player.hp += 1; this.checkSuzy(room, player); if (player.hp > 0) { room.pending = null; this.addLog(room, `${player.name} dùng Beer để thoát chết.`); this.resolveAfter(room, pending.after); } return true;
    }
    if (data.response === 'give_up') { room.pending = null; this.eliminate(room, player, pending.actorId, pending.reason, pending.after); return true; }
    return this.error(socket, 'Chọn Beer để tự cứu hoặc chấp nhận bị loại.');
  }

  applyDamage(room, targetId, amount, actorId, reason, after) {
    const target = this.byId(room, targetId); if (!target || target.dead || room.result) return;
    target.hp -= amount; const actor = this.byId(room, actorId); this.addLog(room, `${target.name} mất ${amount} máu do ${reason}.`);
    if (target.characterId === 'BART_CASSIDY') this.drawToHand(room, target, amount);
    if (target.characterId === 'EL_GRINGO' && actor && !actor.dead) for (let index = 0; index < amount && actor.hand.length; index += 1) target.hand.push(actor.hand.splice(crypto.randomInt(actor.hand.length), 1)[0]);
    this.checkSuzy(room, target); this.checkSuzy(room, actor);
    if (target.hp <= 0) { room.pending = { id: crypto.randomUUID(), kind: 'LETHAL', waitingId: target.id, actorId, targetId: target.id, reason, after, message: `${target.name} đang mất hết máu: dùng Beer hoặc bị loại.` }; }
    else this.resolveAfter(room, after);
  }
  eliminate(room, player, actorId, reason, after) {
    const actor = this.byId(room, actorId), fallen = [...player.hand, ...player.equipment]; player.hand = []; player.equipment = []; player.dead = true; player.hp = 0; this.addLog(room, `${player.name} bị loại (${reason}). Vai của họ được công khai: ${ROLE_LABELS[player.role]}.`);
    if (this.checkWinner(room)) return;
    const vulture = this.living(room).find(item => item.characterId === 'VULTURE_SAM'); if (vulture) { vulture.hand.push(...fallen); this.addLog(room, `${vulture.name} lấy bài của ${player.name}.`); this.checkSuzy(room, vulture); } else fallen.forEach(card => this.discardCard(room, card));
    if (actor && actor.role === 'SHERIFF' && player.role === 'DEPUTY') { actor.hand.forEach(card => this.discardCard(room, card)); actor.equipment.forEach(card => this.discardCard(room, card)); actor.hand = []; actor.equipment = []; this.addLog(room, `${actor.name} loại Deputy nên bỏ toàn bộ bài.`); }
    if (actor && player.role === 'OUTLAW') { this.drawToHand(room, actor, 3); this.addLog(room, `${actor.name} loại Outlaw và rút thưởng 3 lá.`); }
    this.resolveAfter(room, after);
  }
  resolveAfter(room, after) {
    if (!after || room.result) { room.pending = null; return; }
    if (after.type === 'ATTACK_DONE') { this.finishAttack(room, after.attack); return; }
    if (after.type === 'INDIANS_DONE') { this.finishIndians(room, after.pending); return; }
    if (after.type === 'CLEAR_PENDING') { room.pending = null; return; }
    if (after.type === 'DYNAMITE_RESOLVED') { this.afterDynamite(room, after.playerId); return; }
  }
  afterDynamite(room, playerId) { const player = this.byId(room, playerId); if (!player || player.dead) { this.advanceTurn(room); return; } const jail = this.equipmentOf(player, 'JAIL'); if (jail) this.startDrawCheck(room, player, 'JAIL', { type: 'JAIL_CHECK', playerId: player.id, cardId: jail.id }); else this.beginDrawPhase(room, player); }
  checkSuzy(room, player) { if (player && !player.dead && player.characterId === 'SUZY_LAFAYETTE' && player.hand.length === 0) { const card = this.drawCard(room); if (card) { player.hand.push(card); this.addLog(room, `${player.name} hết bài và rút 1 lá bằng Suzy Lafayette.`); } } }
  checkWinner(room) {
    const alive = this.living(room), sheriffAlive = alive.some(player => player.role === 'SHERIFF'); let faction = null;
    if (!sheriffAlive) faction = alive.length === 1 && alive[0].role === 'RENEGADE' ? 'RENEGADE' : 'OUTLAWS';
    else if (!alive.some(player => player.role === 'OUTLAW' || player.role === 'RENEGADE')) faction = 'SHERIFF_DEPUTIES';
    if (!faction) return false;
    const winnerIds = faction === 'RENEGADE' ? alive.filter(player => player.role === 'RENEGADE').map(player => player.id) : faction === 'OUTLAWS' ? room.players.filter(player => player.role === 'OUTLAW').map(player => player.id) : room.players.filter(player => player.role === 'SHERIFF' || player.role === 'DEPUTY').map(player => player.id);
    room.phase = 'RESULT'; room.pending = null; room.result = { faction, winnerIds, roles: room.players.map(player => ({ playerId: player.id, role: player.role })), message: faction === 'RENEGADE' ? 'Renegade là người sống cuối cùng.' : faction === 'OUTLAWS' ? 'Sheriff đã bị loại.' : 'Tất cả Outlaw và Renegade đã bị loại.' };
    this.addLog(room, `Ván kết thúc: ${faction === 'SHERIFF_DEPUTIES' ? 'Sheriff và Deputy' : faction === 'OUTLAWS' ? 'Outlaw' : 'Renegade'} thắng.`);
    if (this.onMatchCompleted) this.onMatchCompleted({ matchId: room.matchId, gameId: 'bang', roomCode: room.code, completedAt: new Date().toISOString(), players: room.players.map(player => ({ profileId: player.profileId, outcome: winnerIds.includes(player.id) ? 'WIN' : 'LOSS' })), result: room.result });
    leaveCompletedSeats(this, room, 'bang');
    return true;
  }

  endTurn(socket, room, player, data) {
    if (!this.requireCurrent(socket, room, player, 'MAIN')) return false; const excess = Math.max(0, player.hand.length - player.hp), ids = Array.isArray(data.cardIds) ? data.cardIds : [];
    if (ids.length !== excess || new Set(ids).size !== ids.length || !ids.every(id => player.hand.some(card => card.id === id))) return this.error(socket, excess ? `Bạn phải bỏ đúng ${excess} lá để số bài không quá máu.` : 'Không cần bỏ bài lúc này.');
    ids.forEach(id => this.discardCard(room, this.removeHand(player, id))); this.checkSuzy(room, player); this.advanceTurn(room); return true;
  }
  advanceTurn(room) { if (room.result) return; const next = this.nextAlive(room, room.currentPlayerId); if (!next) return; room.currentPlayerId = next.id; room.pending = null; this.startTurn(room); }
  sidHeal(socket, room, player, data) {
    if (!ACTIVE_PHASES.has(room.phase) || player.dead || player.characterId !== 'SID_KETCHUM' || player.hp >= player.maxHp) return this.error(socket, 'Sid Ketchum không thể hồi máu lúc này.');
    const ids = Array.isArray(data.cardIds) ? data.cardIds : []; if (ids.length !== 2 || new Set(ids).size !== 2 || !ids.every(id => player.hand.some(card => card.id === id))) return this.error(socket, 'Sid Ketchum cần bỏ đúng 2 lá trên tay.');
    ids.forEach(id => this.discardCard(room, this.removeHand(player, id))); player.hp += 1; this.addLog(room, `${player.name} dùng Sid Ketchum hồi 1 máu.`); this.checkSuzy(room, player); return true;
  }
  playAgain(socket, room, player) {
    if (room.phase !== 'RESULT' || !player.isHost) return this.error(socket, 'Chỉ chủ bàn có thể mở phòng chờ cho ván mới.');
    room.phase = 'WAITING'; room.matchId = null; room.deck = []; room.discard = []; room.currentPlayerId = null; room.pending = null; room.result = null; room.actionIds = {}; room.players.forEach(item => { item.ready = false; item.role = null; item.characterId = null; item.hp = 0; item.maxHp = 0; item.hand = []; item.equipment = []; item.dead = false; item.bangCount = 0; }); this.addLog(room, 'Trở về phòng chờ; mọi người cần sẵn sàng lại.'); return true;
  }
  leaveRoom(socket, code) {
    const room = this.rooms.get(code), player = this.player(room, socket);
    if (!room || !player || isServerActionSocket(this, socket)) return this.error(socket, 'Bạn không còn ở trong phòng BANG! này.');
    if (ACTIVE_PHASES.has(room.phase)) { player.leaveAfterHand = true; this.addLog(room, `${player.name} sẽ rời bàn sau ván.`); this.touch(room); this.broadcast(code); return { queued: true }; }
    room.players = room.players.filter(item => item !== player); this.playerRoom.delete(socket.id); socket.leave(code); socket.emit('room_left'); if (!room.players.length) { this.rooms.delete(code); this.saveSoon(); return; }
    this.ensureHost(room); this.addLog(room, `${player.name} rời phòng.`); this.touch(room); this.broadcast(code); return { ok: true };
  }
  syncState(socket, code) { const ctx = this.access(socket, code); if (ctx && !ctx.error) socket.emit('game_state', this.buildStateFor(ctx.room, ctx.player.id)); return ctx; }
  handleDisconnect(socket) {
    const code = this.playerRoom.get(socket.id), room = this.rooms.get(code), player = this.player(room, socket); this.playerRoom.delete(socket.id); if (!player) return;
    markDisconnected(player, now(), this.graceMs); this.ensureHost(room); this.refreshReconnectState(room);
    this.addLog(room, `${player.name} mất kết nối; có 120 giây để khôi phục ghế${ACTIVE_PHASES.has(room.phase) ? ', sau đó server sẽ tự phản hồi hiệu ứng hoặc kết thúc lượt.' : '.'}`); this.touch(room); this.broadcast(code); this.flush();
  }
  publicCard(card) { return card ? { id: card.id, type: card.type, name: card.name, rank: card.rank, suit: card.suit, border: card.border, weaponRange: card.weaponRange || null } : null; }
  publicPending(room, playerId) {
    const pending = room.pending; if (!pending) return null; const base = { id: pending.id, kind: pending.kind, waitingId: pending.waitingId, actorId: pending.actorId || null, targetId: pending.targetId || null, source: pending.source || null, message: pending.message };
    if (pending.kind === 'GENERAL_STORE') base.cards = pending.cards.map(card => this.publicCard(card));
    if (pending.kind === 'DRAW_CHECK' && pending.waitingId === playerId) base.options = pending.options.map(card => this.publicCard(card));
    if (pending.kind === 'KIT_DRAW' && pending.waitingId === playerId) base.options = pending.options.map(card => this.publicCard(card));
    return base;
  }
  roleFor(room, viewerId, player) { return player.id === viewerId || player.role === 'SHERIFF' || player.dead || room.phase === 'RESULT' ? player.role : null; }
  buildStateFor(room, playerId) {
    const me = this.byId(room, playerId); return { gameId: 'bang', roomCode: room.code, rulesVersion: room.rulesVersion, phase: room.phase, revision: room.revision, matchId: room.matchId, myId: playerId, currentPlayerId: room.currentPlayerId, paused: room.paused,
      deckCount: room.deck.length, discardTop: this.publicCard(room.discard.at(-1)), discardCount: room.discard.length, myHand: me?.hand.map(card => this.publicCard(card)) || [], pending: this.publicPending(room, playerId), result: room.result, log: room.log,
      players: room.players.map(player => { const character = characterById(player.characterId); return { id: player.id, name: cleanName(player.name), avatar: player.avatar, isHost: player.isHost, ready: player.ready, connected: player.connected, leaveAfterHand: player.leaveAfterHand, dead: player.dead, hp: player.hp, maxHp: player.maxHp, handCount: player.hand.length, role: this.roleFor(room, playerId, player), character: character ? { id: character.id, name: character.name, ability: character.ability } : null, equipment: player.equipment.map(card => this.publicCard(card)), distanceFromMe: me && !me.dead && !player.dead && me.id !== player.id ? this.distance(room, me.id, player.id) : null, range: this.weaponRange(player) }; }) };
  }
  broadcast(code) { const room = this.rooms.get(code); if (!room) return; room.updatedAt = now(); for (const player of room.players) { const socket = this.io.sockets.sockets.get(player.socketId); if (socket && player.connected) socket.emit('game_state', this.buildStateFor(room, player.id)); } this.saveSoon(); }
  cleanup() {
    const at = now();
    for (const room of [...this.rooms.values()]) {
      const { wasPaused, waiting } = this.refreshReconnectState(room, at);
      if (wasPaused && !waiting.length && ACTIVE_PHASES.has(room.phase)) { this.addLog(room, 'Hết 120 giây khôi phục; BANG! tiếp tục và server sẽ xử lý lượt hợp lệ khi ghế vắng đến lượt.'); this.touch(room); this.broadcast(room.code); }
      if (['WAITING', 'RESULT'].includes(room.phase)) {
        const expired = room.players.filter(player => isReconnectExpired(player, at, this.graceMs));
        if (expired.length) {
          room.players = room.players.filter(player => !expired.includes(player));
          expired.forEach(player => this.profileStore?.markMemberLeft?.({ gameId: 'bang', roomCode: room.code, playerId: player.id }));
          if (!room.players.length) { this.rooms.delete(room.code); this.profileStore?.closeGameRoom?.('bang', room.code); this.saveSoon(); continue; }
          this.ensureHost(room); this.touch(room); this.broadcast(room.code);
        }
      }
    }
  }
  load() {
    if (!this.storageFile || !fs.existsSync(this.storageFile)) return;
    try { runStorageOperation(this.storageDiagnostics, 'manager:bang', 'read', 'room-file-load', () => {
      const saved = JSON.parse(fs.readFileSync(this.storageFile, 'utf8')); if (saved.version !== 1 || !Array.isArray(saved.rooms)) throw new Error('Định dạng lưu BANG! không hợp lệ');
      let changed = false;
      for (const room of saved.rooms) {
        if (now() - room.updatedAt > 12 * 3600000 && !ACTIVE_PHASES.has(room.phase) && room.phase !== 'RESULT') continue;
        changed = restoreDisconnectedSeats(room.players, now(), this.graceMs) || changed;
        room.players.forEach(player => { player.hand ||= []; player.equipment ||= []; player.bangCount ||= 0; player.leaveAfterHand ||= false; });
        room.deck ||= []; room.discard ||= []; room.actionIds ||= {}; room.log ||= []; room.pending ||= null;
        this.refreshReconnectState(room); this.rooms.set(room.code, room);
      }
      if (changed) this.flush();
    }, { recoveryVerified: true, failureCode: 'ROOM_JSON_READ_FAILED' });
    } catch (error) { console.error('Không đọc được dữ liệu phòng BANG!:', error.message); this.storageReadError = true; this.storageError = true; }
  }
  saveSoon() { if (!this.storageFile || this.storageReadError || this.saveTimer) return; this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 100); this.saveTimer.unref(); }
  flush() { if (!this.storageFile || this.storageReadError) return; try { runStorageOperation(this.storageDiagnostics, 'manager:bang', this.runStateMutation ? 'export' : 'write', 'room-file-save', () => { fs.mkdirSync(path.dirname(this.storageFile), { recursive: true }); fs.writeFileSync(`${this.storageFile}.tmp`, JSON.stringify({ version: 1, rooms: [...this.rooms.values()] }), { mode: 0o600 }); fs.renameSync(`${this.storageFile}.tmp`, this.storageFile); }, { failureCode: 'ROOM_JSON_WRITE_FAILED' }); } catch (error) { console.error('Không lưu được dữ liệu phòng BANG!:', error.message); } }
}

module.exports = { BangManager, ACTIVE_PHASES };
