'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');

for (const [gameId, variant, cancellation] of [
  ['the-gang', 'standard', 'returnToLobby'],
  ['uno', 'classic-local-v1', 'leaveRoom'],
]) {
  test(`production tournament resolves ${gameId}/${variant} cancellation without awarding points`, { timeout: 15000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-tournament-cancel-'));
    const game = createGameServer({ databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json') });
    const clients = [];
    t.after(async () => {
      clients.forEach(client => client.disconnect());
      await game.close();
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${game.server.address().port}`, members = [];
    for (let index = 0; index < 3; index++) {
      const profile = game.gm.profiles.createProfile({ displayName: `Cancel player ${index}` });
      const client = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { profileToken: profile.sessionToken } });
      clients.push(client);
      await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
      members.push({ id: profile.profile.id, name: profile.profile.displayName, avatar: '🎲', client });
    }
    const groups = game.groupLobbyService, tournaments = game.groupTournaments.service, store = game.gm.profiles;
    const group = await groups.createGroup(members[0]), groupId = group.groupId;
    members[0].capability = group.groupCapability;
    for (const member of members.slice(1)) member.capability = (await groups.joinGroup(member, group.inviteCapability)).groupCapability;
    const tournament = await tournaments.create({ groupId, actorProfileId: members[0].id, name: 'Cancellation cup', gameId, variant, rounds: 1 });
    await tournaments.start({ groupId, tournamentId: tournament.tournamentId, actorProfileId: members[0].id });
    const proposal = await groups.propose(members[0], groupId, members[0].capability, { gameId, variant, config: { maxPlayers: 4 } });
    for (const member of members) await groups.confirm(member, groupId, member.capability,
      { proposalId: proposal.proposal.id, proposalRevision: proposal.proposal.revision });
    await groups.switchGroup(members[0], groupId, members[0].capability);
    let room;
    for (const member of members) {
      const handoff = await groups.handoff(member, groupId, member.capability);
      const resumed = await new Promise((resolve, reject) => member.client.timeout(3000).emit('room:resume',
        { roomCode: handoff.roomCode, sessionToken: handoff.sessionToken }, (error, result) => error ? reject(error) : resolve(result)));
      assert.equal(resumed.error, undefined);
      room = game.gm.managerForCode(handoff.roomCode).rooms.get(handoff.roomCode);
      game.gm.setReady(game.io.sockets.sockets.get(member.client.id), room.code, true);
    }
    const financialCounts = () => ['wallet_ledger', 'wallet_operations', 'reservations']
      .map(table => store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count);
    const before = financialCounts(), host = game.io.sockets.sockets.get(members[0].client.id);
    await game.gm.startGame(host, room.code);
    assert.notEqual(room.phase, 'WAITING');
    const matchId = room.matchId;
    assert.equal(store.db.prepare("SELECT status FROM group_tournament_records WHERE record_type='match' AND match_id=?").get(matchId).status, 'REGISTERED');
    if (cancellation === 'returnToLobby') {
      // A rejected guest operation must leave the live association intact.
      await game.gm.gangAction('returnToLobby', game.io.sockets.sockets.get(members[1].client.id), room.code);
      assert.equal(store.db.prepare("SELECT status FROM group_tournament_records WHERE record_type='match' AND match_id=?").get(matchId).status, 'REGISTERED');
      await game.gm.gangAction('returnToLobby', host, room.code);
      assert.equal(room.matchId, matchId, 'Gang keeps its old match id when resetting; cancellation still resolves');
    } else {
      await game.gm.leaveRoom(game.io.sockets.sockets.get(members[1].client.id), room.code);
      assert.notEqual(room.matchId, matchId, 'UNO112 cancellation changes the manager match id');
    }
    assert.equal(room.phase, 'WAITING');
    const detail = await tournaments.detail({ groupId, tournamentId: tournament.tournamentId, actorProfileId: members[0].id });
    assert.equal(detail.status, 'COMPLETED');
    assert.equal(detail.rounds[0].status, 'CANCELLED');
    assert.equal(detail.completedRounds, 0);
    assert.ok(detail.standings.every(row => row.points === 0));
    assert.equal(tournaments.membershipLocked(groupId), false);
    await game.groupTournaments.lifecycle.reconcilePending();
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM group_tournament_records WHERE record_type='match' AND match_id=?").get(matchId).count, 1);
    assert.deepEqual(financialCounts(), before);
    assert.deepEqual(game.groupTournaments.errors, []);
  });
}
