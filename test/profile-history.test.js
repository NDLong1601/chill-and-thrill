'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore, StoreError } = require('../src/platform/profileStore');

function memoryStore(t) {
  const store = new ProfileStore();
  t.after(() => store.close());
  return store;
}

function makeCompleted(store, profileId, { matchId, gameId = 'uno', roomCode = 'CAS1', completedAt = '2026-10-05T18:00:00.000Z', result = {}, outcome = 'WIN' }) {
  return store.recordCompletedMatch({ matchId, gameId, roomCode, completedAt, result,
    players: [{ profileId, outcome }] });
}

test('wallet history groups reserve, settlement, refund, Poker buy-in/cash-out, exchange, claim and legacy chip receipts', t => {
  const store = memoryStore(t);
  const first = store.createProfile({ displayName: 'Lịch sử A' });
  const second = store.createProfile({ displayName: 'Lịch sử B' });

  const held = store.reserveMany({ operationKey: 'history-shared-hold-001', roomCode: 'HOLD1', matchId: 'hold-match',
    reservations: [{ profileId: first.profile.id, amount: 100 }, { profileId: second.profile.id, amount: 100 }] });
  store.settleReservations({ reservations: held.held.map(item => ({ reservationId: item.reservationId })),
    outcomes: [{ profileId: first.profile.id, delta: -100 }, { profileId: second.profile.id, delta: 100 }],
    operationKey: 'history-shared-settle-001', roomCode: 'HOLD1', matchId: 'hold-match' });

  const refundHold = store.reserveMany({ operationKey: 'history-refund-hold-001', roomCode: 'REF1', matchId: 'refund-match',
    reservations: [{ profileId: first.profile.id, amount: 40 }] });
  store.releaseReservations({ reservations: refundHold.held.map(item => ({ reservationId: item.reservationId })),
    operationKey: 'history-refund-close-001', roomCode: 'REF1', matchId: 'refund-match' });

  const pokerHold = store.reserveMany({ operationKey: `poker:buyin:PKR1:${first.profile.id}:history`, roomCode: 'PKR1', matchId: 'poker-hand',
    reservations: [{ profileId: first.profile.id, amount: 200 }] });
  store.settlePokerSeat({ reservations: pokerHold.held.map(item => ({ reservationId: item.reservationId })), profileId: first.profile.id,
    stack: 260, operationKey: `poker:cashout:PKR1:seat-history:poker-hand`, roomCode: 'PKR1', matchId: 'poker-hand' });

  store.executeOperation('history_fixture_gem_credit', 'history-gem-credit-001', { profileId: first.profile.id }, at =>
    store.writeWallet(first.profile.id, 2, 0, { operationKey: 'history-gem-credit-001', source: 'fixture', note: 'Gem fixture', at, currency: 'gem' }));
  store.exchangeCurrency(first.profile.id, { direction: 'gem-to-coin', gems: 1, operationKey: 'history-exchange-001' });
  makeCompleted(store, first.profile.id, { matchId: 'history-claim-match', gameId: 'the-gang', roomCode: 'GANG1', result: { won: true, score: 7 } });
  const claim = store.claimMission(first.profile.id, 'daily_match', 1);
  const retriedClaim = store.claimMission(first.profile.id, 'daily_match', 1);
  assert.equal(claim.idempotent, false);
  assert.equal(retriedClaim.idempotent, true);

  const page = store.listHistoryPage(first.profile.id, { limit: '50' });
  const txs = page.items.filter(item => item.type === 'transaction');
  const find = (predicate, because) => {
    const item = txs.find(predicate);
    assert.ok(item, `history includes ${because}`);
    return item;
  };
  const reservation = find(item => item.group === 'hold' && item.roomCode === 'HOLD1', 'a hold receipt');
  const chipHold = reservation.receipt.currencies.find(item => item.currency === 'chip');
  assert.deepEqual([chipHold.availableDelta, chipHold.reservedDelta, chipHold.totalAssetDelta], [-100, 100, 0]);
  assert.equal(reservation.receipt.idempotentByOperationKey, true);

  const settled = find(item => item.group === 'settlement' && item.matchId === 'hold-match', 'the fixed-game settlement');
  const firstSettlement = settled.receipt.currencies.find(item => item.currency === 'chip');
  assert.deepEqual([firstSettlement.availableDelta, firstSettlement.reservedDelta, firstSettlement.totalAssetDelta], [0, -100, -100]);
  assert.deepEqual(firstSettlement.sources, ['settlement']);

  const refund = find(item => item.group === 'refund' && item.roomCode === 'REF1', 'a refund receipt');
  const chipRefund = refund.receipt.currencies.find(item => item.currency === 'chip');
  assert.deepEqual([chipRefund.availableDelta, chipRefund.reservedDelta, chipRefund.totalAssetDelta], [40, -40, 0]);

  const pokerCashout = find(item => item.group === 'settlement' && item.roomCode === 'PKR1' && item.label.includes('Poker'), 'a Poker cash-out');
  const pokerChip = pokerCashout.receipt.currencies.find(item => item.currency === 'chip');
  assert.deepEqual([pokerChip.availableDelta, pokerChip.reservedDelta, pokerChip.totalAssetDelta], [260, -200, 60]);
  assert.equal(pokerCashout.gameId, 'poker', 'operation prefixes identify Poker even without a room lookup');

  const exchange = find(item => item.group === 'exchange', 'a two-currency exchange receipt');
  assert.deepEqual(exchange.receipt.currencies.map(item => [item.currency, item.totalAssetDelta]), [['coin', 10_000_000], ['gem', -1]]);
  const reward = find(item => item.group === 'reward', 'a mission-claim receipt');
  assert.equal(reward.receipt.currencies.find(item => item.currency === 'coin').totalAssetDelta, 100);
  assert.deepEqual(reward.receipt.source, ['mission']);
  assert.deepEqual(store.listLedger(first.profile.id).filter(row => row.source === 'bootstrap').map(row => row.currency).sort(), ['chip', 'coin'],
    'both starting grants retain their own currency even when their timestamps match');

  const responseText = JSON.stringify(page);
  assert.equal(responseText.includes(second.profile.id), false, 'another participant id is not included in this profile receipt');
  assert.equal(responseText.includes('payload_hash'), false);
  assert.equal(responseText.includes('result_json'), false);
});

test('casual matches with no ledger remain searchable, expose only allowlisted outcome fields, and paginate same-time rows without gaps', t => {
  const store = memoryStore(t);
  const profile = store.createProfile({ displayName: 'Lịch sử ván' });
  const completedAt = '2026-10-05T18:00:00.000Z';
  const games = ['the-gang', 'uno', 'tien-len', 'poker', 'sam-loc', 'phom', 'bang'];
  for (const gameId of games) makeCompleted(store, profile.profile.id, {
    matchId: `same-time-${gameId}`, gameId, roomCode: `R-${gameId}`, completedAt,
    result: { winnerName: '<b>Winner</b>', reason: 'Đã kết thúc', roles: [{ playerId: 'private-player', role: 'SHERIFF' }], winnerIds: ['private-player'], privateHand: ['secret-card'], secretPayload: 'never expose' },
  });
  assert.equal(makeCompleted(store, profile.profile.id, { matchId: 'same-time-uno', gameId: 'uno', roomCode: 'R-uno', completedAt }).recorded, false,
    'replayed completion must not create a duplicate match event');
  store.transaction(() => {
    store.db.prepare(`INSERT INTO wallet_operations(idempotency_key, kind, payload_hash, result_json, created_at)
      VALUES ('same-time-grant', 'fixture_credit', 'fixture-hash', '{}', ?)` ).run(completedAt);
    store.db.prepare(`INSERT INTO wallet_ledger(id, operation_key, profile_id, available_delta, reserved_delta, source, note, created_at)
      VALUES ('same-time-ledger', 'same-time-grant', ?, 5, 0, 'fixture', 'Same timestamp operation', ?)` ).run(profile.profile.id, completedAt);
  });

  const allIds = new Set();
  const seenMatches = [];
  let cursor;
  do {
    const page = store.listHistoryPage(profile.profile.id, { limit: '2', ...(cursor ? { cursor } : {}) });
    for (const item of page.items) {
      assert.equal(allIds.has(item.id), false, 'stable cursor must not repeat an event');
      allIds.add(item.id);
      if (item.type === 'match') seenMatches.push(item);
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seenMatches.map(item => item.matchId).sort(), games.map(gameId => `same-time-${gameId}`).sort());
  assert.equal(seenMatches.length, games.length);
  assert.ok([...allIds].length >= games.length + 1, 'the same-timestamp wallet event is also retained');
  const gang = seenMatches.find(item => item.gameId === 'the-gang');
  assert.equal(gang.outcome, 'WIN', 'The Gang outcome can be derived from its persisted public result');
  const payload = JSON.stringify(store.listHistoryPage(profile.profile.id, { group: 'match', limit: '50' }));
  assert.equal(payload.includes('private-player'), false);
  assert.equal(payload.includes('secret-card'), false);
  assert.equal(payload.includes('secretPayload'), false);
  assert.equal(payload.includes('roles'), false);
  assert.equal(payload.includes('<b>Winner</b>'), true, 'public display text is returned as data for textContent rendering');
  makeCompleted(store, profile.profile.id, { matchId: 'uno-own-winner-result', gameId: 'uno', roomCode: 'UNOW', outcome: null,
    result: { winnerProfileId: profile.profile.id, winnerName: 'Player' } });
  makeCompleted(store, profile.profile.id, { matchId: 'uno-other-winner-result', gameId: 'uno', roomCode: 'UNOL', outcome: null,
    result: { winnerProfileId: 'another-profile-id', winnerName: 'Other player' } });
  const derived = store.listHistoryPage(profile.profile.id, { gameId: 'uno', group: 'match', limit: '50' }).items;
  const ownWin = derived.find(item => item.matchId === 'uno-own-winner-result');
  const ownLoss = derived.find(item => item.matchId === 'uno-other-winner-result');
  assert.equal(ownWin.outcome, 'WIN');
  assert.equal(ownLoss.outcome, 'LOSS');
  assert.equal(ownWin.result.won, true);
  assert.equal(JSON.stringify(ownWin).includes(profile.profile.id), false, 'deriving a personal outcome does not expose a profile id');
});

test('match room code and UNO variant come from immutable match snapshots, not a reused or deleted room row', t => {
  const store = memoryStore(t);
  const profile = store.createProfile({ displayName: 'Biến thể UNO' });
  store.syncRoom({ gameId: 'uno', room: { code: 'REUSE1', phase: 'RESULT', matchId: 'uno-old-match', variant: 'classic-local-v1', players: [] } });
  makeCompleted(store, profile.profile.id, { matchId: 'uno-old-match', gameId: 'uno', roomCode: 'REUSE1', result: { winnerName: 'A' } });
  store.syncRoom({ gameId: 'uno', room: { code: 'REUSE1', phase: 'RESULT', matchId: 'uno-new-match', variant: 'classic-108-v1', players: [] } });
  makeCompleted(store, profile.profile.id, { matchId: 'uno-new-match', gameId: 'uno', roomCode: 'REUSE1', result: { winnerName: 'B' } });
  makeCompleted(store, profile.profile.id, { matchId: 'uno-legacy-no-variant', gameId: 'uno', roomCode: 'OLDUNO', result: { winnerName: 'C' } });
  store.db.prepare('DELETE FROM rooms WHERE room_code = ?').run('REUSE1');

  const matches = store.listHistoryPage(profile.profile.id, { gameId: 'uno', roomCode: 'REUSE1', group: 'match', limit: '50' }).items;
  const oldMatch = matches.find(item => item.matchId === 'uno-old-match');
  const newMatch = matches.find(item => item.matchId === 'uno-new-match');
  assert.equal(oldMatch.variant, 'classic-local-v1');
  assert.equal(newMatch.variant, 'classic-108-v1');
  assert.equal(oldMatch.roomCode, 'REUSE1');
  assert.equal(newMatch.roomCode, 'REUSE1');
  const legacy = store.listHistoryPage(profile.profile.id, { group: 'match', limit: '50' }).items.find(item => item.matchId === 'uno-legacy-no-variant');
  assert.equal(legacy.variant, null, 'legacy variant is not guessed');
  makeCompleted(store, profile.profile.id, { matchId: 'uno-corrupt-snapshot', gameId: 'uno', roomCode: 'BROKEN1', result: { winnerName: 'Old result' } });
  store.db.prepare("UPDATE match_snapshots SET snapshot_json = '{broken' WHERE match_id = 'uno-corrupt-snapshot'").run();
  const corrupt = store.listHistoryPage(profile.profile.id, { gameId: 'uno', group: 'match', limit: '50' }).items.find(item => item.matchId === 'uno-corrupt-snapshot');
  assert.equal(corrupt.roomCode, null, 'corrupt private snapshot metadata fails closed without breaking other history');
  assert.equal(corrupt.variant, null);
});

test('history preserves explicit chip/coin units and does not infer a legacy result unit from its game', t => {
  const store = memoryStore(t);
  const profile = store.createProfile({ displayName: 'Đơn vị lịch sử' });
  for (const [matchId, currency] of [['old-chip', 'chip'], ['current-coin', 'coin'], ['missing-unit', undefined], ['unknown-unit', 'private-token']]) {
    makeCompleted(store, profile.profile.id, { matchId, gameId: 'tien-len', result: { stake: 50, pot: 100, currency } });
  }
  const matches = store.listHistoryPage(profile.profile.id, { group: 'match', limit: '50' }).items;
  assert.equal(matches.find(item => item.matchId === 'old-chip').result.currency, 'chip');
  assert.equal(matches.find(item => item.matchId === 'current-coin').result.currency, 'coin');
  assert.equal(matches.find(item => item.matchId === 'missing-unit').result.currency, undefined);
  assert.equal(matches.find(item => item.matchId === 'unknown-unit').result.currency, undefined);
  assert.equal(JSON.stringify(matches).includes('private-token'), false);
});

test('Vietnamese local-day filters include UTC evening records and validation bounds reject unsafe filters', t => {
  const store = memoryStore(t);
  const profile = store.createProfile({ displayName: 'Ngày Việt Nam' });
  makeCompleted(store, profile.profile.id, { matchId: 'vietnam-day-match', gameId: 'uno', roomCode: 'DAY1', completedAt: '2026-10-05T18:00:00.000Z' });
  assert.equal(store.listHistoryPage(profile.profile.id, { from: '2026-10-06', to: '2026-10-06', group: 'match' }).items.length, 1);
  assert.equal(store.listHistoryPage(profile.profile.id, { from: '2026-10-05', to: '2026-10-05', group: 'match' }).items.length, 0);
  for (const [filters, code] of [
    [{ limit: '0' }, 'HISTORY_LIMIT_INVALID'], [{ limit: '51' }, 'HISTORY_LIMIT_INVALID'],
    [{ from: '2026-02-30' }, 'HISTORY_DATE_INVALID'], [{ from: '2026-10-07', to: '2026-10-06' }, 'HISTORY_DATE_RANGE_INVALID'],
    [{ from: '2025-01-01', to: '2026-10-06' }, 'HISTORY_RANGE_TOO_WIDE'], [{ gameId: "uno' OR 1=1 --" }, 'HISTORY_GAME_INVALID'],
    [{ roomCode: "A' OR 1=1 --" }, 'HISTORY_ROOM_INVALID'], [{ currency: 'coin; DROP TABLE profiles' }, 'HISTORY_CURRENCY_INVALID'],
    [{ group: 'settlement OR 1=1' }, 'HISTORY_GROUP_INVALID'], [{ cursor: 'eyJmb28iOiJ4In0' }, 'HISTORY_CURSOR_INVALID'],
    [{ profileId: 'someone-else' }, 'HISTORY_FILTER_INVALID'],
  ]) assert.throws(() => store.listHistoryPage(profile.profile.id, filters), error => error instanceof StoreError && error.code === code);
  assert.ok(store.publicProfile(profile.profile.id), 'invalid filters cannot damage the profile tables');
});

test('REST history requires the matching profile token and never accepts profileId as an owner selector', async t => {
  const { createGameServer } = require('../src/httpServer');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-history-'));
  const game = createGameServer({ databaseFile: path.join(directory, 'history.sqlite') });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await game.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const store = game.gm.profiles;
  const owner = store.createProfile({ displayName: 'Chủ hồ sơ' });
  const other = store.createProfile({ displayName: 'Hồ sơ khác' });
  makeCompleted(store, owner.profile.id, { matchId: 'owner-history-match', gameId: 'bang', roomCode: 'OWN1', result: { faction: 'OUTLAWS', roles: ['private'], privateHand: ['secret'] } });
  makeCompleted(store, other.profile.id, { matchId: 'other-history-match', gameId: 'uno', roomCode: 'OTH1', result: { winnerName: 'Other' } });
  const base = `http://127.0.0.1:${game.server.address().port}`;
  assert.equal((await fetch(`${base}/api/history`)).status, 401);
  assert.equal((await fetch(`${base}/api/history`, { headers: { 'X-Profile-Token': 'invalid' } })).status, 401);
  assert.equal((await fetch(`${base}/api/history?profileId=${other.profile.id}`, { headers: { 'X-Profile-Token': owner.sessionToken } })).status, 400);
  assert.equal((await fetch(`${base}/api/history?limit=51`, { headers: { 'X-Profile-Token': owner.sessionToken } })).status, 400);
  const response = await fetch(`${base}/api/history?gameId=bang&group=match`, { headers: { 'X-Profile-Token': owner.sessionToken } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body.items.map(item => item.matchId), ['owner-history-match']);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(other.profile.id), false);
  assert.equal(serialized.includes('privateHand'), false);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('result_json'), false);
  assert.equal(serialized.includes('payload_hash'), false);
});
