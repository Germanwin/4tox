/* path.js — поиск ближайшего объекта и маршрут к нему: пример и проверка.

   Прогон БЕЗ БРАУЗЕРА: тот же мир, что строит игра (те же параметры панели),
   та же ратуша у центра, тот же код пути (`js/villager.js`), но без кадров.
   Нужен затем, что новое поведение («идёт к камню», «идёт к пятну застройки»)
   отлаживается здесь за секунды, а не в браузере, и тем же кодом, которым
   потом будет ходить игра.

   Что печатает и что проверяет:
     1) какой объект выбран ближайшим и почему именно он (по воздуху ближе,
        а путь нашёлся);
     2) маршрут точками и его длину против кратчайшего клеточного;
     3) что ни одна клетка маршрута не занята и не вода, и что каждая прямая
        между соседними точками чиста (lineClear);
     4) что при свободной прямой маршрут и есть прямая.

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
   не оптимизируются). */
const ROOT = path.join(__dirname, '..', 'js');
const FILES = ['noise.js', 'rng.js', 'worldgen.js', 'buildings.js', 'hero.js', 'villager.js'];
for (const f of FILES) {
  new Function(fs.readFileSync(path.join(ROOT, f), 'utf8') + '\n//# sourceURL=' + f)();
}

const WG = globalThis.WorldGen;
const B = globalThis.Buildings;
const V = globalThis.Villagers;
const DT = 1 / 60;

/* Параметры панели по умолчанию (index.html) и ратуша игрока (js/app.js:
   HOME). Мир обязан быть тем же, что в игре, иначе числа отсюда не про игру.
   Поворот берём у движка построек: лицом вправо-вниз — то же правило, по
   которому стоит вся деревня (js/buildings.js, FACE_ROT). */
const HOME = { variant: 'c', rot: B.FACE_ROT };
const PARAMS = { size: 64, land: 0.72, coast: 0.5, forest: 0.5, rock: 0.5, trees: 0.45, rocks: 0.6 };

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

/* Мир и ратуша — ровно как в newGame (js/app.js). */
function makeWorld(seed) {
  const world = WG.generate(Object.assign({ seed }, PARAMS));
  const buildings = [];
  const home = B.homeSpot(world, HOME);
  if (home) {
    B.clearSite(world, Object.assign({}, home), { clearable: true, requireClear: false, yard: 1 });
    buildings.push(home);
  }
  return { world, buildings, home };
}

/* Откуда игрок появляется: двор ратуши (js/app.js: spawnVillagers). */
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
const { world, buildings, home } = makeWorld(seed);
const solid = V.blockedMap(world, buildings);
const from = yard(world, home);

const trees = nearestOfKind(world, from.x, from.y, 'tree', 0).length;
const stones = nearestOfKind(world, from.x, from.y, 'stone', 0).length;
console.log('сид %s: мир %d×%d, деревьев %d, камней %d, ратуша %s',
  seed, world.width, world.height, trees, stones,
  home ? home.x + ',' + home.y : 'нет');

/* Дерево по умолчанию идётся КОДОМ ИГРЫ, камень — рецептом выше: это и
   показывает, что способ переносится на новый вид.
   
   Дерево ищет ПЛАНИРОВЩИК (V.plan), а не рождение жителя: житель без работы
   дерево не ищет вовсе — он гуляет вокруг дома (js/villager.js), а за дерево
   берётся наёмный работник (задача 3). Планировщик ровно тот же, что звал
   create до 2026-10-16, и он же ставит состояние toward. */
let target, spot, points, source;
/* Клетка, ОТ КОТОРОЙ считается кратчайший клеточный путь.

   Это не та клетка, которую тест назвал жителю, а та, где он оказался: если
   названная занята деревом или камнем, `create` сам выводит человека на
   свободную (`spawnSpot`). Путь от занятой клетки поиск не находит вовсе —
   `findPath` возвращает null, — и раньше из этого выходил кратчайший 0.00, а
   проверка «путь не длиннее кратчайшего» валилась на ровном месте (сид
   `другой-сид-777`: маршрут 5.41 против «кратчайшего» 0.00). От нуля сравнивать
   не с чем: нет клеточного пути — нет и оценки, и сказать надо именно это. */
let startCell = { cx: Math.floor(from.x), cy: Math.floor(from.y) };
if (kind === 'tree') {
  const v = V.create(world, { index: 0, x: from.x, y: from.y, buildings, avoid: [] });
  V.plan(v, world, solid);
  target = v.tree; spot = v.goal; points = v.path; source = 'код игры (Villagers.plan)';
  startCell = { cx: Math.floor(v.x), cy: Math.floor(v.y) };
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

const air = Math.hypot(target.x - from.x, target.y - from.y);
// Путь от занятой клетки не находится — тогда кратчайшего нет, а не ноль.
const cellPath = V.findPath(world, solid, startCell.cx, startCell.cy,
  Math.floor(spot.x), Math.floor(spot.y));
const shortest = cellPath ? octile(world, cellPath) : null;
const len = pathLength(points);
const direct = V.lineClear(world, solid, from.x, from.y, spot.x, spot.y);
const route = auditRoute(world, solid, points);

console.log('цель (%s): %s %s, клетка %d,%d; по воздуху от %s — %s клетки',
  source, kind, target.x.toFixed(2) + ',' + target.y.toFixed(2),
  Math.floor(target.x), Math.floor(target.y),
  from.x.toFixed(1) + ',' + from.y.toFixed(1), air.toFixed(2));
if (kind === 'tree' && (startCell.cx !== Math.floor(from.x) || startCell.cy !== Math.floor(from.y))) {
  console.log('  житель встал не туда, куда его позвали: %d,%d вместо %d,%d (клетка занята)',
    startCell.cx, startCell.cy, Math.floor(from.x), Math.floor(from.y));
}
console.log('клетка подхода: %d,%d%s', Math.floor(spot.x), Math.floor(spot.y),
  V.walkable(world, solid, Math.floor(spot.x), Math.floor(spot.y)) ? '' : ' — ЗАНЯТА');
console.log('маршрут: %d прямых, %s клетки; кратчайший клеточный %s',
  points.length - 1, len.toFixed(2), shortest === null ? 'нет пути' : shortest.toFixed(2));
console.log('  точки: %s', points.map(p => '(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ')').join(' -> '));
console.log('  прямая от старта к цели: %s', direct ? 'свободна' : 'занята (шёл в обход)');

check('маршрут состоит из чистых прямых', route.bad === 0, route.bad + ' прямых задевают занятое');
check('ни одного шага в воду', route.water === 0, route.water + ' проб в воде');
check('ни одного шага в дерево, камень или дом', route.blocked === 0, route.blocked + ' проб в занятом');
check('путь не длиннее кратчайшего клеточного', shortest !== null && len <= shortest + 0.05,
  shortest === null ? 'клеточного пути нет — сравнивать не с чем'
    : `${len.toFixed(2)} при кратчайшем ${shortest.toFixed(2)}`);
check('при свободной прямой маршрут и есть прямая', !direct || points.length === 2,
  direct ? `${points.length - 1} прямых при свободной прямой` : 'прямая занята — обход законен');

/* Ходьба: тот же update, что в игре, — с проверкой клетки под ногами на
   каждом шаге. Это то, что обещано игроку, и то, что проверяет приёмка
   в браузере (tools/villager.js); здесь — быстрая версия без кадров.

   Набор спрайтов тут ПОДДЕЛКА, и это не поблажка: update() берёт из атласа
   только число кадров и к/с анимации (Hero.frameCount / Hero.fps), а картинки
   читает рендер. Числа взяты те же, что в атласе игры (villager/poses.py:
   idle 6 x 8, walk 8 x 12, work 8 x 12) — иначе удар считался бы не по той
   фазе, и «пять секунд» превратились бы в пятьдесят ударов. */
const SET = { anims: { idle: { frames: 6, fps: 8, loop: true },
                       walk: { frames: 8, fps: 12, loop: true },
                       work: { frames: 8, fps: 12, loop: false } } };

if (kind === 'tree') {
  const v = V.create(world, { index: 0, x: from.x, y: from.y, buildings, avoid: [] });
  V.plan(v, world, solid);            // работа: цель и маршрут (см. выше)
  let steps = 0, water = 0, blocked = 0;
  while (steps < 60 * 600 && v.state === 'toward') {
    V.update(v, world, SET, DT, { buildings });
    steps++;
    const cx = Math.floor(v.x), cy = Math.floor(v.y);
    const k = cy * world.width + cx;
    if (!world.isLand[k]) water++;
    else if (solid[k]) blocked++;
  }
  const face = v.tree ? ((Math.atan2(v.tree.y - v.y, v.tree.x - v.x) * 180 / Math.PI) % 360 + 360) % 360 : null;
  const faceErr = face === null ? 0 : Math.abs(((v.rot - face + 540) % 360) - 180);
  console.log('ходьба: дошёл за %s с, пройдено %s клетки, встал в %s, до ствола %s',
    (steps / 60).toFixed(1), v.walked.toFixed(2), v.x.toFixed(2) + ',' + v.y.toFixed(2),
    v.tree ? Math.hypot(v.tree.x - v.x, v.tree.y - v.y).toFixed(2) : '—');
  check('житель дошёл до дерева и рубит', v.state === 'chop', 'состояние ' + v.state);
  check('за весь путь ни шага в воду или в занятое', water === 0 && blocked === 0,
    `${water} в воде, ${blocked} в занятом`);
  check('повёрнут на цель', faceErr < 0.5, 'расхождение ' + faceErr.toFixed(2) + '°');

  /* --- рубка: пять секунд, восемь ударов, дерево падает ------------------- *
   * Заказчик (2026-10-14): «когда персонаж подходил к дереву и останавливался
   * он начинал его рубить, рубил его 5 секунд а потом дерево исчезало».
   * Здесь это проверяется без браузера и без картинок — по числам симуляции. */
  const tree = v.tree, start = { x: v.x, y: v.y };
  const trees0 = world.stats.trees;
  let t = 0, moved = 0, shakes = 0, goneAt = null, workFrames = 0;
  while (v.state === 'chop' && t < 12) {
    if (tree) tree.shake = 0;                 // тряску гасит рендер; тут её считаем сами
    V.update(v, world, SET, DT, { buildings });
    t += DT;
    if (v.anim === 'work') workFrames++;
    if (v.x !== start.x || v.y !== start.y) moved++;
    if (tree && tree.shake) shakes++;
    if (tree && world.objects.indexOf(tree) < 0 && goneAt === null) goneAt = t;
  }
  const hits = v.hits;
  let nextTree = null;
  for (let i = 0; i < 600 && !nextTree; i++) {
    V.update(v, world, SET, DT, { buildings });
    if (v.tree) nextTree = v.tree;
  }
  const sameTree = !!(nextTree && tree && Math.abs(nextTree.x - tree.x) < 1e-9 &&
                      Math.abs(nextTree.y - tree.y) < 1e-9);
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
  check('после падения он идёт к следующему дереву, а не стоит',
    !!nextTree && !sameTree, nextTree ? 'следующее ' + nextTree.x.toFixed(1) + ',' + nextTree.y.toFixed(1) : 'не нашёл');
}

console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nИТОГ: ПРИНЯТО');
process.exit(fails ? 1 : 0);
