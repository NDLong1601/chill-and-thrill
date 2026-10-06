'use strict';

// Compatibility facade for the imported M1–M3 portal. All games use the same
// ProfileStore and ledger; this facade never opens a second wallet database.
const crypto = require('node:crypto');
const { ProfileStore, StoreError, vietnamDay } = require('./profileStore');

class ProfileService {
  constructor(options = {}) {
    this.profiles = options.profileStore || new ProfileStore(options);
    this.ownsStore = !options.profileStore;
    this.storageError = false;
    this.migrationReport = null;
    this.store = {
      file: this.profiles.databaseFile,
      schemaVersion: () => this.profiles.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      integrityCheck: () => Object.values(this.profiles.db.prepare('PRAGMA integrity_check').get())[0],
    };
    this.wallet = { history: id => this.history(id) };
    this.missions = { list: id => this.missionList(id) };
  }

  close() { if (this.ownsStore) this.profiles.close(); }
  createProfile(name, avatar) {
    const created = this.profiles.createProfile({ displayName: name, avatar });
    return { player: this.publicProfile(created.profile.id), rawToken: created.sessionToken, recoveryCode: created.recoveryCode };
  }
  resolveProfile(rawToken) {
    const profile = this.profiles.authenticate(rawToken);
    return profile ? { player: this.publicProfile(profile.id), rawToken } : null;
  }
  requireProfile(rawToken) {
    const profile = this.resolveProfile(rawToken);
    if (!profile) throw new StoreError('Hồ sơ local không hợp lệ hoặc phiên đã hết hạn.', 'PROFILE_UNAUTHORIZED');
    return profile;
  }
  getOrCreate(name, avatar, rawToken) {
    return rawToken ? this.requireProfile(rawToken) : this.createProfile(name, avatar);
  }
  publicProfile(id) {
    const profile = this.profiles.publicProfile(id);
    if (!profile) return null;
    const room = this.profiles.db.prepare(`SELECT r.room_code AS roomCode, r.game_id AS gameId, r.phase, r.state_json AS stateJson
      FROM room_members m JOIN rooms r ON r.id = m.room_id
      WHERE m.profile_id = ? AND m.left_at IS NULL ORDER BY r.updated_at DESC LIMIT 1`).get(id);
    let inGame = 0;
    if (room?.gameId === 'poker') {
      const committed = this.profiles.db.prepare("SELECT state_json AS stateJson FROM game_snapshots WHERE game_id = 'poker' AND room_code = ? AND closed_at IS NULL").get(room.roomCode);
      try { inGame = JSON.parse(committed?.stateJson || room.stateJson).players.find(p => p.profileId === id)?.stack || 0; } catch {}
    }
    const activeRoom = room ? { roomCode: room.roomCode, gameId: room.gameId, phase: room.phase } : null;
    return { ...profile, playerId: profile.id, name: profile.displayName,
      wallet: { ...profile.wallet, inGame }, activeRoom, localOnly: true, timezone: 'Asia/Ho_Chi_Minh' };
  }
  updateProfile(rawToken, patch = {}) {
    const { player } = this.requireProfile(rawToken);
    this.profiles.updateProfile(player.playerId, { displayName: patch.name, avatar: patch.avatar });
    return this.publicProfile(player.playerId);
  }
  issueProfileToken(id) {
    if (!this.profiles.publicProfile(id)) throw new StoreError('Ghế cũ chưa có hồ sơ; hãy tạo hồ sơ trước khi ghép.', 'PROFILE_NOT_FOUND');
    const rawToken = crypto.randomBytes(32).toString('base64url'), at = new Date().toISOString();
    this.profiles.db.prepare(`INSERT INTO sessions(id, profile_id, token_hash, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(crypto.randomUUID(), id, crypto.createHash('sha256').update(rawToken).digest('hex'), at, at,
      new Date(Date.now() + 90 * 86400000).toISOString());
    return rawToken;
  }
  history(id) {
    return this.profiles.listLedger(id, 100).map(row => ({ ...row, reason: row.note, sourceType: row.source, inGameDelta: 0 }));
  }
  historyPage(rawToken, filters = {}) {
    const { player } = this.requireProfile(rawToken);
    return this.profiles.listHistoryPage(player.playerId, filters);
  }
  storageHealth() { return this.profiles.storageHealth(); }
  auditFixedGameHolds(options = {}) { return this.profiles.auditFixedGameHolds(options); }
  heldReservationCount() { return this.profiles.heldReservationCount(); }
  missionList(id) {
    const current = vietnamDay();
    const periods = this.profiles.db.prepare(`SELECT DISTINCT period FROM mission_progress
      WHERE profile_id = ? AND period < ? ORDER BY period DESC LIMIT 6`).all(id, current).map(row => row.period);
    const daily = [current, ...periods].flatMap(period => this.profiles.getMissions(id, period))
      .filter(m => m.kind !== 'tutorial' && this.validPeriod(m.period) && (m.period === current || (m.complete && !m.claimed)));
    const tutorial = this.profiles.getMissions(id, current).find(m => m.kind === 'tutorial');
    return [...daily, ...(tutorial ? [tutorial] : [])]
      .map(m => ({ ...m, missionId: m.id, title: m.description, target: m.threshold, periodKey: m.period,
        completed: m.complete, locked: !m.enabled, lockReason: !m.enabled ? 'Chưa có hướng dẫn được server xác minh.' : '' }));
  }
  validPeriod(period) {
    if (typeof period !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(period)) return false;
    const today = new Date(`${vietnamDay()}T00:00:00+07:00`).getTime();
    const age = (today - new Date(`${period}T00:00:00+07:00`).getTime()) / 86400000;
    return Number.isInteger(age) && age >= 0 && age < 7;
  }
  profilePayload(rawToken) {
    const { player } = this.requireProfile(rawToken), id = player.playerId;
    return { profile: this.publicProfile(id), missions: this.missionList(id), history: this.history(id) };
  }
  missionPayload(rawToken) { return this.profilePayload(rawToken); }
  claimMission(rawToken, request = {}) {
    const { player } = this.requireProfile(rawToken);
    const period = request.periodKey || vietnamDay();
    if (request.missionId !== 'tutorial_verified' && !this.validPeriod(period)) throw new StoreError('Kỳ nhiệm vụ đã hết hạn.', 'MISSION_EXPIRED');
    this.profiles.claimMission(player.playerId, request.missionId, request.version || 1, period);
    return this.profilePayload(rawToken);
  }
  canEnterWalletRoom(id, code) {
    const held = this.profiles.db.prepare("SELECT room_code FROM reservations WHERE profile_id = ? AND status = 'HELD' AND room_code <> ? LIMIT 1").get(id, code);
    if (held) throw new StoreError('Hồ sơ đang giữ tiền cược ở một bàn khác.', 'PROFILE_ALREADY_IN_WALLET_ROOM');
  }
  syncRoom(room) {
    if (!room) return null;
    const gameId = room.gameId || 'the-gang';
    return this.profiles.transaction(() => {
      this.profiles.syncRoom({ room, gameId });
      let result = null;
      if (gameId === 'the-gang' && room.gameOver) result = { won: room.gameWon, mode: room.mode, score: room.score };
      if (gameId === 'uno' && room.uno?.phase === 'RESULT') result = room.uno.result;
      if (!result) return null;
      const completedAt = result.endedAt || result.date || room.lastResult?.date || new Date().toISOString();
      const recorded = this.profiles.recordCompletedMatch({ matchId: room.matchId, gameId, roomCode: room.code,
        players: room.players.map(p => ({ profileId: this.profiles.publicProfile(p.profileId) ? p.profileId : null })), result, completedAt });
      return recorded.recorded ? { completionEvent: { eventId: room.matchId, matchId: room.matchId, gameId, roomCode: room.code, endedAt: completedAt } } : null;
    });
  }
}

module.exports = { ProfileService };
