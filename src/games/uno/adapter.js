'use strict';

const crypto = require('node:crypto');
const { createMatch, resetForNextRound, applyAction, visibleState, expireWindows } = require('./engine');

const error = (code, message, state) => ({ ok: false, error: { code, message }, ...(state ? { state } : {}) });

class UnoAdapter {
  constructor(gameManager) {
    this.gameManager = gameManager;
    this.gameId = 'uno';
    this.timers = new Map();
  }

  hydrate() {
    for (const room of this.gameManager.rooms.values()) {
      if (room.gameId === this.gameId && room.uno) this.schedule(room);
    }
  }

  createRoom(socket, request = {}) {
    return this.gameManager.createRoom(socket, request.playerName, 'ADVANCED', request.avatar, {
      ...(request.config || {}), gameId: this.gameId, variant: 'classic-local-v1', profile: request.profile,
    });
  }

  joinRoom(socket, request = {}) {
    return this.gameManager.joinRoom(socket, request.roomCode, request.playerName, request.avatar, { password: request.password, profile: request.profile });
  }

  resumeRoom(socket, request = {}) {
    return this.gameManager.resumeRoom(socket, request.roomCode, request.sessionToken);
  }

  startGame(socket, code) {
    const room = this.gameManager.rooms.get(code);
    const player = this.gameManager.player(room, socket);
    if (!room || !player) return this.gameManager.error(socket, 'Bạn không còn ở trong phòng này.');
    if (!player.isHost) return this.gameManager.error(socket, 'Chỉ chủ phòng được bắt đầu ván UNO.');
    if (room.phase !== 'WAITING') return this.gameManager.error(socket, 'Phòng không ở trạng thái chờ.');
    const maxPlayers = room.config?.maxPlayers || 4;
    if (room.players.length < 2 || room.players.length > maxPlayers) return this.gameManager.error(socket, `UNO cần từ 2 đến ${maxPlayers} người.`);
    if (room.players.some(item => !item.ready)) return this.gameManager.error(socket, 'Tất cả thành viên cần bấm Sẵn sàng.');
    room.uno = createMatch({ playerIds: room.players.map(item => item.id), matchId: crypto.randomUUID() });
    room.matchId = room.uno.matchId;
    room.phase = 'PLAYING';
    this.gameManager.addLog(room, `🎴 VÁN UNO #${room.uno.roundNumber} BẮT ĐẦU`, 'heist');
    this.schedule(room);
    this.gameManager.broadcast(code);
    return { ok: true, matchId: room.matchId };
  }

  returnToLobby(socket, code) {
    const room = this.gameManager.rooms.get(code);
    const player = this.gameManager.player(room, socket);
    if (!room || !player) return this.gameManager.error(socket, 'Bạn không còn ở trong phòng này.');
    if (!player.isHost) return this.gameManager.error(socket, 'Chỉ chủ phòng được đưa UNO về phòng chờ.');
    this.clearTimer(code);
    room.uno = null; room.phase = 'WAITING'; room.matchId = crypto.randomUUID();
    room.players.forEach(item => { item.ready = false; item.roundConfirmed = false; });
    this.gameManager.addLog(room, '🏠 Trở về phòng chờ UNO', 'system');
    this.gameManager.broadcast(code);
    return { ok: true };
  }

  playAgain(socket, code) {
    const room = this.gameManager.rooms.get(code);
    const player = this.gameManager.player(room, socket);
    if (!room || !player) return this.gameManager.error(socket, 'Bạn không còn ở trong phòng này.');
    return this.handleAction(socket, { roomCode: code, matchId: room.uno?.matchId, expectedRevision: room.uno?.revision, actionId: crypto.randomUUID(), type: 'start_next_round', payload: {} });
  }

  handleAction(socket, envelope = {}) {
    const room = this.gameManager.rooms.get(envelope.roomCode);
    const player = this.gameManager.player(room, socket);
    if (!room || !player) return error('ROOM_ACCESS', 'Bạn không còn ở trong phòng này.');
    const match = room.uno;
    if (!match) return error('MATCH_NOT_FOUND', 'Ván UNO chưa bắt đầu.');
    const state = () => this.buildStateFor(room, player.id);
    const actionId = typeof envelope.actionId === 'string' && envelope.actionId.length <= 100 ? envelope.actionId : '';
    if (!actionId) return error('INVALID_ACTION', 'Thiếu mã thao tác.');
    const duplicate = match.actionReceipts?.find(receipt => receipt.actionId === actionId);
    if (duplicate) return error('DUPLICATE_ACTION', 'Thao tác này đã được xử lý.', state());
    if (envelope.matchId !== match.matchId) return error('MATCH_NOT_FOUND', 'Ván UNO đã đổi; hãy lấy trạng thái mới.', state());
    if (!Number.isInteger(envelope.expectedRevision) || envelope.expectedRevision !== match.revision) {
      return error('STALE_REVISION', 'Bàn UNO đã thay đổi; hãy thao tác trên trạng thái mới.', state());
    }

    const outcome = applyAction(match, {
      playerId: player.id, type: envelope.type, payload: envelope.payload || {}, isHost: player.isHost,
      now: Date.now(),
    });
    match.actionReceipts ||= [];
    match.actionReceipts.push({ actionId, ok: outcome.ok, error: outcome.error || null, revision: match.revision });
    match.actionReceipts = match.actionReceipts.slice(-500);
    if (!outcome.ok) return { ...outcome, state: state() };

    if (outcome.nextRound) {
      const next = resetForNextRound(match, { matchId: crypto.randomUUID(), now: Date.now() });
      room.uno = next; room.matchId = next.matchId; room.phase = 'PLAYING';
      this.schedule(room);
      this.gameManager.addLog(room, `🎴 VÁN UNO #${next.roundNumber} BẮT ĐẦU`, 'heist');
    } else {
      room.phase = match.phase;
      room.matchId = match.matchId;
      this.schedule(room);
      if (match.phase === 'RESULT') {
      this.gameManager.addLog(room, '🏁 Ván UNO kết thúc', 'win');
      }
    }
    this.gameManager.broadcast(room.code);
    return { ok: true, event: outcome.event || 'ACTION_APPLIED', state: this.buildStateFor(room, player.id) };
  }

  onDisconnect(room) {
    if (room?.gameId === this.gameId) this.schedule(room);
  }

  schedule(room) {
    if (!room?.uno) return;
    this.clearTimer(room.code);
    const deadlines = [room.uno.reactionWindow?.deadlineAt, room.uno.unoWindow?.deadlineAt].filter(Number.isFinite);
    if (!deadlines.length) return;
    const delay = Math.max(0, Math.min(...deadlines) - Date.now());
    const timer = setTimeout(() => this.timeout(room.code), delay);
    timer.unref?.();
    this.timers.set(room.code, timer);
  }

  timeout(code) {
    const room = this.gameManager.rooms.get(code);
    this.clearTimer(code);
    if (!room?.uno) return;
    const before = room.uno.revision;
    const changed = expireWindows(room.uno, Date.now());
    if (changed) {
      room.uno.revision = before + 1;
      room.uno.updatedAt = Date.now();
      room.phase = room.uno.phase;
      this.gameManager.addLog(room, '⏱️ Cửa sổ phản ứng UNO đã hết giờ; server tự xử lý.', 'system');
      this.gameManager.broadcast(code);
    }
    this.schedule(room);
  }

  clearTimer(code) {
    const timer = this.timers.get(code);
    if (timer) clearTimeout(timer);
    this.timers.delete(code);
  }

  buildStateFor(room, playerId) {
    const players = room.players || [];
    if (!room.uno) {
      return {
        roomCode: room.code, myId: playerId, seatId: playerId, gameId: 'uno', category: 'casual', rulesVersion: 1,
        variant: 'classic-local-v1', phase: 'WAITING', matchId: room.matchId, revision: 0, serverTime: Date.now(),
        roomName: room.config?.roomName || 'UNO · Phòng LAN', maxPlayers: room.config?.maxPlayers || 4,
        visibility: room.config?.visibility || 'public', requiresPassword: !!room.config?.passwordHash,
        direction: 'clockwise', currentColor: null, currentPlayerId: null, pendingDraw: 0, pendingTargetId: null,
        drawPileCount: 0, discardPileCount: 0, topCard: null, reactionWindow: null, unoWindow: null, drawChoice: null,
        availableActions: [], result: null, myHand: [], disconnected: players.filter(item => !item.connected).map(item => item.name),
        strictChat: false, quickChat: [], chatLog: room.chatLog || [], log: [],
        players: players.map(item => ({ id: item.id, name: item.name, avatar: item.avatar, isHost: item.isHost, connected: item.connected,
          ready: item.ready, cardCount: 0, isCurrent: false, unoCalled: false })),
      };
    }
    return visibleState(room.uno, playerId, players, room, Date.now());
  }
}

module.exports = { UnoAdapter };
