'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { createTemporaryDirectory, removeTemporaryDirectory } = require('../scripts/helpers/temporary-directory');
const { ProfileStore } = require('../src/platform/profileStore');
const { GroupTournamentService } = require('../src/platform/groupTournamentService');
const { createGroupTournamentLifecycle } = require('../src/platform/groupTournamentLifecycle');
const { TienLenManager } = require('../src/games/tien-len/tienLenEngine');
const { createTienLenDeck } = require('../public/js/tien-len-rules');

const GROUP_ID = 'lifecycle-group';

function fakeIo() {
  const sockets = new Map();
  return { sockets: { sockets }, to: () => ({ emit() {} }) };
}

function socket(id, profile) {
  return { id, profile, events: [], join() {}, leave() {}, emit(event, payload) { this.events.push({ event, payload }); } };
}

function playAgain(manager, socket, roomCode, room) {
  return manager.action(socket, roomCode, { action: 'play_again', actionId: crypto.randomUUID(), expectedRevision: room.revision });
}

function makeFixture(t, { shuffle = cards => [...cards], notifyLifecycle = true } = {}) {
  const directory = createTemporaryDirectory('tournament-lifecycle');
  const databaseFile = path.join(directory, 'profiles.sqlite');
  const storageFile = path.join(directory, 'tien-len.json');
  let store = new ProfileStore({ databaseFile });
  const stores = [store];
  const profiles = ['alice', 'bob'].map(name => store.createProfile({ displayName: name, avatar: '🎲' }).profile);
  const sockets = profiles.map((profile, index) => socket(`player-${index}`, profile));
  const io = fakeIo(); sockets.forEach(item => io.sockets.sockets.set(item.id, item));
  let manager = null;
  let service, lifecycle;
  const groupSnapshot = async requestedGroupId => {
    if (requestedGroupId !== GROUP_ID) return null;
    const room = manager?.rooms.get(roomCode);
    const binding = room ? { roomCode: room.code, gameId: 'tien-len', variant: 'standard',
      matchId: room.matchId || null, participants: room.players.map(player => player.profileId), phase: room.phase,
      terminalStatus: room.phase === 'RESULT' ? 'RESULT' : null } : null;
    return { groupId: GROUP_ID, name: 'Nhóm kiểm tra', hostProfileId: profiles[0].id,
      participantProfileIds: profiles.map(profile => profile.id), members: profiles.map((profile, joinOrder) => ({ profileId: profile.id,
        displayName: profile.displayName, joinOrder })), currentTargetRoomCode: roomCode || null, roomBinding: binding };
  };
  service = new GroupTournamentService({ profileStore: store, getTrustedGroupSnapshot: groupSnapshot });
  lifecycle = createGroupTournamentLifecycle({ tournamentService: service, getRoom: code => manager?.rooms.get(code) || null, onError() {} });
  const constructManager = activeStore => new TienLenManager(io, { profileStore: activeStore, storageFile, profileForSocket: item => item.profile,
    shuffle, onMatchCompleted: match => {
      const saved = activeStore.recordCompletedMatch(match);
      if (notifyLifecycle && saved.recorded) lifecycle.onMatchCommitted(match);
      return saved;
    } });
  manager = constructManager(store);
  const created = manager.createRoom(sockets[0], 'Alice', '🎲', { stake: 100 });
  const joined = manager.joinRoom(sockets[1], created.roomCode, 'Bob', '🎲');
  assert.equal(created.error, undefined); assert.equal(joined.error, undefined);
  let roomCode = created.roomCode;
  let room = manager.rooms.get(roomCode);
  store.syncRoom({ gameId: 'tien-len', room });
  const setReady = (hostReady = true, guestReady = true) => {
    manager.setReady(sockets[0], roomCode, hostReady); manager.setReady(sockets[1], roomCode, guestReady);
    store.syncRoom({ gameId: 'tien-len', room });
  };
  const createTournament = async (rounds = 1) => {
    const createdTournament = await service.create({ groupId: GROUP_ID, actorProfileId: profiles[0].id,
      name: 'Vòng đời', gameId: 'tien-len', variant: 'standard', rounds });
    await service.start({ groupId: GROUP_ID, tournamentId: createdTournament.tournamentId, actorProfileId: profiles[0].id });
    return createdTournament.tournamentId;
  };
  t.after(() => {
    try { manager?.close(); } catch {}
    for (const currentStore of stores) { try { currentStore.close(); } catch {} }
    removeTemporaryDirectory(directory);
  });
  return {
    directory, databaseFile, storageFile, profiles, sockets, io,
    get store() { return store; }, set store(value) { store = value; stores.push(value); },
    get manager() { return manager; }, set manager(value) { manager = value; },
    get service() { return service; }, set service(value) { service = value; },
    get lifecycle() { return lifecycle; }, set lifecycle(value) { lifecycle = value; },
    get room() { return manager.rooms.get(roomCode); }, roomCode, setReady, createTournament, constructManager,
  };
}

test('persists before a real engine start, links the new match id, and auto-scores the next round', async t => {
  const f = makeFixture(t);
  const tournamentId = await f.createTournament(2);
  f.setReady();
  const firstBefore = f.room.matchId;
  await f.lifecycle.aroundStart({ groupId: GROUP_ID, room: f.room, gameId: 'tien-len', variant: 'standard',
    start: () => f.manager.startGame(f.sockets[0], f.roomCode) });
  const firstMatchId = f.room.matchId;
  assert.notEqual(firstMatchId, firstBefore);
  assert.equal(f.service.detail ? (await f.service.detail({ groupId: GROUP_ID, tournamentId, actorProfileId: f.profiles[0].id })).currentRoundStatus : null, 'PLAYING');

  f.manager.finish(f.room, f.room.players[0], 'lifecycle test result');
  await f.lifecycle.drain();
  let detail = await f.service.detail({ groupId: GROUP_ID, tournamentId, actorProfileId: f.profiles[0].id });
  assert.equal(detail.currentRound, 2);
  assert.equal(detail.currentRoundStatus, 'READY');
  assert.equal(detail.standings[0].points, 3);

  const terminalMatchId = f.room.matchId;
  const replay = await f.lifecycle.aroundStart({ groupId: GROUP_ID, room: f.room, gameId: 'tien-len', variant: 'standard',
    start: () => playAgain(f.manager, f.sockets[0], f.roomCode, f.room) });
  assert.equal(replay?.error, undefined, replay?.error);
  const secondMatchId = f.room.matchId;
  assert.notEqual(secondMatchId, terminalMatchId);
  assert.equal(f.room.phase, 'TURN');
  const secondAssociation = f.store.db.prepare("SELECT payload_json FROM group_tournament_records WHERE record_type = 'match' AND status = 'REGISTERED' AND match_id = ?").get(secondMatchId);
  assert.ok(secondAssociation);
  assert.equal(JSON.parse(secondAssociation.payload_json).roomRulesVersion, 'south-v1');
  f.manager.finish(f.room, f.room.players[1], 'lifecycle second result');
  await f.lifecycle.drain();

  detail = await f.service.detail({ groupId: GROUP_ID, tournamentId, actorProfileId: f.profiles[0].id });
  assert.equal(detail.status, 'COMPLETED');
  assert.deepEqual(detail.standings.map(row => row.points), [3, 3]);
  assert.deepEqual(detail.rounds.map(round => round.matchId), [firstMatchId, secondMatchId]);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM match_players WHERE match_id IN (?, ?)').get(firstMatchId, secondMatchId).count, 4);
});

test('captures a white-win completion that commits inside startGame before the post-start hook', async t => {
  const whiteWinShuffle = cards => {
    const twos = cards.filter(card => card.rank === '2');
    return [...twos, ...cards.filter(card => card.rank !== '2')];
  };
  const f = makeFixture(t, { shuffle: whiteWinShuffle });
  const tournamentId = await f.createTournament(1);
  f.setReady();
  const start = await f.lifecycle.aroundStart({ groupId: GROUP_ID, room: f.room, gameId: 'tien-len', variant: 'standard',
    start: () => f.manager.startGame(f.sockets[0], f.roomCode) });
  await f.lifecycle.drain();
  assert.equal(start?.error, undefined);
  assert.equal(f.room.phase, 'RESULT');
  const matchId = f.room.matchId;
  assert.equal(f.store.db.prepare("SELECT status FROM matches WHERE match_id = ?").get(matchId).status, 'COMPLETED');
  const association = f.store.db.prepare('SELECT status FROM group_tournament_records WHERE record_type = \'match\' AND match_id = ?').get(matchId);
  assert.equal(association.status, 'SCORED');
  const detail = await f.service.detail({ groupId: GROUP_ID, tournamentId, actorProfileId: f.profiles[0].id });
  assert.equal(detail.status, 'COMPLETED');
  assert.equal(detail.standings[0].points, 3);
  assert.equal(detail.rounds[0].matchId, matchId);
});

test('resets a denied manager start intent and captures same-id room resets as server cancellations', async t => {
  const f = makeFixture(t);
  const tournamentId = await f.createTournament(1);
  f.setReady(true, false);
  const declined = await f.lifecycle.aroundStart({ groupId: GROUP_ID, room: f.room, gameId: 'tien-len', variant: 'standard',
    start: () => f.manager.startGame(f.sockets[0], f.roomCode) });
  assert.ok(declined.error);
  let detail = await f.service.detail({ groupId: GROUP_ID, tournamentId, actorProfileId: f.profiles[0].id });
  assert.equal(detail.currentRoundStatus, 'READY');
  assert.equal(f.store.db.prepare("SELECT status FROM group_tournament_records WHERE status = 'FAILED'").get().status, 'FAILED');

  f.setReady();
  await f.lifecycle.aroundStart({ groupId: GROUP_ID, room: f.room, gameId: 'tien-len', variant: 'standard',
    start: () => f.manager.startGame(f.sockets[0], f.roomCode) });
  const matchId = f.room.matchId;
  const result = await f.lifecycle.aroundCancellation({ groupId: GROUP_ID, room: f.room,
    cancel: () => { f.room.phase = 'WAITING'; return { ok: true }; } });
  assert.equal(result.tournamentCancellation.status, 'CANCELLED');
  assert.equal(f.store.db.prepare("SELECT status FROM group_tournament_records WHERE match_id = ?").get(matchId).status, 'CANCELLED');
  detail = await f.service.detail({ groupId: GROUP_ID, tournamentId, actorProfileId: f.profiles[0].id });
  assert.equal(detail.status, 'COMPLETED');
  assert.equal(detail.rounds[0].status, 'CANCELLED');
  assert.deepEqual(detail.standings.map(row => row.points), [0, 0]);
});

test('reconciles a committed engine result after room overwrite and service restart', async t => {
  const f = makeFixture(t, { notifyLifecycle: false });
  const tournamentId = await f.createTournament(1);
  f.setReady();
  await f.lifecycle.aroundStart({ groupId: GROUP_ID, room: f.room, gameId: 'tien-len', variant: 'standard',
    start: () => f.manager.startGame(f.sockets[0], f.roomCode) });
  const completedMatchId = f.room.matchId;
  f.manager.finish(f.room, f.room.players[0], 'committed before restart');
  playAgain(f.manager, f.sockets[0], f.roomCode, f.room);
  assert.notEqual(f.room.matchId, completedMatchId);
  assert.equal(f.room.phase, 'TURN');
  f.store.syncRoom({ gameId: 'tien-len', room: f.room });
  f.manager.close(); f.manager = null;
  f.store.close();

  f.store = new ProfileStore({ databaseFile: f.databaseFile });
  f.service = new GroupTournamentService({ profileStore: f.store, getTrustedGroupSnapshot: async () => null });
  f.lifecycle = createGroupTournamentLifecycle({ tournamentService: f.service,
    getRoom: code => f.manager?.rooms.get(code) || null, onError() {} });
  f.manager = f.constructManager(f.store);
  const recovered = await f.lifecycle.reconcilePending();
  assert.equal(recovered.reconciled, 1);
  assert.equal(f.store.db.prepare("SELECT status FROM group_tournament_records WHERE match_id = ?").get(completedMatchId).status, 'SCORED');
  const detail = await f.service.detail({ groupId: GROUP_ID, tournamentId, actorProfileId: f.profiles[0].id });
  assert.equal(detail.status, 'COMPLETED');
  assert.equal(detail.standings[0].points, 3);
  assert.equal(detail.rounds[0].matchId, completedMatchId);
});

test('R02 recovers a committed coin cancellation after restart without a live group or another refund', async t => {
  const f = makeFixture(t, { notifyLifecycle: false });
  const tournamentId = await f.createTournament(1);
  f.setReady();
  await f.lifecycle.aroundStart({ groupId: GROUP_ID, room: f.room, gameId: 'tien-len', variant: 'standard',
    start: () => f.manager.startGame(f.sockets[0], f.roomCode) });
  const matchId = f.room.matchId;
  assert.equal((await f.lifecycle.reconcilePending()).recovered, 0, 'an active wager has no cancellation proof');
  // Bypass the new hook to reproduce both old deployments and a crash after
  // the engine commits the refund, before the tournament callback is written.
  f.manager.action(f.sockets[0], f.roomCode, { action: 'cancel_before_first_play', actionId: crypto.randomUUID(), expectedRevision: f.room.revision });
  assert.equal(f.room.phase, 'WAITING');
  assert.equal(f.store.db.prepare("SELECT status FROM group_tournament_records WHERE match_id = ?").get(matchId).status, 'REGISTERED');
  const financialCounts = store => ['wallet_ledger', 'wallet_operations', 'reservations'].map(table =>
    store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
  const countsBeforeRestart = financialCounts(f.store);
  f.manager.close(); f.manager = null; f.store.close();
  f.store = new ProfileStore({ databaseFile: f.databaseFile });
  f.service = new GroupTournamentService({ profileStore: f.store, getTrustedGroupSnapshot: async () => null });
  f.lifecycle = createGroupTournamentLifecycle({ tournamentService: f.service, getRoom: () => null, onError() {} });
  const recovered = await f.lifecycle.reconcilePending();
  assert.equal(recovered.recovered, 1); assert.equal(recovered.pending, 0);
  const detail = await f.service.detail({ groupId: GROUP_ID, tournamentId, actorProfileId: f.profiles[0].id });
  assert.equal(detail.rounds[0].status, 'CANCELLED');
  assert.equal(detail.status, 'COMPLETED'); assert.ok(detail.standings.every(row => row.points === 0));
  assert.equal((await f.lifecycle.reconcilePending()).recovered, 0);
  assert.deepEqual(financialCounts(f.store), countsBeforeRestart);
  assert.deepEqual(f.profiles.map(p => f.store.publicProfile(p.id).balances.coin), [{ available: 1000, reserved: 0 }, { available: 1000, reserved: 0 }]);
});
