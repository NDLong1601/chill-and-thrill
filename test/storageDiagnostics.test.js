'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StorageDiagnostics } = require('../src/platform/storageDiagnostics');

function fixture() {
  let now = Date.parse('2026-10-06T08:00:00.000Z');
  const diagnostics = new StorageDiagnostics({
    clock: () => new Date(now),
    database: { kind: 'sqlite', schemaVersion: 3, integrity: 'ok', operational: true },
    heldAudit: { total: 4, needsAttention: 0 },
  });
  return { diagnostics, advance: milliseconds => { now += milliseconds; } };
}

test('reports one source per game/UNO variant with timestamps and keeps API compatibility fields', () => {
  const { diagnostics, advance } = fixture();
  for (const [id, gameId, variant] of [
    ['gang', 'the-gang', null], ['uno-classic', 'uno', 'classic'], ['uno-advanced', 'uno', 'advanced'],
    ['tien-len', 'tien-len', null], ['poker', 'poker', null], ['sam-loc', 'sam-loc', null], ['phom', 'phom', null], ['bang', 'bang', null],
  ]) diagnostics.registerSource({ id: `manager:${id}`, gameId, variant, kind: 'room-json', mode: 'persisted', authority: 'authoritative' });

  diagnostics.begin('manager:phom', 'read', 'load');
  advance(25);
  diagnostics.succeed('manager:phom', 'read', { stage: 'validated', recoveryVerified: true });
  const status = diagnostics.getStatus();
  assert.deepEqual({ scope: status.scope, database: status.database, schemaVersion: status.schemaVersion, integrity: status.integrity, error: status.error }, {
    scope: 'local-server', database: 'sqlite', schemaVersion: 3, integrity: 'ok', error: null,
  });
  assert.equal(status.sources.length, 8);
  assert.deepEqual(status.sources.filter(source => source.gameId === 'uno').map(source => source.variant), ['classic', 'advanced']);
  assert.equal(status.sources.find(source => source.id === 'manager:phom').operations.read.lastSuccessAt, '2026-10-06T08:00:00.025Z');
});

test('a JSON export failure warns while the authoritative SQLite commit remains safe for betting', () => {
  const { diagnostics } = fixture();
  diagnostics.registerSource({ id: 'snapshot:phom', gameId: 'phom', kind: 'sqlite-snapshot', mode: 'persisted', authority: 'authoritative' });
  diagnostics.registerSource({ id: 'export:phom', gameId: 'phom', kind: 'room-json-export', mode: 'persisted', authority: 'export' });
  diagnostics.begin('snapshot:phom', 'write', 'snapshot');
  diagnostics.succeed('snapshot:phom', 'write');
  diagnostics.begin('snapshot:phom', 'commit', 'sqlite-commit');
  diagnostics.succeed('snapshot:phom', 'commit');
  diagnostics.begin('export:phom', 'export', 'rename');
  diagnostics.fail('export:phom', 'export', { stage: 'rename', code: 'ROOM_JSON_EXPORT_FAILED', message: 'C:\\private\\profiles.sqlite token=secret' });

  const status = diagnostics.getStatus();
  assert.equal(status.status, 'warning');
  assert.equal(status.canStartWager, true);
  assert.equal(status.error, null);
  assert.equal(status.warnings[0].code, 'ROOM_JSON_EXPORT_FAILED');
  assert.match(status.sources.find(source => source.id === 'snapshot:phom').operations.commit.lastSuccessAt, /^2026-/);
  assert.doesNotMatch(JSON.stringify(status), /private|profiles\.sqlite|secret|message/);

  diagnostics.begin('export:phom', 'export', 'retry');
  diagnostics.succeed('export:phom', 'export', { stage: 'retry' });
  assert.equal(diagnostics.getStatus().warnings.some(item => item.code === 'ROOM_JSON_EXPORT_FAILED'), false);
  assert.equal(diagnostics.getStatus().canStartWager, true);
});

test('a failed legacy JSON fallback stays visible as a warning when validated SQLite remains authoritative', () => {
  const { diagnostics } = fixture();
  diagnostics.registerSource({ id: 'snapshot:phom', gameId: 'phom', kind: 'sqlite-snapshot', authority: 'authoritative' });
  diagnostics.registerSource({ id: 'legacy:phom', gameId: 'phom', kind: 'legacy-json', authority: 'legacy-fallback' });
  diagnostics.begin('snapshot:phom', 'read', 'restore');
  diagnostics.succeed('snapshot:phom', 'read', { recoveryVerified: true });
  diagnostics.begin('legacy:phom', 'read', 'legacy-fallback');
  diagnostics.fail('legacy:phom', 'read', { code: 'LEGACY_ROOM_READ_FAILED' });
  const status = diagnostics.getStatus();
  assert.equal(status.canStartWager, true);
  assert.equal(status.failures.length, 0);
  assert.equal(status.warnings[0].code, 'LEGACY_ROOM_READ_FAILED');
});

test('authoritative write and commit faults block new wagers; only a successful matching operation clears them', () => {
  for (const operation of ['write', 'commit']) {
    const { diagnostics } = fixture();
    diagnostics.registerSource({ id: 'snapshot:sam-loc', gameId: 'sam-loc', kind: 'sqlite-snapshot', authority: 'authoritative' });
    diagnostics.begin('snapshot:sam-loc', operation, 'snapshot');
    diagnostics.fail('snapshot:sam-loc', operation, { code: 'SQLITE_BUSY' });
    let status = diagnostics.getStatus();
    assert.equal(status.canStartWager, false, operation);
    assert.equal(status.failures[0].operation, operation);
    diagnostics.begin('snapshot:sam-loc', 'export', 'rename');
    diagnostics.succeed('snapshot:sam-loc', 'export');
    assert.equal(diagnostics.getStatus().canStartWager, false, 'unrelated export success cannot clear authoritative fault');
    diagnostics.begin('snapshot:sam-loc', operation, 'retry');
    diagnostics.succeed('snapshot:sam-loc', operation, { stage: 'retry' });
    status = diagnostics.getStatus();
    assert.equal(status.canStartWager, true, operation);
    assert.equal(status.sources[0].operations[operation].lastError, null);
  }
});

test('a damaged authoritative read remains unsafe until validated recovery is explicitly confirmed', () => {
  const { diagnostics } = fixture();
  diagnostics.registerSource({ id: 'snapshot:tien-len', gameId: 'tien-len', kind: 'sqlite-snapshot', authority: 'authoritative' });
  diagnostics.begin('snapshot:tien-len', 'read', 'restore');
  diagnostics.fail('snapshot:tien-len', 'read', { stage: 'parse', code: 'SNAPSHOT_INVALID' });
  assert.equal(diagnostics.getStatus().canStartWager, false);

  diagnostics.begin('snapshot:tien-len', 'read', 'retry');
  diagnostics.succeed('snapshot:tien-len', 'read', { recoveryVerified: false });
  assert.equal(diagnostics.getStatus().failures[0].state, 'recovery-required');
  assert.equal(diagnostics.getStatus().canStartWager, false);

  diagnostics.begin('snapshot:tien-len', 'read', 'validated-recovery');
  diagnostics.succeed('snapshot:tien-len', 'read', { recoveryVerified: true });
  assert.equal(diagnostics.getStatus().canStartWager, true);
  assert.equal(diagnostics.getStatus().failures.length, 0);
});

test('database integrity, memory mode, and unresolved held audit affect the betting gate safely', () => {
  const { diagnostics } = fixture();
  diagnostics.registerSource({ id: 'store:profiles', kind: 'profile-store', mode: 'persisted', authority: 'authoritative' });
  diagnostics.setDatabaseStatus({ integrity: 'error', operational: false, errorCode: 'SQLITE_CORRUPT' });
  assert.equal(diagnostics.getStatus().canStartWager, false);
  diagnostics.setDatabaseStatus({ integrity: 'ok', operational: true });
  diagnostics.setHeldAudit({ total: 5, inconsistent: 1 });
  assert.equal(diagnostics.getStatus().canStartWager, false);
  assert.equal(diagnostics.getStatus().heldAudit.needsAttention, 1);
  diagnostics.setHeldAudit({ total: 5, needsAttention: 0 });
  assert.equal(diagnostics.getStatus().canStartWager, true);

  const memory = new (require('../src/platform/storageDiagnostics').StorageDiagnostics)({
    database: { kind: 'memory', fixture: false, integrity: 'ok', operational: true },
  });
  assert.equal(memory.getStatus().safetyMode, 'memory');
  assert.equal(memory.getStatus().canStartWager, false);
  const testFixture = new (require('../src/platform/storageDiagnostics').StorageDiagnostics)({
    database: { kind: 'memory', fixture: true, integrity: 'ok', operational: true },
    heldAudit: { total: 0, needsAttention: 0 },
  });
  assert.equal(testFixture.getStatus().safetyMode, 'memory-fixture');
  assert.equal(testFixture.getStatus().canStartWager, true);
});

test('external Phỏm manager errors block bets without inventing operation timestamps', () => {
  const { diagnostics } = fixture();
  diagnostics.registerSource({ id: 'manager:phom', gameId: 'phom', kind: 'room-snapshot-manager', authority: 'authoritative' });
  diagnostics.setExternalFault('manager:phom', { operation: 'read', stage: 'load', code: 'ROOM_MANAGER_STORAGE_ERROR' });
  const status = diagnostics.getStatus();
  assert.equal(status.canStartWager, false);
  assert.equal(status.failures[0].gameId, 'phom');
  assert.equal(status.failures[0].externallyReported, true);
  assert.equal(status.failures[0].at, undefined);
  diagnostics.setExternalFault('manager:phom', null);
  assert.equal(diagnostics.getStatus().canStartWager, true);
});

test('the current synchronous wallet transaction can check safety without blocking itself on its pending commit', () => {
  const { diagnostics } = fixture();
  diagnostics.registerSource({ id: 'sqlite:profiles', kind: 'sqlite', authority: 'authoritative' });
  diagnostics.begin('sqlite:profiles', 'write', 'wallet-transaction');
  diagnostics.begin('sqlite:profiles', 'commit', 'wallet-transaction');
  assert.equal(diagnostics.getStatus().canStartWager, false);
  assert.equal(diagnostics.getStatus({ ignorePending: true }).canStartWager, true);
  diagnostics.fail('sqlite:profiles', 'commit', { code: 'SQLITE_COMMIT_FAILED' });
  assert.equal(diagnostics.getStatus({ ignorePending: true }).canStartWager, false);
});

test('local diagnostics and public status never expose paths, profile data, tokens, or raw exception text', () => {
  const { diagnostics } = fixture();
  diagnostics.registerSource({ id: 'snapshot:phom', gameId: 'phom', kind: 'sqlite-snapshot', authority: 'authoritative' });
  diagnostics.begin('snapshot:phom', 'read', 'restore');
  diagnostics.fail('snapshot:phom', 'read', {
    stage: 'restore', code: 'SNAPSHOT_READ_FAILED',
    message: 'C:\\Users\\PC\\Documents\\private.sqlite token=abcd profileId=p-123 state_json=hidden hand=2H',
  });
  for (const status of [diagnostics.getStatus(), diagnostics.getLocalDiagnostics()]) {
    const json = JSON.stringify(status);
    assert.doesNotMatch(json, /Users|private\.sqlite|token|abcd|profileId|p-123|state_json|2H|message/);
    assert.equal(status.failures[0].code, 'SNAPSHOT_READ_FAILED');
  }
});
