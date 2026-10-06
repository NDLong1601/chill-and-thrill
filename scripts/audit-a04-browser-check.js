'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-a04-browser-'));
  const game = createGameServer({ storageFile: path.join(directory, 'rooms.json'), databaseFile: path.join(directory, 'profiles.sqlite') });
  let browser;
  try {
    await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${game.server.address().port}`;
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const contexts = [], errors = [];
    for (const name of ['Storage host', 'Storage guest']) {
      const created = game.gm.profiles.createProfile({ displayName: name });
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript(token => localStorage.setItem('chill-thrill:profile-token', token), created.sessionToken);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(12000);
      await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      contexts.push({ context, page, profileId: created.profile.id, name });
    }
    const [host, guest] = contexts;
    await host.page.goto(`${url}/profile`);
    await host.page.waitForFunction(() => !!window.StorageStatus);
    game.gm.phom.storageError = true;
    await host.page.evaluate(() => StorageStatus.refresh(document.getElementById('storage-status')));
    assert.match(await host.page.locator('#storage-status').innerText(), /Phỏm/);
    assert.equal(await host.page.locator('#storage-status').getAttribute('data-level'), 'blocked');
    for (const width of [320, 390, 844, 1280]) {
      await host.page.setViewportSize({ width, height: width === 844 ? 390 : 900 });
      const box = await host.page.locator('#storage-status').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
    }
    await host.page.setViewportSize({ width: 390, height: 844 });
    fs.mkdirSync(path.resolve('test-results'), { recursive: true });
    await host.page.screenshot({ path: path.resolve('test-results/storage-A04-profile-mobile-20261006.png'), fullPage: true });
    game.gm.phom.storageError = false;
    await host.page.evaluate(() => StorageStatus.refresh(document.getElementById('storage-status')));
    assert.equal(await host.page.locator('#storage-status').isVisible(), false);

    await host.page.setViewportSize({ width: 1280, height: 900 });
    await host.page.goto(`${url}/tien-len`);
    await host.page.locator('#name').fill(host.name);
    await host.page.locator('#create').click();
    await host.page.locator('#room-view:not([hidden])').waitFor();
    const code = await host.page.locator('#room-title').innerText();
    await guest.page.goto(`${url}/tien-len?room=${code}`);
    await guest.page.locator('#name').fill(guest.name);
    await guest.page.locator('#join').click();
    await guest.page.locator('#room-view:not([hidden])').waitFor();
    await host.page.locator('#room-players .player').nth(1).waitFor();
    const hostPreflight = host.page.locator('[data-room-preflight]:visible');
    const guestPreflight = guest.page.locator('[data-room-preflight]:visible');
    await hostPreflight.getByRole('heading', { name: 'Chưa thể bắt đầu', exact: true }).waitFor();
    assert.match(await hostPreflight.innerText(), /Sẽ giữ khi bắt đầu: 100 coin/);
    assert.match(await hostPreflight.innerText(), /Storage guest/);
    assert.equal(await guestPreflight.getByRole('heading', { name: 'Chưa thể bắt đầu', exact: true }).count(), 0);
    assert.match(await guestPreflight.innerText(), /Chủ phòng sẽ bắt đầu/);
    await host.page.locator('#ready').click();
    await guest.page.locator('#ready').click();
    await hostPreflight.getByRole('heading', { name: 'Có thể bắt đầu', exact: true }).waitFor();
    await host.page.waitForFunction(() => !!window.StorageWarning);
    game.gm.phom.storageError = true;
    await host.page.evaluate(() => StorageWarning.refresh());
    assert.match(await host.page.locator('#storage-status').innerText(), /Phỏm/);
    await host.page.locator('#start').click();
    await host.page.waitForFunction(() => document.getElementById('notice')?.textContent.includes('Phỏm'));
    const room = game.gm.tienLen.rooms.get(code);
    assert.equal(room.phase, 'WAITING');
    for (const member of contexts) assert.equal(game.gm.profiles.publicProfile(member.profileId).balances.coin.reserved, 0);
    game.gm.phom.storageError = false;
    await host.page.evaluate(() => StorageWarning.refresh());
    assert.equal(await host.page.locator('#storage-status').isVisible(), false);
    await host.page.locator('#start').click();
    await host.page.locator('#game-view:not([hidden])').waitFor();
    assert.equal(await hostPreflight.isVisible(), false);
    assert.notEqual(room.phase, 'WAITING');
    for (const member of contexts) assert.equal(game.gm.profiles.publicProfile(member.profileId).balances.coin.reserved, 100);
    assert.deepEqual(errors, []);
    await Promise.all(contexts.map(member => member.context.close()));
    console.log('PASS A04 profile/native warnings, recovery, 320/390/844/1280, actual blocked coin start and wallet preservation; B01 host/guest waiting preflight and readiness transitions.');
  } finally {
    await browser?.close();
    await game.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
