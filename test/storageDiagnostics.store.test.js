'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProfileStore } = require('../src/platform/profileStore');
const { StorageDiagnostics } = require('../src/platform/storageDiagnostics');

function fixture(t) {
  const diagnostics = new StorageDiagnostics({
    database: { kind: 'memory', fixture: true, integrity: 'unknown' },
    heldAudit: { total: 0, needsAttention: 0 },
  });
  diagnostics.registerSource({ id: 'profile-store', kind: 'sqlite-profile-ledger', mode: 'memory', fixture: true, authority: 'authoritative' });
  for (const gameId of ['tien-len', 'sam-loc', 'phom', 'poker']) diagnostics.registerSource({
    id: `snapshot:${gameId}`, gameId, kind: 'sqlite-room-snapshot', mode: 'memory', fixture: true, authority: 'authoritative',
  });
  diagnostics.registerSource({ id: 'manager:phom', gameId: 'phom', kind: 'fixed-game-manager', mode: 'memory', fixture: true, authority: 'authoritative' });
  const store = new ProfileStore({ databaseFile: ':memory:', storageDiagnostics: diagnostics, storageFixture: true });
  t.after(() => store.close());
  const health = store.storageHealth();
  assert.deepEqual(health, { database: 'memory', schemaVersion: 4, integrity: 'ok' });
  const report = store.auditFixedGameHolds();
  diagnostics.setHeldAudit({ total: store.heldReservationCount(), needsAttention: report.reduce((sum, item) => sum + (item.needsAttention ? item.holdCount : 0), 0) });
  return { diagnostics, store };
}

test('ProfileStore records its actual schema probe, snapshot validation, and transaction commit timestamps', t => {
  const { diagnostics, store } = fixture(t);
  const created = store.createProfile({ displayName: 'A04 read/write probe' });
  const status = diagnostics.getStatus();
  const profileSource = status.sources.find(source => source.id === 'profile-store');
  assert.ok(profileSource.operations.read.lastSuccessAt);
  assert.ok(profileSource.operations.commit.lastSuccessAt);
  assert.ok(profileSource.operations.write.lastSuccessAt);
  assert.equal(status.database, 'memory');
  assert.equal(status.safetyMode, 'memory-fixture');
  assert.equal(status.canStartWager, true);

  store.saveGameSnapshot({ gameId: 'phom', room: { code: 'A04X', gameId: 'phom', phase: 'WAITING', players: [] } });
  assert.equal(JSON.parse(store.gameSnapshots('phom')[0].stateJson).code, 'A04X');
  const snapshot = diagnostics.getStatus().sources.find(source => source.id === 'snapshot:phom');
  assert.ok(snapshot.operations.read.lastSuccessAt);
  assert.ok(snapshot.operations.commit.lastSuccessAt);
  assert.equal(created.profile.balances.coin.available, 1000);
});

test('SQLite commit failure rolls back the wallet, blocks new holds, and needs a later successful commit to recover', t => {
  const { diagnostics, store } = fixture(t);
  const profile = store.createProfile({ displayName: 'Commit fault' }).profile;
  const before = store.publicProfile(profile.id).balances.coin;
  const originalExec = store.db.exec.bind(store.db);
  let failCommit = true;
  store.db.exec = statement => {
    if (statement === 'COMMIT' && failCommit) { failCommit = false; const error = new Error('private raw database path must not escape'); error.code = 'ERR_SQLITE_ERROR'; throw error; }
    return originalExec(statement);
  };
  assert.throws(() => store.reserveMany({ reservations: [{ profileId: profile.id, amount: 100 }],
    operationKey: 'storage-commit-fault-01', roomCode: 'SAFE', currency: 'coin' }), { code: 'ERR_SQLITE_ERROR' });
  assert.deepEqual(store.publicProfile(profile.id).balances.coin, before, 'COMMIT fault rolls back both wallet columns');
  assert.equal(diagnostics.getStatus().canStartWager, false);
  const afterFault = store.publicProfile(profile.id).balances.coin;
  assert.throws(() => store.reserveMany({ reservations: [{ profileId: profile.id, amount: 100 }],
    operationKey: 'storage-commit-fault-02', roomCode: 'SAFE', currency: 'coin' }), { code: 'STORAGE_UNSAFE' });
  assert.deepEqual(store.publicProfile(profile.id).balances.coin, afterFault, 'the gate runs before a second wallet mutation');

  store.transaction(() => {});
  assert.equal(diagnostics.getStatus().canStartWager, true, 'a real later SQLite commit clears the matching commit error');
  const held = store.reserveMany({ reservations: [{ profileId: profile.id, amount: 100 }],
    operationKey: 'storage-commit-fault-01', roomCode: 'SAFE', currency: 'coin' });
  assert.equal(held.held.length, 1);
  assert.deepEqual(store.publicProfile(profile.id).balances.coin, { available: 900, reserved: 100 });
});

test('Phỏm manager/storage fault blocks fixed-game starts and Poker buy-ins before wallet changes, while refund/cash-out still work', t => {
  const { diagnostics, store } = fixture(t);
  const phomPlayers = [store.createProfile({ displayName: 'Phỏm A' }).profile, store.createProfile({ displayName: 'Phỏm B' }).profile];
  const poker = store.createProfile({ displayName: 'Poker' }).profile;
  const pokerHold = store.reserveMany({ reservations: [{ profileId: poker.id, amount: 200 }], operationKey: 'poker:buyin:a04-before-fault', roomCode: 'POKE' });
  const secondHold = store.reserveMany({ reservations: [{ profileId: poker.id, amount: 200 }], operationKey: 'poker:buyin:a04-existing-seat', roomCode: 'POKE' });
  const beforePhom = phomPlayers.map(player => store.publicProfile(player.id).balances.coin);
  const beforePoker = store.publicProfile(poker.id).balances.chip;
  diagnostics.setExternalFault('manager:phom', { operation: 'read', stage: 'manager-load', code: 'ROOM_MANAGER_STORAGE_ERROR' });
  assert.equal(diagnostics.getStatus().canStartWager, false);
  assert.throws(() => store.preflightFixedGameStart({ gameId: 'phom', stake: 10, profileIds: phomPlayers.map(player => player.id) }), { code: 'STORAGE_UNSAFE' });
  assert.throws(() => store.reserveMany({ reservations: [{ profileId: poker.id, amount: 100 }], operationKey: 'poker:buyin:a04-blocked', roomCode: 'POKE' }), { code: 'STORAGE_UNSAFE' });
  assert.deepEqual(phomPlayers.map(player => store.publicProfile(player.id).balances.coin), beforePhom);
  assert.deepEqual(store.publicProfile(poker.id).balances.chip, beforePoker);

  const released = store.releaseReservations({ reservations: [{ reservationId: pokerHold.held[0].reservationId }],
    operationKey: 'poker:refund:a04-allowed', roomCode: 'POKE' });
  assert.equal(released.released.length, 1);
  const cashout = store.settlePokerSeat({ reservations: [{ reservationId: secondHold.held[0].reservationId }], profileId: poker.id,
    stack: 200, operationKey: 'poker:cashout:a04-allowed', roomCode: 'POKE' });
  assert.equal(cashout.stack, 200);
  assert.equal(store.publicProfile(poker.id).balances.chip.available, 1000);
});

test('malformed committed snapshot is reported and only a parsed matching snapshot clears the read fault', t => {
  const { diagnostics, store } = fixture(t);
  store.saveGameSnapshot({ gameId: 'phom', room: { code: 'A04Y', gameId: 'phom', phase: 'TURN', players: [] } });
  store.db.prepare("UPDATE game_snapshots SET state_json = 'not-json' WHERE game_id = 'phom' AND room_code = 'A04Y'").run();
  const invalid = store.gameSnapshots('phom');
  assert.equal(invalid.length, 1);
  assert.equal(diagnostics.getStatus().canStartWager, false);

  store.saveGameSnapshot({ gameId: 'phom', room: { code: 'A04Y', gameId: 'phom', phase: 'TURN', players: [] } });
  assert.equal(store.gameSnapshots('phom')[0].roomCode, 'A04Y');
  assert.equal(diagnostics.getStatus().canStartWager, true);
});
