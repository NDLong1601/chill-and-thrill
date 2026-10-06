'use strict';

// Keep the real controls and their listeners; only reorganize their layout.
const gameScreen = $('screen-game');
const station = $('my-player-station');
const chipConsole = document.createElement('div');
chipConsole.className = 'station-chip-controls';
station.insertBefore(chipConsole, document.querySelector('.my-chips-tracker'));
chipConsole.append(document.querySelector('.pool-zone'), document.querySelector('.my-chips-tracker'));
document.querySelector('.pool-header').append($('round-status-box'));
document.querySelector('.topbar-right').insertBefore($('btn-hide-cards'), $('btn-toggle-chat-panel'));
$('table-feature-content').append($('specialist-panel'), $('showdown-panel'));

const menu = $('table-tools-menu');
for (const [id, label] of [
  ['btn-manage-game', 'Quản lý phòng'], ['btn-history-game', 'Lịch sử'],
  ['btn-sound-toggle', 'Âm thanh'], ['btn-game-rules', 'Luật chơi'], ['btn-game-poker', 'Hạng bài'],
]) {
  const button = $(id);
  button.dataset.label = label;
  button.setAttribute('aria-label', label);
  menu.append(button);
  button.addEventListener('click', () => setTableMenu(false));
}
menu.append($('pinned-challenge-btn'));
$('pinned-challenge-btn').setAttribute('role', 'button');
$('pinned-challenge-btn').tabIndex = 0;
$('pinned-challenge-btn').setAttribute('aria-label', 'Xem thẻ đang dùng');
$('pinned-challenge-btn').addEventListener('keydown', event => {
  if (['Enter', ' '].includes(event.key)) { event.preventDefault(); $('pinned-challenge-btn').click(); }
});
$('pinned-challenge-btn').addEventListener('click', () => setTableMenu(false));
function setTableMenu(open) {
  menu.hidden = !open;
  $('btn-table-menu').setAttribute('aria-expanded', String(open));
}
$('btn-table-menu').onclick = () => setTableMenu(menu.hidden);
document.addEventListener('click', event => { if (!event.target.closest('.table-tools')) setTableMenu(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') setTableMenu(false); });
document.querySelectorAll('.col-lbl').forEach((label, index) => {
  label.title = label.textContent;
  label.textContent = `V${index + 1}`;
});

let viewportFrame;
function fitTableViewport() {
  cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(() => {
    const visual = window.visualViewport;
    const height = visual && Math.abs(visual.scale - 1) < .05 ? visual.height : innerHeight;
    gameScreen.style.setProperty('--game-height', `${Math.round(height)}px`);
    gameScreen.classList.toggle('table-compact', height <= 620 || innerWidth <= 1100);
    const bottomInset = Math.max(0, parseFloat(getComputedStyle(station).paddingBottom) - 4);
    gameScreen.classList.toggle('table-short', height - bottomInset <= 315);
    if (!MobileUI.isEditing()) gameScreen.scrollTop = 0;
  });
}
window.addEventListener('resize', fitTableViewport);
window.addEventListener('orientationchange', fitTableViewport);
window.visualViewport?.addEventListener('resize', fitTableViewport);
fitTableViewport();

let fullscreenAttempted = false;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function fullscreenElement() { return document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement; }
function updateFullscreenButton() {
  const active = !!fullscreenElement();
  $('btn-fullscreen').textContent = active ? '⊡' : '⛶';
  $('btn-fullscreen').title = active ? 'Thoát toàn màn hình' : 'Toàn màn hình';
  $('btn-fullscreen').setAttribute('aria-label', $('btn-fullscreen').title);
  $('btn-fullscreen').setAttribute('aria-pressed', String(active));
  fitTableViewport();
}
async function enterTableFullscreen(automatic = false) {
  fullscreenAttempted = true;
  if (MobileUI.isStandalone()) return;
  const element = document.documentElement;
  const request = element.requestFullscreen || element.webkitRequestFullscreen || element.mozRequestFullScreen || element.msRequestFullscreen;
  if (!request) {
    if (!automatic) {
      if (isIOS) $('modal-ios-fullscreen')?.classList.remove('hidden');
      else toast('Trình duyệt chưa hỗ trợ toàn màn hình.');
    }
    return;
  }
  try {
    if (!fullscreenElement()) {
      await request.call(element);
    }
    if (touchDevice && screen.orientation?.lock) {
      try { await screen.orientation.lock('landscape'); } catch { /* Manual rotation remains available. */ }
    }
  } catch (err) {
    if (!automatic) {
      if (isIOS) $('modal-ios-fullscreen')?.classList.remove('hidden');
      else toast('Chưa bật được toàn màn hình. Hãy chạm lại nút ⛶.');
    }
  }
  updateFullscreenButton();
}
$('btn-fullscreen').onclick = async () => {
  fullscreenAttempted = true;
  if (fullscreenElement()) {
    try {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
      if (exit) await exit.call(document);
    } catch { toast('Hãy dùng nút quay lại của trình duyệt để thoát toàn màn hình.'); }
  } else await enterTableFullscreen(false);
};
$('btn-rotate-fullscreen').onclick = () => enterTableFullscreen(false);
document.addEventListener('fullscreenchange', updateFullscreenButton);
document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
document.addEventListener('mozfullscreenchange', updateFullscreenButton);
document.addEventListener('MSFullscreenChange', updateFullscreenButton);
document.addEventListener('click', event => {
  if (event.target.closest('[data-close="modal-ios-fullscreen"]')) $('modal-ios-fullscreen')?.classList.add('hidden');
});
updateFullscreenButton();

let lastFeatureAction = '';
function openTableFeature() {
  $('modal-table-feature').classList.remove('hidden');
  setTableMenu(false);
}
$('btn-table-feature').onclick = openTableFeature;
$('btn-showdown-table').onclick = () => $('btn-reveal-next')?.click();
function showPrivateHand() {
  const preview = $('private-hand-preview');
  const cards = document.createElement('div'); cards.className = 'private-hand-preview-row';
  $('my-cards-row').childNodes.forEach(card => cards.append(card.cloneNode(true)));
  const note = document.createElement('p'); note.textContent = $('my-hand-hint-txt').textContent;
  preview.replaceChildren(cards, note);
  $('modal-my-hand').classList.remove('hidden');
}
$('my-cards-row').setAttribute('role', 'button');
$('my-cards-row').setAttribute('aria-label', 'Phóng to bài của bạn');
$('my-cards-row').tabIndex = 0;
$('my-cards-row').addEventListener('click', showPrivateHand);
$('my-cards-row').addEventListener('keydown', event => {
  if (['Enter', ' '].includes(event.key)) { event.preventDefault(); showPrivateHand(); }
});

function syncTableControls(state) {
  if (state.phase === 'WAITING') {
    $('modal-table-feature').classList.add('hidden');
    setTableMenu(false); lastFeatureAction = '';
    return;
  }
  const me = state.players.find(player => player.id === myId);
  $('disp-round-name').title = $('disp-round-name').textContent;
  const active = ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'].includes(state.phase);
  const confirmed = state.players.filter(player => player.roundConfirmed).length;
  $('round-chip-status').textContent = state.phase === 'SHOWDOWN' ? `${state.showdown.revealedCount}/${state.players.length} đã lật` : `${confirmed}/${state.players.length} đã chốt`;
  $('round-chip-status').title = 'Thay đổi chip sẽ hủy xác nhận của cả đội';
  const colors = { white: '⚪ Trắng · V1', yellow: '🟡 Vàng · V2', orange: '🟠 Cam · V3', red: '🔴 Đỏ · V4' };
  $('pool-color-name').textContent = colors[state.currentRoundChipColor];
  $('btn-confirm-round').textContent = me.roundConfirmed ? '↩ Hủy chốt' : '✓ Chốt chip';
  const next = { PRE_FLOP: 'Mở Flop →', FLOP: 'Mở Turn →', TURN: 'Mở River →', RIVER: 'So bài →' };
  if (active) $('btn-advance-phase').textContent = state.phase === 'FLOP' && [...state.activeChallenges, state.permanentChallenge].some(card => card?.id === 5) ? 'Mở River →' : next[state.phase];
  $('btn-return-my-chip').textContent = me.lockedChip ? '🔒 Đã khóa' : '↩ Trả chip';
  const hideLabel = cardsHidden ? 'Hiện bài' : 'Che bài';
  $('btn-hide-cards').innerHTML = `<span aria-hidden="true">${cardsHidden ? '👁' : '🙈'}</span>`;
  $('btn-hide-cards').setAttribute('aria-label', hideLabel); $('btn-hide-cards').title = hideLabel;
  $('my-hand-hint').title = $('my-hand-hint-txt').textContent;
  $('my-name-disp').title = $('my-name-disp').textContent;
  if (!$('modal-my-hand').classList.contains('hidden')) showPrivateHand();

  const showdown = state.phase === 'SHOWDOWN';
  if (showdown) gameScreen.querySelectorAll('.osc-chips-track > :last-child').forEach(chip => chip.classList.add('active-round-socket'));
  const hasSpecialist = !$('specialist-panel').classList.contains('hidden');
  $('btn-table-feature').classList.toggle('hidden', !showdown && !hasSpecialist);
  $('btn-table-feature').textContent = showdown ? '⚖️' : '✨';
  const featureLabel = showdown ? 'Chi tiết so bài và dự đoán' : 'Sử dụng chuyên gia';
  $('btn-table-feature').title = featureLabel; $('btn-table-feature').setAttribute('aria-label', featureLabel);
  $('table-feature-title').textContent = featureLabel;
  $('btn-showdown-table').classList.toggle('hidden', !showdown);
  if (showdown) {
    $('btn-showdown-table').textContent = isHost ? `Lật bài ${state.showdown.revealedCount + 1}/${state.players.length}` : 'Chờ lật bài';
    $('btn-showdown-table').disabled = !isHost || $('btn-reveal-next')?.disabled;
  }
  if (!showdown && !hasSpecialist) $('modal-table-feature').classList.add('hidden');
  const specialist = state.specialistState;
  const mustChoose = hasSpecialist && (['PASS', 'VIEW'].includes(specialist?.stage) || specialist?.proposal || (['SELECT_CARD', 'DISCARD'].includes(specialist?.stage) && specialist.usedBy === myId));
  const mustGuess = showdown && state.showdown.revealedCount === state.players.length - 1 && (state.showdown.needsValue || state.showdown.needsRank) && myId !== state.showdown.order.at(-1);
  const actionKey = mustChoose || mustGuess ? JSON.stringify([state.phaseKey, specialist?.stage, specialist?.proposal?.actorId, specialist?.proposal?.recipientId, mustGuess]) : '';
  if (!actionKey && lastFeatureAction) { $('modal-table-feature').classList.add('hidden'); lastFeatureAction = ''; }
  if (actionKey && actionKey !== lastFeatureAction && $('modal-card-spotlight').classList.contains('hidden')) {
    lastFeatureAction = actionKey; openTableFeature();
  }
}
socket.on('game_state', syncTableControls);
$('btn-hide-cards').addEventListener('click', () => { if (lastState) syncTableControls(lastState); });
document.addEventListener('click', event => {
  if (event.target.closest('[data-close="modal-card-spotlight"]') && lastState) syncTableControls(lastState);
});
