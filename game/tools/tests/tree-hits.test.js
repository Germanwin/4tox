/* tree-hits.test.js — удары по деревьям из сетевого снимка.

   Сервер шлёт id дерева и возраст удара. Клиент обязан качнуть ИМЕННО это
   дерево и ровно с той фазой затухания, а чужой/уже срубленный id — тихо
   пропустить. Иначе дерево либо не трясётся вовсе, либо дрожит вечно.

   Запуск: node --test game/tools/tests/tree-hits.test.js */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const TreeHits = require('../../js/tree-hits.js');
const { loadEngine, makeSim } = require('./load-engine');

test('удар применяется к своему дереву и с возрастом удара', () => {
  const world = {
    objects: [
      { id: 7, kind: 'tree' },
      { id: 8, kind: 'stone' }
    ]
  };
  TreeHits.apply(world, [{ id: 7, age: 120 }], 50);
  assert.equal(world.objects[0].shake, 1);
  assert.ok(Math.abs(world.objects[0]._shakeT - 49.88) < 1e-9,
    'момент удара сдвинут на возраст: ' + world.objects[0]._shakeT);
  assert.equal(world.objects[1].shake, undefined, 'камень не трясётся');
});

test('неизвестный id и пустой список ничего не ломают', () => {
  const world = { objects: [{ id: 2, kind: 'tree' }] };
  TreeHits.apply(world, [{ id: 999, age: 0 }], 10);
  assert.equal(world.objects[0].shake, undefined);
  TreeHits.apply(world, null, 10);
  TreeHits.apply(null, [{ id: 2, age: 0 }], 10);
});

test('сервер кладёт реальный удар в снимок с возрастом', () => {
  const g = loadEngine();
  const sim = makeSim();
  const w = sim.state.world;
  w.objects = [{
    id: 7, kind: 'tree', variant: 'oak', x: 10.5, y: 10.5, scale: 1
  }];
  w.objectTotal = 1;
  w.removedIds = [];
  sim.state.tick = 30;
  w.time = 1.5;
  const v = { hits: 0, chopT: 0, tree: w.objects[0] };
  g.Villagers.strike(v, w);
  assert.equal(w._treeHits.length, 1, 'удар записан один раз');
  assert.equal(w._treeHits[0].id, 7);
  const snap = g.Replication.build(sim.state, {
    revision: 1, roomId: 'TREE', epoch: 1
  });
  assert.deepEqual(snap.treeHits, [{ id: 7, age: 0 }]);
});
