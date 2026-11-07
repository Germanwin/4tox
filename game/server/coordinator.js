/* Room coordinator for Godot EOS clients. */
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');
const migration = require('./migration-bundle');
const { guestIdentity } = require('./guest-identity');

const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_BODY = 8 * 1024 * 1024;
const MAX_BACKUP_TOTAL = 32 * 1024 * 1024;
const MAX_ROOMS = 1000;
const LEASE_MS = 10000;
const PRESENCE_MS = 15000;
const EMPTY_MS = 30000;
const MIGRATE_MS = 15000;
function rand(n = 32) { return crypto.randomBytes(n).toString('base64url'); }
function digest(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function code() { let s = ''; for (let i = 0; i < 10; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]; return s; }
function validAddress(s) { return typeof s === 'string' && s.length > 0 && s.length <= 160 && /^[A-Za-z0-9._-]+$/.test(s); }
function validVersion(s) { return typeof s === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(s); }
function name(s) { return typeof s === 'string' ? s.trim().slice(0, 32) : ''; }
function failure(reason, status = 400) { return { ok: false, reason, status }; }

class Coordinator {
  constructor(options = {}) {
    this.now = options.now || Date.now;
    this.rooms = new Map();
    this.maxRooms = options.maxRooms || MAX_ROOMS;
    this.persist = options.persist || (() => {});
  }
  save() { this.persist(this.rooms); }
  view(r, p, now) {
    const out = { ok: true, generation: r.generation, state: r.state, host: r.host === p.id,
      candidate: r.candidate === p.id, address: r.state === 'active' ? r.address : null,
      leaseMs: r.state === 'active' ? Math.max(0, r.leaseUntil - now) : 0,
      members: r.members.map(x => ({ name: x.name, online: now - x.seen < PRESENCE_MS })),
      backupAvailable: !!r.backup, started: !!r.started };
    if (r.host === p.id || r.candidate === p.id) out.ticketHashes = r.members.map(x => x.hash);
    return out;
  }
  auth(b) {
    const r = this.rooms.get(String(b.code || '').toUpperCase());
    const h = digest(typeof b.token === 'string' ? b.token : '');
    const p = r && r.members.find(x => x.hash === h);
    return r && p ? { r, p } : null;
  }
  elect(r, now) {
    r.address = null; r.host = null; r.leaseUntil = 0; r.restoredBy = null;
    const next = r.members.find(p => now - p.seen < PRESENCE_MS && !r.tried.includes(p.id));
    r.generation++;
    if (!next) { r.state = 'failed'; r.candidate = null; return; }
    r.candidate = next.id; r.tried.push(next.id); r.state = 'migrating'; r.deadline = now + MIGRATE_MS;
  }
  advance(r, now) {
    if (r.state === 'active' && now >= r.leaseUntil) { r.tried = [r.host]; this.elect(r, now); }
    else if (r.state === 'migrating' && now >= r.deadline) this.elect(r, now);
  }
  sweep() {
    let previous = null;
    const remember = () => { if (!previous) previous = structuredClone(this.rooms); };
    const now = this.now(); let dirty = false;
    for (const [k, r] of this.rooms) {
      const live = r.members.some(p => now - p.seen < PRESENCE_MS);
      if (live && r.emptySince != null) { remember(); r.emptySince = null; dirty = true; }
      else if (!live && r.emptySince == null) {
        remember(); r.emptySince = r.members.reduce((latest, p) => Math.max(latest, p.seen), 0); dirty = true;
      }
      if (r.emptySince != null && now - r.emptySince >= EMPTY_MS) { remember(); this.rooms.delete(k); dirty = true; continue; }
      if ((r.state === 'active' && now >= r.leaseUntil) || (r.state === 'migrating' && now >= r.deadline)) remember();
      const before = r.generation; this.advance(r, now); dirty ||= before !== r.generation;
    }
    if (dirty) {
      try { this.save(); } catch (e) { this.rooms = previous; throw e; }
    }
  }
  request(op, b) {
    this.sweep();
    const previous = new Map(this.rooms);
    if (previous && b && typeof b === 'object') {
      const key = String(b.code || '').trim().toUpperCase();
      if (this.rooms.has(key)) this.rooms.set(key, structuredClone(this.rooms.get(key)));
    }
    try { return this._request(op, b); }
    catch (e) { if (previous) this.rooms = previous; throw e; }
  }
  _request(op, b) {
    const now = this.now();
    if (!b || typeof b !== 'object' || Array.isArray(b)) return failure('bad_request');
    if (op === 'create') {
      if (this.rooms.size >= this.maxRooms) return failure('capacity', 503);
      const nm = name(b.name);
      if (!nm || !Number.isInteger(b.max) || b.max < 2 || b.max > 4 || !validVersion(b.version) || !validAddress(b.address)) return failure('bad_request');
      let c; do { c = code(); } while (this.rooms.has(c));
      const token = rand(), id = rand(12);
      const r = { code: c, max: b.max, version: b.version, generation: 1, state: 'active', host: id,
        address: b.address, leaseUntil: now + LEASE_MS, candidate: null, deadline: 0, tried: [], emptySince: null,
        members: [{ id, hash: digest(token), name: nm, seen: now }], backup: null, started: false };
      this.rooms.set(c, r); this.save(); return { ok: true, code: c, token, ...this.view(r, r.members[0], now) };
    }
    if (op === 'join') {
      const r = this.rooms.get(String(b.code || '').trim().toUpperCase());
      if (!r || r.state === 'failed') return failure('unavailable', 404);
      if (r.started) return failure('started', 409);
      const nm = name(b.name);
      if (!nm || b.version !== r.version) return failure('incompatible_or_name');
      if (r.members.length >= r.max) return failure('full', 409);
      if (r.members.some(x => x.name.toLocaleLowerCase() === nm.toLocaleLowerCase())) return failure('name_taken', 409);
      const token = rand(), p = { id: rand(12), hash: digest(token), name: nm, seen: now };
      r.members.push(p); this.save(); return { ...this.view(r, p, now), token };
    }
    const a = this.auth(b); if (!a) return failure('unauthorized', 403);
    const { r, p } = a; const oldGeneration = r.generation; this.advance(r, now);
    if (r.generation !== oldGeneration) this.save();
    if (b.version && b.version !== r.version) return failure('version_mismatch', 409);
    if (op === 'leave') {
      r.members = r.members.filter(x => x !== p);
      if (!r.members.length) this.rooms.delete(r.code);
      else if (r.host === p.id || r.candidate === p.id) { r.tried = [p.id]; this.elect(r, now); }
      this.save(); return { ok: true };
    }
    if (op === 'heartbeat') {
      p.seen = now; r.emptySince = null;
      if (r.host === p.id && r.state === 'active' && b.generation === r.generation) r.leaseUntil = now + LEASE_MS;
      return this.view(r, p, now);
    }
    if (op === 'bind') {
      if (!Number.isSafeInteger(b.playerId) || b.playerId < 0 || typeof b.roomTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(b.roomTokenHash)) return failure('bad_binding');
      if (r.members.some(x => x !== p && x.nodePlayerId === b.playerId)) return failure('binding_taken', 409);
      p.nodePlayerId = b.playerId; p.nodeTokenHash = b.roomTokenHash;
      this.save(); return { ok: true };
    }
    if (op === 'activate') {
      if (r.state !== 'migrating' || r.candidate !== p.id || b.generation !== r.generation || !validAddress(b.address) || now >= r.deadline) return failure('stale_authority', 409);
      if (!r.backup) return failure('no_backup', 409);
      if (r.restoredBy !== p.id) return failure('restore_required', 409);
      r.host = p.id; r.candidate = null; r.address = b.address; r.state = 'active'; r.leaseUntil = now + LEASE_MS; r.tried = [];
      this.save(); return this.view(r, p, now);
    }
    if (op === 'decline') {
      if (r.state !== 'migrating' || r.candidate !== p.id || b.generation !== r.generation) return failure('stale_authority', 403);
      this.elect(r, now); this.save(); return this.view(r, p, now);
    }
    if (op === 'resign') {
      if (r.state !== 'active' || r.host !== p.id || b.generation !== r.generation || now >= r.leaseUntil) return failure('stale_authority', 403);
      r.tried = [p.id]; this.elect(r, now); this.save(); return this.view(r, p, now);
    }
    if (op === 'backup') {
      if (r.state !== 'active' || r.host !== p.id || b.generation !== r.generation || now >= r.leaseUntil) return failure('stale_authority', 403);
      if (typeof b.data !== 'string' || b.data.length > MAX_BODY - 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.data)) return failure('bad_backup');
      const data = Buffer.from(b.data, 'base64');
      if (!data.length || data.toString('base64') !== b.data || digest(data) !== b.sha256) return failure('bad_backup');
      let otherBytes = 0;
      for (const other of this.rooms.values()) if (other !== r && other.backup) otherBytes += Buffer.byteLength(other.backup.data, 'base64');
      if (otherBytes + data.length > MAX_BACKUP_TOTAL) return failure('backup_capacity', 503);
      if (b.codec && b.codec !== 'gzip' && b.codec !== 'json') return failure('bad_backup');
      r.backup = { data: b.data, sha256: b.sha256, codec: b.codec || 'json', generation: r.generation, savedAt: now };
      r.backupCorrupt = false;
      this.save(); return { ok: true, savedAt: now };
    }
    if (op === 'start') {
      if (r.state !== 'active' || r.host !== p.id || b.generation !== r.generation || now >= r.leaseUntil) return failure('stale_authority', 403);
      if (r.members.length < 2) return failure('not_enough_players', 409);
      r.started = true; this.save(); return { ok: true };
    }
    if (op === 'unstart') {
      if (r.state !== 'active' || r.host !== p.id || b.generation !== r.generation || now >= r.leaseUntil) return failure('stale_authority', 403);
      r.started = false; this.save(); return { ok: true };
    }
    if (op === 'restore') {
      if (r.state !== 'migrating' || r.candidate !== p.id || b.generation !== r.generation || now >= r.deadline) return failure('stale_authority', 403);
      if (!r.backup) return failure(r.backupCorrupt ? 'bad_backup' : 'no_backup', 404);
      let saved;
      try { saved = migration.decode(Buffer.from(r.backup.data, 'base64'), r.backup.sha256, r.backup.codec); } catch { return failure('bad_backup', 409); }
      if (r.started && (!saved.lobby || saved.lobby.started === false || !saved.checkpoint)) return failure('no_game_backup', 409);
      const member = saved && saved.lobby && Array.isArray(saved.lobby.players) && saved.lobby.players.find(x => x.id === p.nodePlayerId);
      if (!member || typeof member.token !== 'string' || !p.nodeTokenHash || digest(member.token) !== p.nodeTokenHash) return failure('binding_mismatch', 409);
      let copy = r.backup;
      if (saved.lobby.started === false) {
        saved.lobby.players = saved.lobby.players.filter(x => r.members.some(m => m.nodePlayerId === x.id && m.nodeTokenHash && typeof x.token === 'string' && digest(x.token) === m.nodeTokenHash));
        const packed = migration.encode(saved);
        copy = { ...r.backup, data: packed.data, sha256: packed.sha256, codec: packed.codec };
      }
      r.restoredBy = p.id; this.save();
      return { ok: true, data: copy.data, sha256: copy.sha256, codec: copy.codec, backupGeneration: r.backup.generation, savedAt: r.backup.savedAt, playerId: p.nodePlayerId };
    }
    return failure('not_found', 404);
  }
}

/* Entire state encrypted at rest. The key lives only in the coordinator service. */
function encryptedStore(file, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('coordinator_key_must_be_32_bytes');
  const backupDir = file + '.backups';
  function seal(magic, plaintext) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(plaintext), c.final()]);
    return Buffer.concat([Buffer.from(magic), iv, c.getAuthTag(), data]);
  }
  function unseal(magic, bytes) {
    if (bytes.length < 32 || bytes.subarray(0, 4).toString() !== magic) throw new Error('coordinator_store_invalid');
    const d = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16)); d.setAuthTag(bytes.subarray(16, 32));
    return Buffer.concat([d.update(bytes.subarray(32)), d.final()]);
  }
  function atomicWrite(target, body) {
    const tmp = target + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
    try {
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, target);
    } finally { try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
  function syncDir(dir) {
    const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  }
  function save(rooms) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const refs = new Set(), records = [];
    for (const [code, room] of rooms) {
      let backup = room.backup;
      if (backup) {
        const ref = backup.sha256;
        if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error('coordinator_bad_backup_ref');
        const target = path.join(backupDir, ref + '.bin');
        if (!fs.existsSync(target)) atomicWrite(target, seal('4TB1', Buffer.from(backup.data, 'base64')));
        refs.add(ref + '.bin');
        backup = { sha256: ref, codec: backup.codec, generation: backup.generation, savedAt: backup.savedAt, ref };
      }
      records.push([code, { ...room, backup }]);
    }
    syncDir(backupDir);
    atomicWrite(file, seal('4TC1', Buffer.from(JSON.stringify(records))));
    syncDir(path.dirname(file));
    for (const name of fs.readdirSync(backupDir)) {
      if (/^[a-f0-9]{64}\.bin$/.test(name) && !refs.has(name)) fs.unlinkSync(path.join(backupDir, name));
    }
  }
  function load() {
    if (!fs.existsSync(file)) return new Map();
    const rooms = new Map(JSON.parse(unseal('4TC1', fs.readFileSync(file)).toString('utf8')));
    for (const room of rooms.values()) {
      if (!room.backup || !room.backup.ref) continue;
      const ref = room.backup.ref;
      if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error('coordinator_bad_backup_ref');
      try {
        const data = unseal('4TB1', fs.readFileSync(path.join(backupDir, ref + '.bin')));
        if (digest(data) !== ref) throw new Error('coordinator_backup_checksum');
        room.backup.data = data.toString('base64');
        delete room.backup.ref;
      } catch {
        room.backup = null;
        room.backupCorrupt = true;
        try { fs.unlinkSync(path.join(backupDir, ref + '.bin')); } catch { /* already absent */ }
      }
    }
    return rooms;
  }
  return { save, load };
}

function makeServer(coordinator, options = {}) {
  const buckets = new Map();
  const memberBuckets = new Map();
  let lastPrune = 0;
  const server = http.createServer((req, res) => {
    const now = Date.now();
    let ip = req.socket.remoteAddress || '';
    if (options.trustLoopbackProxy && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) {
      const chain = String(req.headers['x-forwarded-for'] || '').split(',');
      const forwarded = chain[chain.length - 1].trim();
      if (net.isIP(forwarded)) ip = forwarded;
    }
    if (now - lastPrune >= 30000) {
      for (const [k, v] of buckets) if (now - v.since > 120000) buckets.delete(k);
      for (const [k, v] of memberBuckets) if (now - v.since > 120000) memberBuckets.delete(k);
      lastPrune = now;
    }
    if (!buckets.has(ip) && buckets.size >= 50000) { res.writeHead(503); res.end(); return; }
    let b = buckets.get(ip); if (!b || now - b.since > 60000) b = { since: now, count: 0, creates: 0, joins: 0 };
    b.count++; if (req.url === '/create') b.creates++; if (req.url === '/join') b.joins++; if (req.url === '/openid/token') b.tokens = (b.tokens || 0) + 1; buckets.set(ip, b);
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    if (b.count > 600 || b.creates > 8 || b.joins > 20) return reply(429, { ok: false, reason: 'rate_limit' });
    if (options.guestIdentity && req.method === 'POST' && req.url === '/openid/token') {
      if (b.tokens > 20) return reply(429, { ok: false, reason: 'rate_limit' });
      req.resume();
      return reply(200, { token: options.guestIdentity.issue() });
    }
    if (options.guestIdentity && req.method === 'GET' && req.url === '/openid/userinfo') {
      const match = /^Bearer ([A-Za-z0-9_.-]{1,256})$/.exec(String(req.headers.authorization || ''));
      const info = match && options.guestIdentity.verify(match[1]);
      return info ? reply(200, info) : reply(401, { error: 'invalid_token' });
    }
    if (options.guestIdentity && req.method === 'POST' && req.url === '/openid/refresh') {
      const match = /^Bearer ([A-Za-z0-9_.-]{1,256})$/.exec(String(req.headers.authorization || ''));
      const info = match && options.guestIdentity.verify(match[1]);
      req.resume();
      return info ? reply(200, { token: options.guestIdentity.issue(info.id) }) : reply(401, { error: 'invalid_token' });
    }
    if (req.method === 'GET' && req.url === '/config') {
      if (!options.publicConfig) return reply(503, { ok: false, reason: 'not_configured' });
      const eos = {};
      for (const k of ['product_name', 'product_version', 'product_id', 'sandbox_id', 'deployment_id', 'client_id', 'client_secret']) {
        if (typeof options.publicConfig[k] !== 'string' || options.publicConfig[k].length > 256) return reply(503, { ok: false, reason: 'not_configured' });
        eos[k] = options.publicConfig[k];
      }
      if (options.guestIdentity && options.publicConfig.login_method === 'openid') eos.login_method = 'openid';
      return reply(200, { ok: true, eos });
    }
    if (req.method !== 'POST' || !/^\/(create|join|leave|heartbeat|bind|activate|decline|resign|backup|restore|start|unstart)$/.test(req.url)) return reply(404, { ok: false, reason: 'not_found' });
    if (Number(req.headers['content-length']) > MAX_BODY) return reply(413, { ok: false, reason: 'too_large' });
    let chunks = [], n = 0, tooLarge = false;
    req.on('data', chunk => { n += chunk.length; if (n > MAX_BODY) { tooLarge = true; chunks = []; } else if (!tooLarge) chunks.push(chunk); });
    req.on('end', () => {
      if (tooLarge) return reply(413, { ok: false, reason: 'too_large' });
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { ok: false, reason: 'bad_json' }); }
      if (body && typeof body === 'object' && coordinator.auth(body)) {
        const key = digest(body.token);
        let member = memberBuckets.get(key); if (!member || now - member.since > 60000) member = { since: now, count: 0 };
        member.count++; memberBuckets.set(key, member);
        if (member.count > 120) return reply(429, { ok: false, reason: 'rate_limit' });
      }
      try { const out = coordinator.request(req.url.slice(1), body); reply(out.status || 200, out); }
      catch { reply(500, { ok: false, reason: 'storage_error' }); }
    });
  });
  server.maxConnections = 256;
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
if (require.main === module) {
  const credentialFile = process.env.COORDINATOR_KEY_FILE || (process.env.CREDENTIALS_DIRECTORY ? path.join(process.env.CREDENTIALS_DIRECTORY, 'coordinator-key') : '');
  const keyText = credentialFile ? fs.readFileSync(credentialFile, 'utf8').trim() : (process.env.COORDINATOR_KEY || '');
  const key = Buffer.from(keyText, 'base64');
  const file = process.env.COORDINATOR_STATE;
  if (!file) throw new Error('COORDINATOR_STATE_required');
  const store = encryptedStore(file, key), c = new Coordinator({ persist: store.save });
  c.rooms = store.load();
  /* Restarts never extend an old lease. */
  for (const r of c.rooms.values()) {
    r.leaseUntil = 0; r.deadline = 0; r.emptySince = null;
  }
  const timer = setInterval(() => { try { c.sweep(); } catch { /* next sweep retries */ } }, 1000); timer.unref();
  const configFile = process.env.COORDINATOR_CLIENT_CONFIG;
  const publicConfig = configFile && fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : null;
  const identityFile = process.env.COORDINATOR_IDENTITY_KEY_FILE || (process.env.CREDENTIALS_DIRECTORY ? path.join(process.env.CREDENTIALS_DIRECTORY, 'identity-key') : '');
  const identity = identityFile && fs.existsSync(identityFile) ? guestIdentity(Buffer.from(fs.readFileSync(identityFile, 'utf8').trim(), 'base64')) : null;
  makeServer(c, { trustLoopbackProxy: process.env.COORDINATOR_TRUST_LOOPBACK_PROXY === '1', publicConfig, guestIdentity: identity }).listen(Number(process.env.COORDINATOR_PORT || 8798), '127.0.0.1');
}
module.exports = { Coordinator, encryptedStore, makeServer, LEASE_MS, PRESENCE_MS, EMPTY_MS, MIGRATE_MS };
