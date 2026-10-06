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
function waitState(client, predicate) { if (client.state && predicate(client.state)) return Promise.resolve(client.state); return new Promise((resolve, reject) => { const timer = setTimeout(() => { client.off('game_state', onState); reject(new Error('Không nhận được state Sâm lốc đúng hạn.')); }, 3000); function onState(state) { if (predicate(state)) { clearTimeout(timer); client.off('game_state', onState); resolve(state); } } client.on('game_state', onState); }); }

test('Sâm lốc is served through the shared gateway, QR route, and keeps hands private', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-sam-http-')); const game = createGameServer({ databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json') }); const clients = [];
  t.after(async () => { clients.forEach(client => client.disconnect()); await game.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${game.server.address().port}`; const host = await connect(url), guest = await connect(url); clients.push(host, guest);
  const created = await request(host, 'create_room', { playerName: 'Chủ bàn', avatar: '🕶️', gameId: 'sam-loc' }); await waitState(host, state => state.gameId === 'sam-loc' && state.phase === 'WAITING'); await request(guest, 'join_room', { roomCode: created.roomCode, playerName: 'Bạn bàn', avatar: '🎲' }); await waitState(host, state => state.players.length === 2);
  host.emit('set_ready', { roomCode: created.roomCode, ready: true }); guest.emit('set_ready', { roomCode: created.roomCode, ready: true }); await waitState(host, state => state.players.every(player => player.ready)); host.emit('start_game', { roomCode: created.roomCode });
  const started = await waitState(host, state => state.gameId === 'sam-loc' && state.phase === 'SAM_DECLARATION'), other = await waitState(guest, state => state.gameId === 'sam-loc' && state.phase === 'SAM_DECLARATION'); assert.equal(started.myHand.length, 10); assert.equal(started.maxLoss, 40); assert.equal(JSON.stringify(started).includes(JSON.stringify(other.myHand[0].id)), false);
  const page = await fetch(`${url}/sam-loc`); assert.equal(page.status, 200); assert.match(await page.text(), /Sâm lốc/); const rules = await fetch(`${url}/docs/rules/sam-loc.md`); assert.equal(rules.status, 200); const qr = await fetch(`${url}/api/rooms/${created.roomCode}/qr`); assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);
});
