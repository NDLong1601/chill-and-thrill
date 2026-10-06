'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const GameValues = require('../public/js/game-values');

test('shared economy reader keeps stake, max loss, and server currency independent', () => {
  const room = { gameId: 'tien-len', currency: 'chip', stake: 50, maxLoss: 500, result: null };
  assert.deepEqual(GameValues.readEconomy(room), { currency: 'chip', stake: 50, maxLoss: 500 });
  assert.equal(GameValues.describeEconomy(room), 'Cược 50 chip/người · giữ tối đa 500 chip/người');
  assert.equal(GameValues.describeEconomy(room, { includeMaxLoss: false }), 'Cược 50 chip/người');
});

test('result values override live values and missing max loss stays explicitly unknown', () => {
  assert.deepEqual(GameValues.readEconomy({
    currency: 'coin', phase: 'RESULT', stake: 50, maxLoss: 100,
    result: { stake: 500, maxLoss: 1000 },
  }), { currency: 'coin', stake: 500, maxLoss: 1000 });
  assert.deepEqual(GameValues.readEconomy({ gameId: 'tien-len', stake: 10000 }), { currency: '', stake: 10000, maxLoss: null });
  assert.equal(GameValues.describeEconomy({ gameId: 'tien-len', stake: 10000 }), 'Cược 10.000/người · mức giữ tối đa đang chờ xác nhận');
});
