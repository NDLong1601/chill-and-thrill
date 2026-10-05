'use strict';

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
  bang: 'Vai ẩn, khoảng cách và những phát súng bất ngờ.', poker: 'Texas Hold’em với chip ảo trên server local.',
  'tien-len': 'Tiến lên miền Nam với chip ảo.', 'sam-loc': 'Báo Sâm, chặn Sâm và đấu trí.', phom: 'Bốc, ăn, đánh và hạ phỏm.',
};
function portalGame(game) {
  return { ...game, gameId: game.id, rulesVersion: 1, shortDescription: descriptions[game.id],
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
    visibility: input.visibility === 'invite' ? 'invite' : 'public', password: typeof input.password === 'string' ? input.password.trim().slice(0, 64) : '',
    difficulty: require('../cardsData').GAME_MODES[input.difficulty] ? input.difficulty : 'ADVANCED',
    variant: gameId === 'uno' ? (input.variant === 'classic-108-v1' ? input.variant : 'classic-local-v1') : 'standard' };
}

module.exports = { GAMES, getGame, publicGames, PORTAL_NAME, publicCatalog, requirePlayable, validateRoomConfig };
