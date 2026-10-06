'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { ServerSupervisor } = require('../src/platform/launcherLifecycle');
const { createLauncherControlServer, writeFailureReadyFile } = require('../src/platform/launcherControlServer');

const projectRoot = path.resolve(__dirname, '..');
const controlPort = 41739;

function parseArgs(argv) {
  if (argv.length === 0) return {};
  if (argv.length !== 2 || argv[0] !== '--ready-file') throw new Error('Chỉ hỗ trợ tùy chọn --ready-file.');
  const readyFile = path.resolve(argv[1]);
  const tempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(tempRoot, readyFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Tệp báo sẵn sàng phải ở thư mục tạm của Windows.');
  }
  return { readyFile };
}

function errorMessage(error) {
  if (error?.code === 'EADDRINUSE') return `Cổng điều khiển ${controlPort} đã được dùng. Nếu Chill & Thrill Launcher đã mở, hãy chuyển tới cửa sổ đó.`;
  return `Không mở được bảng launcher: ${error?.message || 'lỗi hệ thống'}`;
}

async function existingLauncherIsListening() {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port: controlPort, path: '/healthz', headers: { Host: `127.0.0.1:${controlPort}` }, timeout: 1000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(response.statusCode === 200 && parsed.app === 'chill-thrill-launcher' && parsed.version === 1);
        } catch { resolve(false); }
      });
    });
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

async function main() {
  const { readyFile } = parseArgs(process.argv.slice(2));
  const supervisor = new ServerSupervisor({ projectRoot });
  const control = createLauncherControlServer({ projectRoot, supervisor, readyFile });
  control.server.on('launcher-ready-error', error => {
    void writeFailureReadyFile(readyFile, `Không thể tạo tệp mở launcher: ${error.message}`);
  });
  control.server.once('error', async error => {
    if (error.code === 'EADDRINUSE' && await existingLauncherIsListening()) {
      const payload = { url: `http://127.0.0.1:${controlPort}/`, existing: true };
      if (readyFile) {
        try { fs.writeFileSync(readyFile, JSON.stringify(payload), { flag: 'wx', mode: 0o600 }); } catch { /* the first launch already owns its ready file */ }
      }
      process.exitCode = 0;
      return;
    }
    const message = errorMessage(error);
    await writeFailureReadyFile(readyFile, message);
    if (!readyFile) process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
  control.listen(controlPort, '127.0.0.1');
}

if (require.main === module) {
  try { void main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { parseArgs, existingLauncherIsListening };
