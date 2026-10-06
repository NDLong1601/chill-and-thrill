'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGameServer } = require('../src/httpServer');
const { ProfileStore } = require('../src/platform/profileStore');

async function fixture(t, corruptFile) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-a04-product-'));
  const storageFile = path.join(directory, 'rooms.json');
  const databaseFile = path.join(directory, 'profiles.sqlite');
  let game;
  t.after(async () => {
    if (game) await game.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  // Complete the legacy import first, then corrupt the saved recovery input.
  // Otherwise the import correctly refuses to construct a writable server.
  fs.writeFileSync(storageFile, JSON.stringify({ version: 2, rooms: [] }));
  const initialized = new ProfileStore({ databaseFile, legacyRoomsFile: storageFile });
  initialized.close();
  if (corruptFile) fs.writeFileSync(path.join(directory, corruptFile), '{ broken JSON');
  game = createGameServer({ storageFile, databaseFile });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  return { game, directory, url, status: async () => {
    const response = await fetch(`${url}/api/storage/status`);
    assert.equal(response.status, 200);
    return response.json();
  } };
}

const writeSources = [
  { manager: 'gang', source: 'manager:the-gang', blocked: false },
  { manager: 'gang', source: 'manager:uno-classic', blocked: false },
  { manager: 'uno', source: 'manager:uno-advanced', blocked: false },
  { manager: 'bang', source: 'manager:bang', blocked: false },
  { manager: 'tienLen', source: 'export:tien-len', blocked: false },
  { manager: 'samLoc', source: 'export:sam-loc', blocked: false },
  { manager: 'phom', source: 'export:phom', blocked: false },
  { manager: 'poker', source: 'export:poker', blocked: false },
];

for (const spec of writeSources) test(`A04 API reports actual ${spec.source} write failure and matching recovery`, async t => {
  const f = await fixture(t), manager = f.game.gm[spec.manager];
  assert.equal((await f.status()).canStartWager, true);
  const originalRename = fs.renameSync;
  fs.renameSync = function(source, destination) {
    if (String(destination) === manager.storageFile) {
      const error = new Error(`private disk path ${manager.storageFile}`);
      error.code = 'EACCES';
      throw error;
    }
    return Reflect.apply(originalRename, fs, [source, destination]);
  };
  try { manager.flush(); } finally { fs.renameSync = originalRename; }
  const failed = await f.status();
  assert.equal(failed.integrity, 'ok');
  assert.equal(failed.canStartWager, !spec.blocked);
  const source = failed.sources.find(source => source.id === spec.source);
  const operation = spec.blocked ? 'write' : 'export';
  assert.equal(source.operations[operation].state, 'error');
  assert.ok(source.operations[operation].lastError.at);
  assert.equal(JSON.stringify(failed).includes(manager.storageFile), false);
  // A healthy SQL read alone cannot clear an unresolved JSON write/export.
  assert.equal((await f.status()).sources.find(source => source.id === spec.source).operations[operation].state, 'error');
  manager.flush();
  const recovered = await f.status();
  assert.equal(recovered.canStartWager, true);
  assert.equal(recovered.sources.find(source => source.id === spec.source).operations[operation].state, 'ok');
});

for (const spec of [
  { file: 'rooms.json', manager: 'gang' },
  { file: 'rooms.uno.json', manager: 'uno' },
  { file: 'rooms.bang.json', manager: 'bang' },
  { file: 'rooms.tien-len.json', manager: 'tienLen' },
  { file: 'rooms.sam-loc.json', manager: 'samLoc' },
  { file: 'rooms.phom.json', manager: 'phom' },
]) test(`A04 API exposes corrupt ${spec.manager} recovery input and preserves the source file`, async t => {
  const f = await fixture(t, spec.file);
  const status = await f.status();
  assert.equal(status.canStartWager, false);
  assert.equal(status.integrity, 'ok');
  assert.ok(status.failures.length > 0);
  assert.equal(fs.readFileSync(path.join(f.directory, spec.file), 'utf8'), '{ broken JSON');
});

test('A04 direct wager gate refreshes a newly failed manager without a preceding HTTP status request', async t => {
  const f = await fixture(t), store = f.game.gm.profiles;
  const created = store.createProfile({ displayName: 'Private owner', avatar: '🎲' });
  const before = store.publicProfile(created.profile.id).balances.coin;
  f.game.gm.phom.storageError = true;
  assert.throws(() => store.reserveMany({ reservations: [{ profileId: created.profile.id, amount: 10 }],
    currency: 'coin', operationKey: crypto.randomUUID(), roomCode: 'TEST' }), error => error.code === 'STORAGE_UNSAFE');
  assert.deepEqual(store.publicProfile(created.profile.id).balances.coin, before);
  const status = await f.status();
  assert.equal(status.canStartWager, false);
  const publicText = JSON.stringify(status);
  for (const secret of [created.profile.id, created.sessionToken, created.recoveryCode, f.directory, 'Private owner']) {
    assert.equal(publicText.includes(secret), false);
  }
  assert.equal(status.scope, 'local-server');
  assert.equal(status.database, 'sqlite');
  assert.equal(typeof status.schemaVersion, 'number');
  assert.equal(status.heldAudit.total, 0);
});

test('A04 Poker legacy JSON read errors have real timestamps while healthy SQL remains authoritative', async t => {
  const f = await fixture(t, 'rooms.poker.json');
  const status = await f.status();
  assert.equal(status.integrity, 'ok');
  assert.equal(status.canStartWager, true);
  const read = status.sources.find(source => source.id === 'manager:poker-json').operations.read;
  assert.equal(read.state, 'error');
  assert.equal(read.lastError.code, 'LEGACY_ROOM_READ_FAILED');
  assert.ok(read.lastError.at);
  assert.equal(fs.readFileSync(path.join(f.directory, 'rooms.poker.json'), 'utf8'), '{ broken JSON');
});

test('A04 counts orphan Poker holds read-only, blocks new wagers, and still permits explicit release', async t => {
  const f = await fixture(t), store = f.game.gm.profiles;
  const profile = store.createProfile({ displayName: 'Orphan owner' }).profile;
  const reserved = store.reserveMany({ reservations: [{ profileId: profile.id, amount: 40 }], roomCode: 'LOST',
    operationKey: `poker:buyin:LOST:${profile.id}:${crypto.randomUUID()}` });
  const before = store.publicProfile(profile.id).wallet;
  const status = await f.status();
  assert.deepEqual({ total: status.heldAudit.total, needsAttention: status.heldAudit.needsAttention }, { total: 1, needsAttention: 1 });
  assert.equal(status.canStartWager, false);
  assert.deepEqual(store.publicProfile(profile.id).wallet, before);
  assert.throws(() => store.reserveMany({ reservations: [{ profileId: profile.id, amount: 10 }],
    roomCode: 'NEXT', operationKey: crypto.randomUUID() }), error => error.code === 'STORAGE_UNSAFE');
  store.releaseReservations({ reservations: reserved.held, operationKey: crypto.randomUUID(), roomCode: 'LOST' });
  assert.equal((await f.status()).canStartWager, true);
  assert.equal(store.publicProfile(profile.id).wallet.reserved, 0);
});

test('A04 accepts a live Poker buy-in linked to its committed seat across different hand IDs', async t => {
  const f = await fixture(t), store = f.game.gm.profiles, manager = f.game.gm.poker;
  const profile = store.createProfile({ displayName: 'Poker owner' }).profile;
  const client = { id: crypto.randomUUID(), data: { profile }, join() {}, leave() {}, emit() {} };
  f.game.io.sockets.sockets.set(client.id, client);
  const created = manager.createRoom(client, profile.displayName, '🎲');
  const room = manager.rooms.get(created.roomCode);
  const result = manager.action(client, room.code, { action: 'buy_in', amount: 200,
    actionId: crypto.randomUUID(), expectedRevision: room.revision });
  assert.equal(result?.error, undefined);
  room.matchId = crypto.randomUUID();
  manager.persistRoom(room);
  const status = await f.status();
  assert.equal(status.heldAudit.total, 1);
  assert.equal(status.heldAudit.needsAttention, 0);
  assert.equal(status.canStartWager, true);
  assert.equal(store.publicProfile(profile.id).wallet.reserved, 200);
  f.game.io.sockets.sockets.delete(client.id);
});
