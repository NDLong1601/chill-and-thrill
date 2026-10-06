'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createTemporaryDirectory, removeTemporaryDirectory } = require('./helpers/temporary-directory');
const express = require('express');
const { chromium } = require('@playwright/test');
const { ProfileStore } = require('../src/platform/profileStore');
const { ProfileService } = require('../src/platform/profileService');
const { GroupTournamentService } = require('../src/platform/groupTournamentService');
const { attachGroupTournamentRoutes } = require('../src/platform/groupTournamentRoutes');

async function main() {
  const root = createTemporaryDirectory('tournament-browser');
  let store, server, browser;
  try {
    store = new ProfileStore({ databaseFile: path.join(root, 'store.sqlite') });
    const alice = store.createProfile({ displayName: 'Alice', avatar: '🎲' });
    const bob = store.createProfile({ displayName: 'Bobby', avatar: '🕶️' });
    const groupId = 'group-browser-c08';
    const members = [
      { profileId: alice.profile.id, displayName: 'Alice', joinOrder: 0 },
      { profileId: bob.profile.id, displayName: 'Bobby', joinOrder: 1 },
    ];
    let roomBinding = null;
    const service = new GroupTournamentService({ profileStore: store,
      getTrustedGroupSnapshot: async requested => requested === groupId ? { groupId, name: 'Nhóm kiểm tra', hostProfileId: alice.profile.id,
        participantProfileIds: members.map(item => item.profileId), members, currentTargetRoomCode: roomBinding?.roomCode || null, roomBinding } : null,
    });

    const app = express(); app.use(express.json());
    attachGroupTournamentRoutes(app, { service, profiles: new ProfileService({ profileStore: store }) });
    app.use(express.static(path.join(__dirname, '..', 'public')));
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(token => localStorage.setItem('chill-thrill:profile-token', token), alice.sessionToken);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${origin}/groups/tournament.html?group=${encodeURIComponent(groupId)}`);
    await page.getByRole('heading', { name: 'Giải đấu & bảng xếp hạng' }).waitFor();
    await page.getByText('Nhóm kiểm tra').waitFor();
    await page.locator('input[name=name]').fill('Tối thứ sáu');
    await page.locator('select[name=gameId]').selectOption('uno');
    await page.locator('select[name=variant]').selectOption('classic-108-v1');
    await page.locator('input[name=rounds]').fill('1');
    await page.getByRole('button', { name: 'Tạo giải' }).click();
    await page.getByRole('button', { name: 'Bắt đầu và khóa thành viên' }).waitFor();
    await page.getByRole('button', { name: 'Bắt đầu và khóa thành viên' }).click();
    await page.getByText('Vòng 1 / 1 · Sẵn sàng mở ván trong nhóm.').waitFor();

    const data = { roomCode: 'BROWSER8', gameId: 'uno', variant: 'classic-108-v1', matchId: 'browser-match-c08',
      participantProfileIds: [alice.profile.id, bob.profile.id] };
    roomBinding = { roomCode: data.roomCode, gameId: data.gameId, variant: data.variant, matchId: data.matchId,
      participants: data.participantProfileIds, phase: 'WAITING', terminalStatus: null };
    await service.registerRoomMatch({ groupId, roomCode: data.roomCode, gameId: data.gameId, variant: data.variant, matchId: data.matchId });
    store.syncRoom({ gameId: 'uno', room: { code: data.roomCode, gameId: 'uno', phase: 'RESULT', matchId: data.matchId,
      variant: data.variant, players: [{ id: 'a', profileId: alice.profile.id }, { id: 'b', profileId: bob.profile.id }] } });
    store.recordCompletedMatch({ matchId: data.matchId, gameId: 'uno', roomCode: data.roomCode,
      players: [{ profileId: alice.profile.id, outcome: 'WIN' }, { profileId: bob.profile.id, outcome: 'LOSS' }],
      result: { winnerProfileId: alice.profile.id, durationMs: 40 } });
    await service.reconcileCommittedMatch({ groupId, gameId: data.gameId, variant: data.variant, matchId: data.matchId });

    await page.getByRole('button', { name: 'Làm mới' }).click();
    await page.getByRole('cell', { name: 'Alice' }).waitFor();
    await page.getByRole('cell', { name: '3', exact: true }).waitFor();
    await page.getByText('Đã tính điểm').waitFor();
    assert.equal(pageErrors.length, 0, `browser errors: ${pageErrors.join('; ')}`);
    const body = await page.locator('body').innerText();
    assert.equal(body.includes(alice.sessionToken), false);
    assert.equal(body.includes(bob.sessionToken), false);
    assert.equal(body.includes(alice.profile.id), false);
    assert.equal(body.includes(bob.profile.id), false);
    console.log('C08 browser flow passed: create → host start/roster lock → committed result → standings/history refresh; no page errors or peer credentials.');
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    if (store) store.close();
    removeTemporaryDirectory(root);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
