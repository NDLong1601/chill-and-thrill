'use strict';

const TienLenRules = require('../../public/js/tien-len-rules');

const UNO_COLORS = Object.freeze(['red', 'blue', 'green', 'yellow']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);

function requireProjection(projection, gameId, variant) {
  if (!projection || projection.schemaVersion !== 1 || projection.gameId !== gameId || projection.variant !== variant ||
      !projection.publicState || !Array.isArray(projection.ownHand)) {
    throw new TypeError('Bot policy requires a sanitized own-seat projection.');
  }
  for (const forbidden of ['room', 'match', 'hands', 'drawPile', 'profileId', 'profileToken', 'wallet', 'ledger', 'reservations']) {
    if (own(projection, forbidden)) throw new TypeError(`Bot projection contains forbidden field: ${forbidden}`);
  }
  for (const player of projection.publicState.players || []) {
    if (!player || Object.keys(player).some(key => !['id', 'name', 'handCount', 'cardCount', 'isCurrent', 'isHost', 'unoCalled'].includes(key))) {
      throw new TypeError('Bot projection contains non-public player fields.');
    }
  }
}

function colorCounts(hand) {
  return Object.fromEntries(UNO_COLORS.map(color => [color, hand.filter(card => card.color === color).length]));
}

function chooseColor(hand) {
  const counts = colorCounts(hand);
  return UNO_COLORS.reduce((best, color) => counts[color] > counts[best] ? color : best, UNO_COLORS[0]);
}

function chooseUnoAction(projection) {
  requireProjection(projection, 'uno', 'classic-local-v1');
  const actions = projection.legalActions;
  if (!Array.isArray(actions) || !actions.length) return null;
  const publicState = projection.publicState;
  const hand = projection.ownHand;
  const find = type => actions.find(action => action.type === type);

  if (find('call_uno')) return { type: 'call_uno', payload: {} };
  if (find('catch_uno')) return { type: 'catch_uno', payload: {} };
  if (find('choose_color')) return { type: 'choose_color', payload: { color: chooseColor(hand) } };
  if (find('draw_penalty')) return { type: 'draw_penalty', payload: {} };
  // Challenge truth depends on the offender's private hand. The bot has no
  // access to it, so it takes the legal, predictable penalty response.
  if (find('challenge_draw_four')) return { type: 'draw_penalty', payload: {} };

  const playable = actions.filter(action => action.type === 'play_card' || action.type === 'play_drawn');
  if (playable.length) {
    const cardFor = action => hand.find(card => card.id === action.cardId);
    const opponentCounts = publicState.players.filter(player => player.id !== projection.seatId).map(player => player.handCount);
    const urgent = opponentCounts.some(count => count === 1);
    playable.sort((left, right) => {
      const score = action => {
        const card = cardFor(action);
        if (!card) return Number.MAX_SAFE_INTEGER;
        let value = 0;
        if (card.type === 'wild4') value += 30;
        else if (card.type === 'wild') value += 24;
        else if (card.type === 'draw2') value += urgent ? -20 : 8;
        else if (card.type === 'skip' || card.type === 'reverse') value += urgent ? -12 : 4;
        if (card.type === 'number') value -= Number(card.value) || 0;
        // Keep wilds while ordinary legal cards remain, except when this is
        // the final card and winning is immediately available.
        if ((card.type === 'wild' || card.type === 'wild4') && hand.length > 2) value += 20;
        return value;
      };
      return score(left) - score(right) || String(left.cardId).localeCompare(String(right.cardId));
    });
    const action = playable[0];
    const card = cardFor(action);
    const payload = { cardId: action.cardId };
    if (card && (card.type === 'wild' || card.type === 'wild4')) payload.chosenColor = chooseColor(hand.filter(item => item.id !== card.id));
    if (hand.length === 2) payload.callUno = true;
    return { type: action.type, payload };
  }
  if (find('draw_card')) return { type: 'draw_card', payload: {} };
  if (find('pass_draw')) return { type: 'pass_draw', payload: {} };
  return null;
}

function possibleTienLenPlays(projection) {
  const hand = projection.ownHand;
  const publicState = projection.publicState;
  const isLead = !publicState.topPlay;
  const requiredCardId = publicState.initialRequiredCardId;
  const topFormation = publicState.topPlay?.formation || null;
  const options = [];
  const count = hand.length;

  for (let mask = 1; mask < (1 << count); mask += 1) {
    const cards = [];
    for (let index = 0; index < count; index += 1) if (mask & (1 << index)) cards.push(hand[index]);
    if (requiredCardId && !cards.some(card => card.id === requiredCardId)) continue;
    const formation = TienLenRules.classify(cards);
    if (!formation || (!isLead && !TienLenRules.canBeat(formation, topFormation))) continue;
    options.push({ cards, formation });
  }
  return options;
}

function chooseTienLenAction(projection) {
  requireProjection(projection, 'tien-len', 'south-v1');
  if (projection.publicState.currentPlayerId !== projection.seatId) return null;
  const plays = possibleTienLenPlays(projection);
  if (!plays.length) {
    if (projection.publicState.topPlay && projection.publicState.leaderId !== projection.seatId) return { action: 'pass' };
    return null;
  }

  plays.sort((left, right) => {
    const leadWeight = projection.publicState.topPlay ? 0 : -3;
    const score = play => play.formation.power * 100 + play.formation.length * (8 + leadWeight) +
      (play.formation.kind === 'four' ? 3 : play.formation.kind === 'pair-run' ? 2 : 0);
    return score(left) - score(right) || left.cards.map(card => card.id).join(',').localeCompare(right.cards.map(card => card.id).join(','));
  });
  return { action: 'play', cardIds: plays[0].cards.map(card => card.id) };
}

module.exports = {
  chooseUnoAction,
  chooseTienLenAction,
  possibleTienLenPlays,
  requireProjection,
};
