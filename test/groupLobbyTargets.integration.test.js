'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');

test('one group retains four profiles and private handoffs through all eight real game targets', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-group-targets-'));
  const game = createGameServer({ databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json') });
  const clients = [];
  t.after(async () => {
    clients.forEach(client => client.disconnect()); await game.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${game.server.address().port}`, service = game.groupLobbyService;
  const members = [];
  for (let index = 0; index < 4; index++) {
    const created = game.gm.profiles.createProfile({ displayName: `Group player ${index}` });
    const client = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { profileToken: created.sessionToken } });
    clients.push(client);
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    members.push({ id: created.profile.id, name: created.profile.displayName, avatar: '🎲', token: created.sessionToken, client });
  }
  const created = await service.createGroup(members[0]), groupId = created.groupId;
  members[0].capability = created.groupCapability;
  for (const member of members.slice(1)) member.capability = (await service.joinGroup(member, created.inviteCapability)).groupCapability;
  const balances = () => members.map(member => game.gm.profiles.publicProfile(member.id).balances);
  const initialBalances = balances();
  const initialLedger = game.gm.profiles.db.prepare('SELECT COUNT(*) AS count FROM wallet_ledger').get().count;
  const visited = new Set();
  for (const [gameId, variant] of [
    ['the-gang', 'standard'], ['uno', 'classic-local-v1'], ['uno', 'classic-108-v1'], ['tien-len', 'standard'],
    ['poker', 'standard'], ['sam-loc', 'standard'], ['phom', 'standard'], ['bang', 'standard'],
  ]) {
    await t.test(`${gameId}/${variant}`, async () => {
      if (visited.size) {
        // A real navigation destroys each game socket and creates a fresh
        // authenticated lobby socket, without resuming the previous game first.
        for (const member of members) member.client.disconnect();
        const previousCode = [...visited].at(-1);
        const previousRoom = game.gm.managerForCode(previousCode).rooms.get(previousCode);
        const deadline = Date.now() + 3000;
        while (previousRoom.players.some(player => player.connected)) {
          assert.ok(Date.now() < deadline, 'previous sockets must disconnect before navigating');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        for (const member of members) {
          const client = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { profileToken: member.token } });
          clients.push(client);
          await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
          member.client = client;
          await service.heartbeat(member, groupId, member.capability);
        }
      }
      const proposal = await service.propose(members[0], groupId, members[0].capability,
        { gameId, variant, config: { maxPlayers: 4, roomName: 'All target group' } });
      for (const member of members) await service.confirm(member, groupId, member.capability,
        { proposalId: proposal.proposal.id, proposalRevision: proposal.proposal.revision });
      const switched = await service.switchGroup(members[0], groupId, members[0].capability);
      assert.equal(switched.transition.status, 'complete');
      assert.equal(switched.members.length, 4);
      assert.equal(JSON.stringify(switched).includes('sessionToken'), false);
      const handoffs = await Promise.all(members.map(member => service.handoff(member, groupId, member.capability)));
      assert.equal(new Set(handoffs.map(handoff => handoff.roomCode)).size, 1);
      assert.equal(new Set(handoffs.map(handoff => handoff.sessionToken)).size, 4);
      const code = handoffs[0].roomCode;
      assert.equal(visited.has(code), false); visited.add(code);
      const room = game.gm.managerForCode(code).rooms.get(code);
      assert.equal(room.gameId || 'the-gang', gameId);
      assert.equal(room.config.visibility, 'invite');
      assert.deepEqual(room.players.map(player => player.profileId).sort(), members.map(member => member.id).sort());
      for (let index = 0; index < members.length; index++) {
        const resumed = await new Promise((resolve, reject) => members[index].client.timeout(3000).emit('room:resume',
          { roomCode: code, sessionToken: handoffs[index].sessionToken }, (error, result) => error ? reject(error) : resolve(result)));
        assert.equal(resumed.error, undefined);
        const seat = room.players.find(player => player.profileId === members[index].id);
        assert.equal(seat.token, handoffs[index].sessionToken);
        assert.equal(seat.socketId, members[index].client.id);
      }
      assert.deepEqual(balances(), initialBalances);
      assert.equal(game.gm.profiles.db.prepare('SELECT COUNT(*) AS count FROM wallet_ledger').get().count, initialLedger);
      assert.equal(game.gm.profiles.db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE status='HELD'").get().count, 0);
      const allRooms = [game.gm.gang, game.gm.uno, game.gm.tienLen, game.gm.poker, game.gm.samLoc, game.gm.phom, game.gm.bang]
        .flatMap(manager => [...manager.rooms.values()]);
      assert.equal(allRooms.length, 1, 'Previous empty rooms close before the group enters the next game');
    });
  }
});
