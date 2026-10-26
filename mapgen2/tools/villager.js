/* villager.js — приёмка жителей в игре (нужен Chrome).

 * Проверяет то, что обещано игроку, а не то, что удобно проверить:
 *   1) атлас жителя загрузился и разобран: idle 6, walk 8, work 8, carry 8,
 *      walk_axe 8 и carry_put 4 на ВОСЕМЬ поворотов (через 45°), общая с
 *      лесорубом клетка и общая крупность мира; carry и walk_axe — циклы 12 к/с,
 *      carry_put — не цикл (им житель сдаёт брёвна в лагере);
 *   2) в начале партии РОВНО ТРИ жителя, у всех разные id («Житель №1», «№2»,
 *      «№3»), все появились на суше, не в воде и не в пятне постройки;
 *   3) прописка: вместимость дома жителя 4, трое в нём числятся, и список
 *      жильцов сходится с v.home; когда жителей больше, чем мест (count = 6),
 *      лишние остаются БЕЗДОМНЫМИ, и партия от этого не ломается;
 *   4) за N смоделированных минут НИ ОДИН житель не срубил дерево: счётчик
 *      деревьев в мире не менялся, анимации work не было ни кадра, дерево
 *      целью не выбиралось, а состояние всё время wander (или stand — если
 *      идти некуда);
 *   5) каждый житель ни разу не отошёл от СВОЕГО ЯКОРЯ дальше WANDER_R = 10
 *      клеток — замер максимума по кадрам, а не «на глаз»;
 *   6) ни одного шага в воду, в дерево, камень или постройку — для всех трёх,
 *      на каждом шаге симуляции (шаг — тот же, что в игровом цикле);
 *   7) тот же сид — та же прогулка: у всех трёх;
 *   8) скорость шага и рост человечка не изменились;
 *   9) все три живые попадают в общий поток отрисовки по глубине, и все три
 *      действительно нарисованы (пиксели кадра в габарите каждого спрайта);
 *  10) после перегенерации карты жителей снова трое, и гуляют они по НОВОЙ
 *      суше, а не по клеткам старого острова.

 * Кадры для глаза: крупный план жителя с сеткой, трое у своего дома, весь
 * остров с тремя прогулками и кругом радиуса 10 вокруг якоря.

 * Запуск: node tools/villager.js [url]
 *        VILLAGER_MINUTES=2 node tools/villager.js     # короткий прогон
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = require('./chrome.js');
/* Сид прогона задан в адресе, а не «какой выпадет»: приёмка должна быть
   воспроизводимой — иначе FAIL на одном острове не повторить на другом.
   Проверки при этом сформулированы так, чтобы держаться на любом сиде. */
const SEED = process.env.VILLAGER_SEED || 'житель-приёмка';
const url = process.argv[2] ||
  'file://' + path.join(__dirname, '..', 'index.html') + '?seed=' + encodeURIComponent(SEED);
const OUT = path.join(__dirname, 'out');
const PORT = 9700 + (process.pid % 200);
const PROFILE = '/tmp/dsh-villager-' + process.pid;

/* Сколько минут партии прожить в главном прогоне. Житель гуляет всё это время
   и не делает ничего другого, поэтому «долго» здесь дешёвое: 10 минут втроих
   — около четверти секунды счёта (замер без браузера: 224 мс). Шаги по 1/60 с. */
const MINUTES = +(process.env.VILLAGER_MINUTES || 10);
const DT = 1 / 60;

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--allow-file-access-from-files', '--hide-scrollbars',
  '--window-size=1400,900', 'about:blank'
], { stdio: 'ignore', detached: true });

/* Гасим Chrome ЦЕЛОЙ ГРУППОЙ процессов.

   kill по одному pid убивает только сам браузер, а его хелперы — рендерер,
   GPU, утилиты — остаются жить: страница в них продолжает крутиться на 60
   кадрах в секунду и есть процессор. Один прогон приёмки оставляет восемь
   таких процессов, пять прогонов — сорок, и машина занята целиком: композитор
   системы не успевает, и тормозит всё, включая игру в соседнем окне. Поэтому
   браузер запускается отдельной группой (detached), а гасится её номер. */
function killChrome() {
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) { /* уже погашен */ }
}

/* И на прерывании тоже: Ctrl-C по длинной приёмке не должен оставлять
   браузер работать. */
['SIGINT', 'SIGTERM'].forEach(function (sig) {
  process.on(sig, function () { killChrome(); process.exit(130); });
});


const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});

(async () => {
  for (let i = 0; i < 100; i++) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`); break; }
    catch (e) { await new Promise(r => setTimeout(r, 150)); }
  }
  const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));

  let id = 1; const pending = new Map(); const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(d.exception ? d.exception.description : d.text);
    }
  });
  const send = (method, params) => new Promise(r => {
    const i = id++; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const js = async (expr) => {
    const res = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return res.result.value;
  };
  const shoot = async (name, setup) => {
    if (setup) await js(setup);
    await new Promise(r => setTimeout(r, 350));
    const dataUrl = await js(`document.getElementById('view').toDataURL('image/png')`);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('  ' + name + '.png');
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 3600));

  console.log('жители в игре:');

  /* --- 1. атлас ------------------------------------------------------ */
  const atlas = await js(`(() => {
    const g = window.__mapgen, set = g.renderer.villagerSprites;
    if (!set) return null;
    const H = window.Hero, m = set.meta;
    const at = (rot) => {
      const s = H.sprite(set, { anim: 'walk', phase: 0.3, rot: rot });
      return s ? [s.sx, s.sy] : null;
    };
    return {
      ppu: set.ppu, mul: set.mul, img: [set.img.width, set.img.height],
      anims: set.anims, frames: Object.keys(m.frames).length,
      rots: set.rots,
      idle: H.frameCount(set, 'idle'), walk: H.frameCount(set, 'walk'),
      walkFps: H.fps(set, 'walk'),
      anchor: [m.frames.villager_idle_0_0.anchorX, m.frames.villager_idle_0_0.anchorY],
      cell: [m.frames.villager_idle_0_0.w, m.frames.villager_idle_0_0.h],
      // курс округляется до БЛИЖАЙШЕГО поворота: 20° -> 0°, 60° -> 45°, 80° -> 90°
      r0: at(0), r20: at(20), r45: at(45), r60: at(60), r80: at(80), r90: at(90), r180: at(180),
      f0: H.sprite(set, { anim: 'walk', phase: 0.01, rot: 0 }).sx,
      f1: H.sprite(set, { anim: 'walk', phase: 0.2, rot: 0 }).sx
    };
  })()`);
  check('атлас жителя загрузился', !!atlas, atlas ? atlas.img.join('×') : 'нет');
  if (!atlas) { finish(); return; }
  check('кадров 336: idle 6, walk 8, work 8, carry 8, walk_axe 8, carry_put 4 на восемь поворотов',
    atlas.frames === 336 && atlas.idle === 6 && atlas.walk === 8 &&
    !!(atlas.anims.carry && atlas.anims.carry.frames === 8 &&
       atlas.anims.carry.loop === true && atlas.anims.carry.fps === 12 &&
       atlas.anims.walk_axe && atlas.anims.walk_axe.frames === 8 &&
       atlas.anims.walk_axe.loop === true &&
       atlas.anims.carry_put && atlas.anims.carry_put.frames === 4 &&
       atlas.anims.carry_put.loop === false) &&
    atlas.rots.length === 8,
    `${atlas.frames} кадров, поворотов ${atlas.rots.length}: ${atlas.rots.join('/')}, ` +
    `анимации ${Object.keys(atlas.anims).map(k => k + ' ' + atlas.anims[k].frames).join(', ')}`);
  check('повороты идут через 45° — диагонали хода есть',
    atlas.rots.join(',') === '0,45,90,135,180,225,270,315', atlas.rots.join('/'));
  check('клетка и опора — как у лесоруба', atlas.cell.join('×') === '112×132' &&
    atlas.anchor[0] === 57 && atlas.anchor[1] === 107, atlas.cell.join('×') + ' опора ' + atlas.anchor.join(','));
  check('атлас объявляет крупность мира — общую с растительностью', atlas.mul === 1.35, 'mul ' + atlas.mul);
  check('курс округляется до ближайшего поворота: 20° — это 0°, 60° — это 45°',
    String(atlas.r20) === String(atlas.r0) && String(atlas.r60) === String(atlas.r45) &&
    String(atlas.r80) === String(atlas.r90),
    `20°->${atlas.r20} (0°->${atlas.r0}), 60°->${atlas.r60} (45°->${atlas.r45}), 80°->${atlas.r80} (90°->${atlas.r90})`);
  check('диагональные повороты нарисованы отдельно от осей',
    String(atlas.r45) !== String(atlas.r0) && String(atlas.r45) !== String(atlas.r90),
    '45° не совпал ни с 0°, ни с 90°');
  check('фаза меняет кадр внутри поворота', atlas.f0 !== atlas.f1, atlas.f0 + ' -> ' + atlas.f1);

  /* --- 1b. рост и шаг человечка в игре ------------------------------- *
   * Рост проверяется ЗАМЕРОМ, а не сверкой с константой: силуэт берётся из
   * самого кадра атласа (верхняя непрозрачная строка против пикселя опоры), а
   * рост переводится в клетки тем же scaleAt, которым рисует игра. Так одна и
   * та же проверка поймает и правку атласа, и правку масштаба.
   *
   * Заказчик (2026-10-13): «персонаж в игре слишком большой, уменьшить его в
   * масштабе в 2.2 раза». Тогда рост стал 0.54 клетки. Скорость шага —
   * 1.26 кл/с из анимации, делённая на тот же множитель: 0.573. Оба числа
   * решение игры, и прогулка их не меняет.
   *
   * 1.26 — ИЗМЕРЕННОЕ число, а не допущение (2026-10-16). Замер шага
   * (villager/tools/gait_probe.py): опорная ступня проходит под тазом
   * 0.286 юнита за полуцикл = 1.143 юн/с; 1 юнит = 78.4 px атласа, клетка =
   * 96 px при крупности 1, значит 1 юнит = 78.4·1.35/96 = 1.102 клетки,
   * отсюда 1.143·1.102 = 1.26. До этой правки замер давал 0.253 юнита и
   * 0.51 кл/с — игра шла на 13% быстрее рисунка (ступни подъезжали); шаг
   * анимации расширили и выровняли, а не подогнали скорость. Связь
   * «шаг <-> SPEED» проверяет МАШИНА: gait_probe читает строку SPEED прямо из
   * js/villager.js и падает при расхождении больше 3%. */
  const size = await js(`(() => {
    const g = window.__mapgen, V = window.Villagers, set = g.renderer.villagerSprites;
    const spr = V.sprite(set, { anim: 'idle', phase: 0, rot: 0 });
    const cv = document.createElement('canvas');
    cv.width = spr.sw; cv.height = spr.sh;
    const c2 = cv.getContext('2d');
    c2.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh, 0, 0, spr.sw, spr.sh);
    const d = c2.getImageData(0, 0, spr.sw, spr.sh).data;
    let top = -1;
    for (let y = 0; y < spr.sh && top < 0; y++)
      for (let x = 0; x < spr.sw; x++)
        if (d[(y * spr.sw + x) * 4 + 3] > 24) { top = y; break; }
    const feet = spr.ay * spr.sh;                 // пиксель кадра, куда ложится земля
    const body = feet - top;                      // рост в пикселях кадра, без тени
    const z = 96;                                 // зум не важен: рост считаем в клетках
    return {
      top: top, feet: feet, body: body, shrink: V.SHRINK, speed: V.SPEED,
      now: body * V.scaleAt(set, z) / z,          // рост в клетках, как его видит игра
      was: body * set.mul / z,                    // каким он был на крупности мира
      cell: [spr.sw, spr.sh]
    };
  })()`);
  check('рост человечка — 0.54 клетки, в 2.2 раза мельче прежнего',
    size.shrink === 2.2 && Math.abs(size.now - 0.537) < 0.02 && Math.abs(size.was / size.now - 2.2) < 0.01,
    `${size.now.toFixed(3)} клетки (было ${size.was.toFixed(2)}, силуэт ${size.body} px из ${size.cell[1]})`);
  /* Скорость: 1.26 кл/с — замер шага (ступня не едет), 1.1 — правило заказчика
     «быстрее на 10% без ускорения анимации» (js/villager.js: SPEED_BOOST). Оба
     множителя видны в коде игры, и оба тут проверяются: если кто-то поправит
     один, приёмка покраснеет. Связь «замер шага <-> SPEED_STEP» машинно
     проверяет villager/tools/gait_probe.py — он читает эти числа из файла. */
  check('скорость шага — из анимации, +10% заказчика, замедлена тем же множителем',
    Math.abs(size.speed - 1.26 * 1.1 / 2.2) < 1e-9, size.speed.toFixed(3) + ' клетки/с');

  /* --- 2. начало партии: три жителя ---------------------------------- *
   * Требование заказчика (2026-10-16): «в начале партии появляются ТРИ жителя,
   * у каждого есть идентификатор и прописка в доме». Проверяется всё, что тут
   * сказано, и порознь: число, разные id, суша под ногами, отсутствие воды и
   * пятна постройки под ними, дом как вместилище и прописка как поле жителя. */
  const born = await js(`(() => {
    const g = window.__mapgen, w = g.getWorld(), B = window.Buildings, S = window.Session;
    /* Жители появляются ЗАНОВО прямо здесь: страница открыта уже несколько
       секунд, и за это время те, что вышли при загрузке, успели отойти от
       дома. Проверка про появление обязана смотреть на появление, а не на
       «где их застали». */
    g.spawnVillagers(g.getBuildings()[0]);
    const list = g.getVillagers(), builds = g.getBuildings();
    const house = S.houseOf(builds);
    const door = house ? B.frontSpot(house) : null;
    const solid = window.Villagers.blockedMap(w, builds);
    const cellsIn = new Set();
    for (const b of builds) for (const c of B.cells(b)) cellsIn.add(c.x + ',' + c.y);
    const cell = (v) => [Math.floor(v.x), Math.floor(v.y)];
    return {
      n: list.length,
      ids: list.map(v => v.id),
      distinct: new Set(list.map(v => v.id)).size,
      names: list.map(v => S.villagerName(v)),
      states: list.map(v => v.state),
      cells: list.map(cell),
      distinctCells: new Set(list.map(v => cell(v).join(','))).size,
      onLand: list.filter(v => w.isLand[cell(v)[1] * w.width + cell(v)[0]]).length,
      inWater: list.filter(v => w.distWater[cell(v)[1] * w.width + cell(v)[0]] < 1).length,
      blocked: list.filter(v => solid[cell(v)[1] * w.width + cell(v)[0]]).length,
      inBuilding: list.filter(v => cellsIn.has(cell(v).join(','))).length,
      houseType: house ? B.typeOf(house) : null,
      capacity: B.housingCapacity(house),
      housed: list.filter(v => v.home === house).length,
      homeless: list.filter(v => v.home === null).length,
      residents: S.residentsOf(house, list).length,
      residentsMatch: S.residentsOf(house, list).every(v => v.home === house),
      door: door ? [door.x, door.y] : null,
      atDoor: list.filter(v => v.anchor &&
        Math.abs(v.anchor.x - (door.x + 0.5)) < 1e-9 &&
        Math.abs(v.anchor.y - (door.y + 0.5)) < 1e-9).length,
      anchors: list.map(v => [v.anchor.x, v.anchor.y]),
      trees: list.filter(v => !!v.tree).length,
      walking: list.filter(v => v.path && v.path.length > 1).length,
      radius: window.Villagers.WANDER_R
    };
  })()`);
  check('в начале партии ровно ТРИ жителя', born.n === 3, born.n + ' шт.');
  check('у всех разные id, и зовут их «Житель №1», «№2», «№3»',
    born.distinct === 3 && born.ids.join(',') === '1,2,3' &&
      born.names.join(' · ') === 'Житель №1 · Житель №2 · Житель №3',
    born.ids.join(',') + ' — ' + born.names.join(' · '));
  check('все появились на суше, не в воде и не в пятне постройки',
    born.onLand === 3 && born.inWater === 0 && born.blocked === 0 && born.inBuilding === 0,
    `на суше ${born.onLand}, в воде ${born.inWater}, в занятой ${born.blocked}, в постройке ${born.inBuilding}`);
  check('все трое вышли из дома и встали в разные клетки',
    born.distinctCells === 3 && born.cells.every(c => Math.abs(c[0] - born.door[0]) <= 2 && Math.abs(c[1] - born.door[1]) <= 2),
    'клетки ' + born.cells.map(c => c.join(',')).join(' · ') + ' против двери ' + born.door.join(','));
  check('прописка: дом жителя вмещает 4 и трое в нём числятся',
    born.houseType === 'house' && born.capacity === 4 && born.housed === 3 && born.residents === 3 &&
      born.residentsMatch && born.homeless === 0,
    `дом ${born.houseType}, вместимость ${born.capacity}, прописано ${born.housed}, ` +
    `жильцов по выборке ${born.residents}, бездомных ${born.homeless}`);
  check('якорь прогулки у каждого — клетка перед дверью своего дома',
    born.atDoor === 3,
    born.anchors.map(a => a.map(n => n.toFixed(1)).join(',')).join(' · ') +
    ' против двери ' + born.door.join(','));
  check('житель без работы дерево не ищет: цели нет ни у кого, а путь — прогулочный',
    born.trees === 0 && born.walking === 3 && born.states.every(s => s === 'wander'),
    `дерево-цель у ${born.trees}, путь есть у ${born.walking}, состояния ${born.states.join(',')}`);
  check('радиус прогулки — правило заказчика: ' + born.radius + ' клеток', born.radius === 10, String(born.radius));

  /* --- 2б. вместимость и бездомные ----------------------------------- *
   * Требование заказчика: дом первого уровня вмещает четырёх, и это свойство
   * ПОСТРОЙКИ (Buildings.housingCapacity), а не жителя. Проверяется тем, что
   * жителей ставят больше, чем мест: лишние обязаны остаться бездомными
   * (v.home = null), а партия — не сломаться: они так же гуляют и так же не
   * заходят в воду. */
  const over = await js(`(() => {
    const g = window.__mapgen, w = g.getWorld(), B = window.Buildings, S = window.Session;
    const builds = g.getBuildings(), home = builds[0], house = S.houseOf(builds);
    const six = S.spawnVillagers(w, g.renderer, builds, home, { count: 6 });
    const solid = window.Villagers.blockedMap(w, builds);
    const cell = (v) => [Math.floor(v.x), Math.floor(v.y)];
    // Проживаем немного: бездомный — не «выключенный», он гуляет как все.
    const before = six.map(v => [v.x, v.y]);
    for (let i = 0; i < 60 * 20; i++) S.stepVillagers(six, w, g.renderer, ${DT}, builds);
    const moved = six.map((v, i) => Math.hypot(v.x - before[i][0], v.y - before[i][1]));
    const out = {
      n: six.length,
      entities: {
        capacity: B.housingCapacity(house), houseType: B.typeOf(house),
        townhall: B.housingCapacity(builds[0]), camp: B.housingCapacity(builds[2]),
        junk: B.housingCapacity({ type: 'barn', level: 1 })
      },
      housed: six.filter(v => v.home === house).length,
      homeless: six.filter(v => v.home === null).length,
      homeIsHouse: six.filter(v => v.home && B.typeOf(v.home) === 'house').length,
      homeowners: six.map(v => !!v.home),
      anchors: six.map(v => [v.anchor.x, v.anchor.y]),
      water: six.filter(v => !w.isLand[cell(v)[1] * w.width + cell(v)[0]] ||
        solid[cell(v)[1] * w.width + cell(v)[0]]).length,
      states: six.map(v => v.state),
      moved: moved, minMoved: Math.min.apply(null, moved),
      grew: six.map(v => v.id)
    };
    // Партия продолжается обычными тремя: шесть были проверкой, а не новым миром.
    g.spawnVillagers(home);
    return out;
  })()`);
  check('дом первого уровня вмещает ровно 4, остальные типы — 0',
    over.entities.capacity === 4 && over.entities.townhall === 0 && over.entities.camp === 0 &&
      over.entities.junk === 0,
    `дом ${over.entities.capacity}, ратуша ${over.entities.townhall}, лагерь ${over.entities.camp}, ` +
    `неизвестный тип ${over.entities.junk}`);
  check('жителей больше, чем мест: лишние остаются бездомными (count = 6 → 4 + 2)',
    over.n === 6 && over.housed === 4 && over.homeless === 2 && over.homeIsHouse === 4,
    `${over.n} жителей: в доме ${over.housed}, бездомных ${over.homeless}, ` +
    `прописка ${over.homeowners.map(h => h ? 'дом' : 'нет').join('/')}`);
  check('бездомный не сломал партию: он живёт и гуляет как все',
    over.water === 0 && over.minMoved > 0.5 && over.states.every(s => s === 'wander' || s === 'stand'),
    `за 20 с сдвинулись на ${over.moved.map(m => m.toFixed(1)).join('/')} клетки, ` +
    `в воде или занятом ${over.water}, состояния ${over.states.join(',')}`);
  check('id идут по порядку появления и не повторяются',
    over.grew.join(',') === '1,2,3,4,5,6', over.grew.join(','));
  check('дом и после лишних жителей — по-прежнему дом',
    (await js(`(() => {
      const g = window.__mapgen, S = window.Session;
      const list = g.getVillagers(), house = S.houseOf(g.getBuildings());
      return list.length === 3 && S.residentsOf(house, list).length === 3;
    })()`)),
    'в партии снова трое, все прописаны');

  /* --- 3. их двигает сам игровой цикл -------------------------------- *
   * Прогоны ниже шагают симуляцию руками, и без этой проверки опечатка в
   * вызове stepVillagers из цикла осталась бы незамеченной: жители стояли бы
   * на месте в игре и ходили только в тесте. */
  const live = await js(`(async () => {
    const g = window.__mapgen, list = g.getVillagers();
    const from = list.map(v => [v.x, v.y]);
    const anims = new Set(list.map(v => v.anim));
    let moved = [0, 0, 0];
    for (let i = 0; i < 48; i++) {
      await new Promise(r => setTimeout(r, 250));
      for (let k = 0; k < list.length; k++) anims.add(list[k].anim);
      moved = list.map((v, k) => Math.hypot(v.x - from[k][0], v.y - from[k][1]));
      if (Math.min.apply(null, moved) > 0.5) break;
    }
    return { moved: moved, anims: [...anims], walked: list.map(v => v.walked),
             states: list.map(v => v.state) };
  })()`);
  check('всех трёх двигает сам игровой цикл, без вмешательства теста',
    live.moved.every(m => m > 0.5),
    `сдвинулись на ${live.moved.map(m => m.toFixed(2)).join('/')} клетки, анимации: ${live.anims.join(', ')}`);

  /* --- 4. прогулка: N минут без рубки, в круге, по суше -------------- *
   * Главный прогон. Шагает симуляцию сам (stepVillagers — тот же код, что в
   * игровом цикле) и на КАЖДОМ шаге смотрит клетку под каждым жителем: вода,
   * дерево/камень и пятно постройки считаются отдельно, и ни одного такого
   * шага быть не должно. Он это делает не потому, что «проверяем на каждом
   * шаге», а потому что путь так посчитан: прямая не задевает занятых клеток
   * (lineClear), а между точками пути живёт ровно одна прямая.
   *
   * Здесь же меряется удаление от ЯКОРЯ (клетка перед дверью дома): требование
   * заказчика — не дальше WANDER_R клеток. Меряется максимум по кадрам, а не
   * «на глаз»: круг выпуклый, поэтому достаточно, чтобы в нём лежали точки
   * маршрута (planWander), но проверить это обязан тест, а не рассуждение.
   *
   * Третье число — самое близкое расстояние до ствола за весь прогон. Рубка
   * подходит к дереву на STAND_OFF = 0.30 (житель придвигается к коре), и
   * «не подходил вплотную» значит «не подходил так, как подходит рубящий»:
   * гуляющий ходит по свободным клеткам, а ствол стоит в СВОЕЙ клетке. */
  const STEPS = Math.round(MINUTES * 60 / DT);
  const sim = await js(`(() => {
    const g = window.__mapgen, V = window.Villagers, S = window.Session, B = window.Buildings;
    g.newGame();                       // свежая партия: жители только что вышли из дома
    const w = g.getWorld(), list = g.getVillagers(), builds = g.getBuildings();
    const solid = V.blockedMap(w, builds);
    const trees0 = w.stats ? w.stats.trees : null;
    // Деревья в круге прогулки (±2 клетки запаса): житель дальше круга не
    // уходит, поэтому «ближайшее дерево» ищется по ним, а не по всему лесу.
    const near = list.map(v => w.objects.filter(o => o.kind === 'tree' &&
      Math.hypot(o.x - v.anchor.x, o.y - v.anchor.y) < V.WANDER_R + 2));
    const st = list.map(() => ({ max: 0, minTree: Infinity, states: {}, anims: {},
                                 stand: 0, trips: 0, walked: 0 }));
    const trail = list.map(() => []);
    let water = 0, blocked = 0, outside = 0, badRot = 0, badPhase = 0;
    let work = 0, badState = 0, picked = 0, felled = 0;
    for (let s = 0; s < ${STEPS}; s++) {
      g.stepVillagers(${DT});
      for (let i = 0; i < list.length; i++) {
        const v = list[i], one = st[i];
        const cx = Math.floor(v.x), cy = Math.floor(v.y);
        if (cx < 0 || cy < 0 || cx >= w.width || cy >= w.height) outside++;
        else if (!w.isLand[cy * w.width + cx]) water++;
        else if (solid[cy * w.width + cx]) blocked++;
        if (!(v.rot >= 0 && v.rot < 360)) badRot++;
        if (!(v.phase >= 0 && v.phase < 1)) badPhase++;
        if (v.anim === 'work') work++;
        if (v.state !== 'wander' && v.state !== 'stand') badState++;
        if (v.tree) picked++;
        felled = Math.max(felled, v.felled);
        one.states[v.state] = (one.states[v.state] || 0) + 1;
        one.anims[v.anim] = (one.anims[v.anim] || 0) + 1;
        if (v.state === 'stand') one.stand++;
        one.max = Math.max(one.max, Math.hypot(v.x - v.anchor.x, v.y - v.anchor.y));
        for (const t of near[i]) {
          const d = Math.hypot(v.x - t.x, v.y - t.y);
          if (d < one.minTree) one.minTree = d;
        }
        /* След для кадра — с прореживанием по расстоянию: за 10 минут житель
           проходит 340 клеток, и точка на каждый шестой кадр дала бы тысячи
           узлов там, где ломаная из шага в четверть клетки выглядит так же. */
        const last = trail[i][trail[i].length - 1];
        if (!last || Math.hypot(v.x - last[0], v.y - last[1]) >= 0.25)
          trail[i].push([+v.x.toFixed(2), +v.y.toFixed(2)]);
      }
    }
    st.forEach((one, i) => { one.trips = list[i].trips; one.walked = list[i].walked; });
    const trees1 = w.stats ? w.stats.trees : null;
    return {
      steps: ${STEPS}, minutes: ${MINUTES}, n: list.length,
      max: st.map(o => o.max), minTree: st.map(o => o.minTree),
      states: st.map(o => o.states), anims: st.map(o => o.anims),
      stand: st.map(o => o.stand), trips: st.map(o => o.trips), walked: st.map(o => o.walked),
      water: water, blocked: blocked, outside: outside,
      badRot: badRot, badPhase: badPhase, work: work, badState: badState, picked: picked,
      felled: felled, trees0: trees0, trees1: trees1,
      radius: V.WANDER_R, standOff: V.STAND_OFF,
      anchors: list.map(v => [v.anchor.x, v.anchor.y]),
      trail: trail
    };
  })()`);
  const mm = (n) => n.toFixed(2);
  check('за ' + MINUTES + ' минут ни одного срубленного дерева',
    sim.trees1 === sim.trees0 && sim.felled === 0,
    `деревьев ${sim.trees0} -> ${sim.trees1}, жители срубили ${sim.felled}`);
  check('и ни разу не играли анимацию работы, и дерево не выбирали целью',
    sim.work === 0 && sim.picked === 0,
    `кадров анимации work: ${sim.work}, кадров с деревом-целью: ${sim.picked}`);
  check('всё время в состоянии wander (или stand, если идти некуда)',
    sim.badState === 0,
    sim.states.map((s, i) => '№' + (i + 1) + ' ' + JSON.stringify(s)).join(' · ') +
    (sim.badState ? ` — ВНЕ ЭТИХ СОСТОЯНИЙ ${sim.badState} кадров` : ''));
  check('ни один не отошёл от своего якоря дальше ' + sim.radius + ' клеток',
    sim.max.every(d => d <= sim.radius + 1e-9),
    'максимум от якоря: ' + sim.max.map((d, i) => '№' + (i + 1) + ' ' + d.toFixed(3)).join(' · ') +
    ' клетки');
  check('к дереву не подходил так близко, как подходит рубящий (STAND_OFF ' + sim.standOff + ')',
    sim.minTree.every(d => d >= sim.standOff),
    'ближе всего к стволу: ' + sim.minTree.map((d, i) => '№' + (i + 1) + ' ' + mm(d)).join(' · ') +
    ' клетки');
  check('ни одного шага в воду за ' + MINUTES + ' минут',
    sim.water === 0 && sim.outside === 0,
    `${sim.water} шагов в воде, ${sim.outside} за картой из ${sim.steps}`);
  check('ни одного шага в дерево, камень или постройку', sim.blocked === 0, sim.blocked + ' шагов');
  check('курс свободный, но всегда в [0, 360), фаза анимации — в [0, 1)',
    sim.badRot === 0 && sim.badPhase === 0, `${sim.badRot} / ${sim.badPhase}`);
  check('жители ходят, а не стоят: каждый прошёл десятки клеток',
    sim.walked.every(w => w > 15 * MINUTES) && sim.trips.every(t => t > MINUTES / 2),
    'пройдено ' + sim.walked.map((w, i) => '№' + (i + 1) + ' ' + w.toFixed(0)).join(' · ') +
    ' клетки за ' + sim.trips.map((t, i) => '№' + (i + 1) + ' ' + t).join('/') + ' переходов' +
    (sim.stand.some(s => s) ? '; в stand кадров: ' + sim.stand.join('/') : ''));

  /* --- 4б. тот же сид — та же прогулка ------------------------------- *
   * ГПСЧ у каждого жителя свой (от сида мира и номера), и Math.random в
   * движке нет вовсе: прогулка обязана повторяться до знака. Проверяется
   * двумя прогонами с НОВОГО появления жителей: сравниваются точки каждую
   * секунду — все три жителя, а не только первый. */
  const again = await js(`(() => {
    const g = window.__mapgen, DT = ${DT};
    const walk = () => {
      g.spawnVillagers(g.getBuildings()[0]);
      const list = g.getVillagers(), pts = [];
      for (let i = 0; i < 60 * 120; i++) {
        g.stepVillagers(DT);
        if (i % 60 === 0) pts.push(list.map(v => [+v.x.toFixed(4), +v.y.toFixed(4)]));
      }
      return pts;
    };
    const a = walk(), b = walk();
    const same = JSON.stringify(a) === JSON.stringify(b);
    // Пройденное каждым: «тот же путь» без «он вообще шёл» ничего не стоит.
    const span = a[0].map((_, k) => {
      let s = 0;
      for (let i = 1; i < a.length; i++)
        s += Math.hypot(a[i][k][0] - a[i-1][k][0], a[i][k][1] - a[i-1][k][1]);
      return s;
    });
    return { same: same, first: a[0], last: a[a.length - 1], span: span, samples: a.length };
  })()`);
  check('тот же сид — та же прогулка у всех трёх',
    again.same && again.samples > 100,
    `${again.samples} замеров: ` + JSON.stringify(again.first[0]) + ' -> ' +
    JSON.stringify(again.last[0]) + ' (первый житель)');
  check('и они действительно идут, а не стоят',
    again.span.every(s => s > 20), 'пройдено за две минуты: ' +
    again.span.map(s => s.toFixed(1)).join('/') + ' клетки');

  /* --- 5. порядок глубины -------------------------------------------- */
  const order = await js(`(() => {
    const g = window.__mapgen, r = g.renderer;
    const seq = [];
    r.eachSprite(
      (o) => seq.push(['объект', o.x + o.y]),
      (b) => seq.push(['дом', window.Buildings.depth(b)]),
      (v) => seq.push(['житель', v.x + v.y]));
    let bad = 0, walkers = 0, prev = -Infinity;
    for (const [kind, key] of seq) {
      if (key < prev - 1e-6) bad++;
      if (kind === 'житель') walkers++;
      prev = key;
    }
    return { n: seq.length, bad, walkers, inGame: g.getVillagers().length };
  })()`);
  check('в общий поток отрисовки попадают все три жителя',
    order.walkers === 3 && order.inGame === 3, order.walkers + ' из ' + order.n + ' спрайтов');
  check('порядок глубины не убывает (x + y)', order.bad === 0, order.bad + ' нарушений');

  /* --- 6. все три нарисованы ----------------------------------------- *
   * Сравниваются два кадра ОДНОГО времени: со слоем жителей и без него.
   * Разницу внутри габарита КАЖДОГО спрайта считаем фигурой — так проверка
   * отвечает на вопрос «нарисованы ли все трое», а не «нарисован ли кто-нибудь».
   * Фигуры ставятся в чистый двор перед домом, и это не поблажка: в чаще их
   * закрывают кроны деревьев, которые по глубине ближе камеры (x + y больше),
   * и «не нарисован» означало бы не то, что случилось, — на это тест уже
   * попадался. Проверка здесь про слой отрисовки, а не про видимость в лесу.
   *
   * Вне габаритов спрайтов на суше не должно измениться ничего; на воде Chrome
   * даёт дрожание в пару единиц (рябь заливается умножением на весь кадр), и
   * такое дрожание считается отдельно. */
  const drawn = await js(`(() => {
    const g = window.__mapgen, r = g.renderer, B = window.Buildings, w = g.getWorld();
    const V = window.Villagers, S = window.Session;
    g.spawnVillagers(g.getBuildings()[0]);
    const list = g.getVillagers();
    const house = S.houseOf(g.getBuildings()), c = B.center(house);
    const solid = V.blockedMap(w, g.getBuildings());
    // Свободные клетки строго ПЕРЕД домом, по возрастанию расстояния до него.
    const spots = [];
    for (let x = Math.floor(c.x) - 7; x <= Math.floor(c.x) + 7; x++)
      for (let y = Math.floor(c.y) - 7; y <= Math.floor(c.y) + 7; y++) {
        const k = y * w.width + x;
        if (x < 1 || y < 1 || x >= w.width - 1 || y >= w.height - 1) continue;
        if (!w.isLand[k] || solid[k]) continue;
        const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
        if (d < 3 || (x + y + 1) < (c.x + c.y) + 4) continue;   // строго перед домом
        spots.push({ x: x + 0.5, y: y + 0.5 });
      }
    spots.sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y));
    const placed = [];
    for (const s of spots) {
      if (placed.some(p => Math.hypot(p.x - s.x, p.y - s.y) < 2)) continue;
      placed.push(s);
      if (placed.length === list.length) break;
    }
    for (let i = 0; i < list.length && i < placed.length; i++) {
      const v = list[i];
      v.x = placed[i].x; v.y = placed[i].y;
      v.path = null; v.state = 'stand'; v.anim = 'idle'; v.phase = 0;
    }
    const cv = r.canvas, ctx = cv.getContext('2d');
    r.cam.zoom = 96;
    r.centerOn(c.x, c.y + 2);
    r.hover = null;
    const boxes = list.map(v => r.villagerBox(v, r.cam.zoom));
    const dpr = r.dpr;
    const want = boxes.map(box => ({
      x0: (r.cssW / 2 + box.dx) * dpr, y0: (r.cssH / 2 + box.dy) * dpr,
      x1: (r.cssW / 2 + box.dx + box.dw) * dpr, y1: (r.cssH / 2 + box.dy + box.dh) * dpr
    }));
    const grab = () => ctx.getImageData(0, 0, cv.width, cv.height).data;
    r.showVillagers = true;  r.render(1); const a = grab();
    r.showVillagers = false; r.render(1); const b = grab();
    r.showVillagers = true;

    const VISIBLE = 30;
    let n = 0, noise = 0, onLand = 0, onWater = 0, worst = 0, worstAt = null;
    const per = want.map(() => 0);
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i+1] - b[i+1]) + Math.abs(a[i+2] - b[i+2]);
      if (d < 12) continue;
      const px = (i / 4) % cv.width, py = Math.floor((i / 4) / cv.width);
      let inside = -1;
      for (let k = 0; k < want.length; k++) {
        const q = want[k];
        if (px >= q.x0 - 2 && px <= q.x1 + 2 && py >= q.y0 - 2 && py <= q.y1 + 2) { inside = k; break; }
      }
      if (inside >= 0) { n++; per[inside]++; continue; }
      if (d < VISIBLE) { noise++; continue; }
      const wp = r.screenToWorld(px / dpr - r.cssW / 2, py / dpr - r.cssH / 2);
      const wx = Math.floor(wp.x), wy = Math.floor(wp.y);
      const on = wx >= 0 && wy >= 0 && wx < w.width && wy < w.height && !!w.isLand[wy * w.width + wx];
      if (on) onLand++; else onWater++;
      if (d > worst) { worst = d; worstAt = [wx, wy, on, d]; }
    }
    // exportPNG обязан показывать то же, что экран: слой в нём тоже есть.
    const e1 = r.exportPNG(1);
    r.showVillagers = false;
    const e2 = r.exportPNG(1);
    r.showVillagers = true;
    let exp = 0;
    const g1 = e1.getContext('2d').getImageData(0,0,e1.width,e1.height).data;
    const g2 = e2.getContext('2d').getImageData(0,0,e2.width,e2.height).data;
    for (let i = 0; i < g1.length; i += 4) if (g1[i] !== g2[i] || g1[i+1] !== g2[i+1]) exp++;
    // Земля под ногами: пиксель кадра, куда проецируется точка опоры спрайта.
    const feet = boxes.map(box => (r.cssH / 2 + box.dy + box.dh * (1 - box.spr.ay)) * dpr);
    return {
      n: n, per: per, noise: noise, onLand: onLand, onWater: onWater, worst: worst, worstAt: worstAt,
      placed: placed.length, spots: spots.length,
      boxes: want, feet: feet,
      dw: boxes.map(b => +b.dw.toFixed(1)), dh: boxes.map(b => +b.dh.toFixed(1)),
      exp: exp, expScale: Math.pow(r.cachePx / r.cam.zoom, 2)
    };
  })()`);
  check('все три жителя нарисованы — у каждого свои пиксели в кадре',
    drawn.placed === 3 && drawn.per.every(p => p > 200),
    `пикселей по жителям: ${drawn.per.join('/')} (всего ${drawn.n}), ` +
    `кадры ${drawn.dw.join('×')} × ${drawn.dh.join('×')} px`);
  check('вне габаритов спрайтов на суше не изменилось ничего', drawn.onLand === 0,
    drawn.onLand ? `${drawn.onLand} пикселей суши, худший ${JSON.stringify(drawn.worstAt)}` : 'ни одного');
  check('на воде — только дрожание растеризации', drawn.onWater <= 200,
    `${drawn.onWater} пикселей воды` +
    (drawn.worst ? `, худший ${drawn.worst} единиц в клетке ${drawn.worstAt[0]},${drawn.worstAt[1]}` : '') +
    (drawn.noise ? `; всего дрожания ${drawn.noise} пикселей` : ''));
  check('ноги стоят на земле клетки у каждого',
    drawn.feet.every((f, i) => f > drawn.boxes[i].y0 && f < drawn.boxes[i].y1 + 1),
    drawn.feet.map(f => f.toFixed(0)).join('/') + ' в силуэтах ' +
    drawn.boxes.map(b => b.y0.toFixed(0) + '..' + b.y1.toFixed(0)).join(' / '));
  const expWant = Math.max(25, drawn.n * drawn.expScale * 0.5);
  check('в экспорт PNG жители тоже попадают', drawn.exp >= expWant,
    `${drawn.exp} пикселей при ${drawn.n} на экране ` +
    `(в экспорте масштаб x${Math.sqrt(drawn.expScale).toFixed(2)}, ждали от ${Math.round(expWant)})`);

  /* --- 7. кадры ------------------------------------------------------ */
  console.log('кадры:');

  /* Крупный план: сетка включена, клетка под жителем подсвечена — по нему
   * видно, что он стоит НА клетке, а не висит над ней и не провалился. */
  await js(`(() => {
    const g = window.__mapgen;
    g.spawnVillagers(g.getBuildings()[0]);
    return 1;
  })()`);
  await shoot('villager-zoom', `(() => {
    const g = window.__mapgen, r = g.renderer, v = g.getVillagers()[0];
    const V = window.Villagers, B = window.Buildings, w = g.getWorld();
    const home = g.getBuildings()[0], c = B.center(home);
    const solid = V.blockedMap(w, g.getBuildings());
    let best = null;
    for (let x = Math.floor(c.x) - 6; x <= Math.floor(c.x) + 6; x++)
      for (let y = Math.floor(c.y) - 6; y <= Math.floor(c.y) + 6; y++) {
        const k = y * w.width + x;
        if (x < 1 || y < 1 || x >= w.width - 1 || y >= w.height - 1) continue;
        if (!w.isLand[k] || solid[k]) continue;
        const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
        if (d < 2.6 || (x + y + 1) < (c.x + c.y) + 2.5) continue;
        if (!best || d < best.d) best = { x: x + 0.5, y: y + 0.5, d: d };
      }
    if (best) {
      v.x = best.x; v.y = best.y;
      /* Стоять он будет не «пока не надоест»: житель без работы, которому идти
         некуда, через WANDER_RETRY (1 с) пробует снова и уходит. Кадр снимается
         через треть секунды после постановки, а сброс stuck отодвигает попытку
         на секунду вперёд — иначе на кадре была бы пустая лужайка. */
      v.path = null; v.state = 'stand'; v.anim = 'idle'; v.phase = 0; v.rot = 0;
      v.stuck = 0;
    }
    r.cam.zoom = 110;
    r.centerOn(v.x, v.y - 0.15);
    r.showGrid = true;
    r.hover = { x: Math.floor(v.x), y: Math.floor(v.y) };
    return best ? 1 : 0;
  })()`);

  /* Трое у своего дома — тот самый кадр, ради которого задача делалась: видно,
   * что жителей ТРИ, что они разные (разные номера и позы) и что все они
   * собрались у двери дома, а не разошлись по острову. Кадр СТАВИТСЯ, а не
   * ловится: за время съёмки они успели бы разойтись в разные стороны. */
  const trio = await js(`(() => {
    const g = window.__mapgen, r = g.renderer, B = window.Buildings;
    const V = window.Villagers, S = window.Session, w = g.getWorld();
    g.spawnVillagers(g.getBuildings()[0]);
    const list = g.getVillagers();
    const house = S.houseOf(g.getBuildings());
    const door = B.frontSpot(house), c = B.center(house);
    const solid = V.blockedMap(w, g.getBuildings());
    // Клетка перед дверью и две соседние с ней: жители встают в ряд у входа.
    const around = [];
    for (let dx = -2; dx <= 2; dx++)
      for (let dy = -1; dy <= 2; dy++) {
        const x = door.x + dx, y = door.y + dy;
        const k = y * w.width + x;
        if (x < 1 || y < 1 || x >= w.width - 1 || y >= w.height - 1) continue;
        if (!w.isLand[k] || solid[k]) continue;
        around.push({ x: x + 0.5, y: y + 0.5, d: Math.abs(dx) + Math.abs(dy) });
      }
    around.sort((a, b) => a.d - b.d);
    const spots = [];
    for (const s of around) {
      if (spots.some(p => Math.hypot(p.x - s.x, p.y - s.y) < 1.5)) continue;
      spots.push(s);
      if (spots.length === list.length) break;
    }
    for (let i = 0; i < list.length && i < spots.length; i++) {
      list[i].x = spots[i].x; list[i].y = spots[i].y;
      list[i].path = null; list[i].state = 'stand'; list[i].anim = 'idle';
      list[i].phase = i / list.length;            // разные кадры покоя: видно, что их трое
      list[i].rot = 90 + i * 45;
      // Запертыми они себя не считают — просто стоят секунду до новой точки
      // прогулки; кадр снимается раньше (см. villager-zoom).
      list[i].stuck = 0;
    }
    r.showGrid = false;
    r.hover = null;
    r.showVillagers = true;
    r.cam.zoom = 96;
    r.centerOn(c.x, c.y + 1.6);
    return { spots: spots.length, n: list.length, door: [door.x, door.y],
             names: list.map(v => S.villagerName(v)), at: spots.map(s => [s.x, s.y]) };
  })()`);
  await shoot('villager-three', null);
  check('кадр «трое у дома»: все три жителя стоят у двери своего дома',
    trio.spots === 3 && trio.n === 3,
    trio.names.join(' · ') + ' у двери ' + trio.door.join(','));

  /* Весь остров и прогулки всех трёх — из ГЛАВНОГО прогона (sim), а не
   * прожитые заново: это те самые шаги, что проверены выше, и остров на
   * картинке тот же. Круг радиуса WANDER_R вокруг якоря рисуется затем, чтобы
   * «не дальше 10 клеток» было видно глазом, а не только числом. */
  const islandShot = async (name, opts) => {
    const data = await js(`(() => {
      const g = window.__mapgen, r = g.renderer;
      const o = ${JSON.stringify(opts)};
      const src = r.exportPNG(1);
      const k = Math.min(1, 1500 / src.width);
      const cv = document.createElement('canvas');
      cv.width = Math.round(src.width * k);
      cv.height = Math.round(src.height * k);
      const g2 = cv.getContext('2d');
      g2.imageSmoothingEnabled = true;
      g2.drawImage(src, 0, 0, cv.width, cv.height);
      const cpx = r.cachePx, off = r.cacheOffset;
      const to = (x, y) => [((x - y) * 0.5 * cpx + off.x) * k, ((x + y) * 0.25 * cpx + off.y) * k];
      const drawDot = (xy, color, r0) => {
        const p = to(xy[0], xy[1]);
        g2.fillStyle = color;
        g2.beginPath(); g2.arc(p[0], p[1], r0 || 5, 0, 7); g2.fill();
      };
      for (const c of (o.circles || [])) {
        g2.beginPath();
        for (let i = 0; i <= 96; i++) {
          const a = i / 96 * Math.PI * 2;
          const p = to(c.x + Math.cos(a) * c.r, c.y + Math.sin(a) * c.r);
          if (i === 0) g2.moveTo(p[0], p[1]); else g2.lineTo(p[0], p[1]);
        }
        g2.closePath();
        g2.strokeStyle = c.color || 'rgba(255,255,255,0.8)';
        g2.lineWidth = 1.3;
        g2.setLineDash([5, 4]);
        g2.stroke();
        g2.setLineDash([]);
      }
      for (const t of (o.trails || [])) {
        const pts = t.points;
        g2.lineWidth = 1.2;
        g2.strokeStyle = t.color;
        g2.beginPath();
        for (let i = 0; i < pts.length; i++) {
          const p = to(pts[i][0], pts[i][1]);
          if (i === 0) g2.moveTo(p[0], p[1]); else g2.lineTo(p[0], p[1]);
        }
        g2.stroke();
        if (pts.length) {
          drawDot(pts[0], t.color, 3.4);
          drawDot(pts[pts.length - 1], '#c8281a', 3.4);
        }
      }
      for (const a of (o.anchors || [])) drawDot(a, '#fff2c4', 3.2);
      g2.fillStyle = 'rgba(0,0,0,0.55)';
      g2.fillRect(0, 0, cv.width, 26);
      g2.fillStyle = '#fff';
      g2.font = '600 15px -apple-system, Segoe UI, Roboto, sans-serif';
      g2.fillText(o.title || '', 10, 18);
      return cv.toDataURL('image/png');
    })()`);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data.split(',')[1], 'base64'));
    console.log('  ' + name + '.png');
  };

  const TRAIL_COLORS = ['#2f8f3f', '#1d5fbf', '#8a3fbf'];
  await islandShot('villager-trail', {
    trails: sim.trail.map((points, i) => ({ points: points, color: TRAIL_COLORS[i % 3] })),
    anchors: sim.anchors,
    circles: sim.anchors.map(a => ({ x: a[0], y: a[1], r: sim.radius,
      color: 'rgba(255,255,255,0.75)' })),
    title: 'прогулки трёх жителей за ' + MINUTES + ' мин: пунктир — круг радиуса ' +
      sim.radius + ' вокруг якоря, максимум вышел ' +
      sim.max.map(d => d.toFixed(2)).join('/') + ' клетки, срублено ' +
      (sim.trees0 - sim.trees1) + ' деревьев'
  });

  /* --- 8. перегенерация карты ---------------------------------------- *
   * «Сгенерировать» в панели и `R` строят ДРУГОЙ мир, а путь жителя — это
   * клетки того мира, на котором он его считал. Забыть про это легко: житель
   * остаётся с прошлым путём и идёт по воде нового острова. Кнопка тут
   * настоящая, из панели, — тест жмёт её, а не зовёт функцию. */
  const regen = await js(`(() => {
    const g = window.__mapgen, V = window.Villagers, S = window.Session, B = window.Buildings;
    document.getElementById('seed').value = 'житель-перегенерация';
    document.getElementById('regen').click();
    const w = g.getWorld(), list = g.getVillagers(), builds = g.getBuildings();
    if (!list.length) return { n: 0 };
    const solid = V.blockedMap(w, builds);
    const house = S.houseOf(builds);
    const W = w.width;
    let water = 0, blocked = 0, off = 0, steps = 0;
    const max = list.map(() => 0);
    const states = list.map(() => ({}));
    while (steps < 180 * 60) {
      g.stepVillagers(${DT});
      steps++;
      for (let i = 0; i < list.length; i++) {
        const v = list[i], cx = Math.floor(v.x), cy = Math.floor(v.y);
        if (cx < 0 || cy < 0 || cx >= W || cy >= w.height) off++;
        else if (!w.isLand[cy * W + cx]) water++;
        else if (solid[cy * W + cx]) blocked++;
        states[i][v.state] = (states[i][v.state] || 0) + 1;
        max[i] = Math.max(max[i], Math.hypot(v.x - v.anchor.x, v.y - v.anchor.y));
      }
    }
    const cell = (v) => [Math.floor(v.x), Math.floor(v.y)];
    return {
      n: list.length, water: water, blocked: blocked, off: off, steps: steps,
      max: max, states: states, radius: V.WANDER_R,
      housed: list.filter(v => v.home === house).length,
      land: list.every(v => !!w.isLand[cell(v)[1] * W + cell(v)[0]]),
      cells: V.landCells(w).length,
      walked: list.map(v => Math.round(v.walked)),
      trees: w.stats ? w.stats.trees : null
    };
  })()`);
  check('после перегенерации карты жителей снова трое, и все прописаны',
    regen.n === 3 && regen.housed === 3, regen.n + ' шт., прописано ' + regen.housed);
  check('на новом острове они гуляют по НОВОЙ суше, а не по старой',
    regen.water === 0 && regen.blocked === 0 && regen.off === 0 && regen.land,
    `${regen.water} в воде, ${regen.blocked} в занятом, ${regen.off} за картой; ` +
    `суши на острове ${regen.cells} клеток`);
  check('и на новом острове они не выходят из своего круга',
    regen.max.every(d => d <= regen.radius + 1e-9),
    'максимум от якоря: ' + regen.max.map(d => d.toFixed(2)).join('/') + ' клетки за ' +
    (regen.steps / 60).toFixed(0) + ' с');
  check('на новом острове они тоже гуляют, а не стоят',
    regen.walked.every(w => w > 20) && regen.states.every(s =>
      Object.keys(s).every(k => k === 'wander' || k === 'stand')),
    'пройдено ' + regen.walked.join('/') + ' клеток, состояния ' +
    regen.states.map(s => JSON.stringify(s)).join(' · '));

  console.log('\nитог прогулки: ' + (sim.steps / 60).toFixed(0) + ' с на троих, ' +
    'максимум от якоря ' + sim.max.map(d => d.toFixed(2)).join('/') + ' клетки при радиусе ' +
    sim.radius + ', ближе всего к стволу ' + sim.minTree.map(d => d.toFixed(2)).join('/') +
    ' клетки, срублено деревьев ' + (sim.trees0 - sim.trees1));

  if (errors.length) { console.log('\nошибки:'); errors.forEach(e => console.log('  ' + e)); }
  else console.log('\nошибок в консоли нет');

  finish();

  function finish() {
    console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nИТОГ: ПРИНЯТО');
    ws.close(); killChrome();
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    process.exit(fails ? 1 : 0);
  }
})().catch(e => { console.error('ошибка: ' + e.message); killChrome(); process.exit(1); });
