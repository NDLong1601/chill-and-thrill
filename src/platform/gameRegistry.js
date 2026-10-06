'use strict';

const { parseAmount } = require('../../public/js/game-values');

// The registry is deliberately data-only.  Transport code derives category and
// availability from here instead of trusting a value sent by a browser.
const GAMES = Object.freeze({
  'the-gang': Object.freeze({
    id: 'the-gang', category: 'casual', name: 'The Gang', status: 'playable',
    minPlayers: 2, maxPlayers: 6, rulesPath: '/api/rules',
  }),
  uno: Object.freeze({
    id: 'uno', category: 'casual', name: 'UNO', status: 'playable',
    minPlayers: 2, maxPlayers: 6, rulesPath: '/docs/rules/uno.md',
  }),
  'tien-len': Object.freeze({ id: 'tien-len', category: 'thrill', name: 'Tiến lên', status: 'playable', minPlayers: 2, maxPlayers: 4, rulesPath: '/docs/rules/tien-len.md', stake: 100 }),
  poker: Object.freeze({ id: 'poker', category: 'thrill', name: 'Poker Texas Hold’em', status: 'playable', minPlayers: 2, maxPlayers: 6, rulesPath: '/docs/rules/poker.md', blinds: { small: 5, big: 10 }, buyIn: { min: 200, max: 1000 } }),
  'sam-loc': Object.freeze({ id: 'sam-loc', category: 'thrill', name: 'Sâm lốc', status: 'playable', minPlayers: 2, maxPlayers: 5, rulesPath: '/docs/rules/sam-loc.md', stake: 20 }),
  phom: Object.freeze({ id: 'phom', category: 'thrill', name: 'Phỏm', status: 'playable', minPlayers: 2, maxPlayers: 4, rulesPath: '/docs/rules/phom.md', stake: 10 }),
  bang: Object.freeze({ id: 'bang', category: 'casual', name: 'BANG!', status: 'playable', minPlayers: 4, maxPlayers: 7, rulesPath: '/docs/rules/bang.md' }),
});

function getGame(gameId) {
  return GAMES[gameId] ? portalGame(GAMES[gameId]) : null;
}

function publicGames() {
  return Object.values(GAMES);
}

const PORTAL_NAME = process.env.GANG_PORTAL_NAME || 'Chill & Thrill';
const descriptions = {
  'the-gang': 'Phối hợp đọc bài và đục két cùng cả đội.', uno: 'Đánh lá chức năng và gọi UNO đúng lúc.',
  bang: 'Vai ẩn, khoảng cách và những phát súng bất ngờ.', poker: 'Đọc đối thủ, chọn thời điểm và cược bằng chip.',
  'tien-len': 'Tiến lên miền Nam với coin.', 'sam-loc': 'Báo Sâm, chặn Sâm và đấu trí bằng coin.', phom: 'Bốc, ăn, đánh và hạ phỏm bằng coin.',
};
function portalGame(game) {
  return { ...game, gameId: game.id, rulesVersion: 1, shortDescription: descriptions[game.id], currency: require('./currencies').currencyForGame(game.id),
    ...(game.stake ? { stakeRules: publicStakeRules(game.id) } : {}),
    variants: game.id === 'uno' ? [{ id: 'classic-local-v1', name: '112 lá · 2–4 người' }, { id: 'classic-108-v1', name: '108 lá · 2–6 người' }] : [],
    capabilities: { usesWallet: game.category === 'thrill', privateState: true, supportsResume: true, supportsQr: true, supportsHistory: true } };
}
function publicCatalog() { return { version: 2, portalName: PORTAL_NAME, categories: ['casual', 'thrill'], games: publicGames().map(portalGame) }; }
function requirePlayable(gameId) {
  const game = getGame(gameId);
  if (!game) throw Object.assign(new Error('Game không tồn tại.'), { code: 'GAME_NOT_FOUND' });
  if (game.status !== 'playable') throw Object.assign(new Error('Game này chưa phát hành.'), { code: 'GAME_NOT_PLAYABLE' });
  return portalGame(game);
}
function validateRoomConfig(gameId, input = {}) {
  const game = requirePlayable(gameId);
  const upper = gameId === 'uno' && input.variant !== 'classic-108-v1' ? 4 : game.maxPlayers;
  const maxPlayers = input.maxPlayers === undefined ? upper : Number(input.maxPlayers);
  if (!Number.isInteger(maxPlayers) || maxPlayers < game.minPlayers || maxPlayers > upper) throw Object.assign(new Error(`Số người phải từ ${game.minPlayers} đến ${upper}.`), { code: 'INVALID_CONFIG' });
  return { roomName: String(input.roomName || `${game.name} · Phòng LAN`).trim().slice(0, 32), maxPlayers,
    ...(game.stake ? { stake: validateStake(gameId, input.stake, maxPlayers) } : {}),
    visibility: input.visibility === 'invite' ? 'invite' : 'public', password: typeof input.password === 'string' ? input.password.trim().slice(0, 64) : '',
    difficulty: require('../cardsData').GAME_MODES[input.difficulty] ? input.difficulty : 'ADVANCED',
    variant: gameId === 'uno' ? (input.variant === 'classic-108-v1' ? input.variant : 'classic-local-v1') : 'standard' };
}

function getStakeLimits(gameId, playerCount) {
  const game = GAMES[gameId];
  if (!game?.stake) throw Object.assign(new Error('Game này không có mức cược cố định.'), { code: 'STAKE_UNSUPPORTED' });
  const count = playerCount === undefined ? game.maxPlayers : Number(playerCount);
  if (!Number.isInteger(count) || count < game.minPlayers || count > game.maxPlayers) {
    throw Object.assign(new Error(`Số người cược phải từ ${game.minPlayers} đến ${game.maxPlayers}.`), { code: 'INVALID_CONFIG' });
  }
  const { CURRENCIES } = require('./currencies');
  let holdFactor, maxNetGainFactor;
  if (gameId === 'tien-len') {
    holdFactor = 1;
    maxNetGainFactor = count - 1;
  } else if (gameId === 'sam-loc') {
    holdFactor = 2 * (count - 1);
    // Includes a failed Sâm and the existing “báo một” extra penalty.
    maxNetGainFactor = Math.max(2 * (count - 1), count);
  } else {
    holdFactor = 6 * (count - 1);
    // settleReservations accepts at most one hold-sized loss from each other
    // seat, so their sum is the safe upper bound on one player's net winnings.
    maxNetGainFactor = holdFactor * (count - 1);
  }
  const grossPayoutFactor = holdFactor + maxNetGainFactor;
  const maxStake = Math.floor(CURRENCIES.coin.max / Math.max(holdFactor, maxNetGainFactor, grossPayoutFactor));
  return { currency: 'coin', playerCount: count, minStake: 1, maxStake, holdFactor,
    maxLossFactor: holdFactor, maxNetGainFactor, grossPayoutFactor };
}

function publicStakeRules(gameId) {
  const game = GAMES[gameId];
  return { currency: 'coin', defaultStake: game.stake, minStake: 1, maxPlayers: game.maxPlayers,
    limitsByPlayerCount: Object.fromEntries(Array.from({ length: game.maxPlayers - game.minPlayers + 1 }, (_, index) => {
      const count = game.minPlayers + index, limits = getStakeLimits(gameId, count);
      return [count, { maxStake: limits.maxStake, holdFactor: limits.holdFactor,
        maxLossFactor: limits.maxLossFactor, maxNetGainFactor: limits.maxNetGainFactor,
        grossPayoutFactor: limits.grossPayoutFactor }];
    })) };
}

function validateStake(gameId, value, playerCount) {
  const game = GAMES[gameId];
  if (!game?.stake) throw Object.assign(new Error('Game này không có mức cược cố định.'), { code: 'STAKE_UNSUPPORTED' });
  const limits = getStakeLimits(gameId, playerCount);
  const amount = parseAmount(value ?? game.stake, { min: limits.minStake, max: limits.maxStake });
  if (!require('./currencies').validateAmount(amount, limits.currency)) throw Object.assign(new Error('Mức cược không hợp lệ theo đơn vị tiền của game.'), { code: 'STAKE_LIMIT' });
  return amount;
}

module.exports = { GAMES, getGame, publicGames, PORTAL_NAME, publicCatalog, requirePlayable, validateRoomConfig, validateStake, getStakeLimits };
