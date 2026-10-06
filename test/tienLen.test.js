'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../src/platform/profileStore');
const { createTienLenDeck, classify, canBeat, whiteWin } = require('../src/games/tien-len/tienLenDeck');
const { TienLenManager } = require('../src/games/tien-len/tienLenEngine');

function fakeIo() { const sockets = new Map(); return { sockets: { sockets }, to: () => ({ emit() {} }) }; }
function socket(id, profile) { return { id, profile, events: [], join() {}, leave() {}, emit(event, payload) { this.events.push({ event, payload }); } }; }
function card(rank, suit) { return { id: `${rank}${suit}`, rank, suit }; }
function deterministicShuffle(cards) { const next = [...cards]; let seed = 0x5eed1234; for (let index = next.length - 1; index > 0; index--) { seed = (seed * 1664525 + 1013904223) >>> 0; const other = seed % (index + 1); [next[index], next[other]] = [next[other], next[index]]; } return next; }
function fixture(t, count = 4, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-tien-len-'));
  const store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite') });
  const io = fakeIo(), profiles = Array.from({ length: count }, (_item, index) => store.createProfile({ displayName: `Người ${index + 1}`, avatar: '🎲' }).profile);
  const sockets = profiles.map((profile, index) => socket(`tl-${index}`, profile)); sockets.forEach(item => io.sockets.sockets.set(item.id, item));
  const manager = new TienLenManager(io, { profileStore: store, profileForSocket: item => item.profile, onMatchCompleted: match => store.recordCompletedMatch(match), storageFile: options.storageFile, shuffle: options.shuffle || deterministicShuffle });
  const created = manager.createRoom(sockets[0], 'ignored', '🎲');
  for (let index = 1; index < count; index++) manager.joinRoom(sockets[index], created.roomCode, 'ignored', '🎲');
  const room = manager.rooms.get(created.roomCode); room.players.forEach((player, index) => manager.setReady(sockets[index], room.code, true));
  if (!options.noStart) manager.startGame(sockets[0], room.code);
  t.after(() => { manager.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, io, manager, profiles, sockets, room, created };
}
function act(f, index, action, extra = {}) { f.manager.action(f.sockets[index], f.room.code, { action, actionId: crypto.randomUUID(), expectedRevision: f.room.revision, ...extra }); }

test('Tiến lên deck, formations, cuts and white-win priorities use the local v1 rules', () => {
  const deck = createTienLenDeck(); assert.equal(deck.length, 52); assert.equal(new Set(deck.map(item => item.id)).size, 52);
  assert.equal(classify([card('3', 'S'), card('4', 'C'), card('5', 'D')]).kind, 'straight');
  assert.equal(classify([card('Q', 'S'), card('K', 'C'), card('A', 'D'), card('2', 'H')]), null);
  const threePairs = classify([card('3', 'S'), card('3', 'C'), card('4', 'S'), card('4', 'C'), card('5', 'S'), card('5', 'C')]);
  const two = classify([card('2', 'H')]); assert.equal(canBeat(threePairs, two), true);
  const pairTwo = classify([card('2', 'S'), card('2', 'H')]); assert.equal(canBeat(threePairs, pairTwo), false);
  const fourTwos = ['S', 'C', 'D', 'H'].map(suit => card('2', suit)); assert.equal(whiteWin(fourTwos).label, 'tứ quý 2');
});

test('Tiến lên recognizes pairs, triples and fours with their correct cutting rules', () => {
  const pair = classify([card('2', 'S'), card('2', 'H')]);
  const triple = classify([card('7', 'S'), card('7', 'C'), card('7', 'D')]);
  const four = classify(['S', 'C', 'D', 'H'].map(suit => card('8', suit)));
  assert.equal(pair.kind, 'pair'); assert.equal(triple.kind, 'triple'); assert.equal(four.kind, 'four');
  assert.equal(canBeat(four, pair), true);
  assert.equal(canBeat(triple, pair), false);
  assert.equal(canBeat(classify([card('8', 'S'), card('8', 'H')]), classify([card('7', 'C'), card('7', 'H')])), true);
});

test('Tiến lên restores a legacy pair label without changing seats, tokens or cards', t => {
  const f = fixture(t, 2), owner = f.room.players[0];
  const rank = owner.hand.find(card => owner.hand.filter(other => other.rank === card.rank).length >= 2).rank;
  const cards = owner.hand.filter(card => card.rank === rank).slice(0, 2);
  owner.hand = owner.hand.filter(card => !cards.includes(card));
  f.room.topPlay = { playerId: owner.id, cards, formation: { ...classify(cards), kind: 'triple' } };
  f.room.playedAny = true; f.room.currentPlayerId = f.room.players[1].id; f.room.leaderId = owner.id;
  f.manager.storageFile = path.join(f.directory, 'legacy-label.json'); f.manager.close();
  const restored = new TienLenManager(fakeIo(), { profileStore: f.store, storageFile: f.manager.storageFile });
  restored.storageFile = null;
  t.after(() => restored.close());
  const room = restored.rooms.get(f.room.code);
  assert.equal(room.topPlay.formation.kind, 'pair'); assert.equal(room.paused, true);
  assert.deepEqual(room.players.map(player => ({ id: player.id, token: player.token, hand: player.hand })), f.room.players.map(player => ({ id: player.id, token: player.token, hand: player.hand })));
});

test('Tiến lên keeps opponents private, requires the dealt low card, rejects stale/foreign actions and resets a passed round', t => {
  const f = fixture(t, 3); assert.equal(f.room.phase, 'TURN');
  const own = f.manager.buildStateFor(f.room, f.room.players[0].id); assert.equal(own.myHand.length, 13); assert.equal(JSON.stringify(own).includes(JSON.stringify(f.room.players[1].hand[0].id)), false);
  const before = JSON.stringify(f.room); const other = f.room.players.findIndex(player => player.id !== f.room.currentPlayerId); act(f, other, 'pass'); assert.equal(JSON.stringify(f.room), before);
  const starter = f.room.players.findIndex(player => player.id === f.room.currentPlayerId); const starterPlayer = f.room.players[starter]; const wrong = starterPlayer.hand.find(item => item.id !== f.room.initialRequiredCardId); act(f, starter, 'play', { cardIds: [wrong.id] }); assert.equal(starterPlayer.hand.length, 13);
  const low = starterPlayer.hand.find(item => item.id === f.room.initialRequiredCardId); act(f, starter, 'play', { cardIds: [low.id] }); assert.equal(starterPlayer.hand.length, 12);
  const responder = f.room.players.findIndex(player => player.id === f.room.currentPlayerId); act(f, responder, 'pass');
  const last = f.room.players.findIndex(player => player.id === f.room.currentPlayerId); act(f, last, 'pass'); assert.equal(f.room.topPlay, null); assert.equal(f.room.currentPlayerId, starterPlayer.id);
  const revision = f.room.revision; f.manager.action(f.sockets[starter], f.room.code, { action: 'play', actionId: crypto.randomUUID(), expectedRevision: revision - 1, cardIds: [starterPlayer.hand[0].id] }); assert.equal(f.room.revision, revision);
});

test('a valid cut closes the trick and gives its cutter the next lead', t => {
  const f = fixture(t, 2), cutter = f.room.players[0], other = f.room.players[1];
  cutter.hand = [card('3', 'S'), card('3', 'C'), card('4', 'S'), card('4', 'C'), card('5', 'S'), card('5', 'C'), card('9', 'H')];
  f.room.phase = 'TURN'; f.room.playedAny = true; f.room.initialRequiredCardId = null; f.room.currentPlayerId = cutter.id; f.room.leaderId = other.id;
  const top = card('2', 'H'); f.room.topPlay = { playerId: other.id, formation: classify([top]), cards: [top] };
  act(f, 0, 'play', { cardIds: cutter.hand.slice(0, 6).map(item => item.id) }); assert.equal(f.room.topPlay, null); assert.equal(f.room.currentPlayerId, cutter.id); assert.equal(cutter.hand.length, 1);
});

test('four fixed reservations settle once as +300/-100 and record a mission match', t => {
  const f = fixture(t, 4); const winner = f.room.players[0];
  // Make the settlement terminal deterministic without altering reservations.
  const terminalCard = winner.hand[0]; winner.hand = [terminalCard]; f.room.currentPlayerId = winner.id; f.room.initialRequiredCardId = terminalCard.id; f.room.playedAny = false; f.room.topPlay = null;
  act(f, 0, 'play', { cardIds: [terminalCard.id] }); assert.equal(f.room.phase, 'RESULT'); assert.equal(f.room.result.pot, 400);
  assert.deepEqual(f.profiles.map(profile => f.store.publicProfile(profile.id).balances.coin.available), [1300, 900, 900, 900]);
  const saved = f.store.profileState(f.profiles[0].id); assert.equal(saved.missions.find(item => item.id === 'daily_match').progress, 1);
  f.manager.finish(f.room, winner, 'replay'); assert.deepEqual(f.profiles.map(profile => f.store.publicProfile(profile.id).balances.coin.available), [1300, 900, 900, 900]);
  const previousMatch = f.room.matchId; act(f, 0, 'play_again'); assert.equal(f.room.phase, 'TURN'); assert.notEqual(f.room.matchId, previousMatch); assert.ok(f.room.players.every(player => player.hand.length === 13));
});

test('a missing balance prevents partial holds and host cancellation releases a pre-play hand', t => {
  const f = fixture(t, 2, { noStart: true });
  const blocking = f.store.reserveMany({ reservations: [{ profileId: f.profiles[1].id, amount: 1000 }], currency: 'coin', operationKey: 'test-blocking-reservation', roomCode: 'OTHER' });
  f.manager.startGame(f.sockets[0], f.room.code); assert.equal(f.room.phase, 'WAITING'); assert.equal(f.store.publicProfile(f.profiles[0].id).balances.coin.available, 1000); assert.equal(f.store.publicProfile(f.profiles[1].id).balances.coin.available, 0);
  f.store.releaseReservations({ reservations: blocking.held, operationKey: 'release-blocking-reservation', roomCode: 'OTHER' });
  f.manager.startGame(f.sockets[0], f.room.code); assert.equal(f.room.phase, 'TURN');
  act(f, 0, 'cancel_before_first_play'); assert.equal(f.room.phase, 'WAITING');
  assert.deepEqual(f.profiles.map(profile => f.store.publicProfile(profile.id).balances.coin), [{ available: 1000, reserved: 0 }, { available: 1000, reserved: 0 }]);
});

test('a reserved in-progress Tiến lên hand survives restart paused and resumes without duplicating a hold', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-tl-restart-')), databaseFile = path.join(directory, 'profiles.sqlite'), storageFile = path.join(directory, 'tien-len.json');
  const store = new ProfileStore({ databaseFile }), profiles = [store.createProfile({ displayName: 'A' }), store.createProfile({ displayName: 'B' })];
  const io = fakeIo(), first = socket('first', profiles[0].profile), second = socket('second', profiles[1].profile); io.sockets.sockets.set(first.id, first); io.sockets.sockets.set(second.id, second);
  let manager = new TienLenManager(io, { profileStore: store, profileForSocket: item => item.profile, storageFile, shuffle: deterministicShuffle });
  const created = manager.createRoom(first, 'A', '🕶️'), joined = manager.joinRoom(second, created.roomCode, 'B', '🎲'), room = manager.rooms.get(created.roomCode);
  manager.setReady(first, room.code, true); manager.setReady(second, room.code, true); manager.startGame(first, room.code); const matchId = room.matchId; manager.close();
  const restoredIo = fakeIo(), firstBack = socket('first-back', profiles[0].profile), secondBack = socket('second-back', profiles[1].profile); restoredIo.sockets.sockets.set(firstBack.id, firstBack); restoredIo.sockets.sockets.set(secondBack.id, secondBack);
  manager = new TienLenManager(restoredIo, { profileStore: store, profileForSocket: item => item.profile, storageFile, shuffle: deterministicShuffle }); t.after(() => { manager.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const restored = manager.rooms.get(created.roomCode); assert.equal(restored.matchId, matchId); assert.equal(restored.phase, 'TURN'); assert.equal(restored.paused, true);
  manager.resumeRoom(firstBack, created.roomCode, created.sessionToken); assert.equal(manager.rooms.get(created.roomCode).paused, true);
  manager.resumeRoom(secondBack, created.roomCode, joined.sessionToken); assert.equal(manager.rooms.get(created.roomCode).paused, false);
  assert.deepEqual(profiles.map(item => store.publicProfile(item.profile.id).balances.coin), [{ available: 900, reserved: 100 }, { available: 900, reserved: 100 }]);
});
