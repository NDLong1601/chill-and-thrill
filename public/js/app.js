'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   THE GANG · CLIENT CONTROLLER & INTERACTIVE ENGINE (V2.0)
   ═══════════════════════════════════════════════════════════════════════ */

const socket = io();

// ── App State ──────────────────────────────────────────────────────────
let myId = null;
let roomCode = '';
let isHost = false;
let lastState = null;
let soundEnabled = true;
let selectedAvatar = '🕶️';
let selectedMode = 'ADVANCED';
let selectedTargetPlayerId = null;
let spotlightTimerInterval = null;

// ── Helpers ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
};

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  const target = $(screenId);
  if (target) target.classList.add('active');
}

// ═══════════════════════════════════════════════════════════════════════
// SOUND ENGINE (Web Audio API - Tự tổng hợp âm thanh chân thực)
// ═══════════════════════════════════════════════════════════════════════
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playChipSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800 + Math.random() * 200, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(320, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  } catch (e) {}
}

function playSnatchSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    [400, 750, 1100].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + i * 0.04);
      gain.gain.setValueAtTime(0.35, now + i * 0.04);
      gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.04 + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.04);
      osc.stop(now + i * 0.04 + 0.08);
    });
  } catch (e) {}
}

function playCardSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const bufferSize = ctx.sampleRate * 0.06;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1400;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.06);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    noise.start();
  } catch (e) {}
}

function playVaultSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.25, now + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.09 + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.09);
      osc.stop(now + i * 0.09 + 0.3);
    });
  } catch (e) {}
}

function playAlarmSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    [300, 450, 300, 450].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.2, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.12 + 0.11);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.11);
    });
  } catch (e) {}
}

function playEmoteSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(500, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(950, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  } catch (e) {}
}

function playChatSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(900, ctx.currentTime);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.08);
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════
// LOBBY CONTROLS
// ═══════════════════════════════════════════════════════════════════════

document.querySelectorAll('.avatar-opt').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.avatar-opt').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedAvatar = btn.getAttribute('data-avatar');
    playChipSound();
  });
});

document.querySelectorAll('input[name="game-mode"]').forEach((input) => {
  input.addEventListener('change', (e) => {
    selectedMode = e.target.value;
    document.querySelectorAll('.mode-card').forEach((card) => card.classList.remove('active'));
    e.target.closest('.mode-card').classList.add('active');
    const badgeMap = {
      BASIC: 'Dành cho người mới',
      ADVANCED: 'Chuẩn The Gang',
      EXPERT: 'Thử thách cao',
      MASTER_THIEF: 'Đỉnh cao · 2 Báo động',
    };
    $('mode-badge-preview').textContent = badgeMap[selectedMode] || '';
    playChipSound();
  });
});

$('btn-create').addEventListener('click', () => {
  const name = $('inp-name').value.trim();
  if (!name) {
    showLobbyError('Vui lòng nhập tên mật danh của bạn!');
    return;
  }
  socket.emit('create_room', {
    playerName: name,
    modeId: selectedMode,
    avatar: selectedAvatar,
  });
});

$('btn-join').addEventListener('click', doJoinRoom);
$('inp-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doJoinRoom();
});
$('inp-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});

function doJoinRoom() {
  const name = $('inp-name').value.trim();
  const code = $('inp-code').value.trim().toUpperCase();
  if (!name) {
    showLobbyError('Vui lòng nhập tên mật danh của bạn!');
    return;
  }
  if (code.length !== 4) {
    showLobbyError('Mã phòng phải có đúng 4 ký tự!');
    return;
  }
  socket.emit('join_room', {
    playerName: name,
    roomCode: code,
    avatar: selectedAvatar,
  });
}

function showLobbyError(msg) {
  const el = $('lobby-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4500);
}

// Modal triggers
$('btn-open-rules').addEventListener('click', () => $('modal-rules').classList.remove('hidden'));
$('btn-open-poker-rank').addEventListener('click', () => $('modal-poker-rank').classList.remove('hidden'));
$('btn-game-rules').addEventListener('click', () => $('modal-rules').classList.remove('hidden'));
$('btn-game-poker').addEventListener('click', () => $('modal-poker-rank').classList.remove('hidden'));

document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = $(btn.getAttribute('data-close'));
    if (target) target.classList.add('hidden');
    if (btn.getAttribute('data-close') === 'modal-card-spotlight' && spotlightTimerInterval) {
      clearInterval(spotlightTimerInterval);
    }
  });
});

$('btn-sound-toggle').addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  $('btn-sound-toggle').textContent = soundEnabled ? '🔊' : '🔇';
});

// ═══════════════════════════════════════════════════════════════════════
// WAITING ROOM
// ═══════════════════════════════════════════════════════════════════════

$('btn-copy-code').addEventListener('click', () => {
  if (!roomCode) return;
  copyText(roomCode);
});

$('btn-copy-link').addEventListener('click', () => {
  copyText(getShareLink());
});

$('btn-start-game').addEventListener('click', () => {
  socket.emit('start_game', { roomCode });
});

$('sel-change-mode').addEventListener('change', (e) => {
  socket.emit('change_mode', { roomCode, modeId: e.target.value });
});

function renderWaitingRoom(state) {
  $('disp-room-code').textContent = state.roomCode;
  $('disp-member-count').textContent = state.players.length;

  const modeInfo = state.modeInfo;
  if (modeInfo) {
    $('disp-mode-title').textContent = `Chế độ: ${modeInfo.name} (${modeInfo.badge})`;
    $('disp-mode-desc').textContent = modeInfo.desc;
  }

  const modeSelect = $('sel-change-mode');
  if (isHost) {
    modeSelect.classList.remove('hidden');
    modeSelect.value = state.mode;
  } else {
    modeSelect.classList.add('hidden');
  }

  const grid = $('wait-player-grid');
  grid.innerHTML = '';
  state.players.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'member-chip-card';
    card.innerHTML = `
      <span class="mcc-avatar">${p.avatar || '🕶️'}</span>
      <div>
        <div class="mcc-name">${esc(p.name)}</div>
        <div class="mcc-role">${p.isHost ? 'CHỦ PHÒNG 👑' : 'THÀNH VIÊN'}</div>
      </div>
    `;
    grid.appendChild(card);
  });

  const startBtn = $('btn-start-game');
  const clientHint = $('wait-client-hint');

  if (isHost) {
    startBtn.classList.remove('hidden');
    clientHint.classList.add('hidden');
    const needMore = Math.max(0, 2 - state.players.length);
    startBtn.disabled = needMore > 0;
    startBtn.innerHTML =
      needMore > 0
        ? `▶ CẦN THÊM ${needMore} THÀNH VIÊN NỮA...`
        : '▶ BẮT ĐẦU VỤ CƯỚP';
  } else {
    startBtn.classList.add('hidden');
    clientHint.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// SOCKET EVENTS
// ═══════════════════════════════════════════════════════════════════════

socket.on('room_created', ({ roomCode: code, playerId }) => {
  myId = playerId;
  roomCode = code;
  isHost = true;
  $('disp-room-code').textContent = code;
  showScreen('screen-waiting');
  playVaultSound();
});

socket.on('room_joined', ({ roomCode: code, playerId }) => {
  myId = playerId;
  roomCode = code;
  isHost = false;
  $('disp-room-code').textContent = code;
  showScreen('screen-waiting');
  playCardSound();
});

socket.on('join_error', ({ message }) => showLobbyError(message));
socket.on('game_error', ({ message }) => alert(message));

socket.on('game_state', (state) => {
  const prevPhase = lastState?.phase;
  lastState = state;
  myId = state.myId;
  roomCode = state.roomCode;

  const me = state.players.find((p) => p.id === myId);
  isHost = me?.isHost || false;

  if (state.phase === 'WAITING') {
    showScreen('screen-waiting');
    renderWaitingRoom(state);
    $('modal-result').classList.add('hidden');
    $('modal-gameover').classList.add('hidden');
  } else {
    showScreen('screen-game');
    renderGameArena(state);

    if (prevPhase !== state.phase) {
      if (['FLOP', 'TURN', 'RIVER'].includes(state.phase)) playCardSound();
      if (state.phase === 'RESULT') {
        if (state.lastResult?.success) playVaultSound();
        else playAlarmSound();
      }
      if (state.phase === 'GAME_OVER') {
        if (state.gameWon) playVaultSound();
        else playAlarmSound();
      }
    }
  }
});

// Spotlight card popup
socket.on('spotlight_cards', ({ cards }) => {
  if (cards && cards.length > 0) {
    showCardSpotlight(cards[0]);
  }
});

// Chip snatched event (Cướp chip)
socket.on('chip_snatched', ({ snatcherId, snatcherName, victimId, victimName, color, chip }) => {
  playSnatchSound();
  
  // Screen shake animation
  const table = $('poker-table');
  table.classList.add('screen-shake');
  setTimeout(() => table.classList.remove('screen-shake'), 450);

  // If I was the victim -> Show warning toast!
  if (victimId === myId) {
    const toast = $('snatch-toast');
    $('st-title').textContent = '⚠️ BẠN VỪA BỊ CƯỚP CHIP!';
    $('st-desc').textContent = `${snatcherName} vừa cướp chip ${chip}⭐ của bạn! Bạn có thể cướp lại ngay!`;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 4500);
  }
});

// Emote event
socket.on('player_emote', ({ fromId, fromName, toId, toName, emote }) => {
  playEmoteSound();
  spawnFloatingEmote(toId || fromId, emote);
});

// Chat event
socket.on('chat_message', (msg) => {
  playChatSound();
  appendChatMessage(msg);
  if ($('comm-dock-panel').classList.contains('dock-collapsed')) {
    $('chat-unread-dot').classList.remove('hidden');
  }
});

// ═══════════════════════════════════════════════════════════════════════
// RENDER BÀN POKER ARENA & PERIMETER SEATS
// ═══════════════════════════════════════════════════════════════════════

const COLOR_NAMES_VI = {
  white: 'Chip Trắng (Vòng 1)',
  yellow: 'Chip Vàng (Vòng 2)',
  orange: 'Chip Cam (Vòng 3)',
  red: 'Chip Đỏ (Vòng 4 - So Bài)',
};

const ROUND_TITLES_VI = {
  PRE_FLOP: 'Vòng 1 · Pre-Flop',
  FLOP: 'Vòng 2 · The Flop',
  TURN: 'Vòng 3 · The Turn',
  RIVER: 'Vòng 4 · The River',
  SHOWDOWN: 'Màn So Bài · Showdown',
  RESULT: 'Kết quả vụ cướp',
  GAME_OVER: 'Kết thúc trận đấu',
};

function renderGameArena(state) {
  renderTopbar(state);
  renderPinnedChallenge(state);
  renderPerimeterSeats(state);
  renderCommunityCards(state.communityCards);
  renderCenterChipPool(state);
  renderMyStation(state);
  renderGameLog(state.log);

  if (state.phase === 'RESULT' && state.lastResult) {
    renderResultModal(state);
  } else {
    $('modal-result').classList.add('hidden');
  }

  if (state.phase === 'GAME_OVER') {
    renderGameOverModal(state);
  } else {
    $('modal-gameover').classList.add('hidden');
  }
}

/* ── Topbar (Heist, Round, Vaults, Alarms) ── */
function renderTopbar(state) {
  $('disp-heist-num').textContent = `VỤ CƯỚP #${state.heistNumber}`;
  $('disp-round-name').textContent = ROUND_TITLES_VI[state.phase] || state.phase;

  for (let i = 1; i <= 3; i++) {
    const vEl = $(`vault-${i}`);
    if (vEl) {
      const isOpened = i <= state.score.vaults;
      vEl.classList.toggle('opened', isOpened);
      vEl.querySelector('.v-icon').textContent = isOpened ? '🔓' : '🔒';
    }
  }

  $('alarm-limit-txt').textContent = `MAX ${state.maxAlarms}`;
  for (let i = 1; i <= 3; i++) {
    const aEl = $(`alarm-${i}`);
    if (aEl) {
      if (i > state.maxAlarms) {
        aEl.classList.add('hidden');
      } else {
        aEl.classList.remove('hidden');
        const isTriggered = i <= state.score.alarms;
        aEl.classList.toggle('triggered', isTriggered);
      }
    }
  }
}

/* ── Thẻ Thử Thách Ghim (Pinned Chip) ── */
function renderPinnedChallenge(state) {
  const btn = $('pinned-challenge-btn');
  const allCards = [
    ...(state.activeChallenges || []),
    ...(state.activeSpecialist ? [state.activeSpecialist] : []),
    ...(state.permanentChallenge ? [state.permanentChallenge] : []),
  ];

  if (allCards.length === 0) {
    btn.classList.add('hidden');
    return;
  }

  const primaryCard = allCards[0];
  btn.classList.remove('hidden');
  $('pinned-challenge-title').textContent = `#${primaryCard.id} ${primaryCard.title}`;
  btn.onclick = () => showCardSpotlight(primaryCard);
}

/* ── Vòng Ghế Người Chơi Quanh Viền Bàn (Perimeter Seats) ── */
function renderPerimeterSeats(state) {
  const container = $('table-seats-perimeter');
  container.innerHTML = '';
  const revealed = ['SHOWDOWN', 'RESULT', 'GAME_OVER'].includes(state.phase);
  const activeRound = ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'].includes(state.phase);
  const currentRoundColor = state.currentRoundChipColor;
  // View the table from our seat; the next teammate stays on our left.
  const mySeat = state.players.findIndex(p => p.id === myId);
  const opponents = [...state.players.slice(mySeat + 1), ...state.players.slice(0, mySeat)].filter(p => p.id !== myId);
  const positions = {
    1: ['top-center'],
    2: ['left', 'right'],
    3: ['left', 'top-center', 'right'],
    4: ['left', 'top-left', 'top-right', 'right'],
    5: ['left', 'top-left', 'top-center', 'top-right', 'right'],
  };
  $('poker-table').dataset.seatCount = opponents.length;
  $('poker-table').dataset.revealed = revealed;

  opponents.forEach((p, index) => {
      const capsule = document.createElement('div');
      capsule.className = 'opp-seat-capsule' + (p.connected ? '' : ' disconnected');
      capsule.id = `seat-player-${p.id}`;
      capsule.dataset.position = positions[opponents.length][index];
      capsule.setAttribute('role', 'button');
      capsule.tabIndex = 0;
      capsule.setAttribute('aria-label', `Tương tác với ${p.name}`);
      capsule.title = `Chạm để tương tác với ${p.name}`;

      // Header: Avatar, Name, Interact badge
      const hdr = document.createElement('div');
      hdr.className = 'osc-header';
      hdr.innerHTML = `
        <div class="osc-avatar-ring">${p.avatar || '🕶️'}</div>
        <div class="osc-name">${esc(p.name)}${p.isHost ? ' 👑' : ''}</div>
        <span class="osc-interact-badge">TƯƠNG TÁC ⚡</span>
      `;
      capsule.appendChild(hdr);

      // Fanned Cards (2 lá bài tẩy mặt sau hoàng gia hoặc mở khi Showdown)
      const fanned = document.createElement('div');
      fanned.className = 'osc-cards-fanned';
      (p.privateCards || []).forEach((c) => {
        fanned.appendChild(c ? createCardEl(c, 'sm') : createCardBackEl('sm'));
      });
      capsule.appendChild(fanned);

      // Hand rank name (Showdown)
      const rankName = document.createElement('div');
      rankName.className = 'osc-hand-rank-name';
      rankName.textContent = revealed ? p.handNameVi || p.handName : '';
      capsule.appendChild(rankName);

      // Khay 4 Chip to rõ ràng (30px)
      const track = document.createElement('div');
      track.className = 'osc-chips-track';

      ['white', 'yellow', 'orange', 'red'].forEach((colorKey) => {
        const val = p.chips[colorKey];
        const socketEl = document.createElement('div');
        const isActiveColor = activeRound && colorKey === currentRoundColor;
        socketEl.className = 'osc-chip-socket' + (isActiveColor ? ' active-round-socket' : '');

        if (val !== null) {
          const chipEl = createChipEl(val, colorKey, 'sm');
          socketEl.appendChild(chipEl);
        } else {
          socketEl.innerHTML = '<span class="empty-star">-</span>';
        }
        track.appendChild(socketEl);
      });

      capsule.appendChild(track);

      // Click vào người chơi để mở Menu Cướp Chip & Gửi Emote
      capsule.addEventListener('click', () => {
        openPlayerActionPopover(p, state);
      });
      capsule.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openPlayerActionPopover(p, state);
        }
      });

      container.appendChild(capsule);
    });
}

/* ── 5 Lá Bài Cộng Đồng ── */
function renderCommunityCards(cards) {
  const row = $('community-cards-row');
  row.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    if (i < cards.length) {
      row.appendChild(createCardEl(cards[i], 'md'));
    } else {
      const slot = document.createElement('div');
      slot.className = 'card-slot';
      row.appendChild(slot);
    }
  }
}

/* ── Khay Chip Pool Ở Giữa Bàn ── */
function renderCenterChipPool(state) {
  const rack = $('center-chip-rack');
  rack.innerHTML = '';
  const color = state.currentRoundChipColor;
  $('pool-color-name').textContent = COLOR_NAMES_VI[color] || color;

  const active = ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'].includes(state.phase);

  for (let n = 1; n <= state.players.length; n++) {
    const isAvailable = state.chipPool.includes(n);
    const chip = createChipEl(n, color, 'md');

    if (isAvailable && active) {
      chip.title = `Chọn chip ${n}⭐`;
      chip.addEventListener('click', () => {
        playChipSound();
        socket.emit('claim_chip', { roomCode, chipNumber: n });
      });
    } else {
      chip.style.opacity = isAvailable ? '0.9' : '0.22';
      chip.classList.add('no-click');
    }

    rack.appendChild(chip);
  }
}

/* ── Khu Vực Của Tôi (My Station) ── */
function renderMyStation(state) {
  const me = state.players.find((p) => p.id === myId);
  if (!me) return;

  $('my-avatar-disp').textContent = me.avatar || '🕶️';
  $('my-name-disp').textContent = `${me.name} (Tôi)`;

  const cardsRow = $('my-cards-row');
  cardsRow.innerHTML = '';
  (me.privateCards || []).forEach((c) => {
    cardsRow.appendChild(c ? createCardEl(c, 'lg') : createCardBackEl('lg'));
  });

  renderHandHelperHint(me.privateCards, state.communityCards, me.extraNote);

  // Khay 4 Chip Lớn Của Tôi
  const currentColor = state.currentRoundChipColor;
  const activeRound = ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'].includes(state.phase);

  ['white', 'yellow', 'orange', 'red'].forEach((colorKey) => {
    const socketEl = $(`my-chip-${colorKey}`);
    socketEl.innerHTML = '';
    const val = me.chips[colorKey];
    if (val !== null) {
      const chip = createChipEl(val, colorKey, 'lg');
      chip.classList.add('no-click');
      socketEl.appendChild(chip);
    } else {
      socketEl.innerHTML = '<span class="empty-star">-</span>';
    }
  });

  // Nút Trả chip vòng này
  const returnBtn = $('btn-return-my-chip');
  if (activeRound && me.chips[currentColor] !== null) {
    returnBtn.classList.remove('hidden');
    returnBtn.onclick = () => {
      playChipSound();
      socket.emit('return_chip', { roomCode });
    };
  } else {
    returnBtn.classList.add('hidden');
  }

  // Trạng thái chọn chip & Action Buttons
  const pickedCount = state.players.filter((p) => p.chips[currentColor] !== null).length;
  const totalCount = state.players.length;

  $('round-chip-status').textContent = `Đã chọn: ${pickedCount}/${totalCount} thành viên`;

  const advBtn = $('btn-advance-phase');
  const advanceLabels = {
    PRE_FLOP: 'MỞ FLOP (3 LÁ CHUNG) →',
    FLOP: 'MỞ TURN (LÁ THỨ 4) →',
    TURN: 'MỞ RIVER (LÁ CUỐI) →',
    RIVER: '⚖️ SO BÀI SHOWDOWN! →',
  };

  if (isHost && advanceLabels[state.phase]) {
    advBtn.classList.remove('hidden');
    advBtn.textContent = advanceLabels[state.phase];
    advBtn.disabled = pickedCount < totalCount;
    advBtn.onclick = () => {
      playCardSound();
      socket.emit('advance_phase', { roomCode });
    };
  } else {
    advBtn.classList.add('hidden');
  }
}

function renderHandHelperHint(myCards, commCards, extraNote) {
  const hintTxt = $('my-hand-hint-txt');
  if (!myCards || myCards.length === 0) {
    hintTxt.textContent = 'Đang chờ chia bài...';
    return;
  }

  const all = [...myCards, ...(commCards || [])];
  const vals = myCards.map((c) => (c ? c.value : 0)).sort((a, b) => b - a);

  let desc = '';
  if (all.length < 5) {
    if (vals[0] === vals[1] && vals[0] > 0) {
      desc = `Đôi ${valName(vals[0])} trên tay`;
    } else if (vals[0] >= 11) {
      desc = `Bài cao ${valName(vals[0])}`;
    } else {
      desc = `Bài thường (${valName(vals[0])} cao)`;
    }
  } else {
    desc = 'Xem xét 5 lá bài chung...';
  }

  if (extraNote) desc += ` · [${extraNote}]`;
  hintTxt.textContent = desc;
}

function valName(v) {
  const map = { 14: 'Át (A)', 13: 'K', 12: 'Q', 11: 'J' };
  return map[v] || String(v);
}

// ═══════════════════════════════════════════════════════════════════════
// ACTION POPOVER: CƯỚP CHIP & GỬI EMOTE
// ═══════════════════════════════════════════════════════════════════════

function openPlayerActionPopover(targetPlayer, state) {
  selectedTargetPlayerId = targetPlayer.id;

  $('pop-target-avatar').textContent = targetPlayer.avatar || '🕶️';
  $('pop-target-name').textContent = targetPlayer.name;

  const color = state.currentRoundChipColor;
  const targetChip = targetPlayer.chips[color];
  const activeRound = ['PRE_FLOP', 'FLOP', 'TURN', 'RIVER'].includes(state.phase);

  const statusEl = $('pop-chip-status');
  const snatchBtn = $('btn-snatch-chip-action');

  if (targetChip !== null) {
    statusEl.textContent = `Đang giữ: Chip ${COLOR_NAMES_VI[color]} [${targetChip}⭐]`;
    snatchBtn.disabled = !activeRound;
    snatchBtn.innerHTML = `<span class="sab-icon">⚡</span> CƯỚP CHIP ${targetChip}⭐ CỦA ${esc(targetPlayer.name)}!`;
  } else {
    statusEl.textContent = `Chưa chọn chip ở vòng ${COLOR_NAMES_VI[color]}`;
    snatchBtn.disabled = true;
    snatchBtn.innerHTML = `<span class="sab-icon">⏳</span> NGƯỜI NÀY CHƯA CHỌN CHIP`;
  }

  snatchBtn.onclick = () => {
    playSnatchSound();
    socket.emit('snatch_chip', { roomCode, targetId: selectedTargetPlayerId });
    $('modal-player-action').classList.add('hidden');
  };

  // Emote buttons
  document.querySelectorAll('.btn-emote').forEach((btn) => {
    btn.onclick = () => {
      const emote = btn.getAttribute('data-emote');
      playEmoteSound();
      socket.emit('send_emote', {
        roomCode,
        targetId: selectedTargetPlayerId,
        emote,
      });
      $('modal-player-action').classList.add('hidden');
    };
  });

  $('modal-player-action').classList.remove('hidden');
}

// Emote floating animation
function spawnFloatingEmote(playerId, emoteChar) {
  const seat = $(`seat-player-${playerId}`) || $('my-cards-row') || document.body;
  const rect = seat.getBoundingClientRect();

  const bubble = document.createElement('div');
  bubble.className = 'floating-emote-bubble';
  bubble.textContent = emoteChar;
  bubble.style.left = `${rect.left + rect.width / 2 - 15}px`;
  bubble.style.top = `${rect.top - 20}px`;

  document.body.appendChild(bubble);
  setTimeout(() => bubble.remove(), 2100);
}

// ═══════════════════════════════════════════════════════════════════════
// SPOTLIGHT THẺ THỬ THÁCH (TỰ ĐỘNG ĐÓNG 10S)
// ═══════════════════════════════════════════════════════════════════════

function showCardSpotlight(card) {
  if (!card) return;
  if (spotlightTimerInterval) clearInterval(spotlightTimerInterval);

  $('spot-type-tag').textContent = `⚡ THẺ THỬ THÁCH / CHUYÊN GIA`;
  $('spot-icon').textContent = card.icon || '🃏';
  $('spot-title').textContent = `#${card.id} ${card.title}`;
  $('spot-rule').textContent = card.rule || card.summary;

  const bar = $('spot-countdown-bar');
  let timeLeft = 10;
  $('spot-timer-num').textContent = timeLeft;
  bar.style.width = '100%';

  $('modal-card-spotlight').classList.remove('hidden');

  const startTime = Date.now();
  const totalMs = 10000;

  spotlightTimerInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, totalMs - elapsed);
    const pct = (remaining / totalMs) * 100;
    bar.style.width = `${pct}%`;
    $('spot-timer-num').textContent = Math.ceil(remaining / 1000);

    if (remaining <= 0) {
      clearInterval(spotlightTimerInterval);
      $('modal-card-spotlight').classList.add('hidden');
    }
  }, 100);
}

// ═══════════════════════════════════════════════════════════════════════
// CHAT & NHẬT KÝ DOCK
// ═══════════════════════════════════════════════════════════════════════

$('btn-toggle-chat-panel').addEventListener('click', () => {
  const dock = $('comm-dock-panel');
  dock.classList.toggle('dock-collapsed');
  $('chat-unread-dot').classList.add('hidden');
});

$('btn-close-comm-dock').addEventListener('click', () => {
  $('comm-dock-panel').classList.add('dock-collapsed');
});

$('tab-btn-chat').addEventListener('click', () => {
  $('tab-btn-chat').classList.add('active');
  $('tab-btn-log').classList.remove('active');
  $('tab-content-chat').classList.add('active');
  $('tab-content-log').classList.remove('active');
});

$('tab-btn-log').addEventListener('click', () => {
  $('tab-btn-log').classList.add('active');
  $('tab-btn-chat').classList.remove('active');
  $('tab-content-log').classList.add('active');
  $('tab-content-chat').classList.remove('active');
});

// Quick Chat presets
document.querySelectorAll('.qc-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const text = btn.getAttribute('data-text');
    socket.emit('send_chat', { roomCode, text });
  });
});

$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('inp-chat-msg');
  const text = inp.value.trim();
  if (text) {
    socket.emit('send_chat', { roomCode, text });
    inp.value = '';
  }
});

function appendChatMessage(msg) {
  const container = $('chat-messages-container');
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble-msg';
  bubble.innerHTML = `
    <div class="chat-msg-hdr">
      <span class="chat-msg-author">${msg.avatar || '🕶️'} ${esc(msg.name)}</span>
      <span>${msg.time}</span>
    </div>
    <div class="chat-msg-text">${esc(msg.text)}</div>
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function renderGameLog(log) {
  const list = $('log-messages-list');
  list.innerHTML = '';
  (log || []).forEach((entry) => {
    const row = document.createElement('div');
    row.className = `log-entry-row type-${entry.type || 'info'}`;
    row.innerHTML = `
      <span style="color:var(--text-sub)">[${entry.t}]</span>
      <span>${esc(entry.msg)}</span>
    `;
    list.appendChild(row);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// RESULT MODAL
// ═══════════════════════════════════════════════════════════════════════

function renderResultModal(state) {
  const { success, reason, heistNumber, playerResults } = state.lastResult;
  const banner = $('res-banner');
  banner.className = `result-badge-banner ${success ? 'success' : 'fail'}`;

  $('res-icon').textContent = success ? '🔓' : '🚨';
  $('res-title').textContent = success
    ? `VỤ CƯỚP #${heistNumber} THÀNH CÔNG!`
    : `VỤ CƯỚP #${heistNumber} THẤT BẠI!`;
  $('res-reason').textContent = reason;

  $('res-vault-txt').textContent = `${state.score.vaults} / ${state.maxVaults}`;
  $('res-alarm-txt').textContent = `${state.score.alarms} / ${state.maxAlarms}`;

  const rows = $('res-showdown-rows');
  rows.innerHTML = '';

  (playerResults || []).forEach((p) => {
    const row = document.createElement('div');
    row.className = 'sdl-row';

    const pCol = document.createElement('div');
    pCol.className = 'sdl-player-info';
    pCol.innerHTML = `<span>${p.avatar || '🕶️'}</span><span>${esc(p.name)}</span>`;

    const cCol = document.createElement('div');
    if (p.chip !== null) {
      cCol.appendChild(createChipEl(p.chip, 'red', 'sm'));
    } else {
      cCol.textContent = '-';
    }

    const hCol = document.createElement('div');
    hCol.className = 'sdl-cards-mini';
    (p.privateCards || []).forEach((c) => {
      hCol.appendChild(c ? createCardEl(c, 'sm') : createCardBackEl('sm'));
    });

    const rCol = document.createElement('div');
    rCol.className = 'sdl-hand-rank';
    rCol.textContent = p.handNameVi || p.handName || '';

    row.appendChild(pCol);
    row.appendChild(cCol);
    row.appendChild(hCol);
    row.appendChild(rCol);
    rows.appendChild(row);
  });

  const hostNextWrap = $('host-next-heist-wrap');
  const clientWaitWrap = $('client-wait-heist-wrap');

  if (isHost) {
    hostNextWrap.classList.remove('hidden');
    clientWaitWrap.classList.add('hidden');
    $('btn-next-heist').onclick = () => {
      playVaultSound();
      socket.emit('next_heist', { roomCode });
      $('modal-result').classList.add('hidden');
    };
  } else {
    hostNextWrap.classList.add('hidden');
    clientWaitWrap.classList.remove('hidden');
  }

  $('btn-result-to-lobby').onclick = () => {
    socket.emit('return_to_lobby', { roomCode });
    $('modal-result').classList.add('hidden');
  };

  $('modal-result').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════════
// GAME OVER MODAL
// ═══════════════════════════════════════════════════════════════════════

function renderGameOverModal(state) {
  const won = state.gameWon;
  $('go-emblem').textContent = won ? '🏆' : '💀';
  $('go-title').textContent = won ? 'CHIẾN THẮNG HOÀNG GIA!' : 'BỊ CẢNH SÁT TÚM GỌN!';
  $('go-title').style.color = won ? 'var(--gold-light)' : 'var(--red)';
  $('go-subtitle').textContent = won
    ? `Băng nhóm đã phối hợp xuất sắc mở sạch ${state.maxVaults} két sắt ngân hàng!`
    : `Báo động đã vang lên ${state.maxAlarms} lần! Cả băng đảng đã sa lưới.`;

  $('go-vault-cnt').textContent = state.score.vaults;
  $('go-alarm-cnt').textContent = state.score.alarms;

  const playAgainBtn = $('btn-play-again');
  const clientWait = $('client-go-wait');

  if (isHost) {
    playAgainBtn.classList.remove('hidden');
    clientWait.classList.add('hidden');
    playAgainBtn.onclick = () => {
      playVaultSound();
      socket.emit('play_again', { roomCode });
      $('modal-gameover').classList.add('hidden');
    };
  } else {
    playAgainBtn.classList.add('hidden');
    clientWait.classList.remove('hidden');
  }

  $('btn-go-lobby').onclick = () => {
    socket.emit('return_to_lobby', { roomCode });
    $('modal-gameover').classList.add('hidden');
  };

  $('modal-gameover').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════════
// CARDS & CHIPS BUILDERS
// ═══════════════════════════════════════════════════════════════════════

const SUIT_SYMBOLS = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣', none: '★' };
const VAL_LABELS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const RED_SUITS = new Set(['hearts', 'diamonds']);

function createCardEl(card, size = 'md') {
  const { suit, value } = card;
  const isRed = RED_SUITS.has(suit);
  const valStr = VAL_LABELS[value] || String(value);
  const suitSym = SUIT_SYMBOLS[suit] || '?';

  const div = document.createElement('div');
  div.className = `playing-card card-${size}${isRed ? ' red' : ''}`;
  div.innerHTML = `
    <div class="card-corner top">
      <span class="c-val">${valStr}</span>
      <span class="c-suit">${suitSym}</span>
    </div>
    <div class="c-center-symbol">${suitSym}</div>
    <div class="card-corner bottom">
      <span class="c-val">${valStr}</span>
      <span class="c-suit">${suitSym}</span>
    </div>
  `;
  return div;
}

// Mặt sau lá bài hoàng gia The Gang
function createCardBackEl(size = 'md') {
  const div = document.createElement('div');
  div.className = `playing-card card-${size} card-back`;
  div.innerHTML = `
    <div class="card-back-ornament">
      <span class="card-back-emblem">🏦</span>
    </div>
  `;
  return div;
}

function createChipEl(number, color = 'white', size = 'md') {
  const div = document.createElement('div');
  div.className = `poker-chip chip-${color} chip-size-${size}`;
  div.innerHTML = `<span>${number}⭐</span>`;
  return div;
}
