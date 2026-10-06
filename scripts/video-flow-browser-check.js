'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

async function touchSweep(page, from = 0, to = 2, cancel = false) {
  const cards = await page.locator('#hand button').evaluateAll(buttons => buttons.map(el => {
    const r = el.getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 };
  }));
  const cdp = await page.context().newCDPSession(page);
  const point = index => ({ ...cards[index], id: 1, radiusX: 2, radiusY: 2, force: 1 });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(from)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(to)] });
  await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function main() {
  const server = createGameServer(); await new Promise(resolve => server.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
  const errors = [];
  try {
    for (const id of ['tien-len', 'sam-loc', 'phom']) {
      const contexts = [], pages = [];
      try {
        for (let i = 0; i < 3; i++) {
          const context = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true }); contexts.push(context);
          const page = await context.newPage(); pages.push(page); page.setDefaultTimeout(8000); page.on('pageerror', error => errors.push(error.message));
          await page.goto(`${url}/${id}`); await page.locator('#name').fill(['Long Nguyễn', 'Finn', 'Người chơi 3'][i]);
          if (!i) { await page.locator('#create').click(); await page.locator('#room-view:not([hidden])').waitFor(); }
          else { await page.locator('#room-code').fill(await pages[0].locator('#room-title').innerText()); await page.locator('#join').click(); await page.locator('#room-view:not([hidden])').waitFor(); }
        }
        const code = await pages[0].locator('#room-title').innerText(), manager = server.gm.managerForCode(code), room = manager.rooms.get(code);
        for (const page of pages) await page.locator('#ready').click();
        await pages[0].locator('#start').click();
        for (const page of pages) await page.locator('#game-view:not([hidden])').waitFor();
        const waiting = pages.find((page, index) => room.players[index].id !== room.currentPlayerId);
        const revision = room.revision;
        // Real touch swipe, reverse swipe and cancellation work while waiting for a turn.
        await touchSweep(waiting); assert.equal(await waiting.locator('#hand .selected').count(), 3);
        assert.equal(await waiting.locator('#hand [aria-pressed="true"]').count(), 3);
        await touchSweep(waiting); assert.equal(await waiting.locator('#hand .selected').count(), 0);
        await touchSweep(waiting, 0, 2, true); assert.equal(await waiting.locator('#hand .selected').count(), 0);
        await waiting.locator('#hand button').first().focus(); await waiting.keyboard.press('Space');
        assert.equal(await waiting.locator('#hand .selected').count(), 1); assert.equal(room.revision, revision);
        await waiting.locator('#sort').click(); assert.equal(await waiting.locator('#hand .selected').count(), 1);
        if (id === 'sam-loc') {
          for (const page of pages) await page.getByRole('button', { name: 'Không báo', exact: true }).click();
          await pages[0].waitForFunction(() => state.phase === 'TURN');
        }
        const actorIndex = room.players.findIndex(player => player.id === room.currentPlayerId), actor = pages[actorIndex];
        for (const [index, page] of pages.entries()) if (index !== actorIndex) await page.locator('#actions').waitFor({ state: 'hidden' });
        await actor.waitForFunction(() => document.querySelector('#players .current .seat-time')?.textContent.endsWith('s'));
        assert.match(await actor.locator('#players .current .seat-avatar').evaluate(el => getComputedStyle(el).backgroundImage), /conic-gradient/);
        const infoButton = actor.locator('#players .seat-avatar').first(); await infoButton.click();
        await actor.locator('.seat-info-dialog[open]').waitFor(); assert.match(await actor.locator('.seat-info-dialog').innerText(), /lá trên tay/);
        await actor.keyboard.press('Escape'); assert.equal(await actor.locator('.seat-info-dialog').isVisible(), false);
        await actor.evaluate(() => { selected.clear(); renderHand(); renderActions(); window.sentActions = 0; socket.onAnyOutgoing(event => { if (event === 'game_action') window.sentActions++; }); });
        if (id !== 'phom') {
          const required = await actor.evaluate(() => state.initialRequiredCardId);
          await actor.locator(`#hand [data-card-id]:not([data-card-id="${required}"])`).first().click();
          assert.equal(await actor.locator('#actions button.primary').isDisabled(), true);
          await actor.evaluate(() => { selected.clear(); renderHand(); renderActions(); });
          await actor.locator(`#hand [data-card-id="${required}"]`).click();
        } else {
          assert.equal(await actor.evaluate(() => state.phase), 'DISCARD');
          await touchSweep(actor, 0, 1); assert.equal(await actor.locator('#actions button.primary').isDisabled(), true);
          await actor.evaluate(() => { selected.clear(); renderHand(); renderActions(); }); await actor.locator('#hand button').first().click();
        }
        await actor.screenshot({ path: path.join(__dirname, '..', 'test-results', `video-flow-${id}-selected.png`) });
        const before = room.revision;
        await actor.evaluate(() => { const button = document.querySelector('#actions button.primary'); button.click(); button.click(); });
        await actor.waitForFunction(revision => state.revision > revision, before);
        assert.equal(await actor.evaluate(() => window.sentActions), 1, 'One server submission for a rapid double press');
        assert.equal(room.revision, before + 1);
        const nextActor = pages[room.players.findIndex(player => player.id === room.currentPlayerId)];
        if (id !== 'phom') {
          const passer = room.currentPlayerId; await nextActor.getByRole('button', { name: 'Bỏ lượt', exact: true }).click();
          await actor.waitForFunction(() => state.passedIds.length === 1);
          assert.match(await actor.locator(`#players [data-player-id="${passer}"] .seat-status`).innerText(), /Bỏ lượt/);
        }
        // Memory-only shortened fixture; settlement, delivery and direct rematch use real engines.
        if (id === 'tien-len') manager.finish(room, room.players[0], 'Video interaction fixture');
        if (id === 'sam-loc') manager.finishNormal(room, room.players[0], null, 'Video interaction fixture');
        if (id === 'phom') { room.players.forEach((player, index) => { player.score = index * 10; }); manager.finishRound(room, null, 'Video interaction fixture'); }
        manager.touch(room); server.gm.broadcast(code);
        const host = pages[0]; await host.locator('#result:not([hidden])').waitFor();
        assert.equal(await host.locator('.result-player').count(), 3);
        const deltas = await host.locator('.result-delta').allTextContents(); assert.ok(deltas.every(value => /^[+-][\d.]+ coin$/.test(value)), deltas.join(' '));
        await host.screenshot({ path: path.join(__dirname, '..', 'test-results', `video-flow-${id}-result.png`) });
        await host.getByRole('button', { name: 'Đóng kết quả', exact: true }).click(); await host.locator('#result').waitFor({ state: 'hidden' });
        assert.equal(room.phase, 'RESULT'); await host.getByRole('button', { name: 'Kết quả', exact: true }).click();
        await host.emulateMedia({ reducedMotion: 'reduce' });
        const matchId = room.matchId; await host.getByRole('button', { name: 'Chia ván tiếp', exact: true }).click();
        await host.waitForFunction(matchId => state.matchId !== matchId && state.phase !== 'RESULT', matchId);
        assert.equal(await host.locator('#hand .selected').count(), 0);
        if (id === 'sam-loc') assert.equal(await host.getByRole('button', { name: 'Không báo', exact: true }).isEnabled(), true);
        assert.equal(await host.locator('#room-view').isVisible(), false);
        assert.equal(await host.evaluate(() => document.querySelector('#hand').getAnimations({ subtree: true }).length), 0, 'Reduced motion suppresses new-deal animation');
        if (id === 'phom') {
          // Exercise the longest action toolbar including a native destination selector.
          const card = (rank, suit) => ({ id: `${rank}${suit}`, rank, suit });
          room.phase = 'LAYDOWN'; room.currentPlayerId = room.players[0].id;
          room.players[0].hand = [card('3','S'), card('3','H'), card('3','C'), card('8','D'), card('7','S'), card('9','C'), card('J','H'), card('Q','D'), card('A','S')];
          room.players[0].eatenCardIds = [];
          room.players[1].laid = true; room.players[1].melds = [{ kind: 'set', cards: [card('8','S'), card('8','H'), card('8','C')] }];
          manager.touch(room); server.gm.broadcast(code); await host.getByRole('button', { name: 'Hạ bài', exact: true }).waitFor();
          assert.equal(await host.locator('#drafts').isVisible(), false);
          await host.locator('#hand [data-card-id="8D"]').click(); await host.locator('#actions select').selectOption('0');
          for (const size of [{ width: 844, height: 390 }, { width: 667, height: 375 }, { width: 740, height: 360 }]) {
            await host.setViewportSize(size);
            const bottom = await host.locator('.hand').evaluate(el => el.getBoundingClientRect().bottom);
            assert.ok(bottom <= size.height + 1, `Phom laydown hand clipped at ${JSON.stringify(size)}: ${bottom}`);
            assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
          }
          await host.getByRole('button', { name: 'Gửi', exact: true }).click(); await host.locator('#drafts:not([hidden])').waitFor();
          await host.screenshot({ path: path.join(__dirname, '..', 'test-results', 'video-flow-phom-laydown.png') });
        }
        console.log(`PASS: ${id} touch sweep/cancel, keyboard and off-turn selection, sort, legal play gate, seat clock/info, duplicate press, results and fresh-hand reset`);
      } finally { for (const context of contexts) await context.close(); }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
