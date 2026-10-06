'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore, StoreError, vietnamDay } = require('../src/platform/profileStore');

function temporaryStore(t, legacyRooms = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-m3-'));
  const store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite'), legacyRoomsFile: legacyRooms });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store };
}

test('M3 profile identity survives a nickname change and recovery without exposing a token hash', t => {
  const { store } = temporaryStore(t);
  const created = store.createProfile({ displayName: 'Lan', avatar: '🎲' });
  assert.equal(created.profile.wallet.available, 1000);
  assert.equal(store.authenticate(created.sessionToken).id, created.profile.id);
  const renamed = store.updateProfile(created.profile.id, { displayName: 'Lan Mới', avatar: '💻' });
  assert.equal(renamed.displayName, 'Lan Mới');
  assert.equal(renamed.wallet.available, 1000);
  const recovered = store.recoverProfile(created.profile.id, created.recoveryCode);
  assert.equal(recovered.profile.id, created.profile.id);
  assert.equal(store.authenticate(recovered.sessionToken).id, created.profile.id);
  assert.equal(JSON.stringify(store.profileState(created.profile.id)).includes(created.sessionToken), false);
});

test('M3 reserves chip atomically, has idempotency protection, and conserves chips on settlement', t => {
  const { store } = temporaryStore(t);
  const first = store.createProfile({ displayName: 'A' }), second = store.createProfile({ displayName: 'B' });
  const failed = () => store.reserveMany({
    operationKey: 'reserve-insufficient-0001', roomCode: 'FAIL', matchId: 'm-fail',
    reservations: [{ profileId: first.profile.id, amount: 100 }, { profileId: second.profile.id, amount: 1001 }],
  });
  assert.throws(failed, error => error instanceof StoreError && error.code === 'INSUFFICIENT_CHIPS');
  assert.deepEqual(store.publicProfile(first.profile.id).wallet, { available: 1000, reserved: 0 });
  assert.deepEqual(store.publicProfile(second.profile.id).wallet, { available: 1000, reserved: 0 });

  const held = store.reserveMany({
    operationKey: 'reserve-table-0001', roomCode: 'ROOM', matchId: 'm-win',
    reservations: [{ profileId: first.profile.id, amount: 100 }, { profileId: second.profile.id, amount: 100 }],
  });
  assert.equal(held.idempotent, false);
  assert.equal(store.reserveMany({
    operationKey: 'reserve-table-0001', roomCode: 'ROOM', matchId: 'm-win',
    reservations: [{ profileId: first.profile.id, amount: 100 }, { profileId: second.profile.id, amount: 100 }],
  }).idempotent, true);
  assert.throws(() => store.reserveMany({
    operationKey: 'reserve-table-0001', roomCode: 'ROOM', matchId: 'm-win',
    reservations: [{ profileId: first.profile.id, amount: 101 }, { profileId: second.profile.id, amount: 100 }],
  }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.throws(() => store.reserveMany({
    operationKey: 'reserve-other-table-0001', roomCode: 'OTHR', matchId: 'm-other',
    reservations: [{ profileId: first.profile.id, amount: 1 }],
  }), error => error.code === 'CHIP_SEAT_ACTIVE');
  store.settleWinnerTakesPot({ reservations: held.held, winnerProfileId: first.profile.id, operationKey: 'settle-table-0001', roomCode: 'ROOM', matchId: 'm-win' });
  assert.deepEqual(store.publicProfile(first.profile.id).wallet, { available: 1100, reserved: 0 });
  assert.deepEqual(store.publicProfile(second.profile.id).wallet, { available: 900, reserved: 0 });
  assert.equal(store.publicProfile(first.profile.id).wallet.available + store.publicProfile(second.profile.id).wallet.available, 2000);
});

test('Poker cash-out atomically returns a redistributed table stack to each wallet', t => {
  const { store } = temporaryStore(t);
  const first = store.createProfile({ displayName: 'Stack A' }), second = store.createProfile({ displayName: 'Stack B' });
  const firstHold = store.reserveMany({ operationKey: 'poker-buyin-a-0001', roomCode: 'PKR1', matchId: 'hand-1', reservations: [{ profileId: first.profile.id, amount: 200 }] });
  const secondHold = store.reserveMany({ operationKey: 'poker-buyin-b-0001', roomCode: 'PKR1', matchId: 'hand-1', reservations: [{ profileId: second.profile.id, amount: 200 }] });
  const paidA = store.settlePokerSeat({ reservations: firstHold.held, profileId: first.profile.id, stack: 400, operationKey: 'poker-cashout-a-0001', roomCode: 'PKR1', matchId: 'hand-1' });
  const paidB = store.settlePokerSeat({ reservations: secondHold.held, profileId: second.profile.id, stack: 0, operationKey: 'poker-cashout-b-0001', roomCode: 'PKR1', matchId: 'hand-1' });
  assert.equal(paidA.wallet.available, 1200); assert.equal(paidB.wallet.available, 800);
  assert.equal(store.settlePokerSeat({ reservations: firstHold.held, profileId: first.profile.id, stack: 400, operationKey: 'poker-cashout-a-0001', roomCode: 'PKR1', matchId: 'hand-1' }).idempotent, true);
  assert.equal(store.publicProfile(first.profile.id).wallet.available + store.publicProfile(second.profile.id).wallet.available, 2000);
});

test('M3 match replay advances missions once and an atomic claim cannot mint twice', t => {
  const { store } = temporaryStore(t);
  const player = store.createProfile({ displayName: 'Mission' });
  const match = { matchId: 'm-uno-0001', gameId: 'uno', roomCode: 'UNO1', players: [{ profileId: player.profile.id, outcome: 'WIN' }], result: { winner: player.profile.id }, completedAt: new Date().toISOString() };
  assert.equal(store.recordCompletedMatch(match).recorded, true);
  assert.equal(store.recordCompletedMatch(match).recorded, false);
  const mission = store.getMissions(player.profile.id).find(item => item.id === 'daily_match');
  assert.equal(mission.progress, 1);
  const firstClaim = store.claimMission(player.profile.id, 'daily_match', 1);
  const secondClaim = store.claimMission(player.profile.id, 'daily_match', 1);
  assert.equal(firstClaim.reward, 100);
  assert.equal(secondClaim.idempotent, true);
  assert.equal(store.publicProfile(player.profile.id).balances.coin.available, 1100);
  assert.equal(store.publicProfile(player.profile.id).wallet.available, 1000);
  const oldDay = '2026-10-01T16:30:00.000Z';
  assert.equal(vietnamDay(oldDay), '2026-10-01');
  store.recordCompletedMatch({ ...match, matchId: 'm-old-day-0001', completedAt: oldDay });
  assert.equal(store.getMissions(player.profile.id).find(item => item.id === 'daily_match').progress, 1);
});

test('M3 copies and imports a legacy rooms file without merging people by nickname', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-legacy-'));
  const legacyFile = path.join(directory, 'rooms.json');
  fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, rooms: [{ code: 'ABCD', phase: 'WAITING', updatedAt: Date.now(), players: [
    { id: 'legacy-one', name: 'Trùng tên', isHost: true }, { id: 'legacy-two', name: 'Trùng tên', isHost: false },
  ] }] }));
  const store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite'), legacyRoomsFile: legacyFile });
  const count = store.db.prepare('SELECT COUNT(*) AS count FROM room_members WHERE room_id = ?').get('legacy:ABCD').count;
  assert.equal(count, 2);
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith('rooms.json.m3-backup-')), true);
  store.close();
  const reopened = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite'), legacyRoomsFile: legacyFile });
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM room_members WHERE room_id = ?').get('legacy:ABCD').count, 2);
  t.after(() => { reopened.close(); fs.rmSync(directory, { recursive: true, force: true }); });
});
