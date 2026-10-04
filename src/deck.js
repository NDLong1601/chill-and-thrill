'use strict';

const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
// 2-10, 11=Jack, 12=Queen, 13=King, 14=Ace
const VALUES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const value of VALUES) {
      deck.push({ suit, value });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Deal cards for one round.
 * Supports configurable cardsPerPlayer (e.g. 2 default, or 3 for Challenge #10 Security Camera).
 */
function deal(numPlayers, cardsPerPlayer = 2) {
  const deck = shuffleDeck(createDeck());
  const playerHands = Array.from({ length: numPlayers }, () => []);

  // Deal cardsPerPlayer each (alternating like real poker)
  for (let round = 0; round < cardsPerPlayer; round++) {
    for (let p = 0; p < numPlayers; p++) {
      playerHands[p].push(deck.pop());
    }
  }

  // 5 community cards
  const communityCards = deck.splice(-5);

  return { playerHands, communityCards, remainingDeck: deck };
}

module.exports = { createDeck, shuffleDeck, deal };
