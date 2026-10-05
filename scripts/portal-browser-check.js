'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

async function main() {
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    desktop.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const host = await desktop.newPage(); host.setDefaultTimeout(8000);
    await host.goto(url);
    await host.locator('#screen-home.active').waitFor();
    await host.locator('#portal-player-name').fill('Portal Host');
    await host.locator('[data-game-card-action="uno"]').click();
    await host.locator('#detail-max-players').selectOption('2');
    await host.locator('#detail-create').click();
    await host.locator('#screen-waiting.active').waitFor();
    const code = await host.locator('#disp-room-code').innerText();
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    mobile.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const friend = await mobile.newPage(); friend.setDefaultTimeout(8000);
    await friend.goto(`${url}/rooms/${code}`);
    await friend.locator('#portal-player-name').fill('Portal Friend');
    await friend.locator('#portal-join').click();
    await friend.locator('#screen-waiting.active').waitFor();
    await host.locator('#btn-ready').click(); await friend.locator('#btn-ready').click();
    await host.waitForFunction(() => !document.getElementById('btn-start-game').disabled);
    await host.locator('#btn-start-game').click();
    await host.locator('#screen-uno.active').waitFor();
    await friend.locator('#screen-uno.active').waitFor();
    assert.equal(await host.evaluate(() => lastState.variant), 'classic-local-v1');
    assert.equal(await host.evaluate(() => lastState.myHand.length), await host.evaluate(() => lastState.topCard.type === 'draw2' ? 9 : 7));
    await host.reload();
    await host.locator('#screen-uno.active').waitFor();
    await mobile.close(); await desktop.close();

    for (const gameId of ['uno', 'tien-len', 'poker', 'sam-loc', 'phom', 'bang']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      const page = await context.newPage(); page.setDefaultTimeout(8000);
      await page.goto(url);
      await page.locator('#portal-player-name').fill(`Portal ${gameId}`);
      await page.locator(`[data-game-card-action="${gameId}"]`).click();
      if (gameId === 'uno') await page.locator('#detail-uno-variant').selectOption('classic-108-v1');
      await page.locator('#detail-create').click();
      await page.waitForURL(new RegExp(`/${gameId}\\?room=`));
      await page.locator('#room-view').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => Boolean(localStorage.getItem('chill-thrill:profile-token'))), true);
      const identity = await page.evaluate(async () => (await fetch('/api/profile', { headers: { 'X-Profile-Token': localStorage.getItem('chill-thrill:profile-token') } })).json());
      assert.equal(identity.profile.wallet.available, 1000);
      assert.equal(game.gm.profiles.db.prepare('SELECT available FROM wallets WHERE profile_id = ?').get(identity.profile.playerId).available, 1000);
      await page.locator('#leave').click();
      await page.locator('#home-view').waitFor({ state: 'visible' });
      await context.close();
    }
    assert.deepEqual(errors, [], 'No browser page errors across imported and existing games');
    console.log('PASS: portal UNO 112 create/join/start/reload, UNO 108 and all M4–M6 portal-to-table links, one shared profile/wallet, zero page errors.');
  } finally { await browser?.close(); await game.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
