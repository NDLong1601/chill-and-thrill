'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BangManager } = require('../src/games/bang/bangEngine');
const { CARD_META, CHARACTERS, ROLE_SETS, createBangDeck } = require('../src/games/bang/bangDeck');

function fakeIo() { const sockets = new Map(); return { sockets: { sockets }, to: () => ({ emit() {} }) }; }
function fakeSocket(id, profile) { return { id, profile, events: [], join() {}, leave() {}, emit(event, payload) { this.events.push({ event, payload }); } }; }
function makeCard(type, serial = crypto.randomUUID()) { const source = createBangDeck().find(card => card.type === type); return { ...source, ...CARD_META[type], id: `${type}-${serial}` }; }
function fixture(t, options = {}) {
  const io = fakeIo(), completed = [], profiles = Array.from({ length: 4 }, (_item, index) => ({ id: `profile-${index}`, displayName: `Người ${index + 1}`, avatar: '🤠' }));
  const sockets = profiles.map((profile, index) => fakeSocket(`bang-${index}`, profile)); sockets.forEach(socket => io.sockets.sockets.set(socket.id, socket));
  const manager = new BangManager(io, { storageFile: options.storageFile, profileForSocket: socket => socket.profile, onMatchCompleted: match => completed.push(match), shuffle: cards => [...cards] });
  const created = manager.createRoom(sockets[0], 'ignored', '🤠'); const credentials = [created]; for (let index = 1; index < 4; index += 1) credentials.push(manager.joinRoom(sockets[index], created.roomCode, 'ignored', '🤠'));
  const room = manager.rooms.get(created.roomCode); room.players.forEach((player, index) => manager.setReady(sockets[index], room.code, true)); manager.startGame(sockets[0], room.code);
  t.after(() => manager.close()); return { io, profiles, sockets, manager, room, credentials, completed };
}
function act(f, index, action, extra = {}) { return f.manager.action(f.sockets[index], f.room.code, { action, actionId: crypto.randomUUID(), expectedRevision: f.room.revision, ...extra }); }

test('BANG! base deck has the official 80-card composition, characters, and role sets', () => {
  const deck = createBangDeck(), counts = Object.fromEntries([...new Set(deck.map(card => card.type))].map(type => [type, deck.filter(card => card.type === type).length]));
  assert.equal(deck.length, 80); assert.equal(new Set(deck.map(card => card.id)).size, 80); assert.equal(CHARACTERS.length, 16);
  assert.deepEqual(Object.fromEntries(Object.entries(ROLE_SETS).map(([count, roles]) => [count, roles.length])), { 4: 4, 5: 5, 6: 6, 7: 7 });
  assert.deepEqual({ BANG: counts.BANG, MISSED: counts.MISSED, BEER: counts.BEER, JAIL: counts.JAIL, DYNAMITE: counts.DYNAMITE, GATLING: counts.GATLING }, { BANG: 25, MISSED: 12, BEER: 6, JAIL: 3, DYNAMITE: 1, GATLING: 1 });
});

test('BANG! hides roles and hands while keeping Sheriff/character/equipment public', t => {
  const f = fixture(t), first = f.room.players[0], second = f.room.players[1], third = f.room.players[2]; const state = f.manager.buildStateFor(f.room, second.id);
  assert.equal(state.phase, 'DRAW'); assert.equal(state.players.find(player => player.id === first.id).role, 'SHERIFF'); assert.equal(state.players.find(player => player.id === third.id).role, null);
  assert.equal(JSON.stringify(state).includes(third.hand[0].id), false); assert.equal(state.myHand.length, second.hand.length);
  f.room.players[0].equipment = [makeCard('SCOPE')]; assert.equal(f.manager.distance(f.room, first.id, third.id), 1, 'Scope reduces a two-seat distance');
  third.dead = true; assert.equal(f.manager.distance(f.room, first.id, second.id), 1, 'eliminated seats are removed from distance');
});

test('BANG!, Slab, Barrel check, Duel and Indians use a server-owned reaction queue', t => {
  const f = fixture(t), [attacker, target] = f.room.players; f.room.phase = 'MAIN'; f.room.currentPlayerId = attacker.id; attacker.characterId = 'SLAB_THE_KILLER'; attacker.hand = [makeCard('BANG')]; target.hand = [makeCard('MISSED'), makeCard('MISSED')];
  act(f, 0, 'play_card', { cardId: attacker.hand[0].id, targetId: target.id }); assert.equal(f.room.pending.kind, 'ATTACK'); assert.equal(f.room.pending.missesNeeded, 2); const revisionBeforeWrongReply = f.room.revision; const wrongReply = act(f, 2, 'respond', { response: 'take' }); assert.match(wrongReply.error, /Không phải bạn/); assert.equal(f.room.revision, revisionBeforeWrongReply);
  act(f, 1, 'respond', { response: 'miss', cardId: target.hand[0].id }); assert.equal(f.room.pending.kind, 'ATTACK'); act(f, 1, 'respond', { response: 'miss', cardId: target.hand[0].id }); assert.equal(f.room.pending, null); assert.equal(target.hp, target.maxHp);
  attacker.hand = [makeCard('DUEL')]; target.hand = [makeCard('BANG')]; f.room.phase = 'MAIN'; f.room.currentPlayerId = attacker.id; act(f, 0, 'play_card', { cardId: attacker.hand[0].id, targetId: target.id }); assert.equal(f.room.pending.kind, 'DUEL'); act(f, 1, 'respond', { response: 'bang', cardId: target.hand[0].id }); assert.equal(f.room.pending.waitingId, attacker.id); act(f, 0, 'respond', { response: 'take' }); assert.equal(f.room.pending, null); assert.equal(attacker.hp, attacker.maxHp - 1);
  attacker.hand = [makeCard('INDIANS')]; target.hand = [makeCard('BANG')]; f.room.phase = 'MAIN'; f.room.currentPlayerId = attacker.id; act(f, 0, 'play_card', { cardId: attacker.hand[0].id }); assert.equal(f.room.pending.kind, 'INDIANS'); act(f, 1, 'respond', { response: 'bang', cardId: target.hand[0].id }); assert.notEqual(f.room.pending?.waitingId, target.id, 'each other living seat responds exactly once');
});

test('Jail, Dynamite and Beer resolve in the published order, including repeated lethal Beer', t => {
  const f = fixture(t), [, target] = f.room.players; const jail = makeCard('JAIL'); target.equipment = [jail]; f.room.currentPlayerId = target.id; f.room.deck = [makeCard('MISSED')]; f.manager.startTurn(f.room); assert.equal(f.room.pending.kind, 'DRAW_CHECK'); act(f, 1, 'respond', { choiceIndex: 0 }); assert.notEqual(f.room.currentPlayerId, target.id, 'failed Jail skips the turn');
  target.dead = false; target.hp = 1; target.hand = [makeCard('BEER'), makeCard('BEER'), makeCard('BEER')]; const dynamite = makeCard('DYNAMITE'); target.equipment = [dynamite]; f.room.currentPlayerId = target.id; f.room.phase = 'DRAW'; f.room.deck = [makeCard('BANG')]; f.room.deck[0].suit = 'S'; f.room.deck[0].rank = '2'; f.manager.startTurn(f.room); assert.equal(f.room.pending.kind, 'DRAW_CHECK'); act(f, 1, 'respond', { choiceIndex: 0 }); assert.equal(f.room.pending.kind, 'LETHAL'); act(f, 1, 'respond', { response: 'beer', cardId: target.hand[0].id }); act(f, 1, 'respond', { response: 'beer', cardId: target.hand[0].id }); act(f, 1, 'respond', { response: 'beer', cardId: target.hand[0].id }); assert.equal(target.hp, 1); assert.equal(f.room.pending, null);
});

test('General Store, equipment replacement, Panic/Cat Balou and end-turn discard preserve card ownership', t => {
  const f = fixture(t), [actor, target] = f.room.players; f.room.phase = 'MAIN'; f.room.currentPlayerId = actor.id; actor.hand = [makeCard('GENERAL_STORE')]; f.room.deck = [makeCard('BEER'), makeCard('BANG'), makeCard('MISSED'), makeCard('SALOON')];
  act(f, 0, 'play_card', { cardId: actor.hand[0].id }); assert.equal(f.room.pending.kind, 'GENERAL_STORE'); for (let index = 0; index < 4; index += 1) { const cardId = f.room.pending.cards[0].id; act(f, index, 'respond', { cardId }); } assert.equal(f.room.pending, null); assert.equal(f.room.players.reduce((sum, player) => sum + player.hand.length, 0) >= 4, true);
  const scope = makeCard('SCOPE'), cat = makeCard('CAT_BALOU'); actor.hand = [cat]; target.equipment = [scope]; f.room.phase = 'MAIN'; f.room.currentPlayerId = actor.id; act(f, 0, 'play_card', { cardId: cat.id, targetId: target.id, targetCardId: scope.id }); assert.equal(target.equipment.length, 0); assert.ok(f.room.discard.some(card => card.id === scope.id));
  const panic = makeCard('PANIC'), barrel = makeCard('BARREL'); actor.hand = [panic]; target.equipment = [barrel]; f.room.phase = 'MAIN'; f.room.currentPlayerId = actor.id; act(f, 0, 'play_card', { cardId: panic.id, targetId: target.id, targetCardId: barrel.id }); assert.ok(actor.hand.some(card => card.id === barrel.id));
  actor.hp = 1; actor.hand = [makeCard('BANG'), makeCard('MISSED')]; f.room.phase = 'MAIN'; f.room.currentPlayerId = actor.id; act(f, 0, 'end_turn', { cardIds: [actor.hand[0].id] }); assert.equal(actor.hand.length, 1);
});

test('elimination checks the winner before post-elimination effects and records early players once', t => {
  const f = fixture(t), [sheriff, outlaw, deputy, renegade] = f.room.players; sheriff.role = 'SHERIFF'; outlaw.role = 'OUTLAW'; deputy.role = 'DEPUTY'; renegade.role = 'RENEGADE'; deputy.dead = true; renegade.dead = true; sheriff.hand = [makeCard('BANG')]; outlaw.hand = []; outlaw.hp = 1; f.room.phase = 'MAIN'; f.room.currentPlayerId = sheriff.id;
  act(f, 0, 'play_card', { cardId: sheriff.hand[0].id, targetId: outlaw.id }); act(f, 1, 'respond', { response: 'take' }); assert.equal(f.room.pending.kind, 'LETHAL'); act(f, 1, 'respond', { response: 'give_up' }); assert.equal(f.room.phase, 'RESULT'); assert.equal(f.room.result.faction, 'SHERIFF_DEPUTIES'); assert.equal(f.completed.length, 1); assert.equal(f.completed[0].players.length, 4);
});

test('all sixteen base-character abilities have a server-side rule path', t => {
  const f = fixture(t), [first, second, third, fourth] = f.room.players;
  first.characterId = 'BART_CASSIDY'; first.hp = 3; first.hand = []; f.room.deck = [makeCard('BANG')]; f.manager.applyDamage(f.room, first.id, 1, second.id, 'BANG', { type: 'CLEAR_PENDING' }); assert.equal(first.hand.length, 1, 'Bart draws for damage');
  first.characterId = 'BLACK_JACK'; first.hand = []; first.hp = 4; first.maxHp = 4; f.room.phase = 'DRAW'; f.room.currentPlayerId = first.id; const red = makeCard('BEER'); red.suit = 'H'; f.room.deck = [makeCard('BANG'), red, makeCard('MISSED')]; act(f, 0, 'draw_cards'); assert.equal(first.hand.length, 3, 'Black Jack draws extra on red second card');
  first.characterId = 'CALAMITY_JANET'; assert.equal(f.manager.isMissCard(first, makeCard('BANG')), true); assert.equal(f.manager.isBangCard(first, makeCard('MISSED')), true);
  first.characterId = 'JESSE_JONES'; first.hand = []; second.hand = [makeCard('BANG')]; f.room.phase = 'DRAW'; f.room.currentPlayerId = first.id; f.room.deck = [makeCard('MISSED')]; act(f, 0, 'draw_cards', { targetId: second.id }); assert.equal(second.hand.length, 0, 'Jesse draws the first card from a target');
  second.characterId = 'JOURDONNAIS'; f.manager.startAttack(f.room, { actorId: first.id, source: 'BANG', targetIds: [second.id], index: 0 }); assert.equal(f.room.pending.barrelAttempts, 1, 'Jourdonnais has a virtual Barrel');
  first.characterId = 'KIT_CARLSON'; f.room.pending = null; f.room.deck = [makeCard('BANG'), makeCard('BEER'), makeCard('MISSED')]; f.manager.beginDrawPhase(f.room, first); assert.equal(f.room.pending.kind, 'KIT_DRAW');
  first.characterId = 'LUCKY_DUKE'; f.room.pending = null; f.room.deck = [makeCard('BANG'), makeCard('BEER')]; f.manager.startDrawCheck(f.room, first, 'JAIL', { type: 'JAIL_CHECK', cardId: 'none' }); assert.equal(f.room.pending.options.length, 2, 'Lucky Duke chooses one of two draw checks'); f.room.pending = null;
  first.characterId = 'ROSE_DOOLAN'; second.characterId = 'PAUL_REGRET'; first.dead = false; second.dead = false; third.dead = false; fourth.dead = false; assert.equal(f.manager.distance(f.room, first.id, third.id), 1, 'Rose reduces distance'); assert.equal(f.manager.distance(f.room, third.id, second.id), 2, 'Paul increases distance to himself');
  first.characterId = 'PEDRO_RAMIREZ'; first.hand = []; f.room.phase = 'DRAW'; f.room.currentPlayerId = first.id; f.room.discard = [makeCard('BANG')]; f.room.deck = [makeCard('MISSED')]; act(f, 0, 'draw_cards', { from: 'discard' }); assert.equal(first.hand.length, 2, 'Pedro can draw from discard first');
  first.characterId = 'SID_KETCHUM'; first.hp = 2; first.maxHp = 4; first.hand = [makeCard('BANG'), makeCard('MISSED')]; f.room.phase = 'MAIN'; f.room.currentPlayerId = first.id; act(f, 0, 'sid_heal', { cardIds: first.hand.map(card => card.id) }); assert.equal(first.hp, 3, 'Sid exchanges two cards for life');
  first.characterId = 'SUZY_LAFAYETTE'; first.hand = []; f.room.deck = [makeCard('BEER')]; f.manager.checkSuzy(f.room, first); assert.equal(first.hand.length, 1, 'Suzy draws when empty');
  first.characterId = 'VULTURE_SAM'; first.hand = []; first.role = 'SHERIFF'; second.role = 'OUTLAW'; third.role = 'DEPUTY'; fourth.role = 'RENEGADE'; second.hand = [makeCard('BANG')]; second.equipment = [makeCard('BARREL')]; f.manager.eliminate(f.room, second, third.id, 'fixture', { type: 'CLEAR_PENDING' }); assert.equal(first.hand.length, 2, 'Vulture Sam takes a defeated player’s cards');
  first.characterId = 'WILLY_THE_KID'; first.hand = [makeCard('BANG'), makeCard('BANG')]; first.equipment = [makeCard('SCHOFIELD')]; second.dead = false; second.hp = 3; second.hand = []; f.room.phase = 'MAIN'; f.room.currentPlayerId = first.id; assert.equal(f.manager.playBang(f.sockets[0], f.room, first, first.hand[0], second), true); f.room.pending = null; assert.equal(f.manager.playBang(f.sockets[0], f.room, first, first.hand[0], second), true); assert.equal(first.bangCount, 2, 'Willy ignores the normal BANG! limit');
});

test('restart preserves a pending reaction and resumes only after every seat reconnects', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-bang-restart-')), storageFile = path.join(directory, 'bang.json'); const f = fixture(t, { storageFile }); const [attacker, target] = f.room.players; f.room.phase = 'MAIN'; f.room.currentPlayerId = attacker.id; attacker.hand = [makeCard('BANG')]; target.hand = [makeCard('MISSED')]; act(f, 0, 'play_card', { cardId: attacker.hand[0].id, targetId: target.id }); f.manager.close(); const restoredIo = fakeIo(), restoredSockets = f.profiles.map((profile, index) => fakeSocket(`return-${index}`, profile)); restoredSockets.forEach(socket => restoredIo.sockets.sockets.set(socket.id, socket)); const restored = new BangManager(restoredIo, { storageFile, profileForSocket: socket => socket.profile, shuffle: cards => [...cards] }); t.after(() => { restored.close(); fs.rmSync(directory, { recursive: true, force: true }); }); const room = restored.rooms.get(f.room.code); assert.equal(room.pending.kind, 'ATTACK'); assert.equal(room.paused, true); room.players.forEach((player, index) => restored.resumeRoom(restoredSockets[index], room.code, f.credentials[index].sessionToken)); assert.equal(room.paused, false); assert.equal(JSON.stringify(restored.buildStateFor(room, room.players[0].id)).includes(room.players[1].hand[0].id), false);
});
