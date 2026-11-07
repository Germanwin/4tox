'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path'); const net = require('net');
const { spawn } = require('child_process');
test('local Node fences the room when the host process stops renewing its lease', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-lease-'));
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../../server/server.js'), '--local', '--port', String(port), '--no-upnp', '--state-dir', temp, '--migration-export', '--lease-required'], { stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  const post = async (url, body) => { const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    let ready = false; for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + '/api/health')).ok; } catch {} if (!ready) await new Promise(r => setTimeout(r, 50)); }
    assert.ok(ready);
    const host = (await post('/api/lobby', { name: 'Host', max: 2 })).body;
    const guest = (await post('/api/join', { code: host.code, name: 'Guest' })).body;
    assert.equal((await post('/api/migration-lease', { code: host.code, token: guest.token, leaseMs: 500 })).status, 403);
    assert.equal((await post('/api/migration-lease', { code: host.code, token: host.token, leaseMs: 500 })).status, 200);
    await new Promise(r => setTimeout(r, 750));
    const denied = await post('/api/migration-lease', { code: host.code, token: host.token, leaseMs: 500 });
    assert.equal(denied.status, 503); assert.equal(denied.body.reason, 'lease_expired');
    assert.equal(fs.existsSync(path.join(temp, host.code)), false);
  } finally { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); fs.rmSync(temp, { recursive: true, force: true }); }
});
