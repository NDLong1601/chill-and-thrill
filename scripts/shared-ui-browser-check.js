'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('@playwright/test');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');

async function main() {
  // No player files: the server and profile database live only in memory.
  const game = createGameServer(); await new Promise(resolve => game.server.listen(0, '0.0.0.0', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const screenshots = path.join(__dirname, '..', 'test-results'); fs.mkdirSync(screenshots, { recursive: true });
  const errors = [], clients = []; let browser;
  const connect = async () => {
    const client = io(url, { transports: ['websocket'], forceNew: true }); clients.push(client);
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    return game.io.sockets.sockets.get(client.id);
  };
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
    await context.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', cause => errors.push(cause.stack));
    await page.goto(url); await page.locator('#portal-player-name').tap(); await page.keyboard.type('Ban iPhone');
    assert.equal(await page.locator('#portal-player-name').inputValue(), 'Ban iPhone');
    assert.equal(await page.locator('#portal-player-name').evaluate(input => input.closest('#room-entry-section') !== null), true);
    assert.equal(await page.locator('#profile-display-name').isVisible(), false);
    await page.locator('#portal-room-code').tap(); await page.keyboard.type('abcd');
    assert.equal(await page.locator('#portal-room-code').inputValue(), 'ABCD');
    assert.equal(await page.locator('#portal-room-password').isVisible(), false);
    assert.equal(await page.locator('#portal-tutorial').count(), 0);
    const text = await page.locator('#screen-home').innerText(); assert.doesNotMatch(text, /schema|SQLite|Luật v|Hướng dẫn M\d/i);
    await page.locator('#portal-room-code').blur(); await page.screenshot({ path: path.join(screenshots, 'ui-home-phone.png'), fullPage: true });
    await page.locator('#btn-tab-profile').click();
    await page.locator('#profile-display-name').tap(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('Ten moi');
    assert.equal(await page.locator('#portal-player-name').inputValue(), 'Ten moi');
    await page.locator('#btn-profile-exit').click();
    for (const [id, variant] of [['the-gang'], ['uno', 'classic-local-v1'], ['uno', 'classic-108-v1'], ['tien-len'], ['sam-loc'], ['phom'], ['poker'], ['bang']]) {
      const host = await connect();
      const created = game.gm.createRoom(host, 'Chu phong', 'BASIC', '🎲', id, { password: '012345', ...(variant ? { variant } : {}) });
      assert.ok(!created.error, created.error);
      await page.goto(`${url}/rooms/${created.roomCode}`);
      await page.locator('#portal-player-name').fill('Ban iPhone'); await page.locator('#portal-join').click();
      await page.locator('.room-password-dialog[open]').waitFor();
      assert.equal(await page.locator('.passcode-cells span').count(), 6);
      await page.locator('#portal-room-password').tap(); await page.keyboard.type('654321');
      await page.locator('.password-submit').click(); await page.waitForFunction(() => document.querySelector('#room-password-error').textContent.includes('Mật khẩu'));
      assert.equal(game.gm.managerForCode(created.roomCode).rooms.get(created.roomCode).players.length, 1);
      await page.locator('#portal-room-password').fill('012345');
      if (id === 'the-gang') await page.screenshot({ path: path.join(screenshots, 'ui-password-phone.png') });
      await page.locator('.password-submit').click();
      const integrated = id === 'the-gang' || variant === 'classic-local-v1';
      const waiting = integrated ? '#screen-waiting.active' : '#room-view:not([hidden])';
      await page.locator(waiting).waitFor();
      if (!integrated) assert.equal(new URL(page.url()).searchParams.get('returnTo'), 'portal');
      await page.waitForFunction(integrated => document.querySelector(integrated ? '#room-qr' : '#qr')?.naturalWidth > 0, integrated);
      const addresses = await fetch(`${url}/api/network`).then(response => response.json());
      if (addresses.addresses.some(item => !item.local)) {
        const link = await page.locator(integrated ? '#share-link' : '#room-view .share-link').getAttribute('href');
        assert.ok(!['localhost', '127.0.0.1', '[::1]'].includes(new URL(link).hostname), 'QR/share link must use a reachable LAN address when opened via localhost');
      }
      assert.equal(await page.locator(`${waiting} .room-shell-layout`).count(), 1);
      const room = game.gm.managerForCode(created.roomCode).rooms.get(created.roomCode);
      assert.equal(room.players.length, 2);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.screenshot({ path: path.join(screenshots, `ui-waiting-${id}-${variant || 'standard'}-phone.png`), fullPage: true });
      if (id === 'poker') {
        await page.locator('#buyin-amount').tap(); await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type('250');
        assert.equal(await page.locator('#buyin-amount').inputValue(), '250');
        assert.equal(await page.locator('#buyin-amount').evaluate(input => parseFloat(getComputedStyle(input).fontSize) >= 16), true);
      }
      // Exercise the real rotation observer without mutating room/game state.
      await page.evaluate(({ integrated, id }) => {
        if (integrated) showScreen(id === 'uno' ? 'screen-uno' : 'screen-game'); else { document.getElementById('room-view').hidden = true; document.getElementById('game-view').hidden = false; }
      }, { integrated, id });
      const gate = integrated ? '#rotate-device-overlay' : '.table-rotation-gate';
      try { await page.locator(gate).waitFor({ state: 'visible' }); }
      catch (cause) { console.error('Rotation fixture:', await page.evaluate(() => ({ width: innerWidth, height: innerHeight, touch: navigator.maxTouchPoints, angle: window.orientation, portrait: MobileUI.isPhonePortrait(), helper: String(MobileUI.isPhonePortrait), screens: [...document.querySelectorAll('.screen.active')].map(node => node.id) }))); throw cause; }
      await page.setViewportSize({ width: 844, height: 390 }); await page.locator(gate).waitFor({ state: 'hidden' });
      if (id === 'poker') {
        // Simulate a keyboard shrinking the visual area while editing in landscape.
        await page.evaluate(() => { const input = document.createElement('input'); input.id = 'keyboard-fixture'; document.getElementById('game-view').append(input); input.focus(); });
        await page.setViewportSize({ width: 390, height: 200 });
        assert.equal(await page.locator(gate).isVisible(), false);
        assert.equal(await page.locator('#game-view').evaluate(node => node.closest('main').parentElement.inert), false);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      // Return to the real waiting room before leaving; the engine stayed in WAITING throughout.
      await page.evaluate(() => { document.getElementById('keyboard-fixture')?.remove(); });
      await page.reload(); await page.locator(waiting).waitFor();
      if (!integrated) assert.equal(new URL(page.url()).searchParams.get('returnTo'), 'portal');
      await page.locator(integrated ? '#btn-leave-waiting' : '#leave').click();
      await page.locator('#screen-home.active').waitFor();
      assert.equal(new URL(page.url()).pathname, '/');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('gang.session')), null);
      assert.equal(await page.evaluate(() => localStorage.getItem('chill-thrill:last-room')), null);
      assert.equal(room.players.length, 1, 'The joining seat must be removed on departure');
      console.log(`PASS: ${id} ${variant || ''} protected join/retry, common waiting room, QR, portrait gate, rotation, reload and departure to portal`);
    }
    const legacyHost = await connect();
    const legacy = game.gm.createRoom(legacyHost, 'Cu', 'BASIC', '🎲', 'the-gang', { password: 'old-text-password' });
    await page.goto(`${url}/?room=${legacy.roomCode}`); await page.locator('#portal-player-name').fill('Khach cu'); await page.locator('#portal-join').click();
    await page.locator('.password-legacy').click(); await page.locator('#portal-room-password').fill('old-text-password'); await page.locator('.password-submit').click();
    await page.locator('#screen-waiting.active').waitFor();
    const origin = 'https://room.lan';
    const qr = await new Promise((resolve, reject) => {
      http.get(`${url}/api/rooms/${legacy.roomCode}/qr?origin=${encodeURIComponent(origin)}`, { headers: { Host: 'room.lan' } }, response => {
        let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body }));
      }).on('error', reject);
    });
    assert.equal(qr.status, 200); assert.match(qr.body, /<svg/);
    assert.equal((await fetch(`${url}/api/rooms/${legacy.roomCode}/qr?origin=https://evil.example`)).status, 400);
    console.log('PASS: legacy text passwords, HTTPS/LAN hostname QR and rejected foreign origins');
    await page.locator('#btn-leave-waiting').click(); await page.locator('#screen-home.active').waitFor();
    const directHost = await connect();
    const direct = game.gm.createRoom(directHost, 'UNO', 'BASIC', '🎲', 'uno', { variant: 'classic-108-v1', password: '123456' });
    await page.goto(`${url}/uno?room=${direct.roomCode}`); await page.locator('#name').fill('Link cu'); await page.locator('#join').click();
    await page.locator('.room-password-dialog[open]').waitFor(); await page.locator('#portal-room-password').fill('123456'); await page.locator('.password-submit').click();
    await page.locator('#room-view:not([hidden])').waitFor();
    assert.equal(game.gm.uno.rooms.get(direct.roomCode).players.length, 2);
    await page.locator('#leave').click(); await page.locator('#home-view:not([hidden])').waitFor();
    assert.equal(new URL(page.url()).pathname, '/uno');
    assert.equal(new URL(page.url()).searchParams.get('returnTo'), null);
    await page.goto(`${url}/poker?room=${legacy.roomCode}`); await page.locator('#name').fill('Dung game'); await page.locator('#join').click();
    await page.waitForURL(`**/?room=${legacy.roomCode}`); await page.locator('#screen-home.active').waitFor();
    assert.equal(await page.locator('#portal-room-code').inputValue(), legacy.roomCode);
    console.log('PASS: direct protected legacy links and cross-game invitations route to the matching game');
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const preview = await desktop.newPage(); preview.on('pageerror', cause => errors.push(cause.stack));
    await preview.goto(url); await preview.locator('#portal-player-name').fill('Chill & Thrill');
    await preview.screenshot({ path: path.join(screenshots, 'ui-home-desktop.png'), fullPage: true });
    await preview.locator('[data-game-card-action="the-gang"]').click();
    await preview.screenshot({ path: path.join(screenshots, 'ui-game-detail-desktop.png'), fullPage: true });
    await preview.locator('#detail-create').click(); await preview.locator('#screen-waiting.active').waitFor();
    await preview.waitForFunction(() => document.getElementById('room-qr').naturalWidth > 0);
    await preview.screenshot({ path: path.join(screenshots, 'ui-waiting-desktop.png'), fullPage: true });
    await preview.locator('#btn-leave-waiting').click(); await preview.locator('#screen-home.active').waitFor();
    await preview.locator('[data-game-card-action="poker"]').click(); await preview.locator('#detail-create').click();
    await preview.waitForURL('**/poker?room=*'); await preview.locator('#room-view:not([hidden])').waitFor();
    await preview.waitForFunction(() => document.getElementById('qr').naturalWidth > 0);
    await preview.screenshot({ path: path.join(screenshots, 'ui-poker-waiting-desktop.png'), fullPage: true });
    await desktop.close();
    assert.deepEqual(errors, []); console.log('PASS: native form inputs in simulated standalone iPhone, no source introductions or page errors');
    await context.close();
  } finally { clients.forEach(client => client.disconnect()); await browser?.close(); await game.close(); }
}
main().catch(cause => { console.error(cause); process.exitCode = 1; });
