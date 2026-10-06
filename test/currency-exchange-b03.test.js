'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ProfileStore } = require('../src/platform/profileStore');
const { CURRENCIES, COIN_PER_GEM } = require('../src/platform/currencies');
const { quoteCurrencyExchange } = require('../src/platform/currencyQuote');
const { createGameServer } = require('../src/httpServer');

function credit(store, profileId, currency, amount, operationKey) {
  return store.executeOperation('b03_fixture', operationKey, { profileId, currency, amount }, at =>
    store.writeWallet(profileId, amount, 0, { operationKey, source: 'fixture', note: 'B03 temporary fixture', at, currency }));
}

test('exchange quote uses available funds after holds and respects destination currency caps', t => {
  const store = new ProfileStore(); t.after(() => store.close());
  const first = store.createProfile().profile;
  credit(store, first.id, 'coin', 3 * COIN_PER_GEM, 'b03-credit-coins');
  store.reserveMany({ currency: 'coin', roomCode: 'B03', operationKey: 'b03-hold-coins', reservations: [{ profileId: first.id, amount: COIN_PER_GEM }] });
  const balances = store.publicProfile(first.id).balances;
  assert.deepEqual(balances.coin, { available: 2 * COIN_PER_GEM + 1000, reserved: COIN_PER_GEM });

  const exact = quoteCurrencyExchange({ balances, direction: 'coin-to-gem', gems: 2 });
  assert.equal(exact.canExchange, true);
  assert.equal(exact.debit, 2 * COIN_PER_GEM);
  assert.equal(exact.credit, 2);
  assert.equal(exact.after.coin.available, 1000);
  assert.equal(exact.after.coin.reserved, COIN_PER_GEM);
  assert.equal(exact.maxGems, 2);

  const insufficient = quoteCurrencyExchange({ balances, direction: 'coin-to-gem', gems: 3 });
  assert.equal(insufficient.canExchange, false);
  assert.equal(insufficient.maxGems, 2);
  assert.match(insufficient.error, /Còn thiếu 9\.999\.000 coin/);
  assert.match(insufficient.error, /10\.000\.000 đang giữ/);

  credit(store, first.id, 'gem', CURRENCIES.gem.max - 1, 'b03-credit-gem-cap');
  const atGemCap = quoteCurrencyExchange({ balances: store.publicProfile(first.id).balances, direction: 'coin-to-gem', gems: 1 });
  assert.equal(atGemCap.canExchange, true);
  const gemCap = quoteCurrencyExchange({ balances: store.publicProfile(first.id).balances, direction: 'coin-to-gem', gems: 2 });
  assert.equal(gemCap.canExchange, false);
  assert.equal(gemCap.maxGems, 1);
  assert.match(gemCap.error, /tối đa 1 gem/);
  assert.match(gemCap.error, /vượt giới hạn 1 gem/);

  const second = store.createProfile().profile;
  credit(store, second.id, 'gem', 1, 'b03-credit-target-gem');
  credit(store, second.id, 'coin', CURRENCIES.coin.max - 1000 - (COIN_PER_GEM / 2), 'b03-near-coin-cap');
  const coinCap = quoteCurrencyExchange({ balances: store.publicProfile(second.id).balances, direction: 'gem-to-coin', gems: 1 });
  assert.equal(coinCap.canExchange, false);
  assert.equal(coinCap.maxGems, 0);
  assert.match(coinCap.error, /chỗ nhận tối đa 5\.000\.000 coin/);
  assert.match(coinCap.error, /vượt giới hạn 5\.000\.000 coin/);
});

test('exchange quote rejects invalid integer amounts and directions', () => {
  const balances = { coin: { available: 1000, reserved: 0 }, gem: { available: 0, reserved: 0 } };
  for (const gems of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    const quote = quoteCurrencyExchange({ balances, direction: 'coin-to-gem', gems });
    assert.equal(quote.valid, false);
  }
  assert.equal(quoteCurrencyExchange({ balances, direction: 'chip-to-gem', gems: 1 }).valid, false);
});

test('quote endpoint is private, reports server reward pace, and POST retries are idempotent', async t => {
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  t.after(() => game.close());
  const store = game.gm.profiles;
  const first = store.createProfile();
  const other = store.createProfile();
  const base = `http://127.0.0.1:${game.server.address().port}`;
  const quoteUrl = new URL('/api/wallet/exchange/quote', base);
  quoteUrl.searchParams.set('direction', 'coin-to-gem');
  quoteUrl.searchParams.set('gems', '1');
  quoteUrl.searchParams.set('profileId', other.profile.id);

  const unauthorized = await fetch(quoteUrl);
  assert.equal(unauthorized.status, 401);
  const quoteResponse = await fetch(quoteUrl, { headers: { 'X-Profile-Token': first.sessionToken } });
  const quote = await quoteResponse.json();
  assert.equal(quoteResponse.status, 200);
  assert.equal(quote.balances.coin.available, 1000);
  assert.equal(quote.rate, COIN_PER_GEM);
  assert.equal(quote.rewards.startingCoinGrant, 1000);
  assert.equal(quote.rewards.openDailyMissionCount, 3);
  assert.equal(quote.rewards.openDailyMissionReward, 450);
  assert.equal(quoteResponse.headers.get('cache-control'), 'no-store');
  assert.equal(store.publicProfile(other.profile.id).balances.coin.available, 1000);

  credit(store, first.profile.id, 'coin', COIN_PER_GEM, 'b03-api-credit');
  const body = { direction: 'coin-to-gem', gems: 1, operationKey: 'b03-api-exchange-retry-0001' };
  const post = () => fetch(`${base}/api/wallet/exchange`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Profile-Token': first.sessionToken }, body: JSON.stringify(body),
  });
  const initial = await (await post()).json();
  const retry = await (await post()).json();
  assert.equal(initial.exchange.idempotent, false);
  assert.equal(retry.exchange.idempotent, true);
  assert.equal(store.publicProfile(first.profile.id).balances.coin.available, 1000);
  assert.equal(store.publicProfile(first.profile.id).balances.gem.available, 1);
  assert.equal(store.listLedger(first.profile.id).filter(row => row.source === 'exchange').length, 2);
});

test('POST rechecks balances after a quote and gives the exact current shortfall', async t => {
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  t.after(() => game.close());
  const store = game.gm.profiles;
  const created = store.createProfile();
  credit(store, created.profile.id, 'coin', 2 * COIN_PER_GEM, 'b03-stale-credit');
  const base = `http://127.0.0.1:${game.server.address().port}`;
  const quote = await fetch(`${base}/api/wallet/exchange/quote?direction=coin-to-gem&gems=1`, { headers: { 'X-Profile-Token': created.sessionToken } });
  assert.equal(quote.status, 200);
  store.reserveMany({ currency: 'coin', roomCode: 'B03STALE', operationKey: 'b03-stale-hold', reservations: [{ profileId: created.profile.id, amount: 2 * COIN_PER_GEM }] });
  const response = await fetch(`${base}/api/wallet/exchange`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Profile-Token': created.sessionToken },
    body: JSON.stringify({ direction: 'coin-to-gem', gems: 1, operationKey: 'b03-stale-post-0001' }),
  });
  const result = await response.json();
  assert.equal(response.status, 409);
  assert.match(result.error, /Cần 10\.000\.000 coin khả dụng/);
  assert.match(result.error, /Còn thiếu 9\.999\.000 coin/);
  assert.equal(store.publicProfile(created.profile.id).balances.gem.available, 0);
});

test('quote and POST respect coin capacity reserved for a live match payout', async t => {
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  t.after(() => game.close());
  const store = game.gm.profiles;
  const first = store.createProfile();
  const second = store.createProfile();
  const stake = 100;
  credit(store, first.profile.id, 'coin', CURRENCIES.coin.max - stake - 1000, 'b03-live-game-near-cap');
  credit(store, first.profile.id, 'gem', 1, 'b03-live-game-gem');
  store.preflightFixedGameStart({ gameId: 'tien-len', stake, profileIds: [first.profile.id, second.profile.id] });
  store.reserveMany({ currency: 'coin', roomCode: 'B03CAP', matchId: 'b03-live-cap-match',
    operationKey: 'tien-len:reserve:b03-live-cap-match',
    reservations: [first.profile.id, second.profile.id].map(profileId => ({ profileId, amount: stake })) });

  const capacity = store.walletCreditCapacity(first.profile.id, 'coin');
  assert.equal(capacity.available, CURRENCIES.coin.max - stake * 2);
  assert.equal(capacity.protectedCredit, stake * 2);
  assert.equal(capacity.remaining, 0);

  const base = `http://127.0.0.1:${game.server.address().port}`;
  const quoteResponse = await fetch(`${base}/api/wallet/exchange/quote?direction=gem-to-coin&gems=1`, {
    headers: { 'X-Profile-Token': first.sessionToken },
  });
  const quote = await quoteResponse.json();
  assert.equal(quoteResponse.status, 200);
  assert.equal(quote.canExchange, false);
  assert.equal(quote.maxGems, 0);
  assert.equal(quote.protectedCredit, stake * 2);
  assert.match(quote.error, /200 coin sức chứa được để dành để thanh toán các ván đang chơi/);

  const before = store.publicProfile(first.profile.id).balances;
  const response = await fetch(`${base}/api/wallet/exchange`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Profile-Token': first.sessionToken },
    body: JSON.stringify({ direction: 'gem-to-coin', gems: 1, operationKey: 'b03-protected-credit-0001' }),
  });
  const result = await response.json();
  assert.equal(response.status, 409);
  assert.equal(result.code, 'PAYOUT_CAPACITY');
  assert.match(result.error, /200 coin sức chứa được để dành để thanh toán các ván đang chơi/);
  assert.match(result.error, /vượt giới hạn 10\.000\.000 coin/);
  assert.deepEqual(store.publicProfile(first.profile.id).balances, before);
  assert.equal(store.listLedger(first.profile.id).filter(row => row.source === 'exchange').length, 0);
});
