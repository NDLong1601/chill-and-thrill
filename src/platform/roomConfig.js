'use strict';
const crypto = require('node:crypto');
function passwordHash(password) {
  if (!password) return null;
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}
function verifyPassword(password, hash) {
  if (!hash) return true;
  if (typeof password !== 'string') return false;
  const [salt, value] = hash.split(':');
  if (!salt || !value) return false;
  const actual = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(value, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
module.exports = { passwordHash, verifyPassword };
