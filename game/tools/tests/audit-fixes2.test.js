/* audit-fixes2.test.js — вторая пачка репро-тестов аудита 2026-10-28. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./load-engine.js');

test('M-02: погибший лесоруб снимает метку с дерева', () => {
  const g = E.loadEngine();
  const tree = { id: 't1', kind: 'tree', x: 10, y: 10 };
  const world = { objects: [tree], _villagers: [] };
  const v = { id: 1, x: 10, y: 10, tree: tree };
  tree.mark = v;
  g.Combat.killVillager(v, world);
  assert.equal(tree.mark, null, 'метка дерева должна быть снята');
});

test('M-07: снос дома выселяет жильцов (v.home = null)', () => {
  const g = E.loadEngine();
  const w = g.WorldGen.generate({ seed: 'house-home', size: 64 });
  const house = g.Buildings.make({ type: 'house', variant: 'a', rot: 0, x: 10, y: 10, owner: 0, town: 0, id: 'h1' });
  const v = { id: 1, owner: 0, town: 0, home: house, employer: null, trainee: false, station: null };
  const res = g.Buildings.remove(w, [house], house, { villagers: [v] });
  assert.equal(res.ok, true);
  assert.equal(v.home, null, 'v.home не должен указывать на снесённый дом');
});

test('M-10: разрушенный военный лагерь можно убрать', () => {
  const g = E.loadEngine();
  const wc = g.Buildings.make({ type: 'warcamp', variant: 'x', rot: 0, x: 10, y: 10, owner: 0, town: 0, id: 'w1' });
  wc.rubble = true;
  const can = g.Buildings.canEdit(wc, 'remove');
  assert.equal(can.ok, true, 'завал лагеря не должен запирать 5x5 навсегда');
});

test('M-06b: повтор атаки после вытеснения события создаёт новую запись, а не правит мёртвую', () => {
  const g = E.loadEngine();
  const w = { time: 0, objects: [] };
  g.Events.init(w);
  const first = g.Events.attack(w, 0, 10, 10);
  for (let i = 0; i < g.Events.MAX + 3; i++) {
    g.Events.refuse(w, 0, 'build', 'нет', 1, 1);
  }
  const second = g.Events.attack(w, 0, 31, 32);
  assert.ok(second, 'атака должна вернуть событие');
  assert.ok(g.Events.list(w).indexOf(second) >= 0,
    'событие повтора должно быть в журнале, а не в вытесненном объекте');
});

test('M-12b: военный лагерь с чужим вариантом отклоняется', () => {
  const g = E.loadEngine();
  const sim = E.makeSim({ players: 2, mode: 'multi' });
  const st = sim.state;
  const town = st.world.towns[0];
  town.logs = 500;
  let spot = null;
  const fp = g.Buildings.footprint(0, 'warcamp');
  for (let y = 1; y < 40 && !spot; y++) {
    for (let x = 1; x < 40 && !spot; x++) {
      const b = g.Buildings.make({ type: 'warcamp', variant: 'x', rot: 0, x, y, owner: 0, town: 0 });
      if (g.Buildings.canPlace(st.world, st.buildings, b, {
        clearable: false, requireClear: true, yard: g.Buildings.YARD, villagers: st.villagers
      }).ok) spot = { x, y };
    }
  }
  assert.ok(spot);
  const r = g.Commands.apply(st, {
    type: 'build', owner: 0,
    payload: { buildingType: 'warcamp', variant: 'a', rot: 0, x: spot.x, y: spot.y }
  });
  assert.equal(r.status, 'rejected');
  assert.equal(r.reasonCode, 'bad_variant');
});

test('M-09: завал проходим и застраиваем: новый дом сминает руину', () => {
  const g = E.loadEngine();
  const w = g.WorldGen.generate({ seed: 'rubble-fix', size: 64 });
  const B = g.Buildings;
  /* Годное место под дом ищем тем же findSpot, что и игра. */
  const spot = B.findSpot(w, [], 'a', B.FACE_ROT, {
    type: 'house', center: { x: w.width / 2, y: w.height / 2 }, range: 14,
    minSep: 0, clearable: true, requireClear: false, yard: 1
  });
  assert.ok(spot, 'нашлось место под дом');
  const ruin = B.make({ type: 'house', variant: 'a', rot: B.FACE_ROT, x: spot.x, y: spot.y, owner: 0, town: 0, id: 'r1' });
  ruin.rubble = true;
  const solid = g.Villagers.blockedMap(w, [ruin]);
  assert.equal(solid[spot.y * w.width + spot.x], 0, 'клетка завала проходима');
  const cand = B.make({ type: 'house', variant: 'a', rot: B.FACE_ROT, x: spot.x, y: spot.y, owner: 0, town: 0, id: 'n1' });
  const chk = B.canPlace(w, [ruin], cand, {
    clearable: true, requireClear: false, yard: 1, villagers: []
  });
  assert.equal(chk.ok, true, 'на завал можно поставить дом: ' + chk.reason);
});

test('M-11: дом с дверью в воду не ставится', () => {
  const g = E.loadEngine();
  const B = g.Buildings, WG = g.WorldGen;
  const w = WG.generate({ seed: 'door-water', size: 64 });
  const spot = B.findSpot(w, [], 'a', B.FACE_ROT, {
    type: 'house', center: { x: w.width / 2, y: w.height / 2 }, range: 14,
    minSep: 0, clearable: true, requireClear: false, yard: 1
  });
  assert.ok(spot);
  const b = B.make({ type: 'house', variant: 'a', rot: B.FACE_ROT, x: spot.x, y: spot.y, owner: 0, town: 0 });
  const front = B.frontSpot(b);
  assert.ok(front, 'у дома есть дверь');
  const fx = Math.floor(front.x), fy = Math.floor(front.y);
  const idx = fy * w.width + fx;
  /* Только клетка двери — вода; остальные выходы свободны. */
  w.tile[idx] = WG.T.WATER;
  if (w.isLand) w.isLand[idx] = 0;
  const chk = B.canPlace(w, [], b, { clearable: true, requireClear: false, yard: 1, villagers: [] });
  assert.equal(chk.ok, false, 'дверь в воду — не место для дома');
  assert.match(chk.reason, /дверь|выход/);
});
