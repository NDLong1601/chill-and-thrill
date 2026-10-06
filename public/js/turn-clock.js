'use strict';

(function turnClockDisplay() {
  let clock = null, received = 0, remaining = 0, actorId = null;
  const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet'; stylesheet.href = '/css/reconnect-lifecycle.css'; document.head.appendChild(stylesheet);
  const reconnectBanner = document.createElement('aside'); reconnectBanner.id = 'reconnect-lifecycle-banner'; reconnectBanner.className = 'reconnect-lifecycle-banner';
  reconnectBanner.setAttribute('role', 'status'); reconnectBanner.setAttribute('aria-live', 'polite'); reconnectBanner.hidden = true;
  document.body.prepend(reconnectBanner);
  let latestState = null, stateReceived = 0;

  function policyHint(state, actorExpired) {
    if (state.gameId === 'the-gang') return 'Nếu ghế chưa khôi phục sau 120 giây, The Gang trở về sảnh.';
    if (state.gameId === 'poker') return actorExpired ? 'Server sẽ check nếu không phải theo cược hoặc fold nếu cần theo; ghế all-in vẫn giữ phần trong pot.' : 'Sau 120 giây, lượt của ghế vắng sẽ check khi hợp lệ hoặc fold khi cần theo cược; all-in vẫn ở trong pot.';
    if (state.gameId === 'tien-len') return 'Sau 120 giây, server sẽ đánh nước hợp lệ hoặc bỏ lượt khi ghế vắng đến lượt.';
    if (state.gameId === 'sam-loc') return 'Sau 120 giây, server sẽ đánh nước hợp lệ, bỏ lượt hoặc tự xử lý cửa sổ báo Sâm theo deadline.';
    if (state.gameId === 'phom') return 'Sau 120 giây, server sẽ rút, hạ phỏm hoặc đánh lá bỏ hợp lệ khi ghế vắng đến lượt.';
    if (state.gameId === 'bang') return 'Sau 120 giây, server sẽ chọn phản hồi hợp lệ an toàn và kết thúc lượt của ghế vắng.';
    if (state.gameId === 'uno' && state.variant === 'classic-local-v1') return 'Sau 120 giây, server chọn màu mặc định, xử lý lượt hoặc nhận lá phạt. Cửa sổ gọi UNO 5 giây và phản đối +4 15 giây vẫn chạy khi mất kết nối.';
    if (state.gameId === 'uno') return 'Sau 120 giây, server chọn màu mặc định, xử lý lượt hoặc nhận lá phạt. Cửa sổ UNO và +4 tiếp tục theo deadline 12 giây khi mất kết nối.';
    return 'Sau 120 giây, server tiếp tục theo nước đi hợp lệ của game.';
  }

  function renderReconnectStatus() {
    const state = latestState;
    if (!state) { reconnectBanner.hidden = true; return; }
    const waiting = state.reconnect?.waiting || [];
    const now = (state.serverNow || state.serverTime || Date.now()) + Math.max(0, performance.now() - stateReceived);
    const missing = waiting.filter(item => Number.isFinite(item.deadlineAt) ? item.deadlineAt > now : !item.expired);
    const expired = waiting.filter(item => Number.isFinite(item.deadlineAt) ? item.deadlineAt <= now : !!item.expired);
    const self = (state.players || []).find(item => item.id === state.myId);
    const queued = !!self?.leaveAfterHand;
    if (!waiting.length && !queued) { reconnectBanner.hidden = true; reconnectBanner.replaceChildren(); return; }
    const nextDeadline = Math.min(...missing.map(item => item.deadlineAt).filter(Number.isFinite));
    const seconds = Number.isFinite(nextDeadline) ? Math.max(0, Math.ceil((nextDeadline - now) / 1000)) : 0;
    const actor = state.pending?.waitingId || state.turnClock?.playerId || state.currentPlayerId;
    const actorExpired = expired.some(item => item.playerId === actor);
    const lines = [];
    if (missing.length) {
      lines.push(`Đang chờ ${missing.map(item => item.name).join(', ')} kết nối lại · còn ${seconds} giây.`);
      lines.push(policyHint(state, false));
    }
    if (expired.length) lines.push(`${expired.map(item => item.name).join(', ')} đã hết thời gian khôi phục. ${policyHint(state, actorExpired)}`);
    if (waiting.length && state.gameId === 'uno') lines.push(state.variant === 'classic-local-v1'
      ? 'Các cửa sổ phản ứng 5/15 giây vẫn tiếp tục theo giờ server.'
      : 'Các cửa sổ phản ứng 12 giây vẫn tiếp tục theo giờ server.');
    if (queued) lines.push('Bạn sẽ rời phòng khi ván hiện tại kết thúc.');
    reconnectBanner.replaceChildren();
    lines.forEach((line, index) => { const p = document.createElement(index ? 'p' : 'strong'); p.textContent = line; reconnectBanner.appendChild(p); });
    reconnectBanner.hidden = false;
  }

  setInterval(renderReconnectStatus, 250);
  const timer = document.createElement('span'); timer.className = 'turn-countdown'; timer.hidden = true;
  timer.setAttribute('role', 'timer'); timer.setAttribute('aria-label', 'Thời gian còn lại của lượt');
  function paint() {
    if (!clock) {
      timer.hidden = true;
      document.querySelectorAll('#players .seat-avatar').forEach(avatar => { avatar.style.removeProperty('--turn-progress'); avatar.querySelector('.seat-time').textContent = ''; });
      return;
    }
    const ms = clock.deadlineAt === null ? remaining : Math.max(0, remaining - (performance.now() - received));
    const seconds = Math.ceil(ms / 1000);
    timer.textContent = `${seconds}s`; timer.dataset.urgent = String(seconds <= 5);
    timer.title = clock.deadlineAt === null ? 'Đồng hồ tạm dừng khi mất kết nối' : 'Mỗi lượt 30 giây';
    timer.hidden = false;
    document.querySelectorAll('#players [data-player-id]').forEach(seat => {
      const avatar = seat.querySelector('.seat-avatar'); if (!avatar) return;
      const active = seat.dataset.playerId === actorId;
      avatar.style.setProperty('--turn-progress', active ? Math.min(1, ms / (clock.durationMs || 30000)) : 0);
      seat.dataset.urgent = String(active && seconds <= 5);
      avatar.querySelector('.seat-time').textContent = active ? `${seconds}s` : '';
    });
  }
  socket.on('game_state', state => {
    latestState = state; stateReceived = performance.now();
    clock = state.turnClock; actorId = clock?.playerId || state.currentPlayerId; received = performance.now();
    remaining = clock?.deadlineAt ? Math.max(0, clock.deadlineAt - (state.serverNow || state.serverTime || Date.now())) : clock?.remainingMs || 0;
    const target = document.getElementById('phase-banner') || document.getElementById('uno-turn-label');
    if (target) target.append(timer);
    paint();
    renderReconnectStatus();

  });
  socket.on('disconnect', () => { if (clock) { remaining = Math.max(0, remaining - (performance.now() - received)); clock = { ...clock, deadlineAt: null }; paint(); } });
  setInterval(paint, 200);
})();
