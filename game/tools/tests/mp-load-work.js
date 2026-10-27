/* mp-load-work.js — активная работа 100/200 жителей без браузера.

   В отличие от mp-load.js (движение/гуляние), здесь жители реально наняты в
   лагеря, ищут деревья, рубят и сдают брёвна. Это проверка E02 для работы:
   counters подтверждают, что нагрузка не «стоячие жители».

     node game/tools/tests/mp-load-work.js --entities 100 --ticks 600

   Сырой отчёт: game/tools/out/mp-load-work-<n>.json.
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { loadEngine, makeSim } = require('./load-engine');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
function pct(a, p) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))].toFixed(3);
}

async function main() {
  const g = loadEngine();
  const want = Math.max(9, arg('entities', 100));
  const ticks = Math.max(2, arg('ticks', 600));
  const realtime = process.argv.includes('--realtime');
  const memSample = process.argv.includes('--mem-sample');
  const sim = makeSim({ size: 192 });
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

  /* Лес: достаточно целей на всех, id по порядку и сортировка по глубине,
     как у настоящего worldgen. */
  const trees = [];
  for (let y = 3; y < 188; y += 2) {
    for (let x = 3; x < 188; x += 2) {
      if (x % 7 < 2 && y % 7 < 2) continue;
      trees.push({ kind: 'tree', variant: 'oak', x: x + 0.5, y: y + 0.5,
        scale: 1, phase: 0, id: trees.length });
    }
  }
  trees.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  trees.forEach((t, i) => { t.id = i; });
  w.objects = trees;
  w.objectTotal = trees.length;

  /* По три рабочих места на лагерь. Кампании — пополам по владельцам. */
  const need = want - sim.state.villagers.length;
  const campCount = Math.ceil(need / 3);
  const camps = [];
  for (let c = 0; c < campCount; c++) {
    const owner = c % 2;
    const idx = Math.floor(c / 2);
    const x = 6 + (idx % 8) * 22 + owner * 3;
    const y = 8 + Math.floor(idx / 8) * 22 + owner * 2;
    const b = g.Buildings.make({
      type: 'lumbercamp', variant: 'a', rot: 90,
      x: x, y: y, owner: owner, town: owner,
      id: 'p' + owner + ':load' + idx
    });
    sim.state.buildings.push(b);
    camps.push(b);
  }
  g.Buildings.touch(w);

  let hired = 0;
  for (let c = 0; c < camps.length && hired < need; c++) {
    for (let k = 0; k < 3 && hired < need; k++) {
      const v = g.Villagers.blank(w, {
        id: 20000 + hired, index: 20000 + hired, rngKey: 20000 + hired,
        x: camps[c].x + 1 + k, y: camps[c].y + 1,
        owner: camps[c].owner, town: camps[c].owner,
        avoid: sim.state.villagers, buildings: sim.state.buildings
      });
      v.avoid = [];
      sim.state.villagers.push(v);
      const r = g.Session.hire(camps[c], v, sim.state.villagers);
      if (r && r.ok) hired++;
    }
  }
  w._villagers = sim.state.villagers;
  w._buildings = sim.state.buildings;

  const start = new Map(sim.state.villagers.map((v) => [v.id, { x: v.x, y: v.y }]));
  const stepMs = [];
  let navRequests = 0, navReady = 0;
  const wallStart = Date.now();
  for (let t = 0; t < ticks; t++) {
    const t0 = process.hrtime.bigint();
    sim.step([]);
    stepMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    const ns = g.Navigation.diagnostics(w).stats;
    if (ns) { navRequests += ns.requests || 0; navReady += ns.ready || 0; }
    if (memSample && t % 100 === 0) {
      const m = process.memoryUsage();
      console.error('mem t=' + t + ' rss=' + Math.round(m.rss / 1048576) +
        'MB heap=' + Math.round(m.heapUsed / 1048576) + 'MB ext=' +
        Math.round(m.external / 1048576) + 'MB');
    }
    if (realtime) {
      const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
      await sleep(Math.max(0, 50 - elapsed));
    }
  }
  const wallMs = Date.now() - wallStart;

  let moved = 0, withPath = 0, workers = 0, chopping = 0, carrying = 0;
  sim.state.villagers.forEach((v) => {
    const p = start.get(v.id);
    if (p && Math.hypot(v.x - p.x, v.y - p.y) > 0.5) moved++;
    if (v.path && v.path.length) withPath++;
    if (v.employer) workers++;
    if (v.state === 'chop') chopping++;
    if (v.carrying) carrying++;
  });
  const felled = w.towns.reduce((n, t) => n + (t.felled || 0), 0);
  const logs = w.towns.reduce((n, t) => n + (t.logs || 0), 0);
  const out = {
    scenario: 'work',
    entities: sim.state.villagers.length,
    workers: hired,
    camps: camps.length,
    trees: trees.length,
    ticks: ticks,
    realtime: realtime,
    wallMs: wallMs,
    stepMs: { p50: pct(stepMs, 0.5), p95: pct(stepMs, 0.95), p99: pct(stepMs, 0.99),
      max: +Math.max.apply(null, stepMs).toFixed(3) },
    activity: {
      moved: moved, withPath: withPath, workers: workers,
      chopping: chopping, carrying: carrying,
      navRequests: navRequests, navReady: navReady,
      felled: felled, logs: logs
    },
    logCounts: w.towns.map((t) => t.logs || 0),
    memory: process.memoryUsage()
  };
  const dir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mp-load-work-' + out.entities + '.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  console.log('written ' + file);
}

if (require.main === module) main().catch(function (e) { console.error(e); process.exit(1); });
module.exports = { main: main };
