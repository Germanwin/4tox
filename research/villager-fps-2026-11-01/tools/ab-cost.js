/* ab-cost.js — A/B одной и той же сцены В ОДНОМ процессе браузера: старая
   реализация против новой. Так шум машины (другие процессы, прогрев, частота)
   сокращается: обе цены снимаются подряд, на одном мире, одной камерой.

   Что сравнивается:
     порядок жителей   — прежний villagerOrder (новый массив + объект на жителя)
     цвет команды      — прежний teamColorFor (rgba-строка на жителя)
     маска закрытия    — прежний coverMask (объект-хеш + копия списка построек)
     кадр спрайта      — прежний поиск поворота перебором for…in

   Запуск: node research/villager-fps-2026-11-01/tools/ab-cost.js [--count 600]
*/
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CHROME = require(path.join(REPO, 'mapgen2/tools/chrome.js'));
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i < 0 ? d : process.argv[i + 1]; }
const COUNT = Number(arg('count', 600));
const DPR = Number(arg('dpr', 2));
const ZOOM = Number(arg('zoom', 40));
const SIZE = Number(arg('size', 192));
const FRAMES = Number(arg('frames', 40));
const PORT = 9200 + (process.pid % 200);
const PROFILE = path.join(os.tmpdir(), '4tox-ab-' + process.pid);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const file = path.join(REPO, rel);
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('нет'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

(async () => {
  const { server, port: webPort } = await serve();
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE, '--no-first-run', '--hide-scrollbars', 'about:blank'],
  { stdio: 'ignore', detached: true });
  const kill = () => { try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {} try { server.close(); } catch (e) {} };
  ['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { kill(); process.exit(130); }));

  try {
    for (let i = 0; i < 120; i++) {
      try { await getJSON('http://127.0.0.1:' + PORT + '/json/version'); break; } catch (e) { await sleep(150); }
    }
    const list = await getJSON('http://127.0.0.1:' + PORT + '/json/list');
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 1; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.error ? { __cdpError: m.error } : m.result); pending.delete(m.id); }
    });
    const send = (method, params) => new Promise((r) => { const i = id++; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const js = async (expr) => {
      const res = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
      if (!res) throw new Error('CDP не ответил');
      if (res.__cdpError) throw new Error('CDP: ' + JSON.stringify(res.__cdpError));
      if (res.exceptionDetails) { const d = res.exceptionDetails; throw new Error((d.exception && d.exception.description) || d.text); }
      return res.result.value;
    };
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: DPR, mobile: false });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + webPort + '/game/index.html' });
    const waitFor = async (expr, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { try { if (await js(expr)) return true; } catch (e) {} await sleep(200); }
      return false;
    };
    if (!await waitFor('!!(window.__game && window.__game.Play)', 30000)) throw new Error('страница не загрузилась');
    await sleep(1200);
    const btn = await js(`(() => { const el = document.querySelector('#btnPlay');
      const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    if (!await waitFor("window.__game.Play.state.mode === 'play'", 20000)) throw new Error('партия не началась');
    await sleep(2500);
    if (SIZE !== 96) { await js(`window.__game.Play.start({ seed: 'ab-cost', size: ${SIZE} }); 1`); await sleep(2500); }

    const FILL = fs.readFileSync(path.join(__dirname, 'fill.js'), 'utf8');
    await js(`(() => {
      ${FILL}
      fill(${COUNT});
      const P = window.__game.Play, r = P.renderer(), t = P.state.buildings[0];
      r.cam.zoom = ${ZOOM}; r.cam.x = t.x + 1.5; r.cam.y = t.y + 2; r.clampCamera();
      window.__ab = {
        r: r, P: P, proto: Object.getPrototypeOf(r),
        cost(n) { const t0 = performance.now();
          for (let i = 0; i < n; i++) { P.tick(1 / 60); P.draw(i / 60); window.__game.Hud.tick(1 / 60); }
          return (performance.now() - t0) / n; },
        /* Старые реализации — ровно те, что были до правки. */
        oldOrder() {
          const R = this.proto;
          this._order = R.villagerOrder;
          R.villagerOrder = function () {
            var out = [], i, v;
            for (i = 0; i < this.villagers.length; i++) { v = this.villagers[i]; out.push({ v: v, key: v.x + v.y }); }
            out.sort(function (a, c) { return a.key - c.key; });
            return out;
          };
        },
        oldColor() {
          const R = this.proto;
          this._color = R.teamColorFor;
          R.teamColorFor = function (owner, alpha) {
            var w = this.world;
            var t = w && w.towns && w.towns[owner === undefined ? 0 : owner];
            var hex = t && t.color ? String(t.color).replace('#', '') : '4a90d9';
            if (hex.length !== 6) hex = '4a90d9';
            var r2 = parseInt(hex.slice(0, 2), 16), g2 = parseInt(hex.slice(2, 4), 16), b2 = parseInt(hex.slice(4, 6), 16);
            return 'rgba(' + r2 + ',' + g2 + ',' + b2 + ',' + (alpha === undefined ? 1 : alpha) + ')';
          };
        },
        oldCover() {
          const R = this.proto, B = window.Buildings;
          this._cover = R.coverMask;
          R.coverMask = function () {
            var w = this.world;
            if (!w || !B.coverCells) return null;
            var out = {}, i, j, cells, c;
            var list = (this.buildings || []).slice();
            if (this.pending && this.pending.length) for (i = 0; i < this.pending.length; i++) list.push(this.pending[i]);
            if (this.ghost && this.ghost.b) list.push(this.ghost.b);
            for (i = 0; i < list.length; i++) {
              if (!list[i]) continue;
              cells = B.coverCells(list[i]);
              for (j = 0; j < cells.length; j++) {
                c = cells[j];
                if (c.x < 0 || c.y < 0 || c.x >= w.width || c.y >= w.height) continue;
                out[c.y * w.width + c.x] = 1;
              }
            }
            return out;
          };
        },
        oldSprite() {
          const V = window.Villagers, H = window.Hero;
          this._sprite = V.sprite;
          V.sprite = function (set, h) {
            if (!set) return null;
            var byAnim = set.frames[h.anim] || set.frames.idle;
            if (!byAnim) return null;
            var n = Math.max(1, H.frameCount(set, h.anim));
            var i = Math.floor(h.phase * n) % n;
            var byFrame = byAnim[i] || byAnim[0];
            var best = null, bd = Infinity;
            for (var k in byFrame) {
              var rr = +k;
              var d = Math.abs(((h.rot - rr + 540) % 360) - 180);
              if (d < bd - 1e-9 || (best !== null && Math.abs(d - bd) <= 1e-9 && rr > best)) { bd = d; best = rr; }
            }
            var rot = best === null ? 0 : best;
            return byFrame[rot] || byFrame[0] || null;
          };
        },
        restore(which) {
          const R = this.proto;
          if (which === 'order' && this._order) { R.villagerOrder = this._order; this._order = null; }
          if (which === 'color' && this._color) { R.teamColorFor = this._color; this._color = null; }
          if (which === 'cover' && this._cover) { R.coverMask = this._cover; this._cover = null; R._cover = null; }
          if (which === 'sprite' && this._sprite) { window.Villagers.sprite = this._sprite; this._sprite = null; }
        }
      };
      return 1;
    })()`);

    const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
    const total = await js('window.__game.Play.state.villagers.length');
    console.log(`жителей ${total} · зум ${ZOOM} · dpr ${DPR} · ${FRAMES} кадров на замер`);
    console.log('(A/B в одном процессе: «новое» и «старое» снимаются подряд, шум машины общий)');

    const CASES = [
      ['порядок жителей', 'oldOrder'],
      ['цвет команды', 'oldColor'],
      ['маска закрытия', 'oldCover'],
      ['кадр спрайта', 'oldSprite']
    ];
    /* Прогрев. */
    await js(`window.__ab.cost(20); 1`);
    for (const [name, fn] of CASES) {
      await js(`window.__ab.restore(${JSON.stringify(fn.replace('old', '').toLowerCase())}); 1`);
      const a = [];
      for (let k = 0; k < 3; k++) a.push(await js(`window.__ab.cost(${FRAMES})`));
      await js(`window.__ab.${fn}(); 1`);
      const b = [];
      for (let k = 0; k < 3; k++) b.push(await js(`window.__ab.cost(${FRAMES})`));
      await js(`window.__ab.restore(${JSON.stringify(fn.replace('old', '').toLowerCase())}); 1`);
      const med = (arr) => arr.slice().sort((x, y) => x - y)[1];
      const na = med(a), nb = med(b);
      console.log('   ' + name.padEnd(18) + ' новое ' + f2(na).padStart(6) + ' мс · старое ' + f2(nb).padStart(6) +
        ' мс · разница ' + (na < nb ? '−' : '+') + f2(Math.abs(nb - na)) + ' мс кадра');
    }
  } finally {
    kill();
  }
  process.exit(0);
})().catch((e) => {
  console.error('A/B не отработал:', (e && e.message) || e);
  process.exit(1);
});
