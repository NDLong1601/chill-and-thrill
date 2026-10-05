'use strict';

const COLORS = Object.freeze(['red', 'yellow', 'green', 'blue']);
const COLOR_NAMES = Object.freeze({ red: 'Đỏ', yellow: 'Vàng', green: 'Xanh lá', blue: 'Xanh dương' });
const SYMBOL_NAMES = Object.freeze({ skip: 'Bỏ lượt', reverse: 'Đổi chiều', draw2: '+2', wild: 'Đổi màu', wild4: '+4 đổi màu' });

function shuffle(cards, random = Math.random) {
  const copy = [...cards];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function makeCard(id, color, symbol) {
  return Object.freeze({ id, color, symbol, kind: typeof symbol === 'number' ? 'number' : symbol });
}

function createUnoDeck() {
  const cards = [];
  for (const color of COLORS) {
    cards.push(makeCard(`${color}-0-0`, color, 0));
    for (let number = 1; number <= 9; number++) {
      cards.push(makeCard(`${color}-${number}-0`, color, number));
      cards.push(makeCard(`${color}-${number}-1`, color, number));
    }
    for (const symbol of ['skip', 'reverse', 'draw2']) {
      cards.push(makeCard(`${color}-${symbol}-0`, color, symbol));
      cards.push(makeCard(`${color}-${symbol}-1`, color, symbol));
    }
  }
  for (let i = 0; i < 4; i++) {
    cards.push(makeCard(`wild-${i}`, null, 'wild'));
    cards.push(makeCard(`wild4-${i}`, null, 'wild4'));
  }
  return cards;
}

function cardLabel(card) {
  return typeof card.symbol === 'number' ? String(card.symbol) : SYMBOL_NAMES[card.symbol] || String(card.symbol);
}

module.exports = { COLORS, COLOR_NAMES, SYMBOL_NAMES, createUnoDeck, shuffle, cardLabel };
