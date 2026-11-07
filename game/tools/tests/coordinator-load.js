/* Local storage/load probe. Synthetic bytes and no EOS/network simulation. */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { performance } = require('perf_hooks');
const { Coordinator, encryptedStore } = require('../../server/coordinator');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-coord-load-'));
try {
  const store = encryptedStore(path.join(dir, 'state'), crypto.randomBytes(32));
  const c = new Coordinator({ persist: store.save });
  const bytes = crypto.randomBytes(116612);
  const delays = [], cpu = process.cpuUsage(), start = performance.now();
  for (let i = 0; i < 20; i++) {
    const h = c.request('create', { name: 'host', max: 4, version: 'v1', address: 'host.socket' });
    for (let j = 0; j < 3; j++) c.request('join', { code: h.code, name: 'guest' + j, version: 'v1' });
    bytes.writeUInt32BE(i, 0);
    const data = bytes.toString('base64'), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const t = performance.now();
    const result = c.request('backup', { code: h.code, token: h.token, generation: 1, data, sha256 });
    if (!result.ok) throw new Error('backup failed');
    delays.push(performance.now() - t);
  }
  delays.sort((a, b) => a - b);
  const usage = process.cpuUsage(cpu), memory = process.memoryUsage();
  console.log(JSON.stringify({ rooms: c.rooms.size, participants: 80, snapshotBytes: bytes.length,
    elapsedMs: Math.round(performance.now() - start), backupP95Ms: Math.round(delays[Math.floor(delays.length * 0.95)]),
    cpuUserMs: Math.round(usage.user / 1000), cpuSystemMs: Math.round(usage.system / 1000),
    rssMiB: Math.round(memory.rss / 1048576), stateBytes: fs.statSync(path.join(dir, 'state')).size }));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
