/* path-defer.js — приёмка PATH-01: временный отказ планировщика.

   Жалоба: «часть жителей останавливается; найм, обучение и приказы перестают
   нормально работать». Воспроизведение ТЗ §5: на 64x64 всё суша, воин
   (10.5,10.5), приказ (30.5,30.5), старый путь очищен; каждый шаг 0.05 с —
   beginFrame, затем `world._pathFrame.left = 0` (бюджет съели ранние
   запросы), затем update. На исходном коммите через 1.35 с приказ снимался
   (order=null, state=stand, _pathStop='frame'), хотя цель достижима.

   Здесь проверяется: явный результат поиска, сохранение приказа/работы/
   обучения/груза при deferred, очередь справедливости на 100/200 существах,
   освобождение слота ученика и те же правила для входа в казарму, рабочего
   места и точки атаки.

   Запуск: node mapgen2/tools/path-defer.js */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');

globalThis.window = globalThis;
for (const f of ['noise.js', 'rng.js', 'metrics.js', 'worldgen.js', 'buildings.js',
  'hero.js', 'villager.js', 'session.js', 'events.js', 'combat.js', 'army.js']) {
  new Function(fs.readFileSync(path.join(JS, f), 'utf8') + '\n//# sourceURL=' + f)();
}

const B = globalThis.Buildings, C = globalThis.Combat, S = globalThis.Session;
const V = globalThis.Villagers, WG = globalThis.WorldGen, M = globalThis.Metrics;
const DT = 0.05;
globalThis.Metrics.on = true;         // счётчики — часть приёмки, а не фон

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

let fails = 0;
function check(ok, text) {
  console.log((ok ? '  ok   ' : '  FAIL ') + text);
  if (!ok) fails++;
}

function worldOf(w, h) {
  const N = w * h;
  return {
    width: w, height: h, time: 0, seed: 'path-defer',
    isLand: new Uint8Array(N).fill(1),
    tile: new Uint8Array(N).fill(WG.T.GRASS),
    objects: [], towns: [{ alive: true }, { alive: true }, { alive: true }, { alive: true }],
    _buildings: [], _villagers: []
  };
}

/* Один шаг «бюджет съеден ранними запросами»: beginFrame, затем left=0. */
function deferredStep(world, v, buildings) {
  V.beginFrame(world);
  world._pathFrame.left = 0;
  V.update(v, world, SET, DT, { buildings: buildings || [] });
}

function normalStep(world, v, buildings) {
  V.update(v, world, SET, DT, { buildings: buildings || [] });
}

/* Шаг с настоящим бюджетом, но с явно заданным остатком: так имитируется
   «дорогой ранний запрос», не выдумывая нагрузку. */
function budgetStep(world, v, left, buildings) {
  V.beginFrame(world);
  world._pathFrame.left = Math.max(0, left);
  V.update(v, world, SET, DT, { buildings: buildings || [] });
  return world._pathStop;
}

/* ================== 1. Точный сценарий ТЗ §5 ================== */
console.log('\n== 1. Точный сценарий: приказ не снимается при deferred ==');
{
  const world = worldOf(64, 64);
  const v = V.blank(world, { id: 1, x: 10.5, y: 10.5, owner: 0, town: 0 });
  v.warrior = true;
  v.state = 'march';
  v.path = null;
  v.order = { x: 30.5, y: 30.5 };
  let firstStop = '';
  for (let t = 0; t < 1.35; t += DT) {
    V.beginFrame(world);
    world._pathFrame.left = 0;
    V.update(v, world, SET, DT, { buildings: [] });
    if (!firstStop && world._pathStop) firstStop = world._pathStop;
  }
  check(v.order && v.order.x === 30.5, 'через 1.35 с приказ жив (order не null)');
  check(v.state !== 'stand', 'состояние не «stand» (раньше снималось в stand): ' + v.state);
  check(firstStop === 'deferred', 'результат поиска явный: ' + firstStop);
  check(v.pathQueuedAt !== undefined, 'житель стоит в очереди справедливости');
  check(M.counters.pathDeferred > 0, 'счётчик отложенных поисков растёт: ' +
    M.counters.pathDeferred);
  /* Бюджет вернулся — тот же приказ сразу достижим. */
  V.beginFrame(world);                 // свежий кадр, а не остаток прошлого
  const ok = V.routeTo(v, world, V.blockedMap(world, []), 30.5, 30.5,
    { state: 'march', anim: 'walk' });
  check(ok && !!v.path, 'со свежим бюджетом routeTo к той же точке = true');
  check(world._pathStop === '', 'результат успешного поиска пустой: "' +
    world._pathStop + '"');
}

/* ================== 2. Явные виды отказа ================== */
console.log('\n== 2. Результаты поиска различимы ==');
{
  const world = worldOf(32, 32);
  /* Вода сплошной полосой: цель за водой недостижима. */
  for (let y = 0; y < 32; y++) world.isLand[y * 32 + 16] = 0;
  const v = V.blank(world, { id: 1, x: 5.5, y: 5.5, owner: 0, town: 0 });
  const solid = V.blockedMap(world, []);
  const bad = V.routeTo(v, world, solid, 25.5, 5.5, {});
  check(!bad && world._pathStop === 'unreachable',
    'цель за водой: unreachable, а не отказ вообще');
  const water = V.routeTo(v, world, solid, 16.5, 5.5, {});
  check(!water && world._pathStop === 'invalid', 'цель в воде: invalid');
  const ok = V.routeTo(v, world, solid, 5.5 + 1, 5.5, {});
  check(ok && world._pathStop === '', 'соседняя клетка: found ("")');
}

/* ================== 3. Работа и груз при deferred ================== */
console.log('\n== 3. Работа, дерево и груз не теряются ==');
{
  const world = worldOf(64, 64);
  const camp = B.make({ type: 'lumbercamp', variant: 'a', rot: 0, x: 10, y: 10, owner: 0 });
  const buildings = [camp];
  const tree = { kind: 'tree', variant: 'oak', x: 20, y: 20, w: 1, h: 1 };
  world.objects.push(tree);
  /* Двор лагеря — в пятне, поэтому рабочий стоит СНАРУЖИ его: иначе первый
     же кадр честно выводит его шагом из стены и снимает топор. */
  const v = V.blank(world, { id: 2, x: 16.5, y: 16.5, owner: 0, town: 0 });
  v.employer = camp;
  v.job = 'lumber';
  v.tree = tree;
  v.state = 'toTree';
  v.path = null;
  V.mark(v, tree);
  for (let t = 0; t < 5; t += DT) deferredStep(world, v, buildings);
  check(v.employer === camp, 'работодатель сохранён');
  check(v.tree === tree, 'выбранное дерево сохранено');
  check(!tree._noPath, 'кеш «дерево недостижимо» НЕ записан');
  check(v.state !== 'toCamp', 'в лагерь за новым деревом не ушёл: ' + v.state);
  /* Груз: носильщик с брёвнами при deferred не теряет ходку. */
  const carrier = V.blank(world, { id: 3, x: 17.5, y: 14.5, owner: 0, town: 0 });
  carrier.employer = camp;
  carrier.job = 'lumber';
  carrier.carrying = true;
  carrier.state = 'carry';
  carrier.path = null;
  for (let t = 0; t < 3; t += DT) deferredStep(world, carrier, buildings);
  check(carrier.carrying === true && carrier.employer === camp,
    'груз (carrying) сохранён при deferred');
}

/* ================== 4. Ученик и слот тренировки ================== */
console.log('\n== 4. Ученик не запирает слот молча ==');
{
  const world = worldOf(64, 64);
  /* Казарма за полосой воды: путь к ней НЕДОСТИЖИМ (это не отсрочка), и слот
     обязан освободиться сам, словами. */
  for (let y = 0; y < 64; y++) world.isLand[y * 64 + 35] = 0;
  const barracks = B.make({ type: 'barracks', variant: 'a', rot: 0, x: 45, y: 20, owner: 0 });
  const warcamp = B.make({ type: 'warcamp', variant: 'x', rot: 0, x: 20, y: 30, owner: 0 });
  const buildings = [barracks, warcamp];
  const v = V.blank(world, { id: 4, x: 10.5, y: 10.5, owner: 0, town: 0 });
  const list = [v];
  const tr = S.train(barracks, v, list, buildings);
  check(tr.ok && v.trainee, 'житель отправлен учиться: ' + tr.reason);
  const slotsBefore = S.traineesOf(barracks, list).length;
  /* 10 секунд отсрочки: обучение и слот на месте. */
  for (let t = 0; t < 10; t += DT) deferredStep(world, v, buildings);
  check(v.trainee && S.traineesOf(barracks, list).length === slotsBefore,
    '10 с deferred: обучение и место сохранены');
  /* 25 секунд: ожидание исчерпано, слот освобождён и это видно событием. */
  for (let t = 0; t < 25; t += DT) deferredStep(world, v, buildings);
  check(!v.trainee, 'после 20 с ожидания обучение отменено');
  check(S.traineesOf(barracks, list).length === 0, 'слот тренировки освобождён');
  const ev = (world.events || []).filter(e => e.kind === 'training-failed');
  check(ev.length === 1 && /казарм/.test(ev[0].text),
    'отмена объяснена событием: ' + (ev[0] && ev[0].text));
}

/* ================== 5. Справедливая очередь 100/200 ================== */
console.log('\n== 5. Очередь справедливости: 100 и 200 существ ==');
function fairness(n, budgetForFirst) {
  const world = worldOf(64, 64);
  const list = [];
  for (let i = 0; i < n; i++) {
    const x = 2.5 + (i % 50) * 0.6, y = 2.5 + Math.floor(i / 50) * 0.6;
    const v = V.blank(world, { id: i + 1, x: x, y: y, owner: i % 4, town: i % 4 });
    v.warrior = true;
    v.state = 'march';
    v.path = null;
    v.order = { x: 60.5, y: 55.5 };
    list.push(v);
  }
  const frames = 400;
  for (let f = 0; f < frames; f++) {
    V.beginFrame(world);
    for (let i = 0; i < n; i++) {
      const v = list[i];
      /* Дорогие ранние запросы: бюджет кадра съеден первыми. */
      if (i >= budgetForFirst) world._pathFrame.left = 0;
      V.update(v, world, SET, DT, { buildings: [] });
      /* Путь срублен каждый кадр (дерево упало на дорогу): житель ищет снова.
         Без этого удачливые уходили бы из очереди, и голодания не было бы. */
      v.path = null;
    }
  }
  const wait = list.map(v => v.pathDeferCount ? (v.pathWaitMax || 0) : 0);
  const finite = wait.slice().sort((a, b) => a - b);
  const p95 = finite[Math.floor(finite.length * 0.95)];
  let maxWait = 0, maxI = -1;
  wait.forEach((w, i) => { if (w > maxWait) { maxWait = w; maxI = i; } });
  const byOwner = [0, 1, 2, 3].map(o => {
    const own = wait.filter((w, i) => i % 4 === o).sort((a, b) => a - b);
    return { owner: o, n: own.length,
      max: own.length ? own[own.length - 1] : null,
      p95: own.length ? own[Math.floor(own.length * 0.95)] : null };
  });
  const quart = [0, 1, 2, 3].map(q => {
    const a = Math.floor(q * n / 4), b = Math.floor((q + 1) * n / 4);
    const own = wait.slice(a, b);
    return { from: a, to: b - 1, max: own.length ? Math.max.apply(null, own) : null };
  });
  const deferredUnits = list.filter(v => v.pathDeferCount > 0).length;
  return { n, p95, maxWait, maxI, byOwner, quart, deferredUnits,
    deferred: M.counters.pathDeferred, fair: M.counters.pathFairServed };
}
for (const n of [100, 200]) {
  M.reset();
  const r = fairness(n, 1);
  console.log('  ' + n + ' существ: p95 ожидания ' + r.p95 + ' кадров, худшее ' +
    r.maxWait + ' (индекс ' + r.maxI + '), отложено у ' + r.deferredUnits +
    ' существ, deferred ' + r.deferred + ', по очереди обслужено ' + r.fair);
  console.log('    по владельцам: ' + r.byOwner.map(o =>
    '#' + o.owner + ' p95=' + o.p95 + '/max=' + o.max).join(', '));
  console.log('    по позициям: ' + r.quart.map(q =>
    '[' + q.from + '..' + q.to + '] max=' + q.max).join(', '));
  /* Пропускная способность честная: кадр даёт 2 гарантированных поиска,
     поэтому при n ожидающих худшее ожидание — около n/2 кадров (5 с мира на
     200 существах при 20 шагах/с). Это НЕ голодание: каждый получает поиск,
     очередь движется по кругу. Порог — throughput, а не «побыстрее». */
  const bound = Math.ceil(n / 2) + 8;
  check(r.p95 <= bound,
    n + ' существ: p95 ожидания ' + r.p95 + ' кадров (<= ' + bound + ')');
  check(r.maxWait <= bound,
    n + ' существ: худшее ожидание ' + r.maxWait + ' кадров (<= ' + bound + ')');
  check(r.quart.every(q => q.max !== null && q.max <= bound),
    'поздние позиции массива получают обслуживание');
  check(r.fair > 0 && r.deferredUnits > 0,
    'очередь справедливости выдавала поиски: ' + r.fair +
    ' (отложено у ' + r.deferredUnits + ')');
}

/* ================== 6. Точка атаки: цель не бросается при deferred ================== */
console.log('\n== 6. Точка атаки при deferred ==');
{
  const world = worldOf(64, 64);
  const a = V.blank(world, { id: 1, x: 10.5, y: 10.5, owner: 0, town: 0 });
  a.warrior = true;
  const b = V.blank(world, { id: 2, x: 15.5, y: 10.5, owner: 1, town: 1 });
  b.warrior = true;
  a.target = b;
  a.combatMode = 'chase';
  a.state = 'toBattle';
  C.init(world, [], [a, b]);
  for (let t = 0; t < 6; t += DT) {
    C.tick(world, DT, { buildings: [], villagers: [a, b] });
    deferredStep(world, a, []);
    deferredStep(world, b, []);
  }
  check(a.target === b, 'цель боя не брошена за 6 с отсрочки');
  check(!a.noPathKey, 'кеш недостижимой цели не записан');
  check(a.combatMode === 'chase' || a.combatMode === 'attack',
    'режим боя сохранён: ' + a.combatMode);
}

/* ================== итог ================== */
console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nОТСРОЧКА ПУТИ ПРИНЯТА');
process.exit(fails ? 1 : 0);
