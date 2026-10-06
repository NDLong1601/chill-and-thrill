'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { ServerSupervisor } = require('../src/platform/launcherLifecycle');
const { createLauncherControlServer } = require('../src/platform/launcherControlServer');
const { ProfileStore } = require('../src/platform/profileStore');
const { defaultSourcePaths, createBackup, verifyBackup, restoreBackup, MANAGER_FILES } = require('../src/platform/backupRestore');

const childFixture = path.resolve(__dirname, '../scripts/fixtures/launcher-child-fixture.js');

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail('Timed out waiting for fixture state.');
}

function makeSupervisor(t, env = {}, extras = {}) {
  const supervisor = new ServerSupervisor({
    childScript: childFixture,
    projectRoot: path.resolve(__dirname, '..'),
    env,
    startTimeoutMs: extras.startTimeoutMs ?? 1500,
    stopTimeoutMs: extras.stopTimeoutMs ?? 1500,
  });
  t.after(async () => {
    if (!supervisor.getStatus().managedProcess) return;
    try {
      if (supervisor.getStatus().state === 'starting') await delay(60);
      await supervisor.stop();
    } catch {
      try { await supervisor.stop(); } catch { /* this fixture has no force-kill cleanup path */ }
    }
  });
  return supervisor;
}

function makeDataFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-launcher-c06-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  const dataDirectory = path.join(projectRoot, 'data');
  fs.mkdirSync(dataDirectory, { recursive: true });
  const databaseFile = path.join(dataDirectory, 'chill-and-thrill.sqlite');
  const storageFile = path.join(dataDirectory, 'rooms.json');
  const paths = defaultSourcePaths({ projectRoot, dataDirectory, databaseFile, storageFile });
  const store = new ProfileStore({ databaseFile });
  store.close();
  fs.writeFileSync(storageFile, JSON.stringify({ version: 2, rooms: [] }, null, 2));
  for (const spec of MANAGER_FILES) {
    const file = paths.managerFiles[spec.sourceKey];
    fs.writeFileSync(file, JSON.stringify({ version: spec.versions[0], rooms: [] }, null, 2));
  }
  const sourceFiles = [databaseFile, ...Object.values(paths.managerFiles)];
  return { root, projectRoot, dataDirectory, databaseFile, storageFile, paths, sourceFiles };
}

function makeControl(t, { projectRoot, supervisor, sourcePaths, createBackupOperation, restoreBackupOperation, openFolder } = {}) {
  const capability = crypto.randomBytes(32).toString('base64url');
  const control = createLauncherControlServer({
    projectRoot,
    supervisor,
    capability,
    sourcePaths,
    createBackup: createBackupOperation,
    restoreBackup: restoreBackupOperation,
    openFolder,
    uiDirectory: path.resolve(__dirname, '../launcher'),
  });
  const port = 41739;
  control.server.address = () => ({ port });
  control.server.emit('listening');
  t.after(() => control.server.emit('close'));
  return Promise.resolve({ control, capability, port, origin: `http://127.0.0.1:${port}` });
}

async function invokeControl(controlInfo, method, route, options = {}) {
  const headers = {
    host: `127.0.0.1:${controlInfo.port}`,
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(options.csrf ? { 'x-ct-csrf': options.csrf } : {}),
    ...(options.contentType ? { 'content-type': options.contentType } : {}),
    ...(options.headers || {}),
  };
  const body = options.body === undefined ? '' : JSON.stringify(options.body);
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = route;
  req.headers = headers;
  req.socket = { remoteAddress: options.remoteAddress || '127.0.0.1' };
  const res = {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(status, responseHeaders) { this.statusCode = status; this.headers = responseHeaders; return this; },
    end(content = '') { this.body = Buffer.isBuffer(content) ? content.toString('utf8') : String(content); this.ended = true; },
  };
  const handler = controlInfo.control.server.listeners('request')[0];
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: res.body, json: () => JSON.parse(res.body || '{}') };
}

async function ownerSession(controlInfo) {
  const { capability, port, origin } = controlInfo;
  const login = await invokeControl(controlInfo, 'POST', '/api/session', { origin, contentType: 'application/json', body: { capability } });
  assert.equal(login.status, 200);
  const loginBody = login.json();
  const cookie = login.headers['Set-Cookie']?.split(';', 1)[0];
  assert.match(cookie || '', /^ct_launcher_session=/);
  return { cookie, csrf: loginBody.csrf };
}

async function postAsOwner(controlInfo, owner, route, body = {}) {
  return invokeControl(controlInfo, 'POST', route, {
    origin: controlInfo.origin, contentType: 'application/json', cookie: owner.cookie, csrf: owner.csrf, body,
  });
}

test('launcher serializes starts and waits for stop acknowledgement plus child exit', async t => {
  const supervisor = makeSupervisor(t, { LAUNCHER_FIXTURE_READY_DELAY_MS: '100', LAUNCHER_FIXTURE_EXIT_DELAY_MS: '140' });
  const starting = supervisor.start();
  await assert.rejects(supervisor.start(), error => error.code === 'START_IN_PROGRESS');
  const first = await starting;
  assert.equal(first.state, 'running');
  const duplicate = await supervisor.start();
  assert.equal(duplicate.alreadyRunning, true);

  const startedAt = Date.now();
  const stopped = await supervisor.stop();
  assert.ok(Date.now() - startedAt >= 120, 'stop waited for the fixture process exit after its IPC acknowledgement');
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.managedProcess, false);
});

test('launcher reports a port conflict and never closes the unrelated listener', async t => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => blocker.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(() => resolve())));
  const port = blocker.address().port;
  const supervisor = makeSupervisor(t, { LAUNCHER_FIXTURE_PORT: String(port) });
  await assert.rejects(supervisor.start(), error => error.code === 'EADDRINUSE');
  await waitFor(() => !supervisor.getStatus().managedProcess);
  assert.equal(supervisor.getStatus().state, 'failed');
  assert.equal(blocker.listening, true);
  await assert.rejects(supervisor.stop(), error => error.code === 'STOP_NOT_CONFIRMED');
});

test('stop timeout is visible, leaves the child alive, and a retry can complete', async t => {
  const supervisor = makeSupervisor(t, { LAUNCHER_FIXTURE_IGNORE_FIRST_STOP: '1' }, { stopTimeoutMs: 100 });
  await supervisor.start();
  await assert.rejects(supervisor.stop(), error => error.code === 'STOP_TIMEOUT');
  assert.equal(supervisor.getStatus().state, 'stop-failed');
  assert.equal(supervisor.getStatus().managedProcess, true);
  // The first short deadline is deliberate. Give the IPC retry a normal
  // window so host load cannot make child startup/ack scheduling flaky.
  supervisor.stopTimeoutMs = 2000;
  const retry = await supervisor.stop();
  assert.equal(retry.state, 'stopped');
  assert.equal(retry.managedProcess, false);
  assert.equal(retry.exitInfo.code, 0, 'retry completed only after a clean child exit');
});

test('owner session is one-time, loopback-only, and requires CSRF on control actions', async t => {
  let stopCalls = 0;
  const supervisor = {
    getStatus: () => ({ state: 'stopped', managedProcess: false, urls: [
      { name: 'Ethernet', url: 'http://192.168.1.40:3000', local: false },
    ], lastError: null }),
    start: async () => ({ state: 'running' }),
    stop: async () => { stopCalls++; return { state: 'stopped' }; },
  };
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-launcher-auth-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const dataDir = path.join(projectRoot, 'data');
  const paths = defaultSourcePaths({ projectRoot, dataDirectory: dataDir });
  const info = await makeControl(t, {
    projectRoot,
    supervisor,
    sourcePaths: () => paths,
    openFolder: () => {},
  });

  const unauthenticated = await invokeControl(info, 'GET', '/api/status');
  assert.equal(unauthenticated.status, 401);
  const badOrigin = await invokeControl(info, 'POST', '/api/session', { origin: 'http://example.com', contentType: 'application/json', body: { capability: info.capability } });
  assert.equal(badOrigin.status, 403);
  const owner = await ownerSession(info);
  const status = await invokeControl(info, 'GET', '/api/status', { cookie: owner.cookie });
  assert.equal(status.status, 200);
  assert.match(status.json().server.urls[0].qrDataUrl, /^data:image\/png;base64,/);
  const page = await invokeControl(info, 'GET', '/');
  assert.equal(page.status, 200);
  assert.equal(page.body.includes(info.capability), false);
  const replay = await invokeControl(info, 'POST', '/api/session', { origin: info.origin, contentType: 'application/json', body: { capability: info.capability } });
  assert.equal(replay.status, 401);
  const missingCsrf = await invokeControl(info, 'POST', '/api/server/stop', { origin: info.origin, contentType: 'application/json', cookie: owner.cookie, body: {} });
  assert.equal(missingCsrf.status, 403);
  assert.equal(stopCalls, 0);
  const wrongHost = await invokeControl(info, 'GET', '/api/status', { cookie: owner.cookie, headers: { host: `localhost:${info.port}` } });
  assert.equal(wrongHost.status, 403);
  const nonLoopback = await invokeControl(info, 'GET', '/api/status', { cookie: owner.cookie, remoteAddress: '192.168.1.25' });
  assert.equal(nonLoopback.status, 403);
});

test('backup waits for a managed child exit, verifies checksums, preserves every source, and restores to a new folder', async t => {
  const fixture = makeDataFixture(t);
  const before = new Map(fixture.sourceFiles.map(file => [file, hash(file)]));
  const dataListingBefore = fs.readdirSync(fixture.dataDirectory).sort();
  const supervisor = makeSupervisor(t, { LAUNCHER_FIXTURE_EXIT_DELAY_MS: '140' });
  await supervisor.start();
  let observedState;
  const info = await makeControl(t, {
    projectRoot: fixture.projectRoot,
    supervisor,
    sourcePaths: root => defaultSourcePaths({ projectRoot: root, dataDirectory: fixture.dataDirectory, databaseFile: fixture.databaseFile, storageFile: fixture.storageFile }),
    createBackupOperation: options => {
      observedState = supervisor.getStatus();
      return createBackup({ ...options, dataDirectory: fixture.dataDirectory, databaseFile: fixture.databaseFile, storageFile: fixture.storageFile });
    },
    restoreBackupOperation: options => restoreBackup({ ...options, databaseFile: fixture.databaseFile, storageFile: fixture.storageFile }),
  });
  const owner = await ownerSession(info);
  const startedAt = Date.now();
  const response = await postAsOwner(info, owner, '/api/backup');
  assert.equal(response.status, 200, response.json().error);
  const result = response.json();
  assert.ok(Date.now() - startedAt >= 120);
  assert.equal(observedState.state, 'stopped');
  assert.equal(observedState.managedProcess, false);
  assert.equal(result.manifest.state, 'complete');
  assert.equal(verifyBackup(result.directory).manifest.state, 'complete');
  for (const file of fixture.sourceFiles) assert.equal(hash(file), before.get(file), `source unchanged: ${file}`);
  assert.deepEqual(fs.readdirSync(fixture.dataDirectory).sort(), dataListingBefore);

  const restoreResponse = await postAsOwner(info, owner, '/api/restore', { backupDirectory: result.directory });
  assert.equal(restoreResponse.status, 200, restoreResponse.json().error);
  const restored = restoreResponse.json();
  assert.notEqual(restored.directory, fixture.dataDirectory);
  assert.ok(fs.existsSync(path.join(restored.directory, 'profile-store.sqlite')));
  for (const file of fixture.sourceFiles) assert.equal(hash(file), before.get(file), `restore preserves active source: ${file}`);
});

test('backup refuses to run when graceful stop fails or no launcher-owned stop was confirmed', async t => {
  let backupCalls = 0;
  const makeSupervisorStatus = state => ({
    getStatus: () => ({ state, managedProcess: state === 'running', urls: [], lastError: null }),
    stop: async () => { throw Object.assign(new Error('fixture did not acknowledge stop'), { code: 'STOP_TIMEOUT' }); },
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-launcher-refuse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePaths = () => defaultSourcePaths({ projectRoot: root });
  const runningInfo = await makeControl(t, {
    projectRoot: root,
    supervisor: makeSupervisorStatus('running'),
    sourcePaths,
    createBackup: () => { backupCalls++; throw new Error('must not run'); },
  });
  const owner = await ownerSession(runningInfo);
  const activeResponse = await postAsOwner(runningInfo, owner, '/api/backup');
  assert.equal(activeResponse.status, 409);
  assert.equal(backupCalls, 0);

  const idleInfo = await makeControl(t, {
    projectRoot: root,
    supervisor: makeSupervisorStatus('idle'),
    sourcePaths,
    createBackup: () => { backupCalls++; throw new Error('must not run'); },
  });
  const idleOwner = await ownerSession(idleInfo);
  const unverifiedResponse = await postAsOwner(idleInfo, idleOwner, '/api/backup');
  assert.equal(unverifiedResponse.status, 409);
  assert.equal(backupCalls, 0);
});
