/* warriors-cost.js — сколько стоит КАДР, когда часть жителей становится
   воинами. Отвечает на вопрос «100 воинов при 600 жителях — почему просадка».

   Мерится по частям, чтобы было видно, где именно:
     tick  — шаг мира (в нём Combat.tick: выбор цели, удары, поводки);
     draw  — отрисовка (у воина свой атлас, своя кайма, растворение);
     hud   — панели (в том числе «Войска», если открыта).

   Запуск: node research/villager-fps-2026-11-01/tools/warriors-cost.js
           [--villagers 600] [--warriors 0,25,50,100] [--dpr 2] [--zoom 40]
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
const VILLAGERS = Number(arg('villagers', 600));
const WARRIORS = String(arg('warriors', '0,25,50,100')).split(',').map(Number);
const DPR = Number(arg('dpr', 2));
const ZOOM = Number(arg('zoom', 40));
const SIZE = Number(arg('size', 192));
const FRAMES = Number(arg('frames', 40));
const PORT = 9100 + (process.pid % 200);
const PROFILE = path.join(os.tmpdir(), '4tox-warriors-' + process.pid);

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
    if (SIZE !== 96) { await js(`window.__game.Play.start({ seed: 'warriors', size: ${SIZE} }); 1`); await sleep(2500); }

    const FILL = fs.readFileSync(path.join(__dirname, 'fill.js'), 'utf8');
    const info = await js(`(() => {
      ${FILL}
      fill(${VILLAGERS});
      const P = window.__game.Play, st = P.state, r = P.renderer(), w = st.world;
      const B = window.Buildings;
      const t = st.buildings[0];
      r.cam.zoom = ${ZOOM}; r.cam.x = t.x + 1.5; r.cam.y = t.y + 2; r.clampCamera();
      /* Военного лагеря на старте нет (правило 2026-10-23) — ставим его так же,
         как это делает игрок и приёмка menu.js: findSpot + settle. Без лагеря
         воин с state='patrol' не имеет куда идти и начинает искать путь каждый
         кадр: замер показывал не цену воина, а цену потерянного воина. */
      function ensureCamp(type) {
        let b = st.buildings.find((x) => B.typeOf(x) === type);
        if (b) return b;
        const spot = B.findSpot(w, st.buildings, 'x', B.FACE_ROT, { type: type, minSep: 0 });
        if (!spot) return null;
        B.settle(w, spot, { clear: true });
        st.buildings.push(spot);
        r.setBuildings(st.buildings);
        return spot;
      }
      ensureCamp('barracks');
      const camp = ensureCamp('warcamp');
      window.__w = {
        r: r, P: P, B: B, camp: camp,
        /* Включить ровно n воинов: первые n жителей деревни. Флаг тот же,
           которым пользуется игра (v.warrior), лагерь — настоящий, если он
           есть в деревне. */
        arm(n) {
          const list = P.state.villagers;
          const c = this.camp;
          /* Воины ставятся в кольцо СВОЕГО лагеря — там, где они и стоят в
             жизни, а не в общем кольце вокруг ратуши. */
          const ring = (c && this.B.patrolCells) ? this.B.patrolCells(c) : null;
          let k = 0;
          for (let i = 0; i < list.length; i++) {
            const v = list[i];
            const on = i < n;
            v.warrior = on;
            v.warcamp = on ? (c || null) : null;
            v.trainee = false;
            if (on) {
              if (ring && ring.length) {
                const cell = ring[k % ring.length];
                v.x = cell.x + 0.5; v.y = cell.y + 0.5;
              }
              k++;
              v.state = 'patrol'; v.anim = 'idle'; v.path = null; v._planClock = 0;
            } else if (v.state === 'patrol') {
              v.state = 'wander'; v.path = null;
            }
          }
          return list.filter((v) => v.warrior).length;
        },
        cost(fn, n) { const t0 = performance.now(); for (let i = 0; i < n; i++) fn(i); return (performance.now() - t0) / n; },
        tickMs(n) { return this.cost((i) => this.P.tick(1 / 60), n); },
        drawMs(n) { return this.cost((i) => this.P.draw(i / 60), n); },
        hudMs(n) { return this.cost(() => window.__game.Hud.tick(1 / 60), n); },
        frameMs(n) { return this.cost((i) => { this.P.tick(1 / 60); this.P.draw(i / 60); window.__game.Hud.tick(1 / 60); }, n); },
        /* Тренировка: ровно то, что делает игрок кнопкой «Тренировать». */
        train(n) {
          const S = window.Session, P = this.P;
          const bar = P.state.buildings.find((b) => this.B.typeOf(b) === 'barracks');
          if (!bar) return -1;
          let made = 0;
          for (const v of P.state.villagers) {
            if (made >= n) break;
            if (v.trainee || v.warrior || v.employer) continue;
            const r = S.train(bar, v, P.state.villagers, P.state.buildings);
            if (r && r.ok) made++;
          }
          return made;
        },
        /* Покадровый замер: tick и draw по отдельности, чтобы видеть хвост. */
        sample(ms) {
          const out = { tick: [], draw: [], frame: [] };
          const t0 = performance.now();
          let i = 0;
          while (performance.now() - t0 < ms) {
            const a = performance.now();
            this.P.tick(1 / 60);
            const b = performance.now();
            this.P.draw(i / 60);
            const c = performance.now();
            window.__game.Hud.tick(1 / 60);
            const d = performance.now();
            out.tick.push(b - a); out.draw.push(c - b); out.frame.push(d - a);
            i++;
          }
          return out;
        },
        info() {
          const st = this.P.state;
          return { villagers: st.villagers.length,
            warriors: st.villagers.filter((v) => v.warrior).length,
            buildings: st.buildings.length,
            types: st.buildings.map((b) => this.B.typeOf(b)).join(','),
            camp: !!this.camp };
        }
      };
      return window.__w.info();
    })()`);

    const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
    console.log(`жителей ${info.villagers} · построек ${info.buildings} (${info.types}) · лагерь ${info.camp ? 'есть' : 'НЕТ'}` +
      ` · зум ${ZOOM} · dpr ${DPR}`);
    console.log('\nвоинов | тик мира | отрисовка | HUD | кадр целиком');
    let prev = 0;
    for (const n of WARRIORS) {
      await js(`window.__w.arm(${n})`);
      await sleep(600);
      const armed = await js(`window.__w.info()`);
      const tick = await js(`window.__w.tickMs(${FRAMES})`);
      const draw = await js(`window.__w.drawMs(${FRAMES})`);
      const hud = await js(`window.__w.hudMs(20)`);
      const frame = await js(`window.__w.frameMs(${FRAMES})`);
      console.log('   ' + String(armed.warriors).padStart(4) + '  | ' + f2(tick).padStart(8) + ' | ' +
        f2(draw).padStart(9) + ' | ' + f2(hud).padStart(5) + ' | ' + f2(frame).padStart(7) +
        (n ? '   (к прошлой строке: ' + (tick >= prev ? '+' : '') + f2(tick - prev) + ' мс тика)' : ''));
      prev = tick;
    }

    /* --- тренировка: тот самый момент «начал тренировать» --- */
    const TRAIN = Number(arg('train', 100));
    if (TRAIN > 0) {
      const made = await js(`window.__w.train(${TRAIN})`);
      const phases = [];
      for (let k = 0; k < 6; k++) {
        const smp = await js(`window.__w.sample(1000)`);
        const stat = (a) => {
          const s = a.slice().sort((x, y) => x - y);
          return { p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
        };
        phases.push({ sec: k + 1, tick: stat(smp.tick), draw: stat(smp.draw), frame: stat(smp.frame),
          warriors: await js(`window.__w.info().warriors`),
          trainees: await js(`window.__game.Play.state.villagers.filter(v => v.trainee).length`) });
      }
      console.log(`\nтренировка ${made} жителей — по секундам (мс):`);
      console.log('   сек | воинов | учеников | tick p50/p95/max | draw p50/p95/max | кадр p95');
      for (const ph of phases) {
        console.log('   ' + String(ph.sec).padStart(3) + ' | ' + String(ph.warriors).padStart(6) + ' | ' +
          String(ph.trainees).padStart(8) + ' | ' +
          f2(ph.tick.p50) + '/' + f2(ph.tick.p95) + '/' + f2(ph.tick.max) + ' | ' +
          f2(ph.draw.p50) + '/' + f2(ph.draw.p95) + '/' + f2(ph.draw.max) + ' | ' + f2(ph.frame.p95));
      }
    }

    /* --- где именно время: профиль на последнем числе воинов --- */
    await js(`window.__w.arm(${WARRIORS[WARRIORS.length - 1]})`);
    await sleep(500);
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: 100 });
    await send('Profiler.start');
    await js(`new Promise(res => { const t0 = performance.now();
      function step(t) { window.__w.P.tick(1 / 60); window.__w.P.draw(t / 1000); window.__game.Hud.tick(1 / 60);
        if (t - t0 < 2000) requestAnimationFrame(step); else res(1); }
      requestAnimationFrame(step); })`);
    const prof = await send('Profiler.stop');
    const nodes = new Map();
    for (const nd of prof.profile.nodes) nodes.set(nd.id, nd);
    const self = new Map();
    const dts = prof.profile.timeDeltas, samples = prof.profile.samples;
    let totalT = 0;
    for (let i = 0; i < samples.length; i++) {
      const d = dts[i] || 0; totalT += d;
      const nd = nodes.get(samples[i]);
      if (!nd) continue;
      const cf = nd.callFrame || {};
      const name = (cf.functionName || '(аноним)') + ' @ ' + String(cf.url || '').split('/').pop() + ':' + (cf.lineNumber + 1);
      self.set(name, (self.get(name) || 0) + d);
    }
    console.log('\nгде время (2 с с ' + WARRIORS[WARRIORS.length - 1] + ' воинами):');
    for (const [name, d] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)) {
      console.log('  ' + f2(d / 1000).padStart(9) + ' мс  ' + f2(100 * d / totalT).padStart(6) + '%  ' + name);
    }
  } finally {
    kill();
  }
  process.exit(0);
})().catch((e) => {
  console.error('замер не состоялся:', (e && e.message) || e);
  process.exit(1);
});
