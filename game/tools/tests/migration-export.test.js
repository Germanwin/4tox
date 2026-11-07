'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const migration = require('../../server/migration-bundle');

test('opt-in local export requires host and carries a portable checkpoint', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-export-'));
  const sock = net.createServer(); await new Promise(resolve => sock.listen(0, '127.0.0.1', resolve));
  const port = sock.address().port; await new Promise(resolve => sock.close(resolve));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../../server/server.js'), '--local', '--port', String(port), '--no-upnp', '--migration-export', '--state-dir', temp], { stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + '/api/health')).ok; } catch {} if (!ready) await new Promise(r => setTimeout(r, 50)); }
    assert.ok(ready);
    const h = (await post('/api/lobby', { name: 'Host', max: 2, seed: 'export-test', size: 64 })).body;
    const g = (await post('/api/join', { code: h.code, name: 'Guest' })).body;
    await post('/api/ready', { code: h.code, token: h.token, ready: true });
    await post('/api/ready', { code: h.code, token: g.token, ready: true });
    assert.equal((await post('/api/start', { code: h.code, token: h.token })).status, 200);
    assert.equal((await post('/api/migration-export', { code: h.code, token: g.token })).status, 403);
    const out = await post('/api/migration-export', { code: h.code, token: h.token });
    assert.equal(out.status, 200);
    const b = migration.decode(Buffer.from(out.body.data, 'base64'), out.body.sha256, out.body.codec);
    assert.equal(b.roomId, h.code); assert.equal(b.lobby.players.length, 2);
    assert.ok(b.checkpoint.sim && b.checkpoint.room);
  } finally {
    child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
