'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getBestHand } = require('../src/handEvaluator');
const { createPokerDeck } = require('../src/games/poker/pokerDeck');
const { PokerManager, contributionPots, refundUncalled, SMALL_BLIND, BIG_BLIND, MIN_BUY_IN, MAX_BUY_IN } = require('../src/games/poker/pokerEngine');

test('Poker uses a standard 52-card deck and no The Gang card effects', () => {
  const deck = createPokerDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map(card => card.id)).size, 52);
  assert.equal(SMALL_BLIND, 5); assert.equal(BIG_BLIND, 10);
  assert.equal(MIN_BUY_IN, 200); assert.equal(MAX_BUY_IN, 1000);
});

test('Poker evaluator resolves board tie, wheel, and kicker from seven cards', () => {
  const card = (rank, value, suit) => ({ rank, value, suit });
  const board = [card('A', 14, 'S'), card('K', 13, 'S'), card('Q', 12, 'S'), card('J', 11, 'S'), card('10', 10, 'S')];
  assert.equal(getBestHand([card('2', 2, 'C'), card('3', 3, 'D')], board).score, getBestHand([card('4', 4, 'C'), card('5', 5, 'D')], board).score);
  const wheel = getBestHand([card('A', 14, 'D'), card('2', 2, 'D')], [card('3', 3, 'C'), card('4', 4, 'H'), card('5', 5, 'S'), card('K', 13, 'C'), card('Q', 12, 'D')]);
  assert.equal(wheel.nameVi, 'Sảnh');
  const aceKicker = getBestHand([card('A', 14, 'D'), card('9', 9, 'D')], [card('K', 13, 'C'), card('K', 13, 'H'), card('3', 3, 'S'), card('4', 4, 'C'), card('5', 5, 'D')]);
  const queenKicker = getBestHand([card('Q', 12, 'D'), card('9', 9, 'C')], [card('K', 13, 'C'), card('K', 13, 'H'), card('3', 3, 'S'), card('4', 4, 'C'), card('5', 5, 'D')]);
  assert.ok(aceKicker.score > queenKicker.score);
});

test('Poker builds main/side pots then returns unmatched excess', () => {
  const players = [
    { id: 'a', totalContribution: 100, stack: 0, folded: false },
    { id: 'b', totalContribution: 250, stack: 0, folded: false },
    { id: 'c', totalContribution: 500, stack: 0, folded: false },
  ];
  assert.deepEqual(refundUncalled(players), [{ playerId: 'c', amount: 250 }]);
  assert.equal(players[2].stack, 250);
  const pots = contributionPots(players);
  assert.deepEqual(pots.map(pot => pot.amount), [300, 300]);
  assert.deepEqual(pots.map(pot => pot.eligible), [['a', 'b', 'c'], ['b', 'c']]);
});

test('Poker keeps folded contribution in the pot but removes fold player eligibility', () => {
  const players = [
    { id: 'a', totalContribution: 100, stack: 0, folded: false },
    { id: 'b', totalContribution: 100, stack: 0, folded: true },
    { id: 'c', totalContribution: 100, stack: 0, folded: false },
  ];
  const pots = contributionPots(players);
  assert.equal(pots[0].amount, 300);
  assert.deepEqual(pots[0].eligible, ['a', 'c']);
});

test('Poker applies the no-limit short all-in reopening rule cumulatively', () => {
  const manager = new PokerManager({ sockets: { sockets: new Map() } }, { profileStore: { publicProfile: () => null } });
  const room = { code: 'TEST', phase: 'HAND', players: [], currentBet: 100, lastFullRaise: 50, currentPlayerId: 'b', buttonPlayerId: 'a', street: 'PREFLOP', community: [], deck: [], log: [], revision: 0, actionIds: {} };
  const player = (id, stack, roundBet, lastActionBet) => ({ id, name: id, socketId: id, connected: true, inHand: true, folded: false, allIn: false, stack, roundBet, totalContribution: roundBet, lastActionBet, holeCards: [] });
  const a = player('a', 400, 100, 100), b = player('b', 30, 100, null), c = player('c', 60, 100, null); room.players = [a, b, c];
  const socket = id => ({ id, emit: () => {} });
  assert.equal(manager.bettingAction(socket('b'), room, b, { action: 'all_in' }), true);
  assert.equal(room.currentBet, 130); assert.equal(room.lastFullRaise, 50); assert.equal(room.currentPlayerId, 'c');
  assert.equal(manager.bettingAction(socket('c'), room, c, { action: 'all_in' }), true);
  assert.equal(room.currentBet, 160); assert.equal(room.currentPlayerId, 'a');
  assert.equal(manager.legalActions(room, a).canRaise, true);
  manager.close();
});

test('Poker splits a tied main pot, awards a separate side pot, and gives odd chip left of button', () => {
  const manager = new PokerManager({ sockets: { sockets: new Map() } }, { profileStore: { publicProfile: () => null } });
  const card = (rank, value, suit) => ({ rank, value, suit }); const board = [card('A', 14, 'S'), card('K', 13, 'D'), card('Q', 12, 'H'), card('J', 11, 'C'), card('2', 2, 'S')];
  const make = (id, contribution, holeCards) => ({ id, name: id, inHand: true, folded: false, totalContribution: contribution, holeCards, stack: 0 });
  const a = make('a', 101, [card('10', 10, 'D'), card('3', 3, 'C')]); const b = make('b', 251, [card('10', 10, 'H'), card('4', 4, 'C')]); const c = make('c', 251, [card('9', 9, 'D'), card('9', 9, 'C')]);
  const room = { players: [a, b, c], buttonPlayerId: 'a', community: board };
  const { pots, payouts } = manager.resolvePots(room, [a, b, c]);
  assert.deepEqual(pots.map(pot => pot.amount), [303, 300]);
  assert.equal(payouts.get('a'), 151); assert.equal(payouts.get('b'), 452); assert.equal(payouts.get('c'), 0);
  manager.close();
});
