'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { AdminService } = require('../src/platform/adminService');
const { createAdminRouter } = require('../src/platform/adminRouter');

const SECRET = 'LAN-admin-integration-secret-with-more-than-32-bytes';

async function withAdminServer(options, work) {
  const app = express();
  const adminService = options.service || new AdminService({
    adminSecret: Object.hasOwn(options, 'secret') ? options.secret : SECRET,
    getNetworkAddresses: () => [{ name: 'WiFi', url: 'http://192.168.1.42:3000', local: false }],
    getRooms: () => [{ code: 'T123', gameId: 'tien-len', variant: 'standard', phase: 'PLAYING', playerCount: 3, connectedCount: 2, maxPlayers: 4, visibility: 'invite' }],
    getConnectionCount: () => 5,
    getStorageStatus: () => ({ status: 'ok', database: 'sqlite', schemaVersion: 4, integrity: 'ok', canStartWager: true, warnings: [], failures: [], heldAudit: { state: 'ok', total: 0, needsAttention: 0, checkedAt: '2026-10-06T00:00:00Z' } }),
  });
  app.use('/api/admin', createAdminRouter(adminService, { createQrSvg: async url => `<svg xmlns="http://www.w3.org/2000/svg"><text>${url}</text></svg>` }));
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    return await work({ origin, adminService });
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

function authorization(secret = SECRET) { return { Authorization: `Bearer ${secret}` }; }

test('admin router requires the owner secret in Authorization; query and profile credentials are ignored', async () => {
  await withAdminServer({}, async ({ origin }) => {
    const missing = await fetch(`${origin}/api/admin/status`, { headers: { 'x-profile-token': SECRET } });
    assert.equal(missing.status, 401);
    const query = await fetch(`${origin}/api/admin/status?token=${encodeURIComponent(SECRET)}`);
    assert.equal(query.status, 401);
    const wrong = await fetch(`${origin}/api/admin/status`, { headers: authorization('wrong-secret') });
    assert.equal(wrong.status, 401);
    const correct = await fetch(`${origin}/api/admin/status`, { headers: authorization() });
    assert.equal(correct.status, 200);
    assert.match(correct.headers.get('cache-control'), /no-store/);
    const payload = await correct.json();
    assert.equal(payload.server.connectionCount, 5);
    assert.equal(payload.rooms[0].code, 'T123');
  });
});

test('same-origin maintenance mutations are idempotent and cross-origin/replayed conflicts are rejected', async () => {
  await withAdminServer({}, async ({ origin, adminService }) => {
    const operationId = 'browser-operation-1001';
    const request = enabled => fetch(`${origin}/api/admin/maintenance`, {
      method: 'POST',
      headers: { ...authorization(), 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ enabled, operationId }),
    });
    const missingOrigin = await fetch(`${origin}/api/admin/maintenance`, {
      method: 'POST', headers: { ...authorization(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, operationId: 'browser-operation-1002' }),
    });
    assert.equal(missingOrigin.status, 403);
    const badOrigin = await fetch(`${origin}/api/admin/maintenance`, {
      method: 'POST', headers: { ...authorization(), 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ enabled: true, operationId: 'browser-operation-1003' }),
    });
    assert.equal(badOrigin.status, 403);
    const first = await request(true);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.maintenance, true);
    assert.equal(firstBody.replayed, false);
    const replay = await request(true);
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.replayed, true);
    assert.equal(replayBody.receipt.receiptId, firstBody.receipt.receiptId);
    const conflict = await request(false);
    assert.equal(conflict.status, 409);
    assert.equal(adminService.getStatus().server.maintenance, true);
    assert.equal(adminService.getStatus().recentActions.length, 1);
    const extraField = await fetch(`${origin}/api/admin/maintenance`, {
      method: 'POST', headers: { ...authorization(), 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ enabled: false, operationId: 'browser-operation-1004', coinGrant: 1000 }),
    });
    assert.equal(extraField.status, 400);
  });
});

test('admin QR endpoint is authenticated and emits only a local address QR; no financial routes exist', async () => {
  await withAdminServer({}, async ({ origin }) => {
    const denied = await fetch(`${origin}/api/admin/network-qr/0.svg`);
    assert.equal(denied.status, 401);
    const response = await fetch(`${origin}/api/admin/network-qr/0.svg`, { headers: authorization() });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await response.text(), /192\.168\.1\.42:3000/);
    const invalidAddress = await fetch(`${origin}/api/admin/network-qr/1.svg`, { headers: authorization() });
    assert.equal(invalidAddress.status, 404);
    const grant = await fetch(`${origin}/api/admin/money/grant`, { method: 'POST', headers: authorization() });
    assert.equal(grant.status, 404);
  });
});

test('short or missing secret leaves every admin route unavailable without a public bootstrap', async () => {
  for (const secret of [undefined, 'short']) {
    await withAdminServer({ secret }, async ({ origin }) => {
      const response = await fetch(`${origin}/api/admin/status`, { headers: authorization(SECRET) });
      assert.equal(response.status, 401);
    });
  }
});
