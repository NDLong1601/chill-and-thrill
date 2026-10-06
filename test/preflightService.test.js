'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ProfileStore } = require('../src/platform/profileStore');
const { CURRENCIES } = require('../src/platform/currencies');
const { TienLenManager } = require('../src/games/tien-len/tienLenEngine');
const { SamLocManager } = require('../src/games/sam-loc/samLocEngine');
const { PhomManager } = require('../src/games/phom/phomEngine');
const { PokerManager } = require('../src/games/poker/pokerEngine');
const { UnoManager } = require('../src/games/uno/unoEngine');
const { BangManager } = require('../src/games/bang/bangEngine');
const { GameManager } = require('../src/gameEngine');
const { buildRoomPreflight } = require('../src/platform/preflightService');

const temporaryDirectory = () => fs.mkdtempSync(path.join(__dirname, '..', 'test-results', 'preflight-'));
function fakeIo() {
  const sockets = new Map();
  return { sockets: { sockets }, to: () => ({ emit() {} }) };
}
function fakeSocket(id, profile) {
  return { id, profile, data: { profile }, events: [], join() {}, leave() {}, emit(event, payload) { this.events.push({ event, payload }); } };
}
function fixture(t) {
  const directory = temporaryDirectory();
  const store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite') });
  const io = fakeIo();
  const managers = [];
  t.after(() => {
    for (const manager of managers.reverse()) manager.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, io, managers, profiles: [], sockets: [] };
}
function createPlayers(f, count) {
  for (let index = 0; index < count; index += 1) {
    const profile = f.store.createProfile({ displayName: `B01 ${index}` }).profile;
    const socket = fakeSocket(`preflight-${f.sockets.length}`, profile);
    f.profiles.push(profile); f.sockets.push(socket); f.io.sockets.sockets.set(socket.id, socket);
  }
  return { profiles: f.profiles.slice(-count), sockets: f.sockets.slice(-count) };
}
function setAvailable(store, profileId, currency, available) {
  const current = store.walletForUpdate(profileId, currency).available;
  if (current === available) return;
  const operationKey = `preflight-fixture-${profileId}-${currency}-${available}`;
  store.executeOperation('preflight_fixture_balance', operationKey, { profileId, currency, available }, at =>
    store.writeWallet(profileId, available - current, 0, {
      operationKey, source: 'fixture', note: 'Số dư tạm cho kiểm tra preflight', at, currency,
    }));
}
function managerFor(f, Manager, name, profileStore = f.store) {
  const manager = new Manager(f.io, {
    profileStore,
    profileForSocket: socket => socket.profile,
    storageFile: path.join(f.directory, `${name}.rooms.json`),
  });
  f.managers.push(manager);
  return manager;
}
function fixedFixture(t, { gameId, Manager, count = 2, stake, ready = true, currency = 'coin' }) {
  const f = fixture(t), { profiles, sockets } = createPlayers(f, count);
  const manager = managerFor(f, Manager, gameId);
  const created = manager.createRoom(sockets[0], 'B01 0', '🎲', { stake, maxPlayers: Math.max(2, count) });
  assert.ok(created?.roomCode, created?.error);
  for (let i = 1; i < count; i += 1) {
    const joined = manager.joinRoom(sockets[i], created.roomCode, `B01 ${i}`, '🎲');
    assert.ok(joined?.playerId, joined?.error);
  }
  const room = manager.rooms.get(created.roomCode);
  room.currency = currency;
  if (ready) sockets.forEach(socket => manager.setReady(socket, room.code, true));
  return { ...f, manager, room, profiles, sockets };
}
function readSnapshot(f, room, profiles) {
  return {
    room: JSON.stringify(room),
    balances: profiles.map(profile => Object.fromEntries(['coin', 'chip', 'gem'].map(currency => [
      currency, f.store.walletForUpdate(profile.id, currency),
    ]))),
    ledgers: profiles.map(profile => f.store.listLedger(profile.id, 100)),
  };
}
function build(f, room, seatIndex = 0, storageStatus = true, store = f.store) {
  const profile = f.profiles[seatIndex];
  return buildRoomPreflight({
    manager: f.manager, profileStore: store, roomCode: room.code,
    viewerSeatId: room.players[seatIndex].id, viewerProfileId: profile?.id,
    storageStatus,
  });
}

const fixedCases = [
  { gameId: 'tien-len', Manager: TienLenManager, stake: 100, hold: 100 },
  { gameId: 'sam-loc', Manager: SamLocManager, stake: 100, hold: 200 },
  { gameId: 'phom', Manager: PhomManager, stake: 100, hold: 600 },
];

for (const game of fixedCases) {
  test(`${game.gameId} preview reads the actual manager hold rule and leaves room, wallets and ledger unchanged`, t => {
    const f = fixedFixture(t, game);
    const before = readSnapshot(f, f.room, f.profiles);
    const preview = build(f, f.room);
    assert.equal(preview.room.gameId, game.gameId);
    assert.equal(preview.viewer.wallet.currency, 'coin');
    assert.equal(preview.viewer.wallet.available, 1000);
    assert.equal(preview.viewer.funding.amountToHold, game.hold);
    assert.equal(preview.viewer.funding.shortfall, 0);
    assert.equal(preview.evaluation.allowed, true);
    assert.deepEqual(preview.host.seatFunding, f.room.players.map(player => ({ seatId: player.id, status: 'sufficient' })));
    assert.deepEqual(readSnapshot(f, f.room, f.profiles), before);
  });
}

test('legacy Phỏm reservation currency stays chip and the hold comes from actual room stake/count', t => {
  const f = fixedFixture(t, { gameId: 'phom', Manager: PhomManager, count: 2, stake: 10, currency: 'chip' });
  f.room.reservations = [{ reservationId: 'missing-legacy-chip-row', profileId: f.profiles[0].id, amount: 60 }];
  const before = readSnapshot(f, f.room, f.profiles);
  const preview = build(f, f.room);
  assert.equal(preview.viewer.wallet.currency, 'chip');
  assert.equal(preview.viewer.wallet.available, 1000);
  assert.equal(preview.viewer.funding.amountToHold, 60);
  assert.deepEqual(readSnapshot(f, f.room, f.profiles), before);
});

test('host gets peer sufficiency labels and own exact shortfall, with no peer balances or shortfalls', t => {
  const f = fixedFixture(t, { gameId: 'tien-len', Manager: TienLenManager, stake: 100 });
  setAvailable(f.store, f.profiles[0].id, 'coin', 40);
  const before = readSnapshot(f, f.room, f.profiles);
  const preview = build(f, f.room);
  assert.equal(preview.viewer.wallet.available, 40);
  assert.equal(preview.viewer.funding.shortfall, 60);
  assert.equal(preview.viewer.funding.status, 'insufficient');
  assert.equal(preview.evaluation.allowed, false);
  assert.ok(preview.evaluation.blockers.some(item => item.code === 'FUNDS_INSUFFICIENT'));
  assert.deepEqual(preview.host.seatFunding.map(item => item.status), ['insufficient', 'sufficient']);
  assert.equal(JSON.stringify(preview.host).includes('available'), false);
  assert.equal(JSON.stringify(preview.host).includes('shortfall'), false);
  assert.deepEqual(readSnapshot(f, f.room, f.profiles), before);
});

test('guest payload contains only guest wallet and no host funding statuses or reasons', t => {
  const f = fixedFixture(t, { gameId: 'sam-loc', Manager: SamLocManager, stake: 20 });
  setAvailable(f.store, f.profiles[0].id, 'coin', 0);
  const before = readSnapshot(f, f.room, f.profiles);
  const preview = build(f, f.room, 1);
  assert.equal(preview.viewer.wallet.available, 1000);
  assert.equal(preview.viewer.funding.shortfall, 0);
  assert.equal(preview.evaluation.allowed, false);
  assert.deepEqual(preview.evaluation.blockers, []);
  assert.equal(Object.hasOwn(preview, 'host'), false);
  assert.equal(JSON.stringify(preview).includes(f.profiles[0].id), false);
  assert.deepEqual(readSnapshot(f, f.room, f.profiles), before);
});

test('wrong seat/profile identity is rejected before any wallet read', t => {
  const f = fixedFixture(t, { gameId: 'tien-len', Manager: TienLenManager, stake: 100 });
  let reads = 0;
  const store = new Proxy(f.store, { get(target, property) {
    if (property === 'walletForUpdate') return (...args) => { reads += 1; return target.walletForUpdate(...args); };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  assert.throws(() => buildRoomPreflight({ manager: f.manager, profileStore: store,
    roomCode: f.room.code, viewerSeatId: f.room.players[0].id, viewerProfileId: f.profiles[1].id, storageStatus: true }),
  { code: 'VIEWER_IDENTITY_MISMATCH' });
  assert.equal(reads, 0);
  assert.throws(() => buildRoomPreflight({ manager: f.manager, profileStore: store,
    roomCode: f.room.code, viewerSeatId: f.room.players[0].id, storageStatus: true }),
  { code: 'VIEWER_IDENTITY_MISMATCH' });
  assert.equal(reads, 0);
  assert.throws(() => buildRoomPreflight({ manager: f.manager, profileStore: store,
    roomCode: f.room.code, viewerSeatId: 'not-a-seat', viewerProfileId: f.profiles[0].id, storageStatus: true }),
  { code: 'VIEWER_NOT_IN_ROOM' });
  assert.equal(reads, 0);
});

test('insufficient count, readiness, storage failure and unknown storage all block without a start call', t => {
  const f = fixedFixture(t, { gameId: 'tien-len', Manager: TienLenManager, count: 1, stake: 100, ready: false });
  const safe = build(f, f.room, 0, true);
  assert.equal(safe.viewer.funding.amountToHold, 100);
  assert.deepEqual(safe.evaluation.blockers.map(item => item.code), ['MIN_PLAYERS', 'NOT_READY']);
  assert.equal(safe.evaluation.allowed, false);
  assert.equal(f.room.phase, 'WAITING');
  assert.deepEqual(f.store.listLedger(f.profiles[0].id, 100).filter(row => row.source === 'reservation'), []);
  const failed = build(f, f.room, 0, false);
  assert.ok(failed.evaluation.blockers.some(item => item.code === 'STORAGE_UNSAFE'));
  const unknown = build(f, f.room, 0, null);
  assert.ok(unknown.evaluation.blockers.some(item => item.code === 'STORAGE_STATUS_UNKNOWN'));
});

test('fixed-game payout and reserved-credit capacity use the ProfileStore limits', t => {
  const payout = fixedFixture(t, { gameId: 'tien-len', Manager: TienLenManager, stake: 100 });
  setAvailable(payout.store, payout.profiles[0].id, 'coin', CURRENCIES.coin.max - 50);
  const payoutPreview = build(payout, payout.room);
  assert.equal(payoutPreview.viewer.funding.shortfall, 0);
  assert.equal(payoutPreview.viewer.funding.status, 'capacity-blocked');
  assert.ok(payoutPreview.evaluation.blockers.some(item => item.code === 'PAYOUT_CAPACITY'));

  const reserved = fixedFixture(t, { gameId: 'tien-len', Manager: TienLenManager, stake: 100 });
  reserved.store.db.prepare('UPDATE wallets SET coin_available = ?, coin_reserved = ? WHERE profile_id = ?')
    .run(100, CURRENCIES.coin.max - 50, reserved.profiles[0].id);
  const reservedPreview = build(reserved, reserved.room);
  assert.equal(reservedPreview.viewer.funding.shortfall, 0);
  assert.equal(reservedPreview.viewer.funding.status, 'capacity-blocked');
  assert.ok(reservedPreview.evaluation.blockers.some(item => item.code === 'WALLET_CAPACITY'));
});

test('host can identify a player whose profile already holds another game seat', t => {
  const f = fixedFixture(t, { gameId: 'tien-len', Manager: TienLenManager, stake: 100 });
  f.store.reserveMany({ reservations: [{ profileId: f.profiles[1].id, amount: 100 }],
    operationKey: 'preflight-other-room-hold', roomCode: 'OTHER', currency: 'coin' });
  const before = readSnapshot(f, f.room, f.profiles);
  const preview = build(f, f.room);
  assert.equal(preview.evaluation.allowed, false);
  assert.ok(preview.evaluation.blockers.some(item => item.code === 'PLAYER_ALREADY_RESERVED'));
  assert.equal(preview.host.seatFunding[1].status, 'seat-conflict');
  assert.equal(JSON.stringify(preview.host).includes('OTHER'), false);
  assert.equal(JSON.stringify(preview.host).includes('profileId'), false);
  assert.deepEqual(readSnapshot(f, f.room, f.profiles), before);
});

function pokerFixture(t, { available = 1000 } = {}) {
  const f = fixture(t), { profiles, sockets } = createPlayers(f, 2);
  if (available !== 1000) setAvailable(f.store, profiles[0].id, 'chip', available);
  const manager = managerFor(f, PokerManager, 'poker');
  const created = manager.createRoom(sockets[0], 'Poker', '🎲');
  assert.ok(created?.roomCode, created?.error);
  const joined = manager.joinRoom(sockets[1], created.roomCode, 'Poker', '🎲');
  assert.ok(joined?.playerId, joined?.error);
  return { ...f, manager, room: manager.rooms.get(created.roomCode), profiles, sockets };
}

test('Poker reports buy-in shortfall separately from current stack and start-time hold', t => {
  const f = pokerFixture(t, { available: 100 });
  const before = readSnapshot(f, f.room, f.profiles);
  const preview = build(f, f.room);
  assert.equal(preview.viewer.wallet.currency, 'chip');
  assert.equal(preview.viewer.wallet.available, 100);
  assert.equal(preview.viewer.wallet.reserved, 0);
  assert.equal(preview.viewer.funding.mode, 'poker-buy-in');
  assert.equal(preview.viewer.funding.amountToHold, null);
  assert.equal(preview.viewer.funding.stack, 0);
  assert.equal(preview.viewer.funding.minimumAdditionalBuyIn, 200);
  assert.equal(preview.viewer.funding.shortfall, 100);
  assert.equal(preview.evaluation.allowed, false);
  assert.ok(preview.host.seatEligibility.every(item => item.eligible === false));
  assert.deepEqual(readSnapshot(f, f.room, f.profiles), before);
});

test('Poker buy-in already held in stack is not counted or held again by preflight', t => {
  const f = pokerFixture(t);
  f.manager.buyIn(f.sockets[0], f.room, f.room.players[0], { amount: '200', actionId: 'poker-buyin-host' });
  f.manager.buyIn(f.sockets[1], f.room, f.room.players[1], { amount: '200', actionId: 'poker-buyin-guest' });
  f.sockets.forEach(socket => f.manager.setReady(socket, f.room.code, true));
  const before = readSnapshot(f, f.room, f.profiles);
  const preview = build(f, f.room);
  assert.equal(preview.evaluation.allowed, true);
  assert.equal(preview.viewer.wallet.available, 800);
  assert.equal(preview.viewer.wallet.reserved, 200);
  assert.equal(preview.viewer.funding.stack, 200);
  assert.equal(preview.viewer.funding.minimumAdditionalBuyIn, 0);
  assert.equal(preview.viewer.funding.shortfall, 0);
  assert.equal(preview.viewer.funding.amountToHold, null);
  assert.deepEqual(preview.host.seatEligibility.map(item => item.eligible), [true, true]);
  assert.deepEqual(readSnapshot(f, f.room, f.profiles), before);
});

function addCasualPlayers(t, f, Manager, label, { gameId, variant, maxPlayers, count }) {
  const { profiles, sockets } = createPlayers(f, count);
  const manager = managerFor(f, Manager, label, null);
  let created;
  if (Manager === GameManager) {
    const options = { maxPlayers, gameId, variant };
    created = manager.createRoom(sockets[0], `${label} 0`, 'ADVANCED', '🎲', options);
  } else {
    created = manager.createRoom(sockets[0], `${label} 0`, '🎲');
  }
  assert.ok(created?.roomCode, created?.error);
  for (let i = 1; i < count; i += 1) {
    const joined = Manager === GameManager
      ? manager.joinRoom(sockets[i], created.roomCode, `${label} ${i}`, '🎲', { profile: { player: { playerId: profiles[i].id } } })
      : manager.joinRoom(sockets[i], created.roomCode, `${label} ${i}`, '🎲');
    assert.ok(joined?.playerId, joined?.error);
  }
  const room = manager.rooms.get(created.roomCode);
  room.players.forEach(player => { player.ready = true; });
  return { manager, profiles, sockets, room };
}

test('real Gang, UNO112, UNO108 and BANG managers preserve variants, capacity and readiness rules', t => {
  const f = fixture(t);
  const gang = addCasualPlayers(t, f, GameManager, 'gang', { gameId: 'the-gang', variant: 'standard', maxPlayers: 6, count: 2 });
  const uno112 = addCasualPlayers(t, f, GameManager, 'uno112', { gameId: 'uno', variant: 'classic-local-v1', maxPlayers: 4, count: 2 });
  const uno108 = addCasualPlayers(t, f, UnoManager, 'uno108', { gameId: 'uno', variant: 'classic-108-v1', maxPlayers: 6, count: 2 });
  const bang = addCasualPlayers(t, f, BangManager, 'bang', { gameId: 'bang', variant: 'base-4th-edition-v1', maxPlayers: 7, count: 4 });

  for (const [game, expected] of [
    [gang, { gameId: 'the-gang', variant: 'standard', max: 6 }],
    [uno112, { gameId: 'uno', variant: 'classic-local-v1', max: 4 }],
    [uno108, { gameId: 'uno', variant: 'classic-108-v1', max: 6 }],
    [bang, { gameId: 'bang', variant: 'base-4th-edition-v1', max: 7 }],
  ]) {
    const preview = buildRoomPreflight({ manager: game.manager, profileStore: f.store, roomCode: game.room.code,
      viewerSeatId: game.room.players[0].id, storageStatus: null });
    assert.equal(preview.room.gameId, expected.gameId);
    assert.equal(preview.room.variant, expected.variant);
    assert.equal(preview.room.maxPlayers, expected.max);
    assert.equal(preview.room.requiresWagerSafety, false);
    assert.equal(preview.viewer.wallet, null);
    assert.equal(preview.evaluation.allowed, true);
  }

  const solo = addCasualPlayers(t, f, GameManager, 'uno112-solo', { gameId: 'uno', variant: 'classic-local-v1', maxPlayers: 4, count: 1 });
  solo.room.players[0].ready = false;
  const notReady = buildRoomPreflight({ manager: solo.manager, profileStore: f.store, roomCode: solo.room.code,
    viewerSeatId: solo.room.players[0].id, storageStatus: null });
  assert.deepEqual(notReady.evaluation.blockers.map(item => item.code), ['MIN_PLAYERS', 'NOT_READY']);
});

test('preflight follows each engine connection rule instead of treating every offline seat alike', t => {
  const f = fixture(t);
  const gang = addCasualPlayers(t, f, GameManager, 'gang-offline', { gameId: 'the-gang', variant: 'standard', maxPlayers: 6, count: 2 });
  const uno112 = addCasualPlayers(t, f, GameManager, 'uno112-offline', { gameId: 'uno', variant: 'classic-local-v1', maxPlayers: 4, count: 2 });
  const uno108 = addCasualPlayers(t, f, UnoManager, 'uno108-offline', { gameId: 'uno', variant: 'classic-108-v1', maxPlayers: 6, count: 2 });
  const bang = addCasualPlayers(t, f, BangManager, 'bang-offline', { gameId: 'bang', variant: 'base-4th-edition-v1', maxPlayers: 7, count: 4 });
  for (const [game, expectedAllowed] of [[gang, true], [uno112, true], [uno108, false], [bang, false]]) {
    game.room.players[1].connected = false;
    const preview = buildRoomPreflight({ manager: game.manager, profileStore: f.store,
      roomCode: game.room.code, viewerSeatId: game.room.players[0].id, storageStatus: null });
    assert.equal(preview.evaluation.allowed, expectedAllowed, `${preview.room.gameId}/${preview.room.variant}`);
    assert.equal(preview.seats[1].connected, false);
    if (!expectedAllowed) assert.ok(preview.evaluation.blockers.some(item => item.code === 'PLAYER_OFFLINE'));
  }
});
