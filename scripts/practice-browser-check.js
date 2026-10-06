'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { createPracticeHarness } = require('./practice-harness');
const { chooseTienLenAction } = require('../src/platform/practiceBotPolicy');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createProductFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-c02-browser-'));
  const game = require('../src/httpServer').createGameServer({ storageFile: path.join(directory, 'rooms.json'), databaseFile: path.join(directory, 'profiles.sqlite') });
  return {
    service: game.practice,
    listen(port, host) { return new Promise(resolve => game.server.listen(port, host, () => resolve(game.server.address()))); },
    async close() {
      await game.close();
      assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function getSessionState(page) {
  return page.evaluate(async () => {
    const session = JSON.parse(sessionStorage.getItem('chill-thrill:practice-session:v1'));
    const response = await fetch(`/api/practice/sessions/${encodeURIComponent(session.id)}`, { headers: { Authorization: `Bearer ${session.capability}` } });
    return response.json();
  });
}

async function waitForApiAction(page, callback) {
  const responsePromise = page.waitForResponse(response => response.url().includes('/api/practice/sessions/') && response.url().endsWith('/actions') && response.request().method() === 'POST');
  await callback();
  const response = await responsePromise;
  assert.equal(response.ok(), true);
  return response.json();
}

async function clickUnoAction(page, state) {
  const action = state.player.availableActions.find(item => item.type === 'draw_card') || state.player.availableActions.find(item => item.type === 'play_card');
  assert.ok(action, 'UNO practice should expose a human legal move.');
  if (action.type === 'draw_card') {
    const button = page.getByRole('button', { name: 'Rút một lá' });
    return waitForApiAction(page, () => button.click());
  }
  const card = state.player.hand.find(item => item.id === action.cardId);
  const selector = `[data-card-id="${action.cardId}"]`;
  const handButton = page.locator(selector);
  if (card.type === 'wild' || card.type === 'wild4') {
    return waitForApiAction(page, async () => {
      await handButton.click();
      await page.locator('.color-choice').waitFor();
      await page.locator('.color-choice .color-button').first().click();
    });
  }
  return waitForApiAction(page, () => handButton.click());
}

async function clickTienAction(page, state) {
  const projection = {
    schemaVersion: 1, gameId: 'tien-len', variant: state.variant, matchId: state.matchId,
    revision: state.revision, seatId: state.player.id, ownHand: state.player.hand, publicState: state.publicState,
  };
  const decision = chooseTienLenAction(projection);
  if (decision?.action === 'play') {
    for (const cardId of decision.cardIds) await page.locator(`[data-card-id="${cardId}"]`).click();
    const button = page.getByRole('button', { name: 'Đánh tổ hợp đã chọn' });
    assert.equal(await button.isEnabled(), true);
    return waitForApiAction(page, () => button.click());
  }
  if (decision?.action === 'pass') return waitForApiAction(page, () => page.getByRole('button', { name: 'Bỏ lượt' }).click());
  throw new Error('Tiến lên practice did not expose a playable human move.');
}

async function checkViewport(page, width, height) {
  await page.setViewportSize({ width, height });
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(dimensions.scrollWidth <= dimensions.width + 1, `Practice UI overflows at ${width}×${height}: ${dimensions.scrollWidth} > ${dimensions.width}`);
}

async function main() {
  const product = process.env.PRACTICE_PRODUCT === '1';
  const harness = product ? createProductFixture() : createPracticeHarness();
  const address = await harness.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;
  const requests = [];
  const errors = [];
  let browser;
  let context;
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }));
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(new URL(request.url()).origin));
    if (product) {
      await page.goto(`${base}/games/tien-len`);
      const practiceLink = page.getByRole('link', { name: 'Luyện tập với bot' });
      await practiceLink.waitFor();
      assert.equal(await practiceLink.getAttribute('href'), '/practice?game=tien-len&variant=south-v1');
      await practiceLink.click();
      assert.equal(await page.locator('#game-choice').inputValue(), 'tien-len|south-v1');
      await page.locator('#game-choice').selectOption('uno|classic-local-v1');
    } else await page.goto(`${base}/practice`);
    assert.equal(await page.title(), 'Luyện tập với bot · Chill & Thrill');
    assert.equal(await page.locator('option[value="uno|classic-108-v1"]').isDisabled(), true);
    await page.locator('#player-name').fill('Browser learner');
    const unoCreate = page.waitForResponse(response => response.url().endsWith('/api/practice/sessions') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /Chia bài cho tôi/ }).click();
    assert.equal((await unoCreate).ok(), true);
    await page.locator('#table-card:not([hidden])').waitFor();
    await page.getByRole('heading', { name: 'UNO 112 lá', exact: true }).waitFor();
    assert.match(await page.locator('#practice-label').innerText(), /không có giá trị.*không vào ví/);
    await checkViewport(page, 390, 844);
    await checkViewport(page, 1280, 900);

    const beforeReload = await getSessionState(page);
    assert.equal(beforeReload.ok, true);
    const beforeMatchId = beforeReload.state.matchId;
    await page.reload();
    await page.locator('#table-card:not([hidden])').waitFor();
    const afterReload = await getSessionState(page);
    assert.equal(afterReload.state.matchId, beforeMatchId, 'a same-tab reload resumes the finite in-memory session');
    await clickUnoAction(page, afterReload.state);

    await page.getByRole('button', { name: 'Phiên mới' }).click();
    await page.locator('#game-choice').selectOption('tien-len|south-v1');
    const newSessionRequest = page.waitForResponse(response => response.url().endsWith('/api/practice/sessions') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /Chia bài cho tôi/ }).click();
    assert.equal((await newSessionRequest).ok(), true);
    await page.getByRole('heading', { name: 'Tiến lên miền Nam', exact: true }).waitFor();
    const tien = await getSessionState(page);
    assert.equal(tien.state.variant, 'south-v1');
    await checkViewport(page, 390, 844);
    await clickTienAction(page, tien.state);
    assert.equal(harness.service.inspectSessionCount(), 1, 'starting a new session closes the previous in-memory session');

    const deleteResponse = page.waitForResponse(response => response.url().includes('/api/practice/sessions/') && response.request().method() === 'DELETE');
    await page.getByRole('button', { name: 'Đóng phiên luyện tập' }).click();
    assert.equal((await deleteResponse).ok(), true);
    assert.equal(harness.service.inspectSessionCount(), 0, 'explicit close removes session state immediately');
    assert.equal(await page.locator('#setup-card').isVisible(), true);
    await page.goto(`${base}/practice?game=uno&variant=classic-108-v1`);
    await page.locator('#notice').waitFor({ state: 'visible' });
    assert.match(await page.locator('#notice').innerText(), /UNO 108 \(classic-108-v1\) chưa hỗ trợ luyện tập/);
    assert.deepEqual(errors, []);
    assert.ok(requests.every(origin => origin === base), `unexpected external request: ${requests.find(origin => origin !== base)}`);
    process.stdout.write(`Practice ${product ? 'product' : 'standalone'} browser check passed: UNO112, reload, Tiến lên, session cleanup, mobile/desktop overflow, no external requests.\n`);
  } finally {
    await context?.close();
    await browser?.close();
    await harness.close();
  }
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
