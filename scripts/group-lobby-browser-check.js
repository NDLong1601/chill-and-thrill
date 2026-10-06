'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTemporaryDirectory, removeTemporaryDirectory } = require('./helpers/temporary-directory');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

async function createProfile(base, name) {
  const response = await fetch(`${base}/api/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, avatar: '🎲' }) });
  assert.equal(response.status, 201);
  return response.json();
}

async function waitUntil(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for both target seats to reconnect.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function main() {
  const directory = createTemporaryDirectory('group-lobby-browser');
  const game = createGameServer({
    databaseFile: path.join(directory, 'profiles.sqlite'),
    storageFile: path.join(directory, 'rooms.json'),
    unoStorageFile: path.join(directory, 'uno.json'),
    tienLenStorageFile: path.join(directory, 'tien-len.json'),
    pokerStorageFile: path.join(directory, 'poker.json'),
    samLocStorageFile: path.join(directory, 'sam-loc.json'),
    phomStorageFile: path.join(directory, 'phom.json'),
    bangStorageFile: path.join(directory, 'bang.json'),
    graceMs: 60_000,
  });
  let browser;
  const pageErrors = [];
  const externalRequests = [];
  try {
    await new Promise((resolve, reject) => {
      game.server.once('error', reject);
      game.server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${game.server.address().port}`;
    const hostProfile = await createProfile(base, 'Nhóm trưởng');
    const guestProfile = await createProfile(base, 'Bạn chơi');
    const installedChromium = [process.env.CHROME_PATH,
      process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
      process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
    ].find(candidate => candidate && fs.existsSync(candidate));
    browser = await chromium.launch({ headless: true, ...(installedChromium ? { executablePath: installedChromium } : { channel: process.env.GANG_BROWSER_CHANNEL || 'chrome' }) });
    async function makePage(profileToken) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await context.addInitScript(token => {
        localStorage.setItem('chill-thrill:profile-token', token);
        localStorage.setItem('gang.profileToken', token);
      }, profileToken);
      const page = await context.newPage();
      page.on('pageerror', error => pageErrors.push(error.message));
      page.on('request', request => {
        if (new URL(request.url()).origin !== base) externalRequests.push(request.url());
      });
      await page.goto(`${base}/group-lobby`);
      await page.locator('#lobby').waitFor({ state: 'hidden' });
      return { context, page };
    }
    const host = await makePage(hostProfile.profileToken);
    const guest = await makePage(guestProfile.profileToken);
    await host.page.locator('#create-group').click();
    await host.page.locator('#invite-share:not(.hidden)').waitFor();
    const invite = await host.page.locator('#invite-output').inputValue();
    assert.ok(invite.length >= 32);
    await guest.page.locator('#invite-input').fill(invite);
    await guest.page.locator('#join-group').click();
    await guest.page.locator('#members .member').nth(1).waitFor();
    await host.page.waitForFunction(() => document.getElementById('member-count').textContent === '2 / 12');
    const groupId = await host.page.evaluate(() => sessionStorage.getItem('chill-thrill:group-lobby:active'));
    assert.equal(await host.page.locator('#tournament-link').getAttribute('href'), `/groups/tournament.html?group=${groupId}`);
    assert.match(await guest.page.locator('#members').innerText(), /Nhóm trưởng[\s\S]*Bạn chơi|Bạn chơi[\s\S]*Nhóm trưởng/);

    await host.page.locator('#game-select').selectOption('uno');
    await host.page.locator('#variant-select').selectOption('classic-108-v1');
    await host.page.locator('#room-name').fill('Bàn cả nhóm');
    await host.page.locator('#proposal-form button[type=submit]').click();
    await guest.page.locator('#proposal-summary:not(.hidden)').waitFor();
    assert.match(await guest.page.locator('#proposal-summary').innerText(), /UNO.*108 lá/);
    assert.match(await guest.page.locator('#proposal-summary').innerText(), /2 thành viên.*6 ghế.*bàn riêng/);
    assert.equal(await guest.page.locator('#proposal-form').isVisible(), false, 'only the host may propose');
    await guest.page.locator('#confirm-proposal').click();
    await host.page.locator('#confirm-proposal').click();
    await host.page.locator('#switch-game:not(.hidden)').waitFor({ timeout: 12000 });
    await host.page.locator('#switch-game').click();
    await host.page.locator('#transition-summary').filter({ hasText: 'Bàn mới đã sẵn sàng' }).waitFor({ timeout: 15000 });
    await guest.page.locator('#enter-new-room:not(.hidden)').waitFor({ timeout: 10000 });

    const room = [...game.gm.uno.rooms.values()].find(item => item.config?.roomName === 'Bàn cả nhóm');
    assert.ok(room, 'the real UNO 108 manager owns the target room');
    assert.equal(room.players.length, 2);
    assert.equal(room.config.visibility, 'invite');
    for (const page of [host.page, guest.page]) {
      await page.setViewportSize({ width: 320, height: 740 });
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(layout.scrollWidth <= layout.width + 1, `horizontal overflow: ${JSON.stringify(layout)}`);
      await page.setViewportSize({ width: 390, height: 844 });
    }
    await host.page.locator('#enter-new-room').click();
    await host.page.waitForURL(url => url.pathname === '/uno' && url.searchParams.get('room') === room.code, { timeout: 10000 });
    await guest.page.locator('#enter-new-room').click();
    await guest.page.waitForURL(url => url.pathname === '/uno' && url.searchParams.get('room') === room.code, { timeout: 10000 });
    await Promise.all([
      host.page.waitForFunction(code => document.getElementById('room-title')?.textContent === code, room.code, { timeout: 10000 }),
      guest.page.waitForFunction(code => document.getElementById('room-title')?.textContent === code, room.code, { timeout: 10000 }),
    ]);
    await waitUntil(() => game.gm.uno.rooms.get(room.code)?.players.every(player => player.connected) === true);
    await host.page.waitForFunction(code => {
      const value = localStorage.getItem(`chill-thrill:uno:${code}`);
      return value && JSON.parse(value).sessionToken;
    }, room.code);

    // Exercise real page navigation, which creates new sockets, and both
    // portal-integrated targets, whose resume storage differs from UNO108.
    let previousRoom = room;
    for (const [gameId, variant] of [['the-gang', 'standard'], ['uno', 'classic-local-v1'], ['tien-len', 'standard']]) {
      for (const page of [host.page, guest.page]) await page.goto(`${base}/group-lobby`);
      await waitUntil(() => previousRoom.players.every(player => !player.connected));
      for (const page of [host.page, guest.page]) await page.locator('#members').filter({ hasText: 'Nhóm trưởng' }).waitFor();
      await waitUntil(() => [...game.groupLobbyService.groups.get(groupId).members.values()].every(member => member.connected));
      await host.page.locator('#game-select').selectOption(gameId);
      if (gameId === 'uno') await host.page.locator('#variant-select').selectOption(variant);
      await host.page.locator('#max-players').selectOption('2');
      const targetName = `Navigation ${gameId} ${variant}`;
      await host.page.locator('#room-name').fill(targetName);
      await host.page.locator('#proposal-form button[type=submit]').click();
      await guest.page.locator('#proposal-status').filter({ hasText: 'Chờ xác nhận' }).waitFor({ timeout: 12000 });
      await guest.page.locator('#proposal-summary').filter({ hasText: ({ 'the-gang': 'The Gang', uno: '112 lá', 'tien-len': 'Tiến lên' })[gameId] }).waitFor({ timeout: 12000 });
      await guest.page.locator('#confirm-proposal').click();
      await host.page.locator('#confirm-proposal').click();
      await host.page.locator('#switch-game:not(.hidden)').waitFor({ timeout: 12000 });
      await host.page.locator('#switch-game').click();
      await host.page.locator('#transition-summary').filter({ hasText: 'Bàn mới đã sẵn sàng' }).waitFor({ timeout: 15000 });
      await guest.page.locator('#enter-new-room:not(.hidden)').waitFor({ timeout: 12000 });
      const managers = [game.gm.gang, game.gm.uno, game.gm.tienLen];
      const target = managers.flatMap(manager => [...manager.rooms.values()]).find(item => item.config?.roomName === targetName);
      assert.ok(target, 'navigation creates exactly the requested target');
      assert.equal(game.gm.managerForCode(previousRoom.code), null, 'old room closes before the next handoff');
      // A clean host session and a guest's stale previous session must both
      // be replaced by the current portal handoff.
      if (gameId !== 'tien-len') await host.page.evaluate(() => sessionStorage.removeItem('gang.session'));
      for (const page of [host.page, guest.page]) await page.locator('#enter-new-room').click();
      for (const page of [host.page, guest.page]) {
        if (gameId === 'tien-len') await page.locator('#room-title').filter({ hasText: target.code }).waitFor();
        else {
          await page.locator('#screen-waiting.active').waitFor();
          assert.equal(await page.evaluate(() => lastState.gameId), gameId);
          if (gameId === 'uno') assert.equal(await page.evaluate(() => lastState.variant), variant);
          assert.equal(JSON.parse(await page.evaluate(() => sessionStorage.getItem('gang.session'))).roomCode, target.code);
          await page.reload();
          await page.locator('#screen-waiting.active').waitFor();
        }
      }
      await waitUntil(() => target.players.every(player => player.connected));
      assert.equal(target.players.length, 2);
      previousRoom = target;
    }
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
    await host.context.close(); await guest.context.close();
    process.stdout.write('C01/R01/R05 group lobby browser check passed: two profiles, private invite, UNO108 -> lobby -> The Gang -> lobby -> UNO112 -> lobby -> Tien len, fresh sockets, clean/stale sessions and portal reloads at 320/390px; no external requests or page errors.\n');
  } finally {
    if (browser) await browser.close();
    await game.close();
    removeTemporaryDirectory(directory);
  }
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
