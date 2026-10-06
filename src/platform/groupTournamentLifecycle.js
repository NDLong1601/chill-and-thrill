'use strict';

// Bridges trusted room-manager lifecycle events to the durable group ranking
// ledger. Start intent is committed before a manager can mutate its room; the
// exact match id is linked after start, outside C01's group lock.
const crypto = require('node:crypto');
const { TournamentError } = require('./groupTournamentService');

function isId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 160; }
function sameProfileSet(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && [...new Set(left)].length === left.length && [...new Set(right)].length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}
function readJson(value) {
  try { return JSON.parse(value); } catch { throw new TournamentError('Dữ liệu vòng đời giải đã lưu không đọc được.', 'TOURNAMENT_DATA_INVALID', 503); }
}

class GroupTournamentLifecycle {
  constructor({ tournamentService, getRoom, onError = error => console.error('Group tournament lifecycle:', error?.message || error) } = {}) {
    if (!tournamentService?.store?.db || typeof tournamentService.prepareStartIntent !== 'function'
      || typeof tournamentService.bindStartIntent !== 'function' || typeof getRoom !== 'function') {
      throw new TypeError('GroupTournamentLifecycle requires GroupTournamentService and a trusted getRoom(roomCode) resolver.');
    }
    this.service = tournamentService;
    this.store = tournamentService.store;
    this.getRoom = getRoom;
    this.onError = onError;
    this.pending = new Set();
    this.cancellationCaptures = new Map();
    this.closed = false;
  }

  authorizeTarget(args) {
    return this.service.authorizeTarget(args);
  }

  async beforeStart({ groupId, room, gameId = room?.gameId || 'the-gang', variant } = {}) {
    if (this.closed) throw new TournamentError('Vòng đời giải đang dừng.', 'TOURNAMENT_LIFECYCLE_CLOSED', 503);
    if (!isId(groupId)) return { tracked: false };
    return this.service.prepareStartIntent({ groupId, room, gameId, variant });
  }

  async afterStart({ startIntentId, room } = {}) {
    if (this.closed) throw new TournamentError('Vòng đời giải đang dừng.', 'TOURNAMENT_LIFECYCLE_CLOSED', 503);
    if (!isId(startIntentId)) return { registered: false, status: 'NO_INTENT' };
    const row = this.store.db.prepare("SELECT payload_json, status FROM group_tournament_records WHERE record_id = ? AND record_type = 'match'").get(startIntentId);
    if (!row) throw new TournamentError('Không tìm thấy lượt bắt đầu đã lưu.', 'START_INTENT_NOT_FOUND', 404);
    const record = readJson(row.payload_json);
    const actualRoom = room || this.getRoom(record.roomCode, record.gameId);
    if (record.kind === 'start_intent') {
      const linked = await this.service.bindStartIntent({ startIntentId, room: actualRoom });
      const committed = this.store.db.prepare("SELECT 1 FROM matches WHERE match_id = ? AND status = 'COMPLETED'").get(linked.matchId);
      if (!committed) return linked;
      const reconciled = await this.service.reconcileCommittedMatch({ groupId: record.groupId, gameId: record.gameId, variant: record.variant, matchId: linked.matchId });
      return { ...linked, reconciled };
    }
    if (record.startIntentId !== startIntentId || !['REGISTERED', 'SCORED', 'CANCELLED', 'NO_SCORE'].includes(row.status)
      || !actualRoom || actualRoom.matchId !== record.matchId || actualRoom.code !== record.roomCode
      || (actualRoom.gameId || 'the-gang') !== record.gameId) {
      throw new TournamentError('Lượt bắt đầu không còn ở trạng thái liên kết.', 'START_INTENT_INVALID', 409);
    }
    const committed = this.store.db.prepare("SELECT 1 FROM matches WHERE match_id = ? AND status = 'COMPLETED'").get(record.matchId);
    const reconciled = committed ? await this.service.reconcileCommittedMatch({ groupId: record.groupId, gameId: record.gameId, variant: record.variant, matchId: record.matchId }) : null;
    return { registered: true, duplicate: true, matchId: record.matchId, reconciled };
  }

  async failStart({ startIntentId, room, message } = {}) {
    const row = this.store.db.prepare("SELECT payload_json FROM group_tournament_records WHERE record_id = ? AND record_type = 'match' AND status = 'STARTING'").get(startIntentId);
    if (!row) return { failed: false, status: 'NOT_STARTING' };
    const intent = readJson(row.payload_json);
    const actualRoom = room || this.getRoom(intent.roomCode, intent.gameId);
    return this.service.failStartIntent({ startIntentId, room: actualRoom, message });
  }

  async aroundStart({ groupId, room, gameId = room?.gameId || 'the-gang', variant, start } = {}) {
    if (typeof start !== 'function') throw new TypeError('aroundStart requires the trusted manager start function.');
    const prepared = await this.beforeStart({ groupId, room, gameId, variant });
    let result;
    try {
      result = await start();
    } catch (error) {
      if (prepared.tracked) await this.failStart({ startIntentId: prepared.startIntentId, room, message: error?.message });
      throw error;
    }
    if (!prepared.tracked) return result;
    if (result?.error || result?.ok === false) {
      await this.failStart({ startIntentId: prepared.startIntentId, room, message: result.error || 'Manager did not start the match.' });
      return result;
    }
    const currentRoom = this.getRoom(room?.code, gameId) || room;
    const currentMatchId = typeof currentRoom?.matchId === 'string' ? currentRoom.matchId : null;
    if (currentRoom?.phase === prepared.startPhase && currentMatchId === prepared.waitingMatchId) {
      await this.failStart({ startIntentId: prepared.startIntentId, room: currentRoom, message: 'Manager did not change the waiting room.' });
      return result;
    }
    await this.afterStart({ startIntentId: prepared.startIntentId });
    return result;
  }

  async captureCancellation({ groupId, room } = {}) {
    if (this.closed || !isId(groupId) || !room || !isId(room.code) || !isId(room.matchId)) return { tracked: false };
    const gameId = room.gameId || 'the-gang';
    const context = await this.service.getTrustedContext(groupId);
    const binding = context?.roomBinding;
    if (!context || context.groupId !== groupId || context.currentTargetRoomCode !== room.code || !binding
      || binding.roomCode !== room.code || binding.gameId !== gameId || binding.matchId !== room.matchId || binding.phase !== room.phase
      || room.phase === 'WAITING' || !Array.isArray(binding.participants)) return { tracked: false };
    const association = this.store.db.prepare(`SELECT record_id, payload_json FROM group_tournament_records
      WHERE record_type = 'match' AND group_id = ? AND game_id = ? AND match_id = ? AND status = 'REGISTERED'`).get(groupId, gameId, room.matchId);
    if (!association) return { tracked: false };
    const match = readJson(association.payload_json);
    const seats = (room.players || []).map(player => ({ seatId: player.id, profileId: player.profileId }));
    if (match.roomCode !== room.code || match.variant !== binding.variant
      || !sameProfileSet(binding.participants, match.participantProfileIds)
      || !sameProfileSet(seats.map(item => item.profileId), match.participantProfileIds)) {
      throw new TournamentError('Server match hiện tại không khớp roster đã khóa; không ghi nhận hủy.', 'MATCH_GROUP_BINDING_INVALID', 409);
    }
    const captureId = crypto.randomUUID();
    this.cancellationCaptures.set(captureId, { groupId, roomCode: room.code, gameId, variant: match.variant,
      matchId: room.matchId, participantProfileIds: match.participantProfileIds, phase: room.phase });
    return { tracked: true, captureId };
  }

  async aroundCancellation({ groupId, room, cancel } = {}) {
    if (typeof cancel !== 'function') throw new TypeError('aroundCancellation requires the trusted server cancellation function.');
    const capture = await this.captureCancellation({ groupId, room });
    let result;
    try { result = await cancel(); }
    catch (error) {
      if (capture.tracked) this.cancellationCaptures.delete(capture.captureId);
      throw error;
    }
    if (!capture.tracked) return result;
    if (result === false || result?.error || result?.ok === false || result?.cancelled === false || result?.canceled === false) {
      this.cancellationCaptures.delete(capture.captureId);
      return result;
    }
    const captured = this.cancellationCaptures.get(capture.captureId);
    this.cancellationCaptures.delete(capture.captureId);
    const currentRoom = this.getRoom(captured.roomCode, captured.gameId);
    const reset = !currentRoom || currentRoom.code !== captured.roomCode || currentRoom.gameId && currentRoom.gameId !== captured.gameId
      || currentRoom.phase === 'WAITING'
      || currentRoom.phase === 'CANCELLED';
    if (!reset) return result;
    const resolution = await this.service.resolveCapturedCancellation(captured);
    return { result, tournamentCancellation: resolution };
  }

  onMatchCommitted(match) {
    if (this.closed) return Promise.resolve({ ignored: true, status: 'CLOSED' });
    const promise = this.processCommittedMatch(match);
    return this.track(promise);
  }

  async processCommittedMatch(match) {
    if (!isId(match?.matchId) || !isId(match?.gameId)) return { ignored: true, status: 'INVALID_IDENTITY' };
    const row = this.store.db.prepare("SELECT * FROM group_tournament_records WHERE record_type = 'match' AND match_id = ? AND status = 'REGISTERED'").get(match.matchId);
    if (row) {
      const association = readJson(row.payload_json);
      if (association.gameId !== match.gameId || (match.roomCode && association.roomCode !== match.roomCode)) {
        throw new TournamentError('Completion callback does not match its durable room association.', 'MATCH_PROOF_MISMATCH', 409);
      }
      return this.service.reconcileCommittedMatch({ groupId: association.groupId, gameId: association.gameId,
        variant: association.variant, matchId: association.matchId });
    }
    const intents = this.store.db.prepare("SELECT record_id, payload_json FROM group_tournament_records WHERE record_type = 'match' AND status = 'STARTING' AND game_id = ?").all(match.gameId);
    const intentRow = intents.find(item => {
      const intent = readJson(item.payload_json);
      return intent.kind === 'start_intent' && intent.roomCode === match.roomCode;
    });
    if (!intentRow) return { ignored: true, status: 'NO_GROUP_START_INTENT' };
    const intent = readJson(intentRow.payload_json);
    const room = this.getRoom(intent.roomCode, intent.gameId);
    const linked = await this.afterStart({ startIntentId: intentRow.record_id, room });
    if (linked.matchId !== match.matchId) throw new TournamentError('Commit arrived for a different match than the prepared room start.', 'MATCH_ASSOCIATION_CONFLICT', 409);
    return linked;
  }

  track(promise) {
    let tracked;
    tracked = Promise.resolve(promise).catch(error => {
      try { this.onError(error); } catch { /* lifecycle errors must not break a committed game event */ }
      return { error };
    }).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }

  async reconcilePending() {
    if (this.closed) return { reconciled: 0, recovered: 0, pending: 0 };
    let reconciled = 0, recovered = 0;
    const registered = this.store.db.prepare("SELECT record_id, payload_json FROM group_tournament_records WHERE record_type = 'match' AND status = 'REGISTERED' ORDER BY created_at").all();
    for (const row of registered) {
      const match = readJson(row.payload_json);
      const committed = this.store.db.prepare("SELECT 1 FROM matches WHERE match_id = ? AND status = 'COMPLETED'").get(match.matchId);
      if (!committed) {
        const cancellation = await this.service.recoverCommittedCoinCancellation(match);
        if (cancellation.applied) recovered++;
        continue;
      }
      const result = await this.service.reconcileCommittedMatch({ groupId: match.groupId, gameId: match.gameId, variant: match.variant, matchId: match.matchId });
      if (result.applied) reconciled++;
    }
    const intents = this.store.db.prepare("SELECT record_id, payload_json FROM group_tournament_records WHERE record_type = 'match' AND status = 'STARTING' ORDER BY created_at").all();
    for (const row of intents) {
      const intent = readJson(row.payload_json);
      if (intent.kind !== 'start_intent') continue;
      const room = this.getRoom(intent.roomCode, intent.gameId);
      const result = await this.service.recoverStartIntent({ startIntentId: row.record_id, room });
      if (result.recovered || ['REGISTERED', 'RECONCILED'].includes(result.status)) recovered++;
    }
    await this.drain();
    const pending = this.store.db.prepare("SELECT COUNT(*) AS count FROM group_tournament_records WHERE record_type = 'match' AND status IN ('STARTING', 'REGISTERED')").get().count;
    return { reconciled, recovered, pending };
  }

  async drain() {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  async close() {
    this.closed = true;
    await this.drain();
  }
}

function createGroupTournamentLifecycle(options) {
  const lifecycle = new GroupTournamentLifecycle(options);
  return {
    beforeStart: lifecycle.beforeStart.bind(lifecycle),
    afterStart: lifecycle.afterStart.bind(lifecycle),
    failStart: lifecycle.failStart.bind(lifecycle),
    aroundStart: lifecycle.aroundStart.bind(lifecycle),
    captureCancellation: lifecycle.captureCancellation.bind(lifecycle),
    aroundCancellation: lifecycle.aroundCancellation.bind(lifecycle),
    onMatchCommitted: lifecycle.onMatchCommitted.bind(lifecycle),
    reconcilePending: lifecycle.reconcilePending.bind(lifecycle),
    authorizeTarget: lifecycle.authorizeTarget.bind(lifecycle),
    drain: lifecycle.drain.bind(lifecycle),
    close: lifecycle.close.bind(lifecycle),
    instance: lifecycle,
  };
}

module.exports = { GroupTournamentLifecycle, createGroupTournamentLifecycle };
