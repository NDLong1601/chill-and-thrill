'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CURRENCIES, validateAmount } = require('../src/platform/currencies');
const { getGame, getStakeLimits, publicCatalog, validateRoomConfig, validateStake } = require('../src/platform/gameRegistry');
const { ProfileStore } = require('../src/platform/profileStore');
const { TienLenManager } = require('../src/games/tien-len/tienLenEngine');
const { SamLocManager } = require('../src/games/sam-loc/samLocEngine');
const { PhomManager } = require('../src/games/phom/phomEngine');

const games = [
  { id: 'tien-len', Manager: TienLenManager, min: 2, max: 4 },
  { id: 'sam-loc', Manager: SamLocManager, min: 2, max: 5 },
  { id: 'phom', Manager: PhomManager, min: 2, max: 4 },
];
const temporaryDirectory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-a07-'));
function fakeIo() {
  const sockets = new Map();
  return { sockets: { sockets }, to: () => ({ emit() {} }) };
}
function fakeSocket(id, profile) {
  return { id, profile, events: [], join() {}, leave() {}, emit(event, payload) { this.events.push({ event, payload }); } };
}
function creditTo(store, profileId, currency, available) {
  const current = store.walletForUpdate(profileId, currency).available;
  if (available === current) return;
  const operationKey = `a07-fixture-${profileId}-${currency}`;
  store.executeOperation('a07_fixture_credit', operationKey, { profileId, currency, available }, at =>
    store.writeWallet(profileId, available - current, 0, { operationKey, source: 'fixture', note: 'Tài khoản tạm cho A07', at, currency }));
}
function makeManagerFixture(t, game, { playerCount = 2, maxPlayers = playerCount, stake, availableEach = 1000 } = {}) {
  const directory = temporaryDirectory();
  const store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite') });
  const io = fakeIo();
  const profiles = Array.from({ length: playerCount }, (_, index) => store.createProfile({ displayName: `A07 ${index}` }).profile);
  profiles.forEach(profile => creditTo(store, profile.id, 'coin', availableEach));
  const sockets = profiles.map((profile, index) => fakeSocket(`${game.id}-${index}`, profile));
  sockets.forEach(socket => io.sockets.sockets.set(socket.id, socket));
  const manager = new game.Manager(io, { profileStore: store, profileForSocket: socket => socket.profile,
    storageFile: path.join(directory, 'rooms.json'), shuffle: deck => deck });
  const created = manager.createRoom(sockets[0], 'A07', '🎲', { stake, maxPlayers });
  assert.ok(created?.roomCode, created?.error);
  for (let index = 1; index < playerCount; index++) assert.ok(manager.joinRoom(sockets[index], created.roomCode, 'A07', '🎲')?.playerId);
  const room = manager.rooms.get(created.roomCode);
  sockets.forEach(socket => manager.setReady(socket, room.code, true));
  const fixture = { directory, store, manager, profiles, sockets, room };
  t.after(() => {
    manager.close(); store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return fixture;
}

test('server amount validator uses each currency cap and preserves chip as the legacy default', () => {
  for (const [currency, definition] of Object.entries(CURRENCIES)) {
    assert.equal(validateAmount(1, currency), true, `${currency} minimum`);
    assert.equal(validateAmount(definition.max, currency), true, `${currency} maximum`);
    assert.equal(validateAmount(definition.max + 1, currency), false, `${currency} maximum + 1`);
    assert.equal(validateAmount(0, currency), false);
    assert.equal(validateAmount(1.5, currency), false);
    assert.equal(validateAmount(Number.MAX_SAFE_INTEGER + 1, currency), false);
  }
  assert.equal(validateAmount(CURRENCIES.chip.max), true);
  assert.equal(validateAmount(CURRENCIES.coin.max), false, 'legacy callers still default to the chip cap');
  const store = new ProfileStore();
  try {
    assert.equal(store.validateAmount(CURRENCIES.coin.max, 'coin'), true);
    assert.equal(store.validateAmount(CURRENCIES.coin.max), false);
    assert.throws(() => store.reserveMany({ operationKey: 'a07-coin-too-large', roomCode: 'A07', currency: 'coin',
      reservations: [{ profileId: store.createProfile().profile.id, amount: CURRENCIES.coin.max + 1 }] }), { code: 'RESERVATION_INVALID' });
  } finally { store.close(); }
});

test('public registry publishes game hold and payout factors for every supported room size', () => {
  const catalog = publicCatalog();
  for (const game of games) {
    const publicGame = catalog.games.find(item => item.id === game.id);
    assert.equal(publicGame.stakeRules.currency, 'coin');
    assert.equal(publicGame.stakeRules.defaultStake, getGame(game.id).stake);
    for (let count = game.min; count <= game.max; count++) {
      const limits = getStakeLimits(game.id, count);
      const advertised = publicGame.stakeRules.limitsByPlayerCount[count];
      assert.deepEqual(advertised, { maxStake: limits.maxStake, holdFactor: limits.holdFactor,
        maxLossFactor: limits.maxLossFactor, maxNetGainFactor: limits.maxNetGainFactor,
        grossPayoutFactor: limits.grossPayoutFactor });
      assert.equal(validateStake(game.id, 1, count), 1);
      assert.equal(validateStake(game.id, limits.maxStake, count), limits.maxStake);
      assert.throws(() => validateStake(game.id, limits.maxStake + 1, count));
      assert.equal(validateRoomConfig(game.id, { maxPlayers: count, stake: limits.maxStake }).stake, limits.maxStake);
      assert.throws(() => validateRoomConfig(game.id, { maxPlayers: count, stake: limits.maxStake + 1 }));
      for (const factor of [limits.holdFactor, limits.maxLossFactor, limits.maxNetGainFactor, limits.grossPayoutFactor]) {
        assert.ok(Number.isSafeInteger(factor * limits.maxStake));
        assert.ok(factor * limits.maxStake <= CURRENCIES.coin.max);
      }
    }
  }
});

for (const game of games) {
  test(`${game.id} starts at its maximum stake for actual and configured player counts`, async t => {
    for (let playerCount = game.min; playerCount <= game.max; playerCount++) {
      await t.test(`${playerCount} players`, subtest => {
        const limits = getStakeLimits(game.id, playerCount);
        const hold = limits.holdFactor * limits.maxStake;
        const f = makeManagerFixture(subtest, game, { playerCount, maxPlayers: playerCount, stake: limits.maxStake, availableEach: hold });
        const result = f.manager.startGame(f.sockets[0], f.room.code);
        assert.equal(result?.error, undefined, result?.error);
        assert.notEqual(f.room.phase, 'WAITING');
        const expectedReserved = f.room.phase === 'RESULT' ? 0 : hold;
        assert.deepEqual(f.profiles.map(profile => f.store.publicProfile(profile.id).balances.coin.reserved),
          Array(playerCount).fill(expectedReserved));
      });
    }
  });
}

test('two-player 2,000,000,000 coin Tiến lên audit case starts and settles', t => {
  assert.equal(validateRoomConfig('tien-len', { stake: 2_000_000_000 }).stake, 2_000_000_000);
  const f = makeManagerFixture(t, games[0], { playerCount: 2, maxPlayers: 4, stake: 2_000_000_000, availableEach: 3_000_001_000 });
  assert.equal(f.manager.startGame(f.sockets[0], f.room.code)?.error, undefined);
  assert.equal(f.room.stake, 2_000_000_000);
  assert.deepEqual(f.profiles.map(profile => f.store.publicProfile(profile.id).balances.coin.reserved),
    [2_000_000_000, 2_000_000_000]);
});

test('start preflight rejects insufficient seats and payout overflow before any hold or room mutation', t => {
  const f = makeManagerFixture(t, games[0], { playerCount: 2, stake: 2000, availableEach: 1000 });
  creditTo(f.store, f.profiles[0].id, 'coin', 5000);
  const before = f.profiles.map(profile => f.store.publicProfile(profile.id).balances.coin);
  const insufficient = f.manager.startGame(f.sockets[0], f.room.code);
  assert.match(insufficient.error, /không đủ coin/i);
  assert.equal(f.room.phase, 'WAITING');
  assert.deepEqual(f.profiles.map(profile => f.store.publicProfile(profile.id).balances.coin), before);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE status = 'HELD'").get().count, 0);

  const stake = 100;
  const full = makeManagerFixture(t, games[0], { playerCount: 2, maxPlayers: 2, stake,
    availableEach: CURRENCIES.coin.max - stake + 1 });
  const nearCapBefore = full.profiles.map(profile => full.store.publicProfile(profile.id).balances.coin);
  const overflow = full.manager.startGame(full.sockets[0], full.room.code);
  assert.match(overflow.error, /sức chứa coin/i);
  assert.equal(full.room.phase, 'WAITING');
  assert.deepEqual(full.profiles.map(profile => full.store.publicProfile(profile.id).balances.coin), nearCapBefore);
  assert.equal(full.store.db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE status = 'HELD'").get().count, 0);
});

test('coin credit paths preserve live payout headroom; denied credits roll back and settlement reaches the wallet cap', t => {
  const store = new ProfileStore();
  const first = store.createProfile().profile, second = store.createProfile().profile;
  const stake = 100;
  creditTo(store, first.id, 'coin', CURRENCIES.coin.max - stake);
  creditTo(store, second.id, 'coin', stake);
  store.preflightFixedGameStart({ gameId: 'tien-len', stake, profileIds: [first.id, second.id] });
  const held = store.reserveMany({ currency: 'coin', roomCode: 'A07HEAD', matchId: 'a07-headroom-match',
    operationKey: 'tien-len:reserve:a07-headroom-match', reservations: [first, second].map(profile => ({ profileId: profile.id, amount: stake })) }).held;
  assert.deepEqual(store.walletCreditCapacity(first.id, 'coin'), { currency: 'coin', max: CURRENCIES.coin.max,
    available: CURRENCIES.coin.max - stake * 2, protectedCredit: stake * 2, remaining: 0 });

  const period = require('../src/platform/profileStore').vietnamDay();
  store.recordCompletedMatch({ matchId: 'a07-credit-proof', gameId: 'tien-len', players: [{ profileId: first.id }] });
  const coinBefore = store.publicProfile(first.id).balances.coin;
  assert.throws(() => store.claimMission(first.id, 'daily_match', 1, period), { code: 'PAYOUT_CAPACITY' });
  assert.deepEqual(store.publicProfile(first.id).balances.coin, coinBefore);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM mission_claims WHERE profile_id = ?").get(first.id).count, 0);
  creditTo(store, first.id, 'gem', 1);
  const gemBefore = store.publicProfile(first.id).balances.gem;
  assert.throws(() => store.exchangeCurrency(first.id, { direction: 'gem-to-coin', gems: 1, operationKey: 'a07-credit-exchange' }), { code: 'PAYOUT_CAPACITY' });
  assert.deepEqual(store.publicProfile(first.id).balances.gem, gemBefore);
  assert.deepEqual(store.publicProfile(first.id).balances.coin, coinBefore);

  const winner = held.find(item => item.profileId === first.id);
  store.settleWinnerTakesPot({ reservations: held, winnerProfileId: first.id, operationKey: 'a07-headroom-settle',
    roomCode: 'A07HEAD', matchId: 'a07-headroom-match' });
  assert.equal(store.publicProfile(first.id).balances.coin.available, CURRENCIES.coin.max);
  assert.equal(store.publicProfile(first.id).balances.coin.reserved, 0);
  assert.equal(store.db.prepare('SELECT status FROM reservations WHERE id = ?').get(winner.reservationId).status, 'SETTLED');
  store.close();
});

test('settlement and release reject mixed currency holds without changing either wallet', t => {
  const store = new ProfileStore();
  try {
    const chipProfile = store.createProfile().profile, coinProfile = store.createProfile().profile;
    const chip = store.reserveMany({ roomCode: 'A07MIX', operationKey: 'a07-mix-chip', reservations: [{ profileId: chipProfile.id, amount: 10 }] }).held[0];
    const coin = store.reserveMany({ roomCode: 'A07MIX', currency: 'coin', operationKey: 'a07-mix-coin', reservations: [{ profileId: coinProfile.id, amount: 10 }] }).held[0];
    const before = [chipProfile.id, coinProfile.id].map(id => store.publicProfile(id).balances);
    assert.throws(() => store.releaseReservations({ reservations: [chip, coin], operationKey: 'a07-mix-release', roomCode: 'A07MIX' }), { code: 'CURRENCY_MISMATCH' });
    assert.throws(() => store.settleWinnerTakesPot({ reservations: [chip, coin], winnerProfileId: chipProfile.id,
      operationKey: 'a07-mix-settle', roomCode: 'A07MIX' }), { code: 'CURRENCY_MISMATCH' });
    assert.throws(() => store.settleReservations({ reservations: [chip, coin],
      outcomes: [{ profileId: chipProfile.id, delta: 0 }, { profileId: coinProfile.id, delta: 0 }],
      operationKey: 'a07-mix-fixed-settle', roomCode: 'A07MIX' }), { code: 'CURRENCY_MISMATCH' });
    assert.deepEqual([chipProfile.id, coinProfile.id].map(id => store.publicProfile(id).balances), before);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE status = 'HELD'").get().count, 2);
  } finally { store.close(); }
});
