'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectSpectatorState } = require('../src/platform/spectatorProjection');

const MARKERS = [
  'PRIVATE_HAND_MARKER', 'PRIVATE_HOLE_MARKER', 'PRIVATE_ROLE_MARKER', 'DRAW_PILE_MARKER',
  'TOKEN_MARKER', 'PROFILE_ID_MARKER', 'PASSWORD_HASH_MARKER', 'FUTURE_SECRET_MARKER',
];

function fixture(gameId, variant = 'standard', phase = 'TURN', extra = {}) {
  const code = 'T3ST';
  const room = { code, gameId, variant, phase, config: { passwordHash: 'do-not-project' }, ...extra };
  const source = {
    roomCode: code, gameId, variant, phase, revision: 7, paused: false,
    currentPlayerId: 'seat-a', myHand: [MARKERS[0]], myHoleCards: [MARKERS[1]],
    hand: [MARKERS[0]], drawPile: [MARKERS[3]], deck: [MARKERS[3]],
    sessionToken: MARKERS[4], profileToken: MARKERS[4], passwordHash: MARKERS[6],
    wallet: { profileId: MARKERS[5], token: MARKERS[4] },
    futurePublicField: { secret: MARKERS[7] },
    players: [
      { id: 'seat-a', name: 'Linh', avatar: '🎲', isHost: true, ready: true, connected: true,
        handCount: 5, cardCount: 5, stack: 200, inHand: true, folded: false, allIn: false,
        totalContribution: 20, roundBet: 10, privateCards: [MARKERS[0]], holeCards: [MARKERS[1]],
        profileId: MARKERS[5], token: MARKERS[4], role: 'PRIVATE_ROLE_MARKER', privateField: MARKERS[7] },
      { id: 'seat-b', name: 'Minh', avatar: '🕶️', isHost: false, ready: true, connected: true,
        handCount: 4, cardCount: 4, stack: 190, inHand: true, folded: false, allIn: false,
        totalContribution: 10, roundBet: 10, privateCards: [MARKERS[0]], holeCards: [MARKERS[1]],
        profileId: MARKERS[5], token: MARKERS[4], role: 'OUTLAW', privateField: MARKERS[7] },
    ],
    ...extra.source,
  };
  const manager = { rooms: new Map([[code, room]]), buildStateFor: (_room, _viewer) => structuredClone(source), playerRoom: new Map() };
  const gm = { managerForCode: () => manager, gameIdForRoom: () => gameId, gang: manager };
  return { gm, room, source, manager, code };
}

test('the strict spectator projection covers both UNO variants and all supported games', () => {
  const variants = [
    ['the-gang', 'standard'], ['uno', 'classic-local-v1'], ['uno', 'classic-108-v1'],
    ['tien-len', 'standard'], ['sam-loc', 'standard'], ['phom', 'standard'], ['poker', 'standard'], ['bang', 'standard'],
  ];
  for (const [gameId, variant] of variants) {
    const { gm, code } = fixture(gameId, variant);
    const projected = projectSpectatorState(gm, code);
    assert.equal(projected.gameId, gameId, `${gameId}/${variant}`);
    assert.equal(projected.variant, variant);
    assert.deepEqual(projected.players.map(player => player.seatId), ['seat-1', 'seat-2']);
    assert.equal(JSON.stringify(projected).includes(code), true);
    const serialized = JSON.stringify(projected);
    for (const marker of MARKERS) assert.equal(serialized.includes(marker), false, `${gameId}/${variant} included ${marker}`);
    for (const banned of ['token', 'profileId', 'passwordHash', 'myHand', 'myHoleCards', 'drawPile', 'deck', 'privateField', 'futurePublicField']) {
      assert.equal(serialized.includes(`"${banned}"`), false, `${gameId}/${variant} included field ${banned}`);
    }
    assert.equal(projected.futurePublicField, undefined);
    assert.equal(projected.players[0].id, undefined);
    assert.equal(projected.players[0].token, undefined);
  }
});

test('UNO 108 public top cards keep their number or action symbol without card identity', () => {
  for (const symbol of [0, 5, 'draw2', 'wild4']) {
    const { gm, code } = fixture('uno', 'classic-108-v1', 'TURN', {
      source: { topCard: { id: 'PRIVATE_HAND_MARKER', color: 'red', symbol, futureSecret: 'FUTURE_SECRET_MARKER' } },
    });
    assert.deepEqual(projectSpectatorState(gm, code).board.topCard, { color: 'red', symbol });
  }
});

test('only public BANG roles are projected while the Sheriff is alive', () => {
  const { gm, code, source } = fixture('bang', 'standard', 'DRAW');
  source.players[0].role = 'SHERIFF';
  source.players[1].role = 'OUTLAW';
  const projected = projectSpectatorState(gm, code);
  assert.equal(projected.players[0].role, 'SHERIFF');
  assert.equal(Object.hasOwn(projected.players[1], 'role'), false);
  assert.equal(JSON.stringify(projected).includes('PRIVATE_ROLE_MARKER'), false);
});

test('BANG reveals a dead player role and final roles only after the game rule reveals them', () => {
  const { gm, code, source } = fixture('bang', 'standard', 'DRAW');
  source.players[0].role = 'SHERIFF';
  source.players[1].role = 'OUTLAW'; source.players[1].dead = true;
  let projected = projectSpectatorState(gm, code);
  assert.equal(projected.players[1].role, 'OUTLAW');
  source.phase = 'RESULT'; source.players[1].dead = false;
  projected = projectSpectatorState(gm, code);
  assert.equal(projected.players[1].role, 'OUTLAW');
});

test('Poker hole cards stay hidden during a hand and appear only from the completed public showdown', () => {
  const { gm, code, source } = fixture('poker', 'standard', 'HAND', {
    source: { community: [{ id: 'flop', suit: 'H', rank: 'A' }], result: { showdown: [{ playerId: 'seat-a', cards: [{ rank: 'K' }]}] } },
  });
  let projected = projectSpectatorState(gm, code);
  assert.equal(projected.board.communityCards.length, 1);
  assert.equal(projected.board.revealedShowdown, undefined);
  assert.equal(JSON.stringify(projected).includes('PRIVATE_HOLE_MARKER'), false);
  source.phase = 'RESULT';
  projected = projectSpectatorState(gm, code);
  assert.deepEqual(projected.board.revealedShowdown, [{ seatId: 'seat-1', cards: [{ rank: 'K' }], hand: '' }]);
});

test('played, discarded and revealed cards come only from their explicitly public board fields', () => {
  const tlen = fixture('tien-len', 'standard', 'TURN', {
    source: { topPlay: { playerId: 'seat-b', formation: { kind: 'pair', length: 2, secret: MARKERS[7] }, cards: [
      { id: 'public-1', rank: '3', suit: 'S', future: MARKERS[7] }, { id: 'public-2', rank: '3', suit: 'H' },
    ] }, myHand: [{ rank: 'A', suit: 'S' }] },
  });
  const played = projectSpectatorState(tlen.gm, tlen.code);
  assert.equal(played.board.topPlay.seatId, 'seat-2');
  assert.deepEqual(played.board.topPlay.cards, [{ rank: '3', suit: 'S' }, { rank: '3', suit: 'H' }]);
  assert.equal(JSON.stringify(played).includes(MARKERS[7]), false);

  const phom = fixture('phom', 'standard', 'DISCARD', { source: {
    discardTop: { id: 'discarded', value: 7, suit: 'clubs', private: MARKERS[7] }, discardById: 'seat-a', stockCount: 20,
    publicMelds: [{ playerId: 'seat-b', name: 'Minh', melds: [{ kind: 'set', cards: [{ value: 7, suit: 'clubs' }] }], future: MARKERS[7] }],
  } });
  const visible = projectSpectatorState(phom.gm, phom.code);
  assert.deepEqual(visible.board.discardTop, { suit: 'clubs', value: 7 });
  assert.equal(visible.board.discardBySeatId, 'seat-1');
  assert.equal(visible.board.publicMelds[0].seatId, 'seat-2');
  assert.equal(JSON.stringify(visible).includes(MARKERS[7]), false);
});

test('the public view is built on a detached room copy so reads do not advance an engine timer', () => {
  const { gm, code, room, manager } = fixture('uno', 'classic-108-v1', 'PLAYING');
  room.revision = 1;
  manager.buildStateFor = (copy, viewer) => {
    assert.notEqual(copy, room);
    assert.equal(viewer, null);
    copy.revision = 999;
    return { roomCode: code, gameId: 'uno', variant: 'classic-108-v1', phase: 'PLAYING', revision: copy.revision, players: [] };
  };
  const result = projectSpectatorState(gm, code);
  assert.equal(result.phase, 'PLAYING');
  assert.equal(room.revision, 1);
  assert.equal(result.revision, 999);
});

test('UNO variant falls back to the owning manager when a legacy room has no variant field', () => {
  for (const [managerKey, expected] of [['gang', 'classic-local-v1'], ['uno', 'classic-108-v1']]) {
    const { gm, code, room, manager, source } = fixture('uno', 'standard');
    delete room.variant;
    delete room.config.variant;
    delete source.variant;
    gm.gang = managerKey === 'gang' ? manager : undefined;
    gm.uno = managerKey === 'uno' ? manager : undefined;
    const result = projectSpectatorState(gm, code);
    assert.equal(result.variant, expected);
  }
});
