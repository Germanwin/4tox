/* house.js — стартовый дом жителя (тип `house`, пятно 2 x 3) на настоящей карте.

 * Ставит спрайты из assets/starter_house/atlas.png на карту тем же масштабом,
 * что и js/buildings.js: z / (2*cos(az)*ppu) по X и z / (4*sin(el)*cos(az)*ppu)
 * по Y, опора — центр пятна застройки. Пятно подсвечивается ромбами клеток,
 * чтобы было видно, что дом занимает ровно 2 x 3 (при повороте 3 x 2) и что
 * два дома встают рядом, не наезжая друг на друга.
 *
 * Атлас берётся из игры (assets/starter_house/) — того же файла, что грузит
 * страница: если упаковщик не прогнали, кадр будет старый, и это видно.
 *
 * Игра не меняется: атлас и отрисовка подставляются со стороны через CDP.
 *
 * Запуск: node tools/house.js [url]
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = require('./chrome.js');
const url = process.argv[2] || 'file://' + path.join(__dirname, '..', 'index.html');
const OUT = path.join(__dirname, 'out');
const ASSETS = path.join(__dirname, '..', 'assets', 'starter_house');
const PORT = 9900 + (process.pid % 90);
const PROFILE = '/tmp/dsh-hut-' + process.pid;

fs.mkdirSync(OUT, { recursive: true });
const meta = JSON.parse(fs.readFileSync(path.join(ASSETS, 'atlas.json'), 'utf8'));
const png = fs.readFileSync(path.join(ASSETS, 'atlas.png')).toString('base64');

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
    const dataUrl = await js(`document.getElementById('view').toDataURL('image/png')`);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('  ' + name + '.png');
  };

  /* Инъекция атласа дома: картинка data-url + метаданные + функция отрисовки
     в масштабе js/buildings.js. Пятно рисуем ромбами клеток. */
  await js(`(() => {
    window.__house = { meta: ${JSON.stringify(meta)}, img: new Image() };
    return new Promise(res => {
      window.__house.img.onload = () => res(1);
      window.__house.img.src = 'data:image/png;base64,${png}';
    });
  })()`);

  const row = async (items, gap) => js(`(() => {
    const g = window.__mapgen, r = g.renderer, w = g.getWorld(), T = window.WorldGen.T;
    const H = window.__house, meta = H.meta, img = H.img;
    document.getElementById('seed').value = 'стартовый-дом-2x3';
    g.regenerate(false);
    const W = w.width, HH = w.height;
    const items = ${JSON.stringify(items)};
    const stepX = ${gap}, stepY = -${gap};
    const fpOf = (rot) => (rot % 180 === 0) ? [2, 3] : [3, 2];
    const spotsAt = (bx, by) => items.map((it, i) => ({
      variant: it[0], rot: it[1], x: bx + stepX * i, y: by + stepY * i
    }));
    const onGrass = (spots) => spots.every(s => {
      const fp = fpOf(s.rot);
      if (s.x < 1 || s.y < 1 || s.x + fp[0] > W - 1 || s.y + fp[1] > HH - 1) return false;
      for (let j = 0; j < fp[1]; j++) for (let i = 0; i < fp[0]; i++) {
        if (w.tile[(s.y + j) * W + (s.x + i)] !== T.GRASS) return false;
      }
      return true;
    });
    const occludes = (o) => o.kind !== 'tuft' && o.kind !== 'flower' && o.kind !== 'reed';
    const crowd = (spots, front) => {
      let n = 0;
      for (const o of w.objects) {
        if (!occludes(o)) continue;
        const tx = Math.floor(o.x), ty = Math.floor(o.y);
        for (const s of spots) {
          const fp = fpOf(s.rot);
          if (tx >= s.x - 2 && tx < s.x + fp[0] + front && ty >= s.y - 2 && ty < s.y + fp[1] + front) { n++; break; }
        }
      }
      return n;
    };
    let best = null, bestScore = Infinity, clean = null, cleanScore = Infinity;
    for (let by = 6; by < HH - 6; by += 2) {
      for (let bx = 6; bx < W - 6; bx += 2) {
        const spots = spotsAt(bx, by);
        if (!onGrass(spots)) continue;
        const cx = bx + stepX * (items.length - 1) / 2, cy = by + stepY * (items.length - 1) / 2;
        const score = crowd(spots, 7) + Math.hypot(cx - W / 2, cy - HH / 2) * 0.15;
        if (score < bestScore) { bestScore = score; best = spots; }
        if (crowd(spots, 9) === 0 && score < cleanScore) { cleanScore = score; clean = spots; }
      }
    }
    if (clean) { best = clean; }
    if (!best) return null;
    for (const s of best) {                       // расчистить площадку под ряд
      const fp = fpOf(s.rot), keep = [];
      for (const o of w.objects) {
        const tx = Math.floor(o.x), ty = Math.floor(o.y);
        const hit = tx >= s.x - 2 && tx < s.x + fp[0] + 3 && ty >= s.y - 2 && ty < s.y + fp[1] + 3;
        if (!hit) keep.push(o);
      }
      w.objects = keep;
    }
    r.__houses = best;
    // зум: ряд должен влезть в кадр
    const span = (items.length - 1) * ${gap} + 4.5;
    r.cam.zoom = Math.min(84, (r.cssW - 60) / span);
    const fp0 = fpOf(best[0].rot), fp1 = fpOf(best[best.length - 1].rot);
    const c0 = best[0], c1 = best[best.length - 1];
    r.centerOn(c0.x + fp0[0] / 2 + (c1.x + fp1[0] / 2 - c0.x - fp0[0] / 2) / 2,
               c0.y + fp0[1] / 2 + (c1.y + fp1[1] / 2 - c0.y - fp0[1] / 2) / 2 + 0.6);
    return { spots: best, zoom: r.cam.zoom, clean: !!clean, crowd: bestScore };
  })()`);

  const draw = async (showFootprint) => js(`(() => {
    const r = window.__mapgen.renderer, ctx = document.getElementById('view').getContext('2d');
    const H = window.__house, meta = H.meta, img = H.img;
    r.render(1);
    /* sx/sy отдают координаты относительно ЦЕНТРА экрана: рендер сам делает
       translate(cssW/2, cssH/2). При прямой отрисовке его надо повторить. */
    ctx.save();
    ctx.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    ctx.translate(r.cssW / 2, r.cssH / 2);
    const z = r.cam.zoom;
    const az = meta.az_deg * Math.PI / 180, el = meta.el_deg * Math.PI / 180, ppu = meta.ppu;
    const ca = Math.cos(az);
    const scx = z / (2 * ca * ppu), scy = z / (4 * Math.sin(el) * ca * ppu);
    for (const s of r.__houses) {
      const f = meta.frames['sh_' + s.variant + '_' + s.rot];
      if (!f) continue;
      const fp = f.footprint;
      const dw = f.w * scx, dh = f.h * scy;
      const cx = r.sx(s.x + fp[0] / 2, s.y + fp[1] / 2), cy = r.sy(s.x + fp[0] / 2, s.y + fp[1] / 2);
      ctx.drawImage(img, f.x, f.y, f.w, f.h,
        cx - dw * (f.anchorX / f.w), cy - dh * (f.anchorY / f.h), dw, dh);
    }
    if (${showFootprint ? 'true' : 'false'}) {
      const hw = z * 0.5, hh = z * 0.25;
      for (const s of r.__houses) {
        const f = meta.frames['sh_' + s.variant + '_' + s.rot];
        const fp = f ? f.footprint : ((s.rot % 180 === 0) ? [2, 3] : [3, 2]);
        ctx.beginPath();
        for (let j = 0; j < fp[1]; j++) for (let i = 0; i < fp[0]; i++) {
          const cx = r.sx(s.x + i + 0.5, s.y + j + 0.5), cy = r.sy(s.x + i + 0.5, s.y + j + 0.5);
          ctx.moveTo(cx, cy - hh); ctx.lineTo(cx + hw, cy);
          ctx.lineTo(cx, cy + hh); ctx.lineTo(cx - hw, cy); ctx.closePath();
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = Math.max(1, z / 44);
        ctx.stroke();
      }
    }
    ctx.restore();
    /* Снимок делаем ЗДЕСЬ ЖЕ: карта с волнами перерисовывается каждый кадр,
       и отдельный вызов toDataURL ловит уже чистый кадр без наших спрайтов. */
    return { png: r.canvas.toDataURL('image/png'), zoom: z,
             sx: r.sx(r.__houses[0].x + 1.5, r.__houses[0].y + 1), n: r.__houses.length };
  })()`);

  console.log('стартовый дом (тип house) 2 x 3 на карте:');
  const rotations = await row([['a', 0], ['a', 90], ['a', 180], ['a', 270]], 5);
  console.log('  четыре поворота: ' + (rotations ? JSON.stringify(rotations.spots.map(s => [s.rot, s.x, s.y])) : 'нет места'));
  const shot1 = await draw(true);
  fs.writeFileSync(path.join(OUT, 'house-map-rotations.png'),
    Buffer.from(shot1.png.split(',')[1], 'base64'));
  console.log('  house-map-rotations.png  (зум ' + shot1.zoom.toFixed(0) +
    (rotations && rotations.clean ? ', чистое поле' : '') + ')');

  /* Два дома рядом: у пятна остаётся зазор 1/3 клетки по длинной стороне, и по
     нему две постройки встают вплотную, не наезжая друг на друга (правило
     заказчика 2026-10-13 — то, ради чего зазор вообще делается). */
  const pair = await row([['a', 0], ['a', 0]], 4);
  console.log('  два дома рядом: ' + (pair ? JSON.stringify(pair.spots.map(s => [s.x, s.y])) : 'нет места'));
  const shot2 = await draw(true);
  fs.writeFileSync(path.join(OUT, 'house-map-neighbours.png'),
    Buffer.from(shot2.png.split(',')[1], 'base64'));
  console.log('  house-map-neighbours.png');

  if (errors.length) { console.log('\nошибки:'); errors.forEach(e => console.log('  ' + e)); process.exitCode = 1; }
  else console.log('\nошибок в консоли нет');

  ws.close(); killChrome();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('ошибка: ' + (e && e.stack || e)); killChrome(); process.exit(1); });
