'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

async function main() {
  const game = createGameServer(); await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    const host = await context.newPage(); host.setDefaultTimeout(10000); host.on('pageerror', error => errors.push(error.message));
    await host.goto(url);
    await host.evaluate(() => { let name = 'Long Nguyễn'; for (let i = 0; i < 3; i++) name = JSON.stringify(name); localStorage.setItem('gang.playerName', name); });
    await host.reload(); assert.equal(await host.locator('#portal-player-name').inputValue(), 'Long Nguyễn');
    await host.goto(`${url}/games/tien-len`);
    await host.locator('#detail-stake').fill('10tr'); await host.locator('#detail-stake').blur();
    assert.equal(await host.locator('#detail-stake').inputValue(), '10.000.000');
    await host.locator('#detail-stake').fill('-500'); await host.locator('#detail-create').click();
    await host.locator('#detail-error:not(.hidden)').waitFor(); assert.equal(game.gm.tienLen.rooms.size, 0);
    await host.locator('#detail-stake').fill('500'); await host.locator('#detail-create').click();
    try { await host.waitForURL(/\/tien-len\?room=/); }
    catch (error) { console.error({ errors, rooms: game.gm.tienLen.rooms.size, ui: await host.evaluate(() => ({ url: location.href, error: document.getElementById('detail-error')?.textContent, name: document.getElementById('portal-player-name')?.value, amount: document.getElementById('detail-stake')?.value, connected: socket.connected })) }); throw error; }
    await host.locator('#room-view:not([hidden])').waitFor();
    const code = await host.locator('#room-title').innerText(), room = game.gm.tienLen.rooms.get(code);
    assert.equal(room.stake, 500); assert.equal(room.players[0].name, 'Long Nguyễn');
    const playerId = room.players[0].id;
    // Continue from another lobby while the existing table socket is active.
    const lobby = await context.newPage(); lobby.setDefaultTimeout(10000); lobby.on('pageerror', error => errors.push(error.message));
    await lobby.goto(url); await lobby.locator('#portal-resume').click();
    await lobby.waitForURL(/\/tien-len\?room=/); await lobby.locator('#room-view:not([hidden])').waitFor();
    assert.equal(room.players[0].id, playerId); assert.equal(room.players.length, 1);
    assert.doesNotMatch(await lobby.locator('#notice').innerText(), /cửa sổ khác/);
    const guestContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
    const guest = await guestContext.newPage(); guest.setDefaultTimeout(10000); guest.on('pageerror', error => errors.push(error.message));
    await guest.goto(`${url}/tien-len?room=${code}`); await guest.locator('#name').fill('Finn'); await guest.locator('#join').click();
    await lobby.locator('#room-players .player').nth(1).waitFor();
    await lobby.locator('#ready').click(); await guest.locator('#ready').click(); await lobby.locator('#start').click();
    await lobby.locator('#game-view:not([hidden])').waitFor(); await guest.locator('#game-view:not([hidden])').waitFor();
    assert.equal(await guest.locator('.hand > #actions').count(), 1);
    assert.equal(await guest.locator('#game-view > #actions').count(), 0);
    const active = room.currentPlayerId === room.players[0].id ? lobby : guest;
    const waiting = active === lobby ? guest : lobby;
    await active.locator('#actions:not([hidden])').waitFor(); await waiting.locator('#actions').waitFor({ state: 'hidden' });
    assert.ok(await active.locator('.turn-countdown').isVisible());
    const initial = parseInt(await active.locator('.turn-countdown').innerText());
    await active.evaluate(() => { Date.now = () => 1; });
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.ok(parseInt(await active.locator('.turn-countdown').innerText()) < initial);
    await active.screenshot({ path: path.join(__dirname, '..', 'test-results', 'table-updates-tien-len-landscape.png') });
    const match = room.matchId;
    game.gm.tienLen.finish(room, room.players[0], 'Browser fixture'); game.gm.tienLen.touch(room); game.gm.broadcast(code);
    const hostPage = lobby;
    await hostPage.getByRole('button', { name: 'Chia ván tiếp', exact: true }).click();
    await hostPage.waitForFunction(() => state.phase === 'TURN');
    assert.notEqual(room.matchId, match); assert.equal(room.players.length, 2);
    assert.equal(await hostPage.locator('#room-view').isVisible(), false);
    assert.deepEqual(errors, []);
    await guestContext.close(); await context.close();
    console.log('PASS: encoded name repair, amount validation, portal/table handoff, Continue with active seat, contextual actions, live 30s clock and immediate next round');
  } finally { await browser.close(); await game.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
