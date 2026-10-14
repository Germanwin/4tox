/* views.js — набор кадров для визуальной проверки: общий план, крупный зум,
 * экспорт PNG. Снимает канвас страницы, а не весь экран, чтобы в кадр
 * не попадали панель и миникарта.
 *
 * Запуск: node tools/views.js [url]
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] || 'file://' + path.join(__dirname, '..', 'index.html');
const OUT = path.join(__dirname, 'out');
const PORT = 9500 + (process.pid % 300);
const PROFILE = '/tmp/dsh-views-' + process.pid;

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
      errors.push(m.params.exceptionDetails.exception ? m.params.exceptionDetails.exception.description : m.params.exceptionDetails.text);
    }
  });
  const send = (method, params) => new Promise(r => {
    const i = id++; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const evalJS = async (expr) => {
    const res = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' + JSON.stringify(res.exceptionDetails.exception && res.exceptionDetails.exception.description));
    return res.result.value;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 3200));

  // Снимаем только сам канвас — панель и миникарта не должны мешать
  const shoot = async (name, setup) => {
    if (setup) await evalJS(setup);
    await new Promise(r => setTimeout(r, 400));
    const dataUrl = await evalJS(`document.getElementById('view').toDataURL('image/png')`);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('  ' + name + '.png');
  };

  console.log('кадры:');
  // Кадр игры: остров целиком и по половине его диаметра моря вокруг.
  await shoot('view-far', `(() => { const r = window.__mapgen.renderer; r.fitIsland(); return 1; })()`);
  // Открытое море далеко от острова: пустоты быть не должно — ни цвета,
  // ни волн за краем карты не обрывается.
  await shoot('view-sea', `(() => {
    const r = window.__mapgen.renderer, w = r.world, b = w.landBounds;
    r.cam.zoom = Math.max(r.minZoom, 22);
    r.centerOn(b.x1 + (b.x1 - b.x0) * 0.35, b.y0 - (b.y1 - b.y0) * 0.35);
    return 1;
  })()`);
  await shoot('view-zoom', `(() => {
    const r = window.__mapgen.renderer, w = r.world;
    r.cam.zoom = 60; r.centerOn(w.width / 2, w.height / 2);
    return 1;
  })()`);
  await shoot('view-forest', `(() => {
    const r = window.__mapgen.renderer, w = r.world;
    // наводим камеру на самую густую рощу
    let best = null, bs = -1;
    for (const o of w.objects) {
      if (o.kind !== 'tree') continue;
      const i = Math.floor(o.y) * w.width + Math.floor(o.x);
      const f = w.forestness[i];
      if (f > bs) { bs = f; best = o; }
    }
    r.cam.zoom = 90;
    if (best) r.centerOn(best.x, best.y);
    return bs;
  })()`);
  await shoot('view-coast', `(() => {
    const r = window.__mapgen.renderer, w = r.world, b = w.landBounds;
    // Средний зум на берег: видно и отмель, и как она уходит в глубину
    r.cam.zoom = 30;
    r.centerOn(b.x1 - 6, (b.y0 + b.y1) / 2);
    return 1;
  })()`);
  await shoot('view-edge', `(() => {
    const r = window.__mapgen.renderer, w = r.world, b = w.landBounds;
    r.cam.zoom = 70; r.centerOn((b.x0 + b.x1) / 2, b.y0 + 2);
    return 1;
  })()`);

  // Экспорт: собираем PNG и проверяем, что он не пустой
  const exp = await evalJS(`(() => {
    const g = window.__mapgen, r = g.renderer;
    const cv = r.exportPNG(1);
    return { size: [cv.width, cv.height], url: cv.toDataURL('image/png').length };
  })()`);
  console.log('экспорт PNG: ' + exp.size.join('×') + ', dataURL ' + exp.url + ' байт');
  const expData = await evalJS(`window.__mapgen.renderer.exportPNG(1).toDataURL('image/png')`);
  fs.writeFileSync(path.join(OUT, 'export.png'), Buffer.from(expData.split(',')[1], 'base64'));
  console.log('  export.png');

  if (errors.length) { console.log('\nошибки:'); errors.forEach(e => console.log('  ' + e)); }
  else console.log('\nошибок в консоли нет');

  ws.close(); chrome.kill('SIGKILL');
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error('ошибка: ' + e.message); chrome.kill('SIGKILL'); process.exit(1); });
