'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTemporaryDirectory, removeTemporaryDirectory } = require('../scripts/helpers/temporary-directory');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');
const { GroupLobbyError, GroupLobbyService, adapterKey, targetAdaptersFromManager, managerSwitchLifecycle } = require('../src/platform/groupLobbyService');
const { createGroupLobbyRouter, createProfileServiceResolver, profileTokenFromRequest } = require('../src/platform/groupLobbyRouter');

function temporaryGame(t, options = {}) {
  const directory = createTemporaryDirectory('group-lobby');
  const game = createGameServer({ databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json'), graceMs: 60_000 });
  const sockets = new Map();
  let nextSocket = 0;
  function connect(name) {
    const listeners = new Map();
    const socket = {
      id: `c01-socket-${++nextSocket}`, connected: true, data: {}, emitted: [],
      on(event, handler) { const list = listeners.get(event) || new Set(); list.add(handler); listeners.set(event, list); return socket; },
      off(event, handler) { listeners.get(event)?.delete(handler); return socket; },
      join() {}, leave() {}, emit(event, data) { socket.emitted.push({ event, data }); return socket; },
    };
    game.io.sockets.sockets.set(socket.id, socket);
    game.gm.bootstrapProfile(socket, name, '🕶️');
    const profile = { id: socket.data.profile.id, name: socket.data.profile.displayName, avatar: socket.data.profile.avatar };
    sockets.set(profile.id, socket);
    return { socket, profile };
  }
  const integration = managerSwitchLifecycle({ gameManager: game.gm, socketForProfile: id => sockets.get(id) });
  const targetAdapters = targetAdaptersFromManager({ gameManager: game.gm, socketForProfile: id => sockets.get(id) });
  const service = new GroupLobbyService({
    targetAdapters,
    ...integration,
    membershipLocked: options.membershipLocked,
    authorizeTarget: options.authorizeTarget || (async () => ({ ok: true })),
    clock: options.clock,
    limits: options.limits,
  });
  t.after(async () => {
    service.close();
    await game.close();
    removeTemporaryDirectory(directory);
  });
  return { game, sockets, connect, service, targetAdapters, directory };
}

async function createGroupWith(fixture, count = 2) {
  const players = Array.from({ length: count }, (_, index) => fixture.connect(`Player ${index + 1}`));
  const created = await fixture.service.createGroup(players[0].profile);
  const membership = new Map([[players[0].profile.id, { profile: players[0].profile, capability: created.groupCapability }]]);
  for (const player of players.slice(1)) {
    const joined = await fixture.service.joinGroup(player.profile, created.inviteCapability);
    membership.set(player.profile.id, { profile: player.profile, capability: joined.groupCapability });
  }
  return { players, created, membership, groupId: created.groupId };
}

function walletSnapshot(game, profileId) {
  const balances = game.gm.profiles.publicProfile(profileId).balances;
  return Object.fromEntries(Object.entries(balances).map(([currency, value]) => [currency, { ...value }]));
}

async function temporaryHttpGame(t) {
  const directory = createTemporaryDirectory('group-lobby-http');
  const game = createGameServer({
    databaseFile: path.join(directory, 'profiles.sqlite'),
    storageFile: path.join(directory, 'rooms.json'),
    unoStorageFile: path.join(directory, 'uno.json'),
    tienLenStorageFile: path.join(directory, 'tien-len.json'),
    pokerStorageFile: path.join(directory, 'poker.json'),
    samLocStorageFile: path.join(directory, 'sam-loc.json'),
    phomStorageFile: path.join(directory, 'phom.json'),
    bangStorageFile: path.join(directory, 'bang.json'),
    graceMs: 60_000,
  });
  await new Promise((resolve, reject) => {
    game.server.once('error', reject);
    game.server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${game.server.address().port}`;
  const sockets = [];
  t.after(async () => {
    sockets.forEach(socket => socket.disconnect());
    await game.close();
    removeTemporaryDirectory(directory);
  });
  async function createProfile(name) {
    const response = await fetch(`${base}/api/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, avatar: '🎲' }) });
    assert.equal(response.status, 201);
    return response.json();
  }
  async function connectSocket(profileToken) {
    const socket = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { profileToken } });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
  }
  async function groupRequest(pathname, { profileToken, groupCapability, method = 'GET', body } = {}) {
    const response = await fetch(`${base}/api/groups${pathname}`, {
      method,
      headers: {
        ...(profileToken ? { 'X-Profile-Token': profileToken } : {}),
        ...(groupCapability ? { 'X-Group-Capability': groupCapability } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { response, body: await response.json() };
  }
  return { game, base, createProfile, connectSocket, groupRequest, sockets };
}

async function proposeAndConfirm(fixture, group, target) {
  const host = group.players[0];
  const proposal = await fixture.service.propose(host.profile, group.groupId, group.membership.get(host.profile.id).capability, target);
  for (const member of group.players) {
    const current = group.membership.get(member.profile.id);
    await fixture.service.confirm(member.profile, group.groupId, current.capability,
      { proposalId: proposal.proposal.id, proposalRevision: proposal.proposal.revision });
  }
  return proposal;
}

test('group switch provisions both UNO variants through real managers and keeps each seat credential private', async t => {
  for (const variant of ['classic-local-v1', 'classic-108-v1']) {
    await t.test(variant, async t2 => {
      const fixture = temporaryGame(t2);
      const group = await createGroupWith(fixture, 2);
      const before = new Map(group.players.map(item => [item.profile.id, walletSnapshot(fixture.game, item.profile.id)]));
      const proposal = await proposeAndConfirm(fixture, group, { gameId: 'uno', variant, config: { roomName: 'Nhóm chơi UNO', maxPlayers: variant === 'classic-local-v1' ? 4 : 6 } });
      const confirmed = await fixture.service.getGroup(group.players[0].profile, group.groupId, group.membership.get(group.players[0].profile.id).capability);
      assert.equal(confirmed.proposal.confirmationCount, 2);
      const switched = await fixture.service.switchGroup(group.players[0].profile, group.groupId, group.membership.get(group.players[0].profile.id).capability);
      assert.equal(switched.transition.status, 'complete');
      assert.equal(switched.proposal.target.variant, variant);
      const targetManager = variant === 'classic-local-v1' ? fixture.game.gm.gang : fixture.game.gm.uno;
      const targetRooms = [...targetManager.rooms.values()].filter(room => room.gameId === 'uno' && room.config?.roomName === 'Nhóm chơi UNO');
      assert.equal(targetRooms.length, 1);
      assert.equal(targetRooms[0].players.length, 2);
      assert.equal(targetRooms[0].config.visibility, 'invite');
      assert.equal(targetRooms[0].players.every(player => player.connected === false), true, 'target seats wait safely for their own private handoff');
      const publicJson = JSON.stringify(switched);
      for (const secret of ['sessionToken', 'profileToken', 'recoveryCode', 'roomCode']) assert.equal(publicJson.includes(secret), false);
      for (const member of group.players) {
        const auth = group.membership.get(member.profile.id);
        const handoff = await fixture.service.handoff(member.profile, group.groupId, auth.capability);
        assert.equal(handoff.gameId, 'uno');
        assert.equal(handoff.variant, variant);
        assert.equal(handoff.roomCode, targetRooms[0].code);
        assert.ok(handoff.sessionToken.length >= 32);
        assert.deepEqual(walletSnapshot(fixture.game, member.profile.id), before.get(member.profile.id));
      }
      await assert.rejects(fixture.service.handoff(group.players[0].profile, group.groupId,
        group.membership.get(group.players[1].profile.id).capability), error => error.code === 'GROUP_FORBIDDEN');
      const roomCount = [...fixture.game.gm.gang.rooms, ...fixture.game.gm.uno.rooms].length;
      await fixture.service.confirm(group.players[0].profile, group.groupId, group.membership.get(group.players[0].profile.id).capability,
        { proposalId: proposal.proposal.id, proposalRevision: proposal.proposal.revision }).catch(error => assert.equal(error.code, 'PROPOSAL_STALE'));
      await fixture.service.switchGroup(group.players[1].profile, group.groupId, group.membership.get(group.players[1].profile.id).capability);
      assert.equal([...fixture.game.gm.gang.rooms, ...fixture.game.gm.uno.rooms].length, roomCount);
      const trusted = await fixture.service.getTrustedGroupSnapshot(group.groupId);
      assert.equal(trusted.currentTargetRoomCode, targetRooms[0].code);
      assert.deepEqual(trusted.participantProfileIds, group.players.map(item => item.profile.id));
      assert.equal(trusted.hostProfileId, group.players[0].profile.id);
    });
  }
});

test('capacity, game minimums, and explicit UNO variant are checked against the whole group', async t => {
  const fixture = temporaryGame(t);
  const five = await createGroupWith(fixture, 5);
  await assert.rejects(fixture.service.propose(five.players[0].profile, five.groupId, five.membership.get(five.players[0].profile.id).capability,
    { gameId: 'uno', variant: 'classic-local-v1', config: { maxPlayers: 4 } }), error => error.code === 'GROUP_OVER_CAPACITY');
  await assert.rejects(fixture.service.propose(five.players[0].profile, five.groupId, five.membership.get(five.players[0].profile.id).capability,
    { gameId: 'uno', variant: 'classic-108-v1', config: { maxPlayers: 4 } }), error => error.code === 'GROUP_OVER_CAPACITY');
  await assert.rejects(fixture.service.propose(five.players[0].profile, five.groupId, five.membership.get(five.players[0].profile.id).capability,
    { gameId: 'uno', config: { maxPlayers: 6 } }), error => error.code === 'VARIANT_REQUIRED');
  const small = await createGroupWith(fixture, 2);
  await assert.rejects(fixture.service.propose(small.players[0].profile, small.groupId, small.membership.get(small.players[0].profile.id).capability,
    { gameId: 'bang', variant: 'standard', config: { maxPlayers: 7 } }), error => error.code === 'GROUP_TOO_SMALL');
});

test('membership, disconnect, and host changes invalidate consent at the proposal revision', async t => {
  const fixture = temporaryGame(t);
  const group = await createGroupWith(fixture, 2);
  const host = group.players[0], guest = group.players[1];
  const proposal = await proposeAndConfirm(fixture, group, { gameId: 'uno', variant: 'classic-108-v1', config: { maxPlayers: 6 } });
  await fixture.service.disconnect(guest.profile, group.groupId, group.membership.get(guest.profile.id).capability);
  let view = await fixture.service.getGroup(host.profile, group.groupId, group.membership.get(host.profile.id).capability);
  assert.equal(view.proposal.status, 'stale');
  assert.equal(view.proposal.confirmationCount, 0);
  await assert.rejects(fixture.service.confirm(guest.profile, group.groupId, group.membership.get(guest.profile.id).capability,
    { proposalId: proposal.proposal.id, proposalRevision: proposal.proposal.revision }), error => error.code === 'PROPOSAL_STALE');
  const rejoined = await fixture.service.joinGroup(guest.profile, group.created.inviteCapability);
  group.membership.set(guest.profile.id, { profile: guest.profile, capability: rejoined.groupCapability });
  const newMember = fixture.connect('Player 3');
  await fixture.service.propose(host.profile, group.groupId, group.membership.get(host.profile.id).capability,
    { gameId: 'uno', variant: 'classic-108-v1', config: { maxPlayers: 6 } });
  const pending = await fixture.service.getGroup(host.profile, group.groupId, group.membership.get(host.profile.id).capability);
  await fixture.service.joinGroup(newMember.profile, group.created.inviteCapability);
  view = await fixture.service.getGroup(host.profile, group.groupId, group.membership.get(host.profile.id).capability);
  assert.equal(view.proposal.status, 'stale');
  assert.equal(view.members.length, 3);
  // Start a fresh proposal and verify host transfer invalidates it too.
  const latest = await fixture.service.propose(host.profile, group.groupId, group.membership.get(host.profile.id).capability,
    { gameId: 'uno', variant: 'classic-108-v1', config: { maxPlayers: 6 } });
  const guestKey = latest.members.find(item => item.name === guest.profile.name).memberKey;
  view = await fixture.service.transferHost(host.profile, group.groupId, group.membership.get(host.profile.id).capability, guestKey);
  assert.equal(view.viewer.isHost, false);
  assert.equal(view.proposal.status, 'stale');
  assert.equal(view.proposal.confirmationCount, 0);
  assert.ok(pending.revision < view.revision);
});

test('optional tournament lock blocks roster and host mutation without changing group membership', async t => {
  const fixture = temporaryGame(t);
  const group = await createGroupWith(fixture, 2);
  fixture.service.setMembershipLockChecker(async () => ({ locked: true, message: 'Tournament roster is locked.' }));
  const outsider = fixture.connect('Outsider');
  await assert.rejects(fixture.service.joinGroup(outsider.profile, group.created.inviteCapability), error => error.code === 'GROUP_MEMBERSHIP_LOCKED');
  await assert.rejects(fixture.service.leave(group.players[1].profile, group.groupId,
    group.membership.get(group.players[1].profile.id).capability), error => error.code === 'GROUP_MEMBERSHIP_LOCKED');
  const view = await fixture.service.getGroup(group.players[0].profile, group.groupId,
    group.membership.get(group.players[0].profile.id).capability);
  assert.equal(view.members.length, 2);
  assert.equal(view.members.some(member => member.name === 'Outsider'), false);
});

test('an active coin hand is blocked without leaving the room or changing held funds', async t => {
  const fixture = temporaryGame(t);
  const group = await createGroupWith(fixture, 2);
  const [host, guest] = group.players;
  const created = fixture.game.gm.createRoom(fixture.sockets.get(host.profile.id), host.profile.name, 'ADVANCED', host.profile.avatar,
    'tien-len', { maxPlayers: 2, stake: 100 });
  assert.ok(created.roomCode);
  const joined = fixture.game.gm.joinRoom(fixture.sockets.get(guest.profile.id), created.roomCode, guest.profile.name, guest.profile.avatar, '');
  assert.ok(joined.sessionToken);
  fixture.game.gm.setReady(fixture.sockets.get(host.profile.id), created.roomCode, true);
  fixture.game.gm.setReady(fixture.sockets.get(guest.profile.id), created.roomCode, true);
  assert.equal(fixture.game.gm.startGame(fixture.sockets.get(host.profile.id), created.roomCode).ok, true);
  const before = new Map(group.players.map(item => [item.profile.id, walletSnapshot(fixture.game, item.profile.id)]));
  await proposeAndConfirm(fixture, group, { gameId: 'uno', variant: 'classic-108-v1', config: { maxPlayers: 6 } });
  await assert.rejects(fixture.service.switchGroup(host.profile, group.groupId, group.membership.get(host.profile.id).capability), error => error.code === 'MATCH_ACTIVE');
  assert.equal(fixture.game.gm.managerForCode(created.roomCode).rooms.get(created.roomCode).phase, 'TURN');
  assert.equal(fixture.game.gm.managerForCode(created.roomCode).rooms.get(created.roomCode).reservations.length, 2);
  for (const member of group.players) assert.deepEqual(walletSnapshot(fixture.game, member.profile.id), before.get(member.profile.id));
  assert.equal(fixture.game.gm.managerForCode(created.roomCode).rooms.get(created.roomCode).players.length, 2);
});

test('Poker stack remains in the shared ledger until a safe native cash-out, then moves once', async t => {
  const fixture = temporaryGame(t);
  const group = await createGroupWith(fixture, 2);
  const [host, guest] = group.players;
  const created = fixture.game.gm.createRoom(fixture.sockets.get(host.profile.id), host.profile.name, 'ADVANCED', host.profile.avatar, 'poker', {});
  const joined = fixture.game.gm.joinRoom(fixture.sockets.get(guest.profile.id), created.roomCode, guest.profile.name, guest.profile.avatar, '');
  assert.ok(joined.sessionToken);
  for (const member of group.players) {
    const manager = fixture.game.gm.poker, room = manager.rooms.get(created.roomCode);
    const result = fixture.game.gm.gameAction(fixture.sockets.get(member.profile.id), created.roomCode,
      { action: 'buy_in', amount: 200, actionId: `c01-buyin-${member.profile.id.slice(0, 10)}`, expectedRevision: room.revision });
    assert.equal(result?.error, undefined);
  }
  const table = fixture.game.gm.poker.rooms.get(created.roomCode);
  assert.equal(table.players.reduce((sum, player) => sum + player.stack, 0), 400);
  const beforeTotal = new Map(group.players.map(item => [item.profile.id, walletSnapshot(fixture.game, item.profile.id).chip.available + walletSnapshot(fixture.game, item.profile.id).chip.reserved]));
  await proposeAndConfirm(fixture, group, { gameId: 'uno', variant: 'classic-108-v1', config: { maxPlayers: 6 } });
  await fixture.service.switchGroup(host.profile, group.groupId, group.membership.get(host.profile.id).capability);
  assert.equal(fixture.game.gm.poker.rooms.has(created.roomCode), false);
  for (const member of group.players) {
    const wallet = walletSnapshot(fixture.game, member.profile.id).chip;
    assert.equal(wallet.reserved, 0);
    assert.equal(wallet.available + wallet.reserved, beforeTotal.get(member.profile.id));
  }
  await fixture.service.switchGroup(guest.profile, group.groupId, group.membership.get(guest.profile.id).capability);
  for (const member of group.players) {
    const wallet = walletSnapshot(fixture.game, member.profile.id).chip;
    assert.equal(wallet.reserved, 0);
    assert.equal(wallet.available + wallet.reserved, beforeTotal.get(member.profile.id));
  }
});

test('Poker group switch blocks a stack whose manager reservation IDs do not match the shared ledger', async t => {
  const fixture = temporaryGame(t);
  const group = await createGroupWith(fixture, 2);
  const [host, guest] = group.players;
  const created = fixture.game.gm.createRoom(fixture.sockets.get(host.profile.id), host.profile.name, 'ADVANCED', host.profile.avatar, 'poker', {});
  fixture.game.gm.joinRoom(fixture.sockets.get(guest.profile.id), created.roomCode, guest.profile.name, guest.profile.avatar, '');
  const pokerRoom = fixture.game.gm.poker.rooms.get(created.roomCode);
  const player = pokerRoom.players.find(item => item.profileId === host.profile.id);
  fixture.game.gm.gameAction(fixture.sockets.get(host.profile.id), created.roomCode,
    { action: 'buy_in', amount: 200, actionId: `c01-mismatch-${host.profile.id.slice(0, 10)}`, expectedRevision: pokerRoom.revision });
  player.reservations = [];
  const before = walletSnapshot(fixture.game, host.profile.id);
  await proposeAndConfirm(fixture, group, { gameId: 'uno', variant: 'classic-108-v1', config: { maxPlayers: 6 } });
  await assert.rejects(fixture.service.switchGroup(host.profile, group.groupId, group.membership.get(host.profile.id).capability),
    error => error.code === 'POKER_HOLD_MISMATCH');
  assert.equal(fixture.game.gm.poker.rooms.get(created.roomCode), pokerRoom);
  assert.equal(player.stack, 200);
  assert.deepEqual(walletSnapshot(fixture.game, host.profile.id), before);
});

test('mounted HTTP and authenticated Socket.IO flow creates one UNO target and returns private seat handoffs', async t => {
  const fixture = await temporaryHttpGame(t);
  const unauthorized = await fixture.groupRequest('/', { method: 'POST', body: { profileId: 'spoofed' } });
  assert.equal(unauthorized.response.status, 401);
  assert.equal((await fetch(`${fixture.base}/group-lobby`)).status, 200);
  assert.equal((await fetch(`${fixture.base}/public/group-lobby.html`)).status, 404);
  const alice = await fixture.createProfile('HTTP Alice');
  const bob = await fixture.createProfile('HTTP Bob');
  const aliceSocket = await fixture.connectSocket(alice.profileToken);
  const bobSocket = await fixture.connectSocket(bob.profileToken);
  assert.equal(aliceSocket.connected, true); assert.equal(bobSocket.connected, true);
  const created = await fixture.groupRequest('/', { method: 'POST', profileToken: alice.profileToken,
    body: { profileId: 'attacker-selected-id', playerName: 'Forged Host' } });
  assert.equal(created.response.status, 201);
  const groupId = created.body.groupId;
  const hostCap = created.body.groupCapability;
  assert.equal(created.body.group.members[0].name, 'HTTP Alice');
  assert.equal(JSON.stringify(created.body).includes(alice.profile.playerId), false);
  const joined = await fixture.groupRequest('/join', { method: 'POST', profileToken: bob.profileToken,
    body: { inviteCapability: created.body.inviteCapability, profileId: 'forged-member' } });
  assert.equal(joined.response.status, 201);
  assert.equal(joined.body.group.members.length, 2);
  const guestCap = joined.body.groupCapability;
  const target = { gameId: 'uno', variant: 'classic-108-v1', config: { roomName: 'HTTP group', maxPlayers: 6 } };
  const proposal = await fixture.groupRequest(`/${groupId}/proposal`, { method: 'POST', profileToken: alice.profileToken, groupCapability: hostCap, body: target });
  assert.equal(proposal.response.status, 200);
  const wrongOwner = await fixture.groupRequest(`/${groupId}/confirm`, { method: 'POST', profileToken: alice.profileToken, groupCapability: guestCap,
    body: { proposalId: proposal.body.proposal.id, proposalRevision: proposal.body.proposal.revision } });
  assert.equal(wrongOwner.response.status, 403);
  const stale = await fixture.groupRequest(`/${groupId}/confirm`, { method: 'POST', profileToken: bob.profileToken, groupCapability: guestCap,
    body: { proposalId: proposal.body.proposal.id, proposalRevision: proposal.body.proposal.revision - 1 } });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, 'PROPOSAL_STALE');
  const aliceConfirm = await fixture.groupRequest(`/${groupId}/confirm`, { method: 'POST', profileToken: alice.profileToken, groupCapability: hostCap,
    body: { proposalId: proposal.body.proposal.id, proposalRevision: proposal.body.proposal.revision } });
  assert.equal(aliceConfirm.response.status, 200);
  const bobConfirm = await fixture.groupRequest(`/${groupId}/confirm`, { method: 'POST', profileToken: bob.profileToken, groupCapability: guestCap,
    body: { proposalId: proposal.body.proposal.id, proposalRevision: proposal.body.proposal.revision } });
  assert.equal(bobConfirm.response.status, 200);
  assert.equal(bobConfirm.body.proposal.confirmationCount, 2);
  const switched = await fixture.groupRequest(`/${groupId}/switch`, { method: 'POST', profileToken: alice.profileToken, groupCapability: hostCap, body: {} });
  assert.equal(switched.response.status, 200);
  assert.equal(switched.body.transition.status, 'complete');
  assert.equal(JSON.stringify(switched.body).includes('sessionToken'), false);
  const code = switched.body.transition.roomCode;
  assert.equal(code, undefined, 'public group response must not disclose room code');
  const snapshot = await fixture.game.groupLobbyService.getTrustedGroupSnapshot(groupId);
  assert.equal(snapshot.roomBinding.gameId, 'uno');
  assert.equal(snapshot.roomBinding.variant, 'classic-108-v1');
  assert.deepEqual([...snapshot.roomBinding.participants].sort(), [alice.profile.playerId, bob.profile.playerId].sort());
  assert.deepEqual(snapshot.members.map(member => member.profileId), [alice.profile.playerId, bob.profile.playerId]);
  const aliceHandoff = await fixture.groupRequest(`/${groupId}/handoff`, { profileToken: alice.profileToken, groupCapability: hostCap });
  const bobHandoff = await fixture.groupRequest(`/${groupId}/handoff`, { profileToken: bob.profileToken, groupCapability: guestCap });
  assert.equal(aliceHandoff.response.status, 200);
  assert.equal(bobHandoff.response.status, 200);
  assert.equal(aliceHandoff.body.sessionToken === bobHandoff.body.sessionToken, false);
  assert.equal(aliceHandoff.body.roomCode, bobHandoff.body.roomCode);
  const steal = await fixture.groupRequest(`/${groupId}/handoff`, { profileToken: alice.profileToken, groupCapability: guestCap });
  assert.equal(steal.response.status, 403);
  const targetManager = fixture.game.gm.uno;
  assert.equal(targetManager.rooms.get(aliceHandoff.body.roomCode).players.length, 2);
  assert.equal(targetManager.rooms.get(aliceHandoff.body.roomCode).players.every(player => player.connected === false), true);
  const countBefore = targetManager.rooms.size;
  const retry = await fixture.groupRequest(`/${groupId}/switch`, { method: 'POST', profileToken: bob.profileToken, groupCapability: guestCap, body: {} });
  assert.equal(retry.response.status, 200);
  assert.equal(targetManager.rooms.size, countBefore);
});

test('lost join acknowledgement resumes an existing target seat instead of duplicating the room or seat', async t => {
  const fixture = temporaryGame(t);
  const group = await createGroupWith(fixture, 2);
  const key = adapterKey('uno', 'classic-108-v1');
  const original = fixture.targetAdapters[key];
  let loseOnce = true;
  fixture.service.adapters[key] = { ...original, ensureSeat: async context => {
    const credential = await original.ensureSeat(context);
    if (context.member.id === group.players[1].profile.id && loseOnce) { loseOnce = false; throw new Error('simulated lost acknowledgement'); }
    return credential;
  } };
  await proposeAndConfirm(fixture, group, { gameId: 'uno', variant: 'classic-108-v1', config: { maxPlayers: 6 } });
  await assert.rejects(fixture.service.switchGroup(group.players[0].profile, group.groupId, group.membership.get(group.players[0].profile.id).capability), /simulated lost acknowledgement/);
  let view = await fixture.service.getGroup(group.players[0].profile, group.groupId, group.membership.get(group.players[0].profile.id).capability);
  assert.equal(view.transition.status, 'partial');
  assert.equal(view.transition.joined, 1);
  await fixture.service.switchGroup(group.players[0].profile, group.groupId, group.membership.get(group.players[0].profile.id).capability);
  view = await fixture.service.getGroup(group.players[0].profile, group.groupId, group.membership.get(group.players[0].profile.id).capability);
  assert.equal(view.transition.status, 'complete');
  assert.equal(fixture.game.gm.uno.rooms.size, 1);
  const room = [...fixture.game.gm.uno.rooms.values()][0];
  assert.equal(room.players.length, 2);
  assert.equal(new Set(room.players.map(player => player.profileId)).size, 2);
  assert.equal(room.players.every(player => player.token), true);
});

test('target authorization gate runs before old-seat preparation', async t => {
  const fixture = temporaryGame(t, { authorizeTarget: async () => ({ ok: false, code: 'MAINTENANCE', message: 'Host maintenance is active.' }) });
  const group = await createGroupWith(fixture, 2);
  const [host] = group.players;
  await proposeAndConfirm(fixture, group, { gameId: 'uno', variant: 'classic-108-v1', config: { maxPlayers: 6 } });
  await assert.rejects(fixture.service.switchGroup(host.profile, group.groupId, group.membership.get(host.profile.id).capability), error => error.code === 'MAINTENANCE');
  assert.equal(fixture.game.gm.uno.rooms.size, 0);
});

test('the HTTP router requires a trusted ProfileService resolver and never takes identity from the body', async t => {
  const fixture = temporaryGame(t);
  assert.throws(() => createGroupLobbyRouter({ service: fixture.service }), /resolveProfile/);
  const user = fixture.connect('Trusted Name');
  const token = fixture.sockets.get(user.profile.id);
  const profileService = fixture.game.gm.roomService.profileService;
  const resolver = createProfileServiceResolver(profileService);
  const req = { get: name => name.toLowerCase() === 'x-profile-token' ? token.data.profileToken : undefined, headers: {} };
  assert.deepEqual(resolver(req), user.profile);
  assert.equal(profileTokenFromRequest({ headers: { 'x-profile-token': 'secret-from-header' } }), 'secret-from-header');
  assert.equal(profileTokenFromRequest({ headers: {}, body: { profileToken: 'not-authority' } }), '');
  const router = createGroupLobbyRouter({ service: fixture.service, resolveProfile: request => resolver(request) });
  assert.equal(typeof router.handle, 'function');
});
