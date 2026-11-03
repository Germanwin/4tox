/* lumbercamp-move.js — приёмка ПЕРЕЕЗДА лагеря лесоруба и пути к дереву.

   Прогон БЕЗ БРАУЗЕРА: движок тот же (`js/villager.js`, `js/buildings.js`),
   мир нарочно простой — ровная суша и кольцо деревьев. Так проверяются
   ровно те поломки, которые видит игрок, а не случайности конкретного сида:

     1) лагерь переехал, а рабочий остался с местом СТАРОГО двора. Прежде он
        «стоял на своём месте» там, где лагеря уже нет, брал топор на старом
        месте и сдавал брёвна в траву;
     2) последний шаг в двор закрыт (дерево/камень у кромки) — рабочий вставал
        у лагеря с брёвнами и не двигался никогда: путь кончился, а сдачи нет;
     3) дерево на другой стороне лагеря «по линейке» ближе, и рабочий шёл к
        нему вокруг всего лагеря, хотя такое же дерево на своей стороне — в
        двух шагах;
     4) вход в двор всегда шёл через одну конкретную клетку подхода, даже
        когда рабочий стоял с другой стороны;
     5) житель ТЕЛЕПОРТИРОВАЛСЯ из двора: аварийный выход из занятой клетки
        срабатывал на каждом штатном выходе из лагеря. Теперь ни один шаг не
        длиннее `SPEED x DT`; если лагерь переехал прямо на рабочего, он делает
        короткий ШАГ на место двора/свободную клетку, а не переносится;
     6) лагерь переехал ПРЯМО В ЖИТЕЛЯ — и рабочий, и гуляющий обязаны выйти
        из пятна шагом к ближайшей свободной клетке (без построек, деревьев и
        камней), а не замереть внутри;
     7) переезд лагеря НЕ отбирает топор у тех, кто уже в лесу: идущий к
        дереву и рубящий остаются при своём дереве и не идут за топором
        заново (топор «теряет» только тот, кого накрыло пятном);
     8) брёвна складывают ЛИЦОМ к лагерю, а не спиной к нему.

   Проверки численные: каждая сдача — на ТЕКУЩЕМ месте двора; после переезда
   ни у кого не остаётся старого места; никто не стоит с брёвнами дольше
   пяти секунд; ЖДИТЕ НИ ОДНОГО СКАЧКА больше шага за кадр; все трое
   продолжают работать; казна сходится с рубкой:
   `logs + 4 x inTransit = 4 x felled`.

   Запуск: node tools/lumbercamp-move.js
   Код возврата 1, если хоть одна проверка не прошла. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');

/* Модули игры — IIFE поверх globalThis и без DOM. `window` нужен атласу:
   `atlas.js` кладёт метаданные в window, поэтому в Node window = globalThis. */
globalThis.window = globalThis;
globalThis.Image = function () {
  this.onload = null;
  this.onerror = null;
  Object.defineProperty(this, 'src', {
    get: function () { return this._src; },
    set: function (v) { this._src = v; if (this.onload) this.onload(); }
  });
};
for (const f of ['noise.js', 'rng.js', 'worldgen.js', 'buildings.js', 'hero.js', 'villager.js']) {
  new Function(fs.readFileSync(path.join(JS, f), 'utf8') + '\n//# sourceURL=' + f)();
}
new Function(fs.readFileSync(path.join(ROOT, 'assets', 'lumbercamp', 'atlas.js'), 'utf8'))();

const B = globalThis.Buildings;
const V = globalThis.Villagers;
const DT = 1 / 60;

/* Атлас жителя подделан ровно настолько, насколько его читает update():
   число кадров, к/с, цикл это или проход и картинка (её читает рендер, а не
   движение). Числа — те же, что в атласе игры. */
const FRAMES = { idle: 8, walk: 8, work: 8, walk_axe: 8, carry: 8, carry_put: 4 };
globalThis.Hero = {
  frameCount: function (set, anim) { return FRAMES[anim] || 8; },
  fps: function () { return 12; },
  loops: function (set, anim) { return anim !== 'carry_put'; },
  sprite: function () { return null; },
  scaleAt: function () { return 1; },
  build: function () { return {}; }
};

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

/* Атлас лагеря: нужен для двора (yard), иначе у лагеря нет мест, куда идти.
   Загрузка синхронная: наш Image зовёт onload сразу, а метаданные уже в
   globalThis. */
let atlasOk = false;
B.load('lumbercamp', { base: path.join(ROOT, 'assets') + '/' },
  function () { atlasOk = true; },
  function (e) { console.error('атлас лагеря: ' + (e && e.message ? e.message : e)); });
if (!atlasOk) {
  console.error('FAIL атлас лагеря не загрузился');
  process.exit(1);
}

const CAMP_TYPE = 'lumbercamp';
const LOGS = V.LOGS_PER_TRIP;

function campAt(x, y) {
  return B.make({ type: CAMP_TYPE, variant: 'a', rot: B.FACE_ROT, x: x, y: y });
}

/* Ровная суша и кольцо деревьев вокруг лагеря. Деревья не вплотную к пятну
   и не в клетках двора; у самых кромок новый лагерь расчищается отдельно. */
function makeWorld(seed, camp) {
  const W = 44, H = 44;
  const world = {
    width: W, height: H,
    isLand: new Uint8Array(W * H).fill(1),
    objects: [], seed: seed, stats: { trees: 0 },
    village: { logs: 0, deliveries: 0, felled: 0, inTransit: 0 },
    _buildRev: 0
  };
  const cx = camp.x + 1.5, cy = camp.y + 1.5;
  for (let y = 5; y < H - 5; y += 2) {
    for (let x = 5; x < W - 5; x += 2) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d < 4.5 || d > 14) continue;
      if (x >= camp.x - 2 && x <= camp.x + 4 &&
          y >= camp.y - 2 && y <= camp.y + 4) continue;
      /* Стартовая площадка рабочих: три клетки справа-снизу, чтобы create()
         не искал им место по всему острову. */
      if (x >= 20 && x <= 24 && y >= 19 && y <= 24) continue;
      world.objects.push({ kind: 'tree', x: x + 0.5, y: y + 0.5, type: 'oak' });
    }
  }
  world.stats.trees = world.objects.length;
  return world;
}

function clearArea(world, x0, y0, x1, y1) {
  world.objects = world.objects.filter(function (o) {
    if (o.kind !== 'tree') return true;
    return !(o.x >= x0 && o.x < x1 && o.y >= y0 && o.y < y1);
  });
  world.stats.trees = world.objects.reduce(function (n, o) { return n + (o.kind === 'tree' ? 1 : 0); }, 0);
}

function spawnWorkers(world, camp) {
  const workers = [];
  for (let i = 0; i < 3; i++) {
    const v = V.create(world, { x: 21 + i, y: 21, index: i });
    v.employer = camp;
    v.job = camp;
    v.state = 'toCamp';
    v.path = null;
    v.spot = null;
    v.spotTrip = false;
    workers.push(v);
  }
  camp.workers = workers;
  world._villagers = workers;
  return workers;
}

/* Шаг всех троих тем же кодом, что игровой цикл, и журнал событий, которые
   надо проверить: сдачи, вход в take, «стоит с брёвнами». */
function simulate(world, camp, list, workers, seconds, log) {
  const steps = Math.round(seconds / DT);
  /* За кадр житель проходит не больше SPEED x DT. Всё, что дальше, — скачок
     (spawnSpot, телепорт из пятна), и его надо ловить отдельно от «стоит». */
  const maxStep = V.SPEED * DT + 0.002;
  for (let s = 0; s < steps; s++) {
    world._villagers = workers;
    for (const v of workers) {
      const beforeDel = v.delivered || 0;
      const beforeState = v.state;
      const bx = v.x, by = v.y;
      V.update(v, world, null, DT, { buildings: list });
      const jump = Math.hypot(v.x - bx, v.y - by);
      if (jump > maxStep) {
        log.teleports.push({
          who: v.id, from: [+bx.toFixed(2), +by.toFixed(2)],
          to: [+v.x.toFixed(2), +v.y.toFixed(2)], by: +jump.toFixed(2),
          before: beforeState, after: v.state
        });
      }
      if ((v.delivered || 0) > beforeDel) {
        log.deliveries++;
        if (!B.atYardSpot(camp, v.x, v.y)) {
          log.badDeposits.push({
            who: v.id, x: +v.x.toFixed(2), y: +v.y.toFixed(2),
            state: v.state, spot: v.spot ? [+v.spot.x.toFixed(2), +v.spot.y.toFixed(2)] : null
          });
        }
        /* Лицом к лагерю: сдача не должна играться спиной к нему. */
        const cc = B.center(camp);
        const want = Math.atan2(cc.y - v.y, cc.x - v.x) * 180 / Math.PI;
        const err = Math.abs(((v.rot - want + 540) % 360) - 180);
        if (log.facingWho === null || err > log.facingMax) {
          log.facingMax = err;
          log.facingWho = v.id;
        }
      }
      if (v.state === 'take' && beforeState !== 'take') {
        log.takes++;
        if (!B.atYardSpot(camp, v.x, v.y)) {
          log.badTakes.push({ who: v.id, x: +v.x.toFixed(2), y: +v.y.toFixed(2) });
        }
      }
      /* «Стоит с брёвнами и не двигается»: путь кончился, сдачи не было,
         место не своё. Считаем длительность и запоминаем максимум. */
      const still = (v.state === 'carry' || v.state === 'toCamp') &&
                    !v.path && !V.atOwnYard(v) &&
                    Math.abs(v.x - bx) < 1e-9 && Math.abs(v.y - by) < 1e-9;
      if (still) {
        v._still = (v._still || 0) + DT;
        if (v._still > log.stillMax) {
          log.stillMax = v._still;
          log.stillWho = v.id;
          log.stillState = v.state;
        }
      } else {
        v._still = 0;
      }
    }
  }
}

/* Текущее моё место двора — или null. Снимок прошлого переезда должен
   исчезнуть, а не остаться «почти местом». */
function staleSpots(camp, workers) {
  const out = [];
  for (const v of workers) {
    if (!v.spot) continue;
    if (!B.atYardSpot(camp, v.spot.x, v.spot.y)) {
      out.push({ who: v.id, spot: [+v.spot.x.toFixed(2), +v.spot.y.toFixed(2)] });
    }
  }
  return out;
}

function moveCamp(world, camp, x, y) {
  B.setSpot(world, camp, { x: x, y: y });
  V.blockedMap(world, [camp]);          // та же карта, что читает житель
}

console.log('переезд лагеря лесоруба: путь, место и старые точки');

/* --- 1. место двора есть у всех четырёх сторон ----------------------- */
const camp0 = campAt(15, 15);
const world0 = makeWorld('лагерь-переезд', camp0);
const yard = B.yardSlots(camp0);
const cells = B.workSpotCells(camp0);
const yardCells = {};
for (const s of yard) yardCells[s.cell.x + ',' + s.cell.y] = 1;
const cellKeys = cells.map(function (c) { return c.x + ',' + c.y; });
const sides = {};
for (const s of yard) sides[s.side] = 1;
check('клетки подхода — по одной на каждое место двора, а не только справа',
  cellKeys.length === Object.keys(yardCells).length &&
  cellKeys.every(function (k) { return yardCells[k]; }),
  'мест ' + yard.length + ', клеток ' + cells.length + ', стороны ' + Object.keys(sides).join('/'));

/* --- 2. короткий заступ с угла не бракуется ------------------------- */
const solid0 = V.blockedMap(world0, [camp0]);
const slot0 = yard[0];
const ap0 = B.workSpotCells(camp0).filter(function (c) { return c.y === slot0.cell.y + 1; })[0];
if (ap0) {
  check('короткий заступ с соседней клетки подхода проходит (одна занятая клетка — не две)',
    V.finalStepClear(world0, solid0, ap0.x + 0.5, ap0.y + 0.5, slot0.x, slot0.y),
    'место ' + slot0.x.toFixed(2) + ',' + slot0.y.toFixed(2) +
    ', подход ' + ap0.x + ',' + ap0.y);
}

/* --- 3. цель — короткая ДОРОГА, а не ближайшая по линейке ----------- */
function chooseTree(from, trees) {
  const W = 44, H = 44;
  const world = {
    width: W, height: H,
    isLand: new Uint8Array(W * H).fill(1),
    objects: trees.map(function (t) {
      return { kind: 'tree', x: t[0] + 0.5, y: t[1] + 0.5, type: 'oak' };
    }),
    seed: 'выбор-дерева', stats: { trees: trees.length },
    village: { logs: 0, deliveries: 0, felled: 0, inTransit: 0 },
    _buildRev: 0
  };
  const camp = campAt(20, 20);
  const solid = V.blockedMap(world, [camp]);
  const v = V.create(world, { x: from[0] + 0.5, y: from[1] + 0.5, index: 0 });
  v.employer = camp;
  v.job = camp;
  v.state = 'toTree';
  v.path = null;
  v.spot = null;
  const ok = V.plan(v, world, solid, {
    anim: 'toTree', state: 'toTree', ref: B.center(camp)
  });
  let len = 0;
  if (v.path) {
    for (let i = 1; i < v.path.length; i++) {
      len += Math.hypot(v.path[i].x - v.path[i - 1].x, v.path[i].y - v.path[i - 1].y);
    }
  }
  return {
    ok: ok, tree: v.tree ? [v.tree.x, v.tree.y] : null,
    goal: v.goal ? [+v.goal.x.toFixed(2), +v.goal.y.toFixed(2)] : null,
    len: +len.toFixed(2), path: v.path
  };
}
/* Левое дерево (19,22) ближе к ЦЕНТРУ лагеря, чем правое (24,22). Рабочий
   стоит на правой клетке подхода: к правому идти одну клетку, к левому —
   вокруг всего лагеря. Раньше выбиралось левое. */
const right = chooseTree([23, 21], [[19, 22], [24, 22]]);
check('дерево своей стороны выбирается, хотя по линейке от центра оно дальше',
  !!right.tree && Math.abs(right.tree[0] - 24.5) < 1e-9 && right.len <= 2.5,
  'выбрано ' + JSON.stringify(right.tree) + ', путь ' + right.len + ' клетки');
/* И та же проверка для верхней кромки: верхнее дерево (22,18) дальше от
   центра, чем левое (19,22), но идти до него с верхней клетки — наискосок. */
const top = chooseTree([20, 19], [[19, 22], [22, 18]]);
check('дерево перед рабочей кромкой выбирается и на верхней стороне',
  !!top.tree && Math.abs(top.tree[0] - 22.5) < 1e-9 && top.len <= 2.5,
  'выбрано ' + JSON.stringify(top.tree) + ', путь ' + top.len + ' клетки');

/* --- 4. вход в двор с той стороны, с которой рабочий пришёл ---------- */
function approachFrom(px, py) {
  const W = 44, H = 44;
  const world = {
    width: W, height: H, isLand: new Uint8Array(W * H).fill(1), objects: [],
    seed: 'вход', stats: { trees: 0 },
    village: { logs: 0, deliveries: 0, felled: 0, inTransit: 1 },
    _buildRev: 0
  };
  const camp = campAt(20, 20);
  const list = [camp];
  const solid = V.blockedMap(world, list);
  const v = V.create(world, { x: px, y: py, index: 0 });
  v.employer = camp;
  v.job = camp;
  v.state = 'carry';
  v.path = null;
  v.spot = null;
  v.spotTrip = false;
  const ok = V.goToCamp(v, world, solid, null);
  const last = v.path && v.path[v.path.length - 1];
  return {
    ok: ok, side: v.spot ? v.spot.side : null,
    spot: v.spot ? [+v.spot.x.toFixed(2), +v.spot.y.toFixed(2)] : null,
    into: !!v.intoYard,
    endsAtSpot: !!(last && v.spot &&
      Math.abs(last.x - v.spot.x) < 0.02 && Math.abs(last.y - v.spot.y) < 0.02)
  };
}
const enterTop = approachFrom(20.5, 18.5);
check('с верхней клетки подхода выбирается верхнее место двора, а не правое',
  enterTop.ok && enterTop.side === 'top' && enterTop.into && enterTop.endsAtSpot,
  'место ' + JSON.stringify(enterTop.spot) + ', сторона ' + enterTop.side +
  ', конец пути на месте: ' + enterTop.endsAtSpot);
const enterRight = approachFrom(24.5, 21.5);
check('с правой клетки подхода выбирается правое место двора',
  enterRight.ok && enterRight.side === 'right' && enterRight.into && enterRight.endsAtSpot,
  'место ' + JSON.stringify(enterRight.spot) + ', сторона ' + enterRight.side);

/* --- 5. Главный прогон: работают, лагерь переезжает ------------------ */
const camp = campAt(15, 15);
const world = makeWorld('лагерь-переезд', camp);
const list = [camp];
const workers = spawnWorkers(world, camp);
const log = { deliveries: 0, badDeposits: [], takes: 0, badTakes: [],
              teleports: [], stillMax: 0, stillWho: null, stillState: null,
              facingMax: 0, facingWho: null };

/* До первого переезда каждый должен успеть сдать хотя бы по разу: иначе
   проверка «продолжили после переезда» ничего не значит. */
let guard = 0;
while (guard++ < 300 && workers.some(function (v) { return (v.delivered || 0) < LOGS; })) {
  simulate(world, camp, list, workers, 1, log);
}
check('до переезда все трое уже работали',
  workers.every(function (v) { return (v.delivered || 0) >= LOGS; }),
  workers.map(function (v) { return '№' + v.id + ' ' + (v.delivered || 0); }).join(' · '));

/* Переезд 1 — одним прыжком, когда рабочий как раз идёт в лагерь за топором
   с уже выбранным местом (spotTrip). Именно в этот момент старый код брал
   топор на старом месте. */
guard = 0;
while (guard++ < 600 && !workers.some(function (v) { return v.state === 'toCamp' && v.spotTrip; })) {
  simulate(world, camp, list, workers, 0.5, log);
}
const beforeMove1 = workers.map(function (v) { return v.delivered || 0; });
clearArea(world, 23, 23, 31, 31);
moveCamp(world, camp, 25, 25);
simulate(world, camp, list, workers, 1, log);
check('после переезда ни у кого не осталось места старого двора',
  staleSpots(camp, workers).length === 0,
  JSON.stringify(staleSpots(camp, workers)));
check('все сдачи после переезда — на текущем месте двора',
  log.badDeposits.length === 0,
  log.badDeposits.length ? JSON.stringify(log.badDeposits.slice(0, 4)) : 'сдач ' + log.deliveries);
check('топор берут на текущем дворе, а не на старом месте',
  log.badTakes.length === 0,
  log.badTakes.length ? JSON.stringify(log.badTakes.slice(0, 4)) : 'заходов за топором ' + log.takes);
simulate(world, camp, list, workers, 90, log);
check('после переезда каждый снова сдал хотя бы раз',
  workers.every(function (v, i) { return (v.delivered || 0) > beforeMove1[i]; }),
  workers.map(function (v) { return '№' + v.id + ' +' + ((v.delivered || 0) - beforeMove1[v.id - 1]); }).join(' · '));

/* Переезд 2 — ведением, по клетке, как мышью. Двигаем, пока рабочий несёт
   брёвна: именно в этой ходке раньше появлялась сдача в траву. */
guard = 0;
while (guard++ < 600 && !workers.some(function (v) { return v.state === 'carry' && v.path; })) {
  simulate(world, camp, list, workers, 0.5, log);
}
const beforeMove2 = workers.map(function (v) { return v.delivered || 0; });
clearArea(world, 22, 22, 35, 35);
for (let k = 1; k <= 6; k++) {
  moveCamp(world, camp, 25 + k, 25 + k);
  simulate(world, camp, list, workers, 3 * DT, log);
}
simulate(world, camp, list, workers, 1, log);
check('после ведения ни у кого не осталось места старого двора',
  staleSpots(camp, workers).length === 0,
  JSON.stringify(staleSpots(camp, workers)));
check('после ведения сдачи снова на текущем месте двора',
  log.badDeposits.length === 0,
  log.badDeposits.length ? JSON.stringify(log.badDeposits.slice(0, 4)) : 'сдач ' + log.deliveries);
simulate(world, camp, list, workers, 120, log);
check('после ведения каждый снова сдал хотя бы раз',
  workers.every(function (v, i) { return (v.delivered || 0) > beforeMove2[i]; }),
  workers.map(function (v) { return '№' + v.id + ' +' + ((v.delivered || 0) - beforeMove2[v.id - 1]); }).join(' · '));

/* Никто не стоял с брёвнами дольше пяти секунд. Это та самая «встал рядом с
   лагерем и не двигается»: причина — закрытый последний шаг и место, которое
   считалось своим после переезда. */
check('жители не телепортируются: ни одного скачка больше шага за кадр',
  log.teleports.length === 0,
  log.teleports.length ? JSON.stringify(log.teleports.slice(0, 4)) : 'скачков нет');

check('брёвна складывают ЛИЦОМ к лагерю',
  log.facingMax < 25,
  'хуже всех №' + log.facingWho + ': ' + log.facingMax.toFixed(1) + '° от направления на лагерь');

check('никто не стоит с брёвнами без пути дольше 5 секунд',
  log.stillMax <= 5,
  'дольше всех стоял №' + log.stillWho + ' (' + log.stillState + ') ' + log.stillMax.toFixed(2) + ' с');

/* Казна сходится с рубкой в любой момент: срубленное дерево либо уже сдано,
   либо ещё в пути. Расхождение — это «брёвна в никуда». */
const vill = world.village;
check('казна сходится с рубкой: logs + 4 x inTransit = 4 x felled',
  vill.logs + LOGS * (vill.inTransit || 0) === LOGS * (vill.felled || 0),
  'logs ' + vill.logs + ' + 4 x ' + (vill.inTransit || 0) + ' = ' +
  (vill.logs + LOGS * (vill.inTransit || 0)) + ', срублено ' + (vill.felled || 0) + ' x 4');

/* --- 6. Лагерь переехал прямо в жителя ------------------------------- *
 * Отдельный мир: ставим человека, затем накрываем его пятном лагеря. Он
 * обязан выйти ШАГОМ к ближайшей свободной клетке, а не замереть. */
function trapWorld(seed) {
  const W = 40, H = 40;
  const world = {
    width: W, height: H,
    isLand: new Uint8Array(W * H).fill(1),
    objects: [], seed: seed, stats: { trees: 0 },
    village: { logs: 0, deliveries: 0, felled: 0, inTransit: 0 },
    _buildRev: 0, _buildings: []
  };
  for (let y = 5; y < H - 5; y += 2) {
    for (let x = 5; x < W - 5; x += 2) {
      const d = Math.hypot(x + 0.5 - 20.5, y + 0.5 - 20.5);
      if (d < 6 || d > 16) continue;
      world.objects.push({ kind: 'tree', x: x + 0.5, y: y + 0.5, type: 'oak' });
    }
  }
  world.stats.trees = world.objects.length;
  const camp = campAt(15, 15);
  const list = [camp];
  world._buildings = list;
  return { world: world, list: list, camp: camp };
}
function cellInBuilding(camp, v) {
  return B.cells(camp).some(function (c) {
    return c.x === Math.floor(v.x) && c.y === Math.floor(v.y);
  });
}
function trapRun(world, list, camp, v, seconds) {
  const maxStep = V.SPEED * DT + 0.002;
  let jumps = 0, outAt = -1, stillMax = 0, still = 0;
  const steps = Math.round(seconds / DT);
  for (let s = 0; s < steps; s++) {
    const bx = v.x, by = v.y;
    V.update(v, world, null, DT, { buildings: list });
    if (Math.hypot(v.x - bx, v.y - by) > maxStep) jumps++;
    if (!cellInBuilding(camp, v) && outAt < 0) outAt = s * DT;
    const waiting = v.state === 'carry' || v.state === 'toCamp' || v.state === 'stand';
    if (waiting && Math.abs(v.x - bx) < 1e-9 && Math.abs(v.y - by) < 1e-9) {
      still += DT;
      if (still > stillMax) stillMax = still;
    } else {
      still = 0;
    }
  }
  return { jumps: jumps, outAt: outAt, stillMax: stillMax };
}
/* Рабочий: доходим до двора, затем накрываем его пятном. */
{
  const t = trapWorld('лагерь-на-рабочего');
  const v = V.create(t.world, { x: 23, y: 23, index: 0 });
  v.employer = t.camp; v.job = t.camp; v.state = 'toCamp';
  v.path = null; v.spot = null; v.spotTrip = false;
  t.camp.workers = [v]; t.world._villagers = [v];
  for (let i = 0; i < 60 * 30 && v.state !== 'take'; i++) {
    V.update(v, t.world, null, DT, { buildings: t.list });
  }
  const at = { x: Math.floor(v.x) - 1, y: Math.floor(v.y) - 1 };
  B.setSpot(t.world, t.camp, at);
  V.blockedMap(t.world, t.list);
  const r = trapRun(t.world, t.list, t.camp, v, 20);
  check('лагерь, переехавший прямо в рабочего, выводит его ШАГОМ из пятна',
    r.outAt >= 0 && r.jumps === 0,
    'вышел через ' + (r.outAt < 0 ? '—' : r.outAt.toFixed(2) + ' с') +
    ', скачков ' + r.jumps + ', дольше всего стоял ' + r.stillMax.toFixed(2) + ' с');
}
/* Гуляющий: ставим его в клетку, затем накрываем пятном. */
{
  const t = trapWorld('лагерь-на-гуляющего');
  const v = V.create(t.world, { x: 23, y: 23, index: 1 });
  v.state = 'wander'; v.path = null;
  t.world._villagers = [v];
  B.setSpot(t.world, t.camp, { x: 22, y: 22 });   // пятно 22..24 накрывает 23,23
  V.blockedMap(t.world, t.list);
  const r = trapRun(t.world, t.list, t.camp, v, 20);
  check('гуляющий из-под переехавшего лагеря тоже выходит ШАГОМ',
    r.outAt >= 0 && r.jumps === 0,
    'вышел через ' + (r.outAt < 0 ? '—' : r.outAt.toFixed(2) + ' с') +
    ', скачков ' + r.jumps + ', дольше всего стоял ' + r.stillMax.toFixed(2) + ' с');
}

/* --- 7. Переезд не отбирает топор у тех, кто в лесу ------------------ *
 * Рабочий в toTree/chop топор уже взял. Переезд лагеря не должен гнать его
 * назад к колоде: дерево и путь остаются, а место двора выбирается заново
 * только на обратной дороге. */
function moveCampClearOf(t, v) {
  const fp = B.footprint(t.camp.rot, t.camp.type);
  const wx = Math.floor(v.x), wy = Math.floor(v.y);
  const tx = v.tree ? Math.floor(v.tree.x) : -1, ty = v.tree ? Math.floor(v.tree.y) : -1;
  const offs = [[3, 3], [3, -3], [-3, 3], [-3, -3], [4, 0], [-4, 0], [0, 4], [0, -4]];
  for (const o of offs) {
    const x = t.camp.x + o[0], y = t.camp.y + o[1];
    if (x < 1 || y < 1 || x + fp.w >= t.world.width - 1 || y + fp.h >= t.world.height - 1) continue;
    const covers = function (cx, cy) {
      return cx >= x && cx < x + fp.w && cy >= y && cy < y + fp.h;
    };
    if (covers(wx, wy) || covers(tx, ty)) continue;
    B.setSpot(t.world, t.camp, { x: x, y: y });
    V.blockedMap(t.world, t.list);
    return true;
  }
  return false;
}
function axeTrip(want) {
  const t = trapWorld('топор-' + want);
  const v = V.create(t.world, { x: 23, y: 23, index: 0 });
  v.employer = t.camp; v.job = t.camp; v.state = 'toCamp';
  v.path = null; v.spot = null; v.spotTrip = false;
  t.camp.workers = [v]; t.world._villagers = [v];
  let takes = 0, prev = v.state, guard = 0;
  while (guard++ < 60 * 120 && !(v.state === want && v.tree)) {
    V.update(v, t.world, null, DT, { buildings: t.list });
    if (v.state === 'take' && prev !== 'take') takes++;
    prev = v.state;
  }
  if (v.state !== want || !v.tree) return { setup: false, why: 'state ' + v.state + ' tree ' + !!v.tree };
  const tree = v.tree;
  if (!moveCampClearOf(t, v)) return { setup: false, why: 'move: worker ' + Math.floor(v.x) + ',' + Math.floor(v.y) + ' tree ' + Math.floor(v.tree.x) + ',' + Math.floor(v.tree.y) + ' camp ' + t.camp.x + ',' + t.camp.y };
  let afterTake = 0, treeLost = false, saw = v.state, guard2 = 0;
  while (guard2++ < 60 * 12) {
    const ps = v.state;
    V.update(v, t.world, null, DT, { buildings: t.list });
    if (v.state === 'take' && ps !== 'take') afterTake++;
    if ((v.state === 'chop' || v.state === 'toTree') && v.tree !== tree) treeLost = true;
    saw = v.state;
    if (v.state === 'carry' || v.state === 'drop' || v.state === 'toCamp') break;
  }
  return { setup: true, takes: takes, afterTake: afterTake, treeLost: treeLost, state: saw };
}
{
  const r = axeTrip('toTree');
  check('переезд лагеря не отбирает топор у идущего к дереву',
    r.setup && r.afterTake === 0 && !r.treeLost &&
    (r.state === 'toTree' || r.state === 'chop' || r.state === 'carry' || r.state === 'drop'),
    r.setup ? 'после переезда: state ' + r.state + ', заходов за топором ' + r.afterTake +
      ', дерево потеряно: ' + r.treeLost : 'не удалось поставить сцену: ' + (r.why || ''));
}
{
  const r = axeTrip('chop');
  check('переезд лагеря не отбирает топор у рубящего',
    r.setup && r.afterTake === 0 && !r.treeLost && r.state === 'carry',
    r.setup ? 'доработал до ' + r.state + ', заходов за топором ' + r.afterTake +
      ', дерево потеряно: ' + r.treeLost : 'не удалось поставить сцену: ' + (r.why || ''));
}

check('за прогон никто не уволен и все трое работают',
  workers.every(function (v) { return v.employer === camp; }) &&
  workers.every(function (v) { return (v.delivered || 0) > LOGS; }),
  'сдано ' + vill.deliveries + ' ходок, ' + vill.logs + ' брёвен');

console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nИТОГ: ПРИНЯТО');
process.exit(fails ? 1 : 0);
