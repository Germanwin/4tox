/* shot.js — «до / после» на ОДНОМ сиде и одном кадре: сначала старый
   художник выгоревшего пятна (код удалённого Renderer.bakeRubble, наложен на
   запечённый участок), потом новый — просто дерн.

   Запуск: node experiments/ruins-ground/shot.js [before.png] [after.png]
   Нужен Chrome; кадры по умолчанию кладутся рядом с этим файлом. */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = 'file://' + path.join(REPO, 'mapgen2', 'index.html') + '?seed=rivet-42';
const outBefore = process.argv[2] || path.join(__dirname, 'before.png');
const outAfter = process.argv[3] || path.join(__dirname, 'after.png');
const PORT = 9750 + (process.pid % 90);
const PROFILE = '/tmp/dsh-ruincmp-' + process.pid;

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--allow-file-access-from-files', '--hide-scrollbars',
  '--window-size=1280,900', 'about:blank'
], { stdio: 'ignore', detached: true });
function killChrome() { try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) {} }
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { killChrome(); process.exit(130); }));

const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});

(async () => {
  for (let i = 0; i < 100; i++) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`); break; }
    catch (e) { await new Promise(r => setTimeout(r, 150)); }
  }
  const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));

  let id = 1; const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  const send = (method, params) => new Promise(r => {
    const i = id++; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const js = async (expr) => {
    const res = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return res.result.value;
  };
  const shoot = async (file) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 4000));

  var info = await js(`(async () => {
    const g = window.__mapgen, B = window.Buildings, R = g.renderer;
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('нет atlas.png'));
      im.src = 'assets/ruins/atlas.png';
    });
    R.setRuins(img, window.RUINS_ATLAS);
    const list = g.getBuildings();
    list.forEach(b => B.ruin(g.getWorld(), b, { villagers: g.getVillagers() }));
    R.setBuildings(list);
    let x = 0, y = 0;
    list.forEach(b => { const f = B.footprint(b.rot, b.type); x += b.x + f.w / 2; y += b.y + f.h / 2; });
    x /= list.length; y /= list.length;
    R.cam.zoom = 90; R.cam.x = x; R.cam.y = y;

    // --- СТАРЫЙ художник выгоревшего пятна: код удалённого bakeRubble -----
    const PLOT_BAKE = 128, PLOT_APRON = 0.42, PLOT_CORE = 0.10;
    function burn(ctx, b, r, ox, oy) {
      var BAKE = PLOT_BAKE;
      var cw = ctx.canvas.width, ch = ctx.canvas.height;
      var u0 = r.x0 - PLOT_APRON, v0 = r.y0 - PLOT_APRON;
      var u1 = r.x1 + PLOT_APRON, v1 = r.y1 + PLOT_APRON;
      var cu0 = r.x0 - PLOT_CORE, cv0 = r.y0 - PLOT_CORE;
      var cu1 = r.x1 + PLOT_CORE, cv1 = r.y1 + PLOT_CORE;
      var i, u, v, x, y;
      function X(uu, vv) { return (uu - vv) * BAKE * 0.5 - ox; }
      function Y(uu, vv) { return (uu + vv) * BAKE * 0.25 - oy; }
      function rectPath(x0, y0, x1, y1) {
        ctx.beginPath();
        ctx.moveTo(X(x0, y0), Y(x0, y0));
        ctx.lineTo(X(x1, y0), Y(x1, y0));
        ctx.lineTo(X(x1, y1), Y(x1, y1));
        ctx.lineTo(X(x0, y1), Y(x0, y1));
        ctx.closePath();
      }
      var seed = (Math.imul(b.x | 0, 374761393) ^
        Math.imul(b.y | 0, 668265263) ^ 0x9e3779b9) >>> 0;
      if (!seed) seed = 0x1b873593;
      var rs = seed;
      function rnd() {
        rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0;
        return rs / 4294967296;
      }
      ctx.save();
      rectPath(u0, v0, u1, v1);
      ctx.clip();
      ctx.fillStyle = 'rgba(42,34,24,0.84)';
      ctx.fillRect(0, 0, cw, ch);
      var coals = Math.round((r.x1 - r.x0) * (r.y1 - r.y0) * 90);
      for (i = 0; i < coals; i++) {
        u = u0 + rnd() * (u1 - u0);
        v = v0 + rnd() * (v1 - v0);
        x = X(u, v); y = Y(u, v);
        ctx.fillStyle = rnd() < 0.30
          ? 'rgba(150,136,114,' + (0.10 + rnd() * 0.16) + ')'
          : 'rgba(16,12,9,' + (0.12 + rnd() * 0.22) + ')';
        ctx.fillRect(x, y, 1 + rnd() * 2, 1 + rnd() * 1.8);
      }
      ctx.restore();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      var midU = (u0 + u1) * 0.5, midV = (v0 + v1) * 0.5;
      function fade(x0, y0, x1, y1, ax, ay, bx, by) {
        ctx.save();
        rectPath(x0, y0, x1, y1);
        ctx.clip();
        var lg = ctx.createLinearGradient(X(ax, ay), Y(ax, ay), X(bx, by), Y(bx, by));
        for (var fi = 0; fi <= 6; fi++) {
          var ft = fi / 6, fa = ft * ft * (3 - 2 * ft);
          lg.addColorStop(ft, 'rgba(0,0,0,' + fa + ')');
        }
        ctx.fillStyle = lg;
        ctx.fillRect(0, 0, cw, ch);
        ctx.restore();
      }
      fade(u0, v0, cu0, v1, cu0, midV, u0, midV);
      fade(cu1, v0, u1, v1, cu1, midV, u1, midV);
      fade(u0, v0, u1, cv0, midU, cv0, midU, v0);
      fade(u0, cv1, u1, v1, midU, cv1, midU, v1);
      ctx.restore();
    }
    // Готовим «старый» кадр: честный дерн, поверх — выгоревшее пятно, и
    // участок под завалом снова рисуется (сейчас paintPlot его пропускает).
    R.buildings.forEach(b => {
      b._plotLayer = null;
      const rr = R.plotRect(b);
      const layer = R.plotLayer(b);
      if (b.rubble && layer) burn(layer.canvas.getContext('2d'), b, rr, layer.ox, layer.oy);
    });
    const proto = window.Render.Renderer.prototype;
    const paintPlot = proto.paintPlot;
    window.__paintPlotBak = paintPlot;
    proto.paintPlot = function (ctx, b, st, ghost) {
      if (b && b.rubble && !ghost && b._plotLayer) {
        const layer = b._plotLayer, s = st.px / 128;
        ctx.drawImage(layer.canvas,
          st.off.x + layer.ox * s, st.off.y + layer.oy * s,
          layer.canvas.width * s, layer.canvas.height * s);
        return;
      }
      return paintPlot.apply(this, arguments);
    };
    R.render(1);
    return { n: list.length, zoom: R.cam.zoom, cam: [x, y] };
  })()`);
  console.log(JSON.stringify(info));
  await shoot(outBefore);
  console.log('before', outBefore);

  await js(`(() => {
    const g = window.__mapgen, R = g.renderer;
    window.Render.Renderer.prototype.paintPlot = window.__paintPlotBak;
    R.buildings.forEach(b => { b._plotLayer = null; });
    R.render(1);
    return 1;
  })()`);
  await shoot(outAfter);
  console.log('after', outAfter);
  killChrome();
  process.exit(0);
})().catch(e => { console.error(e); killChrome(); process.exit(1); });
