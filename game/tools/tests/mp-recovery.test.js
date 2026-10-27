'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEngine } = require('./load-engine');
const persistence = require('../../server/persistence.js');

function record(n) {
  return persistence.encodeRecord({ type: 'tickCommit', n: n, data: 'x'.repeat(n) });
}

test('T16: оборванный последний record отсекается, средний — fault', () => {
  const good = Buffer.concat([record(4), record(8), record(16)]);
  const truncated = record(32);
  const tail = Buffer.concat([good, truncated.subarray(0, truncated.length - 5)]);
  const ok = persistence.decodeRecords(tail, { allowTruncatedTail: true });
  assert.equal(ok.length, 3);
  assert.throws(function () {
    persistence.decodeRecords(tail, { allowTruncatedTail: false });
  }, /journal_truncated/);

  const bad = Buffer.from(good);
  bad[bad.length - 20] ^= 0xff;              // портим байт в СЕРЕДИНЕ
  assert.throws(function () {
    persistence.decodeRecords(bad, { allowTruncatedTail: true });
  }, /journal_checksum/);
});

test('checkpoint: хранятся два последних, старые удаляются', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-persist-'));
  const p = persistence.create({ dir, roomId: 'PERSIST' });
  await p.open();
  for (let i = 1; i <= 3; i++) {
    await p.writeCheckpoint({ tick: i }, {
      tick: i, revision: i, epoch: 1, journalOffset: 0, journalSegment: 1
    });
  }
  const list = await p.listCheckpoints();
  assert.equal(list.length, 2, 'два последних checkpoint');
  assert.ok(/checkpoint-0000000003/.test(list[1]));
  await p.close();
});

test('T18: старые consumed ID дают history_expired, а не applied', async () => {
  const g = loadEngine();
  const { RoomRuntime } = require('../../server/room-runtime.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-hist-'));
  let t = 0;
  const clock = { now: () => t, setTimeout: () => 0, setImmediate: () => 0, clearTimeout: () => {} };
  const r = new RoomRuntime({
    roomId: 'HIST', seed: 'тихая-пойма-123', size: 64,
    players: [{ sessionId: 's1', playerId: 1, owner: 0 }],
    dir, clock
  });
  r.maxResults = 1;
  await r.start();
  for (let i = 1; i <= 3; i++) {
    const res = await r.submit({
      sessionId: 's1', playerId: 1, owner: 0,
      command: {
        protocol: 4, roomId: 'HIST', epoch: r.epoch,
        commandId: 's0-h:' + i, clientSequence: i,
        type: 'stop', payload: { ids: [] }
      }
    });
    assert.equal(res.admitted, true);
    await r.executeAndCommitOneTick();
    t += 50;
  }
  const first = r.commandState('s1', ['s0-h:1']).results[0];
  assert.equal(first.status, 'history_expired');
  assert.ok(first.boundary >= 2);
  const last = r.commandState('s1', ['s0-h:3']).results[0];
  assert.equal(last.status, 'applied');
  await r.close('test');
});

test('recover: команда упавшего тика получает recovery_interrupted', async () => {
  const g = loadEngine();
  const { RoomRuntime } = require('../../server/room-runtime.js');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-recover-'));
  let t = 0;
  const clock = { now: () => t, setTimeout: () => 0, setImmediate: () => 0, clearTimeout: () => {} };
  const r = new RoomRuntime({
    roomId: 'REC', seed: 'тихая-пойма-123', size: 64,
    players: [{ sessionId: 's1', playerId: 1, owner: 0 }],
    dir, clock
  });
  await r.start();
  const w = r.sim.state.world;
  w.isLand.fill(1); w.tile.fill(globalThis.WorldGen.T.GRASS); w.objects = [];
  w.townTotal = 0; w.removedIds = [];
  const res = await r.submit({
    sessionId: 's1', playerId: 1, owner: 0,
    command: { protocol: 4, roomId: 'REC', epoch: r.epoch, commandId: 's0-r:1',
      clientSequence: 1, type: 'stop', payload: { ids: [] } }
  });
  assert.equal(res.admitted, true);
  const beforeEpoch = r.epoch;
  const original = r.sim.step;
  r.sim.step = function () { throw new Error('boom'); };
  await assert.rejects(r.executeAndCommitOneTick());
  r.sim.step = original;
  assert.equal(r.status, 'faulted');
  const rec = await r.recover('test');
  assert.equal(rec.ok, true);
  assert.ok(r.epoch > beforeEpoch);
  assert.equal(r.status, 'running');
  const st = r.commandState('s1', ['s0-r:1']).results[0];
  assert.equal(st.status, 'rejected');
  assert.equal(st.reasonCode, 'recovery_interrupted');
  await r.close('test');
});
