'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTemporaryDirectory, removeTemporaryDirectory } = require('../scripts/helpers/temporary-directory');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');
const { createGameApiClient } = require('../public/js/game-api-client');

async function fixture(t) {
  const directory = createTemporaryDirectory('game-result-socket');
  const game = createGameServer({
    databaseFile: path.join(directory, 'profiles.sqlite'),
    storageFile: path.join(directory, 'rooms.json'),
    graceMs: 5000,
  });
  const clients = [];
  t.after(async () => {
    clients.forEach(client => client.disconnect());
    await game.close();
    removeTemporaryDirectory(directory);
  });
  await new Promise((resolve, reject) => {
    game.server.once('error', reject);
    game.server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${game.server.address().port}`;
  async function connect() {
    const socket = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.lastGameState = null;
    socket.on('game_state', state => { socket.lastGameState = state; });
    clients.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  }
  return { game, connect };
}

function waitForState(socket, predicate, timeoutMs = 2000) {
  if (socket.lastGameState && predicate(socket.lastGameState)) return Promise.resolve(socket.lastGameState);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('game_state', onState);
      reject(new Error('Timed out waiting for a game_state update.'));
    }, timeoutMs);
    function onState(state) {
      if (!predicate(state)) return;
      clearTimeout(timer);
      socket.off('game_state', onState);
      resolve(state);
    }
    socket.on('game_state', onState);
  });
}

test('Socket.IO game:result scopes to a seat and never returns active private hands', async t => {
  const { game, connect } = await fixture(t);
  const outsider = createGameApiClient({ socket: await connect(), timeoutMs: 1500 });

  for (const [variant, managerName] of [['classic-local-v1', 'gang'], ['classic-108-v1', 'uno']]) {
    const host = await connect(), friend = await connect();
    const hostApi = createGameApiClient({ socket: host, timeoutMs: 1500 });
    const friendApi = createGameApiClient({ socket: friend, timeoutMs: 1500 });
    const created = await hostApi.createRoom({ gameId: 'uno', variant, playerName: `Host-${variant}`, config: { variant, maxPlayers: 2 } });
    assert.equal(created.ok, true, created.error?.message);
    const joined = await friendApi.joinRoom({ roomCode: created.data.roomCode, playerName: `Friend-${variant}` });
    assert.equal(joined.ok, true, joined.error?.message);

    const manager = game.gm[managerName];
    const room = manager.rooms.get(created.data.roomCode);
    assert.ok(room, `Expected ${variant} to be managed by ${managerName}.`);
    assert.equal(manager.setReady(host, room.code, true)?.error, undefined);
    assert.equal(manager.setReady(friend, room.code, true)?.error, undefined);
    assert.equal(game.gm.startGame(host, room.code)?.error, undefined);

    const hostState = await waitForState(host, state => state.roomCode === room.code && state.phase !== 'WAITING');
    const friendState = await waitForState(friend, state => state.roomCode === room.code && state.phase !== 'WAITING');
    assert.ok(hostState.myHand?.length > 0);
    assert.ok(friendState.myHand?.length > 0);
    const hostJson = JSON.stringify(hostState), friendJson = JSON.stringify(friendState);
    for (const card of friendState.myHand) assert.equal(hostJson.includes(card.id), false);
    for (const card of hostState.myHand) assert.equal(friendJson.includes(card.id), false);

    const hostSummary = await hostApi.result(room.code);
    const friendSummary = await friendApi.result(room.code);
    assert.equal(hostSummary.ok, true, hostSummary.error?.message);
    assert.equal(friendSummary.ok, true, friendSummary.error?.message);
    assert.equal(hostSummary.data.completed, false);
    assert.equal(JSON.stringify(hostSummary).includes('myHand'), false);
    assert.equal(JSON.stringify(hostSummary).includes(hostState.myHand[0].id), false);
    assert.equal(JSON.stringify(friendSummary).includes(friendState.myHand[0].id), false);

    const denied = await outsider.result(room.code);
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'ROOM_ACCESS');
    assert.equal(JSON.stringify(denied).includes(hostState.myHand[0].id), false);

    // A terminal result may contain game-specific details; the shared result
    // projection must strip private material while retaining the public winner.
    const secret = `private-result-${variant}`;
    const resultValue = { winnerId: created.data.playerId, privateCards: [secret], sessionToken: 'seat-secret' };
    if (managerName === 'gang') {
      room.phase = 'RESULT';
      room.uno.phase = 'RESULT';
      room.uno.result = resultValue;
    } else {
      room.phase = 'RESULT';
      room.result = resultValue;
    }
    const terminal = await hostApi.result(room.code);
    assert.equal(terminal.ok, true, terminal.error?.message);
    assert.equal(terminal.data.completed, true);
    assert.equal(terminal.data.outcome.winnerId, created.data.playerId);
    assert.equal(JSON.stringify(terminal).includes(secret), false);
    assert.equal(JSON.stringify(terminal).includes('seat-secret'), false);
    const deniedTerminal = await outsider.result(room.code);
    assert.equal(deniedTerminal.ok, false);
    assert.equal(deniedTerminal.error.code, 'ROOM_ACCESS');
    assert.equal(JSON.stringify(deniedTerminal).includes(secret), false);
  }
});
