'use strict';

// Keep the portal's Continue button in sync with the existing standalone tables.
(function gameSession() {
  const gameId = location.pathname.replace(/\.html$/, '').split('/').filter(Boolean)[0];
  if (!['uno', 'tien-len', 'poker', 'sam-loc', 'phom', 'bang'].includes(gameId)) return;
  let activeCode = new URLSearchParams(location.search).get('room');
  const read = (storage, key) => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };
  for (const event of ['room_created', 'room_joined', 'room_resumed']) socket.on(event, data => {
    activeCode = data.roomCode;
    localStorage.setItem('chill-thrill:last-room', JSON.stringify({ ...data, gameId, entryPath: `/${gameId}` }));
  });
  socket.on('profile_state', data => { if (data.profileToken) socket.auth = { profileToken: data.profileToken }; });
  socket.on('room_left', () => {
    const last = read(localStorage, 'chill-thrill:last-room');
    if (last?.roomCode === activeCode) localStorage.removeItem('chill-thrill:last-room');
    const portal = read(sessionStorage, 'gang.session');
    if (portal?.roomCode === activeCode) sessionStorage.removeItem('gang.session');
    localStorage.removeItem(`chill-thrill:${gameId}:${activeCode}`);
    activeCode = null;
    history.replaceState(null, '', `/${gameId}`);
  });
})();
