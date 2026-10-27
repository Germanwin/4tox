/* mp-load.js — нагрузочный прогон комнаты без браузера.

   Не заменяет real-device rendering. Меряет CPU шага симуляции, размер
   независимого снимка и распределение времени шага на 100/200 активных
   жителях. Запуск:
     node game/tools/tests/mp-load.js --entities 100 --ticks 3600
   Сырой отчёт: game/tools/out/mp-load-<n>.json
*/
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const os = require('os');
const path = require('path');
const { loadEngine, makeSim } = require('./load-engine');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}

function pct(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];
}

function main() {
  const g = loadEngine();
  const want = Math.max(6, arg('entities', 100));
  const ticks = Math.max(2, arg('ticks', 3600));
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
  for (let i = current; i < want; i++) {
    const v = g.Villagers.blank(w, {
      id: 10000 + i, index: 10000 + i, rngKey: 10000 + i,
      x: 2 + (i % 50), y: 2 + Math.floor(i / 50) * 2,
      owner: i % 2, town: i % 2,
      avoid: sim.state.villagers,
      buildings: sim.state.buildings
    });
    v.state = 'wander';
    v.path = null;
    /* Якорь и пустой avoid: без них planWander может сразу сдаться. */
    v.anchor = { x: v.x, y: v.y };
    v.avoid = [];
    sim.state.villagers.push(v);
    if (w.towns[i % 2]) w.towns[i % 2].villagers.push(v);
  }
  w._villagers = sim.state.villagers;
  const stepMs = [];
  const snapBytes = [];
  const snapGzip = [];
  const startPos = sim.state.villagers.map(function (v) { return { x: v.x, y: v.y }; });
  let navRequests = 0, navReady = 0;
  const started = process.hrtime.bigint();
  for (let t = 0; t < ticks; t++) {
    const t0 = process.hrtime.bigint();
    sim.step([]);
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    stepMs.push(dt);
    const ns = g.Navigation.diagnostics(w).stats;
    if (ns) { navRequests += ns.requests || 0; navReady += ns.ready || 0; }
    if (t % 2 === 0) {
      const snap = g.Replication.build(sim.state, {
        revision: t + 1, serverGeneratedAtMs: t * 50,
        roomId: 'LOAD', epoch: 1
      });
      const text = JSON.stringify(snap);
      snapBytes.push(Buffer.byteLength(text, 'utf8'));
      snapGzip.push(zlib.gzipSync(text, { level: 1 }).length);
    }
  }
  const totalMs = Number(process.hrtime.bigint() - started) / 1e6;
  let moved = 0, withPath = 0, workers = 0, warriors = 0;
  sim.state.villagers.forEach(function (v, i) {
    var p = startPos[i];
    if (p && Math.hypot(v.x - p.x, v.y - p.y) > 0.5) moved++;
    if (v.path && v.path.length) withPath++;
    if (v.employer) workers++;
    if (v.warrior) warriors++;
  });
  const out = {
    entities: sim.state.villagers.length,
    ticks: ticks,
    totalMs: Math.round(totalMs),
    activity: {
      moved: moved, withPath: withPath, workers: workers, warriors: warriors,
      navRequests: navRequests, navReady: navReady
    },
    stepMs: {
      p50: +pct(stepMs, 0.5).toFixed(3),
      p95: +pct(stepMs, 0.95).toFixed(3),
      p99: +pct(stepMs, 0.99).toFixed(3),
      max: +Math.max.apply(null, stepMs).toFixed(3)
    },
    snapshots: snapBytes.length,
    snapshotBytes: {
      avg: Math.round(snapBytes.reduce((a, b) => a + b, 0) / snapBytes.length),
      max: Math.max.apply(null, snapBytes),
      gzipAvg: Math.round(snapGzip.reduce((a, b) => a + b, 0) / snapGzip.length),
      gzipMax: Math.max.apply(null, snapGzip)
    },
    nav: g.Navigation.diagnostics(w),
    memory: process.memoryUsage()
  };
  const dir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mp-load-' + out.entities + '.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  console.log('written ' + file);
}

if (require.main === module) main();
module.exports = { main: main };
