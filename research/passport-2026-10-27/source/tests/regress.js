/* regress.js — независимая headless-приёмка регрессий патча 2026-10-26.

   БЕЗ БРАУЗЕРА: тот же движок (`mapgen2/js/*`), что в игре, но без DOM.
   Проверяются ровно те контракты, которые нельзя увидеть глазами в браузере:

     1. F5 хоста: деревня → снимок (`Serialize.world`) → новый мир по сиду →
        здания через `Serialize.apply` → жители через `Serialize.hydrate`.
        После возврата гражданский гуляет, лесоруб сдаёт +4, ученик
        заканчивает пять секунд, воин с приказом идёт, 120 с шага без
        исключений и NaN. Пока `Serialize.hydrate` не появился, сценарный шаг
        помечается NOT RUN, а не выдаётся за PASS.
     2. Рождение: заблокированный дом A не мешает B; второй дом A
        используется; выбывший город не рождает; при одном жителе рождение
        невозможно.
     3. Экономика: logs + 4·(inTransit + lost) = 4·felled после серии ходок;
        увольнение и смерть носильщика увеличивают lost (на четыре бревна);
        нет NaN.
     4. Постановка: дом нельзя поставить на жителя; поворот прямоугольного
        дома поверх соседнего запрещён; защищённый выход действующей постройки
        (когда появится API) запирать нельзя.
     5. Серия: `Buildings.planLine` проверяется, если агент 9 его добавит;
        иначе NOT RUN с причиной.

   Каждая строка — ok / FAIL / NOT RUN. Код возврата 1, если есть FAIL:
   NOT RUN — это «не проверено», а не «прошло».

   Запуск:
     node mapgen2/tools/regress.js [сид-ф5] [сид-рождения] [сид-экономики]
   Сиды фиксированы и воспроизводимы: FAIL на одном острове повторяется на
   другом, иначе приёмка ничего не доказывает. */
const fs = require('fs');
const path = require('path');

/* Модули игры — IIFE поверх globalThis, без DOM. Порядок — как в index.html:
   сначала зависимости (buildings/villager), потом serialize/session/army. */
const ROOT = path.join(__dirname, '..', 'js');
const FILES = ['noise.js', 'rng.js', 'worldgen.js', 'buildings.js', 'hero.js',
  'villager.js', 'serialize.js', 'session.js', 'combat.js', 'army.js'];
for (const f of FILES) {
  new Function(fs.readFileSync(path.join(ROOT, f), 'utf8') + '\n//# sourceURL=' + f)();
}

const WG = globalThis.WorldGen;
const B = globalThis.Buildings;
const V = globalThis.Villagers;
const S = globalThis.Session;
const Ser = globalThis.Serialize;
const C = globalThis.Combat;
const A = globalThis.Army;
const DT = 1 / 60;

/* Набор кадров атласа жителя — те же числа, что mapgen2/assets/villager/
   atlas.js. Картинки движку не нужны: update() берёт из набора только число
   кадров и к/с, по ним считаются удар, шаг и жест сдачи. */
const SET = {
  anims: {
    idle: { frames: 6, fps: 8, loop: true },
    walk: { frames: 8, fps: 12, loop: true },
    work: { frames: 8, fps: 12, loop: false },
    walk_axe: { frames: 8, fps: 12, loop: true },
    carry: { frames: 8, fps: 12, loop: true },
    carry_put: { frames: 4, fps: 12, loop: false }
  }
};

function makeRenderer() {
  return {
    world: null, buildings: [], villagers: [],
    villagerSprites: SET,
    setBuildings(list) { this.buildings = list; },
    setVillagers(list) { this.villagers = list; },
    fitIsland() {}
  };
}

const BASE = { size: 64, land: 0.72, coast: 0.5, forest: 0.5, rock: 0.5, trees: 0.45, rocks: 0.6 };

let fails = 0, passed = 0, notRuns = 0;
function check(name, ok, extra) {
  if (ok) passed++; else fails++;
  console.log((ok ? '  ok      ' : '  FAIL    ') + name + (extra ? '   ' + extra : ''));
}
function notRun(name, why) {
  notRuns++;
  console.log('  NOT RUN ' + name + '   ' + why);
}
function section(title) {
  console.log('\n== ' + title + ' ==');
}

function townState(t) {
  if (!t) return 'нет деревни';
  return 'logs=' + t.logs + ' deliveries=' + t.deliveries + ' felled=' + t.felled +
    ' inTransit=' + t.inTransit + ' lost=' + (t.lost === undefined ? '—' : t.lost);
}
function finiteN(n) { return typeof n === 'number' && isFinite(n); }
function lostMode(t) {
  if (!t || typeof t.lost !== 'number') return null;
  if (t.logs + 4 * (t.inTransit + t.lost) === 4 * t.felled) return 'trips';
  if (t.logs + 4 * t.inTransit + t.lost === 4 * t.felled) return 'logs';
  return null;
}
function econOk(world, town) {
  if (S.economyCheck) {
    const r = S.economyCheck(world, town);
    return { ok: r.ok, text: 'logs=' + r.logs + ' inTransit=' + r.inTransit +
      ' lost=' + r.lost + ' felled=' + r.felled + ' have=' + r.have + ' need=' + r.need +
      (r.ok ? '' : ' diff=' + r.diff) };
  }
  const t = town || (world && world.village);
  const mode = lostMode(t);
  return { ok: mode !== null, text: t ? townState(t) : 'нет деревни' };
}
function orderOf(v) {
  if (!v) return null;
  if (v.order && finiteN(v.order.x) && finiteN(v.order.y)) return { x: v.order.x, y: v.order.y };
  if (finiteN(v.orderX) && finiteN(v.orderY)) return { x: v.orderX, y: v.orderY };
  return null;
}
function villagerFinite(v) {
  if (!v) return false;
  const nums = ['x', 'y', 'rot', 'phase', 'speed', 'hp', 'maxHp', 'trainT', 'chopT', 'hold'];
  for (const k of nums) {
    if (v[k] !== undefined && !finiteN(v[k])) return false;
  }
  return true;
}

/* ----------------------------- общие помощники ---------------------------- */

/* Постройка рядом с деревней — тем же способом, что Session.VILLAGE: место
   подбирает neighbourSpot, ставит settle. Список построек у деревни ОДИН
   (town.buildings === список), поэтому пушим ровно один раз. */
function addBuilding(world, list, town, type, variant) {
  const spot = B.neighbourSpot(world, list, { type, variant, rot: B.FACE_ROT },
    { clearable: true, requireClear: false, yard: 1 });
  if (!spot) return null;
  B.settle(world, spot, { clear: true });
  spot.owner = town.owner;
  spot.town = town.id;
  spot.id = town.id + ':b' + list.length;
  list.push(spot);
  return spot;
}

/* Свободный прямоугольник травы без построек и объектов — для проверок
   постановки, которым не нужна деревня. */
function clearRect(world, list, w, h) {
  const T = WG.T, W = world.width, H = world.height;
  for (let y = 2; y + h < H - 2; y++) {
    for (let x = 2; x + w < W - 2; x++) {
      let ok = true;
      for (let j = 0; j < h && ok; j++) {
        for (let i = 0; i < w; i++) {
          if (world.tile[(y + j) * W + (x + i)] !== T.GRASS) { ok = false; break; }
        }
      }
      if (!ok) continue;
      for (const o of world.objects) {
        if (!(B.obstacle ? B.obstacle(o) : (o.kind === 'tree' || (o.kind === 'stone' && o.variant !== 'pebble')))) continue;
        if (o.x >= x && o.y >= y && o.x < x + w && o.y < y + h) { ok = false; break; }
      }
      if (!ok) continue;
      let busy = false;
      for (const b of (list || [])) {
        for (const c of B.cells(b)) {
          if (c.x >= x && c.y >= y && c.x < x + w && c.y < y + h) { busy = true; break; }
        }
        if (busy) break;
      }
      if (busy) continue;
      const probe = B.make({ type: 'house', variant: 'a', rot: 0, x, y });
      if (!B.canPlace(world, list || [], probe, { clearable: false, requireClear: true, yard: 0 }).ok) continue;
      return { x, y };
    }
  }
  return null;
}

/* Занять ВСЕ проходимые клетки у двери дома в радиусе рождения. Деревья —
   такая же помеха, как в игре; список занятых клеток после правки мира
   пересобирается сам, но кэш чистим явно: проверка не должна зависеть от
   того, успел ли кто-то до неё позвать blockedMap. */
function blockDoor(world, house) {
  const solid = V.blockedMap(world, world._buildings || []);
  const fp = B.footprint(house.rot, house.type);
  const door = B.frontSpot(house);
  let n = 0;
  for (let dy = -S.BIRTH_REACH; dy <= S.BIRTH_REACH; dy++) {
    for (let dx = -S.BIRTH_REACH; dx <= S.BIRTH_REACH; dx++) {
      const cx = door.x + dx, cy = door.y + dy;
      if (cx < 0 || cy < 0 || cx >= world.width || cy >= world.height) continue;
      if (cx >= house.x && cy >= house.y && cx < house.x + fp.w && cy < house.y + fp.h) continue;
      if (!V.walkable(world, solid, cx, cy)) continue;
      world.objects.push({ kind: 'tree', variant: 'oak', x: cx + 0.5, y: cy + 0.5, scale: 1 });
      n++;
    }
  }
  world._villagerBlocked = null;
  return n;
}

function twoTowns(seed) {
  const world = WG.generate(Object.assign({}, BASE, { seed, size: 96 }));
  const renderer = makeRenderer();
  const st = S.startMulti(world, renderer, { players: 2 });
  return { world, renderer, st, towns: st.towns, buildings: st.buildings, villagers: st.villagers };
}

function townHouse(buildings, townId) {
  for (const b of buildings) {
    if (b.town === townId && B.typeOf(b) === 'house' && !b.rubble) return b;
  }
  return null;
}

/* Повторять попытки рождения, пока они дают детей: у контракта есть
   отложенная попытка (birthPending), и одно «пусто» ещё не значит «город не
   рождает». Больше пяти раз не нужно: свободных мест в домах меньше пяти. */
function birthAttempts(world, renderer, villagers, buildings, times) {
  const born = [];
  for (let i = 0; i < (times || 3); i++) {
    const part = S.tryBirth(world, renderer, villagers, buildings) || [];
    for (const v of part) born.push(v);
  }
  return born;
}

/* ========================= 1. F5: восстановление ========================= */

/* Мир до снимка. Четыре жителя, чтобы были все четыре роли сразу:
   гражданский (гуляет), лесоруб (нанят), ученик (уже внутри казармы, идёт
   пятая секунда) и воин с живым приказом. Постройки для тренировки и службы
   добавляются к деревне тем же neighbourSpot, что и в Session.VILLAGE. */
function makeF5World(seed) {
  const world = WG.generate(Object.assign({}, BASE, { seed }));
  const renderer = makeRenderer();
  const st = S.startHome(world, renderer);
  const town = world.village;
  const barracks = addBuilding(world, st.buildings, town, 'barracks', 'a');
  const warcamp = addBuilding(world, st.buildings, town, 'warcamp', 'x');
  if (!barracks || !warcamp) throw new Error('не нашлось места под казарму и военный лагерь');

  const villagers = S.spawnVillagers(world, renderer, st.buildings, st.home, { count: 4 });
  if (villagers.length !== 4) throw new Error('жителей ' + villagers.length + ' вместо 4');
  const [civilian, lumberjack, trainee, soldier] = villagers;

  const camp = st.buildings.find((b) => B.typeOf(b) === 'lumbercamp');
  const hire = S.hire(camp, lumberjack, villagers);
  if (!hire.ok) throw new Error('лесоруба не наняли: ' + hire.reason);

  /* Воин: настоящее обучение, а не подставленное поле. Пять секунд после
     заступа на территорию казармы, затем выход в лагерь. */
  const trainSoldier = S.train(barracks, soldier, villagers, st.buildings);
  if (!trainSoldier.ok) throw new Error('воина не отправили учиться: ' + trainSoldier.reason);
  let t = 0;
  while (t < 60 && !soldier.warrior) {
    S.stepVillagers(villagers, world, renderer, DT, st.buildings);
    t += DT;
  }
  if (!soldier.warrior) throw new Error('воин не обучился за 60 с');
  t = 0;
  while (t < 60 && soldier.state !== 'patrol' && soldier.state !== 'stand') {
    S.stepVillagers(villagers, world, renderer, DT, st.buildings);
    t += DT;
  }

  /* Ученик: доводим до состояния «внутри казармы, идёт отсчёт». Снимок
     делается сразу после начала пяти секунд, значит после F5 остаток ещё
     должен доиграть. */
  const trainTrainee = S.train(barracks, trainee, villagers, st.buildings);
  if (!trainTrainee.ok) throw new Error('ученика не отправили учиться: ' + trainTrainee.reason);
  t = 0;
  while (t < 60 && !(trainee.trainee && trainee.state === 'training')) {
    S.stepVillagers(villagers, world, renderer, DT, st.buildings);
    t += DT;
  }
  if (trainee.state !== 'training') throw new Error('ученик не заступил в казарму за 60 с');

  /* Приказ воину — после начала обучения ученика, чтобы к снимку он был
     свежим и НЕ выполненным: иначе «воин идёт» после F5 проверяло бы стояние
     на уже достигнутой точке. Цель ищется в той же области, что лагерь. */
  const solid = V.blockedMap(world, st.buildings);
  let order = null, orderAt = null;
  for (const rad of [12, 10, 14, 16, 8, 18]) {
    for (let a = 0; a < 16 && !order; a++) {
      const ang = a / 16 * Math.PI * 2;
      const cx = Math.round(warcamp.x + Math.cos(ang) * rad);
      const cy = Math.round(warcamp.y + Math.sin(ang) * rad);
      if (!V.walkable(world, solid, cx, cy)) continue;
      const res = A.order(world, [soldier.id], villagers, cx + 0.5, cy + 0.5);
      if (res.ok) { order = res; orderAt = { x: cx + 0.5, y: cy + 0.5 }; }
    }
    if (order) break;
  }
  if (!order) throw new Error('воину не нашлось цели приказа');

  /* Один кадр шага, чтобы приказ начал исполняться: к снимку order.done ещё
     false, а позиция уже сдвинулась. */
  for (let i = 0; i < 60; i++) S.stepVillagers(villagers, world, renderer, DT, st.buildings);

  const snap = Ser.world(world, st.buildings, villagers);
  return { world, renderer, buildings: st.buildings, villagers, snap,
    roles: { civilian, lumberjack, trainee, soldier }, town, orderAt };
}

section('F5 хоста: снимок → новый мир → здания → жители');

let f5 = null;
try {
  f5 = makeF5World(process.argv[2] || 'приёмка-ф5');
} catch (e) {
  check('F5: деревня и четыре жителя поднялись', false, e.message);
}

if (f5) {
  const { world, buildings, villagers, snap, roles, town } = f5;
  check('F5: в деревне ратуша, дом, лагерь, казарма и военный лагерь',
    buildings.length >= 5, 'построек ' + buildings.length);
  check('F5: лесоруб нанят и уже сдал хотя бы одну ходку',
    !!roles.lumberjack.employer && town.deliveries >= 1 && town.logs >= 4,
    townState(town));
  check('F5: ученик в казарме, пять секунд ещё идут',
    roles.trainee.trainee === true && roles.trainee.state === 'training' && roles.trainee.trainT > 0,
    'trainT=' + roles.trainee.trainT);
  check('F5: воин получил приказ и ещё не выполнил его',
    !!orderOf(roles.soldier) && roles.soldier.state === 'march',
    'состояние ' + roles.soldier.state);
  check('F5: снимок содержит все постройки и всех жителей',
    snap.buildings.length === buildings.length && snap.villagers.length === villagers.length,
    'зданий ' + snap.buildings.length + '/' + buildings.length +
    ', жителей ' + snap.villagers.length + '/' + villagers.length);

  /* Новый мир по ТОМУ ЖЕ сиду и параметрам. Иначе это не F5, а новая карта. */
  const world2 = WG.generate(Object.assign({}, BASE, { seed: process.argv[2] || 'приёмка-ф5' }));
  const renderer2 = makeRenderer();
  const applied = Ser.apply(world2, snap, renderer2, { smooth: false });
  const buildings2 = applied.buildings || world2._buildings || [];

  let match = buildings2.length === snap.buildings.length;
  const byId2 = {};
  for (const b of buildings2) byId2[b.id] = b;
  for (const bs of snap.buildings) {
    const b = byId2[bs.id];
    if (!b || b.x !== bs.x || b.y !== bs.y || b.rot !== bs.rot ||
        (b.type || 'townhall') !== (bs.type || 'townhall')) { match = false; break; }
  }
  check('F5: Serialize.apply восстановил постройки на своих местах', match,
    'зданий ' + buildings2.length + '/' + snap.buildings.length);
  check('F5: Serialize.apply восстановил казну деревни',
    !!world2.village && world2.village.logs === snap.towns[0].logs &&
    world2.village.felled === snap.towns[0].felled,
    world2.village ? townState(world2.village) : 'нет деревни');

  if (typeof Ser.hydrate !== 'function') {
    notRun('F5: Serialize.hydrate восстанавливает жителей',
      'Serialize.hydrate ещё не реализован (контракт §2; ветка агента 3)');
    notRun('F5: гражданский гуляет после F5', 'нет Serialize.hydrate');
    notRun('F5: лесоруб сдаёт +4 после F5', 'нет Serialize.hydrate');
    notRun('F5: ученик заканчивает обучение за 5 с после F5', 'нет Serialize.hydrate');
    notRun('F5: воин с приказом идёт после F5', 'нет Serialize.hydrate');
    notRun('F5: 120 с шага без исключений и NaN', 'нет Serialize.hydrate');
  } else {
    let restored = null, hydrateError = null;
    try {
      const out = Ser.hydrate(world2, snap, buildings2);
      restored = Array.isArray(out) ? out : (out && out.villagers) || world2._villagers;
    } catch (e) {
      hydrateError = e;
    }
    if (!Array.isArray(restored) || !restored.length) {
      check('F5: Serialize.hydrate вернул жителей', false,
        hydrateError ? hydrateError.message : 'пустой список');
    } else {
      world2._villagers = restored;
      renderer2.setVillagers(restored);
      const byId = {};
      for (const v of restored) byId[v.id] = v;
      const civ = byId[roles.civilian.id], lum = byId[roles.lumberjack.id];
      const tr = byId[roles.trainee.id], sol = byId[roles.soldier.id];

      check('F5: у восстановленных жителей есть speed и rng',
        restored.every((v) => finiteN(v.speed) && v.rng && typeof v.rng.next === 'function'),
        restored.filter((v) => !(finiteN(v.speed) && v.rng)).length + ' без полей симуляции');
      check('F5: координаты и таймеры восстановленных жителей конечны',
        restored.every(villagerFinite),
        restored.filter((v) => !villagerFinite(v)).length + ' с NaN/Infinity');
      check('F5: прописка, работа и обучение переехали ссылками на постройки',
        !!(civ && civ.home) && !!(lum && lum.employer) &&
        !!(tr && tr.trainingAt) && !!(sol && sol.warcamp),
        'home/employer/trainingAt/warcamp');

      if (!civ || !lum || !tr || !sol) {
        check('F5: все четыре роли найдены по id', false, 'id не переехали');
      } else {
        const civStart = { x: civ.x, y: civ.y };
        const solStart = { x: sol.x, y: sol.y };
        const soldierOrder0 = orderOf(sol);
        check('F5: приказ воина переехал в снимок',
          !!soldierOrder0, soldierOrder0 ? 'цель ' + soldierOrder0.x + ',' + soldierOrder0.y : 'order пуст');

        const logs0 = world2.village.logs;
        let civMax = 0, solMax = 0, traineeDoneAt = null;
        let stepError = null, finalRet = null;
        for (let i = 0; i < 120 * 60; i++) {
          try {
            finalRet = S.stepVillagers(restored, world2, renderer2, DT, buildings2);
          } catch (e) {
            stepError = e;
            break;
          }
          civMax = Math.max(civMax, Math.hypot(civ.x - civStart.x, civ.y - civStart.y));
          solMax = Math.max(solMax, Math.hypot(sol.x - solStart.x, sol.y - solStart.y));
          if (traineeDoneAt === null && !tr.trainee) traineeDoneAt = i * DT;
          if (!villagerFinite(civ) || !villagerFinite(lum) || !villagerFinite(tr) || !villagerFinite(sol)) {
            stepError = new Error('NaN в жителе на шаге ' + i);
            break;
          }
        }

        check('F5: 120 с шага без исключений', !stepError,
          stepError ? stepError.message : 'прошло');
        check('F5: stepVillagers вернул конечное число',
          finiteN(finalRet), String(finalRet));
        check('F5: гражданский гуляет после F5', civMax > 0.5,
          'прошёл ' + civMax.toFixed(2) + ' клетки');
        check('F5: лесоруб сдаёт +4 после F5',
          world2.village.logs - logs0 >= 4 && (world2.village.logs - logs0) % 4 === 0,
          'прибавка ' + (world2.village.logs - logs0) + ' (' + townState(world2.village) + ')');
        check('F5: ученик заканчивает обучение за 5 с после F5',
          traineeDoneAt !== null && traineeDoneAt <= 5.5,
          traineeDoneAt === null ? 'не закончил' : traineeDoneAt.toFixed(2) + ' с');
        check('F5: воин с приказом идёт после F5', solMax > 1,
          'прошёл ' + solMax.toFixed(2) + ' клетки, приказ ' + (orderOf(sol) ? 'есть' : 'потерян'));
        const econ2 = econOk(world2, world2.village);
        check('F5: экономика после 120 с без NaN и без расхождения',
          econ2.ok &&
          [world2.village.logs, world2.village.deliveries, world2.village.felled,
            world2.village.inTransit].every(finiteN),
          econ2.text);
      }
    }
  }
}

/* ============================ 2. Рождение ============================== */

section('Рождение: две деревни, дома и выбывший город');

/* Двухдомовая деревня A: у первого дома дверь заперта, у второго места есть.
   Жители A прописаны во второй дом, поэтому первый остаётся самым свободным
   и выбирается первым — именно его недоступность и проверяется. */
function makeSecondHouseA(seed) {
  const t = twoTowns(seed);
  const { world, st, towns } = t;
  const A = towns[0];
  const h1 = townHouse(st.buildings, A.id);
  const spot = B.neighbourSpot(world, st.buildings, { type: 'house', variant: 'a', rot: B.FACE_ROT },
    { clearable: true, requireClear: false, yard: 1 });
  if (!h1 || !spot) return null;
  B.settle(world, spot, { clear: true });
  spot.owner = A.owner;
  spot.town = A.id;
  spot.id = A.id + ':b' + st.buildings.length;
  st.buildings.push(spot);
  A.buildings.push(spot);
  world._buildings = st.buildings;
  for (const v of st.villagers) if (v.town === A.id) v.home = spot;
  return { world, renderer: t.renderer, st, h1, h2: spot, A };
}

/* 2.1. A заперт — B рождает. */
try {
  const { world, renderer, st, towns } = twoTowns(process.argv[3] || 'рождение-1');
  const A = towns[0], Bv = towns[1];
  const hA = townHouse(st.buildings, A.id);
  const hB = townHouse(st.buildings, Bv.id);
  if (!hA || !hB) {
    check('рождение: у обеих деревень есть дом', false, 'дом не найден');
  } else {
    const blocked = blockDoor(world, hA);
    const born = birthAttempts(world, renderer, st.villagers, st.buildings, 3);
    check('рождение: у дома A заняты все клетки у двери',
      blocked > 0, 'занято ' + blocked + ' клеток');
    check('рождение: заблокированный дом A не мешает B родить',
      born.length > 0 && born.every((v) => v.town === Bv.id) && born.some((v) => v.town === Bv.id),
      born.length ? born.map((v) => 'деревня ' + v.town).join(', ') : 'не родил никто');
    check('рождение: ребёнок B прописан в дом B',
      born.length > 0 && born.every((v) => v.home === hB),
      born.length ? born.map((v) => v.home === hB ? 'B' : 'не B').join(',') : '—');
  }
} catch (e) {
  check('рождение: сценарий двух деревень', false, e.message);
}

/* 2.2. Первый дом A заперт — используется второй. */
try {
  const setup = makeSecondHouseA(process.argv[3] || 'рождение-1');
  if (!setup) {
    check('рождение: второй дом A используется', false, 'не нашлось места под второй дом');
  } else {
    const { world, renderer, st, h1, h2, A } = setup;
    const blocked = blockDoor(world, h1);
    const born = birthAttempts(world, renderer, st.villagers, st.buildings, 3);
    check('рождение: дверь первого дома A заперта',
      blocked > 0, 'занято ' + blocked + ' клеток');
    check('рождение: второй дом A используется',
      born.some((v) => v.home === h2) && !born.some((v) => v.home === h1),
      born.length ? born.map((v) => v.home === h2 ? 'второй' : v.home === h1 ? 'первый' : 'другой').join(',') : 'не родил никто');
    check('рождение: свободный второй дом A не блокирует рождение',
      born.some((v) => v.town === A.id && v.home === h2),
      born.length ? born.map((v) => 'деревня ' + v.town).join(', ') : 'не родил никто');
  }
} catch (e) {
  check('рождение: сценарий второго дома', false, e.message);
}

/* 2.3. Выбывший город не рождает. */
try {
  const { world, renderer, st, towns } = twoTowns(process.argv[3] || 'рождение-1');
  const A = towns[0], Bv = towns[1];
  A.alive = false;
  const born = birthAttempts(world, renderer, st.villagers, st.buildings, 3);
  check('рождение: выбывший город не рождает',
    born.length > 0 && born.every((v) => v.town === Bv.id),
    born.length ? born.map((v) => 'деревня ' + v.town).join(', ') : 'не родил никто');
  check('рождение: живой город рядом рождает',
    born.some((v) => v.town === Bv.id) && !born.some((v) => v.town === A.id),
    'родили: ' + born.map((v) => v.town).join(','));
} catch (e) {
  check('рождение: сценарий выбывшего города', false, e.message);
}

/* 2.4. При одном жителе рождение невозможно. */
try {
  const world = WG.generate(Object.assign({}, BASE, { seed: process.argv[3] || 'рождение-1' }));
  const renderer = makeRenderer();
  const st = S.startHome(world, renderer);
  const villagers = S.spawnVillagers(world, renderer, st.buildings, st.home, { count: 1 });
  const born = S.tryBirth(world, renderer, villagers, st.buildings) || [];
  check('рождение: при одном жителе рождение невозможно',
    villagers.length === 1 && born.length === 0,
    'жителей ' + villagers.length + ', родилось ' + born.length);
} catch (e) {
  check('рождение: сценарий одного жителя', false, e.message);
}

/* ============================ 3. Экономика ============================= */

section('Экономика: инвариант груза, увольнение и смерть носильщика');

try {
  const econSeed = process.argv[4] || 'экономика-1';
  const world = WG.generate(Object.assign({}, BASE, { seed: econSeed }));
  const renderer = makeRenderer();
  const st = S.startHome(world, renderer);
  const villagers = S.spawnVillagers(world, renderer, st.buildings, st.home, { count: 1 });
  const worker = villagers[0];
  const camp = st.buildings.find((b) => B.typeOf(b) === 'lumbercamp');
  const town = world.village;

  const hire = S.hire(camp, worker, villagers);
  check('экономика: лесоруба наняли в лагерь', hire.ok, hire.reason);

  /* Три ходки. Инвариант проверяется не только в конце: он обязан держаться
     в КАЖДЫЙ момент — и когда брёвна на руках, и когда их несут. */
  let t = 0, badInvariant = 0, firstBad = null;
  while (t < 900 && town.deliveries < 3) {
    S.stepVillagers(villagers, world, renderer, DT, st.buildings);
    t += DT;
    const econ = econOk(world, town);
    if (!econ.ok) {
      badInvariant++;
      if (!firstBad) firstBad = econ.text;
    }
  }
  check('экономика: после трёх ходок сдано 12 брёвен', town.logs === 12 && town.deliveries === 3,
    townState(town));
  check('экономика: logs + 4·(inTransit + lost) = 4·felled на каждом шаге',
    badInvariant === 0, badInvariant ? badInvariant + ' нарушений, первое: ' + firstBad : 'ни одного нарушения');
  check('экономика: в координатах и таймерах нет NaN',
    villagerFinite(worker) && [town.logs, town.deliveries, town.felled, town.inTransit].every(finiteN),
    townState(town));

  /* Увольнение с полными руками: четыре бревна уже в ходке (inTransit), и они
     должны уйти в lost, а не исчезнуть. */
  t = 0;
  while (t < 180 && !(worker.carrying && worker.state === 'carry')) {
    S.stepVillagers(villagers, world, renderer, DT, st.buildings);
    t += DT;
  }
  if (!(worker.carrying && worker.state === 'carry')) {
    check('экономика: лесоруб успел взять брёвна на руки', false, 'состояние ' + worker.state);
  } else {
    const before = { logs: town.logs, felled: town.felled, inTransit: town.inTransit, lost: town.lost || 0 };
    const fire = S.fire(camp, worker);
    const mode = lostMode(town);
    const delta = (town.lost || 0) - before.lost;
    check('экономика: увольнение носильщика принято', fire.ok, fire.reason);
    check('экономика: у деревни есть счётчик lost', typeof town.lost === 'number',
      'lost=' + town.lost);
    check('экономика: увольнение носильщика увеличило lost на 4 бревна',
      delta === (mode === 'logs' ? 4 : 1) && mode !== null,
      'lost +' + delta + ' (ходок в пути было ' + before.inTransit + '), режим ' + mode);
    check('экономика: после увольнения инвариант груза держится',
      econOk(world, town).ok, econOk(world, town).text);
    check('экономика: уволенный не сдал брёвна и не остался носильщиком',
      !worker.carrying && !worker.employer && town.logs === before.logs,
      'carrying=' + worker.carrying + ' employer=' + (worker.employer ? 'есть' : 'нет'));
  }

  /* Смерть носильщика: тот же учёт, но через Combat.killVillager. */
  if (typeof C.killVillager !== 'function') {
    notRun('экономика: смерть носильщика увеличивает lost на 4',
      'Combat.killVillager не экспортирован');
  } else {
    const rehire = S.hire(camp, worker, villagers);
    if (!rehire.ok) {
      check('экономика: носильщика снова наняли', false, rehire.reason);
    } else {
      t = 0;
      while (t < 240 && !(worker.carrying && worker.state === 'carry')) {
        S.stepVillagers(villagers, world, renderer, DT, st.buildings);
        t += DT;
      }
      if (!(worker.carrying && worker.state === 'carry')) {
        check('экономика: носильщик снова взял брёвна', false, 'состояние ' + worker.state);
      } else {
        const before = { logs: town.logs, inTransit: town.inTransit, lost: town.lost || 0 };
        C.killVillager(worker, world);
        /* stepVillagers делает это первым кадром, но проверка не обязана
           ждать кадра: тот же учёт доступен отдельно. */
        if (S.noteDeadCargo) S.noteDeadCargo(world, villagers);
        else S.stepVillagers(villagers, world, renderer, DT, st.buildings);
        const mode = lostMode(town);
        const delta = (town.lost || 0) - before.lost;
        check('экономика: смерть носильщика увеличила lost на 4 бревна',
          delta === (mode === 'logs' ? 4 : 1) && mode !== null,
          'lost +' + delta + ' (ходок в пути было ' + before.inTransit + '), режим ' + mode);
        check('экономика: после смерти инвариант груза держится',
          econOk(world, town).ok, econOk(world, town).text);
        check('экономика: мёртвый не числится носильщиком',
          worker.dead && !worker.carrying && !worker.employer && town.logs === before.logs,
          'dead=' + worker.dead + ' carrying=' + worker.carrying);
      }
    }
  }

  /* Снимок и возврат мира: lost обязан переехать вместе с казной. Иначе
     после F5 учёт теряет уже потерянные ходки и инвариант «поедет» молча. */
  try {
    const snap = Ser.world(world, st.buildings, villagers);
    check('экономика: снимок несёт lost деревни',
      !!(snap.towns && snap.towns[0]) && typeof snap.towns[0].lost === 'number',
      snap.towns && snap.towns[0] ? 'lost=' + snap.towns[0].lost : 'нет towns');
    const world2 = WG.generate(Object.assign({}, BASE, { seed: econSeed }));
    Ser.apply(world2, snap, null, { smooth: false });
    check('экономика: Serialize.apply сохраняет lost и инвариант',
      !!world2.village && world2.village.lost === town.lost && econOk(world2, world2.village).ok,
      world2.village ? (econOk(world2, world2.village).text + ' (было lost=' + town.lost + ')') : 'нет деревни');
  } catch (e) {
    check('экономика: снимок и возврат сохраняют lost', false, e.message);
  }
} catch (e) {
  check('экономика: сценарий лесоруба', false, e.message);
}

/* ============================ 4. Постановка ============================ */

section('Постановка: житель в пятне, поворот поверх соседа, защищённый выход');

let placeWorld = null;
try {
  placeWorld = WG.generate(Object.assign({}, BASE,
    { seed: 'постановка-1', trees: 0, rocks: 0, forest: 0, rock: 0 }));
  const rect = clearRect(placeWorld, [], 6, 5);
  if (!rect) throw new Error('не нашлось чистой травы 6×5');
  placeWorld._rect = rect;
} catch (e) {
  check('постановка: чистая площадка найдена', false, e.message);
}

if (placeWorld) {
  const { x, y } = placeWorld._rect;
  const house0 = B.make({ type: 'house', variant: 'a', rot: 0, x, y });

  /* 4.1. Житель в пятне. */
  const v = V.blank(placeWorld, { id: 901, index: 901, x: x + 1.5, y: y + 1.5 });
  placeWorld._villagers = [v];
  const chkV = B.canPlace(placeWorld, [], house0,
    { clearable: false, requireClear: true, yard: 0, villagers: [v] });
  check('постановка: дом нельзя поставить на жителя', chkV.ok === false,
    chkV.ok ? 'canPlace разрешил, хотя житель в клетке ' + Math.floor(v.x) + ',' + Math.floor(v.y)
      : 'отказ: ' + chkV.reason);
  check('постановка: отказ словами про жителя',
    chkV.ok === false && /жител/i.test(chkV.reason || ''), chkV.reason || 'причина пуста');

  /* 4.2. Поворот прямоугольного дома поверх соседнего. Дом 2×3; под 90° он
     становится 3×2 и накрывает соседа, который стоял справа. */
  placeWorld._villagers = [];
  const houseA = B.make({ type: 'house', variant: 'a', rot: 0, x, y });
  const houseB = B.make({ type: 'house', variant: 'a', rot: 0, x: x + 2, y });
  const rot = B.checkAt(placeWorld, [houseA, houseB], houseA, { rot: 90 });
  check('постановка: поворот прямоугольного дома поверх соседнего запрещён',
    rot.ok === false, rot.ok ? 'поворот разрешён' : 'отказ: ' + rot.reason);

  /* 4.3. Защищённый выход. Дом окружён стенами так, что у него остался ровно
     один выход; кандидат встаёт ровно на него. Движок обязан отказать словами
     «запирает выход», а не пропустить. Список стен собран вручную и не
     пересекается с домом — это проверка ПРАВИЛА, а не расстановки. */
  if (typeof B.exitCells !== 'function') {
    notRun('постановка: защищённый выход действующей постройки запирать нельзя',
      'в Buildings нет exitCells — правило выходов ещё не реализовано');
  } else {
    const exRect = clearRect(placeWorld, [], 12, 10);
    if (!exRect) {
      check('постановка: площадка для проверки выходов найдена', false, 'нет чистой травы 12×10');
    } else {
      const hx = exRect.x + 3, hy = exRect.y + 3;
      const wallTop = B.make({ type: 'house', variant: 'a', rot: 0, x: hx, y: hy - 3 });
      const wallLeft = B.make({ type: 'house', variant: 'a', rot: 0, x: hx - 2, y: hy });
      const wallRight = B.make({ type: 'house', variant: 'a', rot: 0, x: hx + 2, y: hy });
      const wallBottom = B.make({ type: 'house', variant: 'a', rot: 0, x: hx - 1, y: hy + 3 });
      const active = B.make({ type: 'house', variant: 'a', rot: 0, x: hx, y: hy });
      const around = [active, wallTop, wallLeft, wallRight, wallBottom];
      const exits = B.exitCells(placeWorld, around, active);
      check('постановка: у действующего дома остался ровно один выход',
        exits.length === 1, exits.length + ' выход(ов)');
      const cand = B.make({ type: 'house', variant: 'a', rot: 0, x: hx + 1, y: hy + 3 });
      const sealed = B.canPlace(placeWorld, around, cand,
        { protectExits: true, clearable: false, requireClear: true, yard: 0 });
      check('постановка: защищённый выход действующей постройки запирать нельзя',
        sealed.ok === false && sealed.sealed.indexOf(active) >= 0,
        sealed.ok ? 'постановка разрешена' : 'отказ: ' + sealed.reason);
      check('постановка: отказ словами про запертый выход',
        sealed.ok === false && /выход/i.test(sealed.reason || ''), sealed.reason || 'причина пуста');
    }
  }
}

/* ============================== 5. Серия =============================== */

section('Серия построек: Buildings.planLine');

if (typeof B.planLine !== 'function') {
  notRun('серия: Buildings.planLine считает линию домов',
    'Buildings.planLine ещё нет (агент 9); Play в node недоступен');
} else {
  try {
    const world = WG.generate(Object.assign({}, BASE, { seed: 'серия-1' }));
    const rect = clearRect(world, [], 12, 6);
    if (!rect) throw new Error('не нашлось чистой травы 12×6');
    const spec = { type: 'house', variant: 'a', rot: 0, from: { x: rect.x, y: rect.y },
      to: { x: rect.x + 4, y: rect.y } };
    const opts = { clearable: false, requireClear: true, yard: 0 };
    const plan = B.planLine(world, [], spec, opts);
    check('серия: planLine вернул план', !!(plan && plan.ok !== false && Array.isArray(plan.items)),
      plan ? 'items=' + (plan.items || []).length + ' reason=' + (plan.reason || '') : 'нет ответа');
    if (plan && plan.items) {
      const items = plan.items;
      let overlap = false;
      for (let i = 0; i < items.length && !overlap; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i], b = items[j];
          const fa = B.footprint(a.rot === undefined ? 0 : a.rot, spec.type);
          const fb = B.footprint(b.rot === undefined ? 0 : b.rot, spec.type);
          if (a.x < b.x + fb.w && b.x < a.x + fa.w && a.y < b.y + fb.h && b.y < a.y + fa.h) overlap = true;
        }
      }
      check('серия: в плане два и больше домов', items.length >= 2, 'домов ' + items.length);
      check('серия: дома в плане не налезают друг на друга', !overlap, overlap ? 'есть наложение' : 'чисто');
      const plan2 = B.planLine(world, [], spec, opts);
      const samePlan = !!plan2 &&
        JSON.stringify((plan2.items || []).map((i) => [i.x, i.y])) ===
          JSON.stringify(items.map((i) => [i.x, i.y]));
      check('серия: повторный план детерминирован', samePlan,
        samePlan ? 'план совпал' : 'повтор дал другой план');
    }
  } catch (e) {
    check('серия: сценарий planLine', false, e.message);
  }
}

/* ============================ 6. Chrome =============================== */

/* Один адрес Chrome на все браузерные приёмки. Сам браузер здесь не
   запускается: проверяется разрешение пути — env главнее поиска, ошибка
   внятная, известный путь находится, и ни один тест не держит путь своей
   константой. */
section('Chrome: единый модуль разрешения для браузерных приёмок');

const chromeModulePath = require.resolve('./chrome.js');
function chromeResolve(envValue) {
  const prev = process.env.CHROME_PATH;
  if (envValue === null || envValue === undefined) delete process.env.CHROME_PATH;
  else process.env.CHROME_PATH = envValue;
  delete require.cache[chromeModulePath];
  try {
    return { path: require(chromeModulePath) };
  } catch (e) {
    return { error: e };
  } finally {
    if (prev === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = prev;
    delete require.cache[chromeModulePath];
  }
}

const byEnv = chromeResolve(process.execPath);
check('Chrome: CHROME_PATH главнее известных путей',
  byEnv.path === process.execPath, byEnv.error ? byEnv.error.message : byEnv.path);

const badPath = path.join(__dirname, 'нет-такого-chrome-' + process.pid);
const badEnv = chromeResolve(badPath);
check('Chrome: неверный CHROME_PATH — ошибка с подсказкой',
  !!badEnv.error && /CHROME_PATH/.test(badEnv.error.message) &&
  /Chrome не найден/.test(badEnv.error.message) && /CHROME_PATH=/.test(badEnv.error.message),
  badEnv.error ? badEnv.error.message.split('\n')[0] : 'ошибки нет, вернулся ' + badEnv.path);

const byKnown = chromeResolve(null);
if (byKnown.error) {
  notRun('Chrome: известный путь находится без переменной',
    'Chrome не установлен на этой машине: ' + byKnown.error.message.split('\n')[0]);
} else {
  check('Chrome: известный путь находится без переменной',
    fs.existsSync(byKnown.path), byKnown.path);
}

const BROWSER_TESTS = [
  'look.js', 'house.js', 'game.js', 'controls.js', 'place.js', 'lumberjack.js',
  'townhall.js', 'hut.js', 'ground.js', 'views.js', 'villager.js'
].map((f) => path.join(__dirname, f)).concat([
  'modes.js', 'army.js', 'mp.js', 'menu.js'
].map((f) => path.join(__dirname, '..', '..', 'game', 'tools', f)));
const hard = [], missing = [];
for (const f of BROWSER_TESTS) {
  const src = fs.readFileSync(f, 'utf8');
  if (/Google Chrome\.app\/Contents\/MacOS/.test(src)) hard.push(path.basename(f));
  if (!/require\(['"]\.{1,2}\/(?:\.\.\/)?(?:mapgen2\/tools\/)?chrome\.js['"]\)/.test(src) &&
      !/require\(['"]\.\.\/\.\.\/mapgen2\/tools\/chrome\.js['"]\)/.test(src)) missing.push(path.basename(f));
}
check('Chrome: ни один браузерный тест не держит путь константой', hard.length === 0,
  hard.length ? hard.join(', ') : 'все берут chrome.js');
check('Chrome: все 15 браузерных приёмок требуют chrome.js', missing.length === 0,
  missing.length ? 'без модуля: ' + missing.join(', ') : 'все 15');

/* ================================ итог ================================= */

console.log('\nИТОГ: проверок ' + (passed + fails) + ', ok ' + passed + ', FAIL ' + fails +
  ', NOT RUN ' + notRuns);
process.exit(fails ? 1 : 0);
