'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createTemporaryDirectory, removeTemporaryDirectory } = require('../scripts/helpers/temporary-directory');
const express = require('express');
const { ProfileStore } = require('../src/platform/profileStore');
const { ProfileService } = require('../src/platform/profileService');
const { GroupTournamentService } = require('../src/platform/groupTournamentService');
const { attachGroupTournamentRoutes } = require('../src/platform/groupTournamentRoutes');

const temporary = createTemporaryDirectory('tournament-routes');
test.after(() => removeTemporaryDirectory(temporary));

test('tournament routes authenticate a profile, authorize group membership and expose no result-submission endpoint', async t => {
  const store = new ProfileStore({ databaseFile: path.join(temporary, 'store.sqlite') });
  const alice = store.createProfile({ displayName: 'Alice', avatar: '🎲' });
  const bob = store.createProfile({ displayName: 'Bob', avatar: '🎲' });
  const outsider = store.createProfile({ displayName: 'Outside', avatar: '🎲' });
  const members = [
    { profileId: alice.profile.id, displayName: 'Alice', joinOrder: 0 },
    { profileId: bob.profile.id, displayName: 'Bob', joinOrder: 1 },
  ];
  const service = new GroupTournamentService({ profileStore: store,
    getTrustedGroupSnapshot: async groupId => groupId === 'group-routes' ? { groupId, name: 'Routes', hostProfileId: alice.profile.id,
      participantProfileIds: members.map(item => item.profileId), currentTargetRoomCode: null } : null,
  });
  const app = express(); app.use(express.json());
  attachGroupTournamentRoutes(app, { service, profiles: new ProfileService({ profileStore: store }) });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { token, method = 'GET', body } = {}) => fetch(`${origin}${route}`, {
    method, headers: { ...(token ? { 'x-profile-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const base = '/api/groups/group-routes/tournaments';

  assert.equal((await request(base)).status, 401);
  assert.equal((await request(base, { token: outsider.sessionToken })).status, 403);
  const createdResponse = await request(base, { token: alice.sessionToken, method: 'POST', body: {
    name: 'Friday', gameId: 'uno', variant: 'classic-108-v1', rounds: 2, results: [{ profileId: alice.profile.id, points: 999999 }],
  } });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(Object.hasOwn(created, 'groupId'), false);
  assert.equal(Object.hasOwn(created.standings[0], 'profileId'), false);
  assert.equal(created.standings[0].points, 0);
  assert.equal((await request(`${base}/${created.tournamentId}/start`, { token: bob.sessionToken, method: 'POST', body: {} })).status, 403);
  assert.equal((await request(`${base}/${created.tournamentId}/start`, { token: alice.sessionToken, method: 'POST', body: {} })).status, 200);
  assert.equal((await request(`${base}/${created.tournamentId}/result`, { token: alice.sessionToken, method: 'POST', body: { points: 1000 } })).status, 404);
  const detail = await (await request(`${base}/${created.tournamentId}`, { token: alice.sessionToken })).json();
  const serialized = JSON.stringify(detail);
  assert.equal(serialized.includes(alice.sessionToken), false);
  assert.equal(serialized.includes(bob.sessionToken), false);
  assert.equal(serialized.includes(alice.profile.id), false);
  assert.equal(serialized.includes(bob.profile.id), false);
});
