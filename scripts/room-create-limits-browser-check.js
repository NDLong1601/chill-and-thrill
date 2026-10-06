'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

const gameIds = ['tien-len', 'sam-loc', 'phom'];

async function main() {
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    let catalog;
    for (const gameId of gameIds) {
      const context = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
      const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${url}/${gameId}`);
      catalog ||= await page.evaluate(async () => (await fetch('/api/registry')).json());
      const gameInfo = catalog.games.find(item => item.gameId === gameId);
      const rules = gameInfo?.stakeRules;
      assert.ok(rules, `${gameId} catalog publishes stakeRules`);
      const capacity = rules.maxPlayers || gameInfo.maxPlayers;
      const capRow = rules.limitsByPlayerCount[String(capacity)];
      assert.ok(capRow, `${gameId} publishes limits for engine-default capacity ${capacity}`);

      const field = page.locator('#create-stake');
      await field.waitFor();
      await page.waitForFunction(() => {
        const input = document.getElementById('create-stake');
        return input && !input.disabled && input.min && input.max && document.getElementById('create-stake-limit').textContent.includes('bàn tối đa');
      });
      assert.equal(await field.getAttribute('min'), String(rules.minStake));
      assert.equal(await field.getAttribute('max'), String(capRow.maxStake));
      const limitText = await page.locator('#create-stake-limit').innerText();
      assert.ok(limitText.includes(rules.minStake.toLocaleString('vi-VN')), limitText);
      assert.ok(limitText.includes(capRow.maxStake.toLocaleString('vi-VN')), limitText);
      assert.ok(limitText.includes(`tối đa ${capacity} người`), limitText);

      await field.fill(String(rules.minStake)); await field.blur();
      assert.equal(await field.evaluate(input => input.validity.valid), true, `${gameId} accepts exact minimum in UI`);
      await field.fill(String(capRow.maxStake)); await field.blur();
      assert.equal(await field.evaluate(input => input.validity.valid), true, `${gameId} accepts exact maximum in UI`);
      assert.equal(game.gm[gameId === 'tien-len' ? 'tienLen' : gameId === 'sam-loc' ? 'samLoc' : 'phom'].rooms.size, 0, 'limit boundary checks do not create or start a room');

      await page.locator('#name').fill('A05 limit');
      await field.fill(String(capRow.maxStake + 1)); await field.blur();
      assert.equal(await field.evaluate(input => input.validity.valid), false, `${gameId} marks max + 1 invalid in UI`);
      await page.locator('#create').click();
      await page.waitForFunction(() => document.getElementById('notice').textContent.length > 0);
      assert.equal(game.gm[gameId === 'tien-len' ? 'tienLen' : gameId === 'sam-loc' ? 'samLoc' : 'phom'].rooms.size, 0, `${gameId} blocks max + 1 before a room is created`);
      await context.close();
    }

    const legacyCatalog = structuredClone(catalog);
    const legacyTienLen = legacyCatalog.games.find(item => item.gameId === 'tien-len');
    delete legacyTienLen.stakeRules;
    const fallbackContext = await browser.newContext({ viewport: { width: 844, height: 390 } });
    const fallbackPage = await fallbackContext.newPage(); fallbackPage.setDefaultTimeout(10000); fallbackPage.on('pageerror', error => errors.push(error.message));
    await fallbackPage.route('**/api/registry', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(legacyCatalog) }));
    await fallbackPage.goto(`${url}/tien-len`);
    const fallbackField = fallbackPage.locator('#create-stake');
    await fallbackPage.waitForFunction(() => {
      const input = document.getElementById('create-stake');
      return input && !input.disabled && document.getElementById('create-stake-limit').textContent.includes('máy chủ sẽ kiểm tra');
    });
    assert.equal(await fallbackField.getAttribute('min'), null, 'legacy catalog does not get an invented minimum');
    assert.equal(await fallbackField.getAttribute('max'), null, 'legacy catalog does not get an invented maximum');
    await fallbackField.fill(String(legacyTienLen.stake)); await fallbackField.blur();
    assert.equal(await fallbackField.inputValue(), legacyTienLen.stake.toLocaleString('vi-VN'), 'legacy server default is still used when supplied by catalog');
    assert.deepEqual(errors, [], 'native limit UI has no browser errors');
    await fallbackContext.close();
    console.log('PASS: native stake UI uses catalog min/max for engine-default capacity, blocks max+1, and leaves legacy catalogs to server validation.');
  } finally { await browser?.close(); await game.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
