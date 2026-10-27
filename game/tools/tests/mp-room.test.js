'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEngine } = require('./load-engine');

const { RoomRuntime } = require('../../server/room-runtime.js');

function ctx() {
  loadEngine();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-room-'));
  let t = 0;
  const clock = {
    now: () => t,
    setTimeout: () => 0,
    setImmediate: () => 0,
    clearTimeout: () => {}
  };
  const players = [
    { sessionId: 's1', playerId: 1, owner: 0 },
    { sessionId: 's2', playerId: 2, owner: 1 }
  ];
  return {
    dir, clock, players,
    advance: (ms) => { t += ms; },
    make: (extra) => new RoomRuntime(Object.assign({
      roomId: 'ROOM', seed: 'тихая-пойма-123', size: 64,
      players, dir, clock
    }, extra || {}))
  };
}

function flatten(r) {
  const w = r.sim.state.world;
  w.isLand.fill(1);
  if (w.tile) w.tile.fill(globalThis.WorldGen.T.GRASS);
  w.objects = [];
  w.objectTotal = 0;
  w.removedIds = [];
  w._villagerBlocked = null;
  w._treeIndex = null;
  w._villagerAreas = null;
  w.navVersion = (w.navVersion || 0) + 1;
}

function cmd(r, seq, id, payload, epoch) {
  return {
    sessionId: 's1', playerId: 1, owner: 0,
    command: {
      protocol: 4, roomId: 'ROOM', epoch: epoch === undefined ? r.epoch : epoch,
      commandId: id || ('s0-test:' + seq), clientSequence: seq,
      type: 'build', payload: payload || { buildingType: 'house', variant: 'a', rot: 0, x: 10, y: 10 }
    }
  };
}

test('приём: повтор ID не дублирует, другой payload — конфликт, порядок строгий', async () => {
  const c = ctx();
  const r = c.make();
  await r.start();
  const a = await r.submit(cmd(r, 1, 's0-test:1'));
  assert.equal(a.admitted, true);
  assert.equal(a.status, 'received');
  assert.equal(a.nextClientSequence, 2);
  assert.equal(r.queue.length, 1);
  const dup = await r.submit(cmd(r, 1, 's0-test:1'));
  assert.equal(dup.duplicate, true);
  assert.equal(dup.status, 'received');
  assert.equal(r.queue.length, 1, 'повтор не лёг второй раз');

  const conflict = await r.submit(cmd(r, 1, 's0-test:1', {
    buildingType: 'lumbercamp', variant: 'a', rot: 0, x: 30, y: 30
  }));
  assert.equal(conflict.admitted, false);
  assert.equal(conflict.reasonCode, 'command_id_conflict');

  const gap = await r.submit(cmd(r, 3, 's0-test:3'));
  assert.equal(gap.admitted, false);
  assert.equal(gap.reasonCode, 'sequence_gap');

  const stale = await r.submit(cmd(r, 2, 's0-test:2', null, 0));
  assert.equal(stale.admitted, false);
  assert.equal(stale.status, 'stale_epoch');
  await r.close('test');
});

test('применение: result по ID и повтор после applied', async () => {
  const c = ctx();
  const r = c.make();
  await r.start();
  flatten(r);
  r.sim.state.world.towns[0].logs = 100;
  await r.submit(cmd(r, 1, 's0-test:1'));
  await r.executeAndCommitOneTick();
  const st = r.commandState('s1', ['s0-test:1']).results[0];
  assert.equal(st.status, 'applied');
  assert.equal(st.appliedTick, 1);
  assert.equal(st.appliedRevision, 1);
  const dup = await r.submit(cmd(r, 1, 's0-test:1'));
  assert.equal(dup.duplicate, true);
  assert.equal(dup.status, 'applied');
  assert.equal(r.sim.state.buildings.length, 7, 'дом создан один раз');
  await r.close('test');
});

test('durable accept: команда переживает закрытие до tickCommit', async () => {
  const c = ctx();
  const r = c.make();
  await r.start();
  flatten(r);
  flatten(r);
  r.sim.state.world.towns[0].logs = 100;
  await r.submit(cmd(r, 1, 's0-test:1'));
  await r.close('before-tick');          // accept уже fsync, tickCommit нет
  const r2 = c.make();
  await r2.start();
  const st = r2.commandState('s1', ['s0-test:1']).results[0];
  assert.equal(st.status, 'received', 'принятая команда осталась в очереди');
  await r2.executeAndCommitOneTick();
  assert.equal(r2.sim.state.buildings.length, 7);
  assert.equal(r2.commandState('s1', ['s0-test:1']).results[0].status, 'applied');
  await r2.close('test');
});

test('durable tickCommit: результат переживает закрытие, действие не повторяется', async () => {
  const c = ctx();
  const r = c.make();
  await r.start();
  flatten(r);
  r.sim.state.world.towns[0].logs = 100;
  await r.submit(cmd(r, 1, 's0-test:1'));
  await r.executeAndCommitOneTick();
  const before = r.sim.state.buildings.length;
  await r.close('after-commit');
  const r2 = c.make();
  await r2.start();
  assert.equal(r2.tick, 1);
  assert.equal(r2.sim.state.buildings.length, before);
  const st = r2.commandState('s1', ['s0-test:1']).results[0];
  assert.equal(st.status, 'applied');
  const dup = await r2.submit(cmd(r, 1, 's0-test:1'));
  assert.equal(dup.duplicate, true);
  assert.equal(r2.sim.state.buildings.length, before, 'повтор не создал второй дом');
  assert.ok(r2.epoch > r.epoch, 'поколение выросло');
  await r2.close('test');
});

test('fault: частичный шаг не публикуется, комната останавливается', async () => {
  const c = ctx();
  const r = c.make();
  await r.start();
  const before = r.latest.revision;
  const original = r.sim.step;
  r.sim.step = function () {
    r.sim.state.buildings[0].hp = 1;       // частичное изменение
    throw new Error('boom');
  };
  await assert.rejects(r.executeAndCommitOneTick(), /boom/);
  assert.equal(r.status, 'faulted');
  assert.equal(r.latest.revision, before, 'последняя committed версия не сдвинулась');
  assert.equal(r.fault.phase, 'step');
  r.sim.step = original;
  await r.close('test');
});

test('переполнение очереди — явный отказ, ID не consumed', async () => {
  const c = ctx();
  const r = c.make({ commandQueuePerPlayer: 1 });
  await r.start();
  const a = await r.submit(cmd(r, 1, 's0-test:1'));
  assert.equal(a.admitted, true);
  const b = await r.submit(cmd(r, 2, 's0-test:2'));
  assert.equal(b.admitted, false);
  assert.equal(b.reasonCode, 'player_queue_full');
  await r.executeAndCommitOneTick();       // первая команда решена — очередь свободна
  const again = await r.submit(cmd(r, 2, 's0-test:2'));
  assert.equal(again.admitted, true, 'тот же ID принят после освобождения');
  await r.close('test');
});
