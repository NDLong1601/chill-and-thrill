'use strict';

(function mountRoomPreflight() {
  if (!window.RoomPreflight || typeof socket === 'undefined') return;
  let panel = null;
  function update(state) {
    const room = document.getElementById('room-view') || document.getElementById('screen-waiting');
    if (!room) return;
    if (!panel) {
      panel = document.createElement('aside');
      panel.dataset.roomPreflight = 'true';
      panel.setAttribute('aria-label', 'Điều kiện trước khi bắt đầu');
      const rules = room.querySelector('.room-shell-rules');
      (rules || room).appendChild(panel);
    }
    panel.hidden = state?.phase !== 'WAITING';
    if (panel.hidden) return;
    try {
      window.RoomPreflight.render(panel, state.preflight);
      const start = document.getElementById('start') || document.getElementById('btn-start-game');
      // The existing renderer decides game-specific button visibility. This
      // later listener can only restrict its start decision, never enable it.
      if (start && state.preflight.viewer.isHost && !state.preflight.evaluation.allowed) start.disabled = true;
    } catch {
      panel.replaceChildren();
      const message = document.createElement('p');
      message.textContent = 'Chưa nhận được điều kiện bắt đầu từ máy chủ. Hãy kết nối lại để cập nhật.';
      panel.appendChild(message);
    }
  }
  socket.on('game_state', update);
  socket.on('room_left', () => { if (panel) { panel.hidden = true; panel.replaceChildren(); } });
})();
