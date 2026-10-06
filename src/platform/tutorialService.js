'use strict';

const crypto = require('node:crypto');
const { COLORS, applyAction } = require('../games/uno/engine');
const { validateMeldGroups } = require('../games/phom/phomDeck');
const { PokerManager } = require('../games/poker/pokerEngine');
const content = require('../../public/js/tutorial-content');

const TUTORIAL_VERSION = content.VERSION;
const TUTORIAL_REWARD = 200;
const SESSION_TTL_MS = 15 * 60 * 1000;
const EXERCISES = Object.freeze([
  Object.freeze({ id: 'uno-wild-color', gameId: 'uno', variant: 'classic-local-v1', phase: 'PLAYING',
    prompt: 'Bạn vừa đánh lá Wild. Chọn màu muốn dùng cho lượt tiếp theo.',
    publicState: { currentColor: 'red', topCard: { color: 'red', type: 'number', value: 5 }, myHand: [
      { id: 'lesson-wild', color: null, type: 'wild', value: null }, { id: 'lesson-blue-8', color: 'blue', type: 'number', value: 8 },
    ] },
    evaluate: ({ action, now }) => {
      if (!action || action.type !== 'choose-color' || !COLORS.includes(action.color)) return { ok: false, feedback: 'Chọn một màu hợp lệ để hoàn tất thao tác Wild.' };
      const match = { matchId: 'tutorial-match', phase: 'PLAYING', revision: 0, players: ['lesson-seat', 'lesson-opponent'], hands: {
        'lesson-seat': [{ id: 'lesson-wild', color: null, type: 'wild', value: null }, { id: 'lesson-blue-8', color: 'blue', type: 'number', value: 8 }],
        'lesson-opponent': [{ id: 'opponent-hidden-card', color: 'yellow', type: 'number', value: 2 }],
      }, drawPile: [{ id: 'lesson-draw', color: 'green', type: 'number', value: 1 }], discardPile: [{ id: 'lesson-red-5', color: 'red', type: 'number', value: 5 }], direction: 1,
      currentColor: 'red', currentPlayerId: 'lesson-seat', pendingDraw: 0, pendingTargetId: null, drawChoice: null, openingColorPending: false,
      reactionWindow: null, unoWindow: null, lastPlayedCard: null, result: null, actionReceipts: [], log: [] };
      const outcome = applyAction(match, { playerId: 'lesson-seat', type: 'play_card', payload: { cardId: 'lesson-wild', chosenColor: action.color }, now });
      return outcome.ok && match.currentColor === action.color ? { ok: true, feedback: `Đúng. Server đã nhận màu ${action.color} cho Wild.` }
        : { ok: false, feedback: outcome.error?.message || 'Thao tác Wild chưa được chấp nhận.' };
    } }),
  Object.freeze({ id: 'poker-check', gameId: 'poker', variant: 'holdem-nl-v1', phase: 'HAND',
    prompt: 'Mức cược hiện tại đã bằng phần bạn đặt trong vòng này. Chọn thao tác hợp lệ để tiếp tục mà không thêm chip.',
    publicState: { street: 'FLOP', currentBet: 20, myRoundBet: 20, callAmount: 0, legalActions: { canCheck: true, canCall: false, canFold: true } },
    evaluate: ({ action }) => {
      const room = { phase: 'HAND', currentPlayerId: 'lesson-seat', currentBet: 20, lastFullRaise: 10, players: [] };
      const player = { id: 'lesson-seat', inHand: true, folded: false, allIn: false, roundBet: 20, stack: 100, lastActionBet: null };
      room.players = [player, { id: 'lesson-opponent', inHand: true, folded: false, allIn: false, roundBet: 20, stack: 100, lastActionBet: null }];
      const adapter = {
        requireTurn: (_socket, currentRoom, currentPlayer) => currentRoom.phase === 'HAND' && currentRoom.currentPlayerId === currentPlayer.id,
        wagerTo: (_room, currentPlayer, target) => { currentPlayer.stack -= target - currentPlayer.roundBet; currentPlayer.roundBet = target; },
        addLog: () => {}, advanceIfNeeded: () => {}, error: (_socket, message) => ({ error: message }),
      };
      const result = PokerManager.prototype.bettingAction.call(adapter, null, room, player, { action: action?.type });
      if (action?.type !== 'check') return { ok: false, feedback: result?.error || 'Thao tác hợp lệ nhưng chưa hoàn thành mục tiêu bài tập.' };
      return result === true ? { ok: true, feedback: 'Đúng. Check hợp lệ vì không có chip nào cần theo.' }
        : { ok: false, feedback: result?.error || 'Server chưa chấp nhận thao tác.' };
    } }),
  Object.freeze({ id: 'phom-laydown', gameId: 'phom', variant: 'local-v1', phase: 'LAYDOWN',
    prompt: 'Chọn nhóm phỏm trên tay để hạ. Ba lá cùng giá trị tạo thành một bộ.',
    publicState: { myHand: [
      { id: 'lesson-3H', rank: '3', suit: 'H' }, { id: 'lesson-3D', rank: '3', suit: 'D' },
      { id: 'lesson-3C', rank: '3', suit: 'C' }, { id: 'lesson-7S', rank: '7', suit: 'S' },
    ], myEatenCardIds: [], publicMelds: [] },
    evaluate: ({ action }) => {
      const groups = action?.melds;
      const checked = validateMeldGroups(EXERCISE_CARDS.phom, groups || [], []);
      if (!checked || checked.usedIds.size !== 3) return { ok: false, feedback: 'Nhóm chưa hợp lệ hoặc chưa hạ được bộ bài trong bài tập.' };
      return { ok: true, feedback: 'Đúng. Server xác nhận nhóm ba lá cùng giá trị là một bộ hợp lệ.' };
    } }),
]);

const EXERCISE_CARDS = Object.freeze({ phom: EXERCISES[2].publicState.myHand });

function fail(code, message) { return { ok: false, error: { code, message } }; }
function safeCopy(value) { return JSON.parse(JSON.stringify(value)); }

class TutorialService {
  constructor({ store, clock = Date.now, ttlMs = SESSION_TTL_MS, idFactory = () => crypto.randomUUID(), nonceFactory = () => crypto.randomBytes(24).toString('base64url') } = {}) {
    this.store = store || null;
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.idFactory = idFactory;
    this.nonceFactory = nonceFactory;
    this.sessions = new Map();
  }

  requirePersistence() {
    if (!this.store || typeof this.store.transaction !== 'function' || typeof this.store.hasTutorialVerification !== 'function'
      || typeof this.store.recordTutorialVerification !== 'function' || typeof this.store.claimTutorialReward !== 'function') {
      const error = new Error('Tutorial chưa được nối với giao dịch ProfileStore; phần xác minh và thưởng vẫn khóa.');
      error.code = 'TUTORIAL_PERSISTENCE_UNAVAILABLE'; throw error;
    }
  }

  start({ profileId, version = TUTORIAL_VERSION } = {}) {
    this.requirePersistence();
    if (typeof profileId !== 'string' || !profileId) return fail('PROFILE_REQUIRED', 'Cần hồ sơ đã xác thực để bắt đầu hướng dẫn.');
    if (version !== TUTORIAL_VERSION) return fail('TUTORIAL_VERSION', 'Phiên bản hướng dẫn không còn được hỗ trợ.');
    if (this.store.hasTutorialVerification(profileId, version)) return { ok: true, alreadyVerified: true, version, reward: TUTORIAL_REWARD };
    const id = this.idFactory(), nonce = this.nonceFactory(), now = this.clock();
    const session = { id, nonce, profileId, version, sequence: 0, revision: 0, expiresAt: now + this.ttlMs, actionIds: new Set(), completed: false };
    this.sessions.set(id, session);
    return { ok: true, alreadyVerified: false, ...this.publicSession(session) };
  }

  publicSession(session) {
    const exercise = EXERCISES[session.sequence];
    return { sessionId: session.id, nonce: session.nonce, version: session.version, sequence: session.sequence, revision: session.revision,
      expiresAt: session.expiresAt, total: EXERCISES.length, challenge: exercise ? this.publicChallenge(exercise, session.sequence) : null };
  }

  publicChallenge(exercise, sequence) {
    return { id: exercise.id, sequence, gameId: exercise.gameId, variant: exercise.variant, phase: exercise.phase,
      prompt: exercise.prompt, state: safeCopy(exercise.publicState) };
  }

  submit({ profileId, version, sessionId, nonce, sequence, revision, challengeId, actionId, action } = {}) {
    this.requirePersistence();
    if (version !== TUTORIAL_VERSION) return fail('TUTORIAL_VERSION', 'Phiên bản hướng dẫn không khớp.');
    const session = this.sessions.get(sessionId);
    if (!session) return fail('SESSION_EXPIRED', 'Phiên hướng dẫn không còn hiệu lực. Hãy bắt đầu lại.');
    if (session.profileId !== profileId) return fail('SESSION_OWNER', 'Phiên hướng dẫn thuộc hồ sơ khác.');
    if (session.nonce !== nonce) return fail('SESSION_NONCE', 'Mã phiên hướng dẫn không hợp lệ.');
    if (session.expiresAt <= this.clock()) { this.sessions.delete(sessionId); return fail('SESSION_EXPIRED', 'Phiên hướng dẫn đã hết hạn. Hãy bắt đầu lại.'); }
    if (typeof actionId !== 'string' || actionId.length < 8 || actionId.length > 128) return fail('ACTION_ID', 'Mã thao tác không hợp lệ.');
    if (session.actionIds.has(actionId)) return fail('ACTION_REPLAYED', 'Thao tác này đã được gửi.');
    session.actionIds.add(actionId);
    if (sequence !== session.sequence || revision !== session.revision || challengeId !== EXERCISES[session.sequence]?.id) return fail('CHALLENGE_STALE', 'Bài tập đã chuyển trạng thái. Tải thử thách hiện tại rồi thử lại.');
    if (session.completed) return fail('CURRICULUM_COMPLETE', 'Chương trình này đã hoàn tất.');
    const exercise = EXERCISES[session.sequence];
    if (!exercise) return fail('CURRICULUM_ORDER', 'Không còn bài tập hợp lệ trong phiên này.');
    let result;
    try { result = exercise.evaluate({ action, now: this.clock() }); }
    catch { return fail('EXERCISE_INVALID', 'Không thể xác minh thao tác bài tập.'); }
    if (!result?.ok) return { ok: true, accepted: false, completed: false, sequence: session.sequence, revision: session.revision,
      feedback: result?.feedback || 'Thao tác chưa hoàn thành mục tiêu bài tập.' };
    const nextSequence = session.sequence + 1;
    if (nextSequence < EXERCISES.length) {
      session.sequence = nextSequence; session.revision += 1;
      return { ok: true, accepted: true, completed: false, sequence: session.sequence, revision: session.revision,
        feedback: result.feedback, challenge: this.publicChallenge(EXERCISES[session.sequence], session.sequence) };
    }
    const completedAt = new Date(this.clock()).toISOString();
    let verification;
    try {
      verification = this.store.transaction(() => this.store.recordTutorialVerification({ profileId, version, completedAt,
        operationKey: `tutorial-verified:${version}:${profileId}` }));
    } catch { return fail('VERIFICATION_COMMIT_FAILED', 'Chưa lưu được kết quả. Hãy gửi lại thao tác cuối bằng mã mới.'); }
    session.sequence = nextSequence; session.revision += 1; session.completed = true;
    return { ok: true, accepted: true, completed: true, version, completedAt, verification, feedback: result.feedback,
      reward: TUTORIAL_REWARD, rewardClaimable: true };
  }

  claim({ profileId, version = TUTORIAL_VERSION } = {}) {
    this.requirePersistence();
    if (typeof profileId !== 'string' || !profileId) return fail('PROFILE_REQUIRED', 'Cần hồ sơ đã xác thực để nhận thưởng.');
    if (version !== TUTORIAL_VERSION) return fail('TUTORIAL_VERSION', 'Phiên bản hướng dẫn không khớp.');
    if (!this.store.hasTutorialVerification(profileId, version)) return fail('TUTORIAL_NOT_VERIFIED', 'Hoàn tất chương trình hướng dẫn trước khi nhận thưởng.');
    try {
      const reward = this.store.transaction(() => this.store.claimTutorialReward({ profileId, version, amount: TUTORIAL_REWARD,
        operationKey: `tutorial-reward:${version}:${profileId}` }));
      return { ok: true, reward, alreadyClaimed: !!reward?.alreadyClaimed, version, amount: TUTORIAL_REWARD };
    } catch (error) { return fail(error.code || 'TUTORIAL_REWARD_FAILED', 'Không thể nhận thưởng hướng dẫn lúc này.'); }
  }

  cleanup() {
    const now = this.clock(); let removed = 0;
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) { this.sessions.delete(id); removed += 1; }
    return removed;
  }
}

module.exports = { TutorialService, TUTORIAL_VERSION, TUTORIAL_REWARD, SESSION_TTL_MS, EXERCISES };
