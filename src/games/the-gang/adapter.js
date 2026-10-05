'use strict';

// Transitional adapter: the existing The Gang engine remains the source of truth
// for its rules, while platform transport talks to this game-specific boundary.
class TheGangAdapter {
  constructor(gameManager) {
    this.gameManager = gameManager;
    this.gameId = 'the-gang';
  }

  createRoom(socket, request = {}) {
    return this.gameManager.createRoom(socket, request.playerName, request.difficulty, request.avatar, { ...(request.config || {}), profile: request.profile });
  }

  joinRoom(socket, request = {}) {
    return this.gameManager.joinRoom(socket, request.roomCode, request.playerName, request.avatar, { password: request.password, profile: request.profile });
  }

  resumeRoom(socket, request = {}) {
    return this.gameManager.resumeRoom(socket, request.roomCode, request.sessionToken);
  }

  publicRoom(room) {
    return this.gameManager.publicRoom(room);
  }
}

module.exports = { TheGangAdapter };
