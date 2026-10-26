/* pending.js (приёмка) — ожидающие действия гостя (UX-01), без браузера.

   Проверяет ровно то, из-за чего дом у гостя исчезал: ожидание стоит сразу,
   не входит в мир, согласуется с результатом/снимком в любом порядке, старый
   снимок его не стирает, отказ освобождает резерв, таймаут не считается
   отказом, снесённая до снимка постройка завершает ожидание по версии.

   Запуск: node game/tools/pending.js */
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..');
const JS = path.join(REPO, 'mapgen2', 'js');

globalThis.window = globalThis;
for (const f of ['noise.js', 'rng.js', 'metrics.js', 'worldgen.js', 'buildings.js',
  'hero.js', 'villager.js', 'session.js', 'events.js', 'combat.js', 'army.js']) {
  new Function(fs.readFileSync(path.join(JS, f), 'utf8') + '\n//# sourceURL=' + f)();
}
new Function(fs.readFileSync(path.join(REPO, 'game', 'js', 'pending.js'), 'utf8') +
  '\n//# sourceURL=pending.js')();

const B = globalThis.Buildings, P = globalThis.Pending, WG = globalThis.WorldGen;
let fails = 0;
function check(ok, text) {
  console.log((ok ? '  ok   ' : '  FAIL ') + text);
  if (!ok) fails++;
}
function worldOf(n) {
  const N = n * n;
  return { width: n, height: n, seed: 'pending', tile: new Uint8Array(N).fill(WG.T.GRASS),
    isLand: new Uint8Array(N).fill(1), objects: [], towns: [{ alive: true }, { alive: true }],
    _buildings: [], _villagers: [] };
}
let idSeq = 0;
function made(type, x, y, owner, rot) {
  return B.make({ type: type, variant: type === 'warcamp' ? 'x' : 'a',
    rot: rot || 0, x: x, y: y, owner: owner, town: owner,
    id: 'p1:b' + (++idSeq) });
}
/* Снимок: настоящие постройки мира. seq ставится вручную — модуль его читает. */
function snap(seq, list) {
  return { seq: seq, buildings: list, t: 0 };
}

const world = worldOf(64);

/* ================== 1. Ожидание сразу, мира не касается ================== */
console.log('\n== 1. Ожидание стоит сразу и не входит в мир ==');
P.reset(1);
const spec = { type: 'house', variant: 'a', rot: 0, x: 10, y: 10 };
const act = P.addBuild({ commandId: 7, n: 7, owner: 1, spec: spec, cost: 12, sentSeq: 0 });
check(P.buildings().length === 1, 'ожидающая постройка отображается');
check(P.buildings()[0].pending === true, 'у неё признак pending');
check(P.buildings()[0].x === 10 && P.buildings()[0].y === 10, 'она в той же точке');
check(world._buildings.length === 0, 'в мир (world._buildings) не попала');
check(P.reserved(1) === 12, 'резерв казны 12 брёвен');
check(P.reserved(0) === 0, 'чужая деревня резерва не платит');

/* ================== 2. Снимок раньше результата ================== */
console.log('\n== 2. Снимок раньше applied: показываем и снимаем ожидание ==');
const real = made('house', 10, 10, 1);
P.reconcile(snap(1, []));                    // прошлый состав без дома
check(P.buildings().length === 1, 'старый состав ожидание не стёр');
const settled = P.reconcile(snap(2, [real])); // дом появился
check(settled === 1, 'снимок согласовал ожидание');
check(P.buildings().length === 0, 'ожидание заменено настоящей постройкой');
check(P.reserved(1) === 0, 'резерв освобождён один раз');
P.result(7, { state: 'applied', ids: [real.id], appliedSeq: 2 });
check(P.buildings().length === 0, 'поздний applied не создаёт двойника');

/* ================== 3. Результат раньше снимка ================== */
console.log('\n== 3. applied раньше снимка: ждём id, не координаты ==');
P.reset(1);
P.addBuild({ commandId: 8, n: 8, owner: 1, spec: { type: 'house', x: 20, y: 20 },
  cost: 12, sentSeq: 5 });
P.result(8, { state: 'applied', ids: ['p1:b42'], appliedSeq: 6 });
check(P.buildings().length === 1, 'applied без снимка ожидание не снимает');
check(P.reserved(1) === 12, 'резерв держится до авторитетного появления');
P.reconcile(snap(6, []));
check(P.buildings().length === 1, 'снимок 6 (до постройки) ожидание не стёр');
const b42 = made('house', 20, 20, 1);
b42.id = 'p1:b42';
P.reconcile(snap(7, [b42]));
check(P.buildings().length === 0, 'по id ожидание согласовано');
check(P.reserved(1) === 0, 'резерв освобождён');

/* ================== 4. Снесённая до следующего снимка ================== */
console.log('\n== 4. Применённая, но снесённая постройка не ждётся вечно ==');
P.reset(1);
P.addBuild({ commandId: 9, n: 9, owner: 1, spec: { type: 'house', x: 30, y: 30 },
  cost: 12, sentSeq: 0 });
P.result(9, { state: 'applied', ids: ['p1:b99'], appliedSeq: 10 });
P.reconcile(snap(11, []));
check(P.buildings().length === 1, 'через один снимок после применения ещё ждём');
P.reconcile(snap(12, []));
check(P.buildings().length === 1, 'ещё один шаг запаса');
P.reconcile(snap(13, []));
check(P.buildings().length === 0, 'по версии применения ожидание завершено');
check(P.reserved(1) === 0, 'резерв освобождён после сноса');

/* ================== 5. Отказ, таймаут, серия ================== */
console.log('\n== 5. Отказ, unknown и серия ==');
P.reset(1);
P.addBuild({ commandId: 10, n: 10, owner: 1, spec: { type: 'house', x: 40, y: 40 },
  cost: 12, sentSeq: 0 });
P.result(10, { state: 'rejected', reason: 'нет места' });
check(P.buildings().length === 0, 'rejected убирает ожидание');
check(P.reserved(1) === 0, 'rejected освобождает резерв');

P.addBuild({ commandId: 11, n: 11, owner: 1, spec: { type: 'house', x: 42, y: 40 },
  cost: 12, sentSeq: 0 });
P.result(11, { state: 'unknown', reason: 'результат уточняется' });
check(P.buildings().length === 1, 'таймаут не считается отказом');
check(P.status().unresolved === 1, 'он виден как unresolved');
check(P.reserved(1) === 12, 'резерв не снят таймаутом');

P.reset(1);
const items = [];
for (let i = 0; i < 3; i++) items.push({ type: 'house', x: 50 + i * 3, y: 50, rot: 0 });
P.addLine({ commandId: 12, n: 12, owner: 1, items: items, cost: 36, sentSeq: 0 });
check(P.buildings().length === 3, 'серия показана тремя домами');
check(P.reserved(1) === 36, 'резерв серии — одна общая сумма');
const l1 = made('house', 50, 50, 1), l2 = made('house', 53, 50, 1), l3 = made('house', 56, 50, 1);
P.reconcile(snap(1, [l1, l2]));
check(P.buildings().length === 3, 'часть серии ожидание не снимает (атомарна)');
P.result(12, { state: 'applied', ids: [l1.id, l2.id, l3.id], appliedSeq: 2 });
P.reconcile(snap(2, [l1, l2, l3]));
check(P.buildings().length === 0, 'вся серия согласована по id');
check(P.reserved(1) === 0, 'резерв серии освобождён');

/* ================== 6. Несколько быстрых покупок ================== */
console.log('\n== 6. Несколько быстрых покупок: без двойной траты ==');
P.reset(1);
for (let i = 0; i < 3; i++) {
  P.addBuild({ commandId: 20 + i, n: 20 + i, owner: 1,
    spec: { type: 'house', x: 10 + i * 4, y: 30 }, cost: 12, sentSeq: 0 });
}
check(P.reserved(1) === 36, 'резерв трёх покупок = 36');
P.result(20, { state: 'applied', ids: ['q1'], appliedSeq: 1 });
P.result(21, { state: 'rejected', reason: 'занято' });
P.result(22, { state: 'unknown' });
check(P.reserved(1) === 24, 'после applied резерв ещё держится, после отказа снят');
P.reconcile(snap(2, [Object.assign(made('house', 10, 30, 1), { id: 'q1' })]));
check(P.reserved(1) === 12, 'applied-дом пришёл снимком — его резерв снят');
check(P.buildings().length === 1, 'неизвестная покупка всё ещё ждёт');

/* ================== 7. Счётчики и границы ================== */
console.log('\n== 7. Состояние и ограниченность ==');
P.reset(1);
for (let i = 0; i < 100; i++) {
  P.addBuild({ commandId: 100 + i, n: 100 + i, owner: 1,
    spec: { type: 'house', x: 2 + (i % 20) * 2, y: 2 + Math.floor(i / 20) * 2 },
    cost: 1, sentSeq: 0 });
}
check(P.buildings().length <= 60, 'ожиданий не больше лимита: ' + P.buildings().length);
check(P.exportState().actions.length <= 60, 'выгрузка тоже ограничена');
check(P.exportState().history.length <= 120, 'след диагностики ограничен');
check(P.status().count === P.buildings().length, 'счётчик статуса совпадает');

console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nОЖИДАНИЕ ГОСТЯ ПРИНЯТО');
process.exit(fails ? 1 : 0);
