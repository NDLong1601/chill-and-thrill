'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MultiGameManager } = require('../src/platform/multiGameManager');
const { parseAmount, cleanDisplayName } = require('../public/js/game-values');
const { validateRoomConfig } = require('../src/platform/gameRegistry');

function fixture(t, gameId = 'tien-len', count = 2, config = {}) {
  const sockets = new Map(), io = { sockets: { sockets }, to: () => ({ emit() {} }) };
  const gm = new MultiGameManager(io);
  t.after(() => gm.close());
  const clients = Array.from({ length: count }, (_, i) => {
    const socket = { id: `seat-${i}`, data: {}, events: [], join() {}, leave() {}, emit(event, data) { this.events.push({ event, data }); } };
    sockets.set(socket.id, socket); return socket;
  });
  const created = gm.createRoom(clients[0], 'Chủ bàn', 'ADVANCED', '🎲', gameId, config);
  assert.ok(!created.error, created.error);
  for (const client of clients.slice(1)) assert.ok(!gm.joinRoom(client, created.roomCode, `Khách ${client.id}`, '🎲').error);
  const manager = gm.managerForCode(created.roomCode), room = manager.rooms.get(created.roomCode);
  const act = (index, action, extra = {}) => gm.gameAction(clients[index], room.code, { action, ...extra, actionId: crypto.randomUUID(), expectedRevision: room.revision });
  function start() {
    if (gameId === 'poker') clients.forEach((_, i) => act(i, 'buy_in', { amount: 200 }));
    clients.forEach(client => gm.setReady(client, room.code, true));
    assert.ok(!gm.startGame(clients[0], room.code)?.error);
    if (gameId === 'sam-loc') clients.forEach((_, i) => act(i, 'pass_sam'));
  }
  return { gm, manager, room, clients, created, act, start, io };
}

test('amount parser accepts Vietnamese grouping and short units, rejects partial/unsafe values', () => {
  for (const [input, expected] of [['500', 500], ['1.000', 1000], ['5,000', 5000], ['10k', 10000], ['10tr', 10000000], ['1,5tr', 1500000], ['1.25k', 1250], ['10 triệu', 10000000]]) assert.equal(parseAmount(input), expected);
  for (const input of ['', '-500', '1e6', '10kk', 'Infinity', '10.00', '1,23,456', '0.0001k', 1.1, 9007199254740992, null]) assert.throws(() => parseAmount(input));
  assert.throws(() => parseAmount('5000', { max: 1000 }));
  assert.equal(validateRoomConfig('phom', { stake: '10tr' }).stake, 10000000);
  assert.throws(() => validateRoomConfig('phom', { stake: '1000000000000' }));
});

test('names repair old raw and multiply encoded storage without changing apostrophes or Unicode', () => {
  const name = 'Long Nguyễn';
  let encoded = name; for (let i = 0; i < 4; i++) encoded = JSON.stringify(encoded);
  assert.equal(cleanDisplayName(encoded), name);
  assert.equal(cleanDisplayName('\\"\\\\Long Nguyễn\\"'), name);
  assert.equal(cleanDisplayName(" O'Brien  Nguyễn "), "O'Brien Nguyễn");
});

test('explicit room handoff transfers only the proven seat and revokes the old socket access', t => {
  const f = fixture(t);
  const next = { ...f.clients[0], id: 'new-tab', data: { profile: f.clients[0].data.profile }, events: [] };
  f.io.sockets.sockets.set(next.id, next);
  assert.match(f.gm.resumeRoom(next, f.room.code, f.created.sessionToken).error, /cửa sổ khác/);
  assert.ok(f.gm.resumeRoom(next, f.room.code, 'wrong-token', { handoff: true }).error);
  assert.equal(f.room.players[0].socketId, f.clients[0].id);
  assert.ok(!f.gm.resumeRoom(next, f.room.code, f.created.sessionToken, { handoff: true }).error);
  assert.equal(f.room.players[0].socketId, next.id);
  assert.equal(f.manager.playerRoom.has(f.clients[0].id), false);
  assert.ok(f.gm.setReady(f.clients[0], f.room.code, true).error);
  assert.equal(f.room.players.length, 2);
});

test('integrated rooms also resume an authenticated active seat using the hashed legacy token', t => {
  const f = fixture(t, 'the-gang');
  const next = { ...f.clients[0], id: 'portal-new-tab', data: { profile: f.clients[0].data.profile, profileToken: f.created.profileToken }, events: [] };
  f.io.sockets.sockets.set(next.id, next);
  f.room.players[0].token = null;
  const result = f.gm.resumeRoom(next, f.room.code, f.created.sessionToken, { handoff: true });
  assert.ok(!result.error, result.error); assert.equal(f.room.players[0].socketId, next.id);
  assert.equal(f.manager.playerRoom.has(f.clients[0].id), false);
});

for (const gameId of ['tien-len', 'sam-loc', 'phom']) test(`${gameId}: configured stake settles once and replay stays on the same table`, t => {
  const f = fixture(t, gameId, 2, { stake: 50 });
  // This scenario asserts that replay deals an active hand. Keep the 13-card
  // deal away from the legal immediate white-win branch so the assertion is
  // about replay and not an unrelated random terminal hand.
  if (gameId === 'tien-len') f.manager.shuffle = cards => cards;
  f.start();
  assert.equal(f.room.stake, 50);
  const matchId = f.room.matchId;
  if (gameId === 'tien-len') f.manager.finish(f.room, f.room.players[0], 'fixture');
  else if (gameId === 'sam-loc') f.manager.finishNormal(f.room, f.room.players[0], null, 'fixture');
  else { f.room.players.forEach((p, i) => { p.score = i * 10; }); f.manager.finishRound(f.room, null, 'fixture'); }
  assert.equal(f.room.phase, 'RESULT');
  const receipt = crypto.randomUUID();
  f.gm.gameAction(f.clients[0], f.room.code, { action: 'play_again', actionId: receipt, expectedRevision: f.room.revision });
  assert.notEqual(f.room.phase, 'WAITING'); assert.notEqual(f.room.phase, 'RESULT'); assert.notEqual(f.room.matchId, matchId);
  const nextId = f.room.matchId;
  f.gm.gameAction(f.clients[0], f.room.code, { action: 'play_again', actionId: receipt, expectedRevision: f.room.revision });
  assert.equal(f.room.matchId, nextId); assert.equal(f.room.history.length, 1);
  assert.ok(f.room.players.every(player => player.hand.length > 0));
  assert.ok(f.room.players.every(player => f.gm.profiles.publicProfile(player.profileId).balances.chip.available === 1000));
});

for (const gameId of ['tien-len', 'sam-loc', 'phom', 'poker', 'uno', 'bang']) test(`${gameId}: authoritative 30s clock advances a legal turn and pauses on disconnect`, t => {
  const f = fixture(t, gameId, gameId === 'bang' ? 4 : 2); f.start();
  const actorId = f.room.turnClock?.playerId;
  assert.ok(actorId, gameId);
  const actor = f.room.players.find(player => player.id === actorId);
  const socket = f.clients.find(client => client.id === actor.socketId);
  const before = f.room.revision;
  f.room.turnClock.deadlineAt = Date.now() - 1;
  assert.equal(f.manager.turnClock.expire(f.room), true);
  assert.ok(f.room.revision > before);
  if (f.room.phase !== 'RESULT') assert.ok(f.room.turnClock?.deadlineAt > Date.now());
  // The timeout never wagers beyond a wallet/stack or copies another hand.
  if (gameId === 'poker') assert.equal(f.room.phase, 'RESULT');
  if (f.room.phase !== 'RESULT') {
    f.manager.handleDisconnect(socket);
    assert.equal(f.room.turnClock.deadlineAt, null);
    const remaining = f.room.turnClock.remainingMs;
    f.manager.turnClock.refresh(f.room, Date.now() + 60000);
    assert.equal(f.room.turnClock.remainingMs, remaining);
    assert.equal(f.manager.turnClock.expire(f.room, Date.now() + 60000), false);
  }
});

test('Phỏm timeout preserves the phỏm required by an eaten card', t => {
  const f = fixture(t, 'phom'); f.start();
  const player = f.room.players.find(p => p.id === f.room.currentPlayerId);
  const deck = require('../src/games/phom/phomDeck').createPhomDeck();
  player.hand = ['3H', '3D', '3S', 'KH'].map(id => deck.find(card => card.id === id));
  player.eatenCardIds = ['3H']; f.room.phase = 'DISCARD'; f.room.finishAfterDiscard = false;
  f.manager.turnClock.refresh(f.room); f.room.turnClock.deadlineAt = Date.now() - 1;
  f.manager.turnClock.expire(f.room);
  assert.deepEqual(player.hand.map(card => card.id), ['3H', '3D', '3S']);
  assert.equal(f.room.discardPile.at(-1).card.id, 'KH');
});

test('failed rematch leaves the paid result visible and never partially reserves coins', t => {
  const f = fixture(t); f.start(); f.manager.finish(f.room, f.room.players[0], 'fixture');
  const profileId = f.room.players[0].profileId;
  f.gm.profiles.reserveMany({ reservations: [{ profileId, amount: f.gm.profiles.publicProfile(profileId).balances.coin.available }], currency: 'coin', operationKey: 'fixture:unavailable', roomCode: 'TEST', matchId: 'fixture' });
  const before = f.gm.profiles.publicProfile(f.room.players[1].profileId).balances.coin;
  const matchId = f.room.matchId; f.act(0, 'play_again');
  assert.equal(f.room.phase, 'RESULT'); assert.equal(f.room.matchId, matchId);
  assert.deepEqual(f.gm.profiles.publicProfile(f.room.players[1].profileId).balances.coin, before);
});

test('UNO 112 uses the same 30s deadline, automatic draw/pass, and disconnect pause', t => {
  const f = fixture(t, 'uno', 2, { variant: 'classic-local-v1' }); f.start();
  const before = f.room.uno.revision;
  assert.equal(f.room.turnClock.durationMs, 30000);
  f.room.turnClock.deadlineAt = Date.now() - 1;
  assert.equal(f.manager.turnClock.expire(f.room), true);
  assert.ok(f.room.uno.revision > before);
  assert.ok(f.room.turnClock.deadlineAt > Date.now());
  f.manager.handleDisconnect(f.clients[0]);
  assert.equal(f.room.turnClock.deadlineAt, null);
  assert.equal(f.manager.turnClock.expire(f.room), false);
});
