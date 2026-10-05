'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

async function main() {
  const game = createGameServer(); await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${game.server.address().port}`; let browser; const errors = [];
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true }); const hostContext = await browser.newContext({ viewport: { width: 1280, height: 850 } }); const guests = await Promise.all(Array.from({ length: 3 }, () => browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }))); const pages = [await hostContext.newPage(), ...(await Promise.all(guests.map(context => context.newPage())))];
    for (const page of pages) { page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message)); await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()); }
    const [host, ...players] = pages; await host.goto(`${url}/bang`); await host.locator('#name').fill('Chủ BANG'); await host.locator('#create').click(); await host.locator('#room-view:not([hidden])').waitFor(); const code = await host.locator('#room-title').innerText();
    for (let index = 0; index < players.length; index += 1) { await players[index].goto(`${url}/bang?room=${code}`); await players[index].locator('#name').fill(`Bạn BANG ${index + 1}`); await players[index].locator('#join').click(); }
    await host.locator('#room-players .player').nth(3).waitFor(); for (const page of pages) await page.locator('#ready').click(); await host.locator('#start:not([hidden])').click(); await Promise.all(pages.map(page => page.locator('#game-view:not([hidden])').waitFor())); assert.ok(await host.locator('#hand .bang-card').count() >= 2); const mobile = players[0]; const layout = await mobile.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, cards: document.querySelectorAll('#hand .bang-card').length })); assert.ok(layout.scrollWidth <= layout.width + 1, `BANG! page overflows horizontally: ${JSON.stringify(layout)}`); assert.deepEqual(errors, []);
  } finally { await browser?.close(); await game.close(); }
}
main().then(() => console.log('BANG! browser check passed.')).catch(error => { console.error(error); process.exitCode = 1; });
