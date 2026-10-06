'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ProfileStore } = require('../src/platform/profileStore');
const { COIN_PER_GEM } = require('../src/platform/currencies');
const { createGameServer } = require('../src/httpServer');

test('coin reservations and settlements preserve the separate Poker chip balance', t => {
  const store = new ProfileStore(); t.after(() => store.close());
  const profiles = [store.createProfile().profile, store.createProfile().profile];
  const hold = store.reserveMany({ currency: 'coin', roomCode: 'COIN', operationKey: 'coin-test-reserve', reservations: profiles.map(p => ({ profileId: p.id, amount: 100 })) });
  assert.ok(hold.held.every(item => item.currency === 'coin'));
  const args = { reservations: hold.held, winnerProfileId: profiles[0].id, operationKey: 'coin-test-settle', roomCode: 'COIN', matchId: 'coin-match' };
  store.settleWinnerTakesPot(args); store.settleWinnerTakesPot(args);
  assert.deepEqual(profiles.map(p => store.publicProfile(p.id).balances.coin.available), [1100, 900]);
  assert.ok(profiles.every(p => store.publicProfile(p.id).wallet.available === 1000 && store.publicProfile(p.id).wallet.reserved === 0));
  assert.ok(store.listLedger(profiles[0].id).filter(row => row.source === 'settlement').every(row => row.currency === 'coin'));
});

test('coin/gem exchanges use the server rate, conserve value, retry once and roll back insufficient balances', t => {
  const store = new ProfileStore(); t.after(() => store.close());
  const { profile } = store.createProfile();
  const before = store.publicProfile(profile.id).balances;
  assert.throws(() => store.exchangeCurrency(profile.id, { direction: 'coin-to-gem', gems: 1, operationKey: 'exchange-insufficient' }), /Số dư/);
  assert.deepEqual(store.publicProfile(profile.id).balances, before);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM wallet_operations WHERE idempotency_key = 'exchange-insufficient'").get().n, 0);
  store.executeOperation('fixture', 'exchange-fixture-credit', {}, at => store.writeWallet(profile.id, 2 * COIN_PER_GEM, 0, { currency: 'coin', operationKey: 'exchange-fixture-credit', source: 'fixture', note: 'Temporary test funds', at }));
  const exchange = { direction: 'coin-to-gem', gems: 2, operationKey: 'exchange-two-gems' };
  assert.equal(store.exchangeCurrency(profile.id, exchange).coins, 2 * COIN_PER_GEM);
  assert.equal(store.exchangeCurrency(profile.id, exchange).idempotent, true);
  assert.deepEqual(store.publicProfile(profile.id).balances.gem, { available: 2, reserved: 0 });
  store.exchangeCurrency(profile.id, { direction: 'gem-to-coin', gems: 1, operationKey: 'exchange-one-back' });
  const balances = store.publicProfile(profile.id).balances;
  assert.equal(balances.coin.available + balances.gem.available * COIN_PER_GEM, 1000 + 2 * COIN_PER_GEM);
  assert.deepEqual(balances.chip, before.chip);
  for (const gems of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) assert.throws(() => store.exchangeCurrency(profile.id, { direction: 'coin-to-gem', gems, operationKey: 'exchange-invalid' }));
  assert.throws(() => store.exchangeCurrency(profile.id, { direction: 'chip-to-gem', gems: 1, operationKey: 'exchange-chip-reject' }));
});

test('exchange API authenticates the owner and ignores client supplied rates or target identities', async t => {
  const game = createGameServer(); await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve)); t.after(() => game.close());
  const first = game.gm.profiles.createProfile(), other = game.gm.profiles.createProfile();
  const endpoint = `http://127.0.0.1:${game.server.address().port}/api/wallet/exchange`;
  const body = { direction: 'coin-to-gem', gems: 1, rate: 1, profileId: other.profile.id, operationKey: 'api-exchange-owner-test' };
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-profile-token': first.sessionToken }, body: JSON.stringify(body) })).status, 409);
  assert.equal(game.gm.profiles.publicProfile(other.profile.id).balances.gem.available, 0);
  assert.equal(game.gm.profiles.publicProfile(first.profile.id).balances.coin.available, 1000);
});
