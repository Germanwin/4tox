/* mp-active-window.js — полное окно RoomRuntime с активным миром.

   Не worker/SSE: runtime, commit/journal/checkpoint/snapshot и 200 активных
   жителей в одном процессе. Нужен, чтобы проверить 20 тиков/с и 10 снимков/с
   не на пустой комнате. Часы и таймеры инжектированы, цикл ручной.

     node game/tools/tests/mp-active-window.js --seconds 180 --entities 200
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { loadEngine, makeSim } = require('./load-engine');
const { RoomRuntime } = require('../../server/room-runtime.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pct(a, p) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))].toFixed(3);
}

async function main() {
  const g = loadEngine();
  const seconds = Math.max(2, arg('seconds', 180));
  const want = Math.max(10, arg('entities', 200));
  const ticks = Math.round(seconds * 20);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-active-window-'));
  let snaps = 0, snapLast = null;
  const clock = {
    now: () => Date.now(),
    setTimeout: () => 0, setImmediate: () => 0, clearTimeout: () => {}
  };
  const runtime = new RoomRuntime({
    roomId: 'ACTIVEWINDOW', seed: 'тихая-пойма-123', size: 192,
    players: [
      { sessionId: 's0', playerId: 1, owner: 0, name: 'A' },
      { sessionId: 's1', playerId: 2, owner: 1, name: 'B' }
    ],
    dir: dir, clock: clock,
    onSnapshot: function (s) { snaps++; snapLast = s; }
  });
  await runtime.start();

  /* Активный мир: 200 гуляющих с якорем, как в mp-load, плюс маршруты. */
  const active = makeSim({ size: 192 });
  const w = active.state.world;
  w.objects = []; w.objectTotal = 0; w.removedIds = []; w._treeIndex = null;
  w._villagerBlocked = null; w._villagerAreas = null;
  w.isLand.fill(1); if (w.tile) w.tile.fill(g.WorldGen.T.GRASS);
  w._buildings = active.state.buildings;
  for (let i = 0; i < want; i++) {
    const x = 5 + (i % 20) * 8, y = 5 + Math.floor(i / 20) * 8;
    const v = g.Villagers.blank(w, {
      id: 70000 + i, index: 70000 + i, rngKey: 70000 + i,
      x: x, y: y, owner: i % 2, town: i % 2,
      avoid: active.state.villagers, buildings: active.state.buildings
    });
    v.state = 'wander'; v.path = null;
    v.anchor = { x: x, y: y }; v.avoid = [];
    active.state.villagers.push(v);
  }
  w._villagers = active.state.villagers;
  runtime.sim = active;
  runtime.tick = 0; runtime.revision = 0;
  runtime.latest = null; runtime.baselinePending = false;

  const stepMs = [];
  let navRequests = 0, navReady = 0;
  const started = Date.now();
  for (let t = 0; t < ticks; t++) {
    const t0 = process.hrtime.bigint();
    await runtime.executeAndCommitOneTick();
    stepMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
    const ns = g.Navigation.diagnostics(w).stats;
    if (ns) { navRequests += ns.requests || 0; navReady += ns.ready || 0; }
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
    await sleep(Math.max(0, 50 - elapsed));
  }
  const wallMs = Date.now() - started;
  let moved = 0, withPath = 0;
  active.state.villagers.forEach((v) => {
    if (v.anchor && Math.hypot(v.x - v.anchor.x, v.y - v.anchor.y) > 0.5) moved++;
    if (v.path && v.path.length) withPath++;
  });
  const snapText = snapLast ? JSON.stringify(snapLast) : '';
  const out = {
    scenario: 'active-window',
    plannedSeconds: seconds,
    observedSeconds: +(wallMs / 1000).toFixed(3),
    entities: active.state.villagers.length,
    ticks: runtime.tick,
    committedTickRate: +(runtime.tick / (wallMs / 1000)).toFixed(3),
    snapshots: snaps,
    snapshotsPerSecond: +(snaps / (wallMs / 1000)).toFixed(3),
    snapshotBytes: snapText ? Buffer.byteLength(snapText, 'utf8') : 0,
    snapshotGzip: snapText ? zlib.gzipSync(snapText, { level: 1 }).length : 0,
    stepMs: { p50: pct(stepMs, 0.5), p95: pct(stepMs, 0.95), p99: pct(stepMs, 0.99),
      max: +Math.max.apply(null, stepMs).toFixed(3) },
    activity: { moved: moved, withPath: withPath, navRequests: navRequests, navReady: navReady },
    memory: process.memoryUsage()
  };
  const file = path.join(__dirname, '..', 'out', 'mp-active-window-' + want + '.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  console.log('written ' + file);
  await runtime.close('active-window');
}
main().catch((e) => { console.error(e); process.exit(1); });
