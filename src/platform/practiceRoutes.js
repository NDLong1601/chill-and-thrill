'use strict';

function attachPracticeRoutes(app, service) {
  function capability(req) {
    return /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(req.get('authorization') || '')?.[1] || '';
  }
  function respond(res, result) {
    const status = result.status || (result.ok ? 200 : ({ UNAUTHORIZED: 403, SESSION_EXPIRED: 410, SESSION_NOT_FOUND: 404 }[result.error?.code] || 400));
    const body = { ...result };
    delete body.status;
    return res.status(status).set('Cache-Control', 'no-store').json(body);
  }
  const handle = fn => async (req, res) => {
    try { respond(res, await fn(req)); }
    catch { res.status(503).set('Cache-Control', 'no-store').json({ ok: false, error: { code: 'PRACTICE_UNAVAILABLE', message: 'Chưa thể xử lý phiên luyện tập. Hãy thử lại.' } }); }
  };
  app.post('/api/practice/sessions', handle(req => service.createSession(req.body)));
  app.get('/api/practice/sessions/:id', handle(req => service.getState(req.params.id, capability(req))));
  app.post('/api/practice/sessions/:id/actions', handle(req => service.act(req.params.id, capability(req), req.body)));
  app.delete('/api/practice/sessions/:id', handle(req => service.deleteSession(req.params.id, capability(req))));
}

module.exports = { attachPracticeRoutes };
