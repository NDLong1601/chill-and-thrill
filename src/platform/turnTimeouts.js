'use strict';

const { installTurnClock, standardTurn } = require('./turnClock');
const { runServerAction } = require('./reconnectGrace');

function attachGameClock(manager, gameId) {
  installTurnClock(manager, { getTurn: standardTurn, timeoutAction(room, player, socket) {
    const send = (action, extra = {}) => runServerAction(manager, room, player, { action, ...extra });
    if (['tien-len', 'sam-loc'].includes(gameId)) {
      if (room.topPlay && room.leaderId !== player.id) return send('pass');
      const card = player.hand.find(item => !room.playedAny && item.id === room.initialRequiredCardId) || player.hand[0];
      if (card) return send('play', { cardIds: [card.id] });
      return send('pass');
    }
    if (gameId === 'poker') return send(room.currentBet === player.roundBet ? 'check' : 'fold');
    if (gameId === 'phom') {
      const { bestMeldPlan, canDiscard } = require('../games/phom/phomDeck');
      if (room.phase === 'LAYDOWN') {
        const plan = bestMeldPlan(player.hand, player.eatenCardIds);
        return send('lay_down', { melds: plan?.melds.map(cards => cards.map(card => card.id)) || [], sends: [] });
      }
      if (room.phase === 'DRAW_OR_EAT') {
        const result = send('draw');
        if (result?.error || result?.ok === false) return result;
      }
      if (room.phase === 'DISCARD' && room.currentPlayerId === player.id) {
        const card = player.hand.find(item => canDiscard(player.hand, item.id, player.eatenCardIds));
        if (card) return send('discard', { cardId: card.id });
        return send('declare_u');
      }
    }
    if (gameId === 'uno') {
      if (room.phase === 'DRAW_PENALTY') return send('draw_penalty');
      if (!room.drawnCardId) {
        const result = send('draw');
        if (result?.error || result?.ok === false) return result;
      }
      if (room.currentPlayerId === player.id && room.phase === 'TURN') return send('pass');
    }
    if (gameId === 'bang') {
      const { isHeart, isDynamiteHit } = require('../games/bang/bangDeck');
      const pending = room.pending;
      if (pending) {
        if (pending.kind === 'GENERAL_STORE') return send('respond', { cardId: pending.cards[0]?.id });
        if (pending.kind === 'KIT_DRAW') return send('respond', { cardIds: pending.options.slice(0, 2).map(card => card.id) });
        if (pending.kind === 'DRAW_CHECK') {
          const favorable = pending.reason === 'DYNAMITE' ? pending.options.findIndex(card => !isDynamiteHit(card)) : pending.options.findIndex(isHeart);
          return send('respond', { choiceIndex: favorable >= 0 ? favorable : 0 });
        }
        if (pending.kind === 'ATTACK') {
          const miss = player.hand.find(card => manager.isMissCard?.(player, card));
          if (miss) return send('respond', { response: 'miss', cardId: miss.id });
          if (pending.barrelAttempts > 0) return send('respond', { response: 'barrel' });
          return send('respond', { response: 'take' });
        }
        if (['INDIANS', 'DUEL'].includes(pending.kind)) {
          const bang = player.hand.find(card => manager.isBangCard?.(player, card));
          return bang ? send('respond', { response: 'bang', cardId: bang.id }) : send('respond', { response: 'take' });
        }
        if (pending.kind === 'LETHAL') {
          const beer = player.hand.find(card => card.type === 'BEER');
          if (beer && manager.living(room).length > 2) return send('respond', { response: 'beer', cardId: beer.id });
          return send('respond', { response: 'give_up' });
        }
      }
      if (room.phase === 'DRAW') {
        const result = send('draw_cards');
        if (result?.error || result?.ok === false) return result;
      }
      if (room.phase === 'MAIN' && !room.pending) return send('end_turn', { cardIds: player.hand.slice(0, Math.max(0, player.hand.length - player.hp)).map(card => card.id) });
    }
  } });
}

module.exports = { attachGameClock };
