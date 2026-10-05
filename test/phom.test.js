'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../src/platform/profileStore');
const { createPhomDeck, classifyMeld, bestMeldPlan, validateMeldGroups } = require('../src/games/phom/phomDeck');
const { PhomManager, STAKE, DEN_MULTIPLIER, MOM_SCORE, maxLoss } = require('../src/games/phom/phomEngine');

function fakeIo() { const sockets = new Map(); return { sockets: { sockets }, to: () => ({ emit() {} }) }; }
function socket(id, profile) { return { id, profile, events: [], join() {}, leave() {}, emit(event, payload) { this.events.push({ event, payload }); } }; }
function card(rank, suit) { return { id: `${rank}${suit}`, rank, suit }; }
function deterministicShuffle(cards) { return [...cards].reverse(); }
function fixture(t, count = 2, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-phom-')), store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite') }), io = fakeIo();
  const profiles = Array.from({ length: count }, (_item, index) => store.createProfile({ displayName: `Người ${index + 1}`, avatar: '🎲' }).profile), sockets = profiles.map((profile, index) => socket(`phom-${index}`, profile)); sockets.forEach(item => io.sockets.sockets.set(item.id, item));
  const manager = new PhomManager(io, { profileStore: store, profileForSocket: item => item.profile, onMatchCompleted: match => store.recordCompletedMatch(match), storageFile: options.storageFile, shuffle: deterministicShuffle }); const created = manager.createRoom(sockets[0], 'ignored', '🎲'); for (let index = 1; index < count; index++) manager.joinRoom(sockets[index], created.roomCode, 'ignored', '🎲'); const room = manager.rooms.get(created.roomCode); room.players.forEach((player, index) => manager.setReady(sockets[index], room.code, true)); if (!options.noStart) manager.startGame(sockets[0], room.code);
  t.after(() => { manager.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }); return { directory, store, io, profiles, sockets, manager, room, created };
}
function act(f, index, action, extra = {}) { f.manager.action(f.sockets[index], f.room.code, { action, actionId: crypto.randomUUID(), expectedRevision: f.room.revision, ...extra }); }

test('Phỏm deck, sets/runs, and overlapping plans use exact exhaustive grouping', () => {
  const deck = createPhomDeck(); assert.equal(deck.length, 52); assert.equal(new Set(deck.map(card => card.id)).size, 52);
  assert.equal(classifyMeld([card('A', 'S'), card('2', 'S'), card('3', 'S')]).kind, 'run'); assert.equal(classifyMeld([card('Q', 'S'), card('K', 'S'), card('A', 'S')]), null);
  assert.equal(classifyMeld([card('7', 'S'), card('7', 'C'), card('7', 'D')]).kind, 'set');
  const cards = [card('3', 'S'), card('4', 'S'), card('5', 'S'), card('5', 'C'), card('5', 'D'), card('5', 'H'), card('9', 'H')]; const plan = bestMeldPlan(cards); assert.equal(plan.points, 9); assert.equal(plan.melds.length, 2);
  assert.equal(validateMeldGroups(cards, [['3S', '4S', '5S'], ['5S', '5C', '5D']]), null, 'overlapping groups are rejected');
  assert.equal(maxLoss(4), DEN_MULTIPLIER * STAKE * 3); assert.equal(maxLoss(2), 60);
});

test('eating requires the discarded card to be in a declared valid phỏm and keeps opponent hands private', t => {
  const f = fixture(t); const [first, second] = f.room.players; f.room.phase = 'DRAW_OR_EAT'; f.room.currentPlayerId = second.id; f.room.discardPile = [{ card: card('3', 'D'), playerId: first.id }]; second.hand = [card('3', 'S'), card('3', 'C'), card('9', 'H')];
  act(f, 1, 'eat', { melds: [['3S', '3C', '9H']] }); assert.equal(f.room.phase, 'DRAW_OR_EAT', 'bad eat leaves state unchanged');
  act(f, 1, 'eat', { melds: [['3S', '3C', '3D']] }); assert.equal(f.room.phase, 'DISCARD'); assert.ok(second.hand.some(item => item.id === '3D')); assert.deepEqual(second.eatenCardIds, ['3D']);
  const state = f.manager.buildStateFor(f.room, first.id); assert.equal(JSON.stringify(state).includes('9H'), false, 'private hand is not sent to the other seat');
});

test('ăn chốt costs two units and ù replaces scoring while preserving valid prior eating debts', t => {
  const chot = fixture(t); const [first, second] = chot.room.players; chot.room.phase = 'DRAW_OR_EAT'; chot.room.currentPlayerId = second.id; chot.room.chotEligible = true; chot.room.discardPile = [{ card: card('3', 'D'), playerId: first.id }]; second.hand = [card('3', 'S'), card('3', 'C')]; act(chot, 1, 'eat', { melds: [['3S', '3C', '3D']] }); assert.deepEqual(chot.room.eatenEvents.map(item => ({ amount: item.amount, chot: item.chot })), [{ amount: 2 * STAKE, chot: true }]);
  const u = fixture(t); const [winner] = u.room.players; u.room.phase = 'DISCARD'; u.room.currentPlayerId = winner.id; winner.hand = [card('A', 'S'), card('2', 'S'), card('3', 'S'), card('4', 'C'), card('4', 'D'), card('4', 'H'), card('7', 'C'), card('8', 'C'), card('9', 'C'), card('10', 'C')]; winner.eatenCardIds = []; act(u, 0, 'declare_u'); assert.equal(u.room.result.kind, 'U'); assert.deepEqual(u.room.result.outcomes.map(item => item.delta), [4 * STAKE, -4 * STAKE]);
});

test('hạ/gửi scores cards once, while móm and tied points follow the published local settlement', t => {
  const f = fixture(t); const [first, second] = f.room.players; f.room.phase = 'LAYDOWN'; f.room.currentPlayerId = first.id; first.hand = [card('3', 'S'), card('3', 'C'), card('3', 'D'), card('7', 'H')]; second.hand = [card('4', 'S'), card('4', 'C'), card('4', 'D'), card('10', 'H')]; first.eatenCardIds = []; second.eatenCardIds = [];
  act(f, 0, 'lay_down', { melds: [['3S', '3C', '3D']], sends: [] }); assert.equal(first.score, 7); act(f, 1, 'lay_down', { melds: [['4S', '4C', '4D']], sends: [] }); assert.equal(f.room.result.kind, 'SCORE'); assert.deepEqual(f.room.result.outcomes.map(item => item.delta), [STAKE, -STAKE]); assert.deepEqual(f.profiles.map(profile => f.store.publicProfile(profile.id).wallet), [{ available: 1010, reserved: 0 }, { available: 990, reserved: 0 }]);
  const tied = fixture(t); const [left, right] = tied.room.players; tied.room.phase = 'LAYDOWN'; tied.room.currentPlayerId = left.id; left.hand = [card('3', 'S'), card('3', 'C'), card('3', 'D'), card('7', 'H')]; right.hand = [card('4', 'S'), card('4', 'C'), card('4', 'D'), card('7', 'D')]; left.eatenCardIds = []; right.eatenCardIds = []; act(tied, 0, 'lay_down', { melds: [['3S', '3C', '3D']], sends: [] }); act(tied, 1, 'lay_down', { melds: [['4S', '4C', '4D']], sends: [] }); assert.deepEqual(tied.room.result.outcomes.map(item => item.delta), [0, 0]);
  const mom = fixture(t); const [momPlayer, meldPlayer] = mom.room.players; mom.room.phase = 'LAYDOWN'; mom.room.currentPlayerId = momPlayer.id; momPlayer.hand = [card('K', 'S')]; meldPlayer.hand = [card('4', 'S'), card('4', 'C'), card('4', 'D')]; momPlayer.eatenCardIds = []; meldPlayer.eatenCardIds = []; act(mom, 0, 'lay_down', { melds: [], sends: [] }); assert.equal(momPlayer.score, MOM_SCORE); act(mom, 1, 'lay_down', { melds: [['4S', '4C', '4D']], sends: [] }); assert.deepEqual(mom.room.result.outcomes.map(item => item.delta), [-STAKE, STAKE]);
});

test('gửi only targets an already-laid compatible phỏm and updates ownership before score', t => {
  const f = fixture(t); const [first, second] = f.room.players; f.room.phase = 'LAYDOWN'; f.room.currentPlayerId = first.id; first.hand = [card('3', 'S'), card('4', 'S'), card('5', 'S')]; second.hand = [card('6', 'S'), card('7', 'H'), card('7', 'C'), card('7', 'D')]; first.eatenCardIds = []; second.eatenCardIds = [];
  act(f, 0, 'lay_down', { melds: [['3S', '4S', '5S']], sends: [] }); act(f, 1, 'lay_down', { melds: [['7H', '7C', '7D']], sends: [{ cardId: '6S', targetPlayerId: first.id, targetMeldIndex: 0 }] }); assert.ok(first.melds[0].cards.some(item => item.id === '6S')); assert.equal(second.hand.some(item => item.id === '6S'), false); assert.equal(second.score, 0);
  const invalid = fixture(t); const [left, right] = invalid.room.players; invalid.room.phase = 'LAYDOWN'; invalid.room.currentPlayerId = left.id; left.hand = [card('3', 'S'), card('4', 'S'), card('5', 'S')]; right.hand = [card('8', 'S'), card('7', 'H'), card('7', 'C'), card('7', 'D')]; left.eatenCardIds = []; right.eatenCardIds = []; act(invalid, 0, 'lay_down', { melds: [['3S', '4S', '5S']], sends: [] }); const before = invalid.room.revision; act(invalid, 1, 'lay_down', { melds: [['7H', '7C', '7D']], sends: [{ cardId: '8S', targetPlayerId: left.id, targetMeldIndex: 0 }] }); assert.equal(invalid.room.revision, before); assert.equal(right.laid, false);
});

test('eating three cards triggers bounded đền and replaces that eater’s score/eat debts', t => {
  const f = fixture(t); const [first, second] = f.room.players; f.room.denPlayerId = first.id; f.room.eatenEvents = [{ eaterId: first.id, discardedById: second.id, cardId: '3S', amount: STAKE, chot: false }, { eaterId: first.id, discardedById: second.id, cardId: '4S', amount: STAKE, chot: false }, { eaterId: first.id, discardedById: second.id, cardId: '5S', amount: STAKE, chot: false }]; first.melds = []; second.melds = []; first.hand = []; second.hand = []; first.score = 0; second.score = 0; f.manager.finishRound(f.room, null, 'fixture'); assert.equal(f.room.result.kind, 'DEN'); assert.deepEqual(f.room.result.outcomes.map(item => item.delta), [-DEN_MULTIPLIER * STAKE, DEN_MULTIPLIER * STAKE]); assert.deepEqual(f.profiles.map(profile => f.store.publicProfile(profile.id).wallet), [{ available: 940, reserved: 0 }, { available: 1060, reserved: 0 }]);
});

test('restart pauses an in-progress hand without leaking cards or releasing its reservation', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-phom-restart-')), databaseFile = path.join(directory, 'profiles.sqlite'), storageFile = path.join(directory, 'phom.json'), store = new ProfileStore({ databaseFile }); const firstProfile = store.createProfile({ displayName: 'A' }), secondProfile = store.createProfile({ displayName: 'B' }); const io = fakeIo(), first = socket('first', firstProfile.profile), second = socket('second', secondProfile.profile); io.sockets.sockets.set(first.id, first); io.sockets.sockets.set(second.id, second);
  let manager = new PhomManager(io, { profileStore: store, profileForSocket: item => item.profile, storageFile, shuffle: deterministicShuffle }); const created = manager.createRoom(first, 'A', '🕶️'), joined = manager.joinRoom(second, created.roomCode, 'B', '🎲'), room = manager.rooms.get(created.roomCode); manager.setReady(first, room.code, true); manager.setReady(second, room.code, true); manager.startGame(first, room.code); manager.close(); const restoredIo = fakeIo(), firstBack = socket('first-back', firstProfile.profile), secondBack = socket('second-back', secondProfile.profile); restoredIo.sockets.sockets.set(firstBack.id, firstBack); restoredIo.sockets.sockets.set(secondBack.id, secondBack); manager = new PhomManager(restoredIo, { profileStore: store, profileForSocket: item => item.profile, storageFile, shuffle: deterministicShuffle }); t.after(() => { manager.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }); const restored = manager.rooms.get(created.roomCode); assert.equal(restored.phase, 'DISCARD'); assert.equal(restored.paused, true); assert.deepEqual([firstProfile, secondProfile].map(item => store.publicProfile(item.profile.id).wallet), [{ available: 940, reserved: 60 }, { available: 940, reserved: 60 }]); manager.resumeRoom(firstBack, created.roomCode, created.sessionToken); manager.resumeRoom(secondBack, created.roomCode, joined.sessionToken); const state = manager.buildStateFor(manager.rooms.get(created.roomCode), created.playerId); assert.equal(state.myHand.length, 10); assert.equal(JSON.stringify(state).includes(manager.rooms.get(created.roomCode).players[1].hand[0].id), false);
});
