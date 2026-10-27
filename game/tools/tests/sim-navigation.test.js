'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadEngine } = require('./load-engine');

function makeWorld(W, wall) {
  W = W || 96;
  const world = {
    width: W, height: W, seed: 'nav',
    isLand: new Uint8Array(W * W).fill(1),
    objects: [], removedIds: [], navVersion: 0,
    _buildings: [], time: 0
  };
  if (wall) {
    /* Стена через карту с одной дырой: прямой путь в 125 клеток не
       укладывается в quantum 256, и поиск обязан продолжиться на следующем
       тике, а не соврать unreachable. */
    let id = 0;
    const x = Math.floor(W / 2);
    for (let y = 0; y < W; y++) {
      if (Math.abs(y - Math.floor(W * 0.75)) < 2) continue;
      world.objects.push({ id: id++, kind: 'tree', x: x + 0.5, y: y + 0.5 });
    }
    world.objectTotal = world.objects.length;
  }
  return world;
}

function req(world, id, sx, sy, tx, ty, purpose) {
  return globalThis.Navigation.requestPath(world, {
    entityId: id, purpose: purpose || 'test',
    sx, sy, tx, ty,
    passabilityVersion: globalThis.Navigation.versionOf(world)
  });
}

test('T04: длина пути за тик ограничена, deferred не стал unreachable', () => {
  const g = loadEngine();
  const world = makeWorld(96, true);
  const N = g.Navigation;
  let ready = 0, deferred = 0, unreachable = 0;
  for (let tick = 0; tick < 20; tick++) {
    N.beginTick(world);
    for (let i = 0; i < 40; i++) {
      const r = i % 10 === 0
        ? req(world, tick * 40 + i, 1, 1, 90, 90, 'batch-long')
        : req(world, tick * 40 + i, 1, 1, 20, 20, 'batch-short');
      if (r.status === 'ready') ready++;
      else if (r.status === 'deferred') deferred++;
      else if (r.status === 'unreachable') unreachable++;
    }
    assert.ok(world._navigation.stats.tickPops <= 4096,
      'за тик не больше 4096 снятий: ' + world._navigation.stats.tickPops);
  }
  assert.ok(ready > 0, 'часть коротких запросов успела');
  assert.ok(deferred > 0, 'часть длинных отложена');
  assert.equal(unreachable, 0, 'на всей суше нет ложного unreachable');
});

test('долгий поиск продолжается, а не начинается заново', () => {
  const g = loadEngine();
  const world = makeWorld(128, true);
  const N = g.Navigation;
  N.beginTick(world);
  let r = req(world, 7, 1, 1, 126, 126, 'long');
  assert.equal(r.status, 'deferred');
  let ticks = 0;
  while (r.status === 'deferred' && ticks++ < 200) {
    N.beginTick(world);
    r = req(world, 7, 1, 1, 126, 126, 'long');
  }
  assert.equal(r.status, 'ready', 'поиск завершился');
  assert.ok(r.path.length > 100, 'путь через карту: ' + r.path.length);
});

test('смена версии проходимости отменяет старый job', () => {
  const g = loadEngine();
  const world = makeWorld(128, true);
  const N = g.Navigation;
  N.beginTick(world);
  let r = req(world, 9, 1, 1, 126, 126, 'long');
  assert.equal(r.status, 'deferred');
  world.navVersion++;
  N.beginTick(world);
  assert.equal(world._navigation.active.length, 0, 'старый job отменён');
  let rr = req(world, 9, 1, 1, 126, 126, 'long');
  assert.ok(rr.status === 'deferred' || rr.status === 'ready');
});

test('checkpoint продолжает открытый поиск эквивалентно', () => {
  const g = loadEngine();
  const N = g.Navigation;
  const a = makeWorld(112, true);
  N.beginTick(a);
  let r = req(a, 11, 1, 1, 110, 110, 'long');
  assert.equal(r.status, 'deferred');
  const dto = g.Checkpoint.encode({ world: a });
  const b = g.Checkpoint.decode(dto).world;
  let ra = r, rb = req(b, 11, 1, 1, 110, 110, 'long');
  let guard = 0;
  while (guard++ < 300) {
    N.beginTick(a);
    ra = req(a, 11, 1, 1, 110, 110, 'long');
    if (ra.status !== 'deferred') break;
  }
  guard = 0;
  while (guard++ < 300) {
    N.beginTick(b);
    rb = req(b, 11, 1, 1, 110, 110, 'long');
    if (rb.status !== 'deferred') break;
  }
  assert.equal(ra.status, 'ready');
  assert.equal(rb.status, 'ready');
  assert.deepEqual(rb.path, ra.path, 'продолжение дало тот же маршрут');
});

test('мёртвый житель освобождает job', () => {
  const g = loadEngine();
  const world = makeWorld(128, true);
  const N = g.Navigation;
  N.beginTick(world);
  const r = req(world, 42, 1, 1, 126, 126, 'long');
  assert.equal(r.status, 'deferred');
  N.cancelEntity(world, 42);
  assert.equal(world._navigation.active.length + world._navigation.waiting.length, 0);
});
