'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../src/platform/profileStore');
const { ProfileService } = require('../src/platform/profileService');
const { TutorialService, TUTORIAL_VERSION } = require('../src/platform/tutorialService');
const { CURRENCIES } = require('../src/platform/currencies');
const { createGameServer } = require('../src/httpServer');

const actions = [{ type:'choose-color', color:'blue' }, { type:'check' }, { melds:[['lesson-3H','lesson-3D','lesson-3C']] }];
function submitRequest(session, profileId, index, overrides = {}) {
  return { profileId, version:session.version, sessionId:session.sessionId, nonce:session.nonce, sequence:session.sequence,
    revision:session.revision, challengeId:session.challenge.id, actionId:`b05-action-${index}-${Math.random()}`, action:actions[index], ...overrides };
}
function advance(session, result) { Object.assign(session, { sequence:result.sequence, revision:result.revision, challenge:result.challenge }); }
function finish(service, profileId) {
  const session = service.start({ profileId });
  for (let index=0; index<3; index++) { const result=service.submit(submitRequest(session,profileId,index)); assert.equal(result.accepted,true,JSON.stringify(result)); advance(session,result); }
}
function faultNextCommit(store) {
  const original = store.db.exec.bind(store.db); let armed=true;
  store.db.exec = statement => { if(statement==='COMMIT' && armed) { armed=false; throw new Error('B05 injected commit fault'); } return original(statement); };
  return () => { delete store.db.exec; };
}

test('B05 real API binds owner, validates ordered actions, and all claim routes share one receipt', async t => {
  const game=createGameServer(); await new Promise(resolve=>game.server.listen(0,'127.0.0.1',resolve)); t.after(()=>game.close());
  const store=game.gm.profiles, owner=store.createProfile(), other=store.createProfile();
  const base=`http://127.0.0.1:${game.server.address().port}`;
  async function post(route,body={},token=owner.sessionToken) {
    const response=await fetch(`${base}${route}`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{'X-Profile-Token':token}:{})},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }
  assert.equal((await post('/api/tutorial/start',{},null)).status,401);
  assert.equal((await post('/api/tutorial/claim')).body.code,'TUTORIAL_NOT_VERIFIED');
  const session=(await post('/api/tutorial/start',{version:TUTORIAL_VERSION,profileId:other.profile.id})).body;
  assert.equal(session.ok,true); assert.equal(session.challenge.variant,'classic-local-v1');
  assert.equal((await post('/api/tutorial/submit',submitRequest(session,owner.profile.id,0),other.sessionToken)).body.code,'SESSION_OWNER');
  assert.equal((await post('/api/tutorial/submit',submitRequest(session,owner.profile.id,0,{nonce:'fake'}))).body.code,'SESSION_NONCE');
  assert.equal((await post('/api/tutorial/submit',submitRequest(session,owner.profile.id,0,{sequence:2}))).body.code,'CHALLENGE_STALE');
  assert.equal((await post('/api/tutorial/submit',submitRequest(session,owner.profile.id,0,{version:'wrong'}))).body.code,'TUTORIAL_VERSION');
  assert.equal((await post('/api/tutorial/submit',submitRequest(session,owner.profile.id,0,{action:{type:'choose-color',color:'purple'}}))).body.accepted,false);
  for(let index=0;index<3;index++) {
    const reply=await post('/api/tutorial/submit',submitRequest(session,other.profile.id,index,{completed:true,verified:true}));
    assert.equal(reply.status,200,JSON.stringify(reply.body)); assert.equal(reply.body.accepted,true); advance(session,reply.body);
  }
  assert.equal(store.hasTutorialVerification(owner.profile.id,TUTORIAL_VERSION),true);
  assert.equal(store.hasTutorialVerification(other.profile.id,TUTORIAL_VERSION),false,'body owner and fake completion cannot change authenticated owner');
  assert.equal((await post('/api/tutorial/claim',{},other.sessionToken)).body.code,'TUTORIAL_NOT_VERIFIED');
  const claim=(await post('/api/tutorial/claim')).body;
  assert.equal(claim.profile.balances.coin.available,1200); assert.equal(claim.alreadyClaimed,false);
  assert.equal((await post('/api/tutorial/claim')).body.alreadyClaimed,true);
  const mission=await post('/api/missions/tutorial_verified/claim',{version:1,periodKey:'2020-01-01'});
  assert.equal(mission.status,200); assert.equal(mission.body.profile.balances.coin.available,1200);
  assert.equal(store.listLedger(owner.profile.id).filter(row=>row.source==='mission').length,1);
  const quote=await (await fetch(`${base}/api/wallet/exchange/quote?direction=coin-to-gem&gems=1`,{headers:{'X-Profile-Token':owner.sessionToken}})).json();
  assert.equal(quote.rewards.openDailyMissionCount,3); assert.equal(quote.rewards.openDailyMissionReward,450);
});

test('B05 verification and unclaimed reward survive restart and remain claimable past daily expiry', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'b05-restart-')), file=path.join(directory,'profiles.sqlite');
  let store=new ProfileStore({databaseFile:file}); t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const owner=store.createProfile(); const service=new TutorialService({store,clock:()=>Date.now()-12*86400000}); finish(service,owner.profile.id);
  store.close(); store=new ProfileStore({databaseFile:file});
  const missions=new ProfileService({profileStore:store}).missionList(owner.profile.id);
  const tutorial=missions.filter(item=>item.id==='tutorial_verified'); assert.equal(tutorial.length,1); assert.equal(tutorial[0].complete,true); assert.equal(tutorial[0].claimed,false);
  const resumed=new TutorialService({store}); assert.equal(resumed.start({profileId:owner.profile.id}).alreadyVerified,true);
  assert.equal(resumed.claim({profileId:owner.profile.id}).ok,true); store.close(); store=new ProfileStore({databaseFile:file});
  assert.equal(store.authenticate(owner.sessionToken).id,owner.profile.id);
  assert.equal(new TutorialService({store}).claim({profileId:owner.profile.id}).alreadyClaimed,true);
  assert.equal(store.publicProfile(owner.profile.id).balances.coin.available,1200);
});

test('B05 SQLite commit faults roll back verification and rewards, then retry safely', t => {
  const store=new ProfileStore(); t.after(()=>store.close()); const profile=store.createProfile().profile;
  const service=new TutorialService({store}), session=service.start({profileId:profile.id});
  for(let index=0;index<2;index++){const result=service.submit(submitRequest(session,profile.id,index));assert.equal(result.accepted,true);advance(session,result);}
  let restore=faultNextCommit(store);
  const denied=service.submit(submitRequest(session,profile.id,2)); restore();
  assert.equal(denied.error.code,'VERIFICATION_COMMIT_FAILED'); assert.equal(store.hasTutorialVerification(profile.id,TUTORIAL_VERSION),false);
  assert.equal(session.sequence,2);
  assert.equal(service.submit(submitRequest(session,profile.id,2)).completed,true);
  restore=faultNextCommit(store); const failed=service.claim({profileId:profile.id}); restore();
  assert.equal(failed.ok,false); assert.equal(store.publicProfile(profile.id).balances.coin.available,1000);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM mission_claims WHERE profile_id=?').get(profile.id).n,0);
  assert.equal(store.listLedger(profile.id).filter(row=>row.source==='mission').length,0);
  assert.equal(service.claim({profileId:profile.id}).ok,true); assert.equal(service.claim({profileId:profile.id}).alreadyClaimed,true);
  assert.equal(store.publicProfile(profile.id).balances.coin.available,1200);
});

test('B05 tutorial does not consume protected payout capacity or trust legacy match progress', t => {
  const store=new ProfileStore(); t.after(()=>store.close()); const owner=store.createProfile().profile, other=store.createProfile().profile;
  store.db.prepare('INSERT INTO mission_progress(profile_id,mission_id,version,period,progress,evidence_json,updated_at) VALUES (?, ?, 1, ?, 3, ?, ?)').run(owner.id,'tutorial_verified','2026-10-06','{}',new Date().toISOString());
  assert.equal(store.getMissions(owner.id).find(item=>item.id==='tutorial_verified').complete,false);
  assert.throws(()=>store.claimMission(owner.id,'tutorial_verified',1),{code:'TUTORIAL_NOT_VERIFIED'});
  const service=new TutorialService({store}); finish(service,owner.id);
  store.executeOperation('fixture','b05-cap-fixture',{},at=>store.writeWallet(owner.id,CURRENCIES.coin.max-1100,0,{currency:'coin',operationKey:'b05-cap-fixture',source:'fixture',note:'Temporary capacity fixture',at}));
  const held=store.reserveMany({currency:'coin',roomCode:'B05CAP',matchId:'b05-live',operationKey:'tien-len:reserve:b05-live',reservations:[owner,other].map(profile=>({profileId:profile.id,amount:100}))}).held;
  assert.equal(service.claim({profileId:owner.id}).error.code,'PAYOUT_CAPACITY');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM mission_claims WHERE profile_id=?').get(owner.id).n,0);
  store.releaseReservations({reservations:held,roomCode:'B05CAP',matchId:'b05-live',operationKey:'tien-len:cancel:b05-live'});
  store.executeOperation('fixture','b05-free-cap-fixture',{},at=>store.writeWallet(owner.id,-100,0,{currency:'coin',operationKey:'b05-free-cap-fixture',source:'fixture',note:'Temporary capacity fixture',at}));
  assert.equal(service.claim({profileId:owner.id}).ok,true); assert.equal(store.publicProfile(owner.id).balances.coin.available,CURRENCIES.coin.max);
});

test('B05 additive schema migration preserves existing profile tokens, held funds and ledger', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'b05-migrate-')),file=path.join(directory,'profiles.sqlite');
  let store=new ProfileStore({databaseFile:file}); t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const owner=store.createProfile(); store.reserveMany({currency:'coin',roomCode:'LEGACY',operationKey:'b05-legacy-hold',reservations:[{profileId:owner.profile.id,amount:100}]});
  const balances=store.publicProfile(owner.profile.id).balances, ledger=store.listLedger(owner.profile.id);
  store.db.exec('DROP TABLE tutorial_verifications; DELETE FROM schema_migrations WHERE version=4;'); store.close(); store=new ProfileStore({databaseFile:file});
  assert.equal(store.authenticate(owner.sessionToken).id,owner.profile.id); assert.deepEqual(store.publicProfile(owner.profile.id).balances,balances); assert.deepEqual(store.listLedger(owner.profile.id),ledger);
  assert.equal(store.hasTutorialVerification(owner.profile.id,TUTORIAL_VERSION),false); assert.equal(store.db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get().n,4);
});
