/* path.js — поиск ближайшего объекта и маршрут к нему: пример и проверка.

   Прогон БЕЗ БРАУЗЕРА: тот же мир, что строит игра (те же параметры панели),
   та же деревня у центра и тот же код пути (`js/villager.js`), но без кадров.
   Нужен затем, что новое поведение («идёт к камню», «идёт к пятну застройки»)
   отлаживается здесь за секунды, а не в браузере, и тем же кодом, которым
   потом будет ходить игра.

   Что печатает и что проверяет:
     1) какой объект выбран ближайшим и почему именно он (по воздуху ближе,
        а путь нашёлся);
     2) маршрут точками и его длину против кратчайшего клеточного;
     3) что ни одна клетка маршрута не занята и не вода, и что каждая прямая
        между соседними точками чиста (lineClear);
     4) что при свободной прямой маршрут и есть прямая;
     5) полный рабочий цикл лесоруба: наём в лагерь, дорога к дереву, восемь
        ударов за пять секунд, падение, сдача +4 и следующее дерево.

   Запуск:
     node tools/path.js [сид]            # к ближайшему дереву — кодом игры
     node tools/path.js [сид] stone      # к ближайшему камню — по рецепту
                                         # из PATHFINDING.md (новый вид объекта)

   Код возврата 1, если хоть одна проверка не прошла: инструмент годится
   и как быстрый тест, и как доска для опытов. */
const fs = require('fs');
const path = require('path');

/* Модули игры написаны как IIFE поверх globalThis и от DOM не зависят —
   подключаются они так же, как в tools/smoke.js (см. tools/load-worldgen.js:
   общий контекст, а не vm-песочница: в песочнице типизированные массивы
   не оптимизируются). session.js нужен ради деревни и найма: лесоруб — это
   ЖИТЕЛЬ С РАБОТОДАТЕЛЕМ, и рабочий цикл живёт на нём. */
const ROOT = path.join(__dirname, '..', 'js');
const FILES = ['noise.js', 'rng.js', 'worldgen.js', 'buildings.js', 'hero.js', 'villager.js', 'session.js'];
for (const f of FILES) {
  new Function(fs.readFileSync(path.join(ROOT, f), 'utf8') + '\n//# sourceURL=' + f)();
}

const WG = globalThis.WorldGen;
const B = globalThis.Buildings;
const V = globalThis.Villagers;
const S = globalThis.Session;
const DT = 1 / 60;

/* Параметры панели по умолчанию (index.html). Мир обязан быть тем же, что в
   игре, иначе числа отсюда не про игру. */
const PARAMS = { size: 64, land: 0.72, coast: 0.5, forest: 0.5, rock: 0.5, trees: 0.45, rocks: 0.6 };

/* Набор кадров атласа жителя — только числа (кадры, к/с, цикл). Картинки
   читает рендер, а update() берёт отсюда длительность удара, шага и жеста
   сдачи. Числа те же, что в mapgen2/assets/villager/atlas.js; иначе «пять
   секунд» и «восемь ударов» превратились бы в другие. */
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

/* Подделка рендера: Session.startHome ставит постройки, spawnVillagers —
   людей; картинки в проверке не нужны, но списки должны быть живыми. */
function makeRenderer() {
  return {
    world: null, buildings: [], villagers: [],
    villagerSprites: SET,
    setBuildings(list) { this.buildings = list; },
    setVillagers(list) { this.villagers = list; },
    fitIsland() {}
  };
}

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

/* Мир и деревня — ровно как в Session.startHome (js/session.js): ратуша,
   дом жителя и лагерь лесоруба. Лесоруб берётся не «из воздуха»: его нанимают
   в этот лагерь, как в игре. */
function makeWorld(seed) {
  const world = WG.generate(Object.assign({ seed }, PARAMS));
  const renderer = makeRenderer();
  const village = S.startHome(world, renderer);
  return { world, renderer, buildings: village.buildings, home: village.home };
}

/* Откуда считается маршрут в режиме «камень»: двор ратуши, как в старой
   версии проверки. Лесоруб же выходит из дома — это делает spawnVillagers. */
function yard(world, home) {
  if (!home) return { x: world.width / 2, y: world.height / 2 };
  const fp = B.footprint(home.rot);
  return { x: home.x + fp.w + 1, y: home.y + fp.h + 1 };
}

/* ---------------------- рецепт: ближайший объект вида --------------------- */

/* Всё, что ниже до разделителя, — это и есть «способ», которым в игре ищется
   ближайшее дерево, только без имени «дерево»: так он повторяется для камня,
   постройки, ягод, чего угодно. Разбор — в PATHFINDING.md. */

/* 1. Что считается препятствием для этого вида цели. Препятствия — своё,
   цель — своё: камень мешает идти, но к камню мы и идём. */
function blocks(kind, o) {
  if (o.kind === 'tree') return true;
  if (o.kind === 'stone') return o.variant !== 'pebble';
  return false;
}

/* 2. Цели по воздушному расстоянию: ближайшая — первая. Режется бюджетом:
   если двадцать четыре ближайших недостижимы, двадцать пятая не спасёт,
   а перебор всех целей острова — это сотни поисков пути на ровном месте. */
function nearestOfKind(world, x, y, kind, limit) {
  const out = [];
  for (const o of world.objects) if (o.kind === kind) out.push(o);
  out.sort((a, b) => ((a.x - x) ** 2 + (a.y - y) ** 2) - ((b.x - x) ** 2 + (b.y - y) ** 2));
  return limit && out.length > limit ? out.slice(0, limit) : out;
}

/* 3. Откуда подходить: свободные клетки рядом с целью, по возрастанию
   расстояния до идущего. Четыре соседние по осям — с угла это 1.41 клетки,
   и «рядом с деревом» так уже не читается. */
function standCells(world, solid, target, x, y) {
  return V.standCells(world, solid, target, x, y);
}

/* 4. Поиск: ближайшая цель, до которой есть путь. Возвращает цель, клетку
   подхода и маршрут точками (прямые отрезки) — или null. */
function routeToNearest(world, solid, from, kind, limit) {
  const sx = Math.floor(from.x), sy = Math.floor(from.y);
  if (!V.walkable(world, solid, sx, sy)) return null;
  for (const target of nearestOfKind(world, from.x, from.y, kind, limit)) {
    for (const spot of standCells(world, solid, target, from.x, from.y)) {
      if (spot.cx === sx && spot.cy === sy) {
        return { target, spot, cells: [sy * world.width + sx], points: [{ x: from.x, y: from.y }] };
      }
      const cells = V.findPath(world, solid, sx, sy, spot.cx, spot.cy);
      if (!cells || cells.length < 2) continue;
      return { target, spot, cells, points: V.smoothPath(world, solid, cells) };
    }
  }
  return null;
}

/* ------------------------------ измерения -------------------------------- */

const W = (world) => world.width;

/* Длина цепи клеток в метрике поиска: шаг по оси 1, диагональ √2. Это и есть
   кратчайший путь, с которым сравнивается пройденное. */
function octile(world, cells) {
  let len = 0;
  for (let i = 1; i < cells.length; i++) {
    const ax = cells[i - 1] % W(world), ay = (cells[i - 1] / W(world)) | 0;
    const bx = cells[i] % W(world), by = (cells[i] / W(world)) | 0;
    len += (ax !== bx && ay !== by) ? Math.SQRT2 : 1;
  }
  return len;
}

function pathLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

/* Клетки, которые задевает маршрут: каждая точка — центр клетки, между
   точками прямая, и мы проверяем её тем же lineClear, которым её строил
   smoothPath. Заодно считается, сколько клеток занято/вода. */
function auditRoute(world, solid, points) {
  let bad = 0, water = 0, blocked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (!V.lineClear(world, solid, a.x, a.y, b.x, b.y)) bad++;
    // Пройдём отрезок мелким шагом и посмотрим клетку под ногами: так же,
    // как это делает приёмка в браузере.
    const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 8));
    for (let t = 0; t <= n; t++) {
      const x = a.x + (b.x - a.x) * t / n, y = a.y + (b.y - a.y) * t / n;
      const cx = Math.floor(x), cy = Math.floor(y);
      const k = cy * world.width + cx;
      if (!world.isLand[k]) water++;
      else if (solid[k]) blocked++;
    }
  }
  return { bad, water, blocked };
}

/* ------------------------------- прогон ---------------------------------- */

const seed = process.argv[2] || 'житель-приёмка';
const kind = process.argv[3] || 'tree';
const { world, renderer, buildings, home } = makeWorld(seed);
const solid = V.blockedMap(world, buildings);
/* Двор ратуши в деревне может быть занят домом или лагерем. Стартовая точка
   для режима «камень» — ближайшая свободная к двору: иначе проверка честно
   говорит «идти некуда», хотя камень на карте есть. */
const yard0 = yard(world, home);
const freeStart = V.spawnSpot(world, solid, yard0.x + 0.5, yard0.y + 0.5, null, 8);
const from = freeStart || { x: yard0.x + 0.5, y: yard0.y + 0.5 };
const town = world.village;

const trees = nearestOfKind(world, from.x, from.y, 'tree', 0).length;
const stones = nearestOfKind(world, from.x, from.y, 'stone', 0).length;
console.log('сид %s: мир %d×%d, деревьев %d, камней %d, ратуша %s',
  seed, world.width, world.height, trees, stones,
  home ? home.x + ',' + home.y : 'нет');

let target, spot, points, source;
let routeFrom = { x: from.x, y: from.y };
/* Клетка, ОТ КОТОРОЙ считается кратчайший клеточный путь.

   Для лесоруба это не двор ратуши, а место, откуда планировщик выбрал дерево
   (он выходит из лагеря) — иначе сравнение шло бы не с тем маршрутом. Для
   камня это прежняя точка старта. */
let startCell = { cx: Math.floor(routeFrom.x), cy: Math.floor(routeFrom.y) };
let worker = null;
let walkSeconds = 0;

if (kind === 'tree') {
  /* Лесоруб — НАНЯТЫЙ житель. Раньше проверка звала V.plan вручную у жителя
     без employer: он не рубил, и четыре проверки рубки падали. Теперь путь
     строит тот же рабочий цикл, что в игре: дом → найм → лагерь → дерево. */
  const villagers = S.spawnVillagers(world, renderer, buildings, home, { count: 1 });
  worker = villagers[0];
  const camp = buildings.find((b) => B.typeOf(b) === 'lumbercamp');
  const hired = S.hire(camp, worker, villagers);
  check('жителя наняли в лагерь лесоруба', hired.ok,
    hired.reason || 'лагерь ' + (camp ? camp.x + ',' + camp.y : 'нет'));
  if (!hired.ok) {
    console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nИТОГ: ПРИНЯТО');
    process.exit(fails ? 1 : 0);
  }

  /* Ждём, когда рабочий возьмёт топор и выберет дерево. Это дорога до лагеря
     (toCamp), стоянка за топором (take) и только потом цель. */
  let setup = 0;
  while (setup < 60 * 600 && !(worker.state === 'toTree' && worker.tree && worker.path && worker.path.length)) {
    S.stepVillagers(villagers, world, renderer, DT, buildings);
    setup++;
  }
  if (worker.state !== 'toTree' || !worker.tree || !worker.path) {
    console.log('  рабочий не выбрал дерево за %s с: состояние %s', (setup * DT).toFixed(1), worker.state);
  } else {
    target = worker.tree;
    spot = worker.goal;
    points = worker.path.map((p) => ({ x: p.x, y: p.y }));
    /* Прямая считается от ТОЙ точки, с которой спланирован путь (центр
       клетки), а не от текущей позиции: работник успевает сдвинуться на
       кадр, и от сдвинутой точки прямая может быть свободна, хотя
       сглаживатель её законно не взял (ровно через угол лагеря). */
    routeFrom = { x: points[0].x, y: points[0].y };
    source = 'код игры (наём → лагерь → Villagers.plan)';
    startCell = { cx: Math.floor(routeFrom.x), cy: Math.floor(routeFrom.y) };
    walkSeconds = setup * DT;
  }
} else {
  const r = routeToNearest(world, solid, from, kind, V.TREE_TRIES);
  if (r) {
    target = r.target;
    spot = { x: r.spot.cx + 0.5, y: r.spot.cy + 0.5 };
    points = r.points;
  }
  source = 'рецепт из PATHFINDING.md';
}

if (!target || !points) {
  console.log('  нет ни одного достижимого «%s» с %s — идти некуда (это не ошибка пути)',
    kind, from.x.toFixed(1) + ',' + from.y.toFixed(1));
  console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nИТОГ: ПРИНЯТО');
  process.exit(fails ? 1 : 0);
}

const air = Math.hypot(target.x - routeFrom.x, target.y - routeFrom.y);
/* Стартовая точка сглаженного пути может лежать на СВОЁМ дворе лагеря: это
   законная стоянка, но клетка занята пятном, и findPath от неё не идёт.
   Тогда кратчайший считается от первой проходимой точки, а начальный
   отрезок вычитается из пройденного — иначе сравнение шло бы с нулём. */
let cellFrom = points[0], cellPrefix = 0;
for (let i = 0; i < points.length - 1; i++) {
  const q = points[i];
  if (V.walkable(world, solid, Math.floor(q.x), Math.floor(q.y))) { cellFrom = q; break; }
  cellPrefix += Math.hypot(points[i + 1].x - q.x, points[i + 1].y - q.y);
}
/* Бюджет поиска — на кадр; после прогона он мог кончиться, поэтому перед
   измерением начинаем новый «кадр», иначе findPath вернёт null не потому,
   что пути нет, а потому что бюджет исчерпан. */
if (V.beginFrame) V.beginFrame(world);
const cellPath = V.findPath(world, solid, Math.floor(cellFrom.x), Math.floor(cellFrom.y),
  Math.floor(spot.x), Math.floor(spot.y));
const shortest = cellPath ? octile(world, cellPath) : null;
const len = pathLength(points);
const walkedLen = len - cellPrefix;
const direct = V.lineClear(world, solid, routeFrom.x, routeFrom.y, spot.x, spot.y);
const route = auditRoute(world, solid, points);

console.log('цель (%s): %s %s, клетка %d,%d; по воздуху от %s — %s клетки',
  source, kind, target.x.toFixed(2) + ',' + target.y.toFixed(2),
  Math.floor(target.x), Math.floor(target.y),
  routeFrom.x.toFixed(1) + ',' + routeFrom.y.toFixed(1), air.toFixed(2));
console.log('клетка подхода: %d,%d%s', Math.floor(spot.x), Math.floor(spot.y),
  V.walkable(world, solid, Math.floor(spot.x), Math.floor(spot.y)) ? '' : ' — ЗАНЯТА');
console.log('маршрут: %d прямых, %s клетки; кратчайший клеточный %s',
  points.length - 1, len.toFixed(2), shortest === null ? 'нет пути' : shortest.toFixed(2));
console.log('  точки: %s', points.map(p => '(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ')').join(' -> '));
console.log('  прямая от старта к цели: %s', direct ? 'свободна' : 'занята (шёл в обход)');

check('маршрут состоит из чистых прямых', route.bad === 0, route.bad + ' прямых задевают занятое');
check('ни одного шага в воду', route.water === 0, route.water + ' проб в воде');
check('ни одного шага в дерево, камень или дом', route.blocked === 0, route.blocked + ' проб в занятом');
check('путь не длиннее кратчайшего клеточного', shortest !== null && walkedLen <= shortest + 0.05,
  shortest === null ? 'клеточного пути нет — сравнивать не с чем'
    : `${walkedLen.toFixed(2)} при кратчайшем ${shortest.toFixed(2)}`);
check('при свободной прямой маршрут и есть прямая', !direct || points.length === 2,
  direct ? `${points.length - 1} прямых при свободной прямой` : 'прямая занята — обход законен');

/* Ходьба: тот же update, что в игре, — с проверкой клетки под ногами на
   каждом шаге. Это то, что обещано игроку, и то, что проверяет приёмка
   в браузере (tools/villager.js); здесь — быстрая версия без кадров. */
if (kind === 'tree') {
  const villagers = world._villagers;
  let steps = 0, water = 0, blocked = 0;
  while (steps < 60 * 600 && worker.state === 'toTree') {
    S.stepVillagers(villagers, world, renderer, DT, buildings);
    steps++;
    const cx = Math.floor(worker.x), cy = Math.floor(worker.y);
    const k = cy * world.width + cx;
    if (!world.isLand[k]) water++;
    else if (solid[k]) blocked++;
  }
  walkSeconds += steps * DT;
  const face = worker.tree ? ((Math.atan2(worker.tree.y - worker.y, worker.tree.x - worker.x) * 180 / Math.PI) % 360 + 360) % 360 : null;
  const faceErr = face === null ? 0 : Math.abs(((worker.rot - face + 540) % 360) - 180);
  console.log('ходьба: дошёл за %s с, пройдено %s клетки, встал в %s, до ствола %s',
    walkSeconds.toFixed(1), worker.walked.toFixed(2), worker.x.toFixed(2) + ',' + worker.y.toFixed(2),
    worker.tree ? Math.hypot(worker.tree.x - worker.x, worker.tree.y - worker.y).toFixed(2) : '—');
  check('житель дошёл до дерева и рубит', worker.state === 'chop', 'состояние ' + worker.state);
  check('за весь путь ни шага в воду или в занятое', water === 0 && blocked === 0,
    `${water} в воде, ${blocked} в занятом`);
  check('повёрнут на цель', faceErr < 0.5, 'расхождение ' + faceErr.toFixed(2) + '°');

  /* --- рубка: пять секунд, восемь ударов, дерево падает ------------------- *
   * Заказчик (2026-10-14): «когда персонаж подходил к дереву и останавливался
   * он начинал его рубить, рубил его 5 секунд а потом дерево исчезало».
   * Здесь это проверяется без браузера и без картинок — по числам симуляции. */
  const tree = worker.tree, start = { x: worker.x, y: worker.y };
  const trees0 = world.stats.trees;
  let t = 0, moved = 0, shakes = 0, goneAt = null, workFrames = 0;
  while (worker.state === 'chop' && t < 12) {
    if (tree) tree.shake = 0;                 // тряску гасит рендер; тут её считаем сами
    S.stepVillagers(villagers, world, renderer, DT, buildings);
    t += DT;
    if (worker.anim === 'work') workFrames++;
    if (worker.x !== start.x || worker.y !== start.y) moved++;
    if (tree && tree.shake) shakes++;
    if (tree && world.objects.indexOf(tree) < 0 && goneAt === null) goneAt = t;
  }
  const hits = worker.hits;
  console.log('рубка: %s с, ударов %d, дерево пропало на %s с, деревьев %d -> %d',
    t.toFixed(2), hits, goneAt === null ? '—' : goneAt.toFixed(2), trees0, world.stats.trees);
  check('во время рубки он играет work и не делает ни шага',
    workFrames > 0 && moved === 0, `${workFrames} шагов анимации, сдвигов ${moved}`);
  check('ударов восемь, и каждый тряхнул дерево', hits === 8 && shakes === 8,
    `ударов ${hits}, с тряской ${shakes}`);
  check('дерево исчезло ровно на пятой секунде рубки',
    goneAt !== null && Math.abs(goneAt - 5.0) < 0.05,
    goneAt === null ? 'дерево не пропало' : goneAt.toFixed(3) + ' с');
  check('счётчик деревьев уменьшился на одно', world.stats.trees === trees0 - 1,
    `${trees0} -> ${world.stats.trees}`);

  /* Сдача. У нанятого рабочего после падения есть ходка в лагерь: он несёт
     брёвна и сдаёт их (+4 к казне), и только потом выбирает следующее дерево.
     Это и есть полный цикл; проверка следующего дерева ждёт его, а не стоит
     десяти секунд у срубленного ствола. */
  const logs0 = town.logs;
  let back = 0;
  while (back < 120 && !worker.tree) {
    S.stepVillagers(villagers, world, renderer, DT, buildings);
    back += DT;
  }
  const nextTree = worker.tree;
  const sameTree = !!(nextTree && tree && Math.abs(nextTree.x - tree.x) < 1e-9 &&
                      Math.abs(nextTree.y - tree.y) < 1e-9);
  console.log('сдача: %s брёвен за %s с, ходок %d, в пути %d, срублено %d',
    (town.logs - logs0 >= 0 ? '+' : '') + (town.logs - logs0), back.toFixed(2),
    town.deliveries, town.inTransit, town.felled);
  check('после падения он сдал брёвна в лагерь (+4)', town.logs - logs0 === 4,
    `прибавка ${town.logs - logs0}`);
  check('после падения он идёт к следующему дереву, а не стоит',
    !!nextTree && !sameTree, nextTree ? 'следующее ' + nextTree.x.toFixed(1) + ',' + nextTree.y.toFixed(1) : 'не нашёл');
}

console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nИТОГ: ПРИНЯТО');
process.exit(fails ? 1 : 0);
