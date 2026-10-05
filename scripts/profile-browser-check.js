'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');

async function main() {
  const game = createGameServer();
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.GANG_BROWSER_CHANNEL || 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(8000);
    await page.goto(`http://127.0.0.1:${game.server.address().port}/profile`);
    await page.waitForFunction(() => socket.connected);
    await page.locator('#new-name').fill('Kiểm thử hồ sơ');
    await page.locator('#create').click();
    await page.locator('#profile').waitFor();
    await page.waitForFunction(() => !document.querySelector('#profile').hidden);
    assert.equal(await page.locator('#available').innerText(), '1.000');
    assert.match(await page.locator('#profile-id').innerText(), /^[0-9a-f-]{36}$/i);
    assert.match(await page.locator('#recovery-code').innerText(), /^[A-F0-9-]+$/);
    await page.locator('#edit-name').fill('Kiểm thử đổi tên');
    await page.locator('#save-profile').click();
    await page.waitForFunction(() => document.querySelector('#display-name').textContent === 'Kiểm thử đổi tên');
    assert.equal(await page.locator('#available').innerText(), '1.000');
    console.log('Profile browser check passed.');
  } finally { if (browser) await browser.close(); await game.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
