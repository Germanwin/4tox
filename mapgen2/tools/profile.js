/* profile.js — замер партии без браузера: время шага, поиск пути, снимок,
   заселение, экономика и ряд по минутам.

   Зачем. В задании на патч есть требования, которые нельзя проверить «на
   глаз»: мир не должен деградировать с ростом населения, один кадр не должен
   замирать на секунды, снимок — расти без меры, а догон фона — блокировать
   вкладку. Здесь тот же мир, что строит игра (WorldGen + Session + Villagers +
   Combat), но без картинок: шаг за шагом считается всё, что считается в игре,
   и вокруг каждого шага снимается время. Картинка, кадры оболочки и сеть —
   НЕ здесь: их меряют браузерные приёмки (FPS в headless-профиле был бы
   выдумкой).

   Что печатает:
     шаг      — p50/p95/p99, худший, число шагов дольше 16 мс и гистограмма
                1/2/4/8/16 мс;
     поиск    — A* в секунду, клеток на шаг, худший поиск, отказы, упоры в
                бюджет и повторы, выбор цели и отказы плана;
     снимок   — размер JSON, gzip, время сборки, JSON.stringify, применения
                на клиентском мире и доля битовой карты убранного;
     ряд      — по минутам: p50/p95 шага, путей/с, узлов, бюджет, существа,
                снимок raw/gz, память после GC (для «деградирует со временем»);
     метки    — экономика на 180/300/600-й секунде по КАЖДОЙ деревне;
     заселение— родилось и почему не родилось (жильё/место/отложено);
     память   — heapUsed, heapUsed после GC (если --expose-gc) и RSS;
     среда    — CPU, память машины, версия node, платформа, коммит.

   Запуск:
     node mapgen2/tools/profile.js                          # 192, 1 игрок, 10 мин
     node mapgen2/tools/profile.js --size 192 --minutes 10 --players 4
     node mapgen2/tools/profile.js --entities 200           # РОВНО 200 существ
     node mapgen2/tools/profile.js --ramp 20/100/200        # ступени 20→100→200
     node mapgen2/tools/profile.js --size 192 --minutes 60 # ряд по минутам
     node mapgen2/tools/profile.js --json research/metrics.json
     node --expose-gc mapgen2/tools/profile.js --minutes 60  # честная память

   Отличия от старого `--stress`: он остался для сравнения с baseline
   (формула ceil(N/деревень/10)*10 — на 4 деревнях 200 даёт 212), а --entities
   досыпает РОВНО до N и потому годится для матрицы «20/100/200».

   Код возврата 1 — только если прогон не состоялся (нет карты/деревни), а не
   если число кому-то не понравилось: это измерительный инструмент, а не
   приёмка. Пороговые проверки стоят в приёмках. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', 'js');
const REPO = path.join(__dirname, '..', '..');
const FILES = ['noise.js', 'rng.js', 'metrics.js', 'worldgen.js', 'buildings.js',
  'hero.js', 'villager.js', 'session.js', 'combat.js', 'army.js', 'serialize.js',
  'events.js'];
for (const f of FILES) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;                 // events.js может ещё не быть
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
function num(name, def) {
  const v = arg(name, null);
  if (v === null) return def;
  const n = parseFloat(v);
  return isFinite(n) ? n : def;
}
function listArg(name, def) {
  const v = arg(name, null);
  if (v === null || v === true) return def;
  return String(v).split(/[,\/]+/).map(x => parseFloat(x)).filter(x => isFinite(x));
}

const SIZE = parseInt(arg('size', '192'), 10);
const MINUTES = num('minutes', 10);
const PLAYERS = Math.max(1, parseInt(arg('players', '1'), 10));
const STRESS = parseInt(arg('stress', '0'), 10);        // старое: округление до 10
const ENTITIES = arg('entities', null) === null ? 0 : Math.max(0, parseInt(arg('entities', '0'), 10));
const RAMP = listArg('ramp', null);                     // ступени 20/100/200
const MARKS = listArg('marks', [180, 300, 600]);
const SEED = String(arg('seed', 'патч-замер-1'));
const JSON_OUT = arg('json', null);
const GZIP = arg('no-gzip', false) === false;           // по умолчанию меряем
const APPLY = arg('no-apply', false) === false;
const SNAP_EVERY = 6;                                   // шагов между снимками
const SNAP_SAMPLE = 5;                                  // каждый N-й — gzip/apply
const DT = 1 / 60;
const STEPS = Math.round(MINUTES * 60 / DT);

/* Поля Metrics, у которых на этом коммите НЕТ писателя. Печатаются отдельной
   строкой, чтобы ноль не читали как «всё хорошо». Список — по grep по js/:
   когда писатель появится, строку надо убрать, а не оставить навсегда. */
const NOT_WIRED = [
  ['frames/frameMs/frameOver* (в игре)', 'game/js/boot.js'],
  ['steps/stepMs (в игре)', 'game/js/boot.js'],
  ['caughtUp/dropped/catchUpMs/debtSec', 'game/js/boot.js'],
  ['snaps/snap* (в игре)', 'game/js/play.js'],
  ['commands*', 'game/js/play.js, game/js/net.js'],
  ['births/birthBlocked* (в игре; здесь считаются отдельно)', 'mapgen2/js/session.js'],
  ['attacks/damage', 'mapgen2/js/combat.js'],
  ['pathRetries/pathNodesMax/blockedVersionChurn/areasMs', 'mapgen2/js/villager.js'],
  ['plansByKind', 'mapgen2/js/villager.js']
];

/* Отладочный рендер: движок спрашивает у него только «есть ли атлас» и
   «покажи списки». Картинки здесь нет и не должно быть. */
const ANIMS = {};
if (V && V.ANIM_FALLBACK) {
  for (const k of Object.keys(V.ANIM_FALLBACK)) ANIMS[k] = { frames: 6, fps: 10, loop: true };
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
/* Клиент только рисует: ему нужны те же два метода, но мира клиента не жалко —
   в него применяются снимки, чтобы измерить время применения. */
const clientRenderer = {
  villagerSprites: { anims: ANIMS, frames: {} },
  setVillagers() {},
  setBuildings() {}
};

function ms() { return Number(process.hrtime.bigint()) / 1e6; }

function pct(list, q) {
  if (!list.length) return 0;
  const i = Math.min(list.length - 1, Math.floor(q * (list.length - 1)));
  return list[i];
}

/* Досыпать жителей РОВНО до target, поровну на деревни. idBase — свой,
   чтобы не столкнуться с id, которые выдают рождение и казарма. */
function crowd(world, villagers, buildings, towns, target, idBase) {
  let need = target - villagers.length;
  if (need <= 0) return villagers;
  const per = Math.floor(need / Math.max(1, towns.length));
  let rest = need - per * Math.max(1, towns.length);
  for (const town of towns) {
    if (!town) continue;
    const n = per + (rest > 0 ? 1 : 0);
    if (rest > 0) rest--;
    if (n <= 0) continue;
    const more = S.spawnVillagers(world, renderer, buildings, town.townhall, {
      count: n, owner: town.owner, townId: town.id,
      idBase: idBase + town.id * 20000, append: true
    });
    villagers = world._villagers;
    /* Часть — воины в лагере, если он есть: нагрузочный профиль, а не правило
       игры (в игре воина сначала учат). */
    const wc = buildings.find(b => B.typeOf(b) === 'warcamp' && b.town === town.id);
    if (wc) {
      for (let i = 0; i < more.length; i += 4) {
        const v = more[i];
        v.warrior = true; v.warcamp = wc; v.state = 'patrol';
      }
    }
  }
  return villagers;
}

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
  const towns = world.towns || [world.village];

  /* По лагерю на деревню: наём трёх — то, чем игрок и занимается. */
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

  /* Старый --stress: досыпаем по формуле ceil(N/деревень/10)*10 на деревню —
     так снят baseline, и менять формулу нельзя, иначе «до/после» несравнимо. */
  if (STRESS > 0) {
    const per = Math.ceil(STRESS / towns.length / 10) * 10;
    for (const town of towns) {
      if (!town) continue;
      const more = S.spawnVillagers(world, renderer, buildings, town.townhall, {
        count: per, owner: town.owner, townId: town.id,
        idBase: 5000 + town.id * 10000, append: true
      });
      villagers = world._villagers;
      const wc = buildings.find(b => B.typeOf(b) === 'warcamp' && b.town === town.id);
      if (wc) {
        for (let i = 0; i < more.length; i += 4) {
          const v = more[i];
          v.warrior = true; v.warcamp = wc; v.state = 'patrol';
        }
      }
    }
  }

  /* --entities: ровно N существ на старте (без округлений). */
  if (ENTITIES > 0) villagers = crowd(world, villagers, buildings, towns, ENTITIES, 70000);

  if (C) C.init(world, buildings, villagers);
  return { world, villagers, buildings, home, towns };
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

function townTreasury(t, villagers) {
  const logs = t.logs || 0, deliveries = t.deliveries || 0, felled = t.felled || 0;
  const inTransit = t.inTransit || 0, lost = t.lost || 0;
  const per = V.LOGS_PER_TRIP;
  const worked = felled > 0 || inTransit > 0 || deliveries > 0;
  const workers = villagers.filter(v => v && v.town === t.id && v.employer).length;
  return {
    id: t.id, owner: t.owner,
    logs, deliveries, felled, inTransit, lost, workers,
    /* Инвариант контракта: logs + 4·(в пути + потеряно) = 4·срублено. У
       деревни без работников он не обязан сходиться — там null, а не false. */
    invariant: worked ? (logs + per * (inTransit + lost) === per * felled) : null
  };
}

const HIST = [0.5, 1, 2, 4, 8, 16, 32, 64, Infinity];

function main() {
  const t0 = ms();
  const { world, villagers: startVillagers, buildings, home, towns } = worldNow();
  if (!home) {
    console.error('нет ратуши: карта не дала площадку');
    process.exit(1);
  }
  let villagers = startVillagers;
  const villagersStart = villagers.length;

  M.on = true;
  M.reset();
  const birth = S.birthClock();
  let seconds = 0;
  const stepTimes = [];
  const hist = HIST.map(() => 0);
  let snapRaw = 0, snapRawMax = 0, snapCount = 0, snapSerMs = 0, snapSerMax = 0;
  let snapJsonMs = 0, snapJsonMax = 0, snapGzBytes = 0, snapGzMs = 0, snapGzN = 0;
  let snapApplyMs = 0, snapApplyMax = 0, snapApplyN = 0;
  let removedCharsLast = 0, lastBytes = 0, lastGz = 0;
  const economy = [];
  const marks = [];
  const series = [];
  let mark = 0;
  let births = 0;

  /* Ряд по минутам: снимок Metrics на границе минуты, дальше — дельты. */
  let prevM = M.snapshot();
  let bucket = { steps: [], snaps: 0, bytes: 0, gz: 0, gzN: 0, ser: 0, json: 0,
    apply: 0, applyN: 0, paths: 0, nodes: 0, budgetHits: 0, plans: 0,
    planFails: 0, births: 0 };

  /* Клиентский мир для замера применения снимка: та же карта по тому же сиду,
     но живёт отдельно — хостовый мир он не трогает. */
  let clientWorld = null;
  if (APPLY) {
    clientWorld = WG.generate({ seed: SEED, size: SIZE });
    clientWorld.time = 0;
  }

  const gzOn = GZIP && typeof zlib.gzipSync === 'function';
  const rampTarget = (i) => {
    if (!RAMP || !RAMP.length) return 0;
    const k = Math.min(RAMP.length - 1, Math.floor((i / Math.max(1, STEPS)) * RAMP.length));
    return RAMP[k];
  };

  for (let i = 1; i <= STEPS; i++) {
    /* Ступени --ramp: досыпаем до цели ступени на её границе. */
    if (RAMP && RAMP.length) {
      const t = rampTarget(i);
      if (villagers.length < t) villagers = crowd(world, villagers, buildings, towns, t, 90000);
    }

    const a = ms();
    if (C) C.tick(world, DT, { buildings, villagers });
    const bCombat = ms();
    seconds += DT;
    if (S.birthDue(birth, seconds)) {
      const born = S.tryBirth(world, renderer, villagers, buildings);
      births += born.length;
    }
    const b = ms();
    S.stepVillagers(villagers, world, renderer, DT, buildings);
    const c = ms();
    /* Шаг — весь: бой, рождение и жители, как в старой версии profile.js.
       Иначе p50/p95 нельзя сравнивать с baseline. */
    const dtMs = c - a;
    const combatMs = bCombat - a;
    M.step(dtMs);
    M.combat(combatMs);

    /* Первые секунды — прогрев JIT: в перцентили идут после 2-й секунды. */
    if (seconds > 2) {
      stepTimes.push(dtMs);
      for (let h = 0; h < HIST.length; h++) {
        if (dtMs <= HIST[h]) { hist[h]++; break; }
      }
    }
    bucket.steps.push(dtMs);

    if (i % SNAP_EVERY === 0) {
      const s0 = ms();
      const snap = Ser.world(world, buildings, villagers, { seq: i / SNAP_EVERY });
      const s1 = ms();
      const text = JSON.stringify(snap);
      const s2 = ms();
      const bytes = text.length;
      snapRaw += bytes; snapCount++;
      if (bytes > snapRawMax) snapRawMax = bytes;
      snapSerMs += s1 - s0;
      if (s1 - s0 > snapSerMax) snapSerMax = s1 - s0;
      snapJsonMs += s2 - s1;
      if (s2 - s1 > snapJsonMax) snapJsonMax = s2 - s1;
      lastBytes = bytes;
      removedCharsLast = typeof snap.removed === 'string' ? snap.removed.length : 0;
      bucket.snaps++; bucket.bytes += bytes; bucket.ser += s1 - s0; bucket.json += s2 - s1;
      M.snap(s1 - s0, bytes, s2 - s1);

      /* gzip и apply — дорогие, поэтому каждый SNAP_SAMPLE-й снимок. Время
         шага они не искажают: идут после закрытия шага, но в стену прогона
         входят — это сказано в отчёте. */
      if (i % (SNAP_EVERY * SNAP_SAMPLE) === 0) {
        if (gzOn) {
          const g0 = ms();
          const gz = zlib.gzipSync(text, { level: 1 }).length;
          const g1 = ms();
          snapGzBytes += gz; snapGzMs += g1 - g0; snapGzN++;
          bucket.gz += gz; bucket.gzN++;
          lastGz = gz;
          M.counters.snapGzBytes += gz;
          M.counters.snapGzMs += g1 - g0;
        }
        if (clientWorld) {
          const p0 = ms();
          Ser.apply(clientWorld, JSON.parse(text), clientRenderer, { smooth: false });
          const p1 = ms();
          snapApplyMs += p1 - p0; snapApplyN++;
          if (p1 - p0 > snapApplyMax) snapApplyMax = p1 - p0;
          bucket.apply += p1 - p0; bucket.applyN++;
        }
      }
    }

    /* Метки экономики — по НОМЕРУ ШАГА, а не по накопленным секундам: сумма
       1/60 на последнем шаге даёт 599.9999, и метка 600 молча пропадала. */
    while (mark < MARKS.length && i >= MARKS[mark] * 60) {
      economy.push({
        at: MARKS[mark], step: i,
        villagers: villagers.length,
        towns: towns.filter(Boolean).map(t => townTreasury(t, villagers))
      });
      marks.push({
        at: MARKS[mark], seconds: +(i / 60).toFixed(1),
        villagers: villagers.length,
        housingFree: S.housingFree ? S.housingFree(buildings, villagers, world) : null,
        metrics: { paths: M.counters.paths, budgetHits: M.counters.budgetHits,
          plans: M.counters.plans, births: births }
      });
      mark++;
    }

    if (i % 3600 === 0 || i === STEPS) {
      const m = M.snapshot();
      const free = S.housingFree ? S.housingFree(buildings, villagers, world) : null;
      M.population(villagers.length, free);
      let heapMB = process.memoryUsage().heapUsed / 1048576;
      let heapGc = null;
      if (global.gc) { global.gc(); heapGc = process.memoryUsage().heapUsed / 1048576; }
      const s2 = bucket.steps.slice().sort((x, y) => x - y);
      series.push({
        min: +(i / 3600).toFixed(2),
        villagers: villagers.length,
        housingFree: free,
        stepP50: +pct(s2, 0.5).toFixed(4),
        stepP95: +pct(s2, 0.95).toFixed(4),
        stepMax: +(s2[s2.length - 1] || 0).toFixed(3),
        long16: bucket.steps.filter(x => x > 16).length,
        paths: m.paths - prevM.paths,
        nodes: m.nodes - prevM.nodes,
        nodesPerStep: +((m.nodes - prevM.nodes) / Math.max(1, bucket.steps.length)).toFixed(1),
        budgetHits: m.budgetHits - prevM.budgetHits,
        planFails: m.planFails - prevM.planFails,
        births: births,
        birthsDelta: m.births - prevM.births,
        snapBytes: bucket.snaps ? Math.round(bucket.bytes / bucket.snaps) : 0,
        snapGz: bucket.gzN ? Math.round(bucket.gz / bucket.gzN) : 0,
        serMs: bucket.snaps ? +(bucket.ser / bucket.snaps).toFixed(4) : 0,
        jsonMs: bucket.snaps ? +(bucket.json / bucket.snaps).toFixed(4) : 0,
        applyMs: bucket.applyN ? +(bucket.apply / bucket.applyN).toFixed(4) : 0,
        heapMB: +heapMB.toFixed(1),
        heapGcMB: heapGc === null ? null : +heapGc.toFixed(1),
        rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1)
      });
      prevM = m;
      bucket = { steps: [], snaps: 0, bytes: 0, gz: 0, gzN: 0, ser: 0, json: 0,
        apply: 0, applyN: 0, paths: 0, nodes: 0, budgetHits: 0, plans: 0,
        planFails: 0, births: 0 };
    }
  }

  /* Конец прогона — тоже метка: на коротких прогонах (3 мин) иначе экономики
     нет вовсе, и «сколько принёс лес» не посмотреть. */
  const endSec = STEPS / 60;
  const lastMark = economy.length ? economy[economy.length - 1].at : -1;
  if (Math.abs(lastMark - endSec) > 0.01) {
    economy.push({ at: +endSec.toFixed(1), step: STEPS, final: true,
      villagers: villagers.length,
      towns: towns.filter(Boolean).map(t => townTreasury(t, villagers)) });
  }

  const nowM = M.snapshot();
  const wall = ms() - t0;
  stepTimes.sort((x, y) => x - y);
  const town0 = towns.filter(Boolean)[0] || world.village;
  const free = S.housingFree ? S.housingFree(buildings, villagers, world) : null;
  M.population(villagers.length, free);
  const heapMB = process.memoryUsage().heapUsed / 1048576;
  let heapGcMB = null;
  if (global.gc) { global.gc(); heapGcMB = process.memoryUsage().heapUsed / 1048576; }
  const rssMB = process.memoryUsage().rss / 1048576;

  /* Коммит читаем из .git напрямую, без git и spawnSync: запуск процесса
     стоит десятки мс и попадает в «всё время» прогона. В worktree .git —
     файл-указатель на каталог. */
  let commit = null;
  try {
    let gitDir = path.join(REPO, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (m) gitDir = path.resolve(REPO, m[1].trim());
    }
    /* У worktree ссылки лежат в общем каталоге, он указан в commondir. */
    let common = gitDir;
    const cd = path.join(gitDir, 'commondir');
    if (fs.existsSync(cd)) common = path.resolve(gitDir, fs.readFileSync(cd, 'utf8').trim());
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    commit = head.startsWith('ref: ')
      ? fs.readFileSync(path.join(common, head.slice(5).trim()), 'utf8').trim().slice(0, 7)
      : head.slice(0, 7);
  } catch (e) { commit = null; }

  const report = {
    when: new Date().toISOString(),
    seed: SEED, size: SIZE, players: PLAYERS, minutes: MINUTES,
    stress: STRESS, entities: ENTITIES, ramp: RAMP,
    dt: DT, steps: STEPS,
    wallMs: Math.round(wall),
    villagers: villagers.length,
    villagersStart,
    buildings: buildings.length,
    trees: (world.stats && world.stats.trees) || 0,
    births,
    step: {
      p50: +pct(stepTimes, 0.5).toFixed(4),
      p95: +pct(stepTimes, 0.95).toFixed(4),
      p99: +pct(stepTimes, 0.99).toFixed(4),
      max: +(stepTimes[stepTimes.length - 1] || 0).toFixed(3),
      mean: +(nowM.stepMs / Math.max(1, nowM.steps)).toFixed(4),
      over16: stepTimes.filter(x => x > 16).length
    },
    histogram: Object.fromEntries(HIST.map((h, i) => [h === Infinity ? '>64' : '<=' + h, hist[i]])),
    paths: {
      calls: nowM.paths, nodes: nowM.nodes, fails: nowM.fails,
      budgetHits: nowM.budgetHits,
      perSec: +(nowM.paths / (MINUTES * 60)).toFixed(2),
      nodesPerStep: +(nowM.nodes / Math.max(1, STEPS)).toFixed(1)
    },
    plans: { calls: nowM.plans, fails: nowM.planFails, byKind: nowM.plansByKind },
    caches: { blockedBuilds: nowM.blockedBuilds, areaBuilds: nowM.areaBuilds },
    snapshot: {
      count: snapCount,
      avgBytes: snapCount ? Math.round(snapRaw / snapCount) : 0,
      maxBytes: snapRawMax,
      lastBytes,
      gzBytes: snapGzN ? Math.round(snapGzBytes / snapGzN) : 0,
      gzSamples: snapGzN,
      maxSerMs: +snapSerMax.toFixed(3),
      avgSerMs: +(snapSerMs / Math.max(1, snapCount)).toFixed(4),
      avgJsonMs: +(snapJsonMs / Math.max(1, snapCount)).toFixed(4),
      maxJsonMs: +snapJsonMax.toFixed(3),
      avgApplyMs: snapApplyN ? +(snapApplyMs / snapApplyN).toFixed(4) : null,
      maxApplyMs: snapApplyN ? +snapApplyMax.toFixed(3) : null,
      applySamples: snapApplyN,
      removedChars: removedCharsLast,
      removedShare: lastBytes ? +(removedCharsLast / lastBytes).toFixed(3) : 0,
      gzShare: snapGzN && lastBytes ? +(lastGz / lastBytes).toFixed(3) : null
    },
    birthsStats: {
      /* born — измеренный profile.js счёт рождений; bornMetric — поле
         Metrics, у которого в движке пока нет писателя (должно быть равно). */
      born: births, bornMetric: nowM.births, blocked: nowM.birthBlocked,
      housing: nowM.birthBlockedHousing, spot: nowM.birthBlockedSpot,
      pending: nowM.birthPending,
      population: villagers.length, housingFree: free
    },
    caughtUp: { sec: nowM.caughtUpSec, dropped: nowM.droppedSec, ms: nowM.catchUpMs },
    commands: { seen: nowM.commandsSeen, applied: nowM.commandsApplied,
      rejected: nowM.commandsRejected, expired: nowM.commandsExpired,
      latencyMaxMs: nowM.cmdLatencyMaxMs },
    combat: { ms: nowM.combatMs, attacks: nowM.attacks, damage: nowM.damage },
    economy,
    marks,
    series,
    forest: forestReach(world),
    /* Для сравнения с baseline: казна первой деревни под старым именем. */
    treasury: townTreasury(town0, villagers),
    towns: towns.filter(Boolean).map(t => townTreasury(t, villagers)),
    memoryMB: +heapMB.toFixed(1),
    memory: { heapMB: +heapMB.toFixed(1), heapGcMB: heapGcMB === null ? null : +heapGcMB.toFixed(1),
      rssMB: +rssMB.toFixed(1), gc: !!global.gc },
    notWired: NOT_WIRED.map(x => x[0] + ' ← ' + x[1]),
    env: {
      cpu: (os.cpus()[0] || {}).model || '?',
      cores: os.cpus().length,
      totalMemGB: +(os.totalmem() / 1073741824).toFixed(1),
      platform: process.platform + ' ' + process.arch,
      node: process.version,
      commit
    }
  };

  console.log('сид %s · %d×%d · игроков %d · %s мин · %d существ%s',
    SEED, SIZE, SIZE, PLAYERS, MINUTES, villagers.length,
    ENTITIES ? ' (--entities ' + ENTITIES + ')' : (STRESS ? ' (--stress ' + STRESS + ')' : ''));
  console.log('  шаг мира: p50 %s мс, p95 %s, p99 %s, худший %s; длинных (>16 мс) %d',
    report.step.p50, report.step.p95, report.step.p99, report.step.max, report.step.over16);
  console.log('  гистограмма шага: %s',
    Object.entries(report.histogram).map(([k, v]) => k + ' ' + v).join(' · '));
  console.log('  поиск: %d вызовов (%s/с), %d клеток (%s на шаг), отказов %d, бюджет %d; худший поиск %s',
    report.paths.calls, report.paths.perSec, report.paths.nodes,
    report.paths.nodesPerStep, report.paths.fails, report.paths.budgetHits,
    nowM.pathNodesMax ? nowM.pathNodesMax + ' клеток' : '— (писателя pathNodesMax нет)');
  console.log('  план: %d выборов, %d отказов (%s)',
    report.plans.calls, report.plans.fails,
    Object.keys(report.plans.byKind).length
      ? Object.entries(report.plans.byKind).map(([k, v]) => k + ' ' + v).join(' · ')
      : 'разбивки нет — писателя plansByKind ещё нет');
  console.log('  снимок: %d × %d Б (худший %d), gzip %d Б (1/%d), сборка %s мс (худшая %s), JSON %s (худший %s), apply %s (худший %s), убранное %d%%',
    report.snapshot.count, report.snapshot.avgBytes, report.snapshot.maxBytes,
    report.snapshot.gzBytes, SNAP_SAMPLE, report.snapshot.avgSerMs,
    report.snapshot.maxSerMs, report.snapshot.avgJsonMs, report.snapshot.maxJsonMs,
    report.snapshot.avgApplyMs === null ? '—' : report.snapshot.avgApplyMs,
    report.snapshot.maxApplyMs === null ? '—' : report.snapshot.maxApplyMs,
    Math.round(report.snapshot.removedShare * 100));
  console.log('  заселение: родилось %d, отказов %d (жильё %d, место %d, отложено %d); население %d, свободного жилья %s',
    report.birthsStats.born, report.birthsStats.blocked, report.birthsStats.housing,
    report.birthsStats.spot, report.birthsStats.pending, villagers.length, free);
  console.log('  казна первой деревни: %d брёвен, %d сдач, срублено %d, в пути %d, потеряно %d — %s',
    report.treasury.logs, report.treasury.deliveries, report.treasury.felled,
    report.treasury.inTransit, report.treasury.lost,
    report.treasury.invariant === null ? 'без работников'
      : (report.treasury.invariant ? 'сходится' : 'НЕ СХОДИТСЯ'));
  console.log('  лес от лагеря: %s',
    report.forest.map(f => f.town + ':' + f.forest).join(' '));
  console.log('  экономика: %s',
    economy.map(e => e.at + 'с ' + e.towns.map(t => t.id + ':' + t.logs).join('/')).join(' · '));
  console.log('  память: heap %s МБ%s, RSS %s МБ, всё время %d мс',
    report.memoryMB, heapGcMB === null ? '' : ' (после GC ' + heapGcMB.toFixed(1) + ')',
    report.memory.rssMB, report.wallMs);
  console.log('  среда: %s · %d ядер · %s · node %s · коммит %s',
    report.env.cpu, report.env.cores, report.env.platform, report.env.node, commit || '?');
  console.log('  поля без писателя (NOT RUN): %s', report.notWired.join('; '));
  if (series.length) {
    console.log('  ряд по минутам: мин | существ | шаг p50/p95 | путей | узлов/шаг | снимок/gz | heap(GC)');
    for (const s of series) {
      console.log('   %s | %d | %s/%s | %d | %s | %d/%d | %s%s',
        String(s.min).padStart(5), s.villagers, s.stepP50, s.stepP95, s.paths,
        s.nodesPerStep, s.snapBytes, s.snapGz, s.heapMB,
        s.heapGcMB === null ? '' : '(' + s.heapGcMB + ')');
    }
  }

  if (JSON_OUT) {
    const out = path.resolve(JSON_OUT);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log('  записано: ' + JSON_OUT);
  }
  process.exit(0);
}

main();
