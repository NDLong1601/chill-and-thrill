'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../src/platform/profileStore');
const { MultiGameManager } = require('../src/platform/multiGameManager');
const { TienLenManager } = require('../src/games/tien-len/tienLenEngine');
const { PokerManager } = require('../src/games/poker/pokerEngine');
const {
  deadlineFor, markDisconnected, restoreDisconnectedSeats, isReconnectExpired,
  createServerActionSocket, isServerActionSocket, serverActionPlayer, runServerAction,
} = require('../src/platform/reconnectGrace');

function tempDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'a03-reconnect-')); }
function removeTemp(directory) {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(directory, { recursive: true, force: true });
}
function fakeIo() { return { sockets: { sockets: new Map() }, to: () => ({ emit() {} }) }; }
function socket(io, id, profile) {
  const item = { id, data: {}, profile, events: [], join() {}, leave() {}, emit(event, payload) { this.events.push({ event, payload }); } };
  io.sockets.sockets.set(id, item);
  return item;
}
function shuffled(cards) {
  const result = [...cards]; let seed = 0x5eed1234;
  for (let index = result.length - 1; index > 0; index--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const other = seed % (index + 1); [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function tienFixture(t) {
  const directory = tempDirectory(), store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite') }), io = fakeIo();
  const profiles = ['A', 'B'].map(name => store.createProfile({ displayName: name, avatar: '🎲' }).profile);
  const clients = profiles.map((profile, index) => socket(io, `tien-${index}`, profile));
  const manager = new TienLenManager(io, {
    storageFile: path.join(directory, 'tien.json'), profileStore: store,
    profileForSocket: item => item.profile, shuffle: shuffled,
  });
  const created = manager.createRoom(clients[0], 'A', '🎲');
  const joined = manager.joinRoom(clients[1], created.roomCode, 'B', '🎲');
  const room = manager.rooms.get(created.roomCode);
  assert.equal(joined.error, undefined);
  clients.forEach(client => manager.setReady(client, room.code, true));
  assert.equal(manager.startGame(clients[0], room.code)?.error, undefined);
  const fixture = { directory, store, io, clients, profiles, manager, room };
  t.after(() => { manager.close(); store.close(); removeTemp(directory); });
  return fixture;
}

function pokerFixture(t, count = 3, participating = [0, 1]) {
  const io = fakeIo();
  const profileStore = {
    reserveMany: ({ reservations }) => ({ held: reservations.map(item => ({ ...item })), idempotent: false }),
    publicProfile: () => ({ wallet: { available: 800, reserved: 200 } }),
  };
  const manager = new PokerManager(io, { profileStore, profileForSocket: item => item.profile });
  const clients = Array.from({ length: count }, (_, index) => socket(io, `poker-${index}`, {
    id: `profile-${index}`, displayName: `P${index}`, avatar: '🎲',
  }));
  const created = manager.createRoom(clients[0], 'P0', '🎲'), credentials = [created];
  for (const client of clients.slice(1)) credentials.push(manager.joinRoom(client, created.roomCode, client.profile.displayName, '🎲'));
  const room = manager.rooms.get(created.roomCode);
  for (const index of participating) {
    assert.equal(manager.action(clients[index], room.code, { action: 'buy_in', amount: 200, actionId: `a03-buy-${index}`, expectedRevision: room.revision })?.error, undefined);
    manager.setReady(clients[index], room.code, true);
  }
  assert.equal(manager.startGame(clients[0], room.code)?.error, undefined);
  t.after(() => manager.close());
  return { io, manager, clients, room };
}

test('A03 reconnect deadlines survive repeated restoration and expire at the saved boundary', () => {
  const player = { id: 'seat-1', connected: true };
  markDisconnected(player, 1000, 120000);
  const deadline = player.reconnectDeadlineAt;
  assert.equal(deadlineFor(player), deadline);
  assert.equal(isReconnectExpired(player, deadline - 1), false);
  restoreDisconnectedSeats([player], 45000, 120000);
  assert.equal(player.reconnectDeadlineAt, deadline);
  restoreDisconnectedSeats([player], 90000, 120000);
  assert.equal(player.reconnectDeadlineAt, deadline);
  assert.equal(isReconnectExpired(player, deadline), true);
});

test('A03 automatic actions require a manager-issued server socket and an expired seat', () => {
  const manager = { rooms: new Map(), action(...args) { this.called = args; return { ok: true }; } };
  const player = { id: 'seat-1', connected: false, reconnectDeadlineAt: Date.now() + 60000 };
  const room = { code: 'ROOM', revision: 12, players: [player] };
  manager.rooms.set(room.code, room);
  const lookalike = { id: 'server-action:forged', emit() {} };
  assert.equal(isServerActionSocket(manager, lookalike), false);
  assert.equal(serverActionPlayer(manager, room, lookalike), null);
  assert.equal(runServerAction(manager, room, player, { action: 'fold' }), false);

  player.reconnectDeadlineAt = Date.now() - 1;
  const action = runServerAction(manager, room, player, { action: 'fold' });
  assert.deepEqual(action, { ok: true });
  assert.equal(isServerActionSocket(manager, manager.called[0]), true);
  assert.equal(serverActionPlayer(manager, room, manager.called[0]), player);
  assert.equal(manager.called[2].expectedRevision, room.revision);
});

test('A03 an expired Poker actor remains paused while another live seat still has grace time', t => {
  const f = pokerFixture(t, 3, [0, 1]), actor = f.room.players[0], other = f.room.players[1];
  f.manager.handleDisconnect(f.clients[0]);
  f.manager.handleDisconnect(f.clients[1]);
  const at = Date.now(), actorDeadline = at - 1;
  actor.reconnectDeadlineAt = actorDeadline; actor.disconnectedAt = actorDeadline - f.manager.graceMs;
  other.reconnectDeadlineAt = at + 60000; other.disconnectedAt = at + 60000 - f.manager.graceMs;
  f.room.currentPlayerId = actor.id; f.room.turnClock = null; f.manager.turnClock.refresh(f.room, at);

  assert.equal(f.manager.turnClock.expire(f.room, at), false);
  assert.equal(f.room.paused, true);
  assert.equal(f.room.currentPlayerId, actor.id);
  assert.equal(actor.folded, false);
  const state = f.manager.buildStateFor(f.room, f.room.players[2].id);
  assert.ok(state.reconnect.waiting.some(item => item.playerId === other.id && !item.expired));
  const hiddenCardId = actor.holeCards[0].id;
  assert.equal(JSON.stringify(state).includes(hiddenCardId), false, 'a grace-paused opponent hand remains private');
});

test('A03 Tiến lên auto-plays only at grace expiry and keeps the held coin unchanged', t => {
  const f = tienFixture(t), actor = f.room.players.find(player => player.id === f.room.currentPlayerId);
  const client = f.clients.find(item => item.id === actor.socketId);
  const walletBefore = f.store.publicProfile(actor.profileId).wallet;
  f.manager.handleDisconnect(client);
  const deadline = Date.now() - 10;
  actor.reconnectDeadlineAt = deadline;
  actor.disconnectedAt = deadline - f.manager.graceMs;

  assert.equal(f.manager.turnClock.expire(f.room, deadline - 1), false);
  assert.equal(f.room.currentPlayerId, actor.id);
  assert.equal(f.room.paused, true);
  assert.equal(f.manager.turnClock.expire(f.room, deadline), true);
  assert.notEqual(f.room.currentPlayerId, actor.id);
  assert.equal(actor.hand.length, 12);
  assert.deepEqual(f.store.publicProfile(actor.profileId).wallet, walletBefore);
});

test('A03 an automatic final play records one coin settlement and does not expose the opponent hand', t => {
  const f = tienFixture(t), actor = f.room.players.find(player => player.id === f.room.currentPlayerId);
  const client = f.clients.find(item => item.id === actor.socketId), matchId = f.room.matchId;
  const required = actor.hand.find(card => card.id === f.room.initialRequiredCardId);
  assert.ok(required);
  actor.hand = [required];
  const other = f.room.players.find(player => player !== actor), hiddenCardId = other.hand[0].id;
  assert.equal(JSON.stringify(f.manager.buildStateFor(f.room, actor.id)).includes(hiddenCardId), false);

  f.manager.handleDisconnect(client);
  const deadline = Date.now() - 10;
  actor.reconnectDeadlineAt = deadline; actor.disconnectedAt = deadline - f.manager.graceMs;
  assert.equal(f.manager.turnClock.expire(f.room, deadline), true);
  assert.equal(f.room.phase, 'RESULT');
  const settlementKey = `tien-len:settle:${matchId}`;
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM wallet_operations WHERE idempotency_key = ?').get(settlementKey).n, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM wallet_ledger WHERE match_id = ? AND source = 'settlement'").get(matchId).n, 3);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE match_id = ? AND status = 'HELD'").get(matchId).n, 0);
  assert.equal(f.manager.turnClock.expire(f.room, Date.now() + 60000), false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM wallet_operations WHERE idempotency_key = ?').get(settlementKey).n, 1);
});

test('A03 coin transaction failure rolls the auto-play back and honors the 30 second retry gate', t => {
  const f = tienFixture(t), actorId = f.room.currentPlayerId;
  const initialActor = f.room.players.find(player => player.id === actorId);
  const client = f.clients.find(item => item.id === initialActor.socketId);
  const originalSave = f.store.saveGameSnapshot.bind(f.store);
  let saveAttempts = 0;
  f.manager.handleDisconnect(client);
  const deadline = Date.now() - 10;
  initialActor.reconnectDeadlineAt = deadline;
  initialActor.disconnectedAt = deadline - f.manager.graceMs;
  const originalHand = initialActor.hand.map(card => card.id), originalActor = f.room.currentPlayerId;
  const walletBefore = f.store.publicProfile(initialActor.profileId).wallet;
  f.store.saveGameSnapshot = () => { saveAttempts++; throw new Error('simulated SQLite write failure'); };

  try {
    // Cleanup's transaction cannot run the automatic play inside its own room
    // save transaction; it may only refresh the grace state before the clock.
    f.manager.cleanup();
    let liveActor = f.room.players.find(player => player.id === actorId);
    assert.equal(f.room.currentPlayerId, originalActor);
    assert.deepEqual(liveActor.hand.map(card => card.id), originalHand);
    assert.equal(saveAttempts, 1);

    assert.equal(f.manager.turnClock.expire(f.room, deadline), false);
    liveActor = f.room.players.find(player => player.id === actorId);
    assert.equal(saveAttempts, 2);
    assert.equal(f.room.currentPlayerId, originalActor);
    assert.deepEqual(liveActor.hand.map(card => card.id), originalHand);
    assert.deepEqual(f.store.publicProfile(initialActor.profileId).wallet, walletBefore);
    const retryAt = f.room.turnClock.retryNotBefore;
    assert.equal(retryAt, deadline + 30000);
    assert.equal(f.manager.turnClock.expire(f.room, retryAt - 1), false);
    assert.equal(saveAttempts, 2, 'repeated clock ticks cannot bypass backoff');
    assert.equal(f.manager.turnClock.expire(f.room, retryAt), false);
    assert.equal(saveAttempts, 3, 'the server retries once the saved retry deadline arrives');
    assert.equal(f.room.currentPlayerId, originalActor);
    liveActor = f.room.players.find(player => player.id === actorId);
    assert.deepEqual(liveActor.hand.map(card => card.id), originalHand);
    assert.deepEqual(f.store.publicProfile(initialActor.profileId).wallet, walletBefore);
  } finally { f.store.saveGameSnapshot = originalSave; }
});

test('A03 repeated Tiến lên manager restarts preserve the SQLite reconnect deadline', t => {
  const f = tienFixture(t), actor = f.room.players.find(player => player.id === f.room.currentPlayerId);
  f.manager.handleDisconnect(f.clients.find(item => item.id === actor.socketId));
  const deadline = Date.now() + f.manager.graceMs;
  actor.reconnectDeadlineAt = deadline;
  actor.disconnectedAt = deadline - f.manager.graceMs;
  f.manager.close();

  let manager = new TienLenManager(f.io, {
    storageFile: path.join(f.directory, 'tien.json'), profileStore: f.store,
    profileForSocket: item => item.profile, shuffle: shuffled,
  });
  t.after(() => manager.close());
  assert.equal(manager.rooms.get(f.room.code).players.find(player => player.id === actor.id).reconnectDeadlineAt, deadline);
  manager.close();
  manager = new TienLenManager(f.io, {
    storageFile: path.join(f.directory, 'tien.json'), profileStore: f.store,
    profileForSocket: item => item.profile, shuffle: shuffled,
  });
  assert.equal(manager.rooms.get(f.room.code).players.find(player => player.id === actor.id).reconnectDeadlineAt, deadline);
});

test('A03 The Gang expiry removes only the expired member and preserves the connected host membership', t => {
  const directory = tempDirectory(), io = fakeIo();
  const gm = new MultiGameManager(io, { databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json') });
  t.after(() => { gm.close(); removeTemp(directory); });
  const host = socket(io, 'gang-host'), guest = socket(io, 'gang-guest');
  const created = gm.createRoom(host, 'Host', 'ADVANCED', '🎲', 'the-gang');
  assert.equal(gm.joinRoom(guest, created.roomCode, 'Guest', '🎲').error, undefined);
  gm.setReady(host, created.roomCode, true); gm.setReady(guest, created.roomCode, true);
  assert.equal(gm.startGame(host, created.roomCode)?.error, undefined);
  const room = gm.gang.rooms.get(created.roomCode), hostPlayer = room.players[0], guestPlayer = room.players[1];
  gm.handleDisconnect(guest);
  guestPlayer.reconnectDeadlineAt = Date.now() - 1;
  gm.gang.cleanup();

  assert.equal(room.phase, 'WAITING');
  assert.deepEqual(room.players.map(player => player.id), [hostPlayer.id]);
  assert.equal(gm.gang.rooms.has(room.code), true);
  const membership = profileId => gm.profiles.db.prepare(`SELECT member.left_at AS leftAt FROM room_members member
    JOIN rooms ON rooms.id = member.room_id WHERE rooms.room_code = ? AND member.profile_id = ?`).get(room.code, profileId);
  assert.equal(membership(host.data.profile.id).leftAt, null);
  assert.ok(membership(guest.data.profile.id).leftAt, 'the expired guest membership is marked left');
});

for (const variant of ['classic-local-v1', 'classic-108-v1']) test(`A03 UNO ${variant} reaction deadline stays absolute through disconnect and restart`, t => {
  const directory = tempDirectory(), io = fakeIo(), options = {
    databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json'), graceMs: 120000,
  };
  let gm = new MultiGameManager(io, options);
  t.after(() => { gm.close(); removeTemp(directory); });
  const host = socket(io, `${variant}-clock-host`), guest = socket(io, `${variant}-clock-guest`);
  const created = gm.createRoom(host, 'Host', 'ADVANCED', '🎲', 'uno', { variant });
  assert.equal(gm.joinRoom(guest, created.roomCode, 'Guest', '🎲').error, undefined);
  gm.setReady(host, created.roomCode, true); gm.setReady(guest, created.roomCode, true);
  assert.equal(gm.startGame(host, created.roomCode)?.error, undefined);
  let room = gm.managerForCode(created.roomCode).rooms.get(created.roomCode);
  const hostSeat = room.players.find(player => player.socketId === host.id), guestSeat = room.players.find(player => player.socketId === guest.id);
  const reactionDeadline = Date.now() + 60000;
  if (variant === 'classic-local-v1') {
    room.uno.phase = 'PLAYING'; room.uno.currentPlayerId = guestSeat.id;
    room.uno.reactionWindow = { type: 'draw_four', sourceId: hostSeat.id, targetId: guestSeat.id, winnerId: null, matchingColor: 'red', deadlineAt: reactionDeadline };
    gm.roomService.adapterFor('uno').schedule(room);
  } else {
    room.phase = 'WDF_CHALLENGE'; room.pendingWdf = { targetId: guestSeat.id, offenderId: hostSeat.id, deadlineAt: reactionDeadline, offenderHadColor: false, winner: null };
  }
  gm.handleDisconnect(host);
  const seatDeadline = hostSeat.reconnectDeadlineAt;
  assert.equal(variant === 'classic-local-v1' ? room.uno.reactionWindow.deadlineAt : room.pendingWdf.deadlineAt, reactionDeadline);
  gm.close();
  gm = new MultiGameManager(io, options);

  room = gm.managerForCode(created.roomCode).rooms.get(created.roomCode);
  const restoredHost = room.players.find(player => player.id === hostSeat.id);
  assert.equal(restoredHost.reconnectDeadlineAt, seatDeadline);
  assert.equal(variant === 'classic-local-v1' ? room.uno.reactionWindow.deadlineAt : room.pendingWdf.deadlineAt, reactionDeadline);
  if (variant === 'classic-local-v1') assert.equal(gm.roomService.adapterFor('uno').timers.has(room.code), true);
  const hiddenCardId = variant === 'classic-local-v1' ? room.uno.hands[restoredHost.id][0].id : restoredHost.hand[0].id;
  const state = variant === 'classic-local-v1'
    ? gm.roomService.adapterFor('uno').buildStateFor(room, guestSeat.id)
    : gm.uno.buildStateFor(room, guestSeat.id);
  assert.equal(JSON.stringify(state).includes(hiddenCardId), false, 'the restored public state does not reveal another player\'s hand');
});

for (const variant of ['classic-local-v1', 'classic-108-v1']) test(`A03 ${variant} queue-leave is separate from immediate UNO cancellation`, t => {
  const directory = tempDirectory(), io = fakeIo();
  const gm = new MultiGameManager(io, { databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json') });
  t.after(() => { gm.close(); removeTemp(directory); });
  const host = socket(io, `${variant}-host`), guest = socket(io, `${variant}-guest`);
  const created = gm.createRoom(host, 'Host', 'ADVANCED', '🎲', 'uno', { variant });
  assert.equal(gm.joinRoom(guest, created.roomCode, 'Guest', '🎲').error, undefined);
  gm.setReady(host, created.roomCode, true); gm.setReady(guest, created.roomCode, true);
  assert.equal(gm.startGame(host, created.roomCode)?.error, undefined);
  const room = gm.managerForCode(created.roomCode).rooms.get(created.roomCode), member = room.players.find(player => player.socketId === host.id);
  const queued = variant === 'classic-local-v1'
    ? gm.roomService.handleGameAction(host, { roomCode: room.code, matchId: room.uno.matchId, expectedRevision: room.uno.revision, actionId: `${variant}-queue-0001`, type: 'leave_after_hand' })
    : gm.gameAction(host, room.code, { action: 'leave_after_hand', actionId: `${variant}-queue-0001`, expectedRevision: room.revision });
  assert.ok(queued.ok || queued.queued, JSON.stringify(queued));
  assert.equal(member.leaveAfterHand, true);
  assert.equal(room.players.includes(member), true);
  const guestPlayer = room.players.find(player => player.socketId === guest.id);
  const hiddenCard = variant === 'classic-local-v1' ? room.uno.hands[member.id][0] : member.hand[0];
  const otherState = variant === 'classic-local-v1'
    ? gm.roomService.adapterFor('uno').buildStateFor(room, guestPlayer.id)
    : gm.uno.buildStateFor(room, guestPlayer.id);
  assert.equal(JSON.stringify(otherState).includes(hiddenCard.id), false, 'opponent hand stays private while a leave is queued');

  const matchId = room.matchId;
  if (variant === 'classic-local-v1') {
    const match = room.uno, lastCard = { id: `${variant}-last`, color: 'red', type: 'number', value: 7 };
    match.hands[member.id] = [lastCard]; match.discardPile = [{ id: 'a03-top', color: 'red', type: 'number', value: 3 }];
    match.currentColor = 'red'; match.currentPlayerId = member.id; match.reactionWindow = null; match.unoWindow = null;
    match.openingColorPending = false; match.drawChoice = null; match.pendingDraw = 0;
    const result = gm.roomService.handleGameAction(host, { roomCode: room.code, matchId, expectedRevision: match.revision,
      actionId: `${variant}-win-0001`, type: 'play_card', payload: { cardId: lastCard.id } });
    assert.equal(result.ok, true, JSON.stringify(result));
  } else {
    const finalCard = { id: `${variant}-last`, color: 'red', symbol: 'number', value: 7 };
    gm.uno.finish(room, member, finalCard);
    gm.syncRoom(room.code);
  }
  assert.equal(room.phase, 'RESULT');
  assert.equal(room.players.includes(member), false, 'the queued seat is removed after the recorded result');
  assert.equal(gm.profiles.db.prepare('SELECT COUNT(*) AS n FROM matches WHERE match_id = ?').get(matchId).n, 1);
  assert.equal(gm.profiles.db.prepare('SELECT COUNT(*) AS n FROM match_players WHERE match_id = ?').get(matchId).n, 2);
});
