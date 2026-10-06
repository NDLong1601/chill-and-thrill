'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { chromium }=require('@playwright/test');
const { io }=require('socket.io-client');
const { createGameServer }=require('../src/httpServer');
const { resolve:resolveHelp }=require('../public/js/context-help');

async function main() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'context-b05-browser-'));
  const game=createGameServer({storageFile:path.join(directory,'rooms.json'),databaseFile:path.join(directory,'profiles.sqlite')});
  await new Promise(resolve=>game.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${game.server.address().port}`;
  const clients=[],errors=[];let browser;
  async function connect() {const client=io(base,{transports:['websocket'],forceNew:true});clients.push(client);await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('connect_error',reject);});return game.io.sockets.sockets.get(client.id);}
  try {
    browser=await chromium.launch({channel:process.env.GANG_BROWSER_CHANNEL || 'chrome',headless:true});
    for(const [gameId,variant,count] of [['the-gang','base-v1',3],['uno','classic-local-v1',2],['uno','classic-108-v1',2],['tien-len','south-v1',2],['poker','holdem-nl-v1',2],['sam-loc','local-v1',2],['phom','local-v1',2],['bang','base-4th-edition-v1',4]]) {
      const host=await connect(),created=game.gm.createRoom(host,'Context host','BASIC','🎲',gameId,{...(gameId==='uno'?{variant}:{})});assert.equal(created.error,undefined);
      for(let index=1;index<count-1;index++){const guest=await connect();assert.equal(game.gm.joinRoom(guest,created.roomCode,`Context guest${index}`,'🎲').error,undefined);}
      const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
      await page.goto(`${base}/rooms/${created.roomCode}`);await page.locator('#portal-player-name').fill('Context learner');await page.locator('#portal-join').click();
      await page.locator('#room-view:not([hidden]),#screen-waiting.active').first().waitFor();
      const manager=game.gm.managerForCode(created.roomCode),room=manager.rooms.get(created.roomCode);assert.equal(room.players.length,count);
      if(gameId==='poker') room.players.forEach((player,index)=>manager.action(game.io.sockets.sockets.get(player.socketId),room.code,{action:'buy_in',amount:200,actionId:`context-buyin-${index}`,expectedRevision:room.revision}));
      room.players.forEach(player=>game.gm.setReady(game.io.sockets.sockets.get(player.socketId),room.code,true));assert.equal(game.gm.startGame(host,room.code)?.error,undefined);
      if(gameId==='the-gang') await page.locator('#btn-table-menu').click();
      if(['poker','tien-len','sam-loc','phom'].includes(gameId)) await page.locator('.native-table-preferences-menu > summary').click();
      const panel=page.locator('[data-context-help]:visible');await panel.waitFor();await panel.locator('summary').click();
      const viewer=room.players.find(player=>player.name==='Context learner');assert.ok(viewer);
      const state=manager.buildStateFor(room,viewer.id),hint=resolveHelp(state);
      assert.equal(await panel.locator('strong').innerText(),hint.title);
      assert.equal(await panel.locator('a').getAttribute('href'),`/tutorial?game=${encodeURIComponent(gameId)}&variant=${encodeURIComponent(variant)}`);
      const visibleText=await panel.innerText();assert.equal(visibleText.includes('profileToken'),false);assert.equal(visibleText.includes('myHand'),false);
      for(const viewport of [{width:320,height:740},{width:390,height:844},{width:844,height:390},{width:1280,height:900}]) {
        await page.setViewportSize(viewport);const rect=await panel.boundingBox();assert.ok(rect.x>=0 && rect.x+rect.width<=viewport.width+1,`${gameId}/${variant} context panel fits ${viewport.width}: ${JSON.stringify(rect)}`);
      }
      if(gameId==='uno' && variant==='classic-local-v1') {
        await page.setViewportSize({width:390,height:844});clients.find(client=>client.id===host.id).disconnect();
        await panel.getByText('Bàn đang tạm dừng',{exact:true}).waitFor();
        fs.mkdirSync(path.join(__dirname,'..','test-results'),{recursive:true});await page.screenshot({path:path.join(__dirname,'..','test-results','context-B05-uno-mobile-20261006.png'),fullPage:true});
      }
      const guidePage=await context.newPage();await guidePage.goto(base+(await panel.locator('a').getAttribute('href')));
      await guidePage.locator('#game-select option').first().waitFor({state:'attached'});
      assert.equal(await guidePage.locator('#game-select option:checked').getAttribute('value'),String(require('../public/js/tutorial-content').listGuides().findIndex(item=>item.gameId===gameId && item.variant===variant)));
      await context.close();console.log(`${gameId}/${variant} context help UI passed.`);
    }
    assert.deepEqual(errors,[]);console.log('B05 all eight live-game context panels, variant deep links and mobile layouts passed.');
  } finally {if(browser)await browser.close();clients.forEach(client=>client.disconnect());await game.close();fs.rmSync(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
