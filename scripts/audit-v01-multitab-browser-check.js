'use strict';

// V01 multitab regression. Uses a real Socket.IO server, browser sockets and
// the shipped GameApiClient. All SQLite/room data is isolated under this repo's
// temporary workspace directory; no default data path is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');
const socketClientPath = path.resolve(path.dirname(require.resolve('socket.io')), '..', 'client-dist', 'socket.io.js');

const workspace = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(workspace, `.tmp-v01-multitab-${process.pid}-${Date.now()}`);
const profileTokenKey = 'chill-thrill:profile-token';
const seatCredentialsKey = roomCode => `chill-thrill:tien-len:${roomCode}`;
const timeout = ms => new Promise(resolve => setTimeout(resolve, ms));

function containedWorkspacePath(target) {
  const resolved = path.resolve(target);
  const root = `${workspace}${path.sep}`;
  if (!resolved.startsWith(root)) throw new Error('V01 temporary path escaped the workspace.');
  return resolved;
}

async function waitUntil(predicate, label, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await timeout(10);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function pageAck(page, event, payload) {
  return page.evaluate(({ eventName, requestPayload }) => new Promise((resolve, reject) => {
    window.__v01.socket.timeout(4000).emit(eventName, requestPayload, (error, result) => {
      if (error) reject(new Error(`Socket acknowledgement timed out for ${eventName}.`));
      else resolve(result);
    });
  }), { eventName: event, requestPayload: payload });
}

async function attachPage(page, baseUrl, profileToken = null) {
  await page.route(`${baseUrl}/__v01_multitab__`, route => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>V01 browser fixture</body></html>',
  }));
  await page.goto(`${baseUrl}/__v01_multitab__`);
  await page.addScriptTag({ path: socketClientPath });
  await page.addScriptTag({ path: path.join(workspace, 'public', 'js', 'game-api-client.js') });
  await page.evaluate(async token => {
    const socket = window.io(location.origin, {
      // Polling is still the real Socket.IO client/server protocol and remains
      // usable in sandboxed Chrome hosts where loopback WebSockets are denied.
      transports: ['polling'], forceNew: true, reconnection: false,
      ...(token ? { auth: { profileToken: token } } : {}),
    });
    window.__v01 = { socket, state: null, transferred: null, lateAckCallbacks: 0 };
    socket.on('game_state', state => { window.__v01.state = state; });
    socket.on('seat_transferred', value => { window.__v01.transferred = value; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser Socket.IO connect timeout.')), 5000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('connect_error', error => { clearTimeout(timer); reject(new Error(error.message)); });
    });
    window.__v01.api = window.ChillThrillGameApi.createGameApiClient({ socket, timeoutMs: 4000 });
    window.__v01.ack = (event, payload = {}) => new Promise((resolve, reject) => {
      socket.timeout(4000).emit(event, payload, (error, result) => error ? reject(new Error(`Socket acknowledgement timed out for ${event}.`)) : resolve(result));
    });
  }, profileToken);
}

async function walletSnapshot(game, profileId) {
  const profile = game.gm.profiles.publicProfile(profileId);
  if (!profile?.balances?.coin) throw new Error('The temporary test profile has no coin balance.');
  return { available: profile.balances.coin.available, reserved: profile.balances.coin.reserved };
}

async function main() {
  const root = containedWorkspacePath(temporaryRoot);
  fs.mkdirSync(root, { recursive: false });
  const game = createGameServer({
    databaseFile: path.join(root, 'profiles.sqlite'),
    storageFile: path.join(root, 'rooms.json'),
    graceMs: 30000,
  });
  let browser;
  const browserErrors = [];
  const pages = [];
  try {
    await new Promise((resolve, reject) => {
      game.server.once('error', reject);
      game.server.listen(0, '127.0.0.1', resolve);
    });
    const baseUrl = `http://127.0.0.1:${game.server.address().port}`;
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, serviceWorkers: 'block' });
    const makePage = async token => {
      const page = await context.newPage();
      pages.push(page);
      page.on('pageerror', error => browserErrors.push(error.message));
      page.on('requestfailed', request => browserErrors.push(`${request.url()}: ${request.failure()?.errorText || 'request failed'}`));
      await attachPage(page, baseUrl, token);
      return page;
    };

    const originalTab = await makePage();
    const hostProfile = await pageAck(originalTab, 'profile_bootstrap', { playerName: 'V01 Host', avatar: '🎲' });
    assert.ok(hostProfile?.profile?.id && hostProfile.profileToken, 'the first browser tab should create a profile');
    await originalTab.evaluate(({ key, token }) => localStorage.setItem(key, token), { key: profileTokenKey, token: hostProfile.profileToken });

    const hostCreate = await originalTab.evaluate(async ({ profileToken }) => {
      const response = await window.__v01.api.createRoom({
        gameId: 'tien-len', playerName: 'V01 Host', avatar: '🎲', profileToken,
        config: { stake: 50, maxPlayers: 2, visibility: 'invite' },
      });
      return { ok: response.ok, errorCode: response.error?.code || null, data: response.data || null };
    }, { profileToken: hostProfile.profileToken });
    assert.equal(hostCreate.ok, true, `room creation failed (${hostCreate.errorCode || 'no code'}).`);
    const hostCredentials = hostCreate.data;
    assert.ok(hostCredentials?.roomCode && hostCredentials?.playerId && hostCredentials?.sessionToken);
    await originalTab.evaluate(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: seatCredentialsKey(hostCredentials.roomCode), value: hostCredentials,
    });

    // A second actual Chrome tab in the same browser context shares both the
    // profile token and the seat recovery data from localStorage.
    const newTab = await makePage(hostProfile.profileToken);
    const sharedCredentials = await newTab.evaluate(({ profileKey, roomKey }) => ({
      profileToken: localStorage.getItem(profileKey), seat: JSON.parse(localStorage.getItem(roomKey) || 'null'),
    }), { profileKey: profileTokenKey, roomKey: seatCredentialsKey(hostCredentials.roomCode) });
    assert.equal(sharedCredentials.profileToken, hostProfile.profileToken);
    assert.equal(sharedCredentials.seat?.playerId, hostCredentials.playerId);
    assert.equal(sharedCredentials.seat?.sessionToken, hostCredentials.sessionToken);

    const prematureResume = await newTab.evaluate(async credentials => {
      const response = await window.__v01.api.resumeRoom(credentials);
      return { ok: response.ok, errorCode: response.error?.code || null, message: response.error?.message || '' };
    }, { roomCode: hostCredentials.roomCode, sessionToken: hostCredentials.sessionToken });
    assert.equal(prematureResume.ok, false, 'an ordinary second-tab resume must not take over an active seat.');
    assert.match(prematureResume.message, /cửa sổ khác|đang mở/i);

    // Race an in-place reconnect against an explicit user handoff. The final
    // seat owner must be the new tab regardless of packet arrival order.
    const [originalRaceResume, newTabHandoff] = await Promise.all([
      originalTab.evaluate(async credentials => {
        const response = await window.__v01.api.resumeRoom(credentials);
        return { ok: response.ok, errorCode: response.error?.code || null };
      }, { roomCode: hostCredentials.roomCode, sessionToken: hostCredentials.sessionToken }),
      newTab.evaluate(async credentials => {
        const response = await window.__v01.api.resumeRoom({ ...credentials, handoff: true });
        return { ok: response.ok, errorCode: response.error?.code || null };
      }, { roomCode: hostCredentials.roomCode, sessionToken: hostCredentials.sessionToken }),
    ]);
    assert.equal(newTabHandoff.ok, true, `explicit seat handoff failed (${newTabHandoff.errorCode || 'no code'}).`);
    const hostManager = game.gm.tienLen;
    const room = hostManager.rooms.get(hostCredentials.roomCode);
    const hostSeat = room.players.find(player => player.id === hostCredentials.playerId);
    const newTabSocketId = await newTab.evaluate(() => window.__v01.socket.id);
    const originalSocketId = await originalTab.evaluate(() => window.__v01.socket.id);
    assert.equal(hostSeat.socketId, newTabSocketId, 'the handoff target must own the seat socket.');
    assert.equal(hostManager.playerRoom.get(newTabSocketId), room.code);
    assert.equal(hostManager.playerRoom.has(originalSocketId), false, 'the old tab must lose its server-side seat mapping.');
    assert.equal(typeof originalRaceResume.ok, 'boolean', 'the racing original-tab resume must receive an explicit response.');

    const oldReady = await pageAck(originalTab, 'room:ready', { roomCode: room.code, ready: true });
    assert.equal(oldReady?.ok, false, 'the former tab must not mutate the seat after handoff.');
    assert.equal(hostSeat.ready, false);

    const guestTab = await makePage();
    const guestProfile = await pageAck(guestTab, 'profile_bootstrap', { playerName: 'V01 Guest', avatar: '🟦' });
    const guestJoin = await guestTab.evaluate(async ({ roomCode, profileToken }) => {
      const response = await window.__v01.api.joinRoom({ roomCode, playerName: 'V01 Guest', avatar: '🟦', profileToken });
      return { ok: response.ok, errorCode: response.error?.code || null, data: response.data || null };
    }, { roomCode: room.code, profileToken: guestProfile.profileToken });
    assert.equal(guestJoin.ok, true, `guest join failed (${guestJoin.errorCode || 'no code'}).`);
    const guestSeat = room.players.find(player => player.id === guestJoin.data.playerId);
    assert.ok(guestSeat);

    const guestWalletBefore = await walletSnapshot(game, guestSeat.profileId);
    const hostWalletBefore = await walletSnapshot(game, hostSeat.profileId);
    assert.deepEqual(hostWalletBefore, { available: 1000, reserved: 0 });
    assert.deepEqual(guestWalletBefore, { available: 1000, reserved: 0 });

    const hostReady = await pageAck(newTab, 'room:ready', { roomCode: room.code, ready: true });
    const guestReady = await pageAck(guestTab, 'room:ready', { roomCode: room.code, ready: true });
    assert.equal(hostReady?.ok, true);
    assert.equal(guestReady?.ok, true);
    await waitUntil(() => room.players.every(player => player.ready), 'both seats ready');

    // A stable deck puts 3♠ in the host's opening hand. The repeated start
    // requests are sent over the real browser socket; the manager must create
    // one match and one HELD reservation per seat.
    hostManager.shuffle = cards => {
      const result = [...cards];
      let seed = 0x5eed1234;
      for (let index = result.length - 1; index > 0; index--) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const other = seed % (index + 1);
        [result[index], result[other]] = [result[other], result[index]];
      }
      return result;
    };
    await newTab.evaluate(roomCode => {
      window.__v01.socket.emit('start_game', { roomCode });
      window.__v01.socket.emit('start_game', { roomCode });
    }, room.code);
    await waitUntil(() => room.phase === 'TURN' || room.phase === 'RESULT', 'game start');
    await timeout(80);
    assert.equal(room.phase, 'TURN', 'the deterministic fixture should start a normal hand.');
    assert.equal(room.currentPlayerId, hostSeat.id, 'the host should hold the initial required card in the stable deck.');
    assert.equal(room.reservations.length, 2);
    assert.deepEqual(await walletSnapshot(game, hostSeat.profileId), { available: 950, reserved: 50 });
    assert.deepEqual(await walletSnapshot(game, guestSeat.profileId), { available: 950, reserved: 50 });

    const profileStore = game.gm.profiles;
    const operationCount = (key, table, column) => profileStore.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(key).count;
    const reservationOperationKey = `tien-len:reserve:${room.matchId}`;
    assert.equal(operationCount(reservationOperationKey, 'wallet_operations', 'idempotency_key'), 1,
      'the two concurrent start packets should create only one reservation operation.');
    const heldCount = profileStore.db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE room_code = ? AND match_id = ? AND currency = 'coin' AND status = 'HELD'").get(room.code, room.matchId).count;
    assert.equal(heldCount, 2, 'one hold per seat should exist after start.');

    const initialAction = {
      roomCode: room.code, matchId: room.matchId, expectedRevision: room.revision,
      actionId: 'v01-multitab-old-seat-action-20261006', action: 'play', cardIds: [room.initialRequiredCardId],
    };
    const oldTabAction = await originalTab.evaluate(async envelope => {
      const response = await window.__v01.api.action(envelope);
      return { ok: response.ok, errorCode: response.error?.code || null };
    }, initialAction);
    assert.equal(oldTabAction.ok, false, 'the old tab action must be rejected after seat transfer.');
    assert.equal(room.phase, 'TURN');
    assert.equal(room.revision, initialAction.expectedRevision);
    assert.equal(hostSeat.hand.length, 13);

    // Narrow the live hand only for a deterministic terminal-action fixture.
    // The terminal transition itself, its acknowledgement, duplicate race,
    // settlement and balance/ledger checks all pass through real Socket.IO.
    const requiredCard = hostSeat.hand.find(card => card.id === room.initialRequiredCardId);
    assert.ok(requiredCard);
    hostSeat.hand = [requiredCard];
    hostManager.touch(room);
    hostManager.broadcast(room.code);
    await waitUntil(() => newTab.evaluate(() => window.__v01.state?.myHand?.length === 1), 'terminal hand fixture broadcast');
    const terminalAction = {
      roomCode: room.code, matchId: room.matchId, expectedRevision: room.revision,
      actionId: 'v01-multitab-terminal-action-20261006', action: 'play', cardIds: [requiredCard.id],
    };
    const duplicateActions = await newTab.evaluate(async envelope => Promise.all([
      window.__v01.api.action(envelope),
      window.__v01.api.action(envelope),
    ]).then(values => values.map(value => ({ ok: value.ok, errorCode: value.error?.code || null }))), terminalAction);
    await waitUntil(() => room.phase === 'RESULT', 'one terminal result');
    assert.equal(duplicateActions.filter(value => value.ok).length, 1,
      'only one of the same action envelopes may complete successfully.');
    assert.equal(room.history.length, 1);
    const settlementKey = `tien-len:settle:${room.matchId}`;
    assert.equal(operationCount(settlementKey, 'wallet_operations', 'idempotency_key'), 1);
    const ledgerForMatch = () => profileStore.db.prepare('SELECT COUNT(*) AS count FROM wallet_ledger WHERE match_id = ?').get(room.matchId).count;
    const settledLedgerCount = ledgerForMatch();
    const settledWallets = {
      host: await walletSnapshot(game, hostSeat.profileId),
      guest: await walletSnapshot(game, guestSeat.profileId),
    };
    assert.deepEqual(settledWallets.host, { available: 1050, reserved: 0 });
    assert.deepEqual(settledWallets.guest, { available: 950, reserved: 0 });
    assert.equal(settledLedgerCount, 5, 'two hold receipts, two closed holds and one winner pot receipt are expected.');

    // Exercise the shipped client against a real delayed server acknowledgement.
    // Its read request times out first; the eventual acknowledgement must not
    // resurrect the rejected request, and the same socket must remain usable.
    const serverSocket = game.io.sockets.sockets.get(newTabSocketId);
    let delayedResultPacket = false;
    serverSocket.use((packet, next) => {
      if (packet[0] === 'game:result' && !delayedResultPacket) {
        delayedResultPacket = true;
        setTimeout(next, 180);
        return;
      }
      next();
    });
    await newTab.evaluate(() => {
      const socket = window.__v01.socket;
      const originalEmit = socket.emit.bind(socket);
      socket.emit = function instrumentLateAck(event, ...args) {
        const index = args.length - 1;
        if (event === 'game:result' && typeof args[index] === 'function') {
          const ack = args[index];
          args[index] = (...ackArgs) => { window.__v01.lateAckCallbacks += 1; return ack(...ackArgs); };
        }
        return originalEmit(event, ...args);
      };
    });
    const timedResult = await newTab.evaluate(async roomCode => {
      try {
        await window.__v01.api.result(roomCode, { timeoutMs: 25 });
        return { resolved: true, code: null, uncertain: false };
      } catch (error) {
        return { resolved: false, code: error.code, uncertain: error.uncertain };
      }
    }, room.code);
    assert.deepEqual(timedResult, { resolved: false, code: 'TIMEOUT', uncertain: true });
    await waitUntil(() => newTab.evaluate(() => window.__v01.lateAckCallbacks === 1), 'real late acknowledgement');
    const afterLateAck = await newTab.evaluate(async roomCode => {
      const response = await window.__v01.api.result(roomCode);
      return { ok: response.ok, phase: response.data?.phase || null };
    }, room.code);
    assert.deepEqual(afterLateAck, { ok: true, phase: 'RESULT' });
    assert.equal(operationCount(settlementKey, 'wallet_operations', 'idempotency_key'), 1);
    assert.equal(ledgerForMatch(), settledLedgerCount);
    assert.deepEqual(await walletSnapshot(game, hostSeat.profileId), settledWallets.host);
    assert.deepEqual(await walletSnapshot(game, guestSeat.profileId), settledWallets.guest);

    assert.deepEqual(browserErrors, [], `browser page errors or failed requests: ${browserErrors.length}`);
    console.log(JSON.stringify({
      status: 'PASS',
      browser: 'Chrome headless, three same-origin tabs across one shared host context and one guest tab',
      viewport: { width: 1280, height: 850 },
      checks: [
        'shared localStorage profile and seat credentials',
        'ordinary duplicate resume rejected',
        'competing resume/handoff leaves exactly one server-side seat owner',
        'old tab ready and game action rejected after handoff',
        'duplicate start creates one match and one HELD reservation per seat',
        'duplicate terminal action produces one result/settlement and preserves balances',
        'real late Socket.IO acknowledgement is ignored by the shipped GameApiClient',
      ],
      lateAckCallbacks: 1,
      settlementOperations: 1,
      matchLedgerRows: settledLedgerCount,
      browserErrors: 0,
      fixture: 'temporary SQLite and room JSON under workspace; removed after run',
    }, null, 2));
  } finally {
    for (const page of pages) {
      try { await page.evaluate(() => window.__v01?.socket?.disconnect()); } catch {}
      try { await page.close(); } catch {}
    }
    try { await browser?.close(); } catch {}
    await game.close();
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`V01 multitab browser regression failed: ${error.message}`);
  process.exitCode = 1;
});
