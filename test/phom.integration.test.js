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
function waitState(client, predicate) { if (client.state && predicate(client.state)) return Promise.resolve(client.state); return new Promise((resolve, reject) => { const timer = setTimeout(() => { client.off('game_state', onState); reject(new Error('Không nhận được state Phỏm đúng hạn.')); }, 3000); function onState(state) { if (predicate(state)) { clearTimeout(timer); client.off('game_state', onState); resolve(state); } } client.on('game_state', onState); }); }

test('Phỏm uses the shared room/QR gateway and only sends each player their own hand', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-phom-http-')), game = createGameServer({ databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json') }), clients = [];
  t.after(async () => { clients.forEach(client => client.disconnect()); await game.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${game.server.address().port}`, host = await connect(url), guest = await connect(url); clients.push(host, guest);
  const created = await request(host, 'create_room', { playerName: 'Chủ Phỏm', avatar: '🕶️', gameId: 'phom' }); await waitState(host, state => state.gameId === 'phom' && state.phase === 'WAITING'); await request(guest, 'join_room', { roomCode: created.roomCode, playerName: 'Bạn Phỏm', avatar: '🎲' }); await waitState(host, state => state.players.length === 2);
  host.emit('set_ready', { roomCode: created.roomCode, ready: true }); guest.emit('set_ready', { roomCode: created.roomCode, ready: true }); await waitState(host, state => state.players.every(player => player.ready)); host.emit('start_game', { roomCode: created.roomCode }); const started = await waitState(host, state => state.gameId === 'phom' && state.phase === 'DISCARD'), other = await waitState(guest, state => state.gameId === 'phom' && state.phase === 'DISCARD');
  assert.equal(started.myHand.length, 10); assert.equal(other.myHand.length, 9); assert.equal(started.maxLoss, 60); assert.equal(JSON.stringify(started).includes(other.myHand[0].id), false);
  const page = await fetch(`${url}/phom`); assert.equal(page.status, 200); assert.match(await page.text(), /Phỏm/); const rules = await fetch(`${url}/docs/rules/phom.md`); assert.equal(rules.status, 200); const qr = await fetch(`${url}/api/rooms/${created.roomCode}/qr`); assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);
});
