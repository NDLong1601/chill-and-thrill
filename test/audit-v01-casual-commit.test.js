'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MultiGameManager } = require('../src/platform/multiGameManager');
const { createBackup, restoreBackup } = require('../src/platform/backupRestore');

const targets = [['the-gang', 'standard', 2], ['uno', 'classic-local-v1', 2], ['uno', 'classic-108-v1', 2], ['bang', 'standard', 4]];
function fakeIo() { return { sockets: { sockets: new Map() }, channels: [], to() { return { emit() {} }; } }; }
function client(io, id) {
  const result = { id, data: {}, connected: true, events: [], join() {}, leave() {},
    emit(name, payload) { this.events.push({ name, payload }); } };
  io.sockets.sockets.set(id, result); return result;
}
function fixture(t, [gameId, variant, count]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-v01-commit-'));
  const directory = path.join(root, 'data'); fs.mkdirSync(directory);
  const io = fakeIo(); io.to = code => ({ emit(name, payload) { io.channels.push({ code, name, payload }); } });
  const options = { databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json') };
  let gm = new MultiGameManager(io, options);
  t.after(() => { gm.close(); assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const clients = Array.from({ length: count }, (_, index) => client(io, `seat-${index}`));
  const created = gm.createRoom(clients[0], 'Commit host', 'BASIC', '🎲', gameId, { variant, maxPlayers: count });
  assert.equal(created.error, undefined);
  for (const item of clients.slice(1)) assert.equal(gm.joinRoom(item, created.roomCode, item.id, '🎲')?.error, undefined);
  const manager = gm.managerForCode(created.roomCode), room = manager.rooms.get(created.roomCode);
  clients.forEach(item => assert.equal(gm.setReady(item, room.code, true)?.error, undefined));
  return { get gm() { return gm; }, root, directory, options, clients, io, manager, room, created,
    replace(next) { gm = next; } };
}
function data(gm) {
  return JSON.parse(JSON.stringify({ wallets: gm.profiles.db.prepare('SELECT * FROM wallets ORDER BY profile_id').all(),
    balances: gm.profiles.db.prepare('SELECT id FROM profiles ORDER BY id').all().map(profile => gm.profiles.publicProfile(profile.id).balances),
    ledger: gm.profiles.db.prepare('SELECT * FROM wallet_ledger ORDER BY id').all(),
    operations: gm.profiles.db.prepare('SELECT * FROM wallet_operations ORDER BY idempotency_key').all(),
    matches: gm.profiles.db.prepare('SELECT * FROM matches ORDER BY match_id').all() }));
}
function oneAction(f, [gameId, variant]) {
  const room = f.room, manager = f.manager;
  const actorId = room.uno?.currentPlayerId || room.currentPlayerId || room.players[0].id;
  const actor = room.players.find(player => player.id === actorId);
  const socket = f.clients.find(item => item.id === actor.socketId);
  if (gameId === 'the-gang') return manager.claimChip(f.clients[0], room.code, 1, manager.phaseKey(room));
  if (variant === 'classic-local-v1') {
    const actions = require('../src/games/uno/engine').availableActions(room.uno, actorId);
    const type = ['choose_color', 'draw_penalty', 'draw_card'].find(candidate => actions.some(action => action.type === candidate));
    return f.gm.roomService.handleGameAction(socket, { roomCode: room.code, matchId: room.matchId,
      expectedRevision: room.uno.revision, actionId: 'v01-commit-action', type, payload: { color: 'red' } });
  }
  return f.gm.gameAction(socket, room.code, { action: gameId === 'bang' ? 'draw_cards' : 'draw',
    cardIds: room.pending?.kind === 'KIT_DRAW' ? room.pending.options.slice(0, 2).map(card => card.id) : undefined,
    expectedRevision: room.revision, actionId: 'v01-commit-action' });
}

for (const target of targets) {
  test(`V01 ${target[0]}/${target[1]} SQLite commit failure rolls back the start before any publication`, t => {
    const f = fixture(t, target), before = structuredClone(f.room), money = data(f.gm);
    const store = f.gm.profiles, originalExec = store.db.exec.bind(store.db); let fail = true;
    store.db.exec = sql => { if (sql === 'COMMIT' && fail) { fail = false; throw new Error('V01 injected casual COMMIT failure'); } return originalExec(sql); };
    f.clients.forEach(item => { item.events.length = 0; }); f.io.channels.length = 0;
    const result = f.gm.startGame(f.clients[0], f.room.code);
    delete store.db.exec;
    const errorMessage = typeof result?.error === 'object' ? result.error.message : result?.error
      || f.clients[0].events.find(event => event.name === 'game_error')?.payload.message;
    assert.match(errorMessage, /V01 injected casual COMMIT failure/);
    assert.equal(f.manager.rooms.get(f.room.code), f.room, 'manager room reference remains stable for subscribers');
    assert.deepEqual(f.room, before);
    assert.deepEqual(data(f.gm), money);
    assert.equal(f.clients.some(item => item.events.some(event => event.name === 'game_state')), false);
    assert.equal(f.io.channels.length, 0, 'no channel-level spotlight or completion can escape rollback');
    if (target[1] === 'classic-local-v1') assert.equal(f.gm.roomService.adapterFor('uno').timers.size, 0);
    assert.equal(f.gm.startGame(f.clients[0], f.room.code)?.error, undefined);
    assert.notEqual(f.room.phase, 'WAITING');
  });

  test(`V01 ${target[0]}/${target[1]} backup restores an active SQLite snapshot even when its valid JSON export is empty`, t => {
    const f = fixture(t, target);
    assert.equal(f.gm.startGame(f.clients[0], f.room.code)?.error, undefined);
    const expected = { phase: f.room.phase, matchId: f.room.matchId, players: f.room.players.map(player => ({
      id: player.id, profileId: player.profileId, hand: player.hand || player.privateCards || [], role: player.role || null })) };
    const money = data(f.gm);
    const file = f.manager.storageFile;
    f.gm.close();
    // Preserve every required file, while reproducing a missing room in the
    // compatibility export. The snapshot is the recovery authority.
    fs.writeFileSync(file, JSON.stringify({ version: target[1] === 'classic-local-v1' || target[0] === 'the-gang' ? 2 : 1, rooms: [] }));
    const backup = createBackup({ serverStopped: true, projectRoot: path.resolve(__dirname, '..'),
      dataDirectory: f.directory, ...f.options, outputDirectory: path.join(f.root, 'backup') });
    const restored = restoreBackup({ backupDirectory: backup.directory, outputDirectory: path.join(f.root, 'restored'), serverStopped: true });
    const next = new MultiGameManager(fakeIo(), { databaseFile: restored.databaseFile, storageFile: restored.storageFile });
    f.replace(next);
    const room = next.managerForCode(f.room.code)?.rooms.get(f.room.code);
    assert.ok(room);
    assert.deepEqual({ phase: room.phase, matchId: room.matchId, players: room.players.map(player => ({
      id: player.id, profileId: player.profileId, hand: player.hand || player.privateCards || [], role: player.role || null })) }, expected);
    assert.deepEqual(data(next), money);
  });

  test(`V01 ${target[0]}/${target[1]} action commit failure preserves cards and receipts and allows the same retry`, t => {
    const f = fixture(t, target);
    assert.equal(f.gm.startGame(f.clients[0], f.room.code)?.error, undefined);
    const before = structuredClone(f.room), money = data(f.gm);
    const exec = f.gm.profiles.db.exec.bind(f.gm.profiles.db); let fail = true;
    f.gm.profiles.db.exec = sql => { if (sql === 'COMMIT' && fail) { fail = false; throw new Error('V01 action COMMIT failure'); } return exec(sql); };
    f.clients.forEach(item => { item.events.length = 0; }); f.io.channels.length = 0;
    const failed = oneAction(f, target);
    delete f.gm.profiles.db.exec;
    assert.ok(failed?.error || f.clients.some(item => item.events.some(event => event.name === 'game_error')));
    assert.deepEqual(f.room, before);
    assert.deepEqual(data(f.gm), money);
    assert.equal(f.clients.some(item => item.events.some(event => event.name === 'game_state')), false);
    assert.equal(f.io.channels.length, 0);
    assert.equal(oneAction(f, target)?.error, undefined);
    assert.notDeepEqual(f.room, before);
  });

  test(`V01 ${target[0]}/${target[1]} a closed room tombstone overrides a stale JSON export`, t => {
    const f = fixture(t, target), oldJson = JSON.parse(JSON.stringify(f.room));
    for (const socket of [...f.clients].reverse()) assert.equal(f.gm.leaveRoom(socket, f.room.code)?.error, undefined);
    assert.equal(f.manager.rooms.has(f.room.code), false);
    const file = f.manager.storageFile;
    f.gm.close();
    fs.writeFileSync(file, JSON.stringify({ version: target[1] === 'classic-local-v1' || target[0] === 'the-gang' ? 2 : 1, rooms: [oldJson] }));
    const next = new MultiGameManager(fakeIo(), f.options); f.replace(next);
    assert.equal(next.managerForCode(f.room.code), null);
  });

  test(`V01 ${target[0]}/${target[1]} a failed JSON export preserves its committed active snapshot`, t => {
    const f = fixture(t, target);
    f.manager.flush();
    assert.equal(f.gm.startGame(f.clients[0], f.room.code)?.error, undefined);
    const state = JSON.stringify({ phase: f.room.phase, matchId: f.room.matchId,
      players: f.room.players.map(player => [player.id, player.hand || player.privateCards || [], player.role || null]), uno: f.room.uno || null });
    const money = data(f.gm), originalFile = f.manager.storageFile;
    const blocked = path.join(f.directory, 'blocked-export.json'); fs.mkdirSync(blocked);
    f.manager.storageFile = blocked;
    try { f.manager.flush(); } finally { f.manager.storageFile = originalFile; }
    const key = f.manager.stateSnapshotKey(f.room);
    const saved = JSON.parse(f.gm.profiles.gameSnapshots(key).find(row => row.roomCode === f.room.code).stateJson);
    assert.equal(saved.phase, f.room.phase);
    assert.equal(saved.matchId, f.room.matchId);
    assert.deepEqual(data(f.gm), money);
    // Read the original stale export while the original manager is still
    // alive, so its close() cannot repair the JSON and mask SQLite recovery.
    const next = new MultiGameManager(fakeIo(), f.options);
    try {
      const room = next.managerForCode(f.room.code).rooms.get(f.room.code);
      assert.equal(JSON.stringify({ phase: room.phase, matchId: room.matchId,
        players: room.players.map(player => [player.id, player.hand || player.privateCards || [], player.role || null]), uno: room.uno || null }), state);
      assert.deepEqual(data(next), money);
    } finally { next.close(); }
  });
}

test('V01 UNO112 expired reaction rollback retains a bounded automatic retry and settles after storage recovers', t => {
  const f = fixture(t, ['uno', 'classic-local-v1', 2]);
  assert.equal(f.gm.startGame(f.clients[0], f.room.code)?.error, undefined);
  const adapter = f.gm.roomService.adapterFor('uno');
  f.room.uno.unoWindow = { playerId: f.room.players[0].id, deadlineAt: Date.now() - 100 };
  f.manager.flush();
  const before = structuredClone(f.room), money = data(f.gm);
  const exec = f.gm.profiles.db.exec.bind(f.gm.profiles.db); let fail = true;
  f.gm.profiles.db.exec = sql => { if (sql === 'COMMIT' && fail) { fail = false; throw new Error('V01 reaction COMMIT failure'); } return exec(sql); };
  f.clients.forEach(item => { item.events.length = 0; }); f.io.channels.length = 0;
  adapter.timeout(f.room.code);
  delete f.gm.profiles.db.exec;
  assert.deepEqual(f.room, before);
  assert.deepEqual(data(f.gm), money);
  assert.equal(f.clients.some(item => item.events.some(event => event.name === 'game_state')), false);
  assert.ok(adapter.timers.has(f.room.code), 'the failed fired timer must retain an automatic retry');
  assert.equal(adapter.timers.get(f.room.code)._idleTimeout, 30000);
  adapter.timeout(f.room.code);
  assert.equal(f.room.uno.unoWindow, null);
  assert.equal(adapter.timers.has(f.room.code), false);
  assert.deepEqual(data(f.gm), money);
});
