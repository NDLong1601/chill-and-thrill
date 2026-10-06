'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

const scenarios = [
  { gameId: 'tien-len', stake: 50, manager: 'tienLen' },
  { gameId: 'sam-loc', stake: 500, manager: 'samLoc' },
  { gameId: 'phom', stake: 10000, manager: 'phom' },
];

function creditFixture(game, profileId, key) {
  const profiles = game.gm.profiles;
  const available = profiles.publicProfile(profileId).balances.coin.available;
  if (available >= 2_000_000) return;
  profiles.executeOperation('fixture', key, {}, at => profiles.writeWallet(profileId, 2_000_000, 0, {
    currency: 'coin', operationKey: key, source: 'fixture', note: 'A05 temporary UI fixture funds', at,
  }));
}

async function readUiEconomy(page, phase) {
  return page.evaluate(({ phase }) => {
    const displayed = document.querySelector('[data-economy-summary]')?.textContent || '';
    return { displayed, state: { phase: state.phase, currency: state.currency, stake: state.stake, maxLoss: state.maxLoss, result: state.result } };
  }, { phase });
}

async function main() {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'a05-stakes-'));
  const fixtureDatabase = path.join(fixtureDirectory, 'profiles.sqlite');
  const fixtureRooms = path.join(fixtureDirectory, 'tien-len.json');
  const serverOptions = { databaseFile: fixtureDatabase, storageFile: path.join(fixtureDirectory, 'rooms.json'), tienLenStorageFile: fixtureRooms };
  let game = createGameServer(serverOptions);
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    for (const scenario of scenarios) {
      const hostContext = await browser.newContext({ viewport: { width: 1280, height: 850 } });
      const guestContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
      const host = await hostContext.newPage(), guest = await guestContext.newPage();
      for (const page of [host, guest]) { page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message)); }

      await host.goto(url);
      await host.locator('#portal-player-name').fill(`A05 ${scenario.gameId} host`);
      await host.locator(`[data-game-card-action="${scenario.gameId}"]`).click();
      await host.locator('#screen-game-detail.active').waitFor();
      await host.locator('#detail-stake').fill(String(scenario.stake));
      const prettyStake = scenario.stake.toLocaleString('vi-VN');
      await host.waitForFunction(expected => document.getElementById('detail-stake-summary').textContent.includes(`Cược ${expected} coin/người`), prettyStake);
      await host.locator('#detail-create').click();
      await host.waitForURL(new RegExp(`/${scenario.gameId}\\?room=`));
      await host.locator('#room-view:not([hidden])').waitFor();
      const code = await host.locator('#room-title').innerText();
      let room = game.gm[scenario.manager].rooms.get(code);
      assert.equal(room.stake, scenario.stake, `${scenario.gameId} stored configured stake`);
      assert.match(await host.locator('#room-status').innerText(), new RegExp(`Cược ${prettyStake} coin/người`));

      await guest.goto(`${url}/${scenario.gameId}?room=${code}`);
      await guest.locator('#name').fill(`A05 ${scenario.gameId} guest`);
      await guest.locator('#join').click();
      await host.locator('#room-players .player').nth(1).waitFor();
      assert.equal(room.players.length, 2);
      room.players.forEach((player, index) => creditFixture(game, player.profileId, `a05-funds-${scenario.gameId}-${index}`));
      await host.locator('#ready').click();
      await guest.locator('#ready').click();
      try { await host.locator('#start').click(); }
      catch (error) {
        console.error('A05 start diagnostics:', JSON.stringify({ gameId: scenario.gameId,
          browser: await host.evaluate(() => ({ state, notice: document.getElementById('notice')?.textContent })),
          storage: await fetch(`${url}/api/storage/status`).then(response => response.json()) }));
        throw error;
      }
      await host.locator('#game-view:not([hidden])').waitFor();
      await guest.locator('#game-view:not([hidden])').waitFor();

      const activeHold = scenario.gameId === 'tien-len' ? scenario.stake : room.maxLoss;
      for (const page of [host, guest]) {
        const ui = await readUiEconomy(page, 'active');
        assert.equal(ui.state.currency, 'coin', `${scenario.gameId} currency comes from server state`);
        assert.equal(ui.state.stake, scenario.stake);
        assert.equal(ui.state.maxLoss, activeHold, `${scenario.gameId} reports the per-player hold separately`);
        assert.ok(ui.displayed.includes(`Cược ${prettyStake} coin/người`), ui.displayed);
        assert.ok(ui.displayed.includes(`giữ tối đa ${activeHold.toLocaleString('vi-VN')} coin/người`), ui.displayed);
      }

      if (scenario.gameId === 'tien-len') {
        const oldReservations = room.reservations;
        game.gm.profiles.releaseReservations({ reservations: oldReservations, operationKey: `a05-chip-release-${room.matchId}`, roomCode: room.code, matchId: room.matchId, note: 'Temporary legacy chip room fixture' });
        const chipHold = game.gm.profiles.reserveMany({ currency: 'chip', roomCode: room.code, matchId: room.matchId, operationKey: `a05-chip-hold-${room.matchId}`, reservations: room.players.map(player => ({ profileId: player.profileId, amount: room.stake })) });
        room.reservations = chipHold.held;
        game.gm.profiles.transaction(() => game.gm.profiles.saveGameSnapshot({ gameId: 'tien-len', room }));
        game.gm.tienLen.broadcast(code);
        await host.waitForFunction(() => state.currency === 'chip');
        const ui = await readUiEconomy(host, 'legacy-chip-active');
        assert.ok(ui.displayed.includes(`Cược ${prettyStake} chip/người`), ui.displayed);
        assert.ok(ui.displayed.includes(`giữ tối đa ${room.stake.toLocaleString('vi-VN')} chip/người`), ui.displayed);

        const port = game.server.address().port;
        await game.close();
        game = createGameServer(serverOptions);
        await new Promise(resolve => game.server.listen(port, '127.0.0.1', resolve));
        room = game.gm.tienLen.rooms.get(code);
        assert.ok(room, 'active Tiến lên room restored from temporary SQLite snapshot');
        assert.equal(game.gm.profiles.reservationCurrency(room.reservations), 'chip');
        await host.reload(); await guest.reload();
        await host.waitForFunction(() => socket.connected && state.phase === 'TURN' && state.currency === 'chip' && !state.paused);
        await guest.waitForFunction(() => socket.connected && state.phase === 'TURN' && state.currency === 'chip' && !state.paused);
        const restoredUi = await readUiEconomy(host, 'restored-chip-active');
        assert.ok(restoredUi.displayed.includes(`Cược ${prettyStake} chip/người`), restoredUi.displayed);
        assert.ok(restoredUi.displayed.includes(`giữ tối đa ${room.stake.toLocaleString('vi-VN')} chip/người`), restoredUi.displayed);
      }

      if (scenario.gameId === 'tien-len') game.gm.tienLen.finish(room, room.players[0], 'A05 fixture');
      else if (scenario.gameId === 'sam-loc') game.gm.samLoc.finishNormal(room, room.players[0], null, 'A05 fixture');
      else game.gm.phom.finishRound(room, null, 'A05 fixture');
      game.gm[scenario.manager].touch(room);
      game.gm[scenario.manager].broadcast(code);
      await host.locator('#result:not([hidden])').waitFor();
      const result = await readUiEconomy(host, 'result');
      const resultHold = scenario.gameId === 'tien-len' ? scenario.stake : result.state.result.maxLoss;
      assert.equal(result.state.currency, scenario.gameId === 'tien-len' ? 'chip' : 'coin');
      assert.equal(result.state.result.stake, scenario.stake);
      assert.equal(result.state.result.maxLoss ?? result.state.maxLoss, resultHold);
      assert.ok(result.displayed.includes(`Cược ${prettyStake} ${scenario.gameId === 'tien-len' ? 'chip' : 'coin'}/người`), result.displayed);
      assert.ok(result.displayed.includes(`giữ tối đa ${resultHold.toLocaleString('vi-VN')} ${scenario.gameId === 'tien-len' ? 'chip' : 'coin'}/người`), result.displayed);

      await guestContext.close(); await hostContext.close();
    }
    assert.deepEqual(errors, [], 'stake flows render without browser page errors');
    console.log('PASS: A05 stakes 50/500/10,000 at portal detail, waiting room, table, and result; restored chip-denominated reservation shown as chip.');
  } finally {
    await browser?.close();
    await game?.close();
    const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
    const target = path.resolve(fixtureDirectory);
    if (target.startsWith(tempRoot)) fs.rmSync(target, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
