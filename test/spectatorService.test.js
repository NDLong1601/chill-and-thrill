'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { io: connectSocket } = require('socket.io-client');
const { passwordHash } = require('../src/platform/roomConfig');
const { SpectatorService, attachSpectatorRoutes, attachSpectatorSupport, spectatorChannel } = require('../src/platform/spectatorService');

class FakeSocket {
  constructor(id) { this.id = id; this.connected = true; this.data = {}; this.handlers = new Map(); this.middlewares = []; this.events = []; this.channels = new Set(); }
  on(name, handler) { const handlers = this.handlers.get(name) || []; handlers.push(handler); this.handlers.set(name, handlers); return this; }
  use(handler) { this.middlewares.push(handler); }
  emit(name, payload) { this.events.push({ name, payload }); return this; }
  async join(channel) { this.channels.add(channel); }
  async leave(channel) { this.channels.delete(channel); }
  async request(name, data = {}) {
    for (const middleware of this.middlewares) {
      const error = await new Promise(resolve => middleware([name, data], resolve));
      if (error) return { blocked: true, error };
    }
    const handler = this.handlers.get(name)?.[0];
    if (!handler) return null;
    return await new Promise(resolve => handler(data, resolve));
  }
  disconnect() { this.connected = false; for (const handler of this.handlers.get('disconnect') || []) handler('client disconnect'); }
}

class FakeIo {
  constructor() { this.handlers = new Map(); this.sockets = { sockets: new Map() }; }
  on(name, handler) { const handlers = this.handlers.get(name) || []; handlers.push(handler); this.handlers.set(name, handlers); }
  off(name, handler) { this.handlers.set(name, (this.handlers.get(name) || []).filter(item => item !== handler)); }
  connect(socket) { this.sockets.sockets.set(socket.id, socket); for (const handler of this.handlers.get('connection') || []) handler(socket); }
  to(channel) { return { emit: (name, payload) => { for (const socket of this.sockets.sockets.values()) if (socket.channels.has(channel)) socket.emit(name, payload); } }; }
}

function mockGame({ code = 'T3ST', visibility = 'public', password = null } = {}) {
  const room = { code, gameId: 'tien-len', phase: 'WAITING', revision: 1,
    config: { visibility, passwordHash: password ? passwordHash(password) : null },
    players: [{ id: 'one', name: 'One', avatar: '🎲', isHost: true, ready: true, connected: true, hand: ['SECRET'] }] };
  const manager = { rooms: new Map([[code, room]]), playerRoom: new Map(), buildStateFor: () => ({
    gameId: 'tien-len', roomCode: code, phase: room.phase, revision: room.revision, currentPlayerId: null,
    myHand: ['SECRET'], drawPile: ['SECRET'], sessionToken: 'TOKEN', players: room.players.map(player => ({ ...player, handCount: 13 })),
  }) };
  const gm = { gang: manager, tienLen: manager, managerForCode: candidate => manager.rooms.get(candidate) ? manager : null, gameIdForRoom: () => 'tien-len' };
  return { gm, manager, room };
}

function supportForGame(game) {
  const mounted = game.spectators;
  if (mounted) {
    const service = mounted.service || mounted;
    return { service, close: () => { if (typeof mounted.close === 'function') mounted.close(); else service.close?.(); } };
  }
  return attachSpectatorSupport(game.app, game.io, game.gm);
}

test('missing room and a wrong password share the same response; invite-only policy is respected', () => {
  const io = new FakeIo(), { gm } = mockGame({ visibility: 'invite', password: 'correct' });
  const service = new SpectatorService({ io, gm });
  assert.deepEqual(service.stateResponse('MISS', 'wrong'), service.stateResponse('T3ST', 'wrong'));
  assert.equal(service.stateResponse('T3ST', 'correct').ok, true);
  assert.equal(service.stateResponse('T3ST', 'correct').readOnly, true);
  service.close();
});

test('spectator sockets join only the separate bounded channel and cannot switch to a player role in place', async () => {
  const io = new FakeIo(), { gm, manager } = mockGame();
  const service = new SpectatorService({ io, gm, maxPerRoom: 1, maxTotal: 2 });
  const playerSocket = new FakeSocket('player');
  playerSocket.channels.add('T3ST');
  const watcher = new FakeSocket('watcher');
  manager.playerRoom.set(playerSocket.id, 'T3ST');
  io.connect(playerSocket); io.connect(watcher);

  const playerDenied = await playerSocket.request('spectator:join', { roomCode: 'T3ST' });
  assert.equal(playerDenied.code, 'SPECTATOR_UNAVAILABLE');
  const joined = await watcher.request('spectator:join', { roomCode: 'T3ST' });
  assert.equal(joined.ok, true);
  assert.deepEqual([...watcher.channels], [spectatorChannel('T3ST')]);
  assert.equal(playerSocket.events.some(event => event.name === 'spectator:state'), false);
  assert.equal(watcher.events.some(event => event.name === 'game_state'), false);
  assert.deepEqual(watcher.data, {});
  assert.equal(service.watcherCount('T3ST'), 1);

  const blocked = await watcher.request('join_room', { roomCode: 'T3ST' });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.error.data.code, 'SPECTATOR_READ_ONLY');
  assert.equal(manager.rooms.get('T3ST').players.length, 1);
  await watcher.request('spectator:leave');
  assert.equal(service.watcherCount('T3ST'), 0);
  assert.deepEqual([...watcher.channels], []);
  service.close();
});

test('watch registry cleans up on disconnect and enforces per-room limits', async () => {
  const io = new FakeIo(), { gm } = mockGame();
  const service = new SpectatorService({ io, gm, maxPerRoom: 1 });
  const first = new FakeSocket('first'), second = new FakeSocket('second');
  io.connect(first); io.connect(second);
  assert.equal((await first.request('spectator:join', { roomCode: 'T3ST' })).ok, true);
  assert.equal((await second.request('spectator:join', { roomCode: 'T3ST' })).code, 'SPECTATOR_LIMIT');
  first.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.watcherCount('T3ST'), 0);
  assert.equal((await second.request('spectator:join', { roomCode: 'T3ST' })).ok, true);
  service.close();
});

test('publisher emits only after the transaction guard clears and only to the spectator channel', async () => {
  const io = new FakeIo(), { gm, manager } = mockGame();
  const service = new SpectatorService({ io, gm });
  const playerSocket = new FakeSocket('player'), watcher = new FakeSocket('watcher');
  playerSocket.channels.add('T3ST'); io.connect(playerSocket); io.connect(watcher);
  await watcher.request('spectator:join', { roomCode: 'T3ST' });
  manager.coinTransactionDepth = 1;
  assert.equal(service.publishCommittedRoom('T3ST'), false);
  assert.equal(watcher.events.filter(event => event.name === 'spectator:state').length, 1);
  manager.coinTransactionDepth = 0;
  manager.rooms.get('T3ST').revision++;
  assert.equal(service.publishCommittedRoom('T3ST'), true);
  const events = watcher.events.filter(event => event.name === 'spectator:state');
  assert.equal(events.length, 2);
  assert.equal(events[1].payload.revision, 2);
  assert.equal(playerSocket.events.some(event => event.name === 'spectator:state'), false);
  service.close();
});

test('player game_state emissions become spectator updates only after the commit guard clears', async () => {
  const io = new FakeIo(), { gm, manager } = mockGame();
  const service = new SpectatorService({ io, gm });
  const player = new FakeSocket('player'), watcher = new FakeSocket('watcher');
  manager.playerRoom.set(player.id, 'T3ST');
  io.connect(player); io.connect(watcher);
  await watcher.request('spectator:join', { roomCode: 'T3ST' });
  const baseline = watcher.events.filter(event => event.name === 'spectator:state').length;

  // A mutation that is rolled back drops its buffered player event. Even an
  // accidental emission while the transaction flag is set cannot publish.
  manager.coinTransactionDepth = 1;
  manager.rooms.get('T3ST').revision = 99;
  player.emit('game_state', { result: 'FALSE_RESULT' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(watcher.events.filter(event => event.name === 'spectator:state').length, baseline);
  manager.rooms.get('T3ST').revision = 1;
  manager.coinTransactionDepth = 0;

  // The transaction wrapper replays this socket effect only after commit.
  manager.rooms.get('T3ST').revision = 2;
  player.emit('game_state', { myHand: ['PRIVATE_HAND_MARKER'] });
  await new Promise(resolve => setImmediate(resolve));
  const states = watcher.events.filter(event => event.name === 'spectator:state');
  assert.equal(states.length, baseline + 1);
  assert.equal(states.at(-1).payload.revision, 2);
  assert.equal(JSON.stringify(states.at(-1).payload).includes('PRIVATE_HAND_MARKER'), false);
  service.close();
});

test('a closed room drops spectator membership before its code can be reused', async () => {
  const io = new FakeIo(), { gm, manager } = mockGame();
  const service = new SpectatorService({ io, gm });
  const watcher = new FakeSocket('watcher'), player = new FakeSocket('player');
  manager.playerRoom.set(player.id, 'T3ST');
  io.connect(watcher); io.connect(player);
  assert.equal((await watcher.request('spectator:join', { roomCode: 'T3ST' })).ok, true);
  player.emit('game_state', { roomCode: 'T3ST' });
  await new Promise(resolve => setImmediate(resolve));
  const beforeCloseCount = watcher.events.filter(event => event.name === 'spectator:state').length;

  manager.rooms.delete('T3ST');
  manager.playerRoom.delete(player.id);
  player.emit('room_left');
  assert.equal(service.watcherCount('T3ST'), 0);
  assert.equal(watcher.events.some(event => event.name === 'spectator:unavailable'), true);
  manager.rooms.set('T3ST', { code: 'T3ST', gameId: 'tien-len', phase: 'WAITING', config: {} });
  manager.playerRoom.set(player.id, 'T3ST');
  player.emit('game_state', { roomCode: 'T3ST' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(watcher.events.filter(event => event.name === 'spectator:state').length, beforeCloseCount);
  assert.equal(service.roomBySocket.has(watcher.id), false);
  service.close();
});

test('HTTP state route uses the same privacy/password gate and disables caching', async t => {
  const app = express(); app.use(express.json());
  const io = new FakeIo(), { gm } = mockGame({ visibility: 'invite', password: 'door' });
  const service = new SpectatorService({ io, gm }); attachSpectatorRoutes(app, service);
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { service.close(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (code, password) => fetch(`${base}/api/spectators/${code}/state`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  });
  const deniedRoom = await post('MISS', 'bad'), deniedPassword = await post('T3ST', 'bad');
  assert.equal(deniedRoom.status, 404); assert.equal(deniedPassword.status, 404);
  assert.deepEqual(await deniedRoom.json(), await deniedPassword.json());
  const allowed = await post('T3ST', 'door');
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  const body = await allowed.json();
  assert.equal(body.readOnly, true);
  assert.equal(JSON.stringify(body).includes('SECRET'), false);
  assert.equal(JSON.stringify(body).includes('TOKEN'), false);
  assert.equal(body.profileId, undefined);
});

test('real HTTP and Socket.IO integration keeps invite rooms private, states read-only, and the shared ledger unchanged', async t => {
  const { createGameServer } = require('../src/httpServer');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spectator-c07-'));
  const game = createGameServer({ storageFile: path.join(directory, 'rooms.json'), databaseFile: path.join(directory, 'profiles.sqlite') });
  const support = supportForGame(game);
  const clients = [];
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${game.server.address().port}`;
  t.after(async () => {
    clients.forEach(client => client.disconnect()); support.close(); await game.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const profileResponse = await fetch(`${base}/api/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'C07 host' }) });
  const profile = await profileResponse.json();
  const connect = token => new Promise((resolve, reject) => {
    const client = connectSocket(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: token ? { profileToken: token } : {} });
    clients.push(client); client.once('connect', () => resolve(client)); client.once('connect_error', reject);
  });
  const request = (client, event, data = {}) => new Promise((resolve, reject) => client.timeout(3000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
  const host = await connect(profile.profileToken);
  const created = await request(host, 'room:create', { gameId: 'the-gang', playerName: 'C07 host', config: { maxPlayers: 4, visibility: 'invite', password: 'watch-secret' } });
  assert.equal(created.error, undefined);
  const roomCode = created.roomCode;
  const counts = () => Object.fromEntries(['wallets', 'wallet_ledger', 'wallet_operations', 'reservations', 'rooms', 'matches', 'game_snapshots'].map(table => [table, game.gm.profiles.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  const before = counts();

  const pageResponse = await fetch(`${base}/spectate/${roomCode}`);
  assert.equal(pageResponse.status, 200);
  assert.match(await pageResponse.text(), /Bạn có thể theo dõi trạng thái công khai/);
  assert.equal((await fetch(`${base}/css/spectator.css`)).status, 200);
  assert.equal((await fetch(`${base}/js/spectator.js`)).status, 200);
  const wrong = await fetch(`${base}/api/spectators/${roomCode}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'bad' }) });
  const missing = await fetch(`${base}/api/spectators/MISS/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'bad' }) });
  assert.equal(wrong.status, 404); assert.deepEqual(await wrong.json(), await missing.json());
  const apiState = await fetch(`${base}/api/spectators/${roomCode}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'watch-secret' }) });
  assert.equal(apiState.status, 200);
  const projected = await apiState.json();
  const projectedText = JSON.stringify(projected);
  assert.equal(projected.state.gameId, 'the-gang');
  assert.equal(projected.readOnly, true);
  assert.equal(projectedText.includes(profile.profileToken), false);
  assert.equal(projectedText.includes(created.sessionToken), false);
  assert.equal(projectedText.includes(profile.profile.id), false);
  assert.equal(projectedText.includes('privateCards'), false);

  const watcher = await connect(profile.profileToken); // Auth alone does not make this socket a seat.
  const liveStates = []; watcher.on('spectator:state', state => liveStates.push(state));
  const denied = await request(watcher, 'spectator:join', { roomCode });
  assert.equal(denied.code, 'SPECTATOR_UNAVAILABLE');
  const joined = await request(watcher, 'spectator:join', { roomCode, password: 'watch-secret' });
  assert.equal(joined.ok, true);
  assert.deepEqual([...support.service.roomBySocket.values()], [roomCode]);
  const roleError = new Promise(resolve => watcher.once('spectator:role_error', resolve));
  watcher.emit('room:join', { roomCode, playerName: 'Should stay a watcher', password: 'watch-secret' });
  assert.equal((await roleError).code, 'SPECTATOR_READ_ONLY');
  assert.equal(game.gm.gang.rooms.get(roomCode).players.length, 1);
  assert.equal(game.gm.gang.playerRoom.has(watcher.id), false);
  assert.equal((await request(host, 'spectator:join', { roomCode, password: 'watch-secret' })).code, 'SPECTATOR_UNAVAILABLE');

  const eventCount = liveStates.length;
  assert.equal(support.service.publishCommittedRoom(roomCode), true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(liveStates.length > eventCount);
  assert.equal(liveStates.at(-1).gameId, 'the-gang');
  assert.deepEqual(counts(), before);
  assert.equal(support.service.watcherCount(roomCode), 1);
  const hostSpectatorDenied = await request(host, 'spectator:join', { roomCode, password: 'watch-secret' });
  assert.equal(hostSpectatorDenied.code, 'SPECTATOR_UNAVAILABLE');
  await request(watcher, 'spectator:leave');
  const standardPasswordGate = await request(watcher, 'room:join', { roomCode, playerName: 'Wrong password', password: 'bad' });
  assert.match(standardPasswordGate.error, /mật khẩu/i);
  assert.equal(game.gm.gang.rooms.get(roomCode).players.length, 1);
  await request(watcher, 'spectator:join', { roomCode, password: 'watch-secret' });
  watcher.disconnect();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(support.service.watcherCount(roomCode), 0);
  assert.deepEqual(counts(), before);

  const oldWatcher = await connect(null), oldRoomEvents = [];
  oldWatcher.on('spectator:state', state => oldRoomEvents.push(state));
  assert.equal((await request(oldWatcher, 'spectator:join', { roomCode, password: 'watch-secret' })).ok, true);
  const closedNotice = new Promise(resolve => oldWatcher.once('spectator:unavailable', resolve));
  const playerLeft = new Promise(resolve => host.once('room_left', resolve));
  host.emit('leave_room', { roomCode });
  await playerLeft;
  await closedNotice;
  assert.equal(game.gm.gang.rooms.has(roomCode), false);
  assert.equal(support.service.watcherCount(roomCode), 0);
  const eventCountBeforeReuse = oldRoomEvents.length;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const originalRandomInt = crypto.randomInt;
  const targetIndices = [...roomCode].map(character => alphabet.indexOf(character));
  crypto.randomInt = (upperBound, ...rest) => upperBound === alphabet.length && targetIndices.length
    ? targetIndices.shift()
    : Reflect.apply(originalRandomInt, crypto, [upperBound, ...rest]);
  let recreated;
  try {
    recreated = await request(host, 'room:create', { gameId: 'the-gang', playerName: 'C07 host', config: { maxPlayers: 4, visibility: 'invite', password: 'new-watch-secret' } });
  } finally { crypto.randomInt = originalRandomInt; }
  assert.equal(targetIndices.length, 0);
  assert.equal(recreated.roomCode, roomCode);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(support.service.watcherCount(roomCode), 0);
  assert.equal(oldRoomEvents.length, eventCountBeforeReuse);
  assert.equal(support.service.roomBySocket.has(oldWatcher.id), false);
});

test('real coin and Poker snapshot failures roll back without publishing spectator state or ledger changes', async t => {
  const { createGameServer } = require('../src/httpServer');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spectator-c07-commit-'));
  const game = createGameServer({ storageFile: path.join(directory, 'rooms.json'), databaseFile: path.join(directory, 'profiles.sqlite') });
  const support = supportForGame(game);
  const clients = [];
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${game.server.address().port}`;
  t.after(async () => {
    clients.forEach(client => client.disconnect()); support.close(); await game.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function makeProfile(name) {
    const response = await fetch(`${base}/api/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    return response.json();
  }
  function connect(token) { return new Promise((resolve, reject) => {
    const client = connectSocket(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { profileToken: token } });
    clients.push(client); client.once('connect', () => resolve(client)); client.once('connect_error', reject);
  }); }
  const request = (client, event, data = {}) => new Promise((resolve, reject) => client.timeout(3000).emit(event, data, (error, result) => error ? reject(error) : resolve(result)));
  const counts = () => Object.fromEntries(['wallets', 'wallet_ledger', 'wallet_operations', 'reservations', 'rooms', 'matches', 'game_snapshots'].map(table => [table, game.gm.profiles.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async predicate => {
    const expires = Date.now() + 3000;
    while (Date.now() < expires) { if (predicate()) return; await pause(10); }
    throw new Error('Timed out waiting for the test room to update.');
  };
  const originalSave = game.gm.profiles.saveGameSnapshot.bind(game.gm.profiles);
  let failGameId = null;
  game.gm.profiles.saveGameSnapshot = input => {
    if (input.gameId === failGameId) throw new Error(`injected ${failGameId} snapshot failure`);
    return originalSave(input);
  };

  const hostProfile = await makeProfile('Coin host'), guestProfile = await makeProfile('Coin guest');
  const host = await connect(hostProfile.profileToken), guest = await connect(guestProfile.profileToken), watcher = await connect(guestProfile.profileToken);
  const created = await request(host, 'create_room', { gameId: 'tien-len', playerName: 'Coin host' });
  const code = created.roomCode;
  await request(guest, 'join_room', { roomCode: code, playerName: 'Coin guest' });
  host.emit('set_ready', { roomCode: code, ready: true });
  guest.emit('set_ready', { roomCode: code, ready: true });
  await waitFor(() => game.gm.tienLen.rooms.get(code)?.players.every(player => player.ready));
  assert.equal((await request(watcher, 'spectator:join', { roomCode: code })).ok, true);
  const coinEvents = []; watcher.on('spectator:state', state => coinEvents.push(state));
  const coinRoom = game.gm.tienLen.rooms.get(code), coinRevision = coinRoom.revision;
  const beforeCoinBalances = [hostProfile, guestProfile].map(profile => game.gm.profiles.publicProfile(profile.profile.id).balances.coin);
  const beforeCoinCounts = counts();
  failGameId = 'tien-len';
  host.emit('start_game', { roomCode: code });
  await pause(30);
  failGameId = null;
  assert.equal(coinRoom.phase, 'WAITING');
  assert.equal(coinRoom.revision, coinRevision);
  assert.equal(coinEvents.length, 0);
  assert.deepEqual([hostProfile, guestProfile].map(profile => game.gm.profiles.publicProfile(profile.profile.id).balances.coin), beforeCoinBalances);
  assert.deepEqual(counts(), beforeCoinCounts);

  host.emit('start_game', { roomCode: code });
  await waitFor(() => game.gm.tienLen.rooms.get(code)?.phase === 'TURN');
  await waitFor(() => coinEvents.some(state => state.phase === 'TURN'));
  const activeView = await fetch(`${base}/api/spectators/${code}/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await activeView.json()).policy.canJoinSeat, false);
  const afterStartCounts = counts();
  const afterStartBalances = [hostProfile, guestProfile].map(profile => game.gm.profiles.publicProfile(profile.profile.id).balances.coin);
  const roleError = new Promise(resolve => watcher.once('spectator:role_error', resolve));
  watcher.emit('room:join', { roomCode: code, playerName: 'Active table interloper' });
  assert.equal((await roleError).code, 'SPECTATOR_READ_ONLY');
  await request(watcher, 'spectator:leave');
  const activeJoin = await request(watcher, 'join_room', { roomCode: code, playerName: 'Active table interloper' });
  assert.match(activeJoin.error, /Ván đang diễn ra/i);
  assert.deepEqual(counts(), afterStartCounts);
  assert.deepEqual([hostProfile, guestProfile].map(profile => game.gm.profiles.publicProfile(profile.profile.id).balances.coin), afterStartBalances);

  const pokerProfile = await makeProfile('Poker host'), pokerHost = await connect(pokerProfile.profileToken);
  const pokerCreated = await request(pokerHost, 'create_room', { gameId: 'poker', playerName: 'Poker host' });
  const pokerCode = pokerCreated.roomCode;
  assert.equal((await request(watcher, 'spectator:leave')).ok, true);
  assert.equal((await request(watcher, 'spectator:join', { roomCode: pokerCode })).ok, true);
  const pokerEvents = []; watcher.on('spectator:state', state => pokerEvents.push(state));
  const pokerRoom = game.gm.poker.rooms.get(pokerCode), pokerRevision = pokerRoom.revision;
  const pokerBalance = game.gm.profiles.publicProfile(pokerProfile.profile.id).balances.chip;
  const beforePokerCounts = counts();
  failGameId = 'poker';
  pokerHost.emit('game_action', { roomCode: pokerCode, action: 'buy_in', amount: 200, actionId: 'c07-failed-buyin' });
  await pause(30);
  failGameId = null;
  assert.equal(pokerRoom.phase, 'WAITING');
  assert.equal(pokerRoom.revision, pokerRevision);
  assert.equal(pokerRoom.players[0].stack, 0);
  assert.equal(pokerEvents.length, 0);
  assert.deepEqual(game.gm.profiles.publicProfile(pokerProfile.profile.id).balances.chip, pokerBalance);
  assert.deepEqual(counts(), beforePokerCounts);
  game.gm.profiles.saveGameSnapshot = originalSave;
});
