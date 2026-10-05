'use strict';

const crypto = require('node:crypto');
const { GameManager } = require('../gameEngine');
const { TheGangAdapter } = require('../games/the-gang/adapter');
const { UnoAdapter } = require('../games/uno/adapter');
const { getGame, requirePlayable, validateRoomConfig } = require('./gameRegistry');
const { ProfileService } = require('./profileService');

class RoomService {
  constructor(io, options = {}) {
    const databaseFile = options.databaseFile || process.env.GANG_DATABASE_FILE || process.env.GANG_DB_FILE || ':memory:';
    this.profileService = options.profileService || new ProfileService({ databaseFile, legacyRoomsFile: options.storageFile });
    this.gameManager = new GameManager(io, {
      ...options,
      profileService: this.profileService,
      onRoomChanged: room => {
        const persisted = this.profileService.syncRoom(room);
        if (persisted?.completionEvent) io.to(room.code).emit('match_completed', persisted.completionEvent);
        return persisted;
      },
    });
    this.adapters = new Map([
      ['the-gang', new TheGangAdapter(this.gameManager)],
      ['uno', new UnoAdapter(this.gameManager)],
    ]);
    for (const [gameId, adapter] of this.adapters) {
      this.gameManager.registerStateAdapter(gameId, adapter);
      adapter.hydrate?.();
    }
    if (this.profileService.migrationReport?.status === 'completed' && !this.profileService.storageError) this.gameManager.flush();
  }

  get rooms() { return this.gameManager.rooms; }
  get playerRoom() { return this.gameManager.playerRoom; }
  get storageError() { return this.gameManager.storageError; }

  profileForRequest(request = {}) {
    return this.profileService.getOrCreate(request.playerName, request.avatar, request.profileToken);
  }

  addProfileCredentials(result, profile) {
    if (!result || result.error) return result;
    return { ...result, profileId: profile.player.playerId, profileToken: profile.rawToken, profile: this.profileService.publicProfile(profile.player.playerId) };
  }

  adapterFor(gameId) {
    requirePlayable(gameId);
    const adapter = this.adapters.get(gameId);
    if (!adapter) throw Object.assign(new Error('Game chưa có module chơi.'), { code: 'GAME_NOT_PLAYABLE' });
    return adapter;
  }

  createRoom(socket, request = {}) {
    const gameId = typeof request.gameId === 'string' ? request.gameId : 'the-gang';
    const game = requirePlayable(gameId);
    const config = validateRoomConfig(game.gameId, { ...request.config, difficulty: request.difficulty });
    const profile = this.profileForRequest(request);
    socket.data ||= {};
    socket.data.profile = this.profileService.profiles.publicProfile(profile.player.playerId);
    this.profileService.canEnterWalletRoom(profile.player.playerId, '');
    const result = this.adapterFor(game.gameId).createRoom(socket, { ...request, profile, difficulty: config.difficulty, config });
    if (result?.error) return result;
    this.profileService.syncRoom(this.rooms.get(result.roomCode));
    return this.addProfileCredentials(result, profile);
  }

  joinRoom(socket, request = {}) {
    const room = this.rooms.get(request.roomCode);
    if (!room) return { error: 'Không tìm thấy phòng.' };
    const gameId = room.gameId || 'the-gang';
    const game = getGame(gameId);
    if (!game || game.status !== 'playable') return { error: 'Game trong phòng chưa phát hành.' };
    const profile = this.profileForRequest(request);
    socket.data ||= {};
    socket.data.profile = this.profileService.profiles.publicProfile(profile.player.playerId);
    this.profileService.canEnterWalletRoom(profile.player.playerId, request.roomCode);
    const result = this.adapterFor(gameId).joinRoom(socket, { ...request, profile });
    if (result?.error) return result;
    this.profileService.syncRoom(this.rooms.get(result.roomCode));
    return this.addProfileCredentials(result, profile);
  }

  resumeRoom(socket, request = {}) {
    const room = this.rooms.get(request.roomCode);
    if (!room) return { error: 'Phiên chơi đã hết hạn hoặc phòng không còn tồn tại.' };
    const seat = room.players.find(p => typeof request.sessionToken === 'string' && (p.token === request.sessionToken || p.tokenHash === crypto.createHash('sha256').update(request.sessionToken).digest('hex')));
    const existingProfile = request.profileToken ? this.profileService.requireProfile(request.profileToken) : null;
    if (existingProfile && existingProfile.player.playerId !== (seat?.profileId || seat?.id)) return { error: 'Phiên hồ sơ không khớp với ghế cần khôi phục.' };
    const result = this.adapterFor(room.gameId || 'the-gang').resumeRoom(socket, request);
    if (result?.error) return result;
    const player = room.players.find(item => item.id === result.playerId);
    if (!player) return result;
    if (!this.profileService.publicProfile(player.profileId || player.id)) {
      const created = this.profileService.createProfile(player.name, player.avatar);
      player.profileId = created.player.playerId;
      socket.data ||= {};
      socket.data.profileToken = created.rawToken;
    }
    const profileToken = existingProfile?.rawToken || socket.data?.profileToken || this.profileService.issueProfileToken(player.profileId || player.id);
    socket.data ||= {};
    socket.data.profile = this.profileService.profiles.publicProfile(player.profileId || player.id);
    this.profileService.syncRoom(room);
    return { ...result, profileId: player.profileId || player.id, profileToken, profile: this.profileService.publicProfile(player.profileId || player.id) };
  }

  startGame(socket, roomCode, replay = false) {
    const room = this.rooms.get(roomCode);
    if (!room) return this.gameManager.error(socket, 'Không tìm thấy phòng.');
    if ((room.gameId || 'the-gang') === 'the-gang') return this.gameManager.startGame(socket, roomCode, replay);
    return this.adapterFor(room.gameId).startGame(socket, roomCode, replay);
  }

  returnToLobby(socket, roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return this.gameManager.error(socket, 'Không tìm thấy phòng.');
    if ((room.gameId || 'the-gang') === 'the-gang') return this.gameManager.returnToLobby(socket, roomCode);
    return this.adapterFor(room.gameId).returnToLobby(socket, roomCode);
  }

  playAgain(socket, roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return this.gameManager.error(socket, 'Không tìm thấy phòng.');
    if ((room.gameId || 'the-gang') === 'the-gang') return this.gameManager.playAgain(socket, roomCode);
    return this.adapterFor(room.gameId).playAgain(socket, roomCode);
  }

  handleGameAction(socket, envelope = {}) {
    const code = typeof envelope.roomCode === 'string' ? envelope.roomCode.trim().toUpperCase() : '';
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Không tìm thấy phòng.' } };
    return this.adapterFor(room.gameId || 'the-gang').handleAction(socket, { ...envelope, roomCode: code });
  }

  requestGameState(socket, roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Không tìm thấy phòng.' } };
    const player = this.gameManager.player(room, socket);
    if (!player) return { ok: false, error: { code: 'ROOM_ACCESS', message: 'Bạn không còn ở trong phòng này.' } };
    return { ok: true, state: this.gameManager.buildStateFor(room, player.id) };
  }

  publicRooms() {
    return [...this.rooms.values()]
      .filter(room => (room.config?.visibility || 'public') === 'public' && room.phase === 'WAITING')
      .map(room => this.gameManager.publicRoom(room));
  }

  close() {
    for (const adapter of this.adapters.values()) for (const code of adapter.timers?.keys() || []) adapter.clearTimer(code);
    this.gameManager.close(); this.profileService.close();
  }
}

module.exports = { RoomService };
