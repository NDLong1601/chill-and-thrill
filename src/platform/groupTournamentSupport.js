'use strict';

const { GroupTournamentService } = require('./groupTournamentService');
const { createGroupTournamentLifecycle } = require('./groupTournamentLifecycle');
const { attachGroupTournamentRoutes } = require('./groupTournamentRoutes');

function attachGroupTournamentSupport(app, { gm, profiles, groupLobbyService } = {}) {
  const store = gm.profiles;
  if (store.readOnly) {
    app.use('/api/groups/:groupId/tournaments', (_req, res) => res.status(503).set('Cache-Control', 'no-store')
      .json({ code: 'TOURNAMENT_STORE_UNAVAILABLE', error: 'Giải đấu cần dữ liệu có thể lưu an toàn.' }));
    return { service: null, lifecycle: null, ready: Promise.resolve(), close: async () => {} };
  }
  const service = new GroupTournamentService({ profileStore: store,
    getTrustedGroupSnapshot: groupId => groupLobbyService.getTrustedGroupSnapshot(groupId) });
  const errors = [], pendingStarts = new Set();
  let closing = false;
  const noteError = error => {
    errors.push({ code: error?.code || 'TOURNAMENT_LIFECYCLE_ERROR', message: error?.message || String(error) });
    if (errors.length > 32) errors.shift();
    console.error('Group tournament lifecycle:', error?.message || error);
  };
  const lifecycle = createGroupTournamentLifecycle({ tournamentService: service,
    getRoom: code => gm.managerForCode(code)?.rooms.get(code), onError: noteError });
  attachGroupTournamentRoutes(app, { service, profiles });

  function boundGroup(room) {
    if (!room) return null;
    const groupId = room?.players?.map(player => groupLobbyService.profileGroups.get(player.profileId)).find(Boolean);
    const group = groupId && groupLobbyService.groups.get(groupId);
    return group && group.currentTargetRoomCode === room.code && service.membershipLocked(groupId) ? groupId : null;
  }

  const originalStart = gm.startGame;
  function trackedStart(socket, room, invoke) {
    const groupId = boundGroup(room);
    if (!groupId) return invoke();
    if (closing) return gm.error(socket, 'Giải đấu đang dừng. Hãy thử lại sau.');
    let pending;
    pending = lifecycle.aroundStart({ groupId, room, gameId: room.gameId || 'the-gang',
      variant: room.gameId === 'uno' ? room.variant || room.config?.variant : 'standard',
      start: invoke,
    }).catch(error => {
      noteError(error);
      return gm.error(socket, error?.message || 'Không thể bắt đầu vòng giải.');
    }).finally(() => pendingStarts.delete(pending));
    pendingStarts.add(pending);
    return pending;
  }
  function startGame(socket, code) {
    return trackedStart(socket, gm.managerForCode(code)?.rooms.get(code), () => Reflect.apply(originalStart, gm, [socket, code]));
  }
  gm.startGame = startGame;

  const originalAction = gm.gameAction;
  function gameAction(socket, code, data) {
    if (['cancel_before_first_play', 'cancel_before_first_discard'].includes(data?.action)) {
      return trackedCancellation(socket, gm.managerForCode(code)?.rooms.get(code),
        () => Reflect.apply(originalAction, gm, [socket, code, data]));
    }
    if (data?.action !== 'play_again') return Reflect.apply(originalAction, this, [socket, code, data]);
    return trackedStart(socket, gm.managerForCode(code)?.rooms.get(code), () => Reflect.apply(originalAction, gm, [socket, code, data]));
  }
  gm.gameAction = gameAction;
  const originalClassicAction = gm.roomService.handleGameAction;
  function classicAction(socket, envelope) {
    if (envelope?.type !== 'start_next_round') return Reflect.apply(originalClassicAction, this, [socket, envelope]);
    const code = String(envelope.roomCode || '').trim().toUpperCase();
    return trackedStart(socket, gm.managerForCode(code)?.rooms.get(code), () => Reflect.apply(originalClassicAction, gm.roomService, [socket, envelope]));
  }
  gm.roomService.handleGameAction = classicAction;

  function trackedCancellation(socket, room, invoke) {
    const groupId = boundGroup(room);
    if (!groupId || room.phase === 'WAITING') return invoke();
    const registered = store.db.prepare("SELECT 1 FROM group_tournament_records WHERE record_type='match' AND match_id=? AND status='REGISTERED'").get(room.matchId);
    if (!registered) return invoke();
    if (closing) return gm.error(socket, 'Giải đấu đang dừng. Hãy thử lại sau.');
    let pending;
    pending = lifecycle.aroundCancellation({ groupId, room, cancel: invoke })
      .then(result => result?.tournamentCancellation ? result.result : result)
      .catch(error => { noteError(error); return gm.error(socket, error?.message || 'Không thể xác nhận vòng đã dừng.'); })
      .finally(() => pendingStarts.delete(pending));
    pendingStarts.add(pending);
    return pending;
  }

  const restoreCancellations = [];
  for (const method of ['leaveRoom', 'gangAction']) {
    const original = gm[method];
    function cancelRoom(...args) {
      const [operation, socket, code] = method === 'gangAction' ? args : [null, ...args];
      if (method === 'gangAction' && !['returnToLobby', 'playAgain'].includes(operation)) return Reflect.apply(original, this, args);
      const room = gm.managerForCode(code)?.rooms.get(code);
      if (method === 'gangAction' && operation === 'playAgain') return trackedStart(socket, room, () => Reflect.apply(original, gm, args));
      return trackedCancellation(socket, room, () => Reflect.apply(original, gm, args));
    }
    gm[method] = cancelRoom;
    restoreCancellations.push(() => { if (gm[method] === cancelRoom) gm[method] = original; });
  }

  const originalCompletion = store.recordCompletedMatch;
  function recordCompletedMatch(match) {
    const result = Reflect.apply(originalCompletion, this, [match]);
    const identity = { matchId: match.matchId, gameId: match.gameId, roomCode: match.roomCode };
    queueMicrotask(() => {
      if (closing || store.closed) return;
      // Engine callbacks can execute inside a larger room transaction. Only
      // observe a completion after that synchronous transaction has committed.
      const committed = store.db.prepare("SELECT 1 FROM matches WHERE match_id = ? AND status = 'COMPLETED'").get(identity.matchId);
      if (committed) void lifecycle.onMatchCommitted(identity);
    });
    return result;
  }
  store.recordCompletedMatch = recordCompletedMatch;
  const ready = lifecycle.reconcilePending().catch(error => { noteError(error); return { error }; });
  const recoveryTimer = setInterval(() => {
    if (!closing) void lifecycle.reconcilePending().catch(noteError);
  }, 2000);
  recoveryTimer.unref();
  return {
    service, lifecycle, ready, errors,
    close: async () => {
      closing = true; clearInterval(recoveryTimer);
      if (gm.startGame === startGame) gm.startGame = originalStart;
      if (gm.gameAction === gameAction) gm.gameAction = originalAction;
      if (gm.roomService.handleGameAction === classicAction) gm.roomService.handleGameAction = originalClassicAction;
      restoreCancellations.forEach(restore => restore());
      if (store.recordCompletedMatch === recordCompletedMatch) store.recordCompletedMatch = originalCompletion;
      await ready; await Promise.all([...pendingStarts]); await Promise.resolve();
      await lifecycle.drain(); await lifecycle.close();
    },
  };
}

module.exports = { attachGroupTournamentSupport };
