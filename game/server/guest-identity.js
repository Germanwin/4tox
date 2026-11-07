'use strict';

const crypto = require('crypto');

// Stateless bearer credentials: the signing key never leaves the coordinator.
function guestIdentity(key, now = Date.now) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('guest_identity_key_must_be_32_bytes');
  const sign = value => crypto.createHmac('sha256', key).update(value).digest('base64url');
  return {
    issue(subject = crypto.randomBytes(24).toString('base64url')) {
      if (!/^[A-Za-z0-9_-]{32}$/.test(subject)) throw new Error('invalid_subject');
      const value = `v1.${subject}.${Math.floor(now() / 1000) + 86400}`;
      return `${value}.${sign(value)}`;
    },
    verify(token) {
      if (typeof token !== 'string' || token.length > 256) return null;
      const m = /^(v1\.([A-Za-z0-9_-]{32})\.(\d{10}))\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!m || Number(m[3]) <= Math.floor(now() / 1000) || Number(m[3]) > Math.floor(now() / 1000) + 86400) return null;
      const expected = Buffer.from(sign(m[1]));
      const actual = Buffer.from(m[4]);
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
      return { id: m[2], external_id: '4tox' };
    },
  };
}
module.exports = { guestIdentity };
