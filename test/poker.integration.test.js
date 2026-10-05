'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');

function connect(url, profileToken = null) { return new Promise((resolve, reject) => { const client = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, auth: profileToken ? { profileToken } : {} }); client.on('game_state', state => { client.state = state; }); client.on('game_error', payload => { client.lastError = payload.message; }); client.once('connect', () => resolve(client)); client.once('connect_error', reject); }); }
function waitState(client, predicate) { if (client.state && predicate(client.state)) return Promise.resolve(client.state); return new Promise((resolve, reject) => { const timer = setTimeout(() => { client.off('game_state', onState); reject(new Error(`Không nhận được state Poker đúng hạn: ${JSON.stringify({ phase: client.state?.phase, street: client.state?.street, revision: client.state?.revision, players: client.state?.players?.length, error: client.lastError })}`)); }, 4000); function onState(state) { if (predicate(state)) { clearTimeout(timer); client.off('game_state', onState); resolve(state); } } client.on('game_state', onState); }); }
function request(client, event, data) { return new Promise((resolve, reject) => client.timeout(3000).emit(event, data, (error, result) => error ? reject(error) : resolve(result))); }
let number = 0;
async function act(client, action, extra = {}, changed = null) { const revision = client.state.revision; client.lastError = null; client.emit('game_action', { roomCode: client.state.roomCode, action, actionId: `poker-test-${++number}-${Date.now()}`, expectedRevision: revision, ...extra }); try { return await waitState(client, state => changed ? changed(state, revision) : state.revision > revision); } catch (error) { throw new Error(`${action}: ${client.lastError || error.message}`); } }

test('Poker starts from wallet buy-ins, keeps hole cards private, runs all-in board, and settles once into table stacks', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-poker-http-'));
  const game = createGameServer({ databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json') });
  const clients = []; t.after(async () => { clients.forEach(client => client.disconnect()); await game.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${game.server.address().port}`;
  const host = await connect(url), guest = await connect(url); clients.push(host, guest);
  const created = await request(host, 'create_room', { playerName: 'Chủ Poker', avatar: '🕶️', gameId: 'poker' });
  await waitState(host, state => state.gameId === 'poker' && state.phase === 'WAITING');
  await request(guest, 'join_room', { roomCode: created.roomCode, playerName: 'Khách Poker', avatar: '🎲' });
  await waitState(host, state => state.gameId === 'poker' && state.players.length === 2);
  await act(host, 'buy_in', { amount: 200 }, state => state.myStack === 200); await waitState(guest, state => state.revision >= host.state.revision); await act(guest, 'buy_in', { amount: 200 }, state => state.myStack === 200);
  assert.equal(host.state.myStack, 200); assert.equal(host.state.wallet.reserved, 200);
  assert.deepEqual(game.gm.poker.rooms.get(created.roomCode).players.map(player => player.stack), [200, 200]);
  let revision = host.state.revision; host.emit('set_ready', { roomCode: created.roomCode, ready: true }); await waitState(host, state => state.revision > revision);
  revision = guest.state.revision; guest.emit('set_ready', { roomCode: created.roomCode, ready: true }); await waitState(guest, state => state.revision > revision);
  await waitState(host, state => state.players.every(player => player.ready)); host.emit('start_game', { roomCode: created.roomCode });
  const started = await waitState(host, state => state.phase === 'HAND' && state.street === 'PREFLOP'); const guestState = await waitState(guest, state => state.phase === 'HAND');
  assert.equal(started.myHoleCards.length, 2); assert.equal(JSON.stringify(started).includes(guestState.myHoleCards[0].id), false);
  const first = started.currentPlayerId === started.myId ? host : guest, second = first === host ? guest : host;
  await act(first, 'all_in');
  await waitState(second, state => state.currentPlayerId === state.myId);
  await act(second, 'call');
  const result = await waitState(host, state => state.phase === 'RESULT');
  assert.equal(result.community.length, 5); assert.equal(result.result.showdown.length, 2); assert.equal(result.result.pot, 400);
  const room = game.gm.poker.rooms.get(created.roomCode);
  assert.equal(room.players.reduce((sum, player) => sum + player.stack, 0), 400);
  assert.equal(game.gm.profiles.publicProfile(room.players[0].profileId).wallet.reserved, 200);
  assert.equal((await fetch(`${url}/poker`)).status, 200); assert.equal((await fetch(`${url}/api/rooms/${created.roomCode}/qr`)).status, 200);
});

test('Poker restores a paused all-in hand and its settled result without a second buy-in', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-poker-restart-'));
  const databaseFile = path.join(directory, 'profiles.sqlite'), storageFile = path.join(directory, 'rooms.json'); let game = createGameServer({ databaseFile, storageFile }); const clients = [];
  t.after(async () => { clients.forEach(client => client.disconnect()); await game.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const listen = async () => { await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${game.server.address().port}`; };
  let url = await listen(); const host = await connect(url), guest = await connect(url); clients.push(host, guest);
  const created = await request(host, 'create_room', { playerName: 'Khôi phục A', avatar: '🕶️', gameId: 'poker' }); await waitState(host, state => state.phase === 'WAITING');
  const joined = await request(guest, 'join_room', { roomCode: created.roomCode, playerName: 'Khôi phục B', avatar: '🎲' }); await waitState(host, state => state.players.length === 2);
  await act(host, 'buy_in', { amount: 200 }, state => state.myStack === 200); await waitState(guest, state => state.revision >= host.state.revision); await act(guest, 'buy_in', { amount: 200 }, state => state.myStack === 200);
  let revision = host.state.revision; host.emit('set_ready', { roomCode: created.roomCode, ready: true }); await waitState(host, state => state.revision > revision); revision = guest.state.revision; guest.emit('set_ready', { roomCode: created.roomCode, ready: true }); await waitState(guest, state => state.revision > revision);
  host.emit('start_game', { roomCode: created.roomCode }); const started = await waitState(host, state => state.phase === 'HAND'); const first = started.currentPlayerId === started.myId ? host : guest, second = first === host ? guest : host;
  await act(first, 'all_in'); await waitState(second, state => state.currentPlayerId === state.myId); const savedHole = [...host.state.myHoleCards]; game.gm.poker.flush(); clients.forEach(client => client.disconnect()); await game.close();

  game = createGameServer({ databaseFile, storageFile }); url = await listen(); const restoredHost = await connect(url, created.profileToken), restoredGuest = await connect(url, joined.profileToken); clients.push(restoredHost, restoredGuest);
  await request(restoredHost, 'resume_room', { roomCode: created.roomCode, sessionToken: created.sessionToken }); await request(restoredGuest, 'resume_room', { roomCode: created.roomCode, sessionToken: joined.sessionToken });
  const resumed = await waitState(restoredHost, state => state.phase === 'HAND' && !state.paused); assert.deepEqual(resumed.myHoleCards, savedHole); assert.equal(game.gm.profiles.publicProfile(game.gm.poker.rooms.get(created.roomCode).players[0].profileId).wallet.reserved, 200);
  const restoredActor = resumed.currentPlayerId === resumed.myId ? restoredHost : restoredGuest; await act(restoredActor, 'call'); await waitState(restoredHost, state => state.phase === 'RESULT'); const matchId = restoredHost.state.matchId; game.gm.poker.flush(); restoredHost.disconnect(); restoredGuest.disconnect(); await game.close();

  game = createGameServer({ databaseFile, storageFile }); url = await listen(); const resultHost = await connect(url, created.profileToken); clients.push(resultHost); await request(resultHost, 'resume_room', { roomCode: created.roomCode, sessionToken: created.sessionToken }); const result = await waitState(resultHost, state => state.phase === 'RESULT');
  assert.equal(result.matchId, matchId); assert.equal(game.gm.poker.rooms.get(created.roomCode).players.reduce((sum, player) => sum + player.stack, 0), 400); assert.equal(game.gm.profiles.db.prepare('SELECT COUNT(*) AS count FROM matches WHERE match_id = ?').get(matchId).count, 1);
});
