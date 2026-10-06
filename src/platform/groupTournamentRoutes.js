'use strict';

const { TournamentError } = require('./groupTournamentService');

function rawProfileToken(req) {
  const value = req.get('x-profile-token') || req.get('authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7) : value;
}

function attachGroupTournamentRoutes(app, { service, profiles } = {}) {
  if (!app || !service || !profiles || typeof profiles.requireProfile !== 'function') throw new TypeError('Tournament routes require the service and authenticated ProfileService.');

  app.use('/api/groups/:groupId/tournaments', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      const { player } = profiles.requireProfile(rawProfileToken(req));
      req.tournamentActorProfileId = player.playerId || player.id;
      if (!req.tournamentActorProfileId) throw Object.assign(new Error('Hồ sơ chưa hợp lệ.'), { code: 'PROFILE_UNAUTHORIZED' });
      next();
    } catch (error) {
      const status = error.code === 'PROFILE_UNAUTHORIZED' ? 401 : 503;
      res.status(status).json({ error: error.message || 'Không thể xác thực hồ sơ.', code: error.code || 'PROFILE_UNAVAILABLE' });
    }
  });

  app.get('/api/groups/:groupId/tournaments/rules', (_req, res) => res.json(service.rules()));
  app.get('/api/groups/:groupId/tournaments', (req, res) => respond(res, () => service.list({ groupId: req.params.groupId, actorProfileId: req.tournamentActorProfileId })));
  app.post('/api/groups/:groupId/tournaments', (req, res) => respond(res, () => service.create({
    groupId: req.params.groupId, actorProfileId: req.tournamentActorProfileId,
    name: req.body?.name, gameId: req.body?.gameId, variant: req.body?.variant, rounds: req.body?.rounds,
  }), 201));
  app.get('/api/groups/:groupId/tournaments/:tournamentId', (req, res) => respond(res, () => service.detail({
    groupId: req.params.groupId, tournamentId: req.params.tournamentId, actorProfileId: req.tournamentActorProfileId,
  })));
  app.post('/api/groups/:groupId/tournaments/:tournamentId/start', (req, res) => respond(res, () => service.start({
    groupId: req.params.groupId, tournamentId: req.params.tournamentId, actorProfileId: req.tournamentActorProfileId,
  })));
  app.post('/api/groups/:groupId/tournaments/:tournamentId/close', (req, res) => respond(res, () => service.close({
    groupId: req.params.groupId, tournamentId: req.params.tournamentId, actorProfileId: req.tournamentActorProfileId,
  })));

  return app;
}

async function respond(res, work, successStatus = 200) {
  try { return res.status(successStatus).json(await work()); }
  catch (error) {
    const status = error instanceof TournamentError ? error.status : error.code === 'PROFILE_UNAUTHORIZED' ? 401 : 503;
    return res.status(status).json({ error: error.message || 'Không thể lưu trạng thái giải đấu.', code: error.code || 'TOURNAMENT_STORE_ERROR' });
  }
}

module.exports = { attachGroupTournamentRoutes };
