/* menu.js — приёмка игры (нужен Chrome).

   Проверяет то, ради чего игра заведена отдельной папкой: меню с выбором
   размера, кнопка «Играть», партия с деревней из четырёх построек и ТРЕМЯ
   жителями, строка добытых ресурсов, выезжающая панель сведений (сид и
   жители), меню построек и покупка за брёвна, панель найма в лагере лесоруба,
   счётчик брёвен деревни, доска «Меню» (не останавливает мир), фон и
   возврат в меню. И снимает кадры — их смотрит человек.

   Отдельная история — нажатие у САМОЙ КРОМКИ кнопки (edgeClickOn): на
   `:active` кнопка утапливается и уезжает из-под курсора, и раньше отпускание
   на прежнем месте доставалось родителю — нажатие видно, действия нет.
   Правило заказчика 2026-10-19 и разбор — в AGENTS.md и game/css/base.css.

   Запуск: node game/tools/menu.js [url]
   Кадры:  game/tools/out/{menu,play,village,drawer,build-menu,build-mode,
                          build-placed,villagers,hire-panel,barracks-train,
                          delivery,hover-cell,select-building,
                          narrow-hud,pause,…}.png

   Две вещи, которые тут устроены намеренно:

   1. ЧИСЛА БЕРУТСЯ У ДВИЖКА, А НЕ ПИШУТСЯ В ТЕСТЕ. Сколько мест в лагере —
      Buildings.workSlots, кто уже работает — Session.workersOf, можно ли
      нанять — Session.canHire, сколько брёвен — world.village.logs. Тест
      сверяет экран с движком, а не с копией правил: копия разошлась бы с
      движком на первой же правке, и приёмка стала бы врать.

   2. СИМУЛЯЦИЯ ИДЁТ ШАГАМИ, А НЕ «ПОДОЖДЁМ ДЕСЯТЬ СЕКУНД». Работа жителя
      занимает десятки секунд игрового времени, а ждать их в реальном времени
      приёмка не может. Поэтому шаг времени гоняется руками (Play.tick(0.1)),
      а окно браузера успевает отрисовать HUD между шагами: всплывашки и
      надписи живут в DOM и обновляются своим кадром (js/hud.js). */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] || 'file://' + path.join(__dirname, '..', 'index.html');
const OUT = path.join(__dirname, 'out');
const PORT = 9500 + (process.pid % 90);
const PROFILE = '/tmp/dsh-4tox-game-' + process.pid;

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--hide-scrollbars',
  '--window-size=1440,900', 'about:blank'
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

  let id = 1; const pending = new Map(); const errors = [];
  ws.addEventListener('close', () => {
    /* Браузер закрылся или упал — не оставляем приёмку висеть навсегда:
       каждый ждущий вызов получает ошибку и печатает её в отчёт. */
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
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64'));
    console.log('  кадр ' + name);
  };

  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const clickOn = async (sel) => {
    const r = await js(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
    })()`);
    if (!r) throw new Error('нет элемента ' + sel);
    await clickAt(r.x, r.y);
    return r;
  };
  /* Нажатие у САМОЙ КРОМКИ кнопки — с паузой между нажатием и отпусканием.

     Кнопка утапливается на :active: её коробка уезжает вниз на 2–7px
     (game/css/base.css, --press). Если отпустить мышь, пока переход ещё не
     кончился, коробка не успевает уехать, и такой клик проходит даже на
     сломанном. Поэтому здесь пауза длиннее перехода (.09s): кнопка уезжает,
     и отпускание приходится на место, с которого она уехала, — ровно тот
     случай, на который жаловались («нажатие видно, а действия нет»).

     Точка — середина по горизонтали и 1px от верхней кромки: у кнопок
     скруглённые углы, и угол — это не кромка, а её нет. */
  const edgeClickOn = async (sel) => {
    const r = await js(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + 1, w: b.width, h: b.height };
    })()`);
    if (!r) throw new Error('нет элемента ' + sel);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
    await sleep(60);                 // :hover успевает сложиться до нажатия
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(240);                // дольше перехода утапливания: кнопка уехала
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(120);
    return { x: Math.round(r.x), y: Math.round(r.y) };
  };
  const press = async (key, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  };
  const waitFor = async (expr, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 8000)) {
      if (await js(expr)) return true;
      await sleep(120);
    }
    return false;
  };
  /* Мир ищется по типу, а не по номеру в списке: порядок построек — свойство
     начала партии, и тест не должен ломаться, если он когда-нибудь станет
     другим. */
  const findBuilding = (type) => `window.__game.Play.state.buildings.find(b => window.Buildings.typeOf(b) === '${type}')`;
  const findCamp = findBuilding('lumbercamp');
  const findHouse = findBuilding('house');

  /* Один кадр HUD своими руками.

     HUD обновляет надписи не каждый кадр, а раз в 0.12 с СВОЕГО времени
     (js/hud.js: REFRESH): состояние жителя меняется раз в несколько секунд, и
     писать в DOM на каждый кадр незачем. В приёмке кадры страницы идут редко —
     главный поток занят прогонами симуляции, и requestAnimationFrame успевает
     два-три кадра в секунду. Ждать «пока само обновится» значит гадать;
     поэтому тест подаёт кадр сам — ровно так же, как подаёт шаги времени
     (Play.tick(0.1)). Вызов тот же самый, которым пользуется цикл игры
     (js/boot.js: loop → Hud.tick). */
  const hudFrame = async (n) => {
    for (let i = 0; i < (n || 1); i++) await js(`window.Hud.tick(0.25)`);
    await sleep(30);
  };

  /* Экранная точка клетки — по движку (renderer.sx/sy от центра канваса), а
     не своей формулой: иначе тест проверял бы формулу. */
  const cellPoint = async (x, y) => js(`(() => {
    const r = window.__game.Play.renderer(), b = document.getElementById('view').getBoundingClientRect();
    return { x: b.left + b.width / 2 + r.sx(${x} + 0.5, ${y} + 0.5),
             y: b.top + b.height / 2 + r.sy(${x} + 0.5, ${y} + 0.5) };
  })()`);

  /* Пустая клетка, которая СЕЙЧАС видна игроку. Точка проецируется движком и
     проверяется elementFromPoint: камера за партию уезжает, и клетка, годившаяся
     десять проверок назад, может оказаться под табличками — тогда клик «по
     пустой земле» попадал бы в панель, а не в карту, и проверка валилась бы
     не по делу. */
  const freeSpotOnScreen = async () => js(`(() => {
    const P = window.__game.Play, B = window.Buildings, r = P.renderer(), w = P.state.world;
    const view = document.getElementById('view');
    const rect = view.getBoundingClientRect();
    const c = B.clusterBounds(P.state.buildings);
    const cx = Math.round((c.x0 + c.x1) / 2), cy = Math.round((c.y0 + c.y1) / 2);
    const cands = [];
    for (let rad = 3; rad <= 18; rad += 2) {
      for (let a = 0; a < 12; a++) {
        const ang = a * Math.PI / 6;
        cands.push([cx + Math.round(Math.cos(ang) * rad), cy + Math.round(Math.sin(ang) * rad)]);
      }
    }
    for (let i = 0; i < cands.length; i++) {
      const x = cands[i][0], y = cands[i][1];
      if (x < 1 || y < 1 || x >= w.width - 1 || y >= w.height - 1) continue;
      if (!w.isLand[y * w.width + x]) continue;      // по воде не ходим и не выбираем
      if (r.buildingAt(x, y)) continue;              // и по постройкам тоже
      const px = rect.left + rect.width / 2 + r.sx(x + 0.5, y + 0.5);
      const py = rect.top + rect.height / 2 + r.sy(x + 0.5, y + 0.5);
      if (px < rect.left + 24 || px > rect.right - 24) continue;
      if (py < rect.top + 24 || py > rect.bottom - 24) continue;
      if (document.elementFromPoint(px, py) !== view) continue;
      return { x: x, y: y, px: px, py: py };
    }
    return null;
  })()`);

  /* Камера ставится на точку и сдвигается так, чтобы точка уехала ВПРАВО от
     середины экрана. Это не украшение: панель найма и таблички занимают левый
     край, и постройка под ними недосягаема для мыши. Сдвиг камеры на (−k, +k)
     двигает точку по экрану вправо на k·zoom пикселей (render.js: sx). */
  const lookAt = (wx, wy, zoom, shiftPx) => js(`(() => {
    const r = window.__game.Play.renderer();
    const k = ${shiftPx} / ${zoom};
    r.cam.zoom = ${zoom};
    r.centerOn(${wx} - k, ${wy} + k);
    return 1;
  })()`);

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });

  /* Экран загрузки живёт доли секунды (атласы читаются с диска), и поймать
     его переходом нельзя. Поэтому он показывается заново — тем же кодом
     разметки и с правдоподобным прогрессом: снимается настоящий вид экрана,
     а не его рисунок. Делается это ПОСЛЕ открытия меню: до него загрузку
     прячет сама игра, и кадр вышел бы уже без неё. */

  /* --- 1. загрузка и меню ------------------------------------------- */
  const booted = await waitFor(
    `(() => { const b = document.getElementById('boot'); const m = document.getElementById('menu');
      return !!(b && b.classList.contains('hidden') && m && !m.classList.contains('hidden')); })()`,
    20000);
  check('игра загрузилась и открыла меню', booted);
  if (!booted) { await finish(); return; }
  await sleep(700);        // меню доигрывает вход, превью досыпаются

  /* Счётчик кадров страницы. Он нужен не для скорости: HUD обновляет надписи
     своим кадром (js/boot.js: loop → Hud.tick), а тест гоняет шаги времени
     руками и подолгу держит главный поток. Если цикл страницы встанет, надписи
     замрут, и проверка «строка появилась» будет валиться загадкой — счётчик
     отличает «не успело» от «цикл умер». */
  await js(`(() => {
    if (window.__frames !== undefined) return 1;
    window.__frames = 0;
    (function step() { window.__frames++; requestAnimationFrame(step); })();
    return 1;
  })()`);

  /* Сердцебиение игрового цикла. Кадр (js/boot.js: loop) зовёт Play.draw и
     Hud.tick; если он умрёт, надписи замрут, а тест будет валить «строка не
     появилась». Счётчики печатаются в отчёте. */
  await js(`(() => {
    if (window.__loop) return 1;
    window.__loop = { hud: 0, draw: 0 };
    const ht = window.Hud.tick; window.Hud.tick = function () { window.__loop.hud++; return ht.apply(this, arguments); };
    const pd = window.Play.draw; window.Play.draw = function () { window.__loop.draw++; return pd.apply(this, arguments); };
    return 1;
  })()`);

  /* Ошибки страницы собираются ещё и изнутри неё. Кадр игрового цикла
     (js/boot.js: loop) перезапускается В КОНЦЕ, поэтому исключение внутри него
     убивает цикл молча: HUD перестаёт обновляться, а «Runtime.exceptionThrown»
     про такое сообщает не всегда — и проверка «строка появилась» валилась бы
     загадкой. Список печатается и в отчёте, и рядом с упавшей проверкой. */
  await js(`(() => {
    if (window.__errs) return 1;
    window.__errs = [];
    window.addEventListener('error', e => window.__errs.push(String(e.message) + ' @ ' + (e.filename || '') + ':' + e.lineno));
    window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason)));
    return 1;
  })()`);

  await js(`(() => {
    const b = document.getElementById('boot');
    b.classList.remove('hidden', 'leaving');
    document.getElementById('bootFill').style.width = '62%';
    document.getElementById('bootText').textContent = 'зовём жителя…';
    return 1;
  })()`);
  await sleep(140);
  await shot('boot.png');
  await js(`(() => { const b = document.getElementById('boot');
    b.classList.add('hidden'); b.classList.remove('leaving'); return 1; })()`);

  /* Заставка рисуется каждый кадр (море живёт). Стоила бы она дорого — меню
     выглядело бы красиво и работало плохо. Порог низкий намеренно: это
     проверка «не 10 кадров», а не замер производительности — на загруженной
     машине честные 60 могут просесть. */
  const fps = await js(`new Promise(res => {
    let n = 0; const t0 = performance.now();
    (function step() { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(step); else res(n); })();
  })`);
  check('заставка не тормозит', fps >= 30, fps + ' кадров в секунду');

  console.log('\nменю:');
  const menu = await js(`(() => {
    const cards = [...document.querySelectorAll('.size-card')];
    const cv = cards.map(c => c.querySelector('canvas'));
    const painted = cv.map(c => {
      // Миниатюра не пустая: в ней больше одного цвета.
      const g = c.getContext('2d');
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
      return seen.size;
    });
    const play = document.getElementById('btnPlay').getBoundingClientRect();
    return {
      sizes: cards.map(c => +c.dataset.size),
      names: cards.map(c => c.querySelector('.size-name').textContent),
      selected: cards.filter(c => c.classList.contains('selected')).map(c => +c.dataset.size),
      painted: painted,
      seed: document.getElementById('seed').value,
      playVisible: play.width > 120 && play.height > 40,
      title: document.querySelector('.game-title').textContent
    };
  })()`);
  check('в меню шесть размеров карты (48 скрыт для тестов)',
    menu.sizes.join(',') === '48,64,96,128,192,256', menu.sizes.join(', '));
  check('у размеров есть имена', menu.names.every(n => n && n.length > 2), menu.names.join(' · '));
  check('один размер выбран по умолчанию', menu.selected.length === 1, menu.selected.join(','));
  check('на карточках нарисованы острова', menu.painted.every(n => n > 3), 'цветов: ' + menu.painted.join(','));
  check('сид предложен', !!menu.seed, menu.seed);
  check('кнопка «Играть» на месте и крупная', menu.playVisible);
  check('у игры есть название', menu.title.length > 2, menu.title);

  await shot('menu.png');

  /* --- 2. выбор размера мышью --------------------------------------- */
  console.log('\nвыбор размера:');
  await clickOn('.size-card[data-size="96"]');
  await sleep(200);
  const picked = await js(`(() => {
    const c = document.querySelector('.size-card[data-size="96"]');
    const r = c.getBoundingClientRect();
    return { sel: c.classList.contains('selected'), aria: c.getAttribute('aria-checked'),
             lifted: getComputedStyle(c).transform !== 'none',
             w: Math.round(r.width), h: Math.round(r.height), topline: Math.round(r.top) };
  })()`);
  check('клик мышью выбирает размер', picked.sel && picked.aria === 'true');
  check('выбранная карточка поднята', picked.lifted);
  const others = await js(`document.querySelectorAll('.size-card.selected').length`);
  check('выбран ровно один размер', others === 1, others + ' шт.');

  /* --- нажатие у самой кромки кнопки --------------------------------- *
   * Правило заказчика 2026-10-19: кнопка срабатывает, даже если мышь стояла
   * у её верхней кромки. Раньше кнопка утапливалась, уезжала из-под курсора,
   * и отпускание доставалось родителю: нажатие видно, действия нет. Пауза
   * между нажатием и отпусканием живёт в edgeClickOn — без неё проверка была
   * бы зелёной и на сломанном (короткий клик проскакивает раньше перехода). */
  console.log('\nнажатие у кромки:');
  const seedEdge0 = await js(`document.getElementById('seed').value`);
  const diceEdge = await edgeClickOn('#dice');
  const seedEdge1 = await js(`document.getElementById('seed').value`);
  check('кнопка кубика срабатывает, нажатая у верхней кромки',
    !!seedEdge1 && seedEdge1 !== seedEdge0,
    diceEdge.x + ',' + diceEdge.y + ' · ' + seedEdge0 + ' → ' + seedEdge1);

  await edgeClickOn('.size-card[data-size="128"]');
  const edgePick = await js(`document.querySelector('.size-card.selected').dataset.size`);
  check('карточка размера срабатывает, нажатая у верхней кромки', edgePick === '128', edgePick);
  // Выбор возвращается к 96: дальше проверяется партия того размера.
  await clickOn('.size-card[data-size="96"]');
  await sleep(200);

  /* --- 3. играть ----------------------------------------------------- */
  console.log('\nпартия:');

  /* Портреты жителей рисуются из атласа (js/hud.js: paintFace). Прочитать их
     пиксели нельзя: по `file://` холст после спрайтов помечен «чужим
     источником», и getImageData бросает SecurityError (mapgen2/README.md, раздел
     «Запуск»). Поэтому ловится сам вызов drawImage: он отвечает и на «портрет
     нарисован», и на «какой кадр атласа взят» (sx, sy) — а по смене кадров
     видно, что портрет живой. Ставится это ДО партии: строки таблички
     пересобираются, и слушатель должен стоять раньше первой отрисовки. */
  await js(`(() => {
    if (window.__faces) return 1;
    window.__faces = [];
    const orig = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function () {
      const c = this.canvas;
      const row = c && c.closest ? c.closest('.villager-row') : null;
      if (row) window.__faces.push({ id: row.dataset.vid, sx: arguments[1], sy: arguments[2] });
      return orig.apply(this, arguments);
    };
    return 1;
  })()`);

  /* Партия начинается нажатием «Играть» у САМОЙ ВЕРХНЕЙ КРОМКИ: это ровно
     жалоба заказчика «игра не начинается». */
  await edgeClickOn('#btnPlay');
  const playing = await waitFor(`window.__game && window.__game.Play.state.mode === 'play'`, 15000);
  check('кнопка «Играть» начинает партию, нажатая у верхней кромки', playing);
  if (!playing) { await finish(); return; }

  /* Кадр в середине подлёта камеры: партия начинается общим планом, но
     приходит к нему от ратуши, и этот ход стоит увидеть глазами. */
  await sleep(420);
  await shot('play-arrival.png');
  await sleep(1400);      // долёт

  const started = await js(`(() => {
    const P = window.__game.Play, st = P.state, w = st.world;
    const menu = document.getElementById('menu');
    const hud = document.getElementById('hud');
    const B = window.Buildings, b = st.buildings[0];
    const fp = B.footprint(b.rot, b.type);
    const others = st.buildings.slice(1).map(o => {
      const ofp = B.footprint(o.rot, o.type);
      return { type: B.typeOf(o), variant: o.variant, x: o.x, y: o.y, fp: [ofp.w, ofp.h],
               grass: B.cells(o).every(c => w.tile[c.y * w.width + c.x] === window.WorldGen.T.GRASS) };
    });
    const hb = st.buildings[1] ? B.bounds(st.buildings[1]) : null;
    const tb = B.bounds(b);
    return {
      types: st.buildings.map(o => B.typeOf(o)),
      others: others,
      // зазор между пятном дома и пятном ратуши: дом обязан стоять рядом
      houseGap: hb ? Math.max(Math.max(hb.x0 - tb.x1, tb.x0 - hb.x1),
                              Math.max(hb.y0 - tb.y1, tb.y0 - hb.y1)) : null,
      size: w.islandSize, tiles: w.width, seed: w.seed,
      menuHidden: menu.classList.contains('hidden') || menu.classList.contains('leaving'),
      hudVisible: !hud.classList.contains('hidden'),
      buildings: st.buildings.length,
      variant: b.variant, rot: b.rot, x: b.x, y: b.y, fp: [fp.w, fp.h],
      occupants: B.occupants(w, b).length,
      yard: B.yardOccupants(w, b, 1).length,
      villagers: st.villagers.length,
      villagerOnLand: st.villagers.every(v => w.isLand[Math.floor(v.y) * w.width + Math.floor(v.x)]),
      objects: w.objects.length,
      title: document.getElementById('hudIsland').textContent
    };
  })()`);
  check('карта выбрана того размера, что просили', started.size === 96, started.tiles + '×' + started.tiles + ', домен ' + started.size);
  check('в деревне три постройки', started.buildings === 3, started.buildings + ' шт.');
  check('это ратуша, дом жителя и лагерь лесоруба',
    started.types.join(',') === 'townhall,house,lumbercamp', started.types.join(', '));
  check('дом и лагерь стоят на траве', started.others.every(o => o.grass),
    started.others.map(o => o.type + ' ' + o.fp.join('x')).join(' · '));
  check('дом жителя — рядом с ратушей', started.houseGap !== null && started.houseGap >= 0 && started.houseGap <= 2,
    'зазор ' + started.houseGap + ' клетки');
  check('это ратуша игрока: вариант C, 90°', started.variant === 'c' && started.rot === 90);
  check('под ратушей и во дворе чисто', started.occupants === 0 && started.yard === 0,
    `в пятне ${started.occupants}, во дворе ${started.yard}`);
  check('в партии три жителя, все на суше', started.villagers === 3 && started.villagerOnLand,
    started.villagers + ' чел., суша: ' + started.villagerOnLand);
  check('на карте есть лес и камни', started.objects > 400, started.objects + ' объектов');
  check('меню ушло, HUD пришёл', started.menuHidden && started.hudVisible);
  check('в панели — имя острова', started.title.indexOf(started.seed) >= 0, started.title);

  /* --- 3б. HUD: ресурсы на виду, отладка — в выезжающей панели -------- *
   * Требование заказчика: сид и список жителей — отладочная информация, её
   * место в отдельной выезжающей панели, вместе с «Следить» и «К жителю». На
   * виду остаётся строка добытых ресурсов, и у числа дров стоит настоящая
   * охапка из игры, а не значок из библиотеки. */
  console.log('\nHUD: ресурсы и сведения о деревне:');
  const hudStart = await js(`(() => {
    const res = document.getElementById('resBar');
    const img = document.getElementById('resWoodIcon');
    const drawer = document.getElementById('debugDrawer');
    const bb = drawer.getBoundingClientRect();
    return {
      resShown: !res.classList.contains('hidden') && res.getBoundingClientRect().width > 100,
      count: document.getElementById('villageLogs').textContent,
      word: document.getElementById('villageLogsWord').textContent,
      icon: { w: img.getBoundingClientRect().width, h: img.getBoundingClientRect().height,
              natural: img.naturalWidth, src: img.getAttribute('src') },
      drawerOpen: window.__game.Hud.isDrawerOpen(),
      drawerVisible: getComputedStyle(drawer).visibility,
      drawerRight: Math.round(bb.right),
      aria: drawer.getAttribute('aria-hidden')
    };
  })()`);
  check('строка добытых ресурсов на виду', hudStart.resShown && hudStart.count === '0',
    hudStart.count + ' ' + hudStart.word);
  check('рядом с числом — настоящая охапка из игры, а не библиотечный значок',
    hudStart.icon.w > 20 && hudStart.icon.h > 10 && hudStart.icon.natural > 40 &&
    hudStart.icon.src.indexOf('assets/wood.png') >= 0,
    hudStart.icon.src + ' ' + hudStart.icon.natural + ' px');
  check('сид и жители спрятаны в выезжающую панель',
    !hudStart.drawerOpen && hudStart.drawerVisible === 'hidden' &&
    hudStart.drawerRight <= 0 && hudStart.aria === 'true',
    'панель до ' + hudStart.drawerRight + ', visibility ' + hudStart.drawerVisible);

  await edgeClickOn('#btnDrawer');
  await sleep(320);
  const drawer = await js(`(() => {
    const d = document.getElementById('debugDrawer').getBoundingClientRect();
    const f = document.getElementById('btnFollow').getBoundingClientRect();
    const h = document.getElementById('btnFind').getBoundingClientRect();
    const rows = [...document.querySelectorAll('#villagerList .villager-row')];
    return {
      open: window.__game.Hud.isDrawerOpen(),
      visible: getComputedStyle(document.getElementById('debugDrawer')).visibility,
      left: Math.round(d.left), right: Math.round(d.right), top: Math.round(d.top), bottom: Math.round(d.bottom),
      seed: document.getElementById('hudIsland').textContent,
      dims: document.getElementById('hudDims').textContent,
      rows: rows.length,
      count: document.getElementById('villagerCount').textContent,
      names: rows.map(r => r.querySelector('b').textContent),
      followIn: f.left >= d.left && f.right <= d.right && f.top >= d.top && f.bottom <= d.bottom,
      findIn: h.left >= d.left && h.right <= d.right && h.top >= d.top && h.bottom <= d.bottom,
      expanded: document.getElementById('btnDrawer').getAttribute('aria-expanded'),
      vw: innerWidth, vh: innerHeight
    };
  })()`);
  check('кнопка «Деревня» у самой кромки выезжает сведения',
    drawer.open && drawer.visible === 'visible' && drawer.left >= 0 &&
    drawer.right <= drawer.vw && drawer.bottom <= drawer.vh,
    `панель ${drawer.left}..${drawer.right}, ${drawer.top}..${drawer.bottom}`);
  check('в панели сид острова и размер', drawer.seed.indexOf(started.seed) >= 0 && drawer.dims.indexOf('96') >= 0,
    drawer.seed + ' · ' + drawer.dims);
  check('в панели все жители деревни', drawer.rows === 3 && drawer.count.indexOf('3') >= 0,
    drawer.rows + ' строк, «' + drawer.count + '»: ' + drawer.names.join(' · '));
  check('«Следить» и «К жителю» лежат в панели, а не на карте', drawer.followIn && drawer.findIn);
  check('кнопка показывает, что панель открыта', drawer.expanded === 'true');
  await js(`(() => { const P = window.__game.Play; P.setFocus(P.state.villagers[0]); return 1; })()`);
  const focusedRow = await js(`document.querySelectorAll('#villagerList .villager-row.focused').length`);
  check('выбранный житель подсвечен в панели', focusedRow === 1, focusedRow + ' строк');
  await shot('drawer.png');
  await js(`window.__game.Play.setFocus(null)`);
  await press('t', 'KeyT', 84);
  await sleep(500);
  const drawerClosed = await js(`(() => ({
    open: window.__game.Hud.isDrawerOpen(),
    visible: getComputedStyle(document.getElementById('debugDrawer')).visibility
  }))()`);
  check('T закрывает панель', !drawerClosed.open && drawerClosed.visible === 'hidden',
    'открыта: ' + drawerClosed.open + ', visibility: ' + drawerClosed.visible);

  await clickOn('#btnDrawer');
  await sleep(320);
  await edgeClickOn('#btnDrawerClose');
  await sleep(500);
  const drawerX = await js(`(() => ({
    open: window.__game.Hud.isDrawerOpen(),
    visible: getComputedStyle(document.getElementById('debugDrawer')).visibility
  }))()`);
  check('крестик панели у кромки тоже закрывает её',
    !drawerX.open && drawerX.visible === 'hidden');

  /* Меню построек при нуле брёвен: карточки есть, но купить нечего — кнопки
     выключены и объясняют, сколько нужно. */
  await edgeClickOn('#btnBuild');
  await sleep(320);
  const bm = await js(`(() => {
    const menu = document.getElementById('buildMenu').getBoundingClientRect();
    const cards = [...document.querySelectorAll('#buildList .build-card')].map(c => {
      const cv = c.querySelector('canvas');
      return {
        type: c.dataset.type,
        name: c.querySelector('.build-info b').textContent,
        note: c.querySelector('.build-info i').textContent,
        price: c.querySelector('.build-price b').textContent,
        btn: c.querySelector('.build-btn').textContent,
        disabled: c.querySelector('.build-btn').disabled,
        preview: cv.width * cv.height,
        sprite: !!window.__game.Play.renderer().spritesFor(c.dataset.type)
      };
    });
    return {
      open: window.__game.Hud.isBuildMenuOpen(),
      shown: !document.getElementById('buildMenu').classList.contains('hidden'),
      left: Math.round(menu.left), right: Math.round(menu.right),
      top: Math.round(menu.top), bottom: Math.round(menu.bottom),
      vw: innerWidth, vh: innerHeight,
      cards: cards,
      expanded: document.getElementById('btnBuild').getAttribute('aria-expanded')
    };
  })()`);
  check('меню построек открывается кнопкой «Стройка»',
    bm.open && bm.shown && bm.expanded === 'true' &&
    bm.left >= 0 && bm.right <= bm.vw && bm.bottom <= bm.vh,
    `меню ${bm.left}..${bm.right}, ${bm.top}..${bm.bottom}`);
  check('в меню дом жителя, лагерь лесоруба, казарма и военный лагерь',
    bm.cards.map(c => c.type).join(',') === 'house,lumbercamp,barracks,warcamp',
    bm.cards.map(c => c.type).join(', '));
  check('казарма предлагается типом А', bm.cards[2].note.indexOf('тип А') >= 0 &&
    bm.cards[2].name === 'Казарма', bm.cards[2].name + ' · ' + bm.cards[2].note);
  check('у каждой карточки цена в брёвнах и портрет из атласа',
    bm.cards.every(c => +c.price > 0 && c.preview > 400 && c.sprite),
    bm.cards.map(c => c.type + ' ' + c.price + ' брёвен, ' + c.preview + ' px').join(' · '));
  check('при нуле брёвен кнопки выключены и говорят почему',
    bm.cards.every(c => c.disabled && c.btn === 'Мало брёвен'),
    bm.cards.map(c => c.btn).join(' · '));
  await shot('build-menu.png');
  await clickOn('#btnBuildClose');
  await sleep(200);
  check('меню построек закрывается крестиком', !(await js(`window.__game.Hud.isBuildMenuOpen()`)));

  await sleep(1700);      // долёт и проверка кадра
  const arrived = await js(`(() => {
    const r = window.__game.Play.renderer(), st = window.__game.Play.state;
    const v = r.viewBox();
    return { zoom: r.cam.zoom, min: r.minZoom, dist: Math.hypot(r.cam.x - (v.x0 + v.x1) / 2, r.cam.y - (v.y0 + v.y1) / 2) };
  })()`);
  check('камера долетела до общего плана', Math.abs(arrived.zoom - arrived.min) < 0.01,
    `зум ${arrived.zoom.toFixed(2)} против предела ${arrived.min.toFixed(2)}`);

  await shot('play.png');

  /* Кнопки зума у обзора — такие же кнопки, как «Играть»: нажатые у кромки
     они обязаны приближать и отдалять. Возврат тем же множителем ставит зум
     ровно на прежнее место, поэтому кадр дальше не ломается. */
  const zoomEdge0 = await js(`window.__game.Play.renderer().cam.zoom`);
  await edgeClickOn('#btnZoomIn');
  const zoomEdge1 = await js(`window.__game.Play.renderer().cam.zoom`);
  await edgeClickOn('#btnZoomOut');
  const zoomEdge2 = await js(`window.__game.Play.renderer().cam.zoom`);
  check('кнопки зума у кромки приближают и возвращают',
    zoomEdge1 > zoomEdge0 * 1.1 && Math.abs(zoomEdge2 - zoomEdge0) < 1e-6,
    `${zoomEdge0.toFixed(2)} → ${zoomEdge1.toFixed(2)} → ${zoomEdge2.toFixed(2)}`);

  /* Деревня на старте партии — крупно. Это то, ради чего деревня делалась, и
     проверяется оно глазами: числа (пятна, зазоры, порядок отрисовки, место
     жителя) стережёт mapgen2/tools/place.js. Кадр нужен и как память: по нему
     видно, как выглядит начало партии, если что-то в постройках поедет. */
  await js(`(() => {
    const P = window.__game.Play, r = P.renderer(), B = window.Buildings;
    const c = B.clusterBounds(P.state.buildings);
    r.cam.zoom = 72;
    r.centerOn((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2 + 1);
    return 1;
  })()`);
  await sleep(250);
  await shot('village.png');
  // Камера возвращается на общий план: дальше проверки идут про партию целиком.
  await js(`(() => { const P = window.__game.Play; P.renderer().fitIsland(); return 1; })()`);
  await sleep(150);

  /* --- 4. жители деревни: гуляют вокруг дома ------------------------- *
   * Задача 2: жителей в партии ТРИ, у каждого номер (v.id) и прописка
   * (v.home — дом или null), и гуляют они вокруг своего дома. Проверяется не
   * «житель вообще есть», а все три вещи сразу: номера, прописка и то, что
   * каждый сам себе нашёл занятие без единого нажатия игрока.

   * Круг прогулки меряется от ЯКОРЯ движка — клетки перед дверью дома
   * (villager.js: v.anchor, он же Buildings.frontSpot). Мерить от середины
   * пятна дома нельзя: дверь стоит не в середине, и та же прогулка покажется
   * на полклетки длиннее — проверка ловила бы не то, что сторожит движок. */
  console.log('\nжители деревни:');
  const wander = await js(`(() => {
    const P = window.__game.Play, st = P.state, B = window.Buildings, w = st.world;
    const anchorOf = v => {
      if (v.anchor) return v.anchor;
      const door = v.home ? B.frontSpot(v.home) : null;
      return door ? { x: door.x + 0.5, y: door.y + 0.5 } : { x: v.x, y: v.y };
    };
    /* Старожилы снимаются ДО прогона: за 30 секунд игры деревня рожает
       четвёртого, и это не должно ломать замер прогулки первых трёх. */
    const base = st.villagers.slice();
    const from = base.map(v => [v.x, v.y]);
    const states = base.map(() => new Set());
    const maxD = base.map(() => 0);
    for (let i = 0; i < 300; i++) {           // 30 секунд игрового времени
      P.tick(0.1);
      for (let k = 0; k < base.length; k++) {
        const v = base[k], a = anchorOf(v);
        states[k].add(v.state);
        maxD[k] = Math.max(maxD[k], Math.hypot(v.x - a.x, v.y - a.y));
      }
    }
    const born = st.villagers.slice(base.length);
    return {
      n: st.villagers.length,
      base: base.length,
      ids: base.map(v => v.id),
      homes: base.map(v => !!v.home),
      moved: base.map((v, k) => Math.hypot(v.x - from[k][0], v.y - from[k][1])),
      states: states.map(s => [...s].join(',')),
      maxD: maxD,
      born: born.map(v => ({ id: v.id, home: !!v.home, x: v.x, y: v.y,
                             homeHouse: v.home ? B.typeOf(v.home) : null })),
      radius: window.Villagers.WANDER_R || 10,
      onLand: st.villagers.every(v => !!w.isLand[Math.floor(v.y) * w.width + Math.floor(v.x)])
    };
  })()`);
  check('в партии начались три жителя', wander.base === 3, wander.base + ' чел.');
  check('у каждого свой номер', wander.ids.join(',') === '1,2,3', wander.ids.join(', '));
  check('каждый числится в доме', wander.homes.length === 3 && wander.homes.every(Boolean),
    wander.homes.join(', '));
  check('жители ходят сами, без игрока', wander.moved.filter(d => d > 0.5).length >= 2,
    wander.moved.map(d => d.toFixed(1)).join(' / ') + ' клетки');
  check('гуляют вокруг дома, а не по всему острову',
    wander.maxD.every(d => d <= wander.radius + 0.5),
    'дальше всего ' + Math.max(...wander.maxD).toFixed(1) + ' клетки при радиусе ' + wander.radius);
  check('и не заходят в воду', wander.onLand);
  check('за 30 секунд игры родился ровно четвёртый, и он прописан в доме',
    wander.n === 4 && wander.born.length === 1 && wander.born[0].id === 4 &&
    wander.born[0].home && wander.born[0].homeHouse === 'house',
    wander.n + ' жителей, новорождённые: ' + JSON.stringify(wander.born));

  /* --- 4б. панель сведений: все жители строками ----------------------- *
   * Требование: у каждого жителя в панели номер, ЖИВОЙ портрет (тот кадр
   * атласа, который он играет сейчас) и занятие словами. Портрет проверяется
   * не «нарисован ли», а «меняется ли»: живой он именно этим. */
  /* Родившийся на 30-й секунде уже в списке: панель обязана пересобраться без
     перезагрузки — подаём кадр HUD и снимаем портреты уже четырёх строк. */
  await hudFrame(2);
  const faceA = await js(`window.__faces.slice()`);
  for (let i = 0; i < 6; i++) {
    await js(`(() => { const P = window.__game.Play; for (let k = 0; k < 3; k++) P.tick(0.1); return 1; })()`);
    await hudFrame();       // портрет перерисовывается кадром HUD
  }
  const faceB = await js(`window.__faces.slice()`);
  const frames = (list) => {
    const by = {};
    list.forEach(f => { (by[f.id] = by[f.id] || new Set()).add(f.sx + ',' + f.sy); });
    return Object.keys(by).map(id => ({ id: id, n: by[id].size }));
  };
  const painted = frames(faceA);

  await hudFrame(2);
  const plaque = await js(`(() => {
    const rows = [...document.querySelectorAll('#villagerList .villager-row')];
    return {
      n: rows.length,
      ids: rows.map(r => r.dataset.vid),
      names: rows.map(r => r.querySelector('b').textContent),
      doing: rows.map(r => r.querySelector('i').textContent),
      boxes: rows.map(r => Math.round(r.getBoundingClientRect().width)),
      logs: document.getElementById('villageLogs').textContent,
      word: document.getElementById('villageLogsWord').textContent,
      panel: !document.getElementById('hirePanel').classList.contains('hidden')
    };
  })()`);
  check('в панели сведений все жители, включая новорождённого',
    plaque.n === 4 && plaque.ids.join(',') === '1,2,3,4',
    plaque.n + ' строк: ' + plaque.ids.join(','));
  check('у каждого номер словами',
    plaque.names.every((s, i) => s.indexOf('Житель №' + (i + 1)) === 0), plaque.names.join(' · '));
  check('у каждого нарисован портрет из атласа',
    painted.length === 4 && painted.every(p => p.n >= 1) && plaque.boxes.every(b => b > 140),
    'кадров нарисовано: ' + painted.map(p => '№' + p.id + ': ' + p.n).join(', '));
  check('портреты живые: кадр сменился',
    frames(faceA).some((p, i) => { const b = frames(faceB).find(x => x.id === p.id); return b && b.n > p.n; }),
    'кадров за 1.4 с: ' + frames(faceB).map(p => '№' + p.id + ': ' + p.n).join(', '));
  check('и занятие словами у каждого', plaque.doing.every(s => s.length > 10), plaque.doing.join(' · '));
  check('панель найма закрыта, пока лагерь не выбран', !plaque.panel);
  check('счёт в строке ресурсов начинается с нуля', plaque.logs === '0' && plaque.word === 'брёвен',
    plaque.logs + ' ' + plaque.word);

  /* Кадр для глазами-проверки: панель с тремя жителями над деревней. */
  await js(`(() => {
    const P = window.__game.Play, r = P.renderer(), B = window.Buildings, st = P.state;
    const house = st.buildings.find(b => B.typeOf(b) === 'house');
    const bb = B.bounds(house);
    r.cam.zoom = 76;
    r.centerOn((bb.x0 + bb.x1) / 2 + 1.5, (bb.y0 + bb.y1) / 2 + 1.5);
    return 1;
  })()`);
  await sleep(250);
  await shot('villagers.png');

  /* --- 5. клетка под курсором и выбор постройки ---------------------- *
   * Две возможности движка, которые игра показывает так же, как генератор
   * карт: подсветка клетки под курсором со строкой «12, 34 · Трава · роща» и
   * выбор постройки кликом (пятно обводится, в табличке — что выбрано).
   *
   * Тут же сторожится то, чего в игре быть НЕ должно: клавиша B и клик по
   * карте не ставят вторую ратушу. */
  console.log('\nклетка под курсором и выбор постройки:');

  /* Приближаемся к деревне: на общем плане клетка — это восемь пикселей, и
     подсветку в кадре не разглядеть. Проверки от зума не зависят, а кадр
     становится доказательством для глаза. Сдвиг вправо — чтобы деревня не
     легла под таблички. */
  const villageCenter = await js(`(() => {
    const P = window.__game.Play, B = window.Buildings;
    const c = B.clusterBounds(P.state.buildings);
    return { x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2 + 1 };
  })()`);
  await lookAt(villageCenter.x, villageCenter.y, 64, 250);
  await sleep(200);

  /* Клетка рядом с деревней: там игрок и водит мышью, и там подсветку видно.
     Ищется ПОСЛЕ того, как камера встала: помощник считает экранную точку, а
     камера её двигает. */
  const freeCell = await freeSpotOnScreen();
  check('нашлась свободная клетка рядом с деревней, видная игроку', !!freeCell,
    freeCell ? freeCell.x + ', ' + freeCell.y : 'нет');

  if (freeCell) {
    // Точка посчитана помощником — и он же проверил, что она попадает в канвас,
    // а не в табличку или обзор: иначе мышь до карты не дойдёт.
    const freePoint = { x: freeCell.px, y: freeCell.py };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: freePoint.x, y: freePoint.y });
    await sleep(200);
    const hover = await js(`(() => {
      const r = window.__game.Play.renderer();
      const bar = document.getElementById('cellBar');
      return { hover: r.hover, text: document.getElementById('cellText').textContent,
               shown: !bar.classList.contains('hidden') };
    })()`);
    check('подсветка совпадает с клеткой под курсором',
      !!hover.hover && hover.hover.x === freeCell.x && hover.hover.y === freeCell.y,
      hover.hover ? hover.hover.x + ',' + hover.hover.y : 'нет подсветки');
    check('под курсором видно, что это за клетка',
      hover.shown && hover.text.indexOf(freeCell.x + ', ' + freeCell.y) === 0, hover.text);
    // Строка клетки — подпись, а не кнопка: у `#hud > *` стоит
    // `pointer-events: auto`, и без явного `none` она съедала бы мышь внизу
    // экрана — ни подсветки, ни панорамы под ней.
    check('строка клетки не перехватывает мышь',
      await js(`getComputedStyle(document.getElementById('cellBar')).pointerEvents === 'none'`));
    await shot('hover-cell.png');
  }

  /* Выбор постройки: клик по ратуше. Точка берётся по её пятну — по той
     клетке, которую накрывает дом. */
  const hall = await js(`(() => {
    const P = window.__game.Play, B = window.Buildings, b = P.state.buildings[0];
    const bb = B.bounds(b);
    return { x: Math.floor((bb.x0 + bb.x1) / 2), y: Math.floor((bb.y0 + bb.y1) / 2),
             bx: b.x, by: b.y,
             type: B.typeOf(b), fp: B.footprint(b.rot, B.typeOf(b)) };
  })()`);
  const hallPoint = await cellPoint(hall.x, hall.y);
  await clickAt(hallPoint.x, hallPoint.y);
  await sleep(220);
  const chosen = await js(`(() => {
    const P = window.__game.Play, B = window.Buildings, r = P.renderer();
    const pl = document.getElementById('buildPlaque');
    return { selected: r.selected === P.state.buildings[0],
             type: r.selected ? B.typeOf(r.selected) : null,
             name: document.getElementById('buildName').textContent,
             size: document.getElementById('buildSize').textContent,
             cell: document.getElementById('buildCell').textContent,
             shown: !pl.classList.contains('hidden'),
             pick: document.getElementById('view').classList.contains('pick'),
             text: document.getElementById('cellText').textContent,
             hire: !document.getElementById('hirePanel').classList.contains('hidden') };
  })()`);
  check('клик по ратуше выбирает её', chosen.selected && chosen.shown, chosen.name);
  // Клетка в табличке — та, от которой отсчитывается пятно (левый верхний
  // угол), а не та, по которой кликнули: пятно 3 × 4 накрывает шесть клеток,
  // и «какая из них выбрана» — вопрос без ответа.
  check('в табличке — что выбрано и какое у него пятно',
    chosen.type === 'townhall' && chosen.name === 'Ратуша' &&
    chosen.size.indexOf(hall.fp.w + ' × ' + hall.fp.h) >= 0 &&
    chosen.cell.indexOf(hall.bx + ', ' + hall.by) >= 0,
    chosen.name + ' · ' + chosen.size + ' · ' + chosen.cell +
    ' (ждали пятно ' + hall.fp.w + ' × ' + hall.fp.h + ' и клетку ' + hall.bx + ', ' + hall.by + ')');
  check('у ратуши панели найма нет', !chosen.hire);
  // Рамку клетки движок под постройкой не рисует (она ложилась бы на крышу) —
  // и тогда имя постройки в строке под курсором остаётся единственным ответом
  // на вопрос «на что я показываю».
  check('под постройкой строка называет её', chosen.text.indexOf('Ратуша') >= 0, chosen.text);
  check('курсор над постройкой — прицельный', chosen.pick);

  /* Кадр для глазами-проверки: выбранная ратуша с обведённым пятном и
     табличкой. Числа стерегут проверки, а как это выглядит — вопрос к кадру. */
  await sleep(200);
  await shot('select-building.png');

  /* Клик по пустой клетке снимает выбор, а клавиша B расстановку не включает:
     в игре ратуша одна, её ставит начало партии. */
  const freeNow = await freeSpotOnScreen();
  await clickAt(freeNow ? freeNow.px : 900, freeNow ? freeNow.py : 470);
  await sleep(200);
  await press('b', 'KeyB', 66);
  await sleep(200);
  const noPlace = await js(`(() => {
    const P = window.__game.Play, r = P.renderer(), B = window.Buildings;
    const types = P.state.buildings.map(b => B.typeOf(b));
    return { buildings: P.state.buildings.length, ghost: !!r.ghost, selected: !!r.selected,
             halls: types.filter(t => t === 'townhall').length,
             plaque: !document.getElementById('buildPlaque').classList.contains('hidden'),
             crosshair: document.getElementById('view').classList.contains('placing') };
  })()`);
  check('клик по пустой клетке снимает выбор', !noPlace.selected && !noPlace.plaque);
  check('клавиша B не включает расстановку', !noPlace.crosshair && !noPlace.ghost);
  // Считаем не постройки вообще, а РАТУШИ: деревня на старте — это три
  // постройки, и «не появилась вторая ратуша» значит «ратуша по-прежнему одна».
  check('клик по карте не ставит вторую ратушу',
    noPlace.halls === 1 && noPlace.buildings === 3,
    'ратуш ' + noPlace.halls + ', всего построек ' + noPlace.buildings);

  /* --- 6. панель найма в лагере лесоруба ------------------------------ *
   * Требование: клик по лагерю открывает панель, в ней занятость «0 / 3» и
   * список жителей деревни с кнопкой на каждого. Числа берутся у движка
   * (Buildings.workSlots, Session.workersOf), а причина отказа — словами
   * Session.canHire: выключенная кнопка обязана объясняться. */
  console.log('\nпанель найма:');
  const camp = await js(`(() => {
    const B = window.Buildings, camp = ${findCamp};
    if (!camp) return null;
    const cells = B.cells(camp);
    const c = cells[Math.floor(cells.length / 2)];
    const bb = B.bounds(camp);
    return { x: c.x, y: c.y,
             cx: (bb.x0 + bb.x1) / 2, cy: (bb.y0 + bb.y1) / 2,
             slots: typeof B.workSlots === 'function' ? B.workSlots(camp) : null,
             api: typeof window.Session.canHire === 'function' &&
                  typeof window.Session.hire === 'function' &&
                  typeof window.Session.fire === 'function' &&
                  typeof window.Session.workersOf === 'function' &&
                  typeof B.workSlots === 'function' };
  })()`);
  check('в движке есть наём (Session.canHire/hire/fire, Buildings.workSlots)',
    !!(camp && camp.api), camp ? 'workSlots = ' + camp.slots : 'лагеря нет');
  check('в лагере 1 уровня три рабочих места', !!camp && camp.slots === 3, camp ? camp.slots + '' : '');

  if (camp && camp.api) {
    /* Панель занимает левый край, поэтому лагерь ставится правее середины
       экрана: иначе клик по нему не дошёл бы до карты. */
    await lookAt(camp.cx, camp.cy, 72, 340);
    await sleep(200);
    const campPoint = await cellPoint(camp.x, camp.y);
    check('лагерь виден игроку и не закрыт табличками',
      await js(`document.elementFromPoint(${campPoint.x}, ${campPoint.y}) === document.getElementById('view')`),
      Math.round(campPoint.x) + ', ' + Math.round(campPoint.y));

    await clickAt(campPoint.x, campPoint.y);
    await sleep(200);
    await hudFrame(2);
    const opened = await js(`(() => {
      const P = window.__game.Play, B = window.Buildings, r = P.renderer();
      const camp = ${findCamp};
      const panel = document.getElementById('hirePanel');
      const rows = [...document.querySelectorAll('#hireList .hire-row')];
      return {
        campSelected: r.selected === camp,
        shown: !panel.classList.contains('hidden'),
        title: document.getElementById('hireTitle').textContent,
        slots: document.getElementById('hireSlots').textContent,
        rows: rows.length,
        names: rows.map(x => x.querySelector('b').textContent),
        homes: rows.map(x => x.querySelector('i').textContent),
        buttons: rows.map(x => x.querySelector('.hire-btn').textContent),
        marks: rows.map(x => !x.querySelector('.hire-mark').classList.contains('hidden')),
        workers: window.Session.workersOf(camp, P.state.villagers).length,
        title2: document.getElementById('buildName').textContent
      };
    })()`);
    check('клик по лагерю открывает панель найма', opened.shown && opened.campSelected, opened.title);
    check('в панели имя постройки', opened.title === 'Лагерь лесоруба', opened.title);
    check('занятость считается движком: «работники 0 / 3»',
      opened.slots === 'работники 0 / 3' && opened.workers === 0, opened.slots);
    check('в панели все жители деревни, включая новорождённого',
      opened.rows === 4 && opened.names.join(',') === 'Житель №1,Житель №2,Житель №3,Житель №4',
      opened.names.join(' · '));
    check('у каждого видно прописку и занятие',
      opened.homes.every(s => /числится в доме|бездомный/.test(s) && s.length > 12), opened.homes[0]);
    check('пока никто не нанят — у всех кнопка «Нанять»',
      opened.buttons.length === 4 && opened.buttons.every(b => b === 'Нанять') &&
      opened.marks.every(m => !m), opened.buttons.join(','));

    /* Чужой житель. В «против деревни» список партии общий, и до правки
       2026-10-24 в панели найма стояли все шестнадцать врагов — под видом
       «занятых». Подкладываем одного в список и обновляем HUD: строк не
       должно прибавиться, а «работники» не должны пересчитаться. */
    const foreignHire = await js(`(() => {
      const P = window.__game.Play, st = P.state, camp = ${findCamp};
      const read = () => {
        const rows = [...document.querySelectorAll('#hireList .hire-row')];
        return { rows: rows.length, ids: rows.map(r => +r.dataset.vid),
                 slots: document.getElementById('hireSlots').textContent };
      };
      const before = read();
      const enemyCamp = { id: 'enemy-camp', type: 'lumbercamp', variant: 'a', rot: 0, owner: 1, x: 0, y: 0 };
      const enemy = Object.assign({}, st.villagers[0], {
        id: 900, owner: 1, employer: enemyCamp, home: null,
        warrior: false, trainee: false, trainingAt: null
      });
      st.villagers.push(enemy);
      window.__foreignHire = enemy;
      window.Hud.tick(0.25);
      return { before: before, after: read(),
               order: window.Session.hireOrder(camp, st.villagers).map(v => v.id) };
    })()`);
    check('чужой житель не появляется в панели найма',
      foreignHire.after.rows === foreignHire.before.rows &&
      foreignHire.after.slots === foreignHire.before.slots &&
      !foreignHire.after.ids.includes(900) && !foreignHire.order.includes(900),
      foreignHire.after.ids.join(',') + ' / ' + foreignHire.after.slots);
    await js(`(() => {
      const st = window.__game.Play.state;
      const i = st.villagers.indexOf(window.__foreignHire);
      if (i >= 0) st.villagers.splice(i, 1);
      window.__foreignHire = null;
      window.Hud.tick(0.25);
      return 1;
    })()`);

    /* Панель ловит мышь САМА: клик по её кнопке не должен ни выбирать
       постройку под панелью, ни крутить камеру. Проверяется это не
       рассуждением, а кликом мышью по координатам кнопки: до карты событие не
       доходит — курсор стоит на панели. */
    const panelBefore = await js(`(() => {
      const P = window.__game.Play, r = P.renderer();
      return { x: r.cam.x, y: r.cam.y,
               sel: r.selected === ${findCamp},
               pointer: getComputedStyle(document.getElementById('hirePanel')).pointerEvents,
               hit: (() => {
                 const b = document.getElementById('hirePanel').getBoundingClientRect();
                 const el = document.elementFromPoint(b.left + b.width / 2, b.top + 12);
                 return !!(el && document.getElementById('hirePanel').contains(el));
               })() };
    })()`);
    check('панель перехватывает мышь себе', panelBefore.pointer === 'auto' && panelBefore.hit,
      'pointer-events: ' + panelBefore.pointer);

    // Наём первого жителя — нажатием у верхней кромки кнопки: житель не
    // нанимался именно на кромке, и это проверяется тем же нажатием, что и
    // сам наём.
    await edgeClickOn('.hire-row[data-vid="1"] .hire-btn');
    await sleep(200);
    await hudFrame(2);
    const hired1 = await js(`(() => {
      const P = window.__game.Play, r = P.renderer();
      const row = document.querySelector('.hire-row[data-vid="1"]');
      const toast = [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent);
      return { slots: document.getElementById('hireSlots').textContent,
               workers: window.Session.workersOf(${findCamp}, P.state.villagers).map(v => v.id),
               btn: row.querySelector('.hire-btn').textContent,
               mark: !row.querySelector('.hire-mark').classList.contains('hidden'),
               sel: r.selected === ${findCamp},
               cam: [r.cam.x, r.cam.y],
               toast: toast.join(' | ') };
    })()`);
    check('клик по кнопке не уходит в карту: выбор и камера те же',
      hired1.sel && hired1.cam[0] === panelBefore.x && hired1.cam[1] === panelBefore.y,
      `камера ${hired1.cam[0].toFixed(2)}, ${hired1.cam[1].toFixed(2)}`);
    check('«Нанять» у верхней кромки нанимает жителя №1', hired1.workers.join(',') === '1', hired1.workers.join(','));
    check('панель показывает «работники 1 / 3»', hired1.slots === 'работники 1 / 3', hired1.slots);
    check('кнопка стала «Уволить», появилась пометка «здесь работает»',
      hired1.btn === 'Уволить' && hired1.mark, hired1.btn);
    check('наём подтверждён всплывашкой', hired1.toast.indexOf('Житель №1 нанят в лагерь лесоруба') >= 0, hired1.toast);

    await clickOn('.hire-row[data-vid="2"] .hire-btn');
    await sleep(200);
    await hudFrame(2);
    const hired2 = await js(`(() => {
      const P = window.__game.Play;
      return { slots: document.getElementById('hireSlots').textContent,
               workers: window.Session.workersOf(${findCamp}, P.state.villagers).map(v => v.id) };
    })()`);
    check('второй житель тоже нанят', hired2.workers.join(',') === '1,2', hired2.workers.join(','));
    check('и в панели «работники 2 / 3»', hired2.slots === 'работники 2 / 3', hired2.slots);

    /* Нанятые уходят к лагерю и начинают работать: проверяется по состояниям
       жителя (движок называет их сам) и по расстоянию до лагеря. Список
       рабочих состояний не выписывается: «работает» — это «не гуляет и не
       стоит», то есть состояние, которого у свободного жителя не бывает. */
    const toWork = await js(`(() => {
      const P = window.__game.Play, S = window.Session, B = window.Buildings, st = P.state;
      const camp = ${findCamp};
      const bb = B.bounds(camp);
      const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
      const hired = S.workersOf(camp, st.villagers);
      const minD = {}, states = {}, delivered = {};
      hired.forEach(v => { minD[v.id] = 1e9; states[v.id] = new Set(); delivered[v.id] = 0; });
      // 120 секунд игрового времени: дойти до лагеря, взять топор, найти
      // дерево, срубить (5 с) и донести брёвна — в замер это укладывается
      // с запасом, а меньший отрезок делал бы проверку сдач лотереей.
      for (let i = 0; i < 1200; i++) {
        P.tick(0.1);
        hired.forEach(v => {
          minD[v.id] = Math.min(minD[v.id], Math.hypot(v.x - cx, v.y - cy));
          states[v.id].add(v.state);
          delivered[v.id] = v.delivered || 0;
        });
      }
      return { minD: minD, states: Object.fromEntries(Object.entries(states).map(([k, s]) => [k, [...s].join(',')])),
               delivered: delivered,
               onLand: hired.every(v => !!st.world.isLand[Math.floor(v.y) * st.world.width + Math.floor(v.x)]) };
    })()`);
    const workStates = Object.values(toWork.states).map(s => s.split(','));
    check('нанятые уходят к лагерю', Object.keys(toWork.minD).length === 2 && Object.values(toWork.minD).every(d => d <= 3.5),
      Object.entries(toWork.minD).map(([k, d]) => '№' + k + ': ' + d.toFixed(1)).join(', '));
    check('и не гуляют, а работают',
      workStates.length === 2 && workStates.every(list => list.some(s => s && s !== 'wander' && s !== 'stand')),
      Object.values(toWork.states).join(' | '));
    check('работа идёт на суше', toWork.onLand);
    check('брёвна уже сдаются', Object.values(toWork.delivered).some(d => d > 0),
      'сдано по жителям: ' + Object.values(toWork.delivered).join(', '));

    /* Третий нанимается, а четвёртого нанимать некуда — и панель обязана
       сказать, почему. Четвёртый житель заводится движком же
       (`Villagers.create` — тот же конструктор, которым пользуется начало
       партии), но ОДИН: `Session.spawnVillagers` создал бы всех заново, а
       нанятые от этого потеряли бы работу, и проверять «мест нет» было бы
       не на ком. */
    await clickOn('.hire-row[data-vid="3"] .hire-btn');
    await sleep(200);
    await hudFrame(2);
    const full = await js(`(() => {
      const P = window.__game.Play;
      return { slots: document.getElementById('hireSlots').textContent,
               workers: window.Session.workersOf(${findCamp}, P.state.villagers).length,
               marks: [...document.querySelectorAll('#hireList .hire-mark')].filter(m => !m.classList.contains('hidden')).length };
    })()`);
    check('третий житель занял третье место', full.workers === 3 && full.slots === 'работники 3 / 3', full.slots);
    check('все три строки помечены «здесь работает»', full.marks === 3, full.marks + ' шт.');

    /* Четвёртый уже родился сам — на 30-й секунде партии. Никакого ручного
       «Villagers.create» здесь больше нет: проверяется настоящий движок. */
    const fourth = await js(`(() => {
      const P = window.__game.Play, st = P.state;
      const v4 = st.villagers.find(v => v.id === 4);
      return { ok: st.villagers.length === 4 && !!v4, ids: st.villagers.map(v => v.id),
               home: !!(v4 && v4.home), birth: st.birth,
               seconds: st.seconds };
    })()`);
    await hudFrame(2);
    const rowSeen = await js(`!!document.querySelector('.hire-row[data-vid="4"]')`);
    check('деревня выросла сама: четвёртый родился на 30-й секунде и прописан в доме',
      fourth.ok && fourth.home && fourth.birth && fourth.birth.attempts >= 1 && rowSeen,
      fourth.ok ? 'номера: ' + fourth.ids.join(',') + ' · попыток: ' + fourth.birth.attempts
        : 'жителей ' + fourth.ids.join(','));
    if (!rowSeen) {
      const diag = await js(`(() => ({
        frames: window.__frames,
        loop: window.__loop,
        errs: window.__errs,
        plaque: document.querySelectorAll('#villagerList .villager-row').length,
        panel: document.querySelectorAll('#hireList .hire-row').length,
        hidden: document.getElementById('hirePanel').classList.contains('hidden'),
        hud: document.getElementById('hud').classList.contains('hidden'),
        villagers: window.__game.Play.state.villagers.length }))()`);
      check('строка четвёртого жителя появилась в панели', false,
        'кадров ' + diag.frames + ', цикл ' + JSON.stringify(diag.loop) + ', в табличке ' + diag.plaque + ', в панели ' + diag.panel +
        ', панель скрыта: ' + diag.hidden + ', HUD скрыт: ' + diag.hud + ', жителей ' + diag.villagers +
        ', ошибки страницы: ' + JSON.stringify(diag.errs));
    }

    const row4 = await js(`(() => {
      const P = window.__game.Play, S = window.Session, B = window.Buildings, st = P.state;
      const row = document.querySelector('.hire-row[data-vid="4"]');
      if (!row) return null;
      const btn = row.querySelector('.hire-btn');
      const why = row.querySelector('.hire-why');
      const camp = ${findCamp};
      const v4 = st.villagers.find(v => v.id === 4);
      const verdict = S.canHire(camp, v4, st.villagers);
      return { disabled: btn.disabled, text: btn.textContent, title: btn.title,
               why: why.textContent, hidden: why.classList.contains('hidden'),
               reason: verdict.reason || '', ok: !!verdict.ok,
               slots: document.getElementById('hireSlots').textContent,
               rows: document.querySelectorAll('#hireList .hire-row').length };
    })()`);
    check('в панели появился четвёртый житель', !!row4 && row4.rows === 4, row4 ? row4.rows + ' строк' : 'нет строки');
    check('четвёртого нанимать некуда: кнопка выключена',
      !!row4 && row4.disabled && !row4.ok && row4.text === 'Нанять' && row4.slots === 'работники 3 / 3',
      row4 ? row4.slots + ', кнопка: ' + row4.text : '');
    check('и панель объясняет причину словами движка',
      !!row4 && !row4.hidden && row4.why === row4.reason && row4.why.length > 5,
      row4 ? '«' + row4.why + '»' : '');

    /* --- 7. счётчик брёвен ------------------------------------------- *
     * Главный счётчик деревни — брёвна: +4 за сдачу (правило движка), и число
     * в HUD обязано совпадать с world.village.logs. Всплывашка «+4» ловится
     * сразу после шага: она живёт меньше секунды и её убирает таймер.
     *
     * Слово при числе тест считает САМ, а не спрашивает у HUD: сверять
     * функцию с ней же — не проверка. Правило русское: 11..14 всегда «брёвен»,
     * дальше по последней цифре (1 — бревно, 2..4 — бревна, 0/5..9 — брёвен).
     * Числа тут растут четвёрками, но упереться могут в любое: 32 бревна —
     * такой же законный счёт, как 24. */
    const logWord = (n) => {
      const t = Math.abs(n) % 100;
      if (t >= 11 && t <= 14) return 'брёвен';
      const d = t % 10;
      if (d === 1) return 'бревно';
      if (d >= 2 && d <= 4) return 'бревна';
      return 'брёвен';
    };
    console.log('\nсчётчик брёвен:');
    // Камера — на деревню, лагерь правее табличек: всплывашка должна быть
    // видна в кадре.
    await lookAt(camp.cx, camp.cy, 72, 300);
    await sleep(200);
    await shot('hire-panel.png');

    /* Точка отсчёта берётся ЗДЕСЬ, а не «в начале партии»: пока проверялась
       работа, нанятые уже успели снести брёвна, и счёт деревни не ноль. Счёт
       сдачи — не «сколько будет», а «сколько всего», и сверять с ним надо то
       же самое число. */
    const base = await js(`(() => { const w = window.__game.Play.state.world.village;
      return { logs: w.logs, deliveries: w.deliveries }; })()`);
    check('счёт деревни — это 4 бревна за каждую сдачу, и до нас он не врал',
      base.logs === 4 * base.deliveries, base.logs + ' брёвен за ' + base.deliveries + ' сдач');

    const gains = [];
    let caught = 0, mismatch = 0, steps = 0;
    for (let slice = 0; slice < 80 && caught < 2; slice++) {
      const s = await js(`(() => {
        const P = window.__game.Play, w = P.state.world;
        const beforeD = w.village.deliveries, before = w.village.logs;
        const seen = [];
        for (let i = 0; i < 25; i++) {
          P.tick(0.1);
          document.querySelectorAll('#hud .gain').forEach(el => {
            seen.push({ text: el.textContent,
                        left: parseFloat(el.style.left) || 0,
                        top: parseFloat(el.style.top) || 0,
                        cls: el.className });
          });
        }
        const rect = document.getElementById('view').getBoundingClientRect();
        const r = P.renderer();
        const camp = ${findCamp};
        const B = window.Buildings, bb = B.bounds(camp);
        const px = rect.left + rect.width / 2 + r.sx((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2);
        const py = rect.top + rect.height / 2 + r.sy((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2);
        return { logs: w.village.logs, deliveries: w.village.deliveries,
                 dLogs: w.village.logs - before, dDeliveries: w.village.deliveries - beforeD,
                 gains: seen, campX: px, campY: py };
      })()`);
      steps += 25;
      s.gains.forEach(g => gains.push(Object.assign({ campX: s.campX, campY: s.campY }, g)));
      if (s.dDeliveries > 0) {
        // Прибавка за сдачу — РОВНО 4, и на каждую сдачу своя.
        check('за сдачу счёт растёт ровно на 4', s.dLogs === 4 * s.dDeliveries,
          '+' + s.dLogs + ' за ' + s.dDeliveries + ' сдач(у)');
        // HUD обновляется своим кадром: подаём его и сверяем с миром.
        await hudFrame();
        const shown = await js(`(() => ({
          logs: document.getElementById('villageLogs').textContent,
          word: document.getElementById('villageLogsWord').textContent,
          world: window.__game.Play.state.world.village.logs }))()`);
        if (String(shown.world) !== shown.logs) mismatch++;
        if (!caught) {
          check('число в HUD совпадает с world.village.logs', shown.logs === String(shown.world),
            shown.logs + ' против ' + shown.world);
          check('и подписано словом по числу',
            shown.word === logWord(shown.world),
            shown.world + ' ' + shown.word + ' (ждём «' + logWord(shown.world) + '»)');
        }
        caught += s.dDeliveries;
      }
      // Кадр момента сдачи — сразу после шага, пока «+4» ещё живёт над лагерем
      // (его убирает таймер через 950 мс, см. js/hud.js: GAIN_LIFE).
      if (s.gains.length) await shot('delivery.png');
    }
    check('деревня сдала брёвна', caught >= 2, caught + ' сдач(и) за ' + (steps / 10).toFixed(1) + ' с игрового времени');
    check('счёт в HUD не разошёлся с миром ни на одной сдаче', mismatch === 0, mismatch + ' расхождений');
    check('в счётчике ровно 4 бревна за каждую сдачу',
      (await js(`(() => { const w = window.__game.Play.state.world.village;
        return w.logs === 4 * w.deliveries && w.deliveries > ${base.deliveries}; })()`)),
      await js(`(() => { const w = window.__game.Play.state.world.village; return w.logs + ' брёвен за ' + w.deliveries + ' сдач'; })()`));
    check('счёт при этом только растёт', (await js(`window.__game.Play.state.world.village.logs`)) > base.logs);

    const g0 = gains.find(g => /^\+\d+$/.test(g.text));
    check('над лагерем всплывает «+4»', !!g0 && g0.text === '+4',
      gains.length ? gains.map(g => g.text).join(' ') : 'всплывашек не было');
    if (g0) {
      const dx = Math.abs(g0.left - g0.campX), dy = Math.abs(g0.top - g0.campY);
      check('и всплывает именно над лагерем', dx < 60 && dy < 90,
        `смещение ${dx.toFixed(0)}, ${dy.toFixed(0)} px от середины лагеря`);
      // Подпись не должна съедать мышь: у `#hud > *` стоит pointer-events: auto,
      // и без явного `none` цифра перехватывала бы клики над лагерем.
      check('всплывашка не перехватывает мышь', await js(`(() => {
        const d = document.createElement('div');
        d.className = 'gain';
        document.getElementById('hud').appendChild(d);
        const pe = getComputedStyle(d).pointerEvents;
        d.remove();
        return pe === 'none';
      })()`));
    }

    /* --- 8. увольнение ------------------------------------------------ *
     * Уволенный возвращается к прогулке: он больше не в списке работников
     * лагеря, панель это показывает, и через минуту игрового времени он
     * гуляет, а не стоит у лагеря. */
    console.log('\nувольнение:');
    await clickOn('.hire-row[data-vid="1"] .hire-btn');
    await sleep(280);
    const fired = await js(`(() => {
      const P = window.__game.Play, S = window.Session, st = P.state;
      const camp = ${findCamp};
      const row = document.querySelector('.hire-row[data-vid="1"]');
      const toast = [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent);
      return { workers: S.workersOf(camp, st.villagers).map(v => v.id),
               slots: document.getElementById('hireSlots').textContent,
               btn: row.querySelector('.hire-btn').textContent,
               mark: !row.querySelector('.hire-mark').classList.contains('hidden'),
               toast: toast.join(' | ') };
    })()`);
    check('«Уволить» убирает жителя из работников лагеря', fired.workers.join(',') === '2,3', fired.workers.join(','));
    check('панель показывает «работники 2 / 3»', fired.slots === 'работники 2 / 3', fired.slots);
    check('кнопка снова «Нанять», пометка снята', fired.btn === 'Нанять' && !fired.mark);
    check('увольнение подтверждено всплывашкой',
      fired.toast.indexOf('Житель №1 больше не работает в лагере') >= 0, fired.toast);

    const walkedOff = await js(`(() => {
      const P = window.__game.Play, S = window.Session, B = window.Buildings, st = P.state;
      const camp = ${findCamp};
      const bb = B.bounds(camp);
      const v = st.villagers.find(x => x.id === 1);
      const states = new Set(), from = [v.x, v.y];
      let minD = 1e9, last = 1e9, maxD = 0;
      for (let i = 0; i < 900; i++) {
        P.tick(0.1);
        states.add(v.state);
        const d = Math.hypot(v.x - (bb.x0 + bb.x1) / 2, v.y - (bb.y0 + bb.y1) / 2);
        minD = Math.min(minD, d); last = d; maxD = Math.max(maxD, d);
      }
      const solid = window.Villagers.blockedMap(st.world, st.buildings);
      const spawn = window.Villagers.spawnSpot(st.world, solid, v.x, v.y, v.avoid);
      return { states: [...states].join(','), state: v.state, minD: minD, last: last,
               maxD: maxD, moved: Math.hypot(v.x - from[0], v.y - from[1]),
               workers: S.workersOf(camp, st.villagers).map(x => x.id),
               onLand: !!st.world.isLand[Math.floor(v.y) * st.world.width + Math.floor(v.x)],
               x: +v.x.toFixed(2), y: +v.y.toFixed(2), anchor: v.anchor,
               walkable: window.Villagers.walkable(st.world, solid, Math.floor(v.x), Math.floor(v.y)),
               spawn: spawn,
               plan: window.Villagers.planWander(v, st.world, solid) };
    })()`);
    check('уволенный вернулся к прогулке',
      walkedOff.states.indexOf('wander') >= 0 &&
      (walkedOff.state === 'wander' || walkedOff.state === 'stand'),
      'состояния: ' + walkedOff.states);
    /* Угол пятна лагеря 3x3 — 2.12 клетки от центра, середина стороны — 1.5;
       2.0 значит «вышел за середину двора». Берём МАКСИМУМ за прогулку, а не
       точку в конце: за 90 с житель успевает уйти и вернуться, и проверка
       «он не работает в лагере» не должна зависеть от того, куда его
       занесло к последнему тику. */
    check('и ушёл от лагеря', walkedOff.maxD > 2.0 && walkedOff.moved > 1.5,
      'дальше всего ' + walkedOff.maxD.toFixed(1) + ' клетки от лагеря, прошёл ' +
        walkedOff.moved.toFixed(1) + ', в конце ' + walkedOff.last.toFixed(1));
    check('в лагере остались двое', walkedOff.workers.join(',') === '2,3', walkedOff.workers.join(','));

    /* --- 9. панель закрывается ---------------------------------------- *
     * Esc снимает выбор (и панель вместе с ним), клик по пустой земле — тоже.
     * Порядок ступеней у Esc тот же, что был: сначала выбор, потом меню. */
    console.log('\nпанель закрывается:');
    const campPoint2 = await cellPoint(camp.x, camp.y);
    await clickAt(campPoint2.x, campPoint2.y);
    await sleep(250);
    check('клик по лагерю снова открывает панель',
      await js(`!document.getElementById('hirePanel').classList.contains('hidden')`));
    await press('Escape', 'Escape', 27);
    await sleep(300);
    const escaped = await js(`(() => {
      const P = window.__game.Play, r = P.renderer();
      return { panel: !document.getElementById('hirePanel').classList.contains('hidden'),
               selected: !!r.selected,
               plaque: !document.getElementById('buildPlaque').classList.contains('hidden'),
               pause: !document.getElementById('pause').classList.contains('hidden') };
    })()`);
    check('Esc закрывает панель и снимает выбор', !escaped.panel && !escaped.selected && !escaped.plaque);
    check('и меню при этом не открывает', !escaped.pause);

    const campPoint3 = await cellPoint(camp.x, camp.y);
    await clickAt(campPoint3.x, campPoint3.y);
    await sleep(250);
    const reopened = await js(`!document.getElementById('hirePanel').classList.contains('hidden')`);
    // Клетка ищется заново: камера с начала раздела уехала (слежение, зум), и
    // прежняя точка могла оказаться под табличками.
    const freeNow2 = await freeSpotOnScreen();
    await clickAt(freeNow2 ? freeNow2.px : 900, freeNow2 ? freeNow2.py : 470);
    await sleep(280);
    const clickedAway = await js(`(() => ({
      panel: !document.getElementById('hirePanel').classList.contains('hidden'),
      selected: !!window.__game.Play.renderer().selected }))()`);
    check('клик по пустой земле закрывает панель', reopened && !clickedAway.panel && !clickedAway.selected);

    /* --- 10. узкое окно: панель и табличка ---------------------------- *
     * В узком окне левая колонка не должна разъехаться: таблички помещаются в
     * экран, списки укорачиваются и прокручиваются, горизонтальной прокрутки
     * нет, а панель найма не наезжает на табличку деревни. */
    console.log('\nузкое окно:');
    const campPoint4 = await cellPoint(camp.x, camp.y);
    await clickAt(campPoint4.x, campPoint4.y);
    await sleep(280);
    await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 720, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    await hudFrame(2);
    const narrow = await js(`(() => {
      const res = document.getElementById('resBar').getBoundingClientRect();
      const panel = document.getElementById('hirePanel').getBoundingClientRect();
      const rows = [...document.querySelectorAll('#hireList .hire-row')].map(r => r.getBoundingClientRect());
      const vrows = [...document.querySelectorAll('#villagerList .villager-row')].map(r => r.getBoundingClientRect());
      const mm = document.getElementById('mm').getBoundingClientRect();
      return {
        vw: innerWidth, vh: innerHeight,
        res: { l: Math.round(res.left), r: Math.round(res.right), b: Math.round(res.bottom) },
        panel: { l: Math.round(panel.left), r: Math.round(panel.right), t: Math.round(panel.top), b: Math.round(panel.bottom) },
        panelShown: !document.getElementById('hirePanel').classList.contains('hidden'),
        rows: rows.length, rowW: rows.map(r => Math.round(r.width)), rowH: rows.map(r => Math.round(r.height)),
        vrows: vrows.length, vrowW: vrows.map(r => Math.round(r.width)),
        mmLeft: Math.round(mm.left),
        over: document.documentElement.scrollWidth > innerWidth + 1
      };
    })()`);
    check('в узком окне панель найма видна и помещается',
      narrow.panelShown && narrow.panel.l >= 0 && narrow.panel.r <= narrow.vw && narrow.panel.b <= narrow.vh,
      `${narrow.panel.l}..${narrow.panel.r} в ${narrow.vw}, низ ${narrow.panel.b}`);
    /* Строка ресурсов — единственное, что осталось на виду слева сверху. Она
       должна помещаться в окно, а список жителей (даже спрятанный в
       выезжающей панели) — не разъезжаться: у него настоящая ширина. */
    check('строка ресурсов не разъехалась',
      narrow.res.l >= 0 && narrow.res.r <= narrow.vw &&
      narrow.vrows === 4 && narrow.vrowW.every(w => w > 140),
      `строка до ${narrow.res.r} в ${narrow.vw}, ${narrow.vrows} строк шириной ` + narrow.vrowW.join(','));
    check('панель найма не наезжает на строку ресурсов', narrow.panel.t >= narrow.res.b - 1,
      `строка до ${narrow.res.b}, панель с ${narrow.panel.t}`);
    check('панель не накрывает обзор', narrow.panel.r < narrow.mmLeft,
      `панель до ${narrow.panel.r}, обзор с ${narrow.mmLeft}`);
    check('строки панели читаются: не уже 150 пикселей',
      narrow.rows === 4 && narrow.rowW.every(w => w > 150) && narrow.rowH.every(h => h > 24),
      narrow.rowW.join(',') + ' px');
    check('горизонтальной прокрутки нет', !narrow.over);
    await shot('narrow-hud.png');
    // Окно возвращается к прежнему размеру: дальше проверки про партию целиком.
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
  }

  /* --- 11. меню партии ---------------------------------------------- *
   * Срубленное уехало сюда из таблички: в партии на виду брёвна, а сколько
   * деревьев срублено — видно в меню. Само меню — бывшая пауза, но мир за
   * ним не встаёт (правило заказчика 2026-10-24). */
  console.log('\nменю партии:');
  await press('Escape', 'Escape', 27);       // снимает выбор/панель
  await sleep(200);
  await press('Escape', 'Escape', 27);       // и только теперь — меню
  await sleep(300);
  await hudFrame();
  const menuOpen = await js(`(() => {
    const P = window.__game.Play, w = P.state.world;
    const before = P.state.seconds;
    for (let i = 0; i < 20; i++) P.tick(0.25);
    // Доска «Меню» обновляет числа своим кадром (js/hud.js: REFRESH).
    window.Hud.tick(0.25);
    return { open: !document.getElementById('pause').classList.contains('hidden'),
             running: P.state.running, moved: P.state.seconds - before,
             mode: P.state.mode, playing: P.isPlaying(),
             seed: document.getElementById('pauseSeed').textContent,
             size: document.getElementById('pauseSize').textContent,
             logs: document.getElementById('pauseLogs').textContent,
             felled: document.getElementById('pauseFelled').textContent,
             worldLogs: w.village ? String(w.village.logs) : '0',
             worldFelled: String(P.state.felled) };
  })()`);
  check('Esc открывает меню партии', menuOpen.open);
  check('меню партии не останавливает время',
    menuOpen.running && menuOpen.moved >= 5 - 1e-6,
    menuOpen.moved.toFixed(2) + ' с за 20 шагов');
  check('в меню игровой ввод молчит, а мир идёт',
    menuOpen.mode === 'paused' && !menuOpen.playing,
    'режим ' + menuOpen.mode + ', isPlaying ' + menuOpen.playing);
  check('в меню видно, что за остров', menuOpen.seed.length > 3 && menuOpen.size.indexOf('96') >= 0,
    menuOpen.seed + ' ' + menuOpen.size);
  check('в меню видно брёвна и срубленное',
    menuOpen.logs === menuOpen.worldLogs && menuOpen.felled === menuOpen.worldFelled,
    menuOpen.logs + ' брёвен, ' + menuOpen.felled + ' срублено');
  await shot('pause.png');

  await edgeClickOn('#btnResume');
  await sleep(300);
  const resumed = await js(`(() => {
    const P = window.__game.Play, before = P.state.seconds;
    P.tick(0.5);
    return { open: !document.getElementById('pause').classList.contains('hidden'),
             running: P.state.running, grew: P.state.seconds > before };
  })()`);
  check('«Продолжить» у верхней кромки возвращает в партию',
    !resumed.open && resumed.running && resumed.grew);

  /* --- 11a. фон: вкладка/окно не отнимают время ---------------------- *
   * Браузер замораживает страницу так же, как невидимую вкладку: кадры не
   * идут, таймеры спят. Вернулись — мир обязан догнать весь отрезок по
   * стенным часам (game/js/boot.js: advance). */
  console.log('\nфон:');
  const bgBefore = await js(`({ seconds: window.__game.Play.state.seconds,
                                 wall: Date.now(), mode: window.__game.Play.state.mode })`);
  await send('Page.setWebLifecycleState', { state: 'frozen' });
  await sleep(1600);
  await send('Page.setWebLifecycleState', { state: 'active' });
  await sleep(600);
  const bgAfter = await js(`({ seconds: window.__game.Play.state.seconds,
                                wall: Date.now(), running: window.__game.Play.state.running,
                                mode: window.__game.Play.state.mode })`);
  const bgWall = (bgAfter.wall - bgBefore.wall) / 1000;
  const bgGrew = bgAfter.seconds - bgBefore.seconds;
  check('после фона партия догнала прошедшее время',
    bgBefore.mode === 'play' && bgAfter.running && bgGrew >= bgWall - 0.5,
    'прошло ' + bgWall.toFixed(2) + ' с, партия прибавила ' + bgGrew.toFixed(2) + ' с');

  /* --- 12. новый остров и возврат в меню ----------------------------- *
   * Смена острова — кнопкой в меню, а не вызовом __game.newIsland(): у
   * заказчика «карта не меняется» было тем же отказом кнопки на кромке.
   * Меню открывает кнопка «Меню» в углу, тоже нажатая у кромки. */
  console.log('\nсмена острова:');
  await edgeClickOn('#btnPause');
  await sleep(300);
  const pauseEdge = await js(`(() => ({
    open: !document.getElementById('pause').classList.contains('hidden'),
    running: window.__game.Play.state.running }))()`);
  check('кнопка «Меню» у кромки открывает меню', pauseEdge.open && pauseEdge.running);

  const seedBefore = await js(`window.__game.Play.state.world.seed`);
  await edgeClickOn('#btnNewIsland');
  await sleep(400);
  const fresh = await js(`(() => {
    const P = window.__game.Play, st = P.state;
    return { seed: st.world.seed, size: st.world.islandSize,
             buildings: st.buildings.length, villagers: st.villagers.length,
             seconds: st.seconds, felled: st.felled, logs: st.logs,
             deliveries: st.deliveries,
             pause: !document.getElementById('pause').classList.contains('hidden') };
  })()`);
  check('«Новый остров» у кромки даёт другой сид', fresh.seed !== seedBefore,
    seedBefore + ' → ' + fresh.seed);
  check('и закрывает меню', !fresh.pause);
  check('размер при этом сохраняется', fresh.size === 96, fresh.size + '');
  check('на новом острове снова деревня из четырёх построек и три жителя',
    fresh.buildings === 3 && fresh.villagers === 3, fresh.buildings + ' построек, ' + fresh.villagers + ' жителя');
  // Партия с этого мгновения идёт, поэтому «ноль» — это «меньше секунды»:
  // между стартом и этим чтением успевает пройти несколько кадров.
  check('счёт партии начат заново', fresh.seconds < 1.5 && fresh.felled === 0 && fresh.logs === 0,
    fresh.seconds.toFixed(2) + ' с, ' + fresh.logs + ' брёвен, ' + fresh.deliveries + ' сдач');

  await js(`window.__game.toMenu()`);
  await sleep(600);
  const back = await js(`(() => {
    const P = window.__game.Play;
    const before = P.state.seconds;
    for (let i = 0; i < 20; i++) P.tick(0.25);
    return { menu: !document.getElementById('menu').classList.contains('hidden'),
             hud: document.getElementById('hud').classList.contains('hidden'),
             running: P.state.running, moved: P.state.seconds - before,
             panel: !document.getElementById('hirePanel').classList.contains('hidden'),
             card: document.querySelector('.size-card.selected').dataset.size };
  })()`);
  check('возврат в меню показывает меню и прячет HUD', back.menu && back.hud);
  check('в главном меню время мира идёт',
    back.running && back.moved >= 5 - 1e-6, back.moved.toFixed(2) + ' с за 20 шагов');
  check('в меню панели найма нет', !back.panel);
  check('в меню подсвечен размер прошлой партии', back.card === '96', back.card);

  /* Возврат в меню — отдельный кадр: за доской должен остаться ТОТ САМЫЙ
     остров, на котором играли, а не новая заставка. */
  await shot('menu-return.png');

  /* --- 13. узкое окно: меню ------------------------------------------ */
  console.log('\nузкое окно (меню):');
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 720, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const narrowMenu = await js(`(() => {
    const b = document.querySelector('.menu-board').getBoundingClientRect();
    const g = document.querySelector('.size-grid').getBoundingClientRect();
    return { bx: Math.round(b.left), br: Math.round(b.right), bw: Math.round(b.width),
             cols: getComputedStyle(document.querySelector('.size-grid')).gridTemplateColumns.split(' ').length,
             gx: Math.round(g.left), gr: Math.round(g.right), vw: innerWidth,
             over: document.documentElement.scrollWidth > innerWidth + 1 };
  })()`);
  check('доска меню помещается в окно', narrowMenu.bx >= 0 && narrowMenu.br <= narrowMenu.vw,
    `${narrowMenu.bx}..${narrowMenu.br} в ${narrowMenu.vw}`);
  check('карточки перестроились в два столбца', narrowMenu.cols === 2, narrowMenu.cols + ' столбца');
  check('горизонтальной прокрутки нет', !narrowMenu.over);
  await shot('menu-small.png');

  /* --- 14. правка постройки ------------------------------------------ *
   * Удержание ЛКМ по постройке открывает правку: её можно подвинуть,
   * повернуть, снести (кроме ратуши), применить или отменить. Правила —
   * движковые (Buildings.EDIT/checkAt, проверены в mapgen2/tools/game.js);
   * здесь проверяется то, чего там нет: сам жест, состояние партии, полоса
   * кнопок и то, что после переезда дома карта проходимости знает новое пятно,
   * а старое — свободно.
   *
   * Ввод — только настоящими событиями (Input.dispatchMouseEvent):
   * обработчики зовут setPointerCapture, и на синтетическом new MouseEvent он
   * падает.
   *
   * Раздел идёт последним и начинается с нового острова: предыдущие разделы
   * довели партию до узкого окна и выбранного лагеря, и проверять жест на этом
   * состоянии значило бы проверять не то. */
  console.log('\nправка постройки:');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  /* Смена окна через CDP не присылает странице события resize, а размер полотна
     у движка берётся из него (renderer.cssW/cssH). Без этой строки движок
     считает экран прежним (760 x 720 из прошлого раздела), и точка клетки,
     посчитанная тестом, попадает в другую клетку — жест промахивается.
     В настоящем браузере окно меняется с событием, и строка не нужна. */
  await js(`window.__game.Play.resize()`);
  /* Партия начинается тем же входом, что у кнопки «Играть» (__game.start):
     он и меню закрывает, и мир собирает. Сид постоянный — деревня и её
     окрестности у приёмки должны быть одни и те же от прогона к прогону.
     Часы тут же отодвигаются вперёд: время теперь стенное, и пока тест
     разглядывает правку, деревня успела бы нарожать жителей. Рождение
     проверяется своим разделом 15. */
  await js(`(() => {
    window.__game.start('правка-постройки-100', 64);
    window.__game.Play.state.birth = { next: 1e9, attempts: 0 };
    return 1;
  })()`);
  await sleep(500);
  await js(`window.__game.Play.fit()`);       // полёт камеры отменяем: он увёл бы кадр
  await js(`(() => {
    window.__editEvents = [];
    window.__game.Play.on(function (e) {
      if (e.type === 'edit' || e.type === 'edit-note') window.__editEvents.push(e);
    });
    return 1;
  })()`);

  const holdMs = await js(`window.__game.Play.EDIT_HOLD_MS`);
  check('сколько держать ЛКМ — одно число на оба жеста', holdMs === 500, holdMs + ' мс');
  const hint = await js(`document.getElementById('hintBar').textContent`);
  check('в подсказках есть удержание', hint.indexOf('удержать') >= 0);
  const revStart = await js(`window.__game.Play.state.world._buildRev || 0`);

  /* Удержание по постройке — настоящими событиями. Открытия ждём, а не «спим
     ровно полсекунды»: страница занята кадром и симуляцией, и таймер удержания
     может сработать на десятки миллисекунд позже. Зато по времени видно, что
     открылось именно удержание (>= EDIT_HOLD_MS), а не клик: клик проверен выше
     и правку не открывает. */
  const holdOn = async (cx, cy) => {
    const p = await cellPoint(cx, cy);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    const t0 = Date.now();
    const open = await waitFor(`!!window.__game.Play.state.edit`, 5000);
    const ms = Date.now() - t0;
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(200);
    return { open: open, ms: ms, pt: p };
  };

  // Дом и ратуша стоят рядом: обе видны в одном кадре, и жест проверяется на
  // обеих. Сдвиг вправо — чтобы дом не оказался под левыми табличками.
  const houseAt = await js(`(() => {
    const B = window.Buildings, b = ${findHouse};
    const fp = B.footprint(b.rot, b.type);
    return { x: b.x, y: b.y, rot: b.rot, w: fp.w, h: fp.h };
  })()`);
  await lookAt(houseAt.x + 1.5, houseAt.y + 1, 30, 120);
  await sleep(200);

  const pressPt = await cellPoint(houseAt.x + 1, houseAt.y);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pressPt.x, y: pressPt.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pressPt.x, y: pressPt.y, button: 'left', clickCount: 1 });
  // Короткое нажатие (четверть секунды — вдвое короче удержания) правку НЕ
  // открывает: клик по постройке остаётся выбором, каким и был, — иначе режим
  // открывался бы каждым кликом.
  await sleep(250);
  const shortHold = await js(`!!window.__game.Play.state.edit`);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pressPt.x, y: pressPt.y, button: 'left', clickCount: 1 });
  await sleep(250);
  const shortClick = await js(`(() => {
    const P = window.__game.Play, r = P.renderer(), B = window.Buildings;
    return { edit: !!P.state.edit,
             selected: !!(r.selected && B.typeOf(r.selected) === 'house'),
             plaque: !document.getElementById('buildPlaque').classList.contains('hidden') };
  })()`);
  check('короткий клик постройку выбирает, а правку не открывает',
    shortHold === false && shortClick.edit === false && shortClick.selected && shortClick.plaque);

  // Настоящее удержание: держим ЛКМ и не двигаем мышь — постройка идёт за курсором.
  const holdT0 = Date.now();
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pressPt.x, y: pressPt.y, button: 'left', clickCount: 1 });
  const held = await waitFor(`!!window.__game.Play.state.edit`, 5000);
  const heldMs = Date.now() - holdT0;
  const opened = await js(`(() => {
    const P = window.__game.Play, r = P.renderer(), st = P.state, B = window.Buildings;
    const bar = document.getElementById('editBar');
    const ids = ['editMove', 'editRotate', 'editDelete', 'editApply', 'editCancel'];
    const b = st.edit && st.edit.building;
    const info = window.__editEvents.filter(function (e) { return e.type === 'edit'; }).pop();
    const fp = b ? B.footprint(b.rot, b.type) : null;
    const type = b ? B.TYPES[B.typeOf(b)] : null;
    return {
      edit: !!st.edit, mode: st.edit && st.edit.mode,
      house: b && B.typeOf(b) === 'house',
      editing: r.editing === b,
      ghostSame: !!(r.ghost && r.ghost.b === b), ghostOnly: !!(r.ghost && r.ghost.footprintOnly),
      barShown: !bar.classList.contains('hidden'),
      buttons: ids.filter(function (id) { return !!document.getElementById(id); }).length,
      name: document.getElementById('editName').textContent,
      // Пятно и имя приезжают в событии от движка, а не считаются панелью.
      infoFp: info && info.info ? [info.info.w, info.info.h] : null,
      fp: fp && [fp.w, fp.h], engineName: type && type.name,
      canMove: info && info.info && info.info.canMove,
      canRotate: info && info.info && info.info.canRotate
    };
  })()`);
  check('удержание ЛКМ открывает правку и берёт постройку за курсор',
    held && heldMs >= holdMs && opened.edit && opened.house && opened.mode === 'move',
    'открылось через ' + heldMs + ' мс · ' + opened.mode + ' · ' + opened.name);
  check('правимая постройка — та, что ведут, и призрак — только пятно',
    opened.editing && opened.ghostSame && opened.ghostOnly);
  check('полоса правки видна со всеми пятью кнопками',
    opened.barShown && opened.buttons === 5, opened.buttons + ' кнопки');
  check('событие правки отдаёт пятно, имя и правила самого движка',
    !!opened.infoFp && opened.infoFp.join('×') === opened.fp.join('×') &&
    !!opened.engineName && opened.name.toLowerCase() === opened.engineName.toLowerCase() &&
    opened.canMove === true && opened.canRotate === true,
    opened.name + ' · пятно ' + (opened.infoFp || []).join('×'));
  await hudFrame(2);              // кадр — с жителями ЭТОЙ партии, а не прошлой
  await shot('edit-mode.png');

  const blink = await js(`(() => {
    const P = window.__game.Play, r = P.renderer(), b = P.state.edit.building;
    const other = P.state.buildings.find(function (o) { return o !== b; });
    const a = [0, 0.225, 0.45, 0.675].map(function (t) { return r.blinkAlpha(b, t); });
    return { other: r.blinkAlpha(other, 0.2),
             min: Math.min.apply(null, a), max: Math.max.apply(null, a) };
  })()`);
  check('правимая постройка мигает, соседние — нет',
    blink.other === 1 && Math.abs(blink.min - 0.55) < 0.01 && Math.abs(blink.max - 1) < 0.01,
    blink.min.toFixed(2) + '..' + blink.max.toFixed(2) + ', сосед ' + blink.other);

  /* Куда вести: место рядом, которое ДВИЖОК считает годным (своего правила тест
     не придумывает). Курсор при этом встаёт так, чтобы постройка попала ровно в
     это место при том же захвате, что был при нажатии.

     Из годных мест предпочитается ЗАРОСШЕЕ (в пятне есть куст или трава): на
     нём проверяется правило заказчика 2026-10-17 — мелочь переезду не мешает,
     а сминается по «Применить». Если заросшего места рядом нет, тест идёт на
     чистое, и проверки про мелочь честно пропускаются (`mp.weeds === 0`). */
  await js(`window.__miniVer = window.__game.Play.renderer().minimapVersion || 0; 1`);
  const movePlan = await js(`(() => {
    const P = window.__game.Play, B = window.Buildings;
    const b = P.state.edit.building, w = P.state.world, list = P.state.buildings;
    const grab = { x: ${houseAt.x + 1} - b.x, y: ${houseAt.y} - b.y };
    let clean = null;
    for (let d = 2; d <= 6; d++) {
      const cands = [[d, 0], [0, d], [d, d], [0, -d], [-d, 0], [d, -d]];
      for (let k = 0; k < cands.length; k++) {
        const sp = { x: b.x + cands[k][0], y: b.y + cands[k][1] };
        const chk = B.checkAt(w, list, b, sp);
        if (!chk.ok) continue;
        if (chk.decor.length) {
          return { x: sp.x, y: sp.y, grab: grab, weeds: chk.decor.length,
                   kinds: chk.decor.map(function (o) { return o.kind; }) };
        }
        if (!clean) clean = { x: sp.x, y: sp.y, grab: grab, weeds: 0, kinds: [] };
      }
    }
    return clean;
  })()`);
  check('рядом с домом есть место, годное для переезда', !!movePlan);
  const mp = movePlan || { x: houseAt.x, y: houseAt.y, grab: { x: 1, y: 0 } };
  const dstPt = await cellPoint(mp.x + mp.grab.x, mp.y + mp.grab.y);
  /* Мир до ведения: сколько в нём объектов и мелочи. Ведение дома за курсором
     мира менять не должно — мелочь сминается только по «Применить». */
  const worldBefore = await js(`(() => { const w = window.__game.Play.state.world;
    return { objects: w.objects.length, decor: w.stats.decor, trees: w.stats.trees }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dstPt.x, y: dstPt.y,
    button: 'left', buttons: 1 });
  await sleep(200);
  const dragged = await js(`(() => {
    const P = window.__game.Play, r = P.renderer(), st = P.state, B = window.Buildings;
    const b = st.edit.building;
    const W = P.state.world.width;
    const solid = window.Villagers.blockedMap(P.state.world, P.state.buildings);
    const info = window.__editEvents.filter(function (e) { return e.type === 'edit'; }).pop();
    return {
      moved: b.x === ${mp.x} && b.y === ${mp.y}, at: [b.x, b.y],
      changed: st.edit.changed, valid: st.edit.valid,
      order: r._order, sameMini: (r.minimapVersion || 0) === window.__miniVer,
      ghostSame: !!(r.ghost && r.ghost.b === b),
      solid: B.cells(b).every(function (c) { return solid[c.y * W + c.x] === 1; }),
      yardWarn: info && info.info && info.info.yardWarn,
      objects: st.world.objects.length, decor: st.world.stats.decor
    };
  })()`);
  check('ведение ставит постройку в новое место через движок (setSpot)',
    dragged.moved, 'ждём ' + mp.x + ',' + mp.y + ', стоит ' + dragged.at.join(','));
  check('ведение сбрасывает порядок отрисовки, но не пересобирает обзор',
    dragged.order === null && dragged.sameMini);
  check('правка отмечена как изменение, пятно осталось годным',
    dragged.changed === true && dragged.valid === true, 'предупреждение: ' + (dragged.yardWarn || 'нет'));
  check('карта проходимости уже знает новое пятно', dragged.solid);
  check('место, заросшее мелочью, для переезда годится (2026-10-17)',
    mp.weeds === 0 || dragged.valid === true,
    mp.weeds ? 'в пятне мелочи ' + mp.weeds + ' (' + mp.kinds.join(', ') + '), место всё равно годное'
             : 'рядом заросшего места не нашлось');
  check('ведение НЕ косит луг: мир за время перетаскивания не изменился',
    dragged.objects === worldBefore.objects && dragged.decor === worldBefore.decor,
    'объектов ' + worldBefore.objects + ' -> ' + dragged.objects +
    ', мелочи ' + worldBefore.decor + ' -> ' + dragged.decor);

  /* Под ведомым домом мелочи не видно (правило заказчика 2026-10-18): куст из
     пятна не рисуется, хотя в мире он ещё есть, — прячет отрисовка
     (render.js: coverMask), и «Отменить» вернёт дом на целый луг. Проверяется
     обеими половинами сразу: в клетках пятна и двора мелочь В МИРЕ есть, а в
     обход отрисовки из этих клеток не попадает ничего. Счёт один на все три
     состояния дома — ведут, поставили, применили: правило одно и то же. */
  await js(`window.__coverReport = function (b) {
    const B = window.Buildings, w = window.__game.Play.state.world, r = window.__game.Play.renderer();
    const cover = {}, cells = B.coverCells(b);
    for (const c of cells) cover[c.y * w.width + c.x] = 1;
    const cell = (o) => cover[Math.floor(o.y) * w.width + Math.floor(o.x)];
    const inWorld = w.objects.filter(cell);
    const drawn = [];
    r.eachSprite((o) => drawn.push(o), () => {}, () => {});
    return { cover: cells.length, yard: B.YARD,
             world: inWorld.length, worldDecor: inWorld.filter(B.decor).length,
             drawn: drawn.filter(cell).length,
             drawnDecor: drawn.filter((o) => cell(o) && B.decor(o)).length,
             objects: w.objects.length, decor: w.stats.decor };
  }; 1`);
  const hidden = await js(`window.__coverReport(window.__game.Play.state.edit.building)`);
  check('под ведомым домом и в клетке вокруг мелочь не рисуется (2026-10-18)',
    hidden.drawnDecor === 0 && (mp.weeds === 0 || hidden.worldDecor > 0),
    mp.weeds
      ? 'в клетках пятна и двора (' + hidden.cover + ', двор ' + hidden.yard + ') мелочи в мире ' +
        hidden.worldDecor + ', нарисовано её ' + hidden.drawnDecor
      : 'место под домом чистое, мелочи в мире ' + hidden.worldDecor);

  // Отпускание ЛКМ — «поставить»: здание встало, режим остался открытым.
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dstPt.x, y: dstPt.y, button: 'left', clickCount: 1 });
  await sleep(250);
  const placed = await js(`(() => {
    const P = window.__game.Play, r = P.renderer(), st = P.state;
    const b = st.edit.building;
    return { mode: st.edit.mode, ghost: r.ghost, editing: r.editing === b,
             at: [b.x, b.y], bar: !document.getElementById('editBar').classList.contains('hidden'),
             objects: st.world.objects.length, decor: st.world.stats.decor };
  })()`);
  check('отпускание ЛКМ ставит постройку, режим остаётся открытым',
    placed.mode === 'idle' && placed.ghost === null && placed.editing && placed.bar,
    placed.mode + ' · ' + placed.at.join(','));
  check('и «поставить» луг не косит: мир ждёт «Применить»',
    placed.objects === worldBefore.objects && placed.decor === worldBefore.decor,
    'объектов ' + placed.objects + ', мелочи ' + placed.decor);
  const hiddenPlaced = await js(`window.__coverReport(${findHouse})`);
  check('и у поставленного дома (ждёт «Применить») под ним мелочи не видно',
    hiddenPlaced.drawnDecor === 0 && (mp.weeds === 0 || hiddenPlaced.worldDecor > 0),
    'в мире в клетках дома мелочи ' + hiddenPlaced.worldDecor +
    ', нарисовано её ' + hiddenPlaced.drawnDecor);
  /* Кадр ровно того состояния, из-за которого правило и заведено: дом стоит
     там, куда его перевели, правка ещё не применена, а под домом был куст. */
  await shot('edit-dropped.png');

  /* Пока правка не применена, удержание по ДРУГОЙ постройке отклоняется
     словами: молча схватить второе здание значило бы потерять первое. */
  const thAt = await js(`(() => {
    const B = window.Buildings, b = ${findBuilding('townhall')};
    const fp = B.footprint(b.rot, b.type);
    return { x: b.x, y: b.y, w: fp.w, h: fp.h };
  })()`);
  const notesWas = await js(`window.__editEvents.filter(function (e) { return e.type === 'edit-note'; }).length`);
  const thPt = await cellPoint(thAt.x + 1, thAt.y + 1);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: thPt.x, y: thPt.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: thPt.x, y: thPt.y, button: 'left', clickCount: 1 });
  const noted = await waitFor(
    `window.__editEvents.filter(function (e) { return e.type === 'edit-note'; }).length > ${notesWas}`, 5000);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: thPt.x, y: thPt.y, button: 'left', clickCount: 1 });
  await sleep(200);
  const second = await js(`(() => {
    const st = window.__game.Play.state, B = window.Buildings;
    const notes = window.__editEvents.filter(function (e) { return e.type === 'edit-note'; });
    return { stillHouse: B.typeOf(st.edit.building) === 'house', mode: st.edit.mode,
             notes: notes.length, text: notes.length ? notes[notes.length - 1].text : '' };
  })()`);
  check('удержание по другой постройке отклоняется фразой, а не молча',
    noted && second.stillHouse && second.notes > 0 && second.text.length > 0, second.text);

  // «Применить» — единственное, что фиксирует правку и пересобирает обзор;
  // нажимается у верхней кромки, как и остальные кнопки.
  const beforeApply = await js(`(() => ({ rev: window.__game.Play.state.world._buildRev || 0,
                                         mini: window.__game.Play.renderer().minimap }))()`);
  await edgeClickOn('#editApply');
  await sleep(300);
  const applied = await js(`(() => {
    const P = window.__game.Play, r = P.renderer(), st = P.state, B = window.Buildings;
    const b = ${findHouse};
    const W = st.world.width;
    const solid = window.Villagers.blockedMap(st.world, st.buildings);
    const fp = B.footprint(b.rot, b.type);
    const idx = [];
    for (let j = 0; j < fp.h; j++) for (let i = 0; i < fp.w; i++) idx.push((b.y + j) * W + (b.x + i));
    const oldIdx = [];
    for (let j = 0; j < ${houseAt.h}; j++) for (let i = 0; i < ${houseAt.w}; i++) oldIdx.push((${houseAt.y} + j) * W + (${houseAt.x} + i));
    return {
      edit: st.edit, editing: r.editing, bar: !document.getElementById('editBar').classList.contains('hidden'),
      at: [b.x, b.y], rev: st.world._buildRev,
      // Холст обзора теперь переиспользуется (память), поэтому «новый обзор»
      // — это выросшая версия, а не другой canvas.
      miniNew: (r.minimapVersion || 0) !== window.__miniVer,
      newSolid: idx.every(function (i) { return solid[i] === 1; }),
      oldFree: oldIdx.filter(function (i) { return idx.indexOf(i) < 0; })
                     .every(function (i) { return solid[i] === 0; }),
      ver: st.world._villagerBlocked ? st.world._villagerBlocked.version : '',
      objects: st.world.objects.length, decor: st.world.stats.decor,
      // Под вставшим домом не осталось ничего: и помех, и мелочи (crushDecor).
      under: B.occupants(st.world, b).length,
      underDecor: B.occupants(st.world, b).filter(B.decor).length,
      trees: st.world.stats.trees
    };
  })()`);
  check('«Применить» закрывает режим, полоса уходит',
    applied.edit === null && applied.editing === null && applied.bar === false);
  check('после «применить» обзор пересобран, а правка отмечена в мире',
    applied.miniNew && applied.rev > revStart, 'rev ' + revStart + ' -> ' + applied.rev);
  check('новое пятно непроходимо, старое свободно, версия карты это знает',
    applied.newSolid && applied.oldFree && applied.ver.endsWith('/' + applied.rev),
    applied.ver);
  /* Мир меняется ровно здесь и ровно на мелочь: «Применить» сминает куст и
     траву под домом и в клетке вокруг, а деревья не трогает — их правка и не
     пропускает (Buildings.checkAt). */
  check('«Применить» сминает мелочь под вставшим домом (2026-10-17)',
    applied.under === 0 && applied.trees === worldBefore.trees,
    mp.weeds ? 'в пятне было мелочи ' + mp.weeds + ', теперь объектов под домом ' + applied.under
             : 'место было чистое, под домом ' + applied.under + ' объектов');
  check('смята именно мелочь: деревьев в мире не убыло',
    applied.decor <= placed.decor && applied.trees === worldBefore.trees,
    'мелочи ' + placed.decor + ' -> ' + applied.decor +
    ', деревьев ' + worldBefore.trees + ' -> ' + applied.trees);

  /* Житель, на которого переехал дом, выходит из пятна сам. Ради этого в версии
     карты проходимости и стоит третье число (world._buildRev): без него житель
     считал бы карту прежней и ходил бы сквозь новый дом. */
  const inside = await js(`(() => {
    const P = window.__game.Play, B = window.Buildings, v = P.state.villagers[0];
    const b = ${findHouse};
    v.x = b.x + 0.5; v.y = b.y + 0.5; v.path = null;
    return { inFp: B.cells(b).some(function (c) {
      return Math.floor(v.x) === c.x && Math.floor(v.y) === c.y; }) };
  })()`);
  await js(`(() => { for (let i = 0; i < 300; i++) window.__game.Play.tick(0.1); return 1; })()`);
  const walkedOut = await js(`(() => {
    const P = window.__game.Play, v = P.state.villagers[0], w = P.state.world;
    const solid = window.Villagers.blockedMap(w, P.state.buildings);
    return { x: v.x, y: v.y, state: v.state,
             inside: solid[Math.floor(v.y) * w.width + Math.floor(v.x)] === 1 };
  })()`);
  check('житель, на которого переехал дом, выходит из пятна сам',
    inside.inFp && !walkedOut.inside,
    'клетка ' + walkedOut.x.toFixed(1) + ',' + walkedOut.y.toFixed(1) + ' · ' + walkedOut.state);

  /* Поворот и отмена: поворот меняет пятно (3 x 2 на 2 x 3), а «отменить»
     возвращает и место, и угол — то, что было на момент открытия правки. */
  const rotated = await (async () => {
    const at = await js(`(() => { const b = ${findHouse}; return [b.x, b.y]; })()`);
    await holdOn(at[0] + 1, at[1]);
    await edgeClickOn('#editRotate');
    await sleep(250);
    return js(`(() => {
      const P = window.__game.Play, B = window.Buildings, b = P.state.edit && P.state.edit.building;
      const fp = b ? B.footprint(b.rot, b.type) : null;
      return { open: !!P.state.edit, rot: b && b.rot, fp: fp && [fp.w, fp.h], changed: P.state.edit && P.state.edit.changed };
    })()`);
  })();
  check('«Повернуть» поворачивает на 90° и меняет пятно',
    rotated.open && rotated.rot === 180 && !!rotated.fp && rotated.fp.join('×') === '2×3' && rotated.changed,
    rotated.rot + '° · пятно ' + (rotated.fp ? rotated.fp.join('×') : 'нет'));
  await clickOn('#editCancel');
  await sleep(250);
  const cancelled = await js(`(() => {
    const P = window.__game.Play, st = P.state, b = ${findHouse};
    return { open: !!st.edit, rot: b.rot, at: [b.x, b.y],
             bar: !document.getElementById('editBar').classList.contains('hidden') };
  })()`);
  check('«Отменить» возвращает угол и место, режим закрыт',
    !cancelled.open && cancelled.rot === 90 && cancelled.at[0] === applied.at[0] &&
    cancelled.at[1] === applied.at[1] && !cancelled.bar,
    cancelled.rot + '° · ' + cancelled.at.join(','));

  /* Ратуша: снести нельзя, и об этом говорят и кнопка, и всплывашка — одной и
     той же фразой движка. */
  await lookAt(thAt.x + 1.5, thAt.y + 2, 32, 120);
  await sleep(200);
  await holdOn(thAt.x + 1, thAt.y + 1);
  const thRules = await js(`(() => {
    const P = window.__game.Play, B = window.Buildings;
    const info = window.__editEvents.filter(function (e) { return e.type === 'edit'; }).pop().info;
    const btn = document.getElementById('editDelete');
    return { open: !!P.state.edit, canRemove: info.canRemove, removeReason: info.removeReason,
             title: btn.title, aria: btn.getAttribute('aria-disabled'), disabled: btn.disabled,
             engine: B.canEdit(P.state.edit.building, 'remove'),
             count: P.state.buildings.length };
  })()`);
  check('у ратуши «снести» запрещено, и причина — фраза движка',
    thRules.open && thRules.canRemove === false &&
    thRules.removeReason === 'ратушу снести нельзя' &&
    thRules.title === thRules.removeReason && thRules.engine.reason === thRules.removeReason,
    thRules.removeReason);
  check('запрещённая кнопка помечена, но не глохнет молча',
    thRules.aria === 'true' && thRules.disabled === false);

  /* Второе удержание по ТОЙ ЖЕ постройке снова берёт её за курсор: режим уже
     открыт, и повторный жест значит «вести ещё раз», а не «открой второй».
     Ждём его ровно столько же (EDIT_HOLD_MS) — число одно на оба жеста, и по
     времени это видно: раньше срока здание за курсор не встаёт. */
  const retakePt = await cellPoint(thAt.x + 1, thAt.y + 1);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: retakePt.x, y: retakePt.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: retakePt.x, y: retakePt.y, button: 'left', clickCount: 1 });
  const retakeT0 = Date.now();
  const retaken = await waitFor(
    `!!window.__game.Play.state.edit && window.__game.Play.state.edit.mode === 'move'`, 5000);
  const retakeMs = Date.now() - retakeT0;
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: retakePt.x, y: retakePt.y, button: 'left', clickCount: 1 });
  await sleep(200);
  check('повторное удержание берёт то же здание за те же полсекунды',
    retaken && retakeMs >= holdMs, 'взято через ' + retakeMs + ' мс');
  await clickOn('#editDelete');
  await sleep(300);
  const thDenied = await js(`(() => {
    const P = window.__game.Play;
    const toasts = [].map.call(document.querySelectorAll('#toasts .toast'), function (t) { return t.textContent; });
    return { open: !!P.state.edit, count: P.state.buildings.length,
             toast: toasts.length ? toasts[toasts.length - 1] : '' };
  })()`);
  check('нажатие на «Снести» у ратуши объясняет причину и ничего не сносит',
    thDenied.open && thDenied.count === thRules.count &&
    thDenied.toast === 'ратушу снести нельзя', '«' + thDenied.toast + '»');

  /* Место, где стоять нельзя: вода. Клетку ищет движок (у него пятно и
     правило), а ведём туда кнопкой «Двигать» — она делает то же, что
     удержание, и проверяет вторую половину полосы. */
  const waterCell = await js(`(() => {
    const P = window.__game.Play, B = window.Buildings, w = P.state.world, list = P.state.buildings;
    const b = P.state.edit.building, fp = B.footprint(b.rot, b.type), W = w.width;
    for (let y = 1; y + fp.h < w.height; y++) {
      for (let x = 1; x + fp.w < W; x++) {
        if (w.tile[y * W + x] !== window.WorldGen.T.WATER) continue;
        if (B.checkAt(w, list, b, { x: x, y: y }).reason === 'вода') return { x: x, y: y };
      }
    }
    return null;
  })()`);
  await clickOn('#editMove');
  await lookAt(waterCell.x + 1.5, waterCell.y + 1.5, 34, 120);
  await sleep(200);
  const waterPt = await cellPoint(waterCell.x, waterCell.y);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: waterPt.x, y: waterPt.y });
  await sleep(200);
  const onWater = await js(`(() => {
    const P = window.__game.Play, st = P.state, r = P.renderer();
    const info = window.__editEvents.filter(function (e) { return e.type === 'edit'; }).pop().info;
    const b = st.edit.building;
    return { at: [b.x, b.y], valid: st.edit.valid, reason: st.edit.reason,
             infoReason: info.reason, infoValid: info.valid, mode: st.edit.mode,
             ghostOk: r.ghost && r.ghost.ok, state: document.getElementById('editState').textContent };
  })()`);
  check('на воде постройка помечена «нельзя применить», и причина — слова движка',
    onWater.valid === false && onWater.reason === 'вода' && onWater.infoReason === 'вода' &&
    onWater.infoValid === false && onWater.ghostOk === false &&
    onWater.state.indexOf('вода') >= 0,
    onWater.at.join(',') + ' · ' + onWater.reason);
  await hudFrame();
  await shot('edit-denied.png');
  await clickOn('#editApply');
  await sleep(300);
  const applyDenied = await js(`(() => {
    const P = window.__game.Play;
    const toasts = [].map.call(document.querySelectorAll('#toasts .toast'), function (t) { return t.textContent; });
    return { open: !!P.state.edit, toast: toasts.length ? toasts[toasts.length - 1] : '' };
  })()`);
  check('«Применить» на воде отказывает той же фразой',
    applyDenied.open && applyDenied.toast === 'вода', '«' + applyDenied.toast + '»');

  // Тычок мимо при несохранённых правках: режим не закрывается молча.
  const away = await js(`(() => {
    const P = window.__game.Play, r = P.renderer();
    const view = document.getElementById('view'), rect = view.getBoundingClientRect();
    const b = P.state.edit.building;
    for (let d = 4; d <= 12; d++) {
      const cands = [[d, 0], [0, d], [d, d], [-d, 0], [0, -d]];
      for (let k = 0; k < cands.length; k++) {
        const x = b.x + cands[k][0], y = b.y + cands[k][1];
        if (r.buildingAt(x, y)) continue;
        const px = rect.left + rect.width / 2 + r.sx(x + 0.5, y + 0.5);
        const py = rect.top + rect.height / 2 + r.sy(x + 0.5, y + 0.5);
        if (px < rect.left + 20 || px > rect.right - 20) continue;
        if (py < rect.top + 20 || py > rect.bottom - 20) continue;
        if (document.elementFromPoint(px, py) !== view) continue;
        return { px: px, py: py };
      }
    }
    return null;
  })()`);
  const notesBefore = await js(`window.__editEvents.filter(function (e) { return e.type === 'edit-note'; }).length`);
  const awayPt = away || { px: 640, py: 300 };
  await clickAt(awayPt.px, awayPt.py);
  await sleep(300);
  const awayState = await js(`(() => {
    const P = window.__game.Play;
    const notes = window.__editEvents.filter(function (e) { return e.type === 'edit-note'; });
    return { open: !!P.state.edit, notes: notes.length,
             text: notes.length ? notes[notes.length - 1].text : '' };
  })()`);
  check('тычок мимо при несохранённых правках отклоняется фразой',
    awayState.open && awayState.notes > notesBefore && awayState.text.length > 0, awayState.text);

  /* Узкое окно: полоса правки обязана помещаться целиком. «Отменить» за краем
     экрана — не мелочь: правку тогда нечем закрыть, кроме Esc. Проверка не
     теоретическая: общая анимация табличек (plaque-in) перебивала
     центрирование полосы, и «Отменить» уезжала за правый край. */
  await send('Emulation.setDeviceMetricsOverride', { width: 760, height: 720, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await js(`window.__game.Play.resize()`);
  await sleep(200);
  const barNarrow = await js(`(() => {
    const bar = document.getElementById('editBar').getBoundingClientRect();
    const btn = document.getElementById('editCancel').getBoundingClientRect();
    return { l: Math.round(bar.left), r: Math.round(bar.right), b: Math.round(bar.bottom),
             vw: innerWidth, vh: innerHeight, btnRight: Math.round(btn.right),
             over: document.documentElement.scrollWidth > innerWidth + 1 };
  })()`);
  check('в узком окне полоса правки помещается целиком',
    barNarrow.l >= 0 && barNarrow.r <= barNarrow.vw && barNarrow.b <= barNarrow.vh &&
    barNarrow.btnRight <= barNarrow.vw && !barNarrow.over,
    barNarrow.l + '..' + barNarrow.r + ' в ' + barNarrow.vw + ', «Отменить» до ' + barNarrow.btnRight);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await js(`window.__game.Play.resize()`);
  await sleep(200);

  await clickOn('#editCancel');
  await sleep(300);
  const backHome = await js(`(() => {
    const P = window.__game.Play, b = ${findBuilding('townhall')};
    return { open: !!P.state.edit, at: [b.x, b.y], bar: !document.getElementById('editBar').classList.contains('hidden'),
             editing: P.renderer().editing, valid: !!b, rev: P.state.world._buildRev };
  })()`);
  check('«Отменить» возвращает ратушу на место и закрывает режим',
    !backHome.open && backHome.editing === null && !backHome.bar &&
    backHome.at[0] === thAt.x && backHome.at[1] === thAt.y,
    backHome.at.join(','));

  /* --- 14. стройка: покупка за брёвна и постановка -------------------- *
   *
   * Главная новая возможность: в меню построек дом жителя, лагерь лесоруба и
   * казарма типа А. Покупка отделена от постановки: «Поставить» берёт
   * постройку в руки, брёвна списываются только когда она встала. Проверяется
   * весь путь руками: меню → карточка → призрак под курсором → клик → новый
   * дом в мире и минус брёвна. */
  console.log('\nстройка: покупка за брёвна и постановка:');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  await js(`window.__game.Play.resize()`);
  await js(`(() => {
    window.__game.start('стройка-деревни-200', 64);
    // То же, что в правке: пока идёт стройка, деревня не должна рожать —
    // иначе список казармы ниже увидит не трёх жителей, а восемь.
    window.__game.Play.state.birth = { next: 1e9, attempts: 0 };
    return 1;
  })()`);
  await sleep(500);
  // Подлёт камеры отменяем: иначе точка, посчитанная для клика, уедет вместе
  // с камерой, и здание встанет не туда, куда показывали.
  await js(`window.__game.Play.fit()`);
  await js(`(() => {
    const P = window.__game.Play, w = P.state.world;
    w.village.logs = 100;
    P.state.logs = 100;
    P.tick(0.1);
    return w.village.logs;
  })()`);
  await hudFrame(3);

  const findSpot = (type) => js(`(() => {
    const P = window.__game.Play, B = window.Buildings, st = P.state, w = st.world;
    const c = B.clusterBounds(st.buildings);
    const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
    const opts = { clearable: false, requireClear: true, yard: 1 };
    for (let rad = 4; rad <= 24; rad++) {
      for (let a = 0; a < 24; a++) {
        const ang = a * Math.PI / 12;
        const x = Math.round(cx + Math.cos(ang) * rad);
        const y = Math.round(cy + Math.sin(ang) * rad);
        const b = B.make({ type: ${JSON.stringify(type)}, variant: 'a', rot: B.FACE_ROT, x: x, y: y });
        const chk = B.canPlace(w, st.buildings, b, opts);
        if (chk.ok) return { x: x, y: y, rot: b.rot };
      }
    }
    return null;
  })()`);

  const houseSpot = await findSpot('house');
  check('рядом с деревней нашлось место под новый дом', !!houseSpot,
    houseSpot ? houseSpot.x + ',' + houseSpot.y : 'нет');
  await lookAt(houseSpot.x + 1.5, houseSpot.y + 1.5, 34, 120);
  await sleep(200);

  // Меню открывается при 100 брёвнах: кнопки доступны, цена видна.
  await clickOn('#btnBuild');
  await sleep(220);
  const affordable = await js(`(() => {
    const cards = [...document.querySelectorAll('#buildList .build-card')];
    return { enabled: cards.map(c => !c.querySelector('.build-btn').disabled),
             logs: document.getElementById('villageLogs').textContent };
  })()`);
  check('с брёвнами в казне карточки становятся доступны',
    affordable.enabled.every(Boolean) && affordable.logs === '100',
    affordable.logs + ' брёвен, кнопки: ' + affordable.enabled.join(','));

  await clickOn('#buildList .build-card[data-type="house"] .build-btn');
  await sleep(260);
  const began = await js(`(() => {
    const P = window.__game.Play, st = P.state, r = P.renderer();
    return { build: st.build && { type: st.build.type, price: st.build.price, rot: st.build.rot },
             bar: !document.getElementById('placeBar').classList.contains('hidden'),
             name: document.getElementById('placeName').textContent,
             price: document.getElementById('placePrice').textContent,
             ghost: !!r.ghost && r.ghost.b.type,
             logs: st.world.village.logs,
             buildings: st.buildings.length,
             placing: document.getElementById('view').classList.contains('placing'),
             menu: window.__game.Hud.isBuildMenuOpen() };
  })()`);
  check('«Поставить» берёт дом в руки и не списывает брёвна раньше времени',
    began.build && began.build.type === 'house' && began.build.price === 12 &&
    began.buildings === 3 && began.logs === 100,
    JSON.stringify(began.build) + ', брёвен ' + began.logs);
  check('полоса размещения показывает имя, цену и подсказку',
    began.bar && began.name === 'Дом жителя' && began.price === '12',
    began.name + ' · ' + began.price);
  check('под курсором стоит призрак дома, меню закрылось',
    began.ghost === 'house' && began.placing && !began.menu);

  const housePt = await cellPoint(houseSpot.x, houseSpot.y);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: housePt.x, y: housePt.y });
  await sleep(220);
  const ghostOk = await js(`(() => {
    const P = window.__game.Play, e = P.state.build;
    return { ok: !!e && e.ok, at: e ? [e.x, e.y] : null,
             reason: e ? e.reason : '',
             state: document.getElementById('placeState').textContent };
  })()`);
  check('призрак встал в выбранную клетку и место годится',
    ghostOk.ok && ghostOk.at[0] === houseSpot.x && ghostOk.at[1] === houseSpot.y,
    ghostOk.at ? ghostOk.at.join(',') : '—');
  await shot('build-mode.png');

  await clickAt(housePt.x, housePt.y);
  await sleep(320);
  const builtHouse = await js(`(() => {
    const P = window.__game.Play, st = P.state, B = window.Buildings;
    const last = st.buildings[st.buildings.length - 1];
    const toasts = [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent);
    return { n: st.buildings.length, type: B.typeOf(last), variant: last.variant,
             at: [last.x, last.y], logs: st.world.village.logs,
             hudLogs: document.getElementById('villageLogs').textContent,
             bar: !document.getElementById('placeBar').classList.contains('hidden'),
             build: !!st.build, ghost: !!P.renderer().ghost,
             toast: toasts.length ? toasts[toasts.length - 1] : '' };
  })()`);
  check('клик по годному месту ставит дом и списывает ровно его цену',
    builtHouse.n === 4 && builtHouse.type === 'house' && builtHouse.logs === 88,
    builtHouse.n + ' построек, брёвен ' + builtHouse.logs);
  check('постройка встала в выбранную клетку', builtHouse.at[0] === houseSpot.x && builtHouse.at[1] === houseSpot.y,
    builtHouse.at.join(','));
  check('полоса размещения ушла, призрак снят', !builtHouse.bar && !builtHouse.build && !builtHouse.ghost);
  check('постановка подтверждена всплывашкой и счётом',
    builtHouse.toast.indexOf('Построено') >= 0 && builtHouse.hudLogs === '88',
    builtHouse.toast + ' · в HUD ' + builtHouse.hudLogs);

  /* Казарма — та самая, тип А. Она больше дома: пятно 4 x 3 в модели, на карте
     под 90° — 3 x 4. Проверяется и покупка, и то, что на карту встал именно
     вариант A из атласа. */
  const barSpot = await findSpot('barracks');
  check('нашлось место под казарму', !!barSpot, barSpot ? barSpot.x + ',' + barSpot.y : 'нет');
  await lookAt(barSpot.x + 1.5, barSpot.y + 2, 34, 120);
  await sleep(200);
  await clickOn('#btnBuild');
  await sleep(220);
  await clickOn('#buildList .build-card[data-type="barracks"] .build-btn');
  await sleep(260);
  const barBegan = await js(`(() => {
    const P = window.__game.Play;
    return { type: P.state.build && P.state.build.type,
             name: document.getElementById('placeName').textContent,
             price: document.getElementById('placePrice').textContent };
  })()`);
  check('казарма берётся в руки как тип А и стоит 28 брёвен',
    barBegan.type === 'barracks' && barBegan.name === 'Казарма' && barBegan.price === '28',
    barBegan.name + ' · ' + barBegan.price);

  const barPt = await cellPoint(barSpot.x, barSpot.y);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: barPt.x, y: barPt.y });
  await sleep(220);
  const barGhost = await js(`(() => {
    const P = window.__game.Play, e = P.state.build;
    return { ok: !!e && e.ok, rot: e ? e.rot : 0, at: e ? [e.x, e.y] : null,
             fp: e ? [window.Buildings.footprint(e.rot, e.type).w,
                      window.Buildings.footprint(e.rot, e.type).h] : null };
  })()`);
  check('призрак казармы — пятно 3 x 4 и место годится',
    barGhost.ok && barGhost.fp.join('x') === '3x4',
    barGhost.fp ? barGhost.fp.join('x') : '—');
  await clickAt(barPt.x, barPt.y);
  await sleep(320);
  const builtBar = await js(`(() => {
    const P = window.__game.Play, st = P.state, B = window.Buildings;
    const last = st.buildings[st.buildings.length - 1];
    const fp = B.footprint(last.rot, B.typeOf(last));
    return { n: st.buildings.length, type: B.typeOf(last), variant: last.variant,
             rot: last.rot, fp: [fp.w, fp.h], logs: st.world.village.logs,
             sprite: !!P.renderer().spritesFor('barracks'),
             hudLogs: document.getElementById('villageLogs').textContent };
  })()`);
  check('казарма встала на карту вариантом A, поворот 90°',
    builtBar.n === 5 && builtBar.type === 'barracks' && builtBar.variant === 'a' && builtBar.rot === 90,
    builtBar.type + ' ' + builtBar.variant + ' · ' + builtBar.rot + '°');
  check('пятно казармы на карте 3 x 4, спрайт её атласа загружен',
    builtBar.fp.join('x') === '3x4' && builtBar.sprite, builtBar.fp.join('x'));
  check('за казарму списано ещё 28 брёвен', builtBar.logs === 60 && builtBar.hudLogs === '60',
    builtBar.logs + ' в мире, ' + builtBar.hudLogs + ' в HUD');
  await shot('build-placed.png');

  /* Отмена и поворот: постройка ещё не встала — брёвна целы, мира не касается. */
  const beforeCancel = await js(`(() => {
    const P = window.__game.Play;
    P.state.world.village.logs = 50; P.state.logs = 50; P.tick(0.1);
    const n = P.state.buildings.length;
    return { n: n, logs: P.state.world.village.logs };
  })()`);
  await hudFrame(2);
  await clickOn('#btnBuild');
  await sleep(200);
  await clickOn('#buildList .build-card[data-type="lumbercamp"] .build-btn');
  await sleep(220);
  await edgeClickOn('#placeRotate');
  const rotatedBuild = await js(`(() => {
    const P = window.__game.Play;
    return { rot: P.state.build && P.state.build.rot,
             fp: P.state.build ? [window.Buildings.footprint(P.state.build.rot, P.state.build.type).w,
                                  window.Buildings.footprint(P.state.build.rot, P.state.build.type).h] : null,
             logs: P.state.world.village.logs, n: P.state.buildings.length };
  })()`);
  check('«Повернуть» поворачивает будущую постройку и её пятно',
    rotatedBuild.rot === 180 && rotatedBuild.fp.join('x') === '3x3',
    rotatedBuild.rot + '°, ' + (rotatedBuild.fp ? rotatedBuild.fp.join('x') : '—'));
  await press('Escape', 'Escape', 27);
  await sleep(220);
  const cancelledBuild = await js(`(() => {
    const P = window.__game.Play;
    return { build: !!P.state.build, bar: !document.getElementById('placeBar').classList.contains('hidden'),
             ghost: !!P.renderer().ghost, logs: P.state.world.village.logs,
             n: P.state.buildings.length };
  })()`);
  check('Esc отменяет постановку: брёвна и постройки целы',
    !cancelledBuild.build && !cancelledBuild.bar && !cancelledBuild.ghost &&
    cancelledBuild.logs === beforeCancel.logs && cancelledBuild.n === beforeCancel.n,
    'брёвен ' + cancelledBuild.logs + ', построек ' + cancelledBuild.n);

  /* «Отменить» в полосе — та же кнопка, что и все: нажатая у самой верхней
     кромки, она обязана отменять постановку. */
  await clickOn('#btnBuild');
  await sleep(200);
  await clickOn('#buildList .build-card[data-type="lumbercamp"] .build-btn');
  await sleep(220);
  await edgeClickOn('#placeCancel');
  await sleep(220);
  const cancelledByBtn = await js(`(() => {
    const P = window.__game.Play;
    return { build: !!P.state.build, bar: !document.getElementById('placeBar').classList.contains('hidden'),
             logs: P.state.world.village.logs, n: P.state.buildings.length };
  })()`);
  check('«Отменить» в полосе у кромки отменяет постановку',
    !cancelledByBtn.build && !cancelledByBtn.bar &&
    cancelledByBtn.logs === 50 && cancelledByBtn.n === 5,
    'брёвен ' + cancelledByBtn.logs + ', построек ' + cancelledByBtn.n);

  /* Нехватка брёвен: кнопки выключены и объясняют, сколько нужно. */
  await js(`(() => {
    const P = window.__game.Play;
    P.state.world.village.logs = 0; P.state.logs = 0; P.tick(0.1); return 1;
  })()`);
  await hudFrame(2);
  await clickOn('#btnBuild');
  await sleep(220);
  const poor = await js(`(() => {
    const cards = [...document.querySelectorAll('#buildList .build-card')];
    return { buttons: cards.map(c => c.querySelector('.build-btn').textContent),
             disabled: cards.map(c => c.querySelector('.build-btn').disabled),
             titles: cards.map(c => c.querySelector('.build-btn').title) };
  })()`);
  check('без брёвен стройка не начинается и говорит причину',
    poor.disabled.every(Boolean) && poor.buttons.every(b => b === 'Мало брёвен') &&
    poor.titles.every(t => t.indexOf('не хватает брёвен') >= 0),
    poor.titles.join(' · '));
  await edgeClickOn('#btnBuildClose');

  /* --- 14b. казарма: тренировка воинов, а не наём ---------------------- *
   *
   * Заказчик (2026-10-22): в интерфейсе казармы по свободному жителю
   * нажимают «Тренировать»; житель идёт ко входу, заступает на территорию
   * казармы, растворяется, пять секунд тренируется и выходит воином, чтобы
   * уйти в военный лагерь. Найма в казарме больше нет — проверяется именно
   * это: подписи, счётчик, отказы и то, что человек идёт, а не телепортируется.
   *
   * К этому месту в партии уже есть казарма (её только что купили) и лагерь
   * лесоруба. Жителя №2 держим в лагере — он и есть «занятый», которому
   * тренировка закрыта. */
  console.log('\nказарма: тренировка воинов:');
  const findBarracks = findBuilding('barracks');
  const barInfo = await js(`(() => {
    const P = window.__game.Play, B = window.Buildings, S = window.Session, st = P.state;
    /* Военного лагеря на старте больше нет (2026-10-23). Этот блок проверяет
       тренировку и поход в лагерь, поэтому ставим лагерь здесь — как игрок. */
    if (!st.buildings.some(b => B.typeOf(b) === 'warcamp')) {
      const spot = B.findSpot(st.world, st.buildings, 'x', B.FACE_ROT, { type: 'warcamp', minSep: 0 });
      if (spot) {
        B.settle(st.world, spot, { clear: true });
        st.buildings.push(spot);
        P.renderer().setBuildings(st.buildings);
      }
    }
    const bar = ${findBarracks}, camp = ${findCamp};
    if (!bar) return null;
    st.villagers.forEach(v => { if (v.employer) S.fire(v.employer, v); });
    st.villagers.forEach(v => { if (v.trainee) S.cancelTraining(v.trainingAt, v, { outside: true }); });
    const v2 = st.villagers.find(v => v.id === 2);
    if (v2) S.hire(camp, v2, st.villagers);
    const c = B.center(bar);
    const cell = B.cells(bar)[Math.floor(B.cells(bar).length / 2)];
    return { x: cell.x, y: cell.y, cx: c.x, cy: c.y, id: bar.x + ',' + bar.y,
             type: B.typeOf(bar), slots: B.trainingSlots(bar),
             campWorkers: S.workersOf(camp, st.villagers).map(v => v.id),
             villagers: st.villagers.map(v => ({ id: v.id, employer: v.employer ? B.typeOf(v.employer) : null })) };
  })()`);
  check('в партии есть казарма, в лагере занят житель №2',
    !!barInfo && barInfo.type === 'barracks' &&
    barInfo.campWorkers.join(',') === '2' && barInfo.slots === 3,
    barInfo ? 'клетка ' + barInfo.id + ', лагерь ' + barInfo.campWorkers.join(',') : 'казармы нет');
  if (!barInfo) { await finish(); return; }
  await lookAt(barInfo.cx, barInfo.cy, 72, 340);
  await sleep(220);
  const barPoint = await cellPoint(barInfo.x, barInfo.y);
  check('казарма видна игроку и не закрыта табличками',
    await js(`document.elementFromPoint(${barPoint.x}, ${barPoint.y}) === document.getElementById('view')`),
    Math.round(barPoint.x) + ', ' + Math.round(barPoint.y));
  await clickAt(barPoint.x, barPoint.y);
  await sleep(240);
  await hudFrame(2);

  const barOpen = await js(`(() => {
    const P = window.__game.Play, S = window.Session, B = window.Buildings, st = P.state;
    const bar = ${findBarracks}, camp = ${findCamp};
    const rows = [...document.querySelectorAll('#hireList .hire-row')];
    return {
      panel: !document.getElementById('hirePanel').classList.contains('hidden'),
      selected: P.renderer().selected === bar,
      title: document.getElementById('hireTitle').textContent,
      slots: document.getElementById('hireSlots').textContent,
      order: rows.map(r => +r.dataset.vid),
      groups: [...document.querySelectorAll('#hireList .hire-group')].map(g => g.textContent),
      buttons: rows.map(r => r.querySelector('.hire-btn').textContent),
      disabled: rows.map(r => r.querySelector('.hire-btn').disabled),
      whys: rows.map(r => r.querySelector('.hire-why').textContent),
      marks: rows.map(r => !r.querySelector('.hire-mark').classList.contains('hidden')),
      hireAll: { text: document.getElementById('hireAll').textContent,
                 disabled: document.getElementById('hireAll').disabled,
                 title: document.getElementById('hireAll').title },
      fireAll: { text: document.getElementById('fireAll').textContent,
                 hidden: document.getElementById('fireAll').classList.contains('hidden'),
                 disabled: document.getElementById('fireAll').disabled },
      note: document.getElementById('hireBatchNote').textContent,
      noteHidden: document.getElementById('hireBatchNote').classList.contains('hidden'),
      campWorkers: S.workersOf(camp, st.villagers).map(v => v.id),
      barWorkers: S.workersOf(bar, st.villagers).map(v => v.id),
      trainees: S.traineesOf(bar, st.villagers).map(v => v.id),
      warriors: S.warriorsOf(st.villagers).map(v => v.id)
    };
  })()`);
  check('клик по казарме открывает панель с заголовком «Казарма»',
    barOpen.panel && barOpen.selected && barOpen.title === 'Казарма', barOpen.title);
  check('счётчик казармы — «воины 0 · тренируются 0 / 3», а не «рыцари»/«наём»',
    barOpen.slots === 'воины 0 · тренируются 0 / 3', barOpen.slots);
  check('в списке свободные 1 и 3, занятый в лагере 2 — последним',
    barOpen.order.join(',') === '1,3,2' &&
    barOpen.groups.join(',') === 'свободны,заняты',
    barOpen.order.join(',') + ' / ' + barOpen.groups.join(','));
  check('у свободных кнопка «Тренировать», у занятого она выключена с причиной движка',
    barOpen.buttons[0] === 'Тренировать' && barOpen.buttons[1] === 'Тренировать' &&
    !barOpen.disabled[0] && !barOpen.disabled[1] && barOpen.disabled[2] &&
    barOpen.whys[2] === 'он уже работает в лагере лесоруба' &&
    barOpen.buttons.every(b => b !== 'Нанять' && b !== 'Уволить'),
    barOpen.buttons.join(' · ') + ' / ' + barOpen.whys.join(' · '));
  check('пакетная кнопка — «Тренировать свободных»; «Распустить» в казарме нет',
    barOpen.hireAll.text === 'Тренировать свободных' && !barOpen.hireAll.disabled &&
    barOpen.fireAll.hidden && barOpen.fireAll.disabled && barOpen.noteHidden,
    barOpen.hireAll.text + ' · fireAll hidden=' + barOpen.fireAll.hidden);
  check('наём в казарму не тронул работников лагеря',
    barOpen.campWorkers.join(',') === '2' && barOpen.barWorkers.length === 0 &&
    barOpen.trainees.length === 0 && barOpen.warriors.length === 0,
    'лагерь ' + barOpen.campWorkers.join(',') + ', казарма ' + barOpen.barWorkers.join(','));

  /* Чужой воин: у врага в «против деревни» их десять. Он не должен ни
     появиться строкой в панели казармы, ни попасть в счётчик «воины N». */
  const foreignTrain = await js(`(() => {
    const P = window.__game.Play, st = P.state, bar = ${findBarracks};
    const read = () => {
      const rows = [...document.querySelectorAll('#hireList .hire-row')];
      return { rows: rows.length, ids: rows.map(r => +r.dataset.vid),
               slots: document.getElementById('hireSlots').textContent };
    };
    const before = read();
    const enemy = Object.assign({}, st.villagers[0], {
      id: 902, owner: 1, employer: null, home: null, warcamp: null, station: null,
      trainee: false, trainingAt: null, warrior: true
    });
    st.villagers.push(enemy);
    window.__foreignWarrior = enemy;
    window.Hud.tick(0.25);
    return { before: before, after: read(),
             order: window.Session.trainingOrder(bar, st.villagers).map(v => v.id),
             ownWarriors: window.Session.warriorsOf(st.villagers, 0).map(v => v.id) };
  })()`);
  check('чужой воин не появляется ни в панели казармы, ни в счётчике «воины»',
    foreignTrain.after.rows === foreignTrain.before.rows &&
    foreignTrain.after.slots === foreignTrain.before.slots &&
    !foreignTrain.after.ids.includes(902) && !foreignTrain.order.includes(902) &&
    !foreignTrain.ownWarriors.includes(902),
    foreignTrain.after.ids.join(',') + ' / ' + foreignTrain.after.slots);
  await js(`(() => {
    const st = window.__game.Play.state;
    const i = st.villagers.indexOf(window.__foreignWarrior);
    if (i >= 0) st.villagers.splice(i, 1);
    window.__foreignWarrior = null;
    window.Hud.tick(0.25);
    return 1;
  })()`);

  /* «Тренировать» у САМОЙ ВЕРХНЕЙ кромки кнопки: та же проверка попадания,
     что у остальных кнопок (правило 2026-10-19). */
  await js(`(() => {
    window.__game.Play.setFocus(window.__game.Play.state.villagers.find(v => v.id === 1));
    return 1;
  })()`);
  await edgeClickOn('.hire-row[data-vid="1"] .hire-btn');
  await sleep(220);
  await hudFrame(2);
  const barStarted = await js(`(() => {
    const P = window.__game.Play, S = window.Session, B = window.Buildings, st = P.state;
    const bar = ${findBarracks}, camp = ${findCamp};
    const rows = [...document.querySelectorAll('#hireList .hire-row')];
    const row1 = rows.find(r => +r.dataset.vid === 1);
    const v = st.villagers.find(x => x.id === 1);
    const toasts = [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent);
    return {
      order: rows.map(r => +r.dataset.vid),
      groups: [...document.querySelectorAll('#hireList .hire-group')].map(g => g.textContent),
      slots: document.getElementById('hireSlots').textContent,
      btn: row1.querySelector('.hire-btn').textContent,
      disabled: row1.querySelector('.hire-btn').disabled,
      mark: !row1.querySelector('.hire-mark').classList.contains('hidden'),
      markText: row1.querySelector('.hire-mark').textContent,
      focused: row1.classList.contains('focused'),
      focus: P.state.focus === v,
      trainee: !!v.trainee, trainingAt: v.trainingAt === bar,
      employer: v.employer, state: v.state,
      doing: S.villagerDoing(v, window.Villagers.CHOP_TIME),
      set: P.renderer().villagerSet(v) === P.renderer().villagerSprites,
      campWorkers: S.workersOf(camp, st.villagers).map(x => x.id),
      toast: toasts.join(' | ')
    };
  })()`);
  check('«Тренировать» у кромки отправляет жителя №1 учиться, а не нанимает',
    barStarted.trainee && barStarted.trainingAt && barStarted.employer === null &&
    barStarted.state === 'toBarracks' && barStarted.doing === 'идёт в казарму' &&
    barStarted.toast.indexOf('Житель №1 пошёл тренироваться в казарму') >= 0,
    barStarted.doing + ' · ' + barStarted.toast);
  check('строка стала «Тренируется», пометка — «учится», счётчик 1 / 3',
    barStarted.btn === 'Тренируется' && barStarted.disabled && barStarted.mark &&
    barStarted.markText === 'учится' &&
    barStarted.slots === 'воины 0 · тренируются 1 / 3',
    barStarted.btn + ' · ' + barStarted.slots);
  check('порядок: тренирующийся здесь → свободный → занятый',
    barStarted.order.join(',') === '1,3,2' &&
    barStarted.groups.join(',') === 'тренируются здесь,свободны,заняты',
    barStarted.order.join(',') + ' / ' + barStarted.groups.join(','));
  check('подсветка выбранного жителя пережила пересортировку',
    barStarted.focused && barStarted.focus);
  check('пока он идёт, на нём модель обычного жителя',
    barStarted.set);
  check('тренировка не тронула работника лагеря',
    barStarted.campWorkers.join(',') === '2');

  /* Дорога, растворение и пять секунд: шагаем тем же Play.tick, что и игра,
     чтобы проверить именно игровой цикл, а не ручной вызов движка. */
  const barLife = await js(`(() => {
    const P = window.__game.Play, S = window.Session, B = window.Buildings, V = window.Villagers;
    const st = P.state, bar = ${findBarracks};
    const v = st.villagers.find(x => x.id === 1);
    st.birth = { next: st.seconds + 100000, attempts: 0 };
    let guard = 0;
    while (guard++ < 6000 && v.state !== 'training') P.tick(0.1);
    const ent = B.entrance(bar), fp = B.footprint(bar.rot, B.typeOf(bar));
    const inFp = v.x >= bar.x && v.x < bar.x + fp.w && v.y >= bar.y && v.y < bar.y + fp.h;
    const atDoor = Math.hypot(v.x - ent.in.x, v.y - ent.in.y);
    const begun = {
      state: v.state, trainT: v.trainT, hidden: !!v.hidden,
      vis: V.visibility(v), trainee: !!v.trainee, warrior: !!v.warrior,
      traineeAt: S.traineesOf(bar, st.villagers).map(x => x.id),
      set: P.renderer().villagerSet(v) === P.renderer().villagerSprites,
      doing: S.villagerDoing(v, V.CHOP_TIME)
    };
    for (let i = 0; i < 48; i++) P.tick(0.1);       // 4.8 с — ещё учится
    const fourEight = {
      trainT: v.trainT, trainee: !!v.trainee, warrior: !!v.warrior,
      hidden: !!v.hidden, vis: V.visibility(v), state: v.state
    };
    for (let i = 0; i < 3; i++) P.tick(0.1);        // 5.1 с — уже воин
    const done = {
      warrior: !!v.warrior, trainee: !!v.trainee, trainingAt: v.trainingAt,
      hidden: !!v.hidden, vis: V.visibility(v), employer: v.employer,
      warcamp: v.warcamp ? B.typeOf(v.warcamp) : null,
      state: v.state, doing: S.villagerDoing(v, V.CHOP_TIME),
      set: P.renderer().villagerSet(v) === P.renderer().knightSprites,
      atOut: Math.hypot(v.x - ent.out.x, v.y - ent.out.y) < 0.08,
      outside: v.x < bar.x || v.x >= bar.x + fp.w || v.y < bar.y || v.y >= bar.y + fp.h,
      trainees: S.traineesOf(bar, st.villagers).map(x => x.id),
      warriors: S.warriorsOf(st.villagers).map(x => x.id)
    };
    return { inFp: inFp, atDoor: atDoor, begun: begun, fourEight: fourEight,
             done: done, entIn: [ent.in.x, ent.in.y], entOut: [ent.out.x, ent.out.y] };
  })()`);
  check('житель дошёл до входа и заступил НА территорию казармы, а не встал рядом',
    barLife.begun.state === 'training' && barLife.inFp && barLife.atDoor < 0.08,
    'у двери ' + barLife.atDoor.toFixed(3) + ' клетки, внутри пятна ' + barLife.inFp);
  check('на пороге он ещё обычный житель и начинает тренировку ровно с 5 с',
    barLife.begun.trainee && barLife.begun.trainT > 4.9 && barLife.begun.set &&
    barLife.begun.traineeAt.join(',') === '1' && barLife.begun.doing.indexOf('тренируется') === 0,
    barLife.begun.doing + ' · ' + barLife.begun.trainT.toFixed(2) + ' с');
  check('через 4.8 с ещё учится, через 5.1 с — уже воин',
    barLife.fourEight.trainee && !barLife.fourEight.warrior && barLife.fourEight.trainT > 0.1 &&
    barLife.done.warrior && !barLife.done.trainee && barLife.done.trainingAt === null,
    '4.8: ' + barLife.fourEight.trainT.toFixed(2) + ' с, 5.1: воин ' + barLife.done.warrior);
  check('войдя в казарму, он растворился: на тренировке скрыт и невидим',
    barLife.fourEight.hidden && barLife.fourEight.vis === 0 && barLife.begun.vis > 0,
    'видимость ' + barLife.begun.vis.toFixed(2) + ' → ' + barLife.fourEight.vis);
  check('вышел из казармы воином: броня, шлем и меч; работодателя нет',
    barLife.done.set && barLife.done.warcamp === 'warcamp' && barLife.done.employer === null &&
    barLife.done.outside,
    'атлас воина ' + barLife.done.set + ', лагерь ' + barLife.done.warcamp +
    ', снаружи казармы ' + barLife.done.outside);
  check('он идёт в военный лагерь и больше не числится учеником',
    barLife.done.trainees.length === 0 && barLife.done.warriors.join(',') === '1' &&
    (barLife.done.state === 'toWarcamp' || barLife.done.state === 'patrol') &&
    (barLife.done.doing === 'идёт в военный лагерь' || barLife.done.doing === 'воин в лагере'),
    barLife.done.state + ' · ' + barLife.done.doing);

  await hudFrame(2);
  const barAfter = await js(`(() => {
    const P = window.__game.Play, S = window.Session, st = P.state;
    const bar = ${findBarracks};
    const rows = [...document.querySelectorAll('#hireList .hire-row')];
    const row1 = rows.find(r => +r.dataset.vid === 1);
    const toasts = [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent);
    return {
      order: rows.map(r => +r.dataset.vid),
      groups: [...document.querySelectorAll('#hireList .hire-group')].map(g => g.textContent),
      slots: document.getElementById('hireSlots').textContent,
      btn: row1.querySelector('.hire-btn').textContent,
      disabled: row1.querySelector('.hire-btn').disabled,
      mark: !row1.querySelector('.hire-mark').classList.contains('hidden'),
      markText: row1.querySelector('.hire-mark').textContent,
      hireAll: { text: document.getElementById('hireAll').textContent,
                 disabled: document.getElementById('hireAll').disabled,
                 title: document.getElementById('hireAll').title },
      fireHidden: document.getElementById('fireAll').classList.contains('hidden'),
      toast: toasts.join(' | '),
      warriors: S.warriorsOf(st.villagers).map(v => v.id),
      trainees: S.traineesOf(bar, st.villagers).map(v => v.id)
    };
  })()`);
  check('панель показывает обученного воина: «Воин», метка «воин», воины 1',
    barAfter.btn === 'Воин' && barAfter.disabled && barAfter.mark &&
    barAfter.markText === 'воин' && barAfter.slots === 'воины 1 · тренируются 0 / 3' &&
    barAfter.warriors.join(',') === '1' && barAfter.trainees.length === 0,
    barAfter.btn + ' · ' + barAfter.slots);
  check('порядок после обучения: свободный 3 → воин 1 → занятый 2',
    barAfter.order.join(',') === '3,1,2' &&
    barAfter.groups.join(',') === 'свободны,воины,заняты',
    barAfter.order.join(',') + ' / ' + barAfter.groups.join(','));
  check('о новом воине сказано всплывашкой',
    barAfter.toast.indexOf('Житель №1 стал воином и ушёл в военный лагерь') >= 0,
    barAfter.toast);
  check('«Распустить» в казарме по-прежнему нет',
    barAfter.fireHidden);

  /* Пакетная тренировка: свободен только №3 — он и уходит. У занятого №2
     кнопка выключена, а свободных больше нет, значит пакетная гаснет с
     причиной. */
  await edgeClickOn('#hireAll');
  await sleep(240);
  await hudFrame(2);
  const barBatch = await js(`(() => {
    const P = window.__game.Play, S = window.Session, st = P.state;
    const bar = ${findBarracks}, camp = ${findCamp};
    const toasts = [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent);
    return {
      trainees: S.traineesOf(bar, st.villagers).map(v => v.id),
      camp: S.workersOf(camp, st.villagers).map(v => v.id),
      free: st.villagers.filter(v => S.freeForTraining(v)).map(v => v.id),
      slots: document.getElementById('hireSlots').textContent,
      hireAll: { text: document.getElementById('hireAll').textContent,
                 disabled: document.getElementById('hireAll').disabled,
                 title: document.getElementById('hireAll').title },
      note: document.getElementById('hireBatchNote').textContent,
      noteHidden: document.getElementById('hireBatchNote').classList.contains('hidden'),
      toast: toasts.join(' | ')
    };
  })()`);
  check('«Тренировать свободных» у кромки отправляет свободного №3, не трогая занятого',
    barBatch.trainees.join(',') === '3' && barBatch.camp.join(',') === '2' &&
    barBatch.slots === 'воины 1 · тренируются 1 / 3' &&
    barBatch.toast.indexOf('Отправлено на тренировку: 1') >= 0,
    'ученики ' + barBatch.trainees.join(',') + ' · ' + barBatch.toast);
  check('свободных не осталось — пакетная кнопка выключена и говорит причину',
    barBatch.free.length === 0 && barBatch.hireAll.disabled &&
    barBatch.hireAll.title === 'нет свободных жителей' &&
    !barBatch.noteHidden && barBatch.note.indexOf('нет свободных жителей') >= 0,
    barBatch.hireAll.title + ' · ' + barBatch.note);

  /* Воин не остаётся у казармы: он доходит до военного лагеря и ходит по его
     территории, не заходя на модель 2 x 2. Здесь это проверяется на живом
     игровом цикле (Play.tick), а не только в движке: путь воина зависит от
     того, что мир и список построек обновляются каждый кадр. */
  const warcampLife = await js(`(() => {
    const P = window.__game.Play, B = window.Buildings, V = window.Villagers, st = P.state;
    const camp = st.buildings.find(b => B.typeOf(b) === 'warcamp');
    const v = st.villagers.find(x => x.id === 1);
    if (!camp || !v) return { ok: false, reason: 'нет лагеря или воина' };
    st.birth = { next: st.seconds + 100000, attempts: 0 };
    let guard = 0;
    while (guard++ < 12000 && !B.insideWarcamp(camp, v.x, v.y)) P.tick(0.1);
    const entered = B.insideWarcamp(camp, v.x, v.y);
    const model = B.modelCells(camp).map(c => c.x + ',' + c.y);
    const states = new Set();
    let outside = 0, onModel = 0;
    for (let i = 0; i < 300; i++) {
      P.tick(0.1);
      states.add(v.state);
      if (!B.insideWarcamp(camp, v.x, v.y)) outside++;
      if (model.indexOf(Math.floor(v.x) + ',' + Math.floor(v.y)) >= 0) onModel++;
    }
    return { ok: true, entered: entered, outside: outside, onModel: onModel,
             states: [...states].join(','), doing: window.Session.villagerDoing(v, V.CHOP_TIME),
             cell: [Math.floor(v.x), Math.floor(v.y)], camp: [camp.x, camp.y] };
  })()`);
  check('воин дошёл до военного лагеря и ходит по территории, не заходя на модель',
    warcampLife.ok && warcampLife.entered && warcampLife.outside === 0 &&
    warcampLife.onModel === 0 &&
    warcampLife.doing === 'воин в лагере',
    warcampLife.ok ? 'клетка ' + warcampLife.cell.join(',') + ' при лагере ' +
      warcampLife.camp.join(',') + ' · ' + warcampLife.doing +
      ' · состояния ' + warcampLife.states : warcampLife.reason);
  await hudFrame(2);
  await shot('barracks-train.png');

  /* --- 14c. ввод не зависит от платформы ------------------------------- *
   * Заказчик (2026-10-24): «ей можно управлять только с мака; друзья на
   * Windows не могут редактировать здания, с трудом их ставят и вообще плохо
   * управляется; тупо ЛКМ не работает».
   *
   * Причин было три, и все три проверяются здесь НАСТОЯЩИМИ событиями мыши и
   * клавиатуры (Input.dispatchMouseEvent/KeyEvent), а не вызовом функций:
   *
   *   1) ДРОЖЬ РУКИ считалась перетаскиванием. Порог был 6 px по СУММЕ
   *      пройденного пути, а рука на Windows за полсекунды удержания уходит на
   *      8–12 px. Отсюда сразу три жалобы: клик не выбирал, удержание не
   *      открывало правку, постановка срывалась. Теперь дрожь — расстояние от
   *      точки нажатия (7 px ещё клик), удержание терпит 14 px, камера едет
   *      только после 8 px.
   *   2) БУКВЫ сравнивались с `e.key`: на русской раскладке W — это «ц»,
   *      R — «к», O — «щ». Проверяются обе буквы, которыми игрок пользуется
   *      чаще всего: камера и поворот постройки.
   *   3) КОНТЕЙНЕРЫ HUD ловили мышь (`#hud > * { pointer-events: auto }`), и
   *      клик по карте под подсказками и табличками уходил в пустоту. На
   *      ноутбуке с масштабом Windows это до трети экрана.
   *
   * Плюс две новые дороги в правку, чтобы она не зависела от знания жеста:
   * двойной клик и кнопка «Править» в табличке выбранного здания. */
  console.log('\nввод без привязки к платформе:');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  /* Смена окна через CDP не присылает странице resize (см. раздел 14) —
     размер полотна у движка берётся из него. */
  await js(`window.__game.Play.resize()`);
  await js(`(() => {
    window.__game.start('ввод-100', 64);
    window.__game.Play.state.birth = { next: 1e9, attempts: 0 };
    return 1;
  })()`);
  await sleep(600);
  await js(`window.__game.Play.fit()`);
  await sleep(300);

  const inputMove = (x, y, down) => send('Input.dispatchMouseEvent',
    { type: 'mouseMoved', x, y, button: down ? 'left' : 'none', buttons: down ? 1 : 0 });
  const inputPress = (x, y, n) => send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button: 'left', clickCount: n || 1 });
  const inputRelease = (x, y, n) => send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', clickCount: n || 1 });
  /* Клавиша приходит так, как её пришлёт русская раскладка: `key` — кириллица,
     `code` — физическое место. Обработчики обязаны смотреть на `code`. */
  const inputKey = async (key, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code,
      windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code,
      windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(120);
  };

  const platformHouse = await js(`(() => { const B = window.Buildings, b = ${findHouse};
    const fp = B.footprint(b.rot, b.type);
    return { x: b.x, y: b.y, rot: b.rot, w: fp.w, h: fp.h }; })()`);
  /* Сдвиг вправо: под левыми табличками постройка недосягаема для мыши. */
  await lookAt(platformHouse.x + 1.5, platformHouse.y + 1, 36, 150);
  await sleep(250);
  const platformPt = await cellPoint(platformHouse.x + 1, platformHouse.y);

  /* 1. Дрожащий клик: 7 px от точки нажатия — ещё клик, а не панорама.
        Перед проверкой состояние ввода намеренно чистое: предыдущие разделы
        могли оставить открытую правку, приказ или постановку — тогда клик
        тратится на них, и проверялся бы не порог дрожи, а наследство. */
  await js(`(() => { const P = window.__game.Play;
    try { P.cancelOrder(); } catch (e) {}
    try { P.cancelBuild(); } catch (e) {}
    try { P.editAction('cancel'); } catch (e) {}
    P.setFocus(null); P.selectBuilding(null); P.state.follow = false;
    return 1; })()`);
  const camBefore = await js(`(() => { const c = window.__game.Play.renderer().cam;
    return { x: c.x, y: c.y }; })()`);
  await inputMove(platformPt.x, platformPt.y);
  /* Нажатие, дрожь и отпускание уходят ОДНОЙ пачкой, без ожидания ответа на
     каждый шаг: приёмка грузит браузер симуляцией, и пауза между нажатием и
     отпусканием успевала перевалить за EDIT_HOLD_MS (500 мс) — тогда «клик»
     честно открывал правку, и проверялся бы не порог дрожи, а медленный тест. */
  await Promise.all([
    inputPress(platformPt.x, platformPt.y),
    inputMove(platformPt.x + 4, platformPt.y + 2, true),
    inputMove(platformPt.x + 6, platformPt.y + 3, true),
    inputRelease(platformPt.x + 6, platformPt.y + 3)
  ]);
  await sleep(250);
  const jitter = await js(`(() => {
    const P = window.__game.Play, B = window.Buildings, r = P.renderer();
    const b = document.getElementById('view').getBoundingClientRect();
    const p = r.screenToWorld(${platformPt.x + 6} - b.left - r.cssW / 2,
                              ${platformPt.y + 3} - b.top - r.cssH / 2);
    const cell = { x: Math.floor(p.x), y: Math.floor(p.y) };
    const under = r.buildingAt(cell.x, cell.y);
    return { pick: r.selected ? B.typeOf(r.selected) : null,
             mode: P.state.mode, playing: P.isPlaying(),
             edit: !!P.state.edit, build: !!P.state.build, order: !!P.state.order,
             follow: !!P.state.follow,
             rel: [cell.x, cell.y], under: under ? B.typeOf(under) : null }; })()`);
  const jitterPick = jitter.pick;
  const camAfter = await js(`(() => { const c = window.__game.Play.renderer().cam;
    return { x: c.x, y: c.y }; })()`);
  check('дрожащий клик (7 px) выбирает постройку', jitterPick === 'house',
    JSON.stringify(jitter));
  check('дрожащий клик не уводит камеру',
    camBefore.x === camAfter.x && camBefore.y === camAfter.y,
    JSON.stringify(camBefore) + ' -> ' + JSON.stringify(camAfter));

  /* 2. Дрожащее удержание: 10 px — правка открывается, а дом стоит на месте
        (захват пересчитывается по текущей клетке).
        Дрожь уходит одной пачкой сразу после нажатия, ДО срабатывания
        удержания: после открытия правки каждый `pointermove` честно ведёт дом,
        и проверка «не сдвинулся» мерила бы не захват, а скорость теста. */
  await js(`window.__game.Play.selectBuilding(null); 1`);
  await inputMove(platformPt.x, platformPt.y);
  const shake = [inputPress(platformPt.x, platformPt.y)];
  for (let i = 1; i <= 5; i++) {
    shake.push(inputMove(platformPt.x + i * 2, platformPt.y + (i % 3), true));
  }
  await Promise.all(shake);
  const holdOpened = await waitFor(`!!window.__game.Play.state.edit`, 4000);
  const heldPlace = await js(`(() => { const e = window.__game.Play.state.edit;
    return e ? { x: e.building.x, y: e.building.y,
      mode: e.mode } : null; })()`);
  await inputRelease(platformPt.x + 10, platformPt.y + 2);
  await sleep(250);
  check('дрожащее удержание (10 px) открывает правку', holdOpened);
  check('удержание не сдвигает дом с места',
    !!heldPlace && heldPlace.x === platformHouse.x && heldPlace.y === platformHouse.y,
    JSON.stringify(heldPlace && [heldPlace.x, heldPlace.y]) +
      ' при ' + platformHouse.x + ',' + platformHouse.y);
  check('после отпускания дом уже не «в руке»',
    await js(`(() => { const e = window.__game.Play.state.edit;
      return !e || e.mode === 'idle'; })()`));
  await js(`(() => { try { window.__game.Play.editAction('cancel'); } catch (e) {} return 1; })()`);
  await sleep(200);

  /* 3. Двойной клик по своей постройке — второй вход в правку.
        Оба нажатия уходят одной пачкой: браузер считает двойным клик, только
        если второй пришёл в пределах своего порога, а ожидание ответа на
        каждое событие в занятом браузере этот порог пробивало. */
  await js(`window.__game.Play.selectBuilding(null); 1`);
  await inputMove(platformPt.x, platformPt.y);
  await Promise.all([
    inputPress(platformPt.x, platformPt.y, 1),
    inputRelease(platformPt.x, platformPt.y, 1),
    inputPress(platformPt.x, platformPt.y, 2),
    inputRelease(platformPt.x, platformPt.y, 2)
  ]);
  await sleep(300);
  check('двойной клик открывает правку',
    await js(`!!window.__game.Play.state.edit`));
  /* Дом после двойного клика не должен ехать за курсором: кнопка мыши уже
     отпущена, а «ведение» включается только удержанием или кнопкой «Двигать». */
  const dblMode = await js(`(() => { const e = window.__game.Play.state.edit;
    return e ? e.mode : null; })()`);
  check('двойной клик не берёт дом в руки, а открывает полосу', dblMode === 'idle', dblMode);
  await js(`(() => { try { window.__game.Play.editAction('cancel'); } catch (e) {} return 1; })()`);
  await sleep(200);

  /* 4. Кнопка «Править» в табличке: третий вход, доступный одним нажатием. */
  await js(`(() => { const B = window.Buildings, P = window.__game.Play;
    P.selectBuilding(P.state.buildings.find(b => B.typeOf(b) === 'house'));
    return 1; })()`);
  await sleep(300);
  const editBtn = await js(`(() => {
    const b = document.getElementById('btnEdit');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    const p = document.getElementById('buildPlaque').getBoundingClientRect();
    return { shown: !b.classList.contains('hidden'),
      inside: r.left >= p.left - 1 && r.right <= p.right + 1 &&
              r.top >= p.top - 1 && r.bottom <= p.bottom + 1,
      w: Math.round(r.width), h: Math.round(r.height),
      x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  check('в табличке есть кнопка «Править»', !!(editBtn && editBtn.shown),
    editBtn ? editBtn.w + 'x' + editBtn.h : 'нет кнопки');
  check('кнопка «Править» не вылезает из таблички', !!(editBtn && editBtn.inside));
  if (editBtn && editBtn.shown) {
    await inputMove(editBtn.x, editBtn.y);
    await inputPress(editBtn.x, editBtn.y);
    await inputRelease(editBtn.x, editBtn.y);
    await sleep(320);
    check('кнопка «Править» открывает правку',
      await js(`!!window.__game.Play.state.edit`));
    await js(`(() => { try { window.__game.Play.editAction('cancel'); } catch (e) {} return 1; })()`);
    await sleep(200);
  }

  /* 5. Русская раскладка. W физически — «ц», R — «к»: камера и поворот
        обязаны работать так же, как на английской. */
  const keysLoaded = await js(`!!(window.Keys && window.Keys.name({ code: 'KeyW', key: 'ц' }) === 'w')`);
  check('имена клавиш берутся по физическому месту', keysLoaded);
  const camY0 = await js(`window.__game.Play.renderer().cam.y`);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'ц', code: 'KeyW',
    windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
  for (let i = 0; i < 10; i++) await js(`window.__game.Play.stepKeys(0.05)`);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ц', code: 'KeyW',
    windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
  const camY1 = await js(`window.__game.Play.renderer().cam.y`);
  check('«ц» на месте W двигает камеру', Math.abs(camY1 - camY0) > 1,
    (camY1 - camY0).toFixed(2) + ' клетки');

  /* Поворот купленной постройки: сначала выдаём брёвна, иначе меню её не
     возьмёт и проверять будет нечего. */
  await js(`(() => { const P = window.__game.Play;
    P.state.world.village.logs = 999; P.state.logs = 999;
    P.beginBuild('house'); return 1; })()`);
  await sleep(150);
  const rotBefore = await js(`window.__game.Play.buildInfo() ? window.__game.Play.buildInfo().rot : null`);
  await inputKey('к', 'KeyR', 82);
  const rotAfter = await js(`window.__game.Play.buildInfo() ? window.__game.Play.buildInfo().rot : null`);
  check('«к» на месте R поворачивает постановку',
    rotBefore === 90 && rotAfter === 180, rotBefore + ' -> ' + rotAfter);
  await js(`window.__game.Play.cancelBuild(); 1`);

  /* 5б. Дрожащая ПОСТАНОВКА: 10–14 px — это прицеливание, а не панорама.
     Раньше порог постановки был один с кликом (8 px), и на Windows обычный
     клик с дрожью 9–12 px съедался как «перетаскивание»: дом оставался в
     руке, камера чуть уезжала, игрок жал снова. Снаружи — «здание встало
     через полминуты» и «ЛКМ не работает». */
  const freeBuild = await js(`(() => {
    const P = window.__game.Play, B = window.Buildings;
    P.state.world.village.logs = 999; P.state.logs = 999;
    try { P.cancelOrder(); } catch (e) {}
    try { P.cancelBuild(); } catch (e) {}
    try { P.editAction('cancel'); } catch (e) {}
    P.selectBuilding(null); P.setFocus(null);
    const s = B.findSpot(P.state.world, P.state.buildings, 'a', B.FACE_ROT,
      { type: 'house', minSep: 0 });
    return s ? { x: s.x, y: s.y } : null; })()`);
  check('для дрожащей постановки нашлось свободное место', !!freeBuild);
  if (freeBuild) {
    await lookAt(freeBuild.x + 1, freeBuild.y + 1, 36, 150);
    await sleep(250);
    const buildPt = await cellPoint(freeBuild.x, freeBuild.y);
    await inputMove(buildPt.x, buildPt.y);
    await js(`window.__game.Play.beginBuild('house'); 1`);
    await sleep(150);
    const buildReady = await js(`(() => { const e = window.__game.Play.state.build;
      return e ? { ok: !!e.ok, x: e.x, y: e.y } : null; })()`);
    check('дом взят в руки и место годится', !!buildReady && buildReady.ok,
      JSON.stringify(buildReady));
    const placeBefore = await js(`(() => { const P = window.__game.Play;
      return { n: P.state.buildings.length, logs: P.state.logs,
        cam: { x: P.renderer().cam.x, y: P.renderer().cam.y } }; })()`);
    /* Нажатие, дрожь 11 px и отпускание — одной пачкой, как у настоящей мыши:
       пауза между событиями успела бы открыть удержание. */
    await Promise.all([
      inputPress(buildPt.x, buildPt.y),
      inputMove(buildPt.x + 6, buildPt.y + 3, true),
      inputMove(buildPt.x + 10, buildPt.y + 5, true),
      inputRelease(buildPt.x + 10, buildPt.y + 5)
    ]);
    await sleep(350);
    const placedDrift = await js(`(() => { const P = window.__game.Play;
      return { n: P.state.buildings.length, build: !!P.state.build,
        logs: P.state.logs, cam: { x: P.renderer().cam.x, y: P.renderer().cam.y } }; })()`);
    check('дрожащая постановка (11 px) ставит дом',
      placedDrift.n === placeBefore.n + 1 && placedDrift.build === false,
      placeBefore.n + ' -> ' + placedDrift.n);
    check('дрожащая постановка не уводит камеру',
      placedDrift.cam.x === placeBefore.cam.x && placedDrift.cam.y === placeBefore.cam.y,
      JSON.stringify(placeBefore.cam) + ' -> ' + JSON.stringify(placedDrift.cam));

    /* А настоящая панорама постановку по-прежнему отменяет: дом остаётся в
       руке, камера едет. Иначе «поставить» срабатывало бы в конце каждого
       перетаскивания карты. */
    const free2 = await js(`(() => {
      const P = window.__game.Play, B = window.Buildings;
      const s = B.findSpot(P.state.world, P.state.buildings, 'a', B.FACE_ROT,
        { type: 'house', minSep: 0 });
      return s ? { x: s.x, y: s.y } : null; })()`);
    if (free2) {
      await lookAt(free2.x + 1, free2.y + 1, 36, 150);
      await sleep(250);
      const dragPt = await cellPoint(free2.x, free2.y);
      await inputMove(dragPt.x, dragPt.y);
      await js(`window.__game.Play.beginBuild('house'); 1`);
      await sleep(150);
      const dragBefore = await js(`(() => { const P = window.__game.Play;
        return { n: P.state.buildings.length, cam: { x: P.renderer().cam.x,
          y: P.renderer().cam.y } }; })()`);
      await Promise.all([
        inputPress(dragPt.x, dragPt.y),
        inputMove(dragPt.x + 24, dragPt.y + 12, true),
        inputMove(dragPt.x + 44, dragPt.y + 22, true),
        inputRelease(dragPt.x + 44, dragPt.y + 22)
      ]);
      await sleep(300);
      const dragged = await js(`(() => { const P = window.__game.Play;
        return { n: P.state.buildings.length, build: !!P.state.build,
          cam: { x: P.renderer().cam.x, y: P.renderer().cam.y } }; })()`);
      check('панорама (44 px) дом не ставит, а оставляет в руке',
        dragged.build === true && dragged.n === dragBefore.n);
      check('панорама с домом в руке всё-таки двигает камеру',
        dragged.cam.x !== dragBefore.cam.x || dragged.cam.y !== dragBefore.cam.y,
        JSON.stringify(dragBefore.cam) + ' -> ' + JSON.stringify(dragged.cam));
      await js(`window.__game.Play.cancelBuild(); 1`);
    }
  }
  await js(`window.__game.Play.cancelBuild(); 1`);

  /* 6. Интерфейс не ест клики по карте. Проверяются контейнеры, а не кнопки:
        подсказки, левый столбец и правый угол обязаны пропускать мышь. */
  const hudPass = await js(`(() => {
    const out = {};
    [['hint', '#hintBar'], ['left', '.hud-top-left'], ['right', '.hud-top-right'],
     ['bottom', '.hud-bottom-left'], ['cell', '#cellBar']].forEach(function (pair) {
      const el = document.querySelector(pair[1]);
      out[pair[0]] = el ? getComputedStyle(el).pointerEvents : 'нет';
    });
    /* И настоящая проверка попадания: середина полосы подсказок должна
       принадлежать полотну, а не HUD. */
    const h = document.getElementById('hintBar');
    let hit = null;
    if (h) {
      const r = h.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      hit = el ? (el.id || el.className || el.tagName) : null;
    }
    return { styles: out, hit: hit };
  })()`);
  check('полоса подсказок пропускает мышь к карте',
    hudPass.styles.hint === 'none' && hudPass.hit === 'view',
    hudPass.styles.hint + ' · под курсором ' + hudPass.hit);
  check('контейнеры HUD пропускают мышь',
    hudPass.styles.left === 'none' && hudPass.styles.right === 'none' &&
    hudPass.styles.bottom === 'none' && hudPass.styles.cell === 'none',
    JSON.stringify(hudPass.styles));
  await shot('input-hud.png');

  /* --- 15. рождение жителей ------------------------------------------- *
   * Раз в 30 секунд игрового времени деревня пробует заселить свободные места
   * в домах. Проверки идут в отдельной «лаборатории»: каждая начинается с
   * новой партии, время ставится ровно на границу, а шаг — один tick. Так
   * видно именно правило, а не «подождали и посмотрели».
   *
   * Числа не переписываются из движка: дома, места и прописку считают
   * Buildings.housingCapacity / Session.residentsOf / Session.housingFree.
   * Здесь же лежит то, чего в движке нет: снимок старожилов, HUD и кадр
   * проявления. */
  console.log('\nрождение жителей:');
  await js(`(() => {
    window.__birthLab = {
      reset: function (tag) {
        window.__game.start('рождение-' + tag, 64);
        const P = window.__game.Play, st = P.state;
        st.seconds = 0;
        st.birth = window.Session.birthClock();
        return st;
      },
      addHouse: function (st) {
        const B = window.Buildings;
        const cand = B.neighbourSpot(st.world, st.buildings, { type: 'house', variant: 'a' });
        if (!cand) return null;
        B.settle(st.world, cand, { clear: true });
        B.touch(st.world);
        st.buildings.push(cand);
        window.__game.Play.renderer().setBuildings(st.buildings);
        return cand;
      },
      addResident: function (st, home, id) {
        const B = window.Buildings, door = B.frontSpot(home);
        const v = window.Villagers.create(st.world, {
          index: id - 1, x: door.x + 0.5, y: door.y + 0.5,
          buildings: st.buildings, home: home, avoid: st.villagers
        });
        st.villagers.push(v);
        window.__game.Play.renderer().setVillagers(st.villagers);
        return v;
      },
      free: function (st) {
        return window.Session.housingFree(st.buildings, st.villagers);
      },
      residents: function (st) {
        const B = window.Buildings;
        let n = 0;
        st.buildings.forEach(function (h) {
          if (B.typeOf(h) === 'house') n += window.Session.residentsOf(h, st.villagers).length;
        });
        return n;
      }
    };
    return 1;
  })()`);

  /* Старт: 29.9 с — ещё трое; 30.1 с — четверо, у новичка дом и id 4. */
  const birthStart = await js(`(() => {
    const st = window.__birthLab.reset('start');
    const P = window.__game.Play, B = window.Buildings;
    st.seconds = 29.9;
    P.tick(0.01);
    const before = { n: st.villagers.length, seconds: st.seconds };
    st.seconds = 30.0;
    P.tick(0.1);
    const v4 = st.villagers.find(v => v.id === 4);
    const house = window.Session.houseOf(st.buildings);
    const door = house ? B.frontSpot(house) : null;
    const cx = v4 ? Math.floor(v4.x) : -1, cy = v4 ? Math.floor(v4.y) : -1;
    const solid = window.Villagers.blockedMap(st.world, st.buildings);
    return {
      before: before,
      n: st.villagers.length,
      seconds: st.seconds,
      v4: v4 ? { id: v4.id, home: v4.home === house, x: v4.x, y: v4.y } : null,
      near: !!door && Math.max(Math.abs(cx - door.x), Math.abs(cy - door.y)) <= 2,
      land: !!v4 && !!st.world.isLand[cy * st.world.width + cx],
      walkable: !!v4 && window.Villagers.walkable(st.world, solid, cx, cy),
      occupied: !!v4 && st.villagers.filter(v => v !== v4).some(v =>
        Math.floor(v.x) === cx && Math.floor(v.y) === cy)
    };
  })()`);
  check('на 29.9 с в партии ещё три жителя', birthStart.before.n === 3,
    birthStart.before.n + ' чел. на ' + birthStart.before.seconds.toFixed(2) + ' с');
  check('на 30.1 с родился четвёртый: home = дом, id = 4',
    birthStart.n === 4 && !!birthStart.v4 && birthStart.v4.id === 4 && birthStart.v4.home,
    birthStart.n + ' чел., новичок: ' + JSON.stringify(birthStart.v4));
  check('новичок стоит рядом с ЭТИМ домом, на суше и не в занятой клетке',
    birthStart.near && birthStart.land && birthStart.walkable && !birthStart.occupied,
    'рядом: ' + birthStart.near + ', суша: ' + birthStart.land +
    ', проходимо: ' + birthStart.walkable + ', занято: ' + birthStart.occupied);

  /* HUD обновляется без перезагрузки: число и строка новичка — своим кадром. */
  await hudFrame(2);
  const birthHud = await js(`(() => ({
    rows: document.querySelectorAll('#villagerList .villager-row').length,
    count: document.getElementById('villagerCount').textContent,
    name4: (document.querySelector('#villagerList .villager-row[data-vid="4"] b') || {}).textContent || '',
    hireRows: document.querySelectorAll('#hireList .hire-row').length
  }))()`);
  check('HUD без перезагрузки показывает четвёртого в числе и списке',
    birthHud.rows === 4 && birthHud.count.indexOf('4') >= 0 && birthHud.name4 === 'Житель №4',
    birthHud.rows + ' строк, «' + birthHud.count + '», ' + birthHud.name4);

  /* На 60-й секунде места кончились: попытка есть, рождения нет. */
  const birthFull = await js(`(() => {
    const st = window.__game.Play.state, P = window.__game.Play;
    st.seconds = 60.0;
    P.tick(0.1);
    return { n: st.villagers.length, seconds: st.seconds,
             attempts: st.birth.attempts, free: window.__birthLab.free(st) };
  })()`);
  check('ещё через 30 с мест нет — по-прежнему четыре',
    birthFull.n === 4 && birthFull.free === 0 && birthFull.attempts >= 2,
    birthFull.n + ' чел., свободно ' + birthFull.free + ', попыток ' + birthFull.attempts);

  /* Большой пропуск времени (вкладка спала, кадр завис): одна попытка, а
     следующая граница ставится по ТЕКУЩЕМУ времени, а не прибавлением 30. */
  const birthJump = await js(`(() => {
    const st = window.__birthLab.reset('jump'), P = window.__game.Play;
    st.seconds = 95;
    st.birth = { next: 30, attempts: 0 };
    P.tick(0.1);
    return { n: st.villagers.length, seconds: st.seconds,
             attempts: st.birth.attempts, next: st.birth.next };
  })()`);
  check('после большого пропуска — одна попытка и следующая граница по текущему времени',
    birthJump.n === 4 && birthJump.attempts === 1 && birthJump.next === 120,
    birthJump.n + ' чел., попыток ' + birthJump.attempts + ', следующая ' + birthJump.next + ' с');

  /* Три жителя и два дома по четыре: born = min(floor(3/2), 5) = 1. */
  const birthTwoHouses = await js(`(() => {
    const st = window.__birthLab.reset('two-houses'), P = window.__game.Play;
    const house2 = window.__birthLab.addHouse(st);
    if (!house2) return { ok: false, why: 'второй дом не поставился' };
    const before = st.villagers.length;
    st.seconds = 30.0;
    P.tick(0.1);
    const born = st.villagers.slice(before);
    return { ok: true, before: before, n: st.villagers.length, born: born.length,
             home2: born.length === 1 && born[0].home === house2,
             freeBefore: 5, free: window.__birthLab.free(st) };
  })()`);
  check('3 жителя, два дома по 4 → +1, а не +2',
    birthTwoHouses.ok && birthTwoHouses.born === 1 && birthTwoHouses.n === 4 &&
    birthTwoHouses.home2,
    birthTwoHouses.ok ? birthTwoHouses.n + ' чел., новорождённых ' + birthTwoHouses.born
      : birthTwoHouses.why);

  /* Четыре жителя и четыре свободных места: born = min(2, 4) = 2 за один тик.
     Первый дом полон (туда доселён четвёртый), второй пуст. */
  const birthDouble = await js(`(() => {
    const st = window.__birthLab.reset('double'), P = window.__game.Play;
    const house1 = window.Session.houseOf(st.buildings);
    const house2 = window.__birthLab.addHouse(st);
    if (!house2) return { ok: false, why: 'второй дом не поставился' };
    window.__birthLab.addResident(st, house1, 4);
    const free = window.__birthLab.free(st);
    const before = st.villagers.length;
    st.seconds = 30.0;
    P.tick(0.1);
    const born = st.villagers.slice(before);
    return { ok: true, free: free, before: before, n: st.villagers.length,
             born: born.length, ids: born.map(v => v.id),
             homes: born.map(v => v.home === house2) };
  })()`);
  check('4 жителя, 4 свободных места → +2 за один тик',
    birthDouble.ok && birthDouble.free === 4 && birthDouble.born === 2 &&
    birthDouble.n === 6 && birthDouble.ids.join(',') === '5,6' &&
    birthDouble.homes.every(Boolean),
    birthDouble.ok ? birthDouble.free + ' места, родилось ' + birthDouble.born +
      ' (' + birthDouble.ids.join(',') + ')' : birthDouble.why);

  /* Пять жителей и одно место: born = min(floor(5/2), 1) = 1. Вместимость
     дома на время проверки — 6: иначе такого расклада с домом 1 уровня не
     бывает, а правило про одно место всё равно обязано работать. */
  const birthOnePlace = await js(`(() => {
    const st = window.__birthLab.reset('one-place'), P = window.__game.Play;
    const B = window.Buildings, house = window.Session.houseOf(st.buildings);
    const saved = B.HOUSING.house[1];
    B.HOUSING.house[1] = 6;
    window.__birthLab.addResident(st, house, 4);
    window.__birthLab.addResident(st, house, 5);
    const free = window.__birthLab.free(st);
    const before = st.villagers.length;
    st.seconds = 30.0;
    P.tick(0.1);
    const born = st.villagers.slice(before);
    B.HOUSING.house[1] = saved;
    return { free: free, before: before, born: born.length, n: st.villagers.length,
             home: born.length === 1 && born[0].home === house,
             id: born.length === 1 ? born[0].id : null };
  })()`);
  check('5 жителей, 1 место → +1',
    birthOnePlace.free === 1 && birthOnePlace.born === 1 &&
    birthOnePlace.n === 6 && birthOnePlace.home && birthOnePlace.id === 6,
    birthOnePlace.free + ' место, родилось ' + birthOnePlace.born +
    ', всего ' + birthOnePlace.n);

  /* Три жителя и ноль мест: born = 0, попытка ничего не делает. */
  const birthZero = await js(`(() => {
    const st = window.__birthLab.reset('zero'), P = window.__game.Play;
    const B = window.Buildings, house = window.Session.houseOf(st.buildings);
    const saved = B.HOUSING.house[1];
    B.HOUSING.house[1] = 3;
    const free = window.__birthLab.free(st);
    const before = st.villagers.length;
    st.seconds = 30.0;
    P.tick(0.1);
    const born = st.villagers.length - before;
    B.HOUSING.house[1] = saved;
    return { free: free, born: born, n: st.villagers.length };
  })()`);
  check('3 жителя, 0 свободных мест → 0',
    birthZero.free === 0 && birthZero.born === 0 && birthZero.n === 3,
    birthZero.free + ' мест, родилось ' + birthZero.born);

  /* Один житель: пары нет, рождения нет — даже при свободном доме. */
  const birthAlone = await js(`(() => {
    const st = window.__birthLab.reset('alone'), P = window.__game.Play;
    st.villagers = st.villagers.slice(0, 1);
    P.renderer().setVillagers(st.villagers);
    const free = window.__birthLab.free(st);
    st.seconds = 30.0;
    P.tick(0.1);
    return { n: st.villagers.length, free: free };
  })()`);
  check('1 житель → 0, хотя места в доме есть',
    birthAlone.n === 1 && birthAlone.free > 0,
    birthAlone.n + ' чел., свободно ' + birthAlone.free);

  /* Меню: время идёт, поэтому рождение случается и за открытой доской.
     Проверяем ту же границу 30 с: 29.9 + 0.2 = 30.1. */
  const birthMenu = await js(`(() => {
    const st = window.__birthLab.reset('menu'), P = window.__game.Play;
    st.seconds = 29.9;
    P.pause();
    P.tick(0.2);
    const during = { n: st.villagers.length, seconds: st.seconds,
                     running: st.running, mode: st.mode };
    P.resume();
    P.tick(0.1);
    return { during: during, n: st.villagers.length, seconds: st.seconds };
  })()`);
  check('меню не останавливает время: рождение на 30-й секунде случилось',
    birthMenu.during.n === 4 && birthMenu.during.running &&
    birthMenu.during.mode === 'paused' &&
    birthMenu.during.seconds >= 30.1 - 1e-9,
    birthMenu.during.n + ' чел., время ' + birthMenu.during.seconds.toFixed(2) +
      ', режим ' + birthMenu.during.mode);
  check('после закрытия меню рождение не повторяется',
    birthMenu.n === 4 && birthMenu.seconds >= 30.2 - 1e-9,
    birthMenu.n + ' чел., время ' + birthMenu.seconds.toFixed(2));

  /* Снимок старожилов и проявление — в одном прогоне: между вызовами страница
     успела бы прокрутить кадры, и «0 → 1» перестало бы быть проверкой. */
  const birthSnapshot = await js(`(() => {
    const st = window.__birthLab.reset('snapshot'), P = window.__game.Play;
    const V = window.Villagers;
    const snap = v => ({ x: v.x, y: v.y, state: v.state, anim: v.anim,
      path: JSON.stringify(v.path), tree: v.tree ? v.tree.x + ':' + v.tree.y : null,
      step: v.step, goal: JSON.stringify(v.goal), employer: !!v.employer,
      hold: v.hold, chopT: v.chopT });
    const before = st.villagers.map(snap);
    const born = window.Session.tryBirth(st.world, P.renderer(), st.villagers, st.buildings);
    const after = st.villagers.slice(0, before.length).map(snap);
    const changed = before.map((b, i) => JSON.stringify(b) !== JSON.stringify(after[i]));
    const v = born[0];
    /* Второй раз на этой же границе не рожаем: часы ставим на 60. */
    st.seconds = 30.0;
    st.birth = { next: 60, attempts: 1 };
    const x0 = v ? v.x : 0, y0 = v ? v.y : 0;
    const steps = [{ t: v.appearT, a: V.appear(v), x: v.x, y: v.y }];
    for (let i = 0; i < 5; i++) {
      P.tick(0.1);
      steps.push({ t: v.appearT, a: V.appear(v), x: v.x, y: v.y });
    }
    const moved = steps.some(s => s.x !== x0 || s.y !== y0);
    const st1 = { state: v.state, path: !!v.path, x: v.x, y: v.y };
    P.tick(0.1);
    return {
      born: born.length, n: st.villagers.length, changed: changed,
      dur: v.appearDur, first: steps[0], last: steps[steps.length - 1],
      steps: steps, moved: moved,
      after: { state: v.state, path: !!v.path, x: v.x, y: v.y,
               moved: v.x !== st1.x || v.y !== st1.y }
    };
  })()`);
  check('рождение не трогает старожилов: state/path/tree/x/y те же',
    birthSnapshot.born === 1 && birthSnapshot.n === 4 &&
    birthSnapshot.changed.every(c => !c),
    'изменено: ' + birthSnapshot.changed.map((c, i) => c ? i + 1 : '').filter(Boolean).join(','));
  check('новичок проявляется 0 → 1 за ~0.5 с и стоит на месте',
    birthSnapshot.dur >= 0.4 && birthSnapshot.dur <= 0.6 &&
    birthSnapshot.first.t === 0 && birthSnapshot.first.a === 0 &&
    Math.abs(birthSnapshot.last.t - birthSnapshot.dur) < 1e-9 &&
    birthSnapshot.last.a === 1 && !birthSnapshot.moved,
    'за ' + birthSnapshot.dur + ' с: ' + birthSnapshot.steps.map(s => s.a.toFixed(1)).join(' → ') +
    ', сдвиг: ' + birthSnapshot.moved);
  check('после проявления новорождённый живёт обычной жизнью',
    birthSnapshot.after.state === 'wander' &&
    (birthSnapshot.after.path || birthSnapshot.after.moved),
    JSON.stringify(birthSnapshot.after));

  /* Серия рождений: 3 → 4 → 6 → 8, дальше мест нет. Ни одного бездомного,
     и сумма жильцов по домам равна списку партии. */
  const birthSeries = await js(`(() => {
    const st = window.__birthLab.reset('series'), P = window.__game.Play;
    const house2 = window.__birthLab.addHouse(st);
    if (!house2) return { ok: false, why: 'второй дом не поставился' };
    const at = [];
    [30, 60, 90, 120].forEach(function (t) {
      st.seconds = t;
      P.tick(0.1);
      at.push({ t: t + 0.1, n: st.villagers.length, free: window.__birthLab.free(st) });
    });
    const ids = st.villagers.map(v => v.id).sort((a, b) => a - b);
    return { ok: true, at: at, n: st.villagers.length,
             noHome: st.villagers.filter(v => !v.home).length,
             sum: window.__birthLab.residents(st), ids: ids,
             holes: ids.some((id, i) => id !== i + 1) };
  })()`);
  check('после серии рождений нет ни одного home === null',
    birthSeries.ok && birthSeries.noHome === 0 && birthSeries.n === 8,
    birthSeries.ok ? birthSeries.n + ' жителей, бездомных ' + birthSeries.noHome : birthSeries.why);
  check('Σ residentsOf(h) === villagers.length',
    birthSeries.ok && birthSeries.sum === birthSeries.n,
    birthSeries.ok ? birthSeries.sum + ' жильцов на ' + birthSeries.n + ' жителей' : birthSeries.why);
  check('id новорождённых без дыр и повторов',
    birthSeries.ok && !birthSeries.holes, birthSeries.ok ? birthSeries.ids.join(',') : birthSeries.why);
  check('рождения идут по 30 секунд: 4, 6, 8 и упор в вместимость',
    birthSeries.ok && birthSeries.at.map(x => x.n).join(',') === '4,6,8,8' &&
    birthSeries.at[3].free === 0,
    birthSeries.ok ? birthSeries.at.map(x => x.t.toFixed(1) + ' с: ' + x.n + ' чел.').join(' · ')
      : birthSeries.why);

  await finish();

  async function finish() {
    // Ошибки страницы (window.__errs) читаются в конце: цикл игры умирает
    // молча, и без этого списка причина осталась бы невидимой.
    let pageErrs = [];
    try { pageErrs = await js(`window.__errs || []`); } catch (e) { /* страница уже недоступна */ }
    if (errors.length || pageErrs.length) {
      console.log('\nцикл страницы: ' + JSON.stringify(await js(`window.__loop`)));
      console.log('\nошибки:');
      errors.forEach(e => console.log('  ' + e));
      pageErrs.forEach(e => console.log('  (страница) ' + e));
    } else console.log('\nошибок в консоли нет');
    console.log('\n' + (fails ? 'ПРОВАЛЕНО проверок: ' + fails : 'все проверки игры пройдены'));
    ws.close(); killChrome();
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    process.exit(fails ? 1 : 0);
  }
})().catch(e => { console.error('ошибка: ' + e.message); killChrome(); process.exit(1); });
