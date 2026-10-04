'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');

function waitState(client, predicate) {
  if (client.state && predicate(client.state)) return Promise.resolve(client.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('game_state', handler); reject(new Error(`Không nhận được trạng thái: ${JSON.stringify({ phase: client.state?.phase, errors: client.errors })}`)); }, 4000);
    function handler(state) { if (predicate(state)) { clearTimeout(timer); client.off('game_state', handler); resolve(state); } }
    client.on('game_state', handler);
  });
}
async function connect(url) {
  const client = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  client.errors = []; client.on('game_state', state => { client.state = state; }); client.on('game_error', error => client.errors.push(error));
  await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); }); return client;
}
function request(client, event, data) { return new Promise((resolve, reject) => client.timeout(4000).emit(event, data, (error, result) => error ? reject(error) : resolve(result))); }
function send(client, event, data = {}) { client.emit(event, { roomCode: client.state.roomCode, phaseKey: client.state.phaseKey, ...data }); }

test('real sockets complete a heist, recover a seat, transfer host, chat and serve local QR', async t => {
  const game = createGameServer(); t.after(() => game.close());
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const clients = []; t.after(() => clients.forEach(c => c.disconnect()));
  const host = await connect(url); clients.push(host);
  const credentials = await request(host, 'create_room', { playerName: 'Host', modeId: 'BASIC' }); await waitState(host, s => s.players.length === 1);
  const second = await connect(url); clients.push(second);
  const secondCredentials = await request(second, 'join_room', { playerName: 'Bạn 2', roomCode: credentials.roomCode });
  await waitState(host, s => s.players.length === 2); await waitState(second, s => s.players.length === 2);
  for (const client of [host, second]) send(client, 'set_ready', { ready: true });
  await waitState(host, s => s.players.every(p => p.ready)); send(host, 'start_game');
  await waitState(host, s => s.phase === 'PRE_FLOP'); await waitState(second, s => s.phase === 'PRE_FLOP');
  assert.equal(host.state.players.find(p => p.id === secondCredentials.playerId).privateCards.every(c => c === null), true);
  send(host, 'claim_chip', { chipNumber: 1 }); await waitState(host, s => s.players[0].chips.white === 1);
  const cards = host.state.players[0].privateCards;
  host.disconnect(); await waitState(second, s => s.players.find(p => p.id === secondCredentials.playerId).isHost && s.disconnected.length === 1);
  const returned = await connect(url); clients.push(returned);
  const resumed = await request(returned, 'resume_room', credentials); assert.equal(resumed.playerId, credentials.playerId);
  await waitState(returned, s => s.disconnected.length === 0); await waitState(second, s => s.disconnected.length === 0);
  assert.deepEqual(returned.state.players[0].privateCards, cards); assert.equal(returned.state.players[0].chips.white, 1);
  send(second, 'transfer_host', { targetId: credentials.playerId }); await waitState(returned, s => s.players[0].isHost);

  for (const [index, phase] of ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'].entries()) {
    const color = ['white', 'yellow', 'orange', 'red'][index];
    if (phase !== 'PRE_FLOP') { send(returned, 'claim_chip', { chipNumber: 1 }); await waitState(returned, s => s.players[0].chips[color] === 1); }
    await waitState(second, s => s.phase === phase); send(second, 'claim_chip', { chipNumber: 2 });
    await waitState(returned, s => s.players[1].chips[color] === 2);
    send(returned, 'confirm_round', { confirmed: true }); send(second, 'confirm_round', { confirmed: true });
    await waitState(returned, s => s.players.every(p => p.roundConfirmed)); send(returned, 'advance_phase');
    await waitState(returned, s => s.phase !== phase); await waitState(second, s => s.phase !== phase);
  }
  assert.equal(returned.state.phase, 'SHOWDOWN');
  send(returned, 'reveal_next', { expectedCount: 0 }); await waitState(returned, s => s.showdown.revealedCount === 1);
  send(returned, 'reveal_next', { expectedCount: 1 }); await waitState(returned, s => s.phase === 'RESULT');
  assert.equal(returned.state.history.length, 1); assert.ok(returned.state.lastResult.playerResults.every(p => p.best5.length === 5));

  send(returned, 'return_to_lobby'); await waitState(returned, s => s.phase === 'WAITING');
  send(returned, 'send_chat', { text: '<script>không thực thi</script>' });
  await new Promise(resolve => second.once('chat_message', message => { assert.equal(message.text, '<script>không thực thi</script>'); resolve(); }));
  const qr = await fetch(`${url}/api/rooms/${credentials.roomCode}/qr?origin=${encodeURIComponent(url)}`);
  assert.equal(qr.status, 200); assert.match(await qr.text(), /<svg/);
  assert.equal((await fetch(`${url}/api/rooms/${credentials.roomCode}/qr?origin=https://evil.example`)).status, 400);
  const html = await (await fetch(url)).text(); assert.doesNotMatch(html, /https:\/\/(cdn|fonts)/); assert.match(html, /\/socket.io\/socket.io.js/);
  assert.equal((await fetch(url + '/socket.io/socket.io.js')).status, 200);
  // Bad payloads are rejected without taking down other clients.
  returned.emit('claim_chip', null); returned.emit('join_room', { roomCode: {} });
  const network = await fetch(url + '/api/network'); assert.equal(network.status, 200);
});
