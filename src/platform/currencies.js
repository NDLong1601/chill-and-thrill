'use strict';

const COIN_PER_GEM = 10_000_000;
const STARTING_COINS = 1000;
const CURRENCIES = Object.freeze({
  chip: { available: 'available', reserved: 'reserved', max: 1_000_000_000 },
  coin: { available: 'coin_available', reserved: 'coin_reserved', max: 1_000_000_000_000 },
  gem: { available: 'gem_available', reserved: 'gem_reserved', max: 100_000_000 },
});
function validateAmount(value, currency = 'chip') {
  const definition = CURRENCIES[currency];
  return Boolean(definition && Number.isSafeInteger(value) && value > 0 && value <= definition.max);
}
const currencyForGame = gameId => gameId === 'poker' ? 'chip' : ['tien-len', 'sam-loc', 'phom'].includes(gameId) ? 'coin' : null;
module.exports = { COIN_PER_GEM, STARTING_COINS, CURRENCIES, currencyForGame, validateAmount };
