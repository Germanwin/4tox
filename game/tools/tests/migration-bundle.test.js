'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEngine } = require('./load-engine');
const { RoomRuntime } = require('../../server/room-runtime');
const bundle = require('../../server/migration-bundle');

test('capture times out when admission cannot complete', async () => {
  const runtime = { roomId: 'ROOM', admitChain: new Promise(() => {}), pumping: false };
  await assert.rejects(bundle.capture(runtime, { code: 'ROOM', players: [] }, 10), /migration_capture_timeout/);
});

test('portable checkpoint restores real world, committed result and queued command', async () => {
  loadEngine();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-migration-'));
  const players = [{ sessionId: 's1', playerId: 1, owner: 0 }];
  const clock = { now: () => 1, setTimeout: () => 0, setImmediate: () => 0, clearTimeout: () => {} };
  const opts = { roomId: 'ROOM', seed: 'test-migration', size: 64, players, clock };
  let r, restored;
  try {
    r = new RoomRuntime({ ...opts, dir: path.join(root, 'source') }); await r.start();
    const send = n => r.submit({ sessionId: 's1', playerId: 1, owner: 0, command: { protocol: 4,
      roomId: 'ROOM', epoch: r.epoch, commandId: 's0-h:' + n, clientSequence: n, type: 'stop', payload: { ids: [] } } });
    assert.equal((await send(1)).admitted, true); await r.executeAndCommitOneTick();
    assert.equal((await send(2)).admitted, true);
    const lobby = { code: 'ROOM', max: 2, hostId: 1, seed: opts.seed, size: 64,
      players: [{ id: 1, token: 'fixture-only', name: 'Host', owner: 0, ready: true }] };
    const snap = await bundle.capture(r, lobby), packed = bundle.encode(snap);
    assert.throws(() => bundle.decode(Buffer.from(packed.data, 'base64'), 'bad'), /checksum/);
    const target = path.join(root, 'target');
    await bundle.importBundle(target, bundle.decode(Buffer.from(packed.data, 'base64'), packed.sha256, packed.codec));
    await assert.rejects(bundle.importBundle(target, snap), { code: 'EEXIST' });
    restored = new RoomRuntime({ ...opts, dir: target }); await restored.start();
    assert.equal(restored.tick, r.tick);
    assert.equal(restored.commandState('s1', ['s0-h:1']).results[0].status, 'applied');
    assert.equal(restored.commandState('s1', ['s0-h:2']).results[0].status, 'received');
    await restored.executeAndCommitOneTick();
    assert.equal(restored.commandState('s1', ['s0-h:2']).results[0].status, 'applied');
    assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'ROOM', 'lobby.json'))).players[0].name, 'Host');
    console.log('portable checkpoint bytes:', packed.bytes, 'uncompressed:', packed.rawBytes);
  } finally {
    if (r) await r.close('test'); if (restored) await restored.close('test');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
