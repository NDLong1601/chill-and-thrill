'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../src/platform/profileStore');
const { createSamLocDeck, classify, canBeat } = require('../src/games/sam-loc/samLocDeck');
const { SamLocManager, STAKE, maxLoss } = require('../src/games/sam-loc/samLocEngine');

function fakeIo() { const sockets = new Map(); return { sockets: { sockets }, to: () => ({ emit() {} }) }; }
function socket(id, profile) { return { id, profile, events: [], join() {}, leave() {}, emit(event, payload) { this.events.push({ event, payload }); } }; }
function card(rank, suit) { return { id: `${rank}${suit}`, rank, suit }; }
function deterministicShuffle(cards) { return [...cards].reverse(); }
function fixture(t, count = 2, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-sam-'));
  const store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite') });
  const io = fakeIo(), profiles = Array.from({ length: count }, (_item, index) => store.createProfile({ displayName: `Người ${index + 1}`, avatar: '🎲' }).profile);
  const sockets = profiles.map((profile, index) => socket(`sam-${index}`, profile)); sockets.forEach(item => io.sockets.sockets.set(item.id, item));
  const manager = new SamLocManager(io, { profileStore: store, profileForSocket: item => item.profile, onMatchCompleted: match => store.recordCompletedMatch(match), storageFile: options.storageFile, shuffle: deterministicShuffle });
  const created = manager.createRoom(sockets[0], 'ignored', '🎲');
  for (let index = 1; index < count; index++) manager.joinRoom(sockets[index], created.roomCode, 'ignored', '🎲');
  const room = manager.rooms.get(created.roomCode); room.players.forEach((player, index) => manager.setReady(sockets[index], room.code, true));
  if (!options.noStart) manager.startGame(sockets[0], room.code);
  t.after(() => { manager.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, io, profiles, sockets, manager, room, created };
}
function act(f, index, action, extra = {}) { f.manager.action(f.sockets[index], f.room.code, { action, actionId: crypto.randomUUID(), expectedRevision: f.room.revision, ...extra }); }
function declineSam(f) { f.room.players.forEach((player, index) => act(f, index, 'pass_sam')); }

test('Sâm deck has unique cards and distinguishes local formations from Tiến lên cuts', () => {
  const deck = createSamLocDeck(); assert.equal(deck.length, 52); assert.equal(new Set(deck.map(item => item.id)).size, 52);
  assert.equal(classify([card('3', 'S'), card('4', 'C'), card('5', 'D')]).kind, 'straight');
  assert.equal(classify([card('Q', 'S'), card('K', 'C'), card('A', 'D'), card('2', 'H')]), null);
  assert.equal(canBeat(classify([card('10', 'H')]), classify([card('10', 'S')])), false, 'suits never break a Sâm tie');
  assert.equal(maxLoss(5), 160); assert.equal(maxLoss(2), 40);
});

test('Sâm declaration priority is stable, late actions close the saved window, and hands stay private', t => {
  const f = fixture(t, 3); assert.equal(f.room.phase, 'SAM_DECLARATION'); assert.equal(f.room.reservations[0].amount, 80);
  const own = f.manager.buildStateFor(f.room, f.room.players[0].id); assert.equal(own.myHand.length, 10); assert.equal(JSON.stringify(own).includes(JSON.stringify(f.room.players[1].hand[0].id)), false);
  act(f, 0, 'pass_sam'); act(f, 1, 'declare_sam'); act(f, 2, 'declare_sam');
  assert.equal(f.room.phase, 'SAM_PLAY'); assert.equal(f.room.samDeclarerId, f.room.players[1].id);
  const staleRevision = f.room.revision; f.room.phase = 'SAM_DECLARATION'; f.room.samResponses = Object.fromEntries(f.room.players.map(player => [player.id, null])); f.room.samDeadlineAt = Date.now() - 1;
  act(f, 0, 'declare_sam'); assert.notEqual(f.room.phase, 'SAM_DECLARATION'); assert.ok(f.room.revision > staleRevision);
});

test('successful and failed Sâm settle exactly once within the pre-held maximum loss', t => {
  const success = fixture(t, 2); declineSam(success);
  const declarer = success.room.players[0], opponent = success.room.players[1];
  success.room.phase = 'SAM_PLAY'; success.room.samDeclarerId = declarer.id; success.room.currentPlayerId = declarer.id; success.room.leaderId = declarer.id; success.room.topPlay = null; success.room.playedAny = true; declarer.hand = [card('3', 'S')];
  act(success, 0, 'play', { cardIds: ['3S'] }); assert.equal(success.room.result.kind, 'SAM_SUCCESS'); assert.deepEqual(success.profiles.map(profile => success.store.publicProfile(profile.id).balances.coin), [{ available: 1040, reserved: 0 }, { available: 960, reserved: 0 }]);
  const balances = success.profiles.map(profile => success.store.publicProfile(profile.id).balances.coin.available); success.manager.finishSam(success.room, declarer, true, 'Báo Sâm thành công: đánh hết 10 lá.'); assert.deepEqual(success.profiles.map(profile => success.store.publicProfile(profile.id).balances.coin.available), balances);

  const failure = fixture(t, 2); declineSam(failure); const failed = failure.room.players[0], blocker = failure.room.players[1];
  failure.room.phase = 'SAM_PLAY'; failure.room.samDeclarerId = failed.id; failure.room.currentPlayerId = failed.id; failure.room.leaderId = blocker.id; failure.room.playedAny = true; failure.room.topPlay = { playerId: blocker.id, formation: classify([card('A', 'S')]), cards: [card('A', 'S')] }; failed.hand = [card('3', 'S')];
  act(failure, 0, 'pass'); assert.equal(failure.room.result.kind, 'SAM_FAILED'); assert.equal(failure.room.result.winnerId, blocker.id); assert.deepEqual(failure.profiles.map(profile => failure.store.publicProfile(profile.id).balances.coin), [{ available: 960, reserved: 0 }, { available: 1040, reserved: 0 }]);
});

test('Báo một penalty is additive only in a normal hand and the maximum hold covers it', t => {
  const f = fixture(t, 2); declineSam(f); const first = f.room.players[0], second = f.room.players[1];
  f.room.phase = 'TURN'; f.room.currentPlayerId = first.id; f.room.leaderId = first.id; f.room.topPlay = null; f.room.playedAny = false; first.hand = [card('3', 'S'), card('4', 'S')]; second.hand = [card('5', 'S')]; f.room.initialRequiredCardId = '3S';
  act(f, 0, 'play', { cardIds: ['3S'] }); assert.equal(f.room.oneCall.playerId, first.id); assert.equal(f.room.currentPlayerId, second.id);
  act(f, 1, 'play', { cardIds: ['5S'] }); assert.equal(f.room.result.kind, 'BAO_MOT_BLOCKED'); assert.deepEqual(f.room.result.outcomes.map(item => item.delta), [-2 * STAKE, 2 * STAKE]); assert.deepEqual(f.profiles.map(profile => f.store.publicProfile(profile.id).balances.coin), [{ available: 960, reserved: 0 }, { available: 1040, reserved: 0 }]);
});

test('a saved Sâm declaration window restores paused with private hands and the same holds', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-sam-restart-')), databaseFile = path.join(directory, 'profiles.sqlite'), storageFile = path.join(directory, 'sam-loc.json');
  const store = new ProfileStore({ databaseFile }), firstProfile = store.createProfile({ displayName: 'A' }), secondProfile = store.createProfile({ displayName: 'B' });
  const io = fakeIo(), first = socket('first', firstProfile.profile), second = socket('second', secondProfile.profile); io.sockets.sockets.set(first.id, first); io.sockets.sockets.set(second.id, second);
  let manager = new SamLocManager(io, { profileStore: store, profileForSocket: item => item.profile, storageFile, shuffle: deterministicShuffle }); const created = manager.createRoom(first, 'A', '🕶️'), joined = manager.joinRoom(second, created.roomCode, 'B', '🎲'), room = manager.rooms.get(created.roomCode);
  manager.setReady(first, room.code, true); manager.setReady(second, room.code, true); manager.startGame(first, room.code); const deadline = room.samDeadlineAt; manager.close();
  const restoredIo = fakeIo(), firstBack = socket('first-back', firstProfile.profile), secondBack = socket('second-back', secondProfile.profile); restoredIo.sockets.sockets.set(firstBack.id, firstBack); restoredIo.sockets.sockets.set(secondBack.id, secondBack);
  manager = new SamLocManager(restoredIo, { profileStore: store, profileForSocket: item => item.profile, storageFile, shuffle: deterministicShuffle }); t.after(() => { manager.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const restored = manager.rooms.get(created.roomCode); assert.equal(restored.phase, 'SAM_DECLARATION'); assert.equal(restored.paused, true); assert.equal(restored.samDeadlineAt, deadline); assert.deepEqual([firstProfile, secondProfile].map(item => store.publicProfile(item.profile.id).balances.coin), [{ available: 960, reserved: 40 }, { available: 960, reserved: 40 }]);
  manager.resumeRoom(firstBack, created.roomCode, created.sessionToken); manager.resumeRoom(secondBack, created.roomCode, joined.sessionToken); assert.equal(manager.rooms.get(created.roomCode).paused, false); const state = manager.buildStateFor(manager.rooms.get(created.roomCode), created.playerId); assert.equal(state.myHand.length, 10); assert.equal(JSON.stringify(state).includes(JSON.stringify(manager.rooms.get(created.roomCode).players[1].hand[0].id)), false);
});
