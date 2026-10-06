'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-admin-product-'));
  const secret = 'temporary-C05-product-owner-secret-over-32-bytes';
  const game = createGameServer({ storageFile: path.join(directory, 'rooms.json'), databaseFile: path.join(directory, 'profiles.sqlite'), adminSecret: secret });
  let browser;
  const clients = [];
  try {
    await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${game.server.address().port}`;
    async function connect() {
      const socket = io(origin, { transports: ['websocket'], forceNew: true, reconnection: false });
      clients.push(socket);
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
      return socket;
    }
    const request = (socket, event, payload) => new Promise((resolve, reject) => socket.timeout(5000).emit(event, payload, (error, result) => error ? reject(error) : resolve(result)));
    const host = await connect();
    const created = await request(host, 'room:create', { gameId: 'uno', playerName: 'Admin product host', config: { variant: 'classic-local-v1', maxPlayers: 4, visibility: 'invite', password: 'temporary-private-password' } });
    assert.ok(created.roomCode, created.error);
    assert.equal((await fetch(`${origin}/api/admin/status`)).status, 401);
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${origin}/admin`);
    await page.locator('#admin-secret').fill(created.profileToken);
    await page.locator('#auth-form button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#auth-message').textContent === 'Secret sai hoặc API quản trị chưa được cấu hình.');
    assert.equal(await page.locator('#dashboard').isVisible(), false);
    await page.locator('#admin-secret').fill(secret);
    await page.locator('#auth-form button[type=submit]').click();
    await page.locator('#dashboard:not([hidden])').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.qr-image')].some(image => image.complete && image.naturalWidth > 0));
    assert.match(await page.locator('#room-list').innerText(), new RegExp(created.roomCode));
    assert.match(await page.locator('#room-list').innerText(), /UNO 112 lá/);
    assert.equal((await page.locator('#dashboard').innerText()).includes('temporary-private-password'), false);
    assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('temporary-C05-product-owner'))), false);
    await page.locator('#maintenance-toggle').click();
    await page.waitForFunction(() => document.querySelector('#maintenance-state').textContent === 'Bảo trì');
    assert.equal(game.adminService.getStatus().server.maintenance, true);
    assert.match(await page.locator('#receipts').innerText(), /Bật bảo trì/);
    const guest = await connect();
    const blocked = await request(guest, 'room:create', { gameId: 'the-gang', playerName: 'Blocked host' });
    assert.ok(blocked.error);
    const joined = await request(guest, 'room:join', { roomCode: created.roomCode, playerName: 'Existing guest', password: 'temporary-private-password' });
    assert.equal(joined.error, undefined);
    for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        overflow: [...document.querySelectorAll('body *')].map(element => ({ tag: element.tagName, id: element.id, className: typeof element.className === 'string' ? element.className : '', right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width }))
          .filter(element => element.right > innerWidth + 1 && element.width > 0).slice(0, 12) }));
      if (layout.scrollWidth > layout.width + 1) await page.screenshot({ path: path.resolve(__dirname, '../test-results/admin-C05-product-overflow-20261006.png'), fullPage: true });
      assert.ok(layout.scrollWidth <= layout.width + 1, JSON.stringify(layout));
    }
    await page.screenshot({ path: path.resolve(__dirname, '../test-results/admin-C05-product-20261006.png'), fullPage: true });
    await page.locator('#maintenance-toggle').click();
    await page.waitForFunction(() => document.querySelector('#maintenance-state').textContent !== 'Bảo trì');
    assert.equal(game.adminService.getStatus().server.maintenance, false);
    await page.locator('#sign-out').click();
    assert.equal(await page.locator('#dashboard').isVisible(), false);
    assert.equal(await page.locator('#admin-secret').inputValue(), '');
    assert.deepEqual(pageErrors, []);
    console.log('PASS C05 actual mounted admin browser: owner authentication rejects profile tokens, real QR renders, invite room metadata, maintenance receipt/create rejection/existing join, four viewports, secret clear on sign-out, zero page errors. All data temporary.');
  } finally {
    await browser?.close();
    clients.forEach(client => client.disconnect());
    await game.close();
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('ct-admin-product-')) fs.rmSync(directory, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
