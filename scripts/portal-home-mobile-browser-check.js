'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');
const { publicCatalog } = require('../src/platform/gameRegistry');

const PREFERENCE_KEY = 'chill-thrill:portal-home-preferences';

async function main() {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-home-mobile-'));
  const game = createGameServer({ storageFile: path.join(fixtureDirectory, 'rooms.json'), databaseFile: path.join(fixtureDirectory, 'profiles.sqlite') });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const browserErrors = [];
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    context.on('page', page => page.on('pageerror', error => { if (page.url() !== 'about:blank') browserErrors.push({ url: page.url(), message: error.message, stack: error.stack }); }));
    const host = await context.newPage(); host.setDefaultTimeout(10000);
    await host.goto(url);
    await host.locator('#portal-shortcuts-title').waitFor();

    for (const viewport of [{ width: 320, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 850 }]) {
      await host.setViewportSize(viewport);
      const layout = await host.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(layout.scrollWidth <= layout.width, `No horizontal overflow at ${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`);
    }

    const categoryThrill = host.locator('[data-category-filter="thrill"]');
    await categoryThrill.focus(); await host.keyboard.press('Enter');
    assert.equal(await categoryThrill.getAttribute('aria-pressed'), 'true', 'category filter is keyboard-operable and announces selection');
    await host.locator('#casual-section').waitFor({ state: 'hidden' });
    const allGames = host.locator('[data-category-filter="all"]');
    await allGames.focus(); await host.keyboard.press('Enter');
    await host.locator('#casual-section').waitFor({ state: 'visible' });

    await host.locator('#portal-player-name').fill('Home Host');
    await host.locator('#portal-entry-identity [data-avatar="🥷"]').click();
    await host.locator('#casual-games [data-favorite-toggle="uno"]').click();
    assert.equal(await host.locator('#portal-favorite-games [data-game-card="uno"]').count(), 1);
    const savedPreference = await host.evaluate(key => JSON.parse(localStorage.getItem(key)), PREFERENCE_KEY);
    assert.equal(savedPreference.version, 1);
    assert.deepEqual(savedPreference.favorites, ['uno']);
    assert.deepEqual(savedPreference.recent, [], 'opening a card or marking it favorite does not mark the game recently played');
    await host.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 1, favorites: ['uno', 'removed-game'], recent: ['unknown-game'] })), PREFERENCE_KEY);

    await host.reload();
    await host.locator('#portal-favorite-games [data-game-card="uno"]').waitFor();
    assert.equal(await host.locator('#portal-recent-games [data-game-card]').count(), 0, 'unknown saved game IDs are ignored');
    await host.locator('#portal-entry-identity [data-avatar="🥷"]').click();
    const localCreate = host.locator('#casual-games [data-game-card-action="uno"]');
    await localCreate.focus(); await host.keyboard.press('Enter');
    await host.locator('#screen-game-detail.active').waitFor();
    assert.equal((await host.evaluate(key => JSON.parse(localStorage.getItem(key)), PREFERENCE_KEY)).recent.includes('uno'), false, 'viewing details does not mark a recent game');
    await host.locator('#detail-max-players').selectOption('2');
    await host.locator('#detail-uno-variant').selectOption('classic-local-v1');
    await host.locator('#detail-create').click();
    await host.waitForURL(/\/rooms\/[A-Z2-9]{4}$/);
    const localCode = host.url().split('/').at(-1);
    assert.equal(game.gm.publicRoom(localCode).variant, 'classic-local-v1');
    await host.waitForFunction(key => JSON.parse(localStorage.getItem(key)).recent[0] === 'uno', PREFERENCE_KEY);
    const hostProfile = await host.evaluate(async () => {
      const response = await fetch('/api/profile', { headers: { 'X-Profile-Token': localStorage.getItem('chill-thrill:profile-token') } });
      return (await response.json()).profile;
    });
    assert.equal(hostProfile.name, 'Home Host');
    assert.equal(hostProfile.avatar, '🥷', 'saved avatar survives quick-create and external UNO handoff');

    const friendContext = await browser.newContext({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });
    friendContext.on('page', page => page.on('pageerror', error => { if (page.url() !== 'about:blank') browserErrors.push({ url: page.url(), message: error.message, stack: error.stack }); }));
    const friend = await friendContext.newPage(); friend.setDefaultTimeout(10000);
    await friend.goto(`${url}/rooms/${localCode}`);
    await friend.locator('#portal-player-name').fill('Home Friend');
    await friend.locator('#portal-join').focus(); await friend.keyboard.press('Enter');
    await friend.waitForURL(new RegExp(`/rooms/${localCode}$`));
    await friend.locator('#screen-waiting.active').waitFor();
    assert.equal(game.gm.gang.rooms.get(localCode).players.length, 2, 'friend joined the correct 112-card room');
    await friend.waitForFunction(key => JSON.parse(localStorage.getItem(key)).recent[0] === 'uno', PREFERENCE_KEY);
    await friend.reload();
    assert.equal(new URL(friend.url()).pathname, `/rooms/${localCode}`, 'direct invite path remains compatible after reload');
    await friend.locator('#screen-waiting.active').waitFor();
    await friend.goto(url);
    await friend.locator('#portal-continue:not(.hidden)').waitFor();
    await friend.locator('#portal-recent-games [data-game-card="uno"]').waitFor();
    await friend.locator('#portal-leave').click();
    await friend.locator('#screen-home.active').waitFor();
    await friend.waitForFunction(() => !localStorage.getItem('chill-thrill:last-room'));
    await friendContext.close();

    await host.goto(url);
    await host.locator('#portal-continue:not(.hidden)').waitFor();
    await host.locator('#portal-player-name').waitFor();
    assert.equal(await host.locator('#portal-player-name').inputValue(), 'Home Host');
    assert.equal(await host.locator('#portal-entry-identity [data-avatar="🥷"]').getAttribute('class').then(value => value.includes('active')), true);
    await host.locator('#portal-leave').click();
    await host.locator('#screen-home.active').waitFor();
    await host.waitForFunction(() => !localStorage.getItem('chill-thrill:last-room'));

    await host.locator('#portal-recent-games [data-game-quick-action="uno"]').click();
    await host.waitForURL(/\/games\/uno\?quick=create$/);
    await host.locator('#detail-uno-variant').selectOption('classic-108-v1');
    assert.equal(await host.locator('#detail-max-players').inputValue(), '6');
    await host.locator('#detail-create').click();
    await host.waitForURL(/\/uno\?room=/);
    const wideCode = new URL(host.url()).searchParams.get('room');
    assert.equal(game.gm.publicRoom(wideCode).variant, 'classic-108-v1', '108-card UNO remains a separate variant on the shared route');
    await host.goto(url);
    await host.locator('#portal-leave').click();
    await host.locator('#screen-home.active').waitFor();
    await host.waitForFunction(() => !localStorage.getItem('chill-thrill:last-room'));

    if (process.env.PORTAL_HOME_SCREENSHOT) {
      await host.setViewportSize({ width: 390, height: 844 });
      await host.screenshot({ path: process.env.PORTAL_HOME_SCREENSHOT, fullPage: true });
    }
    await host.goto(`${url}/games/tien-len`);
    await host.locator('#screen-game-detail.active').waitFor();
    const stakeMeta = publicCatalog().games.find(item => item.gameId === 'tien-len').stakeRules;
    await host.locator('#detail-max-players').selectOption('2');
    const twoPlayerRules = stakeMeta.limitsByPlayerCount['2'];
    await host.waitForFunction(({ max }) => document.getElementById('detail-stake-summary').textContent.includes(`cược tối đa ${max.toLocaleString('vi-VN')} coin với 2 người`), { max: twoPlayerRules.maxStake });
    const fourPlayerCount = await host.locator('#detail-max-players option').last().getAttribute('value');
    await host.locator('#detail-max-players').selectOption(fourPlayerCount);
    const fourPlayerRules = stakeMeta.limitsByPlayerCount[fourPlayerCount];
    const stakeSummary = await host.locator('#detail-stake-summary').innerText();
    assert.ok(stakeSummary.includes(`tối đa với ${fourPlayerCount} người`), stakeSummary);
    assert.ok(stakeSummary.includes(`cược tối đa ${fourPlayerRules.maxStake.toLocaleString('vi-VN')} coin`), stakeSummary);
    const selectedStake = Number((await host.locator('#detail-stake').inputValue()).replaceAll('.', ''));
    assert.ok(stakeSummary.includes(`giữ tối đa ${(selectedStake * fourPlayerRules.holdFactor).toLocaleString('vi-VN')} coin/người`), stakeSummary);
    await host.locator('#detail-stake').fill(String(fourPlayerRules.maxStake + 1));
    await host.locator('#detail-create').click();
    assert.match(await host.locator('#detail-error').innerText(), new RegExp(fourPlayerRules.maxStake.toLocaleString('vi-VN').replaceAll('.', '\\.')));
    assert.equal((await host.evaluate(key => JSON.parse(localStorage.getItem(key)), PREFERENCE_KEY)).recent.includes('tien-len'), false, 'rejected create does not change recent games');

    const legacyContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    legacyContext.on('page', page => page.on('pageerror', error => { if (page.url() !== 'about:blank') browserErrors.push({ url: page.url(), message: error.message, stack: error.stack }); }));
    const legacy = await legacyContext.newPage(); legacy.setDefaultTimeout(10000);
    await legacy.goto(`${url}/?room=${localCode}`);
    assert.equal(await legacy.locator('#portal-room-code').inputValue(), localCode, 'historical ?room= invite links still prefill the join form');
    assert.equal(await legacy.locator('[data-category-filter="all"]').getAttribute('aria-pressed'), 'true');
    await legacyContext.close();

    const corruptContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    corruptContext.on('page', page => page.on('pageerror', error => { if (page.url() !== 'about:blank') browserErrors.push({ url: page.url(), message: error.message, stack: error.stack }); }));
    await corruptContext.addInitScript(key => localStorage.setItem(key, '{broken'), PREFERENCE_KEY);
    const corrupt = await corruptContext.newPage(); corrupt.setDefaultTimeout(10000);
    await corrupt.goto(url);
    await corrupt.locator('#portal-preference-status:not([hidden])').waitFor();
    assert.match(await corrupt.locator('#portal-preference-status').innerText(), /Không đọc được tùy chọn/);
    await corrupt.locator('#casual-games [data-favorite-toggle="uno"]').click();
    assert.equal(await corrupt.locator('#portal-favorite-games [data-game-card="uno"]').count(), 1);
    assert.equal(await corrupt.locator('#portal-preference-status').isVisible(), false, 'a successful save repairs a corrupt preference value');
    await corruptContext.close();

    const blockedContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    blockedContext.on('page', page => page.on('pageerror', error => { if (page.url() !== 'about:blank') browserErrors.push({ url: page.url(), message: error.message, stack: error.stack }); }));
    await blockedContext.addInitScript(() => {
      const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
      const isLocalStorage = storage => { try { return storage === window.localStorage; } catch { return false; } };
      Storage.prototype.getItem = function (name) { if (isLocalStorage(this)) throw new DOMException('Blocked', 'SecurityError'); return get.call(this, name); };
      Storage.prototype.setItem = function (name, value) { if (isLocalStorage(this)) throw new DOMException('Blocked', 'SecurityError'); return set.call(this, name, value); };
      Storage.prototype.removeItem = function (name) { if (isLocalStorage(this)) throw new DOMException('Blocked', 'SecurityError'); return remove.call(this, name); };
    });
    const blocked = await blockedContext.newPage(); blocked.setDefaultTimeout(10000);
    await blocked.goto(url);
    await blocked.locator('#portal-preference-status:not([hidden])').waitFor();
    await blocked.locator('#casual-games [data-favorite-toggle="uno"]').click();
    assert.equal(await blocked.locator('#portal-favorite-games [data-game-card="uno"]').count(), 1, 'in-memory favorites still work when browser storage is blocked');
    assert.match(await blocked.locator('#portal-preference-status').innerText(), /chặn lưu tùy chọn/);
    await blockedContext.close();

    assert.deepEqual(browserErrors, [], 'no portal browser errors across mobile, storage, identity, and UNO flows');
    console.log('PASS: mobile layouts (320/390/844 landscape), keyboard filters, versioned favorite/recent storage, successful create/join tracking, portal resume/leave, identity hydration, both UNO variants, stake metadata preview, and corrupt/blocked storage.');
    await context.close();
  } finally {
    await browser?.close();
    await game.close();
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
