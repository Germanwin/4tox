'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { guestIdentity } = require('../../server/guest-identity');
const { Coordinator, makeServer } = require('../../server/coordinator');

test('guest tokens are signed, distinct and expire', () => {
  let now = 1700000000000;
  const id = guestIdentity(crypto.randomBytes(32), () => now);
  const first = id.issue(), second = id.issue();
  assert.notEqual(first, second);
  assert.notEqual(id.verify(first).id, id.verify(second).id);
  assert.equal(id.verify(first + 'x'), null);
  assert.equal(id.verify(first.replace(/^v1\./, 'v2.')), null);
  assert.equal(guestIdentity(crypto.randomBytes(32), () => now).verify(first), null);
  now += 86400000;
  assert.equal(id.verify(first), null);
});

test('HTTP identity endpoint requires a valid bearer token and limits issuance', async t => {
  const server = makeServer(new Coordinator(), { guestIdentity: guestIdentity(crypto.randomBytes(32)) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/openid/token', { method: 'POST' });
  assert.equal(res.status, 200);
  const { token } = await res.json();
  assert.equal((await fetch(base + '/openid/userinfo')).status, 401);
  assert.equal((await fetch(base + '/openid/userinfo', { headers: { authorization: 'Bearer invalid' } })).status, 401);
  const info = await fetch(base + '/openid/userinfo', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(info.status, 200);
  const original = await info.json();
  assert.match(original.id, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await fetch(base + '/openid/refresh', { method: 'POST' })).status, 401);
  const renewed = await fetch(base + '/openid/refresh', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const newToken = (await renewed.json()).token;
  const newInfo = await fetch(base + '/openid/userinfo', { headers: { authorization: `Bearer ${newToken}` } });
  assert.equal((await newInfo.json()).id, original.id);
  for (let i = 0; i < 19; i++) assert.equal((await fetch(base + '/openid/token', { method: 'POST' })).status, 200);
  assert.equal((await fetch(base + '/openid/token', { method: 'POST' })).status, 429);
});
