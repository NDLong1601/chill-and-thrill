'use strict';

const crypto = require('node:crypto');
const { createServerActionSocket, isReconnectExpired, publicReconnectState } = require('./reconnectGrace');
const TURN_MS = 30000;

// The saved deadline is authoritative; browser timers only display it.
function installTurnClock(manager, { getTurn, timeoutAction, stateMethod = 'buildStateFor' }) {
  let processing = false;
  function refresh(room, at = Date.now()) {
    const turn = getTurn(room);
    if (!turn) { room.turnClock = null; return null; }
    const key = `${room.matchId}:${turn.key || ''}:${turn.playerId}`;
    let clock = room.turnClock;
    if (!clock || clock.key !== key) clock = room.turnClock = { key, playerId: turn.playerId, durationMs: TURN_MS, remainingMs: TURN_MS, deadlineAt: null };
    const paused = room.paused || turn.paused;
    if (paused && clock.deadlineAt !== null) { clock.remainingMs = Math.max(0, clock.deadlineAt - at); clock.deadlineAt = null; }
    else if (!paused && clock.deadlineAt === null) clock.deadlineAt = at + clock.remainingMs;
    return clock;
  }
  function expire(room, at = Date.now(), force = false) {
    let reconnect = null;
    if (typeof manager.refreshReconnectState === 'function') reconnect = manager.refreshReconnectState(room, at);
    else if (typeof manager.updatePaused === 'function') reconnect = manager.updatePaused(room, at);
    const clock = refresh(room, at);
    if (processing || !clock) return false;
    const player = manager.rooms.get(room.code)?.players.find(item => item.id === clock.playerId);
    const turn = getTurn(room);
    const autoAtGraceEnd = player && isReconnectExpired(player, at, manager.graceMs)
      && !reconnect?.waiting?.length && !room.paused && !room.hostPaused && !turn?.paused;
    const forcedExpiredActor = (force || autoAtGraceEnd) && !room.paused && !room.hostPaused && !turn?.paused
      && (!clock.retryNotBefore || clock.retryNotBefore <= at)
      && player && isReconnectExpired(player, at, manager.graceMs);
    if (forcedExpiredActor) { clock.deadlineAt = at; clock.remainingMs = 0; }
    if (!clock.deadlineAt || clock.deadlineAt > at) return false;
    const socket = player?.connected
      ? manager.io.sockets.sockets.get(player.socketId)
      : player && isReconnectExpired(player, at, manager.graceMs) ? createServerActionSocket(manager, player) : null;
    if (!socket) return false;
    processing = true;
    try {
      const outcome = timeoutAction(room, player, socket, { actionId: crypto.randomUUID(), expectedRevision: room.revision });
      if (outcome?.error || outcome?.ok === false) throw new Error(outcome.error?.message || outcome.error || 'Server không thể xác nhận nước đi tự động.');
      // Some games keep the same actor for a draw/discard or a cut. Every
      // timeout must either advance the turn or leave a fresh finite deadline.
      if (room.turnClock === clock) room.turnClock = null;
      delete clock.retryNotBefore;
      refresh(room, at); manager.broadcast(room.code);
      return true;
    } catch (error) {
      // Do not retry financial settlement each timer tick when storage fails.
      const retryClock = room.turnClock || clock;
      retryClock.deadlineAt = at + TURN_MS; retryClock.remainingMs = TURN_MS; retryClock.retryNotBefore = at + TURN_MS; room.turnClock = retryClock;
      manager.addLog?.(room, 'Server chưa lưu được lượt tự động; sẽ thử lại sau 30 giây.');
      try { manager.broadcast(room.code); } catch { /* Keep the retry deadline even if broadcasting also fails. */ }
      return false;
    } finally { processing = false; }
  }
  for (const method of ['touch', 'broadcast']) {
    const original = manager[method]?.bind(manager);
    if (original) manager[method] = function (...args) { const room = method === 'touch' ? args[0] : manager.rooms.get(args[0]); if (room) refresh(room); return original(...args); };
  }
  const state = manager[stateMethod].bind(manager);
  manager[stateMethod] = function (room, ...args) {
    const serverNow = Date.now();
    const clock = refresh(room, serverNow);
    const result = state(room, ...args);
    const reconnectApplies = typeof manager.reconnectAffects === 'function' ? player => manager.reconnectAffects(room, player) : undefined;
    return { ...result, serverNow, reconnect: publicReconnectState(room, serverNow, manager.graceMs, reconnectApplies), turnClock: clock ? { playerId: clock.playerId, durationMs: TURN_MS, deadlineAt: clock.deadlineAt, remainingMs: clock.deadlineAt ? Math.max(0, clock.deadlineAt - serverNow) : clock.remainingMs } : null };
  };
  const action = manager.action?.bind(manager);
  if (action) manager.action = function (socket, code, data) {
    const room = manager.rooms.get(code);
    if (room && !processing && expire(room)) return manager.error(socket, 'Lượt đã hết 30 giây; bàn vừa được cập nhật.');
    const before = room && { actor: getTurn(room)?.playerId, revision: room.revision };
    const result = action(socket, code, data);
    if (room && before?.revision !== room.revision && before?.actor === getTurn(room)?.playerId && room.actionIds?.[data?.actionId] && ['play', 'pass', 'fold', 'check', 'call', 'bet', 'raise', 'all_in'].includes(data.action)) {
      room.turnClock = null; refresh(room); manager.broadcast(code);
    }
    return result;
  };
  const timer = setInterval(() => { for (const room of manager.rooms.values()) expire(room); }, 250);
  timer.unref();
  const close = manager.close.bind(manager);
  manager.close = function () { clearInterval(timer); return close(); };
  manager.turnClock = { refresh, expire, timer };
  for (const room of manager.rooms.values()) refresh(room);
}

function standardTurn(room) {
  if (!room.currentPlayerId || ['WAITING', 'RESULT', 'CANCELLED', 'UNO_WINDOW', 'WDF_CHALLENGE'].includes(room.phase)) return null;
  const key = room.gameId === 'phom' ? (room.phase === 'LAYDOWN' ? 'laydown' : 'play') : room.gameId === 'bang' ? 'turn' : room.street || room.phase;
  return { playerId: room.pending?.waitingId || room.currentPlayerId, key: room.pending ? `${key}:${room.pending.id}:${room.pending.waitingId}` : key };
}

module.exports = { installTurnClock, standardTurn, TURN_MS };
