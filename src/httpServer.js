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
const { STARTING_COINS } = require('./platform/currencies');
const { quoteCurrencyExchange } = require('./platform/currencyQuote');
const { TutorialService, TUTORIAL_VERSION } = require('./platform/tutorialService');
const { ProfileStore } = require('./platform/profileStore');
const { StorageDiagnostics } = require('./platform/storageDiagnostics');
const { summarizeHeldReservations } = require('./platform/heldAuditSummary');
const { PracticeService } = require('./platform/practiceService');
const { attachPracticeRoutes } = require('./platform/practiceRoutes');
const { AdminService } = require('./platform/adminService');
const { createAdminRouter } = require('./platform/adminRouter');
const { attachSpectatorSupport } = require('./platform/spectatorService');
const { attachGroupTournamentSupport } = require('./platform/groupTournamentSupport');
const { GroupLobbyService, targetAdaptersFromManager, managerSwitchLifecycle } = require('./platform/groupLobbyService');
const { createGroupLobbyRouter, createProfileServiceResolver } = require('./platform/groupLobbyRouter');
const tutorialContent = require('../public/js/tutorial-content');

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
  const databaseFile = options.databaseFile || (options.storageFile ? `${options.storageFile}.profiles.sqlite` : ':memory:');
  const databaseKind = databaseFile === ':memory:' ? 'memory' : 'sqlite';
  const storageFixture = options.storageDiagnosticsFixture === true || (databaseKind === 'memory' && options.storageDiagnosticsFixture !== false);
  const persisted = databaseKind === 'sqlite';
  const diagnostics = new StorageDiagnostics({ database: { kind: databaseKind, fixture: storageFixture, integrity: 'unknown' }, heldAudit: { state: 'unavailable' } });
  diagnostics.registerSource({ id: 'profile-store', kind: 'sqlite-profile-ledger', mode: persisted ? 'persisted' : 'memory', authority: 'authoritative', fixture: storageFixture });
  for (const gameId of ['tien-len', 'poker', 'sam-loc', 'phom']) diagnostics.registerSource({
    id: `snapshot:${gameId}`, gameId, kind: 'sqlite-room-snapshot', mode: persisted ? 'persisted' : 'memory', authority: 'authoritative', fixture: storageFixture,
  });
  const roomFileModes = {
    'gang-shared': Boolean(options.storageFile),
    'uno-advanced': Boolean(options.unoStorageFile || options.storageFile),
    'bang': Boolean(options.bangStorageFile || options.storageFile),
    'poker-export': Boolean(options.pokerStorageFile || options.storageFile),
    'tien-len-export': Boolean(options.tienLenStorageFile || options.storageFile),
    'sam-loc-export': Boolean(options.samLocStorageFile || options.storageFile),
    'phom-export': Boolean(options.phomStorageFile || options.storageFile),
  };
  const roomSources = [
    { id: 'manager:the-gang', gameId: 'the-gang', kind: 'room-json', mode: roomFileModes['gang-shared'] ? 'persisted' : 'memory', authority: 'authoritative' },
    { id: 'manager:uno-classic', gameId: 'uno', variant: 'classic-local-v1', kind: 'room-json', mode: roomFileModes['gang-shared'] ? 'persisted' : 'memory', authority: 'authoritative' },
    { id: 'manager:uno-advanced', gameId: 'uno', variant: 'classic-108-v1', kind: 'room-json', mode: roomFileModes['uno-advanced'] ? 'persisted' : 'memory', authority: 'authoritative' },
    { id: 'manager:tien-len', gameId: 'tien-len', kind: 'fixed-game-manager', mode: persisted ? 'persisted' : 'memory', authority: 'authoritative' },
    { id: 'manager:sam-loc', gameId: 'sam-loc', kind: 'fixed-game-manager', mode: persisted ? 'persisted' : 'memory', authority: 'authoritative' },
    { id: 'manager:phom', gameId: 'phom', kind: 'fixed-game-manager', mode: persisted ? 'persisted' : 'memory', authority: 'authoritative' },
    { id: 'manager:poker-json', gameId: 'poker', kind: 'poker-json-compatibility', mode: roomFileModes['poker-export'] ? 'persisted' : 'memory', authority: 'export' },
    { id: 'manager:bang', gameId: 'bang', kind: 'room-json', mode: roomFileModes.bang ? 'persisted' : 'memory', authority: 'authoritative' },
    { id: 'export:tien-len', gameId: 'tien-len', kind: 'room-json-export', mode: roomFileModes['tien-len-export'] ? 'persisted' : 'memory', authority: 'export' },
    { id: 'export:sam-loc', gameId: 'sam-loc', kind: 'room-json-export', mode: roomFileModes['sam-loc-export'] ? 'persisted' : 'memory', authority: 'export' },
    { id: 'export:phom', gameId: 'phom', kind: 'room-json-export', mode: roomFileModes['phom-export'] ? 'persisted' : 'memory', authority: 'export' },
    { id: 'export:poker', gameId: 'poker', kind: 'room-json-export', mode: roomFileModes['poker-export'] ? 'persisted' : 'memory', authority: 'export' },
    { id: 'legacy:the-gang', gameId: 'the-gang', kind: 'room-json-fallback', mode: roomFileModes['gang-shared'] ? 'persisted' : 'memory', authority: 'legacy-fallback' },
    { id: 'legacy:uno-classic', gameId: 'uno', variant: 'classic-local-v1', kind: 'room-json-fallback', mode: roomFileModes['gang-shared'] ? 'persisted' : 'memory', authority: 'legacy-fallback' },
    { id: 'legacy:uno-advanced', gameId: 'uno', variant: 'classic-108-v1', kind: 'room-json-fallback', mode: roomFileModes['uno-advanced'] ? 'persisted' : 'memory', authority: 'legacy-fallback' },
    { id: 'legacy:tien-len', gameId: 'tien-len', kind: 'room-json-fallback', mode: roomFileModes['tien-len-export'] ? 'persisted' : 'memory', authority: 'legacy-fallback' },
    { id: 'legacy:sam-loc', gameId: 'sam-loc', kind: 'room-json-fallback', mode: roomFileModes['sam-loc-export'] ? 'persisted' : 'memory', authority: 'legacy-fallback' },
    { id: 'legacy:phom', gameId: 'phom', kind: 'room-json-fallback', mode: roomFileModes['phom-export'] ? 'persisted' : 'memory', authority: 'legacy-fallback' },
    { id: 'legacy:poker', gameId: 'poker', kind: 'room-json-fallback', mode: roomFileModes['poker-export'] ? 'persisted' : 'memory', authority: 'legacy-fallback' },
  ];
  roomSources.forEach(source => diagnostics.registerSource({ ...source, fixture: storageFixture && source.mode === 'memory' }));
  const ownsProfileStore = !options.profileStore;
  const profileStore = options.profileStore || new ProfileStore({ databaseFile, legacyRoomsFile: options.storageFile, storageDiagnostics: diagnostics, storageFixture });
  if (!ownsProfileStore) profileStore.attachStorageDiagnostics?.(diagnostics, { fixture: storageFixture });
  const gm = new MultiGameManager(io, { storageFile: options.storageFile, unoStorageFile: options.unoStorageFile, tienLenStorageFile: options.tienLenStorageFile, pokerStorageFile: options.pokerStorageFile, samLocStorageFile: options.samLocStorageFile, phomStorageFile: options.phomStorageFile, bangStorageFile: options.bangStorageFile, databaseFile, profileStore, storageDiagnostics: diagnostics, graceMs: options.graceMs });
  const roomService = gm.roomService;
  const profiles = roomService.profileService;
  const managerFaults = [
    ['manager:the-gang', gm.gang, true], ['manager:uno-classic', gm.gang, true],
    ['manager:uno-advanced', gm.uno, true], ['manager:tien-len', gm.tienLen, true],
    ['manager:sam-loc', gm.samLoc, true], ['manager:phom', gm.phom, true],
    // Poker JSON is a compatibility export; snapshot SQL health is tracked separately.
    ['manager:poker-json', gm.poker, false], ['manager:bang', gm.bang, true],
  ];
  function syncManagerStorageFaults() {
    for (const [sourceId, manager, blocking] of managerFaults) {
      diagnostics.setExternalFault(sourceId, manager?.storageError
        ? { operation: 'read', stage: 'manager-load', code: 'ROOM_MANAGER_STORAGE_ERROR', blocking }
        : null);
    }
  }
  function refreshStorageStatus() {
    profiles.storageHealth();
    try {
      const legacyRooms = [];
      for (const [gameId, manager] of [['tien-len', gm.tienLen], ['sam-loc', gm.samLoc], ['phom', gm.phom]]) {
        for (const room of manager.rooms.values()) legacyRooms.push({ ...room, gameId });
      }
      diagnostics.setHeldAudit(summarizeHeldReservations(profileStore, { legacyRooms }));
    } catch {
      diagnostics.fail('profile-store', 'read', { stage: 'fixed-game-held-audit', code: 'HELD_AUDIT_FAILED' });
      diagnostics.setDatabaseStatus({ operational: false, errorCode: 'HELD_AUDIT_FAILED' });
      diagnostics.setHeldAudit({ state: 'unavailable' });
    }
    syncManagerStorageFaults();
    return diagnostics.getStatus();
  }
  profileStore.setStorageSafetyRefresh?.(refreshStorageStatus);
  gm.setStorageStatusRefresher(refreshStorageStatus);
  refreshStorageStatus();
  const tutorials = new TutorialService({ store: gm.profiles });
  const tutorialCleanup = setInterval(() => tutorials.cleanup(), 60000); tutorialCleanup.unref();
  const port = () => server.address()?.port || Number(process.env.PORT) || 3000;
  const adminService = new AdminService({
    adminSecret: options.adminSecret,
    gm,
    io,
    storageDiagnostics: diagnostics,
    getNetworkAddresses: () => networkUrls(port()),
  });
  const restoreAdminCreateGate = adminService.installRoomCreationGate([
    { target: gm, method: 'createRoom' },
    { target: roomService, method: 'createRoom' },
  ]);
  function socketForProfile(profileId) {
    const candidates = [...io.sockets.sockets.values()].filter(socket => socket.connected && socket.data?.profile?.id === profileId);
    const managers = [gm.gang, gm.uno, gm.tienLen, gm.poker, gm.samLoc, gm.phom, gm.bang];
    for (const socket of candidates) {
      for (const manager of managers) {
        const code = manager?.playerRoom?.get(socket.id);
        const seat = manager?.rooms?.get(code)?.players?.find(player => player.profileId === profileId && player.socketId === socket.id && player.connected);
        if (seat) return socket;
      }
    }
    return candidates.find(socket => managers.every(manager => !manager?.playerRoom?.has(socket.id))) || candidates[0] || null;
  }
  const groupTargetAdapters = targetAdaptersFromManager({ gameManager: gm, socketForProfile });
  const groupSwitchLifecycle = managerSwitchLifecycle({ gameManager: gm, socketForProfile });
  let groupTournaments;
  const groupLobbyService = new GroupLobbyService({
    targetAdapters: groupTargetAdapters,
    ...groupSwitchLifecycle,
    membershipLocked: async groupId => groupTournaments?.service?.membershipLocked(groupId)
      || (typeof options.groupMembershipLocked === 'function' && await options.groupMembershipLocked(groupId)),
    authorizeTarget: async context => {
      const { target } = context;
      if (adminService.maintenance) return { ok: false, code: 'MAINTENANCE_ACTIVE', message: 'Máy chủ đang bảo trì; chưa thể chuyển sang bàn mới.' };
      const status = refreshStorageStatus();
      const game = publicCatalog().games.find(item => item.gameId === target.gameId);
      if (game?.capabilities?.usesWallet && status?.canStartWager !== true) {
        return { ok: false, code: 'STORAGE_UNSAFE', message: status?.blockedReason || 'Chưa thể xác nhận lưu trữ an toàn cho game cược.' };
      }
      const tournamentGate = groupTournaments?.lifecycle?.authorizeTarget(context);
      if (tournamentGate?.ok === false) return tournamentGate;
      if (typeof options.authorizeGroupTarget === 'function') {
        const result = await options.authorizeGroupTarget(context);
        if (result === false || result?.ok === false) return result || { ok: false, code: 'GROUP_TARGET_BLOCKED' };
      }
      return { ok: true };
    },
    bindTargetRoom: options.bindGroupTargetRoom,
  });
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  const spectators = attachSpectatorSupport(app, io, gm);
  groupTournaments = attachGroupTournamentSupport(app, { gm, profiles, groupLobbyService });
  app.use('/api/admin', createAdminRouter(adminService));
  app.use('/api/groups', createGroupLobbyRouter({ service: groupLobbyService, resolveProfile: createProfileServiceResolver(profiles) }));
  // Practice owns only finite in-memory sessions. Never pass the production
  // ProfileStore or real room managers into this sandbox.
  const practice = new PracticeService(options.practiceOptions);
  const practiceCleanup = setInterval(() => practice.cleanup(), 60000); practiceCleanup.unref();
  attachPracticeRoutes(app, practice);
  app.get('/practice', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'practice.html')));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
  app.get('/group-lobby', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'group-lobby.html')));
  app.get('/uno', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'uno.html')));
  app.get('/profile', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'profile.html')));
  app.get('/tutorial', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'tutorial.html')));
  app.get('/history', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'history.html')));
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
  app.get('/api/tutorial/guides', (_req, res) => res.set('Cache-Control', 'no-store').json({ version: TUTORIAL_VERSION, guides: tutorialContent.listGuides() }));
  for (const method of ['start', 'submit', 'claim']) app.post(`/api/tutorial/${method}`, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const rawToken = profileTokenFrom(req);
      const { player } = profiles.requireProfile(rawToken);
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ ok: false, code: 'TUTORIAL_REQUEST_INVALID', error: 'Dữ liệu bài luyện không hợp lệ.' });
      const request = method === 'submit' ? { ...body, profileId: player.id } : { version: body.version, profileId: player.id };
      const result = tutorials[method](request);
      if (!result.ok) return res.status(409).json({ ok: false, code: result.error.code, error: result.error.message });
      return res.json(method === 'claim' ? { ...result, ...profiles.profilePayload(rawToken) } : result);
    } catch (error) {
      const unauthorized = error.code === 'PROFILE_UNAUTHORIZED';
      return res.status(unauthorized ? 401 : 503).json({ ok: false, code: unauthorized ? error.code : 'TUTORIAL_STORE_UNAVAILABLE', error: unauthorized ? error.message : 'Chưa lưu an toàn được hướng dẫn. Vui lòng thử lại.' });
    }
  });
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
  app.get('/api/history', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const result = profiles.historyPage(profileTokenFrom(req), req.query);
      return res.json(result);
    } catch (error) {
      return res.status(error.code === 'PROFILE_UNAUTHORIZED' ? 401 : 400).json({ error: error.message, code: error.code });
    }
  });
  app.patch('/api/profile', (req, res) => {
    try { return res.json(profiles.updateProfile(profileTokenFrom(req), req.body || {})); }
    catch (error) { return res.status(error.code === 'PROFILE_UNAUTHORIZED' ? 401 : 400).json({ error: error.message, code: error.code }); }
  });
  app.get('/api/missions', (req, res) => {
    try { return res.json(profiles.missionPayload(profileTokenFrom(req))); }
    catch (error) { return res.status(401).json({ error: error.message, code: error.code }); }
  });
  const quoteForProfile = (profileId, direction, gems) => {
    const owner = profiles.profiles.publicProfile(profileId);
    if (!owner) throw Object.assign(new Error('Ví hồ sơ không tồn tại.'), { code: 'WALLET_NOT_FOUND' });
    const targetCurrency = direction === 'gem-to-coin' ? 'coin' : 'gem';
    const store = profiles.profiles;
    const creditCapacity = typeof store.walletCreditCapacity === 'function'
      ? store.walletCreditCapacity(profileId, targetCurrency) : null;
    const balances = { ...owner.balances };
    if (creditCapacity) balances[targetCurrency] = { ...balances[targetCurrency], available: creditCapacity.available };
    return quoteCurrencyExchange({ balances, direction, gems, creditCapacity });
  };
  app.get('/api/wallet/exchange/quote', (req, res) => {
    const rawToken = profileTokenFrom(req);
    try {
      const { player } = profiles.requireProfile(rawToken);
      const quote = quoteForProfile(player.id, req.query.direction, Number(req.query.gems));
      if (!quote.valid) return res.status(400).json({ error: quote.error, code: 'EXCHANGE_INVALID' });
      const missionPayload = profiles.missionPayload(rawToken);
      const currentPeriod = missionPayload.missions[0]?.period;
      const openMissions = missionPayload.missions.filter(mission => mission.kind !== 'tutorial' && mission.enabled && mission.period === currentPeriod);
      res.set('Cache-Control', 'no-store');
      return res.json({ ...quote, rewards: {
        startingCoinGrant: STARTING_COINS,
        openDailyMissionCount: openMissions.length,
        openDailyMissionReward: openMissions.reduce((total, mission) => total + mission.reward, 0),
      } });
    } catch (error) { return res.status(error.code === 'PROFILE_UNAUTHORIZED' ? 401 : 400).json({ error: error.message, code: error.code }); }
  });
  app.post('/api/wallet/exchange', (req, res) => {
    const rawToken = profileTokenFrom(req);
    let profileId = null;
    try {
      const { player } = profiles.requireProfile(rawToken);
      profileId = player.id;
      const exchange = profiles.profiles.exchangeCurrency(player.id, { direction: req.body?.direction, gems: req.body?.gems, operationKey: req.body?.operationKey });
      return res.json({ ...profiles.profilePayload(rawToken), exchange });
    } catch (error) {
      let message = error.message;
      if (['WALLET_LIMIT', 'PAYOUT_CAPACITY'].includes(error.code) && profileId) {
        const quote = quoteForProfile(profileId, req.body?.direction, req.body?.gems);
        if (quote.error) message = quote.error;
      }
      return res.status(error.code === 'PROFILE_UNAUTHORIZED' ? 401 : 409).json({ error: message, code: error.code });
    }
  });
  app.post('/api/missions/:id/claim', (req, res) => {
    try { return res.json(profiles.claimMission(profileTokenFrom(req), { missionId: req.params.id, version: Number(req.body?.version || 1), periodKey: req.body?.periodKey })); }
    catch (error) { return res.status(error.code === 'PROFILE_UNAUTHORIZED' ? 401 : 409).json({ error: error.message, code: error.code }); }
  });
  app.get('/api/storage/status', (_req, res) => {
    const status = refreshStorageStatus();
    res.set('Cache-Control', 'no-store');
    return res.json(status);
  });
  app.get('/docs/rules/uno-classic.md', (_req, res) => res.sendFile(path.join(__dirname, '..', 'docs', 'rules', 'uno-classic.md')));
  app.get('/docs/rules/uno.md', (_req, res) => res.sendFile(path.join(__dirname, '..', 'docs', 'rules', 'uno.md')));
  app.get('/api/network', (_req, res) => res.json({ addresses: networkUrls(port()) }));
  app.get('/api/rooms/:code/qr', async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!gm.hasRoom(code)) return res.status(404).json({ error: 'Phòng không còn tồn tại.' });
    const addresses = networkUrls(port());
    const allowed = [...addresses.map(a => a.url), `http://127.0.0.1:${port()}`];
    const requested = req.query.origin;
    let currentHost = false;
    if (typeof requested === 'string') {
      try {
        const parsed = new URL(requested);
        // Also support LAN hostnames and HTTPS hosts used to open this server.
        currentHost = ['http:', 'https:'].includes(parsed.protocol) && parsed.host === req.get('host') && parsed.origin === requested;
      } catch { /* Invalid origins are rejected below. */ }
    }
    if (requested && (!allowed.includes(requested) && !currentHost)) return res.status(400).json({ error: 'Địa chỉ chia sẻ không hợp lệ.' });
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
        const result = method === 'createRoom' ? gm[method](socket, d.playerName, d.modeId, d.avatar, d.gameId, { ...d.config, ...Object.fromEntries(['roomName', 'maxPlayers', 'visibility', 'password', 'stake'].filter(key => d[key] !== undefined).map(key => [key, d[key]])) })
          : method === 'joinRoom' ? gm[method](socket, code, d.playerName, d.avatar, d.password) : gm[method](socket, code, d.sessionToken, { handoff: d.handoff === true });
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
        if (event === 'room:create') {
          const gameId = d.gameId || 'the-gang';
          const variant = gameId === 'uno' ? d.config?.variant || 'classic-local-v1' : undefined;
          result = gm.gameAdapterFor(gameId, variant).create({ socket, request: d }).legacy;
        } else {
          const contract = gm.gameAdapterForRoom(code);
          result = event === 'room:join'
            ? contract.join({ socket, request: { ...d, roomCode: code } }).legacy
            : contract.resume({ socket, request: { ...d, roomCode: code } }).legacy;
        }
      } catch (error) { result = { error: error.message, ...(error.code ? { code: error.code } : {}) }; }
      ack(result);
      if (result?.error) return socket.emit('room:error', { message: result.error });
      emitProfile(result);
      socket.emit(response, result);
      socket.emit(event === 'room:create' ? 'room_created' : event === 'room:join' ? 'room_joined' : 'room_resumed', result);
      gm.broadcast(result.roomCode);
    });
    on('room:ready', (d, ack) => { const result = gm.setReady(socket, d.roomCode, Boolean(d.ready)); ack({ ok: !result?.error }); });
    on('game:action', async (d, ack) => {
      let result;
      try { result = (await gm.gameAdapterForRoom(d.roomCode).action({ socket, envelope: d })).legacy; }
      catch (error) { result = { ok: false, error: { code: error.code || 'GAME_ACTION_FAILED', message: error.message } }; }
      ack(result); socket.emit('game:action_result', result);
    });
    on('game:request_state', (d, ack) => { const result = roomService.requestGameState(socket, d.roomCode); ack(result); if (result.ok) socket.emit('game_state', result.state); });
    on('game:result', (d, ack) => {
      const code = typeof d.roomCode === 'string' ? d.roomCode.trim().toUpperCase() : '';
      let result;
      try { result = gm.gameAdapterForRoom(code).result({ socket, roomCode: code }); }
      catch (error) { result = { contractVersion: 1, operation: 'result', ok: false, data: null,
        error: { code: error.code || 'RESULT_UNAVAILABLE', message: error.message }, capabilities: {},
        legacy: { ok: false, error: { code: error.code || 'RESULT_UNAVAILABLE', message: error.message } } }; }
      ack(result);
    });
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
  return { app, server, io, gm, roomService, tutorials, practice, adminService, groupLobbyService, spectators, groupTournaments, storageDiagnostics: diagnostics, close: () => new Promise((resolve, reject) => {
    clearInterval(tutorialCleanup);
    clearInterval(practiceCleanup);
    restoreAdminCreateGate();
    groupLobbyService.close();
    spectators.close();
    practice.close();
    io.close(() => {
      groupTournaments.close().then(() => {
        gm.close(); if (ownsProfileStore) profileStore.close(); resolve();
      }, reject);
    });
  }) };
}

module.exports = { createGameServer, networkUrls };
