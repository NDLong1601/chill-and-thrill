'use strict';

// M3 persistence boundary.  All values that can affect a wallet are changed
// inside one SQLite transaction; browsers only receive the resulting summary.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { CURRENCIES, COIN_PER_GEM, STARTING_COINS, validateAmount: validateCurrencyAmount } = require('./currencies');
const { VERSION: TUTORIAL_VERSION } = require('../../public/js/tutorial-content');
const { cleanDisplayName } = require('../../public/js/game-values');

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
const cleanName = value => cleanDisplayName(value) || 'Player';
const cleanAvatar = value => AVATARS.has(value) ? value : '🕶️';
function safeSum(values, code = 'AMOUNT_OVERFLOW') {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum)) throw new StoreError('Tổng tiền vượt giới hạn số nguyên an toàn.', code);
  }
  return sum;
}
function isSQLiteError(error) {
  return error?.code === 'ERR_SQLITE_ERROR' ||
    (typeof error?.code === 'string' && error.code.startsWith('SQLITE_')) || Number.isInteger(error?.errcode);
}
const stableJson = value => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const payloadHash = value => tokenHash(stableJson(value));
const HISTORY_GAME_IDS = new Set(['the-gang', 'uno', 'tien-len', 'poker', 'sam-loc', 'phom', 'bang']);
const HISTORY_GROUPS = new Set(['match', 'hold', 'refund', 'settlement', 'exchange', 'reward', 'grant', 'other']);
const HISTORY_CURRENCIES = new Set(['chip', 'coin', 'gem']);
const HISTORY_KINDS = Object.freeze({
  reserve_many: ['hold', 'Giữ tiền vào phòng'],
  release_reservations: ['refund', 'Hoàn khoản đang giữ'],
  settle_winner_takes_pot: ['settlement', 'Thanh toán kết quả ván'],
  settle_reservations: ['settlement', 'Thanh toán kết quả ván'],
  poker_cashout: ['settlement', 'Rút stack Poker về ví'],
  currency_exchange: ['exchange', 'Quy đổi coin/gem'],
  mission_claim: ['reward', 'Nhận thưởng nhiệm vụ'],
  bootstrap: ['grant', 'Cấp số dư khởi đầu'],
  coin_bootstrap: ['grant', 'Cấp coin khởi đầu'],
});
function vietnamDay(input = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(input));
  const part = type => parts.find(value => value.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const MISSION_DEFINITIONS = Object.freeze([
  { id: 'daily_match', version: 1, kind: 'matches', threshold: 1, reward: 100, description: 'Hoàn thành 1 ván hợp lệ hôm nay', enabled: 1 },
  { id: 'daily_three_matches', version: 1, kind: 'matches', threshold: 3, reward: 200, description: 'Hoàn thành 3 ván hợp lệ hôm nay', enabled: 1 },
  { id: 'daily_two_games', version: 1, kind: 'games', threshold: 2, reward: 150, description: 'Hoàn thành 2 game khác nhau hôm nay', enabled: 1 },
  { id: 'tutorial_verified', version: 1, kind: 'tutorial', threshold: 1, reward: 200, description: 'Hoàn thành hướng dẫn đã được máy chủ xác minh · thưởng một lần theo phiên bản', enabled: 1 },
]);

class ProfileStore {
  constructor(options = {}) {
    this.databaseFile = options.databaseFile || ':memory:';
    this.readOnly = options.readOnly === true;
    this.legacyRoomsFile = options.legacyRoomsFile || null;
    this.storageDiagnostics = options.storageDiagnostics || null;
    this.storageSafetyRefresh = null;
    this.storageFixture = options.storageFixture === true;
    this.databaseKind = this.databaseFile === ':memory:' ? 'memory' : 'sqlite';
    if (this.databaseFile !== ':memory:' && !this.readOnly) fs.mkdirSync(path.dirname(this.databaseFile), { recursive: true });
    this.db = new DatabaseSync(this.databaseFile, this.readOnly ? { readOnly: true } : {});
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.storageDiagnostics?.setDatabaseStatus({ kind: this.databaseKind, fixture: this.storageFixture, integrity: 'unknown' });
    if (!this.readOnly) {
      if (this.databaseFile !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
      this.migrate();
      this.backupAndImportLegacyRooms();
    }
  }

  close() { if (this.closed) return; this.closed = true; this.db.close(); }

  attachStorageDiagnostics(diagnostics, { fixture = this.storageFixture } = {}) {
    this.storageDiagnostics = diagnostics || null;
    this.storageFixture = fixture === true;
    this.storageDiagnostics?.setDatabaseStatus({ kind: this.databaseKind, fixture: this.storageFixture });
    return this;
  }

  schemaVersion() { return this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? null; }
  integrityCheck() { return Object.values(this.db.prepare('PRAGMA integrity_check').get() || {})[0] || 'unknown'; }

  hasStorageSource(sourceId) { return Boolean(this.storageDiagnostics?.hasSource?.(sourceId)); }

  setStorageSafetyRefresh(refresh) {
    this.storageSafetyRefresh = typeof refresh === 'function' ? refresh : null;
    return this;
  }

  storageFailureCode(operation) {
    return operation === 'commit' ? 'SQLITE_COMMIT_FAILED' : operation === 'read' ? 'SQLITE_READ_FAILED' : 'SQLITE_WRITE_FAILED';
  }

  recordStorageRead(sourceId, stage, work, { recoveryVerified = false } = {}) {
    const diagnostics = this.storageDiagnostics;
    if (!diagnostics?.hasSource?.(sourceId)) return work();
    diagnostics.begin(sourceId, 'read', stage);
    try {
      const result = work();
      diagnostics.succeed(sourceId, 'read', { stage, recoveryVerified });
      return result;
    } catch (error) {
      diagnostics.fail(sourceId, 'read', { stage, code: this.storageFailureCode('read') });
      if (sourceId === 'profile-store') diagnostics.setDatabaseStatus({ operational: false, errorCode: this.storageFailureCode('read') });
      throw error;
    }
  }

  storageHealth() {
    const diagnostics = this.storageDiagnostics;
    const sourceId = 'profile-store';
    if (!diagnostics?.hasSource?.(sourceId)) {
      return { database: this.databaseKind, schemaVersion: this.schemaVersion(), integrity: this.integrityCheck() };
    }
    diagnostics.begin(sourceId, 'read', 'schema-integrity-check');
    let failureCode = 'SQLITE_HEALTH_CHECK_FAILED';
    try {
      const schemaVersion = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? null;
      if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 4) {
        failureCode = 'SQLITE_SCHEMA_INCOMPLETE';
        throw new Error('Required ProfileStore schema is incomplete');
      }
      for (const table of ['profiles', 'sessions', 'rooms', 'room_members', 'matches', 'match_players', 'match_snapshots',
        'wallets', 'wallet_operations', 'wallet_ledger', 'reservations', 'mission_definitions', 'mission_progress',
        'mission_claims', 'admin_audit', 'game_snapshots', 'tutorial_verifications']) {
        this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      }
      const integrity = Object.values(this.db.prepare('PRAGMA integrity_check').get() || {})[0];
      const safeIntegrity = integrity === 'ok' ? 'ok' : 'error';
      diagnostics.succeed(sourceId, 'read', { stage: 'schema-integrity-check', recoveryVerified: safeIntegrity === 'ok' });
      diagnostics.setDatabaseStatus({ kind: this.databaseKind, fixture: this.storageFixture, schemaVersion,
        integrity: safeIntegrity, operational: safeIntegrity === 'ok', errorCode: safeIntegrity === 'ok' ? undefined : 'SQLITE_INTEGRITY_FAILED' });
      return { database: this.databaseKind, schemaVersion, integrity: safeIntegrity };
    } catch {
      diagnostics.fail(sourceId, 'read', { stage: 'schema-integrity-check', code: failureCode });
      diagnostics.setDatabaseStatus({ kind: this.databaseKind, fixture: this.storageFixture, integrity: 'error', operational: false,
        errorCode: failureCode });
      return { database: this.databaseKind, schemaVersion: null, integrity: 'error' };
    }
  }

  heldReservationCount() {
    return this.recordStorageRead('profile-store', 'held-count', () =>
      this.db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE status = 'HELD'").get().count);
  }

  assertWagerStorageSafe() {
    if (!this.storageDiagnostics) return;
    // Reconcile manager flags, SQL health, and HELD reservations at the point
    // of use. This runs before a new reservation mutates the wallet, including
    // while the caller owns an outer SQLite transaction.
    this.storageSafetyRefresh?.();
    const status = this.storageDiagnostics.getStatus({ ignorePending: true });
    if (!status.canStartWager) throw new StoreError(status.blockedReason || 'Nguồn lưu trữ chưa an toàn; chưa thể bắt đầu ván cược mới.', 'STORAGE_UNSAFE');
  }

  trackSnapshotMutation(gameId, stage, work) {
    const diagnostics = this.storageDiagnostics;
    const sourceId = `snapshot:${gameId}`;
    if (!diagnostics?.hasSource?.(sourceId)) return work();
    diagnostics.begin(sourceId, 'write', stage);
    if (this.transactionDepth) {
      this.pendingSnapshotSources?.add(sourceId);
      try { return work(); }
      catch (error) { diagnostics.fail(sourceId, 'write', { stage, code: 'SQLITE_SNAPSHOT_WRITE_FAILED' }); throw error; }
    }
    diagnostics.begin(sourceId, 'commit', 'sqlite-autocommit');
    try {
      const result = work();
      diagnostics.succeed(sourceId, 'write', { stage });
      diagnostics.succeed(sourceId, 'commit', { stage: 'sqlite-autocommit' });
      return result;
    } catch (error) {
      diagnostics.cancel(sourceId, 'commit', 'statement-failed');
      diagnostics.fail(sourceId, 'write', { stage, code: 'SQLITE_SNAPSHOT_WRITE_FAILED' });
      throw error;
    }
  }

  transaction(work) {
    if (this.readOnly) throw new StoreError('ProfileStore đang mở chỉ đọc.', 'STORE_READ_ONLY');
    const nested = Boolean(this.transactionDepth);
    const root = !nested;
    const savepoint = `nested_${this.transactionDepth || 0}`;
    const diagnostics = this.storageDiagnostics;
    const sourceId = 'profile-store';
    const hasSource = Boolean(diagnostics?.hasSource?.(sourceId));
    const snapshotSources = root ? new Set() : this.pendingSnapshotSources;
    if (root) {
      this.pendingSnapshotSources = snapshotSources;
      if (hasSource) diagnostics.begin(sourceId, 'write', 'sqlite-transaction');
    }
    try { this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE'); }
    catch (error) {
      if (root && hasSource && isSQLiteError(error)) {
        diagnostics.fail(sourceId, 'write', { stage: 'begin-transaction', code: 'SQLITE_WRITE_FAILED' });
        diagnostics.setDatabaseStatus({ operational: false, errorCode: 'SQLITE_WRITE_FAILED' });
      } else if (root && hasSource) diagnostics.cancel(sourceId, 'write', 'begin-aborted');
      if (root) this.pendingSnapshotSources = null;
      throw error;
    }
    this.transactionDepth = (this.transactionDepth || 0) + 1;
    try {
      const result = work();
      if (nested) this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      else {
        if (hasSource) diagnostics.begin(sourceId, 'commit', 'sqlite-commit');
        for (const snapshotSource of snapshotSources) diagnostics.begin(snapshotSource, 'commit', 'sqlite-commit');
        try { this.db.exec('COMMIT'); }
        catch (error) {
          if (hasSource) {
            diagnostics.fail(sourceId, 'commit', { stage: 'sqlite-commit', code: 'SQLITE_COMMIT_FAILED' });
            diagnostics.fail(sourceId, 'write', { stage: 'sqlite-commit', code: 'SQLITE_COMMIT_FAILED' });
            diagnostics.setDatabaseStatus({ operational: false, errorCode: 'SQLITE_COMMIT_FAILED' });
          }
          for (const snapshotSource of snapshotSources) {
            diagnostics.fail(snapshotSource, 'commit', { stage: 'sqlite-commit', code: 'SQLITE_COMMIT_FAILED' });
            diagnostics.fail(snapshotSource, 'write', { stage: 'sqlite-commit', code: 'SQLITE_COMMIT_FAILED' });
          }
          throw error;
        }
        if (hasSource) {
          diagnostics.succeed(sourceId, 'write', { stage: 'sqlite-transaction' });
          diagnostics.succeed(sourceId, 'commit', { stage: 'sqlite-commit' });
          diagnostics.setDatabaseStatus({ operational: true });
        }
        for (const snapshotSource of snapshotSources) {
          diagnostics.succeed(snapshotSource, 'write', { stage: 'sqlite-snapshot' });
          diagnostics.succeed(snapshotSource, 'commit', { stage: 'sqlite-commit' });
        }
      }
      return result;
    } catch (error) {
      let rollbackFailed = false;
      try { this.db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK'); if (nested) this.db.exec(`RELEASE SAVEPOINT ${savepoint}`); }
      catch { rollbackFailed = true; }
      if (root && hasSource && isSQLiteError(error) && diagnostics.getStatus({ ignorePending: true }).failures.every(item => item.sourceId !== sourceId)) {
        diagnostics.fail(sourceId, 'write', { stage: 'sqlite-statement', code: 'SQLITE_WRITE_FAILED' });
        diagnostics.setDatabaseStatus({ operational: false, errorCode: 'SQLITE_WRITE_FAILED' });
      } else if (root && hasSource && !diagnostics.getStatus({ ignorePending: true }).failures.some(item => item.sourceId === sourceId && item.operation === 'commit' && item.state === 'error')) {
        diagnostics.cancel(sourceId, 'write', 'transaction-rolled-back');
      }
      for (const snapshotSource of snapshotSources) {
        const faulted = diagnostics.getStatus({ ignorePending: true }).failures.some(item => item.sourceId === snapshotSource);
        if (rollbackFailed || isSQLiteError(error)) {
          if (!faulted) diagnostics.fail(snapshotSource, 'write', { stage: 'transaction-rolled-back', code: 'SQLITE_WRITE_FAILED' });
        } else diagnostics.cancel(snapshotSource, 'write', 'transaction-rolled-back');
      }
      if (rollbackFailed && hasSource) diagnostics.setDatabaseStatus({ operational: false, errorCode: 'SQLITE_ROLLBACK_FAILED' });
      throw error;
    } finally {
      this.transactionDepth--;
      if (root) this.pendingSnapshotSources = null;
    }
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
      [3, `
        ALTER TABLE wallets ADD COLUMN coin_available INTEGER NOT NULL DEFAULT 1000 CHECK(coin_available >= 0 AND coin_available <= 1000000000000);
        ALTER TABLE wallets ADD COLUMN coin_reserved INTEGER NOT NULL DEFAULT 0 CHECK(coin_reserved >= 0 AND coin_reserved <= 1000000000000);
        ALTER TABLE wallets ADD COLUMN gem_available INTEGER NOT NULL DEFAULT 0 CHECK(gem_available >= 0 AND gem_available <= 100000000);
        ALTER TABLE wallets ADD COLUMN gem_reserved INTEGER NOT NULL DEFAULT 0 CHECK(gem_reserved >= 0 AND gem_reserved <= 100000000);
        ALTER TABLE reservations ADD COLUMN currency TEXT NOT NULL DEFAULT 'chip' CHECK(currency IN ('chip', 'coin', 'gem'));
        ALTER TABLE wallet_ledger ADD COLUMN currency TEXT NOT NULL DEFAULT 'chip' CHECK(currency IN ('chip', 'coin', 'gem'));
        INSERT INTO wallet_operations(idempotency_key, kind, payload_hash, result_json, created_at)
          SELECT 'coin-bootstrap:' || profile_id, 'coin_bootstrap', profile_id, '{"available":1000,"reserved":0}', updated_at FROM wallets;
        INSERT INTO wallet_ledger(id, operation_key, profile_id, available_delta, reserved_delta, source, note, created_at, currency)
          SELECT 'coin-bootstrap:' || profile_id, 'coin-bootstrap:' || profile_id, profile_id, 1000, 0, 'bootstrap', 'Cấp coin khởi đầu', updated_at, 'coin' FROM wallets;
      `],
      [4, `CREATE TABLE tutorial_verifications (
        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        version TEXT NOT NULL, verified_at TEXT NOT NULL, operation_key TEXT NOT NULL UNIQUE,
        PRIMARY KEY(profile_id, version)
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
    this.db.prepare("UPDATE mission_definitions SET enabled = 1 WHERE mission_id = 'tutorial_verified' AND version = 1").run();
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
    return { id: profile.id, displayName: cleanName(profile.display_name), avatar: profile.avatar, createdAt: profile.created_at,
      wallet: { available: wallet.available, reserved: wallet.reserved },
      balances: Object.fromEntries(Object.keys(CURRENCIES).map(currency => [currency, this.walletForUpdate(profileId, currency)])),
      exchangeRate: { coinPerGem: COIN_PER_GEM } };
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
      this.db.prepare(`INSERT INTO wallet_ledger(id, operation_key, profile_id, available_delta, reserved_delta, source, note, created_at, currency)
        VALUES (?, ?, ?, ?, 0, 'bootstrap', 'Cấp coin khởi đầu', ?, 'coin')`).run(crypto.randomUUID(), operationKey, id, STARTING_COINS, at);
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
    return this.db.prepare(`SELECT available_delta AS availableDelta, reserved_delta AS reservedDelta, currency, source, room_code AS roomCode,
      match_id AS matchId, note, created_at AS createdAt FROM wallet_ledger WHERE profile_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(profileId, Math.max(1, Math.min(100, Number(limit) || 20)));
  }

  listHistoryPage(profileId, filters = {}) {
    if (!this.db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(profileId)) throw new StoreError('Hồ sơ không còn tồn tại.', 'PROFILE_NOT_FOUND');
    const allowed = new Set(['from', 'to', 'gameId', 'roomCode', 'group', 'currency', 'limit', 'cursor']);
    if (!filters || typeof filters !== 'object' || Array.isArray(filters) || Object.keys(filters).some(key => !allowed.has(key))) {
      throw new StoreError('Bộ lọc lịch sử không hợp lệ.', 'HISTORY_FILTER_INVALID');
    }
    const readString = (name, maxLength = 200) => {
      const value = filters[name];
      if (value === undefined) return null;
      if (typeof value !== 'string' || !value.length || value.length > maxLength) throw new StoreError(`Tham số ${name} không hợp lệ.`, 'HISTORY_FILTER_INVALID');
      return value;
    };
    const parseDay = name => {
      const value = readString(name, 10);
      if (value === null) return null;
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
      if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new StoreError(`Ngày ${name === 'from' ? 'từ' : 'đến'} phải có dạng YYYY-MM-DD.`, 'HISTORY_DATE_INVALID');
      }
      return value;
    };
    const from = parseDay('from'), to = parseDay('to');
    if (from && to) {
      const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
      if (spanDays < 0) throw new StoreError('Ngày bắt đầu phải trước hoặc trùng ngày kết thúc.', 'HISTORY_DATE_RANGE_INVALID');
      if (spanDays > 365) throw new StoreError('Mỗi lần tìm lịch sử chỉ lọc tối đa 366 ngày.', 'HISTORY_RANGE_TOO_WIDE');
    }
    const gameId = readString('gameId', 32);
    if (gameId && !HISTORY_GAME_IDS.has(gameId)) throw new StoreError('Game lọc không hợp lệ.', 'HISTORY_GAME_INVALID');
    const roomCode = readString('roomCode', 64);
    if (roomCode && !/^[a-zA-Z0-9_-]+$/.test(roomCode)) throw new StoreError('Mã phòng chỉ được gồm chữ, số, gạch ngang hoặc gạch dưới.', 'HISTORY_ROOM_INVALID');
    const group = readString('group', 24);
    if (group && !HISTORY_GROUPS.has(group)) throw new StoreError('Nhóm lịch sử không hợp lệ.', 'HISTORY_GROUP_INVALID');
    const currency = readString('currency', 32);
    if (currency && !HISTORY_CURRENCIES.has(currency)) throw new StoreError('Đơn vị tiền lọc không hợp lệ.', 'HISTORY_CURRENCY_INVALID');
    let limit = 25;
    if (filters.limit !== undefined) {
      if (typeof filters.limit !== 'string' || !/^\d{1,3}$/.test(filters.limit)) throw new StoreError('Số mục mỗi trang phải là số nguyên từ 1 đến 50.', 'HISTORY_LIMIT_INVALID');
      limit = Number(filters.limit);
      if (limit < 1 || limit > 50) throw new StoreError('Số mục mỗi trang phải từ 1 đến 50.', 'HISTORY_LIMIT_INVALID');
    }
    let cursor = null;
    if (filters.cursor !== undefined) {
      const raw = readString('cursor', 640);
      try {
        const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (!decoded || typeof decoded.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(decoded.createdAt) || !Number.isFinite(Date.parse(decoded.createdAt)) ||
          !['match', 'transaction'].includes(decoded.eventType) || typeof decoded.eventRef !== 'string' || !decoded.eventRef.length || decoded.eventRef.length > 256) throw new Error('invalid cursor');
        cursor = decoded;
      } catch { throw new StoreError('Con trỏ trang lịch sử không hợp lệ hoặc đã hết hạn.', 'HISTORY_CURSOR_INVALID'); }
    }
    const roomLower = roomCode?.toLowerCase() || null;
    const fromUtc = from ? new Date(`${from}T00:00:00+07:00`).toISOString() : null;
    const toUtc = to ? new Date(Date.parse(`${to}T00:00:00+07:00`) + 86400000).toISOString() : null;
    const rows = this.db.prepare(`WITH transaction_events AS (
        SELECT 'transaction' AS eventType, l.operation_key AS eventRef, MAX(l.created_at) AS createdAt,
          MAX(l.room_code) AS roomCode, MAX(l.match_id) AS matchId,
          COALESCE(MAX(m.game_id),
            CASE WHEN l.operation_key LIKE 'poker:buyin:%' OR l.operation_key LIKE 'poker:cashout:%' THEN 'poker'
                 WHEN l.operation_key LIKE 'tien-len:%' THEN 'tien-len'
                 WHEN l.operation_key LIKE 'sam-loc:%' THEN 'sam-loc'
                 WHEN l.operation_key LIKE 'phom:%' THEN 'phom'
                 ELSE MAX(r.game_id) END) AS gameId,
          o.kind AS operationKind,
          CASE o.kind WHEN 'reserve_many' THEN 'hold' WHEN 'release_reservations' THEN 'refund'
            WHEN 'settle_winner_takes_pot' THEN 'settlement' WHEN 'settle_reservations' THEN 'settlement'
            WHEN 'poker_cashout' THEN 'settlement' WHEN 'currency_exchange' THEN 'exchange'
            WHEN 'mission_claim' THEN 'reward' WHEN 'bootstrap' THEN 'grant' WHEN 'coin_bootstrap' THEN 'grant'
            ELSE 'other' END AS historyGroup,
          NULL AS outcome, NULL AS resultJson, NULL AS snapshotJson
        FROM wallet_ledger l
        JOIN wallet_operations o ON o.idempotency_key = l.operation_key
        LEFT JOIN matches m ON m.match_id = l.match_id
        LEFT JOIN rooms r ON r.room_code = l.room_code
        WHERE l.profile_id = ?
        GROUP BY l.operation_key, o.kind
      ), match_events AS (
        SELECT 'match' AS eventType, m.match_id AS eventRef, m.completed_at AS createdAt,
          CASE WHEN json_valid(ms.snapshot_json) THEN json_extract(ms.snapshot_json, '$.roomCode') ELSE NULL END AS roomCode,
          m.match_id AS matchId, COALESCE(CASE WHEN json_valid(ms.snapshot_json) THEN json_extract(ms.snapshot_json, '$.gameId') ELSE NULL END, m.game_id) AS gameId,
          NULL AS operationKind, 'match' AS historyGroup, mp.outcome AS outcome,
          m.result_json AS resultJson, ms.snapshot_json AS snapshotJson
        FROM matches m
        JOIN match_players mp ON mp.match_id = m.match_id
        LEFT JOIN match_snapshots ms ON ms.id = (SELECT id FROM match_snapshots
          WHERE match_id = m.match_id ORDER BY committed_at DESC, id DESC LIMIT 1)
        WHERE mp.profile_id = ? AND m.status = 'COMPLETED'
      ), history_events AS (
        SELECT * FROM transaction_events UNION ALL SELECT * FROM match_events
      )
      SELECT eventType, eventRef, createdAt, roomCode, matchId, gameId, operationKind, historyGroup, outcome, resultJson, snapshotJson
      FROM history_events
      WHERE (? IS NULL OR createdAt >= ?) AND (? IS NULL OR createdAt < ?)
        AND (? IS NULL OR gameId = ?) AND (? IS NULL OR lower(roomCode) = ?)
        AND (? IS NULL OR historyGroup = ?)
        AND (? IS NULL OR (eventType = 'transaction' AND EXISTS (
          SELECT 1 FROM wallet_ledger cf WHERE cf.operation_key = eventRef AND cf.profile_id = ? AND cf.currency = ?)))
        AND (? IS NULL OR createdAt < ? OR (createdAt = ? AND (eventType > ? OR (eventType = ? AND eventRef > ?))))
      ORDER BY createdAt DESC, eventType ASC, eventRef ASC LIMIT ?`).all(
      profileId, profileId,
      fromUtc, fromUtc, toUtc, toUtc, gameId, gameId, roomLower, roomLower, group, group,
      currency, profileId, currency,
      cursor?.createdAt || null, cursor?.createdAt || null, cursor?.createdAt || null,
      cursor?.eventType || null, cursor?.eventType || null, cursor?.eventRef || null,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();
    const transactionRefs = rows.filter(row => row.eventType === 'transaction').map(row => row.eventRef);
    const receiptRows = transactionRefs.length ? this.db.prepare(`SELECT operation_key AS operationRef, currency,
        available_delta AS availableDelta, reserved_delta AS reservedDelta, source, note
      FROM wallet_ledger WHERE profile_id = ? AND operation_key IN (${transactionRefs.map(() => '?').join(',')})
      ORDER BY operation_key, currency, created_at, id`).all(profileId, ...transactionRefs) : [];
    const receipts = new Map();
    for (const row of receiptRows) {
      if (!receipts.has(row.operationRef)) receipts.set(row.operationRef, new Map());
      const byCurrency = receipts.get(row.operationRef);
      if (!byCurrency.has(row.currency)) byCurrency.set(row.currency, { currency: row.currency, availableDelta: 0, reservedDelta: 0, sources: new Set(), notes: new Set() });
      const summary = byCurrency.get(row.currency);
      summary.availableDelta += row.availableDelta;
      summary.reservedDelta += row.reservedDelta;
      summary.sources.add(row.source);
      summary.notes.add(row.note);
    }
    const safeNumber = value => Number.isSafeInteger(value) ? value : 0;
    const safeMatchSummary = raw => {
      let result;
      try { result = JSON.parse(raw || '{}'); } catch { result = {}; }
      if (!result || typeof result !== 'object' || Array.isArray(result)) return {};
      const summary = {};
      for (const key of ['kind', 'reason', 'winnerName', 'message', 'faction']) {
        if (typeof result[key] === 'string' && result[key].length) summary[key] = result[key].slice(0, 120);
      }
      for (const key of ['stake', 'pot', 'score', 'durationMs']) if (Number.isSafeInteger(result[key])) summary[key] = result[key];
      if (HISTORY_CURRENCIES.has(result.currency)) summary.currency = result.currency;
      if (typeof result.winnerProfileId === 'string') summary.won = result.winnerProfileId === profileId;
      else if (typeof result.won === 'boolean') summary.won = result.won;
      return summary;
    };
    const items = rows.map(row => {
      const id = crypto.createHash('sha256').update(`${row.eventType}:${row.eventRef}`).digest('hex');
      if (row.eventType === 'match') {
        const summary = safeMatchSummary(row.resultJson);
        let variant = null;
        if (row.gameId === 'uno') {
          try {
            const snapshot = JSON.parse(row.snapshotJson || '{}');
            const candidate = snapshot?.variant || snapshot?.result?.variant;
            if (['classic-local-v1', 'classic-108-v1'].includes(candidate)) variant = candidate;
          } catch { /* Older match snapshots may not contain public variant metadata. */ }
        }
        const outcome = row.outcome || (typeof summary.won === 'boolean' ? (summary.won ? 'WIN' : 'LOSS') : null);
        return { id, type: 'match', group: 'match', createdAt: row.createdAt, gameId: row.gameId,
          variant, roomCode: row.roomCode || null, matchId: row.matchId, outcome, result: summary };
      }
      const kind = HISTORY_KINDS[row.operationKind] || ['other', 'Ví biến động'];
      const currencyGroups = [...(receipts.get(row.eventRef)?.values() || [])].map(summary => ({
        currency: summary.currency, availableDelta: safeNumber(summary.availableDelta), reservedDelta: safeNumber(summary.reservedDelta),
        totalAssetDelta: safeNumber(summary.availableDelta + summary.reservedDelta),
        sources: [...summary.sources], notes: [...summary.notes],
      }));
      return { id, type: 'transaction', group: kind[0], label: kind[1], createdAt: row.createdAt,
        gameId: row.gameId || null, roomCode: row.roomCode || null, matchId: row.matchId || null,
        receipt: { source: [...new Set(currencyGroups.flatMap(item => item.sources))], currencies: currencyGroups,
          idempotentByOperationKey: true } };
    });
    const last = rows.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, eventType: last.eventType, eventRef: last.eventRef })).toString('base64url') : null;
    return { items, nextCursor, hasMore, filters: { from, to, gameId, roomCode: roomCode || null, group, currency, limit, timezone: 'Asia/Ho_Chi_Minh' } };
  }

  validateAmount(value, currency = 'chip') { return validateCurrencyAmount(value, currency); }

  preflightFixedGameStart({ gameId, stake, profileIds } = {}) {
    this.assertWagerStorageSafe();
    const playerCount = Array.isArray(profileIds) ? profileIds.length : 0;
    let limits;
    try { limits = require('./gameRegistry').getStakeLimits(gameId, playerCount); }
    catch (error) { throw new StoreError(error.message || 'Mức cược không hợp lệ.', error.code || 'STAKE_LIMIT'); }
    if (!this.validateAmount(stake, 'coin') || stake < limits.minStake || stake > limits.maxStake) {
      throw new StoreError('Mức cược vượt giới hạn giữ hoặc thanh toán của bàn.', 'STAKE_LIMIT');
    }
    if (!profileIds.every(id => typeof id === 'string') || new Set(profileIds).size !== playerCount) {
      throw new StoreError('Danh sách hồ sơ trong bàn không hợp lệ.', 'PLAYER_SET_INVALID');
    }
    const holdAmount = limits.holdFactor * stake;
    const maxNetGain = limits.maxNetGainFactor * stake;
    const grossPayout = limits.grossPayoutFactor * stake;
    if (![holdAmount, maxNetGain, grossPayout, playerCount * holdAmount, playerCount * grossPayout]
      .every(Number.isSafeInteger)) throw new StoreError('Khoản giữ hoặc thanh toán vượt giới hạn số nguyên an toàn.', 'AMOUNT_OVERFLOW');
    const maxBalance = CURRENCIES.coin.max;
    for (const profileId of profileIds) {
      const wallet = this.walletForUpdate(profileId, 'coin');
      if (wallet.available < holdAmount) throw new StoreError('Một người chơi không đủ coin để giữ mức tối đa của ván.', 'INSUFFICIENT_COINS');
      if (!Number.isSafeInteger(wallet.reserved + holdAmount) || wallet.reserved + holdAmount > maxBalance) {
        throw new StoreError('Ví không còn chỗ để giữ mức coin của ván.', 'WALLET_LIMIT');
      }
      if (!Number.isSafeInteger(wallet.available + maxNetGain) || wallet.available + maxNetGain > maxBalance) {
        throw new StoreError('Ván có thể trả thưởng vượt sức chứa coin của ví; hãy giảm số dư coin trước khi bắt đầu.', 'PAYOUT_CAPACITY');
      }
    }
    return { currency: 'coin', gameId, playerCount, stake, holdAmount, maxNetGain, grossPayout };
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

  walletForUpdate(profileId, currency = 'chip') {
    const columns = CURRENCIES[currency];
    if (!columns) throw new StoreError('Đơn vị tiền không hợp lệ.', 'CURRENCY_INVALID');
    const wallet = this.db.prepare(`SELECT ${columns.available} AS available, ${columns.reserved} AS reserved FROM wallets WHERE profile_id = ?`).get(profileId);
    if (!wallet) throw new StoreError('Ví không tồn tại.', 'WALLET_NOT_FOUND');
    return { available: wallet.available, reserved: wallet.reserved };
  }

  protectedCreditHeadroom(profileId, currency = 'coin') {
    if (currency !== 'coin') return 0;
    const rows = this.db.prepare(`SELECT id, amount, operation_key AS operationKey FROM reservations
      WHERE profile_id = ? AND currency = 'coin' AND status = 'HELD' ORDER BY operation_key, id`).all(profileId);
    if (!rows.length) return 0;
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.operationKey)) groups.set(row.operationKey, []);
      groups.get(row.operationKey).push(row);
    }
    const { getStakeLimits } = require('./gameRegistry');
    const exposures = [];
    for (const [operationKey, reservations] of groups) {
      const gameId = ['tien-len', 'sam-loc', 'phom'].find(id => operationKey.startsWith(`${id}:reserve:`));
      if (!gameId) {
        // Unknown legacy/manual coin holds can still be refunded. Preserve at
        // least that amount of capacity until their owner closes the hold.
        exposures.push(safeSum(reservations.map(row => row.amount)));
        continue;
      }
      const limits = getStakeLimits(gameId, this.db.prepare(`SELECT COUNT(*) AS count FROM reservations
        WHERE operation_key = ? AND currency = 'coin' AND status = 'HELD'`).get(operationKey).count);
      const heldAmount = reservations[0].amount;
      if (reservations.some(row => row.amount !== heldAmount) || heldAmount % limits.holdFactor !== 0) {
        throw new StoreError('Không thể xác định headroom của khoản giữ coin.', 'PAYOUT_HEADROOM_UNKNOWN');
      }
      const stake = heldAmount / limits.holdFactor;
      const grossPayout = limits.grossPayoutFactor * stake;
      if (!Number.isSafeInteger(stake) || !Number.isSafeInteger(grossPayout)) throw new StoreError('Headroom thanh toán vượt giới hạn an toàn.', 'AMOUNT_OVERFLOW');
      exposures.push(grossPayout);
    }
    return safeSum(exposures, 'AMOUNT_OVERFLOW');
  }

  walletCreditCapacity(profileId, currency = 'coin') {
    const wallet = this.walletForUpdate(profileId, currency);
    const protectedCredit = this.protectedCreditHeadroom(profileId, currency);
    return { currency, max: CURRENCIES[currency].max, available: wallet.available, protectedCredit,
      remaining: Math.max(0, CURRENCIES[currency].max - wallet.available - protectedCredit) };
  }

  reservationCurrency(reservations, fallback = 'coin') {
    const id = reservations?.[0]?.reservationId;
    return id ? this.db.prepare('SELECT currency FROM reservations WHERE id = ?').get(id)?.currency || fallback : fallback;
  }

  writeWallet(profileId, availableDelta, reservedDelta, { operationKey, source, roomCode = null, matchId = null, note, at, currency = 'chip', closeHold = false }) {
    if (!Number.isSafeInteger(availableDelta) || !Number.isSafeInteger(reservedDelta)) throw new StoreError('Biến động ví vượt giới hạn số nguyên an toàn.', 'AMOUNT_OVERFLOW');
    const wallet = this.walletForUpdate(profileId, currency), columns = CURRENCIES[currency], available = wallet.available + availableDelta, reserved = wallet.reserved + reservedDelta;
    if (!Number.isSafeInteger(available) || !Number.isSafeInteger(reserved)) {
      throw new StoreError('Số dư không đủ hoặc vượt giới hạn an toàn.', 'WALLET_LIMIT');
    }
    if (currency === 'coin' && availableDelta > 0 && !closeHold) {
      const protectedCredit = this.protectedCreditHeadroom(profileId, currency);
      if (!Number.isSafeInteger(available + protectedCredit) || available + protectedCredit > columns.max) {
        throw new StoreError('Khoản cộng coin sẽ chiếm headroom cần để thanh toán ván đang chơi.', 'PAYOUT_CAPACITY');
      }
    }
    if (available < 0 || reserved < 0 || available > columns.max || reserved > columns.max) {
      throw new StoreError('Số dư không đủ hoặc vượt giới hạn an toàn.', 'WALLET_LIMIT');
    }
    this.db.prepare(`UPDATE wallets SET ${columns.available} = ?, ${columns.reserved} = ?, updated_at = ? WHERE profile_id = ?`).run(available, reserved, at, profileId);
    this.db.prepare(`INSERT INTO wallet_ledger(id, operation_key, profile_id, available_delta, reserved_delta, source, room_code, match_id, note, created_at, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), operationKey, profileId, availableDelta, reservedDelta, source, roomCode, matchId, note, at, currency);
    return { available, reserved };
  }

  reserveMany({ reservations, operationKey, roomCode, matchId = null, currency = 'chip' }) {
    this.assertWagerStorageSafe();
    if (!['chip', 'coin'].includes(currency)) throw new StoreError('Đơn vị cược không hợp lệ.', 'CURRENCY_INVALID');
    if (!Array.isArray(reservations) || !reservations.length || !reservations.every(item => item && typeof item.profileId === 'string' && this.validateAmount(item.amount, currency))) {
      throw new StoreError(`Khoản giữ ${currency} không hợp lệ.`, 'RESERVATION_INVALID');
    }
    const profileIds = reservations.map(item => item.profileId);
    if (new Set(profileIds).size !== profileIds.length) throw new StoreError('Mỗi hồ sơ chỉ có một khoản giữ trong một thao tác.', 'RESERVATION_DUPLICATE');
    const payload = { reservations: reservations.map(item => ({ profileId: item.profileId, amount: item.amount })).sort((a, b) => a.profileId.localeCompare(b.profileId)), roomCode, matchId, ...(currency === 'chip' ? {} : { currency }) };
    return this.executeOperation('reserve_many', operationKey, payload, at => {
      // Check every participant before changing any wallet; this is the all-or-nothing boundary.
      for (const item of reservations) {
        if (this.walletForUpdate(item.profileId, currency).available < item.amount) throw new StoreError(`Một người chơi không đủ ${currency} để vào bàn.`, currency === 'chip' ? 'INSUFFICIENT_CHIPS' : 'INSUFFICIENT_COINS');
        const activeSeat = this.db.prepare("SELECT room_code FROM reservations WHERE profile_id = ? AND status = 'HELD'").get(item.profileId);
        if (activeSeat && activeSeat.room_code !== roomCode) throw new StoreError('Một hồ sơ không thể ngồi hai bàn có chip cùng lúc.', 'CHIP_SEAT_ACTIVE');
      }
      const held = [];
      for (const item of reservations) {
        const wallet = this.writeWallet(item.profileId, -item.amount, item.amount, { operationKey, source: 'reservation', roomCode, matchId, note: `Giữ ${currency} trước khi bắt đầu ván`, at, currency });
        const id = crypto.randomUUID();
        this.db.prepare(`INSERT INTO reservations(id, operation_key, profile_id, room_code, match_id, amount, status, created_at, currency)
          VALUES (?, ?, ?, ?, ?, ?, 'HELD', ?, ?)`)
          .run(id, operationKey, item.profileId, roomCode, matchId, item.amount, at, currency);
        held.push({ reservationId: id, profileId: item.profileId, amount: item.amount, wallet, currency });
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
      if (new Set(rows.map(row => row.currency)).size !== 1) throw new StoreError('Khoản giữ khác đơn vị.', 'CURRENCY_MISMATCH');
      const pot = safeSum(rows.map(row => row.amount));
      if (!this.validateAmount(pot, rows[0].currency)) throw new StoreError('Pot vượt giới hạn tiền tệ an toàn.', 'PAYOUT_LIMIT');
      for (const row of rows) {
        this.writeWallet(row.profile_id, 0, -row.amount, { operationKey, source: 'settlement', roomCode, matchId, note: 'Đóng khoản giữ sau ván', at, currency: row.currency, closeHold: true });
        this.db.prepare("UPDATE reservations SET status = 'SETTLED', closed_at = ? WHERE id = ?").run(at, row.id);
      }
      const winnerWallet = this.writeWallet(winnerProfileId, pot, 0, { operationKey, source: 'settlement', roomCode, matchId, note: 'Nhận pot của ván', at, currency: rows[0].currency, closeHold: true });
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
    if (new Set(reservationIds).size !== reservationIds.length || new Set(outcomeIds).size !== outcomeIds.length || safeSum(outcomes.map(item => item.delta), 'SETTLEMENT_OVERFLOW') !== 0) {
      throw new StoreError('Bảng thanh toán phải đủ người và bảo toàn chip.', 'SETTLEMENT_UNBALANCED');
    }
    const payload = { reservationIds: [...reservationIds].sort(), outcomes: [...outcomes].sort((a, b) => a.profileId.localeCompare(b.profileId)).map(item => ({ profileId: item.profileId, delta: item.delta })), roomCode, matchId, note };
    return this.executeOperation('settle_reservations', operationKey, payload, at => {
      const rows = reservations.map(item => this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(item.reservationId));
      if (rows.some(row => !row || row.status !== 'HELD')) throw new StoreError('Khoản giữ không còn khả dụng để thanh toán.', 'RESERVATION_NOT_HELD');
      const amounts = new Map(rows.map(row => [row.profile_id, row.amount]));
      if (new Set(rows.map(row => row.currency)).size !== 1) throw new StoreError('Khoản giữ khác đơn vị.', 'CURRENCY_MISMATCH');
      if (amounts.size !== rows.length || outcomes.some(item => !amounts.has(item.profileId) || item.delta < -amounts.get(item.profileId))) {
        throw new StoreError('Khoản giữ không đủ cho bảng thanh toán.', 'SETTLEMENT_EXCEEDS_HOLD');
      }
      if (rows.some(row => !Number.isSafeInteger(row.amount + outcomes.find(item => item.profileId === row.profile_id).delta))) {
        throw new StoreError('Khoản thanh toán vượt giới hạn số nguyên an toàn.', 'SETTLEMENT_OVERFLOW');
      }
      const settled = [];
      for (const row of rows) {
        const delta = outcomes.find(item => item.profileId === row.profile_id).delta;
        const wallet = this.writeWallet(row.profile_id, row.amount + delta, -row.amount, {
          operationKey, source: 'settlement', roomCode, matchId, note, at, currency: row.currency, closeHold: true,
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
      const rows = reservations.map(item => this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(item.reservationId));
      if (rows.some(row => !row || row.status !== 'HELD')) throw new StoreError('Khoản giữ không còn khả dụng để hoàn.', 'RESERVATION_NOT_HELD');
      if (new Set(rows.map(row => row.currency)).size !== 1) throw new StoreError('Khoản giữ khác đơn vị.', 'CURRENCY_MISMATCH');
      const released = [];
      for (const row of rows) {
        const wallet = this.writeWallet(row.profile_id, row.amount, -row.amount, { operationKey, source: 'release', roomCode, matchId, note, at, currency: row.currency, closeHold: true });
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
      if (rows.some(row => !row || row.status !== 'HELD' || row.profile_id !== profileId || row.currency !== 'chip')) throw new StoreError('Khoản buy-in Poker không còn khả dụng.', 'POKER_CASHOUT_UNAVAILABLE');
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
    return this.trackSnapshotMutation(gameId, 'sqlite-snapshot-upsert', () => {
      this.db.prepare(`INSERT INTO game_snapshots(game_id, room_code, state_json, updated_at, closed_at)
        VALUES (?, ?, ?, ?, NULL) ON CONFLICT(game_id, room_code) DO UPDATE SET
        state_json = excluded.state_json, updated_at = excluded.updated_at, closed_at = NULL`)
        .run(gameId, room.code, JSON.stringify(room, (key, value) => key === 'socketId' ? undefined : value), nowIso());
    });
  }

  gameSnapshots(gameId) {
    const diagnostics = this.storageDiagnostics, sourceId = `snapshot:${gameId}`;
    if (!diagnostics?.hasSource?.(sourceId)) return this.db.prepare('SELECT room_code AS roomCode, state_json AS stateJson, closed_at AS closedAt FROM game_snapshots WHERE game_id = ?').all(gameId);
    diagnostics.begin(sourceId, 'read', 'sqlite-snapshot-read');
    try {
      const snapshots = this.db.prepare('SELECT room_code AS roomCode, state_json AS stateJson, closed_at AS closedAt FROM game_snapshots WHERE game_id = ?').all(gameId);
      let verified = true;
      for (const snapshot of snapshots) {
        if (snapshot.closedAt) continue;
        try {
          const room = JSON.parse(snapshot.stateJson);
          if (!room || typeof room !== 'object' || room.code !== snapshot.roomCode) verified = false;
        } catch { verified = false; }
      }
      if (verified) diagnostics.succeed(sourceId, 'read', { stage: 'sqlite-snapshot-read', recoveryVerified: true });
      else diagnostics.fail(sourceId, 'read', { stage: 'sqlite-snapshot-validation', code: 'SQLITE_SNAPSHOT_INVALID' });
      return snapshots;
    } catch (error) {
      diagnostics.fail(sourceId, 'read', { stage: 'sqlite-snapshot-read', code: 'SQLITE_SNAPSHOT_READ_FAILED' });
      throw error;
    }
  }

  closeGameRoom(gameId, roomCode) {
    return this.trackSnapshotMutation(gameId, 'sqlite-snapshot-tombstone', () => {
      const at = nowIso();
      this.db.prepare(`INSERT INTO game_snapshots(game_id, room_code, state_json, updated_at, closed_at)
        VALUES (?, ?, NULL, ?, ?) ON CONFLICT(game_id, room_code) DO UPDATE SET state_json = NULL, updated_at = excluded.updated_at, closed_at = excluded.closed_at`)
        .run(gameId, roomCode, at, at);
      this.db.prepare("UPDATE room_members SET status = 'LEFT', left_at = ? WHERE room_id IN (SELECT id FROM rooms WHERE room_code = ? AND game_id = ?) AND left_at IS NULL").run(at, roomCode, gameId);
      this.db.prepare("UPDATE rooms SET phase = 'CLOSED', updated_at = ? WHERE room_code = ? AND game_id = ?").run(at, roomCode, gameId);
    });
  }

  auditFixedGameHolds(options = {}) {
    if (!options._storageTracked) return this.recordStorageRead('profile-store', 'fixed-game-held-audit', () =>
      this.auditFixedGameHolds({ ...options, _storageTracked: true }));
    const { legacyRooms = [], repairSafe = false } = options;
    const games = ['tien-len', 'sam-loc', 'phom'];
    const snapshots = new Map(), mirrorRooms = new Map();
    for (const gameId of games) {
      snapshots.set(gameId, new Map(this.gameSnapshots(gameId).map(row => [row.roomCode, row])));
      mirrorRooms.set(gameId, new Map(this.db.prepare('SELECT room_code AS roomCode, game_id AS gameId, phase, state_json AS stateJson FROM rooms WHERE game_id = ?').all(gameId).map(row => [row.roomCode, row])));
    }
    const oldRooms = new Map();
    for (const room of legacyRooms) if (room?.code) oldRooms.set(`${room.gameId || ''}\0${room.code}`, room);
    const held = this.db.prepare(`SELECT r.id AS reservationId, r.room_code AS roomCode, r.match_id AS matchId,
      r.profile_id AS profileId, r.amount, r.currency, r.operation_key AS operationKey
      FROM reservations r WHERE r.status = 'HELD' ORDER BY r.room_code, r.match_id, r.id`).all()
      .filter(row => games.some(gameId => row.operationKey.startsWith(`${gameId}:reserve:`)));
    const groups = new Map();
    for (const row of held) {
      const gameId = games.find(candidate => row.operationKey.startsWith(`${candidate}:reserve:`));
      const key = `${gameId}\0${row.roomCode}\0${row.matchId || ''}`;
      if (!groups.has(key)) groups.set(key, { gameId, roomCode: row.roomCode, matchId: row.matchId, holds: [] });
      groups.get(key).holds.push(row);
    }
    const report = [];
    for (const group of groups.values()) {
      const snapshot = snapshots.get(group.gameId).get(group.roomCode);
      const mirror = mirrorRooms.get(group.gameId).get(group.roomCode);
      const legacy = oldRooms.get(`${group.gameId}\0${group.roomCode}`) || oldRooms.get(`\0${group.roomCode}`);
      const decoded = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
      const current = snapshot && !snapshot.closedAt ? decoded(snapshot.stateJson) : null;
      const mirrored = decoded(mirror?.stateJson);
      const currentMatches = room => room && room.matchId === group.matchId;
      const activePhase = room => room && !['WAITING', 'RESULT', 'CANCELLED', 'CLOSED'].includes(room.phase);
      const activeSnapshot = currentMatches(current) && activePhase(current);
      const activeMirror = mirror?.phase !== 'CLOSED' && currentMatches(mirrored) && activePhase(mirrored);
      const activeLegacy = currentMatches(legacy) && activePhase(legacy);
      const holdsMatchRoom = room => Array.isArray(room?.reservations) && group.holds.every(hold => room.reservations.some(item => item.reservationId === hold.reservationId));
      const linkedActiveRoom = Boolean((activeSnapshot && holdsMatchRoom(current)) || (activeMirror && holdsMatchRoom(mirrored)) || (activeLegacy && holdsMatchRoom(legacy)));
      const completed = group.matchId && Boolean(this.db.prepare("SELECT 1 FROM matches WHERE match_id = ? AND status = 'COMPLETED'").get(group.matchId));
      const tombstoneEvidence = Boolean(snapshot?.closedAt && !snapshot.stateJson);
      const safeToRefund = tombstoneEvidence && !completed && !activeSnapshot && !activeMirror && !activeLegacy;
      const consistent = linkedActiveRoom && !completed;
      report.push({ ...group, holdCount: group.holds.length, amount: group.holds.reduce((sum, item) => sum + item.amount, 0),
        evidence: { snapshot: snapshot ? (snapshot.closedAt && !snapshot.stateJson ? 'TOMBSTONE' : current ? current.phase : 'INVALID') : 'MISSING',
          room: mirror?.phase || 'MISSING', legacyRoom: legacy?.phase || 'MISSING', completedMatch: Boolean(completed),
          activeSnapshot: Boolean(activeSnapshot), activeRoom: Boolean(activeMirror), activeLegacyRoom: Boolean(activeLegacy), linkedActiveRoom },
        safeToRefund, consistent, needsAttention: !consistent, status: consistent ? 'ACTIVE' : safeToRefund ? 'SAFE_TO_REFUND' : 'REVIEW', repaired: false });
    }
    if (repairSafe && !this.readOnly) {
      this.transaction(() => {
        for (const item of report.filter(row => row.safeToRefund)) {
          const reservations = item.holds.map(row => ({ reservationId: row.reservationId }));
          this.releaseReservations({ reservations, operationKey: `${item.gameId}:reconcile-safe-v1:${item.roomCode}:${item.matchId || 'no-match'}`,
            roomCode: item.roomCode, matchId: item.matchId, note: `Hoàn coin sau đối chiếu tombstone phòng ${item.gameId}` });
          this.closeGameRoom(item.gameId, item.roomCode);
          item.repaired = true;
        }
      });
    }
    return report;
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
      let variant = null;
      let participants = [];
      if (gameId === 'uno' && roomCode) {
        const persistedRoom = this.db.prepare('SELECT game_id AS gameId, state_json AS stateJson FROM rooms WHERE room_code = ?').get(roomCode);
        try {
          const state = persistedRoom?.gameId === 'uno' ? JSON.parse(persistedRoom.stateJson || '{}') : null;
          const sameMatch = state && (state.matchId === matchId || state.uno?.matchId === matchId);
          const candidate = sameMatch ? (state.variant || state.uno?.variant || state.config?.variant) : null;
          if (['classic-local-v1', 'classic-108-v1'].includes(candidate)) variant = candidate;
          if (sameMatch && Array.isArray(state.players)) {
            participants = state.players.filter(player => typeof player.id === 'string' && profiles.includes(player.profileId))
              .map(player => ({ seatId: player.id, profileId: player.profileId }));
          }
        } catch { /* Preserve a missing variant when the persisted room state is old or unreadable. */ }
      }
      this.db.prepare(`INSERT INTO matches(match_id, room_id, game_id, completed_at, mission_period, status, result_json) VALUES (?, ?, ?, ?, ?, 'COMPLETED', ?)`)
        .run(matchId, room?.id || null, gameId, completed, period, JSON.stringify(result || {}));
      this.db.prepare('INSERT INTO match_snapshots(id, match_id, committed_at, snapshot_json) VALUES (?, ?, ?, ?)')
        .run(crypto.randomUUID(), matchId, nowIso(), JSON.stringify({ gameId, roomCode: roomCode || null, matchId,
          ...(variant ? { variant } : {}), ...(participants.length ? { participants } : {}), result: result || {} }));
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
    for (const definition of MISSION_DEFINITIONS.filter(item => item.enabled && item.kind !== 'tutorial')) {
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
      if (definition.kind === 'tutorial') {
        const verification = this.db.prepare('SELECT verified_at AS verifiedAt FROM tutorial_verifications WHERE profile_id = ? AND version = ?').get(profileId, TUTORIAL_VERSION);
        const tutorialPeriod = `once:${TUTORIAL_VERSION}`;
        const claimed = Boolean(this.db.prepare('SELECT 1 FROM mission_claims WHERE profile_id = ? AND mission_id = ? AND version = ? AND period = ?').get(profileId, definition.id, definition.version, tutorialPeriod));
        return { id: definition.id, kind: 'tutorial', version: definition.version, tutorialVersion: TUTORIAL_VERSION,
          description: definition.description, reward: definition.reward, currency: 'coin', threshold: 1,
          progress: verification ? 1 : 0, period: tutorialPeriod, enabled: true, verified: Boolean(verification),
          complete: Boolean(verification), claimed, evidence: verification ? { tutorialVersion: TUTORIAL_VERSION, verifiedAt: verification.verifiedAt } : {} };
      }
      const row = progressRows.get(`${definition.id}:${definition.version}`), progress = row?.progress || 0;
      return { id: definition.id, kind: definition.kind, version: definition.version, description: definition.description, reward: definition.reward, currency: 'coin',
        threshold: definition.threshold, progress, period, enabled: Boolean(definition.enabled), complete: progress >= definition.threshold,
        claimed: claims.has(`${definition.id}:${definition.version}`), evidence: row ? JSON.parse(row.evidence_json) : { matchIds: [] } };
    });
  }

  claimMission(profileId, missionId, version, requestedPeriod) {
    const definition = MISSION_DEFINITIONS.find(item => item.id === missionId && item.version === Number(version));
    if (!definition || !definition.enabled) throw new StoreError('Nhiệm vụ này chưa mở.', 'MISSION_UNAVAILABLE');
    if (definition.kind === 'tutorial') return this.claimTutorialReward({ profileId, version: TUTORIAL_VERSION, amount: definition.reward, operationKey: `tutorial-reward:${TUTORIAL_VERSION}:${profileId}` });
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
      const wallet = this.writeWallet(profileId, definition.reward, 0, { operationKey, source: 'mission', note: `Thưởng nhiệm vụ: ${definition.description}`, at, currency: 'coin' });
      this.db.prepare(`INSERT INTO mission_claims(profile_id, mission_id, version, period, operation_key, claimed_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(profileId, missionId, definition.version, period, operationKey, at);
      return { missionId, version: definition.version, period, reward: definition.reward, wallet };
    });
  }

  hasTutorialVerification(profileId, version = TUTORIAL_VERSION) {
    return Boolean(this.db.prepare('SELECT 1 FROM tutorial_verifications WHERE profile_id = ? AND version = ?').get(profileId, version));
  }

  recordTutorialVerification({ profileId, version, completedAt, operationKey } = {}) {
    if (!this.publicProfile(profileId) || version !== TUTORIAL_VERSION || operationKey !== `tutorial-verified:${version}:${profileId}` || !Number.isFinite(Date.parse(completedAt))) {
      throw new StoreError('Dữ liệu xác minh hướng dẫn không hợp lệ.', 'TUTORIAL_VERIFICATION_INVALID');
    }
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT verified_at AS verifiedAt FROM tutorial_verifications WHERE profile_id = ? AND version = ?').get(profileId, version);
      if (existing) return { alreadyVerified: true, version, completedAt: existing.verifiedAt };
      this.db.prepare('INSERT INTO tutorial_verifications(profile_id, version, verified_at, operation_key) VALUES (?, ?, ?, ?)').run(profileId, version, new Date(completedAt).toISOString(), operationKey);
      return { alreadyVerified: false, version, completedAt: new Date(completedAt).toISOString() };
    });
  }

  claimTutorialReward({ profileId, version = TUTORIAL_VERSION, amount = 200, operationKey } = {}) {
    if (version !== TUTORIAL_VERSION || amount !== 200 || operationKey !== `tutorial-reward:${version}:${profileId}`) throw new StoreError('Thưởng hướng dẫn không hợp lệ.', 'TUTORIAL_REWARD_INVALID');
    if (!this.hasTutorialVerification(profileId, version)) throw new StoreError('Hoàn tất hướng dẫn được máy chủ xác minh trước khi nhận thưởng.', 'TUTORIAL_NOT_VERIFIED');
    const period = `once:${version}`;
    const result = this.executeOperation('mission_claim', operationKey, { profileId, missionId: 'tutorial_verified', version: 1, tutorialVersion: version, period }, at => {
      const wallet = this.writeWallet(profileId, amount, 0, { operationKey, source: 'mission', note: 'Thưởng hướng dẫn được máy chủ xác minh · một lần theo phiên bản', at, currency: 'coin' });
      this.db.prepare('INSERT INTO mission_claims(profile_id, mission_id, version, period, operation_key, claimed_at) VALUES (?, ?, 1, ?, ?, ?)').run(profileId, 'tutorial_verified', period, operationKey, at);
      return { missionId: 'tutorial_verified', version: 1, tutorialVersion: version, period, reward: amount, amount, wallet };
    });
    return { ...result, alreadyClaimed: Boolean(result.idempotent) };
  }

  exchangeCurrency(profileId, { direction, gems, operationKey } = {}) {
    if (!['coin-to-gem', 'gem-to-coin'].includes(direction) || !Number.isSafeInteger(gems) || gems <= 0 || !Number.isSafeInteger(gems * COIN_PER_GEM)) {
      throw new StoreError('Nhập số gem nguyên dương để quy đổi.', 'EXCHANGE_INVALID');
    }
    return this.executeOperation('currency_exchange', operationKey, { profileId, direction, gems, rate: COIN_PER_GEM }, at => {
      const coins = gems * COIN_PER_GEM, sign = direction === 'coin-to-gem' ? -1 : 1;
      const metadata = { operationKey, source: 'exchange', note: `${direction === 'coin-to-gem' ? 'Coin → gem' : 'Gem → coin'}: ${coins} coin = ${gems} gem`, at };
      this.writeWallet(profileId, sign * coins, 0, { ...metadata, currency: 'coin' });
      this.writeWallet(profileId, -sign * gems, 0, { ...metadata, currency: 'gem' });
      return { direction, gems, coins, balances: this.publicProfile(profileId).balances };
    });
  }
}

module.exports = { ProfileStore, StoreError, STARTING_CHIPS, MAX_CHIPS, vietnamDay };
