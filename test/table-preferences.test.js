'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  STORAGE_KEY, defaults, getPublicTurnStatus, inferUnoVariant, normalizePreferences,
  readPreferences, writePreferences,
} = require('../public/js/table-preferences');
const { MultiGameManager } = require('../src/platform/multiGameManager');

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    values,
  };
}

function fakeSocket(id) {
  return { id, data: {}, handshake: { auth: {} }, join() {}, leave() {}, emit() {} };
}

function gameHarness() {
  const output = path.join(process.cwd(), 'test-results');
  fs.mkdirSync(output, { recursive: true });
  const directory = fs.mkdtempSync(path.join(output, '.table-preferences-b06-'));
  const sockets = Array.from({ length: 64 }, (_, index) => fakeSocket(`prefs-${index}`));
  const io = { sockets: { sockets: new Map(sockets.map(socket => [socket.id, socket])) }, to: () => ({ emit() {} }) };
  const manager = new MultiGameManager(io, { storageFile: path.join(directory, 'rooms.json'), databaseFile: path.join(directory, 'profiles.sqlite') });
  return { directory, manager, sockets };
}

test('preferences defaults honor reduced-motion preference and reject invalid saved values', () => {
  assert.deepEqual(defaults(true), { cardSize: 'standard', textSize: 'standard', audioEnabled: false, reduceMotion: true });
  assert.deepEqual(normalizePreferences({ cardSize: 'enormous', textSize: 'large', audioEnabled: true, reduceMotion: 'yes' }, defaults(true)), {
    cardSize: 'standard', textSize: 'large', audioEnabled: true, reduceMotion: true,
  });
  const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify({ version: 1, cardSize: 'large', textSize: 'largest', audioEnabled: true, reduceMotion: false }) });
  assert.deepEqual(readPreferences(storage, true), { cardSize: 'large', textSize: 'largest', audioEnabled: true, reduceMotion: false });
  assert.deepEqual(readPreferences(memoryStorage({ [STORAGE_KEY]: '{broken' }), true), defaults(true));
  assert.deepEqual(readPreferences(memoryStorage({ [STORAGE_KEY]: JSON.stringify({ version: 0, cardSize: 'large' }) }), false), defaults(false));
});

test('storage access and quota errors remain optional and do not throw', () => {
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  assert.deepEqual(readPreferences(blocked, true), defaults(true));
  assert.equal(writePreferences(blocked, defaults()), false);
  assert.equal(writePreferences(null, defaults()), false);
});

test('UNO variant detection uses only public fields and ignores all hand payloads', () => {
  const legacy108 = new Proxy({
    gameId: 'uno', phase: 'TURN', myId: 'me', currentPlayerId: 'other',
    pendingUno: null, pendingWdf: null,
    players: [{ id: 'me', name: 'Me' }, { id: 'other', name: 'Other' }],
  }, { get(target, property, receiver) {
    if (property === 'myHand' || property === 'hands' || property === 'privateCards') throw new Error(`private field read: ${String(property)}`);
    return Reflect.get(target, property, receiver);
  } });
  assert.equal(inferUnoVariant(legacy108), 'classic-108-v1');
  assert.equal(getPublicTurnStatus(legacy108).ownerId, 'other');
  assert.equal(getPublicTurnStatus({ gameId: 'uno', phase: 'TURN', myId: 'me', players: [] }), null);

  const modern112 = getPublicTurnStatus({
    gameId: 'uno', variant: 'classic-local-v1', phase: 'PLAYING', myId: 'me', currentPlayerId: 'me',
    players: [{ id: 'me', name: 'Me' }], availableActions: [{ type: 'draw_card' }],
  });
  assert.equal(modern112.kind, 'mine');
  assert.equal(modern112.isMine, true);
});

test('turn ownership follows explicit reaction targets and authoritative clocks', () => {
  const uno112 = getPublicTurnStatus({
    gameId: 'uno', variant: 'classic-local-v1', phase: 'PLAYING', matchId: 'm112',
    myId: 'target', currentPlayerId: 'current', turnClock: { playerId: 'current', deadlineAt: 1000 },
    reactionWindow: { type: 'wild4', targetId: 'target', deadlineAt: 900 },
    availableActions: [{ type: 'challenge_draw_four' }, { type: 'draw_penalty' }],
    players: [{ id: 'target', name: 'Target' }, { id: 'current', name: 'Current' }],
  });
  assert.equal(uno112.kind, 'mine');
  assert.equal(uno112.ownerId, 'target');
  assert.match(uno112.turnKey, /wild4/);

  const uno108 = getPublicTurnStatus({
    gameId: 'uno', phase: 'WDF_CHALLENGE', matchId: 'm108', myId: 'target', currentPlayerId: 'offender',
    pendingUno: null, pendingWdf: { targetId: 'target', offenderId: 'offender' }, reactionDeadlineAt: 5000,
    players: [{ id: 'target', name: 'Target' }, { id: 'offender', name: 'Offender' }],
  });
  assert.equal(uno108.kind, 'mine');
  assert.equal(uno108.ownerId, 'target');

  const waitingForBangReaction = getPublicTurnStatus({
    gameId: 'bang', phase: 'MAIN', myId: 'target', currentPlayerId: 'turn-owner',
    pending: { id: 'effect-7', kind: 'ATTACK', waitingId: 'target' },
    players: [{ id: 'target', name: 'Target' }, { id: 'turn-owner', name: 'Turn owner' }],
  });
  assert.equal(waitingForBangReaction.kind, 'mine');
  assert.equal(waitingForBangReaction.ownerId, 'target');
  assert.match(waitingForBangReaction.turnKey, /effect-7/);

  const pokerClock = getPublicTurnStatus({
    gameId: 'poker', phase: 'HAND', myId: 'me', currentPlayerId: 'old-seat',
    turnClock: { playerId: 'me', deadlineAt: 1200 }, legalActions: { canCheck: true },
    players: [{ id: 'me', name: 'Me' }, { id: 'old-seat', name: 'Other' }],
  });
  assert.equal(pokerClock.kind, 'mine');
  assert.equal(pokerClock.ownerId, 'me');
});

test('UNO catch window is an optional reaction and never becomes a turn alert', () => {
  const status = getPublicTurnStatus({
    gameId: 'uno', variant: 'classic-local-v1', phase: 'PLAYING', matchId: 'uno-catch',
    myId: 'catcher', currentPlayerId: 'next', unoWindow: { playerId: 'offender', deadlineAt: 3000 },
    availableActions: [{ type: 'catch_uno', targetId: 'offender' }],
    players: [{ id: 'catcher', name: 'Catcher' }, { id: 'offender', name: 'Offender' }, { id: 'next', name: 'Next' }],
  });
  assert.equal(status.kind, 'reaction');
  assert.equal(status.isMine, false);
  assert.equal(status.message, 'Bạn có thể bắt lỗi UNO.');
});

test('all seven games and both UNO variants accept their own public turn projection', t => {
  const { directory, manager, sockets } = gameHarness();
  t.after(() => { manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const cases = [
    ['the-gang', null, 3], ['uno', 'classic-local-v1', 2], ['uno', 'classic-108-v1', 2],
    ['tien-len', null, 2], ['poker', null, 2], ['sam-loc', null, 2], ['phom', null, 2], ['bang', null, 4],
  ];

  for (const [caseIndex, [gameId, variant, count]] of cases.entries()) {
    const socketOffset = caseIndex * 8;
    const hostSocket = sockets[socketOffset];
    const created = manager.createRoom(hostSocket, `Host ${gameId} ${variant || ''}`, 'BASIC', '🎲', gameId, variant ? { variant } : {});
    assert.equal(created.error, undefined, `create ${gameId}/${variant || 'default'}: ${created.error}`);
    for (let index = 1; index < count; index += 1) {
      assert.equal(manager.joinRoom(sockets[socketOffset + index], created.roomCode, `Guest ${gameId} ${index}`, '🃏').error, undefined);
    }
    if (gameId === 'poker') {
      const room = manager.poker.rooms.get(created.roomCode);
      for (let index = 0; index < count; index += 1) {
        manager.poker.action(sockets[socketOffset + index], room.code, { action: 'buy_in', amount: 200, actionId: `prefs-buy-${room.code}-${index}`, expectedRevision: room.revision });
      }
    }
    for (let index = 0; index < count; index += 1) manager.setReady(sockets[socketOffset + index], created.roomCode, true);
    const started = manager.startGame(hostSocket, created.roomCode);
    assert.equal(started?.error, undefined, `start ${gameId}/${variant || 'default'}: ${started?.error}`);

    const roomManager = manager.managerForCode(created.roomCode);
    const room = roomManager.rooms.get(created.roomCode);
    const playerId = room.currentPlayerId || room.players[0].id;
    const publicState = roomManager.buildStateFor(room, playerId);
    const status = getPublicTurnStatus(publicState);
    if (gameId === 'the-gang' || gameId === 'sam-loc' && publicState.phase === 'SAM_DECLARATION') {
      assert.equal(status.kind, 'group', `${gameId} is not a single-seat turn in ${publicState.phase}`);
    } else {
      assert.equal(status.ownerId, publicState.turnClock?.playerId || publicState.currentPlayerId, `${gameId}/${variant || 'default'} chooses its public actor`);
    }
    assert.equal(Object.hasOwn(status, 'playerName'), true);
    if (gameId === 'uno' && variant === 'classic-local-v1') assert.equal(publicState.variant, 'classic-local-v1');
    if (gameId === 'uno' && variant === 'classic-108-v1') assert.equal(inferUnoVariant(publicState), 'classic-108-v1');
    assert.equal(JSON.stringify(status).includes('myHand'), false);
    assert.equal(JSON.stringify(status).includes('myHoleCards'), false);
  }

  const classicRoom = [...manager.gang.rooms.values()].find(room => room.gameId === 'uno');
  assert.ok(classicRoom?.uno);
  const target = classicRoom.players[1];
  classicRoom.uno.currentPlayerId = classicRoom.players[0].id;
  classicRoom.uno.reactionWindow = { type: 'wild4', targetId: target.id, deadlineAt: Date.now() + 15000 };
  classicRoom.uno.phase = 'PLAYING';
  const reactionState = manager.roomService.adapterFor('uno').buildStateFor(classicRoom, target.id);
  assert.equal(reactionState.currentPlayerId, classicRoom.players[0].id);
  assert.equal(getPublicTurnStatus(reactionState).ownerId, target.id);

  const oldUnoRoom = [...manager.uno.rooms.values()].find(room => room.phase !== 'WAITING');
  assert.ok(oldUnoRoom);
  const oldUnoTarget = oldUnoRoom.players[1];
  oldUnoRoom.currentPlayerId = oldUnoRoom.players[0].id;
  oldUnoRoom.pendingWdf = { targetId: oldUnoTarget.id, offenderId: oldUnoRoom.players[0].id, deadlineAt: Date.now() + 12000 };
  oldUnoRoom.phase = 'WDF_CHALLENGE';
  const oldReactionState = manager.uno.buildStateFor(oldUnoRoom, oldUnoTarget.id);
  assert.equal(oldReactionState.currentPlayerId, oldUnoRoom.players[0].id);
  assert.equal(getPublicTurnStatus(oldReactionState).ownerId, oldUnoTarget.id);

  const bangRoom = [...manager.bang.rooms.values()].find(room => room.phase !== 'WAITING');
  assert.ok(bangRoom);
  const bangTarget = bangRoom.players[1];
  bangRoom.currentPlayerId = bangRoom.players[0].id;
  bangRoom.pending = { id: 'prefs-pending', kind: 'ATTACK', waitingId: bangTarget.id, targetId: bangTarget.id };
  const bangState = manager.bang.buildStateFor(bangRoom, bangTarget.id);
  assert.equal(bangState.currentPlayerId, bangRoom.players[0].id);
  assert.equal(getPublicTurnStatus(bangState).ownerId, bangTarget.id);
});
