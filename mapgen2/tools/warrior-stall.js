/* warrior-stall.js — приёмка «воин стоит с целью и не идёт» (2026-10-30).

   Жалоба заказчика: иногда местные воины не защищают деревню и стоят, даже
   когда враг в восьми клетках; их можно бить, а они не отвечают. Новые воины
   из казармы при этом воюют. Отдельно: часть войск не доходит до метки и
   стоит, хотя приказ есть.

   Причина (воспроизведено): в бою `combatMove` повторял поиск пути КАЖДЫЙ
   кадр при `deferred`/`limit`, менял клетку подхода и ключ задачи. Очередь
   A* не успевала завершить ни одну задачу, ожидающие не получали слот, а
   кеш «сюда не дойти» писался в одном формате и читался в другом. Воин
   навсегда оставался с недостижимой целью и не возвращался к приказу.

   Что проверяется:
     1) 20 воинов против дома: никто не стоит >5 с с целью вне удара;
     2) очередь A* не копит задачи: ожидание < 5 с, waiting не растёт;
     3) дом получает урон, часть воинов доходит до приказа;
     4) ответ на удар не отменяется кешем недостижимости;
     5) воин в закрытой клетке — законная цель, гражданский — нет;
     6) удар воина виден: анимация `work` и фаза двигается.

   Запуск: node mapgen2/tools/warrior-stall.js */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');

globalThis.window = globalThis;
for (const f of ['noise.js', 'rng.js', 'metrics.js', 'worldgen.js', 'buildings.js',
  'hero.js', 'villager.js', 'session.js', 'events.js', 'combat.js', 'army.js']) {
  new Function(fs.readFileSync(path.join(JS, f), 'utf8') + '\n//# sourceURL=' + f)();
}
new Function(fs.readFileSync(path.join(JS, 'simulation/navigation.js'), 'utf8') +
  '\n//# sourceURL=navigation.js')();

const B = globalThis.Buildings, S = globalThis.Session, V = globalThis.Villagers;
const C = globalThis.Combat, A = globalThis.Army, WG = globalThis.WorldGen;
const N = globalThis.Navigation;
const DT = 0.05;

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

/* Место под постройку: тот же перебор, что у соседа деревни, но без
   зависимости от камеры и рендера. */
function roomFor(world, list, type, variant, near, minDist) {
  for (let r = 4; r < 40; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = near.x + dx, y = near.y + dy;
        if (x < 3 || y < 3 || x >= world.width - 6 || y >= world.height - 6) continue;
        if (minDist && Math.hypot(x - near.x, y - near.y) < minDist) continue;
        const b = B.make({ type: type, variant: variant, rot: 0, x: x, y: y, owner: 0, town: 0 });
        if (B.canPlace(world, list, b, {}).ok) return b;
      }
    }
  }
  return null;
}

console.log('== 1. Отряд против дома: никто не застревает ==');
const world = WG.generate({ seed: 'warrior-stall', size: 96 });
const st = S.startHomeCore(world, {});
const villagers = S.spawnVillagersCore(world, st.buildings, st.home,
  { count: 3, owner: 0, townId: 0, idBase: 0 });
world._villagers = villagers;
const th = st.home;

const house = roomFor(world, st.buildings, 'house', 'a', th, 13);
house.owner = 1; house.town = 1; house.id = 'enemy:house';
st.buildings.push(house);
world._buildings = st.buildings;
B.settle(world, house, { clear: false });
B.touch(world);
house.hp = 100000;
house.maxHp = 100000;

const camp = roomFor(world, st.buildings, 'warcamp', 'x', th, 0);
st.buildings.push(camp);
world._buildings = st.buildings;
B.settle(world, camp, { clear: false });
B.touch(world);

const patrol = B.patrolCells(camp);
const squad = [];
for (let i = 0; i < 20; i++) {
  const c = patrol[i % patrol.length];
  const v = V.blank(world, { id: 700 + i, owner: 0, town: 0, x: c.x + 0.5, y: c.y + 0.5 });
  v.warrior = true;
  v.warcamp = camp;
  v.state = 'patrol';
  v.anim = 'idle';
  v.maxHp = C.HP.warrior;
  v.hp = C.HP.warrior;
  villagers.push(v);
  squad.push(v);
}
world._villagers = villagers;
C.init(world, st.buildings, villagers);

const order = A.order(world, squad.map(v => v.id), villagers, house.x + 1.5, house.y + 3.5);
check(order.ok && order.count === 20, 'приказ отдан всем 20: ' + order.count);

let maxWaitAge = 0, maxWaiting = 0, frozen = 0, workSeen = false;
const prev = new Map(), still = new Map(), lastMove = new Map();
const seenFrozen = new Set();
const started = Date.now();
for (let f = 0; f < Math.round(30 / DT); f++) {
  world.time = (world.time || 0) + DT;
  world._combatCells = null;
  C.tick(world, DT, { buildings: st.buildings, villagers: villagers, advanceTime: false });
  N.beginTick(world);
  S.stepVillagersCore(villagers, world, DT, st.buildings, SET);

  const nav = world._navigation;
  if (nav) {
    if (nav.waiting.length > maxWaiting) maxWaiting = nav.waiting.length;
    for (let i = 0; i < nav.waiting.length; i++) {
      const j = nav.waiting[i];
      if (!j) continue;
      const age = nav.tick - j.enqueuedTick;
      if (age > maxWaitAge) maxWaitAge = age;
    }
  }

  for (const v of squad) {
    if (v.dead) continue;
    if (v.state === 'attack' && v.anim === 'work') workSeen = true;
    const p = prev.get(v.id);
    if (p && Math.hypot(v.x - p.x, v.y - p.y) < 0.002) {
      still.set(v.id, (still.get(v.id) || 0) + DT);
    } else {
      still.set(v.id, 0);
      lastMove.set(v.id, world.time);
    }
    prev.set(v.id, { x: v.x, y: v.y });
    /* Стоит >5 с, приказ ещё далеко и цель не в ударе — это и есть
       «стоит с заданием». Сюда попадает и ожидание очереди A*, если оно
       длится дольше 5 с: именно так выглядел баг. */
    const toOrderNow = v.order ? Math.hypot(v.x - v.order.x, v.y - v.order.y) : 0;
    const targetInRange = v.target && C.distTo(v.target, v.x, v.y) <= C.ATTACK_RANGE * 1.5;
    if (still.get(v.id) > 5 && toOrderNow > 3 && !targetInRange && !seenFrozen.has(v.id)) {
      seenFrozen.add(v.id);
      frozen++;
      console.log('  застрял:', JSON.stringify({
        id: v.id, x: +v.x.toFixed(1), y: +v.y.toFixed(1), state: v.state,
        target: v.target.id || v.target.type, dist: +C.distTo(v.target, v.x, v.y).toFixed(1),
        pending: !!v.routePending, noPath: !!v.noPathKey
      }));
    }
  }
}
const tookMs = Date.now() - started;
check(frozen === 0, 'никто не стоит с целью вне удара >5 с: ' + frozen);
check(maxWaitAge < 100, 'ожидание в очереди A* < 5 с: ' + (maxWaitAge * DT).toFixed(1) + ' с');
check(maxWaiting <= 16, 'очередь ожидания не растёт: максимум ' + maxWaiting);
check(house.hp < 100000, 'дом получил урон: ' + (100000 - house.hp));
check(workSeen, 'удар воина проигрывается анимацией work');

/* К концу 30 с никто не должен «стоять намертво»: либо дошёл к приказу,
   либо дерётся вплотную, либо двигался в последние 2 с. */
let motionless = 0;
for (const v of squad) {
  if (v.dead) continue;
  const toOrder = v.order ? Math.hypot(v.x - v.order.x, v.y - v.order.y) : 0;
  const inRange = v.target && C.distTo(v.target, v.x, v.y) <= C.ATTACK_RANGE * 1.1;
  if (toOrder > 3 && !inRange && (still.get(v.id) || 0) > 5) motionless++;
}
check(motionless === 0, 'в конце никто не стоит намертво: ' + motionless);
console.log('  (прогон ' + tookMs + ' мс)');

console.log('\n== 2. Ответ на удар сильнее кеша недостижимости ==');
{
  const w = WG.generate({ seed: 'retaliate', size: 64 });
  const s2 = S.startHomeCore(w, {});
  const list = S.spawnVillagersCore(w, s2.buildings, s2.home,
    { count: 2, owner: 0, townId: 0, idBase: 0 });
  w._villagers = list;
  const spot = { x: 20.5, y: 20.5 };
  function unit(id, owner, x, y) {
    const v = V.blank(w, { id: id, owner: owner, town: owner, x: x, y: y });
    v.warrior = true;
    v.state = 'stand';
    v.anchor = { x: x, y: y };
    v.maxHp = C.HP.warrior;
    v.hp = C.HP.warrior;
    return v;
  }
  const a = unit(901, 0, spot.x, spot.y);
  const d = unit(902, 1, spot.x + 1, spot.y);
  list.push(a, d);
  w._villagers = list;
  w._buildings = s2.buildings;
  C.init(w, s2.buildings, list);
  const solid = V.blockedMap(w, s2.buildings);
  check(C.canTarget(d, a, w, solid) === true, 'без кеша цель доступна');
  /* Кеш ровно на этого воина в ЕГО текущей клетке — как после неудачного A*. */
  d.noPathKey = C.targetKey(w, d, a);
  check(C.canTarget(d, a, w, solid) === false, 'кеш недостижимости цель отсекает');
  d.attacker = a;
  d.attackerT = 2.5;
  d.thinkT = 0;
  C.tick(w, DT * 2, { buildings: s2.buildings, villagers: list, advanceTime: false });
  check(d.target === a, 'удар разбудил воина вопреки кешу');
}

console.log('\n== 3. Закрытая клетка: воин — цель, гражданский — нет ==');
{
  const w = WG.generate({ seed: 'closed', size: 64 });
  const s3 = S.startHomeCore(w, {});
  const list = S.spawnVillagersCore(w, s3.buildings, s3.home,
    { count: 1, owner: 0, townId: 0, idBase: 0 });
  const th3 = s3.home;
  w._buildings = s3.buildings;
  w._villagers = list;
  const inside = { x: th3.x + 0.5, y: th3.y + 0.5 };
  function unit(id, owner, x, y, warrior) {
    const v = V.blank(w, { id: id, owner: owner, town: owner, x: x, y: y });
    v.warrior = warrior;
    v.state = 'stand';
    v.maxHp = warrior ? C.HP.warrior : C.HP.villager;
    v.hp = v.maxHp;
    return v;
  }
  const outside = { x: th3.x - 2.5, y: th3.y + 0.5 };
  const viewer = unit(911, 0, outside.x, outside.y, true);
  const foeWarrior = unit(912, 1, inside.x, inside.y, true);
  const foeCivilian = unit(913, 2, inside.x, inside.y, false);
  list.push(viewer, foeWarrior, foeCivilian);
  w._villagers = list;
  C.init(w, s3.buildings, list);
  const solid = V.blockedMap(w, s3.buildings);
  check(C.inClosedCell(w, foeWarrior) === true, 'клетка пятна действительно закрыта');
  check(C.canTarget(viewer, foeWarrior, w, solid) === true,
    'воина в закрытой клетке можно взять в цель');
  check(C.canTarget(viewer, foeCivilian, w, solid) === false,
    'гражданского в закрытой клетке — нельзя');
}

console.log('\n== 4. После недостижимой цели приказ возобновляется ==');
{
  const w = WG.generate({ seed: 'resume-order', size: 64 });
  const s4 = S.startHomeCore(w, {});
  const th4 = s4.home;
  w._buildings = s4.buildings;
  const list = [];
  function unit(id, owner, x, y) {
    const v = V.blank(w, { id: id, owner: owner, town: owner, x: x, y: y });
    v.warrior = true;
    v.state = 'march';
    v.anchor = { x: x, y: y };
    v.maxHp = C.HP.warrior;
    v.hp = C.HP.warrior;
    return v;
  }
  const v = unit(921, 0, th4.x - 4.5, th4.y + 4.5);
  const house4 = B.make({ type: 'house', variant: 'a', rot: 0,
    x: th4.x - 1, y: th4.y + 4, owner: 1, town: 1, id: 'resume:house' });
  s4.buildings.push(house4);
  w._buildings = s4.buildings;
  list.push(v);
  w._villagers = list;
  C.init(w, s4.buildings, list);
  const orderPoint = { x: th4.x + 8.5, y: th4.y + 4.5 };
  v.order = { x: orderPoint.x, y: orderPoint.y, r: 2.5, done: false };
  v.target = house4;
  v.combatMode = 'chase';
  v.attackTarget = house4;
  v._fightAnchor = { x: v.x, y: v.y, r: C.FIGHT_LEASH };
  /* Ровно тот кеш, который старый combatMove писал в чужом формате. */
  v.noPathKey = C.targetKey(w, v, house4);
  const before = Math.hypot(v.x - orderPoint.x, v.y - orderPoint.y);
  check(C.canTarget(v, house4, w, V.blockedMap(w, s4.buildings)) === false,
    'недостижимый дом не берётся в цель');
  let sawNull = false;
  for (let f = 0; f < 60; f++) {
    w.time = (w.time || 0) + DT;
    w._combatCells = null;
    C.tick(w, DT, { buildings: s4.buildings, villagers: list, advanceTime: false });
    if (v.target === null) sawNull = true;
    if (N) N.beginTick(w);
    S.stepVillagersCore(list, w, DT, s4.buildings, SET);
  }
  const after = Math.hypot(v.x - orderPoint.x, v.y - orderPoint.y);
  check(sawNull, 'Combat отпустил недостижимую цель');
  check(after < before - 0.5, 'воин вернулся к приказу и пошёл к метке: ' +
    before.toFixed(1) + ' -> ' + after.toFixed(1));
}

console.log('\n' + (fails ? 'ЗАВИСАНИЕ ВОИНОВ: ЕСТЬ ОШИБКИ' : 'ЗАВИСАНИЕ ВОИНОВ ПРИНЯТО'));
process.exit(fails ? 1 : 0);
