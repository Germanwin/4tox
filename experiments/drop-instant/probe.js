/* probe.js — оптыт: сдача брёвен мгновенна, жест играется один проход.

   Прогон БЕЗ БРАУЗЕРА, тем же кодом, что игровой цикл (Session + Villagers).
   Нужен затем, что правка движка проверяется здесь за секунду, а приёмка
   `mapgen2/tools/lumberjack.js` — минуты: сначала числа, потом Chrome.

   Что меряется (те же четыре числа, что требует заказчик):
     а) кадров между приходом рабочего на место сдачи и ростом village.logs
        ровно 0;
     б) за ходку logs +4, deliveries +1, v.delivered +4, inTransit обратно в 0;
     в) последовательность кадров анимации сдачи за проход — 0,1,2,3 без
        повторов (без «0,1,2,3,0,1...»);
     г) казна + в пути = срублено x 4 на длинном прогоне.

   Запуск: node experiments/drop-instant/probe.js [сид] [минуты] */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'mapgen2', 'js');
const FILES = ['noise.js', 'rng.js', 'worldgen.js', 'buildings.js', 'hero.js', 'villager.js', 'session.js'];
for (const f of FILES) {
  new Function(fs.readFileSync(path.join(ROOT, f), 'utf8') + '\n//# sourceURL=' + f)();
}

const WG = globalThis.WorldGen;
const B = globalThis.Buildings;
const V = globalThis.Villagers;
const S = globalThis.Session;
const H = globalThis.Hero;

const SEED = process.argv[2] || 'лагерь-приёмка';
const MINUTES = +(process.argv[3] || 5);
const DT = 1 / 60;
const PARAMS = { size: 64, land: 0.72, coast: 0.5, forest: 0.5, rock: 0.5, trees: 0.45, rocks: 0.6 };

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

/* Атлас без картинки: движку из него нужны только числа — сколько кадров у
   анимации и с какой частотой. Настоящий атлас грузит Chrome, и читать его
   здесь незачем: разбор кадров — предмет приёмки жителя. */
function spriteSet(meta) {
  const set = { img: null, meta, ppu: meta.ppu || 96, mul: meta.mul === undefined ? 1 : meta.mul,
    anims: meta.anims || {}, rots: [], frames: {} };
  for (const name in meta.frames) {
    const f = meta.frames[name];
    if (f.anim === undefined || f.frame === undefined) continue;
    const byAnim = set.frames[f.anim] || (set.frames[f.anim] = []);
    const byFrame = byAnim[f.frame] || (byAnim[f.frame] = {});
    byFrame[((f.rotation % 360) + 360) % 360] = { img: null, sx: f.x, sy: f.y, sw: f.w, sh: f.h,
      ax: f.anchorX / f.w, ay: f.anchorY / f.h };
    if (set.rots.indexOf(f.rotation) < 0) set.rots.push(f.rotation);
  }
  return set;
}

const meta = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'mapgen2', 'assets', 'villager', 'atlas.json'), 'utf8'));
const set = spriteSet(meta);

/* Атласы построек — только разбором. В браузере их грузит Buildings.load
   (картинкой), здесь картинка не нужна: движку двора от атласа нужен замер
   `yard` (где стоит рабочий) и пятно, а не пиксели. Без этого у лагеря не
   было бы НИ ОДНОГО места двора, и рабочий не смог бы сдать брёвна. */
const ASSETS = path.join(__dirname, '..', '..', 'mapgen2', 'assets');
for (const [type, dir, file] of [['lumbercamp', 'lumbercamp', 'atlas.json'],
                                ['house', 'starter_house', 'atlas.json'],
                                ['townhall', 'townhall', 'atlas.json']]) {
  const m = JSON.parse(fs.readFileSync(path.join(ASSETS, dir, file), 'utf8'));
  B.build(type, null, m);
}

const world = WG.generate(Object.assign({ seed: SEED }, PARAMS));
const start = S.startHome(world);
const list = start.buildings;
const camp = list.filter(b => B.typeOf(b) === 'lumbercamp')[0];
if (!camp) { console.log('нет лагеря лесоруба'); process.exit(1); }

const vs = [];
for (let i = 0; i < 3; i++) {
  vs.push(V.create(world, { index: i, x: B.frontSpot(list[0]).x + 0.5, y: B.frontSpot(list[0]).y + 0.5,
    buildings: list, home: list.filter(b => B.typeOf(b) === 'house')[0], avoid: vs }));
}
for (const v of vs) S.hire(camp, v, vs);

const res = {
  deposits: [], episodes: [], inTransitBad: 0, logStepBad: 0, runsBad: 0,
  creditCalls: 0, deliverCalls: 0, negative: 0
};
const prevStates = {};
const ep = {};      // открытые эпизоды drop по жителям

const STEPS = Math.round(MINUTES * 60 / DT);
for (let step = 0; step < STEPS; step++) {
  world._villagers = vs;
  for (const v of vs) {
    const before = { logs: world.village.logs, deliv: world.village.deliveries,
      transit: world.village.inTransit, mine: v.delivered || 0, state: v.state };
    V.update(v, world, set, DT, { buildings: list });
    const grew = world.village.logs - before.logs;
    if (grew > 0 || world.village.deliveries !== before.deliv) {
      res.creditCalls++;
      res.deposits.push({
        step, who: v.id,
        logs: grew, deliv: world.village.deliveries - before.deliv,
        mine: (v.delivered || 0) - before.mine,
        transit: world.village.inTransit - before.transit,
        wasCarry: before.state === 'carry', atYard: !!B.atYardSpot(camp, v.x, v.y),
        spot: !!v.spot, state: v.state, frame: Math.floor(v.phase * H.frameCount(set, v.anim))
      });
    }
    if (world.village.inTransit < 0) res.negative++;
  }
  for (const v of vs) {
    const f = Math.floor(v.phase * Math.max(1, H.frameCount(set, v.anim))) % Math.max(1, H.frameCount(set, v.anim));
    if (v.state === 'drop' && !ep[v.id]) {
      ep[v.id] = { who: v.id, from: step, frames: [f], creditAt: res.deposits.some(d => d.step === step && d.who === v.id) ? 1 : 0, done: false };
    } else if (ep[v.id] && v.state === 'drop') {
      ep[v.id].frames.push(f);
    } else if (ep[v.id] && v.state !== 'drop') {
      ep[v.id].done = true;
      ep[v.id].to = step;
      res.episodes.push(ep[v.id]);
      ep[v.id] = null;
    }
    prevStates[v.id] = v.state;
  }
}
for (const id in ep) if (ep[id]) { ep[id].to = STEPS; res.episodes.push(ep[id]); ep[id] = null; }

/* --- числа -------------------------------------------------------------- */
console.log(`\nсдача брёвен: ${res.creditCalls} начислений за ${MINUTES} мин (сид «${SEED}»)\n`);

const d = res.deposits;
check('а) сдача — в кадр прихода: начисление пришло из состояния carry на месте двора',
  d.length > 0 && d.every(x => x.wasCarry && x.atYard && x.spot && x.state === 'drop'),
  d.length ? `пример: кадр ${d[0].step}, вышел из «${'carry'}», на дворе ${d[0].atYard}` : 'начислений нет');
check('б) за ходку: logs +4, deliveries +1, v.delivered +4, inTransit -1 — одним вызовом',
  d.length > 0 && d.every(x => x.logs === 4 && x.deliv === 1 && x.mine === 4 && x.transit === -1),
  d.length ? `приросты: logs [${[...new Set(d.map(x => x.logs))]}], deliveries [${[...new Set(d.map(x => x.deliv))]}], ` +
    `v.delivered [${[...new Set(d.map(x => x.mine))]}], inTransit [${[...new Set(d.map(x => x.transit))]}]` : '—');
check('кадров между приходом и начислением 0: начисление и есть кадр прихода',
  d.length > 0 && d.every(x => x.wasCarry && x.atYard && x.state === 'drop'),
  `${d.length} начислений, все — из carry и все на своём дворе`);
check('inTransit не ушёл в минус ни разу', res.negative === 0, `минусов ${res.negative}`);

const expect = [0, 1, 2, 3];
const done = res.episodes.filter(e => e.done);
/* Последовательность КАДРОВ САМОЙ АНИМАЦИИ: соседние повторы одного кадра —
   это один кадр, стоящий несколько кадров симуляции (12 к/с против 60). */
const shown = res.episodes.map(e => dedup(e.frames).join(','));
const modes = {};
for (const q of shown) modes[q] = (modes[q] || 0) + 1;
const nFrames = H.frameCount(set, 'carry_put');
const nFps = H.fps(set, 'carry_put');
const framesPerPass = Math.round((60 / nFps) * nFrames);
const lens = res.episodes.map(e => e.frames.length);
check('в) за проход ровно ОДИН проход кадров 0,1,2,3 — без повторов и зацикливания',
  done.length > 0 && shown.every(q => q === expect.join(',')) &&
    res.episodes.every(e => e.frames[0] === 0 && inOrder(e.frames)) &&
    lens.every(l => Math.abs(l - framesPerPass) <= 1),
  `эпизодов ${res.episodes.length}, доиграно ${done.length}; показанные кадры: ` +
  Object.keys(modes).map(k => `${k} x${modes[k]}`).join(' · '));

const vill = world.village;
const felledTotal = vs.reduce((a, v) => a + (v.felled || 0), 0);
check('г) казна + в пути = срублено x 4 сходится',
  vill.felled === vill.deliveries + vill.inTransit &&
    vill.logs + vill.inTransit * 4 === vill.felled * 4 &&
    vill.logs === vill.deliveries * 4,
  `срублено ${vill.felled} x4 = ${vill.felled * 4}; в казне ${vill.logs} за ${vill.deliveries} сдач; в пути ${vill.inTransit}`);
check('счёт рабочего сходится с казной', vs.reduce((a, v) => a + (v.delivered || 0), 0) === vill.logs,
  vs.map(v => '№' + v.id + ' ' + (v.delivered || 0)).join(' · '));

const lens2 = res.episodes.map(e => e.frames.length).sort((a, b) => a - b);
const mode = lens2[Math.floor(lens2.length / 2)];
console.log(`\nкадров в жесте сдачи: медиана ${mode} кадров симуляции при 60 к/с ` +
  `(${nFrames} кадра при ${nFps} к/с = ${(nFrames / nFps).toFixed(3)} с = ${framesPerPass} кадров симуляции);`);
console.log(`время жеста ${(mode / 60).toFixed(3)} с против прежних 0.800 с стоянки ` +
  `(было 0.8 / ${(nFrames / nFps).toFixed(3)} = ${(0.8 / (nFrames / nFps)).toFixed(1)} прохода)`);
console.log(`\nИТОГ: ${fails ? 'ПРОВАЛЕНО ' + fails : 'ПРИНЯТО'}`);

/* Соседние повторы одного кадра схлопываются: 12 к/с против 60 — каждый кадр
   анимации стоит пять кадров симуляции, и это один показ, а не пять. */
function dedup(frames) {
  var out = [];
  for (var i = 0; i < frames.length; i++) if (!out.length || out[out.length - 1] !== frames[i]) out.push(frames[i]);
  return out;
}
/* Кадры идут по возрастанию: мелькнувший «нулевой через три» — это и есть
   зацикливание, и он виден сразу. */
function inOrder(frames) {
  for (var i = 1; i < frames.length; i++) if (frames[i] < frames[i - 1]) return false;
  return true;
}
process.exit(fails ? 1 : 0);
