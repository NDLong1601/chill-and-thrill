'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const projectRoot = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(projectRoot, 'public/js/preflight.js'), 'utf8');
const styles = fs.readFileSync(path.join(projectRoot, 'public/css/preflight.css'), 'utf8');
const installedChromium = [
  process.env.CHROME_PATH,
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
].filter(candidate => candidate && fs.existsSync(candidate))[0];

function payload({ host = true, gameId = 'tien-len', variant = 'standard', mode = 'fixed-hold', storageSafety = true } = {}) {
  return {
    schemaVersion: 1,
    room: { code: 'B01A', gameId, variant, phase: 'WAITING', revision: 12, requiresWagerSafety: mode !== 'none' },
    seats: [
      { id: 'h', name: 'Host', ready: true, connected: true, balance: 987654321 },
      { id: 'g', name: 'Khách', ready: false, connected: true, balance: 123456789 },
    ],
    viewer: {
      seatId: host ? 'h' : 'g', isHost: host,
      wallet: mode === 'none' ? null : { currency: gameId === 'poker' ? 'chip' : 'coin', available: 90, reserved: 25 },
      funding: mode === 'fixed-hold'
        ? { mode, amountToHold: 100, shortfall: 10 }
        : mode === 'poker-buy-in'
          ? { mode, amountToHold: null, shortfall: 110, stack: 0, minToStart: 10, minBuyIn: 200, maxBuyIn: 1000, minimumAdditionalBuyIn: 200 }
          : { mode },
    },
    evaluation: { allowed: false, blockers: [ { code: 'NOT_READY' }, { code: 'FUNDS_INSUFFICIENT' }, ...(storageSafety === false ? [{ code: 'STORAGE_UNSAFE' }] : []) ] },
    storage: { canStartWager: storageSafety },
    host: { seatFunding: [ { seatId: 'h', status: 'insufficient', available: 90 }, { seatId: 'g', status: 'sufficient', balance: 123456789 } ] },
  };
}

async function checkViewport(browser, width, height, scenario, expected) {
  const page = await browser.newPage({ viewport: { width, height }, isMobile: width <= 520, hasTouch: width <= 520 });
  await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><main id="preflight"></main>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  const outcome = await page.evaluate(input => {
    const root = document.getElementById('preflight');
    window.RoomPreflight.render(root, input);
    return {
      text: root.innerText,
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      revision: root.dataset.revision,
      children: root.children.length,
    };
  }, scenario);
  assert.ok(outcome.text.includes(expected), `Expected UI text "${expected}" at ${width}px.`);
  assert.ok(outcome.scrollWidth <= outcome.width + 1, `Horizontal overflow at ${width}px: ${outcome.scrollWidth} > ${outcome.width}`);
  assert.equal(outcome.revision, '12');
  assert.ok(outcome.children >= 3);
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, ...(installedChromium ? { executablePath: installedChromium } : {}) });
  try {
    await checkViewport(browser, 360, 780, payload(), 'Bạn còn thiếu 10 coin');
    await checkViewport(browser, 390, 844, payload({ storageSafety: false }), 'Máy chủ đang gặp vấn đề lưu trữ');
    await checkViewport(browser, 1280, 900, payload(), 'Khách');
    await checkViewport(browser, 1280, 900, payload({ host: false }), 'Chủ phòng sẽ bắt đầu');
    await checkViewport(browser, 390, 844, payload({ gameId: 'poker', variant: 'holdem-nl-v1', mode: 'poker-buy-in' }), 'Mở hand không giữ thêm chip');
    await checkViewport(browser, 360, 780, payload({ gameId: 'uno', variant: 'classic-108-v1', mode: 'none' }), 'UNO 108 lá');
    await checkViewport(browser, 360, 780, payload({ storageSafety: null }), 'chưa xác nhận tình trạng lưu trữ');
    const page = await browser.newPage({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
    await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><main id="preflight"></main>'); await page.addStyleTag({ content: styles }); await page.addScriptTag({ content: script });
    const privateCheck = await page.evaluate(input => {
      const root = document.getElementById('preflight');
      window.RoomPreflight.render(root, input);
      return { text: root.innerText, model: window.RoomPreflight.buildViewModel(input) };
    }, payload({ host: false }));
    assert.equal(privateCheck.text.includes('123.456.789'), false);
    assert.equal(JSON.stringify(privateCheck.model).includes('balance'), false);
    await page.close();
  } finally {
    await browser.close();
  }
  process.stdout.write('B01 preflight browser checks passed: mobile 360/390 and desktop 1280; fixed hold, Poker buy-in, host privacy, guest privacy and UNO108.\n');
})().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
