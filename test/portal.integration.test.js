'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');
const { vietnamDay } = require('../src/platform/profileStore');

async function fixture(t) {
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`, clients = [];
  t.after(async () => { clients.forEach(c => c.disconnect()); await game.close(); });
  async function connect(token) {
    const client = io(url, { forceNew: true, reconnection: false, transports: ['websocket'], auth: token ? { profileToken: token } : {} });
    clients.push(client);
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    return client;
  }
  const request = (client, event, data = {}) => new Promise((resolve, reject) => client.timeout(3000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
  return { game, url, connect, request };
}

test('merged portal exposes all existing games and serves new deep links without publishing secrets', async t => {
  const { url, connect, request } = await fixture(t);
  const catalog = await (await fetch(`${url}/api/registry`)).json();
  assert.equal(catalog.games.length, 7);
  assert.ok(catalog.games.every(g => g.status === 'playable'));
  assert.deepEqual(catalog.games.find(g => g.gameId === 'uno').variants.map(v => v.id), ['classic-local-v1', 'classic-108-v1']);
  for (const route of ['/play/casual', '/play/thrill', '/games/poker', '/rooms/ABCD', '/missions']) {
    const response = await fetch(`${url}${route}`);
    assert.equal(response.status, 200); assert.match(await response.text(), /screen-home/);
  }
  const host = await connect();
  const room = await request(host, 'room:create', { gameId: 'the-gang', category: 'thrill', playerName: 'Host', config: { maxPlayers: 2, visibility: 'invite', password: 'test-private' } });
  assert.equal(room.gameId, 'the-gang');
  const metadata = await (await fetch(`${url}/api/rooms/${room.roomCode}`)).json();
  assert.equal(metadata.category, 'casual'); assert.equal(metadata.requiresPassword, true);
  assert.ok(!JSON.stringify(metadata).includes('test-private'));
  assert.equal(metadata.sessionToken, undefined); assert.equal(metadata.passwordHash, undefined);
  assert.equal((await (await fetch(`${url}/api/rooms`)).json()).rooms.length, 0);
  const friend = await connect();
  assert.match((await request(friend, 'room:join', { roomCode: room.roomCode, playerName: 'Friend', password: 'wrong' })).error, /Mật khẩu/);
  assert.equal((await request(friend, 'room:join', { roomCode: room.roomCode, playerName: 'Friend', password: 'test-private' })).error, undefined);
  const extra = await connect();
  assert.match((await request(extra, 'room:join', { roomCode: room.roomCode, playerName: 'Extra', password: 'test-private' })).error, /đủ 2/);
});

test('portal REST and existing M4–M6 sockets share one identity and chip ledger', async t => {
  const { game, url, connect, request } = await fixture(t);
  const response = await fetch(`${url}/api/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Shared', avatar: '🎲' }) });
  assert.equal(response.status, 201);
  const created = await response.json(), headers = { 'X-Profile-Token': created.profileToken };
  assert.equal(created.profile.wallet.available, 1000);
  const host = await connect(created.profileToken);
  const room = await request(host, 'room:create', { gameId: 'poker', playerName: 'Shared', profileToken: created.profileToken });
  assert.equal(room.profile.id, created.profile.playerId);
  assert.equal(room.entryPath, '/poker');
  game.gm.profiles.reserveMany({ roomCode: room.roomCode, matchId: 'ledger-test', operationKey: 'ledger-test-reserve', reservations: [{ profileId: created.profile.playerId, amount: 200 }] });
  const rest = await (await fetch(`${url}/api/profile`, { headers })).json();
  const socket = await request(host, 'profile_status');
  assert.equal(rest.profile.wallet.available, 800);
  assert.deepEqual([rest.profile.wallet.available, rest.profile.wallet.reserved], [socket.profile.wallet.available, socket.profile.wallet.reserved]);
  assert.match(rest.history[0].reason, /Giữ chip/);
  const status = await (await fetch(`${url}/api/storage/status`)).json();
  assert.equal(status.integrity, 'ok');
});

test('imported UNO results and historical mission claims commit once in the shared M3 store', async t => {
  const { game, url, connect, request } = await fixture(t);
  const host = await connect();
  const room = await request(host, 'room:create', { gameId: 'uno', playerName: 'Classic', config: { maxPlayers: 2 } });
  const internal = game.gm.rooms.get(room.roomCode), yesterday = new Date(Date.now() - 86400000).toISOString();
  internal.phase = 'RESULT'; internal.uno = { phase: 'RESULT', result: { winnerId: room.playerId, endedAt: yesterday } };
  game.roomService.profileService.syncRoom(internal);
  game.roomService.profileService.syncRoom(internal);
  const headers = { 'X-Profile-Token': room.profileToken, 'Content-Type': 'application/json' };
  const before = await (await fetch(`${url}/api/missions`, { headers })).json();
  const daily = before.missions.find(m => m.missionId === 'daily_match' && m.periodKey === vietnamDay(yesterday));
  assert.equal(daily.progress, 1);
  for (let i = 0; i < 2; i++) {
    const claim = await fetch(`${url}/api/missions/daily_match/claim`, { method: 'POST', headers, body: JSON.stringify({ version: 1, periodKey: daily.periodKey }) });
    assert.equal(claim.status, 200);
  }
  const result = await request(host, 'profile_status');
  assert.equal(result.profile.wallet.available, 1100);
  assert.equal(game.gm.profiles.db.prepare('SELECT COUNT(*) AS count FROM mission_claims').get().count, 1);
  assert.equal(game.gm.profiles.db.prepare('SELECT COUNT(*) AS count FROM matches').get().count, 1);
});
