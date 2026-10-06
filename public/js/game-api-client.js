'use strict';

(function exposeGameApi(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChillThrillGameApi = api;
})(typeof globalThis === 'object' ? globalThis : this, function buildGameApi() {
  const CONTRACT_VERSION = 1;
  const SAFE_SOCKET_READS = new Set(['game:request_state', 'game:result']);
  const PRIVATE_RESULT_KEYS = new Set([
    'token', 'tokenHash', 'sessionToken', 'profileToken', 'recoveryCode', 'password', 'passwordHash',
    'hand', 'myHand', 'privateCards', 'holeCards', 'drawPile', 'deck', 'deckCards', 'privateState',
  ]);

  function isPrivateResultKey(key) {
    return PRIVATE_RESULT_KEYS.has(key) || /token|password|recovery|secret|private|draw.?pile|deck/i.test(key) || /^(my)?hand$/i.test(key);
  }

  class GameApiError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = 'GameApiError';
      this.code = code;
      this.operation = details.operation || null;
      this.transport = details.transport || null;
      this.uncertain = details.uncertain === true;
      this.capabilities = details.capabilities || Object.freeze({});
      this.cause = details.cause;
    }
  }

  function plainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function mergeCapabilities(...records) {
    return Object.freeze(Object.assign({}, ...records.filter(plainObject)));
  }

  function resultError(raw) {
    const nested = raw?.error;
    if (nested === null || nested === undefined || nested === false) return null;
    const message = typeof nested === 'string' ? nested
      : (typeof nested?.message === 'string' ? nested.message
        : (typeof raw?.message === 'string' ? raw.message : 'The operation failed.'));
    const code = typeof nested?.code === 'string' ? nested.code
      : (typeof raw?.code === 'string' ? raw.code : 'LEGACY_GAME_ERROR');
    const extra = plainObject(nested) ? Object.fromEntries(Object.entries(nested).filter(([key]) => !['code', 'message'].includes(key))) : {};
    return Object.freeze({ code, message, ...(Object.keys(extra).length ? { details: Object.freeze(extra) } : {}) });
  }

  function normalizeResponse(operation, transport, raw, capabilities = {}) {
    if (raw?.contractVersion === CONTRACT_VERSION && raw.operation === operation && typeof raw.ok === 'boolean') {
      return Object.freeze({ ...raw, transport, capabilities: mergeCapabilities(capabilities, raw.capabilities), legacy: raw.legacy ?? raw });
    }
    const error = resultError(raw) || (raw?.ok === false
      ? Object.freeze({ code: typeof raw.code === 'string' ? raw.code : 'GAME_OPERATION_FAILED', message: typeof raw.message === 'string' ? raw.message : 'The operation failed.' })
      : null);
    return Object.freeze({
      contractVersion: CONTRACT_VERSION,
      operation,
      transport,
      ok: !error,
      data: error ? null : raw,
      error,
      capabilities: mergeCapabilities(capabilities, raw?.capabilities),
      legacy: raw,
    });
  }

  function toError(raw, options) {
    if (raw instanceof GameApiError) return raw;
    return new GameApiError(options.code || raw?.code || 'GAME_API_ERROR', options.message || raw?.message || 'Game API request failed.', {
      operation: options.operation,
      transport: options.transport,
      uncertain: options.uncertain,
      capabilities: options.capabilities,
      cause: raw,
    });
  }

  function validateRetryKey(operation, payload, options, capabilities) {
    const key = options.idempotencyKey;
    if (typeof key !== 'string' || !key.trim()) return false;
    if (capabilities.idempotencyKeys !== true) return false;
    if (!Array.isArray(capabilities.idempotentOperations) || !capabilities.idempotentOperations.includes(operation)) return false;
    // Only accept a key that is already part of the actual request. The client
    // must never infer server-side dedupe from a local-only option.
    const headerKey = Object.entries(options.headers || {}).find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1];
    return payload?.idempotencyKey === key || payload?.actionId === key || payload?.operationKey === key || headerKey === key;
  }

  function canRetry(operation, transport, payload, options, capabilities) {
    if (transport === 'http' && ['GET', 'HEAD', 'OPTIONS'].includes(String(options.method || 'GET').toUpperCase())) return true;
    if (transport === 'socket' && SAFE_SOCKET_READS.has(options.event)) return true;
    return validateRetryKey(operation, payload, options, capabilities);
  }

  function sanitize(value, seen = new WeakSet()) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) return value.map(item => sanitize(item, seen)).filter(item => item !== undefined);
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
      if (isPrivateResultKey(key)) continue;
      const safe = sanitize(item, seen);
      if (safe !== undefined) clean[key] = safe;
    }
    return clean;
  }

  function projectResult(state, capabilities = {}) {
    if (!plainObject(state)) return normalizeResponse('result', 'socket', { ok: false, error: { code: 'RESULT_UNAVAILABLE', message: 'No game state was available.' } }, capabilities);
    const outcome = state.result ?? state.lastResult ?? null;
    const data = Object.freeze({
      gameId: state.gameId || null,
      variant: state.variant || null,
      rulesVersion: state.rulesVersion ?? null,
      roomCode: typeof state.roomCode === 'string' ? state.roomCode : null,
      matchId: typeof state.matchId === 'string' ? state.matchId : null,
      revision: Number.isSafeInteger(state.revision) ? state.revision : null,
      phase: typeof state.phase === 'string' ? state.phase : 'UNKNOWN',
      completed: state.phase === 'RESULT' || outcome !== null,
      outcome: sanitize(outcome) ?? null,
    });
    return normalizeResponse('result', 'socket', data, capabilities);
  }

  function createGameApiClient(options = {}) {
    const socket = options.socket || null;
    const baseUrl = options.baseUrl || '';
    const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    const defaultTimeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 8000;
    const defaultCapabilities = mergeCapabilities(options.capabilities);

    function socketAttempt(event, payload, operation, requestOptions) {
      const timeoutMs = Number.isFinite(requestOptions.timeoutMs) && requestOptions.timeoutMs > 0 ? requestOptions.timeoutMs : defaultTimeoutMs;
      const signal = requestOptions.signal;
      if (!socket || typeof socket.emit !== 'function') return Promise.reject(toError(null, { code: 'SOCKET_UNAVAILABLE', message: 'Socket transport is unavailable.', operation, transport: 'socket', capabilities: defaultCapabilities }));
      if (socket.connected === false) return Promise.reject(toError(null, { code: 'DISCONNECTED', message: 'Socket is disconnected.', operation, transport: 'socket', uncertain: false, capabilities: defaultCapabilities }));
      if (signal?.aborted) return Promise.reject(toError(null, { code: 'ABORTED', message: 'Request was cancelled before sending.', operation, transport: 'socket', uncertain: false, capabilities: defaultCapabilities }));

      return new Promise((resolve, reject) => {
        let settled = false;
        let dispatched = false;
        let timer;
        const cleanup = () => {
          clearTimeout(timer);
          socket.off?.('disconnect', onDisconnect);
          signal?.removeEventListener?.('abort', onAbort);
        };
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn(value);
        };
        const onDisconnect = () => finish(reject, toError(null, { code: 'DISCONNECTED', message: 'Socket disconnected before the acknowledgement arrived.', operation, transport: 'socket', uncertain: dispatched, capabilities: defaultCapabilities }));
        const onAbort = () => finish(reject, toError(null, { code: 'ABORTED', message: 'Request was cancelled.', operation, transport: 'socket', uncertain: dispatched, capabilities: defaultCapabilities }));
        socket.on?.('disconnect', onDisconnect);
        signal?.addEventListener?.('abort', onAbort, { once: true });
        timer = setTimeout(() => finish(reject, toError(null, { code: 'TIMEOUT', message: 'Socket acknowledgement timed out.', operation, transport: 'socket', uncertain: dispatched, capabilities: defaultCapabilities })), timeoutMs);
        try {
          dispatched = true;
          socket.emit(event, payload, (...args) => {
            if (settled) return; // Late acknowledgements cannot resurrect a request.
            if (args.length > 1 && args[0] instanceof Error) {
              finish(reject, toError(args[0], { code: 'SOCKET_ACK_ERROR', message: args[0].message, operation, transport: 'socket', uncertain: true, capabilities: defaultCapabilities }));
              return;
            }
            finish(resolve, args.length > 1 && args[0] == null ? args[1] : args[0]);
          });
        } catch (error) {
          dispatched = false;
          finish(reject, toError(error, { code: 'SOCKET_SEND_FAILED', operation, transport: 'socket', uncertain: false, capabilities: defaultCapabilities }));
        }
      });
    }

    async function socketRequest(event, payload = {}, requestOptions = {}) {
      const operation = requestOptions.operation || event;
      const attempts = Number.isInteger(requestOptions.retry) && requestOptions.retry > 0 ? requestOptions.retry + 1 : 1;
      const capabilities = mergeCapabilities(defaultCapabilities, requestOptions.capabilities);
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const raw = await socketAttempt(event, payload, operation, requestOptions);
          return normalizeResponse(operation, 'socket', raw, capabilities);
        } catch (error) {
          const retryAllowed = attempt + 1 < attempts && canRetry(operation, 'socket', payload, { ...requestOptions, event }, capabilities);
          if (!retryAllowed || error.code === 'ABORTED') throw error;
          if (requestOptions.retryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, requestOptions.retryDelayMs));
        }
      }
      throw toError(null, { operation, transport: 'socket', capabilities });
    }

    async function httpRequest(path, requestOptions = {}) {
      if (typeof fetchImpl !== 'function') throw toError(null, { code: 'FETCH_UNAVAILABLE', message: 'Fetch transport is unavailable.', operation: requestOptions.operation || path, transport: 'http', capabilities: defaultCapabilities });
      const operation = requestOptions.operation || String(requestOptions.method || 'GET').toLowerCase();
      const method = String(requestOptions.method || 'GET').toUpperCase();
      const payload = requestOptions.body;
      const attempts = Number.isInteger(requestOptions.retry) && requestOptions.retry > 0 ? requestOptions.retry + 1 : 1;
      const capabilities = mergeCapabilities(defaultCapabilities, requestOptions.capabilities);
      for (let attempt = 0; attempt < attempts; attempt++) {
        const controller = new AbortController();
        const timeoutMs = Number.isFinite(requestOptions.timeoutMs) && requestOptions.timeoutMs > 0 ? requestOptions.timeoutMs : defaultTimeoutMs;
        let timedOut = false;
        let externallyAborted = false;
        let timer;
        const externalSignal = requestOptions.signal;
        let rejectAbort;
        const abortPromise = new Promise((_, reject) => { rejectAbort = reject; });
        const onAbort = () => {
          externallyAborted = true;
          controller.abort();
          rejectAbort(toError(null, { code: 'ABORTED', message: 'Request was cancelled.', operation, transport: 'http', uncertain: !['GET', 'HEAD', 'OPTIONS'].includes(method), capabilities }));
        };
        if (externalSignal?.aborted) throw toError(null, { code: 'ABORTED', message: 'Request was cancelled before sending.', operation, transport: 'http', uncertain: false, capabilities });
        externalSignal?.addEventListener?.('abort', onAbort, { once: true });
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(toError(null, { code: 'TIMEOUT', message: 'HTTP request timed out.', operation, transport: 'http', uncertain: !['GET', 'HEAD', 'OPTIONS'].includes(method), capabilities }));
          }, timeoutMs);
        });
        let body = payload;
        const headers = { ...(requestOptions.headers || {}) };
        if (body !== undefined && body !== null && typeof body !== 'string' && !(typeof FormData !== 'undefined' && body instanceof FormData)) {
          body = JSON.stringify(body);
          if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
        }
        let fetchPromise;
        try {
          fetchPromise = Promise.resolve(fetchImpl(`${baseUrl}${path}`, {
            method,
            headers,
            ...(body === undefined ? {} : { body }),
            signal: controller.signal,
            credentials: requestOptions.credentials,
          }));
          const response = await Promise.race([fetchPromise, timeoutPromise, abortPromise]);
          clearTimeout(timer); externalSignal?.removeEventListener?.('abort', onAbort);
          let raw;
          if (response.status === 204) raw = null;
          else {
            const type = response.headers?.get?.('content-type') || '';
            raw = type.includes('json') ? await response.json() : await response.text();
          }
          if (!response.ok && !plainObject(raw)) raw = { error: typeof raw === 'string' && raw ? raw : response.statusText || 'HTTP request failed.', code: `HTTP_${response.status}` };
          else if (!response.ok && raw && !raw.error) raw = { ...raw, error: raw.message || response.statusText || 'HTTP request failed.', code: raw.code || `HTTP_${response.status}` };
          return normalizeResponse(operation, 'http', raw, capabilities);
        } catch (error) {
          clearTimeout(timer); externalSignal?.removeEventListener?.('abort', onAbort);
          if (externallyAborted && !timedOut) throw toError(error, { code: 'ABORTED', message: 'Request was cancelled.', operation, transport: 'http', uncertain: !['GET', 'HEAD', 'OPTIONS'].includes(method), capabilities });
          const requestError = error instanceof GameApiError ? error : toError(error, { code: timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', message: timedOut ? 'HTTP request timed out.' : 'HTTP request failed before a response arrived.', operation, transport: 'http', uncertain: !['GET', 'HEAD', 'OPTIONS'].includes(method), capabilities });
          if (attempt + 1 >= attempts || !canRetry(operation, 'http', payload, { ...requestOptions, method }, capabilities)) throw requestError;
          if (requestOptions.retryDelayMs > 0) await new Promise(resolve => setTimeout(resolve, requestOptions.retryDelayMs));
        }
      }
      throw toError(null, { operation, transport: 'http', capabilities });
    }

    return Object.freeze({
      socketRequest,
      httpRequest,
      createRoom: (request, requestOptions = {}) => socketRequest('room:create', request || {}, { ...requestOptions, operation: 'create' }),
      joinRoom: (request, requestOptions = {}) => socketRequest('room:join', request || {}, { ...requestOptions, operation: 'join' }),
      resumeRoom: (request, requestOptions = {}) => socketRequest('room:resume', request || {}, { ...requestOptions, operation: 'resume' }),
      action: (envelope, requestOptions = {}) => socketRequest('game:action', envelope || {}, { ...requestOptions, operation: 'action' }),
      requestState: (roomCode, requestOptions = {}) => socketRequest('game:request_state', { roomCode }, { ...requestOptions, operation: 'state' }),
      result: (roomCode, requestOptions = {}) => socketRequest('game:result', { roomCode }, { ...requestOptions, operation: 'result' }),
    });
  }

  return Object.freeze({ GameApiError, createGameApiClient, normalizeResponse, projectResult });
});
