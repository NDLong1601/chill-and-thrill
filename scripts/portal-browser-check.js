'use strict';
const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { createGameServer, networkUrls } = require('../src/httpServer');

async function main() {
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, '0.0.0.0', resolve));
  const url = networkUrls(game.server.address().port).find(address => !address.local)?.url || `http://127.0.0.1:${game.server.address().port}`;
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    // Also exercises HTTP LAN browsers where randomUUID is unavailable.
    await desktop.addInitScript(() => Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined }));
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
    await host.waitForFunction(() => document.querySelector('#room-qr').naturalWidth > 0);
    assert.ok(await host.locator('#share-address option').count() > 0);
    assert.equal(await host.locator('#wait-player-grid .member-chip-card').count(), 1);
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    mobile.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const friend = await mobile.newPage(); friend.setDefaultTimeout(8000);
    await friend.goto(`${url}/rooms/${code}`);
    await friend.locator('#portal-player-name').fill('Portal Friend');
    await friend.locator('#portal-join').click();
    await friend.locator('#screen-waiting.active').waitFor();
    await host.locator('#btn-ready').click();
    await host.waitForFunction(() => document.getElementById('btn-ready').textContent.includes('HỦY SẴN SÀNG'));
    await friend.locator('#btn-ready').click();
    await host.waitForFunction(() => !document.getElementById('btn-start-game').disabled);
    await host.locator('#btn-start-game').click();
    await host.locator('#screen-uno.active').waitFor();
    await friend.locator('#screen-uno.active').waitFor();
    await friend.locator('#rotate-device-overlay:not([hidden])').waitFor();
    await friend.setViewportSize({ width: 844, height: 390 });
    await friend.locator('#rotate-device-overlay').waitFor({ state: 'hidden' });
    assert.equal(await host.evaluate(() => lastState.variant), 'classic-local-v1');
    // The opening +2 is drawn by the seat after the host. Check both private
    // hands so a random opening card cannot give this fixture a false failure.
    assert.equal(await host.evaluate(() => lastState.myHand.length), 7);
    const openingGuestHand = await friend.evaluate(() => ({ count: lastState.myHand.length, topType: lastState.topCard.type }));
    assert.equal(openingGuestHand.count, openingGuestHand.topType === 'draw2' ? 9 : 7);
    const actor = await host.evaluate(() => lastState.currentPlayerId === myId) ? host : friend;
    if (await actor.evaluate(() => lastState.availableActions.some(item => item.type === 'choose_color'))) {
      await actor.locator('#uno-actions button').filter({ hasText: 'MÀU Đỏ' }).click();
    }
    await actor.locator('#uno-draw-pile').waitFor();
    await actor.waitForFunction(() => !document.getElementById('uno-draw-pile').disabled);
    const revision = await actor.evaluate(() => lastState.revision);
    await actor.locator('#uno-draw-pile').click();
    await actor.waitForFunction(previous => lastState.revision > previous, revision);
    await host.reload();
    await host.locator('#screen-uno.active').waitFor();
    await friend.locator('#uno-leave-btn').click();
    await friend.locator('#screen-home.active').waitFor();
    await host.locator('#screen-waiting.active').waitFor();
    assert.equal(await friend.evaluate(() => location.pathname), '/');
    assert.equal(await friend.evaluate(() => sessionStorage.getItem('gang.session')), null);
    assert.equal(game.gm.gang.playerRoom.has(await friend.evaluate(() => socket.id)), false);
    await host.locator('#btn-leave-waiting').click();
    await host.locator('#screen-home.active').waitFor();
    await host.locator('[data-game-card-action="the-gang"]').click();
    await host.locator('#detail-create').click();
    await host.locator('#screen-waiting.active').waitFor();
    await host.waitForFunction(() => document.querySelector('#room-qr').naturalWidth > 0 && document.querySelector('#room-qr').src.includes(roomCode));
    assert.equal(await host.evaluate(() => lastState.gameId), 'the-gang');
    assert.equal(await host.locator('#btn-ready').innerText(), '✓ SẴN SÀNG');
    await host.goBack();
    await host.locator('#screen-game-detail [data-portal-home]').click();
    await host.locator('[data-game-card-action="uno"]').click();
    await host.locator('#detail-create').click();
    await host.waitForFunction(() => document.getElementById('detail-error').textContent.includes('rời phòng hiện tại'));
    await host.locator('#screen-game-detail [data-portal-home]').click();
    await host.locator('#portal-leave').click();
    await host.locator('#screen-home.active').waitFor();
    await host.waitForFunction(() => !sessionStorage.getItem('gang.session'));
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
      // Leave a saved table from the portal, including a fresh socket after navigation.
      const savedCode = new URL(page.url()).searchParams.get('room');
      assert.equal(new URL(page.url()).searchParams.get('returnTo'), 'portal');
      await page.reload();
      await page.locator('#room-view:not([hidden])').waitFor();
      assert.equal(new URL(page.url()).searchParams.get('returnTo'), 'portal');
      await page.locator('#leave').click();
      await page.locator('#screen-home.active').waitFor();
      assert.equal(new URL(page.url()).pathname, '/');
      assert.equal(game.gm.hasRoom(savedCode), false);
      assert.equal(await page.evaluate(() => localStorage.getItem('chill-thrill:last-room')), null);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('gang.session')), null);
      assert.equal(await page.evaluate(({ gameId, savedCode }) => localStorage.getItem(`chill-thrill:${gameId}:${savedCode}`), { gameId, savedCode }), null);
      // Continuing a saved table must preserve the same return destination.
      await page.locator(`[data-game-card-action="${gameId}"]`).click();
      if (gameId === 'uno') await page.locator('#detail-uno-variant').selectOption('classic-108-v1');
      await page.locator('#detail-create').click();
      await page.waitForURL(new RegExp(`/${gameId}\\?room=`));
      await page.locator('#room-view:not([hidden])').waitFor();
      const resumeCode = new URL(page.url()).searchParams.get('room');
      await page.goto(url);
      await page.locator('#portal-resume').click();
      await page.waitForURL(new RegExp(`/${gameId}\\?room=${resumeCode}`));
      await page.locator('#room-view:not([hidden])').waitFor();
      assert.equal(new URL(page.url()).searchParams.get('returnTo'), 'portal');
      assert.equal(game.gm.managerForCode(resumeCode).rooms.get(resumeCode).players.length, 1);
      await page.locator('#leave').click();
      await page.locator('#screen-home.active').waitFor();
      assert.equal(game.gm.hasRoom(resumeCode), false);
      // Retain the saved-room departure path from a fresh portal socket.
      await page.locator(`[data-game-card-action="${gameId}"]`).click();
      if (gameId === 'uno') await page.locator('#detail-uno-variant').selectOption('classic-108-v1');
      await page.locator('#detail-create').click();
      await page.waitForURL(new RegExp(`/${gameId}\\?room=`));
      await page.locator('#room-view:not([hidden])').waitFor();
      const leaveSavedCode = new URL(page.url()).searchParams.get('room');
      await page.goto(url);
      await page.locator('#portal-leave').click();
      await page.waitForFunction(() => !sessionStorage.getItem('gang.session') && !localStorage.getItem('chill-thrill:last-room'));
      assert.equal(game.gm.hasRoom(leaveSavedCode), false);
      await page.locator('[data-game-card-action="the-gang"]').click();
      await page.locator('#detail-create').click();
      await page.locator('#screen-waiting.active').waitFor();
      await page.locator('#btn-leave-waiting').click();
      await page.locator('#screen-home.active').waitFor();
      await context.close();
    }
    assert.deepEqual(errors, [], 'No browser page errors across imported and existing games');
    console.log('PASS: HTTP LAN UNO QR/ready/actions/reload/leave, native create/resume/reload return to portal with cleared credentials, same-browser game switching, saved-room departure for UNO 108 and M4–M6, one shared profile/wallet, zero page errors.');
  } finally { await browser?.close(); await game.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
