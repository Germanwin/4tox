/* controls.js — автотест управления через DevTools Protocol (нужен Chrome).
 *
 * Проверяет инварианты, которые глазами не поймать, а руками — легко:
 *   1) при зуме колесом точка мира под курсором остаётся на месте;
 *   2) при перетаскивании точка мира под курсором остаётся под курсором;
 *   3) наведение подсвечивает ту клетку, на которую указывает курсор;
 *   4) клик по миникарте центрирует камеру на выбранной точке;
 *   5) стрелки и WASD двигают камеру в ожидаемую сторону;
 *   6) панорама конечна: дальше предела остров всё ещё виден, а камера
 *      больше не едет.
 *
 * Запуск: node tools/controls.js
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require("path");
const fs = require("fs");

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] || 'file://' + path.join(__dirname, '..', 'index.html');
const PORT = 9600 + (process.pid % 300);
const PROFILE = '/tmp/dsh-controls-' + process.pid;

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--allow-file-access-from-files', '--hide-scrollbars',
  '--window-size=1400,900', 'about:blank'
], { stdio: 'ignore', detached: true });

/* Гасим Chrome ЦЕЛОЙ ГРУППОЙ процессов.

   kill по одному pid убивает только сам браузер, а его хелперы — рендерер,
   GPU, утилиты — остаются жить: страница в них продолжает крутиться на 60
   кадрах в секунду и есть процессор. Один прогон приёмки оставляет восемь
   таких процессов, пять прогонов — сорок, и машина занята целиком: композитор
   системы не успевает, и тормозит всё, включая игру в соседнем окне. Поэтому
   браузер запускается отдельной группой (detached), а гасится её номер. */
function killChrome() {
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) { /* уже погашен */ }
}

/* И на прерывании тоже: Ctrl-C по длинной приёмке не должен оставлять
   браузер работать. */
['SIGINT', 'SIGTERM'].forEach(function (sig) {
  process.on(sig, function () { killChrome(); process.exit(130); });
});


const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
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
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  const send = (method, params) => new Promise(r => {
    const i = id++; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const js = async (expr) => {
    const res = await send('Runtime.evaluate', { returnByValue: true, expression: expr });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result.value;
  };
  // Мышь и клавиатура идут через Input, то есть через те же обработчики,
  // что и у живого пользователя.
  const mouse = (type, x, y, extra) => send('Input.dispatchMouseEvent',
    Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseMoved' && extra && extra.down ? 1 : (type === 'mouseReleased' ? 0 : 0), clickCount: 1 }, extra || {}));
  const wheel = (x, y, dy) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
  const key = (type, k, code, vk) => send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 3200));

  // Игра открывается без панели, а тест проверяет в том числе кадр и окно
  // канваса: открываем панель, как было до начала игры.
  await js(`window.__mapgen.setPanel(true)`);
  await new Promise(r => setTimeout(r, 300));

  // Панель занимает 258 px, канвас начинается сразу после неё
  const rect = await js(`(() => { const r = document.getElementById('view').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
  const px = (x, y) => [rect.left + x, rect.top + y];
  const worldAt = (x, y) => js(`(() => {
    const r = window.__mapgen.renderer;
    return r.screenToWorld(${x} - r.cssW / 2, ${y} - r.cssH / 2);
  })()`);

  console.log('управление:');

  /* --- 1. зум под курсором ---------------------------------------- */
  {
    const [sx, sy] = px(300, 200);
    const before = await worldAt(300, 200);
    await wheel(sx, sy, -240);
    await new Promise(r => setTimeout(r, 120));
    const after = await worldAt(300, 200);
    const err = Math.max(Math.abs(after.x - before.x), Math.abs(after.y - before.y));
    const zoom = await js(`window.__mapgen.renderer.cam.zoom`);
    check('зум под курсором держит точку мира', err < 0.05,
      'ошибка ' + err.toFixed(4) + ' клетки, зум ' + zoom.toFixed(1));
  }

  /* --- 2. перетаскивание 1:1 --------------------------------------- */
  {
    const [sx, sy] = px(400, 300);
    const [ex, ey] = px(560, 380);
    const before = await worldAt(400, 300);
    await mouse('mousePressed', sx, sy);
    for (let i = 1; i <= 4; i++) {
      await mouse('mouseMoved', sx + (ex - sx) * i / 4, sy + (ey - sy) * i / 4, { buttons: 1 });
    }
    await mouse('mouseReleased', ex, ey);
    await new Promise(r => setTimeout(r, 120));
    // после перетаскивания точка мира, которая была под курсором в начале,
    // должна оказаться под курсором в конце
    const nowUnderEnd = await worldAt(560, 380);
    const err = Math.max(Math.abs(nowUnderEnd.x - before.x), Math.abs(nowUnderEnd.y - before.y));
    check('перетаскивание держит точку под курсором', err < 0.05,
      'ошибка ' + err.toFixed(4) + ' клетки');
  }

  /* --- 2b. местность едет вместе с камерой -------------------------- *
   *
   * Самый дорогой баг этого рендера: местность лежит в кэше и показывается
   * блитом, а объекты считаются проекцией sx/sy. Стоит потерять в блите
   * смещение камеры или перепутать его знак — карта «застывает» либо уезжает
   * вбок, а деревья продолжают ехать. Замер по цвету тут врёт (в кадре есть
   * миникарта, виньетка и блики воды), поэтому метим мировой ноль прямо
   * в кэше и смотрим, куда метка попадает на канвасе и как сдвигается.
   */
  {
    const probe = await js(`(() => {
      const r = window.__mapgen.renderer, ctx = r.ctx;
      const cc = r.cache.getContext('2d');
      // мировой ноль лежит в кэше в точке (cacheOffset.x, 0)
      cc.fillStyle = '#ff00ff';
      cc.fillRect(r.cacheOffset.x - 12, 0, 24, 24);
      const findMark = () => {
        const d = ctx.getImageData(0, 0, r.canvas.width, r.canvas.height).data;
        for (let y = 0; y < r.canvas.height; y++)
          for (let x = 0; x < r.canvas.width; x++) {
            const i = (y * r.canvas.width + x) * 4;
            if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] > 200) return [x, y];
          }
        return null;
      };
      const proj = () => [Math.round((r.sx(0, 0) + r.cssW / 2) * r.dpr),
                          Math.round((r.sy(0, 0) + r.cssH / 2) * r.dpr)];
      r.fitToWorld();
      r.render(1);
      const markA = findMark(), projA = proj();
      r.panScreen(120, 60);
      r.render(1);
      const markB = findMark(), projB = proj();
      return { markA: markA, projA: projA, markB: markB, projB: projB };
    })()`);

    const { markA, projA, markB, projB } = probe;
    if (markA && markB) {
      // 1) метка кэша обязана лежать там же, где проекция мирового нуля
      const offErr = Math.max(Math.abs(markA[0] - projA[0]), Math.abs(markA[1] - projA[1]));
      check('кэш лежит там же, где проекция', offErr <= 10,
        `метка ${markA}, проекция ${projA}`);

      // 2) при панораме местность и объекты едут одинаково
      const moved = [markB[0] - markA[0], markB[1] - markA[1]];
      const err = Math.max(Math.abs(moved[0] - 120), Math.abs(moved[1] - 60));
      check('местность едет вместе с камерой', err <= 10,
        `земля уехала на ${moved[0]},${moved[1]} вместо 120,60`);
    } else {
      check('местность едет вместе с камерой', false, 'метка кэша не найдена на канвасе');
    }
  }

  /* --- 3. подсветка клетки ----------------------------------------- */
  {
    await mouse('mouseMoved', ...px(420, 330));
    await new Promise(r => setTimeout(r, 120));
    const hover = await js(`window.__mapgen.renderer.hover`);
    const expect = await worldAt(420, 330);
    const ok = hover && hover.x === Math.floor(expect.x) && hover.y === Math.floor(expect.y);
    check('подсветка совпадает с клеткой под курсором', ok,
      hover ? `подсвечено ${hover.x},${hover.y}, ожидалось ${Math.floor(expect.x)},${Math.floor(expect.y)}` : 'нет подсветки');
  }

  /* --- 4. клик по миникарте ---------------------------------------- */
  {
    const mmRect = await js(`(() => { const r = document.getElementById('mm').getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);
    // Цель — внутри карты, иначе камера честно встанет за её пределами
    const target = { x: 44, y: 20 };
    // Точку на миникарте считает сам рендер: если считать её в тесте
    // отдельной формулой, тест проверяет формулу, а не поведение.
    const mmPoint = await js(`(() => {
      const p = window.__mapgen.renderer.worldToMM(${target.x}, ${target.y});
      return [p.x, p.y];
    })()`);
    // Переводим пиксели буфера миникарты в CSS-пиксели страницы:
    // у канваса атрибут width и его отображаемый размер могут не совпадать,
    // и тогда клик уезжает вместе с масштабом.
    const mmScale = mmRect.width / 192;
    const clickX = mmRect.left + mmPoint[0] * mmScale;
    const clickY = mmRect.top + mmPoint[1] * mmScale;
    await mouse('mousePressed', clickX, clickY);
    await mouse('mouseReleased', clickX, clickY);
    await new Promise(r => setTimeout(r, 150));
    const cam = await js(`window.__mapgen.renderer.cam`);
    const err = Math.max(Math.abs(cam.x - target.x), Math.abs(cam.y - target.y));
    check('клик по миникарте центрирует камеру', err < 2,
      `камера ${cam.x.toFixed(1)},${cam.y.toFixed(1)} против цели ${target.x},${target.y}`);
  }

  /* --- 5. стрелки и WASD ------------------------------------------- *
   *
   * Каждый сдвиг начинается с кадра игры (fitIsland): панорама теперь
   * конечна, и из произвольной точки шаг мог бы упереться в предел — тогда
   * проверялось бы не направление, а сам предел (он проверяется в 5d).
   */
  {
    const reset = () => js(`(() => { const r = window.__mapgen.renderer; r.fitIsland(); return [r.cam.x, r.cam.y]; })()`);

    await reset();
    const before = await js(`window.__mapgen.renderer.cam`);
    await key('keyDown', 'ArrowUp', 'ArrowUp', 38);
    await new Promise(r => setTimeout(r, 600));
    await key('keyUp', 'ArrowUp', 'ArrowUp', 38);
    await new Promise(r => setTimeout(r, 80));
    const after = await js(`window.__mapgen.renderer.cam`);
    // «вверх» по экрану — карта едет вниз, значит камера уходит к верхнему
    // углу карты: обе мировые координаты уменьшаются.
    check('стрелка вверх панорамирует вид вверх по экрану',
      after.y < before.y && after.x < before.x,
      `камера ${before.x.toFixed(1)},${before.y.toFixed(1)} -> ${after.x.toFixed(1)},${after.y.toFixed(1)}`);

    await reset();
    const b2 = await js(`window.__mapgen.renderer.cam`);
    await key('keyDown', 'd', 'KeyD', 68);
    await new Promise(r => setTimeout(r, 600));
    await key('keyUp', 'd', 'KeyD', 68);
    await new Promise(r => setTimeout(r, 80));
    const a2 = await js(`window.__mapgen.renderer.cam`);
    check('D панорамирует вид вправо по экрану', a2.x > b2.x && a2.y < b2.y,
      `камера ${b2.x.toFixed(1)},${b2.y.toFixed(1)} -> ${a2.x.toFixed(1)},${a2.y.toFixed(1)}`);
  }

  /* --- 5c. дрожь руки и русская раскладка -------------------------- *
   *
   * Заказчик (2026-10-24): «у друзей на Windows тупо ЛКМ не работает».
   * Причина была в пороге: он считался по СУММЕ пройденного пути и был 6 px,
   * поэтому обычная дрожь мыши (5–12 px за полсекунды) превращала клик в
   * панораму, а постановка здания срывалась. Теперь дрожь — расстояние от
   * ТОЧКИ НАЖАТИЯ, клик терпит 8 px, камера едет только после порога.
   *
   * И вторая причина: буквы сравнивались с `e.key`, а на русской раскладке
   * физическая W приходит как «ц». Имя клавиши теперь берётся по `e.code`
   * (js/keys.js), и «ц» обязана двигать камеру так же, как «w».
   */
  {
    const setup = await js(`(() => { const r = window.__mapgen.renderer;
      const b = r.world.landBounds;
      r.cam.zoom = Math.min(r.maxZoom, Math.max(r.minZoom * 1.5, 32));
      r.centerOn((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
      r.clampCamera();
      return [r.cam.x, r.cam.y]; })()`);
    const [sx, sy] = px(400, 300);
    await mouse('mousePressed', sx, sy);
    for (let i = 1; i <= 3; i++) {
      await mouse('mouseMoved', sx + i * 2, sy + Math.round(i / 2), { down: true });
    }
    await mouse('mouseReleased', sx + 6, sy + 2);
    await new Promise(r => setTimeout(r, 150));
    const afterJitter = await js(`[window.__mapgen.renderer.cam.x, window.__mapgen.renderer.cam.y]`);
    check('дрожащий клик (7 px) не уводит камеру',
      Math.abs(afterJitter[0] - setup[0]) < 1e-6 &&
      Math.abs(afterJitter[1] - setup[1]) < 1e-6,
      `${setup.map(v => v.toFixed(1)).join(',')} -> ${afterJitter.map(v => v.toFixed(1)).join(',')}`);

    /* Настоящее перетаскивание по-прежнему двигает карту: порог не должен
       съесть панораму. */
    const dragFrom = await js(`[window.__mapgen.renderer.cam.x, window.__mapgen.renderer.cam.y]`);
    await mouse('mousePressed', sx, sy);
    for (let i = 1; i <= 4; i++) {
      await mouse('mouseMoved', sx + i * 20, sy + i * 10, { down: true });
    }
    await mouse('mouseReleased', sx + 80, sy + 40);
    await new Promise(r => setTimeout(r, 150));
    const afterDrag = await js(`[window.__mapgen.renderer.cam.x, window.__mapgen.renderer.cam.y]`);
    check('перетаскивание дальше порога панорамирует',
      Math.hypot(afterDrag[0] - dragFrom[0], afterDrag[1] - dragFrom[1]) > 0.5,
      `${dragFrom.map(v => v.toFixed(1)).join(',')} -> ${afterDrag.map(v => v.toFixed(1)).join(',')}`);

    /* Русская раскладка: key — «ц», место — KeyW. */
    await js(`(() => { const r = window.__mapgen.renderer;
      r.fitIsland(); return 1; })()`);
    const cyrBefore = await js(`window.__mapgen.renderer.cam`);
    await key('keyDown', 'ц', 'KeyW', 87);
    await new Promise(r => setTimeout(r, 500));
    await key('keyUp', 'ц', 'KeyW', 87);
    await new Promise(r => setTimeout(r, 120));
    const cyrAfter = await js(`window.__mapgen.renderer.cam`);
    check('«ц» на месте W панорамирует, как «w»',
      cyrAfter.y < cyrBefore.y - 1,
      `камера ${cyrBefore.y.toFixed(1)} -> ${cyrAfter.y.toFixed(1)}`);
    check('keys.js подключён у генератора',
      await js(`!!(window.Keys && window.Keys.name({ code: 'KeyW', key: 'ц' }) === 'w')`));
  }

  /* --- 5d. предел панорамы: остров не теряется ---------------------- *
   *
   * Панорама конечна: камеру нельзя увести так, чтобы остров пропал с
   * экрана. Проверяем не числа внутри рендера, а сам инвариант: после
   * предельного сдвига в каждую сторону хоть одна клетка суши обязана
   * проецироваться в кадр, а повторный сдвиг — уже никуда не двигать.
   */
  {
    const res = await js(`(() => {
      const r = window.__mapgen.renderer, w = r.world;
      const W = w.width, H = w.height, isLand = w.isLand;
      const landOnScreen = () => {
        let n = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            if (!isLand[y * W + x]) continue;
            const sx = r.sx(x + 0.5, y + 0.5), sy = r.sy(x + 0.5, y + 0.5);
            // Полпикселя допуска: на самом пределе клетка стоит ровно на кромке.
            if (Math.abs(sx) <= r.cssW / 2 + 0.5 && Math.abs(sy) <= r.cssH / 2 + 0.5) n++;
          }
        }
        return n;
      };
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]];
      const b = w.landBounds, out = [];
      for (let i = 0; i < dirs.length; i++) {
        const d = dirs[i];
        r.cam.zoom = Math.min(r.maxZoom, r.minZoom * 1.6);
        r.centerOn((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
        const from = [r.cam.x, r.cam.y];
        r.panScreen(d[0] * 1e6, d[1] * 1e6);
        const at = [r.cam.x, r.cam.y];
        const land = landOnScreen();
        r.panScreen(d[0] * 1e6, d[1] * 1e6);
        out.push({ dir: d, land: land,
                   moved: Math.hypot(at[0] - from[0], at[1] - from[1]),
                   stuck: Math.abs(r.cam.x - at[0]) < 1e-6 && Math.abs(r.cam.y - at[1]) < 1e-6 });
      }
      return out;
    })()`);
    const land = Math.min.apply(null, res.map(r => r.land));
    const stuck = res.filter(r => !r.stuck).length;
    const moved = Math.min.apply(null, res.map(r => r.moved));
    check('на пределе панорамы остров остаётся в кадре', land >= 1,
      'минимум клеток суши в кадре: ' + land);
    check('панорама конечна: повторный сдвиг никуда не двигает', stuck === 0,
      stuck ? stuck + ' направлений без упора' : 'упор во всех ' + res.length + ' направлениях');
    check('до предела камера действительно доезжает', moved > 1,
      'минимальный сдвиг ' + moved.toFixed(1) + ' клетки');
  }

  /* --- 5b. море: волны по всей воде, суша не закрашена ------------- *
   *
   * Раньше проверялось, что блики не выходят за карту. Теперь наоборот:
   * море не кончается вместе с картой, и волны обязаны быть за её краем —
   * иначе общий план читается не как остров в море, а как кусок ландшафта
   * в пустоте. Проверяем три вещи сразу: волны вообще есть, заметная их
   * доля лежит за пределами карты, и на сушу они не заходят.
   *
   * Волны — спрайты гребней (js/waves.js), и одна фаза кадра показывает
   * только те гребни, что попали в поле зрения, поэтому здесь рисуется
   * шестьдесят фаз подряд: так видно всё, что море успевает показать.
   */
  {
    const res = await js(`(() => {
      const r = window.__mapgen.renderer, w = r.world, ctx = r.ctx;
      r.fitIsland();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, r.canvas.width, r.canvas.height);
      // Много фаз: в одной фазе в кадр попадает лишь часть гребней.
      for (let i = 0; i < 60; i++) { r.time = 1 + i * 0.05; r.drawWaterShimmer(ctx); }

      const d = ctx.getImageData(0, 0, r.canvas.width, r.canvas.height).data;
      const k = r.cam.zoom / r.cachePx, s = r.cachePx;
      let n = 0, outside = 0, onLand = 0;
      for (let y = 0; y < r.canvas.height; y += 2) {
        for (let x = 0; x < r.canvas.width; x += 2) {
          const i = (y * r.canvas.width + x) * 4;
          if (d[i] < 20 && d[i + 1] < 20 && d[i + 2] < 20) continue;
          n++;
          // Пиксель канваса -> клетка мира: ровно обратное к блиту кэша.
          const cacheX = (x / r.dpr - r.cssW / 2 - r.sx(0, 0)) / k + r.cacheOffset.x;
          const cacheY = (y / r.dpr - r.cssH / 2 - r.sy(0, 0)) / k;
          const px = cacheX - r.cacheOffset.x, py = cacheY;
          const tx = Math.floor((py * 2 + px) / s), ty = Math.floor((py * 2 - px) / s);
          if (tx < 0 || ty < 0 || tx >= w.width || ty >= w.height) { outside++; continue; }
          if (w.isLand[ty * w.width + tx]) onLand++;
        }
      }
      return { n: n, outside: outside, onLand: onLand, zoom: r.cam.zoom, minZoom: r.minZoom };
    })()`);

    check('волны на море рисуются', res.n > 2000, 'пикселей ' + res.n);
    check('волны есть и за пределами карты', res.outside > res.n * 0.3,
      `${res.outside} из ${res.n} (${(res.outside / Math.max(1, res.n) * 100).toFixed(0)} %)`);
    check('волны не заходят на сушу', res.onLand < res.n * 0.06,
      `${res.onLand} из ${res.n} (${(res.onLand / Math.max(1, res.n) * 100).toFixed(1)} %)`);
  }

  /* --- 5c. кадр игры: остров целиком и по половине диаметра моря ---- */
  {
    const frame = await js(`(() => {
      const r = window.__mapgen.renderer, w = r.world, b = w.landBounds;
      r.fitIsland();
      const v = r.viewBox(), z = r.cam.zoom;
      // Экранный габарит видимой области и габарит острова в тех же клетках.
      const vis = { w: ((v.x1 - v.x0) + (v.y1 - v.y0)) * z * 0.5,
                    h: ((v.x1 - v.x0) + (v.y1 - v.y0)) * z * 0.25 };
      const isl = { w: ((b.x1 - b.x0) + (b.y1 - b.y0)) * z * 0.5,
                    h: ((b.x1 - b.x0) + (b.y1 - b.y0)) * z * 0.25 };
      // Поля моря с каждой стороны: половина диаметра острова.
      const sideX = (vis.w - isl.w) / 2, sideY = (vis.h - isl.h) / 2;
      return { vis: vis, isl: isl, sideX: sideX, sideY: sideY, z: z, min: r.minZoom,
               css: [r.cssW, r.cssH] };
    })()`);
    const fits = frame.vis.w <= frame.css[0] + 1 && frame.vis.h <= frame.css[1] + 1;
    check('на пределе отдаления остров виден целиком', fits,
      `кадр ${frame.vis.w.toFixed(0)}×${frame.vis.h.toFixed(0)} в ${frame.css.join('×')}`);
    const seaX = frame.sideX / Math.max(1, frame.isl.w), seaY = frame.sideY / Math.max(1, frame.isl.h);
    check('по краям кадра — половина диаметра острова моря',
      Math.abs(seaX - 0.5) < 0.12 && Math.abs(seaY - 0.5) < 0.12,
      `слева/справа ${(seaX * 100).toFixed(0)} %, сверху/снизу ${(seaY * 100).toFixed(0)} %`);
    check('дальше предела отдаления камера не уходит', Math.abs(frame.z - frame.min) < 1e-6,
      `зум ${frame.z.toFixed(2)}, предел ${frame.min.toFixed(2)}`);
  }

  /* --- 6. горячие клавиши ------------------------------------------ */
  {
    const before = await js(`window.__mapgen.renderer.showGrid`);
    await key('keyDown', 'g', 'KeyG', 71);
    await key('keyUp', 'g', 'KeyG', 71);
    await new Promise(r => setTimeout(r, 100));
    const after = await js(`window.__mapgen.renderer.showGrid`);
    check('G переключает сетку', before !== after, `${before} -> ${after}`);

    await key('keyDown', 'f', 'KeyF', 70);
    await key('keyUp', 'f', 'KeyF', 70);
    await new Promise(r => setTimeout(r, 150));
    const fit = await js(`(() => { const r = window.__mapgen.renderer, w = r.world, b = w.landBounds;
      const z = r.cam.zoom;
      const island = { w: ((b.x1 - b.x0) + (b.y1 - b.y0)) * z * 0.5,
                       h: ((b.x1 - b.x0) + (b.y1 - b.y0)) * z * 0.25 };
      return { zoom: z, min: r.minZoom,
               fits: island.w <= r.cssW + 1 && island.h <= r.cssH + 1 }; })()`);
    check('F вписывает остров в экран', fit.fits && Math.abs(fit.zoom - fit.min) < 1e-6,
      'зум ' + fit.zoom.toFixed(1) + ', предел ' + fit.min.toFixed(1));
  }

  console.log('\n' + (fails ? 'ПРОВАЛЕНО проверок: ' + fails : 'все проверки управления пройдены'));
  ws.close(); killChrome();
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ошибка: ' + e.message); killChrome(); process.exit(1); });
