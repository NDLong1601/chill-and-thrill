'use strict';

const path = require('node:path');
const { verifyPassword } = require('./roomConfig');
const { projectSpectatorState } = require('./spectatorProjection');
const { subscribeRoomCommits } = require('./roomCommitEvents');

const CHANNEL_PREFIX = 'spectator:';
const UNAVAILABLE = Object.freeze({ ok: false, code: 'SPECTATOR_UNAVAILABLE', message: 'Không tìm thấy phòng hoặc mật khẩu không đúng.' });
const ROLE_EVENTS = new Set(['spectator:join', 'spectator:leave']);

function normalizeCode(value) {
  if (typeof value !== 'string') return '';
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,32}$/.test(code) ? code : '';
}

function managersOf(gm) {
  return [...new Set([gm?.gang, gm?.uno, gm?.tienLen, gm?.poker, gm?.samLoc, gm?.phom, gm?.bang].filter(Boolean))];
}

function spectatorChannel(code) { return `${CHANNEL_PREFIX}${code}`; }

class SpectatorService {
  constructor({ io, gm, maxPerRoom = 48, maxTotal = 512 } = {}) {
    if (!io || !gm) throw new TypeError('SpectatorService requires io and gm.');
    this.io = io;
    this.gm = gm;
    this.maxPerRoom = Math.max(1, Number(maxPerRoom) || 48);
    this.maxTotal = Math.max(1, Number(maxTotal) || 512);
    this.watchersByRoom = new Map();
    this.roomRefByCode = new Map();
    this.roomBySocket = new Map();
    this.playerRoomBySocket = new Map();
    this.pendingBroadcastRooms = new Set();
    this.broadcastFlushQueued = false;
    this.socketTaps = new Map();
    this.closed = false;
    this.unsubscribeCommits = managersOf(gm).map(manager =>
      subscribeRoomCommits(manager, code => this.queueCommittedRoom(code)));
    this.connectionHandler = socket => this.attachSocket(socket);
    this.io.on('connection', this.connectionHandler);
    this.cleanupTimer = setInterval(() => this.pruneClosedRooms(), 1000);
    this.cleanupTimer.unref?.();
    const connected = this.io.sockets?.sockets;
    const sockets = connected instanceof Map ? connected.values() : Object.values(connected || {});
    for (const socket of sockets) this.installStateEmissionTap(socket);
  }

  roomFor(code) {
    const manager = this.gm.managerForCode?.(code);
    const room = manager?.rooms?.get(code);
    if (!manager || !room || room.code !== code) return null;
    return { manager, room };
  }

  authorize(codeInput, password) {
    const code = normalizeCode(codeInput);
    if (!code) return null;
    const found = this.roomFor(code);
    if (!found) return null;
    const hash = found.room.config?.passwordHash;
    try {
      if (!verifyPassword(password, hash)) return null;
    } catch { return null; }
    return found;
  }

  stateResponse(codeInput, password) {
    const found = this.authorize(codeInput, password);
    if (!found) return { ...UNAVAILABLE };
    const state = projectSpectatorState(this.gm, normalizeCode(codeInput));
    if (!state) return { ...UNAVAILABLE };
    return {
      ok: true,
      readOnly: true,
      policy: {
        message: 'Bạn đang xem ở chế độ chỉ đọc. Chỉ có thể vào ghế khi phòng đang chờ; hãy rời chế độ xem rồi dùng luồng vào bàn thông thường.',
        canJoinSeat: found.room.phase === 'WAITING',
      },
      state,
    };
  }

  watcherCount(codeInput) {
    const code = normalizeCode(codeInput);
    return this.watchersByRoom.get(code)?.size || 0;
  }

  totalWatcherCount() { return this.roomBySocket.size; }

  isPlayerSocket(socket) {
    return managersOf(this.gm).some(manager => manager.playerRoom?.has?.(socket.id));
  }

  attachSocket(socket) {
    this.installStateEmissionTap(socket);
    if (typeof socket.use === 'function') {
      socket.use((packet, next) => {
        const code = this.roomBySocket.get(socket.id);
        if (!code || ROLE_EVENTS.has(packet?.[0])) return next();
        const error = new Error('Rời chế độ xem trước khi dùng thao tác của người chơi.');
        error.data = { code: 'SPECTATOR_READ_ONLY' };
        socket.emit('spectator:role_error', { code: 'SPECTATOR_READ_ONLY', message: error.message });
        return next(error);
      });
    }

    socket.on('spectator:join', async (input = {}, callback) => {
      const ack = typeof callback === 'function' ? callback : () => {};
      const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
      const code = normalizeCode(data.roomCode);
      if (!code || this.isPlayerSocket(socket)) return ack({ ...UNAVAILABLE });
      const response = this.stateResponse(code, data.password);
      if (!response.ok) return ack(response);
      const found = this.roomFor(code);
      const expectedRoom = this.roomRefByCode.get(code);
      if (expectedRoom && found && expectedRoom !== found.room) this.invalidateRoomWatchers(code);
      if (!this.roomBySocket.has(socket.id) && this.totalWatcherCount() >= this.maxTotal) {
        return ack({ ok: false, code: 'SPECTATOR_LIMIT', message: 'Đã đủ người xem. Hãy thử lại sau.' });
      }
      const existing = this.watchersByRoom.get(code);
      if (!existing?.has(socket.id) && (existing?.size || 0) >= this.maxPerRoom) {
        return ack({ ok: false, code: 'SPECTATOR_LIMIT', message: 'Bàn đã đủ người xem. Hãy thử lại sau.' });
      }

      await this.leaveSocket(socket, false);
      const channel = spectatorChannel(code);
      await socket.join(channel);
      let watchers = this.watchersByRoom.get(code);
      if (!watchers) this.watchersByRoom.set(code, watchers = new Set());
      watchers.add(socket.id);
      this.roomRefByCode.set(code, found.room);
      this.roomBySocket.set(socket.id, code);
      ack(response);
      socket.emit('spectator:state', response.state);
    });

    socket.on('spectator:leave', async (_input = {}, callback) => {
      await this.leaveSocket(socket, true);
      if (typeof callback === 'function') callback({ ok: true });
    });
    socket.on('disconnect', () => { this.leaveSocket(socket, false).catch(() => {}); });
  }

  installStateEmissionTap(socket) {
    if (!socket || typeof socket.emit !== 'function' || this.socketTaps.has(socket.id)) return;
    const originalEmit = socket.emit;
    const service = this;
    function tappedEmit(event, ...args) {
      const result = Reflect.apply(originalEmit, this, [event, ...args]);
      if (event === 'game_state') {
        service.rememberPlayerRoom(socket, args[0]);
        service.observePlayerStateEmission(socket);
      } else if (event === 'room_left') service.observePlayerRoomLeft(socket);
      return result;
    }
    socket.emit = tappedEmit;
    const restore = () => {
      if (socket.emit === tappedEmit) socket.emit = originalEmit;
      this.socketTaps.delete(socket.id);
    };
    socket.once?.('disconnect', restore);
    this.socketTaps.set(socket.id, { socket, originalEmit, tappedEmit, restore });
  }

  rememberPlayerRoom(socket, state) {
    const code = normalizeCode(state?.roomCode);
    if (!code) return;
    if (managersOf(this.gm).some(manager => manager.playerRoom?.get?.(socket.id) === code)) {
      this.playerRoomBySocket.set(socket.id, code);
    }
  }

  observePlayerRoomLeft(socket) {
    const code = this.playerRoomBySocket.get(socket.id);
    this.playerRoomBySocket.delete(socket.id);
    if (code && !this.roomFor(code)) this.invalidateRoomWatchers(code);
  }

  invalidateRoomWatchers(code) {
    const watchers = [...(this.watchersByRoom.get(code) || [])];
    this.watchersByRoom.delete(code);
    this.roomRefByCode.delete(code);
    for (const socketId of watchers) {
      this.roomBySocket.delete(socketId);
      const socket = this.io.sockets?.sockets?.get?.(socketId);
      if (!socket) continue;
      socket.emit('spectator:unavailable', { roomCode: code });
      Promise.resolve(socket.leave(spectatorChannel(code))).catch(() => {});
    }
  }

  pruneClosedRooms() {
    for (const [code, expectedRoom] of this.roomRefByCode) {
      const current = this.roomFor(code);
      if (!current || current.room !== expectedRoom) this.invalidateRoomWatchers(code);
    }
  }

  observePlayerStateEmission(socket) {
    for (const manager of managersOf(this.gm)) {
      const code = manager.playerRoom?.get?.(socket.id);
      if (!code || !manager.rooms?.has?.(code)) continue;
      this.queueCommittedRoom(code);
      return;
    }
  }

  queueCommittedRoom(code) {
    if (this.closed || !this.watchersByRoom.has(code)) return;
    this.pendingBroadcastRooms.add(code);
    if (this.broadcastFlushQueued) return;
    this.broadcastFlushQueued = true;
    queueMicrotask(() => {
      this.broadcastFlushQueued = false;
      const rooms = [...this.pendingBroadcastRooms];
      this.pendingBroadcastRooms.clear();
      if (!this.closed) for (const roomCode of rooms) this.publishCommittedRoom(roomCode);
    });
  }

  async leaveSocket(socket, notify = false) {
    const code = this.roomBySocket.get(socket.id);
    if (!code) return;
    this.roomBySocket.delete(socket.id);
    const watchers = this.watchersByRoom.get(code);
    watchers?.delete(socket.id);
    if (!watchers?.size) { this.watchersByRoom.delete(code); this.roomRefByCode.delete(code); }
    try { await socket.leave(spectatorChannel(code)); } catch { /* disconnect already removed the membership */ }
    if (notify && socket.connected !== false) socket.emit('spectator:left', { ok: true });
  }

  // Call only after the room manager's committed broadcast. Fixed-game and
  // Poker transactions defer player effects until commit; this guard refuses
  // accidental publication from inside those transactions.
  publishCommittedRoom(codeInput) {
    const code = normalizeCode(codeInput);
    if (!code || !this.watchersByRoom.has(code)) return false;
    const found = this.roomFor(code);
    if (!found) {
      this.invalidateRoomWatchers(code);
      return false;
    }
    if (this.roomRefByCode.get(code) && this.roomRefByCode.get(code) !== found.room) {
      this.invalidateRoomWatchers(code);
      return false;
    }
    const manager = found.manager;
    if (manager.coinTransactionDepth || manager.mutationDepth || manager.stateTransactionDepth || manager.coinTransactionFailure || manager.stateTransactionFailure) return false;
    const state = projectSpectatorState(this.gm, code);
    if (!state) return false;
    this.io.to(spectatorChannel(code)).emit('spectator:state', state);
    return true;
  }

  close() {
    this.closed = true;
    this.unsubscribeCommits.forEach(unsubscribe => unsubscribe());
    this.pendingBroadcastRooms.clear();
    this.io.off?.('connection', this.connectionHandler);
    clearInterval(this.cleanupTimer);
    for (const tap of this.socketTaps.values()) tap.restore();
    this.socketTaps.clear();
    for (const [socketId, code] of [...this.roomBySocket]) {
      const socket = this.io.sockets?.sockets?.get?.(socketId);
      if (socket) this.leaveSocket(socket, false).catch(() => {});
      else {
        const watchers = this.watchersByRoom.get(code);
        watchers?.delete(socketId);
      }
    }
    this.roomBySocket.clear();
    this.watchersByRoom.clear();
    this.roomRefByCode.clear();
    this.playerRoomBySocket.clear();
  }
}

function attachSpectatorRoutes(app, service, { publicDirectory = path.join(__dirname, '..', '..', 'public') } = {}) {
  app.post('/api/spectators/:code/state', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const response = service.stateResponse(req.params.code, req.body?.password);
    return response.ok ? res.json(response) : res.status(404).json(response);
  });
  app.get('/spectate/:code', (_req, res) => res.sendFile(path.join(publicDirectory, 'spectator.html')));
}

function attachSpectatorSupport(app, io, gm, options = {}) {
  const service = new SpectatorService({ io, gm, maxPerRoom: options.maxPerRoom, maxTotal: options.maxTotal });
  attachSpectatorRoutes(app, service, options);
  return { service, close: () => service.close() };
}

module.exports = { SpectatorService, attachSpectatorRoutes, attachSpectatorSupport, normalizeCode, spectatorChannel };
