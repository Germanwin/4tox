/* townhall.js — лист показа: три варианта ратуши и четыре поворота на настоящей
 * карте генератора, в честном масштабе (1 клетка = 1 юнит модели).
 *
 * Это не «наложение спрайтов на картинку», как в townhall/out/final_map.png,
 * а та же отрисовка, что и в генераторе: масштаб считает js/buildings.js,
 * порядок глубины — render.js. Если спрайт перестанет садиться в пятно,
 * на этом листе это будет видно.
 *
 * Запуск: node tools/townhall.js [url]
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] || 'file://' + path.join(__dirname, '..', 'index.html');
const OUT = path.join(__dirname, 'out');
const PORT = 9800 + (process.pid % 150);
const PROFILE = '/tmp/dsh-townhall-' + process.pid;

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

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 3600));

  const shoot = async (name) => {
    await js(`(() => { window.__mapgen.renderer.render(1); return 1; })()`);
    const dataUrl = await js(`document.getElementById('view').toDataURL('image/png')`);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('  ' + name + '.png');
  };

  /* Ставит ряд ратуш по прямой «вправо по экрану»: шаг (1, -1) в клетках
     не меняет экранную высоту, поэтому фигуры встают в линию. Место ищется
     по всей карте: пятно обязано лежать на траве, а вокруг должно быть
     поменьше деревьев — иначе соседняя роща закрывает то, что показываем. */
  const row = async (items, gap) => js(`(() => {
    const g = window.__mapgen, r = g.renderer, w = g.getWorld(), B = window.Buildings, T = window.WorldGen.T;
    document.getElementById('seed').value = 'ратуша-лист';
    g.regenerate(false);
    const W = w.width, H = w.height;
    const stepX = ${gap}, stepY = -${gap};
    const items = ${JSON.stringify(items)};
    const spotsAt = (bx, by) => items.map((it, i) => ({
      variant: it[0], rot: it[1], x: bx + stepX * i, y: by + stepY * i
    }));
    const onGrass = (spots) => spots.every(s => {
      const fp = B.footprint(s.rot);
      if (s.x < 1 || s.y < 1 || s.x + fp.w > W - 1 || s.y + fp.h > H - 1) return false;
      return B.cells(s).every(c => w.tile[c.y * W + c.x] === T.GRASS);
    });
    // Сколько деревьев и камней вокруг ряда: меньше — лучше видно здание.
    // Считаем не только пятно, но и полосу перед ним: именно она закрывает
    // здание, потому что рисуется поверх (порядок по x + y), а дерево в
    // шести клетках перед ратушей ещё достаёт до её края.
    const box = (s, back, front) => {
      const fp = B.footprint(s.rot);
      return { x0: s.x - back, x1: s.x + fp.w + front, y0: s.y - back, y1: s.y + fp.h + front };
    };
    // Что реально закрывает здание — куст и выше. Трава и цветы лежат на
    // земле и дом не перекрывают, поэтому в счёт не идут (иначе «чистого»
    // поля не найти: мелочь рассыпана по всей карте).
    const occludes = (o) => o.kind !== 'tuft' && o.kind !== 'flower' && o.kind !== 'reed';
    const crowd = (spots, front) => {
      let n = 0;
      for (const o of w.objects) {
        if (!occludes(o)) continue;
        const tx = Math.floor(o.x), ty = Math.floor(o.y);
        for (const s of spots) {
          const b = box(s, 2, front);
          if (tx >= b.x0 && tx < b.x1 && ty >= b.y0 && ty < b.y1) { n++; break; }
        }
      }
      return n;
    };
    let best = null, bestScore = Infinity, clean = null, cleanScore = Infinity;
    for (let by = 6; by < H - 6; by += 2) {
      for (let bx = 6; bx < W - 6; bx += 2) {
        const spots = spotsAt(bx, by);
        if (!onGrass(spots)) continue;
        const cx = bx + stepX * (items.length - 1) / 2, cy = by + stepY * (items.length - 1) / 2;
        // Тяготение к середине карты: у края трава есть, но за спиной вода
        const score = crowd(spots, 8) + Math.hypot(cx - W / 2, cy - H / 2) * 0.15;
        if (score < bestScore) { bestScore = score; best = spots; }
        // Отдельно ищем место, где перед рядом вообще ничего не растёт:
        // такое есть почти всегда, и на листе это заметно лучше.
        if (crowd(spots, 10) === 0 && score < cleanScore) { cleanScore = score; clean = spots; }
      }
    }
    if (clean) { best = clean; bestScore = cleanScore; }
    if (!best) return null;
    // На листе показываем модели, а не поведение расчистки: вокруг пятна
    // убираем растительность ещё на клетку-две, иначе соседняя роща закрывает
    // здание целиком (она и должна его закрывать — она ближе к камере).
    for (const s of best) {
      const fp = B.footprint(s.rot);
      const keep = [];
      for (const o of w.objects) {
        const tx = Math.floor(o.x), ty = Math.floor(o.y);
        const hit = tx >= s.x - 2 && tx < s.x + fp.w + 3 &&
          ty >= s.y - 2 && ty < s.y + fp.h + 3;
        if (!hit) keep.push(o);
      }
      w.objects = keep;
    }
    const blds = best.map(s => ({ variant: s.variant, rot: s.rot, x: s.x, y: s.y }));
    r.setBuildings(blds);
    const c0 = B.center(blds[0]), c1 = B.center(blds[blds.length - 1]);
    // Шаг (1,-1) сдвигает фигуру ровно на z пикселей вправо, а само пятно
    // занимает 3.5 клетки: отсюда зум, при котором ряд влезает в кадр.
    const span = (items.length - 1) * ${gap} + 4.5;
    r.cam.zoom = Math.min(72, (r.cssW - 60) / span);
    r.centerOn((c0.x + c1.x) / 2, (c0.y + c1.y) / 2 + 1);
    return { spots: blds, crowd: bestScore, zoom: r.cam.zoom, clean: !!clean };
  })()`);

  console.log('лист ратуши:');
  const belt = await row([['a', 0], ['b', 0], ['c', 0]], 7);
  console.log('  три варианта: ' + (belt ? JSON.stringify(belt.spots.map(b => [b.variant, b.x, b.y])) +
    '  вокруг объектов ' + belt.crowd.toFixed(0) + ', зум ' + belt.zoom.toFixed(0) + (belt.clean ? ', чистое поле' : '') : 'нет места'));
  await shoot('townhall-variants');

  const rot = await row([['a', 0], ['a', 90], ['a', 180], ['a', 270]], 6);
  console.log('  четыре поворота: ' + (rot ? JSON.stringify(rot.spots.map(b => [b.rot, b.x, b.y])) : 'нет места'));
  await shoot('townhall-rotations');

  if (errors.length) { console.log('\nошибки:'); errors.forEach(e => console.log('  ' + e)); process.exitCode = 1; }
  else console.log('\nошибок в консоли нет');

  ws.close(); killChrome();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('ошибка: ' + (e && e.stack || e)); killChrome(); process.exit(1); });
