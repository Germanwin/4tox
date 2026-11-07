/* frames.js — как ЧАСТО идут кадры, пока крутится зум (диагностика).

   Первый замер (probe.js) мерял только JS-время render(): разница между
   стоящей камерой и зумом вышла в шум, потому что растеризация canvas
   происходит не в JS-вызове, а в кадре. Поэтому здесь меряется сам кадр:
   интервалы requestAnimationFrame у живого цикла игры в трёх режимах —
   стоянка, зум, снова стоянка. Если кадр дорожает на зуме, интервалы растут.

   Запуск: node experiments/zoom-perf/frames.js [--villagers 150] [--dpr 2]
   Код возврата 1 — только если прогон не состоялся. */

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = require('../../mapgen2/tools/chrome.js');
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};
const VILLAGERS = arg('villagers', 0);
const BUILDINGS = arg('buildings', 0);
const DPR = arg('dpr', 1);
const url = 'file://' + path.join(__dirname, '..', '..', 'game', 'index.html');
const PORT = 9800 + (process.pid % 90);
const PROFILE = '/tmp/dsh-4tox-frames-' + process.pid;

const HEADED = args.indexOf('--headed') >= 0;
const flags = [
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--hide-scrollbars', '--no-default-browser-check',
  '--force-device-scale-factor=' + DPR,
  '--window-size=1440,900', '--window-position=0,0', 'about:blank'
];
if (!HEADED) flags.unshift('--headless=new');
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

  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      if (await js('!!(window.__game && window.__game.Play && window.__game.Play.ready())')) { ready = true; break; }
    } catch (e) { /* грузится */ }
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
    ${VILLAGERS > 0 ? `
    const core = window.Session.spawnVillagersCore(P.state.world, P.state.buildings,
      P.state.buildings[0], { count: ${VILLAGERS}, append: true });
    P.state.villagers = core;
    r.setVillagers(core);
    ` : ''}
    if (${BUILDINGS} > 0) {
      const base = P.state.buildings.slice();
      const extra = [];
      for (let i = 0; i < ${BUILDINGS}; i++) {
        const src = base[i % base.length];
        const b = Object.assign({}, src, {
          id: 5000 + i,
          x: src.x + ((i % 6) - 3) * 4,
          y: src.y + (Math.floor(i / 6) - 2) * 4
        });
        extra.push(b);
      }
      P.state.buildings = base.concat(extra);
      r.setBuildings(P.state.buildings);
    }
    return { villagers: P.state.villagers.length, objects: P.state.world.objects.length,
      buildings: P.state.buildings.length, zoom: +r.cam.zoom.toFixed(2),
      dpr: r.dpr, canvas: [r.canvas.width, r.canvas.height] };
  })()`);
  console.log('мир:', JSON.stringify(info));

  // Живой цикл игры уже рисует каждый кадр. Считаем интервалы кадров.
  const measure = async (mode, ms) => js(`new Promise((resolve) => {
    const P = window.__game.Play, r = P.renderer();
    const deltas = [];
    let last = 0, dir = 1, frames = 0;
    const m0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const t0 = performance.now();
    function step(ts) {
      if (last) deltas.push(ts - last);
      last = ts;
      frames++;
      if (${JSON.stringify(mode)} === 'zoom') {
        // Один «щелчок колеса» на кадр, как у тачпада: 3 % за кадр.
        r.zoomAt(0, 0, dir > 0 ? 1.03 : 1 / 1.03);
        if (r.cam.zoom >= r.maxZoom * 0.98) dir = -1;
        if (r.cam.zoom <= r.minZoom * 1.02) dir = 1;
      }
      if (performance.now() - t0 < ${ms}) requestAnimationFrame(step);
      else resolve({ mode: ${JSON.stringify(mode)}, frames: frames, deltas: deltas,
        heap0: m0, heap1: performance.memory ? performance.memory.usedJSHeapSize : 0,
        canvases: document.querySelectorAll('canvas').length });
    }
    requestAnimationFrame(step);
  })`);

  const summarize = (o, label) => {
    const d = o.deltas.slice(2).sort((a, b) => a - b);
    const at = (p) => d.length ? +d[Math.min(d.length - 1, Math.floor(d.length * p))].toFixed(1) : 0;
    const over = (ms) => d.filter((x) => x > ms).length;
    const out = {
      label: label, frames: d.length, p50: at(0.5), p95: at(0.95),
      max: d.length ? +d[d.length - 1].toFixed(1) : 0,
      over25: over(25), over50: over(50), over100: over(100),
      fps: d.length ? +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1) : 0
    };
    if (o.heap1) {
      out.heapMB = +((o.heap1 - o.heap0) / 1048576).toFixed(1);
    }
    console.log(`  ${label.padEnd(10)} кадров ${out.frames}, FPS ${out.fps}, p50 ${out.p50} мс, p95 ${out.p95} мс, max ${out.max} мс; >25мс ${out.over25}, >50мс ${out.over50}, >100мс ${out.over100}` + (out.heapMB !== undefined ? `; heap ${out.heapMB} МБ` : ''));
    return out;
  };

  console.log('замер (живой цикл игры):');
  const res = {};
  res.idle1 = summarize(await measure('idle', 1600), 'стоянка');
  res.zoom = summarize(await measure('zoom', 2400), 'зум');
  res.idle2 = summarize(await measure('idle', 1600), 'стоянка');
  // То же у предела отдаления — там на кадре весь остров.
  await js(`(() => { const P = window.__game.Play, r = P.renderer();
    r.cam.x = P.state.world.width / 2; r.cam.y = P.state.world.height / 2;
    r.cam.zoom = r.minZoom; })()`);
  await sleep(300);
  res.farIdle = summarize(await measure('idle', 1600), 'даль-стоянка');
  res.farZoom = summarize(await measure('zoom', 2400), 'даль-зум');

  fs.writeFileSync(path.join(__dirname, 'frames-' + (VILLAGERS || 'base') + '-dpr' + DPR + '.json'),
    JSON.stringify({ info, res }, null, 2));

  ws.close();
  killChrome();
  process.exit(0);
})().catch((e) => {
  console.error('прогон не состоялся:', e.message);
  killChrome();
  process.exit(1);
});
