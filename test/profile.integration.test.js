'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');

function connect(url, token) {
  return new Promise((resolve, reject) => {
    const client = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, auth: token ? { profileToken: token } : {} });
    client.once('connect', () => resolve(client)); client.once('connect_error', reject);
  });
}
function request(client, event, data = {}) { return new Promise((resolve, reject) => client.timeout(3000).emit(event, data, (error, result) => error ? reject(error) : resolve(result))); }
function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); }

test('M3 Socket.IO creates a durable profile and binds it to exactly one room seat', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-profile-api-'));
  const databaseFile = path.join(directory, 'profiles.sqlite');
  let game = createGameServer({ databaseFile });
  await listen(game.server);
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const clients = []; t.after(async () => { clients.forEach(client => client.disconnect()); await game.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const first = await connect(url); clients.push(first);
  const created = await request(first, 'profile_bootstrap', { playerName: 'An', avatar: '🎲' });
  assert.equal(created.profile.wallet.available, 1000); assert.match(created.profileToken, /^[A-Za-z0-9_-]{32,}$/); assert.match(created.recoveryCode, /^[A-F0-9-]+$/);
  const room = await request(first, 'create_room', { playerName: 'Tên khác', avatar: '💻', gameId: 'uno' });
  assert.equal(room.profile.id, created.profile.id);
  const secondTab = await connect(url, created.profileToken); clients.push(secondTab);
  const duplicate = await request(secondTab, 'join_room', { roomCode: room.roomCode, playerName: 'An', avatar: '🎲' });
  assert.match(duplicate.error, /đã có ghế/);
  const renamed = await request(first, 'profile_update', { playerName: 'An đổi tên', avatar: '💻' });
  assert.equal(renamed.profile.displayName, 'An đổi tên'); assert.equal(renamed.profile.wallet.available, 1000);
  await game.close();
  game = createGameServer({ databaseFile });
  await listen(game.server);
  const afterRestart = await connect(`http://127.0.0.1:${game.server.address().port}`, created.profileToken); clients.push(afterRestart);
  const state = await request(afterRestart, 'profile_status');
  assert.equal(state.profile.id, created.profile.id); assert.equal(state.profile.displayName, 'An đổi tên');
  const page = await fetch(`http://127.0.0.1:${game.server.address().port}/profile`);
  assert.equal(page.status, 200); assert.match(await page.text(), /Hồ sơ/);
});
