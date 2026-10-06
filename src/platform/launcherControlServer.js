'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const QRCode = require('qrcode');
const { defaultSourcePaths, createBackup, restoreBackup } = require('./backupRestore');

const SESSION_COOKIE = 'ct_launcher_session';
const BODY_LIMIT = 8192;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1' || address === '::1';
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extraHeaders,
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) {
        reject(Object.assign(new Error('Yêu cầu vượt giới hạn kích thước.'), { code: 'REQUEST_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Dữ liệu JSON không hợp lệ.');
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('Dữ liệu JSON không hợp lệ.'), { code: 'REQUEST_INVALID' }));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(header = '') {
  return new Map(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const split = part.indexOf('=');
    return split < 0 ? [part, ''] : [part.slice(0, split), part.slice(split + 1)];
  }));
}

function timingSafeEqualText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function errorStatus(error) {
  if (['START_IN_PROGRESS', 'SERVER_PROCESS_ACTIVE', 'STOP_IN_PROGRESS', 'SERVER_STATE_UNVERIFIED', 'STOP_NOT_CONFIRMED', 'STOP_TIMEOUT'].includes(error?.code)) return 409;
  if (['REQUEST_INVALID', 'REQUEST_TOO_LARGE', 'BACKUP_REQUIRED', 'OUTPUT_REQUIRED', 'SERVER_STOP_CONFIRMATION_REQUIRED'].includes(error?.code)) return 400;
  return 500;
}

function sourcePathsFor(projectRoot) {
  return defaultSourcePaths({ projectRoot });
}

function backupOutputDirectory(projectRoot, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return path.join(projectRoot, 'backups', `chill-and-thrill-${stamp}-${crypto.randomBytes(3).toString('hex')}`);
}

function openDirectory(directory) {
  if (process.platform !== 'win32') throw Object.assign(new Error('Mở thư mục tự động chỉ khả dụng trên Windows.'), { code: 'OPEN_FOLDER_UNAVAILABLE' });
  const child = spawn('explorer.exe', [directory], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

function createLauncherControlServer(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, '../..'));
  const supervisor = options.supervisor;
  if (!supervisor || typeof supervisor.getStatus !== 'function') throw new TypeError('Cần supervisor của launcher.');
  const createBackupOperation = options.createBackup || createBackup;
  const restoreBackupOperation = options.restoreBackup || restoreBackup;
  const sourcePathResolver = options.sourcePaths || sourcePathsFor;
  const openFolder = options.openFolder || openDirectory;
  const readyFile = options.readyFile || null;
  const sessions = new Map();
  let initialCapability = options.capability || crypto.randomBytes(32).toString('base64url');
  let maintenance = null;
  let boundPort = null;

  const server = http.createServer(async (req, res) => {
    const remote = req.socket.remoteAddress;
    if (!isLoopback(remote)) return sendJson(res, 403, { ok: false, error: 'Bảng điều khiển chỉ chấp nhận kết nối từ máy chủ này.' });
    const expectedHost = boundPort === null ? null : `127.0.0.1:${boundPort}`;
    if (!expectedHost || req.headers.host !== expectedHost) return sendJson(res, 403, { ok: false, error: 'Địa chỉ truy cập không hợp lệ.' });

    const requestUrl = new URL(req.url, `http://${expectedHost}`);
    if (requestUrl.pathname === '/healthz' && req.method === 'GET') {
      return sendJson(res, 200, { app: 'chill-thrill-launcher', version: 1 });
    }

    const staticFile = req.method === 'GET' && STATIC_FILES.get(requestUrl.pathname);
    if (staticFile) {
      const [filename, contentType] = staticFile;
      const filePath = path.join(options.uiDirectory || path.resolve(projectRoot, 'launcher'), filename);
      try {
        const body = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        return res.end(body);
      } catch {
        return sendJson(res, 500, { ok: false, error: 'Không đọc được tệp giao diện launcher.' });
      }
    }

    const origin = `http://127.0.0.1:${boundPort}`;
    if (req.method === 'POST' && requestUrl.pathname === '/api/session') {
      if (req.headers.origin !== origin) return sendJson(res, 403, { ok: false, error: 'Phiên chủ máy phải được mở từ launcher trên máy này.' });
      let body;
      try { body = await readJson(req); } catch (error) { return sendJson(res, errorStatus(error), { ok: false, error: error.message }); }
      if (!initialCapability || !timingSafeEqualText(body.capability, initialCapability)) return sendJson(res, 401, { ok: false, error: 'Mã mở phiên không còn hợp lệ. Hãy chạy lại launcher.' });
      initialCapability = null;
      const sessionId = crypto.randomBytes(32).toString('base64url');
      const csrf = crypto.randomBytes(24).toString('base64url');
      sessions.set(sessionId, { csrf, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
      return sendJson(res, 200, { ok: true, csrf, expiresAt: sessions.get(sessionId).expiresAt }, {
        'Set-Cookie': `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`,
      });
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/session/refresh') {
      if (req.headers.origin !== origin) return sendJson(res, 403, { ok: false, error: 'Nguồn yêu cầu không hợp lệ.' });
      const sessionId = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
      const session = sessions.get(sessionId);
      if (!session || session.expiresAt < Date.now()) {
        if (sessionId) sessions.delete(sessionId);
        return sendJson(res, 401, { ok: false, error: 'Phiên chủ máy đã hết hạn. Hãy chạy lại launcher.' });
      }
      session.csrf = crypto.randomBytes(24).toString('base64url');
      return sendJson(res, 200, { ok: true, csrf: session.csrf, expiresAt: session.expiresAt });
    }

    const sessionId = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    const session = sessions.get(sessionId);
    if (!session || session.expiresAt < Date.now()) {
      if (sessionId) sessions.delete(sessionId);
      return sendJson(res, 401, { ok: false, error: 'Cần mở phiên chủ máy từ cửa sổ launcher.' });
    }
    if (requestUrl.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers.origin !== origin) return sendJson(res, 403, { ok: false, error: 'Nguồn yêu cầu không hợp lệ.' });
      if (req.method !== 'GET' && !timingSafeEqualText(req.headers['x-ct-csrf'], session.csrf)) return sendJson(res, 403, { ok: false, error: 'Phiên bảo mật đã đổi. Tải lại bảng điều khiển.' });
      session.expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    }

    try {
      if (req.method === 'GET' && requestUrl.pathname === '/api/status') {
        const sources = sourcePathResolver(projectRoot);
        const status = supervisor.getStatus();
        const urls = [];
        for (const address of status.urls || []) {
          let qrDataUrl = null;
          try { qrDataUrl = await QRCode.toDataURL(address.url, { margin: 1, width: 180 }); } catch { /* address remains usable as text */ }
          urls.push({ ...address, qrDataUrl });
        }
        return sendJson(res, 200, {
          ok: true,
          server: { ...status, urls },
          maintenance,
          paths: {
            projectRoot,
            databaseFile: sources.databaseFile,
            roomFile: sources.storageFile,
            managerFiles: sources.managerFiles,
            backupDirectory: path.join(projectRoot, 'backups'),
          },
        });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/api/server/start') {
        const result = await supervisor.start();
        return sendJson(res, 200, { ok: true, result, server: supervisor.getStatus() });
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/server/stop') {
        const result = await supervisor.stop();
        return sendJson(res, 200, { ok: true, result, server: supervisor.getStatus() });
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/backup') {
        if (maintenance) return sendJson(res, 409, { ok: false, error: 'Một thao tác dữ liệu đang chạy.' });
        maintenance = { operation: 'backup', startedAt: new Date().toISOString() };
        try {
          await supervisor.stop();
          const status = supervisor.getStatus();
          if (status.state !== 'stopped' || status.managedProcess) throw Object.assign(new Error('Chưa xác nhận tiến trình máy chủ đã thoát. Backup bị từ chối.'), { code: 'STOP_NOT_CONFIRMED' });
          const outputDirectory = backupOutputDirectory(projectRoot);
          fs.mkdirSync(path.dirname(outputDirectory), { recursive: true });
          const result = createBackupOperation({ serverStopped: true, projectRoot, outputDirectory });
          return sendJson(res, 200, { ok: true, directory: result.directory, manifest: result.manifest, validation: result.validation });
        } finally {
          maintenance = null;
        }
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/restore') {
        if (maintenance) return sendJson(res, 409, { ok: false, error: 'Một thao tác dữ liệu đang chạy.' });
        const body = await readJson(req);
        if (typeof body.backupDirectory !== 'string' || !body.backupDirectory.trim() || body.backupDirectory.length > 1024) {
          return sendJson(res, 400, { ok: false, error: 'Nhập đường dẫn thư mục backup đã xác minh.' });
        }
        maintenance = { operation: 'restore', startedAt: new Date().toISOString() };
        try {
          await supervisor.stop();
          const status = supervisor.getStatus();
          if (status.state !== 'stopped' || status.managedProcess) throw Object.assign(new Error('Chưa xác nhận tiến trình máy chủ đã thoát. Restore bị từ chối.'), { code: 'STOP_NOT_CONFIRMED' });
          const result = restoreBackupOperation({ backupDirectory: path.resolve(body.backupDirectory), projectRoot });
          return sendJson(res, 200, { ok: true, directory: result.directory, databaseFile: result.databaseFile, storageFile: result.storageFile,
            validation: result.validation, note: 'Dữ liệu đã khôi phục vào thư mục mới. Máy chủ hiện tại không bị thay thế hoặc tự cấu hình lại.' });
        } finally {
          maintenance = null;
        }
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/open-folder') {
        const body = await readJson(req);
        const sources = sourcePathResolver(projectRoot);
        const allowed = {
          profile: path.dirname(sources.databaseFile),
          rooms: path.dirname(sources.storageFile),
          backups: path.join(projectRoot, 'backups'),
        };
        const directory = allowed[body.key];
        if (!directory) return sendJson(res, 400, { ok: false, error: 'Thư mục không được hỗ trợ.' });
        if (body.key === 'backups') fs.mkdirSync(directory, { recursive: true });
        if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return sendJson(res, 404, { ok: false, error: `Chưa có thư mục: ${directory}` });
        openFolder(directory);
        return sendJson(res, 200, { ok: true, directory });
      }
      return sendJson(res, 404, { ok: false, error: 'Không tìm thấy chức năng.' });
    } catch (error) {
      return sendJson(res, errorStatus(error), { ok: false, code: error.code || 'LAUNCHER_ACTION_FAILED', error: error.message || 'Thao tác launcher thất bại.' });
    }
  });

  server.on('listening', () => {
    boundPort = server.address()?.port;
    if (readyFile) {
      const capability = initialCapability;
      const payload = { launchUrl: `http://127.0.0.1:${boundPort}/#cap=${encodeURIComponent(capability)}`, url: `http://127.0.0.1:${boundPort}/` };
      try { fs.writeFileSync(readyFile, JSON.stringify(payload), { flag: 'wx', mode: 0o600 }); }
      catch (error) { server.emit('launcher-ready-error', error); }
    }
    const expiryTimer = setInterval(() => {
      for (const [id, session] of sessions) if (session.expiresAt < Date.now()) sessions.delete(id);
    }, 60 * 60 * 1000);
    expiryTimer.unref();
    server.once('close', () => clearInterval(expiryTimer));
  });

  return { server, sessions, get capability() { return initialCapability; }, listen: (...args) => server.listen(...args) };
}

async function writeFailureReadyFile(readyFile, message) {
  if (!readyFile) return;
  try { fs.writeFileSync(readyFile, JSON.stringify({ error: message }), { flag: 'wx', mode: 0o600 }); } catch { /* caller reports to stderr */ }
}

module.exports = { createLauncherControlServer, backupOutputDirectory, writeFailureReadyFile, isLoopback };
