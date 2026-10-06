'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('../public/js/context-help');
const { listGuides } = require('../public/js/tutorial-content');
const { MultiGameManager } = require('../src/platform/multiGameManager');
const { createMatch, visibleState } = require('../src/games/uno/engine');

test('published guide catalog covers all requested games and keeps both UNO variants explicit', () => {
  const guides = listGuides();
  assert.deepEqual(guides.map(item => item.gameId), ['the-gang','uno','uno','tien-len','poker','sam-loc','phom','bang']);
  assert.equal(guides.find(item => item.gameId === 'uno' && item.variant === 'classic-local-v1').title, 'UNO 112 · classic-local-v1');
  assert.equal(guides.find(item => item.gameId === 'uno' && item.variant === 'classic-108-v1').title, 'UNO 108 · classic-108-v1');
  assert.equal(guides.every(item => item.steps.length >= 3 && item.rules.length > 12), true);
});

test('context helper selects next action by actual phase and exact UNO variant', () => {
  const uno112 = resolve({ gameId:'uno', variant:'classic-local-v1', myId:'me', phase:'PLAYING', reactionWindow:{targetId:'me'},availableActions:[{type:'draw_penalty'},{type:'challenge_draw_four'}] });
  assert.deepEqual(uno112.actions, ['draw_penalty','challenge_draw_four']);
  const uno108 = resolve({ gameId:'uno', myId:'me', phase:'WDF_CHALLENGE', pendingWdf:{targetId:'me'} });
  assert.equal(uno108.variant, 'classic-108-v1');
  assert.deepEqual(uno108.actions, ['accept_wdf','challenge_wdf']);
  const callUno = resolve({ gameId:'uno', myId:'me', phase:'UNO_WINDOW', variant:'classic-local-v1', unoWindow:{playerId:'me'} });
  assert.deepEqual(callUno.actions, ['call_uno']);
  const catchUno = resolve({ gameId:'uno', myId:'me', phase:'UNO_WINDOW', pendingUno:{targetId:'other'} });
  assert.deepEqual(catchUno.actions, ['catch_uno']);
});

test('turn, declaration, meld, poker and pending-effect guides name actions consistent with server phases', () => {
  assert.deepEqual(resolve({ gameId:'tien-len',rulesVersion:'south-v1',myId:'me',currentPlayerId:'me',phase:'TURN',topPlay:{playerId:'other'} }).actions, ['play','pass']);
  assert.deepEqual(resolve({ gameId:'sam-loc',rulesVersion:'local-v1',myId:'me',currentPlayerId:'other',phase:'SAM_DECLARATION',samWindow:{myResponse:null} }).actions, ['declare_sam','pass_sam']);
  assert.deepEqual(resolve({ gameId:'phom',rulesVersion:'local-v1',myId:'me',currentPlayerId:'me',phase:'LAYDOWN' }).actions, ['lay_down','declare_u']);
  const poker = resolve({ gameId:'poker',rulesVersion:'holdem-nl-v1',myId:'me',currentPlayerId:'me',phase:'HAND',legalActions:{canCheck:false,canCall:true,canRaise:false,canFold:true,callAmount:15} });
  assert.deepEqual(poker.actions, ['call','fold']);
  const bang = resolve({ gameId:'bang',rulesVersion:'base-4th-edition-v1',myId:'me',currentPlayerId:'other',phase:'MAIN',pending:{waitingId:'me',message:'BANG! cần phản ứng.'} });
  assert.equal(bang.title,'Trả lời hiệu ứng');
});

test('paused or non-current seats receive no action recommendation; renderer never echoes private state', () => {
  assert.deepEqual(resolve({gameId:'poker',rulesVersion:'holdem-nl-v1',myId:'me',currentPlayerId:'me',phase:'HAND',paused:true,legalActions:{canCheck:true}}).actions, []);
  assert.deepEqual(resolve({gameId:'uno',variant:'classic-local-v1',myId:'me',phase:'PLAYING',currentPlayerId:'me',reconnect:{waiting:[{expired:false}]},availableActions:[{type:'draw_card'}]}).actions,[]);
  assert.deepEqual(resolve({gameId:'tien-len',rulesVersion:'south-v1',myId:'me',currentPlayerId:'other',phase:'TURN'}).actions, []);
  const secretState = { gameId:'the-gang',variant:'standard',myId:'me',phase:'PRE_FLOP',currentRoundChipColor:'white',players:[{id:'rival',privateCards:['SECRET_OPPONENT_CARD']}] };
  const guide = resolve(secretState);
  assert.equal(JSON.stringify(guide).includes('SECRET_OPPONENT_CARD'),false);
  assert.equal(JSON.stringify(guide).includes('privateCards'),false);
  assert.equal(resolve({gameId:'poker',phase:'HAND'}).title,'Chưa có trạng thái ghế');
});

test('UNO 112 hints consume the real public reaction, penalty, color and draw-choice contract', () => {
  const now=Date.now(),players=[{id:'me',connected:true},{id:'other',connected:true}],room={code:'HELP',config:{}};
  const match=createMatch({playerIds:['me','other'],rng:()=>0.3,now});
  Object.assign(match,{currentPlayerId:'me',openingColorPending:false,reactionWindow:null,unoWindow:null,pendingDraw:0,pendingTargetId:null,drawChoice:null});
  match.reactionWindow={type:'wild4',targetId:'me',deadlineAt:now+15000};
  let state=visibleState(match,'me',players,room,now);
  assert.deepEqual(resolve(state).actions,['draw_penalty','challenge_draw_four']);
  assert.deepEqual(resolve(visibleState(match,'other',players,room,now)).actions,[]);
  match.reactionWindow=null;match.pendingDraw=2;match.pendingTargetId='me';
  assert.deepEqual(resolve(visibleState(match,'me',players,room,now)).actions,['draw_penalty']);
  match.pendingDraw=0;match.pendingTargetId=null;match.openingColorPending=true;
  assert.deepEqual(resolve(visibleState(match,'me',players,room,now)).actions,['choose_color']);
  match.openingColorPending=false;match.drawChoice=match.hands.me[0].id;
  state=visibleState(match,'me',players,room,now);const hint=resolve(state);
  assert.equal(hint.title,'Lá vừa rút');assert.ok(hint.actions.every(action=>state.availableActions.some(item=>item.type===action)));
});

for(const [gameId,variant,count] of [['the-gang','base-v1',3],['uno','classic-local-v1',2],['uno','classic-108-v1',2],['tien-len','south-v1',2],['poker','holdem-nl-v1',2],['sam-loc','local-v1',2],['phom','local-v1',2],['bang','base-4th-edition-v1',4]]) {
  test(`context help resolves ${gameId}/${variant} from real started-room public state`,t=>{
    const sockets=Array.from({length:count},(_,index)=>({id:`help-${index}`,data:{},handshake:{auth:{}},join(){},leave(){},emit(){}}));
    const io={sockets:{sockets:new Map(sockets.map(socket=>[socket.id,socket]))},to:()=>({emit(){}})};
    const gm=new MultiGameManager(io);t.after(()=>gm.close());
    const created=gm.createRoom(sockets[0],'Host','BASIC','🎲',gameId,{...(gameId==='uno'?{variant}:{})});assert.equal(created.error,undefined);
    for(let index=1;index<count;index++) assert.equal(gm.joinRoom(sockets[index],created.roomCode,`Guest${index}`,'🎲').error,undefined);
    if(gameId==='poker') sockets.forEach((socket,index)=>{const room=gm.poker.rooms.get(created.roomCode);gm.poker.action(socket,room.code,{action:'buy_in',amount:200,actionId:`help-buyin-${index}`,expectedRevision:room.revision});});
    sockets.forEach(socket=>gm.setReady(socket,created.roomCode,true));assert.equal(gm.startGame(sockets[0],created.roomCode)?.error,undefined);
    const manager=gm.managerForCode(created.roomCode),room=manager.rooms.get(created.roomCode);
    for(const player of room.players) {
      const state=manager.buildStateFor(room,player.id);
      const hint=resolve(state);assert.equal(hint.variant,variant,JSON.stringify(state));assert.notEqual(hint.title,'Đợi trạng thái game');
      assert.equal(JSON.stringify(hint).includes('myHand'),false);assert.equal(JSON.stringify(hint).includes('myHoleCards'),false);
      assert.deepEqual(resolve({...state,paused:true}).actions,[]);
    }
  });
}

test('UNO 108 prompts before the penultimate card and does not offer a late declaration',()=>{
  const state={gameId:'uno',myId:'me',currentPlayerId:'me',phase:'TURN',myHand:[{id:'a'},{id:'b'}],pendingUno:null};
  assert.ok(resolve(state).actions.includes('declare_uno'));
  assert.deepEqual(resolve({...state,phase:'UNO_WINDOW',pendingUno:{targetId:'me'}}).actions,[]);
  assert.deepEqual(resolve({...state,phase:'DRAW_PENALTY',pendingDraw:{targetId:'me',count:2}}).actions,['draw_penalty']);
});
