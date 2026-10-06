'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const projectRoot = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(projectRoot, 'public/admin.html'), 'utf8')
  .replace(/<link[^>]+href="\/css\/admin\.css"[^>]*>/, '')
  .replace(/<script defer src="\/js\/admin\.js"><\/script>/, '');
const css = fs.readFileSync(path.join(projectRoot, 'public/css/admin.css'), 'utf8');
const js = fs.readFileSync(path.join(projectRoot, 'public/js/admin.js'), 'utf8');
const installedChromium = [
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
].filter(candidate => candidate && fs.existsSync(candidate))[0];

async function main() {
  const browser = await chromium.launch({ headless: true, ...(installedChromium ? { executablePath: installedChromium } : {}) });
  const pageErrors = [];
  const externalRequests = [];
  let maintenance = false;
  let actionCount = 0;
  const origin = 'http://localhost:3000';
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { externalRequests.push(url.href); return route.abort(); }
      if (url.pathname === '/admin-test') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      if (url.pathname === '/api/admin/status') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          server: { maintenance, connectionCount: 4, roomCount: 1, connectedPlayers: 2 },
          addresses: [{ name: 'WiFi · LAN', url: 'http://192.168.1.44:3000', local: false }],
          rooms: [{ code: 'SAFE', gameId: 'uno', variant: 'classic-local-v1', phase: 'PLAYING', playerCount: 2, connectedCount: 2, maxPlayers: 4, visibility: 'public' }],
          storage: { status: 'warning', canStartWager: false, database: { kind: 'sqlite', schemaVersion: 4, integrity: 'ok' }, warnings: [{ sourceId: 'snapshot:tien-len', operation: 'export', code: 'EXPORT_FAILED' }], failures: [], heldAudit: { state: 'ok', total: 2, needsAttention: 0 } },
          recentActions: actionCount ? [{ receiptId: 'receipt-browser-1', action: maintenance ? 'maintenance-enabled' : 'maintenance-disabled', createdAt: '2026-10-06T01:00:00Z' }] : [],
        }) });
      }
      if (url.pathname === '/api/admin/maintenance' && route.request().method() === 'POST') {
        const input = route.request().postDataJSON();
        maintenance = input.enabled === true; actionCount++;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, maintenance, replayed: false, receipt: { receiptId: 'receipt-browser-1' } }) });
      }
      if (/^\/api\/admin\/network-qr\/\d+\.svg$/.test(url.pathname)) {
        return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>' });
      }
      return route.abort();
    });
    await page.goto(`${origin}/admin-test`);
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: js });
    await page.locator('#admin-secret').fill('browser-test-secret-that-is-not-persisted');
    await page.locator('#auth-form button[type=submit]').click();
    await page.locator('#dashboard:not([hidden])').waitFor();
    await page.locator('.qr-image').waitFor();
    assert.match(await page.locator('#auth-message').innerText(), /Đã xác thực/);
    assert.match(await page.locator('#room-list').innerText(), /UNO 112 lá/);
    assert.match(await page.locator('#storage-state').innerText(), /Có cảnh báo/);
    assert.equal(await page.locator('#room-list img, #room-list script').count(), 0, 'room text renders as text only');
    assert.equal(await page.evaluate(() => localStorage.length), 0, 'the secret is not persisted in local storage');

    for (const viewport of [
      { width: 320, height: 740 }, { width: 390, height: 844 },
      { width: 844, height: 390 }, { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(layout.scrollWidth <= layout.width + 1, `horizontal overflow at ${viewport.width}x${viewport.height}: ${JSON.stringify(layout)}`);
    }

    await page.locator('#maintenance-toggle').click();
    await page.waitForFunction(() => document.getElementById('maintenance-state').textContent === 'Bảo trì');
    assert.match(await page.locator('#receipts').innerText(), /Bật bảo trì/);
    assert.equal(actionCount, 1);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(pageErrors, []);
    await page.locator('#sign-out').click();
    assert.equal(await page.locator('#dashboard').isVisible(), false);
    assert.equal(await page.locator('#admin-secret').inputValue(), '');
    await page.close();
  } finally {
    await browser.close();
  }
  process.stdout.write('C05 admin UI browser check passed: 320/390 mobile, 844 landscape, 1280 desktop; maintenance receipt, no external requests or horizontal overflow.\n');
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
