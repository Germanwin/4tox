/* army.js — приёмка управления отрядом: группы, выбор, приказ, места.

   Без браузера: Army — чистая логика, а движение проверяется настоящим
   Villagers.update на сгенерированном острове. Главное требование заказчика:
   в точке приказа воины не должны слиться в одного — у каждого своё место.

   Запуск: node mapgen2/tools/army.js */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');
const ASSETS = path.join(ROOT, 'assets');
globalThis.window = globalThis;
globalThis.Image = function () {
  this.onload = null; this.onerror = null;
  Object.defineProperty(this, 'src', { get() { return this._src; },
    set(v) { this._src = v; if (this.onload) this.onload(); } });
};
for (const f of ['noise.js', 'rng.js', 'worldgen.js', 'buildings.js', 'hero.js', 'villager.js', 'session.js', 'combat.js', 'army.js']) {
  new Function(fs.readFileSync(path.join(JS, f), 'utf8') + '\n//# sourceURL=' + f)();
}
globalThis.Hero = {
  frameCount: () => 8, fps: () => 12, loops: () => true,
  sprite: () => null, scaleAt: () => 1, build: () => ({})
};
for (const [type, meta] of [
  ['townhall', 'TOWNHALL_ATLAS'], ['house', 'STARTER_HOUSE_ATLAS'],
  ['lumbercamp', 'LUMBERCAMP_ATLAS'], ['barracks', 'BARRACKS_ATLAS'],
  ['warcamp', 'WARCAMP_ATLAS']
]) {
  const dir = type === 'house' ? 'starter_house' : type;
  new Function(fs.readFileSync(path.join(ASSETS, dir, 'atlas.js'), 'utf8'))();
  globalThis.Buildings.build(type, {}, globalThis[meta]);
}
const B = globalThis.Buildings, S = globalThis.Session, A = globalThis.Army, V = globalThis.Villagers;
const WG = globalThis.WorldGen, DT = 1 / 60;
let fails = 0;
function check(ok, text) { console.log((ok ? '  ok   ' : '  FAIL ') + text); if (!ok) fails++; }

const world = WG.generate({ seed: 'army-test', size: 64 });
const renderer = { world: null, villagerSprites: {}, setBuildings() {}, setVillagers() {}, fitIsland() {} };
const st = S.startHome(world, renderer, S.SITE);
const buildings = st.buildings;
const villagers = S.spawnVillagers(world, renderer, buildings, st.home, { count: 24 });
world._buildings = buildings; world._villagers = villagers;
const camp = B.neighbourSpot(world, buildings, { type: 'warcamp', variant: 'x' }, S.SITE);
check(!!camp, 'военный лагерь поставлен');
if (camp) { B.settle(world, camp, S.SITE); buildings.push(camp); }
const bar = B.neighbourSpot(world, buildings, { type: 'barracks', variant: 'a' }, S.SITE);
if (bar) { B.settle(world, bar, S.SITE); buildings.push(bar); }

let nCamp = 0, nBar = 0;
for (const v of villagers) {
  if (nCamp < 12) { v.warrior = true; v.warcamp = camp; v.station = null; nCamp++; }
  else if (nBar < 5) { v.warrior = true; v.warcamp = null; v.station = bar; nBar++; }
}
const pc = B.patrolCells(camp);
let pi = 0;
for (const v of villagers) if (v.warrior) {
  v.state = 'patrol';
  const c = pc[pi++ % pc.length];
  v.x = c.x + 0.5; v.y = c.y + 0.5;
}
const groups = A.groups(buildings, villagers, 0);
check(groups.length >= 2, 'группы: ' + groups.map(g => g.name + ' ' + g.ids.length).join(' · '));
check(groups.some(g => g.kind === 'warcamp' && g.ids.length === 12), 'в лагере 12');
check(groups.some(g => g.kind === 'barracks' && g.ids.length === 5), 'во дворе 5');

const allCounts = {}; groups.forEach(g => allCounts[g.key] = g.ids.length);
const ids = A.select(groups, allCounts);
check(ids.length === 17, 'выбраны все 17: ' + ids.length);
const halfCounts = {}; groups.forEach(g => halfCounts[g.key] = A.half(g.ids.length));
check(A.select(groups, halfCounts).length === 9, 'половина от каждой группы: ' + A.select(groups, halfCounts).length);

/* Кнопка «Половина» в панели берёт половину ВСЕГО отряда, а не сумму половин
   по группам. 17 воинов — это 9 (половина с округлением вверх), и ни одна
   группа не отдаёт больше, чем у неё есть. */
const allHalf = A.halfCounts(groups);
const allHalfIds = A.select(groups, allHalf);
check(allHalfIds.length === 9, '«Половина» всего отряда — 9 из 17: ' + allHalfIds.length);
check(groups.every(g => allHalf[g.key] >= 0 && allHalf[g.key] <= g.ids.length),
  'половина не превышает группу: ' + groups.map(g => allHalf[g.key] + '/' + g.ids.length).join(' · '));
check(JSON.stringify(A.halfCounts(groups)) === JSON.stringify(allHalf), 'половина считается детерминированно');
const equalGroups = A.halfCounts([
  { key: 'a', ids: [1, 2, 3] },
  { key: 'b', ids: [4, 5, 6] }
]);
check(equalGroups.a + equalGroups.b === 3,
  'две группы по 3 дают половину 3, а не 2 + 2: ' + equalGroups.a + ' + ' + equalGroups.b);
const oneHalf = A.halfCounts([{ key: 'one', ids: [7] }]);
check(oneHalf.one === 1, 'один воин из одного остаётся выбранным: ' + oneHalf.one);
const emptyHalf = A.halfCounts([]);
check(Object.keys(emptyHalf).length === 0, 'пустой отряд не даёт чисел');

const target = { x: st.home.x + 3, y: st.home.y + 3 };
const res = A.order(world, ids, villagers, target.x, target.y);
check(res.ok && res.count === 17, 'приказ отдан 17: ' + res.count);
let minD = Infinity;
for (let i = 0; i < res.slots.length; i++) for (let j = i + 1; j < res.slots.length; j++) {
  const d = Math.hypot(res.slots[i].x - res.slots[j].x, res.slots[i].y - res.slots[j].y);
  if (d < minD) minD = d;
}
check(minD >= 0.9, 'места не ближе 0.9 клетки: ' + minD.toFixed(2));

for (let t = 0; t < 60 * 90; t++) S.stepVillagers(villagers, world, renderer, DT, buildings);
const arrived = villagers.filter(v => v.warrior && v.order && v.order.done);
check(arrived.length === 17, 'дошли до мест: ' + arrived.length + '/17');
const seen = {}; let sameCell = 0, minStop = Infinity;
for (const v of arrived) {
  const key = Math.floor(v.x) + ',' + Math.floor(v.y);
  if (seen[key]) sameCell++; else seen[key] = 1;
}
for (let i = 0; i < arrived.length; i++) for (let j = i + 1; j < arrived.length; j++) {
  const d = Math.hypot(arrived[i].x - arrived[j].x, arrived[i].y - arrived[j].y);
  if (d < minStop) minStop = d;
}
check(sameCell === 0, 'в одной клетке никого: ' + sameCell);
check(minStop >= 0.5, 'на стоянке не ближе 0.5 клетки: ' + minStop.toFixed(2));

/* Чужая дружина в своей панели (правило 2026-10-24). В сети мир один на
   всех, и в нём лежат лагеря обоих игроков. Группы обязаны отбирать и воинов,
   и ПОСТРОЙКИ по владельцу: иначе гость видел список хоста, а чужой пустой
   лагерь занимал строку в его собственной панели. */
const foeCamp = B.neighbourSpot(world, buildings, { type: 'warcamp', variant: 'x' }, S.SITE);
check(!!foeCamp, 'лагерь второго игрока поставлен');
if (foeCamp) {
  foeCamp.owner = 1;
  foeCamp.town = 1;
  B.settle(world, foeCamp, S.SITE);
  buildings.push(foeCamp);
  const foeCells = B.patrolCells(foeCamp);
  const foe = V.create(world, {
    index: 777, x: foeCells[0].x + 0.5, y: foeCells[0].y + 0.5,
    buildings: buildings, avoid: []
  });
  foe.owner = 1; foe.warrior = true; foe.warcamp = foeCamp; foe.state = 'patrol';
  villagers.push(foe);

  const mine = A.groups(buildings, villagers, 0);
  const theirs = A.groups(buildings, villagers, 1);
  check(mine.every(g => g.building !== foeCamp) &&
    mine.every(g => g.ids.every(w => (w.owner === undefined ? 0 : w.owner) === 0)),
    'в свои группы не попал чужой лагерь и чужой воин: ' +
    mine.map(g => g.name + ' ' + g.ids.length).join(' · '));
  check(theirs.length === 1 && theirs[0].building === foeCamp &&
    theirs[0].ids.length === 1 && theirs[0].ids[0] === foe,
    'у второго игрока ровно его лагерь и его воин: ' +
    theirs.map(g => g.name + ' ' + g.ids.length).join(' · '));
  check(A.groups(buildings, villagers, 0).length === groups.length,
    'чужие постройки не добавили строк в чужую панель');
}

/* Точка на другом берегу: приказ не должен висеть вечно и не должен
   заставлять каждого воина обходить весь остров. Раньше 128 таких приказов
   давали секунды на кадр. */
{
  /* Островок: одна клетка суши в море. Выбираем подальше от деревни. */
  let ix = -1, iy = -1;
  for (let y = 5; y < world.height - 5 && ix < 0; y += 3) {
    for (let x = 5; x < world.width - 5 && ix < 0; x += 3) {
      if (!world.isLand[y * world.width + x]) continue;
      if (Math.hypot(x - target.x, y - target.y) < 15) continue;
      let ok = true;
      for (let j = -2; j <= 2 && ok; j++) for (let i = -2; i <= 2 && ok; i++) {
        if (!world.isLand[(y + j) * world.width + (x + i)]) ok = false;
      }
      if (ok) { ix = x; iy = y; }
    }
  }
  check(ix >= 0, 'нашлось место для островка: ' + ix + ',' + iy);
  if (ix >= 0) {
    for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
      if (!i && !j) continue;
      world.isLand[(iy + j) * world.width + (ix + i)] = 0;
    }
    world._villagerBlocked = null;
    world._villagerAreas = null;
    /* Старые (достижимые) приказы не считаются «оставшимся островным»:
       обнуляем их, иначе проверка ниже ловит прошлую сцену. */
    for (const v of villagers) {
      v.order = null; v.path = null; v.state = 'stand';
    }
    const island = A.order(world, ids, villagers, ix + 0.5, iy + 0.5);
    check(!island.ok && island.skipped === ids.length,
      'приказ на другой берег не отдан и не оставлен висеть: ' +
      island.skipped + ' воинов, причина «' + island.reason + '»');
    check(villagers.every(v => !v.order),
      'ни у кого не осталось недостижимого приказа');
  }
}

/* Неудачный приказ снимается после трёх попыток, а не через 180 секунд:
   каждая попытка — полный обход, и «5 секунд» по кадрам оборачивались вечным
   зависанием. */
{
  const W = world.width;
  let wx = -1, wy = -1;
  for (let y = 1; y < world.height - 1 && wx < 0; y++) {
    for (let x = 1; x < W - 1 && wx < 0; x++) {
      if (world.isLand[y * W + x]) continue;
      let deep = true;
      for (let j = -1; j <= 1 && deep; j++) {
        for (let i = -1; i <= 1 && deep; i++) {
          if (world.isLand[(y + j) * W + (x + i)]) deep = false;
        }
      }
      if (deep) { wx = x; wy = y; }
    }
  }
  check(wx >= 0, 'нашлась вода для недостижимой цели');
  if (wx >= 0) {
    const solid = V.blockedMap(world, buildings);
    const free = V.spawnSpot(world, solid, target.x + 0.5, target.y + 0.5, null, 8) ||
      { x: target.x + 0.5, y: target.y + 0.5 };
    const v = V.create(world, {
      index: 888, x: free.x, y: free.y, buildings: buildings, avoid: []
    });
    v.owner = 0; v.warrior = true; v.state = 'march';
    v.path = null; v.goal = null;
    v.order = { x: wx + 0.5, y: wy + 0.5, r: 2.5, issuedAt: 0, done: false };
    const few = [v];
    world._villagers = few;
    for (let t = 0; t < 60 * 4; t++) S.stepVillagers(few, world, renderer, DT, buildings);
    check(v.order === null, 'недостижимый приказ снят за 4 секунды, а не через 180');
    world._villagers = villagers;
  }
}

console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nОТРЯД ПРИНЯТ');
process.exit(fails ? 1 : 0);
