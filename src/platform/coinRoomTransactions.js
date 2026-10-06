'use strict';

const { notifyRoomCommitted } = require('./roomCommitEvents');

// Fixed-stake rooms commit their private recovery state with every ledger
// operation. The room JSON remains a best-effort compatibility export.
function installCoinRoomTransactions(manager, gameId) {
  const store = manager.profileStore;
  if (!store?.transaction || !store?.saveGameSnapshot) return;

  const methods = ['createRoom', 'joinRoom', 'resumeRoom', 'setReady', 'startGame', 'startRound',
    'action', 'finish', 'settle', 'finishRound', 'cancelBeforeFirstPlay',
    'cancelBeforeFirstDiscard', 'playAgain', 'leaveRoom', 'handleDisconnect', 'cleanup'];
  manager.coinTransactionDepth = 0;
  manager.coinTransactionFailure = null;

  const originalFlush = manager.flush.bind(manager);
  manager.flush = function (...args) {
    if (manager.coinTransactionDepth) { manager.coinFlushPending = true; return; }
    return originalFlush(...args);
  };

  const originalClose = manager.close.bind(manager);
  manager.close = function (...args) {
    if (manager.coinManagerClosed || store.closed) { manager.coinManagerClosed = true; return originalClose(...args); }
    if (manager.coinTransactionDepth) return originalClose(...args);
    manager.coinTransactionDepth = 1;
    manager.coinFlushPending = false;
    try {
      store.transaction(() => {
        for (const room of manager.rooms.values()) store.saveGameSnapshot({ gameId, room });
        originalClose(...args);
      });
    } finally { manager.coinTransactionDepth = 0; manager.coinManagerClosed = true; }
    if (manager.coinFlushPending) originalFlush();
    manager.coinFlushPending = false;
  };

  for (const method of methods) {
    const original = manager[method];
    if (typeof original !== 'function') continue;
    manager[method] = function (...args) {
      if (manager.coinTransactionDepth) {
        try { return original.apply(this, args); }
        catch (error) { manager.coinTransactionFailure ||= error; throw error; }
      }

      const roomRefs = new Map(manager.rooms);
      const roomStates = new Map([...roomRefs].map(([code, room]) => [code, structuredClone(room)]));
      const playerRoom = new Map(manager.playerRoom);
      const before = new Map([...roomRefs].map(([code, room]) => [code, JSON.stringify(room)]));
      const effects = [];
      const committedCodes = [];
      const patched = [];
      const sockets = manager.io?.sockets?.sockets;
      const socketValues = sockets instanceof Map ? [...sockets.values()] : Object.values(sockets || {});
      for (const socket of socketValues) {
        for (const name of ['emit', 'join', 'leave']) {
          if (typeof socket?.[name] !== 'function') continue;
          const ownDescriptor = Object.getOwnPropertyDescriptor(socket, name);
          const originalMethod = socket[name];
          socket[name] = (...callArgs) => { effects.push(() => Reflect.apply(originalMethod, socket, callArgs)); };
          patched.push({ socket, name, ownDescriptor });
        }
      }

      const restoreSocketMethods = () => {
        for (let index = patched.length - 1; index >= 0; index--) {
          const { socket, name, ownDescriptor } = patched[index];
          if (ownDescriptor) Object.defineProperty(socket, name, ownDescriptor);
          else delete socket[name];
        }
      };
      manager.coinTransactionDepth = 1;
      manager.coinTransactionFailure = null;
      manager.coinFlushPending = false;
      let result;
      try {
        result = store.transaction(() => {
          const value = original.apply(this, args);
          if (manager.coinTransactionFailure) throw manager.coinTransactionFailure;
          const changed = new Set([...roomRefs.keys(), ...manager.rooms.keys()]);
          for (const code of changed) {
            const room = manager.rooms.get(code);
            if (room) {
              if (before.get(code) !== JSON.stringify(room)) {
                store.saveGameSnapshot({ gameId, room }); committedCodes.push(code);
              }
            } else if (roomRefs.has(code)) {
              store.closeGameRoom(gameId, code); committedCodes.push(code);
            }
          }
          return value;
        });
      } catch (error) {
        manager.rooms.clear();
        for (const [code, room] of roomRefs) {
          for (const key of Object.keys(room)) delete room[key];
          Object.assign(room, roomStates.get(code));
          manager.rooms.set(code, room);
        }
        manager.playerRoom = playerRoom;
        manager.coinTransactionFailure = null;
        manager.coinFlushPending = false;
        restoreSocketMethods();
        manager.coinTransactionDepth = 0;
        manager.coinTransactionFailure = null;
        const socket = args[0] && typeof args[0].emit === 'function' ? args[0] : null;
        if (socket && error && typeof manager.error === 'function') {
          return manager.error(socket, error.message || 'Chưa thể lưu an toàn trạng thái bàn và coin.');
        }
        if (['cleanup', 'handleDisconnect'].includes(method)) {
          console.error(`Không thể commit ${gameId} ${method}:`, error?.message || error);
          return undefined;
        }
        throw error;
      } finally {
        manager.coinTransactionDepth = 0;
        restoreSocketMethods();
      }

      for (const effect of effects) effect();
      for (const code of committedCodes) notifyRoomCommitted(manager, code);
      if (manager.coinFlushPending) originalFlush();
      manager.coinFlushPending = false;
      return result;
    };
  }
}

module.exports = { installCoinRoomTransactions };
