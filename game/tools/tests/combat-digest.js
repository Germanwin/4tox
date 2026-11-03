/* combat-digest.js — «бой не изменился»: один и тот же бой, снятый в отпечаток.

   Зачем. Оптимизация воинов (кэши карты лагеря, кольца патруля) не имеет права
   поменять ни выбора цели, ни движения, ни урона. Глазами это не проверить:
   сто воинов, шестьсот жителей, десять секунд. Поэтому бой прогоняется в
   фиксированном мире фиксированным числом шагов, и с состояния снимается
   отпечаток: у каждого жителя id, владелец, «воин ли», HP, цель и место
   (округлённое до 1/100 клетки), плюс HP всех построек.

   Отпечаток сравнивается с эталоном из `fixtures/combat-digest.json`, снятым
   ДО правки. Разошёлся — правка меняет бой, и её нельзя принимать, даже если
   она быстрее.

   Запуск:
     node game/tools/tests/combat-digest.js            # сверка с эталоном
     node game/tools/tests/combat-digest.js --write    # переснять эталон (осознанно!)
     node game/tools/tests/combat-digest.js --ticks 300 --players 2 --count 40
*/
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const JS = path.join(ROOT, 'mapgen2', 'js');
const FIXTURE = path.join(__dirname, 'fixtures', 'combat-digest.json');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? def : process.argv[i + 1];
}
const TICKS = Number(arg('ticks', 600));
const PLAYERS = Number(arg('players', 2));
const PER_TOWN = Number(arg('count', 120));
const WRITE = process.argv.includes('--write');
const SEED = String(arg('seed', 'combat-digest-1'));
const SIZE = Number(arg('size', 96));
const DT = 1 / 60;

globalThis.window = globalThis;
for (const f of ['noise.js', 'rng.js', 'metrics.js', 'worldgen.js', 'buildings.js',
  'hero.js', 'villager.js', 'session.js', 'events.js', 'combat.js', 'army.js']) {
  const p = path.join(JS, f);
  if (!fs.existsSync(p)) continue;
  new Function(fs.readFileSync(p, 'utf8') + '\n//# sourceURL=' + f)();
}

const WG = globalThis.WorldGen, B = globalThis.Buildings, V = globalThis.Villagers;
const S = globalThis.Session, C = globalThis.Combat;

/* Отладочный рендер: движок спрашивает у него только «есть ли атлас»
   (без этого Session.spawnVillagers не сеет жителей) и «покажи списки».
   Картинки здесь нет — сверяется бой, а не кадр. */
const ANIMS = {};
for (const k of Object.keys(V && V.ANIM_FALLBACK ? V.ANIM_FALLBACK : {})) ANIMS[k] = { frames: 6, fps: 10, loop: true };
ANIMS.work = { frames: 8, fps: 12, loop: false };
ANIMS.walk = { frames: 8, fps: 12, loop: true };
ANIMS.carry_put = { frames: 4, fps: 12, loop: false };
const renderer = { villagerSprites: { anims: ANIMS, frames: {} }, setVillagers() {}, setBuildings() {} };

function buildWorld() {
  const world = WG.generate({ seed: SEED, size: SIZE });
  const st = S.startMulti(world, renderer, { players: PLAYERS });
  let villagers = st.villagers;
  let buildings = st.buildings;

  /* По военному лагерю на деревню (на старте его больше нет) и по отряду
     воинов: каждый четвёртый житель деревни — воин в лагере. */
  for (const town of (world.towns || [])) {
    if (!town) continue;
    let wc = buildings.find((b) => B.typeOf(b) === 'warcamp' && b.town === town.id);
    if (!wc) {
      const spot = B.findSpot(world, buildings, 'x', B.FACE_ROT, { type: 'warcamp', minSep: 0, town: town.id });
      if (spot) {
        B.settle(world, spot, { clear: true });
        spot.town = town.id;
        spot.owner = town.owner;
        buildings.push(spot);
        wc = spot;
      }
    }
    const more = S.spawnVillagers(world, renderer, buildings, town.townhall, {
      count: PER_TOWN, owner: town.owner, townId: town.id,
      idBase: 5000 + town.id * 10000, append: true
    });
    villagers = world._villagers;
    if (!wc) continue;
    const ring = B.patrolCells(wc);
    let k = 0;
    for (let i = 0; i < more.length; i++) {
      if (i % 4) continue;
      const v = more[i];
      v.warrior = true;
      v.warcamp = wc;
      v.state = 'patrol';
      if (ring.length) {
        const c = ring[k++ % ring.length];
        v.x = c.x + 0.5; v.y = c.y + 0.5;
      }
    }
  }
  world._villagers = villagers;
  world._buildings = buildings;
  world.time = 0;
  return { world, villagers, buildings };
}

function digest(world, villagers, buildings) {
  const rows = [];
  for (const v of villagers) {
    if (!v) continue;
    rows.push([
      v.id, v.owner, v.warrior ? 1 : 0, v.trainee ? 1 : 0,
      Math.round(v.hp || 0),
      v.target ? (v.target.id !== undefined ? v.target.id : 'b') : '-',
      Math.round((v.x || 0) * 100), Math.round((v.y || 0) * 100),
      Math.round((v.rot || 0) * 10)
    ].join(':'));
  }
  rows.sort();
  const bld = buildings.map((b) => (b && !b.rubble ? Math.round(b.hp || 0) : 0)).join(',');
  const body = rows.join('\n') + '\n--buildings--\n' + bld;
  return {
    hash: crypto.createHash('sha1').update(body).digest('hex'),
    villagers: rows.length,
    warriors: villagers.filter((v) => v && v.warrior).length,
    bodies: body
  };
}

function run() {
const { world, villagers, buildings } = buildWorld();
for (let i = 0; i < TICKS; i++) {
  world.time = (world.time || 0) + DT;
  if (C && C.tick) C.tick(world, DT, { buildings, villagers, advanceTime: false });
  if (S && S.stepVillagers) S.stepVillagers(villagers, world, renderer, DT, buildings);
  world._combatCells = null;
}
const d = digest(world, villagers, buildings);
return d;
}

/* Как модуль — для `node --test` (game/tools/tests/combat-digest.test.js):
   та же сверка с эталоном, но без CLI. Как скрипт — печатает и пишет эталон. */
module.exports = { run, digest, buildWorld, FIXTURE, TICKS, PLAYERS, PER_TOWN, SEED, SIZE };

if (require.main !== module) return;

const d = run();

const summary = {
  seed: SEED, size: SIZE, players: PLAYERS, perTown: PER_TOWN, ticks: TICKS,
  villagers: d.villagers, warriors: d.warriors, hash: d.hash
};
console.log('бой: ' + d.villagers + ' жителей, ' + d.warriors + ' воинов, ' + TICKS + ' шагов');
console.log('отпечаток: ' + d.hash);

fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
if (WRITE) {
  fs.writeFileSync(FIXTURE, JSON.stringify(Object.assign({}, summary, { body: d.body }), null, 2) + '\n');
  console.log('эталон записан: ' + path.relative(ROOT, FIXTURE));
  process.exit(0);
}

if (!fs.existsSync(FIXTURE)) {
  console.log('эталона нет: сначала `--write`');
  process.exit(1);
}
const ref = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const same = ref.hash === d.hash;
console.log(same ? 'БОЙ ТОТ ЖЕ: отпечаток совпал с эталоном'
  : 'БОЙ ИЗМЕНИЛСЯ: эталон ' + ref.hash + ', сейчас ' + d.hash);
if (!same && ref.body) {
  /* Показать первые расхождения — по строкам, чтобы было видно, кого именно
     понесло: цель, HP или место. */
  const a = ref.body.split('\n'), b = d.body.split('\n');
  let shown = 0;
  for (let i = 0; i < Math.max(a.length, b.length) && shown < 8; i++) {
    if (a[i] === b[i]) continue;
    console.log('   было  ' + a[i]);
    console.log('   стало ' + b[i]);
    shown++;
  }
}
process.exit(same ? 0 : 1);
