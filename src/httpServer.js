'use strict';

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { QUICK_CHAT } = require('./gameEngine');
const { GAME_MODES, CHALLENGES, SPECIALISTS } = require('./cardsData');
const { MultiGameManager } = require('./platform/multiGameManager');
const { publicGames, publicCatalog, PORTAL_NAME } = require('./platform/gameRegistry');

function networkUrls(port) {
  const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, list]) => list
    .filter(net => net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.'))
    .map(net => ({ name, url: `http://${net.address}:${port}`, local: false })));
  addresses.sort((a, b) => Number(/virtual|vmware|vbox|docker|wsl|vpn|tailscale/i.test(a.name)) - Number(/virtual|vmware|vbox|docker|wsl|vpn|tailscale/i.test(b.name)));
  return [...addresses, { name: 'Máy chủ', url: `http://localhost:${port}`, local: true }];
}

function createGameServer(options = {}) {
  const app = express(), server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 16384 });
  const gm = new MultiGameManager(io, { storageFile: options.storageFile, unoStorageFile: options.unoStorageFile, tienLenStorageFile: options.tienLenStorageFile, pokerStorageFile: options.pokerStorageFile, samLocStorageFile: options.samLocStorageFile, phomStorageFile: options.phomStorageFile, bangStorageFile: options.bangStorageFile, databaseFile: options.databaseFile, graceMs: options.graceMs });
  const roomService = gm.roomService;
  const profiles = roomService.profileService;
  const port = () => server.address()?.port || Number(process.env.PORT) || 3000;
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/uno', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'uno.html')));
  app.get('/profile', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'profile.html')));
  app.get('/tien-len', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'tien-len.html')));
  app.get('/poker', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'poker.html')));
  app.get('/sam-loc', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'sam-loc.html')));
  app.get('/phom', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'phom.html')));
  app.get('/bang', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'bang.html')));
  app.get('/docs/rules/tien-len.md', (_req, res) => res.sendFile(path.join(__dirname, '..', 'docs', 'rules', 'tien-len.md')));
  app.get('/docs/rules/poker.md', (_req, res) => res.sendFile(path.join(__dirname, '..', 'docs', 'rules', 'poker.md')));
  app.get('/docs/rules/sam-loc.md', (_req, res) => res.sendFile(path.join(__dirname, '..', 'docs', 'rules', 'sam-loc.md')));
  app.get('/docs/rules/phom.md', (_req, res) => res.sendFile(path.join(__dirname, '..', 'docs', 'rules', 'phom.md')));
  app.get('/docs/rules/bang.md', (_req, res) => res.sendFile(path.join(__dirname, '..', 'docs', 'rules', 'bang.md')));
  app.get('/api/rules', (_req, res) => res.json({ modes: GAME_MODES, challenges: CHALLENGES, specialists: SPECIALISTS, quickChat: QUICK_CHAT }));
  app.get('/api/games', (_req, res) => res.json({ games: publicGames() }));
  app.get('/api/registry', (_req, res) => res.json(publicCatalog()));
  app.get('/api/rooms', (_req, res) => res.json({ rooms: gm.publicRooms() }));
  app.get('/api/rooms/:code', (req, res) => {
    const room = gm.publicRoom(req.params.code.toUpperCase());
    return room ? res.json({ ...room, portalName: PORTAL_NAME }) : res.status(404).json({ error: 'Không tìm thấy phòng.' });
  });
  const profileTokenFrom = req => {
    const header = req.get('x-profile-token') || req.get('authorization') || '';
    return header.startsWith('Bearer ') ? header.slice(7) : header;
  };
  app.post('/api/profile', (req, res) => {
    try {
      const created = profiles.createProfile(req.body?.name, req.body?.avatar);
      return res.status(201).json({ ...profiles.profilePayload(created.rawToken), profileToken: created.rawToken, recoveryCode: created.recoveryCode });
    } catch (error) { return res.status(400).json({ error: error.message, code: error.code }); }
  });
  app.get('/api/profile', (req, res) => {
    try { return res.json(profiles.profilePayload(profileTokenFrom(req))); }
    catch (error) { return res.status(401).json({ error: error.message, code: error.code }); }
  });
  app.patch('/api/profile', (req, res) => {
    try { return res.json(profiles.updateProfile(profileTokenFrom(req), req.body || {})); }
    catch (error) { return res.status(error.code === 'PROFILE_UNAUTHORIZED' ? 401 : 400).json({ error: error.message, code: error.code }); }
  });
  app.get('/api/missions', (req, res) => {
    try { return res.json(profiles.missionPayload(profileTokenFrom(req))); }
    catch (error) { return res.status(401).json({ error: error.message, code: error.code }); }
  });
  app.post('/api/missions/:id/claim', (req, res) => {
    try { return res.json(profiles.claimMission(profileTokenFrom(req), { missionId: req.params.id, version: Number(req.body?.version || 1), periodKey: req.body?.periodKey })); }
    catch (error) { return res.status(error.code === 'PROFILE_UNAUTHORIZED' ? 401 : 409).json({ error: error.message, code: error.code }); }
  });
  app.get('/api/storage/status', (_req, res) => res.json({ scope: 'local-server', database: profiles.store.file === ':memory:' ? 'memory' : 'sqlite',
    schemaVersion: profiles.store.schemaVersion(), integrity: profiles.store.integrityCheck(), error: gm.gang.storageError ? 'Có lỗi lưu trữ; dữ liệu được giữ nguyên.' : null }));
  app.get('/docs/rules/uno-classic.md', (_req, res) => res.sendFile(path.join(__dirname, '..', 'docs', 'rules', 'uno-classic.md')));
  app.get('/docs/rules/uno.md', (_req, res) => res.sendFile(path.join(__dirname, '..', 'docs', 'rules', 'uno.md')));
  app.get('/api/network', (_req, res) => res.json({ addresses: networkUrls(port()) }));
  app.get('/api/rooms/:code/qr', async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!gm.hasRoom(code)) return res.status(404).json({ error: 'Phòng không còn tồn tại.' });
    const addresses = networkUrls(port());
    const allowed = [...addresses.map(a => a.url), `http://127.0.0.1:${port()}`];
    const requested = req.query.origin;
    if (requested && !allowed.includes(requested)) return res.status(400).json({ error: 'Địa chỉ chia sẻ không hợp lệ.' });
    const origin = requested || addresses[0].url;
    try {
      const roomPath = gm.publicRoom(code)?.requiresPassword ? '/' : gm.managerForCode(code) === gm.gang ? '/' : gm.gameIdForRoom(code) === 'uno' ? '/uno' : gm.gameIdForRoom(code) === 'tien-len' ? '/tien-len' : gm.gameIdForRoom(code) === 'poker' ? '/poker' : gm.gameIdForRoom(code) === 'sam-loc' ? '/sam-loc' : gm.gameIdForRoom(code) === 'phom' ? '/phom' : gm.gameIdForRoom(code) === 'bang' ? '/bang' : '/';
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(await QRCode.toString(`${origin}${roomPath}?room=${code}`, { type: 'svg', margin: 2, width: 220, errorCorrectionLevel: 'M' }));
    } catch { res.status(500).json({ error: 'Không tạo được mã QR.' }); }
  });

  io.on('connection', socket => {
    const profileToken = typeof socket.handshake.auth?.profileToken === 'string' ? socket.handshake.auth.profileToken : null;
    if (profileToken) {
      const identity = gm.authenticateProfile(socket, profileToken);
      if (!identity.error) socket.emit('profile_state', identity);
    }
    let startedAt = Date.now(), count = 0;
    const emitProfile = result => { if (result?.profile) socket.emit('profile_state', result); };
    function bindRequestProfile(data) {
      if (data.profileToken) {
        const result = gm.authenticateProfile(socket, data.profileToken);
        if (result.error) throw new Error(result.error);
      }
    }
    function on(event, handler) {
      socket.on(event, (data = {}, ack) => {
        if (Date.now() - startedAt > 10000) { startedAt = Date.now(); count = 0; }
        if (++count > 100) return gm.error(socket, 'Bạn đang thao tác quá nhanh. Chờ vài giây nhé.');
        if (!data || typeof data !== 'object' || Array.isArray(data)) return gm.error(socket, 'Dữ liệu thao tác không hợp lệ.');
        try { handler(data, typeof ack === 'function' ? ack : () => {}); }
        catch (error) { console.error(`Lỗi ${event}:`, error.message); if (typeof ack === 'function') ack({ error: 'Không thực hiện được thao tác. Vui lòng thử lại.' }); gm.error(socket, 'Không thực hiện được thao tác. Vui lòng thử lại.'); }
      });
    }
    for (const [event, method, response] of [['create_room', 'createRoom', 'room_created'], ['join_room', 'joinRoom', 'room_joined'], ['resume_room', 'resumeRoom', 'room_resumed']]) {
      on(event, (d, ack) => {
        bindRequestProfile(d);
        const code = typeof d.roomCode === 'string' ? d.roomCode.trim().toUpperCase() : '';
        const result = method === 'createRoom' ? gm[method](socket, d.playerName, d.modeId, d.avatar, d.gameId, { ...d.config, roomName: d.roomName, maxPlayers: d.maxPlayers, visibility: d.visibility, password: d.password })
          : method === 'joinRoom' ? gm[method](socket, code, d.playerName, d.avatar, d.password) : gm[method](socket, code, d.sessionToken);
        ack(result);
        emitProfile(result);
        if (result.error) socket.emit(event === 'resume_room' ? 'resume_error' : 'join_error', { message: result.error });
        else { socket.emit(response, result); gm.broadcast(result.roomCode); }
      });
    }
    for (const [event, response] of [['room:create', 'room:created'], ['room:join', 'room:joined'], ['room:resume', 'room:resumed']]) on(event, (d, ack) => {
      let result;
      try {
        bindRequestProfile(d);
        const code = typeof d.roomCode === 'string' ? d.roomCode.trim().toUpperCase() : '';
        if (event === 'room:create') result = gm.createRoom(socket, d.playerName, d.difficulty || 'ADVANCED', d.avatar, d.gameId || 'the-gang',
          { ...d.config, variant: d.gameId === 'uno' ? d.config?.variant || 'classic-local-v1' : d.variant });
        else if (event === 'room:join') result = gm.joinRoom(socket, code, d.playerName, d.avatar, d.password);
        else result = gm.resumeRoom(socket, code, d.sessionToken);
      } catch (error) { result = { error: error.message }; }
      ack(result);
      if (result?.error) return socket.emit('room:error', { message: result.error });
      emitProfile(result);
      socket.emit(response, result);
      socket.emit(event === 'room:create' ? 'room_created' : event === 'room:join' ? 'room_joined' : 'room_resumed', result);
      gm.broadcast(result.roomCode);
    });
    on('room:ready', (d, ack) => { const result = gm.setReady(socket, d.roomCode, Boolean(d.ready)); ack({ ok: !result?.error }); });
    on('game:action', (d, ack) => {
      const result = roomService.handleGameAction(socket, d);
      ack(result); socket.emit('game:action_result', result);
    });
    on('game:request_state', (d, ack) => { const result = roomService.requestGameState(socket, d.roomCode); ack(result); if (result.ok) socket.emit('game_state', result.state); });
    const gang = (method, ...args) => d => gm.gangAction(method, socket, d.roomCode, ...args.map(arg => arg(d)));
    const handlers = {
      change_mode: gang('changeMode', d => d.modeId), set_avatar: gang('setAvatar', d => d.avatar),
      set_ready: d => gm.setReady(socket, d.roomCode, d.ready), set_chat_mode: gang('setChatMode', d => d.strict),
      start_game: d => gm.startGame(socket, d.roomCode), claim_chip: gang('claimChip', d => d.chipNumber, d => d.phaseKey),
      return_chip: gang('returnChip', d => d.phaseKey), snatch_chip: gang('snatchChip', d => d.targetId, d => d.phaseKey),
      confirm_round: gang('confirmRound', d => d.confirmed, d => d.phaseKey), advance_phase: gang('advancePhase', d => d.phaseKey),
      specialist_action: gang('specialistAction', d => d, d => d.phaseKey), submit_guess: gang('submitGuess', d => d, d => d.phaseKey),
      reveal_next: gang('revealNext', d => d.phaseKey, d => d.expectedCount), next_heist: gang('nextHeist'),
      play_again: gang('playAgain'), return_to_lobby: gang('returnToLobby'),
      leave_room: d => gm.leaveRoom(socket, d.roomCode), remove_player: gang('removePlayer', d => d.targetId),
      transfer_host: gang('transferHost', d => d.targetId), set_paused: gang('setPaused', d => d.paused),
      send_chat: gang('sendChat', d => d.text), send_emote: gang('sendEmote', d => d),
      game_action: d => gm.gameAction(socket, d.roomCode, d),
      sync_state: d => gm.syncState(socket, d.roomCode),
      profile_status: (_d, ack) => { const result = gm.profilePayload(socket); ack(result || { profile: null }); emitProfile(result); },
      profile_bootstrap: (d, ack) => { const result = gm.bootstrapProfile(socket, d.playerName, d.avatar); ack(result); emitProfile(result); },
      profile_update: (d, ack) => { const result = gm.updateProfile(socket, d.playerName, d.avatar); ack(result); emitProfile(result); },
      profile_recover: (d, ack) => { const result = gm.recoverProfile(socket, d.profileId, d.recoveryCode); ack(result); emitProfile(result); },
      claim_mission: (d, ack) => { const result = gm.claimMission(socket, d.missionId, d.version); ack(result); emitProfile(result); },
    };
    Object.entries(handlers).forEach(([event, handler]) => on(event, handler));
    socket.on('disconnect', () => gm.handleDisconnect(socket));
  });
  app.get(['/', '/play/:category', '/games/:gameId', '/rooms/:code', '/missions'], (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
  return { app, server, io, gm, roomService, close: () => new Promise(resolve => { io.close(() => { gm.close(); resolve(); }); }) };
}

module.exports = { createGameServer, networkUrls };
