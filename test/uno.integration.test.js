'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');

function connect(url) {
  return new Promise((resolve, reject) => {
    const client = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    client.on('game_state', state => { client.state = state; });
    client.once('connect', () => resolve(client)); client.once('connect_error', reject);
  });
}
function request(client, event, data) { return new Promise((resolve, reject) => client.timeout(3000).emit(event, data, (error, result) => error ? reject(error) : resolve(result))); }
function waitState(client, predicate) {
  if (client.state && predicate(client.state)) return Promise.resolve(client.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('game_state', onState); reject(new Error('Không nhận được state UNO đúng hạn.')); }, 3000);
    function onState(state) { if (predicate(state)) { clearTimeout(timer); client.off('game_state', onState); resolve(state); } }
    client.on('game_state', onState);
  });
}

test('UNO is served separately and can run beside an unchanged The Gang room', async t => {
  const game = createGameServer(); t.after(() => game.close());
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const clients = []; t.after(() => clients.forEach(client => client.disconnect()));
  const unoHost = await connect(url); clients.push(unoHost);
  const uno = await request(unoHost, 'create_room', { playerName: 'Uno Host', avatar: '🎲', gameId: 'uno' });
  await waitState(unoHost, state => state.gameId === 'uno' && state.phase === 'WAITING');
  const gangHost = await connect(url); clients.push(gangHost);
  const gang = await request(gangHost, 'create_room', { playerName: 'Gang Host', modeId: 'BASIC' });
  await waitState(gangHost, state => state.gameId === 'the-gang' && state.category === 'casual' && state.phase === 'WAITING');
  assert.notEqual(uno.roomCode, gang.roomCode);
  assert.ok(game.gm.uno.rooms.has(uno.roomCode)); assert.ok(game.gm.gang.rooms.has(gang.roomCode));
  const joined = await connect(url); clients.push(joined);
  await request(joined, 'join_room', { roomCode: uno.roomCode, playerName: 'Uno Bạn', avatar: '💻' });
  await waitState(unoHost, state => state.gameId === 'uno' && state.players.length === 2);
  unoHost.emit('set_ready', { roomCode: uno.roomCode, ready: true }); joined.emit('set_ready', { roomCode: uno.roomCode, ready: true });
  await waitState(unoHost, state => state.players.every(player => player.ready)); unoHost.emit('start_game', { roomCode: uno.roomCode });
  const started = await waitState(unoHost, state => state.gameId === 'uno' && state.phase === 'TURN');
  assert.ok(started.myHand.length >= 7);
  assert.equal(JSON.stringify(started).includes(game.gm.uno.rooms.get(uno.roomCode).players[1].hand[0].id), false);
  const page = await fetch(`${url}/uno`); assert.equal(page.status, 200); assert.match(await page.text(), /Tạo phòng UNO/);
  const qr = await fetch(`${url}/api/rooms/${uno.roomCode}/qr`); assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);
});
