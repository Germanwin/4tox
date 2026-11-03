/* fps-attribution.js — сколько кадров в секунду даёт игра при разном числе
   жителей и какая часть кадра виновата.

   Зачем. frame-cost.js меряет работу, а этот скрипт — ФПС, то есть то, что
   видит игрок, вместе с растеризацией и композитором (они в JS-время не
   входят). Поэтому его числа шумные: здесь для каждой настройки делается
   несколько прогонов и берётся медиана.

   Что печатает для каждого числа жителей:
     - rAF-ФПС «как есть» и p50/p95 промежутка между кадрами;
     - ФПС с выключенной ОДНОЙ частью кадра: жители на карте, их обводка,
       список жителей в панели, миникарта, HUD целиком.

   Запуск:
     node research/villager-fps-2026-11-01/tools/fps-attribution.js
     node research/villager-fps-2026-11-01/tools/fps-attribution.js --counts 3,300,600 --runs 5
     node research/villager-fps-2026-11-01/tools/fps-attribution.js --dpr 2 --window 2560x1440
     node research/villager-fps-2026-11-01/tools/fps-attribution.js --throttle 4   # слабая машина
     node research/villager-fps-2026-11-01/tools/fps-attribution.js --nogpu         # без аппаратного ускорения
*/
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CHROME = require(path.join(REPO, 'mapgen2/tools/chrome.js'));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? def : process.argv[i + 1];
}
const has = (name) => process.argv.includes('--' + name);
const COUNTS = String(arg('counts', '3,300,600')).split(',').map(Number);
const RUNS = Number(arg('runs', 3));
const SECS = Number(arg('secs', 2));
const DPR = Number(arg('dpr', 1));
const SIZE = Number(arg('size', 192));
const ZOOM = String(arg('zoom', '40'));
const THROTTLE = Number(arg('throttle', 1));
const WINDOW = String(arg('window', '1440x900')).split('x').map(Number);
const PORT = 9500 + (process.pid % 400);
const PROFILE = path.join(os.tmpdir(), '4tox-fpsattr-' + process.pid);

const flags = ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--hide-scrollbars', 'about:blank'];
if (has('nogpu')) flags.unshift('--disable-gpu');
const chrome = spawn(CHROME, flags, { stdio: 'ignore', detached: true });
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => {
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {}
  process.exit(130);
}));

const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILL = require('fs').readFileSync(path.join(__dirname, 'fill.js'), 'utf8');

(async () => {
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
  await send('Emulation.setDeviceMetricsOverride', {
    width: WINDOW[0], height: WINDOW[1], deviceScaleFactor: DPR, mobile: false
  });
  if (THROTTLE > 1) await send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
  await send('Page.navigate', { url: 'file://' + path.join(REPO, 'game/index.html') });

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
  if (SIZE !== 96) {
    await js(`window.__game.Play.start({ seed: 'fps-attribution', size: ${SIZE} }); 1`);
    await sleep(2500);
  }

  await js(`(() => {
    ${FILL}
    const P = window.__game.Play, r = P.renderer(), proto = Object.getPrototypeOf(r);
    window.__probe = {
      fill: fill,
      proto: proto,
      edge: proto.drawSpriteOutline,
      zoom(z) {
        const t = P.state.buildings[0];
        r.cam.zoom = z; r.cam.x = t.x + 1.5; r.cam.y = t.y + 2; r.clampCamera();
      },
      sample(secs) {
        return new Promise((res) => {
          const gaps = []; let prev = 0, t0 = 0;
          function step(t) {
            if (!t0) t0 = t;
            if (prev) gaps.push(t - prev);
            prev = t;
            if (t - t0 < secs * 1000) requestAnimationFrame(step);
            else {
              const s = gaps.slice().sort((a, b) => a - b);
              res({
                fps: 1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length),
                p50: s[Math.floor(s.length * 0.5)],
                p95: s[Math.floor(s.length * 0.95)],
                frames: gaps.length
              });
            }
          }
          requestAnimationFrame(step);
        });
      }
    };
    return 1;
  })()`);

  const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
  const info = await js(`({ v: window.__game.Play.state.villagers.length,
    canvas: [window.__game.Play.renderer().canvas.width, window.__game.Play.renderer().canvas.height] })`);
  console.log(`кадр ${info.canvas.join('x')} пикселей (окно ${WINDOW.join('x')} css, dpr ${DPR})` +
    (has('nogpu') ? ' · без аппаратного ускорения' : '') + (THROTTLE > 1 ? ` · CPU ×${THROTTLE}` : '') +
    ` · мир ${SIZE} · зум ${ZOOM} · прогонов на настройку ${RUNS}`);

  const CONFIGS = [
    ['всё как есть', '', ''],
    ['без жителей на карте',
      'window.__game.Play.renderer().showVillagers = false;',
      'window.__game.Play.renderer().showVillagers = true;'],
    ['без обводки жителей',
      'window.__probe.proto.drawSpriteOutline = function () {};',
      'window.__probe.proto.drawSpriteOutline = window.__probe.edge;'],
    ['без списка жителей (HUD)',
      'window.__probe.vl = document.getElementById("villagerList"); if (window.__probe.vl) window.__probe.vl.remove();',
      'if (window.__probe.vl) document.getElementById("debugDrawer").appendChild(window.__probe.vl);'],
    ['без миникарты',
      'window.__probe.mm = window.__game.Play.renderer().minimap; window.__game.Play.renderer().minimap = null;',
      'window.__game.Play.renderer().minimap = window.__probe.mm;'],
    ['без HUD целиком',
      'window.__probe.hud = window.__game.Hud.tick; window.__game.Hud.tick = function () {};',
      'window.__game.Hud.tick = window.__probe.hud;']
  ];

  for (const n of COUNTS) {
    const have = await js('window.__game.Play.state.villagers.length');
    if (have < n) { await js(`window.__probe.fill(${n - have})`); await sleep(500); }
    else if (have > n) {
      await js(`(() => { const P = window.__game.Play, st = P.state;
        st.villagers.length = ${n}; st.world._villagers = st.villagers;
        P.renderer().setVillagers(st.villagers); return 1; })()`);
      await sleep(300);
    }
    await js(ZOOM === 'fit' ? 'window.__game.Play.fit(); 1' : `window.__probe.zoom(${Number(ZOOM)}); 1`);
    await sleep(300);
    const total = await js('window.__game.Play.state.villagers.length');
    const zoom = await js('Math.round(window.__game.Play.renderer().cam.zoom * 10) / 10');
    console.log(`\n=== жителей ${total}, зум ${zoom} ===`);
    for (const [name, off, on] of CONFIGS) {
      await js(off);
      await sleep(350);
      const runs = [];
      for (let k = 0; k < RUNS; k++) runs.push(await js(`window.__probe.sample(${SECS})`));
      await js(on);
      await sleep(250);
      const fps = runs.map((r) => r.fps).sort((a, b) => a - b);
      const mid = fps[Math.floor(fps.length / 2)];
      const p50 = runs[Math.floor(RUNS / 2)].p50;
      console.log('   ' + name.padEnd(30) + ' медиана ' + f1(mid).padStart(5) + ' к/с' +
        '  (кадр p50 ' + f1(p50) + ' мс; прогоны: ' + fps.map((x) => f1(x)).join(', ') + ')');
    }
  }

  try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {}
  process.exit(0);
})().catch((e) => {
  console.error('замер не состоялся:', (e && e.message) || e);
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch (_) {}
  process.exit(1);
});
