'use strict';

// Shared waiting-room presentation; move the original controls without replacing listeners.
(function roomShell() {
  const integrated = !!document.getElementById('screen-waiting');
  const room = integrated ? document.querySelector('.waiting-container') : document.getElementById('room-view');
  if (!room) return;
  room.classList.add('room-shell');
  const header = document.createElement('header'); header.className = 'room-shell-header';
  const title = document.createElement('div');
  if (integrated) title.append(document.querySelector('.waiting-header'));
  else {
    const heading = document.createElement('h2'); heading.textContent = document.title.split(' · ')[0];
    title.append(heading, room.querySelector('.eyebrow'));
  }
  const home = document.createElement('a'); home.href = '/'; home.className = 'room-home-link'; home.textContent = '← Sảnh game';
  header.append(title, home);
  const layout = document.createElement('div'); layout.className = 'room-shell-layout';
  const invite = document.createElement('aside'); invite.className = 'room-shell-invite';
  const members = document.createElement('section'); members.className = 'room-shell-members';
  const rules = document.createElement('section'); rules.className = 'room-shell-rules';
  if (integrated) {
    const status = document.createElement('p'); status.id = 'room-qr-status'; status.className = 'qr-status'; status.setAttribute('role', 'status');
    const retry = document.createElement('button'); retry.id = 'room-qr-retry'; retry.type = 'button'; retry.textContent = 'Tải lại QR'; retry.hidden = true;
    document.querySelector('.share-room-content > div').append(status, retry);
    retry.addEventListener('click', () => { document.getElementById('room-qr').removeAttribute('src'); loadShareAddresses(); });
    invite.append(document.querySelector('.room-code-banner'), document.querySelector('.share-room'));
    members.append(document.querySelector('.waiting-members-section'));
    rules.append(document.querySelector('.waiting-mode-info'), document.querySelector('.chat-mode-setting'));
    const controls = document.querySelector('.waiting-bottom-controls'); controls.classList.add('room-shell-actions');
    const help = document.createElement('button'); help.type = 'button'; help.className = 'room-help'; help.textContent = 'Hướng dẫn The Gang';
    help.addEventListener('click', () => document.getElementById('btn-tutorial').click());
    controls.querySelector('.room-tools').append(help);
    socket.on('game_state', next => { help.hidden = next.gameId !== 'the-gang'; });
    members.append(rules, controls);
  } else {
    const code = document.getElementById('room-title');
    const label = document.createElement('p'); label.className = 'room-kicker'; label.textContent = 'MÃ PHÒNG';
    invite.append(label, code, room.querySelector('.share'));
    const heading = document.createElement('h3'); heading.textContent = 'Người chơi';
    members.append(heading, document.getElementById('room-players'), document.getElementById('room-status'));
    for (const selector of ['.wallet-strip', '.buyin']) { const element = room.querySelector(selector); if (element) rules.append(element); }
    const controls = room.querySelector('.button-row'); controls.classList.add('room-shell-actions'); members.append(rules, controls);
    const share = invite.querySelector('.share > div');
    const link = document.createElement('a'); link.className = 'share-link';
    const addresses = document.createElement('select'); addresses.className = 'share-address'; addresses.setAttribute('aria-label', 'Địa chỉ máy chủ trong WiFi');
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Sao chép link';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'qr-retry'; retry.textContent = 'Tải lại QR'; retry.hidden = true;
    const status = document.createElement('p'); status.className = 'qr-status'; status.setAttribute('role', 'status');
    const metadata = document.createElement('p'); metadata.className = 'room-metadata'; invite.prepend(metadata);
    share.append(addresses, link, copy, retry, status);
    let codeValue = '', loadedCode = '', loadingCode = '', currentOrigin = location.origin, generation = 0, maxSeats = 0, memberCount = 0;
    const qr = invite.querySelector('#qr');
    function renderShare() {
      if (!codeValue) return;
      link.href = `${currentOrigin}/?room=${codeValue}`; link.textContent = link.href;
      // Avoid resetting image src on every ready/state message.
      const src = `/api/rooms/${codeValue}/qr?origin=${encodeURIComponent(currentOrigin)}`;
      if (qr.getAttribute('src') !== src) qr.src = src;
    }
    async function network(code) {
      loadingCode = code;
      const revision = ++generation;
      try {
        const response = await fetch('/api/network'); if (!response.ok) throw new Error();
        const payload = await response.json(); if (revision !== generation || code !== codeValue) return;
        const items = payload.addresses || [];
        if (!items.some(item => item.url === location.origin)) items.push({ name: 'Địa chỉ đang mở', url: location.origin, local: /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) });
        currentOrigin = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? items.find(item => !item.local)?.url || location.origin : location.origin;
        addresses.replaceChildren(...items.map(item => { const option = document.createElement('option'); option.value = item.url; option.textContent = `${item.name}: ${item.url}`; return option; }));
        addresses.value = currentOrigin;
      } catch { if (revision !== generation) return; currentOrigin = location.origin; addresses.replaceChildren(new Option('Địa chỉ đang mở', currentOrigin)); }
      loadedCode = code; loadingCode = ''; renderShare();
      try {
        const response = await fetch(`/api/rooms/${code}`), roomInfo = await response.json();
        if (code === codeValue && response.ok) {
          metadata.textContent = `${roomInfo.roomName} · ${roomInfo.requiresPassword ? '🔒 Có mật khẩu' : 'Không có mật khẩu'}`;
          maxSeats = roomInfo.maxPlayers; heading.textContent = `Người chơi (${memberCount}/${maxSeats})`;
        }
      } catch { /* Sharing and seating still work if metadata cannot refresh. */ }
    }
    addresses.addEventListener('change', () => { currentOrigin = addresses.value; renderShare(); });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link.href); status.textContent = 'Đã sao chép link.'; }
      catch { status.textContent = 'Chạm giữ đường dẫn để sao chép.'; }
    });
    qr.addEventListener('load', () => { retry.hidden = true; status.textContent = ''; });
    qr.addEventListener('error', () => { retry.hidden = false; status.textContent = 'Chưa tải được QR. Bạn vẫn có thể gửi mã hoặc link phòng.'; });
    retry.addEventListener('click', () => { qr.removeAttribute('src'); network(codeValue); });
    socket.on('game_state', next => {
      if (next.phase !== 'WAITING') return;
      if (codeValue !== next.roomCode) maxSeats = 0;
      codeValue = next.roomCode; memberCount = next.players.length;
      heading.textContent = `Người chơi (${memberCount}/${maxSeats || next.maxPlayers || { uno: 6, 'tien-len': 4, 'sam-loc': 5, phom: 4, poker: 6, bang: 7 }[next.gameId]})`;
      if (loadedCode !== codeValue && loadingCode !== codeValue) network(codeValue); else if (loadedCode === codeValue) renderShare();
    });
  }
  layout.append(invite, members); room.append(header, layout);
})();
