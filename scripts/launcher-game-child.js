'use strict';

// Child owned by the C06 launcher. It never discovers or signals unrelated
// processes; the parent requests a graceful close over this IPC channel.
const path = require('node:path');
const { createGameServer, networkUrls } = require('../src/httpServer');

const projectRoot = path.resolve(__dirname, '..');
const dataDirectory = path.join(projectRoot, 'data');
const storageFile = process.env.GANG_DATA_FILE || path.join(dataDirectory, 'rooms.json');
const databaseFile = process.env.GANG_DATABASE_FILE || process.env.GANG_DB_FILE || path.join(dataDirectory, 'chill-and-thrill.sqlite');
const game = createGameServer({ storageFile, databaseFile });
const requestedPort = process.env.PORT === undefined || process.env.PORT === '' ? 3000 : Number(process.env.PORT);
let started = false;
let closing = null;
let stopRequestId = null;

function notify(message) {
  if (typeof process.send !== 'function' || !process.connected) return Promise.resolve();
  return new Promise(resolve => process.send(message, () => resolve()));
}

function closeGame() {
  if (!closing) closing = Promise.resolve().then(() => game.close());
  return closing;
}

async function finishStop(requestId) {
  try {
    await closeGame();
    await notify({ type: 'stopped', requestId });
    if (process.connected) process.disconnect();
  } catch (error) {
    await notify({ type: 'stopped', requestId, error: { code: error.code || 'SERVER_CLOSE_FAILED', message: error.message || 'Không đóng được máy chủ sạch.' } });
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}

process.on('message', message => {
  if (!message || message.type !== 'stop' || typeof message.requestId !== 'string') return;
  if (!stopRequestId) stopRequestId = message.requestId;
  if (closing) {
    if (stopRequestId !== message.requestId) {
      void closing.then(
        () => notify({ type: 'stopped', requestId: message.requestId }),
        error => notify({ type: 'stopped', requestId: message.requestId, error: { code: error.code || 'SERVER_CLOSE_FAILED', message: error.message || 'Không đóng được máy chủ sạch.' } }),
      );
    }
    return;
  }
  stopRequestId = message.requestId;
  void finishStop(stopRequestId);
});

process.on('disconnect', () => {
  // If the hidden controller exits unexpectedly, disconnect closes this
  // owned child gracefully. There is deliberately no process.kill fallback.
  if (!closing) void closeGame().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
});

game.server.once('error', async error => {
  if (!started) {
    try { await closeGame(); } catch { /* startup error is reported below */ }
    await notify({ type: 'startup-error', error: { code: error.code || 'SERVER_START_FAILED', message: error.code === 'EADDRINUSE'
      ? `Cổng ${requestedPort} đang được dùng. Hãy dừng máy chủ đang chạy bằng cách đã khởi động nó rồi thử lại; launcher không đóng tiến trình khác.`
      : `Không thể mở cổng ${requestedPort}: ${error.message}` } });
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  } else {
    await notify({ type: 'runtime-error', error: { code: error.code || 'SERVER_RUNTIME_FAILED', message: error.message || 'Máy chủ báo lỗi mạng.' } });
  }
});

if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  void closeGame().finally(async () => {
    await notify({ type: 'startup-error', error: { code: 'PORT_INVALID', message: 'Cấu hình PORT không hợp lệ.' } });
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
} else {
  game.server.listen(requestedPort, '0.0.0.0', () => {
    started = true;
    const actualPort = game.server.address()?.port;
    void notify({ type: 'ready', port: actualPort, urls: networkUrls(actualPort) });
  });
}
