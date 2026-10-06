(function () {
  'use strict';
  if(typeof socket==='undefined' || !window.ChillContextHelp) return;
  const panels=new Map();
  function panelFor(state) {
    const id=document.getElementById('game-view')?'game-view':state.gameId==='uno'?'screen-uno':'screen-game';
    const parent=document.getElementById(id); if(!parent) return null;
    if(panels.has(id)) return panels.get(id);
    const details=document.createElement('details');details.className='context-help';details.dataset.contextHelp='';
    const summary=document.createElement('summary');summary.textContent='Gợi ý cho tình huống này';
    const body=document.createElement('div');body.className='context-help-body';body.setAttribute('role','status');body.setAttribute('aria-live','polite');
    const link=document.createElement('a');link.href='/tutorial';link.target='_blank';link.rel='noopener';link.textContent='Xem hướng dẫn và bài luyện';
    details.append(summary,body,link);
    const header=parent.querySelector('.game-header,.uno-topbar,.table-topbar');
    const gangMenu=id==='screen-game'&&parent.querySelector('#table-tools-menu');
    const nativeMenu=parent.querySelector('.native-table-preferences-menu .table-preferences-panel');
    if(gangMenu) gangMenu.append(details);
    else if(nativeMenu) nativeMenu.append(details);
    else if(header) header.insertAdjacentElement('afterend',details);else parent.append(details);
    panels.set(id,{details,body,summary,link});return panels.get(id);
  }
  socket.on('game_state',state=>{
    if(!state?.myId || ['WAITING','LOBBY'].includes(state.phase)) return;
    const panel=panelFor(state);if(!panel) return;
    panel.details.hidden=false;const hint=window.ChillContextHelp.render(panel.body,state);
    panel.summary.textContent=`Gợi ý · ${hint.title}`;
    panel.link.href=`/tutorial?game=${encodeURIComponent(state.gameId)}&variant=${encodeURIComponent(hint.variant || '')}`;
  });
  socket.on('room_left',()=>{for(const panel of panels.values())panel.details.hidden=true;});
  socket.on('disconnect',()=>{for(const panel of panels.values()){panel.summary.textContent='Gợi ý · Đang nối lại';panel.body.textContent='Chờ kết nối và trạng thái mới của máy chủ trước khi thao tác.';}});
}());
