'use strict';

// Internal observers receive only room identities, after the authoritative
// transaction succeeds. Private state stays inside the manager/projector.
const observers = new WeakMap();

function subscribeRoomCommits(manager, listener) {
  let listeners = observers.get(manager);
  if (!listeners) observers.set(manager, listeners = new Set());
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyRoomCommitted(manager, roomCode) {
  for (const listener of observers.get(manager) || []) {
    try { listener(roomCode); }
    catch (error) { console.error('Room commit observer:', error?.message || error); }
  }
}

module.exports = { subscribeRoomCommits, notifyRoomCommitted };
