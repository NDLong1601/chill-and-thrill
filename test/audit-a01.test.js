'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../src/platform/profileStore');
const { TienLenManager } = require('../src/games/tien-len/tienLenEngine');
const { SamLocManager } = require('../src/games/sam-loc/samLocEngine');
const { PhomManager } = require('../src/games/phom/phomEngine');

const games = [
  { id: 'tien-len', Manager: TienLenManager, stake: 100, hold: 100 },
  { id: 'sam-loc', Manager: SamLocManager, stake: 20, hold: 40 },
  { id: 'phom', Manager: PhomManager, stake: 10, hold: 20 },
];

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-audit-a01-')); }
function fakeIo() { const sockets = new Map(); return { sockets: { sockets }, to: () => ({ emit() {} }) }; }
function socket(id, profile) { return { id, profile, events: [], join() {}, leave() {}, emit(event, payload) { this.events.push({ event, payload }); } }; }
function deterministicShuffle(cards) {
  const result = [...cards];
  let seed = 0x5eed1234;
  for (let index = result.length - 1; index > 0; index--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const other = seed % (index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
function makeFixture(t, spec, { start = false } = {}) {
  const directory = temp(), storageFile = path.join(directory, 'rooms.json');
  const store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite') });
  const io = fakeIo(), profiles = [0, 1].map(index => store.createProfile({ displayName: `Player ${index}` }).profile);
  const sockets = profiles.map((profile, index) => socket(`${spec.id}-${index}`, profile));
  sockets.forEach(item => io.sockets.sockets.set(item.id, item));
  const manager = new spec.Manager(io, { profileStore: store, profileForSocket: item => item.profile,
    onMatchCompleted: match => store.recordCompletedMatch(match), storageFile, shuffle: deterministicShuffle });
  const created = manager.createRoom(sockets[0], 'Host', '🎲', { stake: spec.stake });
  const joined = manager.joinRoom(sockets[1], created.roomCode, 'Guest', '🎲');
  const room = manager.rooms.get(created.roomCode);
  manager.setReady(sockets[0], room.code, true); manager.setReady(sockets[1], room.code, true);
  if (start) assert.equal(manager.startGame(sockets[0], room.code)?.error, undefined);
  const fixture = { directory, storageFile, store, io, profiles, sockets, manager, room, created, joined };
  t.after(() => { manager.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return fixture;
}
function balances(f) { return f.profiles.map(profile => f.store.publicProfile(profile.id).balances.coin); }

for (const spec of games) {
  test(`A01 ${spec.id}: JSON export failure leaves SQLite recovery and held coins authoritative`, t => {
    const f = makeFixture(t, spec);
    const holdAmount = f.room.maxLoss || spec.hold;
    const badJsonTarget = path.join(f.directory, 'blocked-export.json'); fs.mkdirSync(badJsonTarget);
    f.manager.storageFile = badJsonTarget;
    const result = f.manager.startGame(f.sockets[0], f.room.code);
    assert.equal(result?.ok, true);
    assert.equal(f.room.phase === 'WAITING', false);
    assert.deepEqual(balances(f).map(wallet => [wallet.available, wallet.reserved]), [[1000 - holdAmount, holdAmount], [1000 - holdAmount, holdAmount]]);
    const saved = f.store.gameSnapshots(spec.id).find(item => item.roomCode === f.room.code);
    assert.equal(JSON.parse(saved.stateJson).phase, f.room.phase);
    f.manager.close();
    const restored = new spec.Manager(fakeIo(), { profileStore: f.store, storageFile: badJsonTarget });
    f.manager = restored;
    t.after(() => restored.close());
    assert.ok(!restored.storageError, 'a committed SQLite snapshot makes the damaged JSON export non-authoritative');
    assert.equal(restored.rooms.get(f.room.code).phase, f.room.phase);
    assert.equal(restored.rooms.get(f.room.code).reservations.length, 2);
    assert.deepEqual(balances(f).map(wallet => wallet.reserved), [holdAmount, holdAmount]);
  });

  test(`A01 ${spec.id}: snapshot failure rolls back start, ledger and queued success events`, t => {
    const f = makeFixture(t, spec);
    f.sockets.forEach(item => { item.events.length = 0; });
    const original = f.store.saveGameSnapshot.bind(f.store);
    f.store.saveGameSnapshot = () => { throw new Error('injected snapshot commit failure'); };
    const result = f.manager.startGame(f.sockets[0], f.room.code);
    f.store.saveGameSnapshot = original;
    assert.match(result.error, /snapshot commit failure/);
    assert.equal(f.manager.rooms.get(f.room.code).phase, 'WAITING');
    assert.equal(f.manager.rooms.get(f.room.code).matchId, null);
    assert.deepEqual(balances(f).map(wallet => [wallet.available, wallet.reserved]), [[1000, 0], [1000, 0]]);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status = 'HELD'").get().n, 0);
    assert.equal(f.sockets.some(item => item.events.some(event => event.event === 'game_state')), false);
    assert.equal(f.sockets[0].events.filter(event => event.event === 'game_error').length, 1);

    const execDescriptor = Object.getOwnPropertyDescriptor(f.store.db, 'exec');
    const originalExec = f.store.db.exec.bind(f.store.db); let failCommit = true;
    f.store.db.exec = statement => {
      if (statement === 'COMMIT' && failCommit) { failCommit = false; throw new Error('injected SQLite commit failure'); }
      return originalExec(statement);
    };
    f.sockets.forEach(item => { item.events.length = 0; });
    const commitResult = f.manager.startGame(f.sockets[0], f.room.code);
    if (execDescriptor) Object.defineProperty(f.store.db, 'exec', execDescriptor); else delete f.store.db.exec;
    assert.match(commitResult.error, /SQLite commit failure/);
    assert.equal(f.manager.rooms.get(f.room.code).phase, 'WAITING');
    assert.deepEqual(balances(f).map(wallet => [wallet.available, wallet.reserved]), [[1000, 0], [1000, 0]]);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status = 'HELD'").get().n, 0);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM wallet_operations WHERE kind = ?').get('reserve_many').n, 0);
  });

  test(`A01 ${spec.id}: swallowed deal-time failure still aborts its enclosing start transaction`, t => {
    const f = makeFixture(t, spec);
    f.manager.shuffle = () => { throw new Error('injected shuffle failure after reserve'); };
    f.sockets.forEach(item => { item.events.length = 0; });
    const result = f.manager.startGame(f.sockets[0], f.room.code);
    assert.match(result.error, /shuffle failure after reserve/);
    assert.equal(f.room.phase, 'WAITING');
    assert.equal(f.room.matchId, null);
    assert.deepEqual(balances(f).map(wallet => [wallet.available, wallet.reserved]), [[1000, 0], [1000, 0]]);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status = 'HELD'").get().n, 0);
    assert.equal(f.sockets.some(item => item.events.some(event => event.event === 'game_state')), false);
  });

  test(`A01 ${spec.id}: settlement and result snapshot commit once and conserve coin`, t => {
    const f = makeFixture(t, spec, { start: true });
    const room = f.room, winner = room.players[0];
    if (spec.id === 'tien-len') assert.equal(f.manager.buildStateFor(room, winner.id).maxLoss, room.stake);
    const saveSnapshot = f.store.saveGameSnapshot.bind(f.store);
    f.store.saveGameSnapshot = () => { throw new Error('injected result snapshot failure'); };
    if (spec.id === 'tien-len') assert.throws(() => f.manager.finish(room, winner, 'A01 failed settlement fixture'), /result snapshot failure/);
    else if (spec.id === 'sam-loc') assert.throws(() => f.manager.settle(room, new Map([[winner.id, spec.stake], [room.players[1].id, -spec.stake]]), 'NORMAL', winner, 'A01 failed settlement fixture'), /result snapshot failure/);
    else { winner.score = 0; room.players[1].score = 25; assert.throws(() => f.manager.finishRound(room, null, 'A01 failed settlement fixture'), /result snapshot failure/); }
    f.store.saveGameSnapshot = saveSnapshot;
    assert.notEqual(room.phase, 'RESULT');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM matches WHERE match_id = ?').get(room.matchId).n, 0);
    assert.ok(balances(f).every(wallet => wallet.reserved > 0));
    if (spec.id === 'tien-len') f.manager.finish(room, winner, 'A01 settlement fixture');
    else if (spec.id === 'sam-loc') f.manager.settle(room, new Map([[winner.id, spec.stake], [room.players[1].id, -spec.stake]]), 'NORMAL', winner, 'A01 settlement fixture');
    else {
      winner.score = 0; room.players[1].score = 25;
      f.manager.finishRound(room, null, 'A01 settlement fixture');
    }
    assert.equal(room.phase, 'RESULT');
    assert.equal(balances(f).reduce((sum, wallet) => sum + wallet.available, 0), 2000);
    assert.deepEqual(balances(f).map(wallet => wallet.reserved), [0, 0]);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM matches WHERE match_id = ?').get(room.matchId).n, 1);
    const opPrefix = `${spec.id}:settle:${room.matchId}`;
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM wallet_operations WHERE idempotency_key = ?').get(opPrefix).n, 1);
    const committed = JSON.parse(f.store.gameSnapshots(spec.id).find(item => item.roomCode === room.code).stateJson);
    assert.equal(committed.phase, 'RESULT');
    if (spec.id === 'tien-len') f.manager.finish(room, winner, 'duplicate fixture');
    else if (spec.id === 'sam-loc') f.manager.settle(room, new Map(), 'NORMAL', winner, 'duplicate fixture');
    else f.manager.finishRound(room, null, 'duplicate fixture');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM wallet_ledger WHERE source = ? AND match_id = ?').get('settlement', room.matchId).n, spec.id === 'tien-len' ? 3 : 2);
    assert.equal(balances(f).reduce((sum, wallet) => sum + wallet.available + wallet.reserved, 0), 2000);
  });
}

test('A01 Tiến lên rolls back white-win settlement failure swallowed by startGame', t => {
  const spec = games[0], f = makeFixture(t, spec), { createTienLenDeck } = require('../src/games/tien-len/tienLenDeck');
  f.manager.shuffle = deck => [...deck.filter(card => card.rank === '2'), ...deck.filter(card => card.rank !== '2')];
  f.store.settleWinnerTakesPot = () => { throw new Error('injected white-win settlement failure'); };
  f.sockets.forEach(item => { item.events.length = 0; });
  const result = f.manager.startGame(f.sockets[0], f.room.code);
  assert.match(result.error, /white-win settlement failure/);
  assert.equal(f.room.phase, 'WAITING');
  assert.equal(f.room.matchId, null);
  assert.deepEqual(balances(f).map(wallet => [wallet.available, wallet.reserved]), [[1000, 0], [1000, 0]]);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status = 'HELD'").get().n, 0);
  assert.equal(f.sockets.some(item => item.events.some(event => event.event === 'game_state')), false);
});

test('A01 Tiến lên terminal action settlement failure restores cards and suppresses the result broadcast', t => {
  const spec = games[0], f = makeFixture(t, spec, { start: true });
  const room = f.room, winner = room.players.find(player => player.id === room.currentPlayerId);
  const lastCard = winner.hand[0]; winner.hand = [lastCard]; room.initialRequiredCardId = lastCard.id;
  room.playedAny = false; room.topPlay = null; room.passedIds = []; room.leaderId = winner.id;
  const before = structuredClone(room);
  f.store.settleWinnerTakesPot = () => { throw new Error('injected action settlement failure'); };
  f.sockets.forEach(item => { item.events.length = 0; });
  f.manager.action(winner === room.players[0] ? f.sockets[0] : f.sockets[1], room.code,
    { action: 'play', actionId: crypto.randomUUID(), expectedRevision: room.revision, cardIds: [lastCard.id] });
  assert.deepEqual(room, before);
  assert.deepEqual(balances(f).map(wallet => wallet.reserved), [spec.hold, spec.hold]);
  assert.equal(f.sockets.some(item => item.events.some(event => event.event === 'game_state')), false);
  assert.equal(f.sockets.flatMap(item => item.events).filter(event => event.event === 'game_error').length, 1);
});

for (const spec of games) for (const crash of ['before_snapshot', 'after_snapshot', 'after_commit']) {
  test(`A01 ${spec.id}: child-process crash ${crash} reopens at the last committed boundary`, t => {
    const directory = temp(), root = path.resolve(__dirname, '..');
    const setup = `
      const fs=require('node:fs'),path=require('node:path');
      const {ProfileStore}=require('./src/platform/profileStore');
      const Manager=require('./src/games/${spec.id === 'tien-len' ? 'tien-len/tienLenEngine' : spec.id === 'sam-loc' ? 'sam-loc/samLocEngine' : 'phom/phomEngine'}').${spec.Manager.name};
      const dir=process.argv[1], crash=process.argv[2], db=path.join(dir,'profiles.sqlite'), json=path.join(dir,'rooms.json');
      const shuffle=cards=>{const result=[...cards];let seed=0x5eed1234;for(let index=result.length-1;index>0;index--){seed=(seed*1664525+1013904223)>>>0;const other=seed%(index+1);[result[index],result[other]]=[result[other],result[index]];}return result;};
      const store=new ProfileStore({databaseFile:db}), io={sockets:{sockets:new Map()}};
      const profiles=[0,1].map(i=>store.createProfile({displayName:'Crash '+i}).profile);
      const sockets=profiles.map((profile,i)=>({id:'crash-'+i,profile,join(){},leave(){},emit(){}}));
      sockets.forEach(s=>io.sockets.sockets.set(s.id,s));
      const manager=new Manager(io,{profileStore:store,profileForSocket:s=>s.profile,storageFile:json,shuffle});
      const seat=manager.createRoom(sockets[0],'Host','🎲',{stake:${spec.stake}}); manager.joinRoom(sockets[1],seat.roomCode,'Guest','🎲');
      const room=manager.rooms.get(seat.roomCode); manager.setReady(sockets[0],room.code,true); manager.setReady(sockets[1],room.code,true);
      manager.flush();
      fs.writeFileSync(path.join(dir,'control.json'),JSON.stringify({profiles:profiles.map(p=>p.id),code:room.code}));
      const original=store.saveGameSnapshot.bind(store);
      store.saveGameSnapshot=args=>{if(crash==='before_snapshot')process.exit(31);original(args);if(crash==='after_snapshot')process.exit(31);};
      if(crash==='after_commit') { const write=fs.writeFileSync; fs.writeFileSync=function(file,...args){if(String(file)===json+'.tmp'){if(!['TURN','SAM_DECLARATION','SAM_PLAY','DRAW_OR_EAT','DISCARD','LAYDOWN'].includes(room.phase))process.exit(33);if(room.reservations.length!==2||profiles.some(p=>store.publicProfile(p.id).balances.coin.reserved!==room.reservations[0].amount))process.exit(34);process.exit(31);}return write.call(fs,file,...args);}; }
      manager.startGame(sockets[0],room.code); process.exit(32);
    `;
    const child = spawnSync(process.execPath, ['-e', setup, directory, crash], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(child.status, 31, child.stderr || child.stdout);
    const control = JSON.parse(fs.readFileSync(path.join(directory, 'control.json'), 'utf8'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'rooms.json'), 'utf8')).rooms[0].phase, 'WAITING');
    const store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite') });
    const restored = new spec.Manager(fakeIo(), { profileStore: store, storageFile: path.join(directory, 'rooms.json') });
    t.after(() => { restored.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const room = restored.rooms.get(control.code), committed = crash === 'after_commit';
    assert.ok(room);
    assert.equal(room.phase === 'WAITING', !committed);
    const holdAmount = committed ? room.reservations[0].amount : 0;
    for (const profileId of control.profiles) {
      const wallet = store.publicProfile(profileId).balances.coin;
      assert.equal(wallet.reserved, holdAmount);
      assert.equal(wallet.available, 1000 - holdAmount);
    }
  });
}

test('A01 hold audit is read-only by default and repairs only an explicit closed tombstone', t => {
  const directory = temp(), databaseFile = path.join(directory, 'profiles.sqlite');
  const store = new ProfileStore({ databaseFile });
  const profiles = [0, 1].map(index => store.createProfile({ displayName: `Audit ${index}` }).profile);
  const roomCode = 'A01X', matchId = crypto.randomUUID();
  const hold = store.reserveMany({ reservations: profiles.map(profile => ({ profileId: profile.id, amount: 75 })),
    operationKey: `tien-len:reserve:${matchId}`, roomCode, matchId, currency: 'coin' });
  store.saveGameSnapshot({ gameId: 'tien-len', room: { code: roomCode, gameId: 'tien-len', matchId, phase: 'TURN', reservations: hold.held, players: [] } });
  store.closeGameRoom('tien-len', roomCode);
  const uncertainProfiles = [0, 1].map(index => store.createProfile({ displayName: `Uncertain ${index}` }).profile);
  const uncertainMatch = crypto.randomUUID(), uncertainCode = 'A01Y';
  store.reserveMany({ reservations: uncertainProfiles.map(profile => ({ profileId: profile.id, amount: 50 })),
    operationKey: `sam-loc:reserve:${uncertainMatch}`, roomCode: uncertainCode, matchId: uncertainMatch, currency: 'coin' });
  store.syncRoom({ gameId: 'sam-loc', room: { code: uncertainCode, gameId: 'sam-loc', matchId: uncertainMatch, phase: 'TURN', players: [] } });
  store.saveGameSnapshot({ gameId: 'sam-loc', room: { code: uncertainCode, gameId: 'sam-loc', matchId: uncertainMatch, phase: 'TURN', reservations: [], players: [] } });
  store.db.prepare("UPDATE game_snapshots SET state_json = 'invalid snapshot' WHERE game_id = 'sam-loc' AND room_code = ?").run(uncertainCode);
  store.db.prepare("UPDATE rooms SET phase = 'CLOSED' WHERE game_id = 'sam-loc' AND room_code = ?").run(uncertainCode);
  store.close();
  const readonly = new ProfileStore({ databaseFile, readOnly: true });
  const legacyActive = { gameId: 'tien-len', code: roomCode, matchId, phase: 'TURN' };
  const blocked = readonly.auditFixedGameHolds({ legacyRooms: [legacyActive] });
  const legacyBlocked = blocked.find(item => item.roomCode === roomCode);
  assert.equal(blocked.length, 2); assert.equal(legacyBlocked.safeToRefund, false); assert.equal(legacyBlocked.evidence.activeLegacyRoom, true);
  const report = readonly.auditFixedGameHolds();
  const safe = report.find(item => item.roomCode === roomCode);
  assert.equal(report.length, 2); assert.equal(safe.safeToRefund, true); assert.equal(safe.repaired, false);
  assert.deepEqual(profiles.map(profile => readonly.publicProfile(profile.id).balances.coin.reserved), [75, 75]);
  const uncertain = readonly.auditFixedGameHolds().find(item => item.roomCode === uncertainCode);
  assert.equal(uncertain.safeToRefund, false); assert.equal(uncertain.evidence.snapshot, 'INVALID');
  assert.deepEqual(uncertainProfiles.map(profile => readonly.publicProfile(profile.id).balances.coin.reserved), [50, 50]);
  readonly.close();
  const repair = new ProfileStore({ databaseFile });
  const repaired = repair.auditFixedGameHolds({ repairSafe: true });
  assert.equal(repaired.find(item => item.roomCode === roomCode).repaired, true);
  assert.equal(repaired.find(item => item.roomCode === uncertainCode).repaired, false);
  assert.deepEqual(profiles.map(profile => repair.publicProfile(profile.id).balances.coin), [{ available: 1000, reserved: 0 }, { available: 1000, reserved: 0 }]);
  assert.equal(repair.db.prepare("SELECT COUNT(*) AS n FROM wallet_ledger WHERE source = 'release' AND match_id = ?").get(matchId).n, 2);
  assert.deepEqual(uncertainProfiles.map(profile => repair.publicProfile(profile.id).balances.coin.reserved), [50, 50]);
  repair.close();
  const cli = spawnSync(process.execPath, ['scripts/audit-a01.js', databaseFile], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(cli.status, 2, cli.stderr || cli.stdout);
  assert.equal(JSON.parse(cli.stdout).mode, 'read-only');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('A01 hold audit recognizes a live room linked to every HELD reservation', t => {
  const directory = temp(), store = new ProfileStore({ databaseFile: path.join(directory, 'profiles.sqlite') });
  const profiles = [0, 1].map(index => store.createProfile({ displayName: `Live ${index}` }).profile), matchId = crypto.randomUUID(), roomCode = 'A01L';
  const hold = store.reserveMany({ reservations: profiles.map(profile => ({ profileId: profile.id, amount: 100 })),
    operationKey: `tien-len:reserve:${matchId}`, roomCode, matchId, currency: 'coin' });
  store.saveGameSnapshot({ gameId: 'tien-len', room: { code: roomCode, gameId: 'tien-len', matchId, phase: 'TURN', reservations: hold.held, players: [] } });
  const report = store.auditFixedGameHolds();
  assert.equal(report.length, 1); assert.equal(report[0].status, 'ACTIVE'); assert.equal(report[0].needsAttention, false);
  store.close(); fs.rmSync(directory, { recursive: true, force: true });
});
