'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTemporaryDirectory, removeTemporaryDirectory } = require('../scripts/helpers/temporary-directory');
const { DatabaseSync } = require('node:sqlite');
const { ProfileStore } = require('../src/platform/profileStore');
const { GroupTournamentService } = require('../src/platform/groupTournamentService');
const { defaultSourcePaths, MANAGER_FILES, createBackup, verifyBackup, restoreBackup } = require('../src/platform/backupRestore');

test('C04 VACUUM backup and restore preserves the C08 app-owned tournament table', async t => {
  const root = createTemporaryDirectory('tournament-backup');
  let store, restoredStore;
  t.after(() => {
    try { restoredStore?.close(); } catch {}
    try { store?.close(); } catch {}
    removeTemporaryDirectory(root);
  });
  const projectRoot = path.join(root, 'project'), dataDirectory = path.join(projectRoot, 'data'), bundle = path.join(root, 'bundle'), restored = path.join(root, 'restored');
  fs.mkdirSync(dataDirectory, { recursive: true });
  const paths = defaultSourcePaths({ projectRoot, dataDirectory, databaseFile: path.join(dataDirectory, 'store.sqlite'), storageFile: path.join(dataDirectory, 'rooms.json') });
  store = new ProfileStore({ databaseFile: paths.databaseFile });
  const one = store.createProfile({ displayName: 'One', avatar: '🎲' });
  const two = store.createProfile({ displayName: 'Two', avatar: '🕶️' });
  const members = [{ profileId: one.profile.id, displayName: 'One', joinOrder: 0 }, { profileId: two.profile.id, displayName: 'Two', joinOrder: 1 }];
  const service = new GroupTournamentService({ profileStore: store,
    getTrustedGroupSnapshot: async groupId => ({ groupId, name: 'Backup', hostProfileId: one.profile.id,
      participantProfileIds: members.map(item => item.profileId), currentTargetRoomCode: null }) });
  const tournament = await service.create({ groupId: 'backup-group', actorProfileId: one.profile.id, name: 'Saved Cup', gameId: 'uno', variant: 'classic-108-v1', rounds: 2 });
  await service.start({ groupId: 'backup-group', tournamentId: tournament.tournamentId, actorProfileId: one.profile.id });
  store.close();

  fs.writeFileSync(paths.storageFile, JSON.stringify({ version: 2, rooms: [] }));
  for (const spec of MANAGER_FILES) fs.writeFileSync(paths.managerFiles[spec.sourceKey], JSON.stringify({ version: spec.versions[0], rooms: [] }));
  const result = createBackup({ serverStopped: true, projectRoot, dataDirectory, databaseFile: paths.databaseFile, storageFile: paths.storageFile, outputDirectory: bundle });
  assert.equal(result.validation.database.schemaVersion, 4);
  assert.ok(verifyBackup(bundle).manifest.files.some(file => file.id === 'profile-store'));
  const restoredResult = restoreBackup({ backupDirectory: bundle, outputDirectory: restored, projectRoot,
    databaseFile: paths.databaseFile, storageFile: paths.storageFile });
  const db = new DatabaseSync(restoredResult.databaseFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT status, payload_json FROM group_tournament_records WHERE record_type = 'tournament' AND record_id = ?").get(tournament.tournamentId);
    assert.equal(row.status, 'IN_PROGRESS');
    assert.equal(JSON.parse(row.payload_json).membershipLocked, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM group_tournament_records').get().count, 1);
  } finally { db.close(); }
  restoredStore = new ProfileStore({ databaseFile: restoredResult.databaseFile });
  const restoredRanking = new GroupTournamentService({ profileStore: restoredStore, getTrustedGroupSnapshot: async () => null });
  const hostView = await restoredRanking.detail({ groupId: 'backup-group', tournamentId: tournament.tournamentId, actorProfileId: one.profile.id });
  assert.equal(hostView.status, 'SUSPENDED');
  assert.equal(hostView.currentRoundStatus, 'SUSPENDED');
  assert.equal(restoredRanking.membershipLocked('backup-group'), false);
  await assert.rejects(restoredRanking.detail({ groupId: 'backup-group', tournamentId: tournament.tournamentId, actorProfileId: 'not-a-member' }), { code: 'GROUP_FORBIDDEN' });
  const closed = await restoredRanking.close({ groupId: 'backup-group', tournamentId: tournament.tournamentId, actorProfileId: one.profile.id });
  assert.equal(closed.status, 'CLOSED');
});
