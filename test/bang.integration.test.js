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
function waitState(client, predicate) { if (client.state && predicate(client.state)) return Promise.resolve(client.state); return new Promise((resolve, reject) => { const timer = setTimeout(() => { client.off('game_state', onState); reject(new Error('Không nhận được state BANG! đúng hạn.')); }, 3000); function onState(state) { if (predicate(state)) { clearTimeout(timer); client.off('game_state', onState); resolve(state); } } client.on('game_state', onState); }); }

test('BANG! uses shared rooms, QR and per-seat hidden state over Socket.IO', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-bang-http-')), game = createGameServer({ databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json') }), clients = [];
  t.after(async () => { clients.forEach(client => client.disconnect()); await game.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${game.server.address().port}`;
  for (let index = 0; index < 4; index += 1) clients.push(await connect(url));
  const created = await request(clients[0], 'create_room', { playerName: 'Sheriff host', avatar: '🤠', gameId: 'bang' }); await waitState(clients[0], state => state.gameId === 'bang' && state.phase === 'WAITING');
  for (let index = 1; index < 4; index += 1) await request(clients[index], 'join_room', { roomCode: created.roomCode, playerName: `Cowboy ${index}`, avatar: '🏜️' });
  await waitState(clients[0], state => state.players.length === 4); clients.forEach(client => client.emit('set_ready', { roomCode: created.roomCode, ready: true })); await waitState(clients[0], state => state.players.every(player => player.ready)); clients[0].emit('start_game', { roomCode: created.roomCode }); const started = await waitState(clients[0], state => state.gameId === 'bang' && state.phase === 'DRAW');
  const states = await Promise.all(clients.map(client => waitState(client, state => state.gameId === 'bang' && state.phase === 'DRAW'))); assert.equal(started.players.filter(player => player.role === 'SHERIFF').length, 1); assert.equal(states.every(state => state.myHand.length > 0), true); assert.equal(JSON.stringify(states[0]).includes(states[1].myHand[0].id), false);
  const page = await fetch(`${url}/bang`); assert.equal(page.status, 200); assert.match(await page.text(), /BANG!/); const rules = await fetch(`${url}/docs/rules/bang.md`); assert.equal(rules.status, 200); assert.match(await rules.text(), /Fourth edition/); const games = await fetch(`${url}/api/games`).then(response => response.json()); assert.equal(games.games.find(item => item.id === 'bang').status, 'playable'); const qr = await fetch(`${url}/api/rooms/${created.roomCode}/qr`); assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);
});
