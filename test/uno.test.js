'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUnoDeck } = require('../src/games/uno/unoDeck');
const { UnoManager } = require('../src/games/uno/unoEngine');

function fakeIo() {
  const sockets = new Map();
  return { sockets: { sockets }, to: () => ({ emit() {} }) };
}
function socket(id) {
  return { id, events: [], join() {}, leave() {}, emit(event, payload) { this.events.push({ event, payload }); } };
}
function fixture(t, count = 2) {
  const io = fakeIo(), manager = new UnoManager(io), sockets = Array.from({ length: count }, (_, i) => socket(`uno-${i}`));
  sockets.forEach(s => io.sockets.sockets.set(s.id, s));
  const created = manager.createRoom(sockets[0], 'Host', '🕶️');
  for (let i = 1; i < count; i++) manager.joinRoom(sockets[i], created.roomCode, `Bạn ${i}`, '🎲');
  const room = manager.rooms.get(created.roomCode); room.players.forEach((_, i) => manager.setReady(sockets[i], room.code, true));
  manager.startGame(sockets[0], room.code);
  t.after(() => manager.close());
  return { io, manager, room, sockets };
}
function act(f, index, action, extra = {}) {
  const room = f.room;
  f.manager.action(f.sockets[index], room.code, { action, actionId: `${action}-${crypto.randomUUID()}`, expectedRevision: room.revision, ...extra });
}
function card(id, color, symbol) { return { id, color, symbol, kind: typeof symbol === 'number' ? 'number' : symbol }; }

test('UNO deck has 108 distinct immutable card IDs', () => {
  const deck = createUnoDeck();
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map(c => c.id)).size, 108);
  assert.equal(deck.filter(c => c.symbol === 'wild4').length, 4);
  assert.equal(deck.filter(c => c.symbol === 'draw2').length, 8);
});

test('UNO state hides every opponent hand while preserving public counts', t => {
  const f = fixture(t, 3);
  const state = f.manager.buildStateFor(f.room, f.room.players[0].id);
  // A legal opening Draw Two can make the initially selected player draw
  // before their first turn, so every hand starts with at least seven cards.
  assert.ok(state.myHand.length >= 7);
  assert.equal(state.players[1].handCount, f.room.players[1].hand.length);
  assert.equal(JSON.stringify(state).includes(f.room.players[1].hand[0].id), false);
});

test('UNO requires a current-player action and rejects stale revisions without mutation', t => {
  const f = fixture(t);
  const room = f.room, current = room.players.findIndex(p => p.id === room.currentPlayerId), other = current === 0 ? 1 : 0;
  const before = JSON.stringify(room);
  f.manager.action(f.sockets[other], room.code, { action: 'draw', actionId: crypto.randomUUID(), expectedRevision: room.revision });
  assert.equal(JSON.stringify(room), before);
  f.manager.action(f.sockets[current], room.code, { action: 'draw', actionId: crypto.randomUUID(), expectedRevision: room.revision - 1 });
  assert.equal(JSON.stringify(room), before);
});

test('missed UNO opens a server window and a different player can catch it', t => {
  const f = fixture(t);
  const room = f.room, first = room.players[0], second = room.players[1];
  room.currentPlayerId = first.id; room.currentColor = 'red'; room.discardPile = [card('top', 'red', 3)];
  first.hand = [card('r1', 'red', 1), card('b2', 'blue', 2)]; second.hand = [card('g5', 'green', 5), card('y6', 'yellow', 6)];
  act(f, 0, 'play', { cardId: 'r1' });
  assert.equal(room.phase, 'UNO_WINDOW'); assert.equal(first.hand.length, 1);
  act(f, 1, 'catch_uno');
  assert.equal(first.hand.length, 3); assert.equal(room.phase, 'TURN'); assert.equal(room.currentPlayerId, second.id);
});

test('declaring UNO prevents the penalty window and the final card wins immediately', t => {
  const f = fixture(t);
  const room = f.room, first = room.players[0];
  room.currentPlayerId = first.id; room.currentColor = 'yellow'; room.discardPile = [card('top', 'yellow', 4)];
  first.hand = [card('y4', 'yellow', 4), card('y5', 'yellow', 5)];
  act(f, 0, 'declare_uno'); act(f, 0, 'play', { cardId: 'y4' });
  assert.equal(room.phase, 'TURN'); assert.equal(first.hand.length, 1);
  // Restore the turn to make the terminal condition explicit without relying on turn order.
  room.currentPlayerId = first.id;
  act(f, 0, 'play', { cardId: 'y5' });
  assert.equal(room.phase, 'RESULT'); assert.equal(room.result.winnerId, first.id);
});

test('Wild Draw Four challenge distinguishes an illegal attempt from a legal one without exposing the hand', t => {
  const f = fixture(t);
  const room = f.room, offender = room.players[0], target = room.players[1];
  room.currentPlayerId = offender.id; room.currentColor = 'red'; room.discardPile = [card('top', 'red', 9)];
  offender.hand = [card('w4', null, 'wild4'), card('r3', 'red', 3)]; target.hand = [card('b1', 'blue', 1), card('g1', 'green', 1)];
  act(f, 0, 'declare_uno'); act(f, 0, 'play', { cardId: 'w4', color: 'blue' });
  assert.equal(room.phase, 'WDF_CHALLENGE');
  const targetState = f.manager.buildStateFor(room, target.id);
  assert.equal(JSON.stringify(targetState).includes('r3'), false);
  act(f, 1, 'challenge_wdf');
  assert.equal(offender.hand.length, 5); assert.equal(room.phase, 'TURN'); assert.equal(room.currentPlayerId, target.id);
});

test('a legal Wild Draw Four challenge fails and draws six for the challenger', t => {
  const f = fixture(t);
  const room = f.room, offender = room.players[0], target = room.players[1];
  room.currentPlayerId = offender.id; room.currentColor = 'red'; room.discardPile = [card('top', 'red', 9)];
  offender.hand = [card('w4', null, 'wild4'), card('b3', 'blue', 3)]; target.hand = [card('b1', 'blue', 1), card('g1', 'green', 1)];
  act(f, 0, 'declare_uno'); act(f, 0, 'play', { cardId: 'w4', color: 'blue' }); act(f, 1, 'challenge_wdf');
  assert.equal(target.hand.length, 8); assert.equal(room.phase, 'TURN'); assert.equal(room.currentPlayerId, offender.id);
});

test('UNO restores a paused reaction window, private hand and turn after a restart', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-uno-'));
  const storageFile = path.join(directory, 'uno.json'), io = fakeIo(), manager = new UnoManager(io, { storageFile });
  const first = socket('first'), second = socket('second'); io.sockets.sockets.set(first.id, first); io.sockets.sockets.set(second.id, second);
  const created = manager.createRoom(first, 'Host', '🕶️'), joined = manager.joinRoom(second, created.roomCode, 'Bạn', '🎲');
  const room = manager.rooms.get(created.roomCode); manager.setReady(first, room.code, true); manager.setReady(second, room.code, true); manager.startGame(first, room.code);
  room.currentPlayerId = room.players[0].id; room.currentColor = 'red'; room.discardPile = [card('top', 'red', 3)];
  room.players[0].hand = [card('r1', 'red', 1), card('secret-blue-two', 'blue', 2)];
  manager.action(first, room.code, { action: 'play', cardId: 'r1', actionId: crypto.randomUUID(), expectedRevision: room.revision });
  assert.equal(room.phase, 'UNO_WINDOW'); const originalMatch = room.matchId;
  manager.close();
  const restoredIo = fakeIo(), restored = new UnoManager(restoredIo, { storageFile });
  t.after(() => { restored.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const returningFirst = socket('return-first'), returningSecond = socket('return-second'); restoredIo.sockets.sockets.set(returningFirst.id, returningFirst); restoredIo.sockets.sockets.set(returningSecond.id, returningSecond);
  restored.resumeRoom(returningFirst, room.code, created.sessionToken); restored.resumeRoom(returningSecond, room.code, joined.sessionToken);
  const resumed = restored.rooms.get(room.code), state = restored.buildStateFor(resumed, resumed.players[1].id);
  assert.equal(resumed.matchId, originalMatch); assert.equal(resumed.phase, 'UNO_WINDOW'); assert.equal(resumed.paused, false);
  assert.equal(resumed.players[0].hand.length, 1); assert.ok(resumed.pendingUno.deadlineAt > Date.now());
  assert.equal(JSON.stringify(state).includes('secret-blue-two'), false);
});
