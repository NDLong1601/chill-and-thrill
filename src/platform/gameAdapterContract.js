'use strict';

const GAME_ADAPTER_CONTRACT_VERSION = 1;
const CONTRACT_OPERATIONS = Object.freeze(['create', 'join', 'resume', 'action', 'result']);

// A stable target table for every currently supported game/variant. The UNO
// split is intentional: the two IDs select different engines and entry paths.
const GAME_VARIANT_TARGETS = Object.freeze({
  'the-gang': Object.freeze({ standard: Object.freeze({ manager: 'gang', entryPath: '/' }) }),
  uno: Object.freeze({
    'classic-local-v1': Object.freeze({ manager: 'gang', entryPath: '/' }),
    'classic-108-v1': Object.freeze({ manager: 'uno', entryPath: '/uno' }),
  }),
  'tien-len': Object.freeze({ standard: Object.freeze({ manager: 'tienLen', entryPath: '/tien-len' }) }),
  poker: Object.freeze({ standard: Object.freeze({ manager: 'poker', entryPath: '/poker' }) }),
  'sam-loc': Object.freeze({ standard: Object.freeze({ manager: 'samLoc', entryPath: '/sam-loc' }) }),
  phom: Object.freeze({ standard: Object.freeze({ manager: 'phom', entryPath: '/phom' }) }),
  bang: Object.freeze({ standard: Object.freeze({ manager: 'bang', entryPath: '/bang' }) }),
});

const LEGACY_UNO_DEFAULTS = Object.freeze({
  'room:create': 'classic-local-v1',
  create_room: 'classic-108-v1',
});

function contractError(code, message) {
  return Object.assign(new Error(message), { code });
}

function resolveGameVariant(gameId, variant, options = {}) {
  const targets = GAME_VARIANT_TARGETS[gameId];
  if (!targets) throw contractError('GAME_NOT_FOUND', `Unknown game ID: ${String(gameId)}`);
  let resolved = variant;
  if (resolved === undefined || resolved === null || resolved === '') {
    if (gameId === 'uno' && options.legacySurface && LEGACY_UNO_DEFAULTS[options.legacySurface]) {
      resolved = LEGACY_UNO_DEFAULTS[options.legacySurface];
    } else if (gameId === 'uno') {
      throw contractError('VARIANT_REQUIRED', 'UNO requires an explicit variant or a recognized legacy surface.');
    } else {
      resolved = 'standard';
    }
  }
  const target = targets[resolved];
  if (!target) throw contractError('VARIANT_NOT_SUPPORTED', `Unsupported variant ${String(resolved)} for ${gameId}.`);
  return Object.freeze({ gameId, variant: resolved, manager: target.manager, entryPath: target.entryPath });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function frozenRecord(value) {
  if (!isPlainObject(value)) return Object.freeze({});
  const result = {};
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) result[key] = item;
    else if (Array.isArray(item)) result[key] = Object.freeze(item.slice());
    else if (isPlainObject(item)) result[key] = frozenRecord(item);
  }
  return Object.freeze(result);
}

function normalizeError(raw) {
  if (raw === null || raw === undefined) return null;
  const source = isPlainObject(raw) ? raw : {};
  const nested = source.error;
  if (nested === null || nested === undefined || nested === false) return null;
  const nestedObject = isPlainObject(nested) ? nested : {};
  const message = typeof nested === 'string' ? nested
    : (typeof nestedObject.message === 'string' ? nestedObject.message
      : (typeof source.message === 'string' ? source.message : 'The operation failed.'));
  const code = typeof nestedObject.code === 'string' ? nestedObject.code
    : (typeof source.code === 'string' ? source.code
      : (typeof source.errorCode === 'string' ? source.errorCode : 'LEGACY_GAME_ERROR'));
  const details = {};
  for (const [key, value] of Object.entries(nestedObject)) {
    if (!['code', 'message'].includes(key)) details[key] = value;
  }
  return Object.freeze({ code, message, ...(Object.keys(details).length ? { details: Object.freeze(details) } : {}) });
}

function normalizeAdapterResult(operation, raw, capabilities = {}) {
  if (!CONTRACT_OPERATIONS.includes(operation)) throw contractError('INVALID_CONTRACT_OPERATION', `Unknown operation: ${operation}`);
  const serverCapabilities = isPlainObject(raw?.capabilities) ? raw.capabilities : {};
  const normalizedCapabilities = frozenRecord({ ...capabilities, ...serverCapabilities });
  const error = normalizeError(raw) || (raw?.ok === false
    ? Object.freeze({ code: typeof raw.code === 'string' ? raw.code : 'GAME_OPERATION_FAILED', message: typeof raw.message === 'string' ? raw.message : 'The operation failed.' })
    : null);
  return Object.freeze({
    contractVersion: GAME_ADAPTER_CONTRACT_VERSION,
    operation,
    ok: !error,
    data: error ? null : raw,
    error,
    capabilities: normalizedCapabilities,
    // Keep the exact legacy return available to migration code. This wrapper
    // never changes the signature or return value of an existing manager.
    legacy: raw,
  });
}

const PRIVATE_RESULT_KEYS = new Set([
  'token', 'tokenHash', 'sessionToken', 'profileToken', 'recoveryCode', 'password', 'passwordHash',
  'hand', 'myHand', 'privateCards', 'holeCards', 'drawPile', 'deck', 'deckCards', 'privateState',
]);

function isPrivateResultKey(key) {
  return PRIVATE_RESULT_KEYS.has(key) || /token|password|recovery|secret|private|draw.?pile|deck/i.test(key) || /^(my)?hand$/i.test(key);
}

function sanitizeResultValue(value, seen = new WeakSet()) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => sanitizeResultValue(item, seen)).filter(item => item !== undefined);
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (isPrivateResultKey(key)) continue;
    const safe = sanitizeResultValue(item, seen);
    if (safe !== undefined) clean[key] = safe;
  }
  return clean;
}

function projectGameResult(state, identity, capabilities = {}) {
  if (isPlainObject(state) && (state.ok === false || state.error)) {
    return normalizeAdapterResult('result', state, capabilities);
  }
  if (!isPlainObject(state)) {
    return normalizeAdapterResult('result', { ok: false, error: { code: 'RESULT_UNAVAILABLE', message: 'No viewer-scoped game state was available.' } }, capabilities);
  }
  const gameId = state.gameId || identity.gameId;
  const variant = state.variant || identity.variant;
  if (gameId !== identity.gameId || variant !== identity.variant) {
    return normalizeAdapterResult('result', { ok: false, error: { code: 'GAME_VARIANT_MISMATCH', message: 'The result belongs to a different game variant.' } }, capabilities);
  }
  const outcome = state.result ?? state.lastResult ?? null;
  const data = Object.freeze({
    gameId,
    variant,
    rulesVersion: state.rulesVersion ?? null,
    roomCode: typeof state.roomCode === 'string' ? state.roomCode : null,
    matchId: typeof state.matchId === 'string' ? state.matchId : null,
    revision: Number.isSafeInteger(state.revision) ? state.revision : null,
    phase: typeof state.phase === 'string' ? state.phase : 'UNKNOWN',
    completed: state.phase === 'RESULT' || outcome !== null,
    outcome: sanitizeResultValue(outcome) ?? null,
  });
  return normalizeAdapterResult('result', data, capabilities);
}

function createGameAdapterContract(spec) {
  if (!isPlainObject(spec)) throw contractError('INVALID_ADAPTER', 'Adapter specification must be a plain object.');
  const identity = resolveGameVariant(spec.gameId, spec.variant);
  const methods = {};
  for (const operation of ['create', 'join', 'resume', 'action', 'result']) {
    if (typeof spec[operation] !== 'function') throw contractError('INVALID_ADAPTER', `Adapter is missing ${operation}().`);
    methods[operation] = spec[operation];
  }
  const capabilities = frozenRecord(spec.capabilities || {});
  function invoke(operation, context = {}) {
    try {
      const value = methods[operation](context);
      if (value && typeof value.then === 'function') {
        return value.then(raw => operation === 'result'
          ? projectGameResult(raw, identity, capabilities)
          : normalizeAdapterResult(operation, raw, capabilities),
        error => normalizeAdapterResult(operation, { ok: false, error: { code: error?.code || 'ADAPTER_ERROR', message: error?.message || 'Adapter operation failed.' } }, capabilities));
      }
      return operation === 'result'
        ? projectGameResult(value, identity, capabilities)
        : normalizeAdapterResult(operation, value, capabilities);
    } catch (error) {
      return normalizeAdapterResult(operation, { ok: false, error: { code: error?.code || 'ADAPTER_ERROR', message: error?.message || 'Adapter operation failed.' } }, capabilities);
    }
  }
  return Object.freeze({
    contractVersion: GAME_ADAPTER_CONTRACT_VERSION,
    gameId: identity.gameId,
    variant: identity.variant,
    manager: identity.manager,
    entryPath: identity.entryPath,
    capabilities,
    create: context => invoke('create', context),
    join: context => invoke('join', context),
    resume: context => invoke('resume', context),
    action: context => invoke('action', context),
    result: context => invoke('result', context),
  });
}

module.exports = {
  GAME_ADAPTER_CONTRACT_VERSION,
  CONTRACT_OPERATIONS,
  GAME_VARIANT_TARGETS,
  createGameAdapterContract,
  normalizeAdapterResult,
  normalizeError,
  projectGameResult,
  resolveGameVariant,
};
