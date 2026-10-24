/* fallback.js — опыт: что делает сдача, когда анимации carry_put в атласе НЕТ.

   Приёмка `mapgen2/tools/lumberjack.js` проверяет ОБА случая, но прогнать она
   может только тот, что лежит в атласе: сейчас `carry_put` в нём есть. Второй
   случай — «кадра нет» — проверяется здесь: атлас берётся тот же, но запись
   `anims.carry_put` из него убирается, и видно, что движок деградирует мягко.

   Контракт (art/characters/villager/README.md, раздел про carry_put): нет
   своей анимации — сдача идёт ЗАМОРОЖЕННЫМ нулевым кадром carry, потому что
   нулевой кадр carry — это стойка с брёвнами на руках. Времени сдача не
   занимает и в этом случае: кадр стоит ровно один.

   Запуск: node experiments/drop-instant/fallback.js [сид] [минуты] */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'mapgen2');
for (const f of ['noise.js', 'rng.js', 'worldgen.js', 'buildings.js', 'hero.js', 'villager.js', 'session.js']) {
  new Function(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8') + '\n//# sourceURL=' + f)();
}
const WG = globalThis.WorldGen, B = globalThis.Buildings, V = globalThis.Villagers;
const S = globalThis.Session, H = globalThis.Hero;
const DT = 1 / 60;
const SEED = process.argv[2] || 'лагерь-приёмка';
const MINUTES = +(process.argv[3] || 3);

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

/* Атлас жителя без carry_put: ровно тот случай, ради которого в движке живёт
   animFrozen. Всё остальное — включая carry — на месте. */
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', 'villager', 'atlas.json'), 'utf8'));
delete meta.anims.carry_put;
const set = { img: null, meta: meta, ppu: meta.ppu || 96, mul: meta.mul === undefined ? 1 : meta.mul,
  anims: meta.anims, rots: [], frames: {} };
for (const name in meta.frames) {
  const f = meta.frames[name];
  if (f.anim === undefined || f.frame === undefined) continue;
  /* Кадров carry_put в атласе тоже нет: `Hero.frameCount` спрашивает и список
     кадров, если записи в `anims` не нашлось, — одного удаления `anims` мало. */
  if (f.anim === 'carry_put') continue;
  const byAnim = set.frames[f.anim] || (set.frames[f.anim] = []);
  const byFrame = byAnim[f.frame] || (byAnim[f.frame] = {});
  byFrame[((f.rotation % 360) + 360) % 360] = { img: null, sx: f.x, sy: f.y, sw: f.w, sh: f.h,
    ax: f.anchorX / f.w, ay: f.anchorY / f.h };
}
for (const [type, dir] of [['lumbercamp', 'lumbercamp'], ['house', 'starter_house'], ['townhall', 'townhall']]) {
  B.build(type, null, JSON.parse(fs.readFileSync(path.join(ROOT, 'assets', dir, 'atlas.json'), 'utf8')));
}

const world = WG.generate({ seed: SEED, size: 64, land: 0.72, coast: 0.5, forest: 0.5, rock: 0.5, trees: 0.45, rocks: 0.6 });
const list = S.startHome(world).buildings;
const camp = list.filter(b => B.typeOf(b) === 'lumbercamp')[0];
const house = list.filter(b => B.typeOf(b) === 'house')[0];
const vs = [];
for (let i = 0; i < 3; i++) {
  const d = B.frontSpot(house);
  vs.push(V.create(world, { index: i, x: d.x + 0.5, y: d.y + 0.5, buildings: list, home: house, avoid: vs }));
}
for (const v of vs) S.hire(camp, v, vs);

console.log(`\nатлас БЕЗ carry_put: animResolve(carry_put) = ${V.animResolve(set, 'carry_put')}\n`);

const ep = {};
const res = { deposits: [], episodes: [], frozenFrames: 0, phases: {}, anims: {} };
const STEPS = Math.round(MINUTES * 60 / DT);
for (let step = 0; step < STEPS; step++) {
  world._villagers = vs;
  for (const v of vs) {
    const b = { logs: world.village.logs, deliv: world.village.deliveries,
                transit: world.village.inTransit, mine: v.delivered || 0, state: v.state };
    V.update(v, world, set, DT, { buildings: list });
    if (world.village.logs !== b.logs || world.village.deliveries !== b.deliv) {
      res.deposits.push({ who: v.id, from: b.state, logs: world.village.logs - b.logs,
        deliv: world.village.deliveries - b.deliv, mine: (v.delivered || 0) - b.mine,
        transit: world.village.inTransit - b.transit, state: v.state,
        atYard: !!B.atYardSpot(camp, v.x, v.y), spot: !!v.spot });
    }
  }
  /* Эпизоды пишутся по КАЖДОМУ рабочему на КАЖДОМ кадре, а не только когда он
     в drop: у состояния drop в этом атласе длина — один кадр, и «начал — тут же
     кончил» иначе не заметить. Кто вышел из drop, тот закрывает свой эпизод. */
  for (const v of vs) {
    res.anims[v.anim] = (res.anims[v.anim] || 0) + 1;
    /* Заморозка считается ТОЛЬКО в сдаче: в атласе без carry_put заморожен и
       кадр carry — он у рабочего с полными руками на всей дороге назад. */
    if (v.frozen && v.state === 'drop') { res.frozenFrames++; res.phases[+v.phase.toFixed(3)] = 1; }
    if (v.state === 'drop') res.dropFrames = (res.dropFrames || 0) + 1;
    if (v.state !== 'drop') {
      if (ep[v.id]) { ep[v.id].done = true; res.episodes.push(ep[v.id]); ep[v.id] = null; }
      continue;
    }
    if (!ep[v.id]) ep[v.id] = { who: v.id, anim: v.anim, from: step, frames: [], frozen: !!v.frozen };
    const f = Math.min(3, Math.floor(v.phase * 4));
    if (ep[v.id].frames[ep[v.id].frames.length - 1] !== f) ep[v.id].frames.push(f);
  }
}
for (const id in ep) if (ep[id]) { ep[id].done = false; res.episodes.push(ep[id]); }

const dep = res.deposits;
check('нет carry_put — сдача берёт запасной кадр carry, а не падает',
  V.animResolve(set, 'carry_put') === 'carry' && res.anims.carry > 0,
  'играли: ' + Object.keys(res.anims).sort().join(', '));
check('кадр сдачи ЗАМОРОЖЕН на фазе 0 (нулевой кадр carry — стойка с брёвнами)',
  res.frozenFrames > 0 && Object.keys(res.phases).join(',') === '0' && res.episodes.every(e => e.frozen),
  `${res.frozenFrames} кадров сдачи заморожены, фазы [${Object.keys(res.phases).join(',')}]`);
check('кадров в состоянии drop столько же, сколько сдач: жест — один кадр',
  res.dropFrames === res.episodes.length && res.episodes.every(e => e.done),
  `кадров drop ${res.dropFrames} при ${res.episodes.length} сдачах (доиграно ${res.episodes.filter(e => e.done).length})`);
check('и это РОВНО ОДИН кадр: времени сдача не занимает и без своей анимации',
  res.episodes.length > 0 && res.episodes.every(e => e.frames.length === 1 && e.frames[0] === 0),
  res.episodes.length + ' сдач, кадры: ' + [...new Set(res.episodes.map(e => e.frames.join(',')))].join(' · '));
check('начисление — по-прежнему в кадр прихода: +4, +1, +4, -1 одним вызовом',
  dep.length > 0 && dep.every(d => d.from === 'carry' && d.logs === 4 && d.deliv === 1 &&
    d.mine === 4 && d.transit === -1 && d.atYard && d.spot),
  dep.length + ' сдач, приросты logs [' + [...new Set(dep.map(d => d.logs))] + ']');
check('счёт деревни сходится', world.village.logs === world.village.deliveries * 4 &&
  world.village.felled === world.village.deliveries + world.village.inTransit,
  `брёвен ${world.village.logs} за ${world.village.deliveries} сдач, срублено ${world.village.felled}, в пути ${world.village.inTransit}`);

console.log(`\nИТОГ: ${fails ? 'ПРОВАЛЕНО ' + fails : 'ПРИНЯТО'}`);
process.exit(fails ? 1 : 0);
