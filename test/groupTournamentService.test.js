'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTemporaryDirectory, removeTemporaryDirectory } = require('../scripts/helpers/temporary-directory');
const { ProfileStore } = require('../src/platform/profileStore');
const { GroupTournamentService } = require('../src/platform/groupTournamentService');

const tempRoot = createTemporaryDirectory('tournament-service');
let fixtureNumber = 0;
const stores = [];
test.after(() => {
  for (const store of stores) { try { store.close(); } catch {} }
  removeTemporaryDirectory(tempRoot);
});

function setup({ memberIds = ['alice', 'bob'], hostId = 'alice' } = {}) {
  const directory = path.join(tempRoot, `case-${++fixtureNumber}`); fs.mkdirSync(directory, { recursive: true });
  const databaseFile = path.join(directory, 'store.sqlite');
  let store = new ProfileStore({ databaseFile });
  stores.push(store);
  const profiles = new Map();
  for (const [index, profileId] of memberIds.entries()) {
    const created = store.createProfile({ displayName: profileId[0].toUpperCase() + profileId.slice(1), avatar: '🎲' });
    profiles.set(profileId, { id: created.profile.id, token: created.sessionToken, name: profileId[0].toUpperCase() + profileId.slice(1), joinOrder: index });
  }
  let members = memberIds.map(profileId => ({ profileId: profiles.get(profileId).id, displayName: profiles.get(profileId).name, joinOrder: profiles.get(profileId).joinOrder }));
  let currentTargetRoomCode = null, currentRoomBinding = null;
  const groupId = 'group-123';
  const groupSnapshot = requested => requested === groupId ? { groupId, name: 'Bàn cuối tuần', hostProfileId: profiles.get(hostId)?.id,
    participantProfileIds: members.map(member => member.profileId), members, currentTargetRoomCode, roomBinding: currentRoomBinding } : null;
  const service = new GroupTournamentService({ profileStore: store, getTrustedGroupSnapshot: groupSnapshot });
  const actor = id => profiles.get(id).id;
  const setupTournament = async ({ gameId = 'uno', variant = 'classic-108-v1', rounds = 1, name = 'Test Cup' } = {}) => {
    const created = await service.create({ groupId, actorProfileId: actor(hostId), name, gameId, variant, rounds });
    await service.start({ groupId, tournamentId: created.tournamentId, actorProfileId: actor(hostId) });
    return created.tournamentId;
  };
  const bindMatch = ({ roomCode = `R${fixtureNumber}A`, gameId = 'uno', variant = 'classic-108-v1', matchId = `match-${fixtureNumber}`, phase = 'WAITING', terminalStatus = null, participantIds = memberIds } = {}) => {
    const participantProfileIds = participantIds.map(actor);
    currentTargetRoomCode = roomCode;
    currentRoomBinding = { roomCode, gameId, variant, matchId, participants: participantProfileIds, phase, terminalStatus };
    return { roomCode, gameId, variant, matchId, participantProfileIds };
  };
  const register = data => service.registerRoomMatch({ groupId, roomCode: data.roomCode, gameId: data.gameId, variant: data.variant, matchId: data.matchId });
  const commitMatch = ({ data, result, outcomes, variant = data.variant, includeRoom = true, participantIds } = {}) => {
    const players = memberIds.map((profileId, index) => ({ id: `seat-${index + 1}`, profileId: actor(profileId), name: profiles.get(profileId).name }));
    if (!includeRoom) throw new Error('fixture requires room authority for committed matches');
    store.syncRoom({ gameId: data.gameId, room: { code: data.roomCode, gameId: data.gameId, phase: 'RESULT', matchId: data.matchId, variant, players } });
    const persistedPlayers = participantIds ? participantIds.map((profileId, index) => ({ profileId: actor(profileId), outcome: outcomes?.[index] ?? null }))
      : players.map((player, index) => ({ profileId: player.profileId, outcome: outcomes?.[index] ?? null }));
    store.recordCompletedMatch({ matchId: data.matchId, gameId: data.gameId, roomCode: data.roomCode, players: persistedPlayers, result });
  };
  const reconcile = data => service.reconcileCommittedMatch({ groupId, gameId: data.gameId, variant: data.variant, matchId: data.matchId });
  return { get store() { return store; }, set store(next) { store = next; }, profiles, actor, groupId, service, get members() { return members; }, set members(value) { members = value; }, get currentTargetRoomCode() { return currentTargetRoomCode; }, get currentRoomBinding() { return currentRoomBinding; }, set currentRoomBinding(value) { currentRoomBinding = value; }, setupTournament, bindMatch, register, commitMatch, reconcile };
}
function sameSet(a, b) { return a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]); }

test('uses one ProfileStore DB, locks a stable roster, and awards committed UNO108 points once across service restart', async () => {
  const f = setup();
  const ledgerBefore = f.store.db.prepare('SELECT COUNT(*) AS count FROM wallet_ledger').get().count;
  const tournamentId = await f.setupTournament();
  assert.equal(f.service.membershipLocked(f.groupId), true);
  const data = f.bindMatch();
  const registered = await f.register(data);
  assert.equal(registered.round, 1);
  f.commitMatch({ data, result: { winnerProfileId: f.actor('alice'), durationMs: 42 }, outcomes: ['WIN', 'LOSS'] });
  const first = await f.reconcile(data);
  assert.equal(first.applied, true);
  assert.equal(first.tournament.status, 'COMPLETED');
  assert.equal((await f.reconcile(data)).applied, false);
  f.store.close();
  f.store = new ProfileStore({ databaseFile: path.join(tempRoot, `case-${fixtureNumber}`, 'store.sqlite') }); stores.push(f.store);
  f.service = new GroupTournamentService({ profileStore: f.store, getTrustedGroupSnapshot: () => null });
  assert.equal((await f.service.reconcileCommittedMatch({ groupId: f.groupId, gameId: data.gameId, variant: data.variant, matchId: data.matchId })).applied, false);
  const detail = await f.service.detail({ groupId: f.groupId, tournamentId, actorProfileId: f.actor('alice') });
  assert.deepEqual(detail.standings.map(row => [row.rank, row.name, row.points]), [[1, 'Alice', 3], [2, 'Bob', 0]]);
  assert.equal(detail.rounds[0].matchId, data.matchId);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM wallet_ledger').get().count, ledgerBefore);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM group_tournament_records').get().count, 2);
});

test('lets live group members open an empty rankings page before the first tournament exists', async () => {
  const f = setup();
  const initial = await f.service.list({ groupId: f.groupId, actorProfileId: f.actor('alice') });
  assert.deepEqual(initial.tournaments, []);
  assert.equal(initial.canManage, true);
  const memberView = await f.service.list({ groupId: f.groupId, actorProfileId: f.actor('bob') });
  assert.deepEqual(memberView.tournaments, []);
  assert.equal(memberView.canManage, false);
});

test('rejects stale group roster and room binding before registering any score association', async () => {
  const f = setup();
  await f.setupTournament();
  const data = f.bindMatch();
  f.members = [f.members[0]];
  await assert.rejects(f.register(data), { code: 'MATCH_GROUP_MEMBERS_CHANGED' });
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM group_tournament_records WHERE record_type = 'match'").get().count, 0);
});

test('requires host for create/start/close and allows only one open tournament per group', async () => {
  const f = setup();
  await assert.rejects(f.service.create({ groupId: f.groupId, actorProfileId: f.actor('bob'), name: 'No', gameId: 'uno', variant: 'classic-108-v1', rounds: 1 }), { code: 'GROUP_HOST_REQUIRED' });
  const tournamentId = await f.setupTournament();
  await assert.rejects(f.service.create({ groupId: f.groupId, actorProfileId: f.actor('alice'), name: 'Duplicate', gameId: 'uno', variant: 'classic-108-v1', rounds: 2 }), { code: 'TOURNAMENT_ALREADY_ACTIVE' });
  const binding = f.bindMatch(); await f.register(binding);
  await assert.rejects(f.service.close({ groupId: f.groupId, tournamentId, actorProfileId: f.actor('alice') }), { code: 'TOURNAMENT_MATCH_ACTIVE' });
  await assert.rejects(f.service.close({ groupId: f.groupId, tournamentId, actorProfileId: f.actor('bob') }), { code: 'GROUP_HOST_REQUIRED' });
});

test('rejects browser-supplied or uncommitted results and mismatched committed participants', async () => {
  const f = setup(); await f.setupTournament(); const data = f.bindMatch(); await f.register(data);
  await assert.rejects(f.reconcile(data), { code: 'MATCH_NOT_COMPLETED' });
  f.commitMatch({ data, result: { winnerProfileId: f.actor('alice') }, outcomes: ['WIN'], participantIds: ['alice'] });
  await assert.rejects(f.reconcile(data), { code: 'MATCH_PARTICIPANTS_MISMATCH' });
  const row = f.store.db.prepare("SELECT record_id, payload_json FROM group_tournament_records WHERE record_type = 'tournament'").get();
  assert.equal(JSON.parse(row.payload_json).totals[f.actor('alice')].points, 0);
});

test('both UNO variants require a matching server snapshot and score without reading client results', async () => {
  for (const variant of ['classic-local-v1', 'classic-108-v1']) {
    const f = setup(); await f.setupTournament({ variant });
    const data = f.bindMatch({ variant }); await f.register(data);
    const result = variant === 'classic-local-v1' ? { winnerId: 'seat-1' } : { winnerProfileId: f.actor('alice') };
    f.commitMatch({ data, result, outcomes: variant === 'classic-local-v1' ? [null, null] : ['WIN', 'LOSS'], variant });
    const applied = await f.reconcile(data);
    assert.equal(applied.applied, true, variant);
    assert.equal(applied.tournament.standings[0].points, 3, variant);
  }
});

test('ties share rank and use a stable, non-random display order', async () => {
  const f = setup(); await f.setupTournament({ gameId: 'poker', variant: 'standard' });
  const data = f.bindMatch({ gameId: 'poker', variant: 'standard' }); await f.register(data);
  f.commitMatch({ data, result: { handId: 'server-hand' }, outcomes: ['TIE', 'TIE'] });
  const detail = (await f.reconcile(data)).tournament;
  assert.deepEqual(detail.standings.map(row => [row.rank, row.points, row.ties]), [[1, 1, 1], [1, 1, 1]]);
  assert.deepEqual(detail.standings.map(row => row.name), ['Alice', 'Bob']);
});

test('The Gang uses shared cooperative success points; failure gives zero', async () => {
  const f = setup(); await f.setupTournament({ gameId: 'the-gang', variant: 'standard' });
  const data = f.bindMatch({ gameId: 'the-gang', variant: 'standard' }); await f.register(data);
  f.commitMatch({ data, result: { won: true, mode: 'ADVANCED' }, outcomes: [null, null] });
  const detail = (await f.reconcile(data)).tournament;
  assert.deepEqual(detail.standings.map(row => row.points), [2, 2]);
});

test('cancel and forfeit resolve rounds with no score and finish a finite tournament', async () => {
  const cancelled = setup(); await cancelled.setupTournament({ rounds: 1 });
  const cancelData = cancelled.bindMatch({ roomCode: 'CANCEL1' }); await cancelled.register(cancelData);
  cancelled.currentRoomBinding = { ...cancelled.currentRoomBinding, phase: 'CANCELLED', terminalStatus: 'CANCELLED' };
  const noScore = await cancelled.service.cancelCurrentRound({ groupId: cancelled.groupId, roomCode: cancelData.roomCode, gameId: cancelData.gameId, variant: cancelData.variant, matchId: cancelData.matchId });
  assert.equal(noScore.tournament.status, 'COMPLETED');
  assert.equal(noScore.tournament.standings.reduce((sum, row) => sum + row.points, 0), 0);

  const forfeited = setup(); await forfeited.setupTournament({ rounds: 1 });
  const forfeitData = forfeited.bindMatch({ roomCode: 'FORFEIT1' }); await forfeited.register(forfeitData);
  forfeited.commitMatch({ data: forfeitData, result: { kind: 'FORFEIT', forfeitedProfileIds: [forfeited.actor('bob')] }, outcomes: ['WIN', 'FORFEIT'] });
  const forfeitResult = await forfeited.reconcile(forfeitData);
  assert.equal(forfeitResult.status, 'NO_SCORE');
  assert.deepEqual(forfeitResult.tournament.standings.map(row => row.points), [0, 0]);
});

test('concurrent duplicate registration and result delivery produce one association and one score', async () => {
  const f = setup(); await f.setupTournament({ rounds: 2 }); const data = f.bindMatch();
  const registrations = await Promise.allSettled([Promise.resolve().then(() => f.register(data)), Promise.resolve().then(() => f.register(data))]);
  assert.equal(registrations.filter(item => item.status === 'fulfilled').length, 2);
  assert.equal(registrations.filter(item => item.status === 'fulfilled' && item.value.duplicate).length, 1);
  f.commitMatch({ data, result: { winnerProfileId: f.actor('alice') }, outcomes: ['WIN', 'LOSS'] });
  const results = await Promise.all([Promise.resolve().then(() => f.reconcile(data)), Promise.resolve().then(() => f.reconcile(data))]);
  assert.equal(results.filter(item => item.applied).length, 1);
  assert.equal((await f.service.detail({ groupId: f.groupId, tournamentId: results[0].tournament.tournamentId, actorProfileId: f.actor('alice') })).standings[0].points, 3);
});

test('score rules do not depend on stake or add ledger, currency, grant, or exchange rows', async () => {
  const f = setup(); const before = f.store.db.prepare('SELECT COUNT(*) AS count FROM wallet_ledger').get().count;
  await f.setupTournament(); const data = f.bindMatch(); await f.register(data);
  f.commitMatch({ data, result: { winnerProfileId: f.actor('alice'), stake: 999999999, profit: 999999999 }, outcomes: ['WIN', 'LOSS'] });
  await f.reconcile(data);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM wallet_ledger').get().count, before);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM wallet_operations WHERE kind IN (\'coin_bootstrap\', \'currency_exchange\', \'mission_claim\')').get().count, 0);
});

test('a corrupted completion snapshot is rejected without advancing the tournament', async () => {
  const f = setup(); const tournamentId = await f.setupTournament(); const data = f.bindMatch(); await f.register(data);
  f.commitMatch({ data, result: { winnerProfileId: f.actor('alice') }, outcomes: ['WIN', 'LOSS'] });
  const snapshot = f.store.db.prepare('SELECT id, snapshot_json FROM match_snapshots WHERE match_id = ?').get(data.matchId);
  const json = JSON.parse(snapshot.snapshot_json); json.result = { winnerProfileId: f.actor('bob') };
  f.store.db.prepare('UPDATE match_snapshots SET snapshot_json = ? WHERE id = ?').run(JSON.stringify(json), snapshot.id);
  await assert.rejects(f.reconcile(data), { code: 'MATCH_PROOF_MISMATCH' });
  const detail = await f.service.detail({ groupId: f.groupId, tournamentId, actorProfileId: f.actor('alice') });
  assert.equal(detail.currentRoundStatus, 'PLAYING');
  assert.deepEqual(detail.standings.map(row => row.points), [0, 0]);
});
