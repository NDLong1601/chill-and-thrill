'use strict';
function balance(f, id) { return f.store.publicProfile(id).balances[f.manager instanceof PokerManager ? 'chip' : 'coin']; }

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ProfileStore } = require('../src/platform/profileStore');
const { ProfileService } = require('../src/platform/profileService');
const { MultiGameManager } = require('../src/platform/multiGameManager');
const { TienLenManager } = require('../src/games/tien-len/tienLenEngine');
const { SamLocManager } = require('../src/games/sam-loc/samLocEngine');
const { PhomManager } = require('../src/games/phom/phomEngine');
const { PokerManager } = require('../src/games/poker/pokerEngine');
const { BangManager } = require('../src/games/bang/bangEngine');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-review-fixes-'));
}
function removeTemp(directory) {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(directory, { recursive: true, force: true });
}
function fakeIo() { return { sockets: { sockets: new Map() }, to: () => ({ emit() {} }) }; }
function socket(io, id, profile) {
  const item = { id, data: {}, profile, events: [], join() {}, leave() {}, emit(event, payload) { this.events.push({ event, payload }); } };
  io.sockets.sockets.set(id, item); return item;
}
function shuffled(cards) {
  const result = [...cards]; let seed = 0x5eed1234;
  for (let index = result.length - 1; index > 0; index--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const other = seed % (index + 1); [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
const card = id => ({ id, rank: id.slice(0, -1), suit: id.slice(-1) });
function fixture(t, Manager, count = 2) {
  const directory = temp(), store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite') }), io = fakeIo();
  const profiles = Array.from({ length: count }, (_, n) => store.createProfile({ displayName: `Player ${n}`, avatar: '🎲' }).profile);
  const sockets = profiles.map((profile, n) => socket(io, `seat-${n}`, profile));
  const options = { storageFile: path.join(directory, 'rooms.json'), profileStore: store, profileForSocket: item => item.profile,
    onMatchCompleted: match => store.recordCompletedMatch(match), shuffle: shuffled };
  const f = { directory, store, io, profiles, sockets, options, manager: new Manager(io, options) };
  f.credentials = [f.manager.createRoom(sockets[0], 'Player 0', '🎲')];
  for (let n = 1; n < count; n++) f.credentials.push(f.manager.joinRoom(sockets[n], f.credentials[0].roomCode, `Player ${n}`, '🎲'));
  f.room = f.manager.rooms.get(f.credentials[0].roomCode);
  t.after(() => { f.manager.close(); store.close(); removeTemp(directory); });
  return f;
}
function start(f) {
  if (f.manager instanceof PokerManager) f.room.players.forEach((player, n) => f.manager.buyIn(f.sockets[n], f.room, player, { amount: 200, actionId: `initial-buy-${n}` }));
  f.sockets.forEach(item => f.manager.setReady(item, f.room.code, true));
  assert.equal(f.manager.startGame(f.sockets[0], f.room.code)?.error, undefined);
}
function action(f, n, type, extra = {}) {
  return f.manager.action(f.sockets[n], f.room.code, { action: type, actionId: crypto.randomUUID(), expectedRevision: f.room.revision, ...extra });
}

test('schema v1 upgrades in place without changing existing identity or chip reservations', t => {
  const directory = temp(), databaseFile = path.join(directory, 'profiles.sqlite');
  let store = new ProfileStore({ databaseFile });
  t.after(() => { store.close(); removeTemp(directory); });
  const identity = store.createProfile({ displayName: 'Existing player' });
  const held = store.reserveMany({ reservations: [{ profileId: identity.profile.id, amount: 200 }], operationKey: 'existing-hold', roomCode: 'ABCD', matchId: 'old-match' });
  store.db.exec(`DROP TABLE game_snapshots;
    DROP TABLE tutorial_verifications;
    DELETE FROM wallet_ledger WHERE currency = 'coin';
    ALTER TABLE wallets DROP COLUMN coin_available; ALTER TABLE wallets DROP COLUMN coin_reserved;
    ALTER TABLE wallets DROP COLUMN gem_available; ALTER TABLE wallets DROP COLUMN gem_reserved;
    ALTER TABLE reservations DROP COLUMN currency; ALTER TABLE wallet_ledger DROP COLUMN currency;
    DELETE FROM schema_migrations WHERE version >= 2;`);
  store.close(); store = new ProfileStore({ databaseFile });
  assert.equal(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 4);
  assert.deepEqual(store.publicProfile(identity.profile.id).balances.coin, { available: 1000, reserved: 0 });
  assert.equal(store.authenticate(identity.sessionToken).id, identity.profile.id);
  assert.deepEqual(store.publicProfile(identity.profile.id).wallet, { available: 800, reserved: 200 });
  assert.equal(store.db.prepare('SELECT status FROM reservations WHERE id = ?').get(held.held[0].reservationId).status, 'HELD');
  assert.deepEqual(store.gameSnapshots('poker'), []);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

for (const finalEat of [false, true]) test(`Phỏm preserves mandatory eaten melds before discarding${finalEat ? ' the final turn' : ''}`, t => {
  const f = fixture(t, PhomManager); start(f);
  const [first, eater] = f.room.players;
  f.room.phase = 'DRAW_OR_EAT'; f.room.currentPlayerId = eater.id;
  f.room.discardPile = [{ card: card('3H'), playerId: first.id }];
  eater.hand = ['4H', '5H', '9D'].map(card); eater.eatenCardIds = [];
  if (finalEat) { f.room.drawTurns = f.room.maxDrawTurns - 1; f.room.chotEligible = true; }
  action(f, 1, 'eat', { melds: [['3H', '4H', '5H']] });
  assert.equal(f.room.phase, 'DISCARD');
  assert.deepEqual(f.manager.buildStateFor(f.room, eater.id).myDiscardableCardIds, ['9D']);
  for (const id of ['3H', '4H', '5H']) {
    const before = JSON.stringify(f.room), wallet = balance(f, f.profiles[1].id);
    action(f, 1, 'discard', { cardId: id });
    assert.equal(JSON.stringify(f.room), before); assert.deepEqual(balance(f, f.profiles[1].id), wallet);
  }
  action(f, 1, 'discard', { cardId: '9D' });
  assert.equal(eater.hand.length, 3);
  if (finalEat) {
    assert.equal(f.room.phase, 'LAYDOWN');
    action(f, 0, 'lay_down', { melds: [], sends: [] });
    action(f, 1, 'lay_down', { melds: [['3H', '4H', '5H']], sends: [] });
    assert.equal(f.room.phase, 'RESULT');
    assert.ok(f.profiles.every(profile => balance(f, profile.id).reserved === 0));
  }
});

for (const [gameId, Manager] of [['tien-len', TienLenManager], ['sam-loc', SamLocManager], ['phom', PhomManager]]) {
  test(`${gameId} refunds expired snapshots once across repeated restarts`, t => {
    const f = fixture(t, Manager); start(f);
    assert.ok(f.room.reservations.length === 2);
    delete f.room.reconnectPolicyVersion; // Exercise the published legacy expiry path, not policy 2.
    f.room.updatedAt = Date.now() - 13 * 3600000; f.manager.close();
    const stale = fs.readFileSync(f.options.storageFile, 'utf8');
    f.manager = new Manager(fakeIo(), f.options);
    assert.equal(f.manager.rooms.has(f.room.code), false);
    assert.deepEqual(f.profiles.map(p => balance(f, p.id)), [{ available: 1000, reserved: 0 }, { available: 1000, reserved: 0 }]);
    f.manager.close(); fs.writeFileSync(f.options.storageFile, stale);
    f.manager = new Manager(fakeIo(), f.options);
    assert.equal(f.manager.rooms.has(f.room.code), false);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM wallet_ledger WHERE source = 'release'").get().n, 2);
  });
  test(`${gameId} retains reservations and source snapshot when expiry cannot commit`, t => {
    const f = fixture(t, Manager); start(f); delete f.room.reconnectPolicyVersion; f.room.updatedAt = Date.now() - 13 * 3600000; f.manager.close();
    const original = f.store.expireFixedRoom.bind(f.store), stale = fs.readFileSync(f.options.storageFile, 'utf8');
    f.store.expireFixedRoom = () => { throw new Error('injected expiry failure'); };
    f.manager = new Manager(fakeIo(), f.options); assert.equal(f.manager.storageError, true); f.manager.close();
    assert.equal(fs.readFileSync(f.options.storageFile, 'utf8'), stale);
    assert.ok(f.profiles.every(p => balance(f, p.id).reserved > 0));
    f.store.expireFixedRoom = original; f.manager = new Manager(fakeIo(), f.options);
    assert.ok(f.profiles.every(p => balance(f, p.id).reserved === 0));
  });
}

for (const fromLoad of [false, true]) test(`Poker expiry refunds every wager before cash-out (${fromLoad ? 'restart' : 'cleanup'})`, t => {
  const f = fixture(t, PokerManager); start(f);
  const current = f.room.players.findIndex(p => p.id === f.room.currentPlayerId);
  action(f, current, 'all_in'); assert.equal(f.room.phase, 'HAND');
  assert.ok(f.room.players.reduce((sum, p) => sum + p.totalContribution, 0) > 15);
  delete f.room.reconnectPolicyVersion; // Keep this compatibility test on the legacy 12-hour refund path.
  f.room.players.forEach(p => { p.connected = false; p.socketId = null; p.disconnectedAt = Date.now() - 13 * 3600000; });
  f.room.updatedAt = Date.now() - 13 * 3600000;
  f.manager.persistRoom(f.room); f.manager.flush(); const stale = fs.readFileSync(f.options.storageFile, 'utf8');
  if (fromLoad) { f.manager.close(); f.manager = new PokerManager(fakeIo(), f.options); } else f.manager.cleanup();
  assert.equal(f.manager.rooms.has(f.room.code), false);
  assert.deepEqual(f.profiles.map(p => balance(f, p.id)), [{ available: 1000, reserved: 0 }, { available: 1000, reserved: 0 }]);
  f.manager.close(); fs.writeFileSync(f.options.storageFile, stale); f.manager = new PokerManager(fakeIo(), f.options);
  assert.equal(f.manager.rooms.has(f.room.code), false, 'committed tombstone prevents stale JSON from resurrecting a cash-out');
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM wallet_ledger WHERE source = 'poker_cashout'").get().n, 2);
});

test('Poker expiry after a settled hand keeps winnings instead of refunding the old pot twice', t => {
  const f = fixture(t, PokerManager); start(f);
  action(f, f.room.players.findIndex(p => p.id === f.room.currentPlayerId), 'fold'); assert.equal(f.room.phase, 'RESULT');
  const expected = f.room.players.map((p, n) => ({ available: 800 + p.stack, reserved: 0 }));
  f.room.players.forEach(p => { p.connected = false; p.disconnectedAt = Date.now() - 13 * 3600000; }); f.room.updatedAt = Date.now() - 13 * 3600000;
  f.manager.cleanup(); assert.deepEqual(f.profiles.map(p => balance(f, p.id)), expected);
  assert.equal(expected.reduce((sum, wallet) => sum + wallet.available, 0), 2000);
});

test('Poker rolls back both wallet and memory if the recovery snapshot cannot commit', t => {
  const f = fixture(t, PokerManager), original = f.store.saveGameSnapshot.bind(f.store);
  f.store.saveGameSnapshot = () => { throw new Error('injected snapshot failure'); };
  action(f, 0, 'buy_in', { amount: 200 });
  f.store.saveGameSnapshot = original;
  assert.deepEqual(balance(f, f.profiles[0].id), { available: 1000, reserved: 0 });
  assert.equal(f.manager.rooms.get(f.room.code).players[0].stack, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status = 'HELD'").get().n, 0);
  assert.ok(f.sockets[0].events.some(event => event.event === 'game_error' && /snapshot failure/.test(event.payload.message)));
});

test('Poker expiry rolls back every cash-out when a later seat fails', t => {
  const f = fixture(t, PokerManager); start(f);
  f.room.players.forEach(p => { p.connected = false; p.socketId = null; });
  f.room.updatedAt = Date.now() - 13 * 3600000;
  const original = f.store.settlePokerSeat.bind(f.store), before = JSON.stringify(f.room);
  let attempts = 0;
  f.store.settlePokerSeat = data => { if (++attempts === 2) throw new Error('injected second cash-out failure'); return original(data); };
  assert.throws(() => f.manager.expireRoom(f.room), /second cash-out/);
  assert.equal(JSON.stringify(f.manager.rooms.get(f.room.code)), before);
  assert.ok(f.profiles.every(p => balance(f, p.id).reserved === 200));
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM wallet_ledger WHERE source = 'poker_cashout'").get().n, 0);
  f.store.settlePokerSeat = original; f.manager.expireRoom(f.room);
  assert.ok(f.profiles.every(p => balance(f, p.id).available === 1000));
});

for (const crash of ['before_snapshot', 'after_snapshot', 'after_commit']) test(`Poker child-process crash ${crash} preserves the wallet/stack boundary`, t => {
  const directory = temp(), root = path.resolve(__dirname, '..');
  const script = `
    const fs = require('node:fs'), path = require('node:path');
    const { ProfileStore } = require('./src/platform/profileStore');
    const { PokerManager } = require('./src/games/poker/pokerEngine');
    const directory = process.argv[1], crash = process.argv[2];
    const store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite') });
    const created = store.createProfile({ displayName: 'Crash test' });
    const socket = { id: 'crash-seat', profile: created.profile, join() {}, leave() {}, emit() {} };
    const io = { sockets: { sockets: new Map([[socket.id, socket]]) } };
    const manager = new PokerManager(io, { storageFile: path.join(directory, 'rooms.json'), profileStore: store, profileForSocket: s => s.profile });
    const seat = manager.createRoom(socket, 'Crash test', '🎲'), room = manager.rooms.get(seat.roomCode);
    store.syncRoom({ gameId: 'poker', room }); manager.flush();
    fs.writeFileSync(path.join(directory, 'control.json'), JSON.stringify({ profileId: created.profile.id, seat }));
    const original = store.saveGameSnapshot.bind(store);
    store.saveGameSnapshot = args => { if (crash === 'before_snapshot') process.exit(23); original(args); if (crash === 'after_snapshot') process.exit(23); };
    manager.action(socket, room.code, { action: 'buy_in', amount: 200, actionId: 'crash-buy-in', expectedRevision: room.revision });
    process.exit(23);
  `;
  const child = spawnSync(process.execPath, ['-e', script, directory, crash], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 23, child.stderr);
  const control = JSON.parse(fs.readFileSync(path.join(directory, 'control.json'))), stale = fs.readFileSync(path.join(directory, 'rooms.json'), 'utf8');
  assert.equal(JSON.parse(stale).rooms[0].players[0].stack, 0, 'JSON export has not recorded the buy-in');
  const store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite') }), io = fakeIo();
  const profile = store.publicProfile(control.profileId), back = socket(io, 'back', profile), options = { storageFile: path.join(directory, 'rooms.json'), profileStore: store, profileForSocket: s => s.profile };
  let manager = new PokerManager(io, options); t.after(() => { manager.close(); store.close(); removeTemp(directory); });
  const room = manager.rooms.get(control.seat.roomCode), committed = crash === 'after_commit';
  assert.equal(room.players[0].stack, committed ? 200 : 0);
  assert.equal(new ProfileService({ profileStore: store }).publicProfile(profile.id).wallet.inGame, committed ? 200 : 0, 'dashboard reads the committed stack even when room metadata/JSON are stale');
  assert.deepEqual(store.publicProfile(profile.id).wallet, committed ? { available: 800, reserved: 200 } : { available: 1000, reserved: 0 });
  assert.equal(manager.resumeRoom(back, room.code, control.seat.sessionToken).error, undefined);
  if (committed) {
    manager.action(back, room.code, { action: 'buy_in', amount: 200, actionId: 'crash-buy-in', expectedRevision: room.revision });
    assert.equal(room.players[0].stack, 200, 'replayed committed action cannot add the same buy-in again');
  }
  manager.leaveRoom(back, room.code); assert.deepEqual(store.publicProfile(profile.id).wallet, { available: 1000, reserved: 0 });
  manager.close(); fs.writeFileSync(options.storageFile, stale); manager = new PokerManager(fakeIo(), options);
  assert.equal(manager.rooms.has(room.code), false);
});

test('one profile can leave and rejoin every game without duplicate room membership', t => {
  const io = fakeIo(), gm = new MultiGameManager(io); t.after(() => gm.close());
  for (const [gameId, variant] of [['the-gang'], ['uno', 'classic-local-v1'], ['uno', 'classic-108-v1'], ['poker'], ['tien-len'], ['sam-loc'], ['phom'], ['bang']]) {
    const host = socket(io, crypto.randomUUID()), guest = socket(io, crypto.randomUUID());
    const room = gm.createRoom(host, 'Host', 'ADVANCED', '🎲', gameId, { variant });
    assert.equal(room.error, undefined);
    for (let n = 0; n < 3; n++) {
      const joined = gm.joinRoom(guest, room.roomCode, 'Guest', '🎲'); assert.equal(joined.error, undefined);
      assert.ok(joined.sessionToken); assert.equal(gm.managerForCode(room.roomCode).rooms.get(room.roomCode).players.length, 2);
      const rows = gm.profiles.db.prepare('SELECT COUNT(*) AS n FROM room_members m JOIN rooms r ON m.room_id = r.id WHERE r.room_code = ? AND m.profile_id = ?').get(room.roomCode, guest.data.profile.id);
      assert.equal(rows.n, 1); gm.leaveRoom(guest, room.roomCode);
    }
    gm.leaveRoom(host, room.roomCode);
  }
});

for (const variant of ['classic-local-v1', 'classic-108-v1']) for (const disconnected of [false, true]) {
  test(`UNO ${variant} leaves ${disconnected ? 'a disconnected' : 'an active'} round and immediately creates another game`, t => {
    const io = fakeIo(), gm = new MultiGameManager(io); t.after(() => gm.close());
    const host = socket(io, 'host'), guest = socket(io, 'guest'), stranger = socket(io, 'stranger');
    const created = gm.createRoom(host, 'Host', 'ADVANCED', '🎲', 'uno', { variant });
    const joined = gm.joinRoom(guest, created.roomCode, 'Guest', '🎲');
    assert.equal(joined.error, undefined);
    gm.setReady(host, created.roomCode, true); gm.setReady(guest, created.roomCode, true); gm.startGame(host, created.roomCode);
    const manager = gm.managerForCode(created.roomCode), room = manager.rooms.get(created.roomCode);
    const matchId = room.matchId;
    // Arm a deadline so leaving also has to clear pending reactions.
    if (variant === 'classic-local-v1') {
      room.uno.unoWindow = { playerId: host.data.profile.id, deadlineAt: Date.now() + 60000 };
      gm.roomService.adapterFor('uno').schedule(room);
      assert.equal(gm.roomService.adapterFor('uno').timers.has(room.code), true);
    } else {
      room.phase = 'WDF_CHALLENGE'; room.pendingWdf = { offenderId: created.playerId, targetId: joined.playerId, deadlineAt: Date.now() + 60000 };
    }
    const before = JSON.stringify(room);
    gm.leaveRoom(stranger, room.code);
    assert.equal(JSON.stringify(room), before, 'only a member may cancel the round');
    if (disconnected) gm.handleDisconnect(host);
    const departing = disconnected ? guest : host;
    const profileId = departing.data.profile.id;
    gm.leaveRoom(departing, room.code);
    assert.equal(room.phase, 'WAITING'); assert.notEqual(room.matchId, matchId);
    assert.equal(room.players.length, 1); assert.equal(room.players[0].isHost, true); assert.equal(room.players[0].ready, false);
    assert.equal(manager.playerRoom.has(departing.id), false);
    assert.ok(departing.events.some(event => event.event === 'room_left'));
    if (variant === 'classic-local-v1') {
      assert.equal(room.uno, null); assert.equal(gm.roomService.adapterFor('uno').timers.has(room.code), false);
    } else {
      assert.equal(room.pendingWdf, null); assert.equal(room.pendingUno, null); assert.equal(room.paused, false);
      assert.deepEqual(room.players[0].hand, []);
    }
    assert.equal(gm.profiles.db.prepare('SELECT COUNT(*) AS n FROM matches').get().n, 0, 'cancelled rounds grant no match or mission credit');
    assert.deepEqual(gm.profiles.publicProfile(profileId).wallet, { available: 1000, reserved: 0 });
    const next = gm.createRoom(departing, 'Same profile', 'ADVANCED', '🎲', 'poker');
    assert.equal(next.error, undefined); assert.equal(next.profile.id, profileId);
    assert.ok(next.sessionToken); assert.equal(next.entryPath, '/poker');
    const oldAction = gm.roomService.handleGameAction(departing, { roomCode: room.code, matchId, expectedRevision: 0, actionId: 'old-action', type: 'draw_card' });
    assert.equal(oldAction.ok, false);
    assert.equal(room.phase, 'WAITING');
    assert.equal(gm.profiles.db.prepare("SELECT status FROM room_members WHERE profile_id = ? AND room_id = ?").get(profileId, `room:uno:${room.code}`).status, 'LEFT');
  });
}

test('foreign sockets cannot ready, start, act, leave or request private room state', t => {
  const io = fakeIo(), gm = new MultiGameManager(io); t.after(() => gm.close());
  for (const [gameId, variant] of [['the-gang'], ['uno', 'classic-local-v1'], ['uno', 'classic-108-v1'], ['poker'], ['tien-len'], ['sam-loc'], ['phom'], ['bang']]) {
    const host = socket(io, crypto.randomUUID()), stranger = socket(io, crypto.randomUUID());
    const joined = gm.createRoom(host, 'Host', 'ADVANCED', '🎲', gameId, { variant });
    const room = gm.managerForCode(joined.roomCode).rooms.get(joined.roomCode), before = JSON.stringify(room);
    assert.doesNotThrow(() => gm.setReady(stranger, joined.roomCode, true));
    assert.doesNotThrow(() => gm.startGame(stranger, joined.roomCode));
    assert.doesNotThrow(() => gm.gameAction(stranger, joined.roomCode, { action: 'draw', actionId: crypto.randomUUID(), expectedRevision: room.revision }));
    assert.doesNotThrow(() => gm.leaveRoom(stranger, joined.roomCode));
    assert.doesNotThrow(() => gm.syncState(stranger, joined.roomCode));
    assert.equal(JSON.stringify(room), before);
    assert.equal(stranger.events.some(event => event.event === 'game_state'), false);
    gm.leaveRoom(host, joined.roomCode);
  }
});

test('resume rejects all cross-room game combinations while preserving same-room recovery', t => {
  const io = fakeIo(), gm = new MultiGameManager(io); t.after(() => gm.close());
  const variants = [['the-gang'], ['uno', 'classic-local-v1'], ['uno', 'classic-108-v1'], ['poker'], ['tien-len'], ['sam-loc'], ['phom'], ['bang']];
  for (const [firstId, firstVariant] of variants) for (const [secondId, secondVariant] of variants) {
    const first = socket(io, crypto.randomUUID()), second = socket(io, crypto.randomUUID());
    const a = gm.createRoom(first, 'Shared', 'ADVANCED', '🎲', firstId, { variant: firstVariant });
    gm.authenticateProfile(second, a.profileToken);
    const b = gm.createRoom(second, 'Shared', 'ADVANCED', '🎲', secondId, { variant: secondVariant });
    gm.handleDisconnect(second);
    assert.match(gm.resumeRoom(first, b.roomCode, b.sessionToken).error, /rời phòng hiện tại/);
    assert.equal(gm.managerForCode(b.roomCode).rooms.get(b.roomCode).players[0].connected, false);
    assert.equal(gm.resumeRoom(first, a.roomCode, a.sessionToken).error, undefined);
    gm.leaveRoom(first, a.roomCode);
    assert.equal(gm.resumeRoom(second, b.roomCode, b.sessionToken).error, undefined); gm.leaveRoom(second, b.roomCode);
  }
});

for (const [gameId, Manager] of [['tien-len', TienLenManager], ['sam-loc', SamLocManager], ['phom', PhomManager], ['poker', PokerManager], ['bang', BangManager]]) test(`${gameId} detaches a queued departure only after recording the complete result`, t => {
  const f = fixture(t, Manager, gameId === 'bang' ? 4 : 2); start(f);
  const departing = f.room.players[1], departingId = departing.id;
  assert.equal(f.manager.leaveRoom(f.sockets[1], f.room.code).queued, true);
  assert.ok(f.manager.playerRoom.has(f.sockets[1].id));
  if (gameId === 'tien-len') f.manager.finish(f.room, f.room.players[0], 'terminal test');
  else if (gameId === 'sam-loc') f.manager.finishNormal(f.room, f.room.players[0], null, 'terminal test');
  else if (gameId === 'phom') { f.room.players.forEach(p => { p.score = 0; }); f.manager.finishRound(f.room, null, 'terminal test'); }
  else if (gameId === 'poker') action(f, f.room.players.findIndex(p => p.id === f.room.currentPlayerId), 'fold');
  else { f.room.players.forEach(p => { if (p.role !== 'SHERIFF' && p.role !== 'DEPUTY') p.dead = true; }); f.manager.checkWinner(f.room); }
  assert.equal(f.room.phase, 'RESULT');
  assert.equal(f.room.players.some(p => p.id === departingId), false);
  assert.equal(f.manager.playerRoom.has(f.sockets[1].id), false);
  assert.ok(f.sockets[1].events.some(event => event.event === 'room_left'));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM match_players WHERE match_id = ?').get(f.room.matchId).n, f.profiles.length);
  assert.equal(balance(f, f.profiles[1].id).reserved, 0);
});
