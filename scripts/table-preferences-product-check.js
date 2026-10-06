'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');
const { getPublicTurnStatus } = require('../public/js/table-preferences');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'table-b06-product-'));
  const game = createGameServer({ storageFile: path.join(directory, 'rooms.json'), databaseFile: path.join(directory, 'profiles.sqlite') });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${game.server.address().port}`;
  const clients = [], errors = [];
  let browser;
  async function connect() {
    const client = io(base, { transports: ['websocket'], forceNew: true });
    clients.push(client);
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    return game.io.sockets.sockets.get(client.id);
  }
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    for (const [gameId, variant, count] of [
      ['the-gang', 'base-v1', 3], ['uno', 'classic-local-v1', 2], ['uno', 'classic-108-v1', 2],
      ['tien-len', 'south-v1', 2], ['poker', 'holdem-nl-v1', 2], ['sam-loc', 'local-v1', 2],
      ['phom', 'local-v1', 2], ['bang', 'base-4th-edition-v1', 4],
    ]) {
      const host = await connect();
      const created = game.gm.createRoom(host, 'B06 host', 'BASIC', '🎲', gameId, gameId === 'uno' ? { variant } : {});
      assert.equal(created.error, undefined);
      for (let index = 1; index < count - 1; index++) {
        const guest = await connect();
        assert.equal(game.gm.joinRoom(guest, created.roomCode, `B06 guest${index}`, '🎲').error, undefined);
      }
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(`${gameId}/${variant}: ${error.message}`));
      await page.goto(`${base}/rooms/${created.roomCode}`);
      await page.locator('#portal-player-name').fill('B06 learner');
      await page.locator('#portal-join').click();
      try { await page.locator('#room-view:not([hidden]),#screen-waiting.active').first().waitFor(); }
      catch (error) {
        console.error(`${gameId}/${variant} waiting-room failure:`, await page.evaluate(() => ({
          url: location.pathname, text: document.body.innerText.slice(-3000),
        })), errors);
        throw error;
      }
      const manager = game.gm.managerForCode(created.roomCode);
      const room = manager.rooms.get(created.roomCode);
      assert.equal(room.players.length, count);
      const waitingPreflight = page.locator('[data-room-preflight]:visible');
      await waitingPreflight.getByRole('heading', { name: 'Trước khi bắt đầu', exact: true }).waitFor();
      const waitingViewer = room.players.find(player => player.name === 'B06 learner');
      const waitingState = manager.buildStateFor(room, waitingViewer.id);
      assert.equal(await waitingPreflight.getAttribute('data-room-code'), created.roomCode);
      assert.equal(await waitingPreflight.getAttribute('data-variant'), waitingState.preflight.room.variant);
      if (waitingState.preflight.viewer.funding.mode === 'fixed-hold') {
        assert.match(await waitingPreflight.innerText(), /Sẽ giữ khi bắt đầu/);
      }
      if (gameId === 'poker') {
        room.players.forEach((player, index) => {
          assert.equal(manager.action(game.io.sockets.sockets.get(player.socketId), room.code, {
            action: 'buy_in', amount: 200, actionId: `b06-buyin-${index}`, expectedRevision: room.revision,
          })?.error, undefined);
        });
      }
      room.players.forEach(player => game.gm.setReady(game.io.sockets.sockets.get(player.socketId), room.code, true));
      assert.equal(game.gm.startGame(host, room.code)?.error, undefined);
      const scope = page.locator('.table-preferences-scope:visible');
      await scope.waitFor();
      const viewer = room.players.find(player => player.name === 'B06 learner');
      const status = getPublicTurnStatus(manager.buildStateFor(room, viewer.id));
      assert.ok(status);
      await page.waitForFunction(kind => [...document.querySelectorAll('.table-preferences-scope')].some(node => node.offsetParent && node.dataset.currentTurn === kind), status.kind);
      if (status.ownerId) {
        await scope.locator('.table-preferences-current-player').waitFor();
        assert.equal(await scope.locator('.table-preferences-current-player').getAttribute('data-table-preferences-current'), 'true');
      }
      if (gameId === 'the-gang') await page.locator('#btn-table-menu').click();
      const nativeTable = ['poker', 'tien-len', 'sam-loc', 'phom'].includes(gameId);
      if (nativeTable) {
        const toggle = scope.locator('.native-table-preferences-menu > summary');
        await toggle.focus(); await toggle.press('Enter');
        assert.equal(await scope.locator('.native-table-preferences-menu').evaluate(node => node.open), true);
      }
      try { await scope.locator('.table-preferences-details > summary').click(); }
      catch (error) {
        console.error(await scope.evaluate(root => ({ display: getComputedStyle(root).display, rows: getComputedStyle(root).gridTemplateRows,
          children: [...root.children].map(node => ({ class: node.className, row: getComputedStyle(node).gridRow, top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height })) })));
        await page.screenshot({ path: path.join(__dirname, '..', 'test-results', `table-preferences-B06-${gameId}-placement.png`), fullPage: true });
        throw error;
      }
      const cardSelector = gameId === 'the-gang' ? '#my-cards-row .playing-card'
        : ['poker', 'tien-len', 'sam-loc', 'phom'].includes(gameId) ? '.hand .tl-card, .my-cards .playing-card' : '.uno-card, .tl-card, .playing-card, .bang-card';
      const cards = scope.locator(cardSelector);
      await cards.first().waitFor();
      const measure = () => cards.first().evaluate(node => ({ width: node.getBoundingClientRect().width, font: parseFloat(getComputedStyle(node).fontSize) }));
      await scope.locator('select[name="cardSize"]').selectOption('compact');
      await page.waitForTimeout(80);
      const compact = await measure();
      const gangPublicSizes = gameId === 'the-gang' ? await scope.evaluate(root => [
        root.querySelector('.community-cards-row > *').getBoundingClientRect().width,
        root.querySelector('.opp-seat-capsule .playing-card').getBoundingClientRect().width,
      ]) : null;
      const nativePublicSizes = nativeTable ? await scope.evaluate(root => [...root.querySelectorAll('.table-stage :is(.tl-card, .table-card, .playing-card)')]
        .map(card => [card.getBoundingClientRect().width, card.getBoundingClientRect().height])) : null;
      await scope.locator('select[name="cardSize"]').selectOption('large');
      await page.waitForFunction(({ compact, cardSelector }) => {
        const root = [...document.querySelectorAll('.table-preferences-scope')].find(node => node.offsetParent);
        const card = root?.querySelector(cardSelector);
        return card && card.getBoundingClientRect().width > compact + 4;
      }, { compact: compact.width, cardSelector });
      if (gangPublicSizes) {
        const actual = await scope.evaluate(root => [
          root.querySelector('.community-cards-row > *').getBoundingClientRect().width,
          root.querySelector('.opp-seat-capsule .playing-card').getBoundingClientRect().width,
        ]);
        assert.deepEqual(actual, gangPublicSizes, 'The Gang card preference preserves public board and opponent thumbnail sizes');
      }
      if (nativePublicSizes) {
        const actual = await scope.evaluate(root => [...root.querySelectorAll('.table-stage :is(.tl-card, .table-card, .playing-card)')]
          .map(card => [card.getBoundingClientRect().width, card.getBoundingClientRect().height]));
        assert.deepEqual(actual, nativePublicSizes, 'Native card preferences preserve the public board dimensions');
      }
      await scope.locator('select[name="textSize"]').selectOption('standard');
      await page.waitForTimeout(80);
      const standard = await measure();
      await scope.locator('select[name="textSize"]').selectOption('largest');
      await page.waitForFunction(({ standard, cardSelector }) => {
        const root = [...document.querySelectorAll('.table-preferences-scope')].find(node => node.offsetParent);
        const card = root?.querySelector(cardSelector);
        return card && parseFloat(getComputedStyle(card).fontSize) > standard + 1;
      }, { standard: standard.font, cardSelector });
      for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
        await page.setViewportSize(viewport);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const panel = scope.locator('.table-preferences-panel');
        const rect = await panel.boundingBox();
        assert.ok(rect.x >= 0 && rect.x + rect.width <= viewport.width + 1, `${gameId}/${variant} preferences fit ${viewport.width}: ${JSON.stringify(rect)}`);
        const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        if (pageWidth > viewport.width + 1) console.error(await scope.evaluate(root => [...root.querySelectorAll('*')]
          .filter(node => node.getClientRects().length && node.getBoundingClientRect().right > innerWidth + 1)
          .slice(0, 15).map(node => ({ tag: node.tagName, class: node.className, text: node.textContent.slice(0, 100),
            left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }))));
        assert.ok(pageWidth <= viewport.width + 1, `${gameId}/${variant} entire table fits ${viewport.width}: ${pageWidth}`);
        if (gameId === 'the-gang') {
          const menuRect = await page.locator('#table-tools-menu').boundingBox();
          assert.ok(menuRect.y >= 0 && menuRect.y + menuRect.height <= viewport.height + 1, `The Gang menu fits available height: ${JSON.stringify(menuRect)}`);
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      if (gameId === 'uno' && variant === 'classic-local-v1') {
        fs.mkdirSync(path.join(__dirname, '..', 'test-results'), { recursive: true });
        await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'table-preferences-B06-product-uno112-mobile.png'), fullPage: true });
      }
      await page.reload();
      const restored = page.locator('.table-preferences-scope:visible');
      await restored.waitFor();
      assert.equal(await restored.getAttribute('data-card-size'), 'large');
      assert.equal(await restored.getAttribute('data-text-size'), 'largest');
      await context.close();
      console.log(`${gameId}/${variant} actual table preferences passed: actor, dimensions, text, four viewports, reload.`);
    }
    assert.deepEqual(errors, []);
    console.log('B06 eight actual product tables passed; all fixtures use temporary storage.');
  } finally {
    if (browser) await browser.close();
    clients.forEach(client => client.disconnect());
    await game.close();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
