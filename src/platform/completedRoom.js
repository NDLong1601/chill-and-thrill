'use strict';
const fs = require('node:fs');

// Record results before calling this: departures must not remove participants
// from the completed match or release their seat while a settlement is pending.
function leaveCompletedSeats(manager, room, gameId) {
  for (const player of [...room.players]) {
    if (!player.leaveAfterHand) continue;
    const socket = manager.io.sockets.sockets.get(player.socketId);
    if (socket && player.connected) socket.emit('game_state', manager.buildStateFor(room, player.id));
    room.players = room.players.filter(item => item !== player);
    if (player.socketId) manager.playerRoom.delete(player.socketId);
    manager.profileStore?.markMemberLeft({ gameId, roomCode: room.code, playerId: player.id });
    if (socket) { socket.leave(room.code); socket.emit('room_left'); }
  }
  manager.ensureHost(room);
  if (!room.players.length) {
    manager.rooms.delete(room.code);
    manager.profileStore?.closeGameRoom(gameId, room.code);
  }
  manager.saveSoon();
}

function loadFixedRooms(manager, gameId, normalize) {
  if (!manager.storageFile || !fs.existsSync(manager.storageFile)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(manager.storageFile, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.rooms)) throw new Error(`Định dạng lưu ${gameId} không hợp lệ`);
    let expired = false;
    for (const room of saved.rooms) {
      if (Date.now() - room.updatedAt > 12 * 3600000) {
        manager.profileStore.expireFixedRoom({ gameId, roomCode: room.code, matchId: room.matchId });
        expired = true; continue;
      }
      room.players.forEach(player => { player.connected = false; player.socketId = null; player.disconnectedAt = Date.now(); });
      normalize(room); manager.rooms.set(room.code, room);
    }
    if (expired) manager.flush();
  } catch (error) { console.error(`Không đọc được dữ liệu phòng ${gameId}:`, error.message); manager.storageError = true; }
}

module.exports = { leaveCompletedSeats, loadFixedRooms };
