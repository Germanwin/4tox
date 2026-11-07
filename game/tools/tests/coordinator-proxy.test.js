'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Coordinator, makeServer } = require('../../server/coordinator');
const { guestIdentity } = require('../../server/guest-identity');
const crypto = require('node:crypto');
const publicConfig = { product_name: 'test', product_version: 'v1', product_id: 'p', sandbox_id: 's', deployment_id: 'd', client_id: 'client', client_secret: 'fixture-only', server_secret: 'never-return' };
test('optional local proxy forwards coordinator control and public configuration only', async () => {
  const coord = makeServer(new Coordinator(), { publicConfig, trustLoopbackProxy: true, guestIdentity: guestIdentity(crypto.randomBytes(32)) });
  await new Promise(resolve => coord.listen(0, '127.0.0.1', resolve));
  const sock = net.createServer(); await new Promise(resolve => sock.listen(0, '127.0.0.1', resolve));
  const port = sock.address().port; await new Promise(resolve => sock.close(resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-coord-proxy-'));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../../server/server.js'), '--local', '--port', String(port), '--no-upnp', '--state-dir', dir], { stdio: 'ignore', env: { ...process.env, COORDINATOR_PROXY_PORT: String(coord.address().port) } });
  const base = 'http://127.0.0.1:' + port;
  try {
    let up = false; for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(base + '/api/health')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 50)); }
    assert.ok(up);
    const config = await (await fetch(base + '/api/eos-coordinator/config')).json();
    assert.equal(config.eos.client_id, 'client');
    assert.equal(config.eos.server_secret, undefined);
    const tokenResponse = await fetch(base + '/api/eos-coordinator/openid/token', { method: 'POST' });
    const { token } = await tokenResponse.json();
    const userInfo = await fetch(base + '/api/eos-coordinator/openid/userinfo', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(userInfo.status, 200);
    assert.match((await userInfo.json()).id, /^[A-Za-z0-9_-]{32}$/);
    const refresh = await fetch(base + '/api/eos-coordinator/openid/refresh', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(refresh.status, 200);
    const res = await fetch(base + '/api/eos-coordinator/create', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' }, body: JSON.stringify({ name: 'host', max: 2, version: 'v1', address: 'host.socket' }) });
    assert.equal((await res.json()).ok, true);
  } finally {
    child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
    await new Promise(resolve => coord.close(resolve)); fs.rmSync(dir, { recursive: true, force: true });
  }
});
