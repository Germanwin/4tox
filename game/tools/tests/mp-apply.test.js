'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { loadEngine, makeSim } = require('./load-engine');

test('F13: числовые снимки не инвалидируют порядок построек', () => {
  const g = loadEngine();
  const sim = makeSim();
  const snap0 = g.Replication.build(sim.state, {
    revision: 0, serverGeneratedAtMs: 1, roomId: 'R', epoch: 1, baseline: true
  });
  const renderer = {
    setBuildings: 0, setVillagers: 0, selected: null, editing: null,
    setBuildingsFn: function () { this.setBuildings++; },
    setVillagersFn: function () { this.setVillagers++; }
  };
  renderer.setBuildings = function () { this.buildingCalls = (this.buildingCalls || 0) + 1; };
  renderer.setVillagers = function () { this.villagerCalls = (this.villagerCalls || 0) + 1; };
  const world = g.WorldGen.generate({ seed: 'тихая-пойма-123', size: 64 });
  const first = g.Serialize.apply(world, snap0, renderer, { smooth: false });
  assert.equal(renderer.buildingCalls, 1, 'baseline строит порядок один раз');
  const ids = first.buildings.map((b) => b.id);
  const v0 = first.villagers[0];

  for (let i = 0; i < 100; i++) {
    sim.state.world.towns[0].logs = i;
    sim.state.villagers[0].x += 0.01;
    const snap = g.Replication.build(sim.state, {
      revision: i + 1, serverGeneratedAtMs: 2 + i, roomId: 'R', epoch: 1
    });
    g.Serialize.apply(world, snap, renderer, { smooth: false });
  }
  assert.equal(renderer.buildingCalls, 1, '100 позиционных снимков — ноль пересортировок');
  assert.deepEqual(world._buildings.map((b) => b.id), ids, 'id и порядок те же');
  assert.strictEqual(first.villagers[0], v0, 'запись жителя переиспользована');

  sim.state.buildings[1].x += 1;
  sim.state.structureVersion++;
  const moved = g.Replication.build(sim.state, {
    revision: 101, serverGeneratedAtMs: 200, roomId: 'R', epoch: 1
  });
  g.Serialize.apply(world, moved, renderer, { smooth: false });
  assert.ok(renderer.buildingCalls >= 2, 'переезд — структурное изменение');
});
