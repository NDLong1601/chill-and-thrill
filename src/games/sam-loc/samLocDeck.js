'use strict';

// Sâm lốc local v1 uses the same physical deck as Tiến lên but intentionally
// does not use suit order or any cutting combinations.  This keeps the two
// rule sets separate despite sharing familiar card formations.
const RANKS = Object.freeze(['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2']);
const SUITS = Object.freeze(['S', 'C', 'D', 'H']);
const SUIT_LABELS = Object.freeze({ S: '♠', C: '♣', D: '♦', H: '♥' });
const rankValue = rank => RANKS.indexOf(rank);

function createSamLocDeck() {
  return RANKS.flatMap(rank => SUITS.map(suit => ({ id: `${rank}${suit}`, rank, suit })));
}

function shuffle(cards) {
  const next = [...cards];
  for (let index = next.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [next[index], next[other]] = [next[other], next[index]];
  }
  return next;
}

function compareCards(left, right) {
  return rankValue(left.rank) - rankValue(right.rank) || SUITS.indexOf(left.suit) - SUITS.indexOf(right.suit);
}

function labelCard(card) { return `${card.rank}${SUIT_LABELS[card.suit] || ''}`; }

function classify(cards) {
  if (!Array.isArray(cards) || !cards.length) return null;
  const ordered = [...cards].sort(compareCards);
  const counts = new Map();
  ordered.forEach(card => counts.set(rankValue(card.rank), (counts.get(rankValue(card.rank)) || 0) + 1));
  const values = [...counts.keys()].sort((left, right) => left - right);
  const high = values.at(-1);
  if (ordered.length === 1) return { kind: 'single', length: 1, power: high, cards: ordered };
  if (counts.size === 1 && ordered.length === 2) return { kind: 'pair', length: 2, power: high, cards: ordered };
  if (counts.size === 1 && ordered.length === 3) return { kind: 'triple', length: 3, power: high, cards: ordered };
  if (counts.size === 1 && ordered.length === 4) return { kind: 'four', length: 4, power: high, cards: ordered };
  const contiguous = values.every((value, index) => !index || value === values[index - 1] + 1);
  // Local v1 never permits 2 in a sảnh, and suit does not break a tie.
  if (ordered.length >= 3 && counts.size === ordered.length && high < rankValue('2') && contiguous) return { kind: 'straight', length: ordered.length, power: high, cards: ordered };
  return null;
}

function canBeat(next, top) {
  return Boolean(next && (!top || (next.kind === top.kind && next.length === top.length && next.power > top.power)));
}

function formationName(formation) {
  if (!formation) return 'tổ hợp không hợp lệ';
  const names = { single: 'rác', pair: 'đôi', triple: 'sám', four: 'tứ quý', straight: 'sảnh' };
  return `${names[formation.kind]} ${formation.cards.map(labelCard).join(' ')}`;
}

module.exports = { RANKS, SUITS, SUIT_LABELS, rankValue, createSamLocDeck, shuffle, compareCards, labelCard, classify, canBeat, formationName };
