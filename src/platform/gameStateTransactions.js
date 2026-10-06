'use strict';

const { restoreDisconnectedSeats } = require('./reconnectGrace');
const { notifyRoomCommitted } = require('./roomCommitEvents');

// Casual tables use the existing ProfileStore transaction and snapshot table.
// JSON remains readable for old installations and is an export after commit.
function installGameStateTransactions(manager, keys, keyForRoom) {
  const store = manager.profileStore || manager.profileService?.profiles;
  if (!store?.transaction || !store?.saveGameSnapshot || manager.runStateMutation) return;
  const diagnostics = manager.storageDiagnostics;
  for (const key of keys) if (diagnostics && !diagnostics.hasSource(`snapshot:${key}`)) {
    diagnostics.registerSource({ id: `snapshot:${key}`, gameId: key.startsWith('uno-') ? 'uno' : key,
      variant: key === 'uno-local' ? 'classic-local-v1' : key === 'uno-108' ? 'classic-108-v1' : null,
      kind: 'sqlite-room-snapshot',
      mode: store.databaseFile === ':memory:' ? 'memory' : 'persisted', authority: 'authoritative',
      fixture: store.databaseFile === ':memory:' });
  }
  manager.stateTransactionDepth = 0;
  manager.stateTransactionFailure = null;
  manager.stateEffects = null;
  manager.stateSnapshotKey = keyForRoom;
  manager.deferStateEffect = effect => {
    if (manager.stateTransactionDepth) manager.stateEffects.push(effect);
    else effect();
  };

  // Tombstones override stale JSON. Persist new reconnect deadlines before a
  // second crash can restart the grace period.
  store.transaction(() => {
    for (const key of keys) for (const saved of store.gameSnapshots(key)) {
      if (saved.closedAt) { manager.rooms.delete(saved.roomCode); continue; }
      const room = JSON.parse(saved.stateJson);
      if (!room || room.code !== saved.roomCode) throw new Error('Invalid casual room snapshot');
      restoreDisconnectedSeats(room.players, Date.now(), manager.graceMs);
      manager.refreshReconnectState(room);
      manager.rooms.set(room.code, room);
      store.saveGameSnapshot({ gameId: key, room });
    }
    // Upgrade legacy JSON without dropping its rooms or changing capabilities.
    for (const room of manager.rooms.values()) store.saveGameSnapshot({ gameId: keyForRoom(room), room });
  });

  const originalFlush = manager.flush.bind(manager);
  manager.flush = function (...args) {
    if (manager.stateTransactionDepth) { manager.stateExportPending = true; return; }
    if (!store.closed) store.transaction(() => {
      for (const room of manager.rooms.values()) store.saveGameSnapshot({ gameId: keyForRoom(room), room });
    });
    return originalFlush(...args);
  };
  manager.runStateMutation = function (work, socket, method, onRollback) {
    if (manager.stateTransactionDepth) {
      try { return work(); }
      catch (error) { manager.stateTransactionFailure ||= error; throw error; }
    }
    const refs = new Map(manager.rooms);
    const snapshots = new Map([...refs].map(([code, room]) => [code, structuredClone(room)]));
    const before = new Map([...refs].map(([code, room]) => [code, JSON.stringify(room)]));
    const playerRoom = new Map(manager.playerRoom), patches = [], effects = [];
    const committedCodes = [];
    const patch = (target, name, replacement) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, name), original = target[name];
      target[name] = replacement(original); patches.push(() => {
        if (descriptor) Object.defineProperty(target, name, descriptor); else delete target[name];
      });
    };
    // Include channel emissions (spotlights, result/mission events and emotes),
    // as well as private seat emissions and membership changes.
    if (typeof manager.io?.to === 'function') patch(manager.io, 'to', original => (...args) => {
      const channel = Reflect.apply(original, manager.io, args);
      return new Proxy(channel, { get(target, name) {
        if (name === 'emit') return (...callArgs) => { effects.push(() => target.emit(...callArgs)); return channel; };
        const value = target[name]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    const clients = manager.io?.sockets?.sockets;
    for (const client of clients instanceof Map ? clients.values() : Object.values(clients || {})) {
      for (const name of ['emit', 'join', 'leave']) if (typeof client[name] === 'function') {
        patch(client, name, original => (...args) => { effects.push(() => Reflect.apply(original, client, args)); });
      }
    }
    manager.stateTransactionDepth = 1; manager.stateTransactionFailure = null;
    manager.stateEffects = effects; manager.stateExportPending = false;
    let value, failure;
    try {
      value = store.transaction(() => {
        const result = work();
        if (manager.stateTransactionFailure) throw manager.stateTransactionFailure;
        for (const code of new Set([...refs.keys(), ...manager.rooms.keys()])) {
          const room = manager.rooms.get(code);
          if (room && before.get(code) !== JSON.stringify(room)) {
            store.saveGameSnapshot({ gameId: keyForRoom(room), room }); committedCodes.push(code);
          } else if (!room && refs.has(code)) {
            store.closeGameRoom(keyForRoom(refs.get(code)), code); committedCodes.push(code);
          }
        }
        return result;
      });
    } catch (error) {
      failure = error; manager.rooms.clear();
      for (const [code, room] of refs) {
        for (const key of Object.keys(room)) delete room[key];
        Object.assign(room, snapshots.get(code)); manager.rooms.set(code, room);
      }
      manager.playerRoom = playerRoom; manager.stateExportPending = false;
    } finally {
      manager.stateTransactionDepth = 0; manager.stateTransactionFailure = null; manager.stateEffects = null;
      for (const restore of patches.reverse()) restore();
    }
    if (failure) {
      onRollback?.();
      if (socket && typeof socket.emit === 'function') {
        if (method === 'handleAction') return { ok: false, error: { code: 'STORAGE_UNSAFE', message: failure.message } };
        return manager.error(socket, failure.message || 'Chưa thể lưu an toàn trạng thái bàn.');
      }
      if (['cleanup', 'handleDisconnect', 'timeout'].includes(method)) { console.error(`Không thể lưu ${method}:`, failure.message); return; }
      throw failure;
    }
    for (const effect of effects) effect();
    for (const code of committedCodes) notifyRoomCommitted(manager, code);
    if (manager.stateExportPending) originalFlush();
    manager.stateExportPending = false;
    return value;
  };
}

function wrapGameStateMutations(manager, target, methods) {
  if (!manager.runStateMutation) return;
  for (const method of methods) {
    const original = target[method];
    if (typeof original !== 'function') continue;
    target[method] = function (...args) {
      return manager.runStateMutation(() => Reflect.apply(original, this, args),
        args[0] && typeof args[0].emit === 'function' ? args[0] : null, method,
        () => target.onStateMutationFailed?.(method, args));
    };
  }
}

module.exports = { installGameStateTransactions, wrapGameStateMutations };
