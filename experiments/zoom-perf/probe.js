/* probe.js — замер стоимости кадра при зуме (диагностика, не приёмка).

   Грузит игру в headless Chrome, начинает партию на 192-й карте и меряет
   render() покадрово в трёх режимах: стоящая камера, приближение, отдаление.
   Внутри render() обёрнуты этапы (земля, море, волны, участки, спрайты) и
   spriteEdge — пересборка цветной каймы. Вторая половина опыта повторяет зум
   с ЗАМОРОЖЕННОЙ толщиной каймы: если кайма и есть причина, зум перестанет
   быть дороже стоянки.

   Запуск: node experiments/zoom-perf/probe.js [file:///путь/к/game/index.html]
   Код возврата 1 — только если прогон не состоялся. */

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = require('../../mapgen2/tools/chrome.js');
const ROOT = path.join(__dirname, '..', '..');

/* Игра грузится по HTTP, а не с file://. Причина одна: под file:// холст
   считается «чужим» из-за картинок атласа, и getImageData в замере падает
   SecurityError. А без чтения пикселя браузер не обязан доделать кадр до
   возврата из render(), и растеризация в замер не попадает вовсе. */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'
};
const HTTP_PORT = 9600 + (process.pid % 90);
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('нет файла'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
});
server.listen(HTTP_PORT, '127.0.0.1');
const URL_ARG = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--')))[0];
const url = URL_ARG || 'http://127.0.0.1:' + HTTP_PORT + '/game/index.html';
const ARGS = process.argv.slice(2);
const opt = (name, def) => { const i = ARGS.indexOf('--' + name); return i >= 0 && ARGS[i + 1] ? Number(ARGS[i + 1]) : def; };
const DPR = opt('dpr', 1);
const VILLAGERS = opt('villagers', 0);
const BUILDINGS = opt('buildings', 0);
const PORT = 9700 + (process.pid % 90);
const PROFILE = '/tmp/dsh-4tox-zoom-' + process.pid;

const NOGPU = ARGS.indexOf('--nogpu') >= 0;
const flags = ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=' + DPR,
  '--window-size=1440,900', 'about:blank'];
if (NOGPU) flags.push('--disable-gpu');
const chrome = spawn(CHROME, flags, { stdio: 'ignore', detached: true });

function killChrome() {
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) { /* уже */ }
}
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
    for (const cb of pending.values()) cb({ __cdpError: { message: 'WebSocket закрыт' } });
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
  await send('Page.navigate', { url });
  await sleep(1500);

  // Ждём, пока игра поднимется (boot → Play.init → атласы).
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      if (await js('!!(window.__game && window.__game.Play && window.__game.Play.ready())')) { ready = true; break; }
    } catch (e) { /* страница ещё грузится */ }
    await sleep(250);
  }
  if (!ready) throw new Error('игра не поднялась: нет window.__game.Play.ready()');

  // Партия на большой карте: на ней и жалуются на зум.
  const info = await js(`(() => {
    const P = window.__game.Play;
    P.start({ seed: 20260101, size: 192, mode: 'solo' });
    const r = P.renderer();
    if (${VILLAGERS} > 0 && window.Session && Session.spawnVillagersCore) {
      const core = Session.spawnVillagersCore(P.state.world, P.state.buildings,
        P.state.buildings[0], { count: ${VILLAGERS}, append: true });
      P.state.villagers = core;
      r.setVillagers(core);
    }
    if (${BUILDINGS} > 0) {
      const base = P.state.buildings.slice();
      const extra = [];
      for (let i = 0; i < ${BUILDINGS}; i++) {
        const src = base[i % base.length];
        extra.push(Object.assign({}, src, {
          id: 6000 + i,
          x: src.x + ((i % 6) - 3) * 4,
          y: src.y + (Math.floor(i / 6) - 2) * 4
        }));
      }
      P.state.buildings = base.concat(extra);
      r.setBuildings(P.state.buildings);
    }
    r.maxZoom = r.maxZoom || 96;
    return {
      size: P.state.world.islandSize,
      objects: P.state.world.objects.length,
      villagers: P.state.villagers.length,
      buildings: P.state.buildings.length,
      zoom: +r.cam.zoom.toFixed(2),
      minZoom: +r.minZoom.toFixed(2),
      maxZoom: +r.maxZoom.toFixed(2),
      css: [r.cssW, r.cssH], dpr: r.dpr
    };
  })()`);
  console.log('мир:', JSON.stringify(info));

  const setup = await js(`(() => {
    const R = window.Render.Renderer.prototype;
    const P = window.__game.Play;
    const st = window.__perf = { stage: {} };
    const names = ['render', 'drawLand', 'drawSeaTexture', 'drawWaterShimmer',
      'drawPlots', 'drawObjects', 'eachSprite', 'drawBuilding', 'spriteEdge',
      'drawSpriteOutline', 'drawSelection', 'drawGhost'];
    for (const n of names) {
      if (!R[n] || R[n].__wrapped) continue;
      const orig = R[n];
      const w = function () {
        const t0 = performance.now();
        try { return orig.apply(this, arguments); }
        finally {
          const dt = performance.now() - t0;
          const s = st.stage[n] || (st.stage[n] = { n: 0, ms: 0, max: 0 });
          s.n++; s.ms += dt; if (dt > s.max) s.max = dt;
        }
      };
      w.__wrapped = true; R[n] = w;
    }
    // Пропуски кэша каймы: сколько раз за прогон холст каймы собирается заново.
    const origEdge = R.spriteEdge;
    st.edgeMiss = 0; st.edgeHit = 0;
    R.spriteEdge = function (spr, color, thickness, clip) {
      const t = Math.max(1, Math.round(thickness || 2));
      const key = color + '|' + t + '|' + Math.max(0, Math.round(clip || 0));
      const c = spr._edges || [];
      let hit = false;
      for (let i = 0; i < c.length; i++) if (c[i].key === key) { hit = true; break; }
      if (hit) st.edgeHit++; else st.edgeMiss++;
      return origEdge.call(this, spr, color, thickness, clip);
    };
    st.frozenEdge = false;
    st.noEdge = false;
    const edgeOrig = R.spriteEdge;
    st.bakeTime = 0; st.bakeN = 0;
    R.spriteEdge = function (spr, color, thickness, clip) {
      if (st.noEdge) return null;
      if (st.frozenEdge) thickness = 2;
      const t0 = performance.now();
      const out = edgeOrig.call(this, spr, color, thickness, clip);
      const dt = performance.now() - t0;
      if (dt > 0.01) { st.bakeTime += dt; st.bakeN++; }
      return out;
    };
    const outOrig = R.drawSpriteOutline;
    R.drawSpriteOutline = function (ctx, box, color, screenPx, clipBottom) {
      if (st.noEdge) return;
      return outOrig.call(this, ctx, box, color, screenPx, clipBottom);
    };
    st.setFrozen = function (on) { st.frozenEdge = !!on; };
    st.setNoEdge = function (on) { st.noEdge = !!on; };
    st.run = function (mode, frames, step) {
      const r = P.renderer();
      const cam = { x: r.cam.x, y: r.cam.y, zoom: r.cam.zoom };
      st.stage = {}; st.edgeHit = 0; st.edgeMiss = 0; st.bakeTime = 0; st.bakeN = 0;
      const times = [];
      let t = performance.now() / 1000;
      for (let i = 0; i < frames; i++) {
        if (mode === 'in') r.cam.zoom = Math.min(r.maxZoom, r.cam.zoom * step);
        else if (mode === 'out') r.cam.zoom = Math.max(r.minZoom, r.cam.zoom / step);
        t += 1 / 60;
        const f0 = performance.now();
        r.render(t);
        // Readback заставляет браузер ДОДЕЛАТЬ кадр (растеризацию и блит
        // текстур) до возврата из вызова: иначе канва откладывает работу, и
        // JS-время render() о ней ничего не говорит.
        r.ctx.getImageData(0, 0, 1, 1);
        times.push(performance.now() - f0);
      }
      r.cam.x = cam.x; r.cam.y = cam.y; r.cam.zoom = cam.zoom;
      times.sort(function (a, b) { return a - b; });
      const q = function (p) { return +times[Math.min(frames - 1, Math.floor(frames * p))].toFixed(2); };
      const out = {
        mode: mode, frames: frames, zoom: +cam.zoom.toFixed(1),
        p50: q(0.5), p95: q(0.95), max: +times[frames - 1].toFixed(2),
        edgeHit: st.edgeHit, edgeMiss: st.edgeMiss, bakeMs: +st.bakeTime.toFixed(1), bakeN: st.bakeN, stage: {}
      };
      for (const n in st.stage) {
        out.stage[n] = {
          calls: st.stage[n].n,
          avg: +(st.stage[n].ms / st.stage[n].n).toFixed(2),
          total: +st.stage[n].ms.toFixed(1)
        };
      }
      return out;
    };
    return 'ok';
  })()`);
  if (setup !== 'ok') throw new Error('инструментовка не встала');

  const scenarios = [];
  // Стоящая камера — база. Камеру ставим на деревню, как в партии.
  await js(`(() => {
    const P = window.__game.Play, r = P.renderer();
    const b = P.state.buildings[0];
    r.cam.x = b.x + 2; r.cam.y = b.y + 2;
    r.cam.zoom = Math.min(r.maxZoom, r.minZoom * 3);
  })()`);
  scenarios.push(await js('window.__perf.run("still", 90, 1)'));
  scenarios.push(await js('window.__perf.run("in", 90, 1.02)'));
  scenarios.push(await js('window.__perf.run("out", 90, 1.02)'));
  // Тот же зум с замороженной толщиной каймы.
  await js('window.__perf.setFrozen(true)');
  await js(`(() => {
    const P = window.__game.Play, r = P.renderer();
    const b = P.state.buildings[0];
    r.cam.x = b.x + 2; r.cam.y = b.y + 2;
    r.cam.zoom = Math.min(r.maxZoom, r.minZoom * 3);
  })()`);
  await js('window.__perf.run("in", 30, 1.02)');   // прогрев кэша каймы
  const frozen = await js('window.__perf.run("in", 90, 1.02)');
  await js('window.__perf.setFrozen(false)');
  // Третий вариант: каймы нет вовсе — верхняя граница экономии.
  await js('window.__perf.setNoEdge(true)');
  await js(`(() => {
    const P = window.__game.Play, r = P.renderer();
    const b = P.state.buildings[0];
    r.cam.x = b.x + 2; r.cam.y = b.y + 2;
    r.cam.zoom = Math.min(r.maxZoom, r.minZoom * 3);
  })()`);
  const noEdge = await js('window.__perf.run("in", 90, 1.02)');
  await js('window.__perf.setNoEdge(false)');

  // Предельное отдаление: там на кадре весь остров, море и волны.
  await js(`(() => {
    const P = window.__game.Play, r = P.renderer();
    r.cam.x = P.state.world.width / 2; r.cam.y = P.state.world.height / 2;
    r.cam.zoom = r.minZoom;
  })()`);
  const far = await js('window.__perf.run("still", 60, 1)');

  const report = { info, scenarios, frozenZoom: frozen, noEdge: noEdge, farStill: far };
  fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(report, null, 2));

  const show = (o) => {
    console.log(`\n${o.mode}: кадр p50 ${o.p50} мс, p95 ${o.p95} мс, max ${o.max} мс` +
      ` · кайма: промахов ${o.edgeMiss}, попаданий ${o.edgeHit}`);
    Object.keys(o.stage).sort((a, b) => o.stage[b].total - o.stage[a].total)
      .slice(0, 6).forEach((n) => {
        const s = o.stage[n];
        console.log(`   ${n.padEnd(18)} ${s.avg.toFixed(2)} мс/вызов · ${s.calls} выз. · ${s.total.toFixed(0)} мс всего`);
      });
  };
  scenarios.forEach(show);
  console.log('\n--- A/B: тот же зум, толщина каймы в пикселях спрайта заморожена ---');
  show(frozen);
  console.log('\n--- A/B: тот же зум, каймы нет вовсе ---');
  show(noEdge);
  console.log('\n--- предел отдаления, камера стоит ---');
  show(far);

  ws.close();
  killChrome();
  process.exit(0);
})().catch((e) => {
  console.error('прогон не состоялся:', e.message);
  killChrome();
  process.exit(1);
});
