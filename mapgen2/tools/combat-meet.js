/* combat-meet.js — приёмка BATTLE-01: встречные армии, самозащита, поводки.

   Почему отдельный инструмент. `combat.js` проверяет правила удара и числа,
   но НЕ проверял главную жалобу заказчика: две армии идут навстречу, одна
   бьёт, вторая проходит мимо и погибает без ответного урона. Причина была в
   том, что якорем обнаружения служила КОНЕЧНАЯ точка приказа (`v.order`) с
   радиусом ORDER_LEASH: у встречных армий концы разные, и «враг рядом» у
   одной не означало «враг рядом» у другой.

   Здесь — точный сценарий из ТЗ §4 и вся его матрица: 96x96, 5x5, 20x20,
   дальние назначения, смена id/владельца, обратный массив, зеркальная карта,
   «Стоп», бой у лагеря, продолжение марша, бой под нагрузкой путей и время
   реакции на реальный удар.

   Запуск: node mapgen2/tools/combat-meet.js */
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
const V = globalThis.Villagers, WG = globalThis.WorldGen;
const DT = 1 / 20;                       // шаг задачи — 0.05 с из ТЗ
const CFG = C.CONFIG;

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
const renderer = {
  world: null, villagerSprites: SET,
  setBuildings() {}, setVillagers() {}, fitIsland() {}
};

let fails = 0;
function check(ok, text) {
  console.log((ok ? '  ok   ' : '  FAIL ') + text);
  if (!ok) fails++;
}

function worldOf(w, h, opts) {
  opts = opts || {};
  const N = w * h;
  const isLand = new Uint8Array(N).fill(opts.water === false ? 1 : 1);
  if (opts.waterX !== undefined) {
    for (let y = 0; y < h; y++) isLand[y * w + opts.waterX] = 0;
  }
  return {
    width: w, height: h, time: 0, isLand,
    tile: new Uint8Array(N).fill(WG.T.GRASS),
    objects: [], towns: [{ alive: true }, { alive: true }],
    _buildings: [], _villagers: []
  };
}

let seq = 0;
function warrior(world, o) {
  const v = V.blank(world, {
    id: o.id === undefined ? 1000 + (seq++) : o.id,
    x: o.x, y: o.y,
    owner: o.owner === undefined ? 0 : o.owner,
    town: o.town === undefined ? (o.owner === undefined ? 0 : o.owner) : o.town
  });
  v.warrior = true;
  v.state = 'march';
  v.path = null;
  v.order = o.order ? { x: o.order[0], y: o.order[1] } : null;
  v.warcamp = o.camp || null;
  return v;
}

function stepFrame(world, villagers, buildings, opts) {
  opts = opts || {};
  C.tick(world, DT, { buildings: buildings, villagers: villagers });
  S.stepVillagers(villagers, world, renderer, DT, buildings || []);
  if (opts.budgetZero) world._pathFrame.left = 0;   // имитация чужого расхода
}

function run(world, villagers, buildings, seconds, opts) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) stepFrame(world, villagers, buildings, opts);
}

function damageTaken(unit) {
  return (unit.maxHp || CFG.hp.warrior) - (unit.hp === undefined ? 0 : unit.hp);
}

/* Сцена встречи: две армии идут навстречу друг другу. Возвращает всё, что
   нужно проверкам: урон, цели, состояния, приказы. */
function meet(opts) {
  opts = opts || {};
  const size = opts.size || 96;
  const w = worldOf(size, size);
  /* Точные числа ТЗ §4: A (20.5,20.5) → (30.5,20.5), B (26.5,20.5) → (5.5,20.5). */
  const aOrder = opts.aOrder || [30.5, 20.5];
  const bOrder = opts.bOrder || [5.5, 20.5];
  const aPos = opts.aPos || [20.5, 20.5];
  const bPos = opts.bPos || [26.5, 20.5];
  const a = warrior(w, {
    id: opts.aId === undefined ? 1 : opts.aId,
    owner: opts.aOwner === undefined ? 0 : opts.aOwner,
    x: aPos[0], y: aPos[1], order: aOrder });
  const b = warrior(w, {
    id: opts.bId === undefined ? 1001 : opts.bId,
    owner: opts.bOwner === undefined ? 1 : opts.bOwner,
    x: bPos[0], y: bPos[1], order: bOrder });
  const list = opts.reverse ? [b, a] : [a, b];
  if (opts.prepare) opts.prepare(w, list);
  run(w, list, [], opts.seconds || 8, { budgetZero: opts.budgetZero });
  return { world: w, a: a, b: b, list: list };
}

/* ================== 1. Точный сценарий ТЗ §4 ================== */
console.log('\n== 1. Встречные армии, точный сценарий (96x96) ==');
{
  const r = meet({});
  check(r.a.hp < CFG.hp.warrior || r.a.dead,
    'A получает урон (hp ' + r.a.hp + ')');
  check(r.b.hp < CFG.hp.warrior || r.b.dead,
    'B получает урон и ОТВЕЧАЕТ (hp ' + r.b.hp + ')');
  check(r.a.target === r.b || r.a.dead, 'A держал целью B');
  check(r.b.target === r.a || r.b.dead, 'B держал целью A (раньше шёл мимо)');
  check(r.a.order && r.b.order, 'приказы обеих армий сохранились');
  check(r.a.hp === r.b.hp && r.a.dead === r.b.dead,
    'исход симметричен: A ' + r.a.hp + '/B ' + r.b.hp +
    ', мертвы ' + r.a.dead + '/' + r.b.dead);
}
{
  /* Обратный массив: та же сцена, но B обновляется первым. */
  const r = meet({ reverse: true });
  check(r.a.hp === r.b.hp && r.a.dead === r.b.dead,
    'обратный массив даёт тот же исход (A ' + r.a.hp + '/B ' + r.b.hp + ')');
  check(r.b.hp < CFG.hp.warrior || r.b.dead, 'B (первый в массиве) тоже получает урон');
}

/* ================== 2. Смена id, владельца и зеркало ================== */
console.log('\n== 2. Смена id/владельца, зеркальная карта ==');
{
  const r = meet({ aId: 1001, bId: 1, aOwner: 1, bOwner: 0 });
  check(r.a.hp < CFG.hp.warrior && r.b.hp < CFG.hp.warrior,
    'смена id/владельца: оба получают урон (A ' + r.a.hp + '/B ' + r.b.hp + ')');
}
{
  /* Зеркало по X: армии идут в обратную сторону. Те же встречные позиции,
     но приказы смотрят в противоположные края. */
  const r = meet({ aOrder: [10.5, 20.5], bOrder: [45.5, 20.5] });
  check(r.a.hp < CFG.hp.warrior && r.b.hp < CFG.hp.warrior,
    'зеркальная карта: оба получают урон (A ' + r.a.hp + '/B ' + r.b.hp + ')');
}

/* ================== 3. Малые карты 5x5 и 20x20 ================== */
console.log('\n== 3. Карты 5x5 и 20x20 ==');
{
  const r = meet({ size: 5, aPos: [1.5, 2.5], bPos: [3.5, 2.5],
    aOrder: [4.5, 2.5], bOrder: [0.5, 2.5], seconds: 6 });
  check(r.a.hp < CFG.hp.warrior && r.b.hp < CFG.hp.warrior,
    '5x5: обе армии бьются (A ' + r.a.hp + '/B ' + r.b.hp + ')');
}
{
  const r = meet({ size: 20, aPos: [8.5, 10.5], bPos: [11.5, 10.5],
    aOrder: [19.5, 10.5], bOrder: [0.5, 10.5], seconds: 6 });
  check(r.a.hp < CFG.hp.warrior && r.b.hp < CFG.hp.warrior,
    '20x20: обе армии бьются (A ' + r.a.hp + '/B ' + r.b.hp + ')');
}

/* ================== 4. Дальние встречные назначения ================== */
console.log('\n== 4. Дальние назначения через весь остров ==');
{
  const r = meet({ aOrder: [90.5, 20.5], bOrder: [0.5, 20.5], seconds: 10 });
  check(r.a.hp < CFG.hp.warrior && r.b.hp < CFG.hp.warrior,
    'концы приказов далеко: стычка по пути состоялась (A ' + r.a.hp + '/B ' + r.b.hp + ')');
  check(r.a.order && r.b.order, 'дальние приказы не сняты');
}

/* ================== 5. Продолжение марша после боя ================== */
console.log('\n== 5. После боя — к приказу ==');
{
  const r = meet({ seconds: 30 });
  const killed = r.b.dead && !r.a.dead;
  if (killed) {
    const dx = r.a.x - r.a.order.x, dy = r.a.y - r.a.order.y;
    check(Math.hypot(dx, dy) < 1.6,
      'победитель дошёл до конечной точки приказа (осталось ' +
      Math.hypot(dx, dy).toFixed(2) + ' кл.)');
    check(r.a.order && r.a.order.done !== false, 'приказ помечен выполненным');
  } else {
    /* На равных оба погибают — тогда марш продолжать некому. Проверяем
       отдельную сцену: марш без врага доходит до точки. */
    const w = worldOf(64, 64);
    const solo = warrior(w, { id: 7, x: 10.5, y: 10.5, order: [20.5, 20.5] });
    run(w, [solo], [], 40);
    check(Math.hypot(solo.x - 20.5, solo.y - 20.5) < 0.6,
      'одиночный марш дошёл до точки (' + solo.x.toFixed(1) + ',' + solo.y.toFixed(1) + ')');
  }
}
{
  /* Живой победитель: у B меньше HP, чтобы A точно выжил. */
  const w = worldOf(64, 64);
  const a = warrior(w, { id: 1, x: 20.5, y: 20.5, order: [40.5, 20.5] });
  const b = warrior(w, { id: 2, owner: 1, x: 24.5, y: 20.5, order: [0.5, 20.5] });
  b.hp = 7;
  C.init(w, [], [a, b]);
  run(w, [a, b], [], 60);
  check(b.dead && !a.dead, 'слабый враг убит, победитель жив');
  check(Math.hypot(a.x - 40.5, a.y - 20.5) < 0.6,
    'после боя воин вернулся к приказу (осталось ' +
    Math.hypot(a.x - 40.5, a.y - 20.5).toFixed(2) + ' кл.)');
}

/* ================== 6. «Стоп» и явный контракт самозащиты ================== */
console.log('\n== 6. «Стоп» (holdFire) — ответ на удар разрешён ==');
{
  const w = worldOf(64, 64);
  const a = warrior(w, { id: 1, x: 20.5, y: 20.5, order: [40.5, 20.5] });
  const b = warrior(w, { id: 2, owner: 1, x: 22.5, y: 20.5, order: [0.5, 20.5] });
  a.holdFire = true;
  a.target = null;
  C.init(w, [], [a, b]);
  run(w, [a, b], [], 4);
  check(a.target === b || (a.attacker === b && a.hp < CFG.hp.warrior),
    'со «Стопом» воин не берёт цель сам, но отвечает ударившему');
  check(b.hp < CFG.hp.warrior,
    'удар в ответ нанесён (hp B ' + b.hp + ')');
  check(a.holdFire === true, 'holdFire не снят сам собой');
}
{
  /* Без удара «Стоп» не даёт напасть первым: враг рядом, но не бьёт. */
  const w = worldOf(64, 64);
  const a = warrior(w, { id: 1, x: 20.5, y: 20.5 });
  const b = warrior(w, { id: 3, owner: 1, x: 22.5, y: 20.5 });
  a.holdFire = true;
  b.holdFire = true;      /* враг тоже не нападает: проверяем только «первым» */
  C.init(w, [], [a, b]);
  run(w, [a, b], [], 3);
  check(a.target === null && b.hp === CFG.hp.warrior,
    'со «Стопом» и без удара воин не нападает первым');
}

/* ================== 7. Бой у лагеря и поводок охраны ================== */
console.log('\n== 7. Лагерь: бой рядом и запрет погони через остров ==');
{
  const w = worldOf(96, 96);
  const camp = B.make({ type: 'warcamp', variant: 'x', rot: 0, x: 20, y: 20, owner: 0 });
  const list = [camp];
  const guard = warrior(w, { id: 1, x: 22.5, y: 20.5, camp: camp });
  const foe = warrior(w, { id: 2, owner: 1, x: 26.5, y: 20.5, order: [50.5, 20.5] });
  C.init(w, list, [guard, foe]);
  run(w, [guard, foe], list, 4);
  check(guard.hp < CFG.hp.warrior && foe.hp < CFG.hp.warrior,
    'бой у лагеря: обе стороны бьются');
}
{
  const w = worldOf(96, 96);
  const camp = B.make({ type: 'warcamp', variant: 'x', rot: 0, x: 20, y: 20, owner: 0 });
  const list = [camp];
  const guard = warrior(w, { id: 1, x: 22.5, y: 20.5, camp: camp });
  const farD = CFG.leash.camp * 3;
  const foe = warrior(w, { id: 2, owner: 1, x: 22.5 + farD, y: 20.5 });
  C.init(w, list, [guard, foe]);
  run(w, [guard, foe], list, 3);
  check(guard.target === null,
    'цель в ' + farD + ' клетках от лагеря не уводит охрану через остров');
}

/* ================== 8. Бой под нагрузкой путей ================== */
console.log('\n== 8. Бой при нулевом бюджете A* (PATH-01) ==');
{
  /* Каждый кадр после шага бюджет кадра обнулён: поиск пути всегда отложен.
     Стычка обязана состояться (цель уже выбрана локально), а приказ — не
     сняться. */
  const r = meet({ seconds: 8, budgetZero: true });
  check(r.a.hp < CFG.hp.warrior && r.b.hp < CFG.hp.warrior,
    'при deferred-бюджете армии всё равно бьются (A ' + r.a.hp + '/B ' + r.b.hp + ')');
  check(r.a.order && r.b.order, 'приказы при deferred-бюджете сохранились');
}

/* ================== 9. Реакция на реальный удар ================== */
console.log('\n== 9. Время реакции защитника ==');
{
  const w = worldOf(64, 64);
  const a = warrior(w, { id: 1, x: 20.5, y: 20.5, order: [50.5, 20.5] });
  const b = warrior(w, { id: 2, owner: 1, x: 21.5, y: 20.5, order: [0.5, 20.5] });
  /* b не ищет цели: ждёт удара. */
  b.thinkT = 999;
  C.init(w, [], [a, b]);
  let hitAt = null, reactAt = null;
  for (let i = 0; i < 80; i++) {
    C.tick(w, DT, { buildings: [], villagers: [a, b] });
    S.stepVillagers([a, b], w, renderer, DT, []);
    if (hitAt === null && b.attacker) hitAt = w.time;
    if (hitAt !== null && reactAt === null && b.target === a && b.combatMode) {
      reactAt = w.time;
    }
    if (hitAt !== null && reactAt !== null) break;
  }
  const allow = CFG.reaction + 2 * DT;
  check(hitAt !== null, 'удар по защитнику состоялся');
  check(reactAt !== null && reactAt - hitAt <= allow,
    'реакция за ' + (reactAt === null ? '∞' : (reactAt - hitAt).toFixed(2)) +
    ' с при допуске think+2 шага = ' + allow.toFixed(2) + ' с');

  /* Явная проверка несправедливости порядка: при пакетном разрешении
     погибающий в этом кадре успевает ударить. */
  const w2 = worldOf(32, 32);
  const x1 = warrior(w2, { id: 1, x: 10.5, y: 10.5 });
  const x2 = warrior(w2, { id: 2, owner: 1, x: 11.5, y: 10.5 });
  x1.hp = x2.hp = CFG.damage.unit;     // обоих добивает один удар
  x1.target = x2; x1.combatMode = 'attack'; x1.attackT = 0; x1.attackTarget = x2;
  x2.target = x1; x2.combatMode = 'attack'; x2.attackT = 0; x2.attackTarget = x1;
  C.init(w2, [], [x1, x2]);
  C.tick(w2, DT, { buildings: [], villagers: [x1, x2] });
  check(x1.dead && x2.dead,
    'пакетный удар: оба с одним HP гибнут вместе (порядок не даёт преимущества)');
}

/* ================== 10. Ограниченный след боя (OBS-01) ================== */
console.log('\n== 10. След боя для выбранных юнитов ==');
{
  const w = worldOf(64, 64);
  const a = warrior(w, { id: 1, x: 20.5, y: 20.5, order: [40.5, 20.5] });
  const b = warrior(w, { id: 2, owner: 1, x: 23.5, y: 20.5, order: [0.5, 20.5] });
  C.traceEnable([1]);
  run(w, [a, b], [], 4);
  const dump = C.traceDump();
  check(dump.on === true && dump.ids.join() === '1', 'след включён только для id 1');
  check(dump.items.length > 0 && dump.items.length <= dump.max,
    'записей ' + dump.items.length + ' (не больше ' + dump.max + ')');
  check(dump.items.every(x => x.kind === 'hit' || x.id === 1),
    'в следе только выбранный юнит и его удары');
  const hit = dump.items.filter(x => x.kind === 'hit');
  check(hit.length > 0 && hit[0].dmg > 0 && hit[0].to !== undefined,
    'урон записан: ' + (hit[0] ? hit[0].dmg + ' по ' + hit[0].to : 'нет'));
  const unit = dump.items.filter(x => x.kind === 'unit');
  check(unit.length > 0 && unit[0].anchor && unit[0].why !== undefined,
    'у юнита есть якорь стычки и причина цели: ' + JSON.stringify(unit[0] && {
      anchor: unit[0].anchor, why: unit[0].why, target: unit[0].target }));
  C.traceDisable();
  check(C.traceDump().on === false, 'след выключается и не стоит ничего');
}

/* ================== итог ================== */
console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nВСТРЕЧНЫЙ БОЙ ПРИНЯТ');
process.exit(fails ? 1 : 0);
