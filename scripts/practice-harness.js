'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { PracticeService } = require('../src/platform/practiceService');

const projectRoot = path.resolve(__dirname, '..');
const assets = new Map([
  ['/practice', ['public/practice.html', 'text/html; charset=utf-8']],
  ['/practice.html', ['public/practice.html', 'text/html; charset=utf-8']],
  ['/css/practice.css', ['public/css/practice.css', 'text/css; charset=utf-8']],
  ['/css/style.css', ['public/css/style.css', 'text/css; charset=utf-8']],
  ['/js/practice.js', ['public/js/practice.js', 'text/javascript; charset=utf-8']],
  ['/js/tien-len-rules.js', ['public/js/tien-len-rules.js', 'text/javascript; charset=utf-8']],
]);
const MAX_BODY_BYTES = 16 * 1024;

function sendJson(response, result) {
  const status = result.status || (result.ok ? 200 : result.error?.code === 'UNAUTHORIZED' ? 403 : result.error?.code === 'SESSION_EXPIRED' ? 410 : result.error?.code === 'SESSION_NOT_FOUND' ? 404 : 400);
  const body = { ...result };
  delete body.status;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Dữ liệu yêu cầu quá lớn.'), { status: 413 }));
        request.destroy();
        return;
      }
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); }
      catch { reject(Object.assign(new Error('Dữ liệu JSON không hợp lệ.'), { status: 400 })); }
    });
    request.on('error', reject);
  });
}

function requestCapability(request) {
  const header = request.headers.authorization || '';
  const match = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(header);
  return match?.[1] || '';
}

function createPracticeHarness(options = {}) {
  const service = options.service || new PracticeService(options.practiceOptions);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const staticAsset = assets.get(pathname);
    if (request.method === 'GET' && staticAsset) {
      const [relativePath, contentType] = staticAsset;
      const absolutePath = path.resolve(projectRoot, relativePath);
      if (!absolutePath.startsWith(projectRoot + path.sep)) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:" });
      response.end(fs.readFileSync(absolutePath));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/practice/sessions') {
      try { sendJson(response, await service.createSession(await readJson(request))); }
      catch (error) { sendJson(response, { ok: false, error: { code: 'REQUEST_FAILED', message: error.status === 413 ? error.message : 'Không thể tạo phiên luyện tập.' }, status: error.status || 500 }); }
      return;
    }
    const match = /^\/api\/practice\/sessions\/([0-9a-f-]{36})(?:\/(actions))?$/.exec(pathname);
    if (match) {
      const id = match[1];
      const capability = requestCapability(request);
      if (request.method === 'GET' && !match[2]) { sendJson(response, await service.getState(id, capability)); return; }
      if (request.method === 'POST' && match[2]) {
        try { sendJson(response, await service.act(id, capability, await readJson(request))); }
        catch { sendJson(response, { ok: false, error: { code: 'REQUEST_FAILED', message: 'Không thể áp dụng thao tác luyện tập.' }, status: 500 }); }
        return;
      }
      if (request.method === 'DELETE' && !match[2]) { sendJson(response, await service.deleteSession(id, capability)); return; }
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('Not found');
  });
  return {
    server,
    service,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address()); });
      });
    },
    close() {
      service.close();
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

if (require.main === module) {
  const port = Number(process.env.PRACTICE_PORT) || 4178;
  const harness = createPracticeHarness();
  harness.listen(port, '127.0.0.1').then(address => {
    process.stdout.write(`Practice sandbox ready at http://127.0.0.1:${address.port}/practice\n`);
  }).catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
  const stop = () => harness.close().finally(() => process.exit());
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

module.exports = { createPracticeHarness };
