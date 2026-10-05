'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

async function main() {
  const game = createGameServer(); await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`; let browser; const errors = [];
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const hostContext = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const host = await hostContext.newPage(), guest = await guestContext.newPage();
    for (const page of [host, guest]) { page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message)); await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()); }
    await host.goto(`${url}/tien-len`); await host.locator('#name').fill('Chủ bàn'); await host.locator('#create').click(); await host.locator('#room-view:not([hidden])').waitFor(); const code = await host.locator('#room-title').innerText();
    await guest.goto(`${url}/tien-len?room=${code}`); await guest.locator('#name').fill('Bạn bàn'); await guest.locator('#join').click(); await host.locator('#room-players .player').nth(1).waitFor();
    await host.locator('#ready').click(); await guest.locator('#ready').click(); await host.locator('#start:not([hidden])').click(); await host.locator('#game-view:not([hidden])').waitFor(); await guest.locator('#game-view:not([hidden])').waitFor();
    assert.equal(await host.locator('#hand .tl-card').count(), 13); assert.equal(await guest.locator('#hand .tl-card').count(), 13); assert.match(await host.locator('#phase-banner').innerText(), /Đến lượt/);
    const layout = await guest.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, cards: document.querySelectorAll('#hand .tl-card').length }));
    assert.ok(layout.scrollWidth <= layout.width + 1, `Tiến lên page overflows horizontally: ${JSON.stringify(layout)}`); assert.deepEqual(errors, []);
  } finally { await browser?.close(); await game.close(); }
}

main().then(() => console.log('Tiến lên browser check passed.')).catch(error => { console.error(error); process.exitCode = 1; });
