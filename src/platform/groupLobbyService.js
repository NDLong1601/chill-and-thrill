'use strict';

const crypto = require('node:crypto');
const { GAME_VARIANT_TARGETS, resolveGameVariant } = require('./gameAdapterContract');
const { getGame, validateRoomConfig } = require('./gameRegistry');

const DEFAULTS = Object.freeze({
  memberLeaseMs: 60_000,
  idleExpiryMs: 30 * 60_000,
  absoluteExpiryMs: 6 * 60 * 60_000,
  proposalExpiryMs: 3 * 60_000,
  maxMembers: 12,
  sweepIntervalMs: 15_000,
});

class GroupLobbyError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'GroupLobbyError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function randomCapability() { return crypto.randomBytes(32).toString('base64url'); }
function digest(value) { return crypto.createHash('sha256').update(value).digest(); }
function matchesHash(capability, storedHex) {
  if (typeof capability !== 'string' || typeof storedHex !== 'string' || !/^[a-f0-9]{64}$/i.test(storedHex)) return false;
  const actual = digest(capability), expected = Buffer.from(storedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function normalizeProfile(profile) {
  const id = profile?.id || profile?.playerId;
  const name = profile?.name || profile?.displayName;
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name.trim()) {
    throw new GroupLobbyError('PROFILE_REQUIRED', 'Hãy đăng nhập hồ sơ người chơi trước.', 401);
  }
  return { id, name: name.trim().slice(0, 32), avatar: typeof profile.avatar === 'string' ? profile.avatar.slice(0, 16) : '🕶️' };
}
function adapterKey(gameId, variant) { return `${gameId}:${variant}`; }
function targetAdaptersFromManager({ gameManager, socketForProfile }) {
  if (!gameManager || typeof socketForProfile !== 'function') return {};
  const targetOperations = new Map();
  const adapters = {};
  for (const [gameId, variants] of Object.entries(GAME_VARIANT_TARGETS)) {
    for (const variant of Object.keys(variants)) {
      const identity = resolveGameVariant(gameId, variant);
      adapters[adapterKey(gameId, variant)] = {
        identity,
        validateConfig(input, { memberCount }) {
          const game = getGame(gameId);
          if (!game) throw Object.assign(new Error('Game không tồn tại.'), { code: 'GAME_NOT_FOUND' });
          if (memberCount < game.minPlayers) throw Object.assign(new Error(`Game cần ít nhất ${game.minPlayers} người.`), { code: 'GROUP_TOO_SMALL' });
          const config = validateRoomConfig(gameId, { ...input, variant, visibility: 'invite', password: '' });
          if (memberCount > config.maxPlayers) throw Object.assign(new Error(`Nhóm có ${memberCount} người nhưng cấu hình chỉ cho ${config.maxPlayers} ghế.`), { code: 'GROUP_OVER_CAPACITY' });
          return config;
        },
        createTarget({ operationId, host, target }) {
          const operationKey = `group:${operationId}`;
          const previous = targetOperations.get(operationKey);
          if (previous) return { roomCode: previous };
          const socket = trustedSocket(socketForProfile, host);
          const result = gameManager.gameAdapterFor(gameId, variant).create({ socket, request: {
            gameId, variant, playerName: host.name, avatar: host.avatar, difficulty: 'ADVANCED',
            config: { ...target.config, variant, visibility: 'invite', password: '' },
          } }).legacy;
          if (result?.error || !result?.roomCode || !result?.sessionToken) {
            throw Object.assign(new Error(result?.error || 'Không thể tạo bàn đích.'), { code: 'TARGET_CREATE_FAILED' });
          }
          // This in-process operation journal lives with the in-memory group service.
          // The room itself is also looked up by profile on retries below.
          targetOperations.set(operationKey, result.roomCode);
          return { roomCode: result.roomCode };
        },
        ensureSeat({ operationId, roomCode, member, target }) {
          const manager = gameManager.managerForCode(roomCode);
          const room = manager?.rooms.get(roomCode);
          const roomVariant = room?.variant || room?.config?.variant ||
            (gameId === 'uno' && manager === gameManager.uno ? 'classic-108-v1' : 'standard');
          if (!manager || !room || (room.gameId || 'the-gang') !== gameId || roomVariant !== variant) {
            throw Object.assign(new Error('Bàn đích không còn tồn tại hoặc không khớp game/variant.'), { code: 'TARGET_ROOM_MISMATCH' });
          }
          let player = room.players.find(item => item.profileId === member.id);
          if (!player) {
            const socket = trustedSocket(socketForProfile, member);
            if (room.players.length >= target.config.maxPlayers) throw Object.assign(new Error('Bàn đích đã đủ ghế.'), { code: 'TARGET_CAPACITY' });
            const result = gameManager.gameAdapterForRoom(roomCode).join({ socket, request: {
              roomCode, playerName: member.name, avatar: member.avatar, password: '',
            } }).legacy;
            if (result?.error || !result?.sessionToken) throw Object.assign(new Error(result?.error || 'Không thể thêm thành viên vào bàn đích.'), { code: 'TARGET_JOIN_FAILED' });
            player = room.players.find(item => item.profileId === member.id);
            if (!player) throw Object.assign(new Error('Manager không xác nhận được ghế vừa tạo.'), { code: 'TARGET_SEAT_UNVERIFIED' });
          }
          const current = player.token;
          if (typeof current !== 'string' || !current) throw Object.assign(new Error('Không lấy được thông tin khôi phục ghế.'), { code: 'TARGET_CREDENTIAL_UNAVAILABLE' });
          return {
            roomCode,
            playerId: player.id,
            sessionToken: current,
            gameId,
            variant,
            entryPath: identity.entryPath,
          };
        },
        getRoomBinding({ roomCode }) {
          const manager = gameManager.managerForCode(roomCode);
          const room = manager?.rooms.get(roomCode);
          const roomVariant = room?.variant || room?.config?.variant ||
            (gameId === 'uno' && manager === gameManager.uno ? 'classic-108-v1' : 'standard');
          if (!room || (room.gameId || 'the-gang') !== gameId || roomVariant !== variant) return null;
          return {
            roomCode,
            gameId,
            variant,
            matchId: typeof room.matchId === 'string' ? room.matchId : null,
            participants: room.players.map(player => player.profileId).filter(profileId => typeof profileId === 'string'),
            phase: String(room.phase || 'UNKNOWN'),
            terminalStatus: ['RESULT', 'GAME_OVER', 'CANCELLED'].includes(room.phase) ? room.phase : null,
          };
        },
        async releaseSeatForHandoff({ roomCode, member }) {
          const manager = gameManager.managerForCode(roomCode);
          const room = manager?.rooms.get(roomCode);
          const player = room?.players.find(item => item.profileId === member.id);
          if (!manager || !room || !player) throw Object.assign(new Error('Không tìm thấy ghế bàn đích để bàn giao.'), { code: 'TARGET_SEAT_UNAVAILABLE' });
          if (!player.connected) return { ok: true, alreadyDisconnected: true };
          const socket = gameManager.io?.sockets?.sockets?.get?.(player.socketId);
          if (!socket || socket.connected === false) throw Object.assign(new Error('Kết nối ghế bàn đích đã đóng trước khi bàn giao.'), { code: 'TARGET_SOCKET_UNAVAILABLE' });
          manager.handleDisconnect(socket);
          try { await socket.leave(roomCode); } catch { /* The disconnect lifecycle already removed the game seat binding. */ }
          return { ok: true };
        },
      };
    }
  }
  return adapters;
}

function trustedSocket(socketForProfile, profile) {
  const socket = socketForProfile(profile.id);
  if (!socket || socket.connected === false || socket.data?.profile?.id !== profile.id) {
    throw Object.assign(new Error(`${profile.name} cần kết nối lại bằng đúng hồ sơ trước khi đổi game.`), { code: 'PROFILE_SOCKET_UNAVAILABLE' });
  }
  return socket;
}

function managersOf(gameManager) {
  return [gameManager.gang, gameManager.uno, gameManager.tienLen, gameManager.poker,
    gameManager.samLoc, gameManager.phom, gameManager.bang].filter(Boolean);
}

function reservationsFor(profileStore, profileId) {
  if (!profileStore?.db?.prepare) throw Object.assign(new Error('Không thể đọc khoản giữ từ ProfileStore.'), { code: 'LEDGER_UNAVAILABLE' });
  return profileStore.db.prepare("SELECT id AS reservationId, room_code AS roomCode, match_id AS matchId, currency, amount FROM reservations WHERE profile_id = ? AND status = 'HELD'").all(profileId);
}

function managerSwitchLifecycle({ gameManager, socketForProfile }) {
  if (!gameManager || typeof socketForProfile !== 'function') return {};
  function roomsFor(profileId) {
    const found = [];
    for (const manager of managersOf(gameManager)) {
      for (const room of manager.rooms.values()) {
        const player = room.players?.find(item => item.profileId === profileId);
        if (player) found.push({ manager, room, player });
      }
    }
    return found;
  }
  return {
    isTargetRoomActive({ roomCode, profileIds }) {
      const room = gameManager.managerForCode(roomCode)?.rooms.get(roomCode);
      return room?.players?.some(player => profileIds.includes(player.profileId) && player.connected &&
        gameManager.io?.sockets?.sockets?.get(player.socketId)?.connected === true) === true;
    },
    async canPrepareMemberForSwitch(profile) {
      try { trustedSocket(socketForProfile, profile); }
      catch { return { ok: false, code: 'PROFILE_SOCKET_UNAVAILABLE', message: `${profile.name} cần kết nối lại bằng đúng hồ sơ trước khi chuyển.` }; }
      const found = roomsFor(profile.id);
      if (found.length > 1) return { ok: false, code: 'MULTIPLE_ACTIVE_ROOMS', message: 'Hồ sơ đang có nhiều ghế đang mở; cần kiểm tra trước khi đổi game.' };
      const held = reservationsFor(gameManager.profiles, profile.id);
      if (!found.length) return held.length ? { ok: false, code: 'OPEN_HOLD', message: 'Hồ sơ còn khoản cược đang giữ.' } : { ok: true };
      const { room, player } = found[0];
      const gameId = room.gameId || 'the-gang';
      if (!['WAITING', 'RESULT', 'GAME_OVER', 'CANCELLED'].includes(room.phase)) {
        return { ok: false, code: 'MATCH_ACTIVE', message: 'Hãy kết thúc ván hiện tại trước khi đổi game.' };
      }
      if (gameId === 'poker') {
        const seatHolds = held.filter(item => item.roomCode === room.code && item.currency === 'chip');
        if (held.some(item => !seatHolds.includes(item))) return { ok: false, code: 'OPEN_HOLD', message: 'Hồ sơ còn khoản giữ ngoài stack Poker hiện tại.' };
        const seatReservationIds = [...(player.reservations || [])].map(item => item.reservationId).sort();
        const ledgerReservationIds = seatHolds.map(item => item.reservationId).sort();
        if (seatReservationIds.some(id => !id) || seatReservationIds.length !== ledgerReservationIds.length ||
            seatReservationIds.some((id, index) => id !== ledgerReservationIds[index]) ||
            (player.stack > 0 && seatReservationIds.length === 0)) {
          return { ok: false, code: 'POKER_HOLD_MISMATCH', message: 'Không khớp được stack Poker với khoản giữ trong ví; chưa cash-out hoặc chuyển game.' };
        }
        return { ok: true, requiresCashout: Boolean(found[0].player.stack || found[0].player.reservations?.length || seatHolds.length) };
      }
      if (held.length) return { ok: false, code: 'OPEN_HOLD', message: 'Cược cũ chưa được thanh toán; đổi game đã bị chặn.' };
      return { ok: true };
    },
    async prepareMemberForSwitch(profile) {
      const found = roomsFor(profile.id);
      if (!found.length) {
        if (reservationsFor(gameManager.profiles, profile.id).length) return { ok: false, code: 'OPEN_HOLD', message: 'Hồ sơ còn khoản cược đang giữ.' };
        return { ok: true };
      }
      if (found.length !== 1) return { ok: false, code: 'MULTIPLE_ACTIVE_ROOMS', message: 'Không thể chọn an toàn ghế cũ để rời.' };
      const { manager, room, player } = found[0];
      if (!['WAITING', 'RESULT', 'GAME_OVER', 'CANCELLED'].includes(room.phase)) return { ok: false, code: 'MATCH_ACTIVE', message: 'Ván hiện tại chưa kết thúc; không rời bàn và không hoàn cược cưỡng bức.' };
      const held = reservationsFor(gameManager.profiles, profile.id);
      const gameId = room.gameId || 'the-gang';
      if (gameId !== 'poker' && held.length) return { ok: false, code: 'OPEN_HOLD', message: 'Cược cũ chưa được thanh toán; không thể đổi game.' };
      if (gameId === 'poker') {
        const seatHolds = held.filter(item => item.roomCode === room.code && item.currency === 'chip');
        const seatReservationIds = [...(player.reservations || [])].map(item => item.reservationId).sort();
        const ledgerReservationIds = seatHolds.map(item => item.reservationId).sort();
        if (held.length !== seatHolds.length || seatReservationIds.some(id => !id) ||
            seatReservationIds.length !== ledgerReservationIds.length ||
            seatReservationIds.some((id, index) => id !== ledgerReservationIds[index]) ||
            (player.stack > 0 && seatReservationIds.length === 0)) {
          return { ok: false, code: 'POKER_HOLD_MISMATCH', message: 'Không khớp được stack Poker với khoản giữ trong ví; chưa cash-out hoặc chuyển game.' };
        }
      }
      const socket = trustedSocket(socketForProfile, profile);
      if (!player.connected || player.socketId !== socket.id) {
        // Returning from a game creates a new lobby socket. Authenticate the
        // old seat through the normal resume contract before asking it to leave.
        const resumed = gameManager.gameAdapterForRoom(room.code).resume({ socket, request: {
          roomCode: room.code, sessionToken: player.token,
        } }).legacy;
        if (resumed?.error || resumed?.playerId !== player.id) {
          return { ok: false, code: 'OLD_ROOM_RESUME_FAILED', message: 'Chưa thể khôi phục ghế cũ an toàn để chuyển game.' };
        }
      }
      const result = await gameManager.leaveRoom(socket, room.code);
      if (result?.error || result?.queued) return { ok: false, code: 'OLD_ROOM_LEAVE_FAILED', message: 'Chưa thể rời bàn cũ an toàn.' };
      if (gameId === 'poker' && (player.stack !== 0 || player.reservations?.length)) {
        // leaveRoom performs PokerManager.cashOutAndRemove through ProfileStore's
        // existing idempotent poker:cashout operation; this check verifies closure.
        if (gameManager.managerForCode(room.code)?.rooms.get(room.code)?.players.some(item => item.profileId === profile.id)) {
          return { ok: false, code: 'POKER_CASHOUT_INCOMPLETE', message: 'Stack Poker chưa cash-out xong.' };
        }
      }
      if (reservationsFor(gameManager.profiles, profile.id).length) return { ok: false, code: 'OPEN_HOLD', message: 'Còn khoản giữ mở sau khi rời bàn; không tạo bàn mới.' };
      return { ok: true };
    },
  };
}

class GroupLobbyService {
  constructor(options = {}) {
    this.clock = typeof options.clock === 'function' ? options.clock : Date.now;
    this.options = { ...DEFAULTS, ...options.limits };
    this.adapters = options.targetAdapters || {};
    this.canPrepareMemberForSwitch = options.canPrepareMemberForSwitch;
    this.prepareMemberForSwitch = options.prepareMemberForSwitch;
    this.isTargetRoomActive = options.isTargetRoomActive;
    this.membershipLocked = typeof options.membershipLocked === 'function' ? options.membershipLocked : null;
    this.authorizeTarget = options.authorizeTarget;
    this.bindTargetRoom = options.bindTargetRoom;
    this.groups = new Map();
    this.profileGroups = new Map();
    this.closed = false;
    this.sweepTimer = setInterval(() => { void this.sweep(); }, this.options.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  close() { this.closed = true; clearInterval(this.sweepTimer); }

  setMembershipLockChecker(check) { this.membershipLocked = typeof check === 'function' ? check : null; }
  setTargetAuthorizer(authorize) { this.authorizeTarget = typeof authorize === 'function' ? authorize : null; }
  setTargetBindingHandler(bind) { this.bindTargetRoom = typeof bind === 'function' ? bind : null; }

  async sweep() {
    if (this.closed) return;
    for (const group of this.groups.values()) await this.withLock(group, () => this.sweepGroup(group));
  }

  async withLock(group, work) {
    const previous = group.lock;
    let unlock;
    group.lock = new Promise(resolve => { unlock = resolve; });
    await previous;
    try { return await work(); }
    finally { unlock(); }
  }

  async assertMembershipMutable(group) {
    if (typeof this.membershipLocked !== 'function') return;
    const snapshot = await this.membershipLocked(group.id);
    if (snapshot === true || snapshot?.locked === true) {
      throw new GroupLobbyError(snapshot?.code || 'GROUP_MEMBERSHIP_LOCKED', snapshot?.message || 'Danh sách nhóm đang được dùng trong giải đấu và chưa thể thay đổi.', 409);
    }
  }

  makeGroupId() { return crypto.randomBytes(16).toString('base64url'); }
  now() { return this.clock(); }

  newMember(profile, host) {
    const capability = randomCapability();
    const at = this.now();
    return { capability, member: { id: profile.id, memberKey: crypto.randomUUID(), name: profile.name, avatar: profile.avatar,
      host, connected: true, joinedAt: at, lastSeenAt: at, capabilityHash: digest(capability).toString('hex') } };
  }

  assertProfileAvailable(profileId) {
    const groupId = this.profileGroups.get(profileId);
    const existing = groupId && this.groups.get(groupId);
    if (existing && existing.expiresAt > this.now()) throw new GroupLobbyError('ALREADY_IN_GROUP', 'Hãy rời sảnh nhóm hiện tại trước khi tham gia nhóm khác.', 409);
    if (groupId) this.profileGroups.delete(profileId);
  }

  async createGroup(trustedProfile) {
    const profile = normalizeProfile(trustedProfile);
    this.assertProfileAvailable(profile.id);
    const { capability, member } = this.newMember(profile, true);
    const inviteCapability = randomCapability();
    const at = this.now(), id = this.makeGroupId();
    const group = { id, createdAt: at, lastActivityAt: at, expiresAt: at + this.options.absoluteExpiryMs,
      revision: 1, membershipRevision: 1, hostProfileId: profile.id, members: new Map([[profile.id, member]]),
      inviteHash: digest(inviteCapability).toString('hex'), proposal: null, transition: null, currentTargetRoomCode: null,
      lock: Promise.resolve() };
    this.groups.set(id, group); this.profileGroups.set(profile.id, id);
    return { groupId: id, groupCapability: capability, inviteCapability, group: this.publicGroup(group, profile.id) };
  }

  findByInvite(inviteCapability) {
    if (typeof inviteCapability !== 'string' || inviteCapability.length < 32) return null;
    for (const group of this.groups.values()) if (matchesHash(inviteCapability, group.inviteHash)) return group;
    return null;
  }

  async joinGroup(trustedProfile, inviteCapability) {
    const profile = normalizeProfile(trustedProfile);
    const initial = this.findByInvite(inviteCapability);
    if (!initial) throw new GroupLobbyError('INVITE_INVALID', 'Mã mời nhóm không hợp lệ hoặc đã hết hạn.', 404);
    return this.withLock(initial, async () => {
      this.sweepGroup(initial);
      if (!this.groups.has(initial.id) || !matchesHash(inviteCapability, initial.inviteHash)) throw new GroupLobbyError('INVITE_INVALID', 'Mã mời nhóm không hợp lệ hoặc đã hết hạn.', 404);
      if (initial.transition && initial.transition.status !== 'complete') throw new GroupLobbyError('SWITCH_RECOVERY_REQUIRED', 'Khôi phục lượt chuyển bàn hiện tại trước khi đổi thành viên.', 409);
      const existing = initial.members.get(profile.id);
      if (!existing) {
        await this.assertMembershipMutable(initial);
        if (initial.transition?.status === 'complete') throw new GroupLobbyError('GROUP_ALREADY_TRANSFERRED', 'Nhóm đã chuyển sang bàn mới; hãy mời thành viên vào bàn bằng luồng của game.', 409);
        this.assertProfileAvailable(profile.id);
        if (initial.members.size >= this.options.maxMembers) throw new GroupLobbyError('GROUP_FULL', 'Sảnh nhóm đã đủ người.', 409);
        const created = this.newMember(profile, false);
        initial.members.set(profile.id, created.member); this.profileGroups.set(profile.id, initial.id);
        this.noteGroupChange(initial, 'membership_changed', true);
        initial.lastActivityAt = this.now();
        return { groupId: initial.id, groupCapability: created.capability, group: this.publicGroup(initial, profile.id) };
      }
      this.markConnected(initial, existing);
      const capability = randomCapability(); existing.capabilityHash = digest(capability).toString('hex');
      initial.lastActivityAt = this.now();
      return { groupId: initial.id, groupCapability: capability, group: this.publicGroup(initial, profile.id) };
    });
  }

  async rotateInvite(trustedProfile, groupId, groupCapability) {
    const { group, member } = this.authenticate(groupId, trustedProfile, groupCapability);
    return this.withLock(group, () => {
      this.sweepGroup(group); this.markConnected(group, member);
      if (!member.host) throw new GroupLobbyError('HOST_ONLY', 'Chỉ host mới có thể tạo mã mời mới.', 403);
      const inviteCapability = randomCapability(); group.inviteHash = digest(inviteCapability).toString('hex');
      group.lastActivityAt = this.now();
      return { inviteCapability, group: this.publicGroup(group, member.id) };
    });
  }

  authenticate(groupId, trustedProfile, groupCapability) {
    const profile = normalizeProfile(trustedProfile);
    const group = this.groups.get(groupId);
    if (!group) throw new GroupLobbyError('GROUP_NOT_FOUND', 'Không tìm thấy sảnh nhóm hoặc sảnh đã hết hạn.', 404);
    const member = group.members.get(profile.id);
    if (!member || !matchesHash(groupCapability, member.capabilityHash)) {
      throw new GroupLobbyError('GROUP_FORBIDDEN', 'Phiên thành viên nhóm không hợp lệ.', 403);
    }
    return { group, member, profile };
  }

  markConnected(group, member) {
    if (!member.connected) {
      member.connected = true;
      this.noteGroupChange(group, 'member_reconnected');
    }
    member.lastSeenAt = this.now();
    group.lastActivityAt = this.now();
  }

  noteGroupChange(group, reason, membershipChanged = false) {
    group.revision++;
    if (membershipChanged) group.membershipRevision++;
    const proposal = group.proposal;
    if (!proposal || ['complete', 'expired', 'stale'].includes(proposal.status)) return;
    proposal.staleReason = reason;
    proposal.confirmations.clear();
    const transition = group.transition;
    const partial = transition && transition.status !== 'complete' &&
      (transition.roomCode || transition.prepared.size || transition.seats.size);
    if (partial) {
      // Keep the exact target bound to its stable operation ID, but require fresh
      // member consent at the new group revision before resuming partial work.
      proposal.status = 'pending'; proposal.revision = group.revision;
      proposal.expiresAt = this.now() + this.options.proposalExpiryMs;
      transition.status = 'partial';
    } else {
      proposal.status = 'stale';
      if (transition) group.transition = null;
    }
  }

  sweepGroup(group) {
    const now = this.now();
    if (now >= group.expiresAt) {
      this.expireGroup(group); return;
    }
    // Lobby heartbeats stop when members navigate to a game. A live seat in
    // their bound room still counts as group activity; unrelated rooms do not.
    const roomCodes = new Set([group.currentTargetRoomCode, group.transition?.roomCode].filter(Boolean));
    const profileIds = [...group.members.keys()];
    if (typeof this.isTargetRoomActive === 'function' && [...roomCodes].some(roomCode =>
      this.isTargetRoomActive({ roomCode, profileIds }) === true)) group.lastActivityAt = now;
    if (now - group.lastActivityAt >= this.options.idleExpiryMs) {
      this.expireGroup(group); return;
    }
    if (group.proposal?.status === 'pending' && now >= group.proposal.expiresAt) {
      const transition = group.transition;
      const partial = transition && transition.status !== 'complete' &&
        (transition.roomCode || transition.prepared.size || transition.seats.size);
      if (partial) {
        group.proposal.confirmations.clear(); group.revision++;
        group.proposal.revision = group.revision; group.proposal.expiresAt = now + this.options.proposalExpiryMs;
        group.proposal.staleReason = 'consent_expired'; transition.status = 'partial';
      } else {
        group.proposal.status = 'expired'; group.proposal.confirmations.clear(); group.revision++;
        if (transition) group.transition = null;
      }
    }
    if (group.transition?.status === 'complete') return;
    let changed = false;
    for (const member of group.members.values()) {
      if (member.connected && now - member.lastSeenAt >= this.options.memberLeaseMs) { member.connected = false; changed = true; }
    }
    if (changed) this.noteGroupChange(group, 'member_disconnected');
  }

  expireGroup(group) {
    this.groups.delete(group.id);
    for (const member of group.members.values()) if (this.profileGroups.get(member.id) === group.id) this.profileGroups.delete(member.id);
  }

  publicGroup(group, viewerProfileId) {
    const proposal = group.proposal;
    return {
      groupId: group.id,
      revision: group.revision,
      membershipRevision: group.membershipRevision,
      viewer: { memberKey: group.members.get(viewerProfileId)?.memberKey || null,
        isHost: group.members.get(viewerProfileId)?.id === group.hostProfileId },
      createdAt: group.createdAt,
      expiresAt: group.expiresAt,
      members: [...group.members.values()].map(member => ({ memberKey: member.memberKey, name: member.name, avatar: member.avatar,
        isHost: member.id === group.hostProfileId, connected: member.connected,
        confirmed: proposal?.status === 'pending' && proposal.confirmations.has(member.id) })),
      proposal: proposal ? {
        id: proposal.id, revision: proposal.revision, status: proposal.status, expiresAt: proposal.expiresAt,
        target: cloneJson(proposal.target), confirmationCount: proposal.confirmations.size,
        requiredConfirmations: group.members.size,
        confirmedByViewer: proposal.status === 'pending' && proposal.confirmations.has(viewerProfileId),
      } : null,
      transition: group.transition ? { status: group.transition.status, prepared: group.transition.prepared.size,
        joined: group.transition.seats.size, total: group.members.size,
        error: group.transition.lastError ? { code: group.transition.lastError.code, message: group.transition.lastError.message } : null } : null,
    };
  }

  async getGroup(trustedProfile, groupId, groupCapability) {
    const { group, member } = this.authenticate(groupId, trustedProfile, groupCapability);
    return this.withLock(group, () => {
      this.sweepGroup(group);
      if (!this.groups.has(group.id)) throw new GroupLobbyError('GROUP_NOT_FOUND', 'Sảnh nhóm đã hết hạn.', 404);
      this.markConnected(group, member);
      return this.publicGroup(group, member.id);
    });
  }

  validateProposalTarget(group, request) {
    const { gameId } = request || {};
    const variant = request?.variant;
    let identity;
    try { identity = resolveGameVariant(gameId, variant); }
    catch (error) { throw new GroupLobbyError(error.code || 'TARGET_INVALID', error.message, 400); }
    const adapter = this.adapters[adapterKey(gameId, variant)];
    if (!adapter || adapter.identity?.gameId !== identity.gameId || adapter.identity?.variant !== identity.variant || typeof adapter.validateConfig !== 'function') {
      throw new GroupLobbyError('TARGET_ADAPTER_UNAVAILABLE', 'Game/variant này chưa có adapter an toàn cho sảnh nhóm.', 503);
    }
    const game = getGame(gameId);
    if (!game) throw new GroupLobbyError('GAME_NOT_FOUND', 'Game không tồn tại.', 404);
    if (group.members.size < game.minPlayers) throw new GroupLobbyError('GROUP_TOO_SMALL', `Game cần ít nhất ${game.minPlayers} người.`, 409);
    let config;
    try { config = adapter.validateConfig({ ...(request.config || {}), variant, visibility: 'invite', password: '' }, { memberCount: group.members.size }); }
    catch (error) { throw new GroupLobbyError(error.code || 'INVALID_CONFIG', error.message || 'Cấu hình bàn không hợp lệ.', 400); }
    if (!config || !Number.isInteger(config.maxPlayers) || group.members.size > config.maxPlayers) {
      throw new GroupLobbyError('GROUP_OVER_CAPACITY', 'Nhóm đông hơn số ghế của cấu hình bàn.', 409);
    }
    const cleanConfig = { ...config, visibility: 'invite', password: '' };
    delete cleanConfig.passwordHash;
    delete cleanConfig.profileToken;
    delete cleanConfig.sessionToken;
    return { gameId, variant, entryPath: identity.entryPath, config: cleanConfig };
  }

  async propose(trustedProfile, groupId, groupCapability, request = {}) {
    const { group, member } = this.authenticate(groupId, trustedProfile, groupCapability);
    return this.withLock(group, () => {
      this.sweepGroup(group);
      if (!this.groups.has(group.id)) throw new GroupLobbyError('GROUP_NOT_FOUND', 'Sảnh nhóm đã hết hạn.', 404);
      this.markConnected(group, member);
      if (!member.host) throw new GroupLobbyError('HOST_ONLY', 'Chỉ host mới có thể đề xuất game.', 403);
      if (group.transition && group.transition.status !== 'complete') throw new GroupLobbyError('SWITCH_RECOVERY_REQUIRED', 'Khôi phục lượt chuyển bàn hiện tại trước khi đề xuất game khác.', 409);
      if (group.transition?.status === 'complete') group.transition = null;
      const target = this.validateProposalTarget(group, request);
      if (group.proposal?.status === 'pending') throw new GroupLobbyError('PROPOSAL_PENDING', 'Đề xuất hiện tại cần được xác nhận hoặc hết hạn trước.', 409);
      group.revision++; group.lastActivityAt = this.now();
      group.proposal = { id: crypto.randomUUID(), revision: group.revision, target, createdAt: this.now(),
        expiresAt: this.now() + this.options.proposalExpiryMs, status: 'pending', confirmations: new Set(), staleReason: null };
      return this.publicGroup(group, member.id);
    });
  }

  async confirm(trustedProfile, groupId, groupCapability, request = {}) {
    const { group, member } = this.authenticate(groupId, trustedProfile, groupCapability);
    return this.withLock(group, () => {
      this.sweepGroup(group);
      if (!this.groups.has(group.id)) throw new GroupLobbyError('GROUP_NOT_FOUND', 'Sảnh nhóm đã hết hạn.', 404);
      this.markConnected(group, member);
      const proposal = group.proposal;
      if (!proposal || proposal.status !== 'pending' || proposal.id !== request.proposalId || proposal.revision !== request.proposalRevision) {
        throw new GroupLobbyError('PROPOSAL_STALE', 'Đề xuất đã đổi hoặc hết hạn. Hãy xem lại game, biến thể và cấu hình.', 409);
      }
      proposal.confirmations.add(member.id);
      group.lastActivityAt = this.now();
      return this.publicGroup(group, member.id);
    });
  }

  assertSwitchHooks() {
    if (typeof this.authorizeTarget !== 'function' || typeof this.canPrepareMemberForSwitch !== 'function' || typeof this.prepareMemberForSwitch !== 'function') {
      throw new GroupLobbyError('SWITCH_POLICY_UNAVAILABLE', 'Chưa nối các cổng an toàn phòng, tiền cược và bảo trì.', 503);
    }
  }

  async switchGroup(trustedProfile, groupId, groupCapability) {
    const { group, member } = this.authenticate(groupId, trustedProfile, groupCapability);
    return this.withLock(group, async () => {
      this.sweepGroup(group);
      if (!this.groups.has(group.id)) throw new GroupLobbyError('GROUP_NOT_FOUND', 'Sảnh nhóm đã hết hạn.', 404);
      this.markConnected(group, member);
      const proposal = group.proposal;
      if (group.transition?.status === 'complete') return this.publicGroup(group, member.id);
      if (!proposal || !['pending', 'switching'].includes(proposal.status)) throw new GroupLobbyError('PROPOSAL_STALE', 'Tạo một đề xuất mới trước khi chuyển game.', 409);
      if (proposal.status === 'pending' && (proposal.confirmations.size !== group.members.size || [...group.members.values()].some(item => !item.connected))) {
        throw new GroupLobbyError('CONSENT_REQUIRED', 'Tất cả thành viên đang kết nối cần xác nhận đúng đề xuất này.', 409);
      }
      if (group.transition && group.transition.proposalId !== proposal.id) throw new GroupLobbyError('SWITCH_CONFLICT', 'Có một lượt chuyển bàn khác đang được khôi phục.', 409);
      const adapter = this.adapters[adapterKey(proposal.target.gameId, proposal.target.variant)];
      if (!adapter) throw new GroupLobbyError('TARGET_ADAPTER_UNAVAILABLE', 'Không tìm thấy adapter game đích.', 503);
      this.assertSwitchHooks();
      const operationId = `${group.id}:${proposal.id}`;
      const members = [...group.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
      const profiles = members.map(item => ({ id: item.id, name: item.name, avatar: item.avatar }));
      try {
        if (!group.transition) {
          proposal.status = 'switching';
        group.transition = { operationId, proposalId: proposal.id, status: 'running', roomCode: null,
            prepared: new Set(), seats: new Map(), handoffsReleased: new Set(), lastError: null };
        } else group.transition.status = 'running';
        const transition = group.transition;
        const policy = await this.authorizeTarget({ operationId, groupId: group.id, target: cloneJson(proposal.target), profiles: cloneJson(profiles) });
        if (policy === false || policy?.ok === false) throw new GroupLobbyError(policy?.code || 'TARGET_POLICY_BLOCKED', policy?.message || 'Bàn đích hiện không được phép tạo.', 409);
        for (const profile of profiles) {
          if (!transition.preflighted?.has(profile.id)) {
            const result = await this.canPrepareMemberForSwitch(profile, { operationId, target: cloneJson(proposal.target) });
            if (result === false || result?.ok === false) throw new GroupLobbyError(result?.code || 'OLD_MATCH_UNSAFE', result?.message || `${profile.name} chưa thể rời bàn cũ.`, 409);
          }
        }
        transition.preflighted ||= new Set(profiles.map(profile => profile.id));
        for (const profile of profiles) {
          if (transition.prepared.has(profile.id)) continue;
          const result = await this.prepareMemberForSwitch(profile, { operationId, target: cloneJson(proposal.target) });
          if (result === false || result?.ok === false) throw new GroupLobbyError(result?.code || 'OLD_MATCH_UNSAFE', result?.message || `${profile.name} chưa thể rời bàn cũ.`, 409);
          transition.prepared.add(profile.id);
        }
        if (!transition.roomCode) {
          const created = await adapter.createTarget({ operationId, host: cloneJson(profiles.find(profile => profile.id === group.hostProfileId)),
            target: cloneJson(proposal.target), profiles: cloneJson(profiles) });
          if (!created?.roomCode) throw new GroupLobbyError('TARGET_CREATE_FAILED', 'Adapter không trả mã bàn đích.', 502);
          transition.roomCode = String(created.roomCode).trim().toUpperCase();
          if (!/^[A-Z2-9]{4}$/.test(transition.roomCode)) throw new GroupLobbyError('TARGET_ROOM_CODE_INVALID', 'Adapter trả mã bàn không hợp lệ.', 502);
        }
        for (const profile of profiles) {
          if (transition.seats.has(profile.id)) continue;
          const credential = await adapter.ensureSeat({ operationId, roomCode: transition.roomCode, member: cloneJson(profile),
            target: cloneJson(proposal.target), idempotencyKey: `${operationId}:${profile.id}` });
          if (!credential || credential.roomCode !== transition.roomCode || credential.gameId !== proposal.target.gameId ||
              credential.variant !== proposal.target.variant || typeof credential.playerId !== 'string' || typeof credential.sessionToken !== 'string') {
            throw new GroupLobbyError('TARGET_SEAT_UNVERIFIED', 'Không xác minh được ghế riêng của một thành viên.', 502);
          }
          transition.seats.set(profile.id, cloneJson({ ...credential, entryPath: proposal.target.entryPath }));
        }
        for (const profile of profiles) {
          if (transition.handoffsReleased.has(profile.id) || typeof adapter.releaseSeatForHandoff !== 'function') continue;
          const released = await adapter.releaseSeatForHandoff({ operationId, roomCode: transition.roomCode,
            member: cloneJson(profile), target: cloneJson(proposal.target) });
          if (released === false || released?.ok === false) throw new GroupLobbyError(released?.code || 'TARGET_HANDOFF_RELEASE_FAILED', released?.message || `Không chuẩn bị được ghế cho ${profile.name}.`, 502);
          transition.handoffsReleased.add(profile.id);
        }
        const roomBinding = typeof adapter.getRoomBinding === 'function'
          ? await adapter.getRoomBinding({ operationId, groupId: group.id, roomCode: transition.roomCode }) : null;
        if (!roomBinding || roomBinding.roomCode !== transition.roomCode || roomBinding.gameId !== proposal.target.gameId ||
            roomBinding.variant !== proposal.target.variant || !Array.isArray(roomBinding.participants)) {
          throw new GroupLobbyError('TARGET_BINDING_UNAVAILABLE', 'Không xác minh được liên kết phòng và danh sách hồ sơ trên manager.', 502);
        }
        const actualParticipants = [...new Set(roomBinding.participants)].sort();
        const expectedParticipants = profiles.map(profile => profile.id).sort();
        if (actualParticipants.length !== expectedParticipants.length || actualParticipants.some((id, index) => id !== expectedParticipants[index])) {
          throw new GroupLobbyError('TARGET_PARTICIPANTS_MISMATCH', 'Danh sách ghế bàn đích không khớp với thành viên đã xác nhận.', 502);
        }
        transition.roomBinding = cloneJson(roomBinding);
        if (typeof this.bindTargetRoom === 'function') {
          await this.bindTargetRoom({ operationId, groupId: group.id, groupRevision: group.revision,
            membershipRevision: group.membershipRevision, hostProfileId: group.hostProfileId,
            members: profiles.map((profile, joinOrder) => ({ profileId: profile.id, displayName: profile.name, joinOrder })),
            proposalId: proposal.id, target: cloneJson(proposal.target), roomBinding: cloneJson(roomBinding) });
        }
        transition.status = 'complete'; transition.lastError = null;
        proposal.status = 'complete'; group.currentTargetRoomCode = transition.roomCode;
        group.currentTarget = cloneJson(proposal.target);
        group.lastActivityAt = this.now(); group.revision++;
        group.targetMembers = members.map((member, joinOrder) => ({ profileId: member.id, displayName: member.name, joinOrder }));
      } catch (error) {
        const normalized = error instanceof GroupLobbyError ? error : new GroupLobbyError(error?.code || 'GROUP_SWITCH_FAILED', error?.message || 'Không thể hoàn tất chuyển bàn.', 502);
        group.transition.status = group.transition.roomCode || group.transition.prepared.size ? 'partial' : 'blocked';
        group.transition.lastError = { code: normalized.code, message: normalized.message };
        proposal.status = 'pending';
        group.lastActivityAt = this.now();
        throw normalized;
      }
      return this.publicGroup(group, member.id);
    });
  }

  async handoff(trustedProfile, groupId, groupCapability) {
    const { group, member } = this.authenticate(groupId, trustedProfile, groupCapability);
    return this.withLock(group, () => {
      this.sweepGroup(group);
      if (!this.groups.has(group.id)) throw new GroupLobbyError('GROUP_NOT_FOUND', 'Sảnh nhóm đã hết hạn.', 404);
      this.markConnected(group, member);
      const credential = group.transition?.status === 'complete' && group.transition.seats.get(member.id);
      if (!credential) throw new GroupLobbyError('HANDOFF_NOT_READY', 'Bàn mới chưa sẵn sàng cho thành viên này.', 409);
      group.lastActivityAt = this.now();
      return cloneJson(credential);
    });
  }

  async heartbeat(trustedProfile, groupId, groupCapability) {
    const { group, member } = this.authenticate(groupId, trustedProfile, groupCapability);
    return this.withLock(group, () => {
      this.sweepGroup(group);
      if (!this.groups.has(group.id)) throw new GroupLobbyError('GROUP_NOT_FOUND', 'Sảnh nhóm đã hết hạn.', 404);
      this.markConnected(group, member); return this.publicGroup(group, member.id);
    });
  }

  async disconnect(trustedProfile, groupId, groupCapability) {
    const { group, member } = this.authenticate(groupId, trustedProfile, groupCapability);
    return this.withLock(group, () => {
      this.sweepGroup(group);
      if (!this.groups.has(group.id)) throw new GroupLobbyError('GROUP_NOT_FOUND', 'Sảnh nhóm đã hết hạn.', 404);
      if (member.connected) { member.connected = false; this.noteGroupChange(group, 'member_disconnected'); }
      group.lastActivityAt = this.now();
      return this.publicGroup(group, member.id);
    });
  }

  async transferHost(trustedProfile, groupId, groupCapability, memberKey) {
    const { group, member } = this.authenticate(groupId, trustedProfile, groupCapability);
    return this.withLock(group, async () => {
      this.sweepGroup(group); this.markConnected(group, member);
      if (!member.host) throw new GroupLobbyError('HOST_ONLY', 'Chỉ host mới có thể chuyển quyền host.', 403);
      await this.assertMembershipMutable(group);
      if (group.transition && group.transition.status !== 'complete') throw new GroupLobbyError('SWITCH_ALREADY_STARTED', 'Không thể đổi host khi đang khôi phục lượt chuyển bàn.', 409);
      const next = [...group.members.values()].find(item => item.memberKey === memberKey && item.connected);
      if (!next) throw new GroupLobbyError('MEMBER_NOT_FOUND', 'Không tìm thấy thành viên đang kết nối.', 404);
      if (next.id === member.id) return this.publicGroup(group, member.id);
      member.host = false; next.host = true; group.hostProfileId = next.id;
      if (group.transition?.status === 'complete') group.transition = null;
      this.noteGroupChange(group, 'host_transferred'); group.lastActivityAt = this.now();
      return this.publicGroup(group, member.id);
    });
  }

  async leave(trustedProfile, groupId, groupCapability) {
    const { group, member } = this.authenticate(groupId, trustedProfile, groupCapability);
    return this.withLock(group, async () => {
      this.sweepGroup(group);
      if (!this.groups.has(group.id)) return { left: true, expired: true };
      if (group.transition?.status === 'running') throw new GroupLobbyError('SWITCH_IN_PROGRESS', 'Hãy chờ lượt chuyển bàn hoàn tất trước khi rời nhóm.', 409);
      if (group.transition?.status === 'partial') throw new GroupLobbyError('SWITCH_RECOVERY_REQUIRED', 'Lượt chuyển bàn một phần cần được khôi phục trước khi rời nhóm.', 409);
      await this.assertMembershipMutable(group);
      group.members.delete(member.id); this.profileGroups.delete(member.id);
      this.noteGroupChange(group, 'membership_changed', true);
      if (!group.members.size) { this.expireGroup(group); return { left: true, expired: true }; }
      if (group.hostProfileId === member.id) {
        const next = [...group.members.values()].filter(item => item.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0]
          || [...group.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
        group.hostProfileId = next.id; next.host = true;
      }
      group.lastActivityAt = this.now();
      return { left: true, group: this.publicGroup(group, null) };
    });
  }

  async getTrustedGroupSnapshot(groupId) {
    const group = this.groups.get(groupId);
    if (!group) return null;
    return this.withLock(group, async () => {
      this.sweepGroup(group);
      if (!this.groups.has(groupId)) return null;
      const orderedMembers = [...group.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
      const inFlight = group.transition && group.transition.status !== 'complete' && group.transition.roomCode;
      const roomCode = inFlight || group.currentTargetRoomCode || group.transition?.roomCode || null;
      const target = inFlight ? group.proposal?.target : (group.currentTarget || (group.transition?.roomCode ? group.proposal?.target : null));
      const adapter = target && this.adapters[adapterKey(target.gameId, target.variant)];
      let roomBinding = roomCode && typeof adapter?.getRoomBinding === 'function'
        ? await adapter.getRoomBinding({ roomCode, groupId: group.id }) : null;
      if (roomBinding) roomBinding = Object.freeze({ ...roomBinding, participants: Object.freeze([...roomBinding.participants]) });
      return Object.freeze({
        groupId: group.id,
        revision: group.revision,
        membershipRevision: group.membershipRevision,
        hostProfileId: group.hostProfileId,
        participantProfileIds: Object.freeze(orderedMembers.map(member => member.id)),
        members: Object.freeze(orderedMembers.map((member, joinOrder) => Object.freeze({ profileId: member.id,
          displayName: member.name, joinOrder, isHost: member.id === group.hostProfileId, connected: member.connected }))),
        targetParticipantProfileIds: Object.freeze((group.targetMembers || []).map(member => member.profileId)),
        targetMembers: Object.freeze((group.targetMembers || []).map(member => Object.freeze({ ...member }))),
        proposal: group.proposal ? Object.freeze({ id: group.proposal.id, revision: group.proposal.revision,
          status: group.proposal.status, target: cloneJson(group.proposal.target) }) : null,
        currentTargetRoomCode: roomCode,
        roomBinding,
        transitionStatus: group.transition?.status || null,
        expiresAt: group.expiresAt,
      });
    });
  }
}

module.exports = {
  GroupLobbyError,
  GroupLobbyService,
  adapterKey,
  targetAdaptersFromManager,
  managerSwitchLifecycle,
};
