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
    const guestContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    const host = await hostContext.newPage(), guest = await guestContext.newPage();
    for (const page of [host, guest]) { page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message)); await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()); }
    await host.goto(`${url}/poker`); await host.locator('#name').fill('Chủ Poker'); await host.locator('#create').click(); await host.locator('#room-view:not([hidden])').waitFor(); const code = await host.locator('#room-title').innerText();
    await guest.goto(`${url}/poker?room=${code}`); await guest.locator('#name').fill('Khách Poker'); await guest.locator('#join').click(); await host.locator('#room-players .player').nth(1).waitFor();
    await host.locator('#buyin').click(); await host.locator('#room-stack').waitFor({ state: 'visible' }); await host.waitForFunction(() => document.querySelector('#room-stack').textContent === '200');
    await guest.locator('#buyin').click(); await guest.waitForFunction(() => document.querySelector('#room-stack').textContent === '200');
    await host.locator('#ready').click(); await guest.locator('#ready').click(); await host.locator('#start:not([hidden])').click(); await host.locator('#game-view:not([hidden])').waitFor(); await guest.locator('#game-view:not([hidden])').waitFor();
    assert.equal(await host.locator('#hole-cards .playing-card').count(), 2); assert.equal(await guest.locator('#hole-cards .playing-card').count(), 2);
    const hostTurn = /Đến lượt bạn/.test(await host.locator('#phase-banner').innerText()), actor = hostTurn ? host : guest, responder = hostTurn ? guest : host;
    await actor.getByRole('button', { name: /All-in đến/ }).click(); await responder.getByRole('button', { name: /Call|All-in/ }).first().click();
    await host.locator('#result:not([hidden])').waitFor(); await guest.locator('#result:not([hidden])').waitFor();
    assert.match(await host.locator('#result').innerText(), /Pot đã chia: 400 chip/);
    const layout = await guest.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, cards: document.querySelectorAll('.playing-card').length }));
    assert.ok(layout.scrollWidth <= layout.width + 1, `Poker page overflows horizontally: ${JSON.stringify(layout)}`); assert.ok(layout.cards >= 7); assert.deepEqual(errors, []);
  } finally { await browser?.close(); await game.close(); }
}

main().then(() => console.log('Poker browser check passed.')).catch(error => { console.error(error); process.exitCode = 1; });
