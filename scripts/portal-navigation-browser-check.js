'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

async function main() {
  const game = createGameServer({ databaseFile: ':memory:' });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    const store = game.gm.profiles;
    const profile = store.createProfile({ displayName: 'Người chơi có tên dài 1234567890', avatar: '🎲' });
    for (const [currency, amount] of [['chip', 999999000], ['coin', 999999999000], ['gem', 999999]]) {
      const operationKey = `r06-navigation-${currency}`;
      store.executeOperation('fixture', operationKey, { currency, amount }, at => store.writeWallet(profile.profile.id, amount, 0,
        { operationKey, currency, source: 'fixture', note: 'In-memory navigation fixture', at }));
    }
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext();
    await context.addInitScript(token => {
      localStorage.setItem('chill-thrill:profile-token', token);
      localStorage.setItem('gang.profileToken', token);
    }, profile.sessionToken);
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${game.server.address().port}/`);
    await page.waitForFunction(() => document.querySelector('#portal-nav-chip')?.textContent.includes('1.000.000.000'));
    for (const width of [390, 701, 900, 1024, 1180, 1280, 1366, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('#btn-tab-lobby').click();
      const menu = page.locator('.portal-nav-link');
      for (let i = 0; i < await menu.count(); i++) {
        if (await menu.nth(i).isVisible()) await menu.nth(i).click({ trial: true });
      }
      await page.locator('#btn-tab-profile').click();
      await page.locator('#account-tab-wallet').click();
      await page.locator('#wallet-exchange').waitFor({ state: 'visible' });
      const layout = await page.evaluate(() => {
        const nav = document.querySelector('#portal-navbar');
        const controls = [...nav.querySelectorAll('button, a, [role="button"]')].filter(element => element.getClientRects().length);
        return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
          outside: controls.filter(element => {
            const box = element.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1;
          }).map(element => element.id || element.className) };
      });
      assert.ok(layout.scrollWidth <= width + 1, `${width}px page overflows: ${JSON.stringify(layout)}`);
      assert.deepEqual(layout.outside, [], `${width}px navigation controls must fit`);
      await page.locator('#btn-tab-lobby').focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('#btn-tab-lobby').getAttribute('aria-selected'), 'true');
      const outline = await page.locator('#btn-tab-lobby').evaluate(element => getComputedStyle(element).outlineStyle);
      assert.notEqual(outline, 'none', 'keyboard focus remains visible');
      if (width === 1280) await page.screenshot({ path: 'test-results/fixes-r06-navigation-1280.png' });
    }
    assert.deepEqual(errors, []);
    console.log('R06 navigation passed at 390/701/900/1024/1180/1280/1366/1440/1920px: long name, large balances, unobstructed menu/profile/wallet clicks and keyboard focus.');
  } finally { await browser?.close(); await game.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
