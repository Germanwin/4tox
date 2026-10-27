'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadEngine, makeSim, command } = require('./load-engine');

function openWorld(sim) {
  /* Юнит-тест строит на ровной суше: реальный остров может не иметь клетки
     (10,10), и отказ «вода» был бы проверкой карты, а не команды. */
  sim.state.world.isLand.fill(1);
  if (sim.state.world.tile) sim.state.world.tile.fill(globalThis.WorldGen.T.GRASS);
  sim.state.world.objects = [];
  sim.state.world.objectTotal = 0;
  sim.state.world.removedIds = [];
  sim.state.world._villagerBlocked = null;
  sim.state.world._treeIndex = null;
  sim.state.world._villagerAreas = null;
  sim.state.world.navVersion = (sim.state.world.navVersion || 0) + 1;
}

function build(sim, cmd) {
  const out = sim.step([Object.assign(command({ commandId: 's0-c:' + (cmd.n || 1), clientSequence: cmd.n || 1 }), cmd)]);
  return out.commandResults[0];
}

test('build: списание и дом только после проверки места', () => {
  const g = loadEngine();
  const sim = makeSim();
  openWorld(sim);
  sim.state.world.towns[0].logs = 100;
  const before = sim.state.buildings.length;
  const r = build(sim, {
    type: 'build',
    payload: { buildingType: 'house', variant: 'a', rot: 0, x: 10, y: 10 }
  });
  assert.equal(r.status, 'applied');
  assert.equal(sim.state.buildings.length, before + 1);
  assert.equal(sim.state.world.towns[0].logs, 88);
  assert.deepEqual(r.ids, [sim.state.buildings[sim.state.buildings.length - 1].id]);

  sim.state.world.towns[0].logs = 0;
  const r2 = build(sim, {
    commandId: 's0-c:2', clientSequence: 2,
    payload: { buildingType: 'house', variant: 'a', rot: 0, x: 14, y: 10 }
  });
  assert.equal(r2.status, 'rejected');
  assert.equal(r2.reasonCode, 'no_resources');
  assert.equal(sim.state.buildings.length, before + 1);
});

test('buildLine: всё или ничего', () => {
  const g = loadEngine();
  const sim = makeSim();
  openWorld(sim);
  sim.state.world.towns[0].logs = 200;
  const before = sim.state.buildings.length;
  const r = build(sim, {
    type: 'buildLine',
    payload: { buildingType: 'house', variant: 'a', rot: 0, x: 10, y: 20, x2: 20, y2: 20 }
  });
  assert.equal(r.status, 'applied');
  assert.ok(r.ids.length >= 3, 'в линии несколько домов: ' + r.ids.length);
  assert.equal(sim.state.buildings.length, before + r.ids.length);
  assert.equal(sim.state.world.towns[0].logs, 200 - r.ids.length * 12);

  /* Одна клетка линии — вода: план невалиден, ни домов, ни списания. */
  const w = sim.state.world;
  /* Вторая клетка линии — вода: план невалиден. */
  w.isLand[25 * w.width + 13] = 0;
  if (w.tile) w.tile[25 * w.width + 13] = globalThis.WorldGen.T.WATER;
  const logsBefore = w.towns[0].logs;
  const countBefore = sim.state.buildings.length;
  const bad = build(sim, {
    commandId: 's0-c:2', clientSequence: 2, type: 'buildLine',
    payload: { buildingType: 'house', variant: 'a', rot: 0, x: 10, y: 25, x2: 20, y2: 25 }
  });
  assert.equal(bad.status, 'rejected');
  assert.equal(sim.state.buildings.length, countBefore);
  assert.equal(w.towns[0].logs, logsBefore);
});

test('edit: владение, перенос, поворот и снос', () => {
  const g = loadEngine();
  const sim = makeSim();
  openWorld(sim);
  sim.state.world.towns[0].logs = 100;
  const r = build(sim, { payload: { buildingType: 'house', variant: 'a', rot: 0, x: 10, y: 10 } });
  const b = sim.state.buildings.find((x) => x.id === r.ids[0]);
  assert.ok(b);
  const foreign = build(sim, {
    commandId: 's0-c:2', clientSequence: 2, owner: 1,
    type: 'edit', payload: { id: b.id, action: 'delete' }
  });
  assert.equal(foreign.status, 'rejected');
  assert.ok(sim.state.buildings.indexOf(b) >= 0);

  const move = build(sim, {
    commandId: 's0-c:3', clientSequence: 3,
    type: 'edit', payload: { id: b.id, action: 'move', x: 10, y: 14 }
  });
  assert.equal(move.status, 'applied');
  assert.equal(b.y, 14);

  const rot = build(sim, {
    commandId: 's0-c:4', clientSequence: 4,
    type: 'edit', payload: { id: b.id, action: 'rotate' }
  });
  assert.equal(rot.status, 'applied');
  assert.equal(b.rot, 90);

  const del = build(sim, {
    commandId: 's0-c:5', clientSequence: 5,
    type: 'edit', payload: { id: b.id, action: 'delete' }
  });
  assert.equal(del.status, 'applied');
  assert.ok(sim.state.buildings.indexOf(b) < 0);
});

test('order/stop не трогают чужих воинов', () => {
  const g = loadEngine();
  const sim = makeSim();
  openWorld(sim);
  sim.state.world.towns[0].logs = 200;
  const r = build(sim, {
    payload: { buildingType: 'warcamp', variant: 'x', rot: 0, x: 10, y: 10 }
  });
  assert.equal(r.status, 'applied');
  const camp = sim.state.buildings.find((b) => b.id === r.ids[0]);
  const mine = sim.state.villagers.find((v) => v.owner === 0);
  const enemy = sim.state.villagers.find((v) => v.owner === 1);
  mine.warrior = true; mine.warcamp = camp; mine.dead = false;
  enemy.warrior = true; enemy.dead = false;

  const order = build(sim, {
    commandId: 's0-c:2', clientSequence: 2, type: 'order',
    payload: { ids: [mine.id, enemy.id], x: 20, y: 20 }
  });
  assert.equal(order.status, 'applied');
  assert.deepEqual(order.ids, [mine.id], 'чужой id отфильтрован');
  assert.ok(mine.order, 'свой получил приказ');
  assert.ok(!enemy.order, 'чужой не получил');

  const stop = build(sim, {
    commandId: 's0-c:3', clientSequence: 3, type: 'stop',
    payload: { ids: [mine.id] }
  });
  assert.equal(stop.status, 'applied');
  assert.ok(!mine.order);
});

test('неизвестный тип и нечисловые координаты — явный отказ', () => {
  const g = loadEngine();
  const sim = makeSim();
  openWorld(sim);
  sim.state.world.towns[0].logs = 100;
  const unknown = build(sim, { type: 'teleport', payload: {} });
  assert.equal(unknown.status, 'rejected');
  assert.equal(unknown.reasonCode, 'unknown_command');
  const bad = build(sim, {
    commandId: 's0-c:2', clientSequence: 2, type: 'build',
    payload: { buildingType: 'house', variant: 'a', rot: 0, x: NaN, y: 10 }
  });
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.reasonCode, 'bad_coords');
  assert.equal(sim.state.buildings.length, 6);
});
