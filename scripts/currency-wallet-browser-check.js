'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');
const { COIN_PER_GEM } = require('../src/platform/currencies');

async function waitForQuote(page, pattern) {
  await page.waitForFunction(expected => {
    const preview = document.querySelector('[data-exchange-preview]');
    return preview && new RegExp(expected).test(preview.textContent);
  }, pattern, { timeout: 8000 });
}

async function runSurface(game, browser, route, viewport, dropFirstResponse) {
  const store = game.gm.profiles;
  const profile = store.createProfile({ displayName: `B03 ${route} ${viewport.width}`, avatar: '🎲' });
  const testCoins = dropFirstResponse ? COIN_PER_GEM - 1000 : 2 * COIN_PER_GEM;
  const operationKey = `b03-browser-credit-${profile.profile.id}`;
  store.executeOperation('b03_browser_fixture', operationKey, { profileId: profile.profile.id, testCoins }, at =>
    store.writeWallet(profile.profile.id, testCoins, 0, { operationKey, source: 'fixture', note: 'Temporary B03 browser fixture', at, currency: 'coin' }));

  const context = await browser.newContext({ viewport });
  await context.addInitScript(token => {
    localStorage.setItem('chill-thrill:profile-token', token);
    localStorage.setItem('gang.profileToken', token);
  }, profile.sessionToken);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  let dropped = false;
  if (dropFirstResponse) {
    await page.route('**/api/wallet/exchange', async requestRoute => {
      const response = await requestRoute.fetch();
      if (!dropped) {
        dropped = true;
        assert.equal(response.status(), 200, 'the first exchange must commit before its response is dropped');
        await requestRoute.abort('connectionreset');
      } else await requestRoute.fulfill({ response });
    });
  }

  try {
    await page.goto(`http://127.0.0.1:${game.server.address().port}${route}`);
    if (route === '/') {
      await page.waitForFunction(() => typeof socket !== 'undefined' && socket.connected);
      await page.locator('#btn-tab-profile').click();
      await page.locator('#account-tab-wallet').click();
    }
    await page.waitForFunction(() => {
      const form = document.querySelector('#wallet-exchange');
      return form && !form.hidden && getComputedStyle(form).display !== 'none';
    });
    await page.waitForFunction(() => document.querySelector('[data-exchange-preview]')?.textContent.includes('Xem trước: trừ'));
    const form = page.locator('#wallet-exchange');
    const gems = form.locator('[name="gems"]');
    const submit = form.locator('button[type="submit"]');
    const max = form.locator('[data-exchange-max]');
    const preview = form.locator('[data-exchange-preview]');
    const initialMax = dropFirstResponse ? '1 gem' : '2 gem';
    await assertEventuallyText(max, initialMax);

    const geometry = await form.evaluate(element => {
      const box = element.getBoundingClientRect();
      const previewNode = element.querySelector('[data-exchange-preview]');
      return { left: box.left, right: box.right, width: box.width, viewport: innerWidth,
        previewFits: previewNode.scrollWidth <= previewNode.clientWidth + 1 };
    });
    assert.ok(geometry.width > 0 && geometry.left >= -1 && geometry.right <= geometry.viewport + 1,
      `${route} exchange form should fit ${viewport.width}px viewport: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.previewFits, true, `${route} quote text should wrap at ${viewport.width}px`);

    await max.click();
    await gems.waitFor({ state: 'visible' });
    assert.equal(await gems.inputValue(), dropFirstResponse ? '1' : '2');
    await waitForQuote(page, dropFirstResponse ? 'trừ 10\\.000\\.000 coin' : 'trừ 20\\.000\\.000 coin');
    await gems.fill('1');
    await waitForQuote(page, 'trừ 10\\.000\\.000 coin');
    assert.match(await preview.innerText(), /nhận 1 gem/);
    assert.equal(await submit.innerText(), 'Xác nhận quy đổi');

    await submit.click();
    if (dropFirstResponse) {
      await page.waitForFunction(() => document.querySelector('#wallet-exchange [data-exchange-message]')?.textContent);
      await page.getByRole('button', { name: 'Kiểm tra lần gửi trước' }).waitFor({ state: 'visible' });
      assert.equal(store.publicProfile(profile.profile.id).balances.gem.available, 1,
        'the simulated lost response should follow a committed first exchange');
      assert.equal(store.publicProfile(profile.profile.id).balances.coin.available, 0);
      await page.getByRole('button', { name: 'Kiểm tra lần gửi trước' }).click();
      await page.waitForFunction(() => document.querySelector('#wallet-exchange [data-exchange-message]')?.textContent.includes('giao dịch trước đó'));
      assert.equal(store.listLedger(profile.profile.id).filter(row => row.source === 'exchange').length, 2,
        'retry after the lost response must not add another pair of ledger rows');
    } else {
      await page.waitForFunction(() => document.querySelector('#wallet-exchange [data-exchange-message]')?.textContent.includes('Đã quy đổi'));
      assert.equal(store.publicProfile(profile.profile.id).balances.gem.available, 1);
      assert.equal(store.listLedger(profile.profile.id).filter(row => row.source === 'exchange').length, 2);
    }

    await form.locator('[name="direction"]').selectOption('gem-to-coin');
    await waitForQuote(page, 'trừ 1 gem.*nhận 10\\.000\\.000 coin');
    assert.match(await preview.innerText(), /nhận 10\.000\.000 coin/);
    assert.equal(await gems.inputValue(), '1', 'changing direction must preserve the entered gem amount');
    await submit.click();
    await page.waitForFunction(() => document.querySelector('#wallet-exchange [data-exchange-message]')?.textContent.includes('Đã quy đổi'));
    assert.equal(store.publicProfile(profile.profile.id).balances.gem.available, 0);
    assert.equal(store.publicProfile(profile.profile.id).balances.coin.available, testCoins + 1000);
    assert.deepEqual(pageErrors, [], `unexpected browser errors on ${route} at ${viewport.width}px`);
  } finally {
    await context.close();
  }
}

async function assertEventuallyText(locator, text) {
  await locator.waitFor({ state: 'visible' });
  await locator.page().waitForFunction(({ selector, text: expected }) => document.querySelector(selector)?.textContent.includes(expected),
    { selector: '[data-exchange-max]', text });
}

async function main() {
  const game = createGameServer({ databaseFile: ':memory:' });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    for (const route of ['/profile', '/']) {
      for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
        const dropFirstResponse = route === '/profile' && viewport.width === 390;
        await runSurface(game, browser, route, viewport, dropFirstResponse);
      }
    }
    console.log('Currency wallet browser check passed: portal and /profile at mobile and desktop viewports, including lost-response retry.');
  } finally {
    if (browser) await browser.close();
    await game.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
