'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');

function connect(url) {
  return new Promise((resolve, reject) => {
    const client = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    client.on('game_state', state => { client.state = state; });
    client.on('game_error', payload => { client.lastError = payload.message; });
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
}

function request(client, event, data) {
  return new Promise((resolve, reject) => client.timeout(3000).emit(event, data,
    (error, result) => error ? reject(error) : resolve(result)));
}

function waitFor(client, predicate, description) {
  if (client.state && predicate(client.state)) return Promise.resolve(client.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('game_state', onState);
      reject(new Error(`Timed out waiting for ${description}; latest error: ${client.lastError || 'none'}`));
    }, 4000);
    function onState(state) {
      if (!predicate(state)) return;
      clearTimeout(timer);
      client.off('game_state', onState);
      resolve(state);
    }
    client.on('game_state', onState);
  });
}

function waitForError(client) {
  if (client.lastError) return Promise.resolve(client.lastError);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('game_error', onError);
      reject(new Error('Timed out waiting for the wager start to be rejected.'));
    }, 4000);
    function onError(payload) {
      clearTimeout(timer);
      client.off('game_error', onError);
      resolve(payload.message);
    }
    client.on('game_error', onError);
  });
}

test('HTTP socket states carry seat-private preflight and refresh storage safety before a wager start', async t => {
  const testResults = path.join(__dirname, '..', 'test-results');
  fs.mkdirSync(testResults, { recursive: true });
  const directory = fs.mkdtempSync(path.join(testResults, 'preflight-http-'));
  const game = createGameServer({ databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json'),
    unoStorageFile: path.join(directory, 'uno.json'), bangStorageFile: path.join(directory, 'bang.json'),
    tienLenStorageFile: path.join(directory, 'tien-len.json'), samLocStorageFile: path.join(directory, 'sam-loc.json'),
    phomStorageFile: path.join(directory, 'phom.json'), pokerStorageFile: path.join(directory, 'poker.json') });
  const clients = [];
  t.after(async () => {
    clients.forEach(client => client.disconnect());
    await game.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const host = await connect(url), guest = await connect(url);
  clients.push(host, guest);

  const created = await request(host, 'create_room', {
    playerName: 'B01 host', avatar: '🎲', gameId: 'tien-len', stake: 100,
  });
  assert.ok(created?.roomCode, created?.error);
  const hostState = await waitFor(host, state => state.roomCode === created.roomCode && state.phase === 'WAITING', 'host waiting state');
  assert.equal(hostState.preflight?.schemaVersion, 1);
  assert.equal(hostState.preflight.viewer.isHost, true);
  assert.equal(hostState.preflight.viewer.wallet.currency, 'coin');
  assert.equal(hostState.preflight.viewer.funding.amountToHold, 100);

  await request(guest, 'join_room', { roomCode: created.roomCode, playerName: 'B01 guest', avatar: '🃏' });
  const room = game.gm.tienLen.rooms.get(created.roomCode);
  const hostProfileId = room.players[0].profileId, guestProfileId = room.players[1].profileId;
  const guestState = await waitFor(guest, state => state.roomCode === created.roomCode && state.players?.length === 2, 'guest room state');
  assert.equal(guestState.preflight.viewer.isHost, false);
  assert.equal(guestState.preflight.viewer.seatId, room.players[1].id);
  assert.equal(Object.hasOwn(guestState.preflight, 'host'), false);
  assert.equal(JSON.stringify(guestState.preflight).includes(hostProfileId), false);
  assert.equal(JSON.stringify(guestState.preflight).includes(guestProfileId), false);

  host.emit('set_ready', { roomCode: created.roomCode, ready: true });
  guest.emit('set_ready', { roomCode: created.roomCode, ready: true });
  await waitFor(host, state => state.roomCode === created.roomCode && state.players?.length === 2 && state.players.every(player => player.ready), 'ready room state');

  const walletBefore = room.players.map(player => game.gm.profiles.walletForUpdate(player.profileId, 'coin'));
  game.storageDiagnostics.setExternalFault('snapshot:tien-len', {
    operation: 'write', stage: 'preflight-test', code: 'TEST_SNAPSHOT_FAILURE',
  });
  assert.equal(game.storageDiagnostics.getStatus({ ignorePending: true }).canStartWager, false);
  host.lastError = null;
  host.emit('start_game', { roomCode: created.roomCode });
  const message = await waitForError(host);

  assert.match(message, /lưu.*an toàn/i);
  assert.equal(room.phase, 'WAITING');
  assert.deepEqual(room.reservations, []);
  assert.deepEqual(room.players.map(player => game.gm.profiles.walletForUpdate(player.profileId, 'coin')), walletBefore);
});
