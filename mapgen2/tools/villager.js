/* villager.js — приёмка жителя в игре (нужен Chrome).

 * Проверяет то, что обещано игроку, а не то, что удобно проверить:
 *   1) атлас жителя загрузился и разобран: idle 6, walk 8, work 8 на ВОСЕМЬ
 *      поворотов (через 45°), общая с лесорубом клетка и общая крупность мира;
 *   2) житель в игре есть: один, на суше, вне пятна ратуши;
 *   3) его двигает сам игровой цикл, а не только тест;
 *   4) он идёт к БЛИЖАЙШЕМУ ДОСТИЖИМОМУ дереву и доходит до клетки рядом с
 *      ним — и за весь путь ни разу не встаёт ни в воду, ни в дерево, камень
 *      или дом: не «в конце пути», а на каждом шаге симуляции;
 *   5) идёт ПО ПРЯМОЙ, а не зигзагом по клеткам: если ничто не мешает, след
 *      отклоняется от прямой меньше чем на треть клетки, а если мешает — путь
 *      всё равно не длиннее кратчайшего клеточного (то есть обход ближайший,
 *      а не «какой-нибудь»);
 *   6) курс свободный (не только четыре оси), а кадр берётся ближайший из
 *      восьми: у курса 20° это поворот 0°, у 70° — поворот 45°;
 *   7) дойдя, он ПОВОРАЧИВАЕТСЯ НА ДЕРЕВО и больше не двигается — это
 *      отдельный прогон на 5 минут после остановки;
 *   8) ратушу он ОБХОДИТ: если ближайшее дерево лежит за ней, ни один шаг не
 *      попадает в её пятно, а путь не длиннее кратчайшего обхода;
 *   9) он НАРИСОВАН: сравнение кадра с выключенным слоем даёт пиксели ровно
 *      в том месте, где стоит спрайт, земля под ногами попадает в силуэт,
 *      и в экспорт PNG он тоже попадает;
 *  10) порядок глубины общий с деревьями и ратушей: в потоке отрисовки
 *      ключи x + y не убывают;
 *  11) тот же сид — тот же путь; после перегенерации карты он идёт к дереву
 *      НОВОГО острова, а не по клеткам старого.

 * Кадры для глаза: крупный план жителя с сеткой, он рядом с ратушей и
 * деревьями, он под своим деревом, весь остров с нарисованным путём и путь
 * в обход ратуши.

 * Запуск: node tools/villager.js [url]
 *        VILLAGER_MINUTES=2 node tools/villager.js     # короткий прогон
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
/* Сид прогона задан в адресе, а не «какой выпадет»: приёмка должна быть
   воспроизводимой — иначе FAIL на одном острове не повторить на другом.
   Проверки при этом сформулированы так, чтобы держаться на любом сиде. */
const SEED = process.env.VILLAGER_SEED || 'житель-приёмка';
const url = process.argv[2] ||
  'file://' + path.join(__dirname, '..', 'index.html') + '?seed=' + encodeURIComponent(SEED);
const OUT = path.join(__dirname, 'out');
const PORT = 9700 + (process.pid % 200);
const PROFILE = '/tmp/dsh-villager-' + process.pid;

// Потолок прогона: житель идёт к дереву один раз и встаёт, поэтому это не
// «сколько он гуляет», а «сколько ждём, если путь длинный». Шаги по 1/60 с.
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
], { stdio: 'ignore' });

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

  console.log('житель в игре:');

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
  check('кадров 176: idle 6, walk 8, work 8 на восемь поворотов',
    atlas.frames === 176 && atlas.idle === 6 && atlas.walk === 8 && atlas.rots.length === 8,
    `${atlas.frames} кадров, поворотов ${atlas.rots.length}: ${atlas.rots.join('/')}`);
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

  /* --- 1b. рост человечка в игре ------------------------------------ *
   * Заказчик (2026-10-13): «персонаж в игре слишком большой, уменьшить его в
   * масштабе в 2.2 раза». Проверяется ЗАМЕРОМ, а не сверкой с константой:
   * силуэт берётся из самого кадра атласа (верхняя непрозрачная строка против
   * пикселя опоры), а рост переводится в клетки тем же scaleAt, которым рисует
   * игра. Так одна и та же проверка поймает и правку атласа, и правку масштаба.
   * Раньше (крупность растительности, 1.35) он был 1.18 клетки — выше дверного
   * проёма дома (0.70) и вровень с карнизом (1.51). */
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

  /* --- 2. житель в игре --------------------------------------------- */
  const born = await js(`(() => {
    const g = window.__mapgen, w = g.getWorld(), list = g.getVillagers();
    const v = list[0];
    if (!v) return { n: 0 };
    const B = window.Buildings, home = g.getBuildings()[0];
    const cx = Math.floor(v.x), cy = Math.floor(v.y);
    const inside = (b) => {
      const bb = B.bounds(b);
      return v.x >= bb.x0 && v.x < bb.x1 && v.y >= bb.y0 && v.y < bb.y1;
    };
    return {
      n: list.length, pos: [v.x, v.y], cell: [cx, cy], rot: v.rot, anim: v.anim,
      state: v.state,
      // Цель выбрана СРАЗУ при появлении: дерево и путь к нему, без паузы.
      tree: v.tree ? [v.tree.x, v.tree.y] : null,
      goal: v.goal ? [v.goal.x, v.goal.y] : null,
      points: v.path ? v.path.length : 0,
      land: !!w.isLand[cy * w.width + cx],
      water: w.distWater[cy * w.width + cx],
      home: home ? [home.x, home.y] : null,
      underHome: home ? inside(home) : false,
      block: window.Villagers.blockedMap(w, g.getBuildings())[cy * w.width + cx],
      speed: v.speed
    };
  })()`);
  check('в игре ровно один житель', born.n === 1, born.n + ' шт.');
  check('он появился на суше', born.land === true, 'клетка ' + born.cell.join(','));
  check('он не в воде и не в занятой клетке', born.block === 0 && born.water >= 1,
    'вода на расстоянии ' + born.water + ' клеток');
  check('он появился во дворе ратуши, а не в её пятне', born.underHome === false,
    'ратуша ' + (born.home || []).join(',') + ', житель ' + born.cell.join(','));
  check('цель выбрана сразу при появлении — дерево и путь к нему',
    !!born.tree && (born.state !== 'toward' || born.points >= 2),
    born.tree
      ? `дерево ${born.tree.map(n => n.toFixed(1)).join(',')}, точек пути ${born.points}, состояние ${born.state}`
      : 'дерева нет');
  check('скорость шага — из анимации и замедлена тем же множителем',
    Math.abs(born.speed - 1.26 / 2.2) < 1e-9, born.speed.toFixed(3) + ' клетки/с');

  /* --- 3. его двигает сам игровой цикл ------------------------------- *
   * Прогон ниже шагает симуляцию руками, и без этой проверки опечатка в
   * вызове stepVillagers из loop() осталась бы незамеченной: житель стоял бы
   * на месте в игре и ходил только в тесте. Если он уже успел дойти до дерева,
   * его отправляют к дальней свободной клетке тем же путём, каким он ходит
   * сам, — и смотрят, сдвинет ли его игровой цикл. */
  const live = await js(`(async () => {
    const g = window.__mapgen, V = window.Villagers, v = g.getVillagers()[0], w = g.getWorld();
    // Он мог уже дойти и рубить: тогда его отправляют к дальней свободной
    // клетке тем же путём, каким он ходит сам, — и смотрят, сдвинет ли его
    // игровой цикл. Это проверка про ЦИКЛ, а не про состояние.
    if (v.state !== 'toward') {
      const solid = V.blockedMap(w, g.getBuildings());
      const W = w.width, H = w.height;
      for (let k = 0; k < W * H; k++) {
        const x = k % W, y = (k / W) | 0;
        if (Math.hypot(x - v.x, y - v.y) < 12) continue;
        if (!V.walkable(w, solid, x, y)) continue;
        if (V.routeTo(v, w, solid, x + 0.5, y + 0.5)) break;
      }
    }
    const a = [v.x, v.y];
    const anims = new Set([v.anim]);
    let moved = 0;
    for (let i = 0; i < 48; i++) {
      await new Promise(r => setTimeout(r, 250));
      anims.add(v.anim);
      moved = Math.hypot(v.x - a[0], v.y - a[1]);
      if (moved > 0.5) break;
    }
    return { moved: moved, anims: [...anims], walked: v.walked, state: v.state };
  })()`);
  check('его двигает сам игровой цикл, без вмешательства теста', live.moved > 0.5,
    `сдвинулся на ${live.moved.toFixed(2)} клетки, анимации: ${live.anims.join(', ')}`);

  /* --- 4. путь к дереву и остановка ---------------------------------- *
   * Прогон шагает симуляцию сам (stepVillagers — тот же код, что в игровом
   * цикле) и на КАЖДОМ шаге смотрит клетку под жителем: вода, дерево/камень и
   * пятно постройки считаются отдельно, и ни одного такого шага быть не
   * должно. Он это делает не потому, что «проверяем на каждом шаге», а потому
   * что путь так посчитан: прямая не задевает занятых клеток (lineClear), а
   * между точками пути живёт ровно одна прямая. */
  const STEPS = Math.round(MINUTES * 60 / DT);
  const sim = await js(`(() => {
    const g = window.__mapgen, V = window.Villagers, w = g.getWorld();
    // Начинаем с свежего жителя: иначе прогон зависит от того, сколько он уже
    // прошёл в живом цикле, и числа не сравнить между запусками.
    g.spawnVillagers(g.getBuildings()[0]);
    const v = g.getVillagers()[0];
    const solid = V.blockedMap(w, g.getBuildings());
    const W = w.width, H = w.height;
    const start = [v.x, v.y], startCell = [Math.floor(v.x), Math.floor(v.y)];
    let water = 0, blocked = 0, outside = 0, badRot = 0, badAnim = 0, badPhase = 0;
    let steps = 0;
    const trail = [];
    const dt = ${DT};
    // Идёт он, пока состояние toward. Дошёл — состояние меняется (chop), и
    // прогон останавливается на ПЕРВОМ приходе: дальше начинается рубка, и
    // она меряется отдельно, ниже.
    while (steps < ${STEPS} && v.state === 'toward') {
      g.stepVillagers(dt);
      steps++;
      const cx = Math.floor(v.x), cy = Math.floor(v.y);
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) outside++;
      else if (!w.isLand[cy * W + cx]) water++;
      else if (solid[cy * W + cx]) blocked++;
      if (!(v.rot >= 0 && v.rot < 360)) badRot++;
      // work — это рубка, и она тут не «попалась»: житель дошёл и рубит.
      if (v.anim !== 'idle' && v.anim !== 'walk' && v.anim !== 'work') badAnim++;
      if (!(v.phase >= 0 && v.phase < 1)) badPhase++;
      if (steps % 6 === 0) trail.push([v.x, v.y]);
    }
    const stop = [v.x, v.y], stopRot = v.rot;
    const tree = v.tree;
    const arrived = v.state !== 'toward';
    /* Пройденное ЗАСЕКАЕТСЯ ЗДЕСЬ, а не в конце прогона: дальше идут рубка и
       дорога к следующему дереву, и v.walked к концу включал бы и то и другое.
       Из этой суммы вычитается STAND_OFF — последний шаг к стволу, которого в
       маршруте нет (он меряется отдельной проверкой ниже). */
    const walkedToTree = v.walked - V.STAND_OFF;

    /* Цель — точка под деревом; v.goal это {x, y}, а не пара чисел: на этом
       тест уже один раз соврал (goal[0] — undefined, и «прямая свободна»).
       Считается это ДО рубки и до перехода к следующему дереву: после падения
       v.goal указывает уже на другое дерево, и «обход не длиннее кратчайшего»
       сравнивало бы путь к одному дереву с путём к другому. */
    const goal = v.goal ? [v.goal.x, v.goal.y] : stop;
    const direct = V.lineClear(w, solid, start[0], start[1], goal[0], goal[1]);
    const goalCell = [Math.floor(goal[0]), Math.floor(goal[1])];
    const cells = V.findPath(w, solid, startCell[0], startCell[1], goalCell[0], goalCell[1]);
    let octile = 0;
    for (let i = 1; cells && i < cells.length; i++) {
      const ax = cells[i-1] % W, ay = (cells[i-1] / W) | 0;
      const bx = cells[i] % W, by = (cells[i] / W) | 0;
      octile += (ax !== bx && ay !== by) ? Math.SQRT2 : 1;
    }

    /* РУБКА. Здесь меряется ровно то, что обещано заказчику: житель стоит и
       бьёт топором, удары идут по кадру удара, а дерево пропадает на пятой
       секунде рубки.

       Тряску дерева (tree.shake) ставит удар, а ГАСИТ её рендер — в прогоне без
       рендера флаг остался бы поднятым навсегда, и «сколько было ударов» по
       нему не сосчитать. Поэтому тест сбрасывает флаг перед каждым шагом и
       считает шаги, на которых удар его поднял: это и есть число ударов. */
    let moved = 0, chopSteps = 0, shakeSteps = 0, goneAt = null, felledAt = null;
    let anims = {};
    const treesBefore = w.stats ? w.stats.trees : null;
    let t = 0;
    while (v.state === 'chop' && t < 12) {
      if (tree) tree.shake = 0;
      const had = w.objects.indexOf(tree) >= 0;
      g.stepVillagers(dt);
      t += dt;
      chopSteps++;
      anims[v.anim] = (anims[v.anim] || 0) + 1;
      if (v.x !== stop[0] || v.y !== stop[1]) moved++;
      if (tree && tree.shake) shakeSteps++;
      if (had && w.objects.indexOf(tree) < 0) { goneAt = t; felledAt = t; }
    }
    const treesAfter = w.stats ? w.stats.trees : null;
    const hits = v.hits;
    /* Что дальше: он выбирает СЛЕДУЮЩЕЕ дерево и ИДЁТ к нему. Меряется это
       двумя секундами симуляции, а не первым же шагом: на первом шаге он
       только выбирает цель, и «сдвинулся на 0.01» ничего не доказывает. */
    let after = { state: v.state, tree: null, steps: 0 };
    for (let i = 0; i < 120; i++) {
      g.stepVillagers(dt);
      after.steps++;
      if (!after.tree && v.tree) after.tree = [v.tree.x, v.tree.y];
    }
    after.state = v.state;
    after.sameTree = !!(after.tree && tree &&
      Math.abs(after.tree[0] - tree.x) < 1e-9 && Math.abs(after.tree[1] - tree.y) < 1e-9);
    after.moved = Math.hypot(v.x - stop[0], v.y - stop[1]);
    // Силуэт следа: максимальное отклонение от прямой старт -> финиш.
    let dev = 0;
    const dx = stop[0] - start[0], dy = stop[1] - start[1];
    const len = Math.hypot(dx, dy) || 1;
    for (const p of trail) dev = Math.max(dev, Math.abs((p[0]-start[0])*dy - (p[1]-start[1])*dx) / len);
    // Стоит ли он на клетке рядом с деревом и смотрит ли на него.
    const faceWant = tree ? ((Math.atan2(tree.y - stop[1], tree.x - stop[0]) * 180 / Math.PI) % 360 + 360) % 360 : null;
    const faceErr = faceWant === null ? null :
      Math.abs(((stopRot - faceWant + 540) % 360) - 180);
    const standOff = tree ? Math.hypot(tree.x - stop[0], tree.y - stop[1]) : null;
    return {
      steps: steps, water, blocked, outside, badRot, badAnim, badPhase, moved,
      chopSteps, hits, shakeSteps, goneAt, felledAt, treesBefore, treesAfter,
      after: after, standOff, standOffK: V.STAND_OFF,
      standCell: [Math.floor(stop[0]), Math.floor(stop[1])],
      arrived: arrived,
      anims: anims,
      tree: tree ? [tree.x, tree.y] : null,
      treeCell: tree ? [Math.floor(tree.x), Math.floor(tree.y)] : null,
      stop: stop, stopCell: [Math.floor(stop[0]), Math.floor(stop[1])],
      rot: stopRot, faceWant, faceErr,
      walked: walkedToTree, walkedAll: v.walked, trips: v.trips,
      direct, octile, dev, len,
      startCell, goalCell, pathCells: cells ? cells.length : -1,
      startOk: V.walkable(w, solid, startCell[0], startCell[1]),
      goalOk: V.walkable(w, solid, goalCell[0], goalCell[1]),
      straight: Math.hypot((tree ? tree.x : stop[0]) - start[0], (tree ? tree.y : stop[1]) - start[1]),
      trail: trail
    };
  })()`);
  check('за ' + MINUTES + ' минут ни одного шага в воду',
    sim.water === 0 && sim.outside === 0, `${sim.water} в воде, ${sim.outside} за картой из ${sim.steps} шагов`);
  check('ни одного шага в дерево, камень или дом', sim.blocked === 0, sim.blocked + ' шагов');
  check('курс свободный, но всегда в [0, 360), анимация — idle, walk или work',
    sim.badRot === 0 && sim.badAnim === 0 && sim.badPhase === 0,
    `${sim.badRot} / ${sim.badAnim} / ${sim.badPhase}`);
  check('он дошёл до дерева и РУБИТ его', sim.arrived && !!sim.tree && sim.steps < STEPS,
    sim.tree ? `за ${(sim.steps / 60).toFixed(1)} с, дерево ${sim.tree.map(n => n.toFixed(2)).join(',')}`
             : 'дерева нет');
  check('встал на СОСЕДНЮЮ с деревом клетку',
    !!sim.treeCell && Math.abs(sim.treeCell[0] - sim.stopCell[0]) +
      Math.abs(sim.treeCell[1] - sim.stopCell[1]) === 1,
    `дерево ${(sim.treeCell || []).join(',')}, житель ${sim.stopCell.join(',')}`);
  check('повёрнут РОВНО на дерево, а не «примерно туда»',
    sim.faceErr !== null && sim.faceErr < 0.5,
    `курс ${sim.rot.toFixed(2)}° против ${sim.faceWant === null ? '—' : sim.faceWant.toFixed(2)}° на дерево`);
  check('идёт по прямой, а не зигзагом по клеткам',
    !sim.direct || sim.dev < 0.30,
    sim.direct
      ? `прямая свободна, отклонение следа ${sim.dev.toFixed(3)} клетки`
      : `прямая занята — шёл в обход, отклонение ${sim.dev.toFixed(3)} клетки`);
  check('обход не длиннее кратчайшего клеточного пути',
    sim.octile > 0 && sim.walked <= sim.octile + 0.05,
    `пройдено ${sim.walked.toFixed(2)} при кратчайшем ${sim.octile.toFixed(2)} клетки ` +
    `(${sim.startCell.join(',')} -> ${sim.goalCell.join(',')}, поиск дал ${sim.pathCells} клеток, ` +
    `проходимы старт ${sim.startOk}, цель ${sim.goalOk})`);

  /* --- 4a. РУБКА: пять секунд, восемь ударов, дерево падает ----------- *
   * Заказчик (2026-10-14): «когда персонаж подходил к дереву и останавливался
   * он начинал его рубить, рубил его 5 секунд а потом дерево исчезало».
   * Проверяется тремя числами, а не «на глаз»:
   *   * во время рубки он НЕ ДВИГАЕТСЯ (рубить — это стоять) и играет work;
   *   * ударов ровно восемь, и каждый поднимает дереву флаг тряски;
   *   * дерево пропадает на 5.00 с (допуск на сложение dt — 0.05 с), и
   *     счётчик деревьев в мире уменьшается.
   * Отдельно проверяется, что он на этом не кончил: дальше он выбирает
   * СЛЕДУЮЩЕЕ дерево и идёт к нему, а не встаёт навсегда. */
  check('во время рубки он играет work и не делает ни шага',
    sim.chopSteps > 0 && sim.moved === 0 && (sim.anims.work || 0) === sim.chopSteps,
    `${sim.chopSteps} шагов рубки (${(sim.chopSteps / 60).toFixed(2)} с), ` +
    `сдвигов с места ${sim.moved}, кадры анимации: ${JSON.stringify(sim.anims)}`);
  check('ударов восемь, и каждый тряхнул дерево',
    sim.hits === 8 && sim.shakeSteps === 8,
    `ударов ${sim.hits}, из них с тряской ${sim.shakeSteps}`);
  check('дерево исчезло ровно на пятой секунде рубки',
    sim.goneAt !== null && Math.abs(sim.goneAt - 5.0) < 0.05,
    sim.goneAt === null ? 'дерево не пропало' : `пропало на ${sim.goneAt.toFixed(2)} с рубки`);
  check('счётчик деревьев в мире уменьшился на одно',
    sim.treesBefore !== null && sim.treesAfter === sim.treesBefore - 1,
    `${sim.treesBefore} -> ${sim.treesAfter}`);
  check('после падения дерева он идёт к СЛЕДУЮЩЕМУ, а не стоит',
    !!sim.after.tree && !sim.after.sameTree && sim.after.moved > 0.5,
    sim.after.tree
      ? `новое дерево ${sim.after.tree.map(n => n.toFixed(1)).join(',')} ` +
        `(прежнее ${sim.after.sameTree ? 'то же' : 'другое'}), отошёл на ${sim.after.moved.toFixed(2)} клетки ` +
        `за ${(sim.after.steps / 60).toFixed(2)} с`
      : 'нового дерева он не нашёл');
  check('под деревом он стоит не в середине клетки, а ближе к стволу (иначе топор не достаёт)',
    sim.standOff !== null && sim.standOff < 0.95,
    sim.standOff === null ? '—' : `до ствола ${sim.standOff.toFixed(2)} клетки ` +
      `(сдвиг STAND_OFF ${sim.standOffK})`);

  /* --- 4b. ближайшее дерево ------------------------------------------ *
   * «Ближайшее» — это ближайшее ДОСТИЖИМОЕ: дерево на соседнем островке по
   * линейке ближе, но дойти до него нельзя. Проверяется честным перебором:
   * у всех деревьев, что ближе выбранного, не должно быть ни одной клетки, с
   * которой до них есть путь. */
  const nearest = await js(`(() => {
    const g = window.__mapgen, V = window.Villagers, w = g.getWorld();
    g.spawnVillagers(g.getBuildings()[0]);
    const v = g.getVillagers()[0];
    const solid = V.blockedMap(w, g.getBuildings());
    const sx = Math.floor(v.x), sy = Math.floor(v.y);
    const reach = (t) => {
      for (const s of V.standCells(w, solid, t, v.x, v.y)) {
        if (s.cx === sx && s.cy === sy) return true;
        if (V.findPath(w, solid, sx, sy, s.cx, s.cy)) return true;
      }
      return false;
    };
    const trees = V.treesNear(w, v.x, v.y, 0);
    let n = 0, bad = 0, firstReach = null;
    for (const t of trees) {
      n++;
      if (reach(t)) { firstReach = t; break; }
      if (n > V.TREE_TRIES) break;                    // дальше житель и не ищет
    }
    const chosen = v.tree;
    const same = !!(chosen && firstReach) &&
      Math.abs(chosen.x - firstReach.x) < 1e-9 && Math.abs(chosen.y - firstReach.y) < 1e-9;
    return {
      trees: trees.length, tried: n, chosen: chosen ? [chosen.x, chosen.y] : null,
      first: firstReach ? [firstReach.x, firstReach.y] : null, same: same,
      noneReachable: !firstReach && !chosen
    };
  })()`);
  check('он идёт к ближайшему ДОСТИЖИМОМУ дереву',
    nearest.same || nearest.noneReachable,
    nearest.same
      ? `выбрано ${nearest.chosen.map(n => n.toFixed(1)).join(',')} из ${nearest.trees} деревьев`
      : `ближайшее достижимое ${nearest.first ? nearest.first.map(n => n.toFixed(1)).join(',') : '—'}, ` +
        `выбрано ${nearest.chosen ? nearest.chosen.map(n => n.toFixed(1)).join(',') : '—'}`);

  /* --- 4c. обход ратуши ---------------------------------------------- *
   * Ставим жителя так, чтобы БЛИЖАЙШЕЕ дерево лежало за ратушей (клетку
   * выбирает сам тест перебором вокруг пятна), и проживаем путь. Прямая тут
   * заведомо занята, поэтому проверяются две вещи: ни один шаг не попал в
   * пятно ратуши и путь не длиннее кратчайшего обхода — то есть ратушу он
   * обходит БЛИЖАЙШИМ путём к дереву, а не «как-нибудь». */
  const detour = await js(`(() => {
    const g = window.__mapgen, V = window.Villagers, B = window.Buildings, w = g.getWorld();
    const home = g.getBuildings()[0];
    if (!home) return { ok: false, reason: 'ратуши нет' };
    const solid = V.blockedMap(w, g.getBuildings());
    const fp = B.footprint(home.rot);
    const cards = B.cells(home);
    const inside = new Set(cards.map(c => c.x + ',' + c.y));
    let pick = null;
    for (let x = Math.max(0, home.x - 9); x < home.x + fp.w + 9 && !pick; x++) {
      for (let y = Math.max(0, home.y - 9); y < home.y + fp.h + 9 && !pick; y++) {
        if (inside.has(x + ',' + y) || !V.walkable(w, solid, x, y)) continue;
        const t = V.create(w, { index: 0, x: x + 0.5, y: y + 0.5, buildings: g.getBuildings() });
        if (!t.tree || t.state !== 'toward') continue;
        // прямая от жителя к его дереву пересекает пятно ратуши?
        let hit = false;
        for (let i = 0; i <= 400; i++) {
          const px = t.x + (t.tree.x - t.x) * i / 400, py = t.y + (t.tree.y - t.y) * i / 400;
          if (inside.has(Math.floor(px) + ',' + Math.floor(py))) { hit = true; break; }
        }
        if (!hit) continue;
        if (!pick || t.walked + 0 > pick.d) {
          pick = { x: x + 0.5, y: y + 0.5, d: Math.hypot(t.tree.x - t.x, t.tree.y - t.y) };
        }
      }
    }
    if (!pick) return { ok: false, reason: 'случая «ратуша между» не нашлось' };
    /* Жителя двигает ИГРОВОЙ цикл, поэтому в найденную клетку ставится тот
       житель, который уже в списке игры, а не отдельный объект: отдельный
       никто не тронет, и проверка «дошёл» превратилась бы в «стоял 600 с». */
    g.spawnVillagers(g.getBuildings()[0]);
    const v = g.getVillagers()[0];
    v.x = pick.x; v.y = pick.y;
    v.path = null; v.tree = null; v.goal = null; v.state = 'toward'; v.walked = 0; v.trips = 0;
    g.stepVillagers(${DT});                      // первый шаг — он же и планирует путь
    if (!v.tree) return { ok: false, reason: 'житель не нашёл дерево с этой клетки' };
    const start = [pick.x, pick.y], startCell = [Math.floor(pick.x), Math.floor(pick.y)];
    const want = v.goal ? [v.goal.x, v.goal.y] : null;
    let inHouse = 0, water = 0, blocked = 0, steps = 0;
    const trail = [[v.x, v.y]];
    while (steps < 60 * 600 && v.state === 'toward') {
      g.stepVillagers(${DT});
      steps++;
      const cx = Math.floor(v.x), cy = Math.floor(v.y);
      if (inside.has(cx + ',' + cy)) inHouse++;
      if (!w.isLand[cy * w.width + cx]) water++;
      else if (solid[cy * w.width + cx]) blocked++;
      if (steps % 6 === 0) trail.push([v.x, v.y]);
    }
    const cells = V.findPath(w, solid, startCell[0], startCell[1],
      Math.floor(want[0]), Math.floor(want[1]));
    let octile = 0;
    for (let i = 1; cells && i < cells.length; i++) {
      const ax = cells[i-1] % w.width, ay = (cells[i-1] / w.width) | 0;
      const bx = cells[i] % w.width, by = (cells[i] / w.width) | 0;
      octile += (ax !== bx && ay !== by) ? Math.SQRT2 : 1;
    }
    // Куда он шёл напрямую: расстояние до дерева по воздуху.
    const air = v.tree ? Math.hypot(v.tree.x - start[0], v.tree.y - start[1]) : null;
    return {
      ok: true, start, stop: [v.x, v.y], tree: v.tree ? [v.tree.x, v.tree.y] : null,
      inHouse, water, blocked, steps, walked: v.walked, octile, air,
      arrived: v.state !== 'toward', goal: want, trail: trail,
      home: [home.x, home.y], fp: [fp.w, fp.h], houseCells: cards.map(c => [c.x, c.y])
    };
  })()`);
  check('ратуша между жителем и деревом: он её обошёл',
    detour.ok && detour.arrived && detour.inHouse === 0 && detour.water === 0 && detour.blocked === 0,
    detour.ok
      ? `шагов в пятне ${detour.inHouse}, в воде ${detour.water}, в занятых ${detour.blocked}; ` +
        `дошёл за ${(detour.steps / 60).toFixed(1)} с`
      : detour.reason);
  if (detour.ok) {
    check('обход ратуши — ближайший путь к дереву, а не «какой-нибудь»',
      detour.walked <= detour.octile + 0.05,
      `пройдено ${detour.walked.toFixed(2)} при кратчайшем ${detour.octile.toFixed(2)} клетки ` +
      `(по воздуху до дерева ${detour.air === null ? '—' : detour.air.toFixed(2)})`);
  }

  /* --- 4d. дом, поставленный поперёк пути ---------------------------- *
   * Ратушу игрок ставит мышью когда угодно — в том числе на уже проложенный
   * путь. Путь после этого обязан пересчитаться сам: в пятне новой ратуши не
   * должно остаться ни одного шага, а житель обязан дойти до дерева. Ставит
   * ратушу тут настоящий placeAt — тот же код, что и по клику. */
  const late = await js(`(() => {
    const g = window.__mapgen, V = window.Villagers, B = window.Buildings, w = g.getWorld();
    g.spawnVillagers(g.getBuildings()[0]);
    const v = g.getVillagers()[0];
    for (let i = 0; i < 120 && v.state === 'toward'; i++) g.stepVillagers(${DT});
    if (v.state !== 'toward' || !v.path) return { ok: false, reason: 'он дошёл раньше, чем мы успели поставить дом' };
    const wp = v.path[v.step];
    const mx = (v.x + wp.x) / 2, my = (v.y + wp.y) / 2;
    let placed = null, cells = null;
    for (let r = 0; r <= 3 && !placed; r++) {
      for (let dx = -r; dx <= r && !placed; dx++) {
        for (let dy = -r; dy <= r && !placed; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const b = { variant: 'a', rot: 0, x: Math.floor(mx) + dx, y: Math.floor(my) + dy };
          const cs = B.cells(b);
          let onLeg = false, onHim = false;
          for (const c of cs) {
            if (c.x === Math.floor(v.x) && c.y === Math.floor(v.y)) onHim = true;
            for (let t = 0; t <= 60; t++) {
              const px = v.x + (wp.x - v.x) * t / 60, py = v.y + (wp.y - v.y) * t / 60;
              if (c.x === Math.floor(px) && c.y === Math.floor(py)) onLeg = true;
            }
          }
          if (!onLeg || onHim) continue;               // пятно обязано лечь на путь, но не на него
          if (!g.placeAt(b)) continue;                 // ставим НАСТОЯЩИМ размещением
          placed = b;
          cells = cs;
        }
      }
    }
    if (!placed) return { ok: false, reason: 'места поперёк пути не нашлось' };
    const inside = new Set(cells.map(c => c.x + ',' + c.y));
    const trips = v.trips;
    let inHouse = 0, water = 0, blocked = 0, steps = 0;
    while (steps < 120 * 60 && v.state === 'toward') {
      g.stepVillagers(${DT});
      steps++;
      const cx = Math.floor(v.x), cy = Math.floor(v.y);
      if (inside.has(cx + ',' + cy)) inHouse++;
      if (!w.isLand[cy * w.width + cx]) water++;
      else if (V.blockedMap(w, g.getBuildings())[cy * w.width + cx]) blocked++;
    }
    const was = g.getBuildings().length;
    g.removeLast();                                  // убираем поставленное за собой
    const cell = [Math.floor(v.x), Math.floor(v.y)];
    return {
      ok: true, home: [placed.x, placed.y], cells: cells.length,
      inHouse, water, blocked, steps, state: v.state,
      replanned: v.trips > trips,
      adjacent: !!v.tree && (Math.abs(Math.floor(v.tree.x) - cell[0]) +
                             Math.abs(Math.floor(v.tree.y) - cell[1])) === 1,
      removed: g.getBuildings().length === was - 1, left: g.getBuildings().length
    };
  })()`);
  check('дом, поставленный поперёк пути, житель обходит',
    late.ok && late.inHouse === 0 && late.water === 0 && late.blocked === 0 &&
      late.state !== 'toward' && late.adjacent && late.replanned && late.removed,
    late.ok
      ? `ратуша встала в ${late.home.join(',')} (${late.cells} клеток), шагов в её пятне ${late.inHouse}, ` +
        `путь пересчитан: ${late.replanned}, дошёл: ${late.state}, убрана: ${late.removed} (осталось ${late.left})`
      : late.reason);

  /* --- 5. порядок глубины ------------------------------------------- */
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
    return { n: seq.length, bad, walkers };
  })()`);
  check('житель попал в общий поток отрисовки', order.walkers === 1, order.walkers + ' из ' + order.n);
  check('порядок глубины не убывает (x + y)', order.bad === 0, order.bad + ' нарушений');

  /* --- 6. он нарисован ---------------------------------------------- *
   * Сравниваются два кадра ОДНОГО времени: с жителем и без него. Разницу
   * внутри габарита его спрайта считаем фигурой, снаружи — шумом отрисовки;
   * их считают отдельно, потому что это разные утверждения. Одиночный
   * сглаженный пиксель на другом конце кадра раздувает общий габарит так,
   * что по нему уже ничего не проверить, — на этом тест уже один раз соврал. */
  const drawn = await js(`(() => {
    const g = window.__mapgen, r = g.renderer, B = window.Buildings, w = g.getWorld();
    const V = window.Villagers, v = g.getVillagers()[0];
    /* Житель ставится в ЧИСТЫЙ ДВОР ратуши, перед домом, а не остаётся там,
       где стоит сам. Это не поблажка: в чаще его закрывают кроны деревьев,
       которые по глубине ближе камеры (x + y больше), и «не нарисован»
       означало бы не то, что случилось, — на это тест уже попался. Проверка
       здесь про слой отрисовки, а не про видимость в лесу. */
    const home = g.getBuildings()[0], c = B.center(home);
    const solid = V.blockedMap(w, g.getBuildings());
    let spot = null;
    for (let x = Math.floor(c.x) - 6; x <= Math.floor(c.x) + 6; x++)
      for (let y = Math.floor(c.y) - 6; y <= Math.floor(c.y) + 6; y++) {
        const k = y * w.width + x;
        if (x < 1 || y < 1 || x >= w.width - 1 || y >= w.height - 1) continue;
        if (!w.isLand[k] || solid[k]) continue;
        const d = Math.hypot(x + 0.5 - c.x, y + 0.5 - c.y);
        if (d < 2.6 || (x + y + 1) < (c.x + c.y) + 2.5) continue;   // строго ПЕРЕД домом
        if (!spot || d < spot.d) spot = { x: x + 0.5, y: y + 0.5, d: d };
      }
    if (spot) { v.x = spot.x; v.y = spot.y; v.path = null; v.state = 'stand'; v.anim = 'idle'; v.phase = 0; }
    const cv = r.canvas, ctx = cv.getContext('2d');
    r.cam.zoom = 96;
    r.centerOn(v.x, v.y);
    r.hover = null;
    const box = r.villagerBox(v, r.cam.zoom);
    const size = [cv.width, cv.height];
    const grab = () => ctx.getImageData(0, 0, cv.width, cv.height).data;

    r.showVillagers = true;  r.render(1); const a = grab();
    const sizeA = [cv.width, cv.height];
    r.showVillagers = false; r.render(1); const b = grab();
    const sizeB = [cv.width, cv.height];
    r.showVillagers = true;

    const dpr = r.dpr;
    const want = {
      x0: (r.cssW / 2 + box.dx) * dpr, y0: (r.cssH / 2 + box.dy) * dpr,
      x1: (r.cssW / 2 + box.dx + box.dw) * dpr, y1: (r.cssH / 2 + box.dy + box.dh) * dpr
    };

    /* Порог разный для фигуры и для остального кадра, и это не поблажка
       себе. Внутри кадра спрайта разница обязана быть крупной — там либо
       человек, либо пусто. А снаружи Chrome даёт дрожание в пару единиц на
       слоях воды: узор ряби заливается умножением на весь кадр, и его
       растеризация от вызова к вызову отличается на +/-2..6 (глазом это
       не видно, но пиксели не равны). Такое дрожание считается отдельно —
       noise, — а видимая разница (out) обязана быть нулевой. */
    /* Строгий проход: те же два кадра, но без волн и ряби. Море тогда —
       градиент из кэша, и оно бит в бит одинаково; так проверяется, что
       от жителя в кадре не зависит НИЧЕГО, кроме его собственного спрайта. */
    const waves = r.waveSprites, ripple = r.ripplePattern;
    r.waveSprites = null; r.ripplePattern = null;
    r.showVillagers = true;  r.render(1); const wa = grab();
    r.showVillagers = false; r.render(1); const wb = grab();
    r.showVillagers = true;
    r.waveSprites = waves; r.ripplePattern = ripple;
    let strict = 0, strictAt = null;
    for (let i = 0; i < wa.length; i += 4) {
      const d = Math.abs(wa[i] - wb[i]) + Math.abs(wa[i+1] - wb[i+1]) + Math.abs(wa[i+2] - wb[i+2]);
      if (d < 12) continue;
      const px = (i / 4) % cv.width, py = Math.floor((i / 4) / cv.width);
      if (px >= want.x0 - 2 && px <= want.x1 + 2 && py >= want.y0 - 2 && py <= want.y1 + 2) continue;
      strict++;
      if (!strictAt) strictAt = [px, py, d];
    }

    const VISIBLE = 30;
    let n = 0, noise = 0, onLand = 0, onWater = 0, worst = 0, worstAt = null;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i+1] - b[i+1]) + Math.abs(a[i+2] - b[i+2]);
      if (d < 12) continue;
      const px = (i / 4) % cv.width, py = Math.floor((i / 4) / cv.width);
      if (px >= want.x0 - 2 && px <= want.x1 + 2 && py >= want.y0 - 2 && py <= want.y1 + 2) {
        n++;
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        continue;
      }
      if (d < VISIBLE) { noise++; continue; }
      // Куда попал разошедшийся пиксель: суша или вода — это разные
      // утверждения, и проверяются они порознь.
      const wp = r.screenToWorld(px / dpr - r.cssW / 2, py / dpr - r.cssH / 2);
      const wx = Math.floor(wp.x), wy = Math.floor(wp.y);
      const inside = wx >= 0 && wy >= 0 && wx < w.width && wy < w.height;
      const land = inside && !!w.isLand[wy * w.width + wx];
      if (land) onLand++; else onWater++;
      if (d > worst) { worst = d; worstAt = [wx, wy, land, d]; }
    }
    // Земля под ногами: пиксель кадра, куда проецируется точка опоры.
    const feet = (r.cssH / 2 + box.dy + box.dh * (1 - box.spr.ay)) * dpr;
    // exportPNG обязан показывать то же, что экран: слой в нём тоже есть.
    const e1 = r.exportPNG(1), e2 = (() => { r.showVillagers = false; const c = r.exportPNG(1); r.showVillagers = true; return c; })();
    let exp = 0;
    const g1 = e1.getContext('2d').getImageData(0,0,e1.width,e1.height).data;
    const g2 = e2.getContext('2d').getImageData(0,0,e2.width,e2.height).data;
    for (let i = 0; i < g1.length; i += 4) if (g1[i] !== g2[i] || g1[i+1] !== g2[i+1]) exp++;

    const view = r.viewTiles(2);
    return {
      n, noise, onLand, onWater, worst, worstAt, strict, strictAt,
      // Числа состояния — в сообщение проверки: если спрайт не нарисуется,
      // по ним видно, где он стоял и что показывал кадр.
      diag: {
        at: [+v.x.toFixed(2), +v.y.toFixed(2)], anim: v.anim, rot: +v.rot.toFixed(1),
        state: v.state, zoom: r.cam.zoom, villagers: r.villagers.length,
        dw: +box.dw.toFixed(1), dh: +box.dh.toFixed(1),
        view: [view.x0, view.y0, view.x1, view.y1], spr: [box.spr.sw, box.spr.sh]
      },
      box: [x0, y0, x1, y1], want: [want.x0, want.y0, want.x1, want.y1],
      size: size, sizeA: sizeA, sizeB: sizeB,
      dw: box.dw, dh: box.dh, feet: feet, dpr: dpr, export: exp,
      expScale: Math.pow(r.cachePx / r.cam.zoom, 2),
      spr: [box.spr.sw, box.spr.sh]
    };
  })()`);
  const insideBox = drawn.box[0] >= drawn.want[0] - 1.5 && drawn.box[1] >= drawn.want[1] - 1.5 &&
    drawn.box[2] <= drawn.want[2] + 1.5 && drawn.box[3] <= drawn.want[3] + 1.5;
  check('кадр не менял размер между сравнениями',
    drawn.sizeA.join('×') === drawn.sizeB.join('×'), drawn.size.join('×'));
  check('житель нарисован (пиксели отличаются от кадра без него)', drawn.n > 400,
    drawn.n + ' пикселей; ' + JSON.stringify(drawn.diag));
  check('нарисован ровно в своём кадре, а не где-то ещё', insideBox,
    'нашлось ' + drawn.box.map(v => v.toFixed(0)).join(',') +
    ' в кадре ' + drawn.want.map(v => v.toFixed(0)).join(','));
  check('кроме его спрайта, кадр не меняется вообще', drawn.strict === 0,
    drawn.strict ? `${drawn.strict} пикселей, первый ${JSON.stringify(drawn.strictAt)}` : 'ни одного пикселя');
  check('вне кадра спрайта на суше не изменилось ничего', drawn.onLand === 0,
    drawn.onLand
      ? `${drawn.onLand} пикселей суши, худший ${JSON.stringify(drawn.worstAt)}`
      : 'ни одного');
  check('на воде — только дрожание растеризации', drawn.onWater <= 200,
    `${drawn.onWater} пикселей воды` +
    (drawn.worst ? `, худший ${drawn.worst} единиц в клетке ${drawn.worstAt[0]},${drawn.worstAt[1]}` : '') +
    (drawn.noise ? `; всего дрожания ${drawn.noise} пикселей` : ''));
  check('фигура занимает заметную часть своего кадра',
    (drawn.box[3] - drawn.box[1]) > drawn.dh * 0.45 * drawn.dpr,
    `${(drawn.box[3] - drawn.box[1]).toFixed(0)} px при нарисованном кадре ${(drawn.dh * drawn.dpr).toFixed(0)}`);
  check('ноги стоят на земле клетки, а не выше и не ниже',
    drawn.feet > drawn.box[1] && drawn.feet < drawn.box[3] + 1,
    `земля ${drawn.feet.toFixed(0)} в силуэте ${drawn.box[1].toFixed(0)}..${drawn.box[3].toFixed(0)}`);
  const expWant = Math.max(25, drawn.n * drawn.expScale * 0.5);
  check('в экспорт PNG житель тоже попадает', drawn.export >= expWant,
    `${drawn.export} пикселей при ${drawn.n} на экране ` +
    `(в экспорте масштаб x${Math.sqrt(drawn.expScale).toFixed(2)}, ждали от ${Math.round(expWant)})`);

  /* --- 7. тот же сид — тот же путь ----------------------------------- */
  const again = await js(`(() => {
    const g = window.__mapgen;
    /* Прогон останавливается на ПЕРВОМ приходе к дереву. Это не поблажка:
       житель теперь ВАЛИТ дерево, то есть меняет мир, и «тот же сид — тот же
       путь» верно ровно до первого удара. Досчитай прогон до конца — второй
       заход пошёл бы по миру без первого дерева, и деревья у двух прогонов
       были бы разные (на этом проверка уже падала). */
    const walk = () => {
      g.spawnVillagers(g.getBuildings()[0]);
      const v = g.getVillagers()[0];
      const pts = [];
      for (let i = 0; i < 3600 && v.state === 'toward'; i++) {
        g.stepVillagers(${DT});
        if (i % 60 === 0) pts.push([+v.x.toFixed(3), +v.y.toFixed(3)]);
      }
      return { pts: pts, tree: v.tree ? [v.tree.x, v.tree.y] : null, state: v.state };
    };
    const a = walk(), b = walk();
    let same = a.pts.length === b.pts.length;
    for (let i = 0; same && i < a.pts.length; i++) same = a.pts[i][0] === b.pts[i][0] && a.pts[i][1] === b.pts[i][1];
    same = same && String(a.tree) === String(b.tree);
    return { same: same, first: a.pts[0], last: a.pts[a.pts.length - 1], tree: a.tree, state: a.state,
             moved: Math.hypot(a.pts[a.pts.length-1][0]-a.pts[0][0], a.pts[a.pts.length-1][1]-a.pts[0][1]) };
  })()`);
  check('тот же сид — тот же путь к тому же дереву', again.same,
    JSON.stringify(again.first) + ' -> ' + JSON.stringify(again.last) + ', дерево ' + JSON.stringify(again.tree));
  check('и он действительно сдвинулся', again.moved > 0.5 || again.state !== 'toward',
    again.moved.toFixed(2) + ' клетки, состояние ' + again.state);

  /* --- 8. кадры ------------------------------------------------------ *
   * Кадры снимаются ДО перегенерации: это тот остров, на котором шёл прогон,
   * и путь на картинке — тот самый, что проверен выше. */
  console.log('кадры:');

  /* Крупный план: сетка включена, клетка под жителем подсвечена — по нему
   * видно, что он стоит НА клетке, а не висит над ней и не провалился.
   *
   * Кадр СТАВИТСЯ в чистый двор ратуши, а не снимается там, где житель
   * остановился сам: если его дерево стоит в чаще, жителя закрывают кроны
   * деревьев перед ним (они по глубине ближе камеры, x + y больше), и на
   * кадре выходила подсвеченная клетка без человека. Где он стоит на самом
   * деле и на что смотрит — проверяют прогоны выше, а кадр тут для глаза. */
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
      v.path = null; v.state = 'stand'; v.anim = 'idle'; v.phase = 0; v.rot = 0;
    }
    r.cam.zoom = 110;
    r.centerOn(v.x, v.y - 0.15);
    r.showGrid = true;
    r.hover = { x: Math.floor(v.x), y: Math.floor(v.y) };
    return best ? 1 : 0;
  })()`);

  // Рядом с домом и деревьями: видно, одного ли он с ними роста. Кадр
  // СТАВИТСЯ, а не ловится: житель уходит к своему дереву, и «кадр роста»
  // оставался пустой лужайкой. Ставим его на свободную траву ПЕРЕД домом (по
  // глубине x + y он ближе камеры — иначе маленький спрайт прячется за крышей
  // целиком) и на время кадра останавливаем.
  await shoot('villager-scale', `(() => {
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
      v.path = null; v.state = 'stand'; v.anim = 'idle'; v.phase = 0; v.rot = 0;
    }
    r.showGrid = false;
    r.hover = null;
    r.cam.zoom = 64;
    r.centerOn((c.x + v.x) / 2, (c.y + v.y) / 2);
    return best ? 1 : 0;
  })()`);

  /* Он под деревом — крупно: видно, что стоит рядом со стволом и смотрит на
   * него, а не «где-то в лесу». Кадр тоже СТАВИТСЯ, и по той же причине:
   * жителя у его собственного дерева в чаще не видно. Дерево для кадра
   * выбирается САМОЕ ОТКРЫТОЕ — у которого вокруг клетки под ним свободно, —
   * и житель встаёт с той стороны, откуда он виден (клетка с большим x + y:
   * по глубине он тогда ближе камеры, чем ствол). */
  const underTree = await js(`(() => {
    const g = window.__mapgen, r = g.renderer, B = window.Buildings, w = g.getWorld();
    const V = window.Villagers, v = g.getVillagers()[0];
    const solid = V.blockedMap(w, g.getBuildings());
    const home = g.getBuildings()[0], c = B.center(home);
    const trees = V.treesNear(w, c.x, c.y, 400);
    let best = null;
    for (const t of trees) {
      const tc = [Math.floor(t.x), Math.floor(t.y)];
      for (const spot of V.standCells(w, solid, t, c.x, c.y)) {
        if (spot.cx + spot.cy <= tc[0] + tc[1]) continue;      // только со стороны камеры
        // открытость: сколько из восьми соседей клетки свободно
        let open = 0;
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            if (V.walkable(w, solid, spot.cx + dx, spot.cy + dy)) open++;
        const d = Math.hypot(t.x - c.x, t.y - c.y);
        if (!best || open > best.open || (open === best.open && d < best.d)) {
          best = { open: open, d: d, x: spot.x, y: spot.y, tree: t };
        }
      }
    }
    if (!best) return { ok: 0 };
    v.x = best.x; v.y = best.y;
    v.path = null; v.state = 'stand'; v.anim = 'idle'; v.phase = 0;
    v.rot = ((Math.atan2(best.tree.y - v.y, best.tree.x - v.x) * 180 / Math.PI) % 360 + 360) % 360;
    const face = v.rot;
    r.showGrid = false;
    r.hover = null;
    r.cam.zoom = 78;
    r.centerOn((v.x + best.tree.x) / 2, (v.y + best.tree.y) / 2 - 0.2);
    return {
      ok: 1, open: best.open, dist: Math.hypot(best.tree.x - v.x, best.tree.y - v.y),
      rot: v.rot, face: face, state: v.state
    };
  })()`);
  await shoot('villager-tree', null);
  check('кадр «житель под деревом»: стоит рядом и смотрит на ствол',
    underTree.ok === 1 && Math.abs(((underTree.rot - underTree.face + 540) % 360) - 180) < 0.5 &&
      underTree.dist < 1.6,
    underTree.ok
      ? `до ствола ${underTree.dist.toFixed(2)} клетки, курс ${underTree.rot.toFixed(1)}°, ` +
        `свободных клеток вокруг ${underTree.open} из 9`
      : 'дерева нет');

  /* Он РУБИТ — кадр удара, крупно. До него симуляция доматывается тем же шагом,
   * что в игре, и останавливается на ФАЗЕ УДАРА (CHOP_HIT): на ней топор входит
   * в ствол, и в игре дерево вздрагивает.
   *
   * Тряску приходится ставить вручную: её гасит рендер по времени, а между
   * постановкой кадра и снятием проходит треть секунды — к этому моменту от
   * амплитуды остаётся 3%, и кадр показывал бы стоящее дерево. Берётся возраст
   * 0.03 с: на нём синус почти максимален (0.97 размаха). И кадр снимается ТУТ
   * ЖЕ, а не помощником shoot: тот ждёт и снимает то, что успело остыть. */
  const chopShot = await js(`(() => {
    const g = window.__mapgen, r = g.renderer, V = window.Villagers, w = g.getWorld();
    g.spawnVillagers(g.getBuildings()[0]);
    const v = g.getVillagers()[0];
    /* Дерево для кадра выбирается САМОЕ ОТКРЫТОЕ — у которого вокруг клетки
       подхода свободно (тем же перебором, что у кадра «под деревом»). Без
       этого кадр рубки выходит пустой лужайкой: житель уходит в чащу, и его
       закрывают кроны деревьев, которые по глубине ближе камеры. */
    const solid = V.blockedMap(w, g.getBuildings());
    const c = V.treesNear(w, v.x, v.y, 400);
    let best = null;
    for (const t of c) {
      const tc = [Math.floor(t.x), Math.floor(t.y)];
      for (const spot of V.standCells(w, solid, t, v.x, v.y)) {
        // только со стороны камеры (x + y больше, чем у ствола): с дальней
        // стороны жителя закрывает крона — она огромная и по глубине ближе
        if (spot.cx + spot.cy <= tc[0] + tc[1]) continue;
        let open = 0;
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++)
            if (V.walkable(w, solid, spot.cx + dx, spot.cy + dy)) open++;
        const d = Math.hypot(t.x - v.x, t.y - v.y);
        if (!best || open > best.open || (open === best.open && d < best.d)) {
          best = { open: open, d: d, x: spot.x, y: spot.y, tree: t };
        }
        break;                                   // у дерева хватит одной клетки подхода
      }
    }
    if (!best) return { png: null, state: 'нет открытого дерева' };
    v.x = best.x; v.y = best.y;
    v.tree = best.tree;
    v.goal = { x: best.x, y: best.y };
    v.path = null; v.close = false; v.state = 'toward'; v.chopT = 0; v.hits = 0;
    for (let i = 0; i < 60 * 20 && v.state === 'toward'; i++) g.stepVillagers(1/60);
    if (v.state !== 'chop') return { png: null, state: v.state };
    const t = v.tree;
    for (let i = 0; i < 200; i++) {              // доматываем до кадра удара
      const before = v.phase;
      g.stepVillagers(1/60);
      if (before < V.CHOP_HIT && v.phase >= V.CHOP_HIT) break;
    }
    r.showGrid = false;
    r.hover = null;
    r.cam.zoom = 110;
    r.centerOn((v.x + t.x) / 2, (v.y + t.y) / 2 - 0.05);
    t.shake = 1;
    t._shakeT = (r.time || 0) - 0.03;
    r.render(r.time || 0);
    return {
      png: document.getElementById('view').toDataURL('image/png'),
      phase: +v.phase.toFixed(3), anim: v.anim,
      hits: v.hits, dist: +Math.hypot(t.x - v.x, t.y - v.y).toFixed(2),
      angle: +(r.treeShake(t, r.time || 0)).toFixed(3), tree: [t.x, t.y],
      hitPhase: V.CHOP_HIT
    };
  })()`);
  if (chopShot.png) {
    fs.writeFileSync(path.join(OUT, 'villager-chop.png'),
      Buffer.from(chopShot.png.split(',')[1], 'base64'));
    console.log('  villager-chop.png');
  }
  check('кадр «житель рубит»: анимация работы на фазе удара, топор у самого ствола',
    !!chopShot.png && chopShot.anim === 'work' &&
      chopShot.phase >= 0.5 && chopShot.phase < 0.62 && chopShot.dist < 1.0,
    chopShot.png
      ? `фаза ${chopShot.phase} (удар на ${chopShot.hitPhase}), до ствола ${chopShot.dist} клетки, ` +
        `ударов ${chopShot.hits}, тряска дерева ${chopShot.angle}`
      : 'житель не дошёл до дерева: ' + chopShot.state);

  /* Весь остров и путь жителя. Путь рисуется поверх экспорта PNG: он собран
   * в тех же пикселях кэша, поэтому ложится ровно на свои клетки. Прогон
   * здесь ПОВТОРЯЕТСЯ, а не берётся из проверок выше, и это не лишняя работа:
   * перегенерация построила другой остров, а координаты прошлого пути — того
   * мира. */
  const islandShot = async (name, trail, tree, title) => {
    const data = await js(`(() => {
      const g = window.__mapgen, r = g.renderer;
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
      const t = ${JSON.stringify(trail)};
      g2.lineWidth = 1.2;
      g2.strokeStyle = 'rgba(220,60,40,0.6)';
      g2.beginPath();
      for (let i = 0; i < t.length; i++) {
        const p = to(t[i][0], t[i][1]);
        if (i === 0) g2.moveTo(p[0], p[1]); else g2.lineTo(p[0], p[1]);
      }
      g2.stroke();
      const drawDot = (xy, color) => {
        const p = to(xy[0], xy[1]);
        g2.fillStyle = color;
        g2.beginPath(); g2.arc(p[0], p[1], 5, 0, 7); g2.fill();
      };
      if (t.length) { drawDot(t[0], '#2f8f3f'); drawDot(t[t.length - 1], '#c8281a'); }
      const tr = ${JSON.stringify(tree)};
      if (tr) { drawDot(tr, '#1d5fbf'); }
      g2.fillStyle = 'rgba(0,0,0,0.55)';
      g2.fillRect(0, 0, cv.width, 26);
      g2.fillStyle = '#fff';
      g2.font = '600 15px -apple-system, Segoe UI, Roboto, sans-serif';
      g2.fillText(${JSON.stringify(title)}, 10, 18);
      return cv.toDataURL('image/png');
    })()`);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data.split(',')[1], 'base64'));
    console.log('  ' + name + '.png');
  };

  /* Путь для кадра берётся из ГЛАВНОГО прогона (sim), а не проживается
     заново: это тот самый путь, шаги которого проверены выше, и остров на
     картинке — тот же. */
  await islandShot('villager-trail', sim.trail, sim.tree,
    'путь жителя к ближайшему дереву: ' + sim.walked.toFixed(1) + ' клетки за ' +
    (sim.steps / 60).toFixed(0) + ' с, встал на клетке ' + sim.stopCell.join(',') +
    ' (зелёная — старт, синяя — дерево, красная — где встал)');

  if (detour.ok && detour.trail) {
    await islandShot('villager-detour', detour.trail, detour.tree,
      'обход ратуши по пути к дереву: пятно ' + detour.fp.join('×') + ' в ' +
      detour.home.join(',') + ', пройдено ' + detour.walked.toFixed(1) +
      ' при кратчайшем ' + detour.octile.toFixed(1) + ' клетки');
  }

  /* --- 9. перегенерация карты ---------------------------------------- *
   * «Сгенерировать» в панели и `R` строят ДРУГОЙ мир, а путь жителя — это
   * клетки того мира, на котором он его считал. Забыть про это легко:
   * житель остаётся с прошлым путём и идёт по воде нового острова. Кнопка
   * тут настоящая, из панели, — тест жмёт её, а не зовёт функцию. */
  const regen = await js(`(() => {
    const g = window.__mapgen, V = window.Villagers;
    document.getElementById('seed').value = 'житель-перегенерация';
    document.getElementById('regen').click();
    const w = g.getWorld(), v = g.getVillagers()[0];
    if (!v) return { n: 0 };
    const W = w.width;
    /* Ставим его на клетку ПОДАЛЬШЕ от деревьев: иначе на новом острове дерево
       может оказаться соседним, прогон закончится на первом же шаге, и «он
       идёт по новой суше» превратится в «он стоит там же, где стоял». */
    const solid0 = V.blockedMap(w, g.getBuildings());
    const trees = [];
    for (const o of w.objects) if (o.kind === 'tree') trees.push([Math.floor(o.x), Math.floor(o.y)]);
    let far = null;
    for (let k = 0; k < W * w.height; k++) {
      const x = k % W, y = (k / W) | 0;
      if (!V.walkable(w, solid0, x, y)) continue;
      let d = Infinity;
      for (const t of trees) {
        const dd = Math.hypot(t[0] - x, t[1] - y);
        if (dd < d) d = dd;
      }
      if (!far || d > far.d) far = { x: x, y: y, d: d };
    }
    if (far) {
      v.x = far.x + 0.5; v.y = far.y + 0.5;
      v.path = null; v.tree = null; v.goal = null; v.state = 'toward'; v.walked = 0;
    }
    let water = 0, blocked = 0, off = 0, steps = 0;
    const start = [v.x, v.y];
    while (steps < 180 * 60 && v.state === 'toward') {
      g.stepVillagers(${DT});
      steps++;
      const cx = Math.floor(v.x), cy = Math.floor(v.y);
      if (cx < 0 || cy < 0 || cx >= W || cy >= w.height) off++;
      else if (!w.isLand[cy * W + cx]) water++;
      else if (V.blockedMap(w, g.getBuildings())[cy * W + cx]) blocked++;
    }
    const cell = [Math.floor(v.x), Math.floor(v.y)];
    return {
      n: g.getVillagers().length, water: water, blocked: blocked, off: off,
      state: v.state, tree: v.tree ? [v.tree.x, v.tree.y] : null,
      walked: Math.hypot(v.x - start[0], v.y - start[1]),
      from: [Math.floor(start[0]), Math.floor(start[1])], cell: cell,
      far: far ? +far.d.toFixed(1) : null,
      // рядом с ним (по осям) обязано стоять дерево — иначе он встал в поле
      adjacent: !!v.tree && (Math.abs(Math.floor(v.tree.x) - cell[0]) +
                             Math.abs(Math.floor(v.tree.y) - cell[1])) === 1,
      land: !!w.isLand[cell[1] * W + cell[0]],
      cells: V.landCells(w).length
    };
  })()`);
  check('после перегенерации карты житель остался один', regen.n === 1, regen.n + ' шт.');
  check('на новом острове он идёт к дереву новой суши, а не по старой',
    regen.water === 0 && regen.blocked === 0 && regen.off === 0 && regen.land &&
      regen.state !== 'toward',
    `${regen.water} в воде, ${regen.blocked} в занятых, ${regen.off} за картой; ` +
    `дерево ${regen.tree ? regen.tree.map(n => n.toFixed(1)).join(',') : '—'}`);
  check('и он снова идёт — от дальней от леса клетки к ближайшему дереву',
    regen.walked > 1 && regen.state !== 'toward' && regen.adjacent,
    `${regen.walked.toFixed(1)} клетки от клетки ${regen.from.join(',')} (до леса ${regen.far} клеток), ` +
    `встал на ${regen.cell.join(',')} рядом с деревом: ${regen.adjacent}`);

  console.log('\nитог пути: ' + sim.steps + ' шагов (' + (sim.steps / 60).toFixed(1) + ' с), ' +
    sim.walked.toFixed(1) + ' клеток до дерева, встал на клетке ' + sim.stopCell.join(',') +
    ', курс ' + sim.rot.toFixed(1) + '°');

  if (errors.length) { console.log('\nошибки:'); errors.forEach(e => console.log('  ' + e)); }
  else console.log('\nошибок в консоли нет');

  finish();

  function finish() {
    console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nИТОГ: ПРИНЯТО');
    ws.close(); chrome.kill('SIGKILL');
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    process.exit(fails ? 1 : 0);
  }
})().catch(e => { console.error('ошибка: ' + e.message); chrome.kill('SIGKILL'); process.exit(1); });
