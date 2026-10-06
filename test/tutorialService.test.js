'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TutorialService, TUTORIAL_VERSION, TUTORIAL_REWARD, EXERCISES } = require('../src/platform/tutorialService');
const { ProfileStore } = require('../src/platform/profileStore');

class MemoryTutorialStore {
  constructor() { this.verifications = new Map(); this.claims = new Map(); this.ledger = new Map(); this.balances = new Map(); this.failNextCommit = false; }
  key(profileId, version) { return `${profileId}:${version}`; }
  hasTutorialVerification(profileId, version) { return this.verifications.has(this.key(profileId, version)); }
  transaction(work) {
    const before = structuredClone({ verifications: this.verifications, claims: this.claims, ledger: this.ledger, balances: this.balances });
    const result = work();
    if (this.failNextCommit) {
      this.failNextCommit = false;
      this.verifications = before.verifications; this.claims = before.claims; this.ledger = before.ledger; this.balances = before.balances;
      throw Object.assign(new Error('injected commit fault'), { code: 'COMMIT_FAILED' });
    }
    return result;
  }
  recordTutorialVerification({ profileId, version, completedAt, operationKey }) {
    const key = this.key(profileId, version);
    if (!operationKey || operationKey !== `tutorial-verified:${version}:${profileId}`) throw new Error('bad idempotency key');
    if (this.verifications.has(key)) return { alreadyVerified: true };
    this.verifications.set(key, { completedAt, operationKey });
    return { alreadyVerified: false };
  }
  claimTutorialReward({ profileId, version, amount, operationKey }) {
    if (!this.hasTutorialVerification(profileId, version)) throw Object.assign(new Error('not verified'), { code: 'TUTORIAL_NOT_VERIFIED' });
    const key = this.key(profileId, version);
    if (this.claims.has(key)) return { alreadyClaimed: true, amount };
    if (operationKey !== `tutorial-reward:${version}:${profileId}`) throw new Error('bad reward idempotency key');
    this.claims.set(key, true); this.ledger.set(operationKey, amount);
    this.balances.set(profileId, (this.balances.get(profileId) || 0) + amount);
    return { alreadyClaimed: false, amount, operationKey };
  }
}

function harness({ clock = () => 1_800_000_000_000, store = new MemoryTutorialStore(), ttlMs, idStart = 0 } = {}) {
  let id = idStart;
  const service = new TutorialService({ store, clock, ttlMs, idFactory: () => `session-${++id}`, nonceFactory: () => `nonce-${id}` });
  return { service, store };
}

function request(session, challenge, sequence, revision, actionId, action, profileId = 'profile-A', overrides = {}) {
  return { profileId, version: TUTORIAL_VERSION, sessionId: session.sessionId, nonce: session.nonce,
    sequence, revision, challengeId: challenge.id, actionId, action, ...overrides };
}

function submitUno(service, session, actionId = 'action-uno-0001') {
  const result = service.submit(request(session, session.challenge, session.sequence, session.revision, actionId, { type: 'choose-color', color: 'blue' }));
  if (result.accepted) Object.assign(session, { sequence: result.sequence, revision: result.revision, challenge: result.challenge });
  return result;
}
function submitPoker(service, session, action, actionId = 'action-poker-0001') {
  const result = service.submit(request(session, session.challenge, session.sequence, session.revision, actionId, { type: action }));
  if (result.accepted) Object.assign(session, { sequence: result.sequence, revision: result.revision, challenge: result.challenge });
  return result;
}
function submitPhom(service, session, groups, actionId = 'action-phom-0001') {
  return service.submit(request(session, session.challenge, session.sequence, session.revision, actionId, { melds: groups }));
}

test('curriculum exercises are server-owned, ordered, versioned and never serialize an opponent hand', () => {
  assert.equal(TUTORIAL_VERSION, '2026-10-06.v1');
  assert.equal(TUTORIAL_REWARD, 200);
  assert.deepEqual(EXERCISES.map(item => item.id), ['uno-wild-color', 'poker-check', 'phom-laydown']);
  const { service } = harness();
  assert.equal(service.start({ profileId: 'profile-A', version: 'fake-v9' }).error.code, 'TUTORIAL_VERSION');
  const session = service.start({ profileId: 'profile-A' });
  assert.equal(session.challenge.gameId, 'uno');
  assert.equal(session.challenge.variant, 'classic-local-v1');
  assert.equal(JSON.stringify(session).includes('opponent-hidden-card'), false);
  assert.equal(JSON.stringify(session).includes('lesson-seat'), false);
  assert.equal(service.submit({ ...request(session, session.challenge, 1, 0, 'action-skip-0001', { type: 'choose-color', color: 'red' }), sequence: 1 }).error.code, 'CHALLENGE_STALE');
  assert.equal(service.submit(request(session, session.challenge, 0, 0, 'action-owner-0001', { type: 'choose-color', color: 'blue' }, 'profile-B')).error.code, 'SESSION_OWNER');
  assert.equal(service.submit({ ...request(session, session.challenge, 0, 0, 'action-version-0001', { type: 'choose-color', color: 'blue' }), version: '2026-10-05.v0' }).error.code, 'TUTORIAL_VERSION');
});

test('invalid feedback does not advance, correct server-validated actions advance exactly one challenge', () => {
  const { service } = harness();
  const session = service.start({ profileId: 'profile-A' });
  const invalidUno = service.submit(request(session, session.challenge, 0, 0, 'action-invalid-uno1', { type: 'play', color: 'blue' }));
  assert.equal(invalidUno.accepted, false);
  assert.match(invalidUno.feedback, /màu hợp lệ/i);
  assert.equal(invalidUno.sequence, 0);
  assert.equal(service.submit(request(session, session.challenge, 0, 0, 'action-invalid-uno1', { type: 'choose-color', color: 'blue' })).error.code, 'ACTION_REPLAYED');

  const uno = submitUno(service, session);
  assert.equal(uno.accepted, true);
  assert.equal(uno.sequence, 1);
  assert.equal(uno.challenge.id, 'poker-check');
  const fold = submitPoker(service, session, 'fold', 'action-fold-0001');
  assert.equal(fold.accepted, false, 'a legal but off-objective fold must not count as the check exercise');
  assert.match(fold.feedback, /chưa hoàn thành mục tiêu/i);
  const call = submitPoker(service, session, 'call', 'action-call-0001');
  assert.equal(call.accepted, false);
  assert.match(call.feedback, /Không có cược để theo/i, 'feedback is returned from the existing Poker validator');
  const poker = submitPoker(service, session, 'check');
  assert.equal(poker.accepted, true);
  assert.equal(poker.sequence, 2);
  assert.equal(poker.challenge.id, 'phom-laydown');
  const badMeld = submitPhom(service, session, [['lesson-7S']], 'action-bad-meld-001');
  assert.equal(badMeld.accepted, false);
  assert.equal(badMeld.sequence, 2);
  const phom = submitPhom(service, session, [['lesson-3H', 'lesson-3D', 'lesson-3C']]);
  assert.equal(phom.accepted, true);
  assert.equal(phom.completed, true);
  assert.equal(phom.rewardClaimable, true);
  assert.equal(service.submit(request(session, session.challenge, 2, 2, 'action-phom-0001', { melds: [['lesson-3H', 'lesson-3D', 'lesson-3C']] })).error.code, 'ACTION_REPLAYED');
});

test('completion and reward stay once per profile/version across day boundaries and service restart', () => {
  let now = Date.parse('2026-10-06T23:59:50+07:00');
  const store = new MemoryTutorialStore();
  const first = harness({ clock: () => now, store });
  const session = first.service.start({ profileId: 'profile-A' });
  submitUno(first.service, session); submitPoker(first.service, session, 'check');
  assert.equal(submitPhom(first.service, session, [['lesson-3H', 'lesson-3D', 'lesson-3C']]).completed, true);
  assert.equal(store.hasTutorialVerification('profile-A', TUTORIAL_VERSION), true);
  now += 2 * 86400000;
  const afterRestart = new TutorialService({ store, clock: () => now });
  assert.equal(afterRestart.start({ profileId: 'profile-A' }).alreadyVerified, true);
  const firstClaim = afterRestart.claim({ profileId: 'profile-A' });
  const repeatedClaim = afterRestart.claim({ profileId: 'profile-A' });
  assert.equal(firstClaim.ok, true);
  assert.equal(firstClaim.alreadyClaimed, false);
  assert.equal(repeatedClaim.alreadyClaimed, true);
  assert.equal(store.balances.get('profile-A'), 200);
  assert.equal(store.ledger.size, 1);
  assert.equal(afterRestart.claim({ profileId: 'profile-B' }).error.code, 'TUTORIAL_NOT_VERIFIED');
  assert.equal(afterRestart.claim({ profileId: 'profile-A', version: 'old-version' }).error.code, 'TUTORIAL_VERSION');
});

test('sessions reject expiry and a failed final commit leaves the same challenge retryable', () => {
  let now = 1000;
  const { service, store } = harness({ clock: () => now, ttlMs: 500 });
  const expired = service.start({ profileId: 'profile-A' });
  now = 1500;
  assert.equal(service.submit(request(expired, expired.challenge, 0, 0, 'action-expired-0001', { type: 'choose-color', color: 'red' })).error.code, 'SESSION_EXPIRED');

  now = 2000;
  const session = service.start({ profileId: 'profile-A' });
  submitUno(service, session); submitPoker(service, session, 'check');
  store.failNextCommit = true;
  const failed = submitPhom(service, session, [['lesson-3H', 'lesson-3D', 'lesson-3C']], 'action-commit-fail1');
  assert.equal(failed.error.code, 'VERIFICATION_COMMIT_FAILED');
  assert.equal(store.hasTutorialVerification('profile-A', TUTORIAL_VERSION), false);
  assert.equal(session.sequence, 2);
  const retry = submitPhom(service, session, [['lesson-3H', 'lesson-3D', 'lesson-3C']], 'action-commit-retry1');
  assert.equal(retry.completed, true);
  assert.equal(store.hasTutorialVerification('profile-A', TUTORIAL_VERSION), true);
});

test('three completed matches do not unlock tutorial_verified; daily match missions remain match-driven', () => {
  const store = new ProfileStore({ databaseFile: ':memory:' });
  try {
    const profile = store.createProfile({ displayName: 'Tutorial check' }).profile;
    const completedAt = '2026-10-06T12:00:00.000Z';
    for (let index = 0; index < 3; index += 1) store.recordCompletedMatch({ matchId: `unlearned-${index}`, gameId: 'uno',
      players: [{ profileId: profile.id, outcome: 'WIN' }], completedAt });
    const missions = store.getMissions(profile.id, '2026-10-06');
    const tutorial = missions.find(item => item.id === 'tutorial_verified');
    assert.equal(tutorial.enabled, true);
    assert.equal(tutorial.verified, false);
    assert.equal(tutorial.progress, 0);
    assert.equal(tutorial.complete, false);
    assert.equal(missions.find(item => item.id === 'daily_three_matches').complete, true);
  } finally { store.close(); }
});
