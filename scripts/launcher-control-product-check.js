'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { ServerSupervisor } = require('../src/platform/launcherLifecycle');
const { createLauncherControlServer } = require('../src/platform/launcherControlServer');
const { verifyBackup } = require('../src/platform/backupRestore');

async function run() {
  const realProjectRoot = path.resolve(__dirname, '..');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-launcher-control-product-'));
  const dataDirectory = path.join(fixtureRoot, 'data');
  fs.mkdirSync(dataDirectory);
  const databaseFile = path.join(dataDirectory, 'chill-and-thrill.sqlite');
  const storageFile = path.join(dataDirectory, 'rooms.json');
  const supervisor = new ServerSupervisor({ projectRoot: realProjectRoot, startTimeoutMs: 20000, stopTimeoutMs: 15000,
    env: { PORT: '0', GANG_DATA_FILE: storageFile, GANG_DATABASE_FILE: databaseFile, GANG_DB_FILE: databaseFile } });
  const capability = 'temporary-c06-browser-control-capability-at-least-32';
  const openedDirectories = [];
  const control = createLauncherControlServer({ projectRoot: fixtureRoot, supervisor, capability,
    uiDirectory: path.join(realProjectRoot, 'launcher'), openFolder: directory => openedDirectories.push(directory) });
  let browser;
  try {
    await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${control.server.address().port}`;
    assert.equal((await fetch(`${origin}/api/status`)).status, 401);
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`${origin}/#cap=${capability}`);
    await page.getByRole('heading', { name: 'Chưa xác nhận trạng thái' }).waitFor();
    assert.equal(new URL(page.url()).hash, '');
    const cookies = await context.cookies();
    assert.equal(cookies.find(cookie => cookie.name === 'ct_launcher_session')?.httpOnly, true);
    assert.equal(await page.locator('#database-path').innerText(), databaseFile);
    assert.equal(await page.locator('#backup-button').isEnabled(), false);
    await page.locator('#start-button').click();
    await page.getByRole('heading', { name: 'Máy chủ đang chạy' }).waitFor();
    await page.locator('#addresses img').first().waitFor();
    assert.ok(await page.locator('#addresses img').count() >= 1);
    assert.match(await page.locator('#addresses img').first().getAttribute('src'), /^data:image\/png;base64,/);
    const gamePort = supervisor.getStatus().port;
    assert.ok(gamePort > 0);
    assert.equal((await fetch(`http://127.0.0.1:${gamePort}/api/registry`)).status, 200);
    await page.reload();
    await page.getByRole('heading', { name: 'Máy chủ đang chạy' }).waitFor();
    assert.equal(supervisor.getStatus().port, gamePort);

    // Backup from RUNNING uses the actual controlled graceful-stop gate.
    const backupResponsePromise = page.waitForResponse(response => response.url() === `${origin}/api/backup` && response.request().method() === 'POST');
    await page.locator('#backup-button').click();
    const backupResponse = await backupResponsePromise;
    assert.equal(backupResponse.status(), 200);
    const backup = await backupResponse.json();
    await page.getByRole('heading', { name: 'Đã dừng an toàn' }).waitFor();
    assert.equal(supervisor.getStatus().managedProcess, false);
    assert.deepEqual(supervisor.getStatus().exitInfo, { code: 0, signal: null });
    assert.equal(verifyBackup(backup.directory).manifest.state, 'complete');
    await assert.rejects(fetch(`http://127.0.0.1:${gamePort}/api/registry`));
    await page.locator('#restore-path').fill(backup.directory);
    const restorePromise = page.waitForResponse(response => response.url() === `${origin}/api/restore` && response.request().method() === 'POST');
    await page.locator('#restore-button').click();
    const restoreResponse = await restorePromise;
    assert.equal(restoreResponse.status(), 200);
    const restored = await restoreResponse.json();
    assert.notEqual(path.dirname(restored.databaseFile), dataDirectory);
    assert.ok(fs.existsSync(restored.databaseFile));
    assert.ok(fs.existsSync(databaseFile));
    assert.equal(supervisor.getStatus().state, 'stopped');
    await page.locator('[data-folder="profile"]').click();
    await page.getByRole('status').filter({ hasText: 'Đã mở thư mục:' }).waitFor();
    assert.deepEqual(openedDirectories, [dataDirectory]);
    for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await page.screenshot({ path: path.join(realProjectRoot, 'test-results', 'launcher-C06-product-mobile-20261006.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS C06 actual browser -> authenticated loopback control -> actual temporary game child: start, QR PNG/IP, cookie refresh/reload, backup waits clean exit, restore to new directory, bounded folder operation, 320/390/844 layout, zero page errors.');
  } finally {
    await browser?.close();
    if (supervisor.getStatus().managedProcess) await supervisor.stop();
    if (control.server.listening) await new Promise(resolve => control.server.close(resolve));
    const contained = path.dirname(fixtureRoot) === path.resolve(os.tmpdir()) && path.basename(fixtureRoot).startsWith('ct-launcher-control-product-');
    if (contained && !supervisor.getStatus().managedProcess) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
