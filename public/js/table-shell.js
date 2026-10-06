'use strict';

// Shared presentation for the standalone tables; all decisions remain in their engines.
(function tableShell() {
  const game = document.getElementById('game-view');
  if (!game) return;
  const thrill = ['poker', 'tien-len', 'sam-loc', 'phom'].includes(location.pathname.replace(/\.html$/, '').split('/')[1]);
  const shell = game.closest('main').parentElement;
  const gate = document.createElement('div');
  gate.className = 'table-rotation-gate'; gate.hidden = true; gate.tabIndex = -1;
  gate.setAttribute('role', 'dialog'); gate.setAttribute('aria-modal', 'true');
  gate.setAttribute('aria-label', 'Xoay điện thoại để chơi');
  gate.innerHTML = '<div><span class="rotation-symbol">↻</span><h2>Xoay điện thoại nằm ngang</h2><p>Bàn chơi và các lá bài sẽ hiển thị đầy đủ hơn.</p><button type="button">Toàn màn hình</button><p class="rotation-note"></p></div>';
  document.body.append(gate);
  async function fullscreen() {
    try {
      if (!document.fullscreenElement) await MobileUI.fullscreen();
    } catch (error) {
      const message = error.message.includes('Trình duyệt') ? error.message : 'Trình duyệt chưa hỗ trợ. Bạn có thể xoay điện thoại bằng tay.';
      gate.querySelector('.rotation-note').textContent = message;
      if (gate.hidden) { const notice = document.getElementById('notice'); if (notice) notice.textContent = message; }
    }
  }
  gate.querySelector('button').addEventListener('click', fullscreen);
  let focused = null;
  function rotate() {
    const active = !game.hidden;
    if (active && thrill && !document.body.classList.contains('in-table-game')) {
      const notice = document.getElementById('notice'); if (notice) notice.textContent = '';
      if (document.activeElement?.closest('[hidden]')) document.activeElement.blur();
      window.scrollTo(0, 0);
    }
    document.body.classList.toggle('in-table-game', active && thrill);
    const required = active && MobileUI.isPhonePortrait();
    const previous = !gate.hidden;
    gate.hidden = !required; shell.inert = required;
    document.body.classList.toggle('needs-table-landscape', required);
    if (required && !previous) { focused = document.activeElement; gate.focus({ preventScroll: true }); }
    else if (!required && previous && focused?.isConnected) focused.focus({ preventScroll: true });
  }
  const tools = document.createElement('div'); tools.className = 'table-tools';
  tools.innerHTML = '<button type="button" class="table-fullscreen" aria-label="Toàn màn hình">⛶</button><button type="button" class="table-history" aria-expanded="false">Nhật ký</button>';
  game.querySelector('.game-header').append(tools);
  tools.querySelector('.table-fullscreen').addEventListener('click', async () => {
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} } else await fullscreen();
  });
  const log = document.getElementById('log')?.closest('section');
  if (log) {
    log.classList.add('table-history-panel'); log.hidden = true;
    tools.querySelector('.table-history').addEventListener('click', event => { log.hidden = !log.hidden; event.currentTarget.setAttribute('aria-expanded', String(!log.hidden)); });
  }
  if (thrill) {
    game.classList.add('thrill-table-view');
    if (location.pathname.replace(/\.html$/, '').split('/')[1] === 'poker') {
      const heading = game.querySelector('.game-header h1'), pot = document.getElementById('pot');
      const summary = document.createElement('span'); summary.className = 'table-pot-summary';
      summary.append(' · POT ', pot, ' CHIP'); game.querySelector('.game-header .eyebrow').append(summary);
      heading.textContent = 'Poker Texas Hold’em';
    }
    const stage = document.createElement('section'); stage.className = 'table-stage';
    stage.setAttribute('aria-label', 'Bàn chơi');
    const players = document.getElementById('players'), table = game.querySelector('.table');
    table.before(stage); stage.append(players, table);
    const actions = document.getElementById('actions');
    if (actions) {
      actions.classList.remove('card'); actions.setAttribute('aria-label', 'Hành động của bạn');
      const hand = game.querySelector('.hand, .my-cards');
      if (hand) hand.prepend(actions);
      const contextualActions = () => {
        actions.hidden = !actions.querySelector('button, input, select');
        if (!actions.hidden) [...actions.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()).forEach(node => node.remove());
      };
      new MutationObserver(contextualActions).observe(actions, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
      contextualActions();
    }
    const melds = document.getElementById('public-melds');
    if (melds) {
      melds.classList.add('table-meld-panel'); melds.hidden = true;
      const button = document.createElement('button'); button.textContent = 'Phỏm'; button.setAttribute('aria-expanded', 'false');
      button.addEventListener('click', () => { melds.hidden = !melds.hidden; button.setAttribute('aria-expanded', String(!melds.hidden)); }); tools.append(button);
    }
    const wallet = document.createElement('span'); wallet.className = 'table-wallet';
    game.querySelector('.game-header > div').append(wallet);
    socket.on('game_state', next => {
      if (!next.wallet) return;
      const currency = next.currency || 'chip';
      wallet.textContent = `${next.wallet.available.toLocaleString('vi-VN')} ${currency} · giữ ${next.wallet.reserved.toLocaleString('vi-VN')}`;
      game.querySelectorAll('[data-game-currency]').forEach(node => { node.textContent = currency.toUpperCase(); });
      const icon = game.querySelector('.game-header h1 .resource-icon'); if (icon) icon.src = `/assets/game/${currency}.webp`;
    });
    const info = document.createElement('section'); info.className = 'table-info-panel card'; info.hidden = true;
    const infoButton = document.createElement('button'); infoButton.textContent = 'Bàn'; infoButton.setAttribute('aria-label', 'Thông tin bàn và người chơi'); infoButton.setAttribute('aria-expanded', 'false');
    const sort = document.getElementById('sort');
    if (sort) {
      const handTop = game.querySelector('.hand-top');
      sort.title = sort.textContent; sort.setAttribute('aria-label', sort.textContent);
      handTop.append(sort);
      const selection = document.createElement('span'); selection.className = 'hand-selection'; selection.textContent = 'Chạm / vuốt chọn bài'; handTop.append(selection);
    }
    infoButton.addEventListener('click', () => { info.hidden = !info.hidden; infoButton.setAttribute('aria-expanded', String(!info.hidden)); }); tools.append(infoButton); game.append(info);
    function tableInfo() {
      const heading = document.createElement('h2'); heading.textContent = 'Thông tin bàn';
      const description = document.createElement('p'); description.textContent = [...table.querySelectorAll('.small')].map(node => node.textContent).join(' · ');
      const list = [...players.children].map(node => { const item = document.createElement('p'); item.textContent = `${node.querySelector('.player-name')?.textContent || ''} · ${node.querySelector('.player-meta')?.textContent || ''}`; return item; });
      info.replaceChildren(heading, description, ...list);
    }
    new MutationObserver(tableInfo).observe(table, { childList: true, subtree: true, characterData: true });
    const result = document.getElementById('result');
    if (result) { result.classList.add('table-result-panel'); stage.append(result); }
    function seats() {
      const nodes = [...players.children], own = nodes.find(node => node.classList.contains('me'));
      const ordered = own ? [own, ...nodes.filter(node => node !== own)] : nodes;
      ordered.forEach((node, index) => { node.dataset.seat = String(index); });
      stage.dataset.players = String(nodes.length);
      tableInfo();
    }
    new MutationObserver(seats).observe(players, { childList: true }); seats();
  }
  new MutationObserver(rotate).observe(game, { attributes: true, attributeFilter: ['hidden'] });
  addEventListener('resize', rotate); addEventListener('orientationchange', rotate); rotate();
})();
