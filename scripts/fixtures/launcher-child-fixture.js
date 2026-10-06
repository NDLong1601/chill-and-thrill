'use strict';

// Child fixture for launcher lifecycle tests only; never loads server.js or
// the production game server.
const net = require('node:net');

let server = null;
let stopCount = 0;
let closing = false;

function send(message) {
  return new Promise(resolve => {
    if (typeof process.send !== 'function' || !process.connected) return resolve();
    process.send(message, () => resolve());
  });
}

function exitAfterDelay() {
  const delay = Number(process.env.LAUNCHER_FIXTURE_EXIT_DELAY_MS) || 0;
  setTimeout(() => { if (process.connected) process.disconnect(); }, delay);
}

async function handleStop(requestId) {
  stopCount++;
  if (process.env.LAUNCHER_FIXTURE_IGNORE_FIRST_STOP === '1' && stopCount === 1) return;
  if (closing) return;
  closing = true;
  const delay = Number(process.env.LAUNCHER_FIXTURE_STOP_DELAY_MS) || 0;
  setTimeout(async () => {
    if (server) await new Promise(resolve => server.close(() => resolve()));
    await send({ type: 'stopped', requestId });
    exitAfterDelay();
  }, delay);
}

process.on('message', message => {
  if (message?.type === 'stop' && typeof message.requestId === 'string') void handleStop(message.requestId);
});
process.on('disconnect', () => {
  if (server && !closing) server.close(() => process.exit(0));
});

const readyDelay = Number(process.env.LAUNCHER_FIXTURE_READY_DELAY_MS) || 0;
setTimeout(() => {
  const port = process.env.LAUNCHER_FIXTURE_PORT;
  if (!port) {
    void send({ type: 'ready', port: 32123, urls: [{ name: 'fixture', url: 'http://127.0.0.1:32123', local: true }] });
    return;
  }
  server = net.createServer();
  server.once('error', error => {
    void send({ type: 'startup-error', error: { code: error.code || 'FIXTURE_START_FAILED', message: `fixture: ${error.message}` } }).then(() => {
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
  });
  server.listen(Number(port), '127.0.0.1', () => {
    void send({ type: 'ready', port: Number(port), urls: [{ name: 'fixture', url: `http://127.0.0.1:${port}`, local: true }] });
  });
}, readyDelay);
