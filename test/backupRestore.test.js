'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ProfileStore } = require('../src/platform/profileStore');
const { MultiGameManager } = require('../src/platform/multiGameManager');
const { defaultSourcePaths, createBackup, verifyBackup, restoreBackup, BackupRestoreError, MANAGER_FILES } = require('../src/platform/backupRestore');

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function emptyRooms(file, version = 1) { writeJson(file, { version, rooms: [] }); }

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-c04-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  const dataDirectory = path.join(projectRoot, 'data');
  const backupParent = path.join(root, 'backups');
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.mkdirSync(backupParent, { recursive: true });
  return { root, projectRoot, dataDirectory, backupParent };
}

function baseRoom(code, gameId, phase, matchId, players, extras = {}) {
  return {
    code, gameId, phase, matchId, revision: 1, updatedAt: Date.now(), startedAt: Date.now(),
    reconnectPolicyVersion: 2, reconnectPaused: false, hostPaused: false, paused: false, players, reservations: [], actionIds: {}, history: [], log: [], ...extras,
  };
}

function player(id, profileId, token, extra = {}) {
  const disconnectedAt = Date.now() - 500;
  return { id, profileId, token, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), name: id, avatar: '🎲',
    isHost: false, connected: false, socketId: null, disconnectedAt, reconnectDeadlineAt: disconnectedAt + 120000, ready: true, hand: [], leaveAfterHand: false, ...extra };
}

function makeFixture(t) {
  const dirs = tempRoot(t);
  const databaseFile = path.join(dirs.dataDirectory, 'chill-and-thrill.sqlite');
  const storageFile = path.join(dirs.dataDirectory, 'rooms.json');
  const paths = defaultSourcePaths({ projectRoot: dirs.projectRoot, dataDirectory: dirs.dataDirectory, databaseFile, storageFile });
  const store = new ProfileStore({ databaseFile });
  t.after(() => { try { store.close(); } catch {} });

  const gangProfile = store.createProfile({ displayName: 'Gang', avatar: '🎲' });
  const uno112Profile = store.createProfile({ displayName: 'UNO 112', avatar: '🥷' });
  const uno108Profile = store.createProfile({ displayName: 'UNO 108', avatar: '💻' });
  const coinA = store.createProfile({ displayName: 'Coin A', avatar: '🎲' });
  const coinB = store.createProfile({ displayName: 'Coin B', avatar: '🥷' });
  const pokerProfile = store.createProfile({ displayName: 'Poker', avatar: '🕶️' });

  const gangRoom = baseRoom('G101', 'the-gang', 'WAITING', 'G-MATCH', [player('gang-seat', gangProfile.profile.id, 'legacy-gang-token', { isHost: true })], {
    variant: 'standard', mode: 'ADVANCED', config: { maxPlayers: 6, visibility: 'public' },
  });
  const uno112Room = baseRoom('U112', 'uno', 'WAITING', 'U112-MATCH', [player('uno112-seat', uno112Profile.profile.id, 'legacy-uno112-token', { isHost: true })], {
    variant: 'classic-local-v1', config: { maxPlayers: 4, visibility: 'public' }, uno: null,
  });
  store.syncRoom({ room: gangRoom, gameId: 'the-gang' });
  store.syncRoom({ room: uno112Room, gameId: 'uno' });

  const uno108Room = { code: 'U108', gameId: 'uno', variant: 'classic-108-v1', phase: 'WAITING', matchId: 'U108-MATCH', revision: 1,
    updatedAt: Date.now(), players: [player('uno108-seat', uno108Profile.profile.id, 'legacy-uno108-token', { isHost: true })], direction: 1,
    currentPlayerId: null, currentColor: null, drawPile: [], discardPile: [], pendingDraw: null, pendingUno: null, pendingWdf: null,
    actionIds: {}, result: null, history: [], log: [], paused: false, startedAt: null };

  const held = store.reserveMany({
    reservations: [{ profileId: coinA.profile.id, amount: 100 }, { profileId: coinB.profile.id, amount: 100 }],
    operationKey: 'tien-len:reserve:C04-MATCH', roomCode: 'TL01', matchId: 'TL-MATCH', currency: 'coin',
  }).held;
  const tienLenRoom = baseRoom('TL01', 'tien-len', 'TURN', 'TL-MATCH', [
    player('coin-a-seat', coinA.profile.id, 'legacy-tl-a', { hand: [{ id: 'card-a' }], isHost: true }),
    player('coin-b-seat', coinB.profile.id, 'legacy-tl-b', { hand: [{ id: 'card-b' }], currentTurn: true }),
  ], { currentPlayerId: 'coin-a-seat', reservations: held, stake: 100, maxLoss: 100, turnClock: { deadlineAt: Date.now() + 60000 } });
  store.syncRoom({ room: tienLenRoom, gameId: 'tien-len' });
  store.saveGameSnapshot({ gameId: 'tien-len', room: tienLenRoom });

  const pokerHold = store.reserveMany({ reservations: [{ profileId: pokerProfile.profile.id, amount: 200 }],
    operationKey: `poker:buyin:PK01:${pokerProfile.profile.id}:C04-ACTION`, roomCode: 'PK01', matchId: 'PK-MATCH' }).held;
  const pokerRoom = baseRoom('PK01', 'poker', 'WAITING', 'PK-MATCH', [
    player('poker-seat', pokerProfile.profile.id, 'legacy-poker-token', { stack: 240, reservations: pokerHold, holeCards: [], inHand: false }),
  ], { buttonPlayerId: 'poker-seat', currentPlayerId: null, street: null, community: [], currentBet: 0 });
  store.syncRoom({ room: pokerRoom, gameId: 'poker' });

  writeJson(storageFile, { version: 2, rooms: [gangRoom, uno112Room] });
  writeJson(paths.managerFiles.uno108, { version: 1, rooms: [uno108Room] });
  writeJson(paths.managerFiles.tienLen, { version: 1, rooms: [tienLenRoom] });
  writeJson(paths.managerFiles.poker, { version: 1, rooms: [pokerRoom] });
  emptyRooms(paths.managerFiles.samLoc);
  emptyRooms(paths.managerFiles.phom);
  emptyRooms(paths.managerFiles.bang);
  store.close();

  return { ...dirs, databaseFile, storageFile, paths, profiles: { gangProfile, uno112Profile, uno108Profile, coinA, coinB, pokerProfile },
    held, pokerHold, gangRoom, uno112Room, uno108Room, tienLenRoom, pokerRoom };
}

function backupOptions(fixture, outputDirectory, extra = {}) {
  return { serverStopped: true, projectRoot: fixture.projectRoot, dataDirectory: fixture.dataDirectory,
    databaseFile: fixture.databaseFile, storageFile: fixture.storageFile, outputDirectory, ...extra };
}

function fakeIo() { return { sockets: { sockets: new Map() }, to: () => ({ emit() {} }) }; }

function stopManagerWithoutExportWrites(gm) {
  for (const adapter of gm.roomService.adapters.values()) for (const timer of adapter.timers?.values() || []) clearTimeout(timer);
  for (const manager of [gm.gang, gm.uno, gm.tienLen, gm.poker, gm.samLoc, gm.phom, gm.bang]) {
    clearInterval(manager.cleanupTimer);
    clearTimeout(manager.saveTimer);
  }
  if (gm.ownsProfileStore) gm.profiles.close();
}

test('C04 requires an explicit stopped-server assertion and every required manager file', t => {
  const f = makeFixture(t);
  const output = path.join(f.backupParent, 'missing-confirmation');
  assert.throws(() => createBackup({ ...backupOptions(f, output), serverStopped: false }), error => error instanceof BackupRestoreError && error.code === 'SERVER_STOP_CONFIRMATION_REQUIRED');
  fs.rmSync(f.paths.managerFiles.bang);
  assert.throws(() => createBackup(backupOptions(f, output)), /ENOENT|Nguồn bắt buộc/);
  assert.equal(fs.existsSync(output), false);
  writeJson(f.paths.managerFiles.bang, { version: 1, rooms: [] });
  fs.writeFileSync(f.paths.managerFiles.uno108, '{ broken authoritative JSON');
  const badJsonOutput = path.join(f.backupParent, 'bad-authoritative-json');
  assert.throws(() => createBackup(backupOptions(f, badJsonOutput)), error => error.code === 'MANAGER_JSON_INVALID');
  assert.equal(fs.existsSync(badJsonOutput), false);
});

test('creates and restores a consistent bundle; restart recovers tokens, both UNO variants, holds, Poker stack, and idempotent settlement', t => {
  const f = makeFixture(t);
  // These are best-effort exports. A01's committed SQL snapshots remain the
  // recovery authority for fixed-stake rooms and Poker.
  fs.writeFileSync(f.paths.managerFiles.tienLen, '{ damaged export');
  fs.writeFileSync(f.paths.managerFiles.poker, '{ damaged export');
  const sourceFiles = [f.databaseFile, ...Object.values(f.paths.managerFiles)];
  const sourceDirectoryBefore = fs.readdirSync(f.dataDirectory).sort();
  const before = new Map(sourceFiles.map(file => [file, hash(file)]));
  const backupDirectory = path.join(f.backupParent, 'backup-one');
  const backup = createBackup(backupOptions(f, backupDirectory, { createdAt: '2026-10-06T00:00:00.000Z' }));
  assert.equal(backup.manifest.state, 'complete');
  assert.equal(backup.manifest.consistency.liveGateIntegrated, false);
  assert.deepEqual(backup.validation.degradedExports.map(item => item.id).sort(), ['poker-export', 'tien-len']);
  assert.equal(backup.validation.database.heldReservations, 3);
  assert.equal(backup.validation.database.profiles, 6);
  for (const file of sourceFiles) assert.equal(hash(file), before.get(file), `source unchanged: ${file}`);
  assert.deepEqual(fs.readdirSync(f.dataDirectory).sort(), sourceDirectoryBefore);

  const verified = verifyBackup(backupDirectory);
  assert.equal(verified.validation.pokerHeldReservations, 1);
  const restoreDirectory = path.join(f.root, 'restored-fixture');
  const restored = restoreBackup({ backupDirectory, outputDirectory: restoreDirectory, projectRoot: f.projectRoot,
    databaseFile: f.databaseFile, storageFile: f.storageFile });
  assert.equal(restored.directory, restoreDirectory);
  assert.notEqual(restored.directory, f.dataDirectory);

  const restoredDb = new ProfileStore({ databaseFile: restored.databaseFile });
  const session = restoredDb.authenticate(f.profiles.gangProfile.sessionToken);
  assert.equal(session.id, f.profiles.gangProfile.profile.id);
  assert.equal(restoredDb.publicProfile(f.profiles.coinA.profile.id).balances.coin.reserved, 100);
  assert.equal(restoredDb.publicProfile(f.profiles.pokerProfile.profile.id).balances.chip.reserved, 200);
  restoredDb.close();

  const managerFiles = Object.fromEntries(Object.entries(f.paths.managerFiles).map(([key]) => [key,
    path.join(restoreDirectory, MANAGER_FILES.find(spec => spec.sourceKey === key).filename)]));
  const gm = new MultiGameManager(fakeIo(), {
    databaseFile: restored.databaseFile,
    storageFile: restored.storageFile,
    unoStorageFile: managerFiles.uno108,
    tienLenStorageFile: managerFiles.tienLen,
    pokerStorageFile: managerFiles.poker,
    samLocStorageFile: managerFiles.samLoc,
    phomStorageFile: managerFiles.phom,
    bangStorageFile: managerFiles.bang,
  });
  try {
    assert.equal(gm.gang.rooms.get('G101').players[0].token, 'legacy-gang-token');
    assert.equal(gm.gang.rooms.get('U112').variant, 'classic-local-v1');
    assert.equal(gm.gang.rooms.get('U112').players[0].token, 'legacy-uno112-token');
    assert.equal(gm.uno.rooms.get('U108').variant, 'classic-108-v1');
    assert.equal(gm.uno.rooms.get('U108').players[0].token, 'legacy-uno108-token');
    assert.equal(gm.tienLen.rooms.get('TL01').players.length, 2);
    assert.equal(gm.poker.rooms.get('PK01').players[0].stack, 240);
    const reservations = f.held.map(item => ({ reservationId: item.reservationId }));
    const outcomes = [{ profileId: f.profiles.coinA.profile.id, delta: 100 }, { profileId: f.profiles.coinB.profile.id, delta: -100 }];
    const settlement = { reservations, outcomes, operationKey: 'tien-len:settlement:C04-MATCH', roomCode: 'TL01', matchId: 'TL-MATCH' };
    gm.profiles.settleReservations(settlement);
    const afterFirst = [gm.profiles.publicProfile(f.profiles.coinA.profile.id).balances.coin, gm.profiles.publicProfile(f.profiles.coinB.profile.id).balances.coin];
    gm.profiles.settleReservations(settlement);
    const afterSecond = [gm.profiles.publicProfile(f.profiles.coinA.profile.id).balances.coin, gm.profiles.publicProfile(f.profiles.coinB.profile.id).balances.coin];
    assert.deepEqual(afterSecond, afterFirst);
    assert.deepEqual(afterFirst, [{ available: 1100, reserved: 0 }, { available: 900, reserved: 0 }]);

    const pokerSettlement = { reservations: f.pokerHold, profileId: f.profiles.pokerProfile.profile.id, stack: 240,
      operationKey: 'poker:cashout:PK01:poker-seat:PK-MATCH', roomCode: 'PK01', matchId: 'PK-MATCH' };
    gm.profiles.settlePokerSeat(pokerSettlement);
    const pokerAfterFirst = gm.profiles.publicProfile(f.profiles.pokerProfile.profile.id).balances.chip;
    gm.profiles.settlePokerSeat(pokerSettlement);
    assert.deepEqual(gm.profiles.publicProfile(f.profiles.pokerProfile.profile.id).balances.chip, pokerAfterFirst);
    assert.deepEqual(pokerAfterFirst, { available: 1040, reserved: 0 });
  } finally { stopManagerWithoutExportWrites(gm); }

  // A restore is a rehearsal in its own directory; it never changes the source fixture.
  for (const file of sourceFiles) assert.equal(hash(file), before.get(file), `source unchanged after restore/restart: ${file}`);
  assert.deepEqual(fs.readdirSync(f.dataDirectory).sort(), sourceDirectoryBefore);
});

test('rejects checksum edits, partial archives, manifest traversal, and schema values it does not understand', t => {
  const f = makeFixture(t);
  const backupDirectory = path.join(f.backupParent, 'backup-checks');
  createBackup(backupOptions(f, backupDirectory));

  const corrupted = path.join(f.root, 'corrupt');
  fs.cpSync(backupDirectory, corrupted, { recursive: true });
  fs.appendFileSync(path.join(corrupted, 'payload', 'rooms.bang.json'), ' ');
  assert.throws(() => verifyBackup(corrupted), error => error.code === 'CHECKSUM_MISMATCH');
  const rejectedRestore = path.join(f.root, 'must-not-publish');
  assert.throws(() => restoreBackup({ backupDirectory: corrupted, outputDirectory: rejectedRestore, projectRoot: f.projectRoot }), error => error.code === 'CHECKSUM_MISMATCH');
  assert.equal(fs.existsSync(rejectedRestore), false);

  const partial = path.join(f.root, 'partial');
  fs.cpSync(backupDirectory, partial, { recursive: true });
  const partialManifest = JSON.parse(fs.readFileSync(path.join(partial, 'manifest.json'), 'utf8'));
  partialManifest.state = 'partial';
  writeJson(path.join(partial, 'manifest.json'), partialManifest);
  assert.throws(() => verifyBackup(partial), error => error.code === 'ARCHIVE_PARTIAL');

  const traversal = path.join(f.root, 'traversal');
  fs.cpSync(backupDirectory, traversal, { recursive: true });
  const traversalManifest = JSON.parse(fs.readFileSync(path.join(traversal, 'manifest.json'), 'utf8'));
  traversalManifest.files[0].path = '../outside.sqlite';
  writeJson(path.join(traversal, 'manifest.json'), traversalManifest);
  assert.throws(() => verifyBackup(traversal), error => error.code === 'PATH_TRAVERSAL');

  const future = path.join(f.dataDirectory, 'future.sqlite');
  const futureStore = new ProfileStore({ databaseFile: future });
  futureStore.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(99, new Date().toISOString());
  futureStore.close();
  const futureOutput = path.join(f.backupParent, 'future-backup');
  assert.throws(() => createBackup(backupOptions(f, futureOutput, { databaseFile: future })), error => error.code === 'PROFILE_SCHEMA_UNKNOWN');
  assert.equal(fs.existsSync(futureOutput), false);
});

test('failed copy cleans its private partial stage and rejects overlapping/symlink paths', async t => {
  const f = makeFixture(t);
  const failedOutput = path.join(f.backupParent, 'failed-copy');
  let copies = 0;
  assert.throws(() => createBackup(backupOptions(f, failedOutput, { copyFile(source, destination) {
    copies += 1;
    if (copies === 3) throw new Error('injected copy failure');
    fs.copyFileSync(source, destination);
  } })), /injected copy failure/);
  assert.equal(fs.existsSync(failedOutput), false);
  assert.equal(fs.readdirSync(f.backupParent).some(name => name.startsWith('failed-copy.partial-')), false);

  assert.throws(() => createBackup(backupOptions(f, path.join(f.dataDirectory, 'nested-backup'))), error => error.code === 'PATH_OVERLAP');
  const goodBackup = path.join(f.backupParent, 'good');
  createBackup(backupOptions(f, goodBackup));
  assert.throws(() => restoreBackup({ backupDirectory: goodBackup, outputDirectory: path.join(f.dataDirectory, 'restore'), projectRoot: f.projectRoot }), error => error.code === 'PROTECTED_DATA_PATH');

  await t.test('symlink bundle roots are rejected when the host permits creating a link', t => {
    const link = path.join(f.root, 'backup-link');
    try { fs.symlinkSync(goodBackup, link, 'junction'); }
    catch (error) { t.skip(`symlink creation unavailable on this host: ${error.code || error.message}`); return; }
    assert.throws(() => verifyBackup(link), error => error.code === 'SYMLINK_REJECTED');
  });
});

test('default restore chooses a new sibling and never opens the source database for writing', t => {
  const f = makeFixture(t);
  const sourceBefore = hash(f.databaseFile);
  const backupDirectory = path.join(f.backupParent, 'default-output');
  createBackup(backupOptions(f, backupDirectory));
  const restored = restoreBackup({ backupDirectory, projectRoot: f.projectRoot, databaseFile: f.databaseFile, storageFile: f.storageFile,
    now: new Date('2026-10-06T01:02:03.000Z') });
  assert.equal(restored.directory, path.join(f.backupParent, 'default-output-restored-20261006T010203Z'));
  assert.equal(hash(f.databaseFile), sourceBefore);
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'data', 'profile-store.sqlite')), false);
});
