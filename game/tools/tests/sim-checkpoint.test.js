'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadEngine, makeSim } = require('./load-engine');

test('T05: capture неизменяем, decode возвращает дерево и точные часы', () => {
  const g = loadEngine();
  const sim = makeSim();
  for (let i = 0; i < 40; i++) sim.step([]);
  const dto = sim.exportState();
  const frozen = JSON.stringify(dto);
  const tree = sim.state.world.objects.find(function (o) { return o.kind === 'tree'; });
  assert.ok(tree, 'в мире есть дерево');
  const beforeRng = sim.state.villagers[0].rng.getState();
  const beforeBirth = JSON.parse(JSON.stringify(sim.state.birth));

  /* Меняем ЖИВОЙ мир после capture: DTO не должен поменяться. */
  sim.state.world.objects = sim.state.world.objects.filter(function (o) { return o !== tree; });
  sim.state.world.removedIds.push(tree.id);
  sim.state.villagers[0].rng.next();
  sim.state.birth.next = 999;
  sim.state.buildings[0].hp = 1;
  assert.equal(JSON.stringify(dto), frozen, 'DTO capture неизменен');

  const restored = g.Checkpoint.decode(dto);
  const back = restored.world.objects.find(function (o) { return o.id === tree.id; });
  assert.ok(back, 'удалённое дерево вернулось');
  assert.ok(restored.world.removedIds.indexOf(tree.id) < 0);
  assert.equal(restored.villagers[0].rng.getState().state, beforeRng.state);
  assert.equal(restored.birth.next, beforeBirth.next);
  assert.ok(restored.buildings[0].hp > 1, 'HP вернулся из capture');
});

test('T06: две ветки из одного capture дают одинаковый мир через 600 тиков', () => {
  const g = loadEngine();
  const a = makeSim();
  for (let i = 0; i < 90; i++) a.step([]);
  const dto = a.exportState();
  const b = g.Simulation.fromState(dto, { gameplay: g.GameplayConfig });
  for (let i = 0; i < 600; i++) { a.step([]); b.step([]); }
  assert.equal(g.Checkpoint.canonicalHash(a.state), g.Checkpoint.canonicalHash(b.state));
  assert.equal(a.state.villagers.length, b.state.villagers.length);
  assert.deepEqual(
    a.state.villagers.map(function (v) { return [v.id, v.state, v.carrying]; }),
    b.state.villagers.map(function (v) { return [v.id, v.state, v.carrying]; })
  );
  assert.deepEqual(a.state.birth, b.state.birth);
});

test('T07: Map/Set/aliases/cycle/typed array, функция — ошибка с путём', () => {
  const g = loadEngine();
  const shared = { name: 'shared' };
  const cycle = { a: 1 };
  cycle.self = cycle;
  const buf = new ArrayBuffer(16);
  const view = new Uint8Array(buf, 4, 8);
  view[0] = 7;
  const state = {
    shared: shared,
    again: shared,
    cycle: cycle,
    map: new Map([['k', shared], [2, cycle]]),
    set: new Set([shared, 3]),
    view: view,
    buffer: buf,
    nested: { list: [shared, null, undefined, true, 'строка'] }
  };
  const dto = g.Checkpoint.encode(state);
  const back = g.Checkpoint.decode(dto);
  assert.strictEqual(back.shared, back.again, 'алиас сохранён');
  assert.strictEqual(back.cycle.self, back.cycle, 'цикл сохранён');
  assert.strictEqual(back.map.get('k'), back.shared, 'Map хранит ту же ссылку');
  assert.strictEqual(back.view.buffer, back.buffer, 'view и ArrayBuffer — один буфер');
  assert.equal(back.view.byteOffset, 4);
  assert.equal(back.view.length, 8);
  assert.equal(back.view[0], 7);
  assert.equal(back.nested.list[2], undefined);

  assert.throws(function () {
    g.Checkpoint.encode({ good: 1, bad: { fn: function () {} } });
  }, function (e) {
    return e && e.code === 'function_in_state' && /bad\.fn/.test(e.path);
  });
});

test('T08: ledger в capture не меняется вслед за живым', () => {
  const g = loadEngine();
  const sim = makeSim();
  sim.state.ledger = { results: { 's0:1': { status: 'received' } } };
  const dto = sim.exportState();
  const frozen = JSON.stringify(dto);
  sim.state.ledger.results['s0:1'].status = 'applied';
  sim.state.ledger.results['s0:2'] = { status: 'applied' };
  assert.equal(JSON.stringify(dto), frozen);
  const back = g.Checkpoint.decode(dto);
  assert.equal(back.ledger.results['s0:1'].status, 'received');
  assert.equal(back.ledger.results['s0:2'], undefined);
});

test('canonicalHash не зависит от порядка ключей plain object', () => {
  const g = loadEngine();
  const a = { x: 1, y: { p: 2, q: 3 } };
  const b = { y: { q: 3, p: 2 }, x: 1 };
  assert.equal(g.Checkpoint.canonicalHash(a), g.Checkpoint.canonicalHash(b));
});
