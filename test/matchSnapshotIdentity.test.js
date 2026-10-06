'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../src/platform/profileStore');

for (const variant of ['classic-local-v1', 'classic-108-v1']) {
  test(`${variant} completion keeps winner identity after another hand and database restart`, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-match-identity-'));
    const databaseFile = path.join(directory, 'profiles.sqlite');
    let store = new ProfileStore({ databaseFile });
    t.after(() => {
      store.close();
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const alice = store.createProfile({ displayName: 'Alice' });
    const bob = store.createProfile({ displayName: 'Bob' });
    const matchId = `match-${variant}`;
    const players = [
      { id: 'winning-seat', profileId: alice.profile.id, token: 'private-seat-token', hand: ['private-card'] },
      { id: 'losing-seat', profileId: bob.profile.id },
      { id: 'unregistered-seat', profileId: 'not-a-match-participant' },
    ];
    const room = { code: 'UNO1', gameId: 'uno', phase: 'RESULT', variant, matchId, players,
      ...(variant === 'classic-local-v1' ? { uno: { matchId, phase: 'RESULT', variant } } : {}) };
    store.syncRoom({ gameId: 'uno', room });
    const completion = { gameId: 'uno', roomCode: room.code, matchId,
      players: players.slice(0, 2).map(player => ({ profileId: player.profileId })), result: { winnerId: 'winning-seat' } };
    assert.equal(store.recordCompletedMatch(completion).recorded, true);
    const snapshot = () => JSON.parse(store.db.prepare('SELECT snapshot_json FROM match_snapshots WHERE match_id = ?').get(matchId).snapshot_json);
    const expected = [{ seatId: 'winning-seat', profileId: alice.profile.id }, { seatId: 'losing-seat', profileId: bob.profile.id }];
    assert.equal(snapshot().variant, variant);
    assert.deepEqual(snapshot().participants, expected);
    assert.doesNotMatch(JSON.stringify(snapshot()), /private-seat-token|private-card|not-a-match-participant/);
    store.syncRoom({ gameId: 'uno', room: { ...room, matchId: 'next-hand', phase: 'WAITING',
      uno: { matchId: 'next-hand', phase: 'WAITING' }, players: [players[1]] } });
    assert.equal(store.recordCompletedMatch(completion).recorded, false);
    store.close();
    store = new ProfileStore({ databaseFile });
    assert.deepEqual(snapshot().participants, expected);
    assert.equal(snapshot().participants.find(player => player.seatId === snapshot().result.winnerId).profileId, alice.profile.id);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM match_snapshots WHERE match_id = ?').get(matchId).count, 1);
  });
}

test('a completion cannot borrow identity or variant from another persisted UNO match', t => {
  const store = new ProfileStore({ databaseFile: ':memory:' });
  t.after(() => store.close());
  const alice = store.createProfile({ displayName: 'Alice' });
  store.syncRoom({ gameId: 'uno', room: { code: 'UNO2', gameId: 'uno', matchId: 'unrelated',
    variant: 'classic-local-v1', players: [{ id: 'seat', profileId: alice.profile.id }] } });
  store.recordCompletedMatch({ gameId: 'uno', roomCode: 'UNO2', matchId: 'completed-old',
    players: [{ profileId: alice.profile.id }], result: { winnerId: 'seat' } });
  const snapshot = JSON.parse(store.db.prepare('SELECT snapshot_json FROM match_snapshots WHERE match_id = ?').get('completed-old').snapshot_json);
  assert.equal(snapshot.participants, undefined);
  assert.equal(snapshot.variant, undefined);
});
