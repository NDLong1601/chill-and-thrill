'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { isLoopbackAddress } = require('./adminService');

function sameOriginRequest(req) {
  const origin = req.get('origin');
  const host = req.get('host');
  if (typeof origin !== 'string' || typeof host !== 'string' || !host) return false;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    return parsed.origin === `${req.protocol}://${host}`;
  } catch {
    return false;
  }
}

function createAdminRouter(adminService, options = {}) {
  if (!adminService || typeof adminService.authenticate !== 'function') throw new TypeError('AdminService is required');
  const router = express.Router();
  const createQrSvg = options.createQrSvg || ((url) => QRCode.toString(url, {
    type: 'svg', margin: 2, width: 220, errorCorrectionLevel: 'M',
  }));

  router.use(express.json({ limit: '4kb', type: 'application/json' }));
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return res.status(404).json({ error: 'Không tìm thấy.' });
    const authorization = req.get('authorization') || '';
    const match = /^Bearer ([\s\S]+)$/.exec(authorization);
    if (!match || !adminService.authenticate(match[1])) return res.status(401).json({ error: 'Không được phép.' });
    next();
  });

  router.get('/status', (_req, res) => res.json(adminService.getStatus()));

  router.get('/network-qr/:index.svg', async (req, res) => {
    const index = Number(req.params.index);
    if (!Number.isSafeInteger(index) || index < 0) return res.status(404).json({ error: 'Không tìm thấy địa chỉ.' });
    const address = adminService.getAddress(index);
    if (!address) return res.status(404).json({ error: 'Không tìm thấy địa chỉ.' });
    try {
      const svg = await createQrSvg(address.url);
      return res.type('image/svg+xml; charset=utf-8').set('X-Content-Type-Options', 'nosniff').send(svg);
    } catch {
      return res.status(500).json({ error: 'Không tạo được mã QR.' });
    }
  });

  router.post('/maintenance', (req, res) => {
    if (!sameOriginRequest(req)) return res.status(403).json({ error: 'Yêu cầu quản trị phải đến từ cùng địa chỉ máy chủ.', code: 'ADMIN_ORIGIN_REJECTED' });
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['enabled', 'operationId'].includes(key))) {
      return res.status(400).json({ error: 'Dữ liệu yêu cầu không hợp lệ.', code: 'ADMIN_REQUEST_INVALID' });
    }
    const result = adminService.setMaintenance(body.enabled, body.operationId);
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    return res.json({ ok: true, maintenance: result.enabled, replayed: result.replayed, receipt: result.receipt });
  });

  return router;
}

module.exports = { createAdminRouter, sameOriginRequest };
