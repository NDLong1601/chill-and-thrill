'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { io } = require('socket.io-client');
const { createGameServer } = require('../src/httpServer');
const { createDeck, createMatch, applyAction, availableActions, drawCards } = require('../src/games/uno/engine');

function fixedMatch() {
  const match = createMatch({ playerIds: ['p1', 'p2'], rng: () => 0.5 });
  match.hands.p1 = [];
  match.hands.p2 = [];
  match.drawPile = createDeck().filter(card => !['red-5-a', 'wild4-0', 'blue-1-a'].includes(card.id));
  match.discardPile = [{ id: 'red-5-a', color: 'red', type: 'number', value: 5 }];
  match.currentColor = 'red'; match.currentPlayerId = 'p1'; match.direction = 1; match.revision = 0;
  match.pendingDraw = 0; match.pendingTargetId = null; match.reactionWindow = null; match.unoWindow = null; match.drawChoice = null; match.phase = 'PLAYING';
  return match;
}

test('UNO deck is exactly 112 cards with unique ids and 7-card deal', () => {
  const deck = createDeck();
  assert.equal(deck.length, 112);
  assert.equal(new Set(deck.map(card => card.id)).size, 112);
  const counts = Object.groupBy(deck, card => card.type);
  assert.equal(counts.number.length, 76);
  assert.equal(counts.draw2.length, 8);
  assert.equal(counts.reverse.length, 8);
  assert.equal(counts.skip.length, 8);
  assert.equal(counts.wild.length, 8);
  assert.equal(counts.wild4.length, 4);
  const match = createMatch({ playerIds: ['a', 'b', 'c', 'd'], rng: () => 0.3 });
  assert.deepEqual(match.players.map(id => match.hands[id].length), [7, 7, 7, 7]);
  assert.equal(new Set([...Object.values(match.hands).flat(), ...match.drawPile, ...match.discardPile].map(card => card.id)).size, 112);
});

test('UNO legal card, invalid action and no stacking penalty preserve server rules', () => {
  const match = fixedMatch();
  match.hands.p1 = [
    { id: 'red-5-a', color: 'red', type: 'number', value: 5 },
    { id: 'blue-2-a', color: 'blue', type: 'number', value: 2 },
  ];
  let result = applyAction(match, { playerId: 'p1', type: 'play_card', payload: { cardId: 'blue-2-a' } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ACTION');
  assert.equal(match.hands.p1.length, 2);
  match.hands.p1 = [{ id: 'red-draw2-0', color: 'red', type: 'draw2', value: null }, { id: 'blue-2-a', color: 'blue', type: 'number', value: 2 }];
  result = applyAction(match, { playerId: 'p1', type: 'play_card', payload: { cardId: 'red-draw2-0' } });
  assert.equal(result.ok, true);
  assert.equal(match.pendingDraw, 2);
  assert.equal(availableActions(match, 'p2').some(item => item.type === 'play_card'), false);
  result = applyAction(match, { playerId: 'p2', type: 'play_card', payload: { cardId: 'blue-2-a' } });
  assert.equal(result.error.code, 'INVALID_ACTION');
  result = applyAction(match, { playerId: 'p2', type: 'draw_penalty', payload: {} });
  assert.equal(result.ok, true);
  assert.equal(match.pendingDraw, 0);
});

test('UNO draw pile recycles discard cards without losing or duplicating ids', () => {
  const match = fixedMatch();
  const top = { id: 'red-5-a', color: 'red', type: 'number', value: 5 };
  const discarded = [{ id: 'blue-1-a', color: 'blue', type: 'number', value: 1 }, { id: 'green-2-a', color: 'green', type: 'number', value: 2 }, top];
  match.drawPile = []; match.discardPile = discarded.slice();
  const drawn = drawCards(match, 'p1', 2, () => 0.2);
  assert.equal(drawn.length, 2);
  assert.equal(match.discardPile.length, 1);
  assert.equal(match.discardPile[0].id, top.id);
  assert.equal(new Set([...drawn, ...match.discardPile].map(card => card.id)).size, 3);
});

test('UNO calls/catches UNO and resolves successful or failed +4 challenges', () => {
  const match = fixedMatch();
  match.hands.p1 = [{ id: 'red-5-a', color: 'red', type: 'number', value: 5 }, { id: 'blue-1-a', color: 'blue', type: 'number', value: 1 }];
  match.hands.p2 = [{ id: 'green-4-a', color: 'green', type: 'number', value: 4 }];
  let result = applyAction(match, { playerId: 'p1', type: 'play_card', payload: { cardId: 'red-5-a' } });
  assert.equal(result.ok, true);
  assert.equal(match.unoWindow.playerId, 'p1');
  result = applyAction(match, { playerId: 'p2', type: 'catch_uno', payload: {} });
  assert.equal(result.ok, true);
  assert.equal(match.hands.p1.length, 3);

  const challenge = fixedMatch();
  challenge.hands.p1 = [{ id: 'wild4-0', color: null, type: 'wild4', value: null }];
  challenge.hands.p2 = [{ id: 'red-1-a', color: 'red', type: 'number', value: 1 }];
  result = applyAction(challenge, { playerId: 'p1', type: 'play_card', payload: { cardId: 'wild4-0', chosenColor: 'blue' } });
  assert.equal(result.ok, true);
  result = applyAction(challenge, { playerId: 'p2', type: 'challenge_draw_four', payload: {} });
  assert.equal(result.guilty, false);
  assert.equal(challenge.phase, 'RESULT');
  assert.equal(challenge.hands.p2.length, 7);

  const failed = fixedMatch();
  failed.hands.p1 = [{ id: 'wild4-0', color: null, type: 'wild4', value: null }];
  failed.hands.p2 = [{ id: 'blue-1-a', color: 'blue', type: 'number', value: 1 }];
  applyAction(failed, { playerId: 'p1', type: 'play_card', payload: { cardId: 'wild4-0', chosenColor: 'blue' } });
  // A server-side challenge fixture can still observe a hidden matching card
  // (for example after a client race); normal play rejects this illegal +4.
  failed.hands.p1.push({ id: 'red-9-a', color: 'red', type: 'number', value: 9 });
  result = applyAction(failed, { playerId: 'p2', type: 'challenge_draw_four', payload: {} });
  assert.equal(result.guilty, true);
  assert.equal(failed.hands.p1.length, 5);
  assert.equal(failed.phase, 'RESULT');
});

function waitFor(client, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off(event, handler); reject(new Error(`Timeout waiting for ${event}`)); }, 4000);
    function handler(value) { if (!predicate(value)) return; clearTimeout(timer); client.off(event, handler); resolve(value); }
    client.on(event, handler);
  });
}

function request(client, event, payload) {
  return new Promise((resolve, reject) => client.timeout(4000).emit(event, payload, (err, value) => err ? reject(err) : resolve(value)));
}

test('UNO sockets keep private hands, stale/duplicate actions safe, and two rooms isolated', async t => {
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const clients = [];
  t.after(async () => { clients.forEach(client => client.disconnect()); await game.close(); });
  async function connect() { const client = io(url, { transports: ['websocket'], forceNew: true, reconnection: false }); await waitFor(client, 'connect'); clients.push(client); return client; }
  const host = await connect();
  const first = await request(host, 'room:create', { gameId: 'uno', playerName: 'UNO Host', config: { roomName: 'UNO A', maxPlayers: 2, visibility: 'public' } });
  const friend = await connect();
  await request(friend, 'room:join', { roomCode: first.roomCode, playerName: 'UNO Friend' });
  await waitFor(host, 'game_state', state => state.gameId === 'uno' && state.players.length === 2);
  host.emit('room:ready', { roomCode: first.roomCode, ready: true }); friend.emit('room:ready', { roomCode: first.roomCode, ready: true });
  await waitFor(host, 'game_state', state => state.gameId === 'uno' && state.players.every(player => player.ready));
  host.emit('start_game', { roomCode: first.roomCode });
  const started = await waitFor(host, 'game_state', state => state.gameId === 'uno' && state.phase === 'PLAYING');
  assert.equal(started.myHand.length, started.topCard.type === 'draw2' ? 9 : 7, 'Opening Draw Two gives the first player two extra cards');
  assert.equal('myHand' in started.players[1], false);
  assert.equal(started.players[1].cardCount, 7);
  const actor = started.currentPlayerId === first.playerId ? host : friend;
  let activeState = started;
  if (!started.currentColor) {
    const color = await request(actor, 'game:action', { roomCode: first.roomCode, matchId: started.matchId, expectedRevision: started.revision, actionId: 'opening-color', type: 'choose_color', payload: { color: 'red' } });
    assert.equal(color.ok, true); activeState = color.state;
  }
  const stale = await request(actor, 'game:action', { roomCode: first.roomCode, matchId: activeState.matchId, expectedRevision: activeState.revision - 1, actionId: 'stale-1', type: 'draw_card', payload: {} });
  assert.equal(stale.error.code, 'STALE_REVISION');
  const draw = await request(actor, 'game:action', { roomCode: first.roomCode, matchId: activeState.matchId, expectedRevision: activeState.revision, actionId: 'once-1', type: 'draw_card', payload: {} });
  assert.equal(draw.ok, true);
  const duplicate = await request(actor, 'game:action', { roomCode: first.roomCode, matchId: activeState.matchId, expectedRevision: activeState.revision, actionId: 'once-1', type: 'draw_card', payload: {} });
  assert.equal(duplicate.error.code, 'DUPLICATE_ACTION');

  const other = await connect();
  const otherRoom = await request(other, 'room:create', { gameId: 'uno', playerName: 'Other Host', config: { maxPlayers: 2 } });
  assert.notEqual(otherRoom.roomCode, first.roomCode);
  const roomList = await (await fetch(`${url}/api/rooms`)).json();
  assert.equal(game.roomService.rooms.size, 2);
  assert.equal(roomList.rooms.filter(room => room.gameId === 'uno').length, 1, 'đang chơi không hiện trong danh sách phòng công khai');
});

test('UNO snapshot restores a normal turn and an open +4 reaction window', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gang-m2-uno-restart-'));
  const storageFile = path.join(directory, 'rooms.json');
  let game = createGameServer({ storageFile });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  let url = `http://127.0.0.1:${game.server.address().port}`;
  const clients = [];
  const connect = async currentUrl => { const client = io(currentUrl, { transports: ['websocket'], forceNew: true, reconnection: false }); await waitFor(client, 'connect'); clients.push(client); return client; };
  const host = await connect(url); const friend = await connect(url);
  const credentials = await request(host, 'room:create', { gameId: 'uno', playerName: 'Restart Host', config: { maxPlayers: 2 } });
  const friendCredentials = await request(friend, 'room:join', { roomCode: credentials.roomCode, playerName: 'Restart Friend' });
  host.emit('room:ready', { roomCode: credentials.roomCode, ready: true }); friend.emit('room:ready', { roomCode: credentials.roomCode, ready: true });
  await waitFor(host, 'game_state', state => state.gameId === 'uno' && state.players.every(player => player.ready));
  host.emit('start_game', { roomCode: credentials.roomCode });
  const started = await waitFor(host, 'game_state', state => state.gameId === 'uno' && state.phase === 'PLAYING');
  game.gm.flush();
  clients.forEach(client => client.disconnect());
  await game.close();

  game = createGameServer({ storageFile });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${game.server.address().port}`;
  clients.length = 0;
  const resumedHost = await connect(url); const resumedFriend = await connect(url);
  const hostStatePromise = waitFor(resumedHost, 'game_state', state => state.gameId === 'uno' && state.phase === 'PLAYING');
  await request(resumedHost, 'room:resume', credentials);
  const resumed = await hostStatePromise;
  await request(resumedFriend, 'room:resume', friendCredentials);
  assert.deepEqual(resumed.myHand, started.myHand);
  assert.equal(resumed.matchId, started.matchId);
  assert.equal(resumed.revision, started.revision);

  const room = game.roomService.rooms.get(credentials.roomCode);
  const match = room.uno;
  const hostId = credentials.playerId;
  const friendId = room.players.find(player => player.id !== hostId).id;
  match.hands[hostId] = [{ id: 'wild4-0', color: null, type: 'wild4', value: null }];
  match.hands[friendId] = [{ id: 'green-1-a', color: 'green', type: 'number', value: 1 }];
  match.discardPile = [{ id: 'red-5-a', color: 'red', type: 'number', value: 5 }]; match.drawPile = createDeck().filter(card => !['wild4-0', 'green-1-a', 'red-5-a'].includes(card.id));
  match.currentColor = 'red'; match.currentPlayerId = hostId; match.reactionWindow = null; match.unoWindow = null; match.pendingDraw = 0; match.revision += 1;
  game.gm.broadcast(credentials.roomCode); game.gm.flush();
  const reactionResult = await request(resumedHost, 'game:action', { roomCode: credentials.roomCode, matchId: match.matchId, expectedRevision: match.revision, actionId: 'restart-reaction', type: 'play_card', payload: { cardId: 'wild4-0', chosenColor: 'blue' } });
  assert.equal(reactionResult.ok, true);
  const reactionMatchId = match.matchId; const reactionDeadline = match.reactionWindow.deadlineAt;
  clients.forEach(client => client.disconnect()); await game.close();

  game = createGameServer({ storageFile });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${game.server.address().port}`;
  const afterRestart = io(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  t.after(async () => { afterRestart.disconnect(); await game.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await waitFor(afterRestart, 'connect');
  const stateAfterReactionRestart = waitFor(afterRestart, 'game_state', state => state.gameId === 'uno' && state.phase === 'PLAYING');
  await request(afterRestart, 'room:resume', credentials);
  const restoredReaction = await stateAfterReactionRestart;
  assert.equal(restoredReaction.matchId, reactionMatchId);
  assert.equal(restoredReaction.reactionWindow.targetId, friendId);
  assert.equal(restoredReaction.reactionWindow.deadlineAt, reactionDeadline);
});
