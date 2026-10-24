/* combat.js — приёмка боя: HP, цели, удары, переключение, защита, завалы.

   Без браузера: Combat не рисует и не ходит, ему нужны только объекты с
   координатами и таблица Buildings. Поэтому сценарии задаются вручную, а
   время идёт шагом 1/60 — те же числа, что в игре.

   Запуск: node mapgen2/tools/combat.js */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');
const ASSETS = path.join(ROOT, 'assets');

globalThis.window = globalThis;
globalThis.Image = function () {
  this.onload = null; this.onerror = null;
  Object.defineProperty(this, 'src', {
    get() { return this._src; },
    set(v) { this._src = v; if (this.onload) this.onload(); }
  });
};
for (const f of ['noise.js', 'rng.js', 'worldgen.js', 'buildings.js', 'hero.js', 'villager.js', 'session.js', 'combat.js']) {
  new Function(fs.readFileSync(path.join(JS, f), 'utf8') + '\n//# sourceURL=' + f)();
}
for (const [type, meta] of [
  ['townhall', 'TOWNHALL_ATLAS'], ['house', 'STARTER_HOUSE_ATLAS'],
  ['lumbercamp', 'LUMBERCAMP_ATLAS'], ['barracks', 'BARRACKS_ATLAS'],
  ['warcamp', 'WARCAMP_ATLAS']
]) {
  const dir = type === 'house' ? 'starter_house' : type;
  new Function(fs.readFileSync(path.join(ASSETS, dir, 'atlas.js'), 'utf8'))();
  globalThis.Buildings.build(type, {}, globalThis[meta]);
}
globalThis.Hero = {
  frameCount: () => 8, fps: () => 12, loops: () => true,
  sprite: () => null, scaleAt: () => 1, build: () => ({})
};
const B = globalThis.Buildings, C = globalThis.Combat;
const S = globalThis.Session, WG = globalThis.WorldGen;
const DT = 1 / 60;
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
    warcamp: camp || null, station: null, path: null, state: 'patrol', anim: 'idle', rot: 0
  };
}
function fakeWorld(w, h) {
  const N = w * h;
  return {
    width: w, height: h, time: 0, isLand: new Uint8Array(N).fill(1),
    tile: new Uint8Array(N).fill(4), objects: [], towns: [], _buildings: [], _villagers: []
  };
}
function addBuilding(world, list, type, x, y, owner, rot) {
  const b = B.make({ type: type, variant: type === 'townhall' ? 'c' : 'a',
    rot: rot === undefined ? 90 : rot, x: x, y: y, owner: owner });
  list.push(b);
  return b;
}
function step(world, buildings, villagers, seconds, opts) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) C.tick(world, DT, Object.assign({ buildings, villagers }, opts || {}));
}

/* 1. Таблица HP и урон. */
const world = fakeWorld(64, 64);
const buildings = [], villagers = [];
const hall = addBuilding(world, buildings, 'townhall', 4, 4, 1);
const house = addBuilding(world, buildings, 'house', 10, 4, 1);
const camp = addBuilding(world, buildings, 'warcamp', 20, 4, 1);
const bar = addBuilding(world, buildings, 'barracks', 30, 4, 1);
const lc = addBuilding(world, buildings, 'lumbercamp', 40, 4, 1);
C.init(world, buildings, villagers);
check(hall.maxHp === 120, 'ратуша 120 HP: ' + hall.maxHp);
check(house.maxHp === 50, 'дом 50 HP: ' + house.maxHp);
check(lc.maxHp === 35, 'лагерь лесоруба 35 HP: ' + lc.maxHp);
check(bar.maxHp === 80, 'казарма 80 HP: ' + bar.maxHp);
check(camp.maxHp === 40, 'военный лагерь 40 HP: ' + camp.maxHp);
const civ = warrior(1, 12, 12, null); civ.warrior = false;
const w1 = warrior(0, 12, 12, null);
C.init(world, buildings, [civ, w1]);
check(civ.maxHp === 15, 'житель 15 HP: ' + civ.maxHp);
check(w1.maxHp === 25, 'воин 25 HP: ' + w1.maxHp);

/* 2. Радиус 8: 7.9 замечает, 8.1 — нет. */
{
  const world2 = fakeWorld(64, 64), bl = [], vl = [];
  const target = warrior(1, 20, 20, null);
  const watcher = warrior(0, 12, 20, null);
  vl.push(target, watcher);
  C.init(world2, bl, vl);
  C.tick(world2, DT, { buildings: bl, villagers: vl });
  check(watcher.target === target, 'цель в 8 клетках замечена');
  const world3 = fakeWorld(64, 64), bl3 = [], vl3 = [];
  const far = warrior(1, 28.1, 20, null);
  const watcher3 = warrior(0, 20, 20, null);
  vl3.push(far, watcher3);
  C.init(world3, bl3, vl3);
  C.tick(world3, DT, { buildings: bl3, villagers: vl3 });
  check(watcher3.target === null, 'цель в 8.1 клетки не замечена');
}

/* 3. Удар раз в 0.8 с и урон 6. */
{
  const world4 = fakeWorld(64, 64), bl = [], vl = [];
  const a = warrior(0, 10.5, 10.5, null);
  const b = warrior(1, 11.5, 10.5, null);
  vl.push(a, b);
  C.init(world4, bl, vl);
  C.tick(world4, DT, { buildings: bl, villagers: vl });
  const hp0 = b.hp;
  step(world4, bl, vl, 0.79);
  check(b.hp === hp0, 'за 0.79 с удара нет (HP ' + b.hp + ')');
  step(world4, bl, vl, 0.05);
  check(b.hp === hp0 - 6, 'на 0.8 с удар 6 (HP ' + b.hp + ')');
  const barUntil = b.hpUntil;
  check(Math.abs(barUntil - (world4.time + 5)) < 0.2, 'полоса живёт 5 с от удара');
}

/* 4. Переключение со здания на воина и обратно. */
{
  const world5 = fakeWorld(64, 64), bl = [], vl = [];
  const building = addBuilding(world5, bl, 'house', 20, 20, 1);
  const a = warrior(0, 17.5, 20.5, null);
  const b = warrior(1, 18.5, 20.5, null);
  vl.push(a, b);
  a.target = building; a.combatMode = 'attack';
  C.init(world5, bl, vl);
  C.tick(world5, DT, { buildings: bl, villagers: vl });
  check(a.target === b, 'воин бросил здание ради подошедшего воина');
  b.hp = 1;
  step(world5, bl, vl, 1.0);
  check(b.dead, 'вражеский воин убит');
  C.tick(world5, DT, { buildings: bl, villagers: vl });
  check(a.target === building, 'после убийства вернулся к зданию: ' + (a.target && a.target.type));
}

/* 5. Защита деревни: воин в лагере замечает врага дальше 8, если тот выбрал
   цель в его деревне. */
{
  const world6 = fakeWorld(64, 64), bl = [], vl = [];
  const th = addBuilding(world6, bl, 'townhall', 10, 10, 0);
  const wc = addBuilding(world6, bl, 'warcamp', 20, 20, 0);
  const guard = warrior(0, 20.5, 20.5, wc);
  /* Дальше агра (8), но в пределах поводка лагеря: воин обязан ответить. */
  const enemy = warrior(1, 30, 30, null);
  enemy.target = th;
  vl.push(guard, enemy);
  C.init(world6, bl, vl);
  C.tick(world6, DT, { buildings: bl, villagers: vl });
  check(guard.target === enemy, 'лагерь защищает деревню и за 8 клеток');
}

/* 6. Смерть жителя и завалы здания; ратуша — выбывание. */
{
  const world7 = fakeWorld(64, 64), bl = [], vl = [];
  const hall7 = addBuilding(world7, bl, 'townhall', 10, 10, 1);
  const a = warrior(0, 11.5, 10.5, null);
  const v = warrior(1, 12.5, 10.5, null); v.warrior = false;
  vl.push(a, v);
  C.init(world7, bl, vl);
  a.target = v; a.combatMode = 'attack';
  step(world7, bl, vl, 3.0);
  check(v.dead && v.hp === 0, 'житель убит и исчез (dead)');
  check(v.hpUntil === 0, 'полоса убитого погашена');
  let defeated = -1;
  a.target = hall7; a.combatMode = 'attack';
  step(world7, bl, vl, 17.0, { onDefeat: function (owner) { defeated = owner; } });
  check(hall7.rubble, 'ратуша превратилась в завалы');
  check(hall7.hp === 0, 'HP ратуши 0');
  check(defeated === 1, 'событие выбывания владельца 1: ' + defeated);
  check(!B.housingCapacity(addBuilding(world7, bl, 'house', 20, 20, 1).rubble), 'целый дом ещё жильё');
}

/* 7. Завалы не работают: места/жильё/дружина — нули. */
{
  const b = B.make({ type: 'house', x: 0, y: 0, rot: 0 });
  b.rubble = true;
  check(B.housingCapacity(b) === 0, 'у завалов дома жилья 0');
  const c = B.make({ type: 'warcamp', x: 0, y: 0, rot: 0 });
  c.rubble = true;
  check(B.patrolCells(c).length === 0, 'у завалов лагеря территории 0');
}

/* 8. Бой в настоящем мире: воин идёт к чужому дому и разрушает его. */
{
  const world8 = WG.generate({ seed: 'combat-move', size: 64 });
  const renderer = { world: null, villagerSprites: {}, setBuildings() {}, setVillagers() {}, fitIsland() {} };
  const st = S.startHome(world8, renderer, S.SITE);
  const list = st.buildings.slice();
  const hc = B.center(st.home);
  const enemyHouse = B.make({ type: 'house', variant: 'a', rot: 90,
    x: Math.floor(hc.x) + 4, y: Math.floor(hc.y) + 2, owner: 1 });
  list.push(enemyHouse);
  const hv = globalThis.Villagers.create(world8, {
    index: 500, x: hc.x + 1, y: hc.y + 1, buildings: list, avoid: []
  });
  hv.warrior = true; hv.owner = 0; hv.state = 'patrol';
  const vils = [hv];
  world8._buildings = list; world8._villagers = vils;
  C.init(world8, list, vils);
  hv.target = enemyHouse; hv.combatMode = 'chase';
  let guard = 0;
  while (!enemyHouse.rubble && guard++ < 60 * 45) {
    C.tick(world8, DT, { buildings: list, villagers: vils });
    globalThis.Villagers.update(hv, world8, renderer.villagerSprites, DT, { buildings: list });
  }
  check(enemyHouse.rubble, 'воин дошёл до чужого дома и разрушил его');
}

/* 9. Выбывание в партии на 2–4 человек. Падение второй/третьей ратуши не
   должно заканчивать партию и не должно давать победителя «по номеру 1». */
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

/* 10. Поводок: цель, ушедшая далеко от лагеря, отпускается. */
{
  const world10 = fakeWorld(96, 96), bl = [], vl = [];
  const wc = addBuilding(world10, bl, 'warcamp', 10, 10, 0);
  const guard10 = warrior(0, 12.5, 12.5, wc);
  const far10 = warrior(1, 50, 50, null);
  guard10.target = far10; guard10.combatMode = 'chase';
  vl.push(guard10, far10);
  C.init(world10, bl, vl);
  C.tick(world10, DT, { buildings: bl, villagers: vl });
  check(guard10.target === null,
    'цель в 50 клетках от лагеря не уводит воина через остров');
}

/* 11. Пять против одного: удары складываются, цель умирает. Это тот случай,
   на который жаловался друг («пять воинов не могут одолеть одного»); в
   симуляции он сходится, значит искать надо не в таблице урона. */
{
  const world11 = fakeWorld(64, 64), bl = [], vl = [];
  const lone = warrior(0, 20.5, 20.5, null);
  vl.push(lone);
  for (let i = 0; i < 5; i++) {
    const a = warrior(1, 19.5 + i * 0.2, 19.5, null);
    a.target = lone; a.combatMode = 'attack';
    vl.push(a);
  }
  C.init(world11, bl, vl);
  step(world11, bl, vl, 5.0);
  check(lone.dead, 'пять воинов одолевают одного за 5 секунд');
}

console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nБОЙ ПРИНЯТ');
process.exit(fails ? 1 : 0);
