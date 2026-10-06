'use strict';

const path = require('node:path');
const { UnoManager } = require('../games/uno/unoEngine');
const { TienLenManager } = require('../games/tien-len/tienLenEngine');
const { PokerManager } = require('../games/poker/pokerEngine');
const { SamLocManager } = require('../games/sam-loc/samLocEngine');
const { PhomManager } = require('../games/phom/phomEngine');
const { BangManager } = require('../games/bang/bangEngine');
const { getGame, validateRoomConfig } = require('./gameRegistry');
const { passwordHash, verifyPassword } = require('./roomConfig');
const { ProfileStore } = require('./profileStore');
const { ProfileService } = require('./profileService');
const { RoomService } = require('./roomService');
const { buildRoomPreflight } = require('./preflightService');
const { createGameAdapterContract, resolveGameVariant } = require('./gameAdapterContract');

const WAGER_GAMES = new Set(['tien-len', 'sam-loc', 'phom', 'poker']);

function unavailablePreflight(room, playerId) {
  const player = room?.players?.find(item => item.id === playerId);
  if (!room || !player) return null;
  const gameId = room.gameId || 'the-gang';
  const requiresWagerSafety = WAGER_GAMES.has(gameId);
  return {
    schemaVersion: 1,
    room: { code: String(room.code || ''), gameId, variant: room.variant || room.rulesVersion || 'standard',
      phase: String(room.phase || ''), revision: Number.isSafeInteger(room.revision) ? room.revision : null,
      minPlayers: null, maxPlayers: Number.isInteger(room.config?.maxPlayers) ? room.config.maxPlayers : null, requiresWagerSafety },
    seats: room.players.map(item => ({ id: String(item.id), name: String(item.name || 'Người chơi'), ready: item.ready === true, connected: item.connected === true })),
    viewer: { seatId: String(player.id), isHost: player.isHost === true, wallet: null,
      funding: { mode: requiresWagerSafety ? 'unknown' : 'none', status: 'unknown' } },
    evaluation: { allowed: false, blockers: player.isHost ? [{ code: 'PREFLIGHT_UNAVAILABLE' }] : [] },
    storage: { canStartWager: null },
  };
}

function storageBlockMessage(status) {
  return status?.blockedReason || 'Chưa thể xác nhận lưu trữ an toàn để bắt đầu ván cược mới.';
}

function unoStorageFile(storageFile) {
  if (!storageFile) return null;
  const parsed = path.parse(storageFile);
  return path.join(parsed.dir, `${parsed.name}.uno${parsed.ext || '.json'}`);
}
function tienLenStorageFile(storageFile) {
  if (!storageFile) return null;
  const parsed = path.parse(storageFile);
  return path.join(parsed.dir, `${parsed.name}.tien-len${parsed.ext || '.json'}`);
}
function pokerStorageFile(storageFile) {
  if (!storageFile) return null;
  const parsed = path.parse(storageFile);
  return path.join(parsed.dir, `${parsed.name}.poker${parsed.ext || '.json'}`);
}
function samLocStorageFile(storageFile) {
  if (!storageFile) return null;
  const parsed = path.parse(storageFile);
  return path.join(parsed.dir, `${parsed.name}.sam-loc${parsed.ext || '.json'}`);
}
function phomStorageFile(storageFile) {
  if (!storageFile) return null;
  const parsed = path.parse(storageFile);
  return path.join(parsed.dir, `${parsed.name}.phom${parsed.ext || '.json'}`);
}
function bangStorageFile(storageFile) {
  if (!storageFile) return null;
  const parsed = path.parse(storageFile);
  return path.join(parsed.dir, `${parsed.name}.bang${parsed.ext || '.json'}`);
}

// Keeps the established The Gang manager intact while giving new games one
// transport entry point.  Existing room codes and socket events stay valid.
class MultiGameManager {
  constructor(io, options = {}) {
    this.io = io;
    this.storageDiagnostics = options.storageDiagnostics || null;
    this.storageStatusRefresher = typeof options.storageStatusRefresher === 'function' ? options.storageStatusRefresher : null;
    this.profiles = options.profileStore || new ProfileStore({ databaseFile: options.databaseFile || (options.storageFile ? `${options.storageFile}.profiles.sqlite` : ':memory:'), legacyRoomsFile: options.storageFile });
    this.ownsProfileStore = !options.profileStore;
    const profileForSocket = socket => socket.data.profile || null;
    const onMatchCompleted = match => this.profiles.recordCompletedMatch(match);
    this.roomService = new RoomService(io, { ...options, profileService: new ProfileService({ profileStore: this.profiles }), profileForSocket,
      codeTaken: code => this.uno?.rooms.has(code) || this.tienLen?.rooms.has(code) || this.poker?.rooms.has(code) || this.samLoc?.rooms.has(code) || this.phom?.rooms.has(code) || this.bang?.rooms.has(code) });
    this.gang = this.roomService.gameManager;
    this.uno = new UnoManager(io, { profileStore: this.profiles, storageFile: options.unoStorageFile || unoStorageFile(options.storageFile), storageDiagnostics: options.storageDiagnostics, graceMs: options.graceMs, profileForSocket, onMatchCompleted, codeTaken: code => this.gang.rooms.has(code) || this.tienLen?.rooms.has(code) || this.poker?.rooms.has(code) || this.samLoc?.rooms.has(code) || this.phom?.rooms.has(code) || this.bang?.rooms.has(code) });
    this.tienLen = new TienLenManager(io, { storageFile: options.tienLenStorageFile || tienLenStorageFile(options.storageFile), storageDiagnostics: options.storageDiagnostics, graceMs: options.graceMs, profileForSocket, profileStore: this.profiles, onMatchCompleted, codeTaken: code => this.gang.rooms.has(code) || this.uno.rooms.has(code) || this.poker?.rooms.has(code) || this.samLoc?.rooms.has(code) || this.phom?.rooms.has(code) || this.bang?.rooms.has(code) });
    this.poker = new PokerManager(io, { storageFile: options.pokerStorageFile || pokerStorageFile(options.storageFile), storageDiagnostics: options.storageDiagnostics, graceMs: options.graceMs, profileForSocket, profileStore: this.profiles, onMatchCompleted, codeTaken: code => this.gang.rooms.has(code) || this.uno.rooms.has(code) || this.tienLen.rooms.has(code) || this.samLoc?.rooms.has(code) || this.phom?.rooms.has(code) || this.bang?.rooms.has(code) });
    this.samLoc = new SamLocManager(io, { storageFile: options.samLocStorageFile || samLocStorageFile(options.storageFile), storageDiagnostics: options.storageDiagnostics, graceMs: options.graceMs, profileForSocket, profileStore: this.profiles, onMatchCompleted, codeTaken: code => this.gang.rooms.has(code) || this.uno.rooms.has(code) || this.tienLen.rooms.has(code) || this.poker.rooms.has(code) || this.phom?.rooms.has(code) || this.bang?.rooms.has(code) });
    this.phom = new PhomManager(io, { storageFile: options.phomStorageFile || phomStorageFile(options.storageFile), storageDiagnostics: options.storageDiagnostics, graceMs: options.graceMs, profileForSocket, profileStore: this.profiles, onMatchCompleted, codeTaken: code => this.gang.rooms.has(code) || this.uno.rooms.has(code) || this.tienLen.rooms.has(code) || this.poker.rooms.has(code) || this.samLoc.rooms.has(code) || this.bang?.rooms.has(code) });
    this.bang = new BangManager(io, { profileStore: this.profiles, storageFile: options.bangStorageFile || bangStorageFile(options.storageFile), storageDiagnostics: options.storageDiagnostics, graceMs: options.graceMs, profileForSocket, onMatchCompleted, codeTaken: code => this.gang.rooms.has(code) || this.uno.rooms.has(code) || this.tienLen.rooms.has(code) || this.poker.rooms.has(code) || this.samLoc.rooms.has(code) || this.phom.rooms.has(code) });
    this.gameAdapterContracts = new Map();
    // Compatibility for the existing server/browser checks that inspect Gang rooms.
    this.rooms = this.gang.rooms;
    const adapter = this.roomService.adapterFor('uno');
    require('./turnClock').installTurnClock(this.gang, {
      getTurn: room => room.gameId === 'uno' && room.uno?.phase === 'PLAYING' ? {
        playerId: room.uno.pendingTargetId || room.uno.currentPlayerId,
        key: room.uno.openingColorPending ? 'color' : 'turn',
        paused: room.paused,
      } : null,
      timeoutAction: (room, player, socket) => adapter.timeoutTurn(room, player, socket),
    });
    this.installPreflightStateBuilders();
  }
  installPreflightStateBuilders() {
    for (const manager of new Set([this.gang, this.uno, this.tienLen, this.poker, this.samLoc, this.phom, this.bang])) {
      if (typeof manager?.buildStateFor !== 'function') continue;
      const buildState = manager.buildStateFor.bind(manager);
      manager.buildStateFor = (room, playerId, ...args) => {
        const state = buildState(room, playerId, ...args);
        if (!state || typeof state !== 'object') return state;
        let storageStatus = null;
        try { storageStatus = this.storageDiagnostics?.getStatus?.({ ignorePending: true }) || null; }
        catch { storageStatus = null; }
        let preflight;
        try {
          const player = room?.players?.find(item => item.id === playerId);
          preflight = buildRoomPreflight({ manager, roomCode: room?.code, viewerSeatId: playerId,
            viewerProfileId: player?.profileId || undefined, profileStore: this.profiles, storageStatus });
        } catch {
          preflight = unavailablePreflight(room, playerId);
        }
        return preflight ? { ...state, preflight } : state;
      };
    }
  }
  setStorageStatusRefresher(refresh) {
    this.storageStatusRefresher = typeof refresh === 'function' ? refresh : null;
  }
  preflightStorageGate(socket, manager, code) {
    const room = manager?.rooms?.get(code);
    const player = manager?.player?.(room, socket);
    if (!room || room.phase !== 'WAITING' || !player?.isHost || !WAGER_GAMES.has(room.gameId || this.gameIdForRoom(code))) return null;
    if (!this.storageDiagnostics) return null;
    let status;
    try {
      status = this.storageStatusRefresher
        ? this.storageStatusRefresher()
        : this.storageDiagnostics.getStatus({ ignorePending: true });
    } catch {
      return storageBlockMessage(null);
    }
    if (status?.canStartWager !== true) return storageBlockMessage(status);
    return null;
  }
  close() { this.roomService.close(); this.uno.close(); this.tienLen.close(); this.poker.close(); this.samLoc.close(); this.phom.close(); this.bang.close(); if (this.ownsProfileStore) this.profiles.close(); }
  error(socket, message) { socket.emit('game_error', { message }); return { error: message }; }
  managerForCode(code) { return this.gang.rooms.has(code) ? this.gang : this.uno.rooms.has(code) ? this.uno : this.tienLen.rooms.has(code) ? this.tienLen : this.poker.rooms.has(code) ? this.poker : this.samLoc.rooms.has(code) ? this.samLoc : this.phom.rooms.has(code) ? this.phom : this.bang.rooms.has(code) ? this.bang : null; }
  hasRoom(code) { return !!this.managerForCode(code); }
  gameIdForRoom(code) { return this.gang.rooms.has(code) ? this.gang.rooms.get(code).gameId || 'the-gang' : this.uno.rooms.has(code) ? 'uno' : this.tienLen.rooms.has(code) ? 'tien-len' : this.poker.rooms.has(code) ? 'poker' : this.samLoc.rooms.has(code) ? 'sam-loc' : this.phom.rooms.has(code) ? 'phom' : this.bang.rooms.has(code) ? 'bang' : null; }
  gameAdapterFor(gameId, variant) {
    const identity = resolveGameVariant(gameId, variant);
    const cacheKey = `${identity.gameId}:${identity.variant}`;
    if (this.gameAdapterContracts.has(cacheKey)) return this.gameAdapterContracts.get(cacheKey);
    const metadata = getGame(gameId);
    const contract = createGameAdapterContract({
      gameId: identity.gameId,
      variant: identity.variant,
      capabilities: metadata?.capabilities || {},
      create: ({ socket, request = {} }) => this.createRoom(socket, request.playerName,
        request.difficulty || request.modeId || 'ADVANCED', request.avatar, identity.gameId,
        { ...(request.config || {}), ...(identity.gameId === 'uno' ? { variant: identity.variant } : {}) }),
      join: ({ socket, request = {} }) => this.joinRoom(socket, request.roomCode, request.playerName, request.avatar, request.password),
      resume: ({ socket, request = {} }) => this.resumeRoom(socket, request.roomCode, request.sessionToken, { handoff: request.handoff === true }),
      action: ({ socket, envelope = {} }) => {
        const code = typeof envelope.roomCode === 'string' ? envelope.roomCode.trim().toUpperCase() : '';
        const manager = this.managerForCode(code);
        if (manager === this.gang) {
          if (this.gameIdForRoom(code) === 'uno') return this.roomService.handleGameAction(socket, { ...envelope, roomCode: code });
          return { ok: false, error: { code: 'GAME_ACTION_UNSUPPORTED', message: 'The Gang vẫn dùng các event thao tác lịch sử.' } };
        }
        return this.gameAction(socket, code, { ...envelope, roomCode: code });
      },
      result: ({ socket, roomCode }) => {
        const code = typeof roomCode === 'string' ? roomCode.trim().toUpperCase() : '';
        const manager = this.managerForCode(code), room = manager?.rooms.get(code);
        if (!room) return { ok: false, error: { code: 'ROOM_NOT_FOUND', message: 'Không tìm thấy phòng.' } };
        const player = manager.player(room, socket);
        if (!player) return { ok: false, error: { code: 'ROOM_ACCESS', message: 'Bạn không còn ở trong phòng này.' } };
        if (typeof manager.buildStateFor !== 'function') return { ok: false, error: { code: 'RESULT_UNAVAILABLE', message: 'Không thể đọc kết quả phòng này.' } };
        return manager.buildStateFor(room, player.id);
      },
    });
    this.gameAdapterContracts.set(cacheKey, contract);
    return contract;
  }
  gameAdapterForRoom(code) {
    const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const gameId = this.gameIdForRoom(normalizedCode);
    if (!gameId) throw Object.assign(new Error('Không tìm thấy phòng.'), { code: 'ROOM_NOT_FOUND' });
    const manager = this.managerForCode(normalizedCode);
    const room = manager?.rooms.get(normalizedCode);
    const variant = gameId === 'uno'
      ? (room?.variant || room?.config?.variant || (manager === this.uno ? 'classic-108-v1' : 'classic-local-v1'))
      : 'standard';
    return this.gameAdapterFor(gameId, variant);
  }
  profilePayload(socket, includeSecrets = false) {
    const profile = socket.data.profile;
    if (!profile) return null;
    const state = this.profiles.profileState(profile.id);
    const payload = { profile: state };
    if (socket.data.profileToken) payload.profileToken = socket.data.profileToken;
    if (includeSecrets && socket.data.recoveryCode) payload.recoveryCode = socket.data.recoveryCode;
    return payload;
  }
  setSocketProfile(socket, profile, sessionToken, recoveryCode) {
    socket.data.profile = profile;
    if (sessionToken) socket.data.profileToken = sessionToken;
    if (recoveryCode) socket.data.recoveryCode = recoveryCode;
    return this.profilePayload(socket, Boolean(recoveryCode));
  }
  authenticateProfile(socket, sessionToken) {
    const profile = this.profiles.authenticate(sessionToken);
    if (!profile) return { error: 'Phiên hồ sơ đã hết hạn. Hãy dùng mã khôi phục hoặc tạo hồ sơ mới.' };
    return this.setSocketProfile(socket, profile, sessionToken);
  }
  bootstrapProfile(socket, name, avatar) {
    if (socket.data.profile) {
      const profile = this.profiles.updateProfile(socket.data.profile.id, { displayName: name, avatar });
      socket.data.profile = profile;
      return this.profilePayload(socket);
    }
    const created = this.profiles.createProfile({ displayName: name, avatar });
    return this.setSocketProfile(socket, created.profile, created.sessionToken, created.recoveryCode);
  }
  updateProfile(socket, name, avatar) {
    if (!socket.data.profile) return { error: 'Hãy tạo hoặc khôi phục hồ sơ trước.' };
    socket.data.profile = this.profiles.updateProfile(socket.data.profile.id, { displayName: name, avatar });
    return this.profilePayload(socket);
  }
  recoverProfile(socket, profileId, recoveryCode) {
    try {
      const recovered = this.profiles.recoverProfile(profileId, recoveryCode);
      return this.setSocketProfile(socket, recovered.profile, recovered.sessionToken);
    } catch (error) { return { error: error.message }; }
  }
  claimMission(socket, missionId, version) {
    if (!socket.data.profile) return { error: 'Hãy tạo hoặc khôi phục hồ sơ trước.' };
    try {
      this.profiles.claimMission(socket.data.profile.id, missionId, version);
      return this.profilePayload(socket);
    } catch (error) { return { error: error.message }; }
  }
  adoptProfileFromSeatToken(socket, code, token) {
    if (socket.data.profile || typeof token !== 'string') return;
    const player = this.managerForCode(code)?.rooms.get(code)?.players.find(item => item.token === token);
    if (!player?.profileId) return;
    const profile = this.profiles.publicProfile(player.profileId);
    if (profile) socket.data.profile = profile;
  }
  syncRoom(code) {
    const manager = this.managerForCode(code);
    if (!manager) return;
    this.profiles.syncRoom({ room: manager.rooms.get(code), gameId: this.gameIdForRoom(code) });
    if (manager.stateSnapshotKey) this.profiles.saveGameSnapshot({ gameId: manager.stateSnapshotKey(manager.rooms.get(code)), room: manager.rooms.get(code) });
  }
  withProfile(result, socket, includeSecrets = false) {
    if (!result || result.error) return result;
    const metadata = this.publicRoom(result.roomCode);
    return { ...result, gameId: metadata?.gameId, variant: metadata?.variant, entryPath: metadata?.entryPath, ...this.profilePayload(socket, includeSecrets) };
  }
  createRoom(socket, name, modeId, avatar, requestedGameId, config = {}) {
    if ([this.gang, this.uno, this.tienLen, this.poker, this.samLoc, this.phom, this.bang].some(manager => manager.playerRoom.has(socket.id))) return { error: 'Hãy rời phòng hiện tại trước khi tạo phòng mới.' };
    const gameId = requestedGameId || 'the-gang'; const game = getGame(gameId);
    if (!game || game.status !== 'playable') return { error: 'Game này chưa sẵn sàng để tạo phòng.' };
    let normalizedConfig;
    try { normalizedConfig = validateRoomConfig(gameId, { ...config, variant: gameId === 'uno' ? config.variant || 'classic-108-v1' : config.variant }); } catch (error) { return { error: error.message }; }
    const identity = this.bootstrapProfile(socket, name, avatar);
    if (identity.error) return identity;
    const result = gameId === 'uno' && config.variant === 'classic-local-v1' ? this.roomService.createRoom(socket, { gameId, playerName: name, avatar, difficulty: modeId, profileToken: socket.data.profileToken, config })
      : gameId === 'uno' ? this.uno.createRoom(socket, name, avatar) : gameId === 'tien-len' ? this.tienLen.createRoom(socket, name, avatar, normalizedConfig) : gameId === 'poker' ? this.poker.createRoom(socket, name, avatar) : gameId === 'sam-loc' ? this.samLoc.createRoom(socket, name, avatar, normalizedConfig) : gameId === 'phom' ? this.phom.createRoom(socket, name, avatar, normalizedConfig) : gameId === 'bang' ? this.bang.createRoom(socket, name, avatar)
      : this.roomService.createRoom(socket, { gameId, playerName: name, avatar, difficulty: modeId, profileToken: socket.data.profileToken, config });
    if (!result?.error) {
      const manager = this.managerForCode(result.roomCode);
      if (manager !== this.gang) manager.rooms.get(result.roomCode).config = { ...normalizedConfig, password: undefined, passwordHash: passwordHash(normalizedConfig.password) };
      this.syncRoom(result.roomCode);
    }
    return this.withProfile(result, socket, true);
  }
  joinRoom(socket, code, name, avatar, password) {
    if ([this.gang, this.uno, this.tienLen, this.poker, this.samLoc, this.phom, this.bang].some(manager => manager.playerRoom.has(socket.id))) return { error: 'Bạn đang ở trong một phòng khác.' };
    const manager = this.managerForCode(code); if (!manager) return { error: 'Không tìm thấy phòng.' };
    const room = manager.rooms.get(code);
    if (manager !== this.gang && !verifyPassword(password, room.config?.passwordHash)) return { error: 'Mật khẩu phòng không đúng.' };
    if (room.config?.maxPlayers && room.players.length >= room.config.maxPlayers) return { error: `Phòng đã đủ ${room.config.maxPlayers} người.` };
    const identity = this.bootstrapProfile(socket, name, avatar); if (identity.error) return identity;
    const result = manager === this.gang ? this.roomService.joinRoom(socket, { roomCode: code, playerName: name, avatar, password, profileToken: socket.data.profileToken }) : manager.joinRoom(socket, code, name, avatar); if (!result?.error) this.syncRoom(code);
    return this.withProfile(result, socket, true);
  }
  resumeRoom(socket, code, token, options = {}) {
    if ([this.gang, this.uno, this.tienLen, this.poker, this.samLoc, this.phom, this.bang].some(manager => manager.playerRoom.has(socket.id) && manager.playerRoom.get(socket.id) !== code)) return { error: 'Hãy rời phòng hiện tại trước khi khôi phục phòng khác.' };
    const manager = this.managerForCode(code); if (!manager) return { error: 'Phiên chơi đã hết hạn hoặc phòng không còn tồn tại.' };
    // Old room tokens remain a valid recovery capability.  New clients retain
    // the profile token too, so a copied nickname/player id grants nothing.
    this.adoptProfileFromSeatToken(socket, code, token);
    // A navigation handoff proves ownership with the existing seat capability.
    // Ordinary reconnects still reject a seat active in another browser tab.
    if (options.handoff === true) {
      const digest = typeof token === 'string' ? require('node:crypto').createHash('sha256').update(token).digest('hex') : null;
      const seat = manager.rooms.get(code)?.players.find(player => typeof token === 'string' && (player.token === token || (digest && player.tokenHash === digest)));
      if (seat && (!seat.profileId || seat.profileId === socket.data.profile?.id) && seat.socketId !== socket.id) {
        const old = this.io.sockets.sockets.get(seat.socketId);
        manager.playerRoom.delete(seat.socketId);
        if (old) { old.leave(code); old.emit('seat_transferred', { roomCode: code }); }
        seat.socketId = null; seat.connected = false;
      }
    }
    const result = manager === this.gang ? this.roomService.resumeRoom(socket, { roomCode: code, sessionToken: token, profileToken: socket.data.profileToken }) : manager.resumeRoom(socket, code, token);
    if (!result?.error) { if (result.profileToken) this.authenticateProfile(socket, result.profileToken); this.syncRoom(code); }
    return this.withProfile(result, socket);
  }
  setReady(socket, code, ready) { const manager = this.managerForCode(code); if (!manager) return this.error(socket, 'Không tìm thấy phòng.'); const result = manager.setReady(socket, code, ready); this.syncRoom(code); return result; }
  startGame(socket, code) {
    const manager = this.managerForCode(code);
    if (!manager) return this.error(socket, 'Không tìm thấy phòng.');
    const blocked = this.preflightStorageGate(socket, manager, code);
    if (blocked) { const result = manager.error(socket, blocked); this.syncRoom(code); return result; }
    const result = manager === this.gang ? this.roomService.startGame(socket, code) : manager.startGame(socket, code);
    this.syncRoom(code);
    return result;
  }
  leaveRoom(socket, code) {
    const manager = this.managerForCode(code); if (!manager) return this.error(socket, 'Không tìm thấy phòng.');
    const player = manager.player(manager.rooms.get(code), socket), gameId = this.gameIdForRoom(code);
    const result = manager === this.gang && gameId === 'uno'
      ? this.roomService.adapterFor('uno').leaveRoom(socket, code) : manager.leaveRoom(socket, code);
    if (manager.rooms.has(code)) this.syncRoom(code);
    else this.profiles.markMemberLeft({ gameId, roomCode: code, playerId: player?.id });
    return result;
  }
  syncState(socket, code) { const manager = this.managerForCode(code); if (manager === this.gang) { const result = this.roomService.requestGameState(socket, code); if (result.ok) socket.emit('game_state', result.state); return result; } return manager?.syncState ? manager.syncState(socket, code) : this.error(socket, 'Không tìm thấy phòng.'); }
  gameAction(socket, code, data) { const manager = this.managerForCode(code); if (manager !== this.uno && manager !== this.tienLen && manager !== this.poker && manager !== this.samLoc && manager !== this.phom && manager !== this.bang) return this.error(socket, 'Hành động này không thuộc game hiện tại.'); const result = manager.action(socket, code, data); this.syncRoom(code); return result; }
  handleDisconnect(socket) { this.gang.handleDisconnect(socket); this.uno.handleDisconnect(socket); this.tienLen.handleDisconnect(socket); this.poker.handleDisconnect(socket); this.samLoc.handleDisconnect(socket); this.phom.handleDisconnect(socket); this.bang.handleDisconnect(socket); }
  startHeist(room) { return this.gang.startHeist(room); }
  flush() { return this.gang.flush(); }
  publicRooms() {
    const rooms = this.roomService.publicRooms();
    for (const manager of [this.uno, this.tienLen, this.poker, this.samLoc, this.phom, this.bang]) for (const room of manager.rooms.values()) {
      if (room.config?.visibility === 'public' && room.phase === 'WAITING') rooms.push(this.publicRoom(room.code));
    }
    return rooms;
  }
  publicRoom(code) {
    const manager = this.managerForCode(code), room = manager?.rooms.get(code), game = getGame(this.gameIdForRoom(code));
    if (!room || !game) return null;
    if (manager === this.gang) return this.gang.publicRoom(room);
    return { roomCode: code, gameId: game.id, category: game.category, roomName: room.config?.roomName || `${game.name} · Phòng LAN`,
      phase: room.phase, stake: room.stake, maxLoss: room.maxLoss, currency: game.currency, maxPlayers: room.config?.maxPlayers || game.maxPlayers, players: room.players.length, visibility: room.config?.visibility || 'invite', requiresPassword: Boolean(room.config?.passwordHash),
      variant: game.id === 'uno' ? 'classic-108-v1' : 'standard', entryPath: `/${game.id}` };
  }
  broadcast(code) { const manager = this.managerForCode(code); return manager?.broadcast(code); }
  gangAction(method, socket, code, ...args) {
    const manager = this.managerForCode(code);
    if (manager !== this.gang || typeof this.gang[method] !== 'function') return this.error(socket, 'Thao tác không thuộc game hiện tại.');
    const result = this.gameIdForRoom(code) === 'uno' && ['playAgain', 'returnToLobby'].includes(method)
      ? this.roomService[method](socket, code) : this.gang[method](socket, code, ...args); this.syncRoom(code); return result;
  }
}

module.exports = { MultiGameManager, unoStorageFile, tienLenStorageFile, pokerStorageFile, samLocStorageFile, phomStorageFile, bangStorageFile };
