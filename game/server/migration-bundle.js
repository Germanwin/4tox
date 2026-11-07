/* Experimental portable checkpoint, independent of the network transport.
   Caller must serialize lobby changes with capture and must not expose this
   material to unauthorised peers: lobby metadata contains bearer tokens. */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { create } = require('./persistence');

async function capture(runtime, lobby, timeoutMs = 5000) {
  if (!runtime || !lobby || lobby.code !== runtime.roomId || !Array.isArray(lobby.players)) throw new Error('migration_bad_lobby');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    /* Admissions can be awaiting fsync, and the simulation may be between
       step and durable tickCommit. Capture only after both settle. */
    const admissions = runtime.admitChain;
    let timeout;
    try {
      await Promise.race([admissions, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('migration_capture_timeout')), Math.max(1, deadline - Date.now()));
      })]);
    } finally { clearTimeout(timeout); }
    if (!runtime.pumping && admissions === runtime.admitChain) break;
    if (Date.now() >= deadline) throw new Error('migration_capture_timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (runtime.status !== 'running') throw new Error('migration_room_not_running');
  const cap = runtime.captureCheckpoint();
  const lobbyCopy = JSON.parse(JSON.stringify(lobby));
  return { format: 1, roomId: runtime.roomId, lobby: lobbyCopy,
    checkpoint: { sim: cap.dto, tick: cap.meta.tick, revision: cap.meta.revision,
      epoch: cap.meta.epoch, room: cap.meta.room } };
}

async function importBundle(root, bundle, hostPlayerId) {
  if (!bundle || bundle.format !== 1 || typeof bundle.roomId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(bundle.roomId) || !bundle.lobby ||
      bundle.lobby.code !== bundle.roomId || !Array.isArray(bundle.lobby.players) ||
      (bundle.lobby.started !== false && (!bundle.checkpoint || !bundle.checkpoint.sim || !bundle.checkpoint.room ||
      !Number.isSafeInteger(bundle.checkpoint.tick) || bundle.checkpoint.tick < 0 ||
      !Number.isSafeInteger(bundle.checkpoint.revision) || bundle.checkpoint.revision < 0 ||
      !Number.isSafeInteger(bundle.checkpoint.epoch) || bundle.checkpoint.epoch < 1))) throw new Error('migration_bad_bundle');
  const lobby = JSON.parse(JSON.stringify(bundle.lobby));
  if (hostPlayerId !== undefined) {
    if (!lobby.players.some(p => p.id === hostPlayerId)) throw new Error('migration_bad_host');
    lobby.hostId = hostPlayerId;
  }
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const final = path.join(root, bundle.roomId);
  const tmpRoot = await fsp.mkdtemp(path.join(root, '.migration-'));
  const p = create({ dir: tmpRoot, roomId: bundle.roomId });
  try {
    await p.open();
    const c = bundle.checkpoint;
    if (c) await p.writeCheckpoint(c.sim, { tick: c.tick, revision: c.revision, epoch: c.epoch,
      journalSegment: 1, journalOffset: 0, room: c.room });
    await p.close();
    const file = path.join(tmpRoot, bundle.roomId, 'lobby.json');
    const h = await fsp.open(file, 'wx', 0o600);
    try { await h.writeFile(JSON.stringify(lobby)); await h.sync(); } finally { await h.close(); }
    /* Cooperating importers reserve the name before the atomic rename. */
    const lock = path.join(root, '.' + bundle.roomId + '.import.lock');
    const reservation = await fsp.open(lock, 'wx', 0o600);
    try {
      try { await fsp.access(final); const e = new Error('room_exists'); e.code = 'EEXIST'; throw e; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      await fsp.rename(path.join(tmpRoot, bundle.roomId), final);
    } finally { await reservation.close(); await fsp.unlink(lock); }
    return final;
  } finally {
    try { await p.close(); } catch { /* already closed */ }
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}
function encode(bundle) {
  const raw = Buffer.from(JSON.stringify(bundle));
  const data = zlib.gzipSync(raw, { level: 3 });
  return { data: data.toString('base64'), sha256: crypto.createHash('sha256').update(data).digest('hex'), codec: 'gzip', bytes: data.length, rawBytes: raw.length };
}
function decode(data, sha256, codec) {
  if (!Buffer.isBuffer(data) || crypto.createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('migration_checksum');
  if (codec && codec !== 'gzip' && codec !== 'json') throw new Error('migration_bad_codec');
  const raw = codec === 'gzip' ? zlib.gunzipSync(data, { maxOutputLength: 32 * 1024 * 1024 }) : data;
  return JSON.parse(raw.toString('utf8'));
}
module.exports = { capture, importBundle, encode, decode };
