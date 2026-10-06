'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { deal, shuffleDeck } = require('./deck');
const { getBestHand, checkShowdown, explainComparison } = require('./handEvaluator');
const { CHALLENGES, SPECIALISTS, GAME_MODES } = require('./cardsData');
const { getGame } = require('./platform/gameRegistry');
const { leaveCompletedSeats } = require('./platform/completedRoom');
const { runStorageOperations } = require('./platform/storageDiagnostics');
const { DEFAULT_RECONNECT_GRACE_MS, deadlineFor, markDisconnected, markConnected, restoreDisconnectedSeats, isReconnectExpired, reconnectWaiters, isServerActionSocket, serverActionPlayer } = require('./platform/reconnectGrace');

const ROUNDS = ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'];
const COLORS = ['white', 'yellow', 'orange', 'red'];
const AVATARS = ['🕶️', '🥷', '💻', '🔓', '🎲', '🏎️'];
const EMOTES = ['😂', '😱', '🤔', '😎', '🤫', '😡', '💸', '🤝', '🚨', '💀'];
const QUICK_CHAT = ['Sẵn sàng!', 'Chờ một chút nhé.', 'Mọi người kiểm tra chip nhé.', 'Tiếp tục nào!', 'Cảm ơn cả đội!'];
const STORAGE_VERSION = 2;
const cleanName = value => require('../public/js/game-values').cleanDisplayName(value) || 'Player';
const clock = () => new Date().toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const emptyChips = () => ({ white: null, yellow: null, orange: null, red: null });
const hashSessionToken = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const sessionTokenMatches = (raw, storedHash) => typeof raw === 'string' && typeof storedHash === 'string' && hashSessionToken(raw) === storedHash;

function hashRoomPassword(password) {
  if (!password) return null;
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}

function verifyRoomPassword(password, encoded) {
  if (!encoded || typeof password !== 'string') return !encoded;
  const [salt, expected] = String(encoded).split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 32).toString('hex');
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function migrateRoom(room) {
  const gameId = room.gameId || 'the-gang';
  const game = getGame(gameId) || getGame('the-gang');
  const legacyMode = GAME_MODES[room.mode] ? room.mode : GAME_MODES[room.difficulty] ? room.difficulty : 'ADVANCED';
  room.gameId = game.gameId;
  room.category = game.category;
  room.rulesVersion = Number.isInteger(room.rulesVersion) ? room.rulesVersion : 1;
  room.variant = room.variant || 'standard';
  room.difficulty = legacyMode;
  room.mode = legacyMode;
  room.config = {
    roomName: String(room.config?.roomName || 'The Gang · Phòng LAN').slice(0, 32),
    maxPlayers: Number.isInteger(room.config?.maxPlayers) ? room.config.maxPlayers : game.maxPlayers,
    visibility: room.config?.visibility === 'invite' ? 'invite' : 'public',
    passwordHash: room.config?.passwordHash || null,
  };
  return room;
}

class GameManager {
  constructor(io, options = {}) {
    this.io = io;
    this.rooms = new Map();
    this.playerRoom = new Map();
    this.stateAdapters = new Map();
    this.storageFile = options.storageFile || null;
    this.storageDiagnostics = options.storageDiagnostics || options.profileService?.profiles?.storageDiagnostics || null;
    this.onRoomChanged = options.onRoomChanged || null;
    this.profileService = options.profileService || null;
    this.codeTaken = typeof options.codeTaken === 'function' ? options.codeTaken : () => false;
    this.profileForSocket = typeof options.profileForSocket === 'function' ? options.profileForSocket : () => null;
    this.graceMs = options.graceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.load();
    const { installGameStateTransactions, wrapGameStateMutations } = require('./platform/gameStateTransactions');
    installGameStateTransactions(this, ['the-gang', 'uno-local'], room => room.gameId === 'uno' ? 'uno-local' : 'the-gang');
    wrapGameStateMutations(this, this, ['createRoom', 'joinRoom', 'resumeRoom', 'handleDisconnect', 'cleanup',
      'leaveRoom', 'removePlayer', 'transferHost', 'setPaused', 'setReady', 'setChatMode', 'changeMode', 'setAvatar',
      'startGame', 'startHeist', 'claimChip', 'returnChip', 'snatchChip', 'confirmRound', 'advancePhase',
      'specialistAction', 'activateSpecialist', 'doShowdown', 'submitGuess', 'revealNext', 'finishHeist',
      'nextHeist', 'playAgain', 'returnToLobby', 'resetToLobby', 'sendChat', 'sendEmote', 'broadcast']);
    this.cleanupTimer = setInterval(() => this.cleanup(), 1000);
    this.cleanupTimer.unref();
  }

  registerStateAdapter(gameId, adapter) {
    if (gameId && adapter) this.stateAdapters.set(gameId, adapter);
  }

  load() {
    if (!this.storageFile || !fs.existsSync(this.storageFile)) return;
    const sourceIds = ['manager:the-gang', 'manager:uno-classic'];
    sourceIds.filter(id => this.storageDiagnostics?.hasSource?.(id)).forEach(id => this.storageDiagnostics.begin(id, 'read', 'room-file-load'));
    try {
      const saved = JSON.parse(fs.readFileSync(this.storageFile, 'utf8'));
      if (![1, STORAGE_VERSION].includes(saved.version) || !Array.isArray(saved.rooms)) throw new Error('Định dạng lưu phòng không hợp lệ');
      let changed = false;
      const recovered = [];
      for (const room of saved.rooms) {
        migrateRoom(room);
        const active = !['WAITING', 'RESULT', 'GAME_OVER', 'CANCELLED'].includes(room.phase);
        if (Date.now() - room.updatedAt > 12 * 3600000 && !active) continue;
        const hadOfflineSeat = room.players.some(p => p.connected === false || Number.isFinite(p.disconnectedAt));
        if (typeof room.hostPaused !== 'boolean') { room.hostPaused = !!room.paused && !hadOfflineSeat; changed = true; }
        room.players.forEach(p => {
          if (!p.tokenHash && p.token) p.tokenHash = hashSessionToken(p.token);
          p.profileId ||= p.id;
          p.roundConfirmed = false;
        });
        changed = restoreDisconnectedSeats(room.players, Date.now(), this.graceMs) || changed;
        this.refreshReconnectState(room);
        recovered.push(room);
      }
      for (const room of recovered) this.rooms.set(room.code, room);
      sourceIds.filter(id => this.storageDiagnostics?.hasSource?.(id)).forEach(id => this.storageDiagnostics.succeed(id, 'read', { stage: 'room-file-load', recoveryVerified: true }));
      if (changed) this.flush();
    } catch (error) {
      console.error('Không đọc được dữ liệu phòng:', error.message);
      // Preserve the source rather than silently overwriting an unreadable save.
      sourceIds.filter(id => this.storageDiagnostics?.hasSource?.(id)).forEach(id => this.storageDiagnostics.fail(id, 'read', { stage: 'room-file-load', code: 'ROOM_JSON_READ_FAILED' }));
      this.storageReadError = true;
      this.storageError = true;
      this.rooms.clear();
    }
  }

  saveSoon() {
    if (!this.storageFile || this.saveTimer || this.storageReadError) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush(); }, 100);
    this.saveTimer.unref();
  }

  flush() {
    if (!this.storageFile || this.storageReadError) return;
    const sourceIds = ['manager:the-gang', 'manager:uno-classic'];
    try {
      runStorageOperations(this.storageDiagnostics, sourceIds, this.runStateMutation ? 'export' : 'write', 'room-file-save', () => {
        fs.mkdirSync(path.dirname(this.storageFile), { recursive: true });
        const safeRooms = JSON.parse(JSON.stringify([...this.rooms.values()], (key, value) => {
          if (key === 'socketId' || (key === 'token' && this.profileService)) return undefined;
          return value;
        }));
        fs.writeFileSync(this.storageFile + '.tmp', JSON.stringify({ version: STORAGE_VERSION, rooms: safeRooms }), { mode: 0o600 });
        fs.renameSync(this.storageFile + '.tmp', this.storageFile);
      }, { failureCode: 'ROOM_JSON_WRITE_FAILED' });
      this.storageWriteError = false;
    } catch (error) { this.storageWriteError = true; console.error('Không lưu được dữ liệu phòng:', error.message); }
  }

  close() { clearInterval(this.cleanupTimer); clearTimeout(this.saveTimer); this.flush(); }

  cleanup() {
    const at = Date.now();
    for (const room of [...this.rooms.values()]) {
      const active = !['WAITING', 'GAME_OVER', 'CANCELLED'].includes(room.phase);
      const { wasPaused, waiting } = this.refreshReconnectState(room, at);
      const expired = room.players.filter(player => isReconnectExpired(player, at, this.graceMs));
      if (room.gameId === 'the-gang' && active && expired.length) {
        this.resetToLobby(room, 'Hết 120 giây khôi phục; The Gang trở về sảnh theo chính sách bàn giải trí.');
        leaveCompletedSeats(this, room, 'the-gang');
        room.players = room.players.filter(player => !expired.includes(player));
        expired.forEach(player => this.profileService?.profiles?.markMemberLeft({ gameId: room.gameId, roomCode: room.code, playerId: player.id }));
        this.ensureHost(room);
        if (!room.players.length) { this.rooms.delete(room.code); this.profileService?.profiles?.closeGameRoom(room.gameId, room.code); }
        else this.broadcast(room.code);
        continue;
      }
      if (wasPaused && !waiting.length && room.gameId === 'uno') this.broadcast(room.code);
      if (['WAITING', 'RESULT', 'GAME_OVER'].includes(room.phase) && expired.length) {
        room.players = room.players.filter(player => !expired.includes(player));
        this.ensureHost(room);
        if (room.players.length) this.broadcast(room.code); else this.rooms.delete(room.code);
      }
      if (!room.players.some(p => p.connected) && at - room.updatedAt > 12 * 3600000 && !active) this.rooms.delete(room.code);
    }
    this.saveSoon();
  }

  error(socket, message) { socket.emit('game_error', { message }); return null; }
  player(room, socket) { return serverActionPlayer(this, room, socket) || room?.players.find(p => p.socketId === socket.id && p.connected); }
  refreshReconnectState(room, at = Date.now()) {
    const wasPaused = !!room.paused, active = !['WAITING', 'RESULT', 'GAME_OVER', 'CANCELLED'].includes(room.phase);
    const waiting = active ? reconnectWaiters(room, at, this.graceMs) : [];
    room.reconnectPaused = waiting.length > 0;
    room.hostPaused = !!room.hostPaused;
    room.paused = room.hostPaused || room.reconnectPaused;
    return { wasPaused, waiting };
  }
  access(socket, code, options = {}) {
    const room = this.rooms.get(code);
    const player = this.player(room, socket);
    if (!room || !player) return this.error(socket, 'Bạn không còn ở trong phòng này.');
    if (options.host && !player.isHost) return this.error(socket, 'Chỉ chủ phòng được thực hiện thao tác này.');
    if (options.phase && !options.phase.includes(room.phase)) return this.error(socket, 'Thao tác không phù hợp với vòng hiện tại.');
    const { waiting } = this.refreshReconnectState(room);
    if (options.playing && (room.hostPaused || (!isServerActionSocket(this, socket) && waiting.length))) return this.error(socket, 'Ván đang tạm dừng hoặc có thành viên còn trong thời gian khôi phục.');
    if (options.phaseKey && options.phaseKey !== this.phaseKey(room)) return this.error(socket, 'Vòng đã thay đổi. Vui lòng thao tác lại.');
    return { room, player };
  }

  phaseKey(room) { return `${room.matchId}:${room.heistNumber}:${room.phase}`; }
  challenges(room) { return [...room.activeChallenges, room.permanentChallenge].filter(Boolean); }
  has(room, id) { return this.challenges(room).some(c => c.id === id); }
  busy(room) { return ['PASS', 'VIEW', 'SELECT_CARD', 'DISCARD'].includes(room.specialistState?.stage) || !!room.specialistState?.proposal; }
  confirmReset(room) { room.players.forEach(p => { p.roundConfirmed = false; }); }

  newPlayer(socket, name, avatar, isHost = false, profile = null) {
    const socketProfile = this.profileForSocket(socket);
    if (!profile && socketProfile) profile = { playerId: socketProfile.id };
    const id = profile?.playerId || crypto.randomUUID();
    const token = crypto.randomBytes(32).toString('hex');
    return { id, profileId: id, token, tokenHash: hashSessionToken(token), socketId: socket.id,
      name: cleanName(name), avatar: AVATARS.includes(avatar) ? avatar : AVATARS[0], isHost, connected: true,
      ready: false, roundConfirmed: false, chips: emptyChips(), privateCards: [], best5: [],
      handScore: 0, handName: '', handNameVi: '', rankLevel: 0, hasMuscleBonus: false, extraNote: '', privateInsights: [],
      reconnectDeadlineAt: null, leaveAfterHand: false };
  }

  credentials(room, player) {
    return { roomCode: room.code, playerId: player.id, sessionToken: player.token, gameId: room.gameId || 'the-gang', category: room.category || 'casual' };
  }

  publicRoom(room) {
    const config = room.config || {};
    return {
      roomCode: room.code, roomName: config.roomName || 'The Gang · Phòng LAN', gameId: room.gameId || 'the-gang',
      category: room.category || 'casual', rulesVersion: room.rulesVersion || 1, variant: room.variant || 'standard',
      difficulty: room.difficulty || room.mode || 'ADVANCED', visibility: config.visibility || 'public',
      requiresPassword: !!config.passwordHash, phase: room.phase, players: room.players.length,
      maxPlayers: config.maxPlayers || 6, updatedAt: room.updatedAt,
    };
  }
  bind(socket, room, player) {
    const wasPaused = !!room.paused;
    player.name = cleanName(player.name); this.playerRoom.set(socket.id, room.code); socket.join(room.code); player.socketId = socket.id; markConnected(player);
    const { waiting } = this.refreshReconnectState(room);
    if (wasPaused && !waiting.length) this.addLog(room, 'Mọi người đã kết nối lại; ván tiếp tục.', 'system');
  }

  createRoom(socket, name, modeId = 'ADVANCED', avatar, roomOptions = {}) {
    if (this.playerRoom.has(socket.id)) return { error: 'Hãy rời phòng hiện tại trước khi tạo phòng mới.' };
    if (roomOptions.gameId && roomOptions.gameId !== 'the-gang') return this.createGenericRoom(socket, name, avatar, roomOptions);
    let code;
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do { code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (this.rooms.has(code) || this.codeTaken(code));
    const mode = GAME_MODES[modeId] || GAME_MODES.ADVANCED;
    const maxPlayers = Number.isInteger(roomOptions.maxPlayers) ? roomOptions.maxPlayers : 6;
    if (maxPlayers < 2 || maxPlayers > 6) return { error: 'Số người của The Gang phải từ 2 đến 6.' };
    const config = {
      roomName: String(roomOptions.roomName || 'The Gang · Phòng LAN').trim().slice(0, 32) || 'The Gang · Phòng LAN',
      maxPlayers, visibility: roomOptions.visibility === 'invite' ? 'invite' : 'public',
      passwordHash: hashRoomPassword(typeof roomOptions.password === 'string' ? roomOptions.password.trim().slice(0, 64) : ''),
    };
    const player = this.newPlayer(socket, name, avatar, true, roomOptions.profile?.player);
    const room = { code, phase: 'WAITING', matchId: crypto.randomUUID(), gameId: 'the-gang', category: 'casual', rulesVersion: 1,
      variant: 'standard', difficulty: mode.id, mode: mode.id, config,
      maxVaults: mode.maxVaults, maxAlarms: mode.maxAlarms, score: { vaults: 0, alarms: 0 },
      heistNumber: 0, roundNumber: 0, gameOver: false, gameWon: false, paused: false, hostPaused: false, reconnectPaused: false, strictChat: true,
      players: [player], communityCards: [], allCommunityCards: [], remainingDeck: [], discardPile: [],
      currentRoundChipColor: 'white', chipPool: [], challengeDeck: [...CHALLENGES], specialistDeck: [...SPECIALISTS],
      permanentChallenge: null, activeChallenges: [], activeSpecialist: null, specialistState: null,
      showdown: null, lastResult: null, log: [], chatLog: [], history: [], matches: [], deckProgress: {}, deckMode: null, updatedAt: Date.now() };
    this.rooms.set(code, room); this.bind(socket, room, player);
    this.addLog(room, `🏠 ${player.name} tạo phòng ${code}`, 'system');
    this.saveSoon();
    return this.credentials(room, player);
  }

  createGenericRoom(socket, name, avatar, roomOptions = {}) {
    const game = getGame(roomOptions.gameId);
    if (!game) return { error: 'Game không tồn tại.' };
    const maxPlayers = Number.isInteger(roomOptions.maxPlayers) ? roomOptions.maxPlayers : game.maxPlayers;
    if (maxPlayers < game.minPlayers || maxPlayers > game.maxPlayers) return { error: `Số người phải từ ${game.minPlayers} đến ${game.maxPlayers}.` };
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (this.rooms.has(code) || this.codeTaken(code));
    const config = {
      roomName: String(roomOptions.roomName || `${game.name} · Phòng LAN`).trim().slice(0, 32) || `${game.name} · Phòng LAN`,
      maxPlayers, visibility: roomOptions.visibility === 'invite' ? 'invite' : 'public',
      passwordHash: hashRoomPassword(typeof roomOptions.password === 'string' ? roomOptions.password.trim().slice(0, 64) : ''),
    };
    const player = this.newPlayer(socket, name, avatar, true, roomOptions.profile?.player);
    const room = {
      code, phase: 'WAITING', matchId: crypto.randomUUID(), gameId: game.gameId, category: game.category,
      rulesVersion: game.rulesVersion, variant: roomOptions.variant || 'standard', difficulty: 'ADVANCED', mode: 'ADVANCED', config,
      paused: false, hostPaused: false, reconnectPaused: false, strictChat: false, players: [player], log: [], chatLog: [], history: [], matches: [], updatedAt: Date.now(),
      uno: null,
    };
    this.rooms.set(code, room); this.bind(socket, room, player);
    this.addLog(room, `🏠 ${player.name} tạo phòng ${code}`, 'system');
    this.saveSoon();
    return this.credentials(room, player);
  }

  joinRoom(socket, code, name, avatar, options = {}) {
    if (this.playerRoom.has(socket.id)) return { error: 'Bạn đang ở trong một phòng khác.' };
    const room = this.rooms.get(code);
    if (!room) return { error: 'Không tìm thấy phòng.' };
    if (room.phase !== 'WAITING') return { error: 'Ván đang diễn ra. Người cũ hãy dùng nút khôi phục; người mới cần chờ phòng chờ.' };
    if (!verifyRoomPassword(options.password || '', room.config?.passwordHash)) return { error: 'Mật khẩu phòng không đúng.' };
    const maxPlayers = room.config?.maxPlayers || 6;
    if (room.players.length >= maxPlayers) return { error: `Phòng đã đủ ${maxPlayers} người.` };
    if (options.profile?.player?.playerId && room.players.some(p => (p.profileId || p.id) === options.profile.player.playerId)) return { error: 'Hồ sơ này đã có ghế trong phòng.' };
    if (room.players.some(p => p.name.toLowerCase() === cleanName(name).toLowerCase())) return { error: 'Mật danh này đã được sử dụng.' };
    const player = this.newPlayer(socket, name, avatar, false, options.profile?.player);
    room.players.push(player); this.bind(socket, room, player);
    this.addLog(room, `👤 ${player.name} tham gia`, 'join'); this.ensureHost(room);
    return this.credentials(room, player);
  }

  resumeRoom(socket, code, token) {
    const room = this.rooms.get(code);
    const player = room?.players.find(p => typeof token === 'string' && (p.token === token || sessionTokenMatches(token, p.tokenHash || hashSessionToken(p.token || ''))));
    if (!player) return { error: 'Phiên chơi đã hết hạn hoặc phòng không còn tồn tại.' };
    const currentCode = this.playerRoom.get(socket.id);
    if (currentCode && currentCode !== code) return { error: 'Bạn đang ở phòng khác.' };
    if (player.connected && player.socketId !== socket.id) return { error: 'Ghế này đang mở trên một cửa sổ khác. Đóng cửa sổ đó trước khi khôi phục.' };
    player.token = token;
    player.tokenHash = hashSessionToken(token);
    this.bind(socket, room, player); this.ensureHost(room);
    this.addLog(room, `🔄 ${player.name} đã nối lại`, 'system');
    return this.credentials(room, player);
  }

  ensureHost(room) {
    const host = room.players.find(p => p.isHost && p.connected);
    if (host) return;
    const next = room.players.find(p => p.connected) || room.players[0];
    room.players.forEach(p => { p.isHost = p === next; });
    if (next?.connected) this.addLog(room, `👑 ${next.name} tiếp quản chủ phòng`, 'system');
  }

  handleDisconnect(socket) {
    const code = this.playerRoom.get(socket.id), room = this.rooms.get(code), player = this.player(room, socket);
    this.playerRoom.delete(socket.id);
    if (!player) return;
    markDisconnected(player, Date.now(), this.graceMs); player.roundConfirmed = false;
    this.refreshReconnectState(room);
    this.addLog(room, `📶 ${player.name} mất kết nối; có 120 giây để khôi phục ghế.`, 'system');
    this.stateAdapters.get(room.gameId)?.onDisconnect?.(room, player.id);
    this.ensureHost(room); this.broadcast(code); this.flush();
  }

  leaveRoom(socket, code) {
    const room = this.rooms.get(code), player = this.player(room, socket);
    if (!room || !player || isServerActionSocket(this, socket)) return this.error(socket, 'Bạn không còn ở trong phòng này.');
    if (room.gameId === 'the-gang' && !['WAITING', 'RESULT', 'GAME_OVER', 'CANCELLED'].includes(room.phase)) {
      player.leaveAfterHand = true;
      this.addLog(room, `${player.name} sẽ rời bàn sau vụ cướp này.`, 'system'); this.broadcast(code);
      return { queued: true };
    }
    const ctx = this.access(socket, code, { phase: ['WAITING', 'RESULT', 'GAME_OVER'] }); if (!ctx) return;
    room.players = room.players.filter(p => p !== player); this.playerRoom.delete(socket.id); socket.leave(code);
    this.ensureHost(room); socket.emit('room_left');
    this.addLog(room, `👋 ${player.name} rời phòng`, 'system');
    if (!room.players.length) { this.rooms.delete(code); this.saveSoon(); } else this.broadcast(code);
  }

  removePlayer(socket, code, targetId) {
    const ctx = this.access(socket, code, { host: true, phase: ['WAITING', 'RESULT', 'GAME_OVER'] }); if (!ctx) return;
    const target = ctx.room.players.find(p => p.id === targetId);
    if (!target || target === ctx.player) return;
    const targetSocket = this.io.sockets.sockets.get(target.socketId);
    if (targetSocket) { targetSocket.leave(code); targetSocket.emit('room_left'); this.playerRoom.delete(targetSocket.id); }
    ctx.room.players = ctx.room.players.filter(p => p !== target);
    this.addLog(ctx.room, `👋 ${target.name} được đưa ra khỏi phòng`, 'system'); this.broadcast(code);
  }

  transferHost(socket, code, targetId) {
    const ctx = this.access(socket, code, { host: true }); if (!ctx) return;
    const target = ctx.room.players.find(p => p.id === targetId && p.connected);
    if (!target) return this.error(socket, 'Người nhận quyền phải đang kết nối.');
    ctx.room.players.forEach(p => { p.isHost = p === target; });
    this.addLog(ctx.room, `👑 Chuyển chủ phòng cho ${target.name}`, 'system'); this.broadcast(code);
  }

  setPaused(socket, code, paused) {
    const ctx = this.access(socket, code, { host: true }); if (!ctx) return;
    ctx.room.hostPaused = !!paused; this.refreshReconnectState(ctx.room);
    this.addLog(ctx.room, paused ? '⏸ Ván đã tạm dừng' : '▶ Tiếp tục ván', 'system'); this.broadcast(code);
  }

  setReady(socket, code, ready) {
    const ctx = this.access(socket, code, { phase: ['WAITING'] }); if (!ctx) return;
    ctx.player.ready = !!ready; this.broadcast(code);
  }

  setChatMode(socket, code, strict) {
    const ctx = this.access(socket, code, { host: true, phase: ['WAITING'] }); if (!ctx) return;
    ctx.room.strictChat = !!strict; ctx.room.players.forEach(p => { p.ready = false; }); this.broadcast(code);
  }

  changeMode(socket, code, modeId) {
    const ctx = this.access(socket, code, { host: true, phase: ['WAITING'] }); if (!ctx) return;
    const mode = GAME_MODES[modeId]; if (!mode) return this.error(socket, 'Chế độ không hợp lệ.');
    Object.assign(ctx.room, { mode: mode.id, difficulty: mode.id, maxVaults: mode.maxVaults, maxAlarms: mode.maxAlarms });
    ctx.room.players.forEach(p => { p.ready = false; }); this.broadcast(code);
  }

  setAvatar(socket, code, avatar) {
    const ctx = this.access(socket, code); if (!ctx) return;
    if (AVATARS.includes(avatar)) { ctx.player.avatar = avatar; this.broadcast(code); }
  }

  rememberDecks(room) {
    if (!room.deckMode) return;
    room.deckProgress ||= {};
    const challenges = [...room.challengeDeck];
    for (const c of [...room.activeChallenges, room.permanentChallenge].filter(Boolean)) if (!challenges.some(x => x.id === c.id)) challenges.push(c);
    const specialists = [...room.specialistDeck];
    if (room.activeSpecialist && !specialists.some(x => x.id === room.activeSpecialist.id)) specialists.push(room.activeSpecialist);
    room.deckProgress[room.deckMode] = { challenges, specialists };
  }

  startGame(socket, code, replay = false) {
    const ctx = this.access(socket, code, { host: true, phase: replay ? ['GAME_OVER'] : ['WAITING'], playing: true }); if (!ctx) return;
    const { room } = ctx;
    const maxPlayers = room.config?.maxPlayers || 6;
    if (room.players.length < 2 || room.players.length > maxPlayers) return this.error(socket, `Cần từ 2 đến ${maxPlayers} người.`);
    if (!replay && room.players.some(p => !p.ready)) return this.error(socket, 'Tất cả thành viên cần bấm Sẵn sàng.');
    const mode = GAME_MODES[room.mode];
      this.rememberDecks(room);
    const progress = room.deckProgress?.[room.mode];
    Object.assign(room, { matchId: crypto.randomUUID(), reconnectPolicyVersion: 2, hostPaused: false, reconnectPaused: false, paused: false, gameOver: false, gameWon: false, score: { vaults: 0, alarms: 0 },
      heistNumber: 0, permanentChallenge: null, activeChallenges: [], activeSpecialist: null,
      deckMode: room.mode, challengeDeck: [...(progress?.challenges || CHALLENGES)].filter(c => !((mode.permanentChallenge || mode.doubleChallenges) && c.id === 1)), specialistDeck: [...(progress?.specialists || SPECIALISTS)] });
    if (mode.permanentChallenge) {
      const index = crypto.randomInt(room.challengeDeck.length);
      room.permanentChallenge = room.challengeDeck.splice(index, 1)[0];
    }
    if (mode.doubleChallenges) {
      room.challengeDeck = shuffleDeck(room.challengeDeck);
      room.activeChallenges = [room.challengeDeck.shift(), room.challengeDeck.shift()];
    }
    this.startHeist(room);
  }

  startHeist(room) {
    const cardsPerPlayer = this.has(room, 10) ? 3 : 2;
    const dealt = deal(room.players.length, cardsPerPlayer);
    Object.assign(room, { heistNumber: room.heistNumber + 1, lastResult: null, showdown: null, discardPile: [],
      allCommunityCards: dealt.communityCards, remainingDeck: dealt.remainingDeck, communityCards: [],
      phase: 'PRE_FLOP', roundNumber: 1, currentRoundChipColor: 'white', heistStartedAt: Date.now() });
    room.players.forEach((p, i) => Object.assign(p, { privateCards: dealt.playerHands[i], chips: emptyChips(),
      roundConfirmed: false, handScore: 0, rankLevel: 0, handName: '', handNameVi: '', best5: [],
      hasMuscleBonus: false, extraNote: '', privateInsights: [] }));
    const id = room.activeSpecialist?.id;
    room.specialistState = id ? { stage: id === 6 ? 'PASS' : id === 9 ? 'VIEW' : [3, 8].includes(id) ? 'DONE' : 'AVAILABLE',
      proposal: null, choices: {}, seen: [], usedBy: null } : null;
    if (id === 3) room.players.forEach(p => { p.extraNote = `${p.privateCards.filter(c => [11, 12, 13].includes(c.value)).length} lá hình (J/Q/K)`; });
    if (id === 8) room.players.forEach(p => { p.extraNote = `Tổng điểm bài tẩy: ${p.privateCards.reduce((sum, c) => sum + (c.value === 14 ? 11 : Math.min(c.value, 10)), 0)}`; });
    if (this.has(room, 1)) { room.phase = 'FLOP'; room.roundNumber = 2; room.currentRoundChipColor = 'yellow'; room.communityCards = room.allCommunityCards.slice(0, 3); this.flopEffects(room); }
    room.chipPool = Array.from({ length: room.players.length }, (_, i) => i + 1);
    this.addLog(room, `🏦 VỤ CƯỚP ${room.heistNumber} BẮT ĐẦU`, 'heist');
    this.io.to(room.code).emit('spotlight_cards', { cards: [...this.challenges(room), room.activeSpecialist].filter(Boolean) });
    this.broadcast(room.code);
  }

  isChipLocked(room, chip) {
    return room.phase !== 'RIVER' && ((chip === 1 && this.has(room, 2)) || (chip === room.players.length && this.has(room, 6)));
  }

  chipAccess(socket, code, phaseKey) {
    const ctx = this.access(socket, code, { phase: ROUNDS, playing: true, phaseKey });
    if (ctx && this.busy(ctx.room)) return this.error(socket, 'Hoàn tất thao tác chuyên gia trước khi đổi chip.');
    return ctx;
  }

  claimChip(socket, code, number, phaseKey) {
    const ctx = this.chipAccess(socket, code, phaseKey); if (!ctx) return;
    const { room, player } = ctx, color = room.currentRoundChipColor;
    if (!Number.isInteger(number) || !room.chipPool.includes(number)) return this.error(socket, 'Chip này đã được người khác lấy.');
    const current = player.chips[color];
    if (current !== null && this.isChipLocked(room, current)) return this.error(socket, 'Chip đang giữ đã bị khóa.');
    room.chipPool = room.chipPool.filter(n => n !== number);
    if (current !== null) room.chipPool.push(current);
    room.chipPool.sort((a, b) => a - b); player.chips[color] = number;
    this.confirmReset(room); this.addLog(room, `${player.name} lấy chip ${number}⭐`, 'chip'); this.broadcast(code);
  }

  returnChip(socket, code, phaseKey) {
    const ctx = this.chipAccess(socket, code, phaseKey); if (!ctx) return;
    const { room, player } = ctx, color = room.currentRoundChipColor, chip = player.chips[color];
    if (chip === null) return;
    if (this.isChipLocked(room, chip)) return this.error(socket, 'Chip đang giữ đã bị khóa.');
    room.chipPool.push(chip); room.chipPool.sort((a, b) => a - b); player.chips[color] = null;
    this.confirmReset(room); this.addLog(room, `${player.name} trả chip ${chip}⭐`, 'chip'); this.broadcast(code);
  }

  snatchChip(socket, code, targetId, phaseKey) {
    const ctx = this.chipAccess(socket, code, phaseKey); if (!ctx) return;
    const { room, player } = ctx, target = room.players.find(p => p.id === targetId && p.connected);
    if (!target || target === player) return this.error(socket, 'Đồng đội không hợp lệ.');
    const color = room.currentRoundChipColor, taken = target.chips[color], old = player.chips[color];
    if (taken === null) return this.error(socket, 'Đồng đội chưa có chip.');
    if (this.isChipLocked(room, taken) || (old !== null && this.isChipLocked(room, old))) return this.error(socket, 'Không thể lấy hoặc trả chip đã khóa.');
    // A chip may be taken, but never placed in front of another player.
    if (old !== null) { room.chipPool.push(old); room.chipPool.sort((a, b) => a - b); }
    player.chips[color] = taken; target.chips[color] = null; this.confirmReset(room);
    this.addLog(room, `${player.name} lấy chip ${taken}⭐ từ ${target.name}`, 'snatch');
    this.io.to(code).emit('chip_snatched', { snatcherId: player.id, snatcherName: player.name, victimId: target.id, victimName: target.name, color, chip: taken });
    this.broadcast(code);
  }

  confirmRound(socket, code, confirmed, phaseKey) {
    const ctx = this.access(socket, code, { phase: ROUNDS, playing: true, phaseKey }); if (!ctx) return;
    if (this.busy(ctx.room)) return this.error(socket, 'Hoàn tất chuyên gia trước khi chốt chip.');
    if (ctx.player.chips[ctx.room.currentRoundChipColor] === null) return this.error(socket, 'Chọn chip trước khi chốt.');
    ctx.player.roundConfirmed = !!confirmed; this.broadcast(code);
  }

  flopEffects(room) {
    const face = room.communityCards.some(c => [11, 12, 13].includes(c.value));
    const victim = this.has(room, 3) && face ? room.players.find(p => p.chips.white === 1)
      : this.has(room, 7) && !face ? room.players.find(p => p.chips.white === room.players.length) : null;
    if (victim) {
      const count = victim.privateCards.length;
      room.discardPile.push(...victim.privateCards);
      victim.privateCards = Array.from({ length: count }, () => room.remainingDeck.pop());
      this.addLog(room, `🚨 ${victim.name} phải rút ${count} lá tẩy mới`, 'card');
    }
  }

  advancePhase(socket, code, phaseKey) {
    const ctx = this.access(socket, code, { host: true, phase: ROUNDS, playing: true, phaseKey }); if (!ctx) return;
    const { room } = ctx;
    if (this.busy(room)) return this.error(socket, 'Hoàn tất thao tác chuyên gia trước khi chuyển vòng.');
    if (room.players.some(p => p.chips[room.currentRoundChipColor] === null || !p.roundConfirmed)) return this.error(socket, 'Tất cả thành viên cần chọn và chốt chip.');
    if (room.phase === 'RIVER') return this.doShowdown(room);
    const next = room.phase === 'PRE_FLOP' ? 'FLOP' : room.phase === 'FLOP' ? (this.has(room, 5) ? 'RIVER' : 'TURN') : 'RIVER';
    room.phase = next; room.roundNumber = ROUNDS.indexOf(next) + 1;
    room.communityCards = room.allCommunityCards.slice(0, next === 'FLOP' ? 3 : next === 'TURN' ? 4 : 5);
    if (next === 'FLOP') this.flopEffects(room);
    room.currentRoundChipColor = COLORS[room.roundNumber - 1]; room.chipPool = Array.from({ length: room.players.length }, (_, i) => i + 1);
    this.confirmReset(room); this.addLog(room, `🃏 Chuyển sang vòng ${room.roundNumber}`, 'phase'); this.broadcast(code);
  }

  specialistAction(socket, code, payload, phaseKey) {
    const ctx = this.access(socket, code, { phase: ROUNDS, playing: true, phaseKey }); if (!ctx) return;
    const { room, player } = ctx, id = room.activeSpecialist?.id, state = room.specialistState;
    if (!state || state.stage === 'DONE') return this.error(socket, 'Không có chuyên gia chờ sử dụng.');
    const index = payload.cardIndex;
    if (state.stage === 'PASS') {
      if (payload.action !== 'select' || !Number.isInteger(index) || !player.privateCards[index]) return this.error(socket, 'Chọn một lá bài của bạn để chuyển.');
      state.choices[player.id] = index;
      if (room.players.every(p => Number.isInteger(state.choices[p.id]))) {
        const selected = room.players.map(p => p.privateCards[state.choices[p.id]]);
        room.players.forEach((p, i) => { p.privateCards[state.choices[p.id]] = selected[(i - 1 + room.players.length) % room.players.length]; });
        state.stage = 'DONE'; this.addLog(room, '🔄 Đã chuyển đồng thời một lá cho người bên trái (theo thứ tự ghế)', 'card');
      }
    } else if (state.stage === 'VIEW') {
      if (payload.action !== 'seen') return this.error(socket, 'Xác nhận đã xem bài trước khi xáo lại.');
      if (!state.seen.includes(player.id)) state.seen.push(player.id);
      if (state.seen.length === room.players.length) {
        const shuffled = shuffleDeck(room.players.flatMap(p => p.privateCards)); let offset = 0;
        room.players.forEach(p => { const count = p.privateCards.length; p.privateCards = shuffled.slice(offset, offset + count); offset += count; });
        state.stage = 'DONE'; this.addLog(room, '🎭 Đã xáo và chia lại đúng những lá tẩy ban đầu', 'card');
      }
    } else if (payload.action === 'propose' && state.stage === 'AVAILABLE' && !state.proposal) {
      const actor = room.players.find(p => p.id === payload.actorId && p.connected);
      const recipient = room.players.find(p => p.id === payload.recipientId && p.connected);
      if (!actor || (id === 1 && (!recipient || recipient === actor)) || (id === 4 && (!Number.isInteger(payload.value) || payload.value < 2 || payload.value > 14))) return this.error(socket, 'Chọn người và thông tin hợp lệ.');
      state.proposal = { actorId: actor.id, recipientId: id === 1 ? recipient.id : null, value: id === 4 ? payload.value : null, approvals: [player.id] };
    } else if (payload.action === 'reject' && state.proposal) {
      state.proposal = null; this.addLog(room, `${player.name} đề nghị chọn lại cách dùng chuyên gia`, 'card');
    } else if (payload.action === 'approve' && state.proposal) {
      if (!state.proposal.approvals.includes(player.id)) state.proposal.approvals.push(player.id);
      if (room.players.every(p => state.proposal.approvals.includes(p.id))) this.activateSpecialist(room);
    } else if (['SELECT_CARD', 'DISCARD'].includes(state.stage) && state.usedBy === player.id) {
      if (payload.action !== 'select' || !Number.isInteger(index) || !player.privateCards[index]) return this.error(socket, 'Chọn một lá bài hợp lệ.');
      if (state.stage === 'SELECT_CARD') {
        const recipient = room.players.find(p => p.id === state.recipientId);
        recipient.privateInsights.push({ fromId: player.id, fromName: player.name, card: { ...player.privateCards[index] } });
        this.addLog(room, `🕵️ ${player.name} đã cho ${recipient.name} xem bí mật một lá`, 'card');
      } else {
        room.discardPile.push(player.privateCards.splice(index, 1)[0]); this.addLog(room, `${player.name} đã bỏ một lá sau khi dùng chuyên gia`, 'card');
      }
      state.stage = 'DONE';
    } else return this.error(socket, 'Thao tác chuyên gia đã thay đổi hoặc không thuộc lượt của bạn.');
    this.confirmReset(room); this.broadcast(code);
  }

  activateSpecialist(room) {
    const state = room.specialistState, proposal = state.proposal, id = room.activeSpecialist.id;
    const actor = room.players.find(p => p.id === proposal.actorId);
    state.usedBy = actor.id; state.recipientId = proposal.recipientId; state.proposal = null;
    if (id === 1) state.stage = 'SELECT_CARD';
    else if (id === 5 || id === 7) {
      actor.privateCards.push(id === 5 ? room.remainingDeck.pop() : { suit: 'none', value: 11, special: true });
      state.stage = 'DISCARD';
    } else {
      state.stage = 'DONE';
      if (id === 2) { actor.extraNote = `Tài xế: ${getBestHand(actor.privateCards, room.communityCards).nameVi}`; this.addLog(room, `${actor.name}: ${actor.extraNote}`, 'card'); }
      if (id === 4) { actor.extraNote = `Có ${actor.privateCards.filter(c => c.value === proposal.value).length} lá ${proposal.value === 14 ? 'A' : proposal.value === 13 ? 'K' : proposal.value === 12 ? 'Q' : proposal.value === 11 ? 'J' : proposal.value}`; this.addLog(room, `${actor.name}: ${actor.extraNote}`, 'card'); }
      if (id === 10) { actor.hasMuscleBonus = true; actor.extraNote = '💪 Giữ thẻ Cơ bắp'; }
    }
    this.addLog(room, `🤝 Cả đội đồng ý để ${actor.name} dùng ${room.activeSpecialist.title}`, 'card');
  }

  doShowdown(room) {
    room.phase = 'SHOWDOWN';
    room.players.forEach(p => {
      const result = getBestHand(p.privateCards, room.communityCards, { hasMuscleBonus: p.hasMuscleBonus });
      Object.assign(p, { handScore: result.score, handName: result.name, handNameVi: result.nameVi, rankLevel: result.rankLevel, best5: result.best5 });
    });
    room.showdown = { order: [...room.players].sort((a, b) => a.chips.red - b.chips.red).map(p => p.id), revealedCount: 0, guesses: {}, votes: {} };
    this.addLog(room, '⚖️ Bắt đầu lật bài theo thứ tự chip đỏ', 'phase'); this.broadcast(room.code);
  }

  submitGuess(socket, code, guesses, phaseKey) {
    const ctx = this.access(socket, code, { phase: ['SHOWDOWN'], playing: true, phaseKey }); if (!ctx) return;
    const { room, player } = ctx, sd = room.showdown, highest = sd.order.at(-1);
    if (player.id === highest || sd.revealedCount !== sd.order.length - 1) return this.error(socket, 'Chỉ đồng đội được đoán trước khi người cuối lật bài.');
    const vote = {};
    if (this.has(room, 4)) { if (!Number.isInteger(guesses.value) || guesses.value < 2 || guesses.value > 14) return this.error(socket, 'Chọn giá trị từ 2 đến A.'); vote.value = guesses.value; }
    if (this.has(room, 9)) { if (!Number.isInteger(guesses.rank) || guesses.rank < 1 || guesses.rank > 10) return this.error(socket, 'Chọn thứ hạng bài.'); vote.rank = guesses.rank; }
    if (!Object.keys(vote).length) return;
    sd.votes[player.id] = vote;
    const votes = room.players.filter(p => p.id !== highest).map(p => sd.votes[p.id]);
    sd.guesses = votes.every(v => v && JSON.stringify(v) === JSON.stringify(vote)) ? vote : {};
    this.broadcast(code);
  }

  revealNext(socket, code, phaseKey, expectedCount) {
    const ctx = this.access(socket, code, { host: true, phase: ['SHOWDOWN'], playing: true, phaseKey }); if (!ctx) return;
    const { room } = ctx, sd = room.showdown;
    if (expectedCount !== undefined && expectedCount !== sd.revealedCount) return this.error(socket, 'Lá bài này đã được lật.');
    if (sd.revealedCount === sd.order.length - 1 && ((this.has(room, 4) && sd.guesses.value === undefined) || (this.has(room, 9) && sd.guesses.rank === undefined))) return this.error(socket, 'Tất cả đồng đội cần thống nhất dự đoán trước khi lật người cuối.');
    sd.revealedCount++;
    if (sd.revealedCount >= sd.order.length) this.finishHeist(room); else this.broadcast(code);
  }

  finishHeist(room) {
    const players = room.showdown.order.map(id => {
      const p = room.players.find(p => p.id === id);
      return { id: p.id, name: cleanName(p.name), avatar: p.avatar, chip: p.chips.red, privateCards: p.privateCards, best5: p.best5,
        handScore: p.handScore, handName: p.handName, handNameVi: p.handNameVi, rankLevel: p.rankLevel, hasMuscleBonus: p.hasMuscleBonus };
    });
    const result = checkShowdown(players), top = players.at(-1), guesses = room.showdown.guesses;
    const guessErrors = [];
    if (this.has(room, 4) && !top.privateCards.some(c => c.value === guesses.value)) guessErrors.push('Đoán sai giá trị bài tẩy của người giữ chip đỏ cao nhất.');
    if (this.has(room, 9) && top.rankLevel !== guesses.rank) guessErrors.push('Đoán sai thứ hạng bài của người giữ chip đỏ cao nhất.');
    if (guessErrors.length) { const originalError = result.success ? '' : ` ${result.reason}`; result.success = false; result.reason = guessErrors.join(' ') + originalError; }
    players.forEach((p, i) => { p.comparison = i ? explainComparison(players[i - 1], p) : 'Người đầu tiên: mốc so sánh cho các tay bài tiếp theo.'; p.orderCorrect = !i || players[i - 1].handScore <= p.handScore; });
    room.score[result.success ? 'vaults' : 'alarms']++;
    room.lastResult = { ...result, matchId: room.matchId, heistNumber: room.heistNumber, playerResults: players,
      mode: room.mode, score: { ...room.score }, date: new Date().toISOString(), durationMs: Date.now() - room.heistStartedAt, guesses };
    room.history.unshift(room.lastResult); room.history = room.history.slice(0, 100);
    room.gameWon = room.score.vaults >= room.maxVaults;
    room.gameOver = room.gameWon || room.score.alarms >= room.maxAlarms;
    room.phase = room.gameOver ? 'GAME_OVER' : 'RESULT';
    if (room.gameOver) { room.matches.unshift({ matchId: room.matchId, mode: room.mode, won: room.gameWon, score: { ...room.score }, date: new Date().toISOString() }); room.matches = room.matches.slice(0, 100); }
    this.addLog(room, result.success ? '🔓 Vụ cướp thành công!' : '🚨 Vụ cướp thất bại!', result.success ? 'win' : 'alarm');
    this.broadcast(room.code);
    leaveCompletedSeats(this, room, 'the-gang');
    if (this.rooms.has(room.code)) this.broadcast(room.code);
  }

  nextHeist(socket, code) {
    const ctx = this.access(socket, code, { host: true, phase: ['RESULT'], playing: true }); if (!ctx) return;
    const room = ctx.room, mode = GAME_MODES[room.mode];
    if (room.players.length < 2) return this.error(socket, 'Cần ít nhất hai người; hãy trở về phòng chờ.');
    if (mode.doubleChallenges) {
      room.activeChallenges.sort((a, b) => a.id - b.id);
      room.challengeDeck.push(room.activeChallenges.shift()); room.activeChallenges.push(room.challengeDeck.shift());
    } else if (mode.useCards) {
      room.challengeDeck.push(...room.activeChallenges); if (room.activeSpecialist) room.specialistDeck.push(room.activeSpecialist);
      room.activeChallenges = []; room.activeSpecialist = null;
      if (room.lastResult.success) room.activeChallenges = [room.challengeDeck.shift()]; else room.activeSpecialist = room.specialistDeck.shift();
    }
    this.startHeist(room);
  }

  playAgain(socket, code) { this.startGame(socket, code, true); }

  returnToLobby(socket, code) {
    const ctx = this.access(socket, code, { host: true }); if (!ctx) return;
    const room = ctx.room;
    this.resetToLobby(room, '🏠 Trở về phòng chờ');
    leaveCompletedSeats(this, room, 'the-gang');
    if (this.rooms.has(code)) this.broadcast(code);
  }

  resetToLobby(room, message = '🏠 Trở về phòng chờ') {
    this.rememberDecks(room);
    Object.assign(room, { phase: 'WAITING', paused: false, hostPaused: false, reconnectPaused: false, gameOver: false, gameWon: false, score: { vaults: 0, alarms: 0 },
      heistNumber: 0, roundNumber: 0, communityCards: [], allCommunityCards: [], remainingDeck: [], chipPool: [],
      activeChallenges: [], activeSpecialist: null, specialistState: null, permanentChallenge: null, showdown: null, lastResult: null });
    room.players.forEach(p => Object.assign(p, { ready: false, roundConfirmed: false, chips: emptyChips(), privateCards: [], best5: [], privateInsights: [], hasMuscleBonus: false, extraNote: '', handName: '', handNameVi: '' }));
    this.addLog(room, message, 'system');
  }

  sendChat(socket, code, text) {
    const ctx = this.access(socket, code); if (!ctx) return;
    const cleaned = typeof text === 'string' ? text.trim().slice(0, 80) : '';
    if (!cleaned) return;
    if (ctx.room.strictChat && !['WAITING', 'RESULT', 'GAME_OVER'].includes(ctx.room.phase) && !QUICK_CHAT.includes(cleaned)) return this.error(socket, 'Phòng đang dùng giao tiếp theo luật: chỉ gửi câu nhanh không tiết lộ bài.');
    const message = { messageId: crypto.randomUUID(), id: ctx.player.id, name: ctx.player.name, avatar: ctx.player.avatar, text: cleaned, time: clock() };
    ctx.room.chatLog.push(message); ctx.room.chatLog = ctx.room.chatLog.slice(-50);
    this.io.to(code).emit('chat_message', message); this.saveSoon();
  }

  sendEmote(socket, code, { targetId, emote }) {
    const ctx = this.access(socket, code); if (!ctx) return;
    if (!EMOTES.includes(emote)) return this.error(socket, 'Biểu cảm không hợp lệ.');
    if (ctx.room.strictChat && !['WAITING', 'RESULT', 'GAME_OVER'].includes(ctx.room.phase)) return this.error(socket, 'Chế độ giao tiếp theo luật tắt emoji trong vụ cướp.');
    const target = ctx.room.players.find(p => p.id === targetId);
    this.io.to(code).emit('player_emote', { fromId: ctx.player.id, fromName: ctx.player.name, toId: target?.id || null, toName: target?.name || null, emote });
  }

  addLog(room, msg, type = 'info') { room.log.unshift({ msg, type, t: clock(), heist: room.heistNumber, round: room.roundNumber }); room.log = room.log.slice(0, 100); }
  broadcast(code) {
    const room = this.rooms.get(code); if (!room) return;
    room.updatedAt = Date.now();
    if (this.onRoomChanged) {
      try { this.onRoomChanged(room); }
      catch (error) {
        this.storageWriteError = true;
        if (this.stateTransactionDepth) throw error;
        console.error('Không ghi được trạng thái SQLite:', error.message);
      }
    }
    for (const p of room.players) { const socket = this.io.sockets.sockets.get(p.socketId); if (socket && p.connected) socket.emit('game_state', this.buildStateFor(room, p.id)); }
    this.saveSoon();
  }

  buildStateFor(room, playerId) {
    const adapter = this.stateAdapters.get(room.gameId);
    if (adapter?.buildStateFor) return adapter.buildStateFor(room, playerId);
    const final = ['RESULT', 'GAME_OVER'].includes(room.phase), sd = room.showdown;
    const revealed = final ? room.players.map(p => p.id) : room.phase === 'SHOWDOWN' ? sd.order.slice(0, sd.revealedCount) : [];
    const blind = this.has(room, 8) && !final;
    const me = room.players.find(p => p.id === playerId);
    const specialist = room.specialistState;
    const state = { roomCode: room.code, myId: playerId, phase: room.phase, phaseKey: this.phaseKey(room),
      gameId: room.gameId || 'the-gang', category: room.category || 'casual', rulesVersion: room.rulesVersion || 1,
      variant: room.variant || 'standard', difficulty: room.difficulty || room.mode, roomName: room.config?.roomName || 'The Gang · Phòng LAN',
      maxPlayers: room.config?.maxPlayers || 6, visibility: room.config?.visibility || 'public', requiresPassword: !!room.config?.passwordHash,
      mode: room.mode, modeInfo: GAME_MODES[room.mode],
      heistNumber: room.heistNumber, roundNumber: room.roundNumber, currentRoundChipColor: room.currentRoundChipColor,
      score: room.score, maxVaults: room.maxVaults, maxAlarms: room.maxAlarms, gameOver: room.gameOver, gameWon: room.gameWon,
      paused: room.paused, disconnected: room.players.filter(p => !p.connected).map(p => p.name), strictChat: room.strictChat, quickChat: QUICK_CHAT,
      communityCards: room.communityCards, chipPool: room.chipPool, activeChallenges: room.activeChallenges, activeSpecialist: room.activeSpecialist,
      permanentChallenge: room.permanentChallenge, lastResult: room.lastResult, log: room.log.filter(e => !blind || e.type !== 'chip' && e.type !== 'snatch').slice(0, 35), chatLog: room.chatLog,
      history: room.history, matches: room.matches,
      myHand: me?.privateCards.length ? getBestHand(me.privateCards, room.communityCards) : null,
      privateInsights: me?.privateInsights || [], specialistState: specialist ? { stage: specialist.stage, proposal: specialist.proposal, usedBy: specialist.usedBy,
        recipientId: specialist.recipientId, selectedIds: Object.keys(specialist.choices), seenIds: specialist.seen, myChoice: specialist.choices[playerId] ?? null } : null,
      showdown: sd ? { order: sd.order, revealedCount: sd.revealedCount, guesses: sd.guesses, votes: sd.votes,
        needsValue: this.has(room, 4), needsRank: this.has(room, 9) } : null,
      players: room.players.map(p => {
        const visible = p.id === playerId || revealed.includes(p.id);
        return { id: p.id, name: cleanName(p.name), avatar: p.avatar, isHost: p.isHost, connected: p.connected, ready: p.ready,
          roundConfirmed: p.roundConfirmed, reconnectDeadline: deadlineFor(p, this.graceMs), leaveAfterHand: !!p.leaveAfterHand,
          chips: Object.fromEntries(COLORS.map(c => [c, blind && COLORS.indexOf(c) < room.roundNumber - 1 ? null : p.chips[c]])),
          lockedChip: ROUNDS.includes(room.phase) && this.isChipLocked(room, p.chips[room.currentRoundChipColor]),
          handName: revealed.includes(p.id) ? p.handName : '', handNameVi: revealed.includes(p.id) ? p.handNameVi : '',
          best5: revealed.includes(p.id) ? p.best5 : [], extraNote: p.extraNote,
          privateCards: visible ? p.privateCards : Array(p.privateCards.length).fill(null) };
      }) };
    return state;
  }
}

module.exports = { GameManager, QUICK_CHAT };
