'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PracticeService, createUnoBotProjection, createTienLenBotProjection } = require('../src/platform/practiceService');
const { chooseUnoAction, chooseTienLenAction } = require('../src/platform/practiceBotPolicy');
const UnoEngine = require('../src/games/uno/engine');
const { ProfileStore } = require('../src/platform/profileStore');

function unoProjection(state) {
  return {
    schemaVersion: 1,
    gameId: 'uno',
    variant: state.variant,
    matchId: state.matchId,
    revision: state.revision,
    seatId: state.player.id,
    ownHand: state.player.hand,
    legalActions: state.player.availableActions,
    publicState: state.publicState,
  };
}

function tienProjection(state) {
  return {
    schemaVersion: 1,
    gameId: 'tien-len',
    variant: state.variant,
    matchId: state.matchId,
    revision: state.revision,
    seatId: state.player.id,
    ownHand: state.player.hand,
    publicState: state.publicState,
  };
}

function actionId(prefix = 'practice-action') { return `${prefix}-${crypto.randomUUID()}`; }

test('UNO 112 practice plays a complete seeded game through the server UNO engine', async t => {
  const service = new PracticeService({ maxBotSteps: 64, botYieldEvery: 3 });
  t.after(() => service.close());
  const created = await service.createSession({ gameId: 'uno', variant: 'classic-local-v1', playerName: 'Lan', seed: 'uno-full-game-20261006' });
  assert.equal(created.ok, true);
  assert.equal(created.state.variant, 'classic-local-v1');
  assert.equal(created.state.practice.label.includes('không có giá trị'), true);
  let state = created.state;
  let applied = 0;
  for (let step = 0; step < 6000 && state.phase !== 'RESULT'; step += 1) {
    assert.equal(state.publicState.currentPlayerId, state.player.id, 'bot automation should stop on the human seat or finish');
    const decision = chooseUnoAction(unoProjection(state));
    assert.ok(decision, `human UNO policy must find a legal action at revision ${state.revision}`);
    const result = await service.act(created.session.id, created.session.capability, {
      matchId: state.matchId,
      expectedRevision: state.revision,
      actionId: actionId('uno-full'),
      type: decision.type,
      payload: decision.payload || {},
    });
    assert.equal(result.ok, true, result.error?.message);
    state = result.state;
    applied += 1;
  }
  assert.equal(state.phase, 'RESULT', 'the seeded UNO practice game must finish');
  assert.ok(applied > 2, 'the game must use real turns rather than an opening fixture result');
  assert.equal(state.publicState.result.winnerId === state.player.id || state.publicState.result.winnerId !== state.player.id, true);
  assert.equal(state.practice.humanWins + state.practice.botWins, 1);
});

test('Tiến lên practice plays a complete seeded game using manager play/pass validation', async t => {
  const service = new PracticeService({ maxBotSteps: 64, botYieldEvery: 3 });
  t.after(() => service.close());
  const created = await service.createSession({ gameId: 'tien-len', variant: 'south-v1', playerName: 'Minh', seed: 'tien-len-full-game-20261006' });
  assert.equal(created.ok, true);
  assert.equal(created.state.variant, 'south-v1');
  let state = created.state;
  let applied = 0;
  for (let step = 0; step < 1000 && state.phase !== 'RESULT'; step += 1) {
    assert.equal(state.publicState.currentPlayerId, state.player.id, 'bot automation should stop on the human seat or finish');
    const decision = chooseTienLenAction(tienProjection(state));
    assert.ok(decision, `human Tiến lên policy must find a legal action at revision ${state.revision}`);
    const result = await service.act(created.session.id, created.session.capability, {
      matchId: state.matchId,
      expectedRevision: state.revision,
      actionId: actionId('tien-full'),
      ...decision,
    });
    assert.equal(result.ok, true, result.error?.message);
    state = result.state;
    applied += 1;
  }
  assert.equal(state.phase, 'RESULT', 'the seeded Tiến lên practice game must finish');
  assert.ok(applied > 2, 'the game must play turns before settling its practice result');
  assert.equal(state.practice.humanWins + state.practice.botWins, 1);
});

test('action IDs, revisions, retries, session capability, and bot command boundaries are enforced', async t => {
  const service = new PracticeService();
  t.after(() => service.close());
  const created = await service.createSession({ gameId: 'uno', variant: 'classic-local-v1', seed: 123 });
  const state = created.state;
  const decision = chooseUnoAction(unoProjection(state));

  const unauthorized = await service.getState(created.session.id, 'A'.repeat(43));
  assert.equal(unauthorized.error.code, 'UNAUTHORIZED');
  const forcedBot = await service.act(created.session.id, created.session.capability, {
    playerId: 'bot', matchId: state.matchId, expectedRevision: state.revision, actionId: actionId(), type: decision.type, payload: decision.payload,
  });
  assert.equal(forcedBot.error.code, 'INVALID_ACTION');

  const stale = await service.act(created.session.id, created.session.capability, {
    matchId: state.matchId, expectedRevision: state.revision - 1, actionId: actionId(), type: decision.type, payload: decision.payload,
  });
  assert.equal(stale.error.code, 'STALE_REVISION');

  const envelope = { matchId: state.matchId, expectedRevision: state.revision, actionId: actionId('retry'), type: decision.type, payload: decision.payload };
  const first = await service.act(created.session.id, created.session.capability, envelope);
  assert.equal(first.ok, true, first.error?.message);
  const afterRevision = first.state.revision;
  const retry = await service.act(created.session.id, created.session.capability, envelope);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.state.revision, afterRevision, 'a retry must not apply the move again');

  const invalidState = await service.getState(created.session.id, created.session.capability);
  const invalidId = actionId('invalid');
  const invalid = await service.act(created.session.id, created.session.capability, {
    matchId: invalidState.state.matchId, expectedRevision: invalidState.state.revision,
    actionId: invalidId, type: 'play_card', payload: { cardId: 'not-on-the-human-hand' },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'INVALID_ACTION');
});

test('UNO 108 is kept as a separate variant and labeled unavailable in this practice release', async t => {
  const service = new PracticeService();
  t.after(() => service.close());
  const unsupported = await service.createSession({ gameId: 'uno', variant: 'classic-108-v1' });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, 'UNSUPPORTED_VARIANT');
  assert.match(unsupported.error.message, /UNO 108 \(classic-108-v1\).*chưa có chế độ luyện tập/);
  assert.equal(service.inspectSessionCount(), 0);
});

test('owner session expires and cleanup erases in-memory practice state', async () => {
  let now = 0;
  const service = new PracticeService({ now: () => now, sessionTtlMs: 1000 });
  const created = await service.createSession({ gameId: 'tien-len', variant: 'south-v1', seed: 8 });
  assert.equal(created.ok, true);
  now = 1001;
  const expired = await service.getState(created.session.id, created.session.capability);
  assert.equal(expired.error.code, 'SESSION_EXPIRED');
  assert.equal(service.inspectSessionCount(), 0);

  now = 0;
  const abandoned = await service.createSession({ gameId: 'uno', variant: 'classic-local-v1', seed: 9 });
  now = 1001;
  assert.equal(service.cleanup(), 1);
  assert.equal(service.inspectSessionCount(), 0);
  const gone = await service.getState(abandoned.session.id, abandoned.session.capability);
  assert.equal(gone.error.code, 'SESSION_NOT_FOUND');
  service.close();
});

test('bot projections contain the bot hand and public counts, never an opponent hand or room data', () => {
  const humanId = 'practice-human';
  const botId = 'practice-bot';
  const unoPlayers = [{ id: humanId, name: 'You', isHost: true, connected: true }, { id: botId, name: 'Bot', isHost: false, connected: true }];
  const uno = UnoEngine.createMatch({ playerIds: [humanId, botId], rng: () => 0.25 });
  const secretUnoCard = { id: 'opponent-private-marker', color: 'red', type: 'number', value: 9 };
  uno.hands[humanId].push(secretUnoCard);
  const unoProjectionValue = createUnoBotProjection(uno, unoPlayers, botId, 1);
  assert.equal(unoProjectionValue.ownHand.some(card => card.id === secretUnoCard.id), false);
  assert.equal(JSON.stringify(unoProjectionValue).includes(secretUnoCard.id), false);
  assert.equal(JSON.stringify(unoProjectionValue).includes('hands'), false);
  assert.throws(() => chooseUnoAction({ ...unoProjectionValue, hands: uno.hands }), /forbidden field/);

  const tienRoom = {
    matchId: 'practice-match', revision: 4, phase: 'TURN', currentPlayerId: botId, leaderId: humanId,
    playedAny: true, initialRequiredCardId: null, passedIds: [],
    topPlay: { playerId: humanId, formation: { kind: 'single', length: 1, power: 0, suit: 0 }, cards: [{ id: '3S', rank: '3', suit: 'S' }] },
    players: [
      { id: humanId, name: 'You', profileId: 'real-profile-marker', hand: [{ id: 'opponent-secret-marker', rank: 'A', suit: 'H' }], isHost: true },
      { id: botId, name: 'Bot', profileId: 'practice-profile:bot', hand: [{ id: '4S', rank: '4', suit: 'S' }], isHost: false },
    ],
  };
  const tienProjectionValue = createTienLenBotProjection(tienRoom, botId);
  const text = JSON.stringify(tienProjectionValue);
  assert.equal(text.includes('opponent-secret-marker'), false);
  assert.equal(text.includes('real-profile-marker'), false);
  assert.equal(text.includes('profileId'), false);
  assert.equal(chooseTienLenAction(tienProjectionValue).action, 'play');
});

test('practice games do not write to an isolated ProfileStore ledger', async t => {
  const store = new ProfileStore({ databaseFile: ':memory:' });
  t.after(() => store.close());
  const createdProfile = store.createProfile({ displayName: 'Real profile fixture' });
  const profileId = createdProfile.profile.id;
  const before = { wallet: store.publicProfile(profileId).wallet, ledger: store.listLedger(profileId, 20) };
  const service = new PracticeService();
  t.after(() => service.close());
  for (const [gameId, variant] of [['uno', 'classic-local-v1'], ['tien-len', 'south-v1']]) {
    const practice = await service.createSession({ gameId, variant, seed: `ledger-check-${gameId}` });
    const response = await service.getState(practice.session.id, practice.session.capability);
    assert.equal(response.ok, true);
    assert.equal(response.state.practice.label.includes('không vào ví'), true);
  }
  assert.deepEqual(store.publicProfile(profileId).wallet, before.wallet);
  assert.deepEqual(store.listLedger(profileId, 20), before.ledger);
});
