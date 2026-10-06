'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGameServer } = require('../src/httpServer');
const { chooseUnoAction, chooseTienLenAction } = require('../src/platform/practiceBotPolicy');

test('production practice routes enforce capabilities, use real validators and leave the shared ledger unchanged', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-c02-api-'));
  const game = createGameServer({ storageFile: path.join(directory, 'rooms.json'), databaseFile: path.join(directory, 'profiles.sqlite') });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await game.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${game.server.address().port}`;
  const profile = game.gm.profiles.createProfile({ displayName: 'Real wallet fixture' });
  const counts = () => Object.fromEntries(['wallets', 'wallet_ledger', 'wallet_operations', 'reservations', 'rooms', 'matches', 'mission_claims', 'game_snapshots'].map(table => [table, game.gm.profiles.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  const before = { wallet: game.gm.profiles.publicProfile(profile.profile.id), counts: counts() };
  async function request(url, body, capability, method = body ? 'POST' : 'GET') {
    const response = await fetch(base + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(capability ? { Authorization: `Bearer ${capability}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const unsupported = await request('/api/practice/sessions', { gameId: 'uno', variant: 'classic-108-v1' });
  assert.equal(unsupported.status, 422);
  assert.equal(unsupported.body.error.code, 'UNSUPPORTED_VARIANT');
  for (const [gameId, variant] of [['uno', 'classic-local-v1'], ['tien-len', 'south-v1']]) {
    const created = await request('/api/practice/sessions', { gameId, variant, seed: `http-c02-${gameId}` });
    assert.equal(created.body.ok, true);
    const { id, capability } = created.body.session;
    const url = `/api/practice/sessions/${id}`;
    const denied = await request(url);
    assert.equal(denied.status, 403);
    assert.equal(Object.hasOwn(denied.body, 'state'), false);
    const wrong = await request(url, undefined, crypto.randomBytes(32).toString('base64url'));
    assert.equal(wrong.status, 403);
    let state = created.body.state;
    for (let index = 0; index < 8 && state.phase !== 'RESULT'; index++) {
      const projection = { schemaVersion: 1, gameId, variant, matchId: state.matchId, revision: state.revision,
        seatId: state.player.id, ownHand: state.player.hand, publicState: state.publicState,
        ...(gameId === 'uno' ? { legalActions: state.player.availableActions } : {}) };
      const action = gameId === 'uno' ? chooseUnoAction(projection) : chooseTienLenAction(projection);
      assert.ok(action);
      const envelope = { ...action, matchId: state.matchId, expectedRevision: state.revision, actionId: `http-c02-${gameId}-${index}` };
      const applied = await request(url + '/actions', envelope, capability);
      assert.equal(applied.body.ok, true, JSON.stringify(applied.body.error));
      const retried = await request(url + '/actions', envelope, capability);
      assert.equal(retried.body.ok, true);
      assert.equal(retried.body.state.revision, applied.body.state.revision);
      state = applied.body.state;
    }
    const serialized = JSON.stringify((await request(url, undefined, capability)).body);
    assert.equal(serialized.includes(profile.profile.id), false);
    assert.equal(serialized.includes('profileToken'), false);
    assert.equal(serialized.includes('reservations'), false);
    assert.equal((await request(url, undefined, capability, 'DELETE')).body.ok, true);
  }
  assert.equal(game.practice.inspectSessionCount(), 0);
  assert.deepEqual({ wallet: game.gm.profiles.publicProfile(profile.profile.id), counts: counts() }, before);
  assert.equal(game.gm.publicRooms().length, 0);
});
