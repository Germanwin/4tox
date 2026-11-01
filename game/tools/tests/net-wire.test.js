/* net-wire.test.js — двоичный кадр снимка: полнота, размер, скорость.

   Проверка не «кодек не падает», а «клиент получает ТО ЖЕ состояние»:
   каждый житель, постройка и деревня после pack/unpack совпадают с JSON-
   снимком в пределах заявленной точности (0.01 клетки, 1 градус). Плюс
   кадр на 300 жителях обязан быть в несколько раз меньше JSON и
   собираться/разбираться за единицы миллисекунд.

   Запуск: node --test game/tools/tests/net-wire.test.js */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine, makeSim } = require('./load-engine');
const Wire = require('../../shared/net-wire.js');

function pct(arr, p) {
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];
}

function stage300() {
  const g = loadEngine();
  const sim = makeSim();
  const w = sim.state.world;
  w.objects = [];
  w.objectTotal = 0;
  w.removedIds = [];
  w.townTotal = 0;
  w._villagerBlocked = null;
  w._treeIndex = null;
  w._villagerAreas = null;
  w.isLand.fill(1);
  if (w.tile) w.tile.fill(g.WorldGen.T.GRASS);
  w._buildings = sim.state.buildings;
  const current = sim.state.villagers.length;
  for (let i = current; i < 300; i++) {
    const v = g.Villagers.blank(w, {
      id: 10000 + i, index: 10000 + i, rngKey: 10000 + i,
      x: 2 + (i % 50), y: 2 + Math.floor(i / 50) * 2,
      owner: i % 2, town: i % 2,
      avoid: sim.state.villagers, buildings: sim.state.buildings
    });
    v.state = 'wander';
    v.path = null;
    v.anchor = { x: v.x, y: v.y };
    v.avoid = [];
    sim.state.villagers.push(v);
    if (w.towns[i % 2]) w.towns[i % 2].villagers.push(v);
  }
  w._villagers = sim.state.villagers;
  for (let t = 0; t < 120; t++) sim.step([]);
  g.Replication.reset();
  for (let t = 0; t < 30; t++) {
    sim.step([]);
    if (t % 2 === 0) {
      g.Replication.build(sim.state, {
        revision: t, serverGeneratedAtMs: t * 50, roomId: 'WIRE', epoch: 1
      });
    }
  }
  return g.Replication.build(sim.state, {
    revision: 999, serverGeneratedAtMs: 9999, roomId: 'WIRE', epoch: 1,
    baseline: true,
    commandResults: [{
      commandId: 's0-abcd:1', clientSequence: 1, sessionId: '0',
      playerId: 1, owner: 0, status: 'applied', reasonCode: 'ok',
      reason: '', ids: [1, 2], appliedTick: 5, appliedRevision: 6,
      decidedTick: 5, decidedRevision: 6, epoch: 1
    }]
  });
}

function near(a, b, eps) {
  return Math.abs(a - b) <= eps;
}

test('снимок на 300 жителях: полный roundtrip и размер', () => {
  const snap = stage300();
  const jsonBytes = Buffer.byteLength(JSON.stringify(snap), 'utf8');
  const packed = Wire.packSnapshot(snap);
  assert.equal(Buffer.from(packed.subarray(0, 4)).toString('ascii'), '4TX1');
  const out = Wire.unpackSnapshot(packed);

  assert.ok(packed.byteLength < jsonBytes * 0.25,
    'двоичный кадр должен быть вчетверо меньше JSON: ' +
    packed.byteLength + ' < ' + jsonBytes * 0.25);
  assert.ok(packed.byteLength > 1000, 'кадр не пустой');

  assert.equal(out.protocol, snap.protocol);
  assert.equal(out.roomId, snap.roomId);
  assert.equal(out.epoch, snap.epoch);
  assert.equal(out.revision, snap.revision);
  assert.equal(out.seq, snap.seq);
  assert.equal(out.simulationTick, snap.simulationTick);
  assert.equal(out.simulationTimeMs, snap.simulationTimeMs);
  assert.equal(out.serverGeneratedAtMs, snap.serverGeneratedAtMs);
  assert.equal(out.seed, snap.seed);
  assert.equal(out.size, snap.size);
  assert.equal(out.over, snap.over);
  assert.equal(out.baseline, true);
  assert.equal(out.objectTotal, snap.objectTotal);
  assert.equal(out.removed, snap.removed);
  assert.equal(out.worldgenHash, snap.worldgenHash);
  assert.equal(out.gameplayConfigHash, snap.gameplayConfigHash);

  assert.equal(out.towns.length, snap.towns.length);
  for (let i = 0; i < snap.towns.length; i++) {
    for (const k of Object.keys(snap.towns[i])) {
      assert.deepEqual(out.towns[i][k], snap.towns[i][k], 'town ' + i + '.' + k);
    }
  }

  assert.equal(out.buildings.length, snap.buildings.length);
  for (let i = 0; i < snap.buildings.length; i++) {
    const a = snap.buildings[i], b = out.buildings[i];
    for (const k of ['id', 'type', 'variant', 'rot', 'owner', 'town', 'rubble']) {
      assert.deepEqual(b[k], a[k], 'building ' + i + '.' + k);
    }
    assert.ok(near(b.x, a.x, 0.01) && near(b.y, a.y, 0.01), 'building coord');
    assert.ok(near(b.hp, a.hp, 0.01) && near(b.maxHp, a.maxHp, 0.01), 'building hp');
  }

  assert.equal(out.villagers.length, snap.villagers.length);
  let motionPoints = 0;
  for (let i = 0; i < snap.villagers.length; i++) {
    const a = snap.villagers[i], b = out.villagers[i];
    assert.equal(b.id, a.id);
    assert.ok(near(b.x, a.x, 0.01), 'v' + a.id + '.x');
    assert.ok(near(b.y, a.y, 0.01), 'v' + a.id + '.y');
    assert.ok(near(b.rot || 0, a.rot || 0, 1), 'v' + a.id + '.rot');
    for (const k of ['anim', 'phase', 'homeId', 'employerId', 'campId',
      'stationId', 'trainingId', 'state', 'carrying', 'warrior', 'trainee',
      'hidden', 'dead', 'safeExtrapolationTo', 'orderX', 'orderY']) {
      if (a[k] === undefined) continue;
      if (typeof a[k] === 'number' && k === 'phase') {
        assert.ok(near(b[k], a[k], 1e-3), 'v' + a.id + '.' + k);
      } else {
        assert.deepEqual(b[k], a[k], 'v' + a.id + '.' + k);
      }
    }
    if (a.motion) {
      motionPoints += a.motion.length;
      assert.equal(b.motion.length, a.motion.length);
      for (let m = 0; m < a.motion.length; m++) {
        assert.equal(b.motion[m].t, a.motion[m].t);
        assert.ok(near(b.motion[m].x, a.motion[m].x, 0.01));
        assert.ok(near(b.motion[m].y, a.motion[m].y, 0.01));
      }
    }
  }
  assert.ok(motionPoints > 100, 'в кадре есть движение: ' + motionPoints + ' точек');

  assert.equal(out.commandResults.length, 1);
  assert.equal(out.commandResults[0].commandId, 's0-abcd:1');
  assert.equal(out.commandResults[0].status, 'applied');
  assert.deepEqual(out.commandResults[0].ids, [1, 2]);
  assert.equal(out.commandResults[0].appliedRevision, 6);

  console.error('wire: json=' + jsonBytes + 'B bin=' + packed.byteLength +
    'B (' + Math.round(packed.byteLength / jsonBytes * 100) + '%), motion=' +
    motionPoints + ' pts');
});

test('кодек: скорость на 300 жителях', () => {
  const snap = stage300();
  const pack = [], unpack = [];
  let buf = null;
  for (let i = 0; i < 40; i++) {
    const t0 = process.hrtime.bigint();
    buf = Wire.packSnapshot(snap, { baseline: i === 0 });
    pack.push(Number(process.hrtime.bigint() - t0) / 1e6);
    const t1 = process.hrtime.bigint();
    Wire.unpackSnapshot(buf);
    unpack.push(Number(process.hrtime.bigint() - t1) / 1e6);
  }
  const p95Pack = pct(pack, 0.95), p95Unpack = pct(unpack, 0.95);
  assert.ok(p95Pack < 12, 'pack p95 ' + p95Pack.toFixed(2) + ' ms');
  assert.ok(p95Unpack < 12, 'unpack p95 ' + p95Unpack.toFixed(2) + ' ms');
  console.error('wire cpu: pack p95=' + p95Pack.toFixed(2) +
    ' ms, unpack p95=' + p95Unpack.toFixed(2) + ' ms');
});

test('кодек: bitmap убранного и null-поля переживают кадр', () => {
  const snap = stage300();
  snap.objectTotal = 37;
  snap.removed = '0500000000';       // биты 0 и 2
  snap.winner = null;
  snap.villagers[0].hp = 4.5;
  snap.villagers[0].deathTimeMs = 1234;
  snap.villagers[0].motion = [];
  const out = Wire.unpackSnapshot(Wire.packSnapshot(snap));
  assert.equal(out.objectTotal, 37);
  assert.equal(out.removed, '0500000000');
  assert.equal(out.winner, null);
  assert.equal(out.villagers[0].hp, 4.5);
  assert.equal(out.villagers[0].deathTimeMs, 1234);
  assert.equal(out.villagers[0].motion, undefined);
});

test('кодек: все необязательные поля жителя переживают кадр', () => {
  const snap = stage300();
  const v = snap.villagers[0];
  Object.assign(v, {
    frozen: 1, warrior: 1, trainee: 1, hidden: 1, carrying: 1,
    dead: 1, teleport: 1, hp: 4.5, hpUntil: 12.3, flinch: 0.42,
    attackT: 0.21, trainingId: '0:b1', trainT: 3.25,
    homeId: '0:b1', employerId: '0:b2', campId: '0:b3',
    stationId: '0:b4', appearT: 1.25, appearDur: 2.5,
    vanishT: 0.3, emergeT: 0.45, orderX: 10.5, orderY: 11.25,
    deathTimeMs: 1234, safeExtrapolationTo: 9999, phase: 0.123,
    anim: 'chop', state: 'chop'
  });
  v.motion = [
    { t: 1000, x: 10.25, y: 20.75, rot: 90.4 },
    { t: 1100, x: 11.5, y: 21.5, rot: 180.2 }
  ];
  const out = Wire.unpackSnapshot(Wire.packSnapshot(snap)).villagers[0];
  assert.equal(out.frozen, 1);
  assert.equal(out.warrior, 1);
  assert.equal(out.trainee, 1);
  assert.equal(out.hidden, 1);
  assert.equal(out.carrying, 1);
  assert.equal(out.dead, 1);
  assert.equal(out.teleport, 1);
  assert.equal(out.hp, 4.5);
  assert.equal(out.hpUntil, 12.3);
  assert.equal(out.flinch, 0.42);
  assert.equal(out.attackT, 0.21);
  assert.equal(out.trainingId, '0:b1');
  assert.equal(out.trainT, 3.25);
  assert.equal(out.homeId, '0:b1');
  assert.equal(out.employerId, '0:b2');
  assert.equal(out.campId, '0:b3');
  assert.equal(out.stationId, '0:b4');
  assert.equal(out.appearT, 1.25);
  assert.equal(out.appearDur, 2.5);
  assert.equal(out.vanishT, 0.3);
  assert.equal(out.emergeT, 0.45);
  assert.equal(out.orderX, 10.5);
  assert.equal(out.orderY, 11.25);
  assert.equal(out.deathTimeMs, 1234);
  assert.equal(out.safeExtrapolationTo, 9999);
  assert.equal(out.phase, 0.123);
  assert.equal(out.anim, 'chop');
  assert.equal(out.state, 'chop');
  assert.equal(out.motion.length, 2);
  assert.equal(out.motion[0].t, 1000);
  assert.ok(near(out.motion[0].x, 10.25, 0.01));
  assert.ok(near(out.motion[1].y, 21.5, 0.01));
});

test('удары по деревьям едут в кадре точным id и возрастом', () => {
  const snap = stage300();
  snap.treeHits = [{ id: 123, age: 40 }, { id: 'tree-7', age: 0 }];
  const out = Wire.unpackSnapshot(Wire.packSnapshot(snap));
  assert.equal(Wire.VERSION, 2, 'формат поднят: в кадре появились удары');
  assert.deepEqual(out.treeHits, [
    { id: '123', age: 40 },
    { id: 'tree-7', age: 0 }
  ]);
  const plain = Wire.unpackSnapshot(Wire.packSnapshot(stage300()));
  assert.deepEqual(plain.treeHits, []);
});

test('кодек: битый кадр отвергается, а не рождает пустой мир', () => {
  const snap = stage300();
  const packed = Wire.packSnapshot(snap);
  assert.throws(() => Wire.unpackSnapshot(new Uint8Array([1, 2, 3])), /wire/);
  const cut = packed.slice(0, packed.byteLength - 5);
  assert.throws(() => Wire.unpackSnapshot(cut), /wire/);
  const wrong = packed.slice();
  wrong[0] = 0;
  assert.throws(() => Wire.unpackSnapshot(wrong), /wire/);
});
