'use strict';

// Phỏm deliberately has its own card helpers.  Its Ace is low for dây and
// its point values differ from the shedding games in this project.
const RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
const SUITS = Object.freeze(['S', 'C', 'D', 'H']);
const SUIT_LABELS = Object.freeze({ S: '♠', C: '♣', D: '♦', H: '♥' });
const rankValue = rank => RANKS.indexOf(rank) + 1;
const cardPoints = card => rankValue(card.rank);

function createPhomDeck() { return RANKS.flatMap(rank => SUITS.map(suit => ({ id: `${rank}${suit}`, rank, suit }))); }
function shuffle(cards) { const next = [...cards]; for (let i = next.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [next[i], next[j]] = [next[j], next[i]]; } return next; }
function compareCards(left, right) { return rankValue(left.rank) - rankValue(right.rank) || SUITS.indexOf(left.suit) - SUITS.indexOf(right.suit); }
function labelCard(card) { return `${card.rank}${SUIT_LABELS[card.suit] || ''}`; }

function classifyMeld(cards) {
  if (!Array.isArray(cards) || cards.length < 3 || new Set(cards.map(card => card?.id)).size !== cards.length) return null;
  const ordered = [...cards].sort(compareCards);
  if (ordered.every(card => card.rank === ordered[0].rank) && ordered.length <= 4) return { kind: 'set', cards: ordered };
  if (ordered.every(card => card.suit === ordered[0].suit) && ordered.every((card, index) => !index || rankValue(card.rank) === rankValue(ordered[index - 1].rank) + 1)) return { kind: 'run', cards: ordered };
  return null;
}

function combinations(items, count) {
  if (count === 0) return [[]]; if (items.length < count) return [];
  const [head, ...tail] = items;
  return [...combinations(tail, count - 1).map(group => [head, ...group]), ...combinations(tail, count)];
}

function candidateMelds(cards) {
  const candidates = [], seen = new Set();
  for (const rank of RANKS) {
    const same = cards.filter(card => card.rank === rank);
    for (const size of [3, 4]) for (const group of combinations(same, size)) add(group);
  }
  for (const suit of SUITS) {
    const sameSuit = cards.filter(card => card.suit === suit).sort(compareCards);
    for (let start = 0; start < sameSuit.length; start++) for (let end = start + 3; end <= sameSuit.length; end++) {
      const group = sameSuit.slice(start, end); if (classifyMeld(group)?.kind === 'run') add(group);
    }
  }
  function add(group) { const key = group.map(card => card.id).sort().join('|'); if (!seen.has(key)) { seen.add(key); candidates.push(classifyMeld(group)); } }
  return candidates;
}

// Enumerate compatible phỏm plans instead of greedily taking the first dây.
// Ten cards is the largest hand this variant examines, so exhaustive search
// remains small and keeps overlapping phỏm correct.
function bestMeldPlan(cards, requiredCardIds = []) {
  const candidates = candidateMelds(cards), required = new Set(requiredCardIds), allIds = new Set(cards.map(card => card.id));
  if ([...required].some(id => !allIds.has(id))) return null;
  let best = null;
  function evaluate(groups, used) {
    if (![...required].every(id => used.has(id))) return;
    const leftovers = cards.filter(card => !used.has(card.id));
    const candidate = { melds: groups.map(group => group.cards), usedIds: [...used], leftoverCards: leftovers, points: leftovers.reduce((sum, card) => sum + cardPoints(card), 0) };
    if (!best || candidate.points < best.points || (candidate.points === best.points && candidate.usedIds.length > best.usedIds.length)) best = candidate;
  }
  function visit(index, groups, used) {
    if (index === candidates.length) return evaluate(groups, used);
    visit(index + 1, groups, used);
    const group = candidates[index]; if (group.cards.some(card => used.has(card.id))) return;
    const next = new Set(used); group.cards.forEach(card => next.add(card.id)); visit(index + 1, [...groups, group], next);
  }
  visit(0, [], new Set()); return best || (required.size ? null : { melds: [], usedIds: [], leftoverCards: [...cards], points: cards.reduce((sum, card) => sum + cardPoints(card), 0) });
}

function canDiscard(cards, cardId, requiredCardIds = []) {
  if (!cards.some(card => card.id === cardId) || requiredCardIds.includes(cardId)) return false;
  return Boolean(bestMeldPlan(cards.filter(card => card.id !== cardId), requiredCardIds));
}

function validateMeldGroups(cards, groups, requiredCardIds = []) {
  if (!Array.isArray(groups)) return null;
  const byId = new Map(cards.map(card => [card.id, card])), used = new Set(), melds = [];
  for (const ids of groups) {
    if (!Array.isArray(ids) || ids.length < 3 || ids.length > 10 || new Set(ids).size !== ids.length) return null;
    const group = ids.map(id => byId.get(id)); if (group.some(card => !card) || group.some(card => used.has(card.id))) return null;
    const meld = classifyMeld(group); if (!meld) return null;
    group.forEach(card => used.add(card.id)); melds.push(meld);
  }
  if (![...new Set(requiredCardIds)].every(id => used.has(id))) return null;
  return { melds, usedIds: used };
}

module.exports = { RANKS, SUITS, SUIT_LABELS, rankValue, cardPoints, createPhomDeck, shuffle, compareCards, labelCard, classifyMeld, candidateMelds, bestMeldPlan, canDiscard, validateMeldGroups };
