/* look.js — проверка кадра: состояние страницы, геометрия карты, скриншот.
 *
 * Считает то, что глазами не измерить: попадает ли мир в экран и стоит ли
 * он по центру. Живые пиксели для этого не годятся — в том же канвасе
 * рисуется миникарта и виньетка, и они попадают в любой замер цвета.
 *
 * Запуск: node tools/look.js [url] [out.png] [ширина] [высота]
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] || 'file://' + path.join(__dirname, '..', 'index.html');
const out = process.argv[3] || path.join(__dirname, 'out', 'look.png');
const W = parseInt(process.argv[4] || '1400', 10);
const H = parseInt(process.argv[5] || '900', 10);
const PORT = 9400 + (process.pid % 400);
const PROFILE = '/tmp/dsh-look-' + process.pid;

fs.mkdirSync(path.dirname(out), { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--window-size=' + W + ',' + H, 'about:blank'
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
      errors.push(m.params.exceptionDetails.exception
        ? m.params.exceptionDetails.exception.description
        : m.params.exceptionDetails.text);
    }
  });
  const send = (method, params) => new Promise(r => {
    const i = id++; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 3500));

  const q = async (expr) => {
    const res = await send('Runtime.evaluate', { returnByValue: true, expression: expr });
    if (res.exceptionDetails) return { error: res.exceptionDetails.text };
    return res.result.value;
  };

  const state = await q(`(() => {
    const g = window.__mapgen, r = g && g.renderer, w = g && g.getWorld();
    const loading = document.getElementById('loading');
    if (!w) return { loading: loading ? loading.textContent.trim() : null, world: null };
    const z = r.cam.zoom, gw = w.width, gh = w.height;
    // Углы карты в координатах канваса (не экрана): начало — левый верх канваса
    const toCanvas = (a, b) => [r.sx(a, b) + r.cssW / 2, r.sy(a, b) + r.cssH / 2];
    const pts = [[0, 0], [gw, 0], [gw, gh], [0, gh]]
      .map(([a, b]) => toCanvas(a, b).map(Math.round));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const mapW = (gw + gh) * z * 0.5, mapH = (gw + gh) * z * 0.25;
    return {
      loading: loading.classList.contains('hidden') ? null : loading.textContent.trim(),
      world: [gw, gh], seed: w.seed, zoom: +z.toFixed(2),
      canvas: [r.cssW, r.cssH], sprites: !!r.sprites,
      objects: w.objects.length, stats: w.stats,
      mapScreenSize: [Math.round(mapW), Math.round(mapH)],
      mapBox: box,
      fitsHorizontally: mapW <= r.cssW + 1,
      fitsVertically: mapH <= r.cssH + 1,
      centreOffset: [Math.round((box[0] + box[2]) / 2 - r.cssW / 2),
                     Math.round((box[1] + box[3]) / 2 - r.cssH / 2)]
    };
  })()`);

  console.log('страница:');
  console.log(JSON.stringify(state, null, 2));
  if (errors.length) { console.log('\nошибки в консоли:'); errors.forEach(e => console.log('  ' + e)); }

  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('\nскриншот: ' + out);

  ws.close(); killChrome();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch(e => { console.error('ошибка: ' + e.message); killChrome(); process.exit(1); });
