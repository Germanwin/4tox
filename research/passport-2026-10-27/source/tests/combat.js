/* combat.js — приёмка боя: CONFIG, замах, цель, урон, LOS, завалы, приказы.

   Без браузера: Combat не рисует и не ходит, ему нужны только объекты с
   координатами и таблица Buildings. Поэтому сценарии задаются вручную, а
   время идёт шагом 1/60 — те же числа, что в игре.

   Главное правило этой проверки: числа берутся из `Combat.CONFIG`, а не
   переписываются в тест. Раньше здесь стояли «0.8 с», «6 урона» и «17 с» —
   после введения `windup` и разного урона по юниту/зданию такая проверка
   зеленела бы на сломанном бое или краснела на верном.

   Что проверяется:
     * таблица HP и то, что старые имена (`HP`, `WARRIOR_DAMAGE`,
       `ATTACK_EVERY`) остались алиасами CONFIG;
     * замах: первый удар по НОВОЙ цели не раньше `windup`, следующие — с
       интервалом по типу цели (юнит/здание);
     * полоса HP ставится от фактического удара, а не от выбора цели;
     * TTK ратуши одним воином и пятью (идеально и в настоящем мире с
       дорогой);
     * LOS: за углом/стеной не бьём; рабочий в закрытой клетке чужого пятна
       снаружи не достаётся; кольцо СВОЕГО военного лагеря — достаётся;
     * недостижимый дом не заставляет воина гонять A*: не больше 40 поисков
       за 60 с;
     * «Стоп» ставит `holdFire`, восемь секунд не наносит урона, новый приказ
       возвращает бой;
     * события `attack`/`destroy` попадают в журнал;
     * прежние сцены: агрессия 8, переключение со здания на воина и обратно,
       защита деревни, смерть, завалы, выбывание, поводок, пять против одного.

   Запуск: node mapgen2/tools/combat.js */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');

globalThis.window = globalThis;
for (const f of ['noise.js', 'rng.js', 'metrics.js', 'worldgen.js', 'buildings.js',
  'hero.js', 'villager.js', 'session.js', 'events.js', 'combat.js', 'army.js']) {
  new Function(fs.readFileSync(path.join(JS, f), 'utf8') + '\n//# sourceURL=' + f)();
}

const B = globalThis.Buildings, C = globalThis.Combat;
const S = globalThis.Session, WG = globalThis.WorldGen;
const V = globalThis.Villagers, A = globalThis.Army;
const E = globalThis.Events, M = globalThis.Metrics;
const DT = 1 / 60;

/* Единственный источник чисел — CONFIG. Ниже ни одного своего «6 урона» или
   «0.8 с»: всё читается отсюда. */
const CFG = C.CONFIG;
const HP = CFG.hp;
const DMG_U = CFG.damage.unit;
const DMG_B = CFG.damage.building;
const UNIT_EVERY = CFG.interval.unit;
const BLD_EVERY = CFG.interval.building;
const WINDUP = CFG.windup;
const AGGRO = CFG.aggro;

/* Кадры жителя — те же числа, что в atlas.js. Нужны только реальному миру:
   update() берёт из набора длину шага и удара. */
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
let seq = 1;
function warrior(owner, x, y, camp) {
  return {
    id: 1000 + (seq++), owner: owner, x: x, y: y, warrior: true,
    hp: 0, maxHp: 0, hpUntil: 0, flinch: 0, attackT: 0, thinkT: 0,
    target: null, combatMode: null, attacker: null, attackerT: 0,
    prevTarget: null, dead: false, hidden: false, trainee: false,
    warcamp: camp || null, station: null, path: null, state: 'patrol',
    anim: 'idle', rot: 0, anchor: { x: x, y: y }, holdFire: false,
    noPathKey: null, noPathT: 0, _fightAnchor: null
  };
}
function fakeWorld(w, h, waterX) {
  const N = w * h;
  const isLand = new Uint8Array(N).fill(1);
  if (waterX !== undefined) for (let y = 0; y < h; y++) isLand[y * w + waterX] = 0;
  return {
    width: w, height: h, time: 0, isLand,
    tile: new Uint8Array(N).fill(WG.T.GRASS), objects: [], towns: [],
    _buildings: [], _villagers: []
  };
}
function addBuilding(world, list, type, x, y, owner, rot) {
  const b = B.make({
    type: type, variant: type === 'townhall' ? 'c' : type === 'warcamp' ? 'x' : 'a',
    rot: rot === undefined ? 0 : rot, x: x, y: y, owner: owner
  });
  list.push(b);
  world._buildings = list;
  return b;
}
function step(world, buildings, villagers, seconds, opts) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    C.tick(world, DT, Object.assign({ buildings: buildings, villagers: villagers }, opts || {}));
  }
}
/* Все попадания за отрезок: время, урон и полоса — по ФАКТУ изменения HP. */
function hits(world, buildings, villagers, seconds, target) {
  let prev = target.hp;
  const out = [];
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    C.tick(world, DT, { buildings: buildings, villagers: villagers });
    if (target.hp !== prev) {
      out.push({ t: world.time, dmg: prev - target.hp, hpUntil: target.hpUntil });
      prev = target.hp;
      if (!target.hp) break;
    }
  }
  return out;
}
function insideBuilding(world, x, y) {
  const key = Math.floor(x) + ',' + Math.floor(y);
  for (const b of (world._buildings || [])) {
    for (const c of B.cells(b)) if (c.x + ',' + c.y === key) return true;
  }
  return false;
}
function finiteN(n) { return typeof n === 'number' && isFinite(n); }

/* ================== 1. CONFIG и таблица HP ================== */
console.log('\n== CONFIG и HP ==');
const world = fakeWorld(64, 64);
const buildings = [], villagers = [];
const hall = addBuilding(world, buildings, 'townhall', 4, 4, 1);
const house = addBuilding(world, buildings, 'house', 10, 4, 1);
const camp = addBuilding(world, buildings, 'warcamp', 20, 4, 1);
const bar = addBuilding(world, buildings, 'barracks', 30, 4, 1);
const lc = addBuilding(world, buildings, 'lumbercamp', 40, 4, 1);
C.init(world, buildings, villagers);
for (const b of [hall, house, lc, bar, camp]) {
  const type = B.typeOf(b);
  check(b.maxHp === HP[type] && b.hp === HP[type],
    type + ': HP ' + b.hp + '/' + b.maxHp + ' из CONFIG ' + HP[type]);
}
const civ = warrior(1, 12, 12, null); civ.warrior = false;
const w1 = warrior(0, 12, 12, null);
C.init(world, buildings, [civ, w1]);
check(civ.maxHp === HP.villager, 'житель ' + civ.maxHp + ' HP');
check(w1.maxHp === HP.warrior, 'воин ' + w1.maxHp + ' HP');
check(C.HP === CFG.hp && C.WARRIOR_DAMAGE === DMG_U && C.ATTACK_EVERY === UNIT_EVERY,
  'старые имена — алиасы CONFIG, а не своя копия');
check(C.BUILDING_DAMAGE === DMG_B && C.BUILDING_EVERY === BLD_EVERY && C.WINDUP === WINDUP,
  'урон/интервал здания и замах — из CONFIG');

/* ================== 2. Агрессия 8 ================== */
console.log('\n== Агрессия ==');
{
  const world2 = fakeWorld(64, 64), bl = [], vl = [];
  const target = warrior(1, 12 + AGGRO, 20, null);
  const watcher = warrior(0, 12, 20, null);
  vl.push(target, watcher);
  C.init(world2, bl, vl);
  C.tick(world2, DT, { buildings: bl, villagers: vl });
  check(watcher.target === target, 'цель в ' + AGGRO + ' клетках замечена');
  const world3 = fakeWorld(64, 64), bl3 = [], vl3 = [];
  const far = warrior(1, 20 + AGGRO + 0.1, 20, null);
  const watcher3 = warrior(0, 20, 20, null);
  vl3.push(far, watcher3);
  C.init(world3, bl3, vl3);
  C.tick(world3, DT, { buildings: bl3, villagers: vl3 });
  check(watcher3.target === null, 'цель в ' + (AGGRO + 0.1) + ' клетки не замечена');
}

/* ================== 3. Замах и интервал: юнит ================== */
console.log('\n== Замах и интервал: юнит ==');
{
  const world4 = fakeWorld(64, 64), bl = [], vl = [];
  const a = warrior(0, 10.5, 10.5, null);
  const b = warrior(1, 11.5, 10.5, null);
  vl.push(a, b);
  C.init(world4, bl, vl);
  C.tick(world4, DT, { buildings: bl, villagers: vl });
  const before = b.hp;
  step(world4, bl, vl, WINDUP - 2 * DT);
  check(b.hp === before, 'до замаха урона нет (HP ' + b.hp + ')');
  const hs = hits(world4, bl, vl, 5, b);
  check(hs.length >= 3, 'удары идут: ' + hs.length);
  check(hs[0].t >= WINDUP - 1e-9,
    'первый удар не раньше windup ' + WINDUP + ' с: ' + hs[0].t.toFixed(3));
  check(hs[0].t <= WINDUP + 2 * DT, 'первый удар около windup: ' + hs[0].t.toFixed(3));
  check(hs[0].dmg === DMG_U, 'урон по юниту ' + hs[0].dmg + ' из CONFIG');
  check(Math.abs((hs[1].t - hs[0].t) - UNIT_EVERY) <= 2 * DT,
    'интервал по юниту ' + (hs[1].t - hs[0].t).toFixed(3) + ' при ' + UNIT_EVERY);
  check(Math.abs(hs[0].hpUntil - (hs[0].t + CFG.barTime)) <= 2 * DT,
    'полоса от фактического удара: ' + hs[0].hpUntil.toFixed(3));
}

/* ================== 4. Замах и интервал: здание ================== */
console.log('\n== Замах и интервал: здание ==');
{
  const world5 = fakeWorld(64, 64), bl = [], vl = [];
  const target = addBuilding(world5, bl, 'townhall', 20, 20, 1);
  const a = warrior(0, 24.5, 20.5, null);
  vl.push(a);
  check(!insideBuilding(world5, a.x, a.y), 'воин стоит на чистой земле, не на пятне ратуши');
  C.init(world5, bl, vl);
  const hs = hits(world5, bl, vl, 6, target);
  check(hs.length >= 3, 'удары по зданию идут: ' + hs.length);
  check(hs[0].t >= WINDUP - 1e-9, 'первый удар по зданию не раньше windup');
  check(hs[0].dmg === DMG_B, 'урон по зданию ' + hs[0].dmg + ' из CONFIG');
  check(Math.abs((hs[1].t - hs[0].t) - BLD_EVERY) <= 2 * DT,
    'интервал по зданию ' + (hs[1].t - hs[0].t).toFixed(3) + ' при ' + BLD_EVERY);
  check(Math.abs(hs[0].hpUntil - (hs[0].t + CFG.barTime)) <= 2 * DT,
    'полоса здания от фактического удара');
}

/* ================== 5. TTK ратуши одним воином ================== */
console.log('\n== TTK ратуши одним воином ==');
{
  const world6 = fakeWorld(64, 64), bl = [], vl = [];
  const target = addBuilding(world6, bl, 'townhall', 20, 20, 1);
  const a = warrior(0, 24.5, 20.5, null);
  vl.push(a);
  C.init(world6, bl, vl);
  const volleys = Math.ceil(HP.townhall / DMG_B);
  const theoretical = WINDUP + (volleys - 1) * BLD_EVERY;
  let t = 0;
  while (!target.rubble && t < 150) {
    C.tick(world6, DT, { buildings: bl, villagers: vl });
    t += DT;
  }
  const tol = (volleys - 1) * DT * 2 + 0.1;
  console.log('  один воин: факт ' + t.toFixed(2) + ' с, из CONFIG ' + theoretical.toFixed(2) +
    ' с, ударов ' + volleys);
  check(target.rubble, 'ратуша разрушена одним воином');
  check(Math.abs(t - theoretical) <= tol,
    'TTK одного воина считается из CONFIG, а не «17 с»');
}

/* ================== 6. TTK ратуши пятью: идеально ================== */
console.log('\n== TTK ратуши пятью воинами: идеально ==');
{
  const world7 = fakeWorld(64, 64), bl = [], vl = [];
  const target = addBuilding(world7, bl, 'townhall', 20, 20, 1);
  const spots = [[19.5, 20.5], [19.5, 21.5], [19.5, 22.5], [24.5, 20.5], [24.5, 22.5]];
  for (const p of spots) vl.push(warrior(0, p[0], p[1], null));
  check(spots.every((p) => !insideBuilding(world7, p[0], p[1])),
    'пятеро стоят на чистой земле вокруг ратуши');
  C.init(world7, bl, vl);
  const volleys = Math.ceil(HP.townhall / (5 * DMG_B));
  const theoretical = WINDUP + (volleys - 1) * BLD_EVERY;
  let defeated = -1, t = 0;
  while (!target.rubble && t < 40) {
    C.tick(world7, DT, { buildings: bl, villagers: vl, onDefeat: (o) => { defeated = o; } });
    t += DT;
  }
  const tol = (volleys - 1) * DT * 2 + 0.1;
  console.log('  пять воинов: факт ' + t.toFixed(2) + ' с, из CONFIG ' + theoretical.toFixed(2) + ' с');
  check(target.rubble, 'ратуша разрушена пятью воинами');
  check(t >= 15 && t <= 25, 'TTK пяти воинов в полосе 15–25 с: ' + t.toFixed(2));
  check(Math.abs(t - theoretical) <= tol, 'TTK пяти сходится с расчётом из CONFIG');
  check(defeated === 1, 'выбывание владельца 1: ' + defeated);
}

/* ================== 7. LOS: за углом не бьём ================== */
console.log('\n== LOS: закрытая клетка и угол ==');
{
  const world8 = fakeWorld(48, 48), bl = [], vl = [];
  addBuilding(world8, bl, 'house', 12, 9, 1);
  const a = warrior(0, 10.5, 10.5, null);
  const b = warrior(1, 14.5, 10.5, null);
  vl.push(a, b);
  C.init(world8, bl, vl);
  const solid = V.blockedMap(world8, bl);
  check(C.losBlocked(world8, solid, a.x, a.y, b.x, b.y, null, null) === true,
    'стена на прямой — LOS закрыт');
  C.tick(world8, DT, { buildings: bl, villagers: vl });
  step(world8, bl, vl, 2);
  check(b.hp === b.maxHp, 'за стеной урона нет (HP ' + b.hp + ')');
  check(a.target !== b, 'цель за стеной не выбрана');
}

/* ================== 8. Рабочий в закрытой клетке ================== */
console.log('\n== Закрытая клетка двора ==');
{
  const world9 = fakeWorld(60, 60), bl = [], vl = [];
  addBuilding(world9, bl, 'lumbercamp', 30, 30, 0);   // своя стена: не цель
  const civ9 = warrior(1, 31.5, 31.5, null); civ9.warrior = false;
  const a = warrior(0, 29.5, 31.5, null);
  vl.push(civ9, a);
  world9._buildings = bl;
  check(C.inClosedCell(world9, civ9) === true, 'рабочий в закрытой клетке лагеря определён');
  C.init(world9, bl, vl);
  C.tick(world9, DT, { buildings: bl, villagers: vl });
  step(world9, bl, vl, 2);
  check(civ9.hp === civ9.maxHp, 'рабочего в закрытой клетке снаружи не бьют');
  check(a.target !== civ9, 'закрытая клетка не выбрана целью');
}

/* ================== 9. Кольцо своего лагеря ================== */
console.log('\n== Кольцо военного лагеря ==');
{
  const world10 = fakeWorld(70, 70), bl = [], vl = [];
  const wc = addBuilding(world10, bl, 'warcamp', 30, 30, 1);
  const ring = B.patrolCells(wc)[0];
  const def = warrior(1, ring.x + 0.5, ring.y + 0.5, wc);
  const a = warrior(0, ring.x + 0.5, ring.y - 0.5, null);
  vl.push(def, a);
  world10._buildings = bl;
  check(C.inClosedCell(world10, def) === false, 'кольцо лагеря — не закрытая клетка');
  C.init(world10, bl, vl);
  C.tick(world10, DT, { buildings: bl, villagers: vl });
  step(world10, bl, vl, 2);
  check(a.target === def && def.hp < def.maxHp,
    'защитника на кольце своего лагеря снаружи бьют');
}

/* ================== 10. Недостижимый дом: без A*-цикла ================== */
console.log('\n== Недостижимый дом ==');
{
  const world11 = fakeWorld(40, 40, 18);   // водная стена x=18
  const bl = [], vl = [];
  const house11 = addBuilding(world11, bl, 'house', 20, 10, 1);
  const a = warrior(0, 16.5, 10.5, null);
  vl.push(a);
  world11._buildings = bl;
  C.init(world11, bl, vl);
  M.on = true;
  M.reset();
  for (let i = 0; i < 60 * 60; i++) {
    C.tick(world11, DT, { buildings: bl, villagers: vl });
    V.beginFrame(world11);
    V.update(a, world11, SET, DT, { buildings: bl });
  }
  const paths = M.counters.paths;
  M.on = false;
  console.log('  поисков пути за 60 с: ' + paths + ', цель ' + (a.target ? 'есть' : 'нет'));
  check(paths <= 40, 'недостижимый дом: не больше 40 A* за 60 с (' + paths + ')');
  check(house11.hp === house11.maxHp, 'недостижимый дом не получил урона');
  check(a.target === null, 'недостижимый дом не выбран целью');
}

/* ================== 11. Стоп, holdFire и новый приказ ================== */
console.log('\n== Стоп и новый приказ ==');
{
  const world12 = fakeWorld(60, 60), bl = [], vl = [];
  const house12 = addBuilding(world12, bl, 'house', 30, 30, 1);
  const a = warrior(0, 32.5, 30.5, null);
  vl.push(a);
  C.init(world12, bl, vl);
  const hs = hits(world12, bl, vl, 3, house12);
  check(hs.length > 0, 'до «Стопа» бой идёт: ' + hs.length + ' удара');
  const stopped = A.stop([a.id], vl);
  check(stopped === 1 && a.holdFire === true && a.target === null,
    '«Стоп» ставит holdFire и снимает цель');
  const hp0 = house12.hp;
  step(world12, bl, vl, 8);
  check(house12.hp === hp0, 'после «Стопа» 8 с без урона');
  const ord = A.order(world12, [a.id], vl, a.x, a.y);
  check(ord.ok && a.holdFire === false, 'новый приказ снимает holdFire');
  const hs2 = hits(world12, bl, vl, 3, house12);
  check(hs2.length > 0, 'после приказа бой возвращается: ' + hs2.length + ' удара');
}

/* ================== 12. События attack/destroy ================== */
console.log('\n== События ==');
{
  const world13 = fakeWorld(60, 60), bl = [], vl = [];
  const house13 = addBuilding(world13, bl, 'house', 30, 30, 1);
  const a = warrior(0, 32.5, 30.5, null);
  vl.push(a);
  C.init(world13, bl, vl);
  let t = 0;
  while (!house13.rubble && t < 60) {
    C.tick(world13, DT, { buildings: bl, villagers: vl });
    t += DT;
  }
  const events = E.list(world13);
  const attack = events.filter((e) => e.kind === 'attack' && e.owner === 1);
  const destroy = events.filter((e) => e.kind === 'destroy' && e.owner === 1);
  check(house13.rubble, 'дом разрушен для события destroy');
  check(attack.length > 0, 'attack в журнале: ' + attack.length + ' запись(ей)');
  check(destroy.length === 1, 'destroy в журнале: ' + destroy.length + ' запись(ей)');
  check(destroy.length === 1 && destroy[0].x !== null && destroy[0].y !== null,
    'destroy знает место разрушения');
}

/* ================== 13. Переключение здание ↔ воин ================== */
console.log('\n== Переключение цели ==');
{
  const world14 = fakeWorld(64, 64), bl = [], vl = [];
  const building = addBuilding(world14, bl, 'house', 20, 20, 1);
  const a = warrior(0, 24.5, 20.5, null);
  const b = warrior(1, 25.5, 20.5, null);
  vl.push(a, b);
  a.target = building; a.combatMode = 'attack';
  C.init(world14, bl, vl);
  C.tick(world14, DT, { buildings: bl, villagers: vl });
  check(a.target === b, 'воин бросил здание ради подошедшего воина');
  b.hp = 1;
  step(world14, bl, vl, 1.0);
  check(b.dead, 'вражеский воин убит');
  C.tick(world14, DT, { buildings: bl, villagers: vl });
  check(a.target === building, 'после убийства вернулся к зданию: ' + (a.target && a.target.type));
}

/* ================== 14. Защита деревни за 8 клеток ================== */
console.log('\n== Защита деревни ==');
{
  const world15 = fakeWorld(64, 64), bl = [], vl = [];
  const th = addBuilding(world15, bl, 'townhall', 10, 10, 0);
  const wc = addBuilding(world15, bl, 'warcamp', 20, 20, 0);
  const guard = warrior(0, 20.5, 20.5, wc);
  const enemy = warrior(1, 30, 30, null);
  enemy.target = th;
  vl.push(guard, enemy);
  C.init(world15, bl, vl);
  C.tick(world15, DT, { buildings: bl, villagers: vl });
  check(guard.target === enemy,
    'лагерь защищает деревню и за ' + AGGRO + ' клеток');
}

/* ================== 15. Смерть жителя ================== */
console.log('\n== Смерть жителя ==');
{
  const world16 = fakeWorld(64, 64), bl = [], vl = [];
  const a = warrior(0, 44.5, 45.5, null);
  const v = warrior(1, 45.5, 45.5, null); v.warrior = false;
  vl.push(a, v);
  a.target = v; a.combatMode = 'attack';
  C.init(world16, bl, vl);
  step(world16, bl, vl, 3.0);
  check(v.dead && v.hp === 0, 'житель убит и исчез (dead)');
  check(v.hpUntil === 0, 'полоса убитого погашена');
}

/* ================== 16. Завалы не работают ================== */
console.log('\n== Завалы ==');
{
  const b = B.make({ type: 'house', x: 0, y: 0, rot: 0 });
  b.rubble = true;
  check(B.housingCapacity(b) === 0, 'у завалов дома жилья 0');
  const c = B.make({ type: 'warcamp', x: 0, y: 0, rot: 0 });
  c.rubble = true;
  check(B.patrolCells(c).length === 0, 'у завалов лагеря территории 0');
}

/* ================== 17. Настоящий мир: дорога и разрушение ================== */
console.log('\n== Настоящий мир ==');
/* Мир с вражеской постройкой рядом с деревней игрока. Пятеро воинов
   выходят на дорогу — TTK считается вместе с дорогой, как в игре. */
function realEnemy(seed, type, count) {
  const world = WG.generate({ seed: seed, size: 96 });
  const st = S.startHome(world, renderer);
  const hc = B.center(st.home);
  const variant = type === 'townhall' ? 'c' : 'a';
  const spot = B.findSpot(world, st.buildings, variant, B.FACE_ROT, {
    type: type, center: { x: hc.x + 12, y: hc.y },
    range: 14, minSep: 10, clearable: true, requireClear: false, yard: 1
  });
  if (!spot) return null;
  B.settle(world, spot, { clearable: true, requireClear: false, yard: 1 });
  spot.owner = 1; spot.town = 1; spot.id = '1:e';
  const list = st.buildings.concat([spot]);
  const ec = B.center(spot);
  const solid = V.blockedMap(world, list);
  const vs = [];
  for (let r = 4; r <= 8 && vs.length < count; r++) {
    for (let a = 0; a < 16 && vs.length < count; a++) {
      const ang = a / 16 * Math.PI * 2;
      const s = V.spawnSpot(world, solid, ec.x + Math.cos(ang) * r, ec.y + Math.sin(ang) * r, null, 1);
      if (!s) continue;
      if (vs.some((v) => Math.floor(v.x) === Math.floor(s.x) && Math.floor(v.y) === Math.floor(s.y))) continue;
      const v = V.blank(world, {
        id: 4000 + vs.length, index: 4000 + vs.length,
        x: s.x, y: s.y, owner: 0, town: 0, home: null
      });
      v.warrior = true; v.state = 'patrol';
      v.anchor = { x: ec.x, y: ec.y };
      v.warcamp = null; v.station = null;
      vs.push(v);
    }
  }
  world._buildings = list;
  world._villagers = vs;
  C.init(world, list, vs);
  return { world: world, list: list, spot: spot, ec: ec, vs: vs };
}
{
  const scene = realEnemy('combat-real-five', 'townhall', 5);
  check(!!scene, 'настоящий мир: вражеская ратуша поставлена');
  if (scene) {
    check(scene.vs.every((v) => !insideBuilding(scene.world, v.x, v.y)),
      'пятеро вышли на чистую землю, не на пятно');
    let t = 0;
    while (!scene.spot.rubble && t < 60) {
      C.tick(scene.world, DT, { buildings: scene.list, villagers: scene.vs });
      V.beginFrame(scene.world);
      for (const v of scene.vs) V.update(v, scene.world, SET, DT, { buildings: scene.list });
      t += DT;
    }
    console.log('  настоящий мир, пять воинов: ' + t.toFixed(2) + ' с');
    check(scene.spot.rubble, 'в настоящем мире ратуша разрушена');
    check(t >= 15 && t <= 25, 'TTK пяти в настоящем мире 15–25 с: ' + t.toFixed(2));
  }
}
{
  const scene = realEnemy('combat-real-house', 'house', 1);
  check(!!scene, 'настоящий мир: вражеский дом поставлен');
  if (scene) {
    const v = scene.vs[0];
    v.target = scene.spot;
    v.combatMode = 'chase';
    let t = 0;
    while (!scene.spot.rubble && t < 70) {
      C.tick(scene.world, DT, { buildings: scene.list, villagers: scene.vs });
      V.beginFrame(scene.world);
      V.update(v, scene.world, SET, DT, { buildings: scene.list });
      t += DT;
    }
    check(scene.spot.rubble, 'воин дошёл до чужого дома и разрушил его (' + t.toFixed(1) + ' с)');
  }
}

/* ================== 18. Выбывание в партии 2–4 ================== */
console.log('\n== Выбывание ==');
{
  const sw = { towns: [
    { id: 0, owner: 0, alive: true },
    { id: 1, owner: 1, alive: true },
    { id: 2, owner: 2, alive: true }
  ] };
  let st = S.standing(sw);
  check(!st.over && st.winner === null, 'три живых города — партия идёт');
  sw.towns[2].alive = false;
  st = S.standing(sw);
  check(!st.over && st.winner === null && st.alive.length === 2,
    'выбыл третий — остались двое, партия идёт');
  sw.towns[1].alive = false;
  st = S.standing(sw);
  check(st.over && st.winner === 0 && st.alive.length === 1,
    'остался один — победитель владелец 0, а не «номер 1»');
  sw.towns[0].alive = false;
  st = S.standing(sw);
  check(st.over && st.winner === null && st.alive.length === 0,
    'все пали — победителя нет');
}

/* ================== 19. Поводок ================== */
console.log('\n== Поводок ==');
{
  const world17 = fakeWorld(96, 96), bl = [], vl = [];
  const wc = addBuilding(world17, bl, 'warcamp', 10, 10, 0);
  const guard = warrior(0, 12.5, 12.5, wc);
  const farD = CFG.leash.camp * 3;
  const far = warrior(1, 10 + farD, 10 + farD, null);
  guard.target = far; guard.combatMode = 'chase';
  vl.push(guard, far);
  C.init(world17, bl, vl);
  C.tick(world17, DT, { buildings: bl, villagers: vl });
  check(guard.target === null,
    'цель в ' + farD + ' клетках от лагеря не уводит воина через остров');
}

/* ================== 20. Пять против одного ================== */
console.log('\n== Пять против одного ==');
{
  const world18 = fakeWorld(64, 64), bl = [], vl = [];
  const lone = warrior(0, 20.5, 20.5, null);
  vl.push(lone);
  for (let i = 0; i < 5; i++) {
    const a = warrior(1, 19.5 + i * 0.2, 19.5, null);
    a.target = lone; a.combatMode = 'attack';
    vl.push(a);
  }
  C.init(world18, bl, vl);
  step(world18, bl, vl, 5.0);
  check(lone.dead, 'пять воинов одолевают одного за 5 секунд');
}

/* ================== итог ================== */
check(!Number.isNaN(world.time) && finiteN(world.time), 'время мира конечно');
console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nБОЙ ПРИНЯТ');
process.exit(fails ? 1 : 0);
