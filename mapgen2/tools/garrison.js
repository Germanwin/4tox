/* garrison.js — приёмка дружины: казарма без лагеря, лагерь за доски,
   вместимость 20 и очередь во двор казармы (требования 2–5 заказчика,
   2026-10-23).

   Проверяется без браузера, на настоящем мире и настоящих атласах:
   1) на старте три постройки, военного лагеря нет;
   2) казарма учит и без лагеря — воин выходит и встаёт во двор казармы,
      а его HP — 25 (таблица боя), а не 15 жителя;
   3) двор вмещает 10, одиннадцатый не учится, пока место не освободится;
   4) построили лагерь — все ждущие уходят в него сами (rebalanceGarrison);
   5) лагерь вмещает 20; 21-й снова встаёт во двор казармы;
   6) когда полны и лагерь (20), и двор (10), тренировка отклоняется словами.

   Запуск: node mapgen2/tools/garrison.js
   Код возврата 1, если хоть одна проверка не прошла. */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'js');
const ASSETS = path.join(ROOT, 'assets');

globalThis.window = globalThis;
globalThis.Image = function () {
  this.onload = null;
  this.onerror = null;
  Object.defineProperty(this, 'src', {
    get: function () { return this._src; },
    set: function (v) { this._src = v; if (this.onload) this.onload(); }
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
  frameCount: function () { return 8; },
  fps: function () { return 12; },
  loops: function () { return true; },
  sprite: function () { return null; },
  scaleAt: function () { return 1; },
  build: function () { return {}; }
};

const B = globalThis.Buildings, S = globalThis.Session, V = globalThis.Villagers;
const WG = globalThis.WorldGen;
const DT = 1 / 60;
let fails = 0, simT = 0;

function check(ok, text) {
  console.log((ok ? '  ok   ' : '  FAIL ') + text);
  if (!ok) fails++;
}
function step(dt) { simT += dt; S.stepVillagers(villagers, world, renderer, dt, buildings); }
function stepUntil(pred, maxSec) {
  const limit = Math.round((maxSec || 180) / DT);
  for (let i = 0; i < limit; i++) { if (pred()) return true; step(DT); }
  return pred();
}
function trainees() { return villagers.filter(v => v.trainee); }
function warriors() { return villagers.filter(v => v.warrior); }
function freeVillager() { return villagers.find(v => !v.employer && !v.trainee && !v.warrior); }
function trainOne() {
  const v = freeVillager();
  if (!v) return false;
  const before = warriors().length;
  if (!S.train(bar, v, villagers, buildings).ok) return false;
  return stepUntil(function () { return trainees().length === 0 && warriors().length === before + 1; }, 180);
}

const world = WG.generate({ seed: 'garrison-test', size: 64 });
const renderer = {
  world: null, villagerSprites: {},
  setBuildings: function () {}, setVillagers: function () {}, fitIsland: function () {}
};
const st = S.startHome(world, renderer, S.SITE);
let buildings = st.buildings;
const villagers = S.spawnVillagers(world, renderer, buildings, st.home, { count: 40 });
world._buildings = buildings;
world._villagers = villagers;

check(buildings.length === 3, 'на старте три постройки: ' + buildings.length);
check(!buildings.some(b => B.typeOf(b) === 'warcamp'), 'военного лагеря на старте нет');

const bar = B.neighbourSpot(world, buildings, { type: 'barracks', variant: 'a' }, S.SITE);
check(!!bar, 'казарма нашла место рядом с деревней');
if (bar) { B.settle(world, bar, S.SITE); buildings.push(bar); }

/* 1. Без лагеря: три воина уходят во двор казармы. */
check(S.canTrain(bar, freeVillager(), villagers, buildings).ok,
  'без лагеря тренировка разрешена, пока есть двор');
for (let i = 0; i < 3; i++) check(trainOne(), 'обучен воин ' + (i + 1));
check(warriors().length === 3, 'три воина: ' + warriors().length);
check(warriors().every(v => v.station === bar && !v.warcamp),
  'все трое приписаны к двору казармы');
check(warriors().every(v => v.maxHp === globalThis.Combat.HP.warrior && v.hp === v.maxHp),
  'обученный воин получил HP воина (' + globalThis.Combat.HP.warrior + '), а не жителя');
stepUntil(function () { return warriors().every(v => v.state === 'garrison'); }, 60);
check(warriors().every(v => v.state === 'garrison'),
  'все стоят во дворе: ' + warriors().map(v => v.state).join(','));


/* 2. Двор вмещает 10. */
while (warriors().length < 10) {
  if (!trainOne()) { stepUntil(function () { return trainees().length === 0; }, 30); }
}
check(warriors().length === 10, 'двор заполнен десятью: ' + warriors().length);
check(S.garrisonAt(bar, villagers) === 10, 'счётчик двора 10: ' + S.garrisonAt(bar, villagers));
const eleventh = freeVillager();
const deniedYard = eleventh ? S.canTrain(bar, eleventh, villagers, buildings)
  : { ok: true, reason: '' };
check(!deniedYard.ok, 'одиннадцатый не учится: ' + deniedYard.reason);

/* 3. Построили лагерь — десять уходят в него. */
const camp = B.neighbourSpot(world, buildings, { type: 'warcamp', variant: 'x' }, S.SITE);
check(!!camp, 'военный лагерь нашёл место');
if (camp) { B.settle(world, camp, S.SITE); buildings.push(camp); }
const moved = S.rebalanceGarrison(world, buildings, villagers);
check(moved === 10, 'rebalance перевёл десятерых: ' + moved);
check(S.warriorsAt(camp, villagers) === 10, 'в лагере десять: ' + S.warriorsAt(camp, villagers));
check(warriors().every(v => v.warcamp === camp && !v.station),
  'все приписаны к лагерю');
stepUntil(function () { return warriors().every(v => v.state === 'patrol'); }, 90);
check(warriors().every(v => v.state === 'patrol'),
  'все дошли в лагерь: ' + warriors().map(v => v.state).join(','));
check(S.canTrain(bar, freeVillager(), villagers, buildings).ok,
  'двор освободился — тренировка снова разрешена');

/* 4. Добираем лагерь до 20, 21-й — во двор. */
while (S.warriorsAt(camp, villagers) < 20) {
  if (!trainOne()) stepUntil(function () { return trainees().length === 0; }, 30);
}
check(S.warriorsAt(camp, villagers) === 20,
  'лагерь заполнен двадцатью: ' + S.warriorsAt(camp, villagers));
check(trainOne(), 'двадцать первый обучен');
const overflow = warriors().find(v => !v.warcamp && v.station === bar);
check(!!overflow, 'двадцать первый встал во двор казармы');
check(S.warriorsAt(camp, villagers) === 20,
  'лагерь не превысил 20: ' + S.warriorsAt(camp, villagers));

/* 5. Добираем двор до 10; 31-й не учится. */
while (S.garrisonAt(bar, villagers) < 10) {
  const n = warriors().length;
  if (!trainOne()) stepUntil(function () { return trainees().length === 0; }, 30);
  if (warriors().length === n && S.garrisonAt(bar, villagers) < 10) {
    /* Свободных жителей больше нет — это тоже честный предел, но не тот,
       который проверяем: увеличивать население тут нечем. */
    break;
  }
}
check(S.garrisonAt(bar, villagers) === 10,
  'двор заполнен десятью: ' + S.garrisonAt(bar, villagers));
const last = freeVillager();
const deniedAll = last ? S.canTrain(bar, last, villagers, buildings)
  : { ok: false, reason: 'нет свободных жителей' };
check(!deniedAll.ok, 'тридцать первый не учится: ' + deniedAll.reason);

console.log('\nвремя симуляции: ' + simT.toFixed(1) + ' с');
console.log(fails ? 'ПРОВАЛЕНО проверок: ' + fails : 'ДРУЖИНА ПРИНЯТА');
process.exit(fails ? 1 : 0);
