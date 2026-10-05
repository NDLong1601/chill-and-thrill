'use strict';

// BANG! base game, fourth edition.  The card quantities and the poker suits
// below are transcribed from dV Giochi's official card list.  IDs carry a
// serial because the physical deck intentionally contains some equal suit /
// rank combinations (for example the two Stagecoaches).
const SUITS = Object.freeze(['S', 'H', 'D', 'C']);
const SUIT_LABELS = Object.freeze({ S: '♠', H: '♥', D: '♦', C: '♣' });
const RANKS = Object.freeze(['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']);

const CARD_META = Object.freeze({
  BANG: { name: 'BANG!', border: 'brown' },
  MISSED: { name: 'Missed!', border: 'brown' },
  BEER: { name: 'Beer', border: 'brown' },
  CAT_BALOU: { name: 'Cat Balou', border: 'brown' },
  STAGECOACH: { name: 'Stagecoach', border: 'brown' },
  WELLS_FARGO: { name: 'Wells Fargo', border: 'brown' },
  DUEL: { name: 'Duel', border: 'brown' },
  GENERAL_STORE: { name: 'General Store', border: 'brown' },
  GATLING: { name: 'Gatling', border: 'brown' },
  INDIANS: { name: 'Indians!', border: 'brown' },
  PANIC: { name: 'Panic!', border: 'brown' },
  SALOON: { name: 'Saloon', border: 'brown' },
  BARREL: { name: 'Barrel', border: 'blue', equipment: true },
  DYNAMITE: { name: 'Dynamite', border: 'blue', equipment: true },
  SCOPE: { name: 'Scope', border: 'blue', equipment: true },
  MUSTANG: { name: 'Mustang', border: 'blue', equipment: true },
  JAIL: { name: 'Jail', border: 'blue', equipment: true, delayed: true },
  REMINGTON: { name: 'Remington', border: 'blue', equipment: true, weaponRange: 3 },
  REV_CARABINE: { name: 'Rev. Carabine', border: 'blue', equipment: true, weaponRange: 4 },
  SCHOFIELD: { name: 'Schofield', border: 'blue', equipment: true, weaponRange: 2 },
  VOLCANIC: { name: 'Volcanic', border: 'blue', equipment: true, weaponRange: 1 },
  WINCHESTER: { name: 'Winchester', border: 'blue', equipment: true, weaponRange: 5 },
});

const CHARACTERS = Object.freeze([
  { id: 'BART_CASSIDY', name: 'Bart Cassidy', maxHp: 4, ability: 'Mỗi khi mất 1 máu, rút 1 lá.' },
  { id: 'BLACK_JACK', name: 'Black Jack', maxHp: 4, ability: 'Lá rút thứ hai đỏ: rút thêm 1 lá.' },
  { id: 'CALAMITY_JANET', name: 'Calamity Janet', maxHp: 4, ability: 'Dùng BANG! như Missed! và ngược lại.' },
  { id: 'EL_GRINGO', name: 'El Gringo', maxHp: 3, ability: 'Khi người khác gây mất máu, lấy ngẫu nhiên 1 lá của họ mỗi máu.' },
  { id: 'JESSE_JONES', name: 'Jesse Jones', maxHp: 4, ability: 'Lá rút đầu: có thể lấy ngẫu nhiên từ tay một người khác.' },
  { id: 'JOURDONNAIS', name: 'Jourdonnais', maxHp: 4, ability: 'Luôn có Barrel; có thể rút kiểm tra khi bị BANG!.' },
  { id: 'KIT_CARLSON', name: 'Kit Carlson', maxHp: 4, ability: 'Nhìn 3 lá đầu, lấy 2, đặt lá còn lại lên đỉnh.' },
  { id: 'LUCKY_DUKE', name: 'Lucky Duke', maxHp: 4, ability: 'Mỗi lần rút kiểm tra, lật 2 lá và chọn kết quả.' },
  { id: 'PAUL_REGRET', name: 'Paul Regret', maxHp: 3, ability: 'Luôn có Mustang.' },
  { id: 'PEDRO_RAMIREZ', name: 'Pedro Ramirez', maxHp: 4, ability: 'Lá rút đầu có thể lấy từ chồng bỏ.' },
  { id: 'ROSE_DOOLAN', name: 'Rose Doolan', maxHp: 4, ability: 'Luôn có Scope.' },
  { id: 'SID_KETCHUM', name: 'Sid Ketchum', maxHp: 4, ability: 'Bỏ 2 lá để hồi 1 máu, bất cứ lúc nào.' },
  { id: 'SLAB_THE_KILLER', name: 'Slab the Killer', maxHp: 4, ability: 'BANG! của bạn cần 2 Missed! để chặn.' },
  { id: 'SUZY_LAFAYETTE', name: 'Suzy Lafayette', maxHp: 4, ability: 'Vừa hết bài trên tay: rút 1 lá.' },
  { id: 'VULTURE_SAM', name: 'Vulture Sam', maxHp: 4, ability: 'Có người bị loại: lấy toàn bộ bài tay/trước mặt của họ.' },
  { id: 'WILLY_THE_KID', name: 'Willy the Kid', maxHp: 4, ability: 'Đánh bao nhiêu BANG! trong lượt cũng được.' },
]);

const ROLE_SETS = Object.freeze({
  4: ['SHERIFF', 'RENEGADE', 'OUTLAW', 'OUTLAW'],
  5: ['SHERIFF', 'RENEGADE', 'OUTLAW', 'OUTLAW', 'DEPUTY'],
  6: ['SHERIFF', 'RENEGADE', 'OUTLAW', 'OUTLAW', 'OUTLAW', 'DEPUTY'],
  7: ['SHERIFF', 'RENEGADE', 'OUTLAW', 'OUTLAW', 'OUTLAW', 'DEPUTY', 'DEPUTY'],
});
const ROLE_LABELS = Object.freeze({ SHERIFF: 'Sheriff', DEPUTY: 'Deputy', OUTLAW: 'Outlaw', RENEGADE: 'Renegade' });

function expand(type, suit, ranks) {
  return ranks.map((rank, index) => ({ id: `${type}_${suit}_${rank}_${index + 1}`, type, rank, suit, ...CARD_META[type] }));
}

function createBangDeck() {
  const deck = [
    ...expand('BARREL', 'S', ['Q', 'K']), ...expand('DYNAMITE', 'H', ['2']), ...expand('SCOPE', 'S', ['A']),
    ...expand('MUSTANG', 'H', ['8', '9']), ...expand('JAIL', 'S', ['J', '10']), ...expand('JAIL', 'H', ['4']),
    ...expand('REMINGTON', 'C', ['K']), ...expand('REV_CARABINE', 'C', ['A']), ...expand('SCHOFIELD', 'C', ['J', 'Q']), ...expand('SCHOFIELD', 'S', ['K']),
    ...expand('VOLCANIC', 'S', ['10']), ...expand('VOLCANIC', 'C', ['10']), ...expand('WINCHESTER', 'S', ['8']),
    ...expand('BANG', 'S', ['A']), ...expand('BANG', 'D', RANKS.slice(0, 13)), ...expand('BANG', 'C', RANKS.slice(0, 8)), ...expand('BANG', 'H', ['Q', 'K', 'A']),
    ...expand('BEER', 'H', ['6', '7', '8', '9', '10', 'J']), ...expand('CAT_BALOU', 'H', ['K']), ...expand('CAT_BALOU', 'D', ['9', '10', 'J']),
    ...expand('STAGECOACH', 'S', ['9', '9']), ...expand('DUEL', 'D', ['Q']), ...expand('DUEL', 'S', ['J']), ...expand('DUEL', 'C', ['8']),
    ...expand('GENERAL_STORE', 'C', ['9']), ...expand('GENERAL_STORE', 'S', ['Q']), ...expand('GATLING', 'H', ['10']),
    ...expand('INDIANS', 'D', ['K', 'A']), ...expand('MISSED', 'C', ['10', 'J', 'Q', 'K', 'A']), ...expand('MISSED', 'S', ['2', '3', '4', '5', '6', '7', '8']),
    ...expand('PANIC', 'H', ['J', 'Q', 'A']), ...expand('PANIC', 'D', ['8']), ...expand('SALOON', 'H', ['5']), ...expand('WELLS_FARGO', 'H', ['3']),
  ];
  if (deck.length !== 80 || new Set(deck.map(card => card.id)).size !== 80) throw new Error('BANG! base deck must contain exactly 80 unique cards.');
  return deck;
}

function shuffle(cards) { const next = [...cards]; for (let i = next.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [next[i], next[j]] = [next[j], next[i]]; } return next; }
function isRed(card) { return card?.suit === 'H' || card?.suit === 'D'; }
function isHeart(card) { return card?.suit === 'H'; }
function isDynamiteHit(card) { return card?.suit === 'S' && ['2', '3', '4', '5', '6', '7', '8', '9'].includes(card.rank); }
function cardLabel(card) { return `${card?.name || card?.type || '?'} ${card?.rank || ''}${SUIT_LABELS[card?.suit] || ''}`.trim(); }

module.exports = { SUITS, SUIT_LABELS, RANKS, CARD_META, CHARACTERS, ROLE_SETS, ROLE_LABELS, createBangDeck, shuffle, isRed, isHeart, isDynamiteHit, cardLabel };
