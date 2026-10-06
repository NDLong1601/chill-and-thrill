'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { io: socketClient } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');

async function checkSingleScreen(page) {
  await checkTableLayout(page);
  const layout = await page.evaluate(() => {
    const game = document.querySelector('#screen-game');
    const nodes = [...document.querySelectorAll('#my-cards-row .playing-card, #center-chip-rack .poker-chip, .opp-seat-capsule, .my-actions-panel button, #btn-hide-cards, #btn-fullscreen, .community-cards-row > *')].filter(e => e.getClientRects().length);
    return { width: innerWidth, height: innerHeight, scrollHeight: game.scrollHeight, clientHeight: game.clientHeight, nodes: nodes.map(e => { const r=e.getBoundingClientRect(); return {name:e.id || e.className, x:r.x,y:r.y,right:r.right,bottom:r.bottom}; }) };
  });
  assert.ok(layout.scrollHeight <= layout.clientHeight + 1, 'The game must fit without vertical scrolling: ' + JSON.stringify(layout));
  for(const rect of layout.nodes) assert.ok(rect.x >= -1 && rect.y >= -1 && rect.right <= layout.width + 1 && rect.bottom <= layout.height + 1, 'Control/card is outside the viewport: ' + JSON.stringify(layout));
}

async function clickGameTool(page, id) {
  await page.locator('#btn-table-menu').click();
  await page.locator('#' + id).click();
}

async function checkTableLayout(page) {
  await page.waitForFunction(() => Math.abs(document.querySelector('#screen-game').getBoundingClientRect().height - (window.visualViewport?.height || innerHeight)) < 1);
  const layout = await page.evaluate(() => {
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const game = document.querySelector('#screen-game');
    return {
      viewport: innerWidth, content: game.scrollWidth, table: rect(document.querySelector('#poker-table')),
      center: rect(document.querySelector('.table-centerpiece')),
      seats: [...document.querySelectorAll('.opp-seat-capsule')].map(element => ({ ...rect(element), position: element.dataset.position })),
      chips: [...document.querySelectorAll('#center-chip-rack .poker-chip')].map(rect),
      buttons: [...document.querySelectorAll('.table-topbar button')].filter(element => element.getClientRects().length).map(rect),
    };
  });
  assert.ok(layout.content <= layout.viewport + 1, `Game overflows horizontally: ${JSON.stringify(layout)}`);
  const overlaps = (a, b) => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1;
  for (const [index, seat] of layout.seats.entries()) {
    assert.ok(seat.x >= 0 && seat.right <= layout.viewport, `Seat is clipped: ${JSON.stringify(seat)}`);
    assert.ok(!overlaps(seat, layout.center), `Seat covers community cards/chips: ${JSON.stringify(layout)}`);
    for (const other of layout.seats.slice(index + 1)) assert.ok(!overlaps(seat, other), 'Player seats overlap: ' + JSON.stringify(layout));
    assert.ok(seat.width >= 44 && seat.height >= 44, 'Player touch target too small');
  }
  for (const target of [...layout.chips, ...layout.buttons]) assert.ok(target.width >= 44 && target.height >= 44, 'Touch target must be at least 44px');
}

async function main() {
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  let browser;
  const errors = [], externalRequests = [];
  const botClients = [];
  const outputs = path.join(__dirname, '..', 'test-results'); fs.mkdirSync(outputs, { recursive: true });
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    for (const context of [desktop, mobile]) {
      await context.route('**/*', route => {
        if (new URL(route.request().url()).hostname !== '127.0.0.1') { externalRequests.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      context.on('page', page => { page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept()); });
    }
    const host = await desktop.newPage(), friend = await mobile.newPage();
    host.setDefaultTimeout(8000); friend.setDefaultTimeout(8000);
    await host.goto(url); await host.waitForFunction(() => socket.connected);
    assert.equal(await host.locator('#screen-home.active').isVisible(), true);
    await host.locator('[data-game-card-action="the-gang"]').click();
    await host.locator('#screen-game-detail.active').waitFor();
    assert.match(await host.locator('#detail-status').innerText(), /Có thể chơi/);
    await host.goBack(); await host.locator('#screen-home.active').waitFor();
    await friend.goto(url); await friend.waitForFunction(() => socket.connected);
    assert.equal(await friend.locator('#screen-home.active').isVisible(), true);
    assert.equal(await friend.locator('#rotate-device-overlay').isVisible(), false);
    const homeWidth = await friend.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(homeWidth.content <= homeWidth.viewport + 1, `Home overflows: ${JSON.stringify(homeWidth)}`);
    await host.locator('#portal-player-name').fill('Chủ phòng');
    await host.locator('[data-game-card-action="the-gang"]').click();
    await host.locator('#btn-detail-tutorial').click();
    for (const value of [2, 2, 1, 1]) { await host.getByRole('button', { name: `Chọn ${value}⭐`, exact: true }).click(); await host.locator('#btn-tutorial-next').click(); }
    assert.match(await host.locator('#tutorial-content').innerText(), /cả đội cùng thắng/);
    await host.locator('[data-close="modal-tutorial"]').click();
    await host.locator('#detail-difficulty').selectOption('BASIC'); await host.locator('#detail-create').click();
    await host.locator('#screen-waiting.active').waitFor();
    await host.waitForFunction(() => document.querySelector('#room-qr').complete && document.querySelector('#room-qr').naturalWidth > 0);
    const code = await host.locator('#disp-room-code').innerText();
    await friend.goto(`${url}/?room=${code}`); await friend.waitForFunction(() => socket.connected);
    assert.equal(await friend.locator('#rotate-device-overlay').isVisible(), false);
    assert.equal(await friend.locator('#portal-room-code').inputValue(), code);
    await friend.locator('#portal-player-name').fill('Đồng đội'); await friend.locator('#portal-join').click(); await friend.locator('#screen-waiting.active').waitFor();
    assert.equal(await friend.locator('#rotate-device-overlay').isVisible(), false);
    await host.locator('#btn-ready').click(); await friend.locator('#btn-ready').click();
    await host.waitForFunction(() => !document.querySelector('#btn-start-game').disabled); await host.locator('#btn-start-game').click();
    await host.waitForFunction(() => lastState?.phase === 'PRE_FLOP'); await friend.waitForFunction(() => lastState?.phase === 'PRE_FLOP');
    await friend.locator('#rotate-device-overlay').waitFor({ state: 'visible' });
    assert.equal(await friend.locator('#screen-game').evaluate(element => element.inert), true);
    assert.equal(await host.locator('#rotate-device-overlay').isVisible(), false);
    await host.setViewportSize({ width: 390, height: 844 });
    assert.equal(await host.locator('#rotate-device-overlay').isVisible(), false);
    await host.setViewportSize({ width: 1440, height: 1000 });
    await friend.screenshot({ path: path.join(outputs, 'mobile-rotate-required.png') });
    const mobileBeforeRotation = await friend.evaluate(() => ({ id: myId, phase: lastState.phase, cards: lastState.players.find(p => p.id === myId).privateCards }));
    await friend.setViewportSize({ width: 844, height: 390 });
    await friend.locator('#rotate-device-overlay').waitFor({ state: 'hidden' });
    assert.equal(await friend.locator('#screen-game').evaluate(element => element.inert), false);
    assert.deepEqual(await friend.evaluate(() => ({ id: myId, phase: lastState.phase, cards: lastState.players.find(p => p.id === myId).privateCards })), mobileBeforeRotation);
    await checkSingleScreen(friend);
    await friend.screenshot({ path: path.join(outputs, 'mobile-own-hand.png') });
    await host.locator('[title="Chọn chip 2⭐"]').click(); await friend.locator('[title="Chọn chip 1⭐"]').click();
    await host.waitForFunction(() => lastState.players[0].chips.white === 2 && lastState.players[1].chips.white === 1);
    assert.equal(await friend.evaluate(() => !!document.fullscreenElement), false, 'Game actions do not steal focus by entering fullscreen');
    await friend.locator('#btn-fullscreen').tap();
    await friend.waitForFunction(() => !!document.fullscreenElement);
    await friend.locator('#btn-fullscreen').tap();
    await friend.waitForFunction(() => !document.fullscreenElement);
    await friend.locator('#btn-hide-cards').tap(); await friend.locator('#btn-hide-cards').tap();
    assert.equal(await friend.evaluate(() => !!document.fullscreenElement), false, 'Manual fullscreen exit must be respected');
    await friend.locator('#btn-fullscreen').tap(); await friend.waitForFunction(() => !!document.fullscreenElement);
    await friend.setViewportSize({ width: 390, height: 844 });
    await friend.locator('#rotate-device-overlay').waitFor({ state: 'visible' });
    assert.equal(await friend.evaluate(() => lastState.players.find(p => p.id === myId).chips.white), 1);
    await friend.setViewportSize({ width: 844, height: 390 });
    await friend.locator('#rotate-device-overlay').waitFor({ state: 'hidden' });
    const before = await host.evaluate(() => ({ id: myId, cards: lastState.players.find(p => p.id === myId).privateCards }));
    await host.reload(); await host.waitForFunction(() => lastState?.phase === 'PRE_FLOP' && lastState.disconnected.length === 0);
    assert.deepEqual(await host.evaluate(() => ({ id: myId, cards: lastState.players.find(p => p.id === myId).privateCards })), before);
    await friend.waitForFunction(() => isHost); await clickGameTool(friend, 'btn-manage-game');
    await friend.getByRole('button', { name: 'Trao chủ phòng' }).click(); await friend.locator('[data-close="modal-management"]').click(); await host.waitForFunction(() => isHost);
    await host.locator('#btn-hide-cards').click(); assert.equal(await host.locator('#my-cards-row .card-back').count(), 2); await host.locator('#btn-hide-cards').click();
    await host.screenshot({ path: path.join(outputs, 'desktop-table.png'), fullPage: true });
    await friend.screenshot({ path: path.join(outputs, 'mobile-table.png'), fullPage: true });
    const width = await friend.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(width.content <= width.viewport + 1, `Mobile overflows: ${JSON.stringify(width)}`);
    for (const phase of ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER']) {
      await host.waitForFunction(phase => lastState.phase === phase, phase); await friend.waitForFunction(phase => lastState.phase === phase, phase);
      if (phase !== 'PRE_FLOP') { await host.locator('[title="Chọn chip 2⭐"]').click(); await friend.locator('[title="Chọn chip 1⭐"]').click(); }
      await host.waitForFunction(() => lastState.players.every(p => p.chips[lastState.currentRoundChipColor] !== null));
      await host.locator('#btn-confirm-round').click(); await friend.locator('#btn-confirm-round').click();
      await host.waitForFunction(() => !document.querySelector('#btn-advance-phase').disabled); await host.locator('#btn-advance-phase').click();
    }
    await host.waitForFunction(() => lastState.phase === 'SHOWDOWN');
    await host.locator('#btn-showdown-table').click(); await host.waitForFunction(() => lastState.showdown.revealedCount === 1);
    await host.locator('#btn-showdown-table').click(); await host.locator('#modal-result:not(.hidden)').waitFor();
    assert.equal(await host.locator('.best-five .playing-card').count(), 10);
    await host.locator('#btn-result-to-lobby').click(); await host.locator('#screen-waiting.active').waitFor();
    await host.locator('#btn-history-waiting').click(); assert.equal(await host.locator('.history-entry').count(), 1);
    await host.locator('[data-close="modal-history"]').click();
    // Exercise the actual specialist proposal, unanimous approval and private card choice UI.
    await host.locator('#sel-change-mode').selectOption('ADVANCED');
    await host.locator('#btn-ready').click(); await friend.locator('#btn-ready').click();
    await host.waitForFunction(() => !document.querySelector('#btn-start-game').disabled); await host.locator('#btn-start-game').click();
    const room = game.gm.rooms.get(code); room.activeSpecialist = require('../src/cardsData').SPECIALISTS[0]; game.gm.startHeist(room);
    await host.locator('[data-close="modal-card-spotlight"]').first().click();
    await friend.locator('[data-close="modal-card-spotlight"]').first().click();
    await host.locator('#btn-table-feature').click();
    await host.locator('#expert-actor').waitFor();
    await host.getByRole('button', { name: 'Đề xuất cho cả đội' }).click();
    await friend.getByRole('button', { name: 'Đồng ý', exact: true }).click(); await host.locator('#specialist-panel .card-choice').first().click();
    await friend.waitForFunction(() => lastState.privateInsights.length === 1); assert.equal(await friend.locator('.private-insight .playing-card').count(), 1);
    await friend.locator('#btn-toggle-chat-panel').click(); await friend.getByRole('button', { name: 'Sẵn sàng!', exact: true }).click();
    await host.waitForFunction(() => document.querySelector('#chat-messages-container').textContent.includes('Sẵn sàng!'));
    assert.equal(await friend.locator('#inp-chat-msg').isDisabled(), true);
    await friend.locator('#btn-close-comm-dock').click();
    await clickGameTool(host, 'btn-manage-game'); await host.getByRole('button', { name: '🏠 Đưa cả đội về phòng chờ' }).click();
    await host.locator('[data-close="modal-management"]').click(); await host.locator('#screen-waiting.active').waitFor();
    await friend.setViewportSize({ width: 390, height: 844 });
    await friend.waitForFunction(() => lastState.phase === 'WAITING');
    assert.equal(await friend.locator('#rotate-device-overlay').isVisible(), false);
    await host.locator('#sel-change-mode').selectOption('BASIC');
    for (let i = 0; i < 4; i++) {
      const bot = socketClient(url, { transports: ['websocket'], forceNew: true }); botClients.push(bot);
      await new Promise(resolve => bot.once('connect', resolve));
      await new Promise(resolve => bot.emit('join_room', { roomCode: code, playerName: `Thành viên ${i + 3}` }, resolve));
      bot.emit('set_ready', { roomCode: code, ready: true });
    }
    await host.locator('#btn-ready').click(); await friend.locator('#btn-ready').click();
    await host.waitForFunction(() => !document.querySelector('#btn-start-game').disabled); await host.locator('#btn-start-game').click();
    await friend.waitForFunction(() => lastState.phase === 'PRE_FLOP' && lastState.players.length === 6);
    await friend.locator('#rotate-device-overlay').waitFor({ state: 'visible' });
    await friend.setViewportSize({ width: 844, height: 390 });
    await friend.locator('#rotate-device-overlay').waitFor({ state: 'hidden' });
    await friend.locator('#screen-game').evaluate(element => { element.scrollTop = 0; });
    await friend.screenshot({ path: path.join(outputs, 'mobile-six-players.png'), fullPage: true });
    const sixWidth = await friend.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(sixWidth.content <= sixWidth.viewport + 1, `Six-player table overflows: ${JSON.stringify(sixWidth)}`);
    await friend.locator('[title="Chọn chip 1⭐"]').tap();
    await friend.waitForFunction(() => lastState.players.find(p => p.id === myId).chips.white === 1);
    await clickGameTool(host, 'btn-manage-game');
    await host.locator('.management-row').filter({ hasText: 'Đồng đội' }).getByRole('button', { name: 'Trao chủ phòng' }).click();
    await host.locator('[data-close="modal-management"]').click();
    await friend.waitForFunction(() => isHost);
    for (const viewport of [{ width: 480, height: 270 }, { width: 568, height: 240 }, { width: 568, height: 320 }, { width: 667, height: 290 }, { width: 667, height: 375 }, { width: 844, height: 390 }, { width: 932, height: 430 }]) {
      await friend.setViewportSize(viewport);
      await checkTableLayout(friend);
      await checkSingleScreen(friend);
      await friend.screenshot({ path: path.join(outputs, `mobile-hand-${viewport.width}.png`) });
      const confirmedBefore = await friend.evaluate(() => lastState.players.find(p => p.id === myId).roundConfirmed);
      await friend.locator('#btn-confirm-round').tap();
      await friend.waitForFunction(previous => lastState.players.find(p => p.id === myId).roundConfirmed !== previous, confirmedBefore);
      assert.ok(await friend.locator('#my-cards-row').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), 'State updates must preserve access to the hand');
      await friend.locator('#screen-game').evaluate(element => { element.scrollTop = 0; });
      await friend.screenshot({ path: path.join(outputs, `mobile-table-${viewport.width}.png`) });
    }
    await friend.setViewportSize({ width: 568, height: 320 });
    await friend.locator('#screen-game').evaluate(element => element.style.setProperty('--safe-bottom', '24px'));
    await friend.evaluate(() => window.dispatchEvent(new Event('resize')));
    await friend.waitForFunction(() => document.querySelector('#screen-game').classList.contains('table-short'));
    await checkSingleScreen(friend);
    await friend.locator('#screen-game').evaluate(element => element.style.removeProperty('--safe-bottom'));
    await friend.evaluate(() => window.dispatchEvent(new Event('resize')));
    await clickGameTool(friend, 'btn-manage-game');
    await friend.locator('.management-row').filter({ has: friend.locator('span', { hasText: 'Chủ phòng' }) }).getByRole('button', { name: 'Trao chủ phòng' }).click();
    await friend.locator('[data-close="modal-management"]').click();
    await host.waitForFunction(() => isHost);
    await friend.setViewportSize({ width: 844, height: 390 });
    await friend.screenshot({ path: path.join(outputs, 'mobile-landscape.png'), fullPage: true });
    // Camera is the widest legal hand. Check real dealing, all five board cards,
    // and revealed hand names for the maximum-size table.
    room.activeChallenges = [require('../src/cardsData').CHALLENGES.find(card => card.id === 10)];
    game.gm.startHeist(room);
    await friend.waitForFunction(() => lastState.players.find(p => p.id === myId).privateCards.length === 3);
    await host.locator('[data-close="modal-card-spotlight"]').first().click();
    await friend.locator('[data-close="modal-card-spotlight"]').first().tap();
    assert.equal(await friend.locator('.opp-seat-capsule .card-back').count(), 15);
    for (const viewport of [{ width: 568, height: 240 }, { width: 568, height: 320 }, { width: 667, height: 290 }, { width: 667, height: 375 }, { width: 844, height: 390 }]) {
      await friend.setViewportSize(viewport);
      await checkSingleScreen(friend);
    }
    for (const phase of ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER']) {
      await host.waitForFunction(value => lastState.phase === value, phase);
      await friend.waitForFunction(value => lastState.phase === value, phase);
      await checkSingleScreen(friend);
      await host.locator('[title="Chọn chip 2⭐"]').click();
      await friend.locator('[title="Chọn chip 1⭐"]').tap();
      const phaseKey = await friend.evaluate(() => lastState.phaseKey);
      botClients.forEach((bot, index) => {
        bot.emit('claim_chip', { roomCode: code, chipNumber: index + 3, phaseKey });
      });
      await host.waitForFunction(() => lastState.players.every(p => p.chips[lastState.currentRoundChipColor] !== null));
      botClients.forEach(bot => bot.emit('confirm_round', { roomCode: code, confirmed: true, phaseKey }));
      await host.locator('#btn-confirm-round').click(); await friend.locator('#btn-confirm-round').tap();
      await host.waitForFunction(() => !document.querySelector('#btn-advance-phase').disabled);
      await host.locator('#btn-advance-phase').click();
    }
    await host.waitForFunction(() => lastState.phase === 'SHOWDOWN');
    for (let revealed = 1; revealed <= 5; revealed++) {
      await host.locator('#btn-showdown-table').click();
      await host.waitForFunction(count => lastState.showdown.revealedCount === count, revealed);
    }
    await friend.waitForFunction(() => lastState.showdown.revealedCount === 5);
    for (const viewport of [{ width: 568, height: 240 }, { width: 568, height: 320 }, { width: 667, height: 290 }, { width: 667, height: 375 }, { width: 844, height: 390 }]) {
      await friend.setViewportSize(viewport); await checkSingleScreen(friend);
    }
    await friend.screenshot({ path: path.join(outputs, 'mobile-six-showdown.png') });
    await friend.locator('#my-cards-row').tap();
    assert.equal(await friend.locator('#private-hand-preview .playing-card').count(), 3);
    await friend.locator('[data-close="modal-my-hand"]').click();
    await friend.setViewportSize({ width: 568, height: 240 });
    await friend.locator('#btn-table-menu').tap();
    assert.ok(await friend.locator('#pinned-challenge-btn').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), 'Challenge/menu buttons must fit a small screen');
    await friend.locator('#btn-table-menu').tap();
    await friend.locator('#btn-fullscreen').tap(); await friend.waitForFunction(() => !document.fullscreenElement);
    await friend.evaluate(() => { window.savedFullscreenRequest = document.documentElement.requestFullscreen; document.documentElement.requestFullscreen = () => Promise.reject(new Error('Simulated fullscreen rejection')); });
    await friend.locator('#btn-fullscreen').tap();
    await friend.waitForFunction(() => document.querySelector('#app-toast').textContent.includes('Chưa bật được toàn màn hình'));
    await checkSingleScreen(friend);
    await friend.evaluate(() => { document.documentElement.requestFullscreen = undefined; document.documentElement.webkitRequestFullscreen = undefined; });
    await friend.locator('#btn-fullscreen').tap();
    await friend.waitForFunction(() => document.querySelector('#app-toast').textContent.includes('Trình duyệt chưa hỗ trợ'));
    await checkSingleScreen(friend);
    assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
    console.log('PASS: one viewport for host/players at 480/568/667/844/932px and 240px available height, 24px bottom safe area, native fullscreen enter/exit + rejection/unsupported fallbacks, private hand preview, utility menu, 44px touch controls, non-overlapping perimeter seats, six-player Camera/three-card hands through River/Showdown, rotation gate, tutorial, QR, invite, ready, reload, host transfer, privacy, history, specialist consent, strict chat, zero external requests and zero page errors.');
    console.log(`Screenshots: ${outputs}`);
  } finally { botClients.forEach(c => c.disconnect()); if (browser) await browser.close(); await game.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
