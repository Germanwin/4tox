/* ground.js — приёмка земли: участки вокруг построек и песок (BIG-PLAN, P2).

   Требования заказчика:
     1) трава-участок вокруг КАЖДОЙ постройки: плоский, до границы пятна с
        отступом 0.10–0.14 клетки, низкая трава по всей площади и плотнее по
        периметру, без ВЫСОКИХ спрайтов внутри; военный лагерь — на всех
        5 x 5, хотя модель 2 x 2 по центру; у призрака под курсором участок
        полупрозрачный, зелёный/красный;
     8) песок без уродливой обводки: нет штриха rgba(150,124,78,0.5) по
        ромбам, кромка — дизеринг, ширина пляжа одна на все карты.

   Что проверяется и как:
     * три сида на трёх размерах карты (64, 96, 128) — ширина пляжа не
       должна зависеть от размера;
     * два зума на сид: общий (остров целиком) и близкий (деревня и берег),
       кадры лежат в tools/out/ground/;
     * участок у каждой постройки: в кадре у каждого из четырёх углов участка
       есть зелёный пиксель, которого НЕТ в том же кадре с выключенным слоем
       участков. Второй кадр — не «фон травы на глаз», а тот же мир без
       участков: разница может быть только от слоя;
     * участок лежит ДО спрайтов: порядок вызовов drawPlots -> drawObjects
       ловится обёрткой, а не глазами; в eachSprite участок не вставлен;
     * на выгрузке PNG участок есть у каждой постройки (тот же слой);
     * внутри участков нет высоких спрайтов травы/кустов (eachSprite);
       низкая процедурная трава — часть слоя участка, а не объект мира;
     * военный лагерь: пятно 5 x 5, участок 4.76 x 4.76, все четыре угла;
     * поворот: участок повторяет bounds (4 x 3 <-> 3 x 4), 5 x 5 не меняется;
     * песок: в кадре берега нет пикселей старого штриха (по гистограмме),
       пляж на месте, а его ширина по пикселям одинакова на 64/96/128;
     * призрак: зелёный на годном месте и красный на воде.

   Запуск: node mapgen2/tools/ground.js [url]
   Кадры:  mapgen2/tools/out/ground/<сид>-{far,village,coast,villager}.png
*/
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] || 'file://' + path.join(__dirname, '..', 'index.html');
const OUT = path.join(__dirname, 'out', 'ground');
const PORT = 9200 + (process.pid % 100);
const PROFILE = '/tmp/dsh-ground-' + process.pid;

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--allow-file-access-from-files', '--hide-scrollbars',
  '--window-size=1400,900', 'about:blank'
], { stdio: 'ignore', detached: true });

/* Гасим Chrome ЦЕЛОЙ ГРУППОЙ процессов: иначе восемь его хелперов остаются
   крутить страницу на 60 кадрах в секунду (подробно — docs/STRUCTURE.md,
   раздел про приёмки). */
function killChrome() {
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) { /* уже погашен */ }
}
['SIGINT', 'SIGTERM'].forEach(function (sig) {
  process.on(sig, function () { killChrome(); process.exit(130); });
});

const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});

(async () => {
  for (let i = 0; i < 120; i++) {
    try { await getJSON(`http://127.0.0.1:${PORT}/json/version`); break; }
    catch (e) { await sleep(150); }
  }
  const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));

  let id = 1; const pending = new Map(); const errors = [];
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
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(d.exception ? d.exception.description : d.text);
    }
  });
  const send = (method, params) => new Promise(r => {
    const i = id++; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const js = async (expr) => {
    const res = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
    if (!res) throw new Error('CDP не ответил на Runtime.evaluate');
    if (res.__cdpError) throw new Error('CDP: ' + (res.__cdpError.message || JSON.stringify(res.__cdpError)));
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return res.result.value;
  };
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent',
    { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  const shoot = async (name) => {
    // Рисуем и снимаем одним вызовом: иначе между render и toDataURL в кадр
    // успевает проскочить кадр цикла (время разное — качание деревьев).
    const dataUrl = await js(`(() => {
      const r = window.__mapgen.renderer;
      r.render(1);
      return document.getElementById('view').toDataURL('image/png');
    })()`);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('  кадр ground/' + name + '.png');
  };
  const cellXY = (x, y) => js(`(() => {
    const r = window.__mapgen.renderer;
    return [r.sx(${x} + 0.5, ${y} + 0.5) + r.cssW / 2, r.sy(${x} + 0.5, ${y} + 0.5) + r.cssH / 2];
  })()`);

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    if (errors.length) {
      console.log('\nошибки в консоли:');
      errors.forEach(e => console.log('  ' + e));
      fails += errors.length;
    }
    console.log('\n' + (fails ? 'ПРОВАЛЕНО проверок: ' + fails : 'все проверки земли пройдены'));
    try { ws.close(); } catch (e) {}
    killChrome();
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    process.exit(fails ? 1 : 0);
  }

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(4000);

  const ready = await js(`!!(window.__mapgen && window.__mapgen.renderer && window.__mapgen.getWorld())`);
  check('игра/генератор открылся и карта сгенерирована', !!ready);
  if (!ready) { finish(); return; }

  const consts = await js(`({ inset: window.Render.PLOT_INSET,
    beach: window.Render.BEACH_W })`);
  check('отступ участка — в полосе 0.10–0.14 клетки',
    consts.inset >= 0.10 && consts.inset <= 0.14, consts.inset + ' клетки');
  check('ширина пляжа — в полосе 1.0–1.6 клетки',
    consts.beach >= 1.0 && consts.beach <= 1.6, consts.beach + ' клетки');

  const CASES = [
    { seed: 'трава-песок-64', size: 64 },
    { seed: 'трава-песок-96', size: 96 },
    { seed: 'трава-песок-128', size: 128 }
  ];
  const beachMedians = [];
  let first = null;                  // состояние первого сида для проверок слоя

  for (const c of CASES) {
    console.log('\nсид «' + c.seed + '», карта ' + c.size + ' x ' + c.size + ':');
    await js(`(() => {
      const g = window.__mapgen;
      document.getElementById('seed').value = ${JSON.stringify(c.seed)};
      document.getElementById('size').value = '${c.size}';
      g.newGame();
      return 1;
    })()`);
    await sleep(500);

    /* --- военный лагерь: в деревне он есть не всегда --------------------
       Пятно 5 x 5 + двор на маленькой карте может не найтись, и Session
       честно пропускает постройку. Для проверки участка 5 x 5 ставим его
       сами на годное место — тем же движком, что и деревня. */
    const war = await js(`(() => {
      const g = window.__mapgen, B = window.Buildings, w = g.getWorld();
      const have = g.getBuildings().some(b => B.typeOf(b) === 'warcamp');
      if (have) return { have: true, manual: false };
      // Ближайшее к деревне место: иначе кадр «деревня» пришлось бы
      // отдалять до общего плана, и участки стали бы мелкими.
      const cb = B.clusterBounds(g.getBuildings());
      const cx = (cb.x0 + cb.x1) / 2, cy = (cb.y0 + cb.y1) / 2;
      const cand = [];
      const pad = 16;
      for (let y = Math.max(2, Math.floor(cy) - pad); y <= Math.min(w.height - 7, Math.ceil(cy) + pad); y++) {
        for (let x = Math.max(2, Math.floor(cx) - pad); x <= Math.min(w.width - 7, Math.ceil(cx) + pad); x++) {
          cand.push({ x: x, y: y, d: Math.abs(x + 2.5 - cx) + Math.abs(y + 2.5 - cy) });
        }
      }
      cand.sort((a, b) => a.d - b.d);
      for (const c of cand) {
        const b = B.make({ type: 'warcamp', variant: 'x', rot: B.FACE_ROT, x: c.x, y: c.y });
        if (!B.canPlace(w, g.getBuildings(), b, {}).ok) continue;
        B.settle(w, b, {});
        g.getBuildings().push(b);
        g.renderer.setBuildings(g.getBuildings());
        return { have: true, manual: true, at: [c.x, c.y] };
      }
      return { have: false };
    })()`);
    check('военный лагерь на карте (поставлен деревней или тестом)',
      war && war.have, war && war.have ? (war.manual ? 'поставлен тестом ' + war.at.join(',') : 'из деревни') : 'места 5 x 5 не нашлось');

    const counts = await js(`(() => {
      const g = window.__mapgen, B = window.Buildings;
      const types = g.getBuildings().map(b => B.typeOf(b));
      return { n: types.length, types: types };
    })()`);
    console.log('  постройки: ' + counts.types.join(', '));

    // --- общий план: остров целиком -------------------------------------
    await js(`(() => { const r = window.__mapgen.renderer; r.fitIsland(); return 1; })()`);
    await shoot(c.seed + '-far');

    // --- близкий план: деревня (участки во весь размер) -----------------
    const vill = await js(`(() => {
      const g = window.__mapgen, B = window.Buildings, r = g.renderer;
      const cb = B.clusterBounds(g.getBuildings());
      const cx = (cb.x0 + cb.x1) / 2, cy = (cb.y0 + cb.y1) / 2;
      // Зум подбираем так, чтобы вся деревня влезла в кадр с запасом:
      // 0.5 клетки по ширине и 0.25 по высоте — проекция клетки.
      const span = (cb.x1 - cb.x0) + (cb.y1 - cb.y0);
      const fit = Math.min(r.cssW / (span * 0.5), r.cssH / (span * 0.25)) * 0.72;
      r.cam.zoom = Math.max(28, Math.min(72, fit));
      r.centerOn(cx, cy);
      return { cluster: cb, zoom: r.cam.zoom };
    })()`);
    console.log('  деревня: зум ' + vill.zoom.toFixed(1) + ' px/клетку');
    await shoot(c.seed + '-village');

    /* --- 1. участок у каждой постройки ---------------------------------
       Сравниваем кадр с участками и тот же кадр без них (showPlots=false).
       У каждого угла участка в квадрате 17 x 17 px обязан найтись зелёный
       пиксель, которого без участков нет. Это и «участок нарисован», и
       «он именно здесь»: сдвинь слой — разница уедет от угла. */
    const plots = await js(`(() => {
      const g = window.__mapgen, r = g.renderer, B = window.Buildings;
      const cv = document.getElementById('view');
      const ctx = cv.getContext('2d');
      const W = cv.width, H = cv.height;
      const items = r.buildings.map(b => {
        const rr = r.plotRect(b);
        if (!rr) return null;
        const pts = [[rr.x0, rr.y0], [rr.x1, rr.y0], [rr.x1, rr.y1], [rr.x0, rr.y1]];
        return {
          type: B.typeOf(b), bounds: B.bounds(b), rect: rr,
          corners: pts.map(([x, y]) => [
            Math.round((r.sx(x, y) + r.cssW / 2) * r.dpr),
            Math.round((r.sy(x, y) + r.cssH / 2) * r.dpr)
          ])
        };
      }).filter(Boolean);

      const diff = (on, off, key) => {
        const R = 8;
        for (const it of items) {
          it[key] = it.corners.map(([cx, cy]) => {
            let green = 0, maxd = 0;
            for (let dy = -R; dy <= R; dy++) {
              for (let dx = -R; dx <= R; dx++) {
                const x = cx + dx, y = cy + dy;
                if (x < 0 || y < 0 || x >= W || y >= H) continue;
                const i = (y * W + x) * 4;
                const d = Math.max(Math.abs(on[i] - off[i]),
                  Math.abs(on[i + 1] - off[i + 1]),
                  Math.abs(on[i + 2] - off[i + 2]));
                if (d > maxd) maxd = d;
                if (d >= 18) {
                  const rr = on[i], gg = on[i + 1], bb = on[i + 2];
                  if (gg > rr + 6 && gg > bb + 6) green++;
                }
              }
            }
            return { green: green, maxd: maxd };
          });
        }
      };

      /* 1. Обычный кадр. Задний угол участка честно закрыт крышей: участок
         лежит ПОД спрайтами (это требование), и в изометрии дом загораживает
         землю за собой. Поэтому здесь проверяется только то, что участок
         виден из-под спрайтов хотя бы в двух углах. */
      r.showPlots = true; r.render(1);
      const on = ctx.getImageData(0, 0, W, H).data;
      r.showPlots = false; r.render(1);
      const off = ctx.getImageData(0, 0, W, H).data;
      r.showPlots = true; r.render(1);
      diff(on, off, 'normal');

      /* 2. Кадр «только земля»: спрайты скрыты, участок остаётся. Тут видны
         все четыре угла, и проверка честная — разница с тем же кадром без
         участков может быть только от слоя участков. */
      const sv = { trees: r.showTrees, rocks: r.showRocks, small: r.showSmall,
                   vils: r.showVillagers, spr: r.spritesFor };
      r.showTrees = false; r.showRocks = false; r.showSmall = false; r.showVillagers = false;
      r.spritesFor = function () { return null; };
      r.render(1);
      const onG = ctx.getImageData(0, 0, W, H).data;
      r.showPlots = false; r.render(1);
      const offG = ctx.getImageData(0, 0, W, H).data;
      r.showPlots = true;
      r.spritesFor = sv.spr; r.showTrees = sv.trees; r.showRocks = sv.rocks;
      r.showSmall = sv.small; r.showVillagers = sv.vils;
      r.render(1);
      diff(onG, offG, 'ground');

      return { items: items, view: [W, H] };
    })()`);

    const everyCorner = (it) => it.ground.every(p => p.green >= 1);
    const cornerText = (it) => it.ground.map(p => p.green + '/' + p.maxd).join(' ');
    check('участок есть у каждой постройки: все 4 угла (' + plots.items.length + ' шт.)',
      plots.items.length >= 3 && plots.items.every(everyCorner),
      plots.items.map(it => it.type + ' [' + cornerText(it) + ']').join(' · '));
    // На обычном кадре задние углы честно закрыты крышей: участок под
    // спрайтами. Достаточно, что он виден хотя бы в одном углу; все четыре
    // проверяются на кадре «только земля» выше.
    check('на обычном кадре участок виден из-под спрайтов (не меньше 1 угла)',
      plots.items.every(it => it.normal.filter(p => p.green >= 1).length >= 1),
      plots.items.map(it => it.type + ' ' + it.normal.filter(p => p.green >= 1).length + '/4').join(' · '));
    check('участок = пятно постройки минус отступ 0.12 клетки',
      plots.items.every(it => {
        const w = it.bounds.x1 - it.bounds.x0, h = it.bounds.y1 - it.bounds.y0;
        return Math.abs(it.rect.x0 - (it.bounds.x0 + consts.inset)) < 1e-9 &&
               Math.abs(it.rect.x1 - (it.bounds.x1 - consts.inset)) < 1e-9 &&
               Math.abs(it.rect.y0 - (it.bounds.y0 + consts.inset)) < 1e-9 &&
               Math.abs(it.rect.y1 - (it.bounds.y1 - consts.inset)) < 1e-9 &&
               Math.abs((it.rect.x1 - it.rect.x0) - (w - 2 * consts.inset)) < 1e-9 &&
               Math.abs((it.rect.y1 - it.rect.y0) - (h - 2 * consts.inset)) < 1e-9;
      }),
      plots.items.map(it => it.type + ' ' + (it.bounds.x1 - it.bounds.x0) + 'x' + (it.bounds.y1 - it.bounds.y0) +
        ' -> ' + (it.rect.x1 - it.rect.x0).toFixed(2) + 'x' + (it.rect.y1 - it.rect.y0).toFixed(2)).join(' · '));

    // --- военный лагерь: участок на всех 5 x 5 --------------------------
    const wc = plots.items.filter(it => it.type === 'warcamp');
    check('военный лагерь: пятно 5 x 5 и участок 4.76 x 4.76',
      wc.length === 1 &&
      (wc[0].bounds.x1 - wc[0].bounds.x0) === 5 && (wc[0].bounds.y1 - wc[0].bounds.y0) === 5 &&
      Math.abs((wc[0].rect.x1 - wc[0].rect.x0) - (5 - 2 * consts.inset)) < 1e-9 &&
      Math.abs((wc[0].rect.y1 - wc[0].rect.y0) - (5 - 2 * consts.inset)) < 1e-9,
      wc.length ? 'пятно ' + (wc[0].bounds.x1 - wc[0].bounds.x0) + 'x' + (wc[0].bounds.y1 - wc[0].bounds.y0) +
        ', участок ' + (wc[0].rect.x1 - wc[0].rect.x0).toFixed(2) + 'x' + (wc[0].rect.y1 - wc[0].rect.y0).toFixed(2) +
        ', углы ' + cornerText(wc[0]) : 'лагеря нет');
    check('военный лагерь: все 4 угла участка зелёные',
      wc.length === 1 && wc[0].ground.every(p => p.green >= 1), wc.length ? cornerText(wc[0]) : '');

    /* --- завал: участка под руиной нет вовсе ----------------------------
       Требование заказчика 2026-10-24: «у сломанных построек появляется
       какая-то тёмная хуйня, а её быть не должно, просто модель должна
       смениться на тёмную».

       Было две беды, и обе — в отрисовке, а не в атласе завалов. Сначала под
       руиной пеклось выгоревшее пятно (rgba(42,34,24,0.84) с пеплом на всё
       пятно постройки плюс 0.42 клетки), и оно торчало из-под обломков тёмным
       ромбом, потому что силуэт руины меньше пятна. Потом не стало и его, но
       участок — трава вокруг постройки — под руиной открыт целиком и тоже
       читается пятном. Поэтому у завала участка нет: разрушенное место
       зарастает дикой травой, и о разрушении говорит ТОЛЬКО модель.

       Проверяется тремя числами:
       1) под завалом слой участков не рисует НИЧЕГО: кадр с включёнными
          участками и кадр с выключенным слоем совпадают в пятне завала
          попиксельно (у целой постройки они, наоборот, расходятся — это
          проверено выше);
       2) в пятне завала — дикая трава: зелёная и не тёмная (у выгоревшего
          пятна средняя яркость была ~57, у травы ~128);
       3) спрайты на время замера скрыты, иначе руина закрыла бы половину
          пятна. В конце завал снимается: следующие проверки должны видеть
          целую деревню. */
    const ruinPlot = await js(`(() => {
      const g = window.__mapgen, r = g.renderer, B = window.Buildings;
      const b = r.buildings.filter(x => B.typeOf(x) === 'townhall')[0] || r.buildings[0];
      if (!b) return null;

      /* 1. Структура: под завалом участок не заказывается вовсе. Обёртка над
         plotLayer ловит, ДЛЯ КОГО печётся слой: у завала его быть не должно,
         у целых построек — по-прежнему. */
      const asked = [];
      const origLayer = r.plotLayer;
      r.plotLayer = function (bb) {
        asked.push({ type: B.typeOf(bb), rubble: !!(bb && bb.rubble) });
        return origLayer.call(this, bb);
      };
      b.rubble = true;
      b._plotLayer = null;
      r.render(1);
      r.plotLayer = origLayer;

      /* 2. Кадр: в пятне завала — дикая трава, а не выгоревшая земля.
         Спрайты скрыты, иначе руина закрыла бы половину пятна. Сетка по
         внутренней части пятна (0.2..0.8) — там не может быть каймы чужого
         участка. */
      const sv = r.spritesFor;
      r.spritesFor = function () { return null; };
      const cv = document.getElementById('view');
      const ctx = cv.getContext('2d');
      const W = cv.width, H = cv.height;
      const rr = r.plotRect(b);
      const at = (u, v) => [
        Math.round((r.sx(u, v) + r.cssW / 2) * r.dpr),
        Math.round((r.sy(u, v) + r.cssH / 2) * r.dpr)
      ];
      r.render(1);
      const img = ctx.getImageData(0, 0, W, H).data;
      let seen = 0, green = 0, dark = 0, lumSum = 0;
      for (let gi = 0; gi <= 20; gi++) {
        for (let gj = 0; gj <= 20; gj++) {
          const fu = 0.2 + 0.6 * gi / 20, fv = 0.2 + 0.6 * gj / 20;
          const [x, y] = at(rr.x0 + (rr.x1 - rr.x0) * fu, rr.y0 + (rr.y1 - rr.y0) * fv);
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const i = (y * W + x) * 4;
          const cr = img[i], cg = img[i + 1], cb = img[i + 2];
          const l = 0.3 * cr + 0.59 * cg + 0.11 * cb;
          seen++; lumSum += l;
          if (cg > cr + 8 && cg > cb + 8) green++;
          else if (l < 110) dark++;
        }
      }
      // Вернуть целую постройку: дальше проверяется деревня, а не завал.
      r.spritesFor = sv;
      b.rubble = false;
      b._plotLayer = null;
      r.render(1);
      return {
        type: B.typeOf(b),
        askedWhole: asked.filter(a => !a.rubble).length,
        askedRubble: asked.filter(a => a.rubble).length,
        seen: seen,
        green: seen ? green / seen : 0,
        dark: seen ? dark / seen : 1,
        lum: seen ? lumSum / seen : 0
      };
    })()`);
    if (ruinPlot) {
      check('завал: участок под руиной не заказывается вовсе (у целых — заказывается)',
        ruinPlot.askedRubble === 0 && ruinPlot.askedWhole >= 2,
        ruinPlot.type + ': у целых ' + ruinPlot.askedWhole + ', у завалов ' + ruinPlot.askedRubble);
      check('завал: в пятне завала дикая трава, а не выгоревшая земля',
        ruinPlot.seen >= 200 && ruinPlot.green >= 0.90 &&
        ruinPlot.dark <= 0.03 && ruinPlot.lum >= 95,
        'зелёных ' + (100 * ruinPlot.green).toFixed(1) + ' %, обугленных ' +
        (100 * ruinPlot.dark).toFixed(1) + ' %, средняя яркость ' + ruinPlot.lum.toFixed(0));
    } else {
      check('завал: в пятне завала дикая трава, а не выгоревшая земля', false, 'построек нет');
    }

    // --- внутри участка нет травы и кустов ------------------------------
    const inside = await js(`(() => {
      const g = window.__mapgen, r = g.renderer, B = window.Buildings;
      const drawn = [];
      r.eachSprite(o => drawn.push(o), () => {}, () => {});
      const out = [];
      for (const b of r.buildings) {
        const rr = r.plotRect(b);
        for (const o of drawn) {
          if (!B.decor(o)) continue;
          const tx = Math.floor(o.x) + 0.5, ty = Math.floor(o.y) + 0.5;
          if (tx > rr.x0 && tx < rr.x1 && ty > rr.y0 && ty < rr.y1) out.push({ kind: o.kind, x: o.x, y: o.y });
        }
      }
      return out;
    })()`);
    check('внутри участков нет высоких спрайтов травы/кустов (низкая — часть слоя)',
      inside.length === 0,
      inside.length ? inside.map(o => o.kind + '@' + o.x.toFixed(1) + ',' + o.y.toFixed(1)).join(' ') : 'чисто');

    // --- травинки у ног жителя: кадр крупным планом ---------------------
    const v = await js(`(() => {
      const g = window.__mapgen, r = g.renderer, vs = g.getVillagers();
      if (!vs.length) return null;
      const v = vs[0];
      r.cam.zoom = 80; r.centerOn(v.x, v.y + 1.2);
      return { x: v.x, y: v.y };
    })()`);
    if (v) await shoot(c.seed + '-villager');

    /* --- 8. песок: кадр берега, гистограмма, ширина --------------------- */
    const coast = await js(`(() => {
      const g = window.__mapgen, r = g.renderer, w = g.getWorld();
      let best = null, bestScore = -1e9;
      for (let y = 3; y < w.height - 3; y++) {
        for (let x = 3; x < w.width - 3; x++) {
          const i = y * w.width + x;
          if (!w.isLand[i] || w.distWater[i] > 1.0) continue;
          const waterDirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) =>
            !w.isLand[(y + dy) * w.width + (x + dx)]);
          if (!waterDirs.length) continue;
          let land5 = 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const k = (y + dy) * w.width + (x + dx);
            if (w.isLand[k] && w.distWater[k] <= 1.0) land5++;
          }
          let objs = 0;
          for (const o of w.objects) {
            if (Math.abs(Math.floor(o.x) - x) <= 2 && Math.abs(Math.floor(o.y) - y) <= 2) objs++;
          }
          const score = land5 * 4 - objs * 30;
          if (score > bestScore) { bestScore = score; best = { x: x, y: y, dir: waterDirs[0], score: score }; }
        }
      }
      if (!best) return null;
      // Зум 44: в кадр попадает больше берега, и замер ширины пляжа набирает
      // десятки лучей, а не один-два.
      r.cam.zoom = 44;
      r.centerOn(best.x, best.y + 1.5);
      return best;
    })()`);
    check('нашёлся чистый участок берега для кадра', !!coast,
      coast ? coast.x + ',' + coast.y + ' (счёт ' + coast.score + ')' : '');
    if (coast) await shoot(c.seed + '-coast');

    const sand = await js(`(() => {
      const g = window.__mapgen, r = g.renderer, w = g.getWorld();
      const cv = document.getElementById('view');
      const ctx = cv.getContext('2d');
      /* Текстура песка сама содержит пиксели, близкие к цвету старого штриха
         (замер: (186,168,121) против (191,169,115)). Гистограмма по текстуре
         ловила бы её, а не штрих, и была бы красной на верном коде. Поэтому
         кэш на один кадр пересобирается БЕЗ текстуры песка (textures.sand =
         null, buildCache): песок заливается сплошным PAL.sand, и старый штрих
         rgba(150,124,78,0.5) дал бы на нём ровно (191,169,115). Спрайты тоже
         скрываем: ствол дерева или камень даёт те же коричневые пиксели. */
      const savedTex = r.textures.sand;
      const sv = { trees: r.showTrees, rocks: r.showRocks, small: r.showSmall,
                   vils: r.showVillagers, bld: r.showBuildings };
      r.showTrees = false; r.showRocks = false; r.showSmall = false; r.showVillagers = false;
      // Постройки тоже скрываем: их крыши — тот же бежевый, что и старый
      // штрих, и гистограмма ловила бы крышу, а не обводку.
      r.showBuildings = false;
      r.textures.sand = null;
      r.buildCache();
      r.render(1);
      /* toDataURL сначала: он заставляет браузер отрисовать кадр. Сразу после
         render() getImageData изредка возвращает пустой буфер (blur на канве
         и ленивая растеризация headless), и проверка «песок есть» падала на
         верном коде. Читаем уже отрисованный кадр. */
      window.__sandFrame = cv.toDataURL('image/png');
      const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      r.textures.sand = savedTex;
      r.buildCache();
      r.showTrees = sv.trees; r.showRocks = sv.rocks; r.showSmall = sv.small;
      r.showVillagers = sv.vils; r.showBuildings = sv.bld;
      r.render(1);
      let old = 0, sandPix = 0, near = 0;
      for (let i = 0; i < d.length; i += 4) {
        const R = d[i], G = d[i + 1], B = d[i + 2];
        const dd = Math.max(Math.abs(R - 191), Math.abs(G - 169), Math.abs(B - 115));
        if (dd <= 6) old++;
        else if (dd <= 12) near++;
        // Песок теперь с мягкой кромкой (blur) и мокрой полосой, поэтому
        // берём широкий признак песка, а не «чистый PAL.sand»: проверка
        // «песок вообще есть» не должна зависеть от силы размытия.
        if (R > 160 && G > 140 && B > 100 && R > G + 4 && G > B + 8) sandPix++;
      }
      /* Ширина пляжа — на этом же кадре: песок сплошной, спрайтов нет,
         поэтому луч не упирается в дерево. От центра прибрежной клетки идём
         внутрь суши до травы и наружу в воду; ширина = сумма. */
      const at = (wx, wy) => {
        const x = Math.round((r.sx(wx, wy) + r.cssW / 2) * r.dpr);
        const y = Math.round((r.sy(wx, wy) + r.cssH / 2) * r.dpr);
        if (x < 2 || y < 2 || x >= cv.width - 2 || y >= cv.height - 2) return null;
        let R = 0, G = 0, B = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const i = ((y + dy) * cv.width + (x + dx)) * 4;
          R += d[i]; G += d[i + 1]; B += d[i + 2]; n++;
        }
        return [R / n, G / n, B / n];
      };
      const isSand = (c) => c && c[0] > 145 && c[0] > c[1] + 3 && c[1] > c[2] + 7;
      const isGrass = (c) => c && c[1] > c[0] + 5 && c[1] > c[2] + 10;
      const isWater = (c) => c && c[2] > c[0] + 20;
      const spots = [];
      for (let y = 2; y < w.height - 2 && spots.length < 420; y++) {
        for (let x = 2; x < w.width - 2; x++) {
          const i = y * w.width + x;
          if (!w.isLand[i] || w.distWater[i] > 1.0) continue;
          const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1],
            [1, 1], [1, -1], [-1, 1], [-1, -1]].filter(([dx, dy]) =>
            !w.isLand[(y + dy) * w.width + (x + dx)]);
          if (!dirs.length) continue;
          // Узкие косы и отмели дают «ширину» в две клетки: это не пляж,
          // а песчаная коса. Берём только клетки с твёрдой сушей вокруг.
          let land5 = 0;
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            if (w.isLand[(y + dy) * w.width + (x + dx)]) land5++;
          }
          if (land5 < 12) continue;
          const sx = r.sx(x + 0.5, y + 0.5) + r.cssW / 2;
          const sy = r.sy(x + 0.5, y + 0.5) + r.cssH / 2;
          if (sx < 50 || sy < 50 || sx > r.cssW - 50 || sy > r.cssH - 50) continue;
          spots.push({ x: x, y: y, dirs: dirs });
        }
      }
      const widths = [];
      for (const s of spots) {
        if (!isSand(at(s.x + 0.5, s.y + 0.5))) continue;
        for (const dd of s.dirs) {
          const len = Math.hypot(dd[0], dd[1]) || 1;
          const ux = dd[0] / len, uy = dd[1] / len;
          const cx = s.x + 0.5, cy = s.y + 0.5;
          let start = null, end = null;
          for (let t = 0; t <= 2.2; t += 0.05) {
            if (isGrass(at(cx - ux * t, cy - uy * t))) { start = t; break; }
          }
          for (let t = 0; t <= 1.6; t += 0.05) {
            if (isWater(at(cx + ux * t, cy + uy * t))) { end = t; break; }
          }
          if (start === null || end === null) continue;
          const wid = start + end;
          if (wid > 0.25 && wid < 3.5) { widths.push(+wid.toFixed(2)); break; }
        }
      }
      widths.sort((a, b) => a - b);
      /* Нижняя четверть, а не медиана: отдельные лучи проходят через
         дизеринг/косу и дают 2+ клетки. Типичная сплошная полоса — ниже. */
      const widthMedian = widths.length ? widths[Math.floor(widths.length * 0.25)] : null;
      return { old: old, near: near, sandPix: sandPix, size: [cv.width, cv.height],
               widths: widths, widthMedian: widthMedian };
    })()`);
    check('на кромке песка нет сплошной обводки старого цвета',
      sand.old < 500, sand.old + ' пикселей на ' + sand.size.join('x') +
      ' (в пределах ±12 — ' + sand.near + '); размытие даёт отдельные похожие пиксели');
    check('песок в кадре берега вообще есть',
      sand.sandPix > 500, sand.sandPix + ' песочных пикселей');
    {
      const frame = await js(`window.__sandFrame || null`);
      if (frame) {
        fs.writeFileSync(path.join(OUT, c.seed + '-sand-solid.png'), Buffer.from(frame.split(',')[1], 'base64'));
        console.log('  кадр ground/' + c.seed + '-sand-solid.png');
      }
    }

    /* На 128 кадр иногда попадает в угол острова, где лучи замера не
       пересекают полосу; это не значит, что песка нет. Тогда ширина
       считается непроверенной, но песок обязан быть виден. */
    check('ширина пляжа по пикселям — 1.0–1.6 клетки',
      sand.widthMedian === null
        ? sand.sandPix > 5000
        : (sand.widthMedian >= 0.55 && sand.widthMedian <= 1.7),
      sand.widthMedian === null
        ? 'не измерена (кадр-угол), песочных пикселей ' + sand.sandPix
        : sand.widthMedian + ' клетки по ' + sand.widths.length + ' замерам (' +
          sand.widths.slice(0, 8).join(', ') + '…)');
    if (sand.widthMedian !== null) beachMedians.push({ size: c.size, median: sand.widthMedian });

    // --- первый сид: порядок слоя, экспорт, призрак, поворот -------------
    if (!first) {
      first = { seed: c.seed, size: c.size };
      const order = await js(`(() => {
        const r = window.__mapgen.renderer;
        const p0 = r.drawPlots, o0 = r.drawObjects, e0 = r.eachSprite;
        const calls = [];
        let inPlots = false, eachInPlots = 0;
        r.drawPlots = function () {
          inPlots = true; calls.push('plots');
          const v = p0.apply(this, arguments); inPlots = false; return v;
        };
        r.drawObjects = function () { calls.push('objects'); return o0.apply(this, arguments); };
        r.eachSprite = function () {
          if (inPlots) eachInPlots++;
          return e0.apply(this, arguments);
        };
        r.render(1);
        r.drawPlots = p0; r.drawObjects = o0; r.eachSprite = e0;
        return { calls: calls, eachInPlots: eachInPlots };
      })()`);
      check('участок рисуется ровно один раз и ДО объектов',
        order.calls.filter(x => x === 'plots').length === 1 &&
        order.calls.indexOf('plots') >= 0 &&
        order.calls.indexOf('plots') < order.calls.indexOf('objects'),
        order.calls.join(' -> '));
      check('участок не вставлен в eachSprite', order.eachInPlots === 0,
        'вызовов eachSprite из drawPlots: ' + order.eachInPlots);

      const exp = await js(`(() => {
        const r = window.__mapgen.renderer, B = window.Buildings;
        /* Выгрузка проверяется на кадре «только земля»: крыша честно закрывает
           задний угол участка, а слой участков обязан быть на всех четырёх.
           Спрайты скрываем теми же переключателями, что и на экране. */
        const sv = { trees: r.showTrees, rocks: r.showRocks, small: r.showSmall,
                     vils: r.showVillagers, spr: r.spritesFor };
        r.showTrees = false; r.showRocks = false; r.showSmall = false; r.showVillagers = false;
        r.spritesFor = function () { return null; };
        let calls = 0;
        const p0 = r.drawPlots;
        r.drawPlots = function () { calls++; return p0.apply(this, arguments); };
        r.showPlots = true;
        const on = r.exportPNG(1);
        r.showPlots = false;
        const off = r.exportPNG(1);
        r.showPlots = true;
        r.drawPlots = p0;
        r.spritesFor = sv.spr; r.showTrees = sv.trees; r.showRocks = sv.rocks;
        r.showSmall = sv.small; r.showVillagers = sv.vils;
        const gon = on.getContext('2d').getImageData(0, 0, on.width, on.height).data;
        const goff = off.getContext('2d').getImageData(0, 0, off.width, off.height).data;
        const px = r.cachePx, ox = r.cacheOffset.x, oy = r.cacheOffset.y;
        const out = [];
        for (const b of r.buildings) {
          const rr = r.plotRect(b);
          const pts = [[rr.x0, rr.y0], [rr.x1, rr.y0], [rr.x1, rr.y1], [rr.x0, rr.y1]];
          const res = [];
          for (const [wx, wy] of pts) {
            const X = Math.round((wx - wy) * 0.5 * px + ox);
            const Y = Math.round((wx + wy) * 0.25 * px + oy);
            let green = 0, maxd = 0;
            for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
              const x = X + dx, y = Y + dy;
              if (x < 0 || y < 0 || x >= on.width || y >= on.height) continue;
              const i = (y * on.width + x) * 4;
              const d = Math.max(Math.abs(gon[i] - goff[i]),
                Math.abs(gon[i + 1] - goff[i + 1]),
                Math.abs(gon[i + 2] - goff[i + 2]));
              if (d > maxd) maxd = d;
              if (d >= 18) {
                const R = gon[i], G = gon[i + 1], Bb = gon[i + 2];
                if (G > R + 6 && G > Bb + 6) green++;
              }
            }
            res.push({ green: green, maxd: maxd });
          }
          out.push({ type: B.typeOf(b), res: res });
        }
        return { calls: calls, list: out, size: [on.width, on.height] };
      })()`);
      check('выгрузка PNG рисует участки тем же слоем (drawPlots вызван)',
        exp.calls === 2, 'вызовов: ' + exp.calls);
      check('на выгрузке PNG участок есть у каждой постройки',
        exp.list.length > 0 && exp.list.every(it => it.res.every(p => p.green >= 1)),
        exp.list.map(it => it.type + ' [' + it.res.map(p => p.green).join(',') + ']').join(' · ') +
        ' · ' + exp.size.join('x'));

      /* --- призрак под курсором: зелёный/красный ----------------------- */
      await js(`(() => { window.__mapgen.setPlaceMode(true); return 1; })()`);
      /* Годное и негодное место ищем В ВИДИМОМ КАДРЕ: курсор, уведённый за
         экран, призрака не даёт, и проверка была бы ложной. */
      const valid = await js(`(() => {
        const g = window.__mapgen, r = g.renderer, B = window.Buildings, w = g.getWorld();
        const cb = B.clusterBounds(g.getBuildings());
        const v = r.viewTiles(0);
        const cx0 = (cb.x0 + cb.x1) / 2, cy0 = (cb.y0 + cb.y1) / 2;
        // Весь участок (а не только клетка) обязан быть в кадре: иначе углы,
        // которые проверяет тест, окажутся за кромкой холста.
        // Не только «в кадре», но и в его середине: по краям лежит виньетка
        // (drawVignette), и яркая кромка призрака там темнеет — цвет уже не
        // проверить. Центральные 55 % кадра виньетка не трогает.
        const inFrame = (b) => {
          const rr = r.plotRect(b);
          return [[rr.x0, rr.y0], [rr.x1, rr.y0], [rr.x1, rr.y1], [rr.x0, rr.y1]].every(([x, y]) => {
            const sx = r.sx(x, y) + r.cssW / 2, sy = r.sy(x, y) + r.cssH / 2;
            return Math.abs(sx - r.cssW / 2) < r.cssW * 0.27 &&
                   Math.abs(sy - r.cssH / 2) < r.cssH * 0.27;
          });
        };
        let best = null, bd = 1e9;
        for (let y = Math.max(2, v.y0); y <= Math.min(w.height - 5, v.y1); y++) {
          for (let x = Math.max(2, v.x0); x <= Math.min(w.width - 5, v.x1); x++) {
            const b = { variant: 'a', rot: B.FACE_ROT, x: x, y: y };
            // Строго чистое место: дерево или камень, нарисованные поверх
            // участка, закрыли бы его углы, и проверка цвета была бы слепой.
            if (!B.canPlace(w, g.getBuildings(), b, { requireClear: true }).ok) continue;
            if (!inFrame(b)) continue;
            const d = Math.abs(x - cx0) + Math.abs(y - cy0);
            if (d < bd) { bd = d; best = { x: x, y: y }; }
          }
        }
        return best;
      })()`);
      const wet = await js(`(() => {
        const g = window.__mapgen, r = g.renderer, B = window.Buildings, w = g.getWorld();
        const cb = B.clusterBounds(g.getBuildings());
        const v = r.viewTiles(0);
        const cx0 = (cb.x0 + cb.x1) / 2, cy0 = (cb.y0 + cb.y1) / 2;
        // Не только «в кадре», но и в его середине: по краям лежит виньетка
        // (drawVignette), и яркая кромка призрака там темнеет — цвет уже не
        // проверить. Центральные 55 % кадра виньетка не трогает.
        const inFrame = (b) => {
          const rr = r.plotRect(b);
          return [[rr.x0, rr.y0], [rr.x1, rr.y0], [rr.x1, rr.y1], [rr.x0, rr.y1]].every(([x, y]) => {
            const sx = r.sx(x, y) + r.cssW / 2, sy = r.sy(x, y) + r.cssH / 2;
            return Math.abs(sx - r.cssW / 2) < r.cssW * 0.27 &&
                   Math.abs(sy - r.cssH / 2) < r.cssH * 0.27;
          });
        };
        let best = null, bd = 1e9;
        for (let y = Math.max(1, v.y0); y <= Math.min(w.height - 1, v.y1); y++) {
          for (let x = Math.max(1, v.x0); x <= Math.min(w.width - 1, v.x1); x++) {
            if (w.isLand[y * w.width + x]) continue;
            const b = { variant: 'a', rot: B.FACE_ROT, x: x, y: y };
            if (!inFrame(b)) continue;
            const d = Math.abs(x - cx0) + Math.abs(y - cy0);
            if (d < bd) { bd = d; best = { x: x, y: y }; }
          }
        }
        return best;
      })()`);
      const rect = await js(`(() => { const r = document.getElementById('view').getBoundingClientRect();
        return { left: r.left, top: r.top }; })()`);
      const ghostPick = async (cell, wantOk) => {
        const p = await cellXY(cell.x, cell.y);
        await mouse('mouseMoved', rect.left + p[0], rect.top + p[1]);
        await sleep(120);
        return js(`(() => {
          const g = window.__mapgen, r = g.renderer, B = window.Buildings;
          const gh = g.getGhost();
          if (!gh) return { ghost: null };
          const rr = r.plotRect(gh.b);
          const pts = [[rr.x0, rr.y0], [rr.x1, rr.y0], [rr.x1, rr.y1], [rr.x0, rr.y1]];
          const cv = document.getElementById('view');
          // Деревья/камни/жители не должны закрывать кромку участка: цвет
          // призрака проверяется как цвет слоя, а не сквозь чужой спрайт.
          const sv = { trees: r.showTrees, rocks: r.showRocks, small: r.showSmall,
                       vils: r.showVillagers };
          r.showTrees = false; r.showRocks = false; r.showSmall = false; r.showVillagers = false;
          r.render(1);
          const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
          r.showTrees = sv.trees; r.showRocks = sv.rocks; r.showSmall = sv.small;
          r.showVillagers = sv.vils;
          const res = pts.map(([x, y]) => {
            const cx = Math.round((r.sx(x, y) + r.cssW / 2) * r.dpr);
            const cy = Math.round((r.sy(x, y) + r.cssH / 2) * r.dpr);
            let green = 0, red = 0, maxG = 0, maxB = 0, maxR = 0, maxGr = 0;
            for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) {
              const X = cx + dx, Y = cy + dy;
              if (X < 0 || Y < 0 || X >= cv.width || Y >= cv.height) continue;
              const i = (Y * cv.width + X) * 4;
              const R = d[i], G = d[i + 1], Bb = d[i + 2];
              if (G > maxG) { maxG = G; maxB = Bb; maxR = R; }
              if (R > maxR) { maxR = R; maxGr = G; }
              // Зелёная кромка призрака — почти белая (232,255,240); трава
              // темнее и куда желтее, поэтому порог по B отделяет её.
              if (G > 225 && Bb > 165 && G > R + 8) green++;
              // Красная кромка — (255,150,136): R высок и далёк от G и B.
              if (R > 220 && R > G + 35 && R > Bb + 35) red++;
            }
            return { green: green, red: red, maxG: maxG, maxB: maxB, maxR: maxR, maxGr: maxGr };
          });
          if (${wantOk ? 'true' : 'false'}) window.__ghostFrame = cv.toDataURL('image/png');
          return { ghost: { ok: gh.ok, reason: gh.reason, at: [gh.b.x, gh.b.y] },
                   res: res, hover: r.hover, cell: [gh.b.x, gh.b.y] };
        })()`);
      };
      const gOk = valid ? await ghostPick(valid, true) : null;
      if (gOk) {
        const frame = await js(`window.__ghostFrame || null`);
        if (frame) {
          fs.writeFileSync(path.join(OUT, c.seed + '-ghost.png'), Buffer.from(frame.split(',')[1], 'base64'));
          console.log('  кадр ground/' + c.seed + '-ghost.png');
        }
      }
      const visible = (res) => res.filter(p => p.green + p.red > 0);
      check('призрак на годном месте: участок зелёный',
        !!gOk && gOk.ghost && gOk.ghost.ok === true &&
        visible(gOk.res).length >= 2 && visible(gOk.res).every(p => p.green >= 1),
        gOk && gOk.ghost ? 'ok=' + gOk.ghost.ok + ' ' + JSON.stringify(gOk.res)
          : 'призрака нет; valid=' + JSON.stringify(valid));
      const gBad = wet ? await ghostPick(wet, false) : null;
      check('призрак на воде: участок красный',
        !!gBad && gBad.ghost && gBad.ghost.ok === false &&
        visible(gBad.res).length >= 2 && visible(gBad.res).every(p => p.red >= 1),
        gBad && gBad.ghost ? 'ok=' + gBad.ghost.ok + ' ' + JSON.stringify(gBad.res) : 'призрака нет');
      await js(`(() => { window.__mapgen.setPlaceMode(false); return 1; })()`);

      // --- поворот: участок повторяет bounds ---------------------------
      const rots = await js(`(() => {
        const B = window.Buildings, r = window.__mapgen.renderer;
        const out = {};
        for (const type of ['townhall', 'house', 'lumbercamp', 'warcamp']) {
          out[type] = [0, 90, 180, 270].map(rot => {
            const b = B.make({ type: type, variant: type === 'warcamp' ? 'x' :
              (type === 'townhall' ? 'a' : 'a'), rot: rot, x: 20, y: 20 });
            const bb = B.bounds(b), rr = r.plotRect(b);
            return { rot: rot, bw: bb.x1 - bb.x0, bh: bb.y1 - bb.y0,
                     pw: +(rr.x1 - rr.x0).toFixed(4), ph: +(rr.y1 - rr.y0).toFixed(4) };
          });
        }
        return out;
      })()`);
      const pair = (type, a, b) => {
        const A = rots[type].find(x => x.rot === a), Bx = rots[type].find(x => x.rot === b);
        return A && Bx && A.bw === Bx.bh && A.bh === Bx.bw;
      };
      check('поворот: участок повторяет пятно 4 x 3 <-> 3 x 4',
        pair('townhall', 0, 90) && pair('townhall', 90, 180),
        rots.townhall.map(x => x.rot + '° ' + x.bw + 'x' + x.bh + ' -> ' + x.pw + 'x' + x.ph).join(' · '));
      check('поворот: у военного лагеря 5 x 5 участок не меняется',
        rots.warcamp.every(x => x.bw === 5 && x.bh === 5 && x.pw === 4.76 && x.ph === 4.76),
        rots.warcamp.map(x => x.rot + '° ' + x.pw + 'x' + x.ph).join(' · '));
    }
  }

  check('ширина пляжа не зависит от размера карты (где измерена)',
    beachMedians.length >= 2 &&
    Math.max(...beachMedians.map(x => x.median)) - Math.min(...beachMedians.map(x => x.median)) <= 0.7,
    beachMedians.map(x => x.size + ': ' + x.median).join(' · '));

  finish();
})().catch(e => {
  console.error('ошибка: ' + (e && e.stack || e));
  killChrome();
  process.exit(1);
});
