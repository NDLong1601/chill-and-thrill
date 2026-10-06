'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  // The server uses its in-memory ProfileStore and room managers; no player files are opened.
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const service = game.roomService.profileService;
  const owner = service.createProfile('A06 Owner', '🥷');
  const ownerId = owner.player.playerId;
  const patches = [];
  let browser;

  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    await context.addInitScript(({ token }) => {
      localStorage.setItem('chill-thrill:profile-token', token);
      localStorage.setItem('gang.profileToken', token);
    }, { token: owner.rawToken });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    let releaseFirstGet;
    const firstGet = new Promise(resolve => { releaseFirstGet = resolve; });
    let delayed = false;
    await page.route('**/api/profile', async route => {
      const request = route.request();
      if (request.method() === 'PATCH') patches.push(JSON.parse(request.postData() || '{}'));
      if (request.method() === 'GET' && !delayed) {
        delayed = true;
        releaseFirstGet();
        const response = await route.fetch();
        await sleep(450);
        await route.fulfill({ response, body: await response.body() });
      } else await route.continue();
    });

    await page.goto(url);
    await page.locator('#screen-home.active').waitFor();
    await page.waitForFunction(() => socket.connected);
    await firstGet;
    // The older 🥷 response arrives after this newer selection and must not restore it.
    await page.locator('#portal-player-name').fill('A06 Race');
    await page.locator('#portal-avatar-picker [data-avatar="💻"]').click();
    await page.waitForFunction(() => document.querySelector('#portal-avatar-picker [data-avatar="💻"]').classList.contains('active'));
    await page.waitForFunction(() => document.querySelector('#portal-nav-avatar').textContent === '💻');
    await page.waitForFunction(() => document.querySelector('#profile-avatar-picker [data-avatar="💻"]').classList.contains('active'));
    assert.equal(await page.locator('#avatar-picker .avatar-opt.active').getAttribute('data-avatar'), '💻', 'legacy room picker follows the same server identity');
    for (let i = 0; i < 40 && service.profiles.publicProfile(ownerId).avatar !== '💻'; i++) await sleep(25);
    assert.equal(service.profiles.publicProfile(ownerId).avatar, '💻', 'newer avatar choice wins over the delayed profile fetch');
    assert.equal(service.profiles.publicProfile(ownerId).displayName, 'A06 Race', 'older profile response does not restore the previous name');
    assert.equal(await page.locator('#portal-nav-name').innerText(), 'A06 Race');
    assert.ok(patches.some(body => JSON.stringify(body) === JSON.stringify({ name: 'A06 Race' })), 'race name PATCH contains only the edited name');
    assert.ok(patches.some(body => JSON.stringify(body) === JSON.stringify({ avatar: '💻' })), 'race avatar PATCH contains only the edited avatar');

    await page.reload();
    await page.locator('#screen-home.active').waitFor();
    await page.waitForFunction(() => document.querySelector('#portal-avatar-picker [data-avatar="💻"]').classList.contains('active'));
    await page.waitForFunction(() => document.querySelector('#profile-avatar-picker [data-avatar="💻"]').classList.contains('active'));
    assert.equal(await page.locator('#avatar-picker .avatar-opt.active').getAttribute('data-avatar'), '💻');

    const patchCount = patches.length;
    await page.locator('#portal-player-name').fill('A06 Renamed');
    await page.locator('#portal-player-name').press('Tab');
    for (let i = 0; i < 40 && service.profiles.publicProfile(ownerId).displayName !== 'A06 Renamed'; i++) await sleep(25);
    assert.equal(service.profiles.publicProfile(ownerId).displayName, 'A06 Renamed');
    assert.ok(patches.slice(patchCount).some(body => JSON.stringify(body) === JSON.stringify({ name: 'A06 Renamed' })), 'name change PATCH contains only name');
    assert.equal(service.profiles.publicProfile(ownerId).avatar, '💻', 'editing the name preserves the selected avatar');

    // Return to 🥷, then create and join a room while keeping the server profile authoritative.
    await page.locator('#portal-avatar-picker [data-avatar="🥷"]').click();
    for (let i = 0; i < 40 && service.profiles.publicProfile(ownerId).avatar !== '🥷'; i++) await sleep(25);
    assert.equal(service.profiles.publicProfile(ownerId).avatar, '🥷');
    await page.locator('[data-game-card-action="the-gang"]').click();
    await page.locator('#detail-create').click();
    await page.locator('#screen-waiting.active').waitFor();
    const code = await page.locator('#disp-room-code').innerText();
    assert.equal(service.profiles.publicProfile(ownerId).avatar, '🥷', 'room creation leaves the saved avatar unchanged');

    const guest = service.createProfile('A06 Guest', '🥷');
    const guestContext = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    await guestContext.addInitScript(({ token }) => {
      localStorage.setItem('chill-thrill:profile-token', token);
      localStorage.setItem('gang.profileToken', token);
    }, { token: guest.rawToken });
    const guestPage = await guestContext.newPage();
    guestPage.setDefaultTimeout(8000);
    guestPage.on('pageerror', error => pageErrors.push(error.message));
    await guestPage.goto(`${url}/rooms/${code}`);
    await guestPage.locator('#portal-player-name').fill('A06 Guest');
    await guestPage.locator('#portal-join').click();
    await guestPage.locator('#screen-waiting.active').waitFor();
    await guestPage.goto(url);
    await guestPage.locator('#screen-home.active').waitFor();
    await guestPage.waitForFunction(() => document.querySelector('#portal-avatar-picker [data-avatar="🥷"]').classList.contains('active'));
    await guestPage.waitForFunction(() => document.querySelector('#profile-avatar-picker [data-avatar="🥷"]').classList.contains('active'));
    assert.equal(service.profiles.publicProfile(guest.player.playerId).avatar, '🥷', 'joining and returning to the portal preserves the guest avatar');

    const freshContext = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const freshPage = await freshContext.newPage();
    freshPage.setDefaultTimeout(8000);
    freshPage.on('pageerror', error => pageErrors.push(error.message));
    await freshPage.goto(url);
    await freshPage.locator('#portal-player-name').fill('A06 New Player');
    await freshPage.locator('#portal-avatar-picker [data-avatar="🥷"]').click();
    await freshPage.locator('[data-game-card-action="the-gang"]').click();
    await freshPage.locator('#detail-create').click();
    await freshPage.locator('#screen-waiting.active').waitFor();
    const freshToken = await freshPage.evaluate(() => localStorage.getItem('chill-thrill:profile-token'));
    const freshId = service.requireProfile(freshToken).player.playerId;
    assert.equal(service.profiles.publicProfile(freshId).displayName, 'A06 New Player');
    assert.equal(service.profiles.publicProfile(freshId).avatar, '🥷', 'a new profile is created with the chosen avatar');
    assert.deepEqual(pageErrors, [], 'browser pages have no uncaught errors');

    await freshContext.close();
    await guestContext.close();
    await context.close();
    console.log('PASS: A06 server-profile hydration, both avatar pickers, reload, name-only PATCH, stale-fetch race, room create/join and return; in-memory fixtures only.');
  } finally {
    await browser?.close();
    await game.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
