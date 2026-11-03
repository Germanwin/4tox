/* game.js — автотест начала игры (нужен Chrome).
 *
 * Игра начинается с того, что открывается карта: случайная, с дефолтными
 * настройками, и на ней уже стоит ратуша игрока — вариант C под 90°, у
 * центра острова. Панель генератора при этом закрыта: открывается игра,
 * а не инструмент.
 *
 * Проверяет то, что легко сломать при правке:
 *   1) открывается карта с дефолтными параметрами, а не пустота;
 *   2) ратуша ровно одна, вариант C, поворот 90°, стоит на траве;
 *   3) она у центра острова, а не у воды и не в углу;
 *   4) место ищется от сида: тот же сид — та же ратуша, новый — новая;
 *   5) камера стоит на пределе отдаления: остров целиком и по половине
 *      его диаметра моря с каждой стороны;
 *   6) панель генератора спрятана и открывается кнопкой;
 *   7) кнопка срабатывает, даже нажатая у самой верхней кромки;
 *   8) обводка построек тонкая на любом отдалении (не жирнеет при зуме).
 *
 * Запуск: node tools/game.js [url]
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = require('./chrome.js');
const url = process.argv[2] || 'file://' + path.join(__dirname, '..', 'index.html');
const OUT = path.join(__dirname, 'out');
const PORT = 9900 + (process.pid % 90);
const PROFILE = '/tmp/dsh-game-' + process.pid;

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--hide-scrollbars',
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

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 3600));

  console.log('начало игры:');

  /* --- 1. карта ----------------------------------------------------- */
  const world = await js(`(() => {
    const g = window.__mapgen, w = g.getWorld();
    if (!w) return null;
    const p = g.readUI();
    return { seed: w.seed, islandSize: w.islandSize, sea: w.sea,
             land: w.stats.landShare, want: p.land, size: p.size,
             tiles: w.width, objects: w.objects.length,
             bounds: w.landBounds };
  })()`);
  check('при открытии сгенерировалась карта', !!world, world ? world.tiles + '×' + world.tiles : 'нет мира');
  if (!world) { finish(); return; }
  check('карта дефолтного размера', world.islandSize === world.size, 'домен ' + world.islandSize);
  check('доля суши совпадает с дефолтной',
    Math.abs(world.land - 0.62) < 0.02, (world.land * 100).toFixed(1) + ' %');
  check('вокруг острова есть полоса моря', world.sea >= 4, world.sea + ' клеток');
  check('на карте есть объекты (лес и камни)', world.objects > 200, world.objects + ' шт.');

  /* --- 2. деревня: ратуша, дом и лагерь ----------------------------- */
  const home = await js(`(() => {
    const g = window.__mapgen, w = g.getWorld(), B = window.Buildings;
    const list = g.getBuildings();
    if (!list.length) return { n: 0 };
    const b = list[0], fp = B.footprint(b.rot, b.type);
    const grass = [];
    for (let j = 0; j < fp.h; j++) for (let i = 0; i < fp.w; i++) {
      const x = b.x + i, y = b.y + j;
      const inside = x >= 0 && y >= 0 && x < w.width && y < w.height;
      grass.push(inside && w.tile[y * w.width + x] === window.WorldGen.T.GRASS);
    }
    const others = list.slice(1).map(o => {
      const ofp = B.footprint(o.rot, o.type);
      let og = 0;
      for (let j = 0; j < ofp.h; j++) for (let i = 0; i < ofp.w; i++)
        if (w.tile[(o.y + j) * w.width + (o.x + i)] === window.WorldGen.T.GRASS) og++;
      return { type: B.typeOf(o), variant: o.variant, rot: o.rot, x: o.x, y: o.y,
               fp: [ofp.w, ofp.h], grass: og, cells: ofp.w * ofp.h,
               junk: B.occupants(w, o).length, yard: B.yardOccupants(w, o, 1).length };
    });
    let overlap = false;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++)
      if (B.overlaps(list[i], list[j])) overlap = true;
    return {
      n: list.length, type: B.typeOf(b), variant: b.variant, rot: b.rot, x: b.x, y: b.y,
      fp: [fp.w, fp.h],
      grass: grass.filter(Boolean).length, cells: grass.length,
      fpOccupants: B.occupants(w, b).length,
      yardOccupants: B.yardOccupants(w, b, 1).length,
      center: { x: b.x + fp.w / 2, y: b.y + fp.h / 2 },
      others: others, overlap: overlap
    };
  })()`);
  check('в деревне три постройки: ратуша, дом и лагерь лесоруба', home.n === 3, home.n + ' шт.');
  check('первая — ратуша игрока, за ней дом жителя и лагерь лесоруба',
    home.type === 'townhall' && home.others.map(o => o.type).join(',') === 'house,lumbercamp',
    [home.type].concat(home.others.map(o => o.type)).join(', '));
  check('военного лагеря на старте нет',
    !home.others.some(o => o.type === 'warcamp'),
    home.others.map(o => o.type).join(',') || 'пусто');
  check('дом и лагерь стоят на траве, площадки и дворы чисты',
    home.others.every(o => o.grass === o.cells && o.junk === 0 && o.yard === 0),
    home.others.map(o => o.type + ' трава ' + o.grass + '/' + o.cells +
      ', мусор ' + o.junk + ', двор ' + o.yard).join(' · '));
  check('пятна построек деревни не пересекаются', !home.overlap);
  check('это вариант C', home.variant === 'c', String(home.variant));
  check('она повёрнута на 90°', home.rot === 90, home.rot + '°');
  check('пятно при повороте 90° — 3 × 4', home.fp.join('×') === '3×4', home.fp.join('×'));
  check('ратуша стоит на траве', home.grass === home.cells,
    home.grass + ' из ' + home.cells + ' клеток');
  check('под ратушей и во дворе чисто',
    home.fpOccupants === 0 && home.yardOccupants === 0,
    `в пятне ${home.fpOccupants}, во дворе ${home.yardOccupants}`);

  const cx = (world.bounds.x0 + world.bounds.x1) / 2;
  const cy = (world.bounds.y0 + world.bounds.y1) / 2;
  const d = Math.hypot(home.center.x - cx, home.center.y - cy);
  const size = world.bounds.x1 - world.bounds.x0;
  check('ратуша стоит у центра острова', d < size * 0.15,
    `смещение ${d.toFixed(1)} клетки при острове ${size}`);

  /* --- 3. место — от сида ------------------------------------------- */
  const repeat = await js(`(() => {
    const g = window.__mapgen, seed = g.getWorld().seed;
    document.getElementById('seed').value = seed;
    g.newGame();
    const a = g.getBuildings()[0];
    document.getElementById('seed').value = seed;
    g.newGame();
    const b = g.getBuildings()[0];
    return { same: a.x === b.x && a.y === b.y, first: [a.x, a.y], second: [b.x, b.y] };
  })()`);
  check('тот же сид — та же ратуша', repeat.same, JSON.stringify(repeat.first));

  const fresh = await js(`(() => {
    const g = window.__mapgen, before = g.getWorld().seed;
    let moved = 0, seeds = new Set([before]), spots = new Set();
    for (let i = 0; i < 6; i++) {
      document.getElementById('seed').value = window.randomSeed();
      g.newGame();
      const b = g.getBuildings()[0];
      seeds.add(g.getWorld().seed);
      spots.add(b.x + ',' + b.y);
    }
    return { seeds: seeds.size, spots: spots.size };
  })()`);
  check('новый сид — новая карта', fresh.seeds >= 6, fresh.seeds + ' разных сидов из 7');
  check('новый сид — новая ратуша', fresh.spots >= 3, fresh.spots + ' разных мест из 7');

  /* --- 4. кадр ------------------------------------------------------ */
  const frame = await js(`(() => {
    const g = window.__mapgen, r = g.renderer, w = g.getWorld(), b = w.landBounds;
    const z = r.cam.zoom, v = r.viewBox();
    const isl = { w: ((b.x1 - b.x0) + (b.y1 - b.y0)) * z * 0.5,
                  h: ((b.x1 - b.x0) + (b.y1 - b.y0)) * z * 0.25 };
    const vis = { w: ((v.x1 - v.x0) + (v.y1 - v.y0)) * z * 0.5,
                  h: ((v.x1 - v.x0) + (v.y1 - v.y0)) * z * 0.25 };
    return { z: z, min: r.minZoom, isl: isl, vis: vis, css: [r.cssW, r.cssH],
             cam: [r.cam.x, r.cam.y], centre: [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] };
  })()`);
  check('камера на пределе отдаления', Math.abs(frame.z - frame.min) < 1e-6,
    `зум ${frame.z.toFixed(2)}, предел ${frame.min.toFixed(2)}`);
  check('остров виден целиком', frame.isl.w <= frame.css[0] + 1 && frame.isl.h <= frame.css[1] + 1,
    `остров ${frame.isl.w.toFixed(0)}×${frame.isl.h.toFixed(0)} в ${frame.css.join('×')}`);
  const seaX = (frame.vis.w - frame.isl.w) / 2 / frame.isl.w;
  const seaY = (frame.vis.h - frame.isl.h) / 2 / frame.isl.h;
  check('по краям — половина диаметра острова моря',
    Math.abs(seaX - 0.5) < 0.12 && Math.abs(seaY - 0.5) < 0.12,
    `${(seaX * 100).toFixed(0)} % и ${(seaY * 100).toFixed(0)} %`);
  check('камера смотрит в центр острова',
    Math.hypot(frame.cam[0] - frame.centre[0], frame.cam[1] - frame.centre[1]) < 1,
    `камера ${frame.cam.map(v => v.toFixed(1))}, центр ${frame.centre.map(v => v.toFixed(1))}`);

  /* --- 5. панель ---------------------------------------------------- */
  const panel = await js(`(() => {
    const p = document.getElementById('panel');
    const hidden = p.classList.contains('hidden');
    window.__mapgen.setPanel(true);
    const shown = !p.classList.contains('hidden');
    window.__mapgen.setPanel(false);
    return { hidden: hidden, shown: shown };
  })()`);
  check('панель генератора при открытии игры спрятана', panel.hidden);
  check('панель открывается и закрывается', panel.shown);

  /* --- 5a. нажатие у самой кромки кнопки ----------------------------- *
   * Та же беда, что и в игре (game/css/base.css, «нажатие у самой кромки
   * кнопки»): на :active коробка уезжает вниз, и отпускание на прежнем
   * месте достаётся родителю — нажатие видно, действия нет. Между нажатием
   * и отпусканием здесь пауза длиннее перехода: короткий клик проскочил бы
   * раньше, чем кнопка уедет, и проверка была бы зелёной на сломанном. */
  {
    await js(`window.__mapgen.setPanel(true)`);
    await new Promise(r => setTimeout(r, 200));
    const dicePt = await js(`(() => {
      const b = document.getElementById('dice').getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + 1) };
    })()`);
    const seedBefore = await js(`document.getElementById('seed').value`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dicePt.x, y: dicePt.y });
    await new Promise(r => setTimeout(r, 60));
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dicePt.x, y: dicePt.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 240));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dicePt.x, y: dicePt.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 120));
    const seedAfter = await js(`document.getElementById('seed').value`);
    check('кубик срабатывает, нажатый у верхней кромки',
      !!seedAfter && seedAfter !== seedBefore, seedBefore + ' → ' + seedAfter);
    await js(`window.__mapgen.setPanel(false)`);
  }

  /* --- 6. клавиша панели -------------------------------------------- */
  {
    const press = (k, code, vk) => send('Input.dispatchKeyEvent',
      { type: 'keyDown', key: k, code: code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
      .then(() => send('Input.dispatchKeyEvent',
        { type: 'keyUp', key: k, code: code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }));
    const isOpen = () => js(`!document.getElementById('panel').classList.contains('hidden')`);

    await press('`', 'Backquote', 192);
    await new Promise(r => setTimeout(r, 120));
    const byLatin = await isOpen();
    await press('`', 'Backquote', 192);
    await new Promise(r => setTimeout(r, 120));

    // На русской раскладке та же клавиша отдаёт «ё»: панель обязана
    // открываться и ею, иначе на русской клавиатуре сочетание не работает.
    await press('ё', 'Backquote', 192);
    await new Promise(r => setTimeout(r, 120));
    const byCyr = await isOpen();
    await press('ё', 'Backquote', 192);
    await new Promise(r => setTimeout(r, 120));

    check('панель открывается клавишей `', byLatin);
    check('панель открывается клавишей ё (русская раскладка)', byCyr);
  }

  /* --- 7. правка постройки: класс, правила, проверка места -------------- *
   * Экран правки — это игра (game/js/play.js: удержание ЛКМ и полоса кнопок),
   * но ВСЕ её правила живут в движке: чем постройка отличается от дерева
   * (make/isBuilding), что с ней можно делать (EDIT/canEdit), годится ли место
   * (checkAt/canApply), как её подвинуть (setSpot/touch/snapshot/restore) и как
   * снести (remove). Поэтому проверяются они здесь, на своём месте, а экран —
   * в приёмке игры (game/tools/menu.js).
   *
   * Мир эта проверка не портит: двигается одна постройка и возвращается на
   * место (restore), а снос идёт по КОПИИ списка. */
  console.log('\nправка постройки (движок):');

  const cls = await js(`(() => {
    const g = window.__mapgen, w = g.getWorld(), B = window.Buildings;
    const made = B.make({ type: 'house', variant: 'a', rot: 100, x: 12.6, y: 7.4 });
    const nan = B.make({ x: undefined, y: 'нет', rot: -450 });
    return {
      kind: made.kind, rot: made.rot, x: made.x, y: made.y,
      type: made.type, variant: made.variant,
      isB: B.isBuilding(made),
      tree: B.isBuilding(w.objects.find(o => o.kind === 'tree')),
      stone: B.isBuilding(w.objects.find(o => o.kind === 'stone')),
      bush: B.isBuilding(w.objects.find(o => o.kind === 'bush')),
      plain: B.isBuilding({ x: 1, y: 1, type: 'tree' }),
      nanX: nan.x, nanY: nan.y, nanRot: nan.rot
    };
  })()`);
  check('make ставит классификатор kind = building',
    cls.kind === 'building' && cls.isB, String(cls.kind));
  check('make округляет место и приводит поворот к четверти',
    cls.x === 13 && cls.y === 7 && cls.rot === 90, cls.x + ',' + cls.y + ' · ' + cls.rot + '°');
  check('make переносит остальные поля как есть',
    cls.type === 'house' && cls.variant === 'a', cls.type + ' ' + cls.variant);
  check('без координат и с чужим углом постройка всё равно целая',
    cls.nanX === 0 && cls.nanY === 0 && cls.nanRot === 270,
    cls.nanX + ',' + cls.nanY + ' · ' + cls.nanRot + '°');
  check('деревья, камни и кусты постройками не считаются',
    !cls.tree && !cls.stone && !cls.bush && !cls.plain);

  const rules = await js(`(() => {
    const B = window.Buildings;
    const t = B.make({ type: 'townhall', x: 0, y: 0 });
    const h = B.make({ type: 'house', x: 0, y: 0 });
    const c = B.make({ type: 'lumbercamp', x: 0, y: 0 });
    const w = B.make({ type: 'warcamp', x: 0, y: 0 });
    const u = B.make({ type: 'hut', x: 0, y: 0 });
    const n = B.make({ x: 0, y: 0 });
    return {
      edit: B.EDIT, th: B.editRules(t), h: B.editRules(h), c: B.editRules(c),
      w: B.editRules(w), unknown: B.editRules(u), noType: B.editRules(n),
      thRemove: B.canEdit(t, 'remove'), hRemove: B.canEdit(h, 'remove'),
      cRemove: B.canEdit(c, 'remove'), wRemove: B.canEdit(w, 'remove'),
      thMove: B.canEdit(t, 'move'), thRotate: B.canEdit(t, 'rotate')
    };
  })()`);
  check('правила по типам совпадают с таблицей правки',
    rules.th.move && rules.th.rotate && !rules.th.remove &&
    rules.h.move && rules.h.rotate && rules.h.remove &&
    rules.c.move && rules.c.rotate && rules.c.remove &&
    rules.w.move && rules.w.rotate && !rules.w.remove,
    'ратуша ' + JSON.stringify(rules.th) + ' · дом ' + JSON.stringify(rules.h) +
    ' · лагерь ' + JSON.stringify(rules.c) + ' · военный лагерь ' + JSON.stringify(rules.w));
  check('неизвестный тип получает строку дома, постройка без типа — ратуши',
    rules.unknown.remove === true && rules.noType.remove === false,
    'чужой тип ' + JSON.stringify(rules.unknown) + ' · без типа ' + JSON.stringify(rules.noType));
  check('ратушу нельзя снести, но можно двигать и поворачивать',
    !rules.thRemove.ok && rules.thMove.ok && rules.thRotate.ok, rules.thRemove.reason);
  check('фраза отказа у ратуши — готовая, для интерфейса',
    rules.thRemove.reason === 'ратушу снести нельзя', rules.thRemove.reason);
  check('военный лагерь можно двигать и поворачивать, но не сносить',
    !rules.wRemove.ok && rules.wRemove.reason === 'военный лагерь снести нельзя',
    rules.wRemove.reason);

  const edit = await js(`(() => {
    const g = window.__mapgen, w = g.getWorld(), B = window.Buildings, V = window.Villagers;
    const W = w.width, list = g.getBuildings();
    /* Правим и сносим ЛАГЕРЬ ЛЕСОРУБА: военный лагерь сносить нельзя (в нём
       дружина), а тест про снос и переезд — про обычную постройку. */
    const b = list.find(x => B.typeOf(x) === 'lumbercamp') || list[list.length - 1];
    const idx = (x) => B.cells(x).map(c => c.y * W + c.x);
    const marks = (cells, solid) => cells.map(i => solid[i]);
    const near = (from, keys) => {
      for (let d = 2; d <= 8; d++) {
        const cands = [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, d], [d, -d], [-d, -d]];
        for (let k = 0; k < cands.length; k++) {
          const chk = B.checkAt(w, list, b, { x: from.x + cands[k][0], y: from.y + cands[k][1] });
          if (keys(chk)) return { x: from.x + cands[k][0], y: from.y + cands[k][1], chk: chk };
        }
      }
      return null;
    };

    // 1. строгая проверка на своём месте и что она возвращает
    const stand = B.canApply(w, list, b);
    const solid0 = V.blockedMap(w, list);
    const ver0 = w._villagerBlocked.version;
    const idx0 = idx(b);
    const wasSolid = marks(idx0, solid0);
    const rev0 = w._buildRev || 0;
    const snap = B.snapshot(b);

    // 2. сдвиг на место, которое движок считает годным
    const free = near(b, (chk) => chk.ok);
    B.setSpot(w, b, free ? { x: free.x, y: free.y } : { x: b.x, y: b.y });
    const movedTo = { x: b.x, y: b.y };
    const idx1 = idx(b);
    const rev1 = w._buildRev;
    const solid1 = V.blockedMap(w, list);
    const ver1 = w._villagerBlocked.version;
    const stayed = idx0.filter(i => idx1.indexOf(i) < 0);
    const arrived = idx1.filter(i => idx0.indexOf(i) < 0);
    const movedOk = B.canApply(w, list, b).ok;

    // 3. «отменить» возвращает и место, и карту проходимости
    B.restore(w, b, snap);
    const solid2 = V.blockedMap(w, list);
    const backSame = JSON.stringify(B.snapshot(b)) === JSON.stringify(snap);
    const backSolid = marks(idx0, solid2);
    const backArrivedFree = marks(arrived, solid2);

    // 4. отказы словами: занятое пятно, вода, край карты, деревья
    const other = list[0];
    const occupied = B.checkAt(w, list, b, { x: other.x, y: other.y, rot: other.rot });
    let water = null;
    for (let i = 0; i < w.tile.length && !water; i++) {
      if (w.tile[i] !== window.WorldGen.T.WATER) continue;
      const x = i % W, y = Math.floor(i / W), fp = B.footprint(b.rot, b.type);
      if (x < 1 || y < 1 || x + fp.w >= W || y + fp.h >= w.height) continue;
      const chk = B.checkAt(w, list, b, { x: x, y: y });
      if (chk.reason === 'вода') water = { x: x, y: y, reason: chk.reason, ok: chk.ok, blocked: chk.blocked.length };
    }
    const edge = B.checkAt(w, list, b, { x: -1, y: 0 });
    // Дерево в пятне — отказ словами (в правке не расчищаем)...
    const trees = near(b, (chk) => chk.blocked.length > 0 && /^мешают деревья и камни: \\d+$/.test(chk.reason));
    // ...а куст, трава, цветы, камыш и галька — не отказ: место годится, и
    // мелочь эта только сомнётся при «применить» (правило заказчика
    // 2026-10-17, js/buildings.js: obstacle/decor).
    const weeds = near(b, (chk) => chk.ok && chk.blocked.length === 0 && chk.decor.length > 0);
    // кольцо вокруг пятна: занято, а постройка всё равно годится — это
    // предупреждение, а не запрет
    const ring = near(b, (chk) => chk.ok && chk.blocked.length === 0 && chk.yardBlocked.length > 0);

    // 5. снос: ратуша — отказ, лагерь — по КОПИИ списка (мир не трогаем)
    const copy = list.slice();
    const delTh = B.remove(w, copy, copy[0]);
    const afterTh = copy.length;
    const delCamp = B.remove(w, copy, b);
    const afterCamp = copy.length;

    return {
      listLen: list.length, standOk: stand.ok, standReason: stand.reason,
      standBlocked: stand.blocked.length, standYard: stand.yard.length,
      standFp: [stand.fp.w, stand.fp.h],
      free: free ? { x: free.x, y: free.y } : null,
      moved: movedTo, movedOk: movedOk, rev0: rev0, rev1: rev1,
      wasSolid: wasSolid, arrived: marks(arrived, solid1), stayedFree: marks(stayed, solid1),
      ver0: ver0, ver1: ver1, ver2: w._villagerBlocked.version,
      backSame: backSame, back: { x: b.x, y: b.y, rot: b.rot },
      backSolid: backSolid, backArrivedFree: backArrivedFree,
      occupied: { ok: occupied.ok, reason: occupied.reason },
      water: water, edge: { ok: edge.ok, reason: edge.reason },
      trees: trees ? { reason: trees.chk.reason, blocked: trees.chk.blocked.length } : null,
      weeds: weeds ? { ok: weeds.chk.ok, blocked: weeds.chk.blocked.length,
                       decor: weeds.chk.decor.length,
                       kinds: weeds.chk.decor.map(o => o.kind) } : null,
      ring: ring ? { cells: ring.chk.yardBlocked.length, ok: ring.chk.ok, reason: ring.chk.reason } : null,
      delTh: delTh, afterTh: afterTh, delCamp: delCamp, afterCamp: afterCamp,
      campStill: list.indexOf(b) >= 0
    };
  })()`);
  check('постройка на своём месте проходит строгую проверку',
    edit.standOk && edit.standReason === '', edit.standReason || 'годится');
  check('checkAt отвечает пятном, запретом и кольцом',
    edit.standFp.join('×') === '3×3' && edit.standBlocked === 0 && edit.standYard === 0,
    'пятно ' + edit.standFp.join('×') + ', в пятне ' + edit.standBlocked + ', в кольце ' + edit.standYard);
  check('setSpot двигает постройку и отмечает правку (touch)',
    !!edit.free && edit.moved.x === edit.free.x && edit.moved.y === edit.free.y && edit.rev1 === edit.rev0 + 1,
    JSON.stringify(edit.moved) + ' · rev ' + edit.rev0 + ' -> ' + edit.rev1);
  check('на новом месте постройка снова проходит проверку', edit.movedOk);
  check('карта проходимости знает про переезд: версия сменилась',
    edit.ver0 !== edit.ver1 && edit.ver1.endsWith('/' + edit.rev1),
    edit.ver0 + ' -> ' + edit.ver1);
  check('пятно на новом месте непроходимо, старое — свободно',
    edit.arrived.length > 0 && edit.arrived.every(v => v === 1) && edit.stayedFree.every(v => v === 0),
    'новых клеток ' + edit.arrived.length + ', освободилось ' + edit.stayedFree.length);
  check('restore возвращает место, поворот и проходимость',
    edit.backSame && edit.backSolid.every(v => v === 1) && edit.backArrivedFree.every(v => v === 0),
    JSON.stringify(edit.back) + ' · версия ' + edit.ver2);
  check('занятое пятно — отказ словами', !edit.occupied.ok && edit.occupied.reason === 'тут уже стоит постройка',
    edit.occupied.reason);
  check('вода — отказ словами', !!edit.water && !edit.water.ok && edit.water.reason === 'вода',
    edit.water ? edit.water.reason + ' в ' + edit.water.x + ',' + edit.water.y : 'воды не нашлось');
  check('край карты — отказ словами', !edit.edge.ok && edit.edge.reason === 'край карты', edit.edge.reason);
  check('деревья в пятне — отказ словами (в правке не расчищаем)',
    !edit.trees || (edit.trees.blocked > 0 && edit.trees.reason === 'мешают деревья и камни: ' + edit.trees.blocked),
    edit.trees ? edit.trees.reason : 'рядом чисто — проверять нечего');
  check('куст и трава в пятне — не отказ: место годится (2026-10-17)',
    !!edit.weeds && edit.weeds.ok === true && edit.weeds.blocked === 0 && edit.weeds.decor > 0,
    edit.weeds ? 'мелочи ' + edit.weeds.decor + ' (' + edit.weeds.kinds.join(', ') + '), запретов ' + edit.weeds.blocked
               : 'заросшего места не нашлось');
  check('кольцо вокруг пятна — предупреждение, а не запрет',
    !edit.ring || edit.ring.ok,
    edit.ring ? edit.ring.cells + ' клеток рядом, место всё равно годится' : 'кольца не нашлось');
  check('ратушу снести нельзя: список не изменился',
    !edit.delTh.ok && edit.delTh.reason === 'ратушу снести нельзя' &&
    edit.delTh.removed === 0 && edit.afterTh === edit.listLen, edit.delTh.reason);
  check('лагерь сносится: из списка уходит, world.objects не трогает',
    edit.delCamp.ok && edit.delCamp.removed === 1 && edit.afterCamp === edit.listLen - 1 && edit.campStill,
    'в списке ' + edit.afterCamp + ', в мире по-прежнему ' + edit.listLen);

  /* Порядок отрисовки и мигание правимой постройки — тоже движок (render.js):
     ведение здания зовёт invalidateOrder десятки раз в секунду, и миникарта при
     этом не пересобирается; полный setBuildings — только на «применить». */
  const paint = await js(`(() => {
    const g = window.__mapgen, r = g.renderer, list = g.getBuildings();
    const b = list[0], other = list[1];
    r.buildingOrder();
    /* Холст обзора переиспользуется (render.js: в сети обзор собирается 10 раз
       в секунду, и новые холсты не успевали освобождаться), поэтому
       «пересобран» — это выросший счётчик сборок, а не новый объект холста. */
    const mm = r.minimapVersion;
    const warm = !!r._order;
    r.invalidateOrder();
    const light = { order: r._order, mm: r.minimapVersion };
    r.setBuildings(list);
    const full = { order: !!r._order, mm: r.minimapVersion, minimap: !!r.minimap };

    const was = r.editing;
    r.editing = b;
    const step = 0.9 / 360, samples = [];
    for (let i = 0; i < 360; i++) samples.push(r.blinkAlpha(b, i * step));
    let jump = 0;
    for (let i = 1; i < samples.length; i++) jump = Math.max(jump, Math.abs(samples[i] - samples[i - 1]));
    const period = Math.max(Math.abs(r.blinkAlpha(b, 0.1) - r.blinkAlpha(b, 1.0)),
                            Math.abs(r.blinkAlpha(b, 0.37) - r.blinkAlpha(b, 1.27)));
    const out = {
      other: r.blinkAlpha(other, 0.3),
      min: Math.min.apply(null, samples), max: Math.max.apply(null, samples),
      jump: jump, period: period,
      // Четверть периода — максимум, половина — середина, три четверти — минимум:
      // по трём точкам видно, что это синус, а не «качели» какой-нибудь формы.
      quarter: r.blinkAlpha(b, 0.225), half: r.blinkAlpha(b, 0.45),
      threeQuarter: r.blinkAlpha(b, 0.675)
    };
    r.editing = was;
    return { mm: mm, warm: warm, light: light, full: full, blink: out };
  })()`);
  check('invalidateOrder сбрасывает порядок, но миникарту не пересобирает',
    paint.warm && !paint.light.order && paint.light.mm === paint.mm, 'обзор тот же самый');
  check('setBuildings пересобирает миникарту и сбрасывает порядок',
    !paint.full.order && paint.full.mm > paint.light.mm && !!paint.full.minimap, 'обзор собран заново');
  check('мигает только правимая постройка', paint.blink.other === 1);
  check('мигание — плавный синус 0.55..1 с периодом 0.9 с',
    Math.abs(paint.blink.min - 0.55) < 0.01 && Math.abs(paint.blink.max - 1) < 0.01 &&
    Math.abs(paint.blink.quarter - 1) < 0.01 && Math.abs(paint.blink.half - 0.775) < 0.01 &&
    Math.abs(paint.blink.threeQuarter - 0.55) < 0.01 &&
    paint.blink.jump < 0.02 && paint.blink.period < 1e-9,
    paint.blink.min.toFixed(3) + '..' + paint.blink.max.toFixed(3) +
    ', четверть ' + paint.blink.quarter.toFixed(3) + ', половина ' + paint.blink.half.toFixed(3) +
    ', три четверти ' + paint.blink.threeQuarter.toFixed(3) +
    ', шаг ' + paint.blink.jump.toFixed(4) + ', период ' + paint.blink.period.toExponential(1));

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const still = await js(`(() => {
    const g = window.__mapgen, r = g.renderer, list = g.getBuildings();
    const was = r.editing;
    r.editing = list[0];
    const out = { a: r.blinkAlpha(list[0], 0), b: r.blinkAlpha(list[0], 0.7), other: r.blinkAlpha(list[1], 0) };
    r.editing = was;
    return out;
  })()`);
  await send('Emulation.setEmulatedMedia', { features: [] });
  check('при «уменьшить движение» мигания нет: ровно 0.72',
    still.a === 0.72 && still.b === 0.72 && still.other === 1,
    still.a + ' и ' + still.b);

  /* --- обводка построек на разных отдалениях ------------------------- *
   *
   * Правило заказчика 2026-10-24: «когда отдаляешь, обводка спрайтов
   * сооружений становится слишком жирной». Толщина задана в пикселях ЭКРАНА,
   * а кайма режется в пикселях кадра, поэтому проверяется не формула, а то,
   * что реально ложится на холст: кайма рисуется тем же drawSpriteOutline и
   * считается по пикселям.
   *
   * Картинка спрайта — своя (прямоугольник на чистом холсте) того же размера,
   * что настоящий кадр ратуши: масштаб «пиксель кадра -> пиксель экрана» тот
   * же, а холст не «испачкан», и пиксели читаются под обычным file:// (с
   * атласом так нельзя — см. ниже про снимок экрана). */
  const edgeInk = await js(`(() => {
    const g = window.__mapgen, r = g.renderer, B = window.Buildings;
    const b = g.getBuildings()[0], set = r.spritesFor(b.type, false);
    const real = B.sprite(set, b.variant, b.rot);
    const sw = real.sw, sh = real.sh;
    const src = document.createElement('canvas'); src.width = sw; src.height = sh;
    const sg = src.getContext('2d');
    sg.fillStyle = '#7a6a4a';
    sg.fillRect(Math.round(sw * 0.1), Math.round(sh * 0.1),
                Math.round(sw * 0.8), Math.round(sh * 0.8));
    const spr = { img: src, sx: 0, sy: 0, sw: sw, sh: sh, ax: 0.5, ay: 0.5 };
    const cv = document.createElement('canvas'); cv.width = 900; cv.height = 900;
    const ctx = cv.getContext('2d');
    const wasZoom = r.cam.zoom, rows = [];
    for (const z of [r.minZoom, 16, 24, 40, 80, r.maxZoom]) {
      const sc = B.scaleAt(set, z);
      const dw = sw * sc.x, dh = sh * sc.y;
      const box = { spr: spr, dw: dw, dh: dh, dx: 450 - dw / 2, dy: 450 - dh / 2 };
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, 900, 900);
      r.cam.zoom = z;
      r.drawSpriteOutline(ctx, box, 'rgba(74,144,217,1)', 1.4);
      /* Строка через середину кадра пересекает кайму дважды — слева и справа.
         Сумма альфы и есть толщина в пикселях экрана: полупрозрачный край
         сглаживания входит долей. */
      const d = ctx.getImageData(0, 450, 900, 1).data;
      let ink = 0, outside = 0;
      for (let x = 0; x < 900; x++) {
        const a = d[x * 4 + 3] / 255;
        if (a > 0.06) {
          ink += a;
          if (x < box.dx - 1 || x > box.dx + dw + 1) outside++;
        }
      }
      rows.push({ zoom: z, dw: dw, side: ink / 2, outside: outside });
    }
    r.cam.zoom = wasZoom;
    return JSON.stringify({ rows: rows, cache: spr._edges.length });
  })()`);
  const ink = JSON.parse(edgeInk);
  const sides = ink.rows.map(r => r.side);
  check('обводка постройки одинакова на любом отдалении',
    sides.every(v => v > 0.6 && v < 2.0),
    ink.rows.map(r => r.zoom.toFixed(1) + ': ' + r.side.toFixed(2) + ' px (кадр ' + r.dw.toFixed(0) + ')').join(', '));
  check('обводка не вылезает за кадр', ink.rows.every(r => r.outside === 0));
  check('каёмочных холстов на спрайт не копится: не больше 6',
    ink.cache > 0 && ink.cache <= 6, 'холстов ' + ink.cache);

  /* --- кадр --------------------------------------------------------- *
   *
   * Снимок берётся через DevTools, а не через toDataURL холста: под
   * обычным file:// любая картинка считается чужим источником, холст
   * помечается как «испачканный», и выгрузить его нельзя. Заодно это
   * позволяет гонять весь тест без флага --allow-file-access-from-files,
   * то есть ровно в тех условиях, в которых игру открывает игрок.
   */
  await js(`(() => { window.__mapgen.renderer.render(1); window.__mapgen.drawMinimap(); return 1; })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(path.join(OUT, 'game-start.png'), Buffer.from(shot.data, 'base64'));
  console.log('  кадр game-start.png');

  /* --- 8. казарма и военный лагерь (движок) -------------------------- *
   *
   * Новая механика: в казарме не нанимают, а тренируют. Свободный житель
   * идёт ко входу, заступает на территорию, растворяется, пять секунд
   * тренируется и выходит воином; воин идёт в военный лагерь 5 x 5 и ходит
   * только по его территории, не заходя на модель 2 x 2.
   *
   * Вход проверяется на всех четырёх поворотах казармы: он считается по
   * двери, а не по середине фасада, и поворот не должен его ломать. */
  console.log('\nказарма: тренировка воинов (движок):');
  const bar = await js(`(() => {
    const g = window.__mapgen, B = window.Buildings, S = window.Session, V = window.Villagers;
    g.newGame();
    const w = g.getWorld(), list = g.getBuildings();
    /* На старте лагеря больше нет (требование 2026-10-23): ставим его здесь,
       как поставил бы игрок, — тест проверяет тренировку и патруль, а не
       стартовую деревню. */
    let camp = list.find(b => B.typeOf(b) === 'warcamp');
    if (!camp) {
      camp = B.findSpot(w, list, 'x', B.FACE_ROT, { type: 'warcamp', minSep: 0 });
      if (!camp) return { ok: false, why: 'места под военный лагерь нет' };
      B.settle(w, camp, { clear: true });
      list.push(camp);
      g.renderer.setBuildings(list);
    }

    /* Четыре казармы — по одной на каждый поворот. Место ищет движок, а не
       тест: пятно, зазор и пересечения остаются его правилами. */
    const bars = [];
    for (const rot of [0, 90, 180, 270]) {
      const spot = B.findSpot(w, list, 'a', rot, { type: 'barracks', minSep: 0 });
      if (!spot) return { ok: false, why: 'места под казарму нет (поворот ' + rot + ')' };
      B.settle(w, spot, { clear: true });
      list.push(spot);
      bars.push(spot);
    }
    g.renderer.setBuildings(list);

    /* Пять жителей: один нужен для проверки ровно пяти секунд, остальные
       четверо — по одному ученику на каждый поворот. Дом вмещает четверых,
       пятый остаётся бездомным — на тренировку это не влияет. */
    const home = list.find(b => B.typeOf(b) === 'house');
    g.spawnVillagers(list[0]);
    const vs = g.getVillagers();
    const door = B.frontSpot(home);
    while (vs.length < 5) {
      const extra = V.create(w, {
        index: vs.length, x: door.x + 0.5, y: door.y + 0.5,
        buildings: list, home: null, avoid: vs
      });
      vs.push(extra);
    }
    w._villagers = vs;
    g.renderer.setVillagers(vs);

    const before = {
      slots: B.trainingSlots(bars[0]), work: B.workSlots(bars[0]),
      workplace: S.isWorkplace(bars[0]), trainer: S.isTrainer(bars[0]),
      freeSet: g.renderer.villagerSet(vs[0]) === g.renderer.villagerSprites,
      hasKnight: !!g.renderer.knightSprites,
      hireReason: S.canHire(bars[0], vs[0], vs).reason
    };

    /* Вместимость: в казарму помещаются трое, четвёртый получает отказ. После
       проверки учеников возвращаем на улицу. */
    const batch = S.trainingBatchInfo(bars[0], vs, list);
    const all3 = S.trainAll(bars[0], vs, list);
    const capIds = S.traineesOf(bars[0], vs).map(v => v.id);
    const fourth = vs.find(v => S.freeForTraining(v));
    const full = fourth ? S.canTrain(bars[0], fourth, vs, list) : null;
    S.traineesOf(bars[0], vs).slice().forEach(v => S.cancelTraining(bars[0], v, { outside: true }));

    function snapshot(v, b) {
      const ent = B.entrance(b), fp = B.footprint(b.rot, 'barracks');
      const front = B.frontSpot(b, 0);
      return {
        rot: b.rot, state: v.state, trainee: !!v.trainee,
        trainAt: v.trainingAt === b,
        inFp: v.x >= b.x && v.x < b.x + fp.w && v.y >= b.y && v.y < b.y + fp.h,
        inFpPoint: ent.in.x >= b.x && ent.in.x < b.x + fp.w &&
                   ent.in.y >= b.y && ent.in.y < b.y + fp.h,
        outFp: ent.out.x < b.x || ent.out.x >= b.x + fp.w ||
               ent.out.y < b.y || ent.out.y >= b.y + fp.h,
        dist: Math.hypot(v.x - ent.in.x, v.y - ent.in.y),
        doorFromCenter: Math.hypot(ent.in.x - (b.x + fp.w / 2), ent.in.y - (b.y + fp.h / 2)),
        frontDist: Math.hypot(ent.in.x - (front.x + 0.5), ent.in.y - (front.y + 0.5)),
        doorX: ent.in.x, doorY: ent.in.y
      };
    }

    /* --- ровно пять секунд на одном ученике ---------------------------- */
    const tv = vs[0], tb = bars[0];
    const timing = {};
    timing.train = S.train(tb, tv, vs, list);
    let guard = 0;
    while (guard++ < 6000 && tv.state !== 'training') g.stepVillagers(0.1);
    timing.start = snapshot(tv, tb);
    timing.begin = { trainT: tv.trainT, hidden: !!tv.hidden,
                     vis: V.visibility(tv), trainee: !!tv.trainee,
                     warrior: !!tv.warrior };
    for (let i = 0; i < 48; i++) g.stepVillagers(0.1);    // 4.8 с
    timing.mid = { trainT: tv.trainT, trainee: !!tv.trainee, warrior: !!tv.warrior,
                   hidden: !!tv.hidden, vis: V.visibility(tv), state: tv.state };
    for (let i = 0; i < 3; i++) g.stepVillagers(0.1);     // 5.1 с
    const ent0 = B.entrance(tb), fp0 = B.footprint(tb.rot, tb.type);
    timing.done = {
      warrior: !!tv.warrior, trainee: !!tv.trainee, trainingAt: tv.trainingAt,
      hidden: !!tv.hidden, employer: tv.employer,
      warcamp: tv.warcamp === camp,
      knightSet: g.renderer.villagerSet(tv) === g.renderer.knightSprites,
      state: tv.state, doing: S.villagerDoing(tv, V.CHOP_TIME),
      atOut: Math.hypot(tv.x - ent0.out.x, tv.y - ent0.out.y) < 0.08,
      outsideBar: tv.x < tb.x || tv.x >= tb.x + fp0.w || tv.y < tb.y || tv.y >= tb.y + fp0.h,
      startPos: timing.start ? [timing.start.doorX, timing.start.doorY] : null
    };

    /* --- вход на всех четырёх поворотах -------------------------------- *
     * Ждём НЕ «все сразу тренируются» (первый успел бы закончить, пока
     * последний идёт), а первого кадра тренировки у каждого. */
    const assigned = [];
    for (let i = 0; i < 4; i++) {
      const r = S.train(bars[i], vs[i + 1], vs, list);
      assigned.push({ rot: bars[i].rot, ok: r.ok, reason: r.reason,
                      trainee: vs[i + 1].trainee, employer: vs[i + 1].employer,
                      state: vs[i + 1].state, id: vs[i + 1].id });
    }
    const seen = [false, false, false, false];
    const doors = [null, null, null, null];
    guard = 0;
    while (guard++ < 6000 && !seen.every(Boolean)) {
      g.stepVillagers(0.1);
      for (let i = 0; i < 4; i++) {
        const v = vs[i + 1];
        if (!seen[i] && v.trainee && v.state === 'training') {
          seen[i] = true;
          doors[i] = snapshot(v, bars[i]);
        }
      }
    }
    const arrived = seen.every(Boolean);

    /* Все доучиваются: и пятый, и первый (он уже воин). */
    guard = 0;
    while (guard++ < 9000 && vs.filter(v => v.warrior).length < 5) g.stepVillagers(0.1);
    const allWarriors = S.warriorsOf(vs).map(v => v.id);

    /* Прогулка по лагерю: ждём, пока все войдут, и 120 с смотрим, что никто не
       вышел за пятно и не заступил на модель. */
    guard = 0;
    let entered = false;
    while (guard++ < 12000 && !(entered = vs.every(v =>
      B.insideWarcamp(v.warcamp, v.x, v.y)))) {
      g.stepVillagers(0.1);
    }
    const model = B.modelCells(camp).map(c => c.x + ',' + c.y);
    let outside = 0, onModel = 0, checked = 0;
    for (let i = 0; i < 1200; i++) {
      g.stepVillagers(0.1);
      for (const v of vs) {
        checked++;
        const cx = Math.floor(v.x), cy = Math.floor(v.y);
        if (!B.insideWarcamp(v.warcamp, v.x, v.y)) outside++;
        if (model.indexOf(cx + ',' + cy) >= 0) onModel++;
      }
    }
    const fp = B.footprint(camp.rot, camp.type);
    const states = {};
    for (const v of vs) states[v.state] = (states[v.state] || 0) + 1;

    return {
      ok: true, before: before, batch: batch.train, all3: all3,
      capIds: capIds, full: full,
      timing: timing, assigned: assigned, arrived: arrived,
      doors: doors, allWarriors: allWarriors, entered: entered,
      outside: outside, onModel: onModel, checked: checked,
      warcamp: { x: camp.x, y: camp.y, w: fp.w, h: fp.h,
                 patrol: B.patrolCells(camp).length, model: B.modelCells(camp).length },
      states: Object.keys(states).join(','),
      free: vs.filter(v => S.freeForTraining(v)).length,
      campWorkers: S.workersOf(camp, vs).length,
      knights: vs.filter(v => V.isKnight(v)).length
    };
  })()`);
  check('казарма: тренировочных мест 3, рабочих мест 0; это не рабочее место, а тренажёр',
    bar.ok && bar.before.slots === 3 && bar.before.work === 0 &&
    bar.before.workplace === false && bar.before.trainer === true,
    bar.ok ? 'мест ' + bar.before.slots + ', рабочих ' + bar.before.work : bar.why);
  check('нанимать в казарму больше нельзя: причина словами движка',
    bar.ok && bar.before.hireReason === 'в казарме тренируют, а не нанимают',
    bar.ok ? bar.before.hireReason : bar.why);
  check('пакетная тренировка заполняет ровно три места, четвёртый получает отказ',
    bar.ok && bar.batch.ok && bar.batch.count === 3 && bar.all3.ok && bar.all3.trained === 3 &&
    bar.capIds.join(',') === '1,2,3' && bar.full &&
    bar.full.reason === 'в казарме нет свободных мест для тренировки',
    bar.ok ? 'обучались ' + bar.capIds.join(',') + ', четвёртому: ' + (bar.full && bar.full.reason) : bar.why);
  check('житель дошёл именно ко входу: на территории казармы, у двери, на всех поворотах',
    bar.ok && bar.arrived && bar.doors.every(d =>
      d && d.state === 'training' && d.trainee && d.trainAt && d.inFp && d.inFpPoint &&
      d.outFp && d.dist < 0.08 && d.doorFromCenter > 0.2 && d.frontDist > 0.2),
    bar.ok ? bar.doors.map((d, i) => (i ? ' · ' : '') + (d ?
      d.rot + '°: d=' + d.dist.toFixed(3) + ' от центра ' + d.doorFromCenter.toFixed(2) :
      '—')).join('') : bar.why);
  check('порог — внутри пятна, а клетка снаружи перед ним: он заступил, а не встал рядом',
    bar.ok && bar.doors.every(d => d && d.inFpPoint && d.outFp),
    bar.ok ? bar.doors.map(d => d.doorX.toFixed(1) + ',' + d.doorY.toFixed(1)).join(' · ') : bar.why);
  check('все четыре казармы (0/90/180/270) отправили жителей учиться',
    bar.ok && bar.assigned.length === 4 &&
    bar.assigned.every(a => a.ok && a.trainee && a.employer === null),
    bar.ok ? bar.assigned.map(a => a.rot + '°:' + a.ok + ' v' + a.id).join(' · ') : bar.why);
  check('пока идёт — он обычный житель; воинский атлас включается только после выхода',
    bar.ok && bar.before.freeSet && bar.before.hasKnight &&
    bar.timing.begin.trainee && !bar.timing.begin.warrior && bar.timing.done.knightSet,
    bar.ok ? 'до: житель, после: воин' : bar.why);
  check('тренировка идёт ровно 5 секунд: 4.8 — ещё ученик, 5.1 — уже воин',
    bar.ok && bar.timing.train && bar.timing.train.ok &&
    bar.timing.begin.trainT > 4.9 && bar.timing.begin.trainT <= 5.0 &&
    bar.timing.mid.trainee && !bar.timing.mid.warrior && bar.timing.mid.trainT > 0.1 &&
    bar.timing.done.warrior && !bar.timing.done.trainee && bar.timing.done.trainingAt === null,
    bar.ok ? 'на входе ' + bar.timing.begin.trainT.toFixed(2) + ' с, через 4.8 — ' +
      bar.timing.mid.trainT.toFixed(2) + ' с' : bar.why);
  check('войдя в казарму, он растворяется: скрыт и невидим на тренировке',
    bar.ok && bar.timing.mid.hidden && bar.timing.mid.vis === 0 && bar.timing.begin.vis > 0,
    bar.ok ? 'скрыт ' + bar.timing.mid.hidden + ', видимость ' + bar.timing.mid.vis : bar.why);
  check('после тренировки он воин, стоит за дверью и идёт в военный лагерь',
    bar.ok && bar.timing.done.warrior && bar.timing.done.warcamp &&
    bar.timing.done.atOut && bar.timing.done.outsideBar && bar.timing.done.employer === null &&
    (bar.timing.done.state === 'toWarcamp' || bar.timing.done.state === 'patrol') &&
    (bar.timing.done.doing === 'идёт в военный лагерь' || bar.timing.done.doing === 'воин в лагере'),
    bar.ok ? bar.timing.done.state + ' · ' + bar.timing.done.doing : bar.why);
  check('после обучения воинов пятеро, работодателя у них нет',
    bar.ok && bar.allWarriors.join(',') === '1,2,3,4,5' &&
    bar.knights === 5 && bar.free === 0 && bar.campWorkers === 0,
    bar.ok ? 'воины ' + bar.allWarriors.join(',') + ', свободных ' + bar.free : bar.why);
  check('все пятеро вошли на территорию 5 x 5',
    bar.ok && bar.entered, bar.ok ? 'вошли' : bar.why);
  check('на территории лагеря 21 свободная клетка и 4 клетки модели',
    bar.ok && bar.warcamp.patrol === 21 && bar.warcamp.model === 4,
    bar.ok ? 'площадка ' + bar.warcamp.w + 'x' + bar.warcamp.h +
      ', ходить ' + bar.warcamp.patrol + ', модель ' + bar.warcamp.model : bar.why);
  check('за 120 с воины ни разу не вышли за лагерь и не заступили на модель 2 x 2',
    bar.ok && bar.outside === 0 && bar.onModel === 0 && bar.checked === 5 * 1200,
    bar.ok ? 'проверок ' + bar.checked + ', снаружи ' + bar.outside +
      ', на модели ' + bar.onModel : bar.why);
  check('ходят они только по территории: состояния воина, без найма и леса',
    bar.ok && bar.states.split(',').every(s => s === 'toWarcamp' || s === 'patrol' || s === 'stand'),
    bar.ok ? bar.states : bar.why);

  /* --- 9. панели найма и казармы: только свои жители ------------------- *
   *
   * В «против деревни» список партии общий: в нём и жители игрока, и 16
   * жителей врага. Панели найма и казармы — про деревню игрока, и чужих в них
   * быть не должно: нанимать и тренировать их всё равно нельзя (canHire и
   * canTrain отвечают отказом), но строка в списке обещала бы обратное.
   */
  console.log('\nпанели найма и казармы: только свои жители:');
  const own = await js(`(() => {
    const g = window.__mapgen, B = window.Buildings, S = window.Session;
    const list = g.getBuildings(), vs = g.getVillagers();
    const camp = list.find(b => B.typeOf(b) === 'lumbercamp');
    const bar = list.find(b => B.typeOf(b) === 'barracks');
    const enemyCamp = { id: 'enemy-camp', type: 'lumbercamp', variant: 'a', rot: 0, owner: 1, x: 0, y: 0 };
    const enemy = [
      { id: 901, owner: 1, x: 0, y: 0, employer: enemyCamp, warrior: false, trainee: false },
      { id: 902, owner: 1, x: 0, y: 0, employer: null, warrior: true, trainee: false },
      { id: 903, owner: 1, x: 0, y: 0, employer: null, warrior: false, trainee: false }
    ];
    const mixed = vs.concat(enemy);
    return {
      own: vs.map(v => v.id),
      hire: S.hireOrder(camp, mixed).map(v => v.id),
      train: S.trainingOrder(bar, mixed).map(v => v.id),
      allWarriors: S.warriorsOf(mixed).map(v => v.id),
      ownWarriors: S.warriorsOf(mixed, 0).map(v => v.id),
      hireInfo: S.batchInfo(camp, mixed),
      ownHireInfo: S.batchInfo(camp, vs),
      trainInfo: S.trainingBatchInfo(bar, mixed, list),
      ownTrainInfo: S.trainingBatchInfo(bar, vs, list),
      enemyHire: S.canHire(camp, enemy[2], mixed).reason,
      enemyTrain: S.canTrain(bar, enemy[2], mixed, list).reason
    };
  })()`);
  check('в списке найма только свои: чужие не попадают ни в одну группу',
    own.own.join(',') === '1,2,3,4,5' && own.hire.join(',') === '1,2,3,4,5',
    own.hire.join(','));
  check('в списке казармы только свои: чужие не попадают ни в «воины», ни в «заняты»',
    own.train.join(',') === '1,2,3,4,5', own.train.join(','));
  check('warriorsOf(list, owner) считает только своих; без owner — всех',
    own.allWarriors.join(',') === '1,2,3,4,5,902' &&
    own.ownWarriors.join(',') === '1,2,3,4,5',
    own.allWarriors.join(',') + ' / ' + own.ownWarriors.join(','));
  check('пакетные числа панели не считают чужих свободными',
    own.hireInfo.hire.free === own.ownHireInfo.hire.free &&
    own.trainInfo.train.free === own.ownTrainInfo.train.free,
    'наём ' + own.hireInfo.hire.free + ' / ' + own.ownHireInfo.hire.free +
    ', тренировка ' + own.trainInfo.train.free + ' / ' + own.ownTrainInfo.train.free);
  check('действие с чужим жителем движок отвергает словами',
    own.enemyHire === 'чужая постройка' && own.enemyTrain === 'чужая казарма',
    own.enemyHire + ' / ' + own.enemyTrain);

  /* Кадр лагеря: воины стоят на территории вокруг модели, а не на ней. Это
     проверка глазами к машинным проверкам выше. */
  if (bar.ok) {
    await js(`(() => {
      const g = window.__mapgen, B = window.Buildings;
      const camp = g.getBuildings().find(b => B.typeOf(b) === 'warcamp');
      const c = B.center(camp);
      g.renderer.cam.zoom = 76;
      g.renderer.centerOn(c.x, c.y);
      g.renderer.render(1);
      return 1;
    })()`);
    const campShot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(OUT, 'barracks-warcamp.png'), Buffer.from(campShot.data, 'base64'));
    console.log('  кадр barracks-warcamp.png');
  }
  finish();

  function finish() {
    if (errors.length) { console.log('\nошибки:'); errors.forEach(e => console.log('  ' + e)); }
    else console.log('\nошибок в консоли нет');
    console.log('\n' + (fails ? 'ПРОВАЛЕНО проверок: ' + fails : 'все проверки начала игры пройдены'));
    ws.close(); killChrome();
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    process.exit(fails ? 1 : 0);
  }
})().catch(e => { console.error('ошибка: ' + e.message); killChrome(); process.exit(1); });
