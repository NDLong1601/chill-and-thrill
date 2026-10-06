'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const ADMIN_SECRET_ENV = 'CHILL_ADMIN_SECRET';
const ROOM_GAME_IDS = new Set(['the-gang', 'uno', 'tien-len', 'poker', 'sam-loc', 'phom', 'bang']);
const ROOM_VARIANTS = new Set(['standard', 'classic-local-v1', 'classic-108-v1']);
const MAX_RECEIPTS = 256;

function validSecret(secret) {
  return typeof secret === 'string' && Buffer.byteLength(secret, 'utf8') >= 32 ? secret : null;
}

function constantTimeSecretMatch(expected, actual) {
  if (typeof actual !== 'string' || !expected) return false;
  const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const actualDigest = crypto.createHash('sha256').update(actual, 'utf8').digest();
  return crypto.timingSafeEqual(expectedDigest, actualDigest);
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeLabel(value, fallback, max = 64) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return normalized || fallback;
}

function safeOriginAddress(record) {
  if (!record || typeof record !== 'object' || typeof record.url !== 'string') return null;
  try {
    const url = new URL(record.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (!(url.hostname === 'localhost' || net.isIP(url.hostname))) return null;
    return {
      name: safeLabel(record.name, 'Mạng LAN', 48),
      url: url.origin,
      local: record.local === true,
    };
  } catch {
    return null;
  }
}

function safeGameId(value, fallback) {
  return ROOM_GAME_IDS.has(value) ? value : (ROOM_GAME_IDS.has(fallback) ? fallback : 'unknown');
}

function safeVariant(value, gameId) {
  if (ROOM_VARIANTS.has(value)) return value;
  return gameId === 'uno' ? 'unknown' : 'standard';
}

function safePhase(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value) ? value : 'UNKNOWN';
}

function safeCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_.-]{0,63}$/.test(value) ? value : 'STORAGE_STATUS_UNAVAILABLE';
}

function sanitizeStorage(status) {
  if (!status || typeof status !== 'object') return {
    status: 'unknown', canStartWager: null,
    database: { kind: 'unknown', schemaVersion: null, integrity: 'unknown' },
    warnings: [], failures: [], heldAudit: { state: 'unavailable', total: null, needsAttention: null, checkedAt: null },
  };
  const list = (items, failure) => (Array.isArray(items) ? items : []).slice(0, 32).map(item => ({
    sourceId: typeof item?.sourceId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(item.sourceId) ? item.sourceId : 'unknown',
    gameId: ROOM_GAME_IDS.has(item?.gameId) ? item.gameId : null,
    operation: ['read', 'write', 'commit', 'export'].includes(item?.operation) ? item.operation : null,
    state: ['error', 'pending', 'recovery-required', 'ok'].includes(item?.state) ? item.state : (failure ? 'error' : 'warning'),
    stage: typeof item?.stage === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(item.stage) ? item.stage : 'unknown',
    code: safeCode(item?.code),
  }));
  const database = status.database;
  const heldAudit = status.heldAudit;
  const integrity = ['ok', 'error', 'unknown'].includes(status.integrity) ? status.integrity : 'unknown';
  const kind = ['sqlite', 'memory', 'unknown'].includes(status.database === 'sqlite' || status.database === 'memory' ? status.database : database?.kind)
    ? (status.database === 'sqlite' || status.database === 'memory' ? status.database : database.kind) : 'unknown';
  return {
    status: ['ok', 'warning', 'unsafe'].includes(status.status) ? status.status : 'unknown',
    canStartWager: typeof status.canStartWager === 'boolean' ? status.canStartWager : null,
    database: {
      kind,
      schemaVersion: safeCount(status.schemaVersion ?? database?.schemaVersion),
      integrity,
    },
    warnings: list(status.warnings, false),
    failures: list(status.failures, true),
    heldAudit: {
      state: heldAudit?.state === 'ok' ? 'ok' : 'unavailable',
      total: safeCount(heldAudit?.total),
      needsAttention: safeCount(heldAudit?.needsAttention),
      checkedAt: typeof heldAudit?.checkedAt === 'string' && Number.isFinite(Date.parse(heldAudit.checkedAt)) ? heldAudit.checkedAt : null,
    },
  };
}

function collectRoomRecords(gm) {
  const definitions = [
    [gm?.gang, null], [gm?.uno, 'uno'], [gm?.tienLen, 'tien-len'], [gm?.poker, 'poker'],
    [gm?.samLoc, 'sam-loc'], [gm?.phom, 'phom'], [gm?.bang, 'bang'],
  ];
  const seen = new Set();
  const records = [];
  for (const [manager, fallbackGameId] of definitions) {
    if (!(manager?.rooms instanceof Map)) continue;
    for (const [roomKey, room] of manager.rooms) {
      const code = typeof room?.code === 'string' ? room.code : roomKey;
      if (typeof code !== 'string' || !/^[A-Z0-9]{3,12}$/.test(code) || seen.has(code)) continue;
      seen.add(code);
      let metadata = null;
      try { metadata = gm?.publicRoom?.(code) || null; } catch { metadata = null; }
      const gameId = safeGameId(metadata?.gameId || room?.gameId, fallbackGameId);
      const players = Array.isArray(room?.players) ? room.players : [];
      const connectedCount = players.reduce((total, player) => total + (player?.connected === true ? 1 : 0), 0);
      const knownVariant = metadata?.variant || room?.variant;
      const variant = knownVariant || (gameId === 'uno' && fallbackGameId === 'uno' ? 'classic-108-v1' : 'standard');
      const maxPlayers = safeCount(metadata?.maxPlayers ?? room?.config?.maxPlayers);
      records.push({
        code,
        gameId,
        variant: safeVariant(variant, gameId),
        phase: safePhase(metadata?.phase || room?.phase),
        playerCount: safeCount(metadata?.players) ?? players.length,
        connectedCount,
        maxPlayers,
        visibility: metadata?.visibility === 'invite' || room?.config?.visibility === 'invite' ? 'invite' : 'public',
      });
    }
  }
  return records.sort((left, right) => left.code.localeCompare(right.code));
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

class AdminService {
  constructor(options = {}) {
    this.secret = validSecret(options.adminSecret ?? process.env[ADMIN_SECRET_ENV]);
    this.gm = options.gm || null;
    this.io = options.io || null;
    this.storageDiagnostics = options.storageDiagnostics || null;
    this.getNetworkAddresses = options.getNetworkAddresses || (() => []);
    this.getRooms = options.getRooms || (() => collectRoomRecords(this.gm));
    this.getConnectionCount = options.getConnectionCount || (() => {
      const count = this.io?.engine?.clientsCount ?? this.io?.sockets?.sockets?.size;
      return safeCount(count);
    });
    this.getStorageStatus = options.getStorageStatus || ((readOptions) => this.storageDiagnostics?.getStatus?.(readOptions));
    this.clock = options.clock || (() => new Date());
    this.idGenerator = options.idGenerator || (() => crypto.randomUUID());
    this.maintenance = false;
    this.receiptsByOperation = new Map();
    this.recentReceipts = [];
  }

  isConfigured() { return this.secret !== null; }

  authenticate(candidate) { return constantTimeSecretMatch(this.secret, candidate); }

  setMaintenance(enabled, operationId) {
    if (typeof enabled !== 'boolean') return { ok: false, status: 400, code: 'ADMIN_REQUEST_INVALID', error: 'Chế độ bảo trì không hợp lệ.' };
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{8,96}$/.test(operationId)) {
      return { ok: false, status: 400, code: 'ADMIN_OPERATION_ID_INVALID', error: 'Mã thao tác không hợp lệ.' };
    }
    const previous = this.receiptsByOperation.get(operationId);
    if (previous) {
      if (previous.enabled !== enabled) return { ok: false, status: 409, code: 'ADMIN_OPERATION_REPLAY_CONFLICT', error: 'Mã thao tác này đã được dùng cho lựa chọn khác.' };
      return { ok: true, replayed: true, enabled: previous.enabled, receipt: previous };
    }
    this.maintenance = enabled;
    const now = this.clock();
    const receipt = Object.freeze({
      receiptId: this.idGenerator(),
      operationId,
      action: enabled ? 'maintenance-enabled' : 'maintenance-disabled',
      enabled,
      createdAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    });
    this.receiptsByOperation.set(operationId, receipt);
    this.recentReceipts.push(receipt);
    if (this.recentReceipts.length > MAX_RECEIPTS) {
      const [removed] = this.recentReceipts.splice(0, this.recentReceipts.length - MAX_RECEIPTS);
      this.receiptsByOperation.delete(removed.operationId);
    }
    return { ok: true, replayed: false, enabled, receipt };
  }

  getAddress(index) {
    const raw = this.readNetworkAddresses();
    return raw[index] || null;
  }

  getStatus() {
    const rooms = this.readRooms();
    const connectedPlayers = rooms.reduce((total, room) => total + (safeCount(room.connectedCount) || 0), 0);
    const storage = this.readStorage();
    return {
      server: { maintenance: this.maintenance, connectionCount: this.readConnectionCount(), roomCount: rooms.length, connectedPlayers },
      addresses: this.readNetworkAddresses(),
      rooms,
      storage,
      recentActions: this.recentReceipts.slice(-10).reverse(),
      financialTools: { available: false },
    };
  }

  readNetworkAddresses() {
    try {
      const input = this.getNetworkAddresses();
      if (!Array.isArray(input)) return [];
      return input.map(safeOriginAddress).filter(Boolean).slice(0, 16);
    } catch {
      return [];
    }
  }

  readRooms() {
    try {
      const input = this.getRooms();
      if (!Array.isArray(input)) return [];
      const rooms = new Map();
      for (const item of input) {
        const code = typeof item?.code === 'string' ? item.code : null;
        if (!code || !/^[A-Z0-9]{3,12}$/.test(code) || rooms.has(code)) continue;
        const gameId = safeGameId(item?.gameId, null);
        rooms.set(code, {
          code,
          gameId,
          variant: safeVariant(item?.variant, gameId),
          phase: safePhase(item?.phase),
          playerCount: safeCount(item?.playerCount) ?? 0,
          connectedCount: safeCount(item?.connectedCount) ?? 0,
          maxPlayers: safeCount(item?.maxPlayers),
          visibility: item?.visibility === 'invite' ? 'invite' : 'public',
        });
      }
      return [...rooms.values()].sort((left, right) => left.code.localeCompare(right.code));
    } catch {
      return [];
    }
  }

  readConnectionCount() {
    try { return safeCount(this.getConnectionCount()); } catch { return null; }
  }

  readStorage() {
    try { return sanitizeStorage(this.getStorageStatus({ ignorePending: true })); }
    catch { return sanitizeStorage(null); }
  }

  installRoomCreationGate(targets = []) {
    const wrapped = [];
    for (const entry of targets) {
      const target = entry?.target;
      const method = entry?.method || 'createRoom';
      if (!target || typeof target[method] !== 'function') continue;
      const original = target[method];
      const service = this;
      function maintenanceGuard(...args) {
        if (service.maintenance) return { error: 'Máy chủ đang bảo trì; chưa thể tạo bàn mới.', code: 'MAINTENANCE_ACTIVE' };
        return original.apply(this, args);
      }
      target[method] = maintenanceGuard;
      wrapped.push({ target, method, original, maintenanceGuard });
    }
    return () => {
      for (const item of wrapped.reverse()) {
        if (item.target[item.method] === item.maintenanceGuard) item.target[item.method] = item.original;
      }
    };
  }
}

module.exports = {
  ADMIN_SECRET_ENV,
  AdminService,
  collectRoomRecords,
  constantTimeSecretMatch,
  isLoopbackAddress,
  sanitizeStorage,
  validSecret,
};
