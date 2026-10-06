'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, 'public');
const harnessPath = path.join(root, 'test', 'fixtures', 'table-preferences-harness.html');
const mimeTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function createServer() {
  return http.createServer((request, response) => {
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); }
    catch { response.writeHead(400).end(); return; }
    const requestedPath = decodeURIComponent(url.pathname);
    const file = requestedPath === '/table-preferences-harness.html'
      ? harnessPath
      : path.resolve(publicRoot, `.${requestedPath}`);
    if (file !== harnessPath && !file.startsWith(`${publicRoot}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    fs.readFile(file, (error, contents) => {
      if (error) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream' });
      response.end(contents);
    });
  });
}

function closeTo(actual, expected, tolerance = 1.5) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual}px to be within ${tolerance}px of ${expected}px`);
}

async function main() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const pageErrors = [];
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.grantPermissions([]);
    await context.newPage();
    const page = context.pages()[0];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${base}/table-preferences-harness.html`);

    assert.equal(await page.locator('#table').getAttribute('data-card-size'), 'standard');
    assert.equal(await page.locator('#table').getAttribute('data-reduce-motion'), 'true');
    assert.match(await page.locator('.table-preferences-turn').innerText(), /Đến lượt Ngọc/);
    assert.equal(await page.locator('[data-player-id="seat-other"]').evaluate(node => node.classList.contains('table-preferences-current-player')), true);
    const defaultMotionMs = await page.locator('#animated-test').evaluate(node => parseFloat(getComputedStyle(node).animationDuration) * 1000);
    assert.ok(defaultMotionMs <= 0.1, `Reduced motion should shorten animation, got ${defaultMotionMs}ms`);

    const summary = page.locator('.table-preferences-details > summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.table-preferences-details').evaluate(node => node.open), true, 'Preferences open from the keyboard');
    const cardSize = page.locator('select[name="cardSize"]');
    await cardSize.focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(await cardSize.inputValue(), 'large', 'Card size is selectable with the keyboard');

    const unoBox = async () => page.locator('.uno-card').first().evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    // Reduced-motion styles use a tiny nonzero transition duration. Wait for
    // the rendered dimensions after a preference change rather than sampling
    // the previous frame immediately after dispatching the select event.
    const waitForCardSize = async (width, height) => page.waitForFunction(({ width, height }) => {
      const rect = document.querySelector('.uno-card').getBoundingClientRect();
      return Math.abs(rect.width - width) <= 1.5 && Math.abs(rect.height - height) <= 1.5;
    }, { width, height });
    await waitForCardSize(80, 112);
    let size = await unoBox();
    closeTo(size.width, 80); closeTo(size.height, 112);
    closeTo(await page.locator('.tl-card').evaluate(node => node.getBoundingClientRect().width), 78);
    closeTo(await page.locator('.bang-card').evaluate(node => node.getBoundingClientRect().width), 136);
    await cardSize.selectOption('compact');
    await waitForCardSize(55.2, 78.4);
    size = await unoBox(); closeTo(size.width, 55.2); closeTo(size.height, 78.4);
    await cardSize.selectOption('standard');
    await waitForCardSize(68, 96);
    size = await unoBox(); closeTo(size.width, 68); closeTo(size.height, 96);
    await cardSize.selectOption('large');

    const textSize = page.locator('select[name="textSize"]');
    await textSize.selectOption('large');
    assert.equal(await page.locator('#table').getAttribute('data-text-size'), 'large');
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.querySelector('.uno-card')).fontSize) - 21.6) <= 1.5);
    const largeCardFont = await page.locator('.uno-card').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize));
    closeTo(largeCardFont, 21.6);
    await textSize.selectOption('largest');
    assert.equal(await page.locator('#table').getAttribute('data-text-size'), 'largest');
    await page.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.querySelector('.uno-card')).fontSize) - 24.8) <= 1.5);
    const largestCardFont = await page.locator('.uno-card').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize));
    closeTo(largestCardFont, 24.8);
    closeTo(await page.locator('.uno-card-value').evaluate(node => parseFloat(getComputedStyle(node).fontSize)), 32);

    for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      const geometry = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
      assert.ok(geometry.documentWidth <= geometry.width, `No page overflow at ${viewport.width}x${viewport.height}: ${JSON.stringify(geometry)}`);
    }

    await page.emulateMedia({ forcedColors: 'active' });
    const forcedColors = await page.locator('.table-preferences-details > summary').evaluate(node => ({
      adjust: getComputedStyle(node).forcedColorAdjust,
      border: getComputedStyle(node).borderColor,
    }));
    assert.equal(forcedColors.adjust, 'auto');
    assert.ok(forcedColors.border, 'Controls retain a visible forced-color border');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('input[name="reduceMotion"]').uncheck();
    assert.equal(await page.locator('#table').getAttribute('data-reduce-motion'), 'false');
    const restoredMotionMs = await page.locator('#animated-test').evaluate(node => parseFloat(getComputedStyle(node).animationDuration) * 1000);
    assert.ok(restoredMotionMs >= 900, `User motion setting overrides OS preference, got ${restoredMotionMs}ms`);

    await page.locator('input[name="audioEnabled"]').check();
    assert.equal(await page.evaluate(() => window.preferenceAudio.contexts), 1, 'Audio context is created only after explicit trusted opt-in');
    await page.evaluate(() => window.updateTableState(window.makeUnoState('seat-me')));
    assert.equal(await page.evaluate(() => window.preferenceAudio.tones), 1, 'First transition to the current player gives one optional tone');
    await page.evaluate(() => window.updateTableState(window.makeUnoState('seat-me')));
    assert.equal(await page.evaluate(() => window.preferenceAudio.tones), 1, 'Duplicate public turn state does not repeat the tone');
    await page.evaluate(() => window.updateTableState({
      ...window.makeUnoState('seat-other'), currentPlayerId: 'seat-me',
      reactionWindow: { type: 'wild4', targetId: 'seat-other', deadlineAt: Date.now() + 1000 }, availableActions: [],
    }));
    assert.equal(await page.evaluate(() => window.preferenceAudio.tones), 1, 'A reaction for another player does not trigger a tone');

    await page.evaluate(() => window.updateTableState(window.makeUnoState('seat-me')));
    await page.waitForFunction(() => document.querySelector('[data-player-id="seat-me"]')?.classList.contains('table-preferences-current-player'));
    await page.setViewportSize({ width: 844, height: 390 });
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results', 'table-preferences-B06-landscape-844x390.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(root, 'test-results', 'table-preferences-B06-desktop-1280x900.png') });

    await page.reload();
    assert.deepEqual(await page.evaluate(() => window.preferences.getPreferences()), {
      cardSize: 'large', textSize: 'largest', audioEnabled: true, reduceMotion: false,
    }, 'Preferences persist across reload');

    const blockedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await blockedContext.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() { throw new DOMException('Blocked by browser policy', 'SecurityError'); },
      });
    });
    const blockedPage = await blockedContext.newPage();
    blockedPage.on('pageerror', error => pageErrors.push(error.message));
    await blockedPage.goto(`${base}/table-preferences-harness.html`);
    await blockedPage.locator('.table-preferences-details > summary').click();
    await blockedPage.locator('select[name="cardSize"]').selectOption('large');
    await blockedPage.getByText(/Không lưu được bộ nhớ trình duyệt/).waitFor();
    assert.equal(await blockedPage.locator('#table').getAttribute('data-card-size'), 'large', 'Settings still apply when storage is blocked');
    await blockedContext.close();

    const pages = ['index.html', 'uno.html', 'tien-len.html', 'poker.html', 'sam-loc.html', 'phom.html', 'bang.html'];
    for (const filename of pages) {
      const html = fs.readFileSync(path.join(publicRoot, filename), 'utf8');
      assert.match(html, /\/css\/table-preferences\.css/);
      assert.match(html, /\/js\/table-preferences\.js/);
      assert.match(html, /\/css\/storage-status\.css/);
      assert.ok(html.indexOf('/js/storage-status.js') < html.indexOf('/js/storage-warning.js'), `${filename} loads storage status before the warning mount`);
    }
    for (const filename of ['uno.js', 'tien-len.js', 'poker.js', 'sam-loc.js', 'phom.js', 'bang.js']) {
      assert.match(fs.readFileSync(path.join(publicRoot, 'js', filename), 'utf8'), /TablePreferences\?\.updateTablePreferences/);
    }
    assert.match(fs.readFileSync(path.join(publicRoot, 'js', 'app.js'), 'utf8'), /TablePreferences\?\.updateTablePreferences/);
    assert.deepEqual(pageErrors, []);
    await context.close();
    console.log('B06 browser checks passed: keyboard access, 4 viewport sizes, card/text dimensions, reduced motion and forced colors, actor highlighting, audio opt-in/dedup, storage failures, persistence, and page wiring. Screenshots: test-results/table-preferences-B06-{landscape-844x390,desktop-1280x900}.png');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
