'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Coordinator, encryptedStore, makeServer, LEASE_MS, MIGRATE_MS, PRESENCE_MS, EMPTY_MS } = require('../../server/coordinator');
function setup(max = 4) {
  let now = 100000;
  const c = new Coordinator({ now: () => now });
  const host = c.request('create', { name: 'Host', version: 'v1', max, address: 'host.socket' });
  const join = name => c.request('join', { code: host.code, version: 'v1', name });
  const req = (op, p, more = {}) => c.request(op, { code: host.code, token: p.token, ...more });
  return { c, host, join, req, advance: n => { now += n; } };
}
function prepare(c, host, guests) {
  const players = guests.map((g, i) => ({ id: i + 1, token: 'local-' + i }));
  guests.forEach((g, i) => assert.equal(c.request('bind', { code: host.code, token: g.token, playerId: i + 1, roomTokenHash: crypto.createHash('sha256').update(players[i].token).digest('hex') }).ok, true));
  const data = Buffer.from(JSON.stringify({ lobby: { players } }));
  assert.equal(c.request('backup', { code: host.code, token: host.token, generation: 1, data: data.toString('base64'), sha256: crypto.createHash('sha256').update(data).digest('hex') }).ok, true);
}
test('rooms are separate, enforce capacity and capability', () => {
  const a = setup(), b = a.c.request('create', { name: 'Other', version: 'v1', max: 2, address: 'other.socket' });
  const j1 = a.join('Alice'), j2 = a.join('Bob'), j3 = a.join('Cathy');
  assert.ok(j1.ok && j2.ok && j3.ok);
  assert.equal(a.join('Dan').reason, 'full');
  assert.equal(a.req('leave', { token: b.token }).reason, 'unauthorized');
  assert.equal(a.c.request('heartbeat', { code: b.code, token: j1.token }).reason, 'unauthorized');
  assert.equal(a.req('backup', j1, { generation: 1 }).reason, 'stale_authority');
  assert.equal(a.c.rooms.size, 2);
});
test('incompatible clients cannot join or resume', () => {
  const a = setup();
  assert.equal(a.c.request('join', { code: a.host.code, name: 'guest', version: 'v2' }).reason, 'incompatible_or_name');
  assert.equal(a.req('heartbeat', a.host, { version: 'v2' }).reason, 'version_mismatch');
});
test('host expiry elects one candidate, stale host is fenced, failed candidate replaced', () => {
  const a = setup(); const one = a.join('one'), two = a.join('two');
  prepare(a.c, a.host, [one, two]);
  a.advance(LEASE_MS + 1);
  let s = a.req('heartbeat', one);
  assert.equal(s.state, 'migrating'); assert.equal(s.candidate, true); assert.equal(s.generation, 2);
  assert.equal(a.req('activate', two, { generation: 2, address: 'two.socket' }).reason, 'stale_authority');
  assert.equal(a.req('activate', a.host, { generation: 1, address: 'old.socket' }).reason, 'stale_authority');
  a.advance(MIGRATE_MS - 1); a.req('heartbeat', two); a.advance(2);
  s = a.req('heartbeat', two); assert.equal(s.candidate, true); assert.equal(s.generation, 3);
  assert.equal(a.req('restore', two, { generation: 3 }).ok, true);
  s = a.req('activate', two, { generation: 3, address: 'two.socket' });
  assert.equal(s.state, 'active'); assert.equal(s.host, true);
  assert.equal(a.req('heartbeat', a.host, { generation: 1 }).host, false);
});
test('backup requires current authority and verifies integrity; only candidate restores', () => {
  const a = setup(), guest = a.join('guest');
  const localToken = 'fixture-token';
  assert.equal(a.req('bind', guest, { playerId: 1, roomTokenHash: crypto.createHash('sha256').update(localToken).digest('hex') }).ok, true);
  const data = Buffer.from(JSON.stringify({ lobby: { players: [{ id: 1, token: localToken }] } }));
  const b = { generation: 1, data: data.toString('base64'), sha256: crypto.createHash('sha256').update(data).digest('hex') };
  assert.equal(a.req('backup', a.host, { ...b, sha256: 'bad' }).reason, 'bad_backup');
  assert.equal(a.req('backup', a.host, b).ok, true);
  assert.equal(a.req('restore', guest, { generation: 1 }).ok, false);
  a.advance(LEASE_MS + 1); const s = a.req('heartbeat', guest);
  assert.equal(a.req('restore', guest, { generation: s.generation }).data, b.data);
  assert.equal(a.req('backup', a.host, b).ok, false);
});
test('started match rejects new members and cannot activate without a backup', () => {
  const a = setup(), guest = a.join('guest');
  assert.equal(a.req('start', guest, { generation: 1 }).ok, false);
  assert.equal(a.req('start', a.host, { generation: 1 }).ok, true);
  assert.equal(a.join('late').reason, 'started');
  a.advance(LEASE_MS + 1);
  const state = a.req('heartbeat', guest);
  assert.equal(a.req('activate', guest, { generation: state.generation, address: 'new.socket' }).reason, 'no_backup');
});
test('damaged backup cannot activate a candidate', () => {
  const a = setup(), guest = a.join('guest');
  a.req('bind', guest, { playerId: 1, roomTokenHash: crypto.createHash('sha256').update('fixture').digest('hex') });
  const bytes = Buffer.from('not a gzip file');
  assert.ok(a.req('backup', a.host, { generation: 1, codec: 'gzip', data: bytes.toString('base64'), sha256: crypto.createHash('sha256').update(bytes).digest('hex') }).ok);
  assert.ok(a.req('start', a.host, { generation: 1 }).ok);
  a.advance(LEASE_MS + 1); const next = a.req('heartbeat', guest);
  assert.equal(a.req('restore', guest, { generation: next.generation }).reason, 'bad_backup');
  assert.equal(a.req('activate', guest, { generation: next.generation, address: 'new.socket' }).reason, 'restore_required');
});
test('simultaneous elections keep rooms independent', () => {
  let now = 100000;
  const c = new Coordinator({ now: () => now });
  const create = name => c.request('create', { name, version: 'v1', max: 2, address: 'host.socket' });
  const a = create('a'), b = create('b');
  const guest = (h, name) => c.request('join', { code: h.code, version: 'v1', name });
  const x = guest(a, 'x'), y = guest(b, 'y');
  prepare(c, a, [x]); prepare(c, b, [y]);
  now += LEASE_MS + 1;
  const xa = c.request('heartbeat', { code: a.code, token: x.token });
  const yb = c.request('heartbeat', { code: b.code, token: y.token });
  assert.equal(xa.candidate, true); assert.equal(yb.candidate, true);
  assert.equal(c.request('activate', { code: a.code, token: y.token, generation: xa.generation, address: 'wrong.socket' }).reason, 'unauthorized');
  assert.equal(c.request('restore', { code: a.code, token: x.token, generation: xa.generation }).ok, true);
  assert.equal(c.request('restore', { code: b.code, token: y.token, generation: yb.generation }).ok, true);
  assert.equal(c.request('activate', { code: a.code, token: x.token, generation: xa.generation, address: 'x.socket' }).host, true);
  assert.equal(c.request('activate', { code: b.code, token: y.token, generation: yb.generation, address: 'y.socket' }).host, true);
});
test('leave last participant and expired empty records are removed', () => {
  const a = setup(); assert.equal(a.req('leave', a.host).ok, true); assert.equal(a.c.rooms.size, 0);
  const b = setup(); b.advance(PRESENCE_MS + 1); b.c.sweep(); b.advance(EMPTY_MS + 1); b.c.sweep(); assert.equal(b.c.rooms.size, 0);
});
test('no heartbeat removes the room 30 seconds after the last presence', () => {
  const a = setup(); a.advance(EMPTY_MS - 1); a.c.sweep(); assert.equal(a.c.rooms.size, 1);
  a.advance(2); a.c.sweep(); assert.equal(a.c.rooms.size, 0);
});
test('encrypted state persists without plaintext and rejects wrong key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-coordinator-'));
  try {
    const key = crypto.randomBytes(32), file = path.join(dir, 'state');
    const store = encryptedStore(file, key), c = new Coordinator({ persist: store.save });
    const h = c.request('create', { name: 'secret name', max: 2, version: 'v1', address: 'host.socket' });
    const data = Buffer.from('private backup bytes');
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    assert.equal(c.request('backup', { code: h.code, token: h.token, generation: 1, data: data.toString('base64'), sha256: hash }).ok, true);
    const raw = fs.readFileSync(file); assert.equal(raw.includes(Buffer.from('secret name')), false); assert.equal(raw.includes(Buffer.from(h.token)), false);
    const reloaded = store.load(); assert.equal(reloaded.size, 1);
    assert.equal(reloaded.get(h.code).backup.data, data.toString('base64'));
    assert.equal(fs.readFileSync(path.join(file + '.backups', hash + '.bin')).includes(data), false);
    assert.throws(() => encryptedStore(file, crypto.randomBytes(32)).load());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('failed persistence does not leave an uncommitted room in memory', () => {
  const c = new Coordinator({ persist: () => { throw new Error('disk_failure'); } });
  assert.throws(() => c.request('create', { name: 'host', max: 2, version: 'v1', address: 'host.socket' }), /disk_failure/);
  assert.equal(c.rooms.size, 0);
});
test('a damaged backup does not prevent other rooms from loading', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-coordinator-damage-'));
  try {
    const file = path.join(dir, 'state'), store = encryptedStore(file, crypto.randomBytes(32));
    const c = new Coordinator({ persist: store.save });
    const a = c.request('create', { name: 'a', max: 2, version: 'v1', address: 'a.socket' });
    const b = c.request('create', { name: 'b', max: 2, version: 'v1', address: 'b.socket' });
    for (const [host, contents] of [[a, 'first'], [b, 'second']]) {
      const bytes = Buffer.from(contents), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      assert.ok(c.request('backup', { code: host.code, token: host.token, generation: 1, data: bytes.toString('base64'), sha256 }).ok);
    }
    const first = crypto.createHash('sha256').update('first').digest('hex');
    fs.writeFileSync(path.join(file + '.backups', first + '.bin'), 'corrupted');
    const loaded = store.load();
    assert.equal(loaded.get(a.code).backup, null);
    assert.equal(loaded.get(a.code).backupCorrupt, true);
    assert.equal(Buffer.from(loaded.get(b.code).backup.data, 'base64').toString(), 'second');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('HTTP simultaneous joins cannot overfill a room and creates are rate limited', async () => {
  const c = new Coordinator(), s = makeServer(c); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + s.address().port;
  const post = (op, body) => fetch(url + '/' + op, { method: 'POST', body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
  try {
    const h = (await post('create', { name: 'host', max: 2, version: 'v1', address: 'host.socket' })).body;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => post('join', { code: h.code, name: 'guest' + i, version: 'v1' })));
    assert.equal(results.filter(x => x.body.ok).length, 1);
    const creates = await Promise.all(Array.from({ length: 9 }, (_, i) => post('create', { name: 'h' + i, max: 2, version: 'v1', address: 'host.socket' })));
    assert.ok(creates.some(x => x.status === 429));
    const guesses = await Promise.all(Array.from({ length: 21 }, () => post('join', { code: 'INVALID999', name: 'guest', version: 'v1' })));
    assert.ok(guesses.some(x => x.status === 429));
  } finally { await new Promise(resolve => s.close(resolve)); }
});
