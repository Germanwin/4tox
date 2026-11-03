/* proto.js — прототипы двух главных облегчений, замер + ПРОВЕРКА КАРТИНКИ.

   1. HUD: убрать чтение clientWidth у каждого портрета (сейчас это
      принудительная раскладка на каждую строку). Мерим LayoutCount/
      LayoutDuration до и после.
   2. Обводка: сложить спрайт и его кайму в ОДИН холст и рисовать одним
      drawImage вместо двух. Мерим время и СРАВНИВАЕМ КАДРЫ ПО ПИКСЕЛЯМ —
      сколько пикселей и насколько отличается.

   Чтобы прочитать пиксели кадра, страница открывается по http (по file://
   холст считается «чужим источником» и getImageData бросает SecurityError).
   Поэтому скрипт сам поднимает крошечный статический сервер на этот репозиторий.

   Запуск: node research/villager-fps-2026-11-01/tools/proto.js
           [--count 600] [--dpr 2] [--zoom 40] [--size 192]
*/
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CHROME = require(path.join(REPO, 'mapgen2/tools/chrome.js'));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? def : process.argv[i + 1];
}
const COUNT = Number(arg('count', 600));
const DPR = Number(arg('dpr', 2));
const ZOOM = String(arg('zoom', '40'));
const SIZE = Number(arg('size', 192));
const WINDOW = String(arg('window', '1440x900')).split('x').map(Number);
const PROFILE = path.join(os.tmpdir(), '4tox-proto-' + process.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'
};

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
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});

(async () => {
  const { server, port: webPort } = await serve();
  const cdpPort = 9400 + (process.pid % 300);
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + cdpPort,
    '--user-data-dir=' + PROFILE, '--no-first-run', '--hide-scrollbars', 'about:blank'],
  { stdio: 'ignore', detached: true });
  const kill = () => {
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {}
    try { server.close(); } catch (e) {}
  };
  ['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { kill(); process.exit(130); }));

  try {
    for (let i = 0; i < 120; i++) {
      try { await getJSON('http://127.0.0.1:' + cdpPort + '/json/version'); break; }
      catch (e) { await sleep(150); }
    }
    const list = await getJSON('http://127.0.0.1:' + cdpPort + '/json/list');
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 1; const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.error ? { __cdpError: m.error } : m.result); pending.delete(m.id); }
    });
    const send = (method, params) => new Promise((r) => {
      const i = id++; pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
    const js = async (expr) => {
      const res = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
      if (!res) throw new Error('CDP не ответил');
      if (res.__cdpError) throw new Error('CDP: ' + JSON.stringify(res.__cdpError));
      if (res.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error((d.exception && d.exception.description) || d.text);
      }
      return res.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Performance.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: WINDOW[0], height: WINDOW[1], deviceScaleFactor: DPR, mobile: false
    });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + webPort + '/game/index.html' });

    const waitFor = async (expr, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try { if (await js(expr)) return true; } catch (e) {}
        await sleep(200);
      }
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
    if (SIZE !== 96) { await js(`window.__game.Play.start({ seed: 'proto', size: ${SIZE} }); 1`); await sleep(2500); }

    const FILL = fs.readFileSync(path.join(__dirname, 'fill.js'), 'utf8');
    const added = await js(`(() => {
      ${FILL}
      fill(${COUNT});
      const P = window.__game.Play, r = P.renderer(), t = P.state.buildings[0];
      r.cam.zoom = ${Number(ZOOM)}; r.cam.x = t.x + 1.5; r.cam.y = t.y + 2; r.clampCamera();
      return P.state.villagers.length;
    })()`);

    const info = await js(`({ canvas: [window.__game.Play.renderer().canvas.width,
      window.__game.Play.renderer().canvas.height], dpr: window.__game.Play.renderer().dpr,
      zoom: Math.round(window.__game.Play.renderer().cam.zoom * 10) / 10 })`);
    console.log(`жителей ${added} · кадр ${info.canvas.join('x')} (окно ${WINDOW.join('x')} css, dpr ${info.dpr}) · зум ${info.zoom}`);

    /* ---------- 1. обводка: два drawImage против одного ---------- */
    const t = await js(`(() => {
      const P = window.__game.Play, r = P.renderer(), proto = Object.getPrototypeOf(r);
      const key = (spr, color, px, clip) => color + '|' + px + '|' + clip;

      /* Сложить спрайт и его кайму в один холст ТОГО ЖЕ размера, что кадр
         атласа. Кайма рисуется ровно та же (тот же spriteEdge с той же
         толщиной и обрезом), просто поверх спрайта в том же холсте. */
      const composeCache = new Map();
      function compose(spr, color, px, clip) {
        const k = spr.sx + '_' + spr.sy + '|' + key(spr, color, px, clip);
        let cv = composeCache.get(k);
        if (cv) return cv;
        const edge = r.spriteEdge(spr, color, px, clip);
        if (!edge) return null;
        cv = document.createElement('canvas');
        cv.width = spr.sw; cv.height = spr.sh;
        const g = cv.getContext('2d');
        g.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh, 0, 0, cv.width, cv.height);
        g.drawImage(edge, 0, 0);
        composeCache.set(k, cv);
        return cv;
      }
      const orig = proto.drawSpriteOutline;
      proto.drawSpriteOutlineOld = orig;
      proto.drawSpriteOutlineComposite = function (ctx, box, color, screenPx, clipBottom) {
        const spr = box.spr;
        if (!spr || !spr.img) return;
        const perPx = box.dw / spr.sw;
        if (!(perPx > 0)) return;
        const px = Math.max(1, Math.round((screenPx || 1.4) / perPx));
        const clip = Math.max(0, Math.round(clipBottom || 0));
        const cv = compose(spr, color, px, clip);
        if (cv) ctx.drawImage(cv, box.dx, box.dy, box.dw, box.dh);
      };

      /* Кадр замораживается: мир не тикает, время рисования одно и то же. */
      P.state.running = false;
      for (const v of P.state.villagers) { v.phase = 0.37; }
      const ctx = r.ctx;
      const grab = () => ctx.getImageData(0, 0, r.canvas.width, r.canvas.height).data;
      const cost = (n) => { const t0 = performance.now();
        for (let i = 0; i < n; i++) P.draw(2.0); return (performance.now() - t0) / n; };

      P.draw(2.0);
      const a = grab();
      const msTwo = cost(40);

      proto.drawSpriteOutline = proto.drawSpriteOutlineComposite;
      P.draw(2.0);
      const b = grab();
      const msOne = cost(40);
      proto.drawSpriteOutline = orig;

      let diff = 0, maxd = 0, sum = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]),
          Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
        if (d) { diff++; sum += d; if (d > maxd) maxd = d; }
      }
      return { msTwo, msOne, diff, maxd, mean: diff ? sum / diff : 0,
        pixels: a.length / 4, composed: composeCache.size };
    })()`);

    const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
    console.log('\nобводка: два холста против одного');
    console.log('   кадр, два drawImage (как сейчас)   ' + f2(t.msTwo) + ' мс');
    console.log('   кадр, один составной холст         ' + f2(t.msOne) + ' мс   (' +
      (t.msOne < t.msTwo ? '−' : '+') + f2(Math.abs(t.msTwo - t.msOne)) + ' мс)');
    console.log('   отличие кадра: ' + t.diff + ' пикселей из ' + t.pixels +
      ' (' + f2(100 * t.diff / t.pixels) + '%), макс. дельта ' + t.maxd + '/255, средняя у отличных ' + f2(t.mean));
    console.log('   составных холстов в кэше: ' + t.composed);

    /* ---------- 2. HUD: clientWidth у каждого портрета ---------- */
    await js(`window.__game.Play.state.running = true; 1`);
    const metrics = async () => {
      const r = await send('Performance.getMetrics');
      const m = {};
      for (const it of r.metrics) m[it.name] = it.value;
      return m;
    };
    const measureHud = async (label) => {
      await js(`window.__game.Hud.tick(0.2); 1`);   // прогрев: пересборка строк
      await sleep(300);
      const a = await metrics();
      await js(`(async () => { const t0 = performance.now();
        while (performance.now() - t0 < 3000) {
          await new Promise(r => requestAnimationFrame(r));
        } return 1; })()`);
      const b = await metrics();
      const d = (k) => (b[k] || 0) - (a[k] || 0);
      console.log('   ' + label.padEnd(34) + ' LayoutCount ' + String(d('LayoutCount')).padStart(4) +
        ' · LayoutDuration ' + f2(d('LayoutDuration') * 1000) + ' мс за 3 с');
      const r = await send('Performance.getMetrics');
      return d('LayoutDuration') * 1000;
    };
    console.log('\nHUD: чтение clientWidth у каждого портрета (600 строк)');
    await measureHud('как сейчас (clientWidth на строку)');
    /* Прототип: размер портрета — константа из CSS (30×38), читается один раз
       на пересборку, а не 600 раз за обновление. */
    await js(`(() => {
      window.__probeSize = { w: 30, h: 38 };
      const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
      const descH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
      Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', {
        configurable: true, get() { return window.__probeSize.w; }
      });
      Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', {
        configurable: true, get() { return window.__probeSize.h; }
      });
      return 1;
    })()`);
    await measureHud('размер портрета — константа');
  } finally {
    kill();
  }
  process.exit(0);
})().catch((e) => {
  console.error('прототип не отработал:', (e && e.message) || e);
  process.exit(1);
});
