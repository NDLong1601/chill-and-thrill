'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTemporaryDirectory, removeTemporaryDirectory } = require('../scripts/helpers/temporary-directory');
const {
  GAME_VARIANT_TARGETS,
  createGameAdapterContract,
  projectGameResult,
  resolveGameVariant,
} = require('../src/platform/gameAdapterContract');
const { GameApiError, createGameApiClient } = require('../public/js/game-api-client');
const { createGameServer } = require('../src/httpServer');

function fakeSocket() {
  const handlers = new Map();
  const requests = [];
  const socket = {
    connected: true,
    on(event, handler) {
      const values = handlers.get(event) || new Set();
      values.add(handler); handlers.set(event, values); return socket;
    },
    off(event, handler) { handlers.get(event)?.delete(handler); return socket; },
    emit(event, payload, ack) { requests.push({ event, payload, ack }); return socket; },
    trigger(event, ...args) { for (const handler of [...(handlers.get(event) || [])]) handler(...args); },
    requests,
    handlerCount(event) { return handlers.get(event)?.size || 0; },
  };
  return socket;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Condition was not reached before the test deadline.');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

function temporaryGame(t) {
  const directory = createTemporaryDirectory('game-api-contract');
  const game = createGameServer({
    databaseFile: path.join(directory, 'profiles.sqlite'),
    storageFile: path.join(directory, 'rooms.json'),
    graceMs: 5000,
  });
  t.after(async () => {
    await game.close();
    removeTemporaryDirectory(directory);
  });
  let nextId = 0;
  function connect() {
    const listeners = new Map();
    const socket = {
      id: `b08-socket-${++nextId}`,
      connected: true,
      data: {},
      emitted: [],
      on(event, handler) { const set = listeners.get(event) || new Set(); set.add(handler); listeners.set(event, set); return socket; },
      off(event, handler) { listeners.get(event)?.delete(handler); return socket; },
      join() {},
      leave() {},
      emit(event, data, ack) {
        if (event === 'room:create') {
          const gameId = data.gameId || 'the-gang';
          const variant = gameId === 'uno' ? data.config?.variant || 'classic-local-v1' : undefined;
          const result = game.gm.gameAdapterFor(gameId, variant).create({ socket, request: data }).legacy;
          if (typeof ack === 'function') ack(result);
          return socket;
        }
        if (event === 'room:join') {
          const roomCode = String(data.roomCode || '').toUpperCase();
          const result = game.gm.gameAdapterForRoom(roomCode).join({ socket, request: { ...data, roomCode } }).legacy;
          if (typeof ack === 'function') ack(result);
          return socket;
        }
        if (event === 'room:resume') {
          const roomCode = String(data.roomCode || '').toUpperCase();
          const result = game.gm.gameAdapterForRoom(roomCode).resume({ socket, request: { ...data, roomCode } }).legacy;
          if (typeof ack === 'function') ack(result);
          return socket;
        }
        if (event === 'game:action') {
          const result = game.gm.gameAdapterForRoom(data.roomCode).action({ socket, envelope: data }).legacy;
          if (typeof ack === 'function') ack(result);
          return socket;
        }
        if (event === 'game:request_state') {
          const result = game.roomService.requestGameState(socket, data.roomCode);
          if (typeof ack === 'function') ack(result);
          return socket;
        }
        if (event === 'game:result') {
          const result = game.gm.gameAdapterForRoom(data.roomCode).result({ socket, roomCode: data.roomCode });
          if (typeof ack === 'function') ack(result);
          return socket;
        }
        socket.emitted.push({ event, data });
        return socket;
      },
      disconnect() {
        if (!socket.connected) return socket;
        socket.connected = false;
        game.gm.handleDisconnect(socket);
        for (const handler of [...(listeners.get('disconnect') || [])]) handler('io client disconnect');
        game.io.sockets.sockets.delete(socket.id);
        return socket;
      },
    };
    game.io.sockets.sockets.set(socket.id, socket);
    return socket;
  }
  return { game, connect };
}

test('variant target table maps all eight game variants and preserves both legacy UNO defaults', () => {
  assert.equal(Object.values(GAME_VARIANT_TARGETS).reduce((count, variants) => count + Object.keys(variants).length, 0), 8);
  assert.deepEqual(resolveGameVariant('uno', 'classic-local-v1'), {
    gameId: 'uno', variant: 'classic-local-v1', manager: 'gang', entryPath: '/',
  });
  assert.deepEqual(resolveGameVariant('uno', 'classic-108-v1'), {
    gameId: 'uno', variant: 'classic-108-v1', manager: 'uno', entryPath: '/uno',
  });
  assert.equal(resolveGameVariant('uno', undefined, { legacySurface: 'room:create' }).variant, 'classic-local-v1');
  assert.equal(resolveGameVariant('uno', undefined, { legacySurface: 'create_room' }).variant, 'classic-108-v1');
  assert.throws(() => resolveGameVariant('uno'), { code: 'VARIANT_REQUIRED' });
  assert.throws(() => resolveGameVariant('uno', 'classic-112-v0'), { code: 'VARIANT_NOT_SUPPORTED' });
  const southRules = projectGameResult({ gameId: 'tien-len', phase: 'WAITING', rulesVersion: 'south-v1' }, resolveGameVariant('tien-len'));
  assert.equal(southRules.data.variant, 'standard');
  assert.equal(southRules.data.rulesVersion, 'south-v1');
});

test('adapter contract wraps old signatures, preserves legacy errors and capability metadata', async () => {
  const oldCredential = { roomCode: 'ABCD', playerId: 'p-1', sessionToken: 'seat-secret' };
  const adapter = createGameAdapterContract({
    gameId: 'poker',
    capabilities: { supportsResume: true, privateState: true, wagerCurrency: 'coin' },
    create: ({ socket, request }) => ({ ...oldCredential, socketId: socket.id, name: request.playerName }),
    join: () => ({ error: 'Phòng đã đủ người.' }),
    resume: () => ({ roomCode: 'ABCD', playerId: 'p-1' }),
    action: () => ({ ok: false, error: { code: 'STALE_REVISION', message: 'Bàn đã thay đổi.', currentRevision: 9 } }),
    result: () => ({ gameId: 'poker', phase: 'RESULT', matchId: 'm-1', revision: 10, lastResult: { winnerId: 'p-1', privateCards: ['hidden'] } }),
  });
  const created = adapter.create({ socket: { id: 'socket-1' }, request: { playerName: 'Host' } });
  assert.equal(created.ok, true);
  assert.deepEqual(created.data, { ...oldCredential, socketId: 'socket-1', name: 'Host' });
  assert.equal(created.data.sessionToken, 'seat-secret');
  assert.equal(created.capabilities.privateState, true);
  assert.equal(adapter.join().error.code, 'LEGACY_GAME_ERROR');
  assert.equal(adapter.join().error.message, 'Phòng đã đủ người.');
  assert.equal(adapter.resume().ok, true);
  const action = adapter.action();
  assert.equal(action.error.code, 'STALE_REVISION');
  assert.equal(action.error.details.currentRevision, 9);
  const result = await adapter.result();
  assert.equal(result.data.completed, true);
  assert.equal(result.data.outcome.winnerId, 'p-1');
  assert.equal(JSON.stringify(result).includes('hidden'), false);
  assert.throws(() => createGameAdapterContract({ gameId: 'bang', create() {} }), { code: 'INVALID_ADAPTER' });
});

test('socket client ignores late acknowledgements, reports timeout and cleans up listeners', async () => {
  const socket = fakeSocket();
  const client = createGameApiClient({ socket, timeoutMs: 12 });
  const pending = client.action({ roomCode: 'ABCD', actionId: 'a-1' });
  assert.equal(socket.requests.length, 1);
  await assert.rejects(pending, error => error instanceof GameApiError && error.code === 'TIMEOUT' && error.uncertain === true);
  assert.equal(socket.handlerCount('disconnect'), 0);
  socket.requests[0].ack({ ok: true, event: 'late-ack' });
  assert.equal(socket.handlerCount('disconnect'), 0);
});

test('socket client distinguishes pre-send cancellation and in-flight disconnect', async () => {
  const disconnected = fakeSocket();
  const disconnectedClient = createGameApiClient({ socket: disconnected, timeoutMs: 100 });
  const pending = disconnectedClient.createRoom({ gameId: 'uno' });
  disconnected.trigger('disconnect', 'transport close');
  await assert.rejects(pending, error => error.code === 'DISCONNECTED' && error.uncertain === true);
  assert.equal(disconnected.handlerCount('disconnect'), 0);

  const cancelled = fakeSocket();
  const cancelledClient = createGameApiClient({ socket: cancelled, timeoutMs: 100 });
  const controller = new AbortController();
  const beforeSend = cancelledClient.joinRoom({}, { signal: AbortSignal.abort() });
  await assert.rejects(beforeSend, error => error.code === 'ABORTED' && error.uncertain === false);
  const active = cancelledClient.resumeRoom({ roomCode: 'ABCD' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(active, error => error.code === 'ABORTED' && error.uncertain === true);
  assert.equal(cancelled.handlerCount('disconnect'), 0);
});

test('client keeps server error codes and capabilities and only retries safe reads or keyed idempotent operations', async () => {
  const socket = fakeSocket();
  const client = createGameApiClient({ socket, timeoutMs: 8 });
  const statePromise = client.requestState('ABCD', { timeoutMs: 8, retry: 1 });
  await waitFor(() => socket.requests.length === 2);
  socket.requests[1].ack({ ok: true, state: { phase: 'WAITING' }, capabilities: { supportsResume: true } });
  const state = await statePromise;
  assert.equal(state.ok, true);
  assert.equal(state.capabilities.supportsResume, true);

  const before = socket.requests.length;
  const noRetry = client.action({ roomCode: 'ABCD', actionId: 'act-1' }, { timeoutMs: 8, retry: 3 });
  await assert.rejects(noRetry, error => error.code === 'TIMEOUT');
  assert.equal(socket.requests.length, before + 1);

  const keyed = client.action({ roomCode: 'ABCD', actionId: 'key-1' }, {
    timeoutMs: 8, retry: 1, idempotencyKey: 'key-1',
    capabilities: { idempotencyKeys: true, idempotentOperations: ['action'] },
  });
  await waitFor(() => socket.requests.length === before + 3);
  assert.equal(socket.requests.length, before + 3);
  socket.requests.at(-1).ack({ ok: false, error: { code: 'STALE_REVISION', message: 'Refresh state.' }, capabilities: { actionIds: true } });
  const failed = await keyed;
  assert.equal(failed.error.code, 'STALE_REVISION');
  assert.equal(failed.capabilities.actionIds, true);

  const fetchCalls = [];
  const fakeFetch = async (_url, init) => {
    fetchCalls.push(init);
    if (fetchCalls.length === 1) throw new Error('temporary network failure');
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ value: 7 }) };
  };
  const httpClient = createGameApiClient({ fetch: fakeFetch, timeoutMs: 100 });
  const read = await httpClient.httpRequest('/api/read', { retry: 1 });
  assert.equal(read.data.value, 7);
  assert.equal(fetchCalls.length, 2);
});

test('real managers keep UNO variants and viewer-private hands separate under the common client', async t => {
  const { game, connect } = temporaryGame(t);
  const contracts = [];
  for (const [gameId, variants] of Object.entries(GAME_VARIANT_TARGETS)) {
    for (const variant of Object.keys(variants)) {
      const adapter = game.gm.gameAdapterFor(gameId, variant);
      assert.equal(adapter.gameId, gameId);
      assert.equal(adapter.variant, variant);
      assert.equal(typeof adapter.create, 'function');
      assert.equal(typeof adapter.result, 'function');
    }
  }

  for (const [variant, managerName] of [['classic-local-v1', 'gang'], ['classic-108-v1', 'uno']]) {
    const host = await connect();
    const friend = await connect();
    const hostApi = createGameApiClient({ socket: host, timeoutMs: 1500 });
    const friendApi = createGameApiClient({ socket: friend, timeoutMs: 1500 });
    const created = await hostApi.createRoom({ gameId: 'uno', variant, playerName: `Host-${variant}`, config: { maxPlayers: 2, variant } });
    assert.equal(created.ok, true, JSON.stringify(created.error));
    assert.equal(created.data.variant, variant);
    const joined = await friendApi.joinRoom({ gameId: 'uno', roomCode: created.data.roomCode, playerName: `Friend-${variant}` });
    assert.equal(joined.ok, true, JSON.stringify(joined.error));

    const manager = game.gm[managerName];
    const room = manager.rooms.get(created.data.roomCode);
    assert.ok(room, `${variant} must resolve to manager ${managerName}`);
    assert.equal(room.variant || (managerName === 'uno' ? 'classic-108-v1' : 'classic-local-v1'), variant);
    // Set each seat through its owning socket to exercise the real manager's access checks.
    manager.setReady(host, room.code, true);
    manager.setReady(friend, room.code, true);
    const started = game.gm.startGame(host, room.code);
    assert.equal(started?.error, undefined);

    const hostState = manager.buildStateFor(room, created.data.playerId);
    const friendState = manager.buildStateFor(room, joined.data.playerId);
    assert.ok(Array.isArray(hostState.myHand) && Array.isArray(friendState.myHand));
    assert.notDeepEqual(hostState.myHand.map(card => card.id), friendState.myHand.map(card => card.id));
    for (const card of friendState.myHand) assert.equal(JSON.stringify(hostState).includes(card.id), false);
    for (const card of hostState.myHand) assert.equal(JSON.stringify(friendState).includes(card.id), false);

    const identity = resolveGameVariant('uno', variant);
    const result = projectGameResult(hostState, identity, { privateState: true });
    assert.equal(result.ok, true);
    assert.equal(result.data.variant, variant);
    assert.equal(JSON.stringify(result).includes('myHand'), false);
    assert.equal(JSON.stringify(result).includes(friendState.myHand[0].id), false);
    const adapter = createGameAdapterContract({
      gameId: 'uno', variant,
      capabilities: { privateState: true, supportsResume: true },
      create: ({ socket, request }) => game.gm.createRoom(socket, request.playerName, 'ADVANCED', request.avatar, 'uno', request.config),
      join: ({ socket, request }) => game.gm.joinRoom(socket, request.roomCode, request.playerName, request.avatar, request.password),
      resume: ({ socket, request }) => game.gm.resumeRoom(socket, request.roomCode, request.sessionToken),
      action: ({ socket, envelope }) => game.roomService.handleGameAction(socket, envelope),
      result: ({ roomCode, viewerSeatId }) => {
        const owner = game.gm.managerForCode(roomCode);
        return owner?.buildStateFor(owner.rooms.get(roomCode), viewerSeatId);
      },
    });
    const scopedResult = adapter.result({ roomCode: room.code, viewerSeatId: created.data.playerId });
    assert.equal(scopedResult.ok, true);
    assert.equal(scopedResult.data.variant, variant);
    assert.equal(JSON.stringify(scopedResult).includes(friendState.myHand[0].id), false);
    assert.equal(adapter.action({ socket: host, envelope: { roomCode: 'NOPE' } }).error.code, 'ROOM_NOT_FOUND');
    const apiResult = await hostApi.result(room.code);
    assert.equal(apiResult.ok, true);
    assert.equal(apiResult.data.variant, variant);
    assert.equal(JSON.stringify(apiResult).includes(hostState.myHand[0].id), false);
    contracts.push({ host, friend, friendToken: joined.data.sessionToken, hostApi, created, adapter });
  }

  const first = contracts[0];
  const disconnectedCode = first.created.data.roomCode;
  const token = first.created.data.sessionToken;
  first.host.disconnect();
  const replacement = await connect();
  const replacementApi = createGameApiClient({ socket: replacement, timeoutMs: 1500 });
  const resumed = await replacementApi.resumeRoom({ roomCode: disconnectedCode, sessionToken: token });
  assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
  assert.equal(resumed.data.playerId, first.created.data.playerId);

  first.friend.disconnect();
  const replacementFriend = connect();
  const resumedThroughAdapter = first.adapter.resume({ socket: replacementFriend, request: {
    roomCode: disconnectedCode, sessionToken: first.friendToken,
  } });
  assert.equal(resumedThroughAdapter.ok, true, JSON.stringify(resumedThroughAdapter.error));
});

test('HTTP POST timeout is reported as uncertain and is not retried by request count alone', async () => {
  let calls = 0;
  const hangingFetch = () => {
    calls++;
    return new Promise(() => {});
  };
  const client = createGameApiClient({ fetch: hangingFetch, timeoutMs: 10 });
  await assert.rejects(client.httpRequest('/api/mutate', { method: 'POST', body: { actionId: 'not-enabled' }, retry: 3 }), error => error.code === 'TIMEOUT' && error.uncertain === true);
  assert.equal(calls, 1);

  const controller = new AbortController();
  const cancelled = client.httpRequest('/api/mutate', { method: 'POST', body: { actionId: 'cancel-me' }, signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, error => error.code === 'ABORTED' && error.uncertain === true);
  assert.equal(calls, 2);
});
