/* profile.js — замер партии без браузера: время шага, поиск пути, снимок.

   Зачем. В задании на патч есть требования, которые нельзя проверить «на
   глаз»: мир не должен деградировать с ростом населения, один кадр не должен
   замирать на секунды, а снимок — расти без меры. Здесь тот же мир, что
   строит игра (WorldGen + Session + Villagers + Combat), но без картинок:
   шаг за шагом считается всё, что считается в игре, и вокруг каждого шага
   снимается время.

   Что печатает:
     шаг      — p50/p95/p99 и худший шаг мира, мс;
     поиск    — A* в секунду, разобранных клеток на шаг, упоры в бюджет;
     снимок   — размер JSON и время сериализации;
     мир      — жителей/построек/деревьев и память процесса;
     экономика — брёвна, сдачи, срублено, потери на 5-й и 10-й минуте.

   Запуск:
     node mapgen2/tools/profile.js                          # 192, 1 игрок, 10 мин
     node mapgen2/tools/profile.js --size 128 --minutes 3
     node mapgen2/tools/profile.js --players 4 --minutes 15 --json research/metrics.json
     node mapgen2/tools/profile.js --stress 200             # 200 существ

   Код возврата 1 — только если прогон не состоялся (нет карты/деревни), а не
   если число кому-то не понравилось: это измерительный инструмент, а не
   приёмка. Пороговые проверки стоят в приёмках. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'js');
const FILES = ['noise.js', 'rng.js', 'metrics.js', 'worldgen.js', 'buildings.js',
  'hero.js', 'villager.js', 'session.js', 'combat.js', 'army.js', 'serialize.js',
  'events.js'];
for (const f of FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;                 // events.js появится позже
  new Function(fs.readFileSync(p, 'utf8') + '\n//# sourceURL=' + f)();
}

const WG = globalThis.WorldGen;
const B = globalThis.Buildings;
const V = globalThis.Villagers;
const S = globalThis.Session;
const C = globalThis.Combat;
const Ser = globalThis.Serialize;
const M = globalThis.Metrics;
if (!WG || !B || !V || !S || !Ser) {
  console.error('нет движка: проверьте пути к mapgen2/js');
  process.exit(1);
}

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const SIZE = parseInt(arg('size', '192'), 10);
const MINUTES = parseFloat(arg('minutes', '10'));
const PLAYERS = Math.max(1, parseInt(arg('players', '1'), 10));
const STRESS = parseInt(arg('stress', '0'), 10);
const SEED = String(arg('seed', 'патч-замер-1'));
const JSON_OUT = arg('json', null);
const DT = 1 / 60;
const STEPS = Math.round(MINUTES * 60 / DT);

/* Отладочный рендер: движок спрашивает у него только «есть ли атлас» и
   «покажи списки». Картинки здесь нет и не должно быть. */
const ANIMS = {};
if (V && V.ANIM_FALLBACK) {
  for (const k of Object.keys(V.ANIM_FALLBACK)) {
    ANIMS[k] = { frames: 6, fps: 10, loop: true };
  }
}
ANIMS.work = { frames: 8, fps: 12, loop: false };
ANIMS.walk = { frames: 8, fps: 12, loop: true };
ANIMS.carry_put = { frames: 4, fps: 12, loop: false };

const renderer = {
  villagerSprites: { anims: ANIMS, frames: {} },
  world: null,
  setVillagers() {},
  setBuildings() {},
  fitIsland() {},
  buildCache() {}
};

function pct(list, q) {
  if (!list.length) return 0;
  const i = Math.min(list.length - 1, Math.floor(q * (list.length - 1)));
  return list[i];
}

function ms() { return Number(process.hrtime.bigint()) / 1e6; }

function worldNow() {
  const world = WG.generate({ seed: SEED, size: SIZE });
  let villagers, buildings, home;
  if (PLAYERS > 1) {
    const st = S.startMulti(world, renderer, { players: Math.min(4, PLAYERS) });
    villagers = st.villagers;
    buildings = st.buildings;
    home = st.home;
  } else {
    const st = S.startHome(world, renderer);
    buildings = st.buildings;
    home = st.home;
    villagers = S.spawnVillagers(world, renderer, buildings, home);
  }
  world.time = 0;
  world.removedIds = world.removedIds || [];

  /* По лагерю на деревню: наём трёх — то, чем игрок и занимается. */
  const towns = world.towns || [world.village];
  for (const town of towns) {
    if (!town) continue;
    const camp = buildings.find(b => B.typeOf(b) === 'lumbercamp' && b.town === town.id);
    if (!camp) continue;
    const mine = villagers.filter(v => v.town === town.id);
    for (const v of mine) {
      if (S.hire(camp, v, villagers).ok) continue;
      if (S.workersOf(camp, villagers).length >= B.workSlots(camp)) break;
    }
  }

  /* Стресс: досыпаем жителей в каждую деревню. Это не правило игры, а
     нагрузочный профиль — «что будет при 100/200 существах». */
  if (STRESS > 0) {
    const per = Math.ceil(STRESS / towns.length / 10) * 10;
    for (const town of towns) {
      if (!town) continue;
      const hall = town.townhall;
      const more = S.spawnVillagers(world, renderer, buildings, hall, {
        count: per, owner: town.owner, townId: town.id,
        idBase: 5000 + town.id * 10000, append: true
      });
      villagers = world._villagers;
      /* Часть — воины в лагере, если он есть. */
      const wc = buildings.find(b => B.typeOf(b) === 'warcamp' && b.town === town.id);
      if (wc) {
        for (let i = 0; i < more.length; i += 4) {
          const v = more[i];
          v.warrior = true; v.warcamp = wc; v.state = 'patrol';
        }
      }
    }
  }

  if (C) C.init(world, buildings, villagers);
  return { world, villagers, buildings, home };
}

function forestReach(world) {
  const towns = world.towns || [world.village];
  const out = [];
  for (const town of towns) {
    if (!town || !town.townhall) continue;
    const camp = (town.buildings || []).find(b => B.typeOf(b) === 'lumbercamp');
    if (!camp) continue;
    const c = B.center(camp);
    const tree = V.treesNear(world, c.x, c.y, 1, null)[0];
    out.push({
      town: town.id,
      forest: tree ? +Math.hypot(tree.x - c.x, tree.y - c.y).toFixed(2) : null
    });
  }
  return out;
}

function main() {
  const t0 = ms();
  const { world, villagers, buildings, home } = worldNow();
  if (!home) {
    console.error('нет ратуши: карта не дала площадку');
    process.exit(1);
  }
  M.on = true;
  M.reset();
  const birth = S.birthClock();
  let seconds = 0;
  const stepTimes = [];
  const snapTimes = [];
  let snapBytes = 0, snaps = 0;
  const economy = [];
  let lastM = M.snapshot();
  let births = 0;

  const wantMarks = [300, 600];
  let mark = 0;

  for (let i = 1; i <= STEPS; i++) {
    const a = ms();
    if (C) C.tick(world, DT, { buildings, villagers });
    seconds += DT;
    if (S.birthDue(birth, seconds)) {
      const born = S.tryBirth(world, renderer, villagers, buildings);
      births += born.length;
    }
    S.stepVillagers(villagers, world, renderer, DT, buildings);
    const b = ms();
    const dtMs = b - a;
    M.step(dtMs);

    /* Первые секунды — прогрев JIT: в перцентили идут после 2-й секунды. */
    if (seconds > 2) stepTimes.push(dtMs);

    if (i % 6 === 0) {
      const s0 = ms();
      const snap = Ser.world(world, buildings, villagers, { seq: i / 6 });
      const s1 = ms();
      const text = JSON.stringify(snap);
      snapBytes += text.length;
      snaps++;
      snapTimes.push(s1 - s0);
      M.snap(s1 - s0, text.length);
    }

    if (mark < wantMarks.length && seconds >= wantMarks[mark]) {
      const town = world.towns ? world.towns[0] : world.village;
      economy.push({
        at: wantMarks[mark],
        logs: town.logs || 0,
        deliveries: town.deliveries || 0,
        felled: town.felled || 0,
        inTransit: town.inTransit || 0,
        lost: town.lost || 0,
        villagers: villagers.length
      });
      mark++;
    }
  }

  const nowM = M.snapshot();
  const wall = ms() - t0;
  stepTimes.sort((x, y) => x - y);
  const town = world.towns ? world.towns[0] : world.village;
  const report = {
    when: new Date().toISOString(),
    seed: SEED, size: SIZE, players: PLAYERS, minutes: MINUTES, stress: STRESS,
    dt: DT,
    steps: STEPS,
    wallMs: Math.round(wall),
    villagers: villagers.length,
    buildings: buildings.length,
    trees: (world.stats && world.stats.trees) || 0,
    births,
    step: {
      p50: +pct(stepTimes, 0.5).toFixed(3),
      p95: +pct(stepTimes, 0.95).toFixed(3),
      p99: +pct(stepTimes, 0.99).toFixed(3),
      max: +(stepTimes[stepTimes.length - 1] || 0).toFixed(3),
      mean: +(nowM.stepMs / Math.max(1, nowM.steps)).toFixed(3)
    },
    paths: {
      calls: nowM.paths, nodes: nowM.nodes, fails: nowM.fails,
      budgetHits: nowM.budgetHits,
      perSec: +(nowM.paths / MINUTES / 60).toFixed(2),
      nodesPerStep: +(nowM.nodes / STEPS).toFixed(1)
    },
    caches: { blockedBuilds: nowM.blockedBuilds, areaBuilds: nowM.areaBuilds },
    snapshot: {
      count: snaps,
      avgBytes: snaps ? Math.round(snapBytes / snaps) : 0,
      maxPerSnapMs: +(Math.max.apply(null, snapTimes.concat(0))).toFixed(3),
      avgSerMs: +(nowM.snapMs / Math.max(1, nowM.snaps)).toFixed(3)
    },
    birthsStats: { born: nowM.births, blocked: nowM.birthBlocked },
    economy,
    forest: forestReach(world),
    treasury: {
      logs: town.logs || 0, deliveries: town.deliveries || 0,
      felled: town.felled || 0, inTransit: town.inTransit || 0,
      lost: town.lost || 0,
      invariant: (town.logs || 0) + V.LOGS_PER_TRIP * (town.inTransit || 0) +
        V.LOGS_PER_TRIP * (town.lost || 0) ===
        V.LOGS_PER_TRIP * (town.felled || 0)
    },
    memoryMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1)
  };

  console.log('сид %s · %d×%d · игроков %d · %s мин · %d существ',
    SEED, SIZE, SIZE, PLAYERS, MINUTES, villagers.length);
  console.log('  шаг мира: p50 %s мм, p95 %s, p99 %s, худший %s',
    report.step.p50, report.step.p95, report.step.p99, report.step.max);
  console.log('  поиск: %d вызовов (%s/с), %d клеток (%s на шаг), отказов %d, бюджет %d',
    report.paths.calls, report.paths.perSec, report.paths.nodes,
    report.paths.nodesPerStep, report.paths.fails, report.paths.budgetHits);
  console.log('  снимок: средний %d Б, сериализация до %s мс',
    report.snapshot.avgBytes, report.snapshot.maxPerSnapMs);
  console.log('  казна: %d брёвен, %d сдач, срублено %d, в пути %d, потеряно %d — %s',
    report.treasury.logs, report.treasury.deliveries, report.treasury.felled,
    report.treasury.inTransit, report.treasury.lost,
    report.treasury.invariant ? 'сходится' : 'НЕ СХОДИТСЯ');
  console.log('  лес от лагеря: %s',
    report.forest.map(f => f.town + ':' + f.forest).join(' '));
  console.log('  экономика: %s',
    economy.map(e => e.at + 'с ' + e.logs + ' брёвен').join(' · '));
  console.log('  память процесса: %s МБ, всё время %d мс', report.memoryMB, report.wallMs);

  if (JSON_OUT) {
    const out = path.resolve(JSON_OUT);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log('  записано: ' + JSON_OUT);
  }
  process.exit(0);
}

main();
