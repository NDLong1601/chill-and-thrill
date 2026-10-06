'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { GAME_VARIANT_TARGETS } = require('../src/platform/gameAdapterContract');
const { createGameServer } = require('../src/httpServer');

const ADMIN_SECRET = 'C05-real-server-integration-secret-more-than-32-bytes';

function connect(url, profileToken = null) {
  return new Promise((resolve, reject) => {
    const client = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, auth: profileToken ? { profileToken } : {} });
    client.on('game_state', state => { client.state = state; });
    client.on('game_error', payload => { client.lastError = payload.message; });
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
}

function request(client, event, data) {
  return new Promise((resolve, reject) => client.timeout(4000).emit(event, data,
    (error, result) => error ? reject(error) : resolve(result)));
}

function waitFor(predicate, label, timeoutMs = 6000) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const end = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() >= end) return reject(new Error(`Timed out waiting for ${label}.`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function waitState(client, predicate, label) {
  if (client.state && predicate(client.state)) return Promise.resolve(client.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('game_state', onState);
      reject(new Error(`Timed out waiting for ${label}; last game error: ${client.lastError || 'none'}`));
    }, 6000);
    function onState(state) {
      if (!predicate(state)) return;
      clearTimeout(timer); client.off('game_state', onState); resolve(state);
    }
    client.on('game_state', onState);
  });
}

function createOptions(directory) {
  return {
    adminSecret: ADMIN_SECRET,
    databaseFile: path.join(directory, 'profiles.sqlite'),
    storageFile: path.join(directory, 'rooms.json'),
    unoStorageFile: path.join(directory, 'uno.json'),
    tienLenStorageFile: path.join(directory, 'tien-len.json'),
    pokerStorageFile: path.join(directory, 'poker.json'),
    samLocStorageFile: path.join(directory, 'sam-loc.json'),
    phomStorageFile: path.join(directory, 'phom.json'),
    bangStorageFile: path.join(directory, 'bang.json'),
    graceMs: 30000,
  };
}

async function listen(game) {
  await new Promise((resolve, reject) => {
    game.server.once('error', reject);
    game.server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${game.server.address().port}`;
}

async function adminRequest(base, pathname, { method = 'GET', secret = ADMIN_SECRET, origin, body, query } = {}) {
  const url = new URL(pathname, base);
  if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method,
    headers: {
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('json') ? await response.json() : await response.text();
  return { response, payload };
}

function managerRoomCount(gm) {
  return [gm.gang, gm.uno, gm.tienLen, gm.poker, gm.samLoc, gm.phom, gm.bang].reduce((total, manager) => total + manager.rooms.size, 0);
}

test('real server admin gates all eight variants, preserves legacy entrypoints, and resets maintenance after restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-c05-gate-'));
  let game = createGameServer(createOptions(directory));
  const clients = [];
  t.after(async () => {
    clients.forEach(client => client.disconnect());
    await game.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let base = await listen(game);
  assert.equal(game.adminService.getStatus().server.maintenance, false);
  assert.equal((await fetch(`${base}/admin`)).status, 200);
  assert.equal((await fetch(`${base}/admin.html`)).status, 200);

  const unauthenticated = await adminRequest(base, '/api/admin/status', { secret: null });
  assert.equal(unauthenticated.response.status, 401);
  const queryCredential = await adminRequest(base, '/api/admin/status', { secret: null, query: { token: ADMIN_SECRET } });
  assert.equal(queryCredential.response.status, 401);
  const profile = game.gm.profiles.createProfile({ displayName: 'C05 auth fixture' });
  const profileCredential = await adminRequest(base, '/api/admin/status', { secret: profile.sessionToken });
  assert.equal(profileCredential.response.status, 401);

  const initial = await adminRequest(base, '/api/admin/status');
  assert.equal(initial.response.status, 200);
  assert.ok(initial.payload.addresses.length > 0);
  assert.deepEqual(initial.payload.rooms, []);
  assert.equal(initial.payload.financialTools.available, false);
  const deniedQr = await adminRequest(base, '/api/admin/network-qr/0.svg', { secret: null });
  assert.equal(deniedQr.response.status, 401);
  const qr = await adminRequest(base, '/api/admin/network-qr/0.svg');
  assert.equal(qr.response.status, 200);
  assert.match(String(qr.payload), /<svg/);

  const adminOrigin = base;
  const crossOrigin = await adminRequest(base, '/api/admin/maintenance', {
    method: 'POST', origin: 'http://attacker.example', body: { enabled: true, operationId: 'cross-origin-0001' },
  });
  assert.equal(crossOrigin.response.status, 403);
  const enabled = await adminRequest(base, '/api/admin/maintenance', {
    method: 'POST', origin: adminOrigin, body: { enabled: true, operationId: 'maintenance-gate-0001' },
  });
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.payload.maintenance, true);

  const creator = await connect(base); clients.push(creator);
  let variantIndex = 0;
  for (const [gameId, variants] of Object.entries(GAME_VARIANT_TARGETS)) {
    for (const variant of Object.keys(variants)) {
      const result = await request(creator, 'room:create', {
        gameId,
        playerName: `C05 gate ${++variantIndex}`,
        config: { variant },
      });
      assert.equal(result?.code, 'MAINTENANCE_ACTIVE', `${gameId}/${variant} should be blocked: ${JSON.stringify(result)}`);
      assert.match(result.error, /bảo trì/i);
    }
  }
  assert.equal(variantIndex, 8);
  const legacyResult = await request(creator, 'create_room', { playerName: 'Legacy gate', gameId: 'the-gang' });
  assert.equal(legacyResult?.code, 'MAINTENANCE_ACTIVE');
  const restEntry = game.roomService.createRoom({ id: 'c05-rest-entry', data: {} }, { gameId: 'the-gang', playerName: 'REST gate' });
  assert.equal(restEntry?.code, 'MAINTENANCE_ACTIVE');
  assert.equal(managerRoomCount(game.gm), 0, 'blocked room requests must not mutate any manager');
  assert.equal(game.gm.profiles.db.prepare("SELECT COUNT(*) AS count FROM profiles WHERE display_name LIKE 'C05 gate%' OR display_name = 'Legacy gate'").get().count, 0,
    'blocked room requests must not bootstrap player wallets');

  clients.forEach(client => client.disconnect()); clients.length = 0;
  await game.close();
  game = createGameServer(createOptions(directory));
  base = await listen(game);
  const restarted = await adminRequest(base, '/api/admin/status');
  assert.equal(restarted.response.status, 200);
  assert.equal(restarted.payload.server.maintenance, false, 'maintenance resets safely on server restart');
  const afterRestartCreator = await connect(base); clients.push(afterRestartCreator);
  const allowed = await request(afterRestartCreator, 'room:create', { gameId: 'the-gang', playerName: 'After maintenance' });
  assert.ok(allowed?.roomCode, allowed?.error);
  assert.equal(game.gm.publicRoom(allowed.roomCode).gameId, 'the-gang');
});

function balancesSnapshot(game, profileIds) {
  return profileIds.map(profileId => {
    const profile = game.gm.profiles.publicProfile(profileId);
    return { profileId, balances: profile.balances };
  });
}

async function createRoom(client, gameId, name, variant) {
  const result = await request(client, 'room:create', {
    gameId, playerName: name, avatar: '🎲', config: variant ? { variant } : {},
  });
  assert.ok(result?.roomCode, result?.error);
  await waitState(client, state => state.roomCode === result.roomCode, `${gameId} initial state`);
  return result;
}

async function joinRoom(client, roomCode, name, profileToken = undefined) {
  const result = await request(client, 'room:join', { roomCode, playerName: name, avatar: '🃏', ...(profileToken ? { profileToken } : {}) });
  assert.equal(result?.error, undefined, result?.error);
  return result;
}

async function readyBoth(game, roomCode, host, guest, manager, phase = 'WAITING') {
  host.emit('set_ready', { roomCode, ready: true });
  await waitState(host, state => state.roomCode === roomCode && state.players?.length >= 2 && state.players.every(player => player.ready), 'host ready');
  guest.emit('set_ready', { roomCode, ready: true });
  await waitState(guest, state => state.roomCode === roomCode && state.players?.length >= 2 && state.players.every(player => player.ready), 'guest ready');
  await waitFor(() => manager.rooms.get(roomCode)?.players.every(player => player.ready), 'server ready state');
  host.emit('start_game', { roomCode });
  await waitState(host, state => state.roomCode === roomCode && state.phase !== phase, 'game start');
}

test('maintenance leaves live coin and Poker tables usable for join, resume, actions, settlement, and leave', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-c05-live-'));
  const game = createGameServer(createOptions(directory));
  const clients = [];
  t.after(async () => {
    clients.forEach(client => client.disconnect());
    await game.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = await listen(game);
  const coinHost = await connect(base), coinGuest = await connect(base);
  const pokerHost = await connect(base), pokerGuest = await connect(base);
  clients.push(coinHost, coinGuest, pokerHost, pokerGuest);

  const coinCreated = await createRoom(coinHost, 'tien-len', 'C05 coin host');
  const coinJoined = await joinRoom(coinGuest, coinCreated.roomCode, 'C05 coin guest');
  const coinRoom = game.gm.tienLen.rooms.get(coinCreated.roomCode);
  coinHost.emit('set_ready', { roomCode: coinCreated.roomCode, ready: true });
  await waitState(coinHost, state => state.players?.find(player => player.id === coinCreated.playerId)?.ready === true, 'coin host ready');
  coinGuest.emit('set_ready', { roomCode: coinCreated.roomCode, ready: true });
  await waitState(coinHost, state => state.players?.length === 2 && state.players.every(player => player.ready), 'coin guest ready');
  coinHost.emit('start_game', { roomCode: coinCreated.roomCode });
  await waitState(coinHost, state => state.roomCode === coinCreated.roomCode && state.phase === 'TURN', 'coin game start');

  const pokerCreated = await createRoom(pokerHost, 'poker', 'C05 Poker host');
  const pokerJoined = await joinRoom(pokerGuest, pokerCreated.roomCode, 'C05 Poker guest');
  const pokerRoom = game.gm.poker.rooms.get(pokerCreated.roomCode);
  let pokerRevision = pokerRoom.revision;
  pokerHost.emit('game:action', { roomCode: pokerCreated.roomCode, action: 'buy_in', amount: 200, actionId: 'c05-poker-buy-host', expectedRevision: pokerRevision });
  await waitFor(() => pokerRoom.players[0].stack === 200, 'Poker host buy-in');
  pokerRevision = pokerRoom.revision;
  pokerGuest.emit('game:action', { roomCode: pokerCreated.roomCode, action: 'buy_in', amount: 200, actionId: 'c05-poker-buy-guest', expectedRevision: pokerRevision });
  await waitFor(() => pokerRoom.players[1].stack === 200, 'Poker guest buy-in');
  pokerHost.emit('set_ready', { roomCode: pokerCreated.roomCode, ready: true });
  await waitState(pokerHost, state => state.players?.find(player => player.id === pokerCreated.playerId)?.ready === true, 'Poker host ready');
  pokerGuest.emit('set_ready', { roomCode: pokerCreated.roomCode, ready: true });
  await waitState(pokerHost, state => state.players?.length === 2 && state.players.every(player => player.ready), 'Poker guest ready');
  pokerHost.emit('start_game', { roomCode: pokerCreated.roomCode });
  await waitState(pokerHost, state => state.roomCode === pokerCreated.roomCode && state.phase === 'HAND', 'Poker hand start');

  const maintenanceProfile = game.gm.profiles.createProfile({ displayName: 'C05 join while maintenance' });
  const joiner = await connect(base, maintenanceProfile.sessionToken); clients.push(joiner);
  const involvedProfiles = [...coinRoom.players, ...pokerRoom.players].map(player => player.profileId);
  const before = balancesSnapshot(game, involvedProfiles);
  const ledgerCount = game.gm.profiles.db.prepare('SELECT COUNT(*) AS count FROM wallet_ledger').get().count;
  const toggle = await adminRequest(base, '/api/admin/maintenance', {
    method: 'POST', origin: base, body: { enabled: true, operationId: 'c05-live-maintenance-01' },
  });
  assert.equal(toggle.response.status, 200);
  assert.deepEqual(balancesSnapshot(game, involvedProfiles), before, 'enabling maintenance does not touch coin or chip balances');
  assert.equal(game.gm.profiles.db.prepare('SELECT COUNT(*) AS count FROM wallet_ledger').get().count, ledgerCount);

  const joinedDuringHand = await joinRoom(joiner, pokerCreated.roomCode, 'C05 poker joiner', maintenanceProfile.sessionToken);
  assert.equal(joinedDuringHand.roomCode, pokerCreated.roomCode);
  await waitFor(() => pokerRoom.players.length === 3, 'join existing Poker hand during maintenance');

  coinGuest.disconnect();
  await waitFor(() => coinRoom.players.find(player => player.profileId === coinJoined.profile?.id)?.connected === false, 'coin guest disconnect');
  const coinResumer = await connect(base, coinJoined.profileToken); clients.push(coinResumer);
  const resumed = await request(coinResumer, 'room:resume', { roomCode: coinCreated.roomCode, sessionToken: coinJoined.sessionToken, profileToken: coinJoined.profileToken });
  assert.equal(resumed?.error, undefined, resumed?.error);
  await waitFor(() => coinRoom.players.find(player => player.profileId === coinJoined.profile?.id)?.connected === true, 'resume existing coin seat during maintenance');

  const opener = coinRoom.players.find(player => player.id === coinRoom.currentPlayerId);
  const openerClient = [coinHost, coinResumer].find(client => client.state?.myId === opener.id);
  assert.ok(openerClient, 'current Tiến lên player has a connected socket');
  const firstCard = opener.hand.find(card => card.id === coinRoom.initialRequiredCardId);
  assert.ok(firstCard, 'the lead hand owns the required first card');
  const beforeActionRevision = coinRoom.revision;
  openerClient.emit('game:action', {
    roomCode: coinCreated.roomCode, action: 'play', cardIds: [firstCard.id],
    actionId: 'c05-live-tien-len-action', expectedRevision: beforeActionRevision,
  });
  await waitFor(() => coinRoom.revision > beforeActionRevision, 'Tiến lên action during maintenance');

  // Force only the final hand shape in this temporary room fixture. The real
  // socket action below still passes through the manager and atomic settlement.
  const coinWinner = coinRoom.players[0];
  const winningCard = coinWinner.hand[0];
  coinRoom.phase = 'TURN'; coinRoom.currentPlayerId = coinWinner.id; coinRoom.leaderId = coinWinner.id;
  coinRoom.initialRequiredCardId = winningCard.id; coinRoom.playedAny = false; coinRoom.topPlay = null;
  coinRoom.passedIds = []; coinRoom.actionIds = {}; coinWinner.hand = [winningCard]; coinRoom.revision++;
  game.gm.tienLen.broadcast(coinCreated.roomCode);
  const beforeCoinSettlementRevision = coinRoom.revision;
  coinHost.emit('game:action', {
    roomCode: coinCreated.roomCode, action: 'play', cardIds: [winningCard.id],
    actionId: 'c05-live-tien-len-settle', expectedRevision: beforeCoinSettlementRevision,
  });
  await waitFor(() => coinRoom.phase === 'RESULT', 'Tiến lên settlement during maintenance');
  // The room retains reservation receipts for its result/history; SQL is the
  // authority for whether those funds are still held.
  for (const receipt of coinRoom.reservations) {
    assert.equal(game.gm.profiles.db.prepare('SELECT status FROM reservations WHERE id = ?').get(receipt.reservationId).status, 'SETTLED');
    assert.equal(game.gm.profiles.publicProfile(receipt.profileId).balances.coin.reserved, 0);
  }
  assert.equal(coinRoom.result.pot, 200);

  const currentPokerPlayer = pokerRoom.players.find(player => player.id === pokerRoom.currentPlayerId);
  const allInClient = [pokerHost, pokerGuest].find(client => client.state?.myId === currentPokerPlayer.id);
  assert.ok(allInClient, 'current Poker player has a connected socket');
  const actionRevision = pokerRoom.revision;
  allInClient.emit('game:action', {
    roomCode: pokerCreated.roomCode, action: 'all_in', actionId: 'c05-live-poker-allin', expectedRevision: actionRevision,
  });
  await waitFor(() => pokerRoom.revision > actionRevision && pokerRoom.currentPlayerId !== currentPokerPlayer.id, 'Poker all-in during maintenance');
  const caller = pokerRoom.players.find(player => player.id === pokerRoom.currentPlayerId);
  const callerClient = [pokerHost, pokerGuest].find(client => client.state?.myId === caller.id);
  assert.ok(callerClient, 'opponent has a connected socket');
  const callRevision = pokerRoom.revision;
  callerClient.emit('game:action', {
    roomCode: pokerCreated.roomCode, action: 'call', actionId: 'c05-live-poker-call', expectedRevision: callRevision,
  });
  await waitFor(() => pokerRoom.phase === 'RESULT', 'Poker settlement during maintenance');
  assert.equal(pokerRoom.players.reduce((sum, player) => sum + player.stack, 0), 400);
  assert.equal(game.gm.profiles.db.prepare('SELECT COUNT(*) AS count FROM matches WHERE match_id = ?').get(pokerRoom.matchId).count, 1);

  const beforeLeave = pokerRoom.players.length;
  const pokerLeaveClient = [pokerHost, pokerGuest].find(client => client.state?.myId === pokerRoom.players[0].id);
  pokerLeaveClient.emit('leave_room', { roomCode: pokerCreated.roomCode });
  await waitFor(() => pokerRoom.players.length === beforeLeave - 1, 'Poker cash-out and leave during maintenance');
  const coinLeavePlayer = coinRoom.players[0];
  const coinLeaveClient = [coinHost, coinResumer].find(client => client.state?.myId === coinLeavePlayer.id);
  coinLeaveClient.emit('leave_room', { roomCode: coinCreated.roomCode });
  await waitFor(() => coinRoom.players.length === 1, 'coin room leave during maintenance');
  assert.equal(game.adminService.getStatus().server.maintenance, true);
});
