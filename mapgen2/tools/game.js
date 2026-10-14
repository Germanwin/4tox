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
 *   6) панель генератора спрятана и открывается кнопкой.
 *
 * Запуск: node tools/game.js [url]
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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
    Math.abs(world.land - 0.72) < 0.02, (world.land * 100).toFixed(1) + ' %');
  check('вокруг острова есть полоса моря', world.sea >= 4, world.sea + ' клеток');
  check('на карте есть объекты (лес и камни)', world.objects > 200, world.objects + ' шт.');

  /* --- 2. ратуша ---------------------------------------------------- */
  const home = await js(`(() => {
    const g = window.__mapgen, w = g.getWorld(), B = window.Buildings;
    const list = g.getBuildings();
    if (list.length !== 1) return { n: list.length };
    const b = list[0], fp = B.footprint(b.rot);
    const grass = [];
    for (let j = 0; j < fp.h; j++) for (let i = 0; i < fp.w; i++) {
      const x = b.x + i, y = b.y + j;
      const inside = x >= 0 && y >= 0 && x < w.width && y < w.height;
      grass.push(inside && w.tile[y * w.width + x] === window.WorldGen.T.GRASS);
    }
    return {
      n: list.length, variant: b.variant, rot: b.rot, x: b.x, y: b.y,
      fp: [fp.w, fp.h],
      grass: grass.filter(Boolean).length, cells: grass.length,
      fpOccupants: B.occupants(w, b).length,
      yardOccupants: B.yardOccupants(w, b, 1).length,
      center: { x: b.x + fp.w / 2, y: b.y + fp.h / 2 }
    };
  })()`);
  check('на карте ровно одна ратуша', home.n === 1, home.n + ' шт.');
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

  finish();

  function finish() {
    if (errors.length) { console.log('\nошибки:'); errors.forEach(e => console.log('  ' + e)); }
    else console.log('\nошибок в консоли нет');
    console.log('\n' + (fails ? 'ПРОВАЛЕНО проверок: ' + fails : 'все проверки начала игры пройдены'));
    ws.close(); chrome.kill('SIGKILL');
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    process.exit(fails ? 1 : 0);
  }
})().catch(e => { console.error('ошибка: ' + e.message); chrome.kill('SIGKILL'); process.exit(1); });
