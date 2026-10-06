'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GameManager, QUICK_CHAT } = require('../src/gameEngine');
const { CHALLENGES, SPECIALISTS } = require('../src/cardsData');
const { getBestHand, checkShowdown } = require('../src/handEvaluator');
const { deal } = require('../src/deck');
const card = (value, suit = 'spades') => ({ value, suit });

function fixture(t, count = 3, mode = 'BASIC', options = {}) {
  const sockets = Array.from({ length: count }, (_, i) => ({ id: `socket-${i}`, events: [], join() {}, leave() {}, emit(event, data) { this.events.push({ event, data }); } }));
  const io = { sockets: { sockets: new Map(sockets.map(s => [s.id, s])) }, to: () => ({ emit() {} }) };
  const gm = new GameManager(io, options); t.after(() => gm.close());
  const credentials = [gm.createRoom(sockets[0], 'Người 1', mode)]; const code = credentials[0].roomCode;
  for (let i = 1; i < count; i++) credentials.push(gm.joinRoom(sockets[i], code, `Người ${i + 1}`));
  const room = gm.rooms.get(code);
  return { gm, io, sockets, credentials, code, room };
}
function start(f) { f.sockets.forEach(s => f.gm.setReady(s, f.code, true)); f.gm.startGame(f.sockets[0], f.code); }
function pickAndConfirm(f) {
  f.sockets.forEach((s, i) => f.gm.claimChip(s, f.code, i + 1));
  f.sockets.forEach(s => f.gm.confirmRound(s, f.code, true));
}
function useExpert(f, id, actorIndex = 0, extra = {}) {
  f.room.activeSpecialist = SPECIALISTS.find(c => c.id === id); f.gm.startHeist(f.room);
  if ([3, 6, 8, 9].includes(id)) return;
  f.gm.specialistAction(f.sockets[0], f.code, { action: 'propose', actorId: f.room.players[actorIndex].id, ...extra });
  f.sockets.slice(1).forEach(s => f.gm.specialistAction(s, f.code, { action: 'approve' }));
}
function finish(f) {
  for (let i = 0; i < 4; i++) { pickAndConfirm(f); f.gm.advancePhase(f.sockets[0], f.code); }
  for (let i = 0; i < f.room.players.length; i++) f.gm.revealNext(f.sockets[0], f.code);
}

test('deal has unique cards and supports 3 hole cards for six players', () => {
  const d = deal(6, 3), all = [...d.playerHands.flat(), ...d.communityCards, ...d.remainingDeck];
  assert.equal(all.length, 52); assert.equal(new Set(all.map(c => `${c.value}:${c.suit}`)).size, 52); assert.equal(d.playerHands[0].length, 3);
});
test('poker evaluates ranks, wheels, kickers, ties and unsuited Jack', () => {
  const royal = getBestHand([], [10, 11, 12, 13, 14].map(v => card(v, 'hearts'))); assert.equal(royal.rankLevel, 10);
  const wheel = getBestHand([], [card(14), card(2, 'clubs'), card(3), card(4), card(5)]); assert.equal(wheel.rankLevel, 5);
  assert.ok(getBestHand([], [card(2), card(3), card(4), card(5), card(6)]).score > wheel.score);
  const board = [card(2), card(2, 'hearts'), card(14), card(7), card(5, 'clubs')];
  const a = getBestHand([card(11), card(3, 'clubs')], board), b = getBestHand([card(10), card(4, 'clubs')], board);
  assert.ok(a.score > b.score);
  assert.equal(checkShowdown([{ chip: 1, handScore: a.score }, { chip: 2, handScore: a.score }]).success, true);
  assert.equal(getBestHand([], [card(11, 'none'), card(12), card(13), card(14), card(10)]).rankLevel, 5);
  const fiveJ = getBestHand([], ['spades', 'hearts', 'clubs', 'diamonds', 'none'].map(s => card(11, s))); assert.equal(fiveJ.rankLevel, 8);
  assert.equal(getBestHand([card(11), card(11, 'hearts'), card(11, 'clubs')], []).rankLevel, 4);
});
test('Muscle wins every hand of the same rank but loses to a higher rank', () => {
  const board = [card(2), card(5, 'hearts'), card(9, 'clubs'), card(11, 'diamonds'), card(13)];
  const muscle = getBestHand([card(2, 'hearts'), card(3, 'clubs')], board, { hasMuscleBonus: true });
  const kings = getBestHand([card(13, 'hearts'), card(14, 'clubs')], board);
  const trips = getBestHand([card(13, 'hearts'), card(13, 'clubs')], board);
  assert.ok(muscle.score > kings.score); assert.ok(muscle.score < trips.score);
});
test('requires all ready and forbids starting a match again mid-game', t => {
  const f = fixture(t); f.gm.startGame(f.sockets[0], f.code); assert.equal(f.room.phase, 'WAITING');
  start(f); const id = f.room.matchId; f.gm.startGame(f.sockets[0], f.code); assert.equal(f.room.matchId, id);
});
test('changing chips never duplicates or loses chips and resets confirmations', t => {
  const f = fixture(t); start(f);
  f.gm.claimChip(f.sockets[0], f.code, 1); f.gm.confirmRound(f.sockets[0], f.code, true);
  f.gm.claimChip(f.sockets[0], f.code, 2);
  assert.equal(f.room.players[0].chips.white, 2); assert.deepEqual(f.room.chipPool, [1, 3]); assert.equal(f.room.players[0].roundConfirmed, false);
  f.gm.claimChip(f.sockets[1], f.code, 2); assert.equal(f.room.players[1].chips.white, null);
  f.gm.returnChip(f.sockets[0], f.code); assert.deepEqual(f.room.chipPool, [1, 2, 3]);
});
test('locked chips cannot be exchanged, returned or taken; River unlocks them', t => {
  const f = fixture(t); start(f); f.room.activeChallenges = [CHALLENGES[1], CHALLENGES[5]];
  f.gm.claimChip(f.sockets[0], f.code, 1); f.gm.claimChip(f.sockets[1], f.code, 3);
  f.gm.claimChip(f.sockets[0], f.code, 2); f.gm.returnChip(f.sockets[0], f.code); f.gm.snatchChip(f.sockets[2], f.code, f.room.players[0].id);
  assert.equal(f.room.players[0].chips.white, 1); assert.equal(f.room.players[2].chips.white, null);
  f.room.phase = 'RIVER'; assert.equal(f.gm.isChipLocked(f.room, 1), false);
});
test('taking a chip returns my old chip to the pool, never places it on another player', t => {
  const f = fixture(t); start(f); f.gm.claimChip(f.sockets[0], f.code, 1); f.gm.claimChip(f.sockets[1], f.code, 2);
  f.gm.snatchChip(f.sockets[0], f.code, f.room.players[1].id);
  assert.equal(f.room.players[0].chips.white, 2); assert.equal(f.room.players[1].chips.white, null); assert.deepEqual(f.room.chipPool, [1, 3]);
});
test('phase guard, host permissions, pause and confirmations are enforced', t => {
  const f = fixture(t); start(f); const key = f.gm.phaseKey(f.room);
  f.gm.advancePhase(f.sockets[0], f.code); assert.equal(f.room.phase, 'PRE_FLOP');
  pickAndConfirm(f); f.gm.advancePhase(f.sockets[1], f.code); assert.equal(f.room.phase, 'PRE_FLOP');
  f.gm.advancePhase(f.sockets[0], f.code); assert.equal(f.room.phase, 'FLOP');
  f.gm.claimChip(f.sockets[0], f.code, 1, key); assert.equal(f.room.players[0].chips.yellow, null);
  f.gm.setPaused(f.sockets[0], f.code, true); f.gm.claimChip(f.sockets[0], f.code, 1); assert.equal(f.room.players[0].chips.yellow, null);
});
test('reload resumes stable player, cards and chip; disconnected host is transferred', t => {
  const f = fixture(t); start(f); f.gm.claimChip(f.sockets[0], f.code, 2);
  const before = [...f.room.players[0].privateCards]; const id = f.room.players[0].id;
  f.gm.handleDisconnect(f.sockets[0]); assert.equal(f.room.players[1].isHost, true);
  const socket = { ...f.sockets[0], id: 'new-socket' }; f.io.sockets.sockets.set(socket.id, socket);
  const resumed = f.gm.resumeRoom(socket, f.code, f.credentials[0].sessionToken);
  assert.equal(resumed.playerId, id); assert.deepEqual(f.room.players[0].privateCards, before); assert.equal(f.room.players[0].chips.white, 2);
  assert.ok(f.gm.resumeRoom(f.sockets[0], f.code, 'bad-token').error);
  assert.ok(f.gm.resumeRoom(f.sockets[0], f.code, f.credentials[0].sessionToken).error);
});
test('Blackout hides previous chips and chip logs in payload, preserving them only on server', t => {
  const f = fixture(t); start(f); f.room.activeChallenges = [CHALLENGES[7]]; pickAndConfirm(f); f.gm.advancePhase(f.sockets[0], f.code);
  const state = f.gm.buildStateFor(f.room, f.room.players[0].id);
  assert.equal(state.players[0].chips.white, null); assert.equal(f.room.players[0].chips.white, 1);
  assert.equal(state.log.some(l => l.type === 'chip'), false);
  assert.equal(state.players[1].privateCards.every(c => c === null), true);
  assert.equal(JSON.stringify(state).includes(f.credentials[0].sessionToken), false);
});
test('Quick Approach and Rushed Escape skip correct chip rounds', t => {
  const f = fixture(t); start(f); f.room.activeChallenges = [CHALLENGES[0], CHALLENGES[4]]; f.gm.startHeist(f.room);
  assert.equal(f.room.phase, 'FLOP'); assert.equal(f.room.communityCards.length, 3);
  pickAndConfirm(f); f.gm.advancePhase(f.sockets[0], f.code); assert.equal(f.room.phase, 'RIVER'); assert.equal(f.room.communityCards.length, 5);
});
for (const [id, face, victimIndex] of [[3, true, 0], [7, false, 2]]) test(`challenge ${id} replaces all three cards when Camera is active`, t => {
  const f = fixture(t); start(f); f.room.activeChallenges = [CHALLENGES[id - 1], CHALLENGES[9]]; f.gm.startHeist(f.room);
  f.room.allCommunityCards = [card(face ? 11 : 2), card(4, 'clubs'), card(8, 'hearts'), card(12), card(14)];
  const old = [...f.room.players[victimIndex].privateCards]; pickAndConfirm(f); f.gm.advancePhase(f.sockets[0], f.code);
  assert.equal(f.room.players[victimIndex].privateCards.length, 3); assert.equal(f.room.discardPile.length, 3); assert.notDeepEqual(f.room.players[victimIndex].privateCards, old);
});
test('Expert excludes Quick Approach from entire deck; Master starts with two random challenges', t => {
  const f = fixture(t, 3, 'EXPERT'); start(f); assert.notEqual(f.room.permanentChallenge.id, 1); assert.equal(f.room.challengeDeck.some(c => c.id === 1), false);
  const master = fixture(t, 3, 'MASTER_THIEF'); start(master); assert.equal(master.room.activeChallenges.length, 2); assert.equal(master.room.maxAlarms, 2);
  assert.equal(master.room.activeChallenges.some(c => c.id === 1), false);
});
test('Informant reveals exactly one card only to the agreed recipient', t => {
  const f = fixture(t); start(f); useExpert(f, 1, 0, { recipientId: f.room.players[1].id });
  assert.equal(f.room.specialistState.stage, 'SELECT_CARD');
  f.gm.specialistAction(f.sockets[2], f.code, { action: 'select', cardIndex: 0 }); assert.equal(f.room.specialistState.stage, 'SELECT_CARD');
  f.gm.specialistAction(f.sockets[0], f.code, { action: 'select', cardIndex: 1 });
  assert.deepEqual(f.gm.buildStateFor(f.room, f.room.players[1].id).privateInsights[0].card, f.room.players[0].privateCards[1]);
  assert.equal(f.gm.buildStateFor(f.room, f.room.players[2].id).privateInsights.length, 0);
});
for (const id of [2, 4, 10]) test(`specialist ${id} needs unanimous approval and applies only to selected player`, t => {
  const f = fixture(t); start(f); useExpert(f, id, 1, id === 4 ? { value: 14 } : {});
  assert.equal(f.room.specialistState.stage, 'DONE'); assert.equal(f.room.specialistState.usedBy, f.room.players[1].id);
  if (id === 10) assert.deepEqual(f.room.players.map(p => p.hasMuscleBonus), [false, true, false]);
  else { assert.ok(f.room.players[1].extraNote); assert.equal(f.room.players[0].extraNote, ''); }
});
for (const id of [5, 7]) test(`specialist ${id} privately adds a card, requires discard and cannot be reused`, t => {
  const f = fixture(t); start(f); useExpert(f, id); assert.equal(f.room.players[0].privateCards.length, 3); assert.equal(f.room.specialistState.stage, 'DISCARD');
  assert.ok(f.gm.buildStateFor(f.room, f.room.players[1].id).players[0].privateCards.every(c => c === null));
  f.gm.specialistAction(f.sockets[0], f.code, { action: 'select', cardIndex: 0 }); assert.equal(f.room.players[0].privateCards.length, 2);
  f.gm.specialistAction(f.sockets[0], f.code, { action: 'select', cardIndex: 0 }); assert.equal(f.room.players[0].privateCards.length, 2);
});
test('Coordinator passes simultaneously to next seat and hides all card selections', t => {
  const f = fixture(t); start(f); useExpert(f, 6); const old = f.room.players.map(p => [...p.privateCards]);
  f.gm.specialistAction(f.sockets[0], f.code, { action: 'select', cardIndex: 1 }); assert.deepEqual(f.room.players[0].privateCards, old[0]);
  const publicState = f.gm.buildStateFor(f.room, f.room.players[1].id).specialistState; assert.equal(publicState.choices, undefined); assert.equal(publicState.myChoice, null);
  f.gm.specialistAction(f.sockets[1], f.code, { action: 'select', cardIndex: 0 }); f.gm.specialistAction(f.sockets[2], f.code, { action: 'select', cardIndex: 1 });
  assert.deepEqual(f.room.players[1].privateCards[0], old[0][1]); assert.deepEqual(f.room.players[0].privateCards[1], old[2][1]);
});
test('Con Artist waits until everyone sees cards then redistributes only original cards', t => {
  const f = fixture(t); start(f); useExpert(f, 9); const all = f.room.players.flatMap(p => p.privateCards).map(c => JSON.stringify(c)).sort();
  f.sockets.forEach(s => f.gm.specialistAction(s, f.code, { action: 'seen' }));
  assert.equal(f.room.specialistState.stage, 'DONE'); assert.deepEqual(f.room.players.flatMap(p => p.privateCards).map(c => JSON.stringify(c)).sort(), all);
});
for (const id of [3, 8]) test(`automatic specialist ${id} publishes its permitted information`, t => {
  const f = fixture(t); start(f); useExpert(f, id); assert.ok(f.room.players.every(p => p.extraNote)); assert.equal(f.room.specialistState.stage, 'DONE');
});
test('Showdown reveals sequentially, rejects duplicate reveal and checks both guesses', t => {
  const f = fixture(t); start(f); f.room.activeChallenges = [CHALLENGES[3], CHALLENGES[8]];
  for (let i = 0; i < 4; i++) { pickAndConfirm(f); f.gm.advancePhase(f.sockets[0], f.code); }
  assert.equal(f.room.phase, 'SHOWDOWN'); assert.equal(f.gm.buildStateFor(f.room, f.room.players[2].id).players[0].privateCards.every(c => c === null), true);
  f.gm.revealNext(f.sockets[0], f.code, undefined, 0); f.gm.revealNext(f.sockets[0], f.code, undefined, 0); assert.equal(f.room.showdown.revealedCount, 1);
  f.gm.revealNext(f.sockets[0], f.code); f.gm.revealNext(f.sockets[0], f.code); assert.equal(f.room.showdown.revealedCount, 2);
  const top = f.room.players[2], vote = { value: top.privateCards[0].value, rank: top.rankLevel };
  f.gm.submitGuess(f.sockets[2], f.code, vote); assert.equal(Object.keys(f.room.showdown.votes).length, 0);
  f.gm.submitGuess(f.sockets[0], f.code, vote); f.gm.submitGuess(f.sockets[1], f.code, { ...vote, rank: vote.rank === 1 ? 2 : 1 });
  assert.deepEqual(f.room.showdown.guesses, {}); f.gm.submitGuess(f.sockets[1], f.code, vote); assert.deepEqual(f.room.showdown.guesses, vote);
  f.gm.revealNext(f.sockets[0], f.code); assert.equal(f.room.history.length, 1); assert.equal(f.room.lastResult.reason.includes('Đoán sai'), false);
});
test('wrong challenge guesses fail even when all hands tie in correct order', t => {
  const f = fixture(t); start(f); f.room.activeChallenges = [CHALLENGES[3], CHALLENGES[8]];
  f.room.communityCards = [10, 11, 12, 13, 14].map(v => card(v, 'hearts'));
  f.room.players.forEach((p, i) => { p.chips.red = i + 1; p.privateCards = [card(2 + i, 'clubs'), card(5 + i, 'diamonds')]; });
  f.gm.doShowdown(f.room); f.gm.revealNext(f.sockets[0], f.code); f.gm.revealNext(f.sockets[0], f.code);
  f.sockets.slice(0, 2).forEach(s => f.gm.submitGuess(s, f.code, { value: 14, rank: 1 })); f.gm.revealNext(f.sockets[0], f.code);
  assert.equal(f.room.lastResult.success, false); assert.equal(f.room.score.alarms, 1); assert.match(f.room.lastResult.reason, /Đoán sai/);
});
test('history persists across restarts and sessions recover private state without leaking tokens', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'the-gang-test-'));
  const storageFile = path.join(directory, 'rooms.json'), f = fixture(t, 3, 'BASIC', { storageFile }); start(f); finish(f); f.gm.flush();
  const restored = new GameManager(f.io, { storageFile }); t.after(() => restored.close());
  t.after(() => { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); });
  const room = restored.rooms.get(f.code); assert.equal(room.history.length, 1); assert.equal(room.players.every(p => !p.connected), true);
  assert.equal(restored.resumeRoom(f.sockets[0], f.code, f.credentials[0].sessionToken).playerId, f.room.players[0].id);
});
test('strict chat blocks hints and emotes during heist but allows neutral presets', t => {
  const f = fixture(t); start(f); f.gm.sendChat(f.sockets[0], f.code, 'Tôi có đôi A'); assert.equal(f.room.chatLog.length, 0);
  f.gm.sendChat(f.sockets[0], f.code, QUICK_CHAT[0]); assert.equal(f.room.chatLog.length, 1);
  f.gm.returnToLobby(f.sockets[0], f.code); f.gm.setChatMode(f.sockets[0], f.code, false); start(f);
  f.gm.sendChat(f.sockets[0], f.code, 'Chào cả đội'); assert.equal(f.room.chatLog.length, 2);
});
test('leave during heist queues the player until settlement, returning to lobby preserves history', t => {
  const f = fixture(t); start(f); f.gm.leaveRoom(f.sockets[1], f.code); assert.equal(f.room.players.length, 3);
  assert.equal(f.room.players[1].leaveAfterHand, true);
  finish(f); assert.equal(f.room.players.length, 2); assert.ok(f.sockets[1].events.some(event => event.event === 'room_left'));
  f.gm.returnToLobby(f.sockets[0], f.code); assert.equal(f.room.history.length, 1); assert.equal(f.room.players.every(p => !p.ready), true);
  f.gm.removePlayer(f.sockets[0], f.code, f.room.players[1].id); assert.equal(f.room.players.length, 1);
});
test('card deck progress survives replay and returning to lobby', t => {
  const f = fixture(t, 3, 'ADVANCED'); start(f);
  f.room.activeChallenges = [f.room.challengeDeck.shift()]; f.room.activeSpecialist = f.room.specialistDeck.shift();
  f.room.phase = 'GAME_OVER'; f.gm.playAgain(f.sockets[0], f.code);
  assert.equal(f.room.challengeDeck[0].id, 2); assert.equal(f.room.specialistDeck[0].id, 2);
  f.gm.returnToLobby(f.sockets[0], f.code); start(f);
  assert.equal(f.room.challengeDeck[0].id, 2); assert.equal(f.room.specialistDeck[0].id, 2);
});
test('completed heist history stays available during the next heist without revealing new opponents cards', t => {
  const f = fixture(t); start(f); finish(f); f.gm.nextHeist(f.sockets[0], f.code);
  const state = f.gm.buildStateFor(f.room, f.room.players[0].id);
  assert.equal(state.history.length, 1); assert.equal(state.lastResult, null);
  assert.equal(state.players[1].privateCards.every(c => c === null), true);
});
