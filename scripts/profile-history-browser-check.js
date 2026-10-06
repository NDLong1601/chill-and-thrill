'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-b02-browser-'));
  const game = createGameServer({ storageFile: path.join(directory, 'rooms.json'), databaseFile: path.join(directory, 'profiles.sqlite') });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${game.server.address().port}`;
  const store = game.gm.profiles;
  const owner = store.createProfile({ displayName: 'History browser owner', avatar: '🥷' });
  const stranger = store.createProfile({ displayName: 'Private other owner' });
  const held = store.reserveMany({ currency: 'coin', roomCode: 'B02C', matchId: 'b02-browser-refund', operationKey: 'tien-len:reserve:b02-browser-refund', reservations: [{ profileId: owner.profile.id, amount: 100 }] });
  store.releaseReservations({ reservations: held.held, roomCode: 'B02C', matchId: 'b02-browser-refund', operationKey: 'tien-len:cancel:b02-browser-refund', note: 'Hoàn coin của fixture' });
  store.executeOperation('fixture', 'b02-browser-gem', { profileId: owner.profile.id }, at => store.writeWallet(owner.profile.id, 1, 0, { operationKey: 'b02-browser-gem', source: 'fixture', note: 'Gem fixture', at, currency: 'gem' }));
  store.exchangeCurrency(owner.profile.id, { direction: 'gem-to-coin', gems: 1, operationKey: 'b02-browser-exchange' });
  for (let index = 0; index < 31; index++) store.recordCompletedMatch({ matchId: `b02-browser-match-${String(index).padStart(2, '0')}`, gameId: 'uno', roomCode: 'B02G', completedAt: '2026-10-05T18:00:00.000Z', players: [{ profileId: owner.profile.id, outcome: 'WIN' }], result: { winnerName: '<img src=x onerror=window.__historyXss=true>', reason: `Kết quả ${index}`, privateHand: ['PRIVATE-CARD'] } });
  store.recordCompletedMatch({ matchId: 'b02-stranger-private-match', gameId: 'bang', roomCode: 'NOPE', completedAt: '2026-10-05T18:00:00.000Z', players: [{ profileId: stranger.profile.id, outcome: 'WIN' }], result: { winnerName: 'Private other owner' } });
  store.recordCompletedMatch({ matchId: 'b02-browser-chip-result', gameId: 'tien-len', roomCode: 'COLD', completedAt: '2026-10-05T18:00:00.000Z', players: [{ profileId: owner.profile.id, outcome: 'WIN' }], result: { stake: 50, pot: 100, currency: 'chip' } });
  const errors = [];
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await context.addInitScript(token => {
      if (location.protocol === 'http:' || location.protocol === 'https:') localStorage.setItem('chill-thrill:profile-token', token);
    }, owner.sessionToken);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(`${base}/profile`);
    await page.locator('#profile').waitFor({ state: 'visible' });
    assert.match(await page.locator('#ledger').innerText(), /Khả dụng/);
    assert.match(await page.locator('#ledger').innerText(), /Đang giữ/);
    assert.match(await page.locator('#ledger').innerText(), /Tổng tài sản/);
    await page.evaluate(() => {
      const saved = localStorage.getItem('chill-thrill:profile-token');
      localStorage.removeItem('chill-thrill:profile-token');
      localStorage.setItem('gang.profileToken', saved);
    });
    await page.reload();
    await page.locator('#profile').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => Boolean(localStorage.getItem('chill-thrill:profile-token'))), true,
      'legacy profile token remains valid and is copied to the current token key');
    await page.locator('a[href="/history"]').click();
    await page.locator('#history-list .history-item').first().waitFor();
    await page.waitForFunction(() => !document.getElementById('history-status').textContent.includes('Đang tải'));
    assert.equal(await page.locator('#history-list .history-item').count(), 20);
    await page.locator('#history-more').click();
    await page.waitForFunction(() => document.querySelectorAll('#history-list .history-item').length > 20);
    const rendered = await page.locator('#history-list').innerText();
    assert.equal(rendered.includes('Private other owner'), false);
    assert.equal(rendered.includes('PRIVATE-CARD'), false);
    assert.equal(await page.locator('#history-list img').count(), 0, 'untrusted result text cannot create an image node');
    assert.equal(await page.evaluate(() => window.__historyXss === true), false);

    async function filter(values) {
      await page.locator('#history-reset').click();
      await page.waitForFunction(() => !document.getElementById('history-status').textContent.includes('Đang tải'));
      for (const [name, value] of Object.entries(values)) {
        const field = page.locator(`#history-filters [name="${name}"]`);
        if (['gameId', 'group', 'currency'].includes(name)) await field.selectOption(value);
        else await field.fill(value);
      }
      await page.locator('#history-filters button[type="submit"]').click();
      await page.waitForFunction(() => !document.getElementById('history-status').textContent.includes('Đang tải'));
    }
    await filter({ group: 'hold', gameId: 'tien-len', currency: 'coin', roomCode: 'B02C' });
    assert.equal(await page.locator('#history-list .history-item').count(), 1);
    assert.match(await page.locator('#history-list').innerText(), /Khả dụng thay đổi\s*-100/);
    assert.match(await page.locator('#history-list').innerText(), /Đang giữ thay đổi\s*\+100/);
    assert.match(await page.locator('#history-list').innerText(), /Tổng tài sản thay đổi\s*0/);
    await filter({ group: 'exchange' });
    assert.equal(await page.locator('#history-list .history-item').count(), 1);
    assert.equal(await page.locator('#history-list .receipt-currency').count(), 2);
    assert.match(await page.locator('#history-list').innerText(), /10\.000\.000/);
    assert.match(await page.locator('#history-list').innerText(), /Gem/);
    await filter({ group: 'match', gameId: 'tien-len', roomCode: 'COLD' });
    assert.match(await page.locator('#history-list').innerText(), /Mức cược 50 chip/);
    assert.match(await page.locator('#history-list').innerText(), /Pot 100 chip/);
    await filter({ group: 'match', gameId: 'uno', from: '2026-10-06', to: '2026-10-06', roomCode: 'B02G' });
    assert.equal(await page.locator('#history-list .history-item').count(), 20);
    await page.locator('#history-more').click();
    await page.waitForFunction(() => document.querySelectorAll('#history-list .history-item').length === 31);
    assert.equal(await page.locator('#history-more').isVisible(), false);
    const resultNames = await page.locator('#history-list .history-result').allTextContents();
    assert.equal(new Set(resultNames.filter(name => /^Kết quả \d+$/.test(name))).size, 31, 'same-time pagination preserves all matches once');
    for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(geometry.scroll <= geometry.width, `History fits ${viewport.width}x${viewport.height}: ${JSON.stringify(geometry)}`);
    }
    await filter({ roomCode: 'EMPTY' });
    await page.locator('#history-empty').waitFor({ state: 'visible' });
    await page.route('**/api/history?**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture lưu trữ tạm thời không sẵn sàng.' }) }));
    await page.locator('#history-filters button[type="submit"]').click();
    await page.waitForFunction(() => document.getElementById('history-status').textContent.includes('không sẵn sàng'));
    await page.unroute('**/api/history?**');
    await filter({ group: 'refund' });
    assert.equal(await page.locator('#history-list .history-item').count(), 1, 'normal history can be retried after a server error');

    let releaseDelayed, capturedDelayed, deliveredDelayed;
    const delayedGate = new Promise(resolve => { releaseDelayed = resolve; });
    const captured = new Promise(resolve => { capturedDelayed = resolve; });
    const delivered = new Promise(resolve => { deliveredDelayed = resolve; });
    let holdFirst = true;
    await page.route('**/api/history?**', async route => {
      if (!holdFirst) return route.continue();
      holdFirst = false;
      const response = await route.fetch();
      capturedDelayed();
      await delayedGate;
      await route.fulfill({ response });
      deliveredDelayed();
    });
    await page.locator('#history-reset').click();
    await captured;
    await page.locator('#history-filters [name="group"]').selectOption('exchange');
    await page.locator('#history-filters button[type="submit"]').click();
    releaseDelayed();
    await delivered;
    await page.waitForFunction(() => !document.getElementById('history-status').textContent.includes('Đang tải'));
    assert.equal(await page.locator('#history-list .history-item').count(), 1, 'a new filter supersedes an in-flight old response');
    assert.match(await page.locator('#history-list').innerText(), /Quy đổi coin\/gem/);
    await page.unroute('**/api/history?**');
    await page.setViewportSize({ width: 390, height: 844 });
    fs.mkdirSync(path.join(__dirname, '..', 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'history-B02-mobile-20261006.png'), fullPage: true });

    const anonymous = await browser.newContext();
    anonymous.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const guestPage = await anonymous.newPage();
    await guestPage.goto(`${base}/history`);
    await guestPage.locator('#history-auth').waitFor({ state: 'visible' });
    assert.equal(await guestPage.locator('#history-list .history-item').count(), 0);
    const blocked = await browser.newContext();
    blocked.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    await blocked.addInitScript(() => { Storage.prototype.getItem = () => { throw new DOMException('Blocked', 'SecurityError'); }; });
    const blockedPage = await blocked.newPage();
    await blockedPage.goto(`${base}/history`);
    await blockedPage.locator('#history-auth').waitFor({ state: 'visible' });
    await blockedPage.goto(`${base}/profile`);
    await blockedPage.locator('#guest').waitFor({ state: 'visible' });
    assert.equal(await blockedPage.locator('#profile').evaluate(element => element.hidden), true,
      'profile bootstrap should remain usable as a guest when browser storage is blocked');
    assert.deepEqual(errors, [], 'no browser errors for history, profile, untrusted text or blocked storage');
    await context.close(); await anonymous.close(); await blocked.close();
    console.log('PASS B02: profile deltas, ownership/XSS, hold/refund/exchange receipts, historical chip units, filters/stale-response race, stable same-time pagination, 320/390/844/1280 layouts, empty/error retry and unauthenticated/blocked storage states.');
  } finally {
    await browser?.close();
    await game.close();
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('history-b02-browser-')) throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
