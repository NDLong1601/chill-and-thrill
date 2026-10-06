'use strict';

// Browser UI regression for the standalone launcher. Every control API is
// fulfilled by Playwright routes; this harness never binds a socket or starts
// the game server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const uiDirectory = path.join(root, 'launcher');
const host = '127.0.0.1';
const port = 41739;
const origin = `http://${host}:${port}`;
const capability = 'launcher-ui-fixture-capability';
const csrf = 'launcher-ui-fixture-csrf';
const png = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="white"/></svg>').toString('base64')}`;
const csp = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const paths = {
  projectRoot: 'C:\\fixture\\chill-and-thrill',
  databaseFile: 'C:\\fixture\\chill-and-thrill\\data\\chill-and-thrill.sqlite',
  roomFile: 'C:\\fixture\\chill-and-thrill\\data\\rooms.json',
  managerFiles: {
    gangUno112: 'C:\\fixture\\chill-and-thrill\\data\\rooms.json',
    uno108: 'C:\\fixture\\chill-and-thrill\\data\\rooms.uno.json',
    tienLen: 'C:\\fixture\\chill-and-thrill\\data\\rooms.tien-len.json',
    poker: 'C:\\fixture\\chill-and-thrill\\data\\rooms.poker.json',
    samLoc: 'C:\\fixture\\chill-and-thrill\\data\\rooms.sam-loc.json',
    phom: 'C:\\fixture\\chill-and-thrill\\data\\rooms.phom.json',
    bang: 'C:\\fixture\\chill-and-thrill\\data\\rooms.bang.json',
  },
  backupDirectory: 'C:\\fixture\\chill-and-thrill\\backups',
};

function statusFor(state, managedProcess) {
  return {
    state,
    managedProcess,
    port: state === 'running' ? 3000 : null,
    urls: state === 'running' ? [
      { name: 'Ethernet', url: 'http://192.168.1.40:3000', local: false, qrDataUrl: png },
      { name: 'Máy chủ', url: 'http://localhost:3000', local: true, qrDataUrl: png },
    ] : [],
    lastError: null,
  };
}

async function main() {
  let browser;
  const actions = [];
  const state = { value: 'running', managedProcess: true, sessionCreated: false };
  const screenshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'chill-thrill-launcher-ui-'));
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      const pathname = url.pathname;
      if (request.method() === 'GET' && pathname === '/') {
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'Content-Security-Policy': csp, 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' }, body: fs.readFileSync(path.join(uiDirectory, 'index.html'), 'utf8') });
      }
      if (request.method() === 'GET' && pathname === '/style.css') return route.fulfill({ contentType: 'text/css; charset=utf-8', body: fs.readFileSync(path.join(uiDirectory, 'style.css'), 'utf8') });
      if (request.method() === 'GET' && pathname === '/app.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: fs.readFileSync(path.join(uiDirectory, 'app.js'), 'utf8') });
      if (request.method() === 'POST' && pathname === '/api/session') {
        const body = request.postDataJSON();
        assert.equal(body.capability, capability);
        state.sessionCreated = true;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Set-Cookie': 'ct_launcher_session=fixture-session; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200' },
          body: JSON.stringify({ ok: true, csrf, expiresAt: Date.now() + 60_000 }),
        });
      }
      if (request.method() === 'GET' && pathname === '/api/status') {
        assert.equal(state.sessionCreated, true);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          ok: true,
          server: statusFor(state.value, state.managedProcess),
          maintenance: null,
          paths,
        }) });
      }
      if (request.method() === 'POST') {
        assert.equal(request.headers()['x-ct-csrf'], csrf);
        const body = request.postDataJSON();
        if (pathname === '/api/server/stop') {
          actions.push('stop'); state.value = 'stopped'; state.managedProcess = false;
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, result: { state: 'stopped' }, server: statusFor('stopped', false) }) });
        }
        if (pathname === '/api/server/start') {
          actions.push('start'); state.value = 'running'; state.managedProcess = true;
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, result: { state: 'running' }, server: statusFor('running', true) }) });
        }
        if (pathname === '/api/backup') {
          actions.push('backup');
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, directory: `${paths.backupDirectory}\\chill-and-thrill-ui-fixture`, manifest: { state: 'complete', files: [] }, validation: {} }) });
        }
        if (pathname === '/api/restore') {
          actions.push(`restore:${body.backupDirectory}`);
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, directory: `${paths.backupDirectory}\\fixture-restored`, databaseFile: 'C:\\fixture\\profile-store.sqlite', storageFile: 'C:\\fixture\\rooms.json', validation: {}, note: 'Dữ liệu đã khôi phục vào thư mục mới.' }) });
        }
        if (pathname === '/api/open-folder') {
          actions.push(`folder:${body.key}`);
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, directory: paths.projectRoot }) });
        }
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: `Unexpected UI request ${request.method()} ${pathname}` }) });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`${origin}/#cap=${capability}`);
    await page.getByRole('heading', { name: 'Máy chủ đang chạy' }).waitFor();
    await page.locator('#addresses img').first().waitFor();
    assert.equal(await page.locator('#addresses img').count(), 2);
    const brandFits = await page.locator('.brand-letters').evaluate(element => element.scrollWidth <= element.clientWidth);
    assert.equal(brandFits, true, 'C & T brand mark stays on one line');
    assert.equal(await page.locator('#database-path').innerText(), paths.databaseFile);
    assert.equal(await page.locator('#rooms-path').innerText(), paths.roomFile);
    assert.equal(await page.locator('#admin-link').getAttribute('href'), 'http://localhost:3000/admin');
    assert.equal((await page.locator('#admin-link').getAttribute('href')).includes('CHILL_ADMIN_SECRET'), false);
    await page.screenshot({ path: path.join(screenshotDirectory, 'launcher-desktop.png'), fullPage: true });

    await page.locator('#stop-button').click();
    await page.getByRole('heading', { name: 'Đã dừng an toàn' }).waitFor();
    assert.equal(await page.locator('#backup-button').isEnabled(), true);
    await page.locator('#backup-button').click();
    await page.getByRole('status').filter({ hasText: 'Backup đã xác minh:' }).waitFor();

    await page.locator('#restore-path').fill(`${paths.backupDirectory}\\chill-and-thrill-ui-fixture`);
    await page.locator('#restore-button').click();
    await page.getByRole('status').filter({ hasText: 'Đã khôi phục vào thư mục mới:' }).waitFor();

    await page.locator('#start-button').click();
    await page.getByRole('heading', { name: 'Máy chủ đang chạy' }).waitFor();
    await page.locator('[data-folder="profile"]').click();
    await page.locator('[data-folder="rooms"]').click();
    await page.locator('[data-folder="backups"]').click();
    assert.deepEqual(actions, ['stop', 'backup', `restore:${paths.backupDirectory}\\chill-and-thrill-ui-fixture`, 'start', 'folder:profile', 'folder:rooms', 'folder:backups']);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    const mobileMetrics = await page.evaluate(() => ({ viewport: innerWidth, pageWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
    assert.ok(mobileMetrics.pageWidth <= mobileMetrics.viewport + 1, `Launcher overflows mobile width: ${JSON.stringify(mobileMetrics)}`);
    assert.equal(await page.locator('.brand-letters').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await page.screenshot({ path: path.join(screenshotDirectory, 'launcher-mobile.png'), fullPage: true });
    assert.deepEqual(pageErrors, []);
    console.log(`Launcher browser check passed: desktop/mobile layout, QR/IP, start/stop, backup/restore, folders. Screenshots: ${screenshotDirectory}`);
  } finally {
    await browser?.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
