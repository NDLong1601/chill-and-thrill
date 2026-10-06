'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ADMIN_SECRET_ENV,
  AdminService,
  collectRoomRecords,
  constantTimeSecretMatch,
  isLoopbackAddress,
  sanitizeStorage,
  validSecret,
} = require('../src/platform/adminService');

const SECRET = 'local-admin-test-secret-32-bytes-minimum';

test('admin authentication requires a 32-byte configured secret and compares credentials', () => {
  assert.equal(ADMIN_SECRET_ENV, 'CHILL_ADMIN_SECRET');
  assert.equal(validSecret('too-short'), null);
  assert.equal(validSecret(SECRET), SECRET);
  assert.equal(constantTimeSecretMatch(null, SECRET), false);
  assert.equal(constantTimeSecretMatch(SECRET, SECRET), true);
  assert.equal(constantTimeSecretMatch(SECRET, `${SECRET}x`), false);
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.20'), false);
});

test('room collection includes active and invite-only rooms while projecting only admin metadata', () => {
  const maps = new Map([
    ['gang', { code: 'ABCD', gameId: 'the-gang', variant: 'standard', phase: 'WAITING', config: { maxPlayers: 6, visibility: 'invite', passwordHash: 'room-password-hash' }, players: [
      { name: 'Guest One', id: 'profile-uuid-1', profileId: 'profile-uuid-1', token: 'seat-secret-1', connected: true, privateCards: ['AS'] },
      { name: 'Guest Two', id: 'profile-uuid-2', token: 'seat-secret-2', connected: false, privateCards: ['KH'] },
    ] }],
    ['uno112', { code: 'U112', gameId: 'uno', variant: 'classic-local-v1', phase: 'PLAYING', config: { maxPlayers: 4 }, players: [{ connected: true }] }],
    ['uno108', { code: 'U108', phase: 'PLAYING', config: { maxPlayers: 6 }, players: [{ connected: true }, { connected: true }] }],
  ]);
  const meta = new Map([
    ['ABCD', { gameId: 'the-gang', variant: 'standard', phase: 'WAITING', players: 2, maxPlayers: 6, visibility: 'invite' }],
    ['U112', { gameId: 'uno', variant: 'classic-local-v1', phase: 'PLAYING', players: 1, maxPlayers: 4, visibility: 'public' }],
    ['U108', { gameId: 'uno', variant: 'classic-108-v1', phase: 'PLAYING', players: 2, maxPlayers: 6, visibility: 'public' }],
  ]);
  const gm = {
    gang: { rooms: new Map([['ABCD', maps.get('gang')], ['U112', maps.get('uno112')]]) },
    uno: { rooms: new Map([['U108', maps.get('uno108')]]) },
    publicRoom(code) { return meta.get(code); },
  };
  const rooms = collectRoomRecords(gm);
  assert.equal(rooms.length, 3);
  assert.deepEqual(rooms.map(room => [room.code, room.gameId, room.variant]), [
    ['ABCD', 'the-gang', 'standard'], ['U108', 'uno', 'classic-108-v1'], ['U112', 'uno', 'classic-local-v1'],
  ]);
  assert.equal(rooms[0].playerCount, 2);
  assert.equal(rooms[0].connectedCount, 1);
  assert.equal(rooms[0].visibility, 'invite');
  const serialized = JSON.stringify(rooms);
  for (const privateValue of ['profile-uuid-1', 'seat-secret-1', 'room-password-hash', 'privateCards', 'Guest One']) {
    assert.equal(serialized.includes(privateValue), false, `unexpected private value: ${privateValue}`);
  }
  assert.deepEqual(Object.keys(rooms[0]).sort(), ['code', 'connectedCount', 'gameId', 'maxPlayers', 'phase', 'playerCount', 'variant', 'visibility']);
});

test('status reads storage with pending operations ignored and sanitizes all public sections', () => {
  const room = {
    code: 'A1B2', gameId: 'poker', variant: 'standard', phase: 'PLAYING',
    playerCount: 2, connectedCount: 1, maxPlayers: 6, visibility: 'public',
    token: 'room-token', passwordHash: 'hash', profileId: 'profile-id', hand: ['AS'],
  };
  const status = {
    status: 'warning', database: 'sqlite', schemaVersion: 4, integrity: 'ok', canStartWager: true,
    warnings: [{ sourceId: '..\\data\\secret.sqlite', gameId: 'poker', operation: 'export', state: 'error', stage: 'C:\\data\\private', code: 'EXPORT_FAILED' }],
    failures: [],
    heldAudit: { state: 'ok', total: 2, needsAttention: 0, checkedAt: '2026-10-06T01:00:00Z' },
  };
  let statusOptions;
  const service = new AdminService({
    adminSecret: SECRET,
    getNetworkAddresses: () => [
      { name: 'WiFi', url: 'http://192.168.1.20:3000', local: false },
      { name: 'evil', url: 'https://evil.example/exfil', local: false },
    ],
    getRooms: () => [room],
    getConnectionCount: () => 3,
    getStorageStatus: options => { statusOptions = options; return status; },
    clock: () => new Date('2026-10-06T01:02:03Z'),
  });
  service.setMaintenance(true, 'operation-0001');
  const result = service.getStatus();
  assert.deepEqual(statusOptions, { ignorePending: true });
  assert.equal(result.server.maintenance, true);
  assert.equal(result.server.connectionCount, 3);
  assert.equal(result.server.roomCount, 1);
  assert.equal(result.addresses.length, 1);
  assert.equal(result.addresses[0].url, 'http://192.168.1.20:3000');
  assert.equal(result.storage.canStartWager, true);
  assert.equal(result.storage.database.schemaVersion, 4);
  assert.equal(result.storage.warnings[0].sourceId, 'unknown');
  assert.equal(result.storage.warnings[0].stage, 'unknown');
  assert.equal(result.financialTools.available, false);
  const json = JSON.stringify(result);
  for (const privateValue of ['room-token', 'passwordHash', 'profile-id', 'hand', 'evil.example', 'secret.sqlite', 'private']) {
    assert.equal(json.includes(privateValue), false, `unexpected private value: ${privateValue}`);
  }
});

test('maintenance gate rejects creation only and can be cleanly uninstalled', () => {
  const calls = [];
  const activeRoom = { phase: 'PLAYING', recoveryCount: 0, actionCount: 0, settlementCount: 0, closed: false };
  const gm = {
    createRoom(...args) { calls.push(['manager-create', ...args]); return { roomCode: 'NEW1' }; },
    joinRoom() { calls.push(['join']); return { ok: true }; },
    startGame() { calls.push(['start']); return { ok: true }; },
    recoverRoom() { activeRoom.recoveryCount++; calls.push(['recover']); return { ok: true }; },
    gameAction() { activeRoom.actionCount++; calls.push(['action']); return { ok: true }; },
    settleMatch() { activeRoom.settlementCount++; activeRoom.phase = 'RESULT'; calls.push(['settle']); return { ok: true }; },
    leaveRoom() { activeRoom.closed = true; calls.push(['leave']); return { ok: true }; },
  };
  const roomService = {
    createRoom(...args) { calls.push(['room-service-create', ...args]); return { roomCode: 'NEW2' }; },
    resumeRoom() { calls.push(['resume']); return { ok: true }; },
  };
  const service = new AdminService({ adminSecret: SECRET });
  const restore = service.installRoomCreationGate([{ target: gm }, { target: roomService }]);
  assert.deepEqual(gm.createRoom('before'), { roomCode: 'NEW1' });
  assert.deepEqual(roomService.createRoom('before'), { roomCode: 'NEW2' });
  assert.equal(service.setMaintenance(true, 'operation-0002').enabled, true);
  assert.deepEqual(gm.createRoom('after'), { error: 'Máy chủ đang bảo trì; chưa thể tạo bàn mới.', code: 'MAINTENANCE_ACTIVE' });
  assert.deepEqual(roomService.createRoom('after'), { error: 'Máy chủ đang bảo trì; chưa thể tạo bàn mới.', code: 'MAINTENANCE_ACTIVE' });
  assert.deepEqual(gm.joinRoom(), { ok: true });
  assert.deepEqual(gm.startGame(), { ok: true });
  assert.deepEqual(roomService.resumeRoom(), { ok: true });
  assert.deepEqual(gm.recoverRoom(), { ok: true });
  assert.deepEqual(gm.gameAction(), { ok: true });
  assert.deepEqual(gm.settleMatch(), { ok: true });
  assert.deepEqual(gm.leaveRoom(), { ok: true });
  assert.deepEqual(calls.map(call => call[0]), ['manager-create', 'room-service-create', 'join', 'start', 'resume', 'recover', 'action', 'settle', 'leave']);
  assert.deepEqual(activeRoom, { phase: 'RESULT', recoveryCount: 1, actionCount: 1, settlementCount: 1, closed: true }, 'maintenance keeps existing-room recovery, actions, settlement, and exit available');
  service.setMaintenance(false, 'operation-0003');
  assert.deepEqual(gm.createRoom('after-close'), { roomCode: 'NEW1' });
  restore();
  assert.deepEqual(roomService.createRoom('after-restore'), { roomCode: 'NEW2' });
});

test('maintenance operations are idempotent and preserve a receipt for replay', () => {
  let receiptNumber = 0;
  const service = new AdminService({
    adminSecret: SECRET,
    idGenerator: () => `receipt-${++receiptNumber}`,
    clock: () => new Date('2026-10-06T02:03:04Z'),
  });
  const first = service.setMaintenance(true, 'operation-0004');
  const replay = service.setMaintenance(true, 'operation-0004');
  const conflict = service.setMaintenance(false, 'operation-0004');
  assert.equal(first.ok, true);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(conflict.status, 409);
  assert.equal(service.getStatus().recentActions.length, 1);
  assert.equal(receiptNumber, 1);
  assert.equal(service.setMaintenance('yes', 'operation-0005').status, 400);
  assert.equal(service.setMaintenance(false, 'bad').status, 400);
});

test('storage projection fails closed and rejects path-like metadata', () => {
  const projection = sanitizeStorage({
    status: 'unsafe', database: { kind: 'sqlite' }, integrity: 'error', canStartWager: false,
    warnings: [{ sourceId: 'C:\\Users\\owner\\db', stage: '../../data', code: 'DATABASE_UNSAFE' }],
    failures: [{ sourceId: 'snapshot:poker', gameId: 'poker', operation: 'commit', state: 'error', stage: 'room-write', code: 'ROOM_WRITE_FAILED' }],
    heldAudit: { state: 'unavailable', total: 3, needsAttention: 1 },
  });
  assert.equal(projection.status, 'unsafe');
  assert.equal(projection.canStartWager, false);
  assert.equal(projection.warnings[0].sourceId, 'unknown');
  assert.equal(projection.warnings[0].stage, 'unknown');
  assert.equal(projection.failures[0].sourceId, 'snapshot:poker');
  assert.equal(projection.heldAudit.state, 'unavailable');
  assert.equal(JSON.stringify(projection).includes('C:\\Users'), false);
});
