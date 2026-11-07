/* frame-stages.js — куда уходит кадр игры, пока крутится зум.

   Отличие от probe.js: здесь НЕ зовём render() руками, а живём в живом цикле
   игры (boot.js → loop → Play.draw + Hud.tick) и складываем время этапов за
   отрезок. Так видно и то, что делает оболочка: обзор (drawMinimap) в HUD
   перерисовывается ровно тогда, когда меняется cam.zoom (ключ в hud.js:2219).

   Запуск: node experiments/zoom-perf/frame-stages.js [--buildings 26]
           [--villagers 200] [--ms 2000]
   Код возврата 1 — только если прогон не состоялся. */

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = require('../../mapgen2/tools/chrome.js');
const ROOT = path.join(__dirname, '..', '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp'
};
const HTTP_PORT = 9550 + (process.pid % 90);
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
});
server.listen(HTTP_PORT, '127.0.0.1');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def; };
const BUILDINGS = opt('buildings', 0);
const VILLAGERS = opt('villagers', 0);
const MS = opt('ms', 2000);

const PORT = 9850 + (process.pid % 90);
const PROFILE = '/tmp/dsh-4tox-stages-' + process.pid;
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--hide-scrollbars', '--window-size=1440,900', 'about:blank'
], { stdio: 'ignore', detached: true });
function killChrome() { try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {} }
['SIGINT', 'SIGTERM'].forEach(function (sig) {
  process.on(sig, function () { killChrome(); process.exit(130); });
});

const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  for (let i = 0; i < 100; i++) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`); break; }
    catch (e) { await sleep(150); }
  }
  const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 1; const pending = new Map();
  ws.addEventListener('close', () => {
    for (const cb of pending.values()) cb({ __cdpError: { message: 'закрыт' } });
    pending.clear();
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.error ? { __cdpError: m.error } : m.result);
      pending.delete(m.id);
    }
  });
  const send = (method, params) => new Promise(r => {
    const i = id++; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const js = async (expr) => {
    const res = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
    if (!res) throw new Error('CDP не ответил');
    if (res.__cdpError) throw new Error('CDP: ' + (res.__cdpError.message || JSON.stringify(res.__cdpError)));
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return res.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:' + HTTP_PORT + '/game/index.html' });
  await sleep(1500);
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      if (await js('!!(window.__game && window.__game.Play && window.__game.Play.ready())')) { ready = true; break; }
    } catch (e) {}
    await sleep(250);
  }
  if (!ready) throw new Error('игра не поднялась');

  const info = await js(`(() => {
    const P = window.__game.Play;
    P.start({ seed: 20260101, size: 192, mode: 'solo' });
    const r = P.renderer();
    const b = P.state.buildings[0];
    r.cam.x = b.x + 2; r.cam.y = b.y + 2;
    r.cam.zoom = Math.min(r.maxZoom, r.minZoom * 3);
    ${VILLAGERS > 0 ? `{
      const core = Session.spawnVillagersCore(P.state.world, P.state.buildings,
        P.state.buildings[0], { count: ${VILLAGERS}, append: true });
      P.state.villagers = core;
      r.setVillagers(core);
    }` : ''}
    ${BUILDINGS > 0 ? `{
      const base = P.state.buildings.slice();
      const extra = [];
      for (let i = 0; i < ${BUILDINGS}; i++) {
        const src = base[i % base.length];
        extra.push(Object.assign({}, src, { id: 7000 + i,
          x: src.x + ((i % 6) - 3) * 4, y: src.y + (Math.floor(i / 6) - 2) * 4 }));
      }
      P.state.buildings = base.concat(extra);
      r.setBuildings(P.state.buildings);
    }` : ''}
    // Инструментовка: этапы кадра.
    const st = window.__st = { sums: {}, marks: {} };
    function wrap(obj, name) {
      const orig = obj[name];
      if (!orig || orig.__w) return;
      const w = function () {
        const t0 = performance.now();
        try { return orig.apply(this, arguments); }
        finally {
          const dt = performance.now() - t0;
          const s = st.sums[name] || (st.sums[name] = { n: 0, ms: 0 });
          s.n++; s.ms += dt;
        }
      };
      w.__w = true; obj[name] = w;
    }
    wrap(P, 'draw');
    wrap(window.Hud, 'tick');
    const R = window.Render.Renderer.prototype;
    ['render', 'drawLand', 'drawSeaTexture', 'drawWaterShimmer', 'drawPlots',
      'drawObjects', 'spriteEdge', 'drawSpriteOutline'].forEach(n => wrap(R, n));
    st.reset = function () { st.sums = {}; };
    st.report = function () {
      const out = {};
      for (const k in st.sums) out[k] = { n: st.sums[k].n, ms: +st.sums[k].ms.toFixed(1) };
      return out;
    };
    return { villagers: P.state.villagers.length, buildings: P.state.buildings.length,
      objects: P.state.world.objects.length, zoom: +r.cam.zoom.toFixed(2),
      dpr: r.dpr, canvas: [r.canvas.width, r.canvas.height] };
  })()`);
  console.log('мир:', JSON.stringify(info));

  const run = async (mode, ms) => js(`new Promise((resolve) => {
    const P = window.__game.Play, r = P.renderer();
    const st = window.__st;
    st.reset();
    let last = 0, dir = 1, frames = 0;
    const t0 = performance.now();
    function step(ts) {
      if (last) frames++;
      last = ts;
      if (${JSON.stringify(mode)} === 'zoom') {
        r.zoomAt(0, 0, dir > 0 ? 1.03 : 1 / 1.03);
        if (r.cam.zoom >= r.maxZoom * 0.98) dir = -1;
        if (r.cam.zoom <= r.minZoom * 1.02) dir = 1;
      }
      if (performance.now() - t0 < ${ms}) requestAnimationFrame(step);
      else resolve({ mode: ${JSON.stringify(mode)}, frames: frames, stages: st.report() });
    }
    requestAnimationFrame(step);
  })`);

  const show = (o) => {
    console.log(`\n${o.mode}: кадров ${o.frames}`);
    Object.keys(o.stages).sort((a, b) => o.stages[b].ms - o.stages[a].ms).forEach((n) => {
      const s = o.stages[n];
      console.log(`   ${n.padEnd(18)} ${(s.ms / o.frames).toFixed(2)} мс/кадр · ${s.n} выз. · ${s.ms} мс`);
    });
  };

  const idle = await run('idle', MS);
  const zoom = await run('zoom', MS);
  show(idle);
  show(zoom);
  fs.writeFileSync(path.join(__dirname, 'stages.json'), JSON.stringify({ info, idle, zoom }, null, 2));

  ws.close(); killChrome(); process.exit(0);
})().catch((e) => {
  console.error('прогон не состоялся:', e.message);
  killChrome();
  process.exit(1);
});
