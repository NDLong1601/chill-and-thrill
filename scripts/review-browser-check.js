'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const QRCode = require('qrcode');
const { createGameServer } = require('../src/httpServer');

async function reconnect(page, expectedId) {
  const result = await page.evaluate(() => new Promise(resolve => {
    socket.disconnect();
    socket.once('connect', () => socket.emit('profile_status', {}, resolve));
    socket.connect();
  }));
  assert.equal(result.profile?.id, expectedId);
  await page.waitForFunction(id => !document.querySelector('#profile').hidden && document.querySelector('#profile-id').textContent === id, expectedId);
}

async function main() {
  // No storage paths: all room state and the SQLite wallet live in memory.
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`, errors = [];
  const originalQr = QRCode.toString;
  let browser, qrPayload;
  QRCode.toString = (value, options) => { qrPayload = value; return originalQr(value, options); };
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    async function pageFor(context) {
      const page = await context.newPage(); page.setDefaultTimeout(8000);
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      return page;
    }
    const ownerContext = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const owner = await pageFor(ownerContext);
    await owner.goto(`${url}/profile`); await owner.waitForFunction(() => socket.connected);
    await owner.locator('#new-name').fill('Reconnect owner'); await owner.locator('#create').click();
    await owner.locator('#profile').waitFor({ state: 'visible' });
    const profileId = await owner.locator('#profile-id').innerText(), recovery = await owner.locator('#recovery-code').innerText();
    await reconnect(owner, profileId);
    await owner.locator('#edit-name').fill('Owner reconnected'); await owner.locator('#save-profile').click();
    await owner.waitForFunction(() => document.querySelector('#display-name').textContent === 'Owner reconnected');
    assert.equal(await owner.locator('#available').innerText(), '1.000');

    const mobileContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    const mobile = await pageFor(mobileContext);
    await mobile.goto(`${url}/profile`); await mobile.waitForFunction(() => socket.connected);
    await mobile.locator('details.recover summary').click();
    await mobile.locator('#recover-id').fill(profileId); await mobile.locator('#recover-code').fill(recovery); await mobile.locator('#recover').click();
    await mobile.locator('#profile').waitFor({ state: 'visible' }); await reconnect(mobile, profileId);
    assert.equal(await mobile.locator('#available').innerText(), '1.000');
    await mobile.goto(`${url}/missions`); await mobile.locator('#screen-home.active').waitFor();
    await mobile.waitForFunction(() => document.querySelectorAll('#portal-missions .portal-mission').length === 4);
    assert.equal(await mobile.locator('#screen-not-found').isVisible(), false);
    assert.match(await mobile.locator('#portal-wallet-available').innerText(), /1\.000/);
    const layout = await mobile.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(layout.scrollWidth <= layout.width + 1);
    const guestContext = await browser.newContext(); const guest = await pageFor(guestContext);
    await guest.goto(`${url}/missions`); await guest.locator('#screen-home.active').waitFor();
    await guest.waitForFunction(() => document.querySelector('#portal-missions').textContent.includes('Tạo hồ sơ'));

    await owner.goto(url); await owner.locator('#portal-player-name').fill('QR owner');
    await owner.locator('[data-game-card-action="uno"]').click();
    await owner.locator('#detail-uno-variant').selectOption('classic-108-v1');
    await owner.locator('#detail-password').fill('123456'); await owner.locator('#detail-create').click();
    await owner.waitForURL(/\/uno\?room=/); await owner.locator('#room-view').waitFor({ state: 'visible' });
    const code = new URL(owner.url()).searchParams.get('room');
    const response = await fetch(`${url}/api/rooms/${code}/qr?origin=${encodeURIComponent(url)}`);
    assert.equal(response.status, 200); assert.match(await response.text(), /<svg/);
    assert.equal(qrPayload, `${url}/?room=${code}`);
    await guest.goto(qrPayload); await guest.locator('#screen-home.active').waitFor();
    await guest.locator('#portal-player-name').fill('QR guest');
    await guest.locator('#portal-join').click();
    await guest.locator('.room-password-dialog[open]').waitFor();
    await guest.locator('#portal-room-password').fill('654321'); await guest.locator('.password-submit').click();
    await guest.waitForFunction(() => /mật khẩu/i.test(document.querySelector('#room-password-error').textContent));
    assert.equal(game.gm.uno.rooms.get(code).players.length, 1);
    await guest.locator('#portal-room-password').fill('123456'); await guest.locator('.password-submit').click();
    await guest.waitForURL(/\/uno\?room=/); await guest.locator('#room-view').waitFor({ state: 'visible' });
    assert.equal(game.gm.uno.rooms.get(code).players.length, 2);
    await guest.reload(); await guest.locator('#room-view').waitFor({ state: 'visible' });
    await guest.locator('#leave').click(); await owner.locator('#leave').click();

    // Inject a reproducible eaten meld into a real two-browser server session.
    await owner.goto(`${url}/phom`); await owner.locator('#name').fill('Phom owner'); await owner.locator('#create').click();
    await owner.locator('#room-view').waitFor({ state: 'visible' }); const phomCode = await owner.locator('#room-title').innerText();
    await guest.goto(`${url}/phom?room=${phomCode}`); await guest.locator('#name').fill('Phom guest'); await guest.locator('#join').click();
    await owner.locator('#room-players .player').nth(1).waitFor();
    await owner.locator('#ready').click(); await guest.locator('#ready').click(); await owner.locator('#start:not([disabled])').click();
    await guest.locator('#game-view').waitFor({ state: 'visible' });
    const room = game.gm.phom.rooms.get(phomCode), eater = room.players[1];
    room.phase = 'DISCARD'; room.currentPlayerId = eater.id;
    eater.hand = ['3H', '4H', '5H', '9D'].map(id => ({ id, rank: id.slice(0, -1), suit: id.slice(-1) })); eater.eatenCardIds = ['3H'];
    game.gm.phom.touch(room); game.gm.phom.broadcast(phomCode);
    await guest.waitForFunction(() => document.querySelectorAll('#hand .tl-card').length === 4);
    assert.equal(await guest.locator('#hand .tl-card:disabled').count(), 3);
    assert.equal(await guest.locator('#hand .tl-card:enabled').innerText(), '9♦');
    await guest.locator('#hand .tl-card:enabled').click(); await guest.getByRole('button', { name: /^Đánh/ }).click();
    await guest.waitForFunction(() => document.querySelectorAll('#hand .tl-card').length === 3);
    assert.ok(room.players[1].hand.every(card => ['3H', '4H', '5H'].includes(card.id)));
    assert.deepEqual(errors, []);
    console.log('PASS: profile create/recover reconnect, authenticated/guest missions, protected UNO QR password join/reload, Phom locked meld cards, zero page errors.');
  } finally { QRCode.toString = originalQr; await browser?.close(); await game.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
