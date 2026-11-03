/* frame-cost.js — детерминированная цена ОДНОГО кадра игры при разном числе
   жителей: tick + draw + hud, ровно как в game/js/boot.js -> frame().

   Зачем. FPS — число шумное: rAF-замеры на живой машине скачут в полтора раза
   (планировщик, другие процессы, прогрев Skia). Здесь один и тот же кадр
   гоняется в цикле, поэтому получается цена работы, а не «сколько успел
   браузер».

   Что печатает:
     - мс на кадр при 0/150/300/600/900 жителях;
     - разложение той же цены на 600: сколько из неё даёт отрисовка жителей,
       их обводка, HUD-список, миникарта, и сколько — «база» без них;
     - микросекунды на одного жителя по каждой функции, которая зовётся НА
       КАЖДОГО каждый кадр (спрайт, кайма, box, поиск кадра, цвет, сортировка).

   Запуск:
     node research/villager-fps-2026-11-01/tools/frame-cost.js
     node research/villager-fps-2026-11-01/tools/frame-cost.js --dpr 2 --size 192 --zoom 40
     node research/villager-fps-2026-11-01/tools/frame-cost.js --counts 0,300,600 --frames 60
     node research/villager-fps-2026-11-01/tools/frame-cost.js --throttle 4

   Нужен Chrome (mapgen2/tools/chrome.js ищет его сам, CHROME_PATH главнее).
*/
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CHROME = require(path.join(REPO, 'mapgen2/tools/chrome.js'));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? def : process.argv[i + 1];
}
const COUNTS = String(arg('counts', '0,150,300,600,900')).split(',').map(Number);
const FRAMES = Number(arg('frames', 60));
const DPR = Number(arg('dpr', 1));
const SIZE = Number(arg('size', 192));
const ZOOM = String(arg('zoom', '40'));
const THROTTLE = Number(arg('throttle', 1));
const WINDOW = String(arg('window', '1440x900')).split('x').map(Number);
const PORT = 9900 + (process.pid % 90);
const PROFILE = path.join(require('os').tmpdir(), '4tox-framecost-' + process.pid);

const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + PROFILE, '--no-first-run', '--hide-scrollbars', 'about:blank'],
  { stdio: 'ignore', detached: true });
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => {
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {}
  process.exit(130);
}));

const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Наполнение мира жителями — общий кусок с fps-attribution.js. */
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
    await js(`window.__game.Play.start({ seed: 'frame-cost', size: ${SIZE} }); 1`);
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
      /* Один кадр ровно тем же путём, что rAF-цикл: tick, draw, hud. */
      frame(t) { P.tick(1 / 60); P.draw(t); window.__game.Hud.tick(1 / 60); },
      cost(fn, n) { const t0 = performance.now(); for (let i = 0; i < n; i++) fn(i); return (performance.now() - t0) / n; },
      per(fn) { const list = P.state.villagers, t0 = performance.now();
        for (let i = 0; i < list.length; i++) fn(list[i]);
        return (performance.now() - t0) * 1000 / list.length; },
      micro() {
        const list = P.state.villagers, z = r.cam.zoom, set = r.villagerSprites;
        const vb = r.villagerBox(list[0], z);
        const px = Math.max(1, Math.round(1.1 / (vb.dw / vb.spr.sw)));
        const clip = Math.round(vb.spr.ay * vb.spr.sh) + 1;
        const out = {};
        for (let warm = 0; warm < 3; warm++) {
          out.sprite = this.per((v) => window.Villagers.sprite(set, v));
          out.box = this.per((v) => r.villagerBox(v, z));
          out.color = this.per(() => r.teamColorFor(0, 0.9));
          out.edge = this.per(() => r.spriteEdge(vb.spr, 'rgba(74,144,217,0.9)', px, clip));
        }
        const t0 = performance.now();
        for (let k = 0; k < 20; k++) r.villagerOrder();
        out.order = (performance.now() - t0) / 20;
        const ctx = r.ctx;
        const draw = (withEdge) => {
          const t1 = performance.now();
          for (let k = 0; k < 20; k++) {
            for (let i = 0; i < list.length; i++) {
              const b = r.villagerBox(list[i], z);
              if (!b || b.dw < 3) continue;
              ctx.drawImage(b.spr.img, b.spr.sx, b.spr.sy, b.spr.sw, b.spr.sh, b.dx, b.dy, b.dw, b.dh);
              if (withEdge) r.drawSpriteOutline(ctx, b, 'rgba(74,144,217,0.9)', 1.1, Math.round(b.spr.ay * b.spr.sh) + 1);
            }
          }
          return (performance.now() - t1) * 1000 / (20 * list.length);
        };
        out.drawOnly = draw(false);
        out.drawEdge = draw(true);
        return out;
      },
      info() {
        return { villagers: P.state.villagers.length, buildings: P.state.buildings.length,
          objects: P.state.world.objects.length, world: P.state.world.width,
          zoom: Math.round(r.cam.zoom * 10) / 10, canvas: [r.canvas.width, r.canvas.height] };
      }
    };
    return 1;
  })()`);

  const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
  const info = await js('window.__probe.info()');
  console.log(`мир ${info.world} · кадр ${info.canvas.join('x')} пикселей (окно ${WINDOW.join('x')} css, dpr ${DPR})` +
    (THROTTLE > 1 ? ` · CPU ×${THROTTLE}` : '') + ` · зум ${ZOOM}`);

  console.log('\nжителей | кадр, мс');
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
    await sleep(200);
    const total = await js('window.__game.Play.state.villagers.length');
    const ms = await js(`window.__probe.cost(t => window.__probe.frame(t / 60), ${FRAMES})`);
    console.log('   ' + String(total).padStart(4) + '  | ' + f2(ms).padStart(7) +
      (ms > 16.7 ? `   (> 16.7 мс: это уже меньше 60 к/с)` : ''));
  }

  /* Разложение: та же цена, но с выключенной одной частью. Разница со строкой
     «всё» — вклад этой части (в замере одна часть за раз). */
  const total = await js('window.__game.Play.state.villagers.length');
  if (total > 50) {
    const CONFIGS = [
      ['без жителей в отрисовке',
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
    console.log(`\nразложение цены кадра на ${total} жителях (разница с «всё как есть»):`);
    const all = await js(`window.__probe.cost(t => window.__probe.frame(t / 60), ${FRAMES})`);
    console.log('   всё как есть'.padEnd(38) + f2(all).padStart(7) + ' мс');
    for (const [name, off, on] of CONFIGS) {
      await js(off); await sleep(150);
      const ms = await js(`window.__probe.cost(t => window.__probe.frame(t / 60), ${FRAMES})`);
      await js(on); await sleep(150);
      console.log('   ' + name.padEnd(35) + f2(ms).padStart(7) + ' мс   (' + (ms < all ? '−' : '+') + f2(Math.abs(all - ms)) + ')');
    }

    const m = await js('window.__probe.micro()');
    console.log('\nна одного жителя, который виден на экране (мкс):');
    console.log('   спрайт кадра (поиск)              ' + f2(m.sprite));
    console.log('   villagerBox (объект + опора)      ' + f2(m.box));
    console.log('   цвет команды (строка rgba)        ' + f2(m.color));
    console.log('   ключ кэша каймы (spriteEdge)      ' + f2(m.edge));
    console.log('   drawImage спрайта                 ' + f2(m.drawOnly));
    console.log('   спрайт + кайма (вторая отрисовка) ' + f2(m.drawEdge));
    console.log('   сортировка всего списка           ' + f2(m.order) + ' мс/кадр');
  }

  try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {}
  process.exit(0);
})().catch((e) => {
  console.error('замер не состоялся:', (e && e.message) || e);
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch (_) {}
  process.exit(1);
});
