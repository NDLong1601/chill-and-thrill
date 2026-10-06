'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('@playwright/test');
const { createGameServer } = require('../src/httpServer');
const { TUTORIAL_VERSION } = require('../src/platform/tutorialService');

async function main() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tutorial-b05-browser-'));
  const game=createGameServer({storageFile:path.join(directory,'rooms.json'),databaseFile:path.join(directory,'profiles.sqlite')});
  await new Promise(resolve=>game.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${game.server.address().port}`,store=game.gm.profiles,owner=store.createProfile({displayName:'Tutorial browser'});
  const errors=[]; let browser;
  try {
    browser=await chromium.launch({channel:process.env.GANG_BROWSER_CHANNEL || 'chrome',headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844}});
    await context.addInitScript(token=>{
      if(!/^https?:$/.test(location.protocol)) return;
      localStorage.setItem('chill-thrill:profile-token',token);
      Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});
    },owner.sessionToken);
    const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${base}/profile`);
    await page.locator('a[href="/tutorial"]').first().click();
    await page.locator('#game-select option').first().waitFor({state:'attached'});
    assert.equal(await page.locator('#curriculum-version').innerText(),TUTORIAL_VERSION);
    for(const label of ['UNO 112 · classic-local-v1','UNO 108 · classic-108-v1']) {
      await page.locator('#game-select').selectOption({label});
      const href=await page.locator('#rules-link').getAttribute('href');
      assert.equal(href,label.includes('112')?'/docs/rules/uno-classic.md':'/docs/rules/uno.md');
      assert.equal((await fetch(base+href)).status,200);
    }
    await page.route('**/api/tutorial/start',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'Chưa lưu an toàn được hướng dẫn. Vui lòng thử lại.'})}));
    await page.locator('#start-button').click();await page.getByText(/Chưa lưu an toàn/i).waitFor();
    await page.unroute('**/api/tutorial/start');
    await page.locator('#start-button').click();await page.locator('.color-choice').first().waitFor();
    for(const session of game.tutorials.sessions.values()) session.expiresAt=0;
    await page.locator('.color-choice[data-color="red"]').click();await page.locator('#submit-button').click();
    await page.getByText(/Hãy bắt đầu lại/i).waitFor();await page.locator('#start-button').click();
    await page.locator('.color-choice[data-color="red"]').click();await page.locator('#submit-button').click();
    await page.getByText('Bài 2 / 3.').waitFor();await page.locator('input[value="fold"]').check();await page.locator('#submit-button').click();
    await page.getByText(/chưa hoàn thành mục tiêu/i).waitFor();await page.locator('input[value="check"]').check();await page.locator('#submit-button').click();
    await page.getByText('Bài 3 / 3.').waitFor();assert.match(await page.locator('.choice-list').innerText(),/3♥/);
    await page.locator('input[value="lesson-7S"]').check();await page.locator('#submit-button').click();await page.getByText(/Nhóm chưa hợp lệ/i).waitFor();
    for(const viewport of [{width:320,height:740},{width:390,height:844},{width:844,height:390},{width:1280,height:900}]) {
      await page.setViewportSize(viewport);const geometry=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
      assert.ok(geometry.scroll<=geometry.width,`No overflow at ${viewport.width}x${viewport.height}: ${JSON.stringify(geometry)}`);
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('input[value="lesson-7S"]').uncheck();for(const id of ['lesson-3H','lesson-3D','lesson-3C']) await page.locator(`input[value="${id}"]`).check();
    await page.locator('#submit-button').click();await page.getByText(/Đã hoàn thành chương trình hướng dẫn/i).waitFor();
    assert.equal(store.hasTutorialVerification(owner.profile.id,TUTORIAL_VERSION),true);
    await page.reload();await page.getByText(/Thưởng đang chờ nhận/i).waitFor();
    assert.equal(await page.locator('#start-button').isVisible(),false);
    await page.locator('#claim-button').click();await page.getByText(/Đã nhận 200 coin/i).waitFor();
    assert.equal(store.publicProfile(owner.profile.id).balances.coin.available,1200);
    const retry=await fetch(`${base}/api/tutorial/claim`,{method:'POST',headers:{'Content-Type':'application/json','X-Profile-Token':owner.sessionToken},body:JSON.stringify({version:TUTORIAL_VERSION})});
    assert.equal((await retry.json()).alreadyClaimed,true);
    await page.reload();await page.getByText(/đã hoàn thành hướng dẫn và nhận thưởng/i).waitFor();assert.equal(await page.locator('#claim-button').isVisible(),false);
    fs.mkdirSync(path.join(__dirname,'..','test-results'),{recursive:true});await page.screenshot({path:path.join(__dirname,'..','test-results','tutorial-B05-mobile-20261006.png'),fullPage:true});
    assert.equal(store.listLedger(owner.profile.id).filter(row=>row.source==='mission').length,1);
    await page.goto(`${base}/profile`);await page.locator('#profile').waitFor({state:'visible'});assert.match(await page.locator('#missions').innerText(),/Đã nhận/);
    await context.addInitScript(()=>{if(/^https?:$/.test(location.protocol)) localStorage.clear();});await page.goto(`${base}/tutorial`);await page.getByText(/Hãy khôi phục\/tạo hồ sơ/i).waitFor();
    await page.locator('#start-button').click();await page.getByText(/Cần hồ sơ đã xác thực/i).waitFor();
    assert.deepEqual(errors,[]);
    console.log('B05 real SQLite/API/browser passed: auth, rules links, error retry, expiry restart, three validated steps, one-time reward, reload, HTTP UUID fallback, mobile layouts.');
  } finally {if(browser) await browser.close();await game.close();fs.rmSync(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
