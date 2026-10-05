'use strict';

// M3 persistence boundary.  All values that can affect a wallet are changed
// inside one SQLite transaction; browsers only receive the resulting summary.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const STARTING_CHIPS = 1000;
const MAX_CHIPS = 1_000_000_000;
const SESSION_DAYS = 90;
const AVATARS = new Set(['🕶️', '🥷', '💻', '🔓', '🎲', '🏎️']);

class StoreError extends Error {
  constructor(message, code = 'STORE_ERROR') { super(message); this.code = code; }
}

const nowIso = () => new Date().toISOString();
const tokenHash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const randomRecoveryCode = () => crypto.randomBytes(10).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
const cleanName = value => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 18) || 'Player';
const cleanAvatar = value => AVATARS.has(value) ? value : '🕶️';
const validAmount = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_CHIPS;
const stableJson = value => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const payloadHash = value => tokenHash(stableJson(value));
function vietnamDay(input = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(input));
  const part = type => parts.find(value => value.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const MISSION_DEFINITIONS = Object.freeze([
  { id: 'daily_match', version: 1, kind: 'matches', threshold: 1, reward: 100, description: 'Hoàn thành 1 ván hợp lệ hôm nay', enabled: 1 },
  { id: 'daily_three_matches', version: 1, kind: 'matches', threshold: 3, reward: 200, description: 'Hoàn thành 3 ván hợp lệ hôm nay', enabled: 1 },
  { id: 'daily_two_games', version: 1, kind: 'games', threshold: 2, reward: 150, description: 'Hoàn thành 2 game khác nhau hôm nay', enabled: 1 },
  // There is no server-verified tutorial flow yet, so this intentionally
  // remains unavailable instead of trusting a client-side completion signal.
  { id: 'tutorial_verified', version: 1, kind: 'tutorial', threshold: 1, reward: 200, description: 'Hoàn thành hướng dẫn đã được máy chủ xác minh', enabled: 0 },
]);

class ProfileStore {
  constructor(options = {}) {
    this.databaseFile = options.databaseFile || ':memory:';
    this.legacyRoomsFile = options.legacyRoomsFile || null;
    if (this.databaseFile !== ':memory:') fs.mkdirSync(path.dirname(this.databaseFile), { recursive: true });
    this.db = new DatabaseSync(this.databaseFile);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (this.databaseFile !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
    this.backupAndImportLegacyRooms();
  }

  close() { this.db.close(); }

  transaction(work) {
    const nested = Boolean(this.transactionDepth);
    const savepoint = `nested_${this.transactionDepth || 0}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth = (this.transactionDepth || 0) + 1;
    try {
      const result = work();
      this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK'); if (nested) this.db.exec(`RELEASE SAVEPOINT ${savepoint}`); } catch {}
      throw error;
    } finally { this.transactionDepth--; }
  }

  migrate() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
    )`);
    const applied = new Set(this.db.prepare('SELECT version FROM schema_migrations').all().map(row => row.version));
    const migrations = [
      [1, `
        CREATE TABLE profiles (
          id TEXT PRIMARY KEY, display_name TEXT NOT NULL, avatar TEXT NOT NULL,
          recovery_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
          expires_at TEXT NOT NULL, revoked_at TEXT
        );
        CREATE INDEX sessions_active_idx ON sessions(token_hash, expires_at);
        CREATE TABLE rooms (
          id TEXT PRIMARY KEY, room_code TEXT NOT NULL UNIQUE, game_id TEXT NOT NULL,
          phase TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, state_json TEXT NOT NULL
        );
        CREATE TABLE room_members (
          member_id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL, legacy_player_id TEXT,
          is_host INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, joined_at TEXT NOT NULL, left_at TEXT,
          UNIQUE(room_id, profile_id)
        );
        CREATE TABLE matches (
          match_id TEXT PRIMARY KEY, room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
          game_id TEXT NOT NULL, completed_at TEXT NOT NULL, mission_period TEXT NOT NULL,
          status TEXT NOT NULL, result_json TEXT NOT NULL
        );
        CREATE INDEX matches_period_idx ON matches(mission_period, game_id);
        CREATE TABLE match_players (
          match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          outcome TEXT, PRIMARY KEY(match_id, profile_id)
        );
        CREATE TABLE match_snapshots (
          id TEXT PRIMARY KEY, match_id TEXT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
          committed_at TEXT NOT NULL, snapshot_json TEXT NOT NULL
        );
        CREATE TABLE wallets (
          profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
          available INTEGER NOT NULL CHECK(available >= 0 AND available <= 1000000000),
          reserved INTEGER NOT NULL CHECK(reserved >= 0 AND reserved <= 1000000000),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE wallet_operations (
          idempotency_key TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_hash TEXT NOT NULL,
          result_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE wallet_ledger (
          id TEXT PRIMARY KEY, operation_key TEXT NOT NULL REFERENCES wallet_operations(idempotency_key),
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          available_delta INTEGER NOT NULL, reserved_delta INTEGER NOT NULL,
          source TEXT NOT NULL, room_code TEXT, match_id TEXT, note TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX wallet_ledger_profile_idx ON wallet_ledger(profile_id, created_at DESC);
        CREATE TABLE reservations (
          id TEXT PRIMARY KEY, operation_key TEXT NOT NULL REFERENCES wallet_operations(idempotency_key),
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          room_code TEXT NOT NULL, match_id TEXT, amount INTEGER NOT NULL CHECK(amount > 0),
          status TEXT NOT NULL CHECK(status IN ('HELD', 'RELEASED', 'SETTLED')), created_at TEXT NOT NULL,
          closed_at TEXT
        );
        CREATE INDEX reservations_active_idx ON reservations(profile_id, status);
        CREATE TABLE mission_definitions (
          mission_id TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL,
          threshold INTEGER NOT NULL, reward INTEGER NOT NULL, description TEXT NOT NULL,
          enabled INTEGER NOT NULL, PRIMARY KEY(mission_id, version)
        );
        CREATE TABLE mission_progress (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          mission_id TEXT NOT NULL, version INTEGER NOT NULL, period TEXT NOT NULL,
          progress INTEGER NOT NULL, evidence_json TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(profile_id, mission_id, version, period),
          FOREIGN KEY(mission_id, version) REFERENCES mission_definitions(mission_id, version)
        );
        CREATE TABLE mission_claims (
          profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          mission_id TEXT NOT NULL, version INTEGER NOT NULL, period TEXT NOT NULL,
          operation_key TEXT NOT NULL UNIQUE REFERENCES wallet_operations(idempotency_key),
          claimed_at TEXT NOT NULL,
          PRIMARY KEY(profile_id, mission_id, version, period)
        );
        CREATE TABLE admin_audit (
          id TEXT PRIMARY KEY, action TEXT NOT NULL, actor TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
      `],
      [2, `CREATE TABLE game_snapshots (
        game_id TEXT NOT NULL, room_code TEXT NOT NULL, state_json TEXT,
        updated_at TEXT NOT NULL, closed_at TEXT,
        PRIMARY KEY(game_id, room_code)
      )`],
    ];
    for (const [version, sql] of migrations) {
      if (applied.has(version)) continue;
      this.transaction(() => {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, nowIso());
      });
    }
    const insertDefinition = this.db.prepare(`INSERT OR IGNORE INTO mission_definitions
      (mission_id, version, kind, threshold, reward, description, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    this.transaction(() => MISSION_DEFINITIONS.forEach(definition => insertDefinition.run(
      definition.id, definition.version, definition.kind, definition.threshold, definition.reward, definition.description, definition.enabled,
    )));
  }

  backupAndImportLegacyRooms() {
    if (!this.legacyRoomsFile || !fs.existsSync(this.legacyRoomsFile)) return;
    const metaExists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_meta'").get();
    if (!metaExists) this.db.exec('CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const imported = this.db.prepare("SELECT value FROM migration_meta WHERE key = 'legacy_rooms_import_v1'").get();
    if (imported) return;
    const backup = `${this.legacyRoomsFile}.m3-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try { fs.copyFileSync(this.legacyRoomsFile, backup, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw new StoreError('Không thể sao lưu rooms.json trước migration.', 'LEGACY_BACKUP_FAILED'); }
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this.legacyRoomsFile, 'utf8')); }
    catch { throw new StoreError('rooms.json cũ bị hỏng; đã giữ nguyên tệp nguồn và không import.', 'LEGACY_ROOMS_INVALID'); }
    if (![1, 2].includes(saved?.version) || !Array.isArray(saved.rooms)) throw new StoreError('rooms.json cũ không đúng phiên bản; đã giữ nguyên tệp nguồn.', 'LEGACY_ROOMS_INVALID');
    this.transaction(() => {
      for (const room of saved.rooms) {
        if (!room || typeof room.code !== 'string' || !Array.isArray(room.players)) continue;
        const createdAt = new Date(room.updatedAt || Date.now()).toISOString();
        this.db.prepare(`INSERT OR IGNORE INTO rooms(id, room_code, game_id, phase, created_at, updated_at, state_json)
          VALUES (?, ?, 'the-gang', ?, ?, ?, ?)`)
          .run(`legacy:${room.code}`, room.code, room.phase || 'WAITING', createdAt, createdAt, JSON.stringify({ imported: true, mode: room.mode || null }));
        for (const player of room.players) {
          if (!player?.id) continue;
          this.db.prepare(`INSERT OR IGNORE INTO room_members(member_id, room_id, profile_id, legacy_player_id, is_host, status, joined_at)
            VALUES (?, ?, NULL, ?, ?, 'LEGACY', ?)`)
            .run(`legacy:${room.code}:${player.id}`, this.db.prepare('SELECT id FROM rooms WHERE room_code = ?').get(room.code).id, player.id, player.isHost ? 1 : 0, createdAt);
        }
      }
      this.db.prepare("INSERT INTO migration_meta(key, value) VALUES ('legacy_rooms_import_v1', ?)").run(nowIso());
    });
  }

  publicProfile(profileId) {
    const profile = this.db.prepare('SELECT id, display_name, avatar, created_at, updated_at FROM profiles WHERE id = ?').get(profileId);
    if (!profile) return null;
    const wallet = this.db.prepare('SELECT available, reserved FROM wallets WHERE profile_id = ?').get(profileId);
    return { id: profile.id, displayName: profile.display_name, avatar: profile.avatar, createdAt: profile.created_at, wallet: { available: wallet.available, reserved: wallet.reserved } };
  }

  createProfile({ displayName, avatar } = {}) {
    const id = crypto.randomUUID(), sessionToken = randomToken(), recoveryCode = randomRecoveryCode();
    const at = nowIso(), expiry = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(), operationKey = `bootstrap:${id}`;
    this.transaction(() => {
      this.db.prepare(`INSERT INTO profiles(id, display_name, avatar, recovery_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, cleanName(displayName), cleanAvatar(avatar), tokenHash(recoveryCode), at, at);
      this.db.prepare(`INSERT INTO sessions(id, profile_id, token_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), id, tokenHash(sessionToken), at, at, expiry);
      this.db.prepare('INSERT INTO wallets(profile_id, available, reserved, updated_at) VALUES (?, ?, 0, ?)').run(id, STARTING_CHIPS, at);
      this.db.prepare(`INSERT INTO wallet_operations(idempotency_key, kind, payload_hash, result_json, created_at) VALUES (?, 'bootstrap', ?, ?, ?)`)
        .run(operationKey, payloadHash({ id, startingChips: STARTING_CHIPS }), JSON.stringify({ available: STARTING_CHIPS, reserved: 0 }), at);
      this.db.prepare(`INSERT INTO wallet_ledger(id, operation_key, profile_id, available_delta, reserved_delta, source, room_code, match_id, note, created_at)
        VALUES (?, ?, ?, ?, 0, 'bootstrap', NULL, NULL, ?, ?)`)
        .run(crypto.randomUUID(), operationKey, id, STARTING_CHIPS, 'Cấp chip khởi đầu', at);
    });
    return { profile: this.publicProfile(id), sessionToken, recoveryCode };
  }

  authenticate(sessionToken) {
    if (typeof sessionToken !== 'string' || sessionToken.length < 32) return null;
    const at = nowIso();
    const session = this.db.prepare(`SELECT profile_id FROM sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`).get(tokenHash(sessionToken), at);
    if (!session) return null;
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(at, tokenHash(sessionToken));
    return this.publicProfile(session.profile_id);
  }

  recoverProfile(profileId, recoveryCode) {
    if (typeof profileId !== 'string' || typeof recoveryCode !== 'string') throw new StoreError('Mã khôi phục không hợp lệ.', 'RECOVERY_INVALID');
    const profile = this.db.prepare('SELECT id FROM profiles WHERE id = ? AND recovery_hash = ?').get(profileId, tokenHash(recoveryCode.trim().toUpperCase()));
    if (!profile) throw new StoreError('Không thể khôi phục hồ sơ. Kiểm tra lại mã hồ sơ và mã khôi phục.', 'RECOVERY_INVALID');
    const sessionToken = randomToken(), at = nowIso(), expiry = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    this.db.prepare(`INSERT INTO sessions(id, profile_id, token_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), profile.id, tokenHash(sessionToken), at, at, expiry);
    return { profile: this.publicProfile(profile.id), sessionToken };
  }

  updateProfile(profileId, { displayName, avatar } = {}) {
    const existing = this.publicProfile(profileId);
    if (!existing) throw new StoreError('Hồ sơ không còn tồn tại.', 'PROFILE_NOT_FOUND');
    const name = displayName === undefined ? existing.displayName : cleanName(displayName);
    const nextAvatar = avatar === undefined ? existing.avatar : cleanAvatar(avatar);
    this.db.prepare('UPDATE profiles SET display_name = ?, avatar = ?, updated_at = ? WHERE id = ?').run(name, nextAvatar, nowIso(), profileId);
    return this.publicProfile(profileId);
  }

  profileState(profileId) {
    const profile = this.publicProfile(profileId);
    if (!profile) return null;
    return { ...profile, missions: this.getMissions(profileId), ledger: this.listLedger(profileId, 20) };
  }

  listLedger(profileId, limit = 20) {
    return this.db.prepare(`SELECT available_delta AS availableDelta, reserved_delta AS reservedDelta, source, room_code AS roomCode,
      match_id AS matchId, note, created_at AS createdAt FROM wallet_ledger WHERE profile_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(profileId, Math.max(1, Math.min(100, Number(limit) || 20)));
  }

  executeOperation(kind, key, payload, work) {
    if (typeof key !== 'string' || key.length < 8 || key.length > 200) throw new StoreError('Idempotency key không hợp lệ.', 'IDEMPOTENCY_INVALID');
    const hash = payloadHash(payload);
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT kind, payload_hash, result_json FROM wallet_operations WHERE idempotency_key = ?').get(key);
      if (previous) {
        if (previous.kind !== kind || previous.payload_hash !== hash) throw new StoreError('Idempotency key đã dùng cho yêu cầu khác.', 'IDEMPOTENCY_CONFLICT');
        return { ...JSON.parse(previous.result_json), idempotent: true };
      }
      const at = nowIso();
      this.db.prepare('INSERT INTO wallet_operations(idempotency_key, kind, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(key, kind, hash, '{}', at);
      const result = work(at) || {};
      this.db.prepare('UPDATE wallet_operations SET result_json = ? WHERE idempotency_key = ?').run(JSON.stringify(result), key);
      return { ...result, idempotent: false };
    });
  }

  walletForUpdate(profileId) {
    const wallet = this.db.prepare('SELECT available, reserved FROM wallets WHERE profile_id = ?').get(profileId);
    if (!wallet) throw new StoreError('Ví không tồn tại.', 'WALLET_NOT_FOUND');
    return wallet;
  }

  writeWallet(profileId, availableDelta, reservedDelta, { operationKey, source, roomCode = null, matchId = null, note, at }) {
    const wallet = this.walletForUpdate(profileId), available = wallet.available + availableDelta, reserved = wallet.reserved + reservedDelta;
    if (!Number.isSafeInteger(available) || !Number.isSafeInteger(reserved) || available < 0 || reserved < 0 || available > MAX_CHIPS || reserved > MAX_CHIPS) {
      throw new StoreError('Số dư không đủ hoặc vượt giới hạn an toàn.', 'WALLET_LIMIT');
    }
    this.db.prepare('UPDATE wallets SET available = ?, reserved = ?, updated_at = ? WHERE profile_id = ?').run(available, reserved, at, profileId);
    this.db.prepare(`INSERT INTO wallet_ledger(id, operation_key, profile_id, available_delta, reserved_delta, source, room_code, match_id, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), operationKey, profileId, availableDelta, reservedDelta, source, roomCode, matchId, note, at);
    return { available, reserved };
  }

  reserveMany({ reservations, operationKey, roomCode, matchId = null }) {
    if (!Array.isArray(reservations) || !reservations.length || !reservations.every(item => item && typeof item.profileId === 'string' && validAmount(item.amount))) {
      throw new StoreError('Khoản giữ chip không hợp lệ.', 'RESERVATION_INVALID');
    }
    const profileIds = reservations.map(item => item.profileId);
    if (new Set(profileIds).size !== profileIds.length) throw new StoreError('Mỗi hồ sơ chỉ có một khoản giữ trong một thao tác.', 'RESERVATION_DUPLICATE');
    const payload = { reservations: reservations.map(item => ({ profileId: item.profileId, amount: item.amount })).sort((a, b) => a.profileId.localeCompare(b.profileId)), roomCode, matchId };
    return this.executeOperation('reserve_many', operationKey, payload, at => {
      // Check every participant before changing any wallet; this is the all-or-nothing boundary.
      for (const item of reservations) {
        if (this.walletForUpdate(item.profileId).available < item.amount) throw new StoreError('Một người chơi không đủ chip để vào bàn.', 'INSUFFICIENT_CHIPS');
        const activeSeat = this.db.prepare("SELECT room_code FROM reservations WHERE profile_id = ? AND status = 'HELD'").get(item.profileId);
        if (activeSeat && activeSeat.room_code !== roomCode) throw new StoreError('Một hồ sơ không thể ngồi hai bàn có chip cùng lúc.', 'CHIP_SEAT_ACTIVE');
      }
      const held = [];
      for (const item of reservations) {
        const wallet = this.writeWallet(item.profileId, -item.amount, item.amount, { operationKey, source: 'reservation', roomCode, matchId, note: 'Giữ chip trước khi bắt đầu ván', at });
        const id = crypto.randomUUID();
        this.db.prepare(`INSERT INTO reservations(id, operation_key, profile_id, room_code, match_id, amount, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'HELD', ?)`)
          .run(id, operationKey, item.profileId, roomCode, matchId, item.amount, at);
        held.push({ reservationId: id, profileId: item.profileId, amount: item.amount, wallet });
      }
      return { held };
    });
  }

  // The future thrill engines call this to close a fixed-stake table.  It is
  // intentionally server-only: a socket event never accepts arbitrary deltas.
  settleWinnerTakesPot({ reservations, winnerProfileId, operationKey, roomCode, matchId }) {
    if (!Array.isArray(reservations) || !reservations.length || !reservations.every(item => typeof item.reservationId === 'string') || typeof winnerProfileId !== 'string') {
      throw new StoreError('Dữ liệu thanh toán không hợp lệ.', 'SETTLEMENT_INVALID');
    }
    const payload = { reservationIds: reservations.map(item => item.reservationId).sort(), winnerProfileId, roomCode, matchId };
    return this.executeOperation('settle_winner_takes_pot', operationKey, payload, at => {
      const rows = reservations.map(item => this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(item.reservationId));
      if (rows.some(row => !row || row.status !== 'HELD')) throw new StoreError('Khoản giữ không còn khả dụng để thanh toán.', 'RESERVATION_NOT_HELD');
      if (!rows.some(row => row.profile_id === winnerProfileId)) throw new StoreError('Người thắng không có trong bàn.', 'WINNER_INVALID');
      const pot = rows.reduce((sum, row) => sum + row.amount, 0);
      for (const row of rows) {
        this.writeWallet(row.profile_id, 0, -row.amount, { operationKey, source: 'settlement', roomCode, matchId, note: 'Đóng khoản giữ sau ván', at });
        this.db.prepare("UPDATE reservations SET status = 'SETTLED', closed_at = ? WHERE id = ?").run(at, row.id);
      }
      const winnerWallet = this.writeWallet(winnerProfileId, pot, 0, { operationKey, source: 'settlement', roomCode, matchId, note: 'Nhận pot của ván', at });
      return { pot, winnerProfileId, wallet: winnerWallet };
    });
  }

  // Fixed-stake games whose published rules include penalties need more than
  // winner-takes-pot.  The game engine supplies a complete, server-derived
  // zero-sum outcome; this method only releases the already-held maximum loss
  // and records the resulting transfer atomically.
  settleReservations({ reservations, outcomes, operationKey, roomCode, matchId, note = 'Thanh toán ván chip cố định' }) {
    if (!Array.isArray(reservations) || !reservations.length || !reservations.every(item => typeof item?.reservationId === 'string') ||
      !Array.isArray(outcomes) || outcomes.length !== reservations.length || !outcomes.every(item => typeof item?.profileId === 'string' && Number.isSafeInteger(item.delta))) {
      throw new StoreError('Dữ liệu thanh toán không hợp lệ.', 'SETTLEMENT_INVALID');
    }
    const reservationIds = reservations.map(item => item.reservationId);
    const outcomeIds = outcomes.map(item => item.profileId);
    if (new Set(reservationIds).size !== reservationIds.length || new Set(outcomeIds).size !== outcomeIds.length || outcomes.reduce((sum, item) => sum + item.delta, 0) !== 0) {
      throw new StoreError('Bảng thanh toán phải đủ người và bảo toàn chip.', 'SETTLEMENT_UNBALANCED');
    }
    const payload = { reservationIds: [...reservationIds].sort(), outcomes: [...outcomes].sort((a, b) => a.profileId.localeCompare(b.profileId)).map(item => ({ profileId: item.profileId, delta: item.delta })), roomCode, matchId, note };
    return this.executeOperation('settle_reservations', operationKey, payload, at => {
      const rows = reservations.map(item => this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(item.reservationId));
      if (rows.some(row => !row || row.status !== 'HELD')) throw new StoreError('Khoản giữ không còn khả dụng để thanh toán.', 'RESERVATION_NOT_HELD');
      const amounts = new Map(rows.map(row => [row.profile_id, row.amount]));
      if (amounts.size !== rows.length || outcomes.some(item => !amounts.has(item.profileId) || item.delta < -amounts.get(item.profileId))) {
        throw new StoreError('Khoản giữ không đủ cho bảng thanh toán.', 'SETTLEMENT_EXCEEDS_HOLD');
      }
      const settled = [];
      for (const row of rows) {
        const delta = outcomes.find(item => item.profileId === row.profile_id).delta;
        const wallet = this.writeWallet(row.profile_id, row.amount + delta, -row.amount, {
          operationKey, source: 'settlement', roomCode, matchId, note, at,
        });
        this.db.prepare("UPDATE reservations SET status = 'SETTLED', closed_at = ? WHERE id = ?").run(at, row.id);
        settled.push({ profileId: row.profile_id, delta, wallet });
      }
      return { outcomes: settled };
    });
  }

  releaseReservations({ reservations, operationKey, roomCode, matchId = null, note = 'Hoàn chip do ván bị hủy' }) {
    if (!Array.isArray(reservations) || !reservations.length) throw new StoreError('Không có khoản giữ để hoàn.', 'RESERVATION_INVALID');
    const payload = { reservationIds: reservations.map(item => item.reservationId).sort(), roomCode, matchId, note };
    return this.executeOperation('release_reservations', operationKey, payload, at => {
      const released = [];
      for (const item of reservations) {
        const row = this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(item.reservationId);
        if (!row || row.status !== 'HELD') throw new StoreError('Khoản giữ không còn khả dụng để hoàn.', 'RESERVATION_NOT_HELD');
        const wallet = this.writeWallet(row.profile_id, row.amount, -row.amount, { operationKey, source: 'release', roomCode, matchId, note, at });
        this.db.prepare("UPDATE reservations SET status = 'RELEASED', closed_at = ? WHERE id = ?").run(at, row.id);
        released.push({ reservationId: row.id, profileId: row.profile_id, wallet });
      }
      return { released };
    });
  }

  // Poker keeps chips in a table stack between hands.  The rows created for
  // each buy-in remain the accounting boundary; when a seat leaves, its
  // current (possibly won or lost) stack is moved back to the wallet in one
  // database transaction.  It deliberately does not accept a client-supplied
  // balance: the poker engine is the sole caller and supplies its persisted
  // server state.
  settlePokerSeat({ reservations, profileId, stack, operationKey, roomCode, matchId = null, note = 'Rút stack Poker về ví' }) {
    if (typeof profileId !== 'string' || !Number.isSafeInteger(stack) || stack < 0 || !Array.isArray(reservations) || !reservations.length || !reservations.every(item => typeof item?.reservationId === 'string')) {
      throw new StoreError('Dữ liệu cash-out Poker không hợp lệ.', 'POKER_CASHOUT_INVALID');
    }
    const payload = { reservationIds: reservations.map(item => item.reservationId).sort(), profileId, stack, roomCode, matchId, note };
    return this.executeOperation('poker_cashout', operationKey, payload, at => {
      const rows = reservations.map(item => this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(item.reservationId));
      if (rows.some(row => !row || row.status !== 'HELD' || row.profile_id !== profileId)) throw new StoreError('Khoản buy-in Poker không còn khả dụng.', 'POKER_CASHOUT_UNAVAILABLE');
      const reserved = rows.reduce((sum, row) => sum + row.amount, 0);
      const wallet = this.writeWallet(profileId, stack, -reserved, { operationKey, source: 'poker_cashout', roomCode, matchId, note, at });
      for (const row of rows) this.db.prepare("UPDATE reservations SET status = 'SETTLED', closed_at = ? WHERE id = ?").run(at, row.id);
      return { profileId, stack, reserved, wallet };
    });
  }

  syncRoom({ room, gameId }) {
    if (!room?.code || !gameId) return;
    const at = nowIso();
    const roomId = `room:${gameId}:${room.code}`;
    this.transaction(() => {
      this.db.prepare(`INSERT INTO rooms(id, room_code, game_id, phase, created_at, updated_at, state_json) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(room_code) DO UPDATE SET game_id = excluded.game_id, phase = excluded.phase, updated_at = excluded.updated_at, state_json = excluded.state_json`)
        .run(roomId, room.code, gameId, room.phase || 'WAITING', at, at, JSON.stringify(room, (key, value) => ['token', 'socketId'].includes(key) ? undefined : value));
      const canonicalRoomId = this.db.prepare('SELECT id FROM rooms WHERE room_code = ?').get(room.code).id;
      this.db.prepare("UPDATE room_members SET status = 'LEFT', left_at = ? WHERE room_id = ? AND left_at IS NULL").run(at, canonicalRoomId);
      for (const player of room.players || []) {
        if (!player?.id) continue;
        this.db.prepare(`INSERT INTO room_members(member_id, room_id, profile_id, legacy_player_id, is_host, status, joined_at, left_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(member_id) DO UPDATE SET room_id = excluded.room_id, profile_id = excluded.profile_id, legacy_player_id = excluded.legacy_player_id, is_host = excluded.is_host, status = excluded.status, left_at = NULL
          ON CONFLICT(room_id, profile_id) DO UPDATE SET member_id = excluded.member_id, legacy_player_id = excluded.legacy_player_id, is_host = excluded.is_host, status = excluded.status, joined_at = excluded.joined_at, left_at = NULL`)
          .run(`member:${gameId}:${room.code}:${player.id}`, canonicalRoomId, this.publicProfile(player.profileId) ? player.profileId : null, player.id, player.isHost ? 1 : 0,
            player.connected ? 'ACTIVE' : 'DISCONNECTED', at);
      }
      if (gameId === 'poker') this.saveGameSnapshot({ gameId, room });
    });
  }

  // Private recovery state lives in the same transaction as the chip ledger.
  // JSON room files remain compatibility exports, never the Poker commit boundary.
  saveGameSnapshot({ gameId, room }) {
    this.db.prepare(`INSERT INTO game_snapshots(game_id, room_code, state_json, updated_at, closed_at)
      VALUES (?, ?, ?, ?, NULL) ON CONFLICT(game_id, room_code) DO UPDATE SET
      state_json = excluded.state_json, updated_at = excluded.updated_at, closed_at = NULL`)
      .run(gameId, room.code, JSON.stringify(room, (key, value) => key === 'socketId' ? undefined : value), nowIso());
  }

  gameSnapshots(gameId) {
    return this.db.prepare('SELECT room_code AS roomCode, state_json AS stateJson, closed_at AS closedAt FROM game_snapshots WHERE game_id = ?').all(gameId);
  }

  closeGameRoom(gameId, roomCode) {
    const at = nowIso();
    this.db.prepare(`INSERT INTO game_snapshots(game_id, room_code, state_json, updated_at, closed_at)
      VALUES (?, ?, NULL, ?, ?) ON CONFLICT(game_id, room_code) DO UPDATE SET state_json = NULL, updated_at = excluded.updated_at, closed_at = excluded.closed_at`)
      .run(gameId, roomCode, at, at);
    this.db.prepare("UPDATE room_members SET status = 'LEFT', left_at = ? WHERE room_id IN (SELECT id FROM rooms WHERE room_code = ? AND game_id = ?) AND left_at IS NULL").run(at, roomCode, gameId);
    this.db.prepare("UPDATE rooms SET phase = 'CLOSED', updated_at = ? WHERE room_code = ? AND game_id = ?").run(at, roomCode, gameId);
  }

  expireFixedRoom({ gameId, roomCode, matchId }) {
    return this.transaction(() => {
      const held = this.db.prepare("SELECT id AS reservationId FROM reservations WHERE room_code = ? AND match_id IS ? AND status = 'HELD' ORDER BY id").all(roomCode, matchId || null);
      if (held.length) this.releaseReservations({ reservations: held, operationKey: `${gameId}:expiry-v2:${matchId}`, roomCode, matchId,
        note: `Hoàn chip: phòng ${gameId} hết hạn` });
      this.closeGameRoom(gameId, roomCode);
    });
  }

  markMemberLeft({ gameId, roomCode, playerId }) {
    if (!gameId || !roomCode || !playerId) return;
    const at = nowIso();
    this.db.prepare("UPDATE room_members SET status = 'LEFT', left_at = ? WHERE member_id = ?")
      .run(at, `member:${gameId}:${roomCode}:${playerId}`);
  }

  recordCompletedMatch({ matchId, gameId, roomCode, players, result, completedAt }) {
    if (typeof matchId !== 'string' || typeof gameId !== 'string' || !Array.isArray(players)) throw new StoreError('Kết quả ván không hợp lệ.', 'MATCH_INVALID');
    const completed = completedAt || nowIso(), period = vietnamDay(completed), profiles = [...new Set(players.map(player => player?.profileId).filter(Boolean))];
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT match_id FROM matches WHERE match_id = ?').get(matchId);
      if (previous) return { recorded: false, period };
      const room = roomCode ? this.db.prepare('SELECT id FROM rooms WHERE room_code = ?').get(roomCode) : null;
      this.db.prepare(`INSERT INTO matches(match_id, room_id, game_id, completed_at, mission_period, status, result_json) VALUES (?, ?, ?, ?, ?, 'COMPLETED', ?)`)
        .run(matchId, room?.id || null, gameId, completed, period, JSON.stringify(result || {}));
      this.db.prepare('INSERT INTO match_snapshots(id, match_id, committed_at, snapshot_json) VALUES (?, ?, ?, ?)')
        .run(crypto.randomUUID(), matchId, nowIso(), JSON.stringify({ gameId, roomCode: roomCode || null, matchId, result: result || {} }));
      for (const player of players) {
        if (!player?.profileId || !this.publicProfile(player.profileId)) continue;
        this.db.prepare('INSERT INTO match_players(match_id, profile_id, outcome) VALUES (?, ?, ?)').run(matchId, player.profileId, player.outcome || null);
      }
      for (const profileId of profiles) this.refreshMissionProgress(profileId, period);
      return { recorded: true, period };
    });
  }

  refreshMissionProgress(profileId, period) {
    const rows = this.db.prepare(`SELECT matches.match_id, matches.game_id FROM matches
      JOIN match_players ON match_players.match_id = matches.match_id
      WHERE match_players.profile_id = ? AND matches.mission_period = ? AND matches.status = 'COMPLETED'`).all(profileId, period);
    const matchIds = [...new Set(rows.map(row => row.match_id))], gameIds = [...new Set(rows.map(row => row.game_id))];
    for (const definition of MISSION_DEFINITIONS.filter(item => item.enabled)) {
      const progress = definition.kind === 'games' ? gameIds.length : matchIds.length;
      const evidence = definition.kind === 'games' ? { matchIds, gameIds } : { matchIds };
      this.db.prepare(`INSERT INTO mission_progress(profile_id, mission_id, version, period, progress, evidence_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, mission_id, version, period) DO UPDATE SET progress = excluded.progress, evidence_json = excluded.evidence_json, updated_at = excluded.updated_at`)
        .run(profileId, definition.id, definition.version, period, progress, JSON.stringify(evidence), nowIso());
    }
  }

  getMissions(profileId, period = vietnamDay()) {
    const claims = new Set(this.db.prepare("SELECT mission_id || ':' || version AS key FROM mission_claims WHERE profile_id = ? AND period = ?").all(profileId, period).map(row => row.key));
    const progressRows = new Map(this.db.prepare('SELECT mission_id, version, progress, evidence_json FROM mission_progress WHERE profile_id = ? AND period = ?').all(profileId, period)
      .map(row => [`${row.mission_id}:${row.version}`, row]));
    return MISSION_DEFINITIONS.map(definition => {
      const row = progressRows.get(`${definition.id}:${definition.version}`), progress = row?.progress || 0;
      return { id: definition.id, version: definition.version, description: definition.description, reward: definition.reward,
        threshold: definition.threshold, progress, period, enabled: Boolean(definition.enabled), complete: progress >= definition.threshold,
        claimed: claims.has(`${definition.id}:${definition.version}`), evidence: row ? JSON.parse(row.evidence_json) : { matchIds: [] } };
    });
  }

  claimMission(profileId, missionId, version, requestedPeriod) {
    const definition = MISSION_DEFINITIONS.find(item => item.id === missionId && item.version === Number(version));
    if (!definition || !definition.enabled) throw new StoreError('Nhiệm vụ này chưa mở.', 'MISSION_UNAVAILABLE');
    const period = requestedPeriod || vietnamDay();
    const age = (new Date(`${vietnamDay()}T00:00:00+07:00`) - new Date(`${period}T00:00:00+07:00`)) / 86400000;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period) || !Number.isInteger(age) || age < 0 || age >= 7) throw new StoreError('Kỳ nhiệm vụ đã hết hạn.', 'MISSION_EXPIRED');
    const operationKey = `mission:${profileId}:${missionId}:${definition.version}:${period}`;
    return this.executeOperation('mission_claim', operationKey, { profileId, missionId, version: definition.version, period }, at => {
      const progress = this.db.prepare(`SELECT progress FROM mission_progress WHERE profile_id = ? AND mission_id = ? AND version = ? AND period = ?`)
        .get(profileId, missionId, definition.version, period);
      if (!progress || progress.progress < definition.threshold) throw new StoreError('Bạn chưa hoàn thành nhiệm vụ này.', 'MISSION_INCOMPLETE');
      const existing = this.db.prepare(`SELECT 1 FROM mission_claims WHERE profile_id = ? AND mission_id = ? AND version = ? AND period = ?`)
        .get(profileId, missionId, definition.version, period);
      if (existing) throw new StoreError('Nhiệm vụ này đã được nhận thưởng.', 'MISSION_CLAIMED');
      const wallet = this.writeWallet(profileId, definition.reward, 0, { operationKey, source: 'mission', note: `Thưởng nhiệm vụ: ${definition.description}`, at });
      this.db.prepare(`INSERT INTO mission_claims(profile_id, mission_id, version, period, operation_key, claimed_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(profileId, missionId, definition.version, period, operationKey, at);
      return { missionId, version: definition.version, period, reward: definition.reward, wallet };
    });
  }
}

module.exports = { ProfileStore, StoreError, STARTING_CHIPS, MAX_CHIPS, vietnamDay };
