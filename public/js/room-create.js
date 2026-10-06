'use strict';

// Legacy game links use the same native room settings as the portal.
(function roomCreate() {
  const home = document.getElementById('home-view');
  if (!home) return;
  home.classList.add('room-create-shell');
  const gameId = location.pathname.replace(/\.html$/, '').split('/')[1];
  const stakePage = ['tien-len', 'sam-loc', 'phom'].includes(gameId);
  const create = document.getElementById('create');
  const settings = document.createElement('div'); settings.className = 'room-create-settings';
  settings.innerHTML = '<label>Tên phòng<input id="create-room-name" maxlength="32" autocomplete="off" placeholder="Bàn của bạn"></label><label>Quyền truy cập<select id="create-visibility"><option value="public">Công khai trong LAN</option><option value="invite">Chỉ qua lời mời</option></select></label><label>Mật khẩu 6 chữ số (tùy chọn)<input id="create-password" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" placeholder="Để trống nếu không dùng"></label>';

  let serverGame = null, stakeBounds = null, canSetCoinStake = false, catalogLoaded = !stakePage;
  let stakeLabel = null, stakeTitle = null, stakeField = null, stakeHint = null, stakeLimit = null;

  if (stakePage) {
    stakeLabel = document.createElement('label'); stakeLabel.id = 'create-stake-field';
    stakeTitle = document.createElement('span'); stakeTitle.textContent = 'Mức cược';
    stakeField = document.createElement('input'); stakeField.id = 'create-stake'; stakeField.type = 'text';
    stakeField.inputMode = 'text'; stakeField.maxLength = 24; stakeField.autocomplete = 'off';
    stakeField.placeholder = '500, 1.000, 10k, 10tr'; stakeField.disabled = true;
    stakeHint = document.createElement('small');
    stakeLimit = document.createElement('small'); stakeLimit.id = 'create-stake-limit'; stakeLimit.setAttribute('role', 'status');
    stakeLimit.textContent = 'Đang tải thông tin mức cược…';
    stakeLabel.append(stakeTitle, stakeField, stakeHint, stakeLimit);
    settings.prepend(stakeLabel);
  }

  create.before(settings); create.textContent = 'Tạo phòng';
  const name = document.getElementById('name'); name.value = GameValues.readName();
  name.addEventListener('change', () => { name.value = GameValues.cleanDisplayName(name.value); GameValues.writeName(name.value); });

  function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
  function limitsFromCatalog(game) {
    const rules = game?.stakeRules;
    const capacity = positiveInteger(rules?.maxPlayers) ? rules.maxPlayers : game?.maxPlayers;
    const limits = Number.isInteger(capacity) ? rules?.limitsByPlayerCount?.[String(capacity)] : null;
    const minStake = rules?.minStake, maxStake = limits?.maxStake;
    if (rules?.currency !== game?.currency || !positiveInteger(minStake) || !positiveInteger(maxStake) || maxStake < minStake) return null;
    return { currency: rules.currency, minStake, maxStake, capacity };
  }
  function amountOptions() { return stakeBounds ? { min: stakeBounds.minStake, max: stakeBounds.maxStake } : undefined; }
  function parseStake() { return GameValues.parseAmount(stakeField.value, amountOptions()); }
  function validateStake(normalize = false) {
    try {
      const amount = parseStake();
      stakeField.setCustomValidity('');
      if (normalize) stakeField.value = GameValues.formatAmount(amount);
      return amount;
    } catch (error) {
      stakeField.setCustomValidity(error.message);
      return null;
    }
  }

  if (stakePage) {
    stakeField.addEventListener('input', () => validateStake());
    stakeField.addEventListener('blur', () => validateStake(true));
    loadStakeCatalog();
  }

  async function loadStakeCatalog() {
    try {
      const response = await fetch('/api/registry');
      if (!response.ok) throw new Error('Không tải được danh mục game.');
      const catalog = await response.json();
      serverGame = catalog.games?.find(game => game.gameId === gameId) || null;
      if (!serverGame) throw new Error('Không tìm thấy cấu hình game trên máy chủ.');
      catalogLoaded = true;
      if (serverGame.currency !== 'coin') {
        stakeLimit.textContent = 'Đơn vị cược chưa được xác nhận. Tải lại trang để thử lại.';
        return;
      }

      canSetCoinStake = true;
      stakeLabel.hidden = false; stakeField.disabled = false;
      stakeTitle.textContent = `Mức cược ${serverGame.currency}`;
      stakeHint.textContent = serverGame.currency === 'coin' ? 'k = 1.000 · tr = 1.000.000 coin' : '';
      home.querySelector('.lead').textContent = 'Chọn mức cược cho bàn. Mức giữ hiển thị tại phòng chờ.';

      stakeBounds = limitsFromCatalog(serverGame);
      if (stakeBounds) {
        stakeField.min = String(stakeBounds.minStake); stakeField.max = String(stakeBounds.maxStake);
        stakeLimit.textContent = `Mức cược: ${GameValues.formatAmount(stakeBounds.minStake)}–${GameValues.formatAmount(stakeBounds.maxStake)} ${stakeBounds.currency} · bàn tối đa ${stakeBounds.capacity} người.`;
      } else {
        stakeField.removeAttribute('min'); stakeField.removeAttribute('max');
        stakeLimit.textContent = 'Giới hạn cược đang chờ cập nhật; máy chủ sẽ kiểm tra khi tạo phòng.';
      }

      const defaultStake = serverGame.stakeRules?.defaultStake ?? serverGame.stake;
      if (positiveInteger(defaultStake) && (!stakeBounds || (defaultStake >= stakeBounds.minStake && defaultStake <= stakeBounds.maxStake))) {
        stakeField.value = GameValues.formatAmount(defaultStake);
      } else {
        stakeField.value = '';
        if (stakeBounds) stakeLimit.textContent += ' Chọn mức cược trong giới hạn.';
      }
      validateStake();
    } catch {
      catalogLoaded = false;
      canSetCoinStake = false;
      stakeBounds = null;
      stakeField.disabled = true;
      stakeLimit.textContent = 'Chưa tải được thông tin mức cược. Tải lại trang để tiếp tục.';
    }
  }

  const emit = socket.emit.bind(socket);
  socket.emit = function (event, data, ...rest) {
    if (event === 'create_room') {
      const password = document.getElementById('create-password').value;
      if (password && !/^\d{6}$/.test(password)) { document.getElementById('notice').textContent = 'Mật khẩu cần đúng 6 chữ số, hoặc để trống.'; return socket; }
      let stake;
      if (stakePage) {
        if (!catalogLoaded) { document.getElementById('notice').textContent = 'Đang tải giới hạn cược. Thử lại sau ít giây.'; return socket; }
        if (!canSetCoinStake) { document.getElementById('notice').textContent = 'Chưa xác nhận được đơn vị cược của phòng.'; return socket; }
        try { stake = parseStake(); }
        catch (error) { stakeField.setCustomValidity(error.message); document.getElementById('notice').textContent = error.message; stakeField.focus(); return socket; }
      }
      data = { ...data, config: { ...data.config, roomName: document.getElementById('create-room-name').value.trim(), visibility: document.getElementById('create-visibility').value, password, ...(canSetCoinStake ? { stake } : {}) } };
    }
    if (['create_room', 'join_room'].includes(event)) { data.playerName = GameValues.cleanDisplayName(data.playerName); GameValues.writeName(data.playerName); }
    return emit(event, data, ...rest);
  };

  socket.on('game_state', state => {
    if (!stakePage || state.gameId !== gameId) return;
    const economy = GameValues.readEconomy(state);
    GameValues.applyEconomy(state, document);
    const caption = document.querySelector('#room-view .eyebrow');
    if (caption) caption.textContent = GameValues.describeEconomy(state).toLocaleUpperCase('vi-VN');
    const start = document.getElementById('start');
    if (start) start.textContent = economy.maxLoss === null
      ? `Bắt đầu · ${economy.stake === null ? 'mức giữ chưa xác nhận' : `cược ${GameValues.formatAmount(economy.stake)} ${economy.currency || ''}/người`}`
      : `Bắt đầu · giữ ${GameValues.formatAmount(economy.maxLoss)} ${economy.currency}/người`;
  });
})();
