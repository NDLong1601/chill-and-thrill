'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { MultiGameManager } = require('../src/platform/multiGameManager');

const targets = [
  ['the-gang', 'standard', 2], ['uno', 'classic-local-v1', 2], ['uno', 'classic-108-v1', 2],
  ['tien-len', 'standard', 2], ['poker', 'standard', 2], ['sam-loc', 'standard', 2],
  ['phom', 'standard', 2], ['bang', 'standard', 4],
];

function fakeIo() { return { sockets: { sockets: new Map() }, to: () => ({ emit() {} }) }; }
function socket(io, id) {
  const client = { id, connected: true, data: {}, events: [], join() {}, leave() {},
    emit(name, payload) { this.events.push({ name, payload }); } };
  io.sockets.sockets.set(id, client); return client;
}
function shuffled(cards) {
  const result = [...cards]; let seed = 0x5eed1234;
  for (let index = result.length - 1; index > 0; index--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const other = seed % (index + 1); [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
function open(directory, io) {
  return new MultiGameManager(io, { databaseFile: path.join(directory, 'profiles.sqlite'),
    storageFile: path.join(directory, 'rooms.json'), graceMs: 120000 });
}
function hands(room) {
  if (room.uno) return room.uno.hands;
  return room.players.map(player => ({ id: player.id,
    hand: player.hand || player.holeCards || player.privateCards || [], role: player.role || null,
    stack: player.stack ?? null, totalContribution: player.totalContribution ?? null }));
}
function applyOneAction(gm, manager, room, clients, gameId, variant) {
  const actorId = room.uno?.currentPlayerId || room.currentPlayerId || room.players[0].id;
  const actor = room.players.find(player => player.id === actorId);
  const client = clients.find(item => item.id === actor.socketId);
  let result;
  if (gameId === 'the-gang') result = manager.claimChip(clients[0], room.code, 1, manager.phaseKey(room));
  else if (variant === 'classic-local-v1') {
    const actions = require('../src/games/uno/engine').availableActions(room.uno, actorId);
    const chosen = actions.find(action => action.type === 'choose_color')
      || actions.find(action => action.type === 'draw_penalty') || actions.find(action => action.type === 'draw_card');
    assert.ok(chosen);
    result = gm.roomService.handleGameAction(client, { roomCode: room.code, matchId: room.matchId,
      expectedRevision: room.uno.revision, actionId: 'restart-durable-action', type: chosen.type, payload: { color: 'red' } });
  } else {
    const data = { expectedRevision: room.revision, actionId: 'restart-durable-action' };
    if (gameId === 'uno') data.action = 'draw';
    else if (gameId === 'tien-len') { data.action = 'play'; data.cardIds = [room.initialRequiredCardId]; }
    else if (gameId === 'sam-loc') data.action = 'pass_sam';
    else if (gameId === 'phom') { data.action = 'discard'; data.cardId = actor.hand[0].id; }
    else if (gameId === 'poker') data.action = 'fold';
    else if (gameId === 'bang') {
      data.action = 'draw_cards';
      if (room.pending?.kind === 'KIT_DRAW') data.cardIds = room.pending.options.slice(0, 2).map(card => card.id);
    }
    result = gm.gameAction(client, room.code, data);
  }
  assert.equal(result?.error, undefined, JSON.stringify(result));
  assert.ok(clients.some(item => item.events.some(event => event.name === 'game_state')));
}
function economics(gm, profileIds) {
  return JSON.parse(JSON.stringify({ balances: profileIds.map(id => gm.profiles.publicProfile(id).balances),
    reservations: gm.profiles.db.prepare('SELECT * FROM reservations ORDER BY id').all(),
    operations: gm.profiles.db.prepare('SELECT * FROM wallet_operations ORDER BY idempotency_key').all(),
    ledger: gm.profiles.db.prepare('SELECT * FROM wallet_ledger ORDER BY id').all() }));
}
function gameplay(room) {
  const keys = ['phase', 'matchId', 'revision', 'uno', 'heistNumber', 'roundNumber', 'currentRoundChipColor',
    'chipPool', 'communityCards', 'allCommunityCards', 'remainingDeck', 'drawPile', 'discardPile', 'deck', 'discard',
    'currentPlayerId', 'currentColor', 'direction', 'pending', 'pendingUno', 'pendingWdf', 'pendingDraw',
    'actionIds', 'samResponses', 'samDeadlineAt', 'topPlay', 'leaderId', 'passedIds', 'result'];
  return JSON.parse(JSON.stringify({ ...Object.fromEntries(keys.filter(key => room[key] !== undefined).map(key => [key, room[key]])),
    seats: room.players.map(player => Object.fromEntries(['id', 'profileId', 'chips', 'role', 'characterId',
      'hp', 'equipment', 'hand', 'holeCards', 'privateCards', 'stack', 'totalContribution', 'folded', 'inHand',
      'roundBet', 'ready', 'roundConfirmed'].filter(key => player[key] !== undefined).map(key => [key, player[key]]))) }));
}

if (process.argv[2] === '--crash-fixture') {
  const directory = process.argv[3], [gameId, variant, count] = JSON.parse(process.argv[4]);
  const boundary = process.argv[5] || 'start';
  const io = fakeIo(), gm = open(directory, io), clients = [], credentials = [];
  for (let index = 0; index < count; index++) clients.push(socket(io, `crash-${index}`));
  const created = gm.createRoom(clients[0], 'Restart host', 'BASIC', '🎲', gameId,
    { variant, maxPlayers: count, stake: gameId === 'sam-loc' ? 20 : gameId === 'phom' ? 10 : 100 });
  assert.equal(created.error, undefined); credentials.push(created);
  for (let index = 1; index < count; index++) {
    const joined = gm.joinRoom(clients[index], created.roomCode, `Restart guest ${index}`, '🎲');
    assert.equal(joined.error, undefined); credentials.push(joined);
  }
  const manager = gm.managerForCode(created.roomCode), room = manager.rooms.get(created.roomCode);
  if (manager.shuffle) manager.shuffle = shuffled;
  if (gameId === 'poker') for (let index = 0; index < count; index++) {
    assert.equal(gm.gameAction(clients[index], room.code,
      { action: 'buy_in', amount: 200, actionId: `restart-buyin-${index}`, expectedRevision: room.revision })?.error, undefined);
  }
  for (const client of clients) assert.equal(gm.setReady(client, room.code, true)?.error, undefined);
  // Establish a durable WAITING baseline. The next published start must itself
  // be recoverable; no close(), timer wait, or post-start flush masks the crash.
  manager.flush();
  clients.forEach(client => { client.events.length = 0; });
  assert.equal(gm.startGame(clients[0], room.code)?.error, undefined);
  assert.notEqual(room.phase, 'WAITING');
  assert.ok(clients.every(client => client.events.some(event => event.name === 'game_state'
    && event.payload.phase !== 'WAITING')), 'the start was published to every seat');
  if (boundary === 'action') {
    manager.flush(); clients.forEach(client => { client.events.length = 0; });
    const previous = JSON.stringify(room);
    applyOneAction(gm, manager, room, clients, gameId, variant);
    assert.notEqual(JSON.stringify(room), previous, 'the action must change the room before the crash');
  }
  const profileIds = room.players.map(player => player.profileId);
  fs.writeFileSync(path.join(directory, 'proof.json'), JSON.stringify({ gameId, variant,
    roomCode: room.code, phase: room.phase, matchId: room.matchId, hands: hands(room), gameplay: gameplay(room),
    credentials: credentials.map((entry, index) => ({ ...entry, profileToken: clients[index].data.profileToken })),
    profileIds, economics: economics(gm, profileIds) }));
  process.exit(0);
} else {
  for (const boundary of ['start', 'action']) for (const target of targets) test(`V01 crash after published ${boundary} restores ${target[0]}/${target[1]} without money or privacy loss`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-v01-restart-'));
    let gm;
    t.after(() => {
      gm?.close();
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const prepared = spawnSync(process.execPath, [__filename, '--crash-fixture', directory, JSON.stringify(target), boundary],
      { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000 });
    assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout);
    const proof = JSON.parse(fs.readFileSync(path.join(directory, 'proof.json'), 'utf8'));
    const io = fakeIo(); gm = open(directory, io);
    const manager = gm.managerForCode(proof.roomCode), room = manager?.rooms.get(proof.roomCode);
    assert.ok(room, 'published room must survive an abrupt process exit');
    assert.equal(room.phase, proof.phase, 'published phase must survive before any background save timer fires');
    assert.equal(room.matchId, proof.matchId, 'the same active match must recover');
    assert.deepEqual(hands(room), proof.hands, 'private cards, roles and Poker contributions must recover exactly');
    assert.deepEqual(gameplay(room), proof.gameplay, 'published action, receipts, piles, chips and pending windows must recover exactly');
    assert.deepEqual(economics(gm, proof.profileIds), proof.economics,
      'restart must preserve every balance, held reservation, operation and ledger row');
    assert.ok(room.players.every(player => !player.connected));
    const outsider = socket(io, 'outsider');
    assert.ok(gm.resumeRoom(outsider, room.code, 'invalid-seat-capability')?.error);
    for (let index = 0; index < proof.credentials.length; index++) {
      const client = socket(io, `resumed-${index}`), credential = proof.credentials[index];
      assert.equal(gm.authenticateProfile(client, credential.profileToken)?.error, undefined);
      assert.equal(gm.resumeRoom(client, room.code, credential.sessionToken)?.error, undefined);
      const state = manager.buildStateFor(room, credential.playerId);
      const serialized = JSON.stringify(state);
      for (const other of room.players.filter(player => player.id !== credential.playerId)) {
        assert.equal(serialized.includes(JSON.stringify(other.token || '__absent-private-token__')), false);
        // BANG equipment, Phom melds and Gang showdown cards are public; only
        // the active private hand is checked here.
        const hidden = room.uno?.hands?.[other.id] || other.hand || other.holeCards || other.privateCards || [];
        const publicIds = new Set((room.discardPile || []).map(card => card.id));
        for (const card of hidden) if (room.phase !== 'RESULT' && card?.id && !publicIds.has(card.id)) {
          assert.equal(serialized.includes(JSON.stringify(card.id)), false, `opponent private card ${card.id} leaked after resume`);
        }
      }
      assert.equal(outsider.events.some(event => event.name === 'game_state'), false);
    }
    assert.deepEqual(hands(room), proof.hands);
    assert.deepEqual(economics(gm, proof.profileIds), proof.economics);
  });
}
