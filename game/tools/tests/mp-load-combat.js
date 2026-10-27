/* mp-load-combat.js — активный бой 100/200 воинов без браузера.

   Воины двух владельцев стоят у вражеской ратуши и реально выбирают цели,
   бьют здания и друг друга. Это вторая половина E02: не «стоячие» юниты, а
   подтверждённые target/combatMode/урон.

     node game/tools/tests/mp-load-combat.js --entities 100 --ticks 300

   Сырой отчёт: game/tools/out/mp-load-combat-<n>.json.
*/
'use strict';

const fs = require('fs');
const path = require('path');
const { loadEngine, makeSim } = require('./load-engine');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
function pct(a, p) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))].toFixed(3);
}

function main() {
  const g = loadEngine();
  const want = Math.max(10, arg('entities', 100));
  const ticks = Math.max(2, arg('ticks', 300));
  const sim = makeSim({ size: 128 });
  const w = sim.state.world;
  w.objects = [];
  w.objectTotal = 0;
  w.removedIds = [];
  w._villagerBlocked = null;
  w._treeIndex = null;
  w._villagerAreas = null;
  w.isLand.fill(1);
  if (w.tile) w.tile.fill(g.WorldGen.T.GRASS);
  w._buildings = sim.state.buildings;

  const enemy = sim.state.buildings.find((b) => b.type === 'townhall' && b.owner === 1) ||
    sim.state.buildings.find((b) => b.owner === 1);
  if (!enemy) throw new Error('no_enemy_town');
  const hpBefore = sim.state.buildings.filter((b) => b.owner === 1)
    .reduce((n, b) => n + (b.hp || 0), 0);

  const perSide = Math.ceil(want / 2);
  let made = 0;
  for (let side = 0; side < 2; side++) {
    for (let i = 0; i < perSide; i++) {
      const x = enemy.x + 5 + (i % 10) * 0.45 + (side ? 2.5 : -2.5);
      const y = enemy.y + 6 + Math.floor(i / 10) * 0.45 + (side ? 2.5 : -2.5);
      const v = g.Villagers.blank(w, {
        id: 40000 + made, index: 40000 + made, rngKey: 40000 + made,
        x: x, y: y, owner: side, town: side,
        avoid: sim.state.villagers, buildings: sim.state.buildings
      });
      v.warrior = true;
      v.state = 'patrol';
      v.order = { x: enemy.x + 1, y: enemy.y + 1 };
      v.anchor = { x: x, y: y };
      v.avoid = [];
      sim.state.villagers.push(v);
      made++;
    }
  }
  w._villagers = sim.state.villagers;
  w._buildings = sim.state.buildings;

  const stepMs = [];
  let navRequests = 0, navReady = 0, maxCombat = 0, maxTargets = 0;
  for (let t = 0; t < ticks; t++) {
    const t0 = process.hrtime.bigint();
    sim.step([]);
    stepMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    const ns = g.Navigation.diagnostics(w).stats;
    if (ns) { navRequests += ns.requests || 0; navReady += ns.ready || 0; }
    let c = 0, tg = 0;
    for (const v of sim.state.villagers) {
      if (!v.warrior) continue;
      if (v.combatMode) c++;
      if (v.target) tg++;
    }
    if (c > maxCombat) maxCombat = c;
    if (tg > maxTargets) maxTargets = tg;
  }

  let aliveWarriors = 0, combatNow = 0, targetNow = 0;
  for (const v of sim.state.villagers) {
    if (!v.warrior) continue;
    aliveWarriors++;
    if (v.combatMode) combatNow++;
    if (v.target) targetNow++;
  }
  const hpAfter = sim.state.buildings.filter((b) => b.owner === 1)
    .reduce((n, b) => n + (b.hp || 0), 0);
  const out = {
    scenario: 'combat',
    warriorsStart: made,
    warriorsAlive: aliveWarriors,
    warriorsLost: made - aliveWarriors,
    ticks: ticks,
    stepMs: { p50: pct(stepMs, 0.5), p95: pct(stepMs, 0.95), p99: pct(stepMs, 0.99),
      max: +Math.max.apply(null, stepMs).toFixed(3) },
    activity: {
      maxCombat: maxCombat, maxTargets: maxTargets,
      combatNow: combatNow, targetNow: targetNow,
      navRequests: navRequests, navReady: navReady,
      hpBefore: hpBefore, hpAfter: hpAfter, damage: hpBefore - hpAfter
    },
    memory: process.memoryUsage()
  };
  const dir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mp-load-combat-' + made + '.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  console.log('written ' + file);
}

if (require.main === module) main();
module.exports = { main: main };
