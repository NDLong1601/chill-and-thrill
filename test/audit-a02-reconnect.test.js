'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PokerManager } = require('../src/games/poker/pokerEngine');

function fixture(count, participating) {
  const sockets = new Map();
  const io = { sockets: { sockets }, to: () => ({ emit() {} }) };
  const profileStore = {
    reserveMany: ({ reservations }) => ({ held: reservations.map(item => ({ ...item })), idempotent: false }),
    publicProfile: () => ({ wallet: { available: 800, reserved: 200 } }),
  };
  const manager = new PokerManager(io, { profileStore, profileForSocket: socket => socket.profile });
  const clients = Array.from({ length: count }, (_, index) => {
    const id = String.fromCharCode(65 + index);
    const client = {
      id: `socket-${id}`,
      profile: { id: `profile-${id}`, displayName: id, avatar: '🎲' },
      events: [],
      join() {},
      leave() {},
      emit(event, data) { this.events.push({ event, data }); },
    };
    sockets.set(client.id, client);
    return client;
  });
  const created = manager.createRoom(clients[0], 'A', '🎲');
  assert.ok(!created.error, created.error);
  const credentials = [created];
  for (const client of clients.slice(1)) credentials.push(manager.joinRoom(client, created.roomCode, client.profile.displayName, '🎲'));
  assert.ok(credentials.every(item => !item.error));
  const room = manager.rooms.get(created.roomCode);
  let actionNumber = 0;
  const act = (client, action, extra = {}) => manager.action(client, room.code, {
    action, ...extra, actionId: `audit-a02-${++actionNumber}`, expectedRevision: room.revision,
  });
  for (const index of participating) {
    assert.equal(act(clients[index], 'buy_in', { amount: 200 })?.error, undefined);
    assert.equal(manager.setReady(clients[index], room.code, true)?.error, undefined);
  }
  assert.equal(manager.startGame(clients[0], room.code)?.error, undefined);
  return { manager, io, clients, created, credentials, room, act };
}

function reconnect(f, index) {
  const old = f.clients[index];
  const resumed = {
    ...old,
    id: `socket-${old.profile.displayName}-reconnected`,
    events: [],
  };
  f.io.sockets.sockets.set(resumed.id, resumed);
  const result = f.manager.resumeRoom(resumed, f.room.code, f.credentials[index].sessionToken);
  assert.ok(!result.error, result.error);
  return resumed;
}

test('A02: offline sit-out seat does not block Poker; reconnecting an active seat resumes with a deadline', t => {
  const f = fixture(3, [0, 1]);
  t.after(() => f.manager.close());
  const [a, b, c] = f.room.players;
  assert.deepEqual(f.room.players.map(player => player.inHand), [true, true, false]);
  assert.equal(f.room.turnClock.deadlineAt > Date.now(), true);

  f.manager.handleDisconnect(f.clients[2]);
  assert.equal(f.room.paused, false);
  assert.ok(f.room.turnClock.deadlineAt > Date.now(), 'the hand clock continues while only C is offline');

  const deadlineBeforeReconnect = f.room.turnClock.deadlineAt;
  f.manager.handleDisconnect(f.clients[0]);
  assert.equal(f.room.paused, true);
  assert.equal(f.room.turnClock.deadlineAt, null);
  assert.equal(f.room.turnClock.playerId === f.room.currentPlayerId, true);

  reconnect(f, 0);
  assert.equal(f.room.paused, false);
  assert.ok(f.room.turnClock.deadlineAt > Date.now(), 'the saved remaining time resumes as a finite deadline');
  assert.ok(f.room.turnClock.deadlineAt <= deadlineBeforeReconnect + 30000);
  assert.equal(a.connected, true);
  assert.equal(b.connected, true);
  assert.equal(c.connected, false);
});

test('A02: a disconnected folded seat is irrelevant, while an all-in live seat still protects its hand', t => {
  const folded = fixture(3, [0, 1, 2]);
  t.after(() => folded.manager.close());
  const actor = folded.room.players.find(player => player.id === folded.room.currentPlayerId);
  const actorSocket = folded.clients.find(client => client.id === actor.socketId);
  assert.equal(folded.act(actorSocket, 'fold')?.error, undefined);
  assert.equal(actor.folded, true);
  assert.equal(folded.room.phase, 'HAND');
  folded.manager.handleDisconnect(actorSocket);
  assert.equal(folded.room.paused, false);
  assert.ok(folded.room.turnClock.deadlineAt > Date.now());

  const allIn = fixture(2, [0, 1]);
  t.after(() => allIn.manager.close());
  const liveAllIn = allIn.room.players[1];
  liveAllIn.allIn = true;
  liveAllIn.stack = 0;
  const allInSocket = allIn.clients[1];
  allIn.manager.handleDisconnect(allInSocket);
  assert.equal(liveAllIn.inHand, true);
  assert.equal(liveAllIn.folded, false);
  assert.equal(allIn.room.paused, true, 'all-in still has showdown/pot eligibility until this hand ends');
  assert.equal(allIn.room.turnClock.deadlineAt, null);
  reconnect(allIn, 1);
  assert.equal(allIn.room.paused, false);
  assert.ok(allIn.room.turnClock.deadlineAt > Date.now());
});

test('A02: a disconnected player who can still act keeps the hand paused until reconnect', t => {
  const f = fixture(2, [0, 1]);
  t.after(() => f.manager.close());
  const waiting = f.room.players[1];
  f.manager.handleDisconnect(f.clients[1]);
  assert.equal(f.room.paused, true);
  assert.equal(f.room.turnClock.deadlineAt, null);
  const turnBeforeAccess = f.room.currentPlayerId;
  const blocked = f.manager.access(f.clients[0], f.room.code);
  assert.match(blocked.error, /B/);
  assert.equal(f.room.currentPlayerId, turnBeforeAccess);
  assert.ok(f.room.players.includes(waiting));

  reconnect(f, 1);
  assert.equal(f.room.paused, false);
  assert.ok(f.room.turnClock.deadlineAt > Date.now());
});
