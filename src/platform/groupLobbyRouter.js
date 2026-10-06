'use strict';

const express = require('express');
const { GroupLobbyError } = require('./groupLobbyService');

function profileTokenFromRequest(req) {
  const custom = req.get?.('X-Profile-Token') || req.headers?.['x-profile-token'];
  if (typeof custom === 'string' && custom.trim()) return custom.trim();
  const authorization = req.get?.('Authorization') || req.headers?.authorization || '';
  return typeof authorization === 'string' && /^Bearer\s+/i.test(authorization) ? authorization.replace(/^Bearer\s+/i, '').trim() : '';
}

function createProfileServiceResolver(profileService) {
  if (!profileService || typeof profileService.requireProfile !== 'function') throw new TypeError('A trusted ProfileService is required.');
  return req => {
    try {
      const authenticated = profileService.requireProfile(profileTokenFromRequest(req));
      const player = authenticated?.player;
      return player ? { id: player.playerId || player.id, name: player.name || player.displayName, avatar: player.avatar } : null;
    } catch (error) {
      if (error?.code === 'PROFILE_UNAUTHORIZED') error.status = 401;
      throw error;
    }
  };
}

function createGroupLobbyRouter({ service, resolveProfile }) {
  if (!service) throw new TypeError('A GroupLobbyService instance is required.');
  if (typeof resolveProfile !== 'function') throw new TypeError('A trusted resolveProfile(request) callback is required.');
  const router = express.Router();
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(express.json({ limit: '8kb' }));
  router.use((req, _res, next) => {
    Promise.resolve().then(() => resolveProfile(req)).then(profile => {
      if (!profile || typeof (profile.id || profile.playerId) !== 'string') throw new GroupLobbyError('PROFILE_UNAUTHORIZED', 'Hãy đăng nhập hồ sơ người chơi trước.', 401);
      // Identity fields come only from the trusted callback. Body profile IDs,
      // names, avatars, and profile tokens are never used as authority.
      req.groupLobbyProfile = profile;
      next();
    }).catch(next);
  });
  const groupCapability = req => req.get('X-Group-Capability') || '';
  const send = (fn, status = 200) => (req, res, next) => {
    Promise.resolve().then(() => fn(req)).then(result => res.status(status).json(result)).catch(next);
  };

  router.post('/', send(req => service.createGroup(req.groupLobbyProfile), 201));
  router.post('/join', send(req => service.joinGroup(req.groupLobbyProfile, req.body?.inviteCapability), 201));
  router.get('/:groupId', send(req => service.getGroup(req.groupLobbyProfile, req.params.groupId, groupCapability(req))));
  router.post('/:groupId/invite', send(req => service.rotateInvite(req.groupLobbyProfile, req.params.groupId, groupCapability(req))));
  router.post('/:groupId/proposal', send(req => service.propose(req.groupLobbyProfile, req.params.groupId, groupCapability(req), req.body || {})));
  router.post('/:groupId/confirm', send(req => service.confirm(req.groupLobbyProfile, req.params.groupId, groupCapability(req), req.body || {})));
  router.post('/:groupId/switch', send(req => service.switchGroup(req.groupLobbyProfile, req.params.groupId, groupCapability(req))));
  router.get('/:groupId/handoff', send(req => service.handoff(req.groupLobbyProfile, req.params.groupId, groupCapability(req))));
  router.post('/:groupId/heartbeat', send(req => service.heartbeat(req.groupLobbyProfile, req.params.groupId, groupCapability(req))));
  router.post('/:groupId/disconnect', send(req => service.disconnect(req.groupLobbyProfile, req.params.groupId, groupCapability(req))));
  router.post('/:groupId/host', send(req => service.transferHost(req.groupLobbyProfile, req.params.groupId, groupCapability(req), req.body?.memberKey)));
  router.post('/:groupId/leave', send(req => service.leave(req.groupLobbyProfile, req.params.groupId, groupCapability(req))));
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number.isInteger(error?.status) ? error.status : 500;
    res.status(status).json({ error: { code: error?.code || 'GROUP_LOBBY_ERROR', message: status === 500 ? 'Không thể xử lý sảnh nhóm lúc này.' : error.message } });
  });
  return router;
}

module.exports = { createGroupLobbyRouter, createProfileServiceResolver, profileTokenFromRequest };
