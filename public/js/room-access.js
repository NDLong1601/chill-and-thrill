'use strict';

// One real input supports native keyboards, paste, autofill and six OTP cells.
(function roomAccess() {
  const dialog = document.createElement('dialog');
  dialog.className = 'room-password-dialog';
  dialog.setAttribute('aria-labelledby', 'room-password-title');
  dialog.innerHTML = `<form class="room-password-form">
    <button type="button" class="password-close" aria-label="Đóng">✕</button>
    <p class="room-kicker">PHÒNG RIÊNG</p><h2 id="room-password-title">Nhập mật khẩu phòng</h2>
    <p class="password-room-label"></p>
    <label for="portal-room-password">Mật khẩu 6 chữ số</label>
    <div class="passcode-field"><div class="passcode-cells" aria-hidden="true">${'<span></span>'.repeat(6)}</div>
    <input id="portal-room-password" type="password" inputmode="numeric" maxlength="6" autocomplete="off" pattern="[0-9]{6}" aria-describedby="room-password-error" required></div>
    <p id="room-password-error" role="alert"></p>
    <button type="submit" class="password-submit">Vào phòng</button>
    <button type="button" class="password-legacy">Dùng mật khẩu dạng chữ của phòng cũ</button>
  </form>`;
  document.body.append(dialog);
  const input = dialog.querySelector('input'), form = dialog.querySelector('form');
  const error = dialog.querySelector('#room-password-error'), submit = dialog.querySelector('[type=submit]');
  let pending = null, legacy = false, submitting = false;
  function paint() {
    if (!legacy) input.value = input.value.replace(/\D/g, '').slice(0, 6);
    dialog.querySelectorAll('.passcode-cells span').forEach((cell, index) => {
      cell.textContent = index < input.value.length ? '●' : '';
      cell.classList.toggle('is-current', index === input.value.length);
    });
  }
  function close() { dialog.close(); pending = null; input.value = ''; submitting = false; }
  function fail(message) {
    submitting = false; submit.disabled = false;
    error.textContent = message || 'Không vào được phòng. Thử lại.';
    input.setAttribute('aria-invalid', 'true');
  }
  dialog.querySelector('.password-close').addEventListener('click', close);
  dialog.addEventListener('cancel', () => { pending = null; input.value = ''; submitting = false; });
  dialog.addEventListener('close', () => { input.value = ''; paint(); });
  input.addEventListener('input', () => { error.textContent = ''; input.removeAttribute('aria-invalid'); paint(); });
  dialog.querySelector('.password-legacy').addEventListener('click', () => {
    legacy = !legacy; dialog.classList.toggle('legacy-password', legacy);
    input.value = ''; input.maxLength = legacy ? 64 : 6; input.inputMode = legacy ? 'text' : 'numeric';
    if (legacy) input.removeAttribute('pattern'); else input.pattern = '[0-9]{6}';
    dialog.querySelector('label').textContent = legacy ? 'Mật khẩu phòng cũ' : 'Mật khẩu 6 chữ số';
    dialog.querySelector('.password-legacy').textContent = legacy ? 'Dùng mật khẩu 6 chữ số' : 'Dùng mật khẩu dạng chữ của phòng cũ';
    error.textContent = ''; paint(); input.focus();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || !pending) return;
    if (!legacy && !/^\d{6}$/.test(input.value)) return fail('Nhập đủ 6 chữ số.');
    submitting = true; setTimeout(() => { if (submitting) submit.disabled = true; }, 0);
    try { await pending.submit(input.value); } catch (cause) { fail(cause.message); }
  });
  window.RoomAccess = {
    prompt(code, onSubmit) {
      pending = { code, submit: onSubmit }; legacy = false; submitting = false;
      dialog.classList.remove('legacy-password'); input.value = ''; input.maxLength = 6; input.inputMode = 'numeric'; input.pattern = '[0-9]{6}';
      dialog.querySelector('label').textContent = 'Mật khẩu 6 chữ số';
      dialog.querySelector('.password-legacy').textContent = 'Dùng mật khẩu dạng chữ của phòng cũ';
      dialog.querySelector('.password-room-label').textContent = `Phòng ${code} có mật khẩu. Chạm vào ô bên dưới để nhập.`;
      error.textContent = ''; input.removeAttribute('aria-invalid'); submit.disabled = false; paint();
      if (!dialog.open) dialog.showModal();
    },
    fail(message) { if (dialog.open) fail(message); },
    close,
    get open() { return dialog.open; }
  };
  // Legacy direct table links use the same protected-room prompt as the portal.
  if (document.getElementById('home-view') && typeof socket !== 'undefined') {
    const emit = socket.emit.bind(socket);
    socket.emit = function(event, data, ...rest) {
      if (event !== 'join_room' || data?.password) return emit(event, data, ...rest);
      const code = String(data?.roomCode || '').trim().toUpperCase();
      if (!/^[A-Z2-9]{4}$/.test(code)) return emit(event, data, ...rest);
      fetch(`/api/rooms/${code}`).then(response => response.ok ? response.json() : null).then(room => {
        const expectedGame = location.pathname.replace(/\.html$/, '').split('/')[1];
        if (room && (room.gameId !== expectedGame || room.variant === 'classic-local-v1')) {
          try { GameValues.writeName(data.playerName); } catch {}
          location.assign(`/?room=${code}`); return;
        }
        if (room?.requiresPassword) RoomAccess.prompt(code, password => emit(event, { ...data, password }, ...rest));
        else emit(event, data, ...rest);
      }).catch(() => { const notice = document.getElementById('notice'); if (notice) notice.textContent = 'Không kết nối được máy chủ. Thử lại.'; });
      return socket;
    };
  }
  if (typeof socket !== 'undefined') {
    socket.on('join_error', result => RoomAccess.fail(result?.message));
    for (const event of ['room_joined', 'room_resumed']) socket.on(event, () => { if (dialog.open) close(); });
  }
})();
