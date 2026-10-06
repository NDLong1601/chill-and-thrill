'use strict';

const OPERATIONS = Object.freeze(['read', 'write', 'commit', 'export']);
const AUTHORITIES = new Set(['authoritative', 'export', 'legacy-fallback']);
const GAME_LABELS = Object.freeze({ 'the-gang': 'The Gang', uno: 'UNO', 'tien-len': 'Tiến lên', poker: 'Poker', 'sam-loc': 'Sâm lốc', phom: 'Phỏm', bang: 'BANG!' });

function isoTime(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('StorageDiagnostics clock must return a valid date');
  return date.toISOString();
}

function safeCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_.-]{0,63}$/.test(value)
    ? value
    : 'STORAGE_OPERATION_FAILED';
}

function safeStage(value) {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(value)
    ? value
    : 'unknown';
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function emptyOperation() {
  return {
    state: 'unknown',
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    recoveryRequired: false,
  };
}

/**
 * In-memory, privacy-safe storage telemetry shared by room managers and the
 * ProfileStore. Callers report outcomes at the actual read/write/commit site;
 * wrapping flush() from outside is intentionally unsupported because several
 * managers historically swallow filesystem errors.
 */
class StorageDiagnostics {
  constructor(options = {}) {
    this.clock = options.clock || (() => new Date());
    this.sources = new Map();
    this.database = {
      kind: 'unknown',
      fixture: false,
      schemaVersion: null,
      integrity: 'unknown',
      operational: null,
      lastError: null,
    };
    this.heldAudit = { state: 'unknown', total: null, needsAttention: null, checkedAt: null };
    if (options.database) this.setDatabaseStatus(options.database);
    if (options.heldAudit) this.setHeldAudit(options.heldAudit);
  }

  registerSource(definition) {
    const { id, gameId = null, variant = null, kind, mode = 'persisted', authority = 'authoritative', fixture = false } = definition || {};
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(id)) throw new TypeError('Storage source id is invalid');
    if (typeof kind !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(kind)) throw new TypeError('Storage source kind is invalid');
    if (!['persisted', 'memory'].includes(mode)) throw new TypeError('Storage source mode must be persisted or memory');
    if (!AUTHORITIES.has(authority)) throw new TypeError('Storage source authority is invalid');
    if (gameId !== null && (typeof gameId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(gameId))) throw new TypeError('Storage source gameId is invalid');
    if (variant !== null && (typeof variant !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(variant))) throw new TypeError('Storage source variant is invalid');
    if (this.sources.has(id)) throw new Error(`Storage source already registered: ${id}`);

    const operations = Object.fromEntries(OPERATIONS.map(operation => [operation, emptyOperation()]));
    this.sources.set(id, { id, gameId, variant, kind, mode, authority, fixture: fixture === true, operations, externalFault: null });
    return this;
  }

  hasSource(sourceId) { return this.sources.has(sourceId); }

  setExternalFault(sourceId, fault) {
    const source = this.sources.get(sourceId);
    if (!source) throw new Error(`Unknown storage source: ${sourceId}`);
    if (fault === null || fault === undefined || fault === false) {
      source.externalFault = null;
      return this;
    }
    source.externalFault = {
      code: safeCode(fault.code),
      stage: safeStage(fault.stage),
      operation: OPERATIONS.includes(fault.operation) ? fault.operation : 'read',
      blocking: fault.blocking !== false,
    };
    return this;
  }

  begin(sourceId, operation, stage = 'unknown') {
    const source = this.#source(sourceId, operation);
    const state = source.operations[operation];
    state.state = 'pending';
    state.lastAttemptAt = isoTime(this.clock);
    state.attemptStage = safeStage(stage);
    return this;
  }

  succeed(sourceId, operation, options = {}) {
    const source = this.#source(sourceId, operation);
    const state = source.operations[operation];
    const at = isoTime(this.clock);
    state.lastSuccessAt = at;
    state.successStage = safeStage(options.stage || 'complete');
    if (operation !== 'read' || options.recoveryVerified === true) {
      state.state = 'ok';
      state.lastError = null;
      state.recoveryRequired = false;
    } else if (state.lastError || state.recoveryRequired) {
      // A successful read alone does not prove that a previously damaged source
      // has been recovered and validated.
      state.state = 'recovery-required';
      state.recoveryRequired = true;
    } else {
      state.state = 'ok';
    }
    return this;
  }

  cancel(sourceId, operation, stage = 'rolled-back') {
    const source = this.#source(sourceId, operation);
    const state = source.operations[operation];
    if (state.state === 'pending') state.state = state.lastError ? 'recovery-required' : 'cancelled';
    state.completionStage = safeStage(stage);
    return this;
  }

  fail(sourceId, operation, details = {}) {
    const source = this.#source(sourceId, operation);
    const state = source.operations[operation];
    const at = isoTime(this.clock);
    const failure = { at, stage: safeStage(details.stage || state.attemptStage), code: safeCode(details.code) };
    state.state = 'error';
    state.lastAttemptAt ||= at;
    state.lastError = failure;
    if (operation === 'read' && source.authority === 'authoritative') state.recoveryRequired = true;
    return this;
  }

  setDatabaseStatus(details = {}) {
    const kind = details.kind ?? details.database;
    if (kind !== undefined && !['memory', 'sqlite', 'unknown'].includes(kind)) throw new TypeError('Database kind is invalid');
    const integrity = details.integrity;
    if (integrity !== undefined && !['ok', 'error', 'unknown'].includes(integrity)) throw new TypeError('Database integrity must be ok, error, or unknown');
    const schemaVersion = details.schemaVersion;
    if (schemaVersion !== undefined && schemaVersion !== null && (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0)) throw new TypeError('Database schemaVersion is invalid');
    const operational = details.operational;
    if (operational !== undefined && operational !== null && typeof operational !== 'boolean') throw new TypeError('Database operational must be boolean or null');
    const errorCode = details.errorCode;
    this.database = {
      kind: kind ?? this.database.kind,
      fixture: details.fixture === undefined ? this.database.fixture : details.fixture === true,
      schemaVersion: schemaVersion === undefined ? this.database.schemaVersion : schemaVersion,
      integrity: integrity ?? this.database.integrity,
      operational: operational === undefined ? this.database.operational : operational,
      lastError: errorCode ? safeCode(errorCode) : (operational === true ? null : this.database.lastError),
    };
    return this;
  }

  setHeldAudit(summary = {}) {
    if (summary.state === 'unavailable') {
      this.heldAudit = { state: 'unavailable', total: null, needsAttention: null, checkedAt: isoTime(this.clock) };
      return this;
    }
    const total = nonNegativeInteger(summary.total, 'heldAudit.total');
    const needsAttention = nonNegativeInteger(summary.needsAttention ?? summary.inconsistent, 'heldAudit.needsAttention');
    if (needsAttention > total) throw new TypeError('heldAudit.needsAttention cannot exceed total');
    this.heldAudit = { state: 'ok', total, needsAttention, checkedAt: isoTime(this.clock) };
    return this;
  }

  getStatus(options = {}) {
    const ignorePending = options.ignorePending === true;
    const sources = [...this.sources.values()].map(source => this.#publicSource(source));
    const authoritativeFailures = [];
    const sourceWarnings = [];
    for (const source of this.sources.values()) {
      for (const [operation, state] of Object.entries(source.operations)) {
        if (ignorePending && state.state === 'pending' && !state.lastError) continue;
        if (state.state !== 'error' && state.state !== 'pending' && state.state !== 'recovery-required') continue;
        const item = { sourceId: source.id, gameId: source.gameId, variant: source.variant, operation, state: state.state, ...(state.lastError || {}) };
        if (source.authority === 'authoritative' && operation !== 'export') authoritativeFailures.push(item);
        else sourceWarnings.push(item);
      }
      if (source.externalFault) {
        const item = { sourceId: source.id, gameId: source.gameId, variant: source.variant,
          operation: source.externalFault.operation, state: 'error', code: source.externalFault.code,
          stage: source.externalFault.stage, externallyReported: true };
        if (source.externalFault.blocking && source.authority === 'authoritative') authoritativeFailures.push(item);
        else sourceWarnings.push(item);
      }
    }

    const databaseUnsafe = this.database.integrity === 'error' || this.database.operational === false ||
      (this.database.kind === 'memory' && !this.database.fixture);
    const heldUnsafe = this.heldAudit.state !== 'ok' || this.heldAudit.needsAttention > 0;
    const memoryUnsafe = [...this.sources.values()].some(source => source.authority === 'authoritative' && source.mode === 'memory' && !source.fixture);
    const blocked = databaseUnsafe || heldUnsafe || memoryUnsafe || authoritativeFailures.length > 0;
    const warnings = [...sourceWarnings];
    if (this.database.integrity === 'unknown') warnings.push({ code: 'DATABASE_INTEGRITY_UNKNOWN', stage: 'integrity' });
    if (this.heldAudit.state !== 'ok') warnings.push({ code: 'HELD_AUDIT_UNAVAILABLE', stage: 'held-audit' });
    if (this.heldAudit.state === 'ok' && this.heldAudit.needsAttention > 0) warnings.push({ code: 'HELD_NEEDS_ATTENTION', stage: 'held-audit', count: this.heldAudit.needsAttention });
    if (databaseUnsafe) warnings.push({ code: this.database.lastError || 'DATABASE_UNSAFE', stage: 'database' });
    if (memoryUnsafe || (this.database.kind === 'memory' && !this.database.fixture)) warnings.push({ code: 'PERSISTENT_STORAGE_UNAVAILABLE', stage: 'configuration' });

    const status = blocked ? 'unsafe' : warnings.length ? 'warning' : 'ok';
    const safetyMode = this.#safetyMode();
    return {
      // Keep the established fields stable for existing clients.
      scope: 'local-server',
      database: this.database.kind === 'unknown' ? 'unknown' : this.database.kind,
      schemaVersion: this.database.schemaVersion,
      integrity: this.database.integrity,
      error: blocked ? 'Không thể bảo đảm lưu an toàn cho ván cược mới.' : null,
      status,
      safetyMode,
      canStartWager: !blocked,
      blockedReason: blocked ? this.#blockedReason(databaseUnsafe, heldUnsafe, memoryUnsafe, authoritativeFailures) : null,
      warnings,
      failures: authoritativeFailures,
      sources,
      heldAudit: { ...this.heldAudit },
    };
  }

  getLocalDiagnostics() {
    // Deliberately uses the same sanitized contract: no paths, tokens, room
    // state, profile identifiers, raw errors, or hands are retained here.
    return this.getStatus();
  }

  #source(sourceId, operation) {
    const source = this.sources.get(sourceId);
    if (!source) throw new Error(`Unknown storage source: ${sourceId}`);
    if (!OPERATIONS.includes(operation)) throw new TypeError(`Unknown storage operation: ${operation}`);
    return source;
  }

  #publicSource(source) {
    const operations = {};
    for (const [name, state] of Object.entries(source.operations)) operations[name] = {
      state: state.state,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError ? { ...state.lastError } : null,
    };
    return { id: source.id, gameId: source.gameId, variant: source.variant, kind: source.kind, mode: source.mode, authority: source.authority, fixture: source.fixture, externalFault: source.externalFault ? { ...source.externalFault } : null, operations };
  }

  #safetyMode() {
    const authoritative = [...this.sources.values()].filter(source => source.authority === 'authoritative');
    const hasPersistent = this.database.kind === 'sqlite' || authoritative.some(source => source.mode === 'persisted');
    const hasMemory = this.database.kind === 'memory' || authoritative.some(source => source.mode === 'memory');
    const memoryIsFixture = (this.database.kind !== 'memory' || this.database.fixture) && authoritative.filter(source => source.mode === 'memory').every(source => source.fixture);
    if (hasPersistent && hasMemory) return 'mixed';
    if (hasMemory) return memoryIsFixture ? 'memory-fixture' : 'memory';
    if (hasPersistent) return 'persisted';
    return 'unknown';
  }

  #blockedReason(databaseUnsafe, heldUnsafe, memoryUnsafe, failures) {
    if (databaseUnsafe) return 'Nguồn SQLite chưa vượt qua kiểm tra an toàn; chưa thể bắt đầu ván cược mới.';
    if (memoryUnsafe || (this.database.kind === 'memory' && !this.database.fixture)) return 'Server đang dùng lưu trữ bộ nhớ không bền vững; chưa thể bắt đầu ván cược mới.';
    if (heldUnsafe) return 'Có khoản coin đang giữ cần đối soát; chưa thể bắt đầu ván cược mới.';
    const failedGame = failures.find(item => item.gameId);
    return failedGame
      ? `Nguồn lưu trữ của ${GAME_LABELS[failedGame.gameId] || failedGame.gameId} chưa an toàn; chưa thể bắt đầu ván cược mới.`
      : 'Nguồn lưu trữ có thẩm quyền chưa an toàn; chưa thể bắt đầu ván cược mới.';
  }
}

function runStorageOperation(diagnostics, sourceId, operation, stage, work, options = {}) {
  if (!diagnostics?.hasSource?.(sourceId)) return work();
  diagnostics.begin(sourceId, operation, stage);
  try {
    const result = work();
    diagnostics.succeed(sourceId, operation, { stage, recoveryVerified: options.recoveryVerified === true });
    return result;
  } catch (error) {
    diagnostics.fail(sourceId, operation, { stage, code: options.failureCode || 'STORAGE_OPERATION_FAILED' });
    throw error;
  }
}

function runStorageOperations(diagnostics, sourceIds, operation, stage, work, options = {}) {
  const tracked = [...new Set(sourceIds || [])].filter(sourceId => diagnostics?.hasSource?.(sourceId));
  tracked.forEach(sourceId => diagnostics.begin(sourceId, operation, stage));
  try {
    const result = work();
    tracked.forEach(sourceId => diagnostics.succeed(sourceId, operation, { stage, recoveryVerified: options.recoveryVerified === true }));
    return result;
  } catch (error) {
    tracked.forEach(sourceId => diagnostics.fail(sourceId, operation, { stage, code: options.failureCode || 'STORAGE_OPERATION_FAILED' }));
    throw error;
  }
}

module.exports = { StorageDiagnostics, STORAGE_OPERATIONS: OPERATIONS, runStorageOperation, runStorageOperations };
