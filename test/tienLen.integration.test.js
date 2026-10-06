'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');

function connect(url) { return new Promise((resolve, reject) => { const client = io(url, { transports: ['websocket'], forceNew: true, reconnection: false }); client.on('game_state', state => { client.state = state; }); client.once('connect', () => resolve(client)); client.once('connect_error', reject); }); }
function request(client, event, data) { return new Promise((resolve, reject) => client.timeout(3000).emit(event, data, (error, result) => error ? reject(error) : resolve(result))); }
function waitState(client, predicate) { if (client.state && predicate(client.state)) return Promise.resolve(client.state); return new Promise((resolve, reject) => { const timer = setTimeout(() => { client.off('game_state', onState); reject(new Error('Không nhận được state Tiến lên đúng hạn.')); }, 3000); function onState(state) { if (predicate(state)) { clearTimeout(timer); client.off('game_state', onState); resolve(state); } } client.on('game_state', onState); }); }

test('Tiến lên is served through the shared socket gateway and reserves every seat before private dealing', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-tl-http-'));
  const game = createGameServer({ databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json') });
  const clients = []; t.after(async () => { clients.forEach(client => client.disconnect()); await game.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${game.server.address().port}`;
  const host = await connect(url), guest = await connect(url); clients.push(host, guest);
  const created = await request(host, 'create_room', { playerName: 'Chủ bàn', avatar: '🕶️', gameId: 'tien-len' });
  await waitState(host, state => state.gameId === 'tien-len' && state.phase === 'WAITING');
  await request(guest, 'join_room', { roomCode: created.roomCode, playerName: 'Bạn bàn', avatar: '🎲' });
  await waitState(host, state => state.gameId === 'tien-len' && state.players.length === 2);
  host.emit('set_ready', { roomCode: created.roomCode, ready: true }); guest.emit('set_ready', { roomCode: created.roomCode, ready: true });
  await waitState(host, state => state.players.every(player => player.ready)); host.emit('start_game', { roomCode: created.roomCode });
  const started = await waitState(host, state => state.gameId === 'tien-len' && state.phase === 'TURN'); const guestState = await waitState(guest, state => state.gameId === 'tien-len' && state.phase === 'TURN');
  assert.equal(started.myHand.length, 13); assert.equal(JSON.stringify(started).includes(JSON.stringify(guestState.myHand[0].id)), false); assert.equal(started.stake, 100);
  assert.ok(started.players.every(player => player.handCount === 13)); const room = game.gm.tienLen.rooms.get(created.roomCode);
  assert.ok(room.reservations.every(item => item.amount === 100)); assert.ok(room.players.every(player => game.gm.profiles.publicProfile(player.profileId).balances.coin.reserved === 100));
  const page = await fetch(`${url}/tien-len`); assert.equal(page.status, 200); assert.match(await page.text(), /Tiến lên miền Nam/);
  const qr = await fetch(`${url}/api/rooms/${created.roomCode}/qr`); assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);
});
