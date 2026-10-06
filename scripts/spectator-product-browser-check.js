'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');
const { projectSpectatorState } = require('../src/platform/spectatorProjection');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spectator-c07-product-'));
  const game = createGameServer({ storageFile: path.join(directory, 'rooms.json'), databaseFile: path.join(directory, 'profiles.sqlite') });
  const clients = [], errors = [], external = [];
  let base;
  let browser;
  const counts = () => Object.fromEntries(['profiles', 'wallets', 'wallet_ledger', 'wallet_operations', 'reservations', 'matches']
    .map(table => [table, game.gm.profiles.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  async function connect() {
    const client = io(base, { transports: ['websocket'], forceNew: true });
    clients.push(client);
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    return game.io.sockets.sockets.get(client.id);
  }
  function assertPublic(state, room) {
    const text = JSON.stringify(state);
    assert.doesNotMatch(text, /"(?:myHand|myHoleCards|privateCards|holeCards|profileId|profileToken|sessionToken|token|passwordHash|deck|drawPile|cardId)"/);
    for (const player of room.players) {
      for (const secret of [player.token, player.profileId]) if (secret) assert.equal(text.includes(secret), false);
    }
  }
  try {
    assert.ok(game.spectators, 'The production server mounts spectator support');
    await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${game.server.address().port}`;
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    for (const [gameId, variant, count] of [
      ['the-gang', 'base-v1', 3], ['uno', 'classic-local-v1', 2], ['uno', 'classic-108-v1', 2],
      ['tien-len', 'south-v1', 2], ['poker', 'holdem-nl-v1', 2], ['sam-loc', 'local-v1', 2],
      ['phom', 'local-v1', 2], ['bang', 'base-4th-edition-v1', 4],
    ]) {
      const host = await connect();
      const created = game.gm.createRoom(host, 'Viewer host', 'BASIC', '🎲', gameId, {
        maxPlayers: count, visibility: 'invite', password: 'watch-secret', ...(gameId === 'uno' ? { variant } : {}),
      });
      assert.equal(created.error, undefined);
      for (let i = 1; i < count; i++) {
        const guest = await connect();
        assert.equal(game.gm.joinRoom(guest, created.roomCode, `Viewer player ${i}`, '🕶️', 'watch-secret').error, undefined);
      }
      const manager = game.gm.managerForCode(created.roomCode), room = manager.rooms.get(created.roomCode);
      const beforeWatching = counts();
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addInitScript(() => {
        localStorage.setItem('chill-thrill:profile-token', 'spectator-must-not-use-profile');
        let clientFactory;
        Object.defineProperty(window, 'io', { configurable: true, get: () => clientFactory, set: factory => {
          clientFactory = (...args) => {
            const socket = factory(...args);
            window.__spectatorSocket = socket;
            window.__spectatorPackets = [];
            window.__playerPackets = [];
            socket.on('spectator:state', state => window.__spectatorPackets.push(state));
            socket.on('game_state', state => window.__playerPackets.push(state));
            return socket;
          };
        } });
      });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(`${gameId}: ${error.message}`));
      await page.route('**/*', route => {
        if (new URL(route.request().url()).hostname !== '127.0.0.1') { external.push(route.request().url()); return route.abort(); }
        return route.continue();
      });
      if (gameId === 'the-gang') {
        await page.goto(base);
        await page.locator('#portal-watch').click();
        await page.getByText('Nhập mã phòng 4 ký tự để mở chế độ khán giả.', { exact: true }).waitFor();
        await page.locator('#portal-room-code').fill(room.code);
        await page.locator('#portal-watch').click();
        await page.waitForURL(`${base}/spectate/${room.code}`);
      } else await page.goto(`${base}/spectate/${room.code}`);
      await page.locator('#room-password').fill('wrong');
      await page.locator('#spectator-form button').click();
      await page.getByText('Không tìm thấy phòng hoặc mật khẩu không đúng.', { exact: true }).waitFor();
      assert.equal(await page.locator('#watch-view').isVisible(), false);
      await page.locator('#room-password').fill('watch-secret');
      await page.locator('#spectator-form button').click();
      await page.locator('#watch-view:not([hidden])').waitFor();
      assert.equal(await page.locator('#player-list .player-row').count(), count);
      assert.equal(await page.locator('#room-password').inputValue(), '');
      assert.deepEqual(counts(), beforeWatching, 'Watching never creates profiles, holds, ledger entries or matches');
      assert.equal(await page.evaluate(() => Object.keys(window.__spectatorSocket.auth).length), 0);
      const state = await page.evaluate(() => window.__spectatorPackets.at(-1));
      assert.deepEqual(state, projectSpectatorState(game.gm, room.code)); assertPublic(state, room);

      if (gameId === 'poker') room.players.forEach((player, index) => {
        assert.equal(manager.action(game.io.sockets.sockets.get(player.socketId), room.code, {
          action: 'buy_in', amount: 200, actionId: `watch-buy-${index}`, expectedRevision: room.revision,
        })?.error, undefined);
      });
      room.players.forEach(player => game.gm.setReady(game.io.sockets.sockets.get(player.socketId), room.code, true));
      assert.equal(game.gm.startGame(host, room.code)?.error, undefined);
      await page.waitForFunction(() => window.__spectatorPackets.at(-1)?.phase !== 'WAITING');
      const playingState = await page.evaluate(() => window.__spectatorPackets.at(-1)); assertPublic(playingState, room);
      assert.equal(await page.evaluate(() => window.__playerPackets.length), 0);
      const beforeBlocked = counts();
      for (const event of ['join_room', 'room:join', 'game_action', 'game:action', 'start_game', 'profile_bootstrap']) {
        const blocked = await page.evaluate(({ event, code }) => new Promise(resolve => {
          window.__spectatorSocket.once('spectator:role_error', resolve);
          window.__spectatorSocket.emit(event, { roomCode: code, action: 'draw', playerName: 'Intruder' });
        }), { event, code: room.code });
        assert.equal(blocked.code, 'SPECTATOR_READ_ONLY');
      }
      assert.deepEqual(counts(), beforeBlocked);
      assert.equal(room.players.length, count);
      for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
        await page.setViewportSize(viewport);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${gameId} spectator fits ${viewport.width}`);
      }
      if (gameId === 'the-gang') {
        const oldSocketId = await page.evaluate(() => window.__spectatorSocket.id);
        const previousStateCount = await page.evaluate(() => window.__spectatorPackets.length);
        game.io.sockets.sockets.get(oldSocketId).conn.close();
        await page.waitForFunction(oldId => window.__spectatorSocket.connected && window.__spectatorSocket.id !== oldId, oldSocketId);
        await page.waitForFunction(count => window.__spectatorPackets.length > count, previousStateCount);
        assert.equal(await page.locator('#watch-view').isVisible(), true, 'Password-protected watch rejoins after transport reconnect');
        const newId = await page.evaluate(() => window.__spectatorSocket.id);
        assert.equal(game.spectators.service.roomBySocket.get(newId), room.code);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'spectator-C07-product-mobile.png'), fullPage: true });
      }
      await page.locator('#leave-button').click();
      await page.locator('#access-card:not([hidden])').waitFor();
      assert.equal(await page.evaluate(() => window.__spectatorSocket.connected), false);
      assert.deepEqual(counts(), beforeBlocked);
      assert.equal(await page.evaluate(() => localStorage.getItem('chill-thrill:profile-token')), 'spectator-must-not-use-profile');
      await context.close();
      console.log(`${gameId}/${variant}: production watch/password/live state/role guard/privacy/reconnect/layout passed.`);
    }
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log('C07 eight production spectator tables passed with temporary SQLite and no player/profile mutations.');
  } finally {
    await browser?.close(); clients.forEach(client => client.disconnect()); await game.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
