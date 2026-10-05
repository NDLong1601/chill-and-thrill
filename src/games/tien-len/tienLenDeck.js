'use strict';

// Tiến lên miền Nam local v1: ranks are ordered 3 ... A, 2; suit only
// breaks a tie between single cards: bích < chuồn < rô < cơ.
const RANKS = Object.freeze(['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2']);
const SUITS = Object.freeze([
  { id: 'S', label: '♠', name: 'Bích' },
  { id: 'C', label: '♣', name: 'Chuồn' },
  { id: 'D', label: '♦', name: 'Rô' },
  { id: 'H', label: '♥', name: 'Cơ' },
]);
const rankValue = rank => RANKS.indexOf(rank);
const suitValue = suit => SUITS.findIndex(item => item.id === suit);

function createTienLenDeck() {
  return RANKS.flatMap(rank => SUITS.map(suit => ({ id: `${rank}${suit.id}`, rank, suit: suit.id })));
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
  return rankValue(left.rank) - rankValue(right.rank) || suitValue(left.suit) - suitValue(right.suit);
}

function labelCard(card) {
  return `${card.rank}${SUITS.find(item => item.id === card.suit)?.label || ''}`;
}

function classify(cards) {
  if (!Array.isArray(cards) || !cards.length) return null;
  const ordered = [...cards].sort(compareCards);
  const values = ordered.map(card => rankValue(card.rank));
  const groups = new Map();
  values.forEach(value => groups.set(value, (groups.get(value) || 0) + 1));
  const highest = values.at(-1);
  if (ordered.length === 1) return { kind: 'single', length: 1, power: highest, suit: suitValue(ordered[0].suit), cards: ordered };
  if (groups.size === 1 && ordered.length <= 4) {
    const kind = ['single', 'pair', 'triple', 'four'][ordered.length];
    return { kind, length: ordered.length, power: highest, cards: ordered };
  }
  const unique = [...groups.keys()].sort((a, b) => a - b);
  const contiguous = unique.every((value, index) => index === 0 || value === unique[index - 1] + 1);
  if (ordered.length >= 3 && groups.size === ordered.length && highest < rankValue('2') && contiguous) {
    return { kind: 'straight', length: ordered.length, power: highest, cards: ordered };
  }
  if (ordered.length >= 6 && ordered.length % 2 === 0 && groups.size === ordered.length / 2 && [...groups.values()].every(count => count === 2) && highest < rankValue('2') && contiguous) {
    return { kind: 'pair-run', length: ordered.length, power: highest, cards: ordered };
  }
  return null;
}

function formationName(formation) {
  if (!formation) return 'tổ hợp không hợp lệ';
  const names = { single: 'rác', pair: 'đôi', triple: 'sám', four: 'tứ quý', straight: 'sảnh', 'pair-run': 'đôi thông' };
  return `${names[formation.kind]} ${formation.cards.map(labelCard).join(' ')}`;
}

function canBeat(next, top) {
  if (!next) return false;
  if (!top) return true;
  const isTwo = top.power === rankValue('2');
  if (top.kind === 'single' && isTwo && (next.kind === 'four' || (next.kind === 'pair-run' && next.length >= 6))) return true;
  if (top.kind === 'pair' && isTwo && (next.kind === 'four' || (next.kind === 'pair-run' && next.length >= 8))) return true;
  if (top.kind === 'four' && next.kind === 'pair-run' && next.length >= 8) return true;
  if (next.kind !== top.kind || next.length !== top.length) return false;
  if (next.power !== top.power) return next.power > top.power;
  return next.kind === 'single' && next.suit > top.suit;
}

function whiteWin(cards) {
  const formations = [];
  const rankCounts = new Map();
  cards.forEach(card => rankCounts.set(rankValue(card.rank), (rankCounts.get(rankValue(card.rank)) || 0) + 1));
  if (rankCounts.get(rankValue('2')) === 4) formations.push({ priority: 5, label: 'tứ quý 2' });
  if (Array.from({ length: 12 }, (_item, index) => rankCounts.has(index)).every(Boolean)) formations.push({ priority: 4, label: 'sảnh rồng 3 đến A' });
  if ([...rankCounts.values()].filter(count => count === 2).length >= 6) formations.push({ priority: 3, label: 'sáu đôi' });
  for (let start = 0; start <= 7; start++) if (Array.from({ length: 5 }, (_item, index) => (rankCounts.get(start + index) || 0) >= 2).every(Boolean)) formations.push({ priority: 2, label: 'năm đôi thông' });
  if ([...rankCounts.values()].filter(count => count >= 3).length >= 4) formations.push({ priority: 1, label: 'bốn sám' });
  return formations.sort((left, right) => right.priority - left.priority)[0] || null;
}

module.exports = { RANKS, SUITS, createTienLenDeck, shuffle, rankValue, suitValue, compareCards, labelCard, classify, formationName, canBeat, whiteWin };
