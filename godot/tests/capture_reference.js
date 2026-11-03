/* capture_reference.js — эталонные кадры из НАСТОЯЩЕЙ браузерной игры.

   Зачем: пиксельный гейт M1 должен сверять Godot с браузером, а не с второй
   реализацией. Скрипт открывает game/index.html, запускает одиночную партию
   на фиксированном сиде, замораживает мир и снимает кадры на трёх зумах.

   Сцена нарочно без построек и жителей: сначала проверяется земля и природа
   (кэш местности, глубина, песок, спрайты), а не HUD и правила.

   Результат: tests/fixtures/scene.json + ref_z24/z40/z64.png.

   Запуск: node godot/tests/capture_reference.js */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = process.env.TOX_OUT
  ? path.resolve(process.env.TOX_OUT)
  : path.join(__dirname, 'fixtures');
const CHROME = require(path.join(REPO, 'mapgen2/tools/chrome.js'));
const PORT = 9500 + (process.pid % 300);
const PROFILE = path.join(os.tmpdir(), '4tox-ref-' + process.pid);
let SEED = 'каменная-заводь-946';
let SIZE = 192;
let HASH = 'af3a0bff';
const ZOOMS = [24, 40, 64];
const CSS_W = 1440;
const CSS_H = 900;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  try {
    const wj = JSON.parse(fs.readFileSync(path.join(OUT, 'world.json'), 'utf8'));
    SEED = wj.seed;
    SIZE = wj.size;
    HASH = wj.worldgenHash;
  } catch (e) { /* останутся значения по умолчанию */ }
  const { server, port: webPort } = await serve();
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE, '--no-first-run', '--hide-scrollbars',
    '--window-size=' + CSS_W + ',' + CSS_H, 'about:blank'], { stdio: 'ignore', detached: true });
  const kill = () => {
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {}
    try { server.close(); } catch (e) {}
  };
  ['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => { kill(); process.exit(130); }));

  try {
    for (let i = 0; i < 120; i++) {
      try { await getJSON('http://127.0.0.1:' + PORT + '/json/version'); break; }
      catch (e) { await sleep(150); }
    }
    const list = await getJSON('http://127.0.0.1:' + PORT + '/json/list');
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 1; const pending = new Map(); const errors = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.error ? { __cdpError: m.error } : m.result); pending.delete(m.id); }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push(d.exception ? d.exception.description : d.text);
      }
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
      width: CSS_W, height: CSS_H, deviceScaleFactor: 1, mobile: false
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
    await js('window.__game.start(' + JSON.stringify(SEED) + ', ' + SIZE + ', {mode:"solo"}); true');
    if (!await waitFor("window.__game.Play.state.mode === 'play'", 30000)) throw new Error('партия не началась');
    await sleep(1500);

    const info = await js(`(() => {
      const P = window.__game.Play, st = P.state, w = st.world, r = P.renderer();
      if (window.WorldGen.hashWorld(w) !== ${JSON.stringify(HASH)}) {
        return { error: 'мир не тот: ' + window.WorldGen.hashWorld(w) };
      }
      /* Мир стоит, кадр не перерисовывается сам: эталон обязан быть один и
         тот же при повторном запуске, включая время волн и анимаций. */
      st.running = false;
      P.draw = function () {};
      document.getElementById('hud').classList.add('hidden');
      document.getElementById('toasts').innerHTML = '';
      if (window.Menu) Menu.leave();
      r.setBuildings([], { minimap: false });
      r.setVillagers([]);
      const hall = st.buildings.find((b) => window.Buildings.typeOf(b) === 'townhall') || st.buildings[0];
      return {
        seed: w.seed, size: w.islandSize, hash: window.WorldGen.hashWorld(w),
        cssW: r.cssW, cssH: r.cssH, dpr: r.dpr,
        hall: hall ? { x: hall.x, y: hall.y } : { x: w.width / 2, y: w.height / 2 },
        objects: w.objects.length,
        /* Мир после расстановки деревни: 8 кустов под пятнами уже смяты.
           Рендер обязан рисовать ровно этот список, иначе дифф поймает
           разницу не в рендере, а в том, что Godot взял мир до расчистки. */
        objectList: w.objects.map((o) => ({
          kind: o.kind, variant: o.variant === undefined ? null : o.variant,
          x: o.x, y: o.y, scale: o.scale, phase: o.phase, id: o.id
        }))
      };
    })()`);
    if (info.error) throw new Error(info.error);

    const cx = info.hall.x + 2;
    const cy = info.hall.y + 1.5;
    const shots = [];
    for (const zoom of ZOOMS) {
      const cam = await js(`(() => {
        const r = window.__game.Play.renderer();
        r.cam.zoom = ${zoom}; r.cam.x = ${cx}; r.cam.y = ${cy};
        r.clampCamera();
        r.render(0);
        return { x: r.cam.x, y: r.cam.y, zoom: r.cam.zoom, cachePx: r.cachePx,
          offset: { x: r.cacheOffset.x, y: r.cacheOffset.y },
          canvas: { w: r.canvas.width, h: r.canvas.height } };
      })()`);
      await sleep(80);
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const png = Buffer.from(shot.data, 'base64');
      const name = 'ref_z' + zoom + '.png';
      fs.writeFileSync(path.join(OUT, name), png);
      shots.push({ file: name, cam });
      console.log(name + ': ' + png.length + ' Б, cam ' + JSON.stringify(cam));

      /* Только земля: первый дифф меряет кэш местности, а не спрайты. */
      const saved = await js(`(() => { const r = window.__game.Play.renderer();
        const s = { trees: r.showTrees, rocks: r.showRocks, small: r.showSmall };
        r.showTrees = false; r.showRocks = false; r.showSmall = false;
        r.render(0); return s; })()`);
      await sleep(80);
      const gshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const gpng = Buffer.from(gshot.data, 'base64');
      const gname = 'ref_ground_z' + zoom + '.png';
      fs.writeFileSync(path.join(OUT, gname), gpng);
      shots.push({ file: gname, cam, ground: true });
      console.log(gname + ': ' + gpng.length + ' Б');
      await js(`(() => { const r = window.__game.Play.renderer();
        r.showTrees = ${saved.trees}; r.showRocks = ${saved.rocks}; r.showSmall = ${saved.small};
        r.render(0); return true; })()`);

      /* Постройки без природы и жителей: сначала проверяются их масштаб,
         точка опоры и кайма, а не слияние слоёв. Газон участка уже в кадре:
         он лежит в том же запечённом слое, что и в игре. */
      await js(`(() => { const P = window.__game.Play, r = P.renderer();
        r.showTrees = false; r.showRocks = false; r.showSmall = false;
        r.setBuildings(P.state.buildings, { minimap: false });
        r.setVillagers([]);
        r.render(0); return true; })()`);
      const bshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const bpng = Buffer.from(bshot.data, 'base64');
      const bname = 'ref_build_z' + zoom + '.png';
      fs.writeFileSync(path.join(OUT, bname), bpng);
      shots.push({ file: bname, cam, buildings: true });
      console.log(bname + ': ' + bpng.length + ' Б');

      /* Газон участка: тот же кадр ещё раз, отдельным именем — по нему
         меряется слой газона сам по себе (ref_plot_z*). */
      const plotDbg = await js(`(() => { const r = window.__game.Play.renderer();
        r.render(0);
        return { layers: r.buildings.map((b) => !!b._plotLayer) }; })()`);
      console.log('  plot debug: ' + JSON.stringify(plotDbg));
      await sleep(250);
      const pshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const ppng = Buffer.from(pshot.data, 'base64');
      const pname = 'ref_plot_z' + zoom + '.png';
      fs.writeFileSync(path.join(OUT, pname), ppng);
      shots.push({ file: pname, cam, plots: true });
      console.log(pname + ': ' + ppng.length + ' Б');
      await js(`(() => { const r = window.__game.Play.renderer();
        r.setBuildings([], { minimap: false });
        r.render(0); return true; })()`);

      /* Жители без построек и природы: проверяются кадр анимации, поворот,
         точка опоры и кайма 1.1 px с обрезкой по тени. */
      await js(`(() => { const P = window.__game.Play, r = P.renderer();
        r.showTrees = false; r.showRocks = false; r.showSmall = false;
        r.setBuildings([], { minimap: false });
        r.setVillagers(P.state.villagers);
        r.render(0); return true; })()`);
      await sleep(80);
      const vshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const vpng = Buffer.from(vshot.data, 'base64');
      const vname = 'ref_vill_z' + zoom + '.png';
      fs.writeFileSync(path.join(OUT, vname), vpng);
      shots.push({ file: vname, cam, villagers: true });
      console.log(vname + ': ' + vpng.length + ' Б');

      /* Общий кадр: природа, постройки, газон и жители вместе — проверяется
         слияние по глубине (x+y), а не каждый слой отдельно. */
      await js(`(() => { const P = window.__game.Play, r = P.renderer();
        r.showTrees = ${saved.trees}; r.showRocks = ${saved.rocks}; r.showSmall = ${saved.small};
        r.setBuildings(P.state.buildings, { minimap: false });
        r.setVillagers(P.state.villagers);
        r.render(0); return true; })()`);
      await sleep(80);
      const fshot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const fpng = Buffer.from(fshot.data, 'base64');
      const fname = 'ref_full_z' + zoom + '.png';
      fs.writeFileSync(path.join(OUT, fname), fpng);
      shots.push({ file: fname, cam, full: true });
      console.log(fname + ': ' + fpng.length + ' Б');

/* Следующий зум обязан начать с чистого листа. */
      await js(`(() => { const r = window.__game.Play.renderer();
        r.setVillagers([]);
        r.setBuildings([], { minimap: false });
        r.render(0); return true; })()`);
    }

    fs.writeFileSync(path.join(OUT, 'scene.json'), JSON.stringify({
      format: '4tox-reference-scene', version: 1,
      seed: info.seed, size: info.size, worldgenHash: info.hash,
      cssW: info.cssW, cssH: info.cssH, dpr: info.dpr,
      objects: info.objects, shots
    }, null, 1));
    fs.writeFileSync(path.join(OUT, 'scene_objects.json'), JSON.stringify({
      seed: info.seed, size: info.size, objects: info.objectList
    }));
    const buildings = await js(`(() => window.__game.Play.state.buildings.map((b) => ({
      id: b.id, type: b.type || 'townhall', variant: b.variant || 'a',
      rot: b.rot || 0, x: b.x, y: b.y, owner: b.owner === undefined ? 0 : b.owner,
      rubble: !!b.rubble
    })))()`);
    fs.writeFileSync(path.join(OUT, 'scene_buildings.json'), JSON.stringify({
      seed: info.seed, size: info.size, buildings
    }));
    const villagers = await js(`(() => window.__game.Play.state.villagers.map((v) => ({
      id: v.id, x: v.x, y: v.y, rot: v.rot || 0, anim: v.anim || 'idle',
      phase: v.phase || 0, owner: v.owner === undefined ? 0 : v.owner,
      town: v.town === undefined ? 0 : v.town, warrior: !!v.warrior,
      hidden: !!v.hidden, vanishT: v.vanishT || 0, emergeT: v.emergeT || 0,
      appearT: typeof v.appearT === 'number' ? v.appearT : 1
    })))()`);
    fs.writeFileSync(path.join(OUT, 'scene_villagers.json'), JSON.stringify({
      seed: info.seed, size: info.size, villagers
    }));
    console.log('scene.json: ' + info.seed + ' ' + info.size + ', ' + info.objects + ' объектов');
    if (errors.length) console.log('ошибки страницы: ' + errors.slice(0, 3).join(' | '));
  } finally {
    kill();
  }
})().catch((e) => {
  console.error('ошибка: ' + (e && e.message || e));
  process.exitCode = 1;
});
