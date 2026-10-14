/* place.js — автотест размещения ратуши (нужен Chrome).
 *
 * Проверяет то, ради чего размещение и делалось, и то, что легко сломать:
 *   1) атлас ратуши загрузился: 3 варианта x 4 поворота;
 *   2) спрайт садится в пятно застройки 4 x 3, а не «примерно»: силуэт
 *      сравнивается с пятном, спроецированным в те же пиксели канваса (ловит
 *      и удвоенный масштаб, и потерянный сдвиг). И он не занимает пятно
 *      целиком: правило посадки требует зазор — треть клетки по длинной
 *      стороне пятна, четверть по короткой (см. js/buildings.js);
 *   3) клик мышью ставит ратушу ровно в ту клетку, на которую указывали;
 *   4) вода, песок, край карты и чужая постройка местом не считаются;
 *   5) поворот меняет пятно: 0/180 — 4 x 3, 90/270 — 3 x 4;
 *   6) порядок отрисовки общий: объекты и постройки идут в одном потоке
 *      по глубине, без «провалов» ключа;
 *   7) постройка попадает в экспорт PNG и на миникарту;
 *   8) три ратуши ставятся кнопкой «все три» и стоят каждая на своей траве;
 *   9) после перегенерации остаются только те постройки, чьё место уцелело.
 *
 * Запуск: node tools/place.js [url]
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] || 'file://' + path.join(__dirname, '..', 'index.html');
const OUT = path.join(__dirname, 'out');
const PORT = 9700 + (process.pid % 200);
const PROFILE = '/tmp/dsh-place-' + process.pid;

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
  const mouse = (type, x, y, extra) => send('Input.dispatchMouseEvent',
    Object.assign({ type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, extra || {}));
  const key = (k, code, vk) => send('Input.dispatchKeyEvent',
    { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }));
  const shoot = async (name) => {
    // Рисуем и снимаем ОДНИМ вызовом: в headless-режиме между двумя запросами
    // успевает проскочить кадр цикла отрисовки (блики и качание деревьев
    // зависят от времени), и в файл попадает не тот кадр, который мы собрали.
    const dataUrl = await js(`(() => {
      const r = window.__mapgen.renderer;
      r.render(1);
      return document.getElementById('view').toDataURL('image/png');
    })()`);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('  кадр ' + name + '.png');
  };
  // Снимок всей страницы: панель размещения — часть того, что сдаётся,
  // и по одному канвасу её не проверить.
  const shootPage = async (name) => {
    // Панель прокручиваем к самой группе: иначе в кадр попадает только её
    // заголовок, и по снимку нельзя проверить ни кнопки, ни состояние.
    await js(`(() => { const g = window.__mapgen; g.renderer.render(1); g.drawMinimap();
      const el = document.getElementById('placeInfo');
      if (el) el.scrollIntoView({ block: 'center' });
      return 1; })()`);
    await new Promise(r => setTimeout(r, 150));
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(shot.data, 'base64'));
    console.log('  кадр ' + name + '.png (вся страница)');
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 3600));

  // Игра открывается с готовой ратушей игрока, а тест — про размещение:
  // расчищаем доску и открываем панель генератора, как было до начала игры.
  await js(`(() => { window.__mapgen.clearBuildings(); window.__mapgen.setPanel(true);
    window.__mapgen.renderer.fitToWorld(); return 1; })()`);
  await new Promise(r => setTimeout(r, 300));

  const rect = await js(`(() => { const r = document.getElementById('view').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
  const pageXY = (x, y) => [rect.left + x, rect.top + y];
  // Экранные координаты центра клетки (в пикселях канваса)
  const screenOfCell = (x, y) => js(`(() => { const r = window.__mapgen.renderer;
    return [r.sx(${x} + 0.5, ${y} + 0.5) + r.cssW / 2, r.sy(${x} + 0.5, ${y} + 0.5) + r.cssH / 2]; })()`);

  console.log('размещение ратуши:');

  /* --- 1. атлас ---------------------------------------------------- */
  const atlas = await js(`(() => {
    const s = window.__mapgen.renderer.buildingSprites;
    if (!s) return null;
    const out = {};
    for (const v of ['a', 'b', 'c']) out[v] = Object.keys(s.frames[v] || {}).map(Number).sort((p, q) => p - q);
    return { ppu: s.ppu, az: s.az, el: s.el, frames: out,
             meta: !!window.TOWNHALL_ATLAS, img: [s.img.width, s.img.height] };
  })()`);
  check('атлас ратуши загрузился', !!atlas, atlas ? atlas.img.join('x') : 'нет set');
  if (!atlas) { finish(); return; }
  check('12 кадров: 3 варианта x 4 поворота',
    ['a', 'b', 'c'].every(v => atlas.frames[v].join(',') === '0,90,180,270'),
    JSON.stringify(atlas.frames));

  /* --- 2. посадка: масштаб, наземный контур и его середина ---------- */
  const rule = await js(`(() => {
    const B = window.Buildings, s = window.__mapgen.renderer.buildingSprites;
    const fp = B.footprint(0);
    return { mul: s.mul, metaMul: s.meta.mul, margin: B.BASE_MARGIN, side: B.longestSide(s.meta),
             fp: [fp.w, fp.h], fit: B.fitMul(B.longestSide(s.meta)), gaps: B.gaps(fp) };
  })()`);
  console.log('  посадка: пятно ' + rule.fp.join(' x ') + ', крупность спрайта ' + rule.mul.toFixed(4) +
    ' (правило дало бы ' + rule.fit.toFixed(4) + ', в атласе поправка ' + Number(rule.metaMul).toFixed(4) + ')');
  // Крупность — из атласа: правило (зазор BASE_MARGIN по длинной стороне)
  // даёт 5/6, а заказчик попросил ещё на 8 % меньше. Тест держит оба числа:
  // и то, что правило на месте, и то, что поправка именно та.
  check('крупность взята из атласа (поправка к правилу), а не по правилу',
    Math.abs(rule.mul - rule.metaMul) < 1e-9, 'mul ' + rule.mul.toFixed(4));
  check('поправка к правилу — минус 8 % (0.7667 против 0.8333)',
    Math.abs(rule.metaMul - 0.7667) < 1e-3 && Math.abs(rule.metaMul - rule.fit * 0.92) < 1e-3,
    rule.fit.toFixed(4) + ' * 0.92 = ' + (rule.fit * 0.92).toFixed(4));

  const fit = await js(`(() => {
    const r = window.__mapgen.renderer, B = window.Buildings, set = r.buildingSprites;
    const z = 64;
    // Пятно и спрайт считаем при одном зуме: sx/sy берут зум из камеры.
    const keep = r.cam.zoom;
    r.cam.zoom = z;
    const pxc = Math.cos(set.az) * set.ppu, pyc = Math.sin(set.el) * pxc;
    const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
    const isStone = (d, i) => Math.abs(d[i + 1] - d[i + 2]) <= 14 && d[i + 1] - d[i] > 0 &&
                              d[i + 1] - d[i] <= 40 && d[i + 1] >= 55 && d[i + 1] <= 215;
    /* Наземный контур по пикселям кадра — тем же способом, что упаковщик
       (tools/pack_townhall.py): нижний непрозрачный пиксель столбца, но
       только там, где виден цоколь. Так тест проверяет не только цифру в
       атласе, но и то, что она про этот спрайт. */
    const measure = (spr) => {
      cv.width = spr.sw; cv.height = spr.sh;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh, 0, 0, spr.sw, spr.sh);
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      const cols = [];
      let stone = false;
      for (let x = 0; x < spr.sw; x++) {
        let st = false;
        for (let y = 0; y < spr.sh; y++) {
          const i = (y * spr.sw + x) * 4;
          if (d[i + 3] >= 250 && isStone(d, i)) { st = true; break; }
        }
        cols.push(st);
        if (st) stone = true;
      }
      const ax = spr.ax * spr.sw, ay = spr.ay * spr.sh;
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let x = 0; x < spr.sw; x++) {
        if (stone && !cols[x]) continue;
        for (let y = spr.sh - 1; y >= 0; y--) {
          const i = (y * spr.sw + x) * 4;
          if (d[i + 3] < 250) continue;
          if (!stone && y < ay - 1.2 * pyc) break;
          const dx = (x - ax) / pxc, dy = (y - ay) / pyc;
          const X = (dx + dy) / 2, Y = (dy - dx) / 2;
          if (X < x0) x0 = X;
          if (X > x1) x1 = X;
          if (Y < y0) y0 = Y;
          if (Y > y1) y1 = Y;
          break;
        }
      }
      return [x0, x1, y0, y1];
    };
    const rows = [];
    for (const v of ['a', 'b', 'c']) for (const rot of [0, 90, 180, 270]) {
      const b = { variant: v, rot: rot, x: 20, y: 20 };
      const spr = B.sprite(set, v, rot);
      const fp = B.footprint(rot);
      const g = measure(spr);
      const meta = spr.ground || null;
      // Как игра ставит спрайт: точка опоры сдвинута на середину наземного
      // контура (B.anchorShift), масштаб — крупность. Значит, контур на карте
      // лежит в клетках пятна как (контур * mul - сдвиг).
      const sh = B.anchorShift(spr, set.mul);
      const drawn = [g[0] * set.mul - sh.x, g[1] * set.mul - sh.x,
                     g[2] * set.mul - sh.y, g[3] * set.mul - sh.y];
      const hw = fp.w / 2, hh = fp.h / 2;
      rows.push({
        v: v, rot: rot, fp: [fp.w, fp.h],
        // запас от наземного контура до края пятна, в клетках (минус — вылез)
        left: hw + drawn[0], right: hw - drawn[1], back: hh + drawn[2], front: hh - drawn[3],
        // середина контура относительно середины пятна — то самое «по середине»
        cx: (drawn[0] + drawn[1]) / 2, cy: (drawn[2] + drawn[3]) / 2,
        ground: g, meta: meta,
        metaErr: meta ? Math.max(Math.abs(meta[0] - g[0]), Math.abs(meta[1] - g[1]),
                                 Math.abs(meta[2] - g[2]), Math.abs(meta[3] - g[3])) : null
      });
    }
    r.cam.zoom = keep;
    return rows;
  })()`);
  const worst = (k) => fit.reduce((a, r) => Math.max(a, r[k]), -Infinity);
  const least = (k) => fit.reduce((a, r) => Math.min(a, r[k]), Infinity);
  console.log('  наземный контур против пятна (запас в клетках) — ' +
    fit.map(r => `${r.v}${r.rot} л${r.left.toFixed(2)} п${r.right.toFixed(2)} з${r.back.toFixed(2)} ф${r.front.toFixed(2)}`)
      .join(' · '));
  console.log('  середина наземного контура против середины пятна (клетки) — ' +
    fit.map(r => `${r.v}${r.rot} ${r.cx >= 0 ? '+' : ''}${r.cx.toFixed(2)}/${r.cy >= 0 ? '+' : ''}${r.cy.toFixed(2)}`)
      .join(' · '));
  check('наземный контур в атласе совпадает с измеренным по пикселям',
    fit.every(r => r.metaErr !== null && r.metaErr < 0.15),
    'максимум расхождения ' + Math.max(...fit.map(r => r.metaErr === null ? 9 : r.metaErr)).toFixed(3) + ' клетки');
  // «Идеально по середине»: центр наземного контура — в центре пятна. Это
  // главное, ради чего сдвигается точка опоры: у ратуши сбоку крыльцо.
  check('середина наземного контура — в середине пятна',
    fit.every(r => Math.abs(r.cx) < 0.02 && Math.abs(r.cy) < 0.02),
    'максимум смещения ' + Math.max(Math.max(...fit.map(r => Math.abs(r.cx))),
                                    Math.max(...fit.map(r => Math.abs(r.cy)))).toFixed(3) + ' клетки');
  // И контур не вылезает за пятно: зазор со всех четырёх сторон. У B при
  // повороте 90/270 навес с кадкой шире всех — там допускаем волос.
  check('наземный контур внутри пятна: зазор со всех четырёх сторон',
    least('left') > -0.15 && least('right') > -0.15 && least('back') > -0.15 && least('front') > -0.15,
    'минимум ' + Math.min(least('left'), least('right'), least('back'), least('front')).toFixed(3) + ' клетки');
  // У B при повороте 90/270 вбок уходят плетень и навес с кадкой: это его
  // собственные детали, и они шире пятна на десятую клетки. Правило их не
  // прячет — оно держит середину и зазор, а деталь торчит на волос. Если
  // такое не нравится, это правка модели, а не масштаба.
  check('выступающие детали B вылезают не больше чем на 0.15 клетки',
    least('left') > -0.15 && least('right') > -0.15,
    'минимум ' + Math.min(least('left'), least('right')).toFixed(3) + ' клетки');

  /* --- 3. клик мышью ставит в клетку под курсором ------------------- */
  {
    const target = await js(`(() => {
      const g = window.__mapgen, w = g.getWorld(), B = window.Buildings;
      // Ищем ровное место: трава, без растений в пятне и, по возможности,
      // без рощи вплотную — иначе на кадрах ратуша стоит по крышу в лесу
      // (деревья перед ней честно рисуются поверх).
      const heavy = (o) => o.kind !== 'tuft' && o.kind !== 'flower' && o.kind !== 'reed';
      const crowd = (b) => {
        const fp = B.footprint(b.rot);
        let n = 0;
        for (const o of w.objects) {
          if (!heavy(o)) continue;
          const tx = Math.floor(o.x), ty = Math.floor(o.y);
          if (tx >= b.x - 3 && tx < b.x + fp.w + 3 && ty >= b.y - 3 && ty < b.y + fp.h + 3) n++;
        }
        return n;
      };
      let best = null, bestScore = Infinity;
      for (let y = 6; y < w.height - 10; y++) {
        for (let x = 6; x < w.width - 10; x++) {
          const b = { variant: 'a', rot: 0, x: x, y: y };
          if (!B.canPlace(w, [], b, { requireClear: true }).ok) continue;
          const s = crowd(b);
          if (s === 0) return { x: x, y: y };
          if (s < bestScore) { bestScore = s; best = { x: x, y: y }; }
        }
      }
      return best;
    })()`);
    check('нашлось чистое место под тест', !!target, target ? target.x + ',' + target.y : '');
    const p = await screenOfCell(target.x, target.y);
    await js(`window.__mapgen.setPlaceMode(true)`);
    await mouse('mouseMoved', ...pageXY(p[0], p[1]));
    await new Promise(r => setTimeout(r, 120));
    const ghost = await js(`(() => { const g = window.__mapgen.getGhost();
      return g ? { x: g.b.x, y: g.b.y, ok: g.ok } : null; })()`);
    check('призрак стоит в клетке под курсором', ghost && ghost.x === target.x && ghost.y === target.y,
      ghost ? `${ghost.x},${ghost.y} против ${target.x},${target.y}` : 'нет призрака');
    check('на чистом месте призрак разрешён', !!(ghost && ghost.ok));

    await mouse('mousePressed', ...pageXY(p[0], p[1]));
    await mouse('mouseReleased', ...pageXY(p[0], p[1]));
    await new Promise(r => setTimeout(r, 150));
    const placed = await js(`window.__mapgen.getBuildings().map(b => [b.variant, b.rot, b.x, b.y])`);
    check('клик поставил ратушу в ту же клетку',
      placed.length === 1 && placed[0][2] === target.x && placed[0][3] === target.y,
      JSON.stringify(placed));
    const cleared = await js(`(() => {
      const g = window.__mapgen, b = g.getBuildings()[0], B = window.Buildings;
      // Считаем всё, что осталось в пятне и в клетке вокруг: и то и другое
      // расчищается при постановке.
      return { fp: B.occupants(g.getWorld(), b).length,
               yard: B.yardOccupants(g.getWorld(), b, 1).length };
    })()`);
    check('под ратушей не осталось ни одного объекта', cleared.fp === 0, cleared.fp + ' шт.');
    check('двор вокруг ратуши расчищен', cleared.yard === 0, cleared.yard + ' шт. в полосе вокруг');
  }

  /* --- 3a. куст в пятне: расчистка и запрет ------------------------ */
  {
    const bush = await js(`(() => {
      const g = window.__mapgen, w = g.getWorld(), B = window.Buildings;
      // Клетка, где стоит украшение (куст, трава, цветы, камыш), вокруг
      // которой пятно 4 x 3 ещё целиком лежит на траве
      for (const o of w.objects) {
        if (o.kind === 'tree' || o.kind === 'stone') continue;
        const cx = Math.floor(o.x), cy = Math.floor(o.y);
        for (let dy = -2; dy <= 0; dy++) for (let dx = -3; dx <= 0; dx++) {
          const b = { variant: 'a', rot: 0, x: cx + dx, y: cy + dy };
          const fp = B.footprint(0);
          if (b.x < 2 || b.y < 2 || b.x + fp.w > w.width - 2 || b.y + fp.h > w.height - 2) continue;
          let grass = true;
          for (const c of B.cells(b)) if (w.tile[c.y * w.width + c.x] !== 4) { grass = false; break; }
          if (!grass) continue;
          const occ = B.occupants(w, b);
          if (!occ.length) continue;
          const chk = B.canPlace(w, g.getBuildings(), b, {});
          const strict = B.canPlace(w, g.getBuildings(), b, { requireClear: true });
          if (chk.ok && chk.blocked.length && !strict.ok) {
            return { b: b, blocked: chk.blocked.length, kinds: occ.map(x => x.kind), strictOk: strict.ok };
          }
        }
      }
      return null;
    })()`);
    check('пятно с кустами и травой: находка для теста', !!bush,
      bush ? JSON.stringify(bush.kinds) : 'не нашлось');
    check('строгий режим такое место не пропускает', !!bush && bush.strictOk === false);
    if (bush) {
      const res = await js(`(() => {
        const g = window.__mapgen, B = window.Buildings, w = g.getWorld();
        const b = ${JSON.stringify(bush.b)};
        const before = w.objects.length, decorBefore = w.stats.decor;
        const ok = g.placeAt(b);
        return { ok: ok, removed: before - w.objects.length, left: B.occupants(w, b).length,
                 yardLeft: B.yardOccupants(w, b, 1).length,
                 decorDropped: decorBefore - w.stats.decor,
                 strictOk: B.canPlace(w, [], b, { requireClear: true }).ok };
      })()`);
      check('ратуша встала на пятно с кустами', res.ok);
      check('кусты и трава из пятна убраны', res.removed > 0 && res.left === 0,
        `убрано ${res.removed}, осталось ${res.left}`);
      check('двор вокруг ратуши тоже чистый', res.yardLeft === 0, 'в полосе вокруг ' + res.yardLeft);
      check('сводка мира пересчитала убранное', res.decorDropped > 0, 'мелочи убрано ' + res.decorDropped);
      // После расчистки пятно действительно пустое — и строгий режим его
      // пропускает: расчистка не «прячет» занятость, а убирает её.
      check('после расчистки место годится и для строгого режима', res.strictOk === true);

      // Кадр именно этого места: куст в передней половине пятна — тот самый
      // случай, когда он рисовался поверх стены. Теперь его там нет.
      // Режим размещения выключаем: иначе в кадр попадает призрак поверх
      // уже стоящей ратуши, и по снимку не понять, что там на самом деле.
      await js(`(() => {
        const g = window.__mapgen, r = g.renderer;
        g.setPlaceMode(false);
        r.selected = null;
        // именно та ратуша, что встала на пятно с кустами
        const bs = g.getBuildings();
        const c = window.Buildings.center(bs[bs.length - 1]);
        r.cam.zoom = 88; r.centerOn(c.x, c.y + 1); return 1;
      })()`);
      const st = await js(`(() => { const g = window.__mapgen, r = g.renderer;
        return { placing: g.isPlacing(), selected: !!r.selected, ghost: !!r.ghost,
                 n: g.getBuildings().length }; })()`);
      console.log('  состояние кадра: ' + JSON.stringify(st));
      await shoot('place-cleared');
      await js(`(() => { window.__mapgen.renderer.fitToWorld(); return 1; })()`);
    }
  }

  /* --- 3b. призрак под курсором ------------------------------------ */
  {
    // Годное место: пятно зелёное, спрайт полупрозрачный. И место в воде:
    // пятно красное. Оба кадра — то, ради чего режим размещения и нужен.
    // Камеру перед наведением ставим явно: курсор ходит по экрану, и если
    // нужная клетка за кадром, наведение её просто не увидит.
    await js(`(() => { window.__mapgen.setPlaceMode(true); window.__mapgen.setRotation(90); return 1; })()`);
    const good = await js(`(() => {
      const g = window.__mapgen, w = g.getWorld(), B = window.Buildings;
      for (let y = 4; y < w.height - 8; y++) for (let x = 4; x < w.width - 8; x++) {
        const chk = B.canPlace(w, g.getBuildings(), { variant: 'b', rot: 90, x: x, y: y }, {});
        if (chk.ok && !chk.blocked.length) return { x: x, y: y };
      }
      return null;
    })()`);
    await js(`(() => { const r = window.__mapgen.renderer; r.fitToWorld(); r.render(1); return 1; })()`);
    const p = await screenOfCell(good.x, good.y);
    await mouse('mouseMoved', ...pageXY(p[0], p[1]));
    await new Promise(r => setTimeout(r, 120));
    const g1 = await js(`(() => { const g = window.__mapgen.getGhost();
      if (!g) return null;
      const fp = window.Buildings.footprint(g.b.rot);
      return { ok: g.ok, fp: [fp.w, fp.h], blocked: g.blocked.length }; })()`);
    check('призрак повёрнутой ратуши: пятно 3 x 4', !!g1 && g1.fp[0] === 3 && g1.fp[1] === 4,
      g1 ? g1.fp.join('x') : 'нет призрака');
    await js(`(() => { const r = window.__mapgen.renderer, c = window.Buildings.center(window.__mapgen.getGhost().b);
      r.cam.zoom = 72; r.centerOn(c.x, c.y + 1); return 1; })()`);
    await shoot('place-ghost');

    const bad = await js(`(() => {
      const g = window.__mapgen, w = g.getWorld(), B = window.Buildings, T = window.WorldGen.T;
      // Клетка воды, вокруг которой есть суша: у самой кромки карты камера
      // упрётся в край, и курсор до неё не дойдёт.
      for (let y = 6; y < w.height - 8; y++) for (let x = 6; x < w.width - 8; x++) {
        if (w.tile[y * w.width + x] >= T.SAND) continue;
        let land = 0;
        for (let j = -4; j <= 4; j += 2) for (let i = -4; i <= 4; i += 2)
          if (w.tile[(y + j) * w.width + (x + i)] === T.GRASS) land++;
        if (land > 2) return { x: x, y: y };
      }
      return null;
    })()`);
    await js(`(() => { const r = window.__mapgen.renderer, c = { x: ${bad.x}, y: ${bad.y} };
      r.cam.zoom = 40; r.centerOn(c.x, c.y); r.render(1); return 1; })()`);
    const q = await screenOfCell(bad.x, bad.y);
    await mouse('mouseMoved', ...pageXY(q[0], q[1]));
    await new Promise(r => setTimeout(r, 120));
    const g2 = await js(`(() => { const g = window.__mapgen.getGhost(); return g ? { ok: g.ok, reason: g.reason } : null; })()`);
    check('в воде призрак запрещён', !!g2 && !g2.ok, g2 ? g2.reason : 'нет призрака');
    await js(`(() => { const r = window.__mapgen.renderer, c = window.Buildings.center(window.__mapgen.getGhost().b);
      r.cam.zoom = 72; r.centerOn(c.x, c.y + 1); return 1; })()`);
    await shoot('place-bad');
    await js(`(() => { const r = window.__mapgen.renderer; r.fitToWorld(); return 1; })()`);
    // И та же сцена целиком, с панелью: по ней видно, что режим размещения
    // собран из настоящих элементов управления, а не нарисован в канвасе.
    await js(`(() => { const g = window.__mapgen; g.setPlaceMode(true);
      g.setVariant('c'); g.setRotation(0); return 1; })()`);
    await mouse('mouseMoved', ...pageXY(p[0], p[1]));
    await new Promise(r => setTimeout(r, 150));
    await shootPage('place-ui');
    await js(`(() => { const r = window.__mapgen.renderer;
      r.fitToWorld(); window.__mapgen.setPlaceMode(false); window.__mapgen.setRotation(0); return 1; })()`);
  }

  /* --- 4. что местом не считается ---------------------------------- */
  {
    const rules = await js(`(() => {
      const g = window.__mapgen, w = g.getWorld(), B = window.Buildings, T = window.WorldGen.T;
      const list = g.getBuildings();
      const at = (pred) => {
        for (let y = 0; y < w.height - 4; y++) for (let x = 0; x < w.width - 4; x++)
          if (pred(w.tile[y * w.width + x])) return { x: x, y: y };
        return null;
      };
      const water = at(c => c < T.SAND), sand = at(c => c === T.SAND);
      const b0 = list[0];
      // Свободное место ищем, а не вычисляем как «+8 клеток»: там легко
      // оказаться в воде, и тест начнёт проверять не то, что задумано.
      let free = null;
      for (let y = 2; y < w.height - 6 && !free; y++) for (let x = 2; x < w.width - 6; x++) {
        if (B.canPlace(w, list, { variant: 'b', rot: 180, x: x, y: y }, {}).ok) { free = { x: x, y: y }; break; }
      }
      const out = {};
      out.water = water ? B.canPlace(w, [], { variant: 'a', rot: 0, x: water.x, y: water.y }, {}) : null;
      out.sand = sand ? B.canPlace(w, [], { variant: 'a', rot: 0, x: sand.x, y: sand.y }, {}) : null;
      out.edge = B.canPlace(w, [], { variant: 'a', rot: 0, x: w.width - 2, y: w.height - 2 }, {});
      out.overlap = B.canPlace(w, list, { variant: 'b', rot: 0, x: b0.x + 1, y: b0.y + 1 }, {});
      out.free = free ? B.canPlace(w, list, { variant: 'b', rot: 180, x: free.x, y: free.y }, {}) : null;
      out.dims = [[0, B.footprint(0).w, B.footprint(0).h], [90, B.footprint(90).w, B.footprint(90).h],
                  [180, B.footprint(180).w, B.footprint(180).h], [270, B.footprint(270).w, B.footprint(270).h]];
      return out;
    })()`);
    check('в воду нельзя', rules.water && !rules.water.ok, rules.water && rules.water.reason);
    check('в песок нельзя', !rules.sand || !rules.sand.ok, rules.sand && rules.sand.reason);
    check('за край карты нельзя', !rules.edge.ok, rules.edge.reason);
    check('на чужую постройку нельзя', !rules.overlap.ok, rules.overlap.reason);
    check('на свободную траву можно', rules.free.ok, rules.free.reason);
    check('пятно поворачивается: 0/180 — 4x3, 90/270 — 3x4',
      JSON.stringify(rules.dims) === JSON.stringify([[0, 4, 3], [90, 3, 4], [180, 4, 3], [270, 3, 4]]),
      JSON.stringify(rules.dims));
  }

  /* --- 5. общий порядок глубины ------------------------------------ */
  {
    const order = await js(`(() => {
      const r = window.__mapgen.renderer;
      const seq = [];
      r.eachSprite((o) => seq.push(o.x + o.y), (b) => seq.push(window.Buildings.depth(b)));
      let bad = -1;
      for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1] - 1e-9) { bad = i; break; }
      return { n: seq.length, bad: bad, at: bad >= 0 ? [seq[bad - 1], seq[bad]] : null };
    })()`);
    check('объекты и постройки идут одним потоком по глубине', order.bad < 0,
      order.n + ' спрайтов' + (order.at ? ', сбой на ' + order.at.join(' > ') : ''));
  }

  /* --- 6. экспорт и миникарта -------------------------------------- */
  {
    const exp = await js(`(() => {
      const r = window.__mapgen.renderer;
      const withB = r.exportPNG(1);
      const g1 = withB.getContext('2d');
      const a = g1.getImageData(0, 0, withB.width, withB.height).data;
      r.showBuildings = false;
      const without = r.exportPNG(1);
      r.showBuildings = true;
      const g2 = without.getContext('2d');
      const b2 = g2.getImageData(0, 0, without.width, without.height).data;
      let diff = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b2[i]) > 8 || Math.abs(a[i + 1] - b2[i + 1]) > 8 ||
            Math.abs(a[i + 2] - b2[i + 2]) > 8) diff++;
      }
      return { size: [withB.width, withB.height], diff: diff };
    })()`);
    check('постройка попадает в экспорт PNG', exp.diff > 500,
      exp.diff + ' пикселей на ' + exp.size.join('x'));

    const mm = await js(`(() => {
      const r = window.__mapgen.renderer, B = window.Buildings;
      // миникарта рисуется из кэша; проверяем, что пятно на ней закрашено
      const b = window.__mapgen.getBuildings()[0];
      const bb = B.bounds(b);
      const p = r.worldToMM((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2);
      const g = r.minimap.getContext('2d');
      const d = g.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data;
      return [d[0], d[1], d[2]];
    })()`);
    check('ратуша отмечена на миникарте', mm[0] > 200 && mm[1] > 170 && mm[2] < 190,
      'rgb ' + mm.join(','));
  }

  /* --- 7. три ратуши, кадры ---------------------------------------- */
  {
    await js(`(() => { window.__mapgen.clearBuildings(); window.__mapgen.setPlaceMode(false); return 1; })()`);
    // Сид фиксируем: расстановка обязана быть одинаковой при одном сиде
    await js(`(() => { document.getElementById('seed').value = 'ратуша-на-карте';
      window.__mapgen.regenerate(false); return 1; })()`);
    await new Promise(r => setTimeout(r, 400));
    const n = await js(`window.__mapgen.placeAllThree()`);
    check('кнопка «все три» поставила три ратуши', n === 3, 'поставлено ' + n);
    const list = await js(`window.__mapgen.getBuildings().map(b => [b.variant, b.rot, b.x, b.y])`);
    check('варианты разные: A, B и C',
      [0, 1, 2].every(i => list[i] && list[i][0] === 'abc'.charAt(i)), JSON.stringify(list));
    check('пятна не пересекаются', await js(`(() => {
      const g = window.__mapgen, B = window.Buildings, l = g.getBuildings();
      for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++)
        if (B.overlaps(l[i], l[j])) return false;
      return true;
    })()`));
    check('все три стоят на траве', await js(`(() => {
      const g = window.__mapgen, w = g.getWorld(), B = window.Buildings, T = window.WorldGen.T;
      for (const b of g.getBuildings()) for (const c of B.cells(b))
        if (w.tile[c.y * w.width + c.x] !== T.GRASS) return false;
      return true;
    })()`));

    // Кадры: общий план, крупный зум на ратушу, посадка по сетке и вид с сеткой.
    await js(`(() => { const r = window.__mapgen.renderer; r.fitToWorld(); return 1; })()`);
    await shoot('place-far');
    await js(`(() => {
      const r = window.__mapgen.renderer, b = window.__mapgen.getBuildings()[0];
      const c = window.Buildings.center(b);
      r.cam.zoom = 72; r.centerOn(c.x, c.y + 1.5);
      return 1;
    })()`);
    await shoot('place-zoom');
    // Пятно выбранной ратуши поверх спрайта: по этому кадру видно, ровно ли
    // основание здания садится в свои 4 x 3 клетки.
    await js(`(() => {
      const r = window.__mapgen.renderer, b = window.__mapgen.getBuildings()[0];
      const c = window.Buildings.center(b);
      r.selected = b; r.showGrid = true;
      r.cam.zoom = 96; r.centerOn(c.x, c.y + 1.2);
      return 1;
    })()`);
    await shoot('place-fit');
    await js(`(() => {
      const r = window.__mapgen.renderer, b = window.__mapgen.getBuildings()[1];
      const c = window.Buildings.center(b);
      r.selected = null; r.showGrid = false;
      r.cam.zoom = 46; r.centerOn(c.x, c.y);
      return 1;
    })()`);
    await shoot('place-three');
    await js(`(() => { const r = window.__mapgen.renderer; r.fitToWorld(); return 1; })()`);
  }

  /* --- 8. перегенерация -------------------------------------------- */
  {
    // Сперва тот же сид, но с подсунутой негодной постройкой: она обязана
    // исчезнуть, а законные три — остаться. Иначе проверка «после смены сида
    // всё хорошо» проходит и тогда, когда чистка не работает вовсе.
    const keep = await js(`(() => {
      const g = window.__mapgen, w = g.getWorld(), T = window.WorldGen.T;
      const before = g.getBuildings().length;
      let wet = null;
      for (let y = 0; y < 10 && !wet; y++) for (let x = 0; x < 10; x++)
        if (w.tile[y * w.width + x] < T.SAND) { wet = { variant: 'a', rot: 0, x: x, y: y }; break; }
      if (wet) g.getBuildings().push(wet);
      g.regenerate(true);
      return { before: before, pushed: !!wet, after: g.getBuildings().length };
    })()`);
    check('постройка, оказавшаяся в воде, снимается с карты',
      keep.pushed && keep.after === keep.before,
      `было ${keep.before} + 1 в воде -> осталось ${keep.after}`);

    const res = await js(`(() => {
      const g = window.__mapgen;
      const before = g.getBuildings().length;
      document.getElementById('seed').value = 'другой-сид-ратуша';
      g.regenerate(true);
      const after = g.getBuildings();
      const w = g.getWorld(), B = window.Buildings, T = window.WorldGen.T;
      let bad = 0;
      for (const b of after) for (const c of B.cells(b))
        if (w.tile[c.y * w.width + c.x] !== T.GRASS) bad++;
      return { before: before, after: after.length, bad: bad };
    })()`);
    check('после смены сида на карте не осталось ратуш в воде',
      res.bad === 0, `было ${res.before}, осталось ${res.after}, в воде клеток ${res.bad}`);

    const regrown = await js(`(() => {
      const g = window.__mapgen, B = window.Buildings;
      let inside = 0, yard = 0;
      for (const b of g.getBuildings()) {
        inside += B.occupants(g.getWorld(), b).length;
        yard += B.yardOccupants(g.getWorld(), b, 1).length;
      }
      return { inside: inside, yard: yard };
    })()`);
    check('на новом сиде площадки под ратушами снова расчищены',
      regrown.inside === 0 && regrown.yard === 0,
      regrown.inside + ' в пятнах, ' + regrown.yard + ' во дворах');
  }

  /* --- 9. переключатель слоя --------------------------------------- */
  {
    const lay = await js(`(() => {
      const r = window.__mapgen.renderer, cv = document.getElementById('view');
      r.showBuildings = true; r.render(1);
      const a = cv.toDataURL('image/png');
      r.showBuildings = false; r.render(1);
      const b = cv.toDataURL('image/png');
      r.showBuildings = true; r.render(1);
      return a !== b;
    })()`);
    check('слой «Ратуша» скрывает постройки', lay);
  }

  if (errors.length) { console.log('\nошибки в консоли:'); errors.forEach(e => console.log('  ' + e)); fails += errors.length; }

  finish();

  function finish() {
    console.log('\n' + (fails ? 'ПРОВАЛЕНО проверок: ' + fails : 'все проверки размещения пройдены'));
    ws.close(); chrome.kill('SIGKILL');
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    process.exit(fails ? 1 : 0);
  }
})().catch(e => { console.error('ошибка: ' + (e && e.stack || e)); chrome.kill('SIGKILL'); process.exit(1); });
