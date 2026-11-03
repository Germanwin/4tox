/* render-identity.js — приёмка «отрисовка жителей не изменилась».

   Что проверяет. Рисует слой жителей ДВУМЯ способами в одной и той же
   странице и сверяет попиксельно:

     A. боевой путь — `Renderer.drawObjects` (то, чем игра рисует на экране);
     B. эталон — тот же порядок глубины, тот же спрайт и та же кайма, но
        собранные здесь, в приёмке, по спецификации: «жители рисуются в
        порядке x+y, стабильно при равном ключе, спрайт из Villagers.sprite,
        точка опоры из villagerBox, кайма drawSpriteOutline толщиной 1.1 px
        цвета teamColorFor(owner, 0.9), кайма обрезана по опоре».

   Обе картинки рисует один и тот же браузер в одном процессе, поэтому
   разница между платформами и видеокартами сюда не входит: сверяется именно
   поведение кода, а не рендерер Chrome. Тест падает, если после правки
   поменялись кадр спрайта, порядок, цвет, толщина каймы, точка опоры или
   размер.

   Зачем. Любая оптимизация отрисовки жителей обязана оставить кадр тем же.
   Кэш кадра, кэш цвета, другой порядок обхода — всё это ловится здесь, а не
   глазами.

   Запуск: node game/tools/tests/render-identity.js
   Код возврата 0 — кадры совпали побитово, 1 — нет (печатается, где и сколько).
*/
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CHROME = require(path.join(REPO, 'mapgen2/tools/chrome.js'));
const PORT = 9300 + (process.pid % 300);
const PROFILE = path.join(os.tmpdir(), '4tox-render-identity-' + process.pid);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml'
};

/* Страница открывается по http, а не по file://: холст с картинками атласа
   под file:// считается «чужим источником», и getImageData бросает
   SecurityError (mapgen2/README.md, раздел «Запуск»). */
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

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

(async () => {
  const { server, port: webPort } = await serve();
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE, '--no-first-run', '--hide-scrollbars',
    '--window-size=1440,900', 'about:blank'], { stdio: 'ignore', detached: true });
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
    await send('Page.navigate', { url: 'http://127.0.0.1:' + webPort + '/game/index.html' });
    const waitFor = async (expr, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try { if (await js(expr)) return true; } catch (e) {}
        await sleep(200);
      }
      return false;
    };
    if (!await waitFor('!!(window.__game && window.__game.Play)', 30000)) {
      check('страница игры загрузилась', false);
      return;
    }
    await sleep(1200);

    const btn = await js(`(() => { const el = document.querySelector('#btnPlay');
      const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btn.x, y: btn.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
    if (!await waitFor("window.__game.Play.state.mode === 'play'", 20000)) {
      check('партия началась', false);
      return;
    }
    await sleep(2000);

    const result = await js(`(() => {
      const P = window.__game.Play, r = P.renderer(), V = window.Villagers, B = window.Buildings;
      const st = P.state, w = st.world;

      /* Мир замораживаем: между двумя отрисовками не должно пройти ни шага. */
      P.state.running = false;
      for (const v of st.villagers) { v.flinch = 0; v.hidden = false; v.vanishT = 0; v.emergeT = 0; }

      /* Жители ставятся детерминированно: разные повороты, разные кадры
         анимации, разные владельцы, и одна ПАРА С РАВНЫМ КЛЮЧОМ x+y —
         ради проверки правила «при равной глубине порядок из списка». */
      const town = w.towns && w.towns[0], hall = town && town.townhall;
      const cx = hall ? hall.x + 1.5 : w.width / 2;
      const cy = hall ? hall.y + 2 : w.height / 2;
      const base = 91000;
      const rots = [0, 45, 90, 135, 180, 225, 270, 315];
      const anims = ['idle', 'walk', 'work', 'carry'];
      const made = [];
      for (let i = 0; i < 24; i++) {
        const col = i % 6, row = Math.floor(i / 6);
        const x = cx - 3 + col * 1.25 + (i % 3) * 0.09;
        const y = cy - 2 + row * 1.1 + (i % 4) * 0.07;
        const v = V.blank(w, { id: base + i, index: base + i, rngKey: base + i,
          x: x, y: y, owner: i % 2, town: i % 2, avoid: [], buildings: st.buildings });
        v.state = 'wander'; v.path = null; v.anchor = { x: x, y: y }; v.avoid = [];
        v.rot = rots[i % rots.length];
        v.anim = anims[i % anims.length];
        v.phase = ((i * 7) % 13) / 13;
        v.flinch = 0;
        made.push(v);
      }
      /* Часть — воины: у них ДРУГОЙ атлас (броня) и своя кайма. Проверка
         обязана видеть и его, иначе правка в villagerSet/кадре воина пройдёт
         мимо неё. Лагерь ставим как игрок: findSpot + settle. */
      let warcamp = st.buildings.find((x) => B.typeOf(x) === 'warcamp');
      if (!warcamp) {
        const spot = B.findSpot(w, st.buildings, 'x', B.FACE_ROT, { type: 'warcamp', minSep: 0 });
        if (spot) { B.settle(w, spot, { clear: true }); st.buildings.push(spot); warcamp = spot; }
      }
      for (let i = 0; i < made.length; i += 3) {
        made[i].warrior = true;
        made[i].warcamp = warcamp;
        made[i].state = 'patrol';
      }
      const warriorsN = made.filter((v) => v.warrior).length;

      /* Пара с РАВНЫМ ключом: у обоих x+y одинаково. */
      const a = made[0], b = made[1];
      a.x = cx; a.y = cy;
      b.x = cx + 0.5; b.y = cy - 0.5;
      st.villagers = made;
      w._villagers = made;
      r.setVillagers(made);

      /* Камера — на них, без подлёта. */
      r.cam.zoom = 40; r.cam.x = cx; r.cam.y = cy; r.clampCamera();
      r.time = 0;

      const W = r.canvas.width, H = r.canvas.height;
      /* Холст повторяет кадр игры: тот же dpr и тот же сдвиг начала координат в
         центр, иначе sx/sy (они в CSS-пикселях от центра) уведут картинку в
         угол и половина её обрежется краем. */
      const mk = () => {
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, W, H);
        g.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
        g.translate(r.cssW / 2, r.cssH / 2);
        return { c, g };
      };

      /* --- A. боевой путь: только жители (деревья, дома и мелочь выключены) --- */
      const keep = { trees: r.showTrees, blds: r.showBuildings, small: r.showSmall, rocks: r.showRocks };
      r.showTrees = false; r.showBuildings = false; r.showSmall = false; r.showRocks = false;
      const A = mk();
      r.drawObjects(A.g);
      r.showTrees = keep.trees; r.showBuildings = keep.blds;
      r.showSmall = keep.small; r.showRocks = keep.rocks;

      /* --- B. эталон по спецификации --- */
      const Bc = mk();
      const z = r.cam.zoom;
      const box = r.viewTiles(r.naturePad());
      const order = made.slice().sort((p, q) => (p.x + p.y) - (q.x + q.y));
      for (const v of order) {
        if (v.x < box.x0 || v.x > box.x1 || v.y < box.y0 || v.y > box.y1) continue;
        const vis = V.visibility(v);
        if (vis <= 0) continue;
        const vb = r.villagerBox(v, z);
        if (!vb || vb.dw < 3) continue;
        const clip = Math.round(vb.spr.ay * vb.spr.sh) + 1;
        Bc.g.drawImage(vb.spr.img, vb.spr.sx, vb.spr.sy, vb.spr.sw, vb.spr.sh,
          vb.dx, vb.dy, vb.dw, vb.dh);
        r.drawSpriteOutline(Bc.g, vb, r.teamColorFor(v.owner, 0.9), 1.1, clip);
      }

      const pa = A.g.getImageData(0, 0, W, H).data;
      const pb = Bc.g.getImageData(0, 0, W, H).data;
      let diff = 0, maxd = 0, painted = 0, first = -1;
      let paintedB = 0, bbA = [1e9, 1e9, -1, -1], bbB = [1e9, 1e9, -1, -1];
      for (let i = 0; i < pa.length; i += 4) {
        const px = (i / 4) % W, py = Math.floor((i / 4) / W);
        if (pa[i + 3] || pa[i] || pa[i + 1] || pa[i + 2]) {
          painted++;
          if (px < bbA[0]) bbA[0] = px; if (py < bbA[1]) bbA[1] = py;
          if (px > bbA[2]) bbA[2] = px; if (py > bbA[3]) bbA[3] = py;
        }
        if (pb[i + 3] || pb[i] || pb[i + 1] || pb[i + 2]) {
          paintedB++;
          if (px < bbB[0]) bbB[0] = px; if (py < bbB[1]) bbB[1] = py;
          if (px > bbB[2]) bbB[2] = px; if (py > bbB[3]) bbB[3] = py;
        }
        const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]),
          Math.abs(pa[i + 2] - pb[i + 2]), Math.abs(pa[i + 3] - pb[i + 3]));
        if (d) { diff++; if (first < 0) first = i / 4; if (d > maxd) maxd = d; }
      }
      return { diff, maxd, painted, paintedB, bbA, bbB, pixels: pa.length / 4, first,
        villagers: made.length, warriors: warriorsN,
        knightSet: !!(r.knightSprites && made.some((v) => r.villagerSet(v) === r.knightSprites)),
        canvas: [W, H] };
    })()`);

    const pct = (100 * result.diff / result.pixels).toFixed(4);
    check('в кадре есть воины со своим атласом', result.warriors > 0 && result.knightSet,
      result.warriors + ' воинов, атлас брони: ' + (result.knightSet ? 'да' : 'НЕТ'));
    check('слой жителей нарисован (кадр не пустой)', result.painted > 500,
      result.painted + ' непрозрачных пикселей из ' + result.pixels);
    check('отрисовка жителей совпала с эталоном побитово', result.diff === 0,
      result.diff + ' отличий (' + pct + '% кадра), макс. дельта ' + result.maxd +
      (result.first >= 0 ? ', первый в пикселе ' + result.first : '') +
      ' · A: ' + result.painted + ' px ' + JSON.stringify(result.bbA) +
      ' · B: ' + result.paintedB + ' px ' + JSON.stringify(result.bbB));
    check('исключений в странице нет', errors.length === 0, errors.slice(0, 3).join(' | '));

    console.log(fails ? '\nприёмка не пройдена' : '\nприёмка пройдена: кадр жителей тот же');
  } finally {
    kill();
  }
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('приёмка не отработала:', (e && e.message) || e);
  process.exit(1);
});
