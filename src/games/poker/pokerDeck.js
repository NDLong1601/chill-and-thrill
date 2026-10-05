'use strict';

// This deck is intentionally separate from The Gang's deck.  It contains no
// specialist / Jack effects and its card shape is exactly what the standard
// hand evaluator consumes.
const RANKS = Object.freeze([
  ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7], ['8', 8],
  ['9', 9], ['10', 10], ['J', 11], ['Q', 12], ['K', 13], ['A', 14],
]);
const SUITS = Object.freeze([
  ['S', '♠'], ['C', '♣'], ['D', '♦'], ['H', '♥'],
]);

function createPokerDeck() {
  return RANKS.flatMap(([rank, value]) => SUITS.map(([suit, suitLabel]) => ({ id: `${rank}${suit}`, rank, value, suit, suitLabel })));
}

function shuffle(cards) {
  const next = [...cards];
  for (let index = next.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [next[index], next[other]] = [next[other], next[index]];
  }
  return next;
}

function labelCard(card) { return `${card.rank}${card.suitLabel || SUITS.find(item => item[0] === card.suit)?.[1] || ''}`; }

module.exports = { RANKS, SUITS, createPokerDeck, shuffle, labelCard };
