'use strict';

const crypto = require('node:crypto');

const DEFAULT_RECONNECT_GRACE_MS = 120000;
const serverActionSockets = new WeakMap();

function deadlineFor(player, graceMs = DEFAULT_RECONNECT_GRACE_MS) {
  if (Number.isFinite(player?.reconnectDeadlineAt)) return player.reconnectDeadlineAt;
  if (Number.isFinite(player?.disconnectedAt)) return player.disconnectedAt + graceMs;
  return null;
}

function markDisconnected(player, at = Date.now(), graceMs = DEFAULT_RECONNECT_GRACE_MS) {
  player.connected = false;
  player.socketId = null;
  player.disconnectedAt = at;
  player.reconnectDeadlineAt = at + graceMs;
}

function markConnected(player) {
  player.connected = true;
  player.disconnectedAt = null;
  player.reconnectDeadlineAt = null;
}

function restoreDisconnectedSeats(players, at = Date.now(), graceMs = DEFAULT_RECONNECT_GRACE_MS) {
  let changed = false;
  for (const player of players || []) {
    const existingDeadline = deadlineFor(player, graceMs);
    const deadline = existingDeadline ?? at + graceMs;
    if (!Number.isFinite(player.reconnectDeadlineAt)) changed = true;
    player.connected = false;
    player.socketId = null;
    if (!Number.isFinite(player.disconnectedAt)) player.disconnectedAt = deadline - graceMs;
    player.reconnectDeadlineAt = deadline;
  }
  return changed;
}

function isReconnectExpired(player, at = Date.now(), graceMs = DEFAULT_RECONNECT_GRACE_MS) {
  const deadline = deadlineFor(player, graceMs);
  return !player?.connected && Number.isFinite(deadline) && deadline <= at;
}

function reconnectWaiters(room, at = Date.now(), graceMs = DEFAULT_RECONNECT_GRACE_MS, applies = () => true) {
  return (room?.players || []).filter(player => !player.connected && applies(player) && !isReconnectExpired(player, at, graceMs));
}

function refreshReconnectPause(room, at = Date.now(), graceMs = DEFAULT_RECONNECT_GRACE_MS, applies = () => true) {
  const waiting = reconnectWaiters(room, at, graceMs, applies);
  room.reconnectPaused = waiting.length > 0;
  room.paused = room.reconnectPaused;
  return waiting;
}

function publicReconnectState(room, at = Date.now(), graceMs = DEFAULT_RECONNECT_GRACE_MS, applies = () => true) {
  const waiting = (room?.players || []).filter(player => !player.connected && applies(player)).map(player => {
    const deadlineAt = deadlineFor(player, graceMs);
    return {
      playerId: player.id,
      name: String(player.name || 'Người chơi').slice(0, 40),
      deadlineAt,
      expired: Number.isFinite(deadlineAt) && deadlineAt <= at,
    };
  });
  return waiting.length ? { serverNow: at, graceMs, waiting } : { serverNow: at, graceMs, waiting: [] };
}

function createServerActionSocket(manager, player) {
  const socket = {
    id: `server-action:${crypto.randomUUID()}`,
    emit() {},
    join() {},
    leave() {},
    to() { return { emit() {} }; },
  };
  serverActionSockets.set(socket, { manager, playerId: player.id });
  return socket;
}

function isServerActionSocket(manager, socket) {
  return serverActionSockets.get(socket)?.manager === manager;
}

function serverActionPlayer(manager, room, socket) {
  const action = serverActionSockets.get(socket);
  return action?.manager === manager ? room?.players.find(player => player.id === action.playerId) || null : null;
}

function runServerAction(manager, room, player, data) {
  if (!player?.connected && !isReconnectExpired(player, Date.now(), manager.graceMs)) return false;
  const socket = player.connected ? manager.io?.sockets?.sockets?.get(player.socketId) : createServerActionSocket(manager, player);
  if (!socket) return false;
  return manager.action(socket, room.code, {
    ...data,
    actionId: crypto.randomUUID(),
    expectedRevision: room.revision,
  });
}

module.exports = {
  DEFAULT_RECONNECT_GRACE_MS,
  deadlineFor,
  markDisconnected,
  markConnected,
  restoreDisconnectedSeats,
  isReconnectExpired,
  reconnectWaiters,
  refreshReconnectPause,
  publicReconnectState,
  createServerActionSocket,
  isServerActionSocket,
  serverActionPlayer,
  runServerAction,
};
