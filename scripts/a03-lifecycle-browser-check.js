'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

function tempDirectory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'a03-browser-')); }
function removeTemp(directory) {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(directory, { recursive: true, force: true });
}

async function client(browser, url, name, errors) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  return { context, page, name };
}

async function createRoom(player, url, gamePath) {
  await player.page.goto(`${url}${gamePath}`);
  await player.page.locator('#name').fill(player.name);
  await player.page.locator('#create').click();
  await player.page.locator('#room-view:not([hidden])').waitFor();
  return player.page.locator('#room-title').innerText();
}

async function joinRoom(player, url, gamePath, code) {
  await player.page.goto(`${url}${gamePath}?room=${code}`);
  await player.page.locator('#name').fill(player.name);
  await player.page.locator('#join').click();
  await player.page.locator('#room-view:not([hidden])').waitFor();
}

async function disconnectProgression(page, bannerText, disconnect) {
  await disconnect();
  await page.waitForFunction(expected => {
    const banner = document.querySelector('#reconnect-lifecycle-banner');
    return banner && !banner.hidden && new RegExp(expected).test(banner.textContent);
  }, bannerText.source, { timeout: 10000 });
  const banner = page.locator('#reconnect-lifecycle-banner');
  assert.match(await banner.innerText(), /còn \d+ giây/);
  return banner;
}

async function testTienLifecycle(browser, game, url, errors) {
  const host = await client(browser, url, 'A03 Chủ coin', errors);
  const guest = await client(browser, url, 'A03 Khách coin', errors);
  const third = await client(browser, url, 'A03 Bạn coin', errors);
  try {
    const code = await createRoom(host, url, '/tien-len');
    await joinRoom(guest, url, '/tien-len', code); await joinRoom(third, url, '/tien-len', code);
    await host.page.locator('#room-players .player').nth(2).waitFor();
    await host.page.locator('#ready').click(); await guest.page.locator('#ready').click(); await third.page.locator('#ready').click();
    await host.page.locator('#start:not([hidden])').click();
    await host.page.locator('#game-view:not([hidden])').waitFor(); await guest.page.locator('#game-view:not([hidden])').waitFor(); await third.page.locator('#game-view:not([hidden])').waitFor();

    const manager = game.gm.tienLen, room = manager.rooms.get(code);
    const guestSocketId = await guest.page.evaluate(() => socket.id);
    const offlineActor = room.players.find(player => player.socketId === guestSocketId);
    const thirdSocketId = await third.page.evaluate(() => socket.id);
    const graceWaiter = room.players.find(player => player.socketId === thirdSocketId);
    assert.ok(offlineActor, 'the browser guest must own a server seat');
    assert.ok(graceWaiter, 'the second browser guest must own a server seat');
    room.playedAny = true; room.topPlay = null; room.passedIds = [];
    room.currentPlayerId = offlineActor.id; room.leaderId = offlineActor.id;
    manager.broadcast(code);

    const banner = await disconnectProgression(host.page, /Đang chờ/, () => guest.page.evaluate(() => socket.disconnect()));
    await third.page.evaluate(() => socket.disconnect());
    offlineActor.reconnectDeadlineAt = Date.now() - 1000;
    offlineActor.disconnectedAt = offlineActor.reconnectDeadlineAt - manager.graceMs;
    graceWaiter.reconnectDeadlineAt = Date.now() + 60000;
    graceWaiter.disconnectedAt = graceWaiter.reconnectDeadlineAt - manager.graceMs;
    manager.broadcast(code);
    await host.page.waitForFunction(({ expired, waiting }) => {
      const text = document.querySelector('#reconnect-lifecycle-banner')?.textContent || '';
      return text.includes(expired) && text.includes('đã hết thời gian khôi phục') && text.includes(waiting) && /còn \d+ giây/.test(text);
    }, { expired: offlineActor.name, waiting: graceWaiter.name });
    assert.match(await banner.innerText(), /Sau 120 giây/);

    await host.page.locator('#game-leave').click();
    await host.page.waitForFunction(() => document.querySelector('#reconnect-lifecycle-banner')?.textContent.includes('Bạn sẽ rời phòng khi ván hiện tại kết thúc.'));

    const cardsBefore = offlineActor.hand.length;
    assert.equal(manager.turnClock.expire(room, Date.now()), false, 'a second offline seat still within grace protects the hand');
    assert.equal(offlineActor.hand.length, cardsBefore);

    graceWaiter.reconnectDeadlineAt = Date.now() - 1;
    graceWaiter.disconnectedAt = graceWaiter.reconnectDeadlineAt - manager.graceMs;
    const expired = manager.turnClock.expire(room, Date.now());
    assert.equal(expired, true);
    assert.equal(offlineActor.hand.length, cardsBefore - 1);
    assert.notEqual(room.currentPlayerId, offlineActor.id);
    graceWaiter.reconnectDeadlineAt = Date.now() + 60000;
    graceWaiter.disconnectedAt = graceWaiter.reconnectDeadlineAt - manager.graceMs;
    manager.refreshReconnectState(room); manager.broadcast(code);
    await host.page.waitForFunction(() => document.querySelector('#reconnect-lifecycle-banner')?.textContent.includes('đã hết thời gian khôi phục'));
    await host.page.waitForFunction(() => document.querySelector('#players .player.current'));
  } finally { await host.context.close(); await guest.context.close(); await third.context.close(); }
}

async function testPokerLifecycle(browser, game, url, errors) {
  const host = await client(browser, url, 'A03 Poker chủ', errors);
  const guest = await client(browser, url, 'A03 Poker khách', errors);
  const third = await client(browser, url, 'A03 Poker bạn', errors);
  try {
    const code = await createRoom(host, url, '/poker');
    await joinRoom(guest, url, '/poker', code); await joinRoom(third, url, '/poker', code);
    for (const player of [host, guest, third]) {
      await player.page.locator('#buyin').click();
      await player.page.waitForFunction(() => document.querySelector('#room-stack')?.textContent === '200');
    }
    for (const player of [host, guest, third]) await player.page.locator('#ready').click();
    await host.page.locator('#start:not([hidden])').click();
    for (const player of [host, guest, third]) await player.page.locator('#game-view:not([hidden])').waitFor();

    const manager = game.gm.poker, room = manager.rooms.get(code);
    const guestSocketId = await guest.page.evaluate(() => socket.id);
    const offlineActor = room.players.find(player => player.socketId === guestSocketId);
    assert.ok(offlineActor && offlineActor.inHand && !offlineActor.folded, 'the browser guest must be live in the hand');
    room.currentPlayerId = offlineActor.id;
    room.currentBet = Math.max(...room.players.map(player => player.roundBet || 0)) + 1;
    manager.broadcast(code);

    const banner = await disconnectProgression(host.page, /Đang chờ/, () => guest.page.evaluate(() => socket.disconnect()));
    await host.page.locator('#game-leave').click();
    await host.page.waitForFunction(() => document.querySelector('#reconnect-lifecycle-banner')?.textContent.includes('Bạn sẽ rời phòng khi ván hiện tại kết thúc.'));
    assert.match(await banner.innerText(), /check khi hợp lệ hoặc fold khi cần theo cược/);

    offlineActor.reconnectDeadlineAt = Date.now() - 1;
    offlineActor.disconnectedAt = offlineActor.reconnectDeadlineAt - manager.graceMs;
    assert.equal(manager.turnClock.expire(room, offlineActor.reconnectDeadlineAt), true);
    assert.equal(offlineActor.folded, true, 'the disconnected Poker actor folds when there is a call');
    assert.equal(room.phase, 'HAND', 'the other two live seats continue the hand');
    assert.notEqual(room.currentPlayerId, offlineActor.id);
    await host.page.waitForFunction(name => [...document.querySelectorAll('#players .player')]
      .some(player => player.textContent.includes(name) && player.classList.contains('folded')), offlineActor.name);
    await host.page.waitForFunction(() => document.querySelector('#reconnect-lifecycle-banner')?.textContent.includes('Bạn sẽ rời phòng khi ván hiện tại kết thúc.'));
  } finally { await host.context.close(); await guest.context.close(); await third.context.close(); }
}

async function main() {
  const directory = tempDirectory();
  const game = createGameServer({
    databaseFile: path.join(directory, 'profiles.sqlite'), storageFile: path.join(directory, 'rooms.json'),
    graceMs: 120000,
  });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const errors = []; let browser;
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    await testTienLifecycle(browser, game, url, errors);
    await testPokerLifecycle(browser, game, url, errors);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await game.close();
    removeTemp(directory);
  }
}

main().then(() => console.log('A03 reconnect lifecycle browser check passed.')).catch(error => { console.error(error); process.exitCode = 1; });
