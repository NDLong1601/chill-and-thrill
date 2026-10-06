'use strict';

// Launch the actual owned game child with exclusively temporary storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { io } = require('socket.io-client');
const { ServerSupervisor } = require('../src/platform/launcherLifecycle');
const { createBackup, verifyBackup, restoreBackup } = require('../src/platform/backupRestore');

const projectRoot = path.resolve(__dirname, '..');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-launcher-product-'));
const dataDirectory = path.join(temporaryRoot, 'source');
fs.mkdirSync(dataDirectory);
const paths = { databaseFile: path.join(dataDirectory, 'profiles.sqlite'), storageFile: path.join(dataDirectory, 'rooms.json') };
const supervisors = [];
const clients = [];

function supervisorFor(source) {
  const supervisor = new ServerSupervisor({ projectRoot, startTimeoutMs: 20000, stopTimeoutMs: 15000,
    env: { PORT: '0', GANG_DATA_FILE: source.storageFile, GANG_DATABASE_FILE: source.databaseFile,
      GANG_DB_FILE: source.databaseFile, CHILL_ADMIN_SECRET: 'temporary-c06-product-secret-32-bytes-minimum' } });
  supervisors.push(supervisor);
  return supervisor;
}

async function connect(url, token) {
  const client = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { profileToken: token } });
  client.states = [];
  client.on('game_state', state => client.states.push(state));
  client.on('game_error', payload => { client.lastGameError = payload; });
  clients.push(client);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Game child socket connect timed out.')), 5000);
    client.once('connect', () => { clearTimeout(timer); resolve(); });
    client.once('connect_error', error => { clearTimeout(timer); reject(error); });
  });
  return client;
}

function request(client, event, payload) {
  return new Promise((resolve, reject) => client.timeout(5000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result)));
}

async function waitState(client, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = client.states.findLast(predicate);
    if (state) return state;
    if (client.lastGameError) throw new Error(client.lastGameError.message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Actual game child did not publish the expected state.');
}

function financialSnapshot(databaseFile) {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const result = {};
    for (const table of ['wallets', 'wallet_operations', 'wallet_ledger', 'reservations', 'matches', 'match_players']) {
      result[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));
    }
    assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0], 'ok');
    return result;
  } finally { db.close(); }
}

async function profile(url, token) {
  const response = await fetch(`${url}/api/profile`, { headers: { 'X-Profile-Token': token } });
  assert.equal(response.status, 200);
  return (await response.json()).profile;
}

async function run() {
  const original = supervisorFor(paths);
  let status = await original.start();
  assert.equal(status.state, 'running');
  const url = `http://127.0.0.1:${status.port}`;
  const members = [];
  for (const name of ['Launcher host', 'Launcher guest']) {
    const response = await fetch(`${url}/api/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, avatar: '🎲' }) });
    assert.equal(response.status, 201);
    const created = await response.json();
    members.push({ token: created.profileToken, id: created.profile.playerId, client: await connect(url, created.profileToken) });
  }
  const host = members[0].client, guest = members[1].client;
  const room = await request(host, 'create_room', { gameId: 'tien-len', playerName: 'Launcher host', stake: 100 });
  assert.ok(room.roomCode, room.error);
  const joined = await request(guest, 'join_room', { roomCode: room.roomCode, playerName: 'Launcher guest' });
  assert.equal(joined.error, undefined);
  await request(host, 'room:ready', { roomCode: room.roomCode, ready: true });
  await request(guest, 'room:ready', { roomCode: room.roomCode, ready: true });
  await waitState(host, state => state.roomCode === room.roomCode && state.players.length === 2 && state.players.every(player => player.ready));
  host.emit('start_game', { roomCode: room.roomCode });
  const started = await waitState(host, state => state.roomCode === room.roomCode && state.phase !== 'WAITING');
  assert.ok(['TURN', 'RESULT'].includes(started.phase), started.phase);
  const balances = await Promise.all(members.map(member => profile(url, member.token)));
  if (started.phase === 'TURN') balances.forEach(member => assert.equal(member.balances.coin.reserved, 100));

  // Stop while sockets are connected: graceful shutdown must persist this hand.
  status = await original.stop();
  assert.equal(status.state, 'stopped');
  assert.deepEqual(status.exitInfo, { code: 0, signal: null });
  members.forEach(member => member.client.disconnect());
  const stoppedFinancials = financialSnapshot(paths.databaseFile);
  await assert.rejects(fetch(`${url}/api/profile`));

  const backupDirectory = path.join(temporaryRoot, 'backup');
  createBackup({ projectRoot, ...paths, outputDirectory: backupDirectory, serverStopped: status.state === 'stopped' });
  assert.equal(verifyBackup(backupDirectory).manifest.state, 'complete');
  assert.deepEqual(financialSnapshot(paths.databaseFile), stoppedFinancials);
  const restored = restoreBackup({ projectRoot, ...paths, backupDirectory, outputDirectory: path.join(temporaryRoot, 'restored') });
  assert.deepEqual(financialSnapshot(restored.databaseFile), stoppedFinancials);
  assert.deepEqual(financialSnapshot(paths.databaseFile), stoppedFinancials);

  const recovered = supervisorFor(restored);
  status = await recovered.start();
  const recoveredUrl = `http://127.0.0.1:${status.port}`;
  const recoveredProfiles = await Promise.all(members.map(member => profile(recoveredUrl, member.token)));
  for (let index = 0; index < members.length; index++) {
    assert.equal(recoveredProfiles[index].playerId, members[index].id);
    assert.deepEqual(recoveredProfiles[index].balances, balances[index].balances);
  }
  const resumedClient = await connect(recoveredUrl, members[0].token);
  const resumed = await request(resumedClient, 'room:resume', { roomCode: room.roomCode, sessionToken: room.sessionToken });
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.playerId, room.playerId);
  const restoredState = await waitState(resumedClient, state => state.roomCode === room.roomCode);
  assert.equal(restoredState.phase, started.phase);
  assert.deepEqual(financialSnapshot(restored.databaseFile), stoppedFinancials);
  assert.equal((await recovered.stop()).state, 'stopped');
  resumedClient.disconnect();
  assert.deepEqual(financialSnapshot(restored.databaseFile), stoppedFinancials);
  console.log('PASS C06 actual owned game child: active-hand graceful stop + clean exit, closed port, authenticated profile/seat restore, shared wallet/holds/ledger unchanged, C04 verified backup and new-directory recovery. All storage temporary.');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  clients.forEach(client => client.disconnect());
  for (const supervisor of supervisors) {
    if (!supervisor.getStatus().managedProcess) continue;
    try { await supervisor.stop(); } catch (error) { console.error('Owned child cleanup failed:', error.message); process.exitCode = 1; }
  }
  const isTemporary = path.dirname(temporaryRoot) === path.resolve(os.tmpdir()) && path.basename(temporaryRoot).startsWith('ct-launcher-product-');
  if (isTemporary && supervisors.every(supervisor => !supervisor.getStatus().managedProcess)) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  else console.error('Temporary fixture retained because cleanup could not confirm every owned child exited:', temporaryRoot);
});
