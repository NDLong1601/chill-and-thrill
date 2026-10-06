'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'fixture condition timed out'); await pause(10); }
}
function deterministicShuffle(cards) {
  const result = [...cards]; let seed = 0x5eed1234;
  for (let i = result.length - 1; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1); [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
async function fixture(t) {
  const game = createGameServer({ databaseFile: ':memory:' }), clients = [];
  t.after(async () => { clients.forEach(client => client.disconnect()); await game.close(); });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${game.server.address().port}`;
  async function connect(token) {
    const client = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: token ? { profileToken: token } : {} });
    clients.push(client);
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    return client;
  }
  const members = [];
  for (let i = 0; i < 2; i++) {
    const p = game.gm.profiles.createProfile({ displayName: `Regression ${i}` });
    members.push({ id: p.profile.id, name: p.profile.displayName, avatar: '🎲', token: p.sessionToken, client: await connect(p.sessionToken) });
  }
  const groups = game.groupLobbyService, tournaments = game.groupTournaments.service, store = game.gm.profiles;
  const group = await groups.createGroup(members[0]), groupId = group.groupId;
  members[0].capability = group.groupCapability;
  members[1].capability = (await groups.joinGroup(members[1], group.inviteCapability)).groupCapability;
  const socket = i => game.io.sockets.sockets.get(members[i].client.id);
  const request = (client, event, data) => new Promise((resolve, reject) => client.timeout(3000).emit(event, data,
    (error, result) => error ? reject(error) : resolve(result)));
  async function switchTo(gameId, variant = 'standard') {
    for (const m of members) await groups.heartbeat(m, groupId, m.capability);
    const p = await groups.propose(members[0], groupId, members[0].capability, { gameId, variant, config: { maxPlayers: 2 } });
    for (const m of members) await groups.confirm(m, groupId, m.capability, { proposalId: p.proposal.id, proposalRevision: p.proposal.revision });
    return groups.switchGroup(members[0], groupId, members[0].capability);
  }
  async function enter() {
    let room;
    for (const m of members) {
      const credential = await groups.handoff(m, groupId, m.capability);
      assert.equal((await request(m.client, 'room:resume', credential)).error, undefined);
      room = game.gm.managerForCode(credential.roomCode).rooms.get(credential.roomCode);
    }
    return room;
  }
  function ready(room) { members.forEach((m, i) => game.gm.setReady(socket(i), room.code, true)); }
  async function returnToLobby(room) {
    members.forEach(m => m.client.disconnect());
    await until(() => room.players.every(p => !p.connected));
    for (const m of members) m.client = await connect(m.token);
  }
  function action(room, i, data) {
    return game.gm.gameAction(socket(i), room.code, { ...data, actionId: crypto.randomUUID(), expectedRevision: room.revision });
  }
  return { game, groups, tournaments, store, groupId, members, socket, request, connect, switchTo, enter, ready, returnToLobby, action };
}

test('R01: fresh lobby sockets cash out a completed Poker hand exactly once before switching', async t => {
  const f = await fixture(t);
  await f.switchTo('poker'); const room = await f.enter();
  for (let i = 0; i < 2; i++) assert.equal((await f.action(room, i, { action: 'buy_in', amount: 200 }))?.error, undefined);
  f.ready(room); assert.equal((await f.game.gm.startGame(f.socket(0), room.code)).error, undefined);
  const actor = room.players.findIndex(p => p.id === room.currentPlayerId);
  await f.action(room, actor, { action: 'fold' });
  assert.equal(room.phase, 'RESULT');
  const expected = room.players.map(p => f.store.publicProfile(p.profileId).balances.chip.available + p.stack);
  await f.returnToLobby(room);
  const switched = await f.switchTo('uno', 'classic-108-v1');
  assert.equal(switched.transition.status, 'complete');
  assert.equal(f.game.gm.managerForCode(room.code), null);
  assert.deepEqual(f.members.map(m => f.store.publicProfile(m.id).balances.chip.available), expected);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status='HELD'").get().n, 0);
  const cashouts = () => f.store.db.prepare("SELECT COUNT(*) AS n FROM wallet_operations WHERE idempotency_key LIKE 'poker:cashout:%'").get().n;
  assert.equal(cashouts(), 2);
  await f.groups.switchGroup(f.members[0], f.groupId, f.members[0].capability);
  assert.equal(cashouts(), 2);
});

for (const [gameId, cancel] of [['tien-len', 'cancel_before_first_play'], ['sam-loc', 'cancel_before_first_play'], ['phom', 'cancel_before_first_discard']]) {
  test(`R02: ${gameId} cancellation resolves the tournament, refunds once and permits the next round`, async t => {
    const f = await fixture(t);
    const tournament = await f.tournaments.create({ groupId: f.groupId, actorProfileId: f.members[0].id, name: 'Regression cup', gameId, variant: 'standard', rounds: 2 });
    await f.tournaments.start({ groupId: f.groupId, tournamentId: tournament.tournamentId, actorProfileId: f.members[0].id });
    await f.switchTo(gameId); const room = await f.enter(), manager = f.game.gm.managerForCode(room.code);
    manager.shuffle = deterministicShuffle;
    f.ready(room); assert.equal((await f.game.gm.startGame(f.socket(0), room.code)).error, undefined);
    assert.notEqual(room.phase, 'RESULT'); const matchId = room.matchId;
    const status = () => f.store.db.prepare("SELECT status FROM group_tournament_records WHERE record_type='match' AND match_id=?").get(matchId).status;
    const guestErrors = [];
    f.members[1].client.on('game_error', error => guestErrors.push(error.message));
    await f.action(room, 1, { action: cancel });
    await until(() => guestErrors.length > 0);
    assert.match(guestErrors.at(-1), /chủ phòng/);
    assert.equal(status(), 'REGISTERED');
    const save = f.store.saveGameSnapshot.bind(f.store);
    f.store.saveGameSnapshot = () => { throw new Error('injected cancellation snapshot failure'); };
    assert.match((await f.action(room, 0, { action: cancel })).error, /snapshot failure/);
    f.store.saveGameSnapshot = save;
    assert.equal(status(), 'REGISTERED'); assert.notEqual(room.phase, 'WAITING');
    assert.ok(f.store.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status='HELD'").get().n > 0);
    assert.equal((await f.action(room, 0, { action: cancel }))?.error, undefined);
    assert.equal(room.phase, 'WAITING'); assert.equal(status(), 'CANCELLED');
    const ledgerCount = () => f.store.db.prepare('SELECT COUNT(*) AS n FROM wallet_ledger').get().n;
    const beforeRetry = ledgerCount(); await f.action(room, 0, { action: cancel });
    assert.equal(ledgerCount(), beforeRetry); assert.equal(status(), 'CANCELLED');
    assert.deepEqual(f.members.map(m => f.store.publicProfile(m.id).balances.coin), [{ available: 1000, reserved: 0 }, { available: 1000, reserved: 0 }]);
    const detail = await f.tournaments.detail({ groupId: f.groupId, tournamentId: tournament.tournamentId, actorProfileId: f.members[0].id });
    assert.equal(detail.rounds[0].status, 'CANCELLED'); assert.ok(detail.standings.every(s => s.points === 0));
    f.ready(room); assert.equal((await f.game.gm.startGame(f.socket(0), room.code)).error, undefined);
    assert.notEqual(room.phase, 'WAITING'); assert.notEqual(room.matchId, matchId);
    assert.equal(f.store.db.prepare("SELECT status FROM group_tournament_records WHERE record_type='match' AND match_id=?").get(room.matchId).status, 'REGISTERED');
    assert.deepEqual(f.game.groupTournaments.errors, []);
  });

  test(`R02: ${gameId} retries a failed tournament update only with complete committed refund proof`, async t => {
    const f = await fixture(t);
    const tournament = await f.tournaments.create({ groupId: f.groupId, actorProfileId: f.members[0].id, name: 'Recovery cup', gameId, variant: 'standard', rounds: 2 });
    await f.tournaments.start({ groupId: f.groupId, tournamentId: tournament.tournamentId, actorProfileId: f.members[0].id });
    await f.switchTo(gameId); const room = await f.enter(), manager = f.game.gm.managerForCode(room.code);
    manager.shuffle = deterministicShuffle;
    f.ready(room); await f.game.gm.startGame(f.socket(0), room.code);
    const matchId = room.matchId, status = () => f.store.db.prepare("SELECT status FROM group_tournament_records WHERE match_id=?").get(matchId).status;
    const resolve = f.tournaments.resolveCapturedCancellation.bind(f.tournaments);
    f.tournaments.resolveCapturedCancellation = () => { throw new Error('injected tournament update failure'); };
    assert.match((await f.action(room, 0, { action: cancel })).error, /tournament update failure/);
    f.tournaments.resolveCapturedCancellation = resolve;
    assert.equal(room.phase, 'WAITING'); assert.equal(status(), 'REGISTERED');
    const row = f.store.db.prepare('SELECT state_json FROM game_snapshots WHERE game_id=? AND room_code=?').get(gameId, room.code);
    // A conflicting authoritative snapshot must not be treated as cancelled.
    const conflicting = { ...JSON.parse(row.state_json), phase: 'TURN', matchId };
    f.store.db.prepare('UPDATE game_snapshots SET state_json=? WHERE game_id=? AND room_code=?').run(JSON.stringify(conflicting), gameId, room.code);
    assert.equal((await f.game.groupTournaments.lifecycle.reconcilePending()).recovered, 0);
    assert.equal(status(), 'REGISTERED');
    f.store.db.prepare('UPDATE game_snapshots SET state_json=? WHERE game_id=? AND room_code=?').run(row.state_json, gameId, room.code);
    const rows = f.store.db.prepare('SELECT COUNT(*) AS n FROM wallet_ledger').get().n;
    assert.equal((await f.game.groupTournaments.lifecycle.reconcilePending()).recovered, 1);
    assert.equal(status(), 'CANCELLED');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM wallet_ledger').get().n, rows);
    assert.equal((await f.game.groupTournaments.lifecycle.reconcilePending()).recovered, 0);
    f.ready(room); assert.equal((await f.game.gm.startGame(f.socket(0), room.code)).error, undefined);
  });
}

test('R03: spectators receive committed timeout moves with no online players, and receive no rolled-back move', async t => {
  const f = await fixture(t);
  await f.switchTo('tien-len'); const room = await f.enter(), manager = f.game.gm.tienLen;
  manager.shuffle = deterministicShuffle;
  f.ready(room); await f.game.gm.startGame(f.socket(0), room.code);
  const observer = await f.connect(), states = [];
  observer.on('spectator:state', state => states.push(state));
  assert.equal((await f.request(observer, 'spectator:join', { roomCode: room.code })).ok, true);
  await until(() => states.length > 0);
  f.members.forEach(m => m.client.disconnect()); await until(() => room.players.every(p => !p.connected));
  clearInterval(manager.turnClock.timer); clearInterval(manager.cleanupTimer);
  await pause(30);
  room.players.forEach(p => { p.disconnectedAt = Date.now() - 125000; p.reconnectDeadlineAt = Date.now() - 5000; });
  const previousRevision = room.revision;
  assert.equal(manager.turnClock.expire(room), true);
  await until(() => states.at(-1).revision === room.revision);
  assert.ok(room.revision > previousRevision);
  assert.equal(states.at(-1).myHand, undefined); assert.equal(states.at(-1).deck, undefined);
  const committedRevision = room.revision, count = states.length;
  room.turnClock.deadlineAt = Date.now() - 1;
  const save = f.store.saveGameSnapshot.bind(f.store);
  f.store.saveGameSnapshot = () => { throw new Error('injected offline timeout snapshot failure'); };
  manager.turnClock.expire(room);
  f.store.saveGameSnapshot = save;
  await pause(40);
  assert.equal(room.revision, committedRevision); assert.equal(states.length, count);
});

test('R04: a live bound game keeps its group past idle expiry, while abandoned and absolute-expired groups are removed', async t => {
  const f = await fixture(t);
  await f.switchTo('uno', 'classic-108-v1'); const room = await f.enter();
  f.ready(room); await f.game.gm.startGame(f.socket(0), room.code);
  const group = f.groups.groups.get(f.groupId), originalExpiry = group.expiresAt;
  let clock = group.lastActivityAt + 31 * 60000;
  f.groups.clock = () => clock;
  await f.groups.sweep();
  assert.equal(f.groups.groups.has(f.groupId), true); assert.equal(group.expiresAt, originalExpiry);
  f.members.forEach(m => m.client.disconnect()); await until(() => room.players.every(p => !p.connected));
  clock += 31 * 60000; await f.groups.sweep();
  assert.equal(f.groups.groups.has(f.groupId), false);
  assert.ok(f.members.every(m => !f.groups.profileGroups.has(m.id)));
  // Absolute expiry remains a separate policy, even with a live game seat.
  const f2 = await fixture(t);
  await f2.switchTo('uno', 'classic-108-v1'); await f2.enter();
  f2.groups.clock = () => f2.groups.groups.get(f2.groupId).expiresAt;
  await f2.groups.sweep(); assert.equal(f2.groups.groups.has(f2.groupId), false);
});
