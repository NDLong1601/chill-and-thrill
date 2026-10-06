'use strict';

const crypto = require('node:crypto');
const { createMatch, resetForNextRound, applyAction, visibleState, expireWindows } = require('./engine');
const { leaveCompletedSeats } = require('../../platform/completedRoom');
const { isServerActionSocket } = require('../../platform/reconnectGrace');

const error = (code, message, state) => ({ ok: false, error: { code, message }, ...(state ? { state } : {}) });

class UnoAdapter {
  constructor(gameManager) {
    this.gameManager = gameManager;
    this.gameId = 'uno';
    this.timers = new Map();
    require('../../platform/gameStateTransactions').wrapGameStateMutations(gameManager, this,
      ['leaveRoom', 'startGame', 'returnToLobby', 'playAgain', 'handleAction', 'timeout']);
  }

  hydrate() {
    for (const room of this.gameManager.rooms.values()) {
      if (room.gameId === this.gameId && room.uno) this.schedule(room);
    }
  }

  onStateMutationFailed(method, args) {
    if (method !== 'timeout') return;
    const code = args[0], room = this.gameManager.rooms.get(code);
    this.clearTimer(code);
    if (!room?.uno || (!room.uno.reactionWindow && !room.uno.unoWindow)) return;
    // Keep an automatic recovery path after a timer's commit fails, without
    // repeatedly retrying an already expired window at zero delay.
    const timer = setTimeout(() => this.timeout(code), 30000);
    timer.unref?.();
    this.timers.set(code, timer);
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

  leaveRoom(socket, code) {
    const room = this.gameManager.rooms.get(code), player = this.gameManager.player(room, socket);
    if (!room || !player || isServerActionSocket(this.gameManager, socket)) return this.gameManager.error(socket, 'Bạn không còn ở trong phòng UNO này.');
    if (room.phase === 'PLAYING') {
      this.clearTimer(code);
      room.uno = null; room.phase = 'WAITING'; room.matchId = crypto.randomUUID(); room.turnClock = null;
      room.paused = false; room.hostPaused = false; room.reconnectPaused = false;
      room.players.forEach(item => { item.ready = false; item.roundConfirmed = false; item.leaveAfterHand = false; });
      this.gameManager.addLog(room, `Ván UNO bị hủy vì ${player.name} rời phòng. Cả đội trở về phòng chờ.`, 'system');
    }
    return this.gameManager.leaveRoom(socket, code);
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
    room.reconnectPolicyVersion = 2;
    room.hostPaused = false;
    room.reconnectPaused = false;
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
    if (envelope.type === 'leave_after_hand') {
      if (isServerActionSocket(this.gameManager, socket) || match.phase !== 'PLAYING') return error('INVALID_ACTION', 'Chỉ có thể xếp lịch rời khi ván UNO đang chơi.');
      const actionId = typeof envelope.actionId === 'string' && envelope.actionId.length <= 100 ? envelope.actionId : '';
      if (!actionId) return error('INVALID_ACTION', 'Thiếu mã thao tác.');
      const existing = match.actionReceipts?.find(receipt => receipt.actionId === actionId);
      if (existing) return { ok: true, event: 'LEAVE_QUEUED', state: this.buildStateFor(room, player.id) };
      if (envelope.matchId !== match.matchId) return error('MATCH_NOT_FOUND', 'Ván UNO đã đổi; hãy lấy trạng thái mới.', this.buildStateFor(room, player.id));
      if (!Number.isInteger(envelope.expectedRevision) || envelope.expectedRevision !== match.revision) return error('STALE_REVISION', 'Bàn UNO đã thay đổi; hãy thao tác trên trạng thái mới.', this.buildStateFor(room, player.id));
      player.leaveAfterHand = true;
      match.revision += 1; match.updatedAt = Date.now();
      match.actionReceipts ||= []; match.actionReceipts.push({ actionId, ok: true, revision: match.revision, type: 'leave_after_hand' });
      match.actionReceipts = match.actionReceipts.slice(-500);
      this.gameManager.addLog(room, `${player.name} sẽ rời phòng sau khi ván UNO kết thúc.`, 'system');
      this.gameManager.broadcast(room.code);
      return { ok: true, event: 'LEAVE_QUEUED', state: this.buildStateFor(room, player.id) };
    }
    const { waiting } = this.gameManager.refreshReconnectState(room);
    if (!isServerActionSocket(this.gameManager, socket) && match.phase === 'PLAYING' && waiting.length) return error('GAME_PAUSED', `Ván đang chờ ${waiting.map(item => item.name).join(', ')} kết nối lại.`);
    if (this.gameManager.turnClock && this.gameManager.turnClock.expire(room)) return error('TURN_EXPIRED', 'Lượt đã hết 30 giây; hãy lấy trạng thái mới.');
    const state = () => this.buildStateFor(room, player.id);
    const beforeActor = match.currentPlayerId;
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
    if (outcome.event === 'CARD_PLAYED' && match.currentPlayerId === beforeActor) room.turnClock = null;

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
        this.gameManager.broadcast(room.code);
        leaveCompletedSeats(this.gameManager, room, 'uno');
      }
    }
    if (this.gameManager.rooms.has(room.code)) this.gameManager.broadcast(room.code);
    return { ok: true, event: outcome.event || 'ACTION_APPLIED', state: this.buildStateFor(room, player.id) };
  }

  onDisconnect(room) {
    if (room?.gameId === this.gameId) this.schedule(room);
  }

  timeoutTurn(room, player, socket) {
    const send = (type, payload = {}) => this.handleAction(socket, { roomCode: room.code, matchId: room.uno.matchId, expectedRevision: room.uno.revision, actionId: crypto.randomUUID(), type, payload });
    const match = room.uno;
    if (match.openingColorPending) return send('choose_color', { color: 'red' });
    if (match.pendingDraw || match.reactionWindow) return send('draw_penalty');
    if (!match.drawChoice) {
      const outcome = send('draw_card');
      if (outcome?.ok === false || outcome?.error) return outcome;
    }
    if (match.drawChoice && match.currentPlayerId === player.id) return send('pass_draw');
  }

  schedule(room) {
    if (this.gameManager.stateTransactionDepth) {
      this.gameManager.deferStateEffect(() => this.schedule(room));
      return;
    }
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
    if (this.gameManager.stateTransactionDepth) {
      this.gameManager.deferStateEffect(() => this.clearTimer(code));
      return;
    }
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
    const clock = this.gameManager.turnClock?.refresh(room);
    const state = visibleState(room.uno, playerId, players, room, Date.now());
    state.players = state.players.map(item => {
      const player = players.find(candidate => candidate.id === item.id);
      return { ...item, leaveAfterHand: !!player?.leaveAfterHand };
    });
    return { ...state, serverNow: Date.now(), turnClock: clock ? { playerId: clock.playerId, durationMs: clock.durationMs, deadlineAt: clock.deadlineAt, remainingMs: clock.deadlineAt ? Math.max(0, clock.deadlineAt - Date.now()) : clock.remainingMs } : null };
  }
}

module.exports = { UnoAdapter };
