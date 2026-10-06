'use strict';
const fs = require('node:fs');
const { runStorageOperation } = require('./storageDiagnostics');
const { DEFAULT_RECONNECT_GRACE_MS, restoreDisconnectedSeats } = require('./reconnectGrace');

// Record results before calling this: departures must not remove participants
// from the completed match or release their seat while a settlement is pending.
function leaveCompletedSeats(manager, room, gameId) {
  const store = manager.profileStore || manager.profileService?.profiles;
  for (const player of [...room.players]) {
    if (!player.leaveAfterHand) continue;
    const socket = manager.io.sockets.sockets.get(player.socketId);
    if (socket && player.connected) socket.emit('game_state', manager.buildStateFor(room, player.id));
    room.players = room.players.filter(item => item !== player);
    if (player.socketId) manager.playerRoom.delete(player.socketId);
    store?.markMemberLeft({ gameId, roomCode: room.code, playerId: player.id });
    if (socket) { socket.leave(room.code); socket.emit('room_left'); }
  }
  manager.ensureHost(room);
  if (!room.players.length) {
    manager.rooms.delete(room.code);
    store?.closeGameRoom(gameId, room.code);
  }
  manager.saveSoon();
}

function loadFixedRooms(manager, gameId, normalize) {
  const candidates = new Map();
  let legacyReadFailed = false;
  if (manager.storageFile && fs.existsSync(manager.storageFile)) {
    try {
      const saved = runStorageOperation(manager.storageDiagnostics, `export:${gameId}`, 'read', 'legacy-json-read', () => {
        const data = JSON.parse(fs.readFileSync(manager.storageFile, 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.rooms)) throw new Error(`Định dạng lưu ${gameId} không hợp lệ`);
        return data;
      }, { recoveryVerified: true, failureCode: 'LEGACY_ROOM_READ_FAILED' });
      for (const room of saved.rooms) if (room?.code) candidates.set(room.code, room);
    } catch (error) {
      // JSON is an import/export compatibility copy. A committed SQLite
      // snapshot below remains authoritative even when this file is damaged.
      console.error(`Không đọc được bản JSON phòng ${gameId}:`, error.message);
      legacyReadFailed = true;
    }
  }
  try {
    const snapshots = manager.profileStore?.gameSnapshots?.(gameId) || [];
    if (legacyReadFailed && !snapshots.length) manager.storageError = true;
    for (const saved of snapshots) {
      if (saved.closedAt || !saved.stateJson) { candidates.delete(saved.roomCode); continue; }
      const room = JSON.parse(saved.stateJson);
      if (!room?.code || room.code !== saved.roomCode) throw new Error(`Snapshot ${gameId}/${saved.roomCode} không hợp lệ`);
      candidates.set(saved.roomCode, room);
    }
  } catch (error) {
    console.error(`Không đọc được snapshot SQLite ${gameId}:`, error.message);
    manager.storageError = true;
    return;
  }
  if (!candidates.size) return;
  try {
    let expired = false;
    const changedSnapshots = [];
    for (const room of candidates.values()) {
      if (Date.now() - room.updatedAt > 12 * 3600000 && room.reconnectPolicyVersion !== 2) {
        manager.profileStore.expireFixedRoom({ gameId, roomCode: room.code, matchId: room.matchId });
        expired = true; continue;
      }
      const changedDeadline = restoreDisconnectedSeats(room.players, Date.now(), manager.graceMs ?? DEFAULT_RECONNECT_GRACE_MS);
      normalize(room); manager.rooms.set(room.code, room);
      if (changedDeadline) changedSnapshots.push(room);
    }
    if (changedSnapshots.length && manager.profileStore?.saveGameSnapshot) {
      manager.profileStore.transaction(() => { for (const room of changedSnapshots) manager.profileStore.saveGameSnapshot({ gameId, room }); });
    }
    if (expired || changedSnapshots.length) manager.flush();
  } catch (error) { console.error(`Không đọc được dữ liệu phòng ${gameId}:`, error.message); manager.storageError = true; }
}

module.exports = { leaveCompletedSeats, loadFixedRooms };
