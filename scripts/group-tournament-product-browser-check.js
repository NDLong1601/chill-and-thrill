'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');
const { createUnoDeck } = require('../src/games/uno/unoDeck');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tournament-c08-product-'));
  const options = { storageFile: path.join(directory, 'rooms.json'), databaseFile: path.join(directory, 'profiles.sqlite') };
  let game = createGameServer(options), browser, base;
  const clients = [], errors = [], external = [];
  const financialCounts = () => Object.fromEntries(['wallet_ledger', 'wallet_operations', 'reservations']
    .map(table => [table, game.gm.profiles.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  async function listen() {
    await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${game.server.address().port}`;
  }
  async function request(suffix, { token, capability, body, method = body ? 'POST' : 'GET' } = {}) {
    const response = await fetch(`${base}/api/groups${suffix}`, { method,
      headers: { ...(token ? { 'X-Profile-Token': token } : {}), ...(capability ? { 'X-Group-Capability': capability } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  async function profile(name) {
    const response = await fetch(`${base}/api/profile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    assert.equal(response.status, 201);
    return response.json();
  }
  async function connect(token) {
    const client = io(base, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { profileToken: token } });
    clients.push(client);
    await new Promise((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    return client;
  }
  async function waitFor(predicate, message) {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(message);
  }
  try {
    assert.ok(game.groupTournaments, 'Production mounts group tournaments and automatic server lifecycle');
    await listen();
    const alice = await profile('Alice'), bob = await profile('Bobby'), outsider = await profile('Outside');
    const aliceClient = await connect(alice.profileToken), bobClient = await connect(bob.profileToken);
    const created = await request('/', { token: alice.profileToken, body: {} }); assert.equal(created.status, 201);
    const groupId = created.data.groupId, hostCap = created.data.groupCapability;
    const joined = await request('/join', { token: bob.profileToken, body: { inviteCapability: created.data.inviteCapability } });
    assert.equal(joined.status, 201);
    const guestCap = joined.data.groupCapability;
    const initialFinancial = financialCounts();
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(token => localStorage.setItem('chill-thrill:profile-token', token), alice.profileToken);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).hostname !== '127.0.0.1') { external.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${base}/groups/tournament.html?group=${groupId}`);
    const initialList = await request(`/${groupId}/tournaments`, { token: alice.profileToken });
    assert.equal(initialList.status, 200, JSON.stringify(initialList.data));
    assert.equal(initialList.data.canManage, true, JSON.stringify(initialList.data));
    await page.locator('#create-panel:not([hidden])').waitFor();
    await page.locator('input[name=name]').fill('Giải nhóm thật');
    await page.locator('#game-select').selectOption('uno');
    await page.locator('#variant-select').selectOption('classic-108-v1');
    await page.locator('input[name=rounds]').fill('2');
    await page.getByRole('button', { name: 'Tạo giải', exact: true }).click();
    await page.getByRole('button', { name: 'Bắt đầu và khóa thành viên' }).click();
    await page.getByText('Vòng 1 / 2 · Sẵn sàng mở ván trong nhóm.', { exact: true }).waitFor();
    const tournaments = await request(`/${groupId}/tournaments`, { token: alice.profileToken });
    assert.equal(tournaments.status, 200);
    const tournamentId = tournaments.data.tournaments[0].tournamentId;
    assert.equal(tournaments.data.tournaments[0].membershipLocked, true);
    assert.equal((await request(`/${groupId}/tournaments`, { token: outsider.profileToken })).status, 403);
    assert.equal((await request(`/${groupId}/tournaments`)).status, 401);
    assert.equal((await request(`/${groupId}/tournaments/${tournamentId}/start`, { token: bob.profileToken,
      body: { actorProfileId: alice.profile.playerId || alice.profile.id } })).status, 403);
    assert.equal((await request(`/${groupId}/leave`, { token: bob.profileToken, capability: guestCap, body: {} })).status, 409);
    assert.equal((await request('/join', { token: outsider.profileToken, body: { inviteCapability: created.data.inviteCapability } })).status, 409);

    const proposal = await request(`/${groupId}/proposal`, { token: alice.profileToken, capability: hostCap,
      body: { gameId: 'uno', variant: 'classic-108-v1', config: { maxPlayers: 6, roomName: 'C08 production round' } } });
    assert.equal(proposal.status, 200);
    for (const [token, capability] of [[alice.profileToken, hostCap], [bob.profileToken, guestCap]]) {
      const consent = await request(`/${groupId}/confirm`, { token, capability,
        body: { proposalId: proposal.data.proposal.id, proposalRevision: proposal.data.proposal.revision } });
      assert.equal(consent.status, 200);
    }
    const switched = await request(`/${groupId}/switch`, { token: alice.profileToken, capability: hostCap, body: {} });
    assert.equal(switched.status, 200);
    const handoff = await request(`/${groupId}/handoff`, { token: alice.profileToken, capability: hostCap });
    assert.equal(handoff.status, 200);
    const code = handoff.data.roomCode, room = game.gm.uno.rooms.get(code);
    assert.equal(room.players.length, 2);
    const guestHandoff = await request(`/${groupId}/handoff`, { token: bob.profileToken, capability: guestCap });
    for (const [client, data] of [[aliceClient, handoff.data], [bobClient, guestHandoff.data]]) {
      const resumed = await new Promise((resolve, reject) => client.timeout(3000).emit('room:resume',
        { roomCode: code, sessionToken: data.sessionToken }, (error, result) => error ? reject(error) : resolve(result)));
      assert.equal(resumed.error, undefined);
    }
    room.players.forEach(player => game.gm.setReady(game.io.sockets.sockets.get(player.socketId), code, true));
    await game.gm.startGame(game.io.sockets.sockets.get(aliceClient.id), code);
    assert.equal(room.phase, 'TURN');
    const matchIds = [];
    for (let round = 1; round <= 2; round++) {
      if (round > 1) {
        const next = await new Promise((resolve, reject) => aliceClient.timeout(4000).emit('game:action', {
          roomCode: code, action: 'play_again', actionId: 'c08-production-next', expectedRevision: room.revision,
        }, (error, result) => error ? reject(error) : resolve(result)));
        assert.equal(next?.error, undefined);
        assert.equal(room.phase, 'TURN');
      }
      const matchId = room.matchId; matchIds.push(matchId);
      await waitFor(() => game.gm.profiles.db.prepare("SELECT 1 FROM group_tournament_records WHERE record_type='match' AND match_id=?").get(matchId), 'Actual server start did not register the tournament match');
      // Shorten a real hand into one legal final play; all publication,
      // validation, completion and automatic score persistence remain real.
      const winner = room.players.find(player => player.socketId === aliceClient.id);
      const finalCard = createUnoDeck().find(card => card.color === 'red' && card.symbol === 5);
      winner.hand = [finalCard]; room.currentPlayerId = winner.id; room.currentColor = 'red';
      room.discardPile = [createUnoDeck().find(card => card.color === 'red' && card.symbol === 3)];
      room.drawnCardId = null; room.unoDeclaredForTurn = true; room.paused = false;
      const envelope = { roomCode: code, action: 'play', cardId: finalCard.id, actionId: `c08-production-final-${round}`, expectedRevision: room.revision };
      aliceClient.emit('game_action', envelope);
      await waitFor(() => room.phase === 'RESULT', 'Legal final UNO play did not complete');
      await waitFor(async () => (await request(`/${groupId}/tournaments/${tournamentId}`, { token: alice.profileToken })).data.completedRounds === round, 'Committed match was not automatically scored');
      aliceClient.emit('game_action', envelope);
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(game.gm.profiles.db.prepare("SELECT COUNT(*) AS count FROM group_tournament_records WHERE record_type='match' AND match_id=?").get(matchId).count, 1);
    }
    assert.equal(new Set(matchIds).size, 2);
    await page.getByRole('button', { name: 'Làm mới' }).click();
    await page.getByText('Đã tính điểm').first().waitFor();
    const winnerRow = page.locator('#standings-body tr').filter({ has: page.getByRole('cell', { name: 'Alice', exact: true }) });
    assert.equal(await winnerRow.locator('td').nth(2).innerText(), '6');
    assert.equal(await page.locator('#round-history .round-card').count(), 2);
    assert.deepEqual(financialCounts(), initialFinancial, 'Tournament and UNO completion do not alter the wallet ledger');
    for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        overflow: [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
          .slice(0, 12).map(node => ({ tag: node.tagName, id: node.id, class: node.className, width: node.getBoundingClientRect().width })) }));
      assert.ok(layout.scrollWidth <= layout.width + 1, `Tournament fits ${viewport.width}: ${JSON.stringify(layout)}`);
    }
    const text = await page.locator('body').innerText();
    for (const secret of [alice.profileToken, bob.profileToken, alice.profile.playerId || alice.profile.id, bob.profile.playerId || bob.profile.id]) {
      assert.equal(text.includes(secret), false, 'Ranking does not display profile or session identifiers');
    }
    clients.forEach(client => client.disconnect()); await game.close();
    game = createGameServer(options); await listen();
    await page.goto(`${base}/groups/tournament.html?group=${groupId}`);
    await page.getByText('Đã tính điểm').first().waitFor();
    assert.equal(await page.locator('#standings-body tr').filter({ has: page.getByRole('cell', { name: 'Alice', exact: true }) }).locator('td').nth(2).innerText(), '6');
    assert.deepEqual(financialCounts(), initialFinancial);
    assert.equal((await request(`/${groupId}/tournaments`, { token: outsider.profileToken })).status, 403);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(__dirname, '..', 'test-results', 'group-tournament-C08-product-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    console.log('C08 production group/host UI/roster lock/legal socket result/automatic single score/history/server restart/four layouts passed; no ledger changes or page errors.');
    await context.close();
  } finally {
    await browser?.close(); clients.forEach(client => client.disconnect()); await game.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
