'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { io: socketClient } = require('socket.io-client');
const crypto = require('node:crypto');
const { createGameServer } = require('../src/httpServer');

async function main() {
  const game = createGameServer(); await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const errors = []; let browser;
  const output = path.join(__dirname, '..', 'test-results'); fs.mkdirSync(output, { recursive: true });
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    for (const id of ['sam-loc', 'tien-len', 'phom', 'poker']) {
      const desktop = await browser.newContext({ viewport: { width: 1280, height: 850 } });
      const mobile = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
      const host = await desktop.newPage(), guest = await mobile.newPage();
      for (const page of [host, guest]) { page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message)); }
      await host.goto(`${url}/${id}`); await host.locator('#name').fill('Chủ bàn'); await host.locator('#create').click();
      await host.locator('#room-view:not([hidden])').waitFor(); const code = await host.locator('#room-title').innerText();
      await guest.goto(`${url}/${id}?room=${code}`); await guest.locator('#name').fill('Khách'); await guest.locator('#join').click();
      await host.locator('#room-players .player').nth(1).waitFor();
      if (id === 'poker') for (const page of [host, guest]) { await page.locator('#buyin').click(); await page.waitForFunction(() => state.myStack === 200); }
      const manager = game.gm.managerForCode(code), room = manager.rooms.get(code);
      for (let round = 0; round < 2; round++) {
        if (round === 0) {
          await host.locator('#ready').click(); await guest.locator('#ready').click(); await host.locator('#start').click();
        }
        await host.locator('#game-view:not([hidden])').waitFor();
        const previousMatch = room.matchId;
        if (round === 0) {
          const revision = room.revision, privateCards = await guest.evaluate(() => JSON.stringify(state.myHand || state.myHoleCards));
          await guest.setViewportSize({ width: 390, height: 844 });
          try { await guest.locator('.table-rotation-gate:not([hidden])').waitFor(); }
          catch (error) { console.error('Rotation fixture', { id, ui: await guest.evaluate(() => ({ width: innerWidth, height: innerHeight, orientation: window.orientation, screen: screen.orientation.type, phone: MobileUI.isPhonePortrait(), focus: document.activeElement.outerHTML.slice(0, 150), gate: document.querySelector('.table-rotation-gate').hidden, view: document.querySelector('#game-view').hidden, viewport: visualViewport.width })) }); throw error; }
          assert.equal(await guest.locator('.tl-shell,.pk-shell').evaluate(el => el.inert), true);
          await guest.evaluate(() => { document.documentElement.requestFullscreen = async () => { throw new Error('Fullscreen unavailable in fixture'); }; });
          await guest.locator('.table-rotation-gate button').click();
          await guest.waitForFunction(() => document.querySelector('.rotation-note').textContent.includes('chưa hỗ trợ'));
          await guest.setViewportSize({ width: 844, height: 390 }); await guest.locator('.table-rotation-gate').waitFor({ state: 'hidden' });
          assert.equal(await guest.evaluate(() => JSON.stringify(state.myHand || state.myHoleCards)), privateCards);
          assert.equal(room.revision, revision);
          assert.equal(await guest.locator('.table-stage').count(), 1);
        }
        if (id === 'sam-loc') {
          if (round === 0) {
            const before = parseInt(await guest.locator('#sam-countdown').innerText());
            await guest.evaluate(() => { Date.now = () => 1; });
            await new Promise(resolve => setTimeout(resolve, 2200));
            assert.ok(parseInt(await guest.locator('#sam-countdown').innerText()) <= before - 2, 'Countdown ticks without a state message and ignores device clock skew');
          }
          await host.getByRole('button', { name: 'Không báo', exact: true }).click();
          try { await guest.getByRole('button', { name: 'Không báo', exact: true }).click(); }
          catch (error) { await guest.screenshot({ path: path.join(output, 'video-flow-rotation-failure.png') }); console.error('Rotated controls', await guest.evaluate(() => ({ width: innerWidth, height:innerHeight, y:scrollY, body:document.body.className, rects:[...document.querySelectorAll('#actions,.hand,.table-stage,.table-stage>.table')].map(el=>({class:el.className, rect:el.getBoundingClientRect().toJSON(), style: getComputedStyle(el).display})) }))); throw error; }
          await host.waitForFunction(() => state.phase === 'TURN');
        }
        if (round === 0) {
          await guest.waitForFunction(() => [...document.querySelectorAll('img.card-art')].every(img => img.complete && img.naturalWidth > 0));
          await host.screenshot({ path: path.join(output, `thrill-${id}-desktop.png`) });
          await guest.screenshot({ path: path.join(output, `thrill-${id}-landscape.png`) });
        }
        if (id === 'poker') {
          const actor = room.currentPlayerId === room.players[0].id ? host : guest;
          await actor.getByRole('button', { name: 'Fold', exact: true }).click();
        } else {
          // Shorten only the in-memory fixture: engine settlement and socket delivery are real.
          if (id === 'tien-len') manager.finish(room, room.players[0], 'Browser rematch fixture');
          if (id === 'sam-loc') manager.finishNormal(room, room.players[0], null, 'Browser rematch fixture');
          if (id === 'phom') { room.players.forEach((p, index) => { p.score = index * 10; }); manager.finishRound(room, null, 'Browser rematch fixture'); }
          manager.touch(room); game.gm.broadcast(code);
        }
        await host.locator('#result:not([hidden])').waitFor(); await guest.locator('#result:not([hidden])').waitFor();
        assert.equal(room.players.length, 2);
        assert.equal(game.gm.profiles.publicProfile(room.players[0].profileId).balances[id === 'poker' ? 'chip' : 'coin'].reserved, id === 'poker' ? 200 : 0);
        if (round === 0) {
          await guest.screenshot({ path: path.join(output, `thrill-${id}-result.png`) });
          await host.getByRole('button', { name: id === 'poker' ? 'Mở hand tiếp theo' : 'Chia ván tiếp', exact: true }).click();
          if (id === 'poker') { await host.waitForFunction(() => state.phase === 'HAND'); assert.notEqual(room.matchId, previousMatch); }
          else { await host.waitForFunction(() => !['WAITING','RESULT'].includes(state.phase)); await guest.waitForFunction(() => !['WAITING','RESULT'].includes(state.phase)); assert.notEqual(room.matchId, previousMatch); assert.equal(room.code, code); }
        }
      }
      if (id !== 'poker') assert.equal(room.history.length, 2);
      assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await desktop.close(); await mobile.close();
      console.log(`PASS: ${id} two rounds, same room, currency, table, rotation${id === 'sam-loc' ? ', live timer' : ''}`);
    }
    for (const [id, count] of [['poker', 6], ['sam-loc', 5], ['tien-len', 4], ['phom', 4]]) {
      const clients = [], context = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
      try {
        for (let i = 0; i < count; i++) {
          const client = socketClient(url, { transports: ['websocket'], forceNew: true }); clients.push(client);
          await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
        }
        const serverSockets = clients.map(client => game.io.sockets.sockets.get(client.id));
        const created = game.gm.createRoom(serverSockets[0], 'Chủ bàn', 'ADVANCED', '🎲', id);
        for (let i = 1; i < count; i++) assert.ok(!game.gm.joinRoom(serverSockets[i], created.roomCode, `Người chơi ${i + 1}`, '🎲').error);
        const manager = game.gm.managerForCode(created.roomCode), room = manager.rooms.get(created.roomCode);
        for (const socket of serverSockets) {
          if (id === 'poker') game.gm.gameAction(socket, room.code, { action: 'buy_in', amount: 200, actionId: crypto.randomUUID(), expectedRevision: room.revision });
          game.gm.setReady(socket, room.code, true);
        }
        assert.ok(!game.gm.startGame(serverSockets[0], room.code)?.error);
        await new Promise(resolve => { serverSockets[0].once('disconnect', resolve); clients[0].disconnect(); });
        await context.addInitScript(({ id, created }) => {
          localStorage.setItem(`chill-thrill:${id}:${created.roomCode}`, JSON.stringify(created));
          localStorage.setItem('chill-thrill:profile-token', created.profileToken);
        }, { id, created });
        const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${url}/${id}?room=${room.code}`);
        try { await page.locator('#game-view:not([hidden])').waitFor(); }
        catch (error) { console.error('Full table fixture:', { id, serverPhase: room.phase, seats: room.players.map(p => ({ name:p.name, ready:p.ready, stack:p.stack, connected:p.connected })), browser: await page.evaluate(() => ({ notice:document.querySelector('#notice').textContent, phase:state?.phase })) }); throw error; }
        await page.waitForFunction(count => document.querySelectorAll('#players > .player').length === count, count);
        const layout = await page.evaluate(() => {
          const rect = el => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom }; };
          return { width:innerWidth, height:innerHeight, center:rect(document.querySelector('.table-stage > .table')), seats:[...document.querySelectorAll('#players > .player')].map(rect), hand:rect(document.querySelector('.hand,.my-cards')), handChildren:[...document.querySelector('.hand,.my-cards').children].map(el=>({ id:el.id, class:el.className, rect:rect(el), display:getComputedStyle(el).display, minHeight:getComputedStyle(el).minHeight, gap:getComputedStyle(el).gap })) };
        });
        await page.screenshot({ path: path.join(output, `thrill-${id}-${count}-players.png`) });
        const overlap = (a,b) => a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1;
        for (const [index, seat] of layout.seats.entries()) {
          assert.ok(seat.x >= 0 && seat.right <= layout.width && seat.y >= 0 && seat.bottom <= layout.height, JSON.stringify(layout));
          assert.ok(!overlap(seat, layout.center), 'Seat covers table cards: ' + JSON.stringify(layout));
          assert.ok(!layout.seats.slice(index + 1).some(other => overlap(seat, other)), 'Seats overlap: ' + JSON.stringify(layout));
        }
        assert.ok(layout.hand.bottom <= layout.height + 1, 'Private hand clipped: ' + JSON.stringify(layout));
        console.log(`PASS: ${id} ${count} seats fit with visible private hand and no overlap`);
        for (const viewport of [{ width: 667, height: 375 }, { width: 740, height: 360 }]) {
          await page.setViewportSize(viewport);
          const short = await page.evaluate(() => {
            const rect = el => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom }; };
            const doc = document.documentElement;
            const bad = [...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > doc.clientWidth + 1).map(el => ({ tag: el.tagName, id: el.id, cls: el.className, right: el.getBoundingClientRect().right }));
            return { center:rect(document.querySelector('.table-stage > .table')), seats:[...document.querySelectorAll('#players > .player')].map(rect), hand:rect(document.querySelector('.hand,.my-cards')), overflow:doc.scrollWidth > doc.clientWidth + 1, scrollW: doc.scrollWidth, clientW: doc.clientWidth, bad };
          });
          assert.ok(!short.overflow && short.hand.bottom <= viewport.height + 1, `${id} clipped in ${JSON.stringify(viewport)}: ${JSON.stringify(short)}`);
          for (const [index, seat] of short.seats.entries()) {
            assert.ok(!overlap(seat, short.center) && !short.seats.slice(index+1).some(other => overlap(seat, other)), `${id} overlapping short table: ${JSON.stringify(short)}`);
          }
        }
        console.log(`PASS: ${id} full table also fits 667x375 and 740x360`);
      } finally { await context.close(); clients.forEach(client => client.disconnect()); }
    }
    const art = await browser.newPage(); await art.goto(url);
    await art.route('**/8S.webp', route => route.abort());
    await art.evaluate(() => { const el = document.createElement('div'); el.className = 'playing-card'; document.body.append(el); GameArt.paintCard(el, { rank: '8', suit: 'S' }); });
    await art.waitForFunction(() => { const img = document.querySelector('[data-card="8S"] img'); return img?.src.endsWith('.png') && img.complete && img.naturalWidth > 0; });
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/assets/game/manifest.json'), 'utf8'));
    await art.evaluate(async urls => {
      for (const url of urls) await new Promise((resolve, reject) => { const img = new Image(); img.onload = resolve; img.onerror = () => reject(new Error(url)); img.src = url; });
    }, Object.values(manifest.cards).map(card => card.url.replace('.webp', '.png')));
    const identity = game.gm.profiles.createProfile({ displayName: 'Quy đổi' });
    game.gm.profiles.executeOperation('fixture', 'wallet-ui-fixture-credit', {}, at => game.gm.profiles.writeWallet(identity.profile.id, 20000000, 0, { currency: 'coin', operationKey: 'wallet-ui-fixture-credit', source: 'fixture', note: 'Temporary UI fixture', at }));
    await art.evaluate(token => localStorage.setItem('chill-thrill:profile-token', token), identity.sessionToken); await art.reload();
    await art.locator('#btn-tab-profile').click();
    await art.locator('#wallet-exchange:not([hidden])').waitFor();
    await art.locator('#wallet-exchange input').fill('2'); await art.locator('#wallet-exchange button.btn-exchange-submit').click();
    await art.waitForFunction(() => document.querySelector('[data-balance="gem"]').textContent === '2');
    await art.locator('#wallet-exchange select').selectOption('gem-to-coin'); await art.locator('#wallet-exchange input').fill('1'); await art.locator('#wallet-exchange button.btn-exchange-submit').click();
    await art.waitForFunction(() => document.querySelector('[data-balance="gem"]').textContent === '1');
    assert.equal(game.gm.profiles.publicProfile(identity.profile.id).balances.coin.available, 10001000);
    assert.equal(game.gm.profiles.publicProfile(identity.profile.id).wallet.available, 1000);
    await art.locator('#wallet-exchange').scrollIntoViewIfNeeded();
    await art.screenshot({ path: path.join(output, 'currency-wallet.png'), fullPage: true });
    console.log('PASS: coin/gem exchange UI updates both balances while Poker chips remain unchanged');
    assert.deepEqual(errors, []); console.log('PASS: missing WebP uses PNG, all 52 PNG faces decode, zero page errors');
  } finally { await browser?.close(); await game.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
