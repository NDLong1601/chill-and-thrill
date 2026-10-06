'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');
const { createDeck } = require('../src/games/uno/engine');

test('production UNO112 socket next round automatically links and scores two group rounds once', { timeout: 15000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-tournament-uno112-'));
  const game = createGameServer({ databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json') });
  const clients = [];
  t.after(async () => {
    clients.forEach(client => client.disconnect()); await game.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${game.server.address().port}`, members = [];
  for (let index = 0; index < 2; index++) {
    const created = game.gm.profiles.createProfile({ displayName: `UNO112 player ${index}` });
    const client = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { profileToken: created.sessionToken } });
    clients.push(client);
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    members.push({ id: created.profile.id, name: created.profile.displayName, avatar: '🎲', client });
  }
  const request = (client, event, payload) => new Promise((resolve, reject) => client.timeout(4000).emit(event, payload,
    (error, result) => error ? reject(error) : resolve(result)));
  const groups = game.groupLobbyService, tournaments = game.groupTournaments.service, store = game.gm.profiles;
  const created = await groups.createGroup(members[0]), groupId = created.groupId;
  members[0].capability = created.groupCapability;
  members[1].capability = (await groups.joinGroup(members[1], created.inviteCapability)).groupCapability;
  const tournament = await tournaments.create({ groupId, actorProfileId: members[0].id, name: 'UNO112 socket cup', gameId: 'uno', variant: 'classic-local-v1', rounds: 2 });
  await tournaments.start({ groupId, tournamentId: tournament.tournamentId, actorProfileId: members[0].id });
  const proposal = await groups.propose(members[0], groupId, members[0].capability,
    { gameId: 'uno', variant: 'classic-local-v1', config: { maxPlayers: 4 } });
  for (const member of members) await groups.confirm(member, groupId, member.capability,
    { proposalId: proposal.proposal.id, proposalRevision: proposal.proposal.revision });
  await groups.switchGroup(members[0], groupId, members[0].capability);
  let room;
  for (const member of members) {
    const handoff = await groups.handoff(member, groupId, member.capability);
    assert.equal((await request(member.client, 'room:resume', { roomCode: handoff.roomCode, sessionToken: handoff.sessionToken })).error, undefined);
    room = game.gm.gang.rooms.get(handoff.roomCode);
    game.gm.setReady(game.io.sockets.sockets.get(member.client.id), room.code, true);
  }
  const financialCounts = () => ['wallet_ledger', 'wallet_operations', 'reservations']
    .map(table => store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
  const before = financialCounts();
  await game.gm.startGame(game.io.sockets.sockets.get(members[0].client.id), room.code);
  const matchIds = [];
  for (let round = 1; round <= 2; round++) {
    if (round > 1) {
      const next = await request(members[0].client, 'game:action', { roomCode: room.code, matchId: room.uno.matchId,
        expectedRevision: room.uno.revision, actionId: 'uno112-next-round', type: 'start_next_round', payload: {} });
      assert.equal(next.ok, true, JSON.stringify(next.error));
    }
    const match = room.uno, seatId = room.players.find(player => player.profileId === members[0].id).id;
    matchIds.push(match.matchId);
    assert.equal(room.phase, 'PLAYING');
    assert.equal(store.db.prepare("SELECT status FROM group_tournament_records WHERE record_type='match' AND match_id=?").get(match.matchId).status, 'REGISTERED');
    // Shorten an actual match to a legal terminal play; the client envelope,
    // validator, receipt, completion transaction and scoring remain real.
    const deck = createDeck(), card = deck.find(item => item.color === 'red' && item.type === 'number' && item.value === 5);
    const top = deck.find(item => item.color === 'red' && item.type === 'number' && item.value === 3);
    match.hands[seatId] = [card]; match.discardPile = [top]; match.currentColor = 'red';
    match.currentPlayerId = seatId; match.openingColorPending = false; match.pendingDraw = 0; match.pendingTargetId = null;
    match.reactionWindow = null; match.unoWindow = null; match.drawChoice = null; room.turnClock = null;
    const envelope = { roomCode: room.code, matchId: match.matchId, expectedRevision: match.revision,
      actionId: `uno112-final-${round}`, type: 'play_card', payload: { cardId: card.id } };
    assert.equal((await request(members[0].client, 'game:action', envelope)).ok, true);
    assert.equal(room.phase, 'RESULT');
    await Promise.resolve(); await game.groupTournaments.lifecycle.drain();
    const replay = await request(members[0].client, 'game:action', envelope);
    assert.equal(replay.ok, false);
    const detail = await tournaments.detail({ groupId, tournamentId: tournament.tournamentId, actorProfileId: members[0].id });
    assert.equal(detail.completedRounds, round);
    assert.equal(detail.standings[0].points, 3 * round);
  }
  assert.equal(new Set(matchIds).size, 2);
  assert.equal((await tournaments.detail({ groupId, tournamentId: tournament.tournamentId, actorProfileId: members[0].id })).status, 'COMPLETED');
  assert.deepEqual(financialCounts(), before);
  assert.deepEqual(game.groupTournaments.errors, []);
});
