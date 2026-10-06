'use strict';

// Common seat, card-motion and result presentation. Only public socket state is read.
(function tableFlow() {
  const game = document.querySelector('.thrill-table-view'); if (!game) return;
  const players = document.getElementById('players'), result = document.getElementById('result'), tools = game.querySelector('.table-tools');
  let latest = null, previous = null, dismissed = null, pending = null, autoCountdownTimer = null;
  const locked = new Map(), reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const node = (tag, className, text) => { const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const playerDialog = node('dialog', 'seat-info-dialog'); playerDialog.setAttribute('aria-label', 'Thông tin người chơi'); document.body.append(playerDialog);
  let inspectedId = null;
  function inspect(id, open = true) {
    const player = latest?.players.find(item => item.id === id); if (!player) { if (playerDialog.open) playerDialog.close(); return; }
    inspectedId = id;
    const restoreFocus = playerDialog.open && playerDialog.contains(document.activeElement);
    const close = node('button', 'seat-info-close', 'Đóng'); close.type = 'button'; close.addEventListener('click', () => playerDialog.close());
    const details = [player.connected ? 'Đang kết nối' : 'Mất kết nối', player.isHost ? 'Chủ bàn' : 'Người chơi'];
    if (player.handCount !== undefined) details.push(`${player.handCount} lá trên tay`);
    if (player.stack !== undefined) details.push(`Stack: ${GameValues.formatAmount(player.stack)} chip`);
    if (player.winStreak && player.winStreak >= 3) details.push(`🔥 Chuỗi thắng: ${player.winStreak} ván`);
    if (player.leaveAfterHand) details.push('Rời sau ván này');
    playerDialog.replaceChildren(node('span', 'seat-info-avatar', player.avatar), node('h2', '', player.name), ...details.map(text => node('p', '', text)), close);
    if (restoreFocus) close.focus({ preventScroll: true });
    if (open && !playerDialog.open) playerDialog.showModal();
  }
  playerDialog.addEventListener('click', event => { if (event.target === playerDialog) { const r = playerDialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) playerDialog.close(); } });
  const resultButton = node('button', 'table-show-result', 'Kết quả'); resultButton.type = 'button'; resultButton.hidden = true; tools.append(resultButton);
  resultButton.addEventListener('click', () => { dismissed = null; result.hidden = false; result.querySelector('.primary')?.focus(); });
  const drafts = document.getElementById('drafts');
  let draftOpen = false, draftButton = null;
  if (drafts) {
    drafts.classList.add('table-draft-panel');
    draftButton = node('button', 'table-show-drafts', 'Nháp'); draftButton.type = 'button'; draftButton.hidden = true;
    draftButton.setAttribute('aria-label', 'Bài hạ và gửi đang soạn'); draftButton.setAttribute('aria-expanded', 'false'); tools.append(draftButton);
    draftButton.addEventListener('click', () => { draftOpen = drafts.hidden; drafts.hidden = !draftOpen; });
    new MutationObserver(() => { draftOpen = !drafts.hidden; draftButton.setAttribute('aria-expanded', String(draftOpen)); }).observe(drafts, { attributes: true, attributeFilter: ['hidden'] });
  }
  function decorateSeats(state) {
    const ordered = [state.myId, ...state.players.filter(item => item.id !== state.myId).map(item => item.id)];
    [...players.children].forEach((seat, index) => {
      const player = state.players[index]; if (!player) return;
      const oldMeta = seat.querySelector('.player-meta')?.textContent || '';
      seat.dataset.playerId = player.id; seat.dataset.seat = ordered.indexOf(player.id); seat.dataset.connected = String(player.connected);
      const avatar = node('button', 'seat-avatar'); avatar.type = 'button'; avatar.setAttribute('aria-label', `Thông tin ${player.name}`);
      avatar.append(node('span', 'seat-avatar-face', player.avatar), node('span', 'seat-time')); avatar.addEventListener('click', () => inspect(player.id));
      const content = node('div', 'seat-caption'), name = node('span', 'player-name', player.name);
      name.title = player.name;

      if (player.winStreak && player.winStreak >= 3) {
        const streakEl = node('span', 'seat-streak');
        streakEl.title = `Chuỗi thắng ${player.winStreak} ván`;
        streakEl.innerHTML = `<span class="streak-flame">🔥</span><b>${player.winStreak}</b>`;
        name.append(streakEl);
      }

      const meta = node('span', 'player-meta', state.gameId === 'poker' ? oldMeta.replace(/^[●○][^·]+·\s*/, '') : player.connected ? (player.id === state.myId ? 'Bạn' : player.isHost ? 'Chủ bàn' : 'Đang chơi') : 'Mất kết nối');
      const flags = [];
      if (state.passedIds?.includes(player.id)) flags.push('Bỏ lượt');
      if (player.handCount === 1 && state.phase !== 'RESULT') flags.push('Còn 1 lá');
      if (state.samDeclarer?.id === player.id && state.phase !== 'RESULT') flags.push('Báo Sâm');
      if (player.laid) flags.push('Đã hạ');
      if (player.leaveAfterHand && state.gameId !== 'poker') flags.push('Rời sau ván');

      const bal = player.balance ?? player.stack ?? (player.id === state.myId ? state.wallet?.available : undefined);
      const balEl = node('span', 'player-balance');
      if (bal !== undefined && bal !== null) {
        balEl.innerHTML = `<span class="balance-icon">💰</span><b class="balance-val">${GameValues.formatCompact(bal)}</b>`;
      }
      content.append(name, meta, balEl, node('span', 'seat-status', flags.join(' · ')));
      seat.replaceChildren(avatar, content);

      if (player.handCount !== undefined && state.phase !== 'RESULT') {
        const count = node('span', 'seat-card-count'); count.setAttribute('aria-label', `${player.handCount} lá trên tay`);
        const back = node('img', ''); back.src = '/assets/game/cards/back.webp'; back.alt = ''; count.append(back, node('b', '', player.handCount)); seat.append(count);
      }

      if (state.phase === 'RESULT') {
        if (player.id !== state.myId) {
          const revealed = player.revealedHand || (state.result?.showdown?.find(s => s.playerId === player.id)?.cards);
          if (Array.isArray(revealed) && revealed.length > 0) {
            const revContainer = node('div', 'seat-revealed-cards');
            revContainer.setAttribute('aria-label', `Bài của ${player.name}`);
            revealed.forEach(card => {
              const cardEl = node('span', 'seat-mini-card has-card-art');
              GameArt.paintCard(cardEl, card);
              revContainer.append(cardEl);
            });
            seat.append(revContainer);
          }
        }

        if (state.result?.outcomes) {
          const outcome = state.result.outcomes.find(o => o.playerId === player.id);
          const isWinner = state.gameId === 'poker' ? (outcome?.payout > 0) : (player.id === state.result.winnerId);
          let bannerText = '';
          const reason = (state.result.reason || '').toLowerCase();
          if (isWinner) {
            if (reason.includes('chặn sâm')) bannerText = 'CHẶN SÂM';
            else if (reason.includes('tới trắng')) bannerText = 'TỚI TRẮNG';
            else if (reason.includes('ù')) bannerText = 'Ù';
            else if (reason.includes('đôi')) bannerText = '5 ĐÔI';
            else bannerText = '👑 THẮNG';
          } else if (outcome && outcome.delta < 0) {
            if (reason.includes('cóng')) bannerText = 'CÓNG';
            else if (reason.includes('móm')) bannerText = 'MÓM';
            else if (reason.includes('đền')) bannerText = 'ĐỀN';
            else bannerText = 'THUA';
          }
          if (bannerText) {
            seat.append(node('div', `seat-outcome-banner ${isWinner ? 'winner' : 'loser'}`, bannerText));
          }

          if (outcome && typeof outcome.delta === 'number' && outcome.delta !== 0) {
            const sign = outcome.delta > 0 ? '+' : '';
            const deltaClass = outcome.delta > 0 ? 'positive' : 'negative';
            seat.append(node('div', `seat-floating-delta ${deltaClass}`, `${sign}${GameValues.formatAmount(outcome.delta)}`));
          }
        }
      }
    });
    if (playerDialog.open) inspect(inspectedId, false);
  }
  function decorateResult(state) {
    resultButton.hidden = state.phase !== 'RESULT' || !state.result;
    if (!state.result || state.phase !== 'RESULT') {
      dismissed = null;
      if (autoCountdownTimer) { clearInterval(autoCountdownTimer); autoCountdownTimer = null; }
      return;
    }
    result.hidden = dismissed === `${state.roomCode}:${state.matchId}`;
    const heading = result.querySelector('h2'); if (heading) { heading.id = 'result-heading'; result.setAttribute('aria-labelledby', heading.id); }
    result.setAttribute('role', 'dialog'); result.setAttribute('aria-modal', 'false');

    result.querySelector('.result-auto-countdown')?.remove();

    const host = state.players.find(item => item.isHost);
    const canContinue = state.players.length >= 2 && state.players.every(item => item.connected);
    const isMeHost = host?.id === state.myId;

    const autoHud = node('div', 'result-auto-countdown');
    autoHud.innerHTML = `
      <div class="countdown-radial">
        <svg viewBox="0 0 36 36" class="countdown-svg">
          <path class="countdown-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
          <path class="countdown-meter" stroke-dasharray="100, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
        </svg>
        <span class="countdown-sec">5</span>
      </div>
      <div class="countdown-text">
        <strong class="countdown-title">Ván tiếp theo tự động</strong>
        <span class="countdown-hint">Đếm ngược: <b class="countdown-num">5s</b></span>
      </div>
    `;

    const details = node('details', 'result-details'), summary = node('summary', '', 'Chi tiết ván'); details.append(summary);
    const potSummary = state.gameId === 'poker' ? result.querySelector('p') : null;
    [...result.children].filter(el => el !== potSummary && !el.classList?.contains('result-auto-countdown') && ['P', 'UL'].includes(el.tagName)).forEach(el => details.append(el));

    const outcomes = node('div', 'result-outcomes');
    (state.result.outcomes || []).forEach(outcome => {
      const player = state.players.find(item => item.id === outcome.playerId), row = node('article', `result-player${outcome.playerId === state.myId ? ' me' : ''}`);
      const won = state.gameId === 'poker' ? outcome.payout > 0 : outcome.playerId === state.result.winnerId;
      row.dataset.winner = String(won);
      const caption = node('div', 'result-player-name'); caption.append(node('strong', '', player?.name || outcome.name), node('span', '', won ? state.gameId === 'poker' ? 'Nhận pot' : 'Thắng ván' : ''));
      const delta = node('b', 'result-delta', `${outcome.delta >= 0 ? '+' : ''}${GameValues.formatAmount(outcome.delta)} ${state.currency || 'chip'}`); delta.dataset.positive = String(outcome.delta >= 0);
      row.append(node('span', 'result-avatar', player?.avatar || '🎲'), caption, delta); outcomes.append(row);
    });

    details.append(outcomes);

    if (heading) heading.after(autoHud); else result.prepend(autoHud);
    autoHud.after(details);

    const close = node('button', 'result-close', '×'); close.type = 'button'; close.setAttribute('aria-label', 'Đóng kết quả');
    close.addEventListener('click', () => {
      dismissed = `${state.roomCode}:${state.matchId}`;
      result.hidden = true;
      if (autoCountdownTimer) { clearInterval(autoCountdownTimer); autoCountdownTimer = null; }
      resultButton.focus();
    });
    result.prepend(close);

    if (state.gameId !== 'poker') {
      const hint = node('p', 'result-next-hint', !canContinue ? 'Chờ đủ người kết nối để chia ván tiếp.' : host?.id === state.myId ? 'Chia bài ngay hoặc chờ tự động.' : `Chờ ${host?.name || 'chủ bàn'} chia ván tiếp.`);
      const nextButton = result.querySelector('button.primary'); if (nextButton) nextButton.disabled = !canContinue;
      result.append(hint);
    }

    if (!autoCountdownTimer) {
      let secondsLeft = 5;
      autoCountdownTimer = setInterval(() => {
        secondsLeft--;
        if (secondsLeft <= 0) {
          clearInterval(autoCountdownTimer);
          autoCountdownTimer = null;
          if (isMeHost && canContinue) {
            const nextBtn = result.querySelector('button.primary');
            if (nextBtn && !nextBtn.disabled) nextBtn.click();
          }
          return;
        }
        const secEl = result.querySelector('.countdown-sec');
        if (secEl) secEl.textContent = String(secondsLeft);
        const numEl = result.querySelector('.countdown-num');
        if (numEl) numEl.textContent = `${secondsLeft}s`;
        const meter = result.querySelector('.countdown-meter');
        if (meter) meter.setAttribute('stroke-dasharray', `${(secondsLeft / 5) * 100}, 100`);
      }, 1000);
    }
  }
  let lastAnimatedMatchId = null;
  let lastStreet = null;

  function playDealAudio(count = 5) {
    if (reducedMotion.matches) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!window._dealAudioCtx) window._dealAudioCtx = new AudioCtx();
      const ctx = window._dealAudioCtx;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      const total = Math.min(count, 13);
      for (let i = 0; i < total; i++) {
        const t = now + (i * 0.065);
        const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.04), ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let j = 0; j < data.length; j++) data[j] = (Math.random() * 2 - 1) * Math.exp(-j / (data.length * 0.22));
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1800 + i * 50;
        filter.Q.value = 3.0;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
        src.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);
        src.start(t);
        src.stop(t + 0.04);
      }
    } catch {}
  }

  function launchDealFlight(stage) {
    if (!stage || reducedMotion.matches) return;
    const existing = stage.querySelector('.table-dealing-layer');
    if (existing) existing.remove();

    const layer = document.createElement('div');
    layer.className = 'table-dealing-layer';
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:80;overflow:hidden;';
    stage.appendChild(layer);

    const stageRect = stage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) { layer.remove(); return; }

    const startX = stageRect.width / 2 - 16;
    const startY = stageRect.height / 2 - 24;

    const targets = [...stage.querySelectorAll('#players > .player')];
    targets.forEach((seat, idx) => {
      const sRect = seat.getBoundingClientRect();
      const targetX = sRect.left - stageRect.left + sRect.width / 2 - 16;
      const targetY = sRect.top - stageRect.top + sRect.height / 2 - 24;

      const ghost = document.createElement('div');
      ghost.className = 'flying-deal-card';
      ghost.style.cssText = `position:absolute;width:32px;height:46px;left:${startX}px;top:${startY}px;border-radius:4px;box-shadow:0 8px 18px rgba(0,0,0,0.7);background:url(/assets/game/cards/back.webp) center/cover no-repeat;`;
      layer.appendChild(ghost);

      ghost.animate([
        { transform: 'translate(0, 0) scale(0.65) rotate(0deg)', opacity: 0.95 },
        { transform: `translate(${targetX - startX}px, ${targetY - startY}px) scale(0.9) rotate(${(idx % 2 === 0 ? 1 : -1) * 14}deg)`, opacity: 0.4 }
      ], {
        duration: 420,
        delay: idx * 90,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
      }).onfinish = () => {
        ghost.remove();
        const avatar = seat.querySelector('.seat-avatar');
        if (avatar) avatar.animate([
          { transform: 'scale(1)' },
          { transform: 'scale(1.15)' },
          { transform: 'scale(1)' }
        ], { duration: 200, easing: 'ease-out' });
      };
    });

    setTimeout(() => layer.remove(), 700);
  }

  function animateChanges(state) {
    if (reducedMotion.matches || state.paused) return;

    const isNewMatch = Boolean(state.matchId && state.matchId !== lastAnimatedMatchId && state.phase !== 'WAITING' && state.phase !== 'RESULT');
    if (isNewMatch) {
      lastAnimatedMatchId = state.matchId;
      const stage = game.querySelector('.table-stage');
      launchDealFlight(stage);

      const handCards = document.querySelectorAll('#hand > button, #hole-cards > span');
      handCards.forEach((card, index) => {
        card.animate([
          { opacity: 0, transform: 'translateY(-30px) scale(0.85) rotate(-3deg)' },
          { opacity: 1, transform: 'none' }
        ], {
          duration: 380,
          delay: Math.min(index * 36, 420),
          easing: 'cubic-bezier(0.18, 0.89, 0.32, 1.15)'
        });
      });

      playDealAudio(handCards.length || 5);
      return;
    }

    if (state.gameId === 'poker') {
      if (state.street === 'PREFLOP') lastStreet = 'PREFLOP';
      else if (state.street && state.street !== lastStreet && ['FLOP', 'TURN', 'RIVER'].includes(state.street)) {
        lastStreet = state.street;
        const communityCards = [...document.querySelectorAll('#community .has-card-art:not(.card-back)')];
        const startIndex = state.street === 'FLOP' ? 0 : state.street === 'TURN' ? 3 : 4;
        communityCards.slice(startIndex).forEach((card, i) => {
          card.animate([
            { opacity: 0, transform: 'scale(0.8) rotateY(90deg)' },
            { opacity: 1, transform: 'scale(1) rotateY(0deg)' }
          ], { duration: 240, delay: i * 60, easing: 'ease-out' });
        });
        playDealAudio(state.street === 'FLOP' ? 3 : 1);
      }
    }

    const play = state.topPlay || (state.discardTop ? { playerId: state.discardById, cards: [state.discardTop] } : null);
    const old = previous?.topPlay || (previous?.discardTop ? { playerId: previous.discardById, cards: [previous.discardTop] } : null);
    const key = item => item ? `${item.playerId}:${item.cards.map(card => card.id).join(',')}` : '';
    if (!play || key(play) === key(old)) return;
    const origin = [...players.children].find(el => el.dataset.playerId === play.playerId)?.getBoundingClientRect();
    document.querySelectorAll('#table-cards > .has-card-art').forEach(card => {
      const destination = card.getBoundingClientRect();
      card.animate([{ opacity: .25, transform: `translate(${origin ? origin.x + origin.width / 2 - destination.x - destination.width / 2 : 0}px, ${origin ? origin.y + origin.height / 2 - destination.y - destination.height / 2 : -20}px) scale(.75)` }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'ease-out' });
    });
    playDealAudio(1);
  }
  function lockActions() {
    game.querySelectorAll('#actions button, #actions input, #actions select, #result button:not(.result-close), #result input').forEach(control => {
      if (!locked.has(control)) locked.set(control, control.disabled); control.disabled = true;
    });
    game.dataset.actionPending = 'true';
  }
  function unlockActions() {
    pending = null; for (const [control, disabled] of locked) if (control.isConnected) control.disabled = disabled;
    locked.clear(); delete game.dataset.actionPending;
  }
  // Ignore rapid duplicate submissions while the first action awaits authoritative state.
  const emit = socket.emit.bind(socket);
  socket.emit = function (event, ...args) {
    if (event === 'game_action') {
      if (pending || !socket.connected) return socket;
      pending = { roomCode: args[0]?.roomCode, revision: args[0]?.expectedRevision, matchId: latest?.matchId }; lockActions();
    }
    return emit(event, ...args);
  };
  socket.on('game_state', state => {
    if (!['tien-len', 'sam-loc', 'phom', 'poker'].includes(state.gameId)) return;
    latest = state;
    game.dataset.phase = state.phase;
    if (pending && (state.roomCode !== pending.roomCode || state.matchId !== pending.matchId || state.revision > pending.revision)) unlockActions();
    if (!game.hidden) { decorateSeats(state); decorateResult(state); animateChanges(state); }
    if (drafts) {
      const drafting = state.phase === 'LAYDOWN' && state.myId === state.currentPlayerId;
      draftButton.hidden = !drafting;
      if (!drafting || previous?.matchId !== state.matchId) draftOpen = false;
      drafts.hidden = !drafting || !draftOpen;
    }
    if (pending) lockActions(); previous = state;
  });
  socket.on('game_error', unlockActions); socket.on('room_left', () => { if (autoCountdownTimer) { clearInterval(autoCountdownTimer); autoCountdownTimer = null; } unlockActions(); latest = null; previous = null; dismissed = null; lastAnimatedMatchId = null; lastStreet = null; playerDialog.close(); });
  socket.on('disconnect', () => { if (autoCountdownTimer) { clearInterval(autoCountdownTimer); autoCountdownTimer = null; } unlockActions(); if (playerDialog.open) playerDialog.close(); });
  new MutationObserver(() => { if (pending) lockActions(); }).observe(document.getElementById('actions'), { childList: true, subtree: true });
  new MutationObserver(() => {
    if (!game.hidden && latest) {
      decorateSeats(latest);
      decorateResult(latest);
      animateChanges(latest);
    }
  }).observe(game, { attributes: true, attributeFilter: ['hidden'] });
})();
