'use strict';

const express = require('express');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { GameManager, QUICK_CHAT } = require('./gameEngine');
const { GAME_MODES, CHALLENGES, SPECIALISTS } = require('./cardsData');

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
  const gm = new GameManager(io, { storageFile: options.storageFile, graceMs: options.graceMs });
  const port = () => server.address()?.port || Number(process.env.PORT) || 3000;
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/api/rules', (_req, res) => res.json({ modes: GAME_MODES, challenges: CHALLENGES, specialists: SPECIALISTS, quickChat: QUICK_CHAT }));
  app.get('/api/network', (_req, res) => res.json({ addresses: networkUrls(port()) }));
  app.get('/api/rooms/:code/qr', async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!gm.rooms.has(code)) return res.status(404).json({ error: 'Phòng không còn tồn tại.' });
    const addresses = networkUrls(port());
    const allowed = [...addresses.map(a => a.url), `http://127.0.0.1:${port()}`];
    const requested = req.query.origin;
    if (requested && !allowed.includes(requested)) return res.status(400).json({ error: 'Địa chỉ chia sẻ không hợp lệ.' });
    const origin = requested || addresses[0].url;
    try {
      res.type('image/svg+xml').set('Cache-Control', 'no-store').send(await QRCode.toString(`${origin}/?room=${code}`, { type: 'svg', margin: 2, width: 220, errorCorrectionLevel: 'M' }));
    } catch { res.status(500).json({ error: 'Không tạo được mã QR.' }); }
  });

  io.on('connection', socket => {
    let startedAt = Date.now(), count = 0;
    function on(event, handler) {
      socket.on(event, (data = {}, ack) => {
        if (Date.now() - startedAt > 10000) { startedAt = Date.now(); count = 0; }
        if (++count > 100) return gm.error(socket, 'Bạn đang thao tác quá nhanh. Chờ vài giây nhé.');
        if (!data || typeof data !== 'object' || Array.isArray(data)) return gm.error(socket, 'Dữ liệu thao tác không hợp lệ.');
        try { handler(data, typeof ack === 'function' ? ack : () => {}); }
        catch (error) { console.error(`Lỗi ${event}:`, error.message); gm.error(socket, 'Không thực hiện được thao tác. Vui lòng thử lại.'); }
      });
    }
    for (const [event, method, response] of [['create_room', 'createRoom', 'room_created'], ['join_room', 'joinRoom', 'room_joined'], ['resume_room', 'resumeRoom', 'room_resumed']]) {
      on(event, (d, ack) => {
        const code = typeof d.roomCode === 'string' ? d.roomCode.trim().toUpperCase() : '';
        const result = method === 'createRoom' ? gm[method](socket, d.playerName, d.modeId, d.avatar)
          : method === 'joinRoom' ? gm[method](socket, code, d.playerName, d.avatar) : gm[method](socket, code, d.sessionToken);
        ack(result);
        if (result.error) socket.emit(event === 'resume_room' ? 'resume_error' : 'join_error', { message: result.error });
        else { socket.emit(response, result); gm.broadcast(result.roomCode); }
      });
    }
    const handlers = {
      change_mode: d => gm.changeMode(socket, d.roomCode, d.modeId), set_avatar: d => gm.setAvatar(socket, d.roomCode, d.avatar),
      set_ready: d => gm.setReady(socket, d.roomCode, d.ready), set_chat_mode: d => gm.setChatMode(socket, d.roomCode, d.strict),
      start_game: d => gm.startGame(socket, d.roomCode), claim_chip: d => gm.claimChip(socket, d.roomCode, d.chipNumber, d.phaseKey),
      return_chip: d => gm.returnChip(socket, d.roomCode, d.phaseKey), snatch_chip: d => gm.snatchChip(socket, d.roomCode, d.targetId, d.phaseKey),
      confirm_round: d => gm.confirmRound(socket, d.roomCode, d.confirmed, d.phaseKey), advance_phase: d => gm.advancePhase(socket, d.roomCode, d.phaseKey),
      specialist_action: d => gm.specialistAction(socket, d.roomCode, d, d.phaseKey), submit_guess: d => gm.submitGuess(socket, d.roomCode, d, d.phaseKey),
      reveal_next: d => gm.revealNext(socket, d.roomCode, d.phaseKey, d.expectedCount), next_heist: d => gm.nextHeist(socket, d.roomCode),
      play_again: d => gm.playAgain(socket, d.roomCode), return_to_lobby: d => gm.returnToLobby(socket, d.roomCode),
      leave_room: d => gm.leaveRoom(socket, d.roomCode), remove_player: d => gm.removePlayer(socket, d.roomCode, d.targetId),
      transfer_host: d => gm.transferHost(socket, d.roomCode, d.targetId), set_paused: d => gm.setPaused(socket, d.roomCode, d.paused),
      send_chat: d => gm.sendChat(socket, d.roomCode, d.text), send_emote: d => gm.sendEmote(socket, d.roomCode, d),
      sync_state: d => { const ctx = gm.access(socket, d.roomCode); if (ctx) socket.emit('game_state', gm.buildStateFor(ctx.room, ctx.player.id)); }
    };
    Object.entries(handlers).forEach(([event, handler]) => on(event, handler));
    socket.on('disconnect', () => gm.handleDisconnect(socket));
  });
  return { app, server, io, gm, close: () => new Promise(resolve => { io.close(() => { gm.close(); resolve(); }); }) };
}

module.exports = { createGameServer, networkUrls };
