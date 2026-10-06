'use strict';

(function publishTablePreferences(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TablePreferences = api;
})(typeof globalThis === 'object' ? globalThis : this, function createApi() {
  const STORAGE_KEY = 'chill-thrill:table-preferences:v1';
  const VERSION = 1;
  const CARD_SIZES = Object.freeze(['compact', 'standard', 'large']);
  const TEXT_SIZES = Object.freeze(['standard', 'large', 'largest']);
  const SUPPORTED_GAMES = new Set(['uno', 'the-gang', 'gang', 'tien-len', 'poker', 'sam-loc', 'phom', 'bang']);
  const ACTIVE_PHASES = new Set([
    'PLAYING', 'TURN', 'UNO_WINDOW', 'WDF_CHALLENGE', 'DRAW_PENALTY', 'HAND',
    'SAM_PLAY', 'DISCARD', 'DRAW_OR_EAT', 'LAYDOWN', 'DRAW', 'PLAY', 'MAIN',
  ]);
  const TERMINAL_PHASES = new Set(['RESULT', 'GAME_OVER', 'CANCELLED', 'WAITING']);
  const OWN = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

  function defaults(systemReducedMotion = false) {
    return { cardSize: 'standard', textSize: 'standard', audioEnabled: false, reduceMotion: !!systemReducedMotion };
  }

  function normalizePreferences(value, fallback = defaults()) {
    const result = { ...fallback };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    if (CARD_SIZES.includes(value.cardSize)) result.cardSize = value.cardSize;
    if (TEXT_SIZES.includes(value.textSize)) result.textSize = value.textSize;
    if (typeof value.audioEnabled === 'boolean') result.audioEnabled = value.audioEnabled;
    if (typeof value.reduceMotion === 'boolean') result.reduceMotion = value.reduceMotion;
    return result;
  }

  function readPreferences(storage, systemReducedMotion = false, key = STORAGE_KEY) {
    const fallback = defaults(systemReducedMotion);
    if (!storage || typeof storage.getItem !== 'function') return fallback;
    try {
      const raw = storage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      if (parsed?.version !== VERSION) return fallback;
      return normalizePreferences(parsed, fallback);
    } catch {
      return fallback;
    }
  }

  function writePreferences(storage, preferences, key = STORAGE_KEY) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(key, JSON.stringify({ version: VERSION, ...normalizePreferences(preferences) }));
      return true;
    } catch {
      return false;
    }
  }

  function inferUnoVariant(state) {
    if (state?.variant === 'classic-local-v1' || state?.variant === 'classic-108-v1') return state.variant;
    // The 108-card manager predates the explicit variant field. Its public
    // projection has these UNO reaction fields; inspect no card or hand data.
    if (state?.gameId === 'uno' && ['WAITING', 'TURN', 'UNO_WINDOW', 'WDF_CHALLENGE', 'DRAW_PENALTY'].includes(state.phase)
      && OWN(state, 'pendingUno') && OWN(state, 'pendingWdf')) return 'classic-108-v1';
    return null;
  }

  function getPublicTurnStatus(state) {
    if (!state || typeof state !== 'object' || !SUPPORTED_GAMES.has(state.gameId)) return null;
    const unoVariant = state.gameId === 'uno' ? inferUnoVariant(state) : null;
    if (state.gameId === 'uno' && !unoVariant) return null;

    const phase = typeof state.phase === 'string' ? state.phase : '';
    if (phase === 'WAITING') return { kind: 'waiting', isMine: false, ownerId: null, playerName: '' };
    if (phase === 'RESULT' || phase === 'GAME_OVER' || phase === 'CANCELLED') {
      return { kind: 'finished', isMine: false, ownerId: null, playerName: '' };
    }
    const reconnectWaiting = Array.isArray(state.reconnect?.waiting)
      && state.reconnect.waiting.some(player => player?.expired === false);
    if (state.paused === true || reconnectWaiting || (state.turnClock && state.turnClock.deadlineAt === null)) {
      return { kind: 'paused', isMine: false, ownerId: null, playerName: '' };
    }

    const players = Array.isArray(state.players) ? state.players : [];
    const findPlayer = id => players.find(item => item?.id === id) || null;
    const makeStatus = (ownerId, { kind, message, turnKey, canAct = true } = {}) => {
      const player = typeof ownerId === 'string' ? findPlayer(ownerId) : null;
      const isMine = typeof state.myId === 'string' && ownerId === state.myId && canAct;
      return {
        kind: kind || (isMine ? 'mine' : 'other'),
        isMine,
        ownerId: typeof ownerId === 'string' ? ownerId : null,
        playerName: typeof player?.name === 'string' ? player.name : '',
        message: message || '',
        turnKey: turnKey || '',
      };
    };

    if (state.gameId === 'uno') {
      const available = Array.isArray(state.availableActions) ? state.availableActions.map(item => item?.type) : null;
      const reaction = unoVariant === 'classic-local-v1' ? state.reactionWindow : state.pendingWdf;
      const reactionTarget = reaction?.targetId;
      if (typeof reactionTarget === 'string') {
        const reactionKey = unoVariant === 'classic-local-v1'
          ? `wild4:${reaction.type || ''}:${reactionTarget}:${reaction.deadlineAt || ''}`
          : `wild4:${reactionTarget}:${reaction.offenderId || ''}:${state.reactionDeadlineAt || ''}`;
        return makeStatus(reactionTarget, {
          turnKey: reactionKey,
          canAct: unoVariant !== 'classic-local-v1' || !available || available.some(type => ['challenge_draw_four', 'draw_penalty'].includes(type)),
          message: reactionTarget === state.myId ? 'Bạn cần xử lý lá +4.' : '',
        });
      }
      const penaltyTarget = unoVariant === 'classic-local-v1' ? state.pendingTargetId : state.pendingDraw?.targetId;
      if (state.pendingDraw && typeof penaltyTarget === 'string') {
        const penaltyKey = `penalty:${penaltyTarget}:${state.pendingDraw?.count || state.pendingDraw}:${state.revision || ''}`;
        return makeStatus(penaltyTarget, {
          turnKey: penaltyKey,
          canAct: unoVariant !== 'classic-local-v1' || !available || available.includes('draw_penalty'),
          message: penaltyTarget === state.myId ? 'Đến lượt bạn rút bài phạt.' : '',
        });
      }

      const unoWindow = unoVariant === 'classic-local-v1' ? state.unoWindow : state.pendingUno;
      if (unoWindow) {
        if (available?.includes('call_uno')) {
          return makeStatus(state.myId, { kind: 'reaction', turnKey: `uno-call:${unoWindow.playerId || unoWindow.targetId || ''}`, canAct: false, message: 'Bạn có thể gọi UNO.' });
        }
        if (available?.includes('catch_uno')) {
          return makeStatus(state.myId, { kind: 'reaction', turnKey: `uno-catch:${unoWindow.playerId || unoWindow.targetId || ''}`, canAct: false, message: 'Bạn có thể bắt lỗi UNO.' });
        }
        const targetId = unoVariant === 'classic-local-v1' ? (unoWindow.playerId || unoWindow.targetId) : unoWindow.targetId;
        const message = targetId === state.myId
          ? 'Bạn đã quên gọi UNO; cửa sổ bắt lỗi đang mở.'
          : 'Đang mở cửa sổ bắt lỗi UNO.';
        return { kind: 'reaction', isMine: false, ownerId: null, playerName: '', message, turnKey: `uno-window:${targetId || ''}`, actionOnly: true };
      }
    }

    if (state.gameId === 'bang' && typeof state.pending?.waitingId === 'string') {
      return makeStatus(state.pending.waitingId, {
        turnKey: `pending:${state.pending.id || state.pending.kind || ''}:${state.pending.waitingId}`,
        canAct: true,
        message: state.pending.waitingId === state.myId ? 'Bạn cần phản ứng với hiệu ứng đang chờ.' : '',
      });
    }

    const actorId = typeof state.turnClock?.playerId === 'string'
      ? state.turnClock.playerId
      : typeof state.currentPlayerId === 'string' ? state.currentPlayerId : null;
    const active = ACTIVE_PHASES.has(phase) || (!TERMINAL_PHASES.has(phase) && phase.length > 0);
    if (!active) return { kind: 'group', isMine: false, ownerId: null, playerName: '' };
    if (!actorId) {
      const message = state.gameId === 'the-gang' ? 'Cả nhóm đang xử lý bàn chơi.' : 'Đang chờ hành động theo trạng thái bàn.';
      return { kind: 'group', isMine: false, ownerId: null, playerName: '', message, turnKey: '' };
    }
    const actor = findPlayer(actorId);
    const legalForMe = state.gameId === 'poker' && actorId === state.myId ? state.legalActions !== null : true;
    const aliveForMe = state.gameId === 'bang' && actorId === state.myId ? actor?.dead !== true : true;
    const turnKey = `${phase}:${state.turnClock?.deadlineAt || ''}`;
    return makeStatus(actorId, {
      canAct: legalForMe && aliveForMe,
      turnKey,
      message: actorId === state.myId ? 'Đến lượt bạn.' : '',
    });
  }

  function preferredReducedMotion(matchMedia) {
    try { return !!matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; }
    catch { return false; }
  }

  function safeLocalStorage(globalObject) {
    try { return globalObject?.localStorage || null; }
    catch { return null; }
  }

  function createTablePreferences(options = {}) {
    const doc = options.document || globalThis.document;
    const globalObject = options.globalObject || globalThis;
    if (!doc?.createElement) throw new Error('TablePreferences needs a document.');

    let host = options.root;
    if (typeof host === 'string') host = doc.querySelector(host);
    if (!host) host = doc.body;
    if (!host?.appendChild) throw new Error('TablePreferences needs a root element.');

    const priorInstance = host.__tablePreferencesInstance;
    if (priorInstance && typeof priorInstance.destroy === 'function') return priorInstance;

    const storage = OWN(options, 'storage') ? options.storage : safeLocalStorage(globalObject);
    const mediaMatcher = options.matchMedia || globalObject.matchMedia?.bind(globalObject);
    const systemReducedMotion = preferredReducedMotion(mediaMatcher);
    let preferences = readPreferences(storage, systemReducedMotion, options.storageKey || STORAGE_KEY);
    let audioContext = null;
    let lastTurnKey = null;
    let hasObservedState = false;
    let destroyed = false;
    let highlightRevision = 0;

    const priorClass = host.classList.contains('table-preferences-scope');
    const priorAttributes = Object.fromEntries(['data-card-size', 'data-text-size', 'data-reduce-motion', 'data-current-turn']
      .map(name => [name, host.hasAttribute(name) ? host.getAttribute(name) : null]));

    const element = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };

    const panel = element('section', 'table-preferences-panel');
    panel.dataset.tablePreferencesPanel = 'true';
    panel.setAttribute('aria-label', 'Tùy chọn bàn chơi');
    const turnBanner = element('p', 'table-preferences-turn', 'Đang chờ trạng thái bàn.');
    turnBanner.setAttribute('role', 'status');
    turnBanner.setAttribute('aria-live', 'polite');
    turnBanner.setAttribute('aria-atomic', 'true');
    panel.appendChild(turnBanner);

    const details = element('details', 'table-preferences-details');
    const summary = element('summary', '', 'Tùy chọn bàn chơi');
    details.appendChild(summary);
    const controls = element('div', 'table-preferences-controls');

    function selectField(legend, name, values, labels) {
      const label = element('label', 'table-preferences-field');
      const caption = element('span', '', legend);
      const select = element('select', 'table-preferences-select');
      select.name = name;
      select.setAttribute('autocomplete', 'off');
      values.forEach((value, index) => {
        const option = element('option', '', labels[index]);
        option.value = value;
        select.appendChild(option);
      });
      label.append(caption, select);
      return { label, control: select };
    }

    const cardField = selectField('Cỡ lá bài', 'cardSize', CARD_SIZES, ['Gọn', 'Vừa', 'Lớn']);
    const textField = selectField('Cỡ chữ', 'textSize', TEXT_SIZES, ['Mặc định', 'Lớn', 'Rất lớn']);
    controls.append(cardField.label, textField.label);

    const audioLabel = element('label', 'table-preferences-check');
    const audioInput = element('input');
    audioInput.type = 'checkbox';
    audioInput.name = 'audioEnabled';
    audioLabel.append(audioInput, element('span', '', 'Âm báo khi đến lượt tôi'));
    controls.appendChild(audioLabel);

    const motionLabel = element('label', 'table-preferences-check');
    const motionInput = element('input');
    motionInput.type = 'checkbox';
    motionInput.name = 'reduceMotion';
    motionLabel.append(motionInput, element('span', '', 'Giảm chuyển động'));
    controls.appendChild(motionLabel);

    const storageStatus = element('span', 'table-preferences-storage-status');
    storageStatus.setAttribute('role', 'status');
    storageStatus.setAttribute('aria-live', 'polite');
    controls.appendChild(storageStatus);
    details.appendChild(controls);
    panel.appendChild(details);

    function syncControls() {
      host.dataset.cardSize = preferences.cardSize;
      host.dataset.textSize = preferences.textSize;
      host.dataset.reduceMotion = String(preferences.reduceMotion);
      cardField.control.value = preferences.cardSize;
      textField.control.value = preferences.textSize;
      audioInput.checked = preferences.audioEnabled;
      motionInput.checked = preferences.reduceMotion;
    }

    function persistAndReport() {
      const saved = writePreferences(storage, preferences, options.storageKey || STORAGE_KEY);
      storageStatus.textContent = saved
        ? 'Tùy chọn đã lưu trên thiết bị này.'
        : 'Không lưu được bộ nhớ trình duyệt; tùy chọn vẫn dùng trong lượt này.';
    }

    function apply(name, value) {
      if (name === 'cardSize' && CARD_SIZES.includes(value)) preferences.cardSize = value;
      else if (name === 'textSize' && TEXT_SIZES.includes(value)) preferences.textSize = value;
      else if (name === 'audioEnabled' && typeof value === 'boolean') preferences.audioEnabled = value;
      else if (name === 'reduceMotion' && typeof value === 'boolean') preferences.reduceMotion = value;
      else return;
      syncControls();
      persistAndReport();
    }

    const audioContextFactory = options.audioContextFactory || (() => {
      const AudioContextType = globalObject.AudioContext || globalObject.webkitAudioContext;
      return AudioContextType ? new AudioContextType() : null;
    });

    function unlockAudioFromGesture(event) {
      if (!preferences.audioEnabled || event?.isTrusted !== true || destroyed) return;
      try {
        if (!audioContext) audioContext = audioContextFactory();
        if (audioContext?.state === 'suspended' && typeof audioContext.resume === 'function') {
          const resumeResult = audioContext.resume();
          if (resumeResult && typeof resumeResult.catch === 'function') resumeResult.catch(() => {});
        }
      } catch { audioContext = null; }
    }

    function playOwnTurnTone() {
      const context = audioContext;
      if (!preferences.audioEnabled || !context || context.state !== 'running') return;
      try {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(660, context.currentTime);
        gain.gain.setValueAtTime(0.0001, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(context.currentTime);
        oscillator.stop(context.currentTime + 0.17);
      } catch { /* Audio is optional; a device/browser may not support Web Audio. */ }
    }

    function announceStatus(status) {
      const messages = {
        waiting: 'Đang chờ người chơi bắt đầu ván.',
        finished: 'Ván đã kết thúc.',
        paused: 'Ván đang tạm dừng.',
        group: 'Đang chờ hành động theo trạng thái bàn.',
        mine: 'Đến lượt bạn.',
        other: name => name ? `Đến lượt ${name}.` : 'Đang đến lượt người chơi khác.',
        reaction: 'Đang có phản ứng cần xử lý.',
      };
      turnBanner.dataset.turn = status.kind;
      host.dataset.currentTurn = status.kind;
      turnBanner.textContent = typeof messages[status.kind] === 'function'
        ? messages[status.kind](status.playerName)
        : status.message || messages[status.kind] || 'Đang chờ trạng thái lượt.';
    }

    function highlightPlayer(ownerId, players) {
      const rows = [...host.querySelectorAll('.uno-player, #players > .player, [id^="seat-player-"]')];
      rows.forEach(row => {
        row.classList.remove('table-preferences-current-player');
        row.removeAttribute('data-table-preferences-current');
      });
      if (!ownerId) return;
      const byId = rows.find(row => row.dataset.playerId === ownerId || row.dataset.tablePlayerId === ownerId || row.id === `seat-player-${ownerId}`);
      const publicSeatIndex = Array.isArray(players) ? players.findIndex(player => player?.id === ownerId) : -1;
      const mappedRows = rows.filter(row => row.matches('.uno-player, #players > .player'));
      if (mappedRows.length === players?.length) {
        mappedRows.forEach((row, index) => { row.dataset.tablePlayerId = players[index]?.id || ''; });
      }
      const target = byId || (mappedRows.length === players?.length && publicSeatIndex >= 0 ? mappedRows[publicSeatIndex] : null)
        || doc.getElementById(`seat-player-${ownerId}`);
      if (!target || !host.contains(target)) return;
      target.classList.add('table-preferences-current-player');
      target.dataset.tablePreferencesCurrent = 'true';
    }

    host.classList.add('table-preferences-scope');
    let before = options.before;
    if (typeof before === 'string') before = host.querySelector(before);
    const gangMenu = host.id === 'screen-game' && host.querySelector('#table-tools-menu');
    const unoShell = host.id === 'screen-uno' && host.querySelector('.uno-shell');
    const nativeTools = host.classList.contains('thrill-table-view') && host.querySelector('.table-tools');
    let nativeMenu = null;
    if (gangMenu) {
      // The Gang reserves the full viewport for its toolbar, arena and hand.
      // Its existing utility menu keeps preferences from creating a fourth row.
      gangMenu.appendChild(panel);
    } else if (nativeTools) {
      nativeMenu = element('details', 'native-table-preferences-menu');
      nativeMenu.append(element('summary', '', 'Tùy chọn'), panel);
      nativeTools.appendChild(nativeMenu);
    } else if (unoShell && before && unoShell.contains(before)) {
      // The portal UNO screen is a flex container around one shell. Adding
      // another flex child would squeeze that shell beside the preferences.
      while (before.parentNode !== unoShell) before = before.parentNode;
      unoShell.insertBefore(panel, before);
    } else if (before && host.contains(before)) {
      // Native tables move their seats into an absolute-positioned stage.
      // Keep interactive preferences in the root flow, outside that stage.
      while (before.parentNode !== host) before = before.parentNode;
      host.insertBefore(panel, before);
    }
    else host.appendChild(panel);
    syncControls();

    const onCardChange = () => apply('cardSize', cardField.control.value);
    const onTextChange = () => apply('textSize', textField.control.value);
    const onAudioChange = event => {
      apply('audioEnabled', audioInput.checked);
      unlockAudioFromGesture(event);
    };
    const onMotionChange = () => apply('reduceMotion', motionInput.checked);
    cardField.control.addEventListener('change', onCardChange);
    textField.control.addEventListener('change', onTextChange);
    audioInput.addEventListener('change', onAudioChange);
    motionInput.addEventListener('change', onMotionChange);
    host.addEventListener('pointerdown', unlockAudioFromGesture, true);
    host.addEventListener('keydown', unlockAudioFromGesture, true);

    const instance = {
      getPreferences: () => ({ ...preferences }),
      updatePublicState(publicState) {
        if (destroyed) return;
        const status = getPublicTurnStatus(publicState);
        if (!status) return;
        announceStatus(status);
        const revision = ++highlightRevision;
        const markCurrentSeat = () => {
          if (!destroyed && revision === highlightRevision) highlightPlayer(status.ownerId, publicState.players);
        };
        if (typeof globalObject.queueMicrotask === 'function') globalObject.queueMicrotask(markCurrentSeat);
        else Promise.resolve().then(markCurrentSeat);
        const matchKey = typeof publicState.matchId === 'string' && publicState.matchId
          ? publicState.matchId
          : (typeof publicState.roomCode === 'string' ? publicState.roomCode : 'room');
        const turnKey = status.ownerId
          ? `${matchKey}:${status.ownerId}:${status.turnKey || status.kind}`
          : null;
        const nextIsNewOwnTurn = status.kind === 'mine' && status.isMine && turnKey !== lastTurnKey;
        if (hasObservedState && nextIsNewOwnTurn) playOwnTurnTone();
        lastTurnKey = turnKey;
        hasObservedState = true;
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        cardField.control.removeEventListener('change', onCardChange);
        textField.control.removeEventListener('change', onTextChange);
        audioInput.removeEventListener('change', onAudioChange);
        motionInput.removeEventListener('change', onMotionChange);
        host.removeEventListener('pointerdown', unlockAudioFromGesture, true);
        host.removeEventListener('keydown', unlockAudioFromGesture, true);
        panel.remove();
        nativeMenu?.remove();
        if (!priorClass) host.classList.remove('table-preferences-scope');
        for (const [name, value] of Object.entries(priorAttributes)) {
          if (value === null) host.removeAttribute(name);
          else host.setAttribute(name, value);
        }
        if (audioContext && typeof audioContext.close === 'function') {
          try { audioContext.close(); } catch {}
        }
        delete host.__tablePreferencesInstance;
      },
    };
    host.__tablePreferencesInstance = instance;
    return instance;
  }

  function updateTablePreferences(root, publicState, options = {}) {
    const doc = options.document || globalThis.document;
    let host = root;
    if (typeof host === 'string') host = doc?.querySelector(host);
    if (!host) return null;
    const instance = host.__tablePreferencesInstance || createTablePreferences({ ...options, root: host });
    instance.updatePublicState(publicState);
    return instance;
  }

  return Object.freeze({
    STORAGE_KEY,
    createTablePreferences,
    defaults,
    getPublicTurnStatus,
    inferUnoVariant,
    normalizePreferences,
    readPreferences,
    updateTablePreferences,
    writePreferences,
  });
});
