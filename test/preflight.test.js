'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Preflight = require('../public/js/preflight');

function fixedRoom(overrides = {}) {
  return {
    schemaVersion: 1,
    room: { code: 'ABCD', gameId: 'tien-len', variant: 'standard', phase: 'WAITING', revision: 8, minPlayers: 2, maxPlayers: 4, requiresWagerSafety: true },
    seats: [
      { id: 'a', name: 'An', ready: true, connected: true, balance: 999999, wallet: { available: 999999 } },
      { id: 'b', name: 'Bình', ready: false, connected: true, balance: 999999, wallet: { available: 999999 } },
    ],
    viewer: {
      seatId: 'a', isHost: true,
      wallet: { currency: 'coin', available: 90, reserved: 25 },
      funding: { mode: 'fixed-hold', amountToHold: 100, shortfall: 10 },
    },
    evaluation: { allowed: false, blockers: [
      { code: 'NOT_READY' }, { code: 'FUNDS_INSUFFICIENT' },
    ] },
    storage: { canStartWager: true },
    host: { seatFunding: [
      { seatId: 'a', status: 'insufficient', shortfall: 10, available: 90 },
      { seatId: 'b', status: 'sufficient', balance: 999999 },
    ] },
    ...overrides,
    room: { code: 'ABCD', gameId: 'tien-len', variant: 'standard', phase: 'WAITING', revision: 8, minPlayers: 2, maxPlayers: 4, requiresWagerSafety: true, ...overrides.room },
    storage: overrides.storage ?? { canStartWager: true },
  };
}

test('renders the server-confirmed fixed-game hold, own shortfall and actual not-ready member', () => {
  const view = Preflight.buildViewModel(fixedRoom());
  assert.equal(view.funding.mode, 'fixed-hold');
  assert.equal(view.funding.amountToHold, 100);
  assert.equal(view.funding.shortfall, 10);
  assert.deepEqual(view.waitingFor.map(seat => seat.name), ['Bình']);
  assert.equal(view.blockers.length, 2);
});

test('legacy chip reservations use the room currency sent by the server', () => {
  const view = Preflight.buildViewModel(fixedRoom({
    room: { code: 'OLD1', gameId: 'phom', variant: 'local-v1', phase: 'WAITING', revision: 2, requiresWagerSafety: true },
    viewer: { seatId: 'a', isHost: true, wallet: { currency: 'chip', available: 500, reserved: 100 }, funding: { mode: 'fixed-hold', amountToHold: 100, shortfall: 0 } },
    evaluation: { allowed: true, blockers: [] },
  }));
  assert.equal(view.currency, 'chip');
  assert.equal(view.funding.amountToHold, 100);
});

test('does not copy peer balances, profile data, or peer shortfalls into the view model', () => {
  const view = Preflight.buildViewModel(fixedRoom());
  assert.equal(Object.hasOwn(view.seats[1], 'balance'), false);
  assert.equal(Object.hasOwn(view.seats[1], 'wallet'), false);
  assert.equal(Object.hasOwn(view.seats[1], 'funding'), false);
  assert.equal(view.seats[1].fundingLabel, 'Đủ điều kiện ví');
  assert.equal(Object.hasOwn(view.seats[1], 'shortfall'), false);
});

test('guest view never includes host-only per-seat financial labels or start reasons', () => {
  const payload = fixedRoom({
    viewer: { seatId: 'b', isHost: false, wallet: { currency: 'coin', available: 500, reserved: 0 }, funding: { mode: 'fixed-hold', amountToHold: 100, shortfall: 0 } },
  });
  const view = Preflight.buildViewModel(payload);
  assert.equal(view.isHost, false);
  assert.deepEqual(view.blockers, []);
  assert.equal(view.seats[0].fundingLabel, null);
});

test('Poker buy-in is distinguished from a start-time hold and stack is separate from wallet totals', () => {
  const view = Preflight.buildViewModel(fixedRoom({
    room: { code: 'POKR', gameId: 'poker', variant: 'holdem-nl-v1', phase: 'WAITING', revision: 3, requiresWagerSafety: true },
    viewer: {
      seatId: 'a', isHost: true,
      wallet: { currency: 'chip', available: 150, reserved: 200 },
      funding: { mode: 'poker-buy-in', amountToHold: null, shortfall: 50, stack: 0, minToStart: 10, minBuyIn: 200, maxBuyIn: 1000, minimumAdditionalBuyIn: 200 },
    },
    evaluation: { allowed: false, blockers: [{ code: 'BUY_IN_REQUIRED' }, { code: 'POKER_MIN_ELIGIBLE', details: { minimumPlayers: 2 } }] },
  }));
  assert.equal(view.funding.mode, 'poker-buy-in');
  assert.equal(view.funding.amountToHold, null);
  assert.equal(view.funding.poker.stack, 0);
  assert.equal(view.funding.shortfall, 50);
  assert.match(Preflight.formatAmount(1000), /1[.]000/);
});

test('casual and gem payloads remain explicit without assuming a coin wager', () => {
  const casual = Preflight.buildViewModel(fixedRoom({
    room: { code: 'GANG', gameId: 'the-gang', variant: 'gang-v1', phase: 'WAITING', revision: 1, requiresWagerSafety: false },
    viewer: { seatId: 'a', isHost: true, wallet: null, funding: { mode: 'none' } },
  }));
  assert.equal(casual.funding.mode, 'none');
  const gem = Preflight.buildViewModel(fixedRoom({
    viewer: { seatId: 'a', isHost: true, wallet: { currency: 'gem', available: 3, reserved: 1 }, funding: { mode: 'fixed-hold', amountToHold: 5, shortfall: 2 } },
  }));
  assert.equal(gem.currency, 'gem');
});

test('storage, capacity and minimum-player blockers resolve to actionable host messages', () => {
  const view = Preflight.buildViewModel(fixedRoom({
    seats: [{ id: 'a', name: 'An', ready: true, connected: true }],
    evaluation: { allowed: false, blockers: [
      { code: 'MIN_PLAYERS', details: { minimumPlayers: 2, playerCount: 1 } },
      { code: 'WALLET_CAPACITY' }, { code: 'STORAGE_UNSAFE' },
    ] },
  }));
  assert.deepEqual(view.blockers, [
    'Hiện có 1 người; cần ít nhất 2 người.',
    'Ví của ít nhất một người chưa đủ sức chứa khoản giữ hoặc thanh toán tối đa.',
    'Máy chủ đang gặp vấn đề lưu trữ; chưa thể bắt đầu ván có cược.',
  ]);
});

test('a nullable storage safety signal cannot show a wager room as startable', () => {
  const view = Preflight.buildViewModel(fixedRoom({
    evaluation: { allowed: true, blockers: [] },
    storage: { canStartWager: null },
  }));
  assert.equal(view.allowed, false);
  assert.deepEqual(view.blockers, ['Máy chủ chưa xác nhận tình trạng lưu trữ an toàn; ván cược tạm thời chưa thể bắt đầu.']);
});

test('a failed storage safety signal suppresses startability even if a stale snapshot says allowed', () => {
  const view = Preflight.buildViewModel(fixedRoom({
    evaluation: { allowed: true, blockers: [] },
    storage: { canStartWager: false },
  }));
  assert.equal(view.allowed, false);
  assert.deepEqual(view.blockers, ['Máy chủ đang gặp vấn đề lưu trữ; chưa thể bắt đầu ván có cược.']);
});

test('passes the live registry variants and seat limits without imposing a client-side start policy', () => {
  const cases = [
    ['the-gang', 'gang-v1', 2, 6, false, 'none'],
    ['uno', 'classic-local-v1', 2, 4, false, 'none'],
    ['uno', 'classic-108-v1', 2, 6, false, 'none'],
    ['bang', 'base-v1', 4, 7, false, 'none'],
    ['tien-len', 'local-v1', 2, 4, true, 'fixed-hold'],
    ['sam-loc', 'local-v1', 2, 5, true, 'fixed-hold'],
    ['phom', 'local-v1', 2, 4, true, 'fixed-hold'],
    ['poker', 'holdem-nl-v1', 2, 6, true, 'poker-buy-in'],
  ];
  for (const [gameId, variant, minPlayers, maxPlayers, requiresWagerSafety, mode] of cases) {
    const view = Preflight.buildViewModel(fixedRoom({
      room: { code: 'TEST', gameId, variant, phase: 'WAITING', revision: 1, minPlayers, maxPlayers, requiresWagerSafety },
      viewer: { seatId: 'a', isHost: true, wallet: mode === 'none' ? null : { currency: gameId === 'poker' ? 'chip' : 'coin', available: 1000, reserved: 0 }, funding: { mode } },
      evaluation: { allowed: true, blockers: [] },
      storage: { canStartWager: true },
    }));
    assert.equal(view.room.gameId, gameId);
    assert.equal(view.room.variant, variant);
    assert.equal(view.room.requiresWagerSafety, requiresWagerSafety);
    assert.equal(view.allowed, true);
  }
});

test('room capacity blocker remains an explicit server reason', () => {
  const view = Preflight.buildViewModel(fixedRoom({
    evaluation: { allowed: false, blockers: [{ code: 'ROOM_CAPACITY' }] },
  }));
  assert.deepEqual(view.blockers, ['Số ghế hiện tại vượt giới hạn của phòng.']);
});

test('unsafe or absent monetary values become unknown instead of fabricated numbers', () => {
  const view = Preflight.buildViewModel(fixedRoom({
    viewer: { seatId: 'a', isHost: true, wallet: { currency: 'coin', available: Number.MAX_SAFE_INTEGER + 1, reserved: -1 }, funding: { mode: 'fixed-hold', amountToHold: NaN, shortfall: -5 } },
  }));
  assert.deepEqual(view.wallet, { available: null, reserved: null });
  assert.equal(view.funding.amountToHold, null);
  assert.equal(view.funding.shortfall, null);
});

test('supports both explicit UNO variants without merging their identity', () => {
  const classic112 = Preflight.buildViewModel(fixedRoom({ room: { code: 'U112', gameId: 'uno', variant: 'classic-local-v1', phase: 'WAITING', revision: 4, requiresWagerSafety: false } }));
  const classic108 = Preflight.buildViewModel(fixedRoom({ room: { code: 'U108', gameId: 'uno', variant: 'classic-108-v1', phase: 'WAITING', revision: 4, requiresWagerSafety: false } }));
  assert.equal(classic112.room.variant, 'classic-local-v1');
  assert.equal(classic108.room.variant, 'classic-108-v1');
});

test('ignores server-provided prose and untrusted player markup when producing view values', () => {
  const payload = fixedRoom({
    seats: [{ id: 'x', name: '<img src=x onerror=alert(1)>', ready: false, connected: true }],
    evaluation: { allowed: false, blockers: [{ code: 'STORAGE_UNSAFE', message: 'private exception path C:\\secret' }] },
  });
  const view = Preflight.buildViewModel(payload);
  assert.equal(view.seats[0].name, '<img src=x onerror=alert(1)>');
  assert.equal(view.blockers[0], 'Máy chủ đang gặp vấn đề lưu trữ; chưa thể bắt đầu ván có cược.');
});

test('rejects unsupported or incomplete preflight contracts instead of guessing', () => {
  assert.throws(() => Preflight.buildViewModel({ schemaVersion: 2 }), /phiên bản/);
  assert.throws(() => Preflight.buildViewModel({ schemaVersion: 1 }), /thiếu trạng thái/);
});
