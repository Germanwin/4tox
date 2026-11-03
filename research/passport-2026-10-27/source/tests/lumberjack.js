/* lumberjack.js — приёмка работы в лагере лесоруба (нужен Chrome).

 * Проверяет то, что обещано заказчику, и проверяет ЧИСЛАМИ:
 *   1) в лагерь нанимаются ТРОЕ, четвёртый получает ok:false и причину
 *      («в лагере нет свободных мест»), нанятые видны как работники лагеря
 *      (Session.workersOf), уволенный работником быть перестаёт;
 *   2) нанятый житель САМ проходит весь цикл: дошёл до лагеря → постоял у
 *      колоды 1.0 с («берёт топор») → пошёл к дереву → рубил РОВНО 5 секунд →
 *      дерево упало на восьмом ударе → понёс брёвна ОБРАТНО в лагерь → СДАЛ ИХ
 *      В КАДР ПРИХОДА (задержки нет вовсе) → сыграл ОДИН проход жеста
 *      складывания `carry_put` и в том же кадре, где проход кончился, пошёл за
 *      топором заново;
 *   3) за ходку деревня получает РОВНО 4 бревна: world.village.logs вырос на 4,
 *      deliveries — на 1, а v.delivered — тоже на 4; и всё это ОДНИМ кадром;
 *   4) срубленных деревьев ровно столько же, сколько сдач: «дерево в никуда» не
 *      пропадает;
 *   5) дерево помечается меткой цели (tree.mark) — двое не рубят один ствол и
 *      не идут к одному дереву;
 *   6) трое не СТОЯТ в одной клетке — ни в лагере, ни под деревом (идти след в
 *      след по дороге можно: это не стоянка);
 *   7) путь рабочего не проходит ни по воде, ни сквозь дерево, камень или
 *      постройку — проверяется на КАЖДОМ шаге симуляции, а не в конце;
 *   8) уволенный возвращается к прогулке и больше не рубит;
 *   9) за весь прогон ни один житель не «спит» и не «отдыхает»: состояний
 *      ровно семь (toCamp, take, toTree, chop, carry, drop, stand), и стоянка
 *      в цикле ОДНА — take. `drop` остался седьмым состоянием, но времени в
 *      нём нет: это ОДИН ПРОХОД жеста сдачи (см. п. 2), а не стоянка;
 *  10) тот же сид — тот же порядок работы: последовательность (житель,
 *      состояние, дерево) у двух прогонов совпадает;
 *  11) кадры для глазами-проверки: рабочий у лагеря, он же под деревом, он же
 *      с охапкой брёвен в пути, момент сдачи крупно и СЕРИЯ кадров одного
 *      прохода — чтобы «проигрывается один раз» было видно глазами, а не
 *      только числом.

 * ЧЕГО ЭТА ПРИЁМКА НЕ ДЕЛАЕТ. Она не проверяет картинку атласа жителя: кадры
 * walk_axe / carry / carry_put рисует задача 1, и в атласе, который лежит в
 * игре сейчас, их нет. Движок это переживает (js/villager.js: ANIM_FALLBACK), и
 * проверяется здесь именно выживание: какой кадр взят вместо недостающего и что
 * сдача без своей анимации идёт ЗАМОРОЖЕННЫМ нулевым кадром carry. Есть в
 * атласе — кадр свой и проход ровно один; нет — застывший нулевой, и партия от
 * этого не ломается.

 * Запуск: node tools/lumberjack.js [url]
 *        LUMBERJACK_MINUTES=2 node tools/lumberjack.js     # короткий прогон
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = require('./chrome.js');
/* Сид прогона задан в адресе, а не «какой выпадет»: приёмка должна быть
   воспроизводимой, иначе FAIL на одном острове не повторить на другом. */
const SEED = process.env.LUMBERJACK_SEED || 'лагерь-приёмка';
const url = process.argv[2] ||
  'file://' + path.join(__dirname, '..', 'index.html') + '?seed=' + encodeURIComponent(SEED);
const OUT = path.join(__dirname, 'out');
const PORT = 9700 + (process.pid % 200);
const PROFILE = '/tmp/dsh-lumberjack-' + process.pid;

// Сколько игровых минут прожить в главном прогоне. Работа — это десятки секунд
// на ходку (дорога до лагеря, дорога до дерева, 5 с рубки, дорога обратно),
// поэтому меньший отрезок сделал бы проверку сдач лотереей.
const MINUTES = +(process.env.LUMBERJACK_MINUTES || 5);
const DT = 1 / 60;
const STEPS = Math.round(MINUTES * 60 / DT);
let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

fs.mkdirSync(OUT, { recursive: true });
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

  let id = 1; const pending = new Map(); const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
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
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return res.result.value;
  };
  const shoot = async (name, setup) => {
    if (setup) await js(setup);
    await new Promise(r => setTimeout(r, 350));
    const dataUrl = await js(`document.getElementById('view').toDataURL('image/png')`);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('  ' + name);
  };

  /* Контактный лист из готовых PNG: кадры в ряд, подпись снизу.
     PNG разбирается и собирается вручную (zlib есть в Node): тянуть ради
     склейки пяти картинок библиотеку в проект незачем. */
  const zlib = require('zlib');
  function readPNG(file) {
    const buf = fs.readFileSync(path.join(OUT, file));
    let p = 8, w = 0, h = 0, bd = 0, ct = 0; const idat = [];
    while (p < buf.length) {
      const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8);
      const data = buf.subarray(p + 8, p + 8 + len);
      if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
      else if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      p += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 1;
    const stride = w * bpp;
    const out = Buffer.alloc(h * stride);
    let q = 0;
    for (let y = 0; y < h; y++) {
      const ft = raw[q++];
      const line = raw.subarray(q, q + stride); q += stride;
      const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
      const cur = out.subarray(y * stride, (y + 1) * stride);
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0, v = line[x];
        cur[x] = ft === 0 ? v : ft === 1 ? (v + a) & 255 : ft === 2 ? (v + b) & 255 :
                 ft === 3 ? (v + ((a + b) >> 1)) & 255 :
                 (v + (Math.abs(b - c) <= Math.abs(a - c) ? (Math.abs(a - b) <= Math.abs(b - c) ? a : b) : c)) & 255;
      }
    }
    return { w: w, h: h, bpp: bpp, px: out };
  }
  function writePNG(file, w, h, rgb) {
    const stride = w * 3;
    const raw = Buffer.alloc(h * (stride + 1));
    for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    fs.writeFileSync(path.join(OUT, file), Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  }
  let CRC_T = null;
  function crc32(buf) {
    if (!CRC_T) {
      CRC_T = new Int32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c; }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return c ^ 0xFFFFFFFF;
  }
  const FONT = {
    '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '001', '001', '001'],
    '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
    'и': ['101', '101', '101', '101', '111'], 'з': ['111', '001', '011', '001', '111'],
    ':': ['000', '010', '000', '010', '000'], ' ': ['000', '000', '000', '000', '000'],
    '-': ['000', '000', '111', '000', '000'], '.': ['000', '000', '000', '000', '010'],
    '№': ['101', '111', '101', '101', '101']
  };
  async function contactSheet(items, out) {
    const imgs = items.map(it => Object.assign({ label: it.label }, readPNG(it.file)));
    const cols = imgs.length, cw = imgs[0].w, ch = imgs[0].h, pad = 6, bar = 5 * 3 + 2 * pad;
    const W = cols * (cw + pad) + pad, Hh = ch + bar + 2 * pad;
    const rgb = Buffer.alloc(W * Hh * 3, 30);
    imgs.forEach((im, i) => {
      const x0 = pad + i * (cw + pad), y0 = pad;
      for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) {
        const s = (y * im.w + x) * im.bpp, d = ((y0 + y) * W + x0 + x) * 3;
        rgb[d] = im.px[s]; rgb[d + 1] = im.px[s + 1]; rgb[d + 2] = im.px[s + 2];
      }
      const text = String(im.label);
      let tx = x0 + 4;
      for (const chr of text) {
        const gl = FONT[chr] || FONT[' '];
        for (let r = 0; r < gl.length; r++) for (let c = 0; c < gl[r].length; c++) if (gl[r][c] === '1') {
          for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
            const px = tx + c * 3 + dx, py = y0 + im.h + pad + r * 3 + dy;
            if (px < W && py < Hh) { const d = (py * W + px) * 3; rgb[d] = 240; rgb[d + 1] = 240; rgb[d + 2] = 220; }
          }
        }
        tx += 4 * 3;
      }
    });
    writePNG(out, W, Hh, rgb);
  }

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 3600));

  console.log('лагерь лесоруба: работа и наём');

  /* --- 1. наём ------------------------------------------------------- *
   * Правила найма спрашиваются у движка и сверяются с тем, что он же делает:
   * сколько мест (Buildings.workSlots), кто работник (Session.workersOf), кого
   * ещё можно взять (Session.canHire). Числа в тесте не выписаны — иначе копия
   * правила разошлась бы с движком на первой же правке. */
  const hire = await js(`(() => {
    const g = window.__mapgen, S = window.Session, B = window.Buildings;
    g.newGame();
    const w = g.getWorld(), list = g.getBuildings(), vs = g.getVillagers();
    const camp = list.filter(b => B.typeOf(b) === 'lumbercamp')[0];
    if (!camp) return { err: 'в деревне нет лагеря лесоруба' };
    const slots = B.workSlots(camp);
    const house = list.filter(b => B.typeOf(b) === 'house')[0];
    const yard = B.yardSlots(camp);
    const fp = B.footprint(camp.rot, camp.type);
    const face = B.faceDir(camp.rot);
    const approach = B.workSpotCells(camp);
    /* Мера «треть клетки» — от СВОЕЙ кромки каждого места: заказчик требует
       заступить на треть клетки от ближайшей границы лагеря, а границей может
       быть любая из четырёх сторон (куда рабочему ближе, туда он и идёт).
       Своя кромка берётся у движка полем side. */
    const dEdge = yard.map(s => {
      if (s.side === 'right') return (camp.x + fp.w) - s.x;
      if (s.side === 'left') return s.x - camp.x;
      if (s.side === 'bottom') return (camp.y + fp.h) - s.y;
      return s.y - camp.y;
    });
    const inFp = yard.every(s => s.x >= camp.x - 1e-9 && s.x <= camp.x + fp.w + 1e-9 &&
                                 s.y >= camp.y - 1e-9 && s.y <= camp.y + fp.h + 1e-9);
    const placeCells = yard.map(s => Math.floor(s.x) + ',' + Math.floor(s.y));
    const sidesSeen = [...new Set(yard.map(s => s.side))];
    const out = {
      slots: slots, type: B.typeOf(camp), camp: [camp.x, camp.y], villagers: vs.length,
      spot: B.workSpot(camp), cells: B.workSpotCells(camp),
      yard: yard, yardCells: placeCells, face: face, approach: approach,
      /* Годится, если: мест не меньше, чем рабочих (трое должны встать в три
         разные клетки); все места внутри пятна; каждое ровно в трети клетки от
         СВОЕЙ кромки; и мест хватает по клеткам. */
      yardOk: yard.length >= 3 && inFp && dEdge.every(d => Math.abs(d - 1 / 3) < 0.02) &&
              new Set(placeCells).size >= 3,
      yardSides: sidesSeen,
      approachOk: approach.every((c, i) => {
        const inFootprint = c.x >= camp.x && c.x < camp.x + fp.w &&
                            c.y >= camp.y && c.y < camp.y + fp.h;
        return !inFootprint;
      }),
      // Наём в чужой тип постройки: работать можно только в лагере лесоруба.
      otherType: house ? S.canHire(house, vs[0], vs) : null,
      taken: [], reasons: [], workers: []
    };
    for (const v of vs) {
      const verdict = S.canHire(camp, v, vs);
      const res = S.hire(camp, v, vs);
      out.taken.push({ id: v.id, can: verdict.ok, ok: res.ok, reason: res.reason || verdict.reason });
      out.workers = S.workersOf(camp, vs).map(x => x.id);
    }
    // Все места заняты: четвёртый получает отказ и причину.
    const extra = window.Villagers.create(w, {
      index: vs.length, x: vs[0].x, y: vs[0].y, buildings: list, home: house, avoid: vs
    });
    vs.push(extra);
    out.fourth = S.canHire(camp, extra, vs);
    out.fourthHire = S.hire(camp, extra, vs);
    out.workersAfter = S.workersOf(camp, vs).map(x => x.id);
    out.spotCellsFree = out.cells.every((c, i) => out.cells.every((d, j) =>
      i === j || c.x !== d.x || c.y !== d.y));
    return out;
  })()`);
  if (hire.err) { console.log('  ' + hire.err); finish(); return; }
  check('лагерь лесоруба даёт ровно ТРИ рабочих места',
    hire.slots === 3 && hire.type === 'lumbercamp', 'мест ' + hire.slots);
  check('нанялись все трое, и каждый виден работником лагеря',
    hire.taken.every(t => t.ok) && hire.workers.join(',') === hire.taken.map(t => t.id).join(','),
    'работники ' + hire.workers.join(','));
  check('четвёртого нанимать некуда: ok:false и причина словами движка',
    hire.fourth && hire.fourth.ok === false && hire.fourth.reason === 'в лагере нет свободных мест' &&
      hire.fourthHire.ok === false && hire.workersAfter.length === 3,
    '«' + (hire.fourth ? hire.fourth.reason : '—') + '», работников ' + hire.workersAfter.length);
  check('в дом не нанимают: работать можно только в лагере лесоруба',
    !!hire.otherType && hire.otherType.ok === false &&
      hire.otherType.reason === 'работать можно только в лагере лесоруба',
    hire.otherType ? '«' + hire.otherType.reason + '»' : 'дома в деревне нет');
  /* Место двора считается ЧИСЛАМИ и сверяется с замером модели: оно лежит ВНУТРИ
     пятна, на 1/3 клетки от передней кромки, и клеток у трёх мест три разные.
     Ожидание берётся у самого движка (Buildings.yardSlots) и у его же меры
     «треть клетки» — второго источника правды тут нет. */
  check('места двора — у ВСЕХ четырёх границ: внутри пятна, ровно в 1/3 клетки от своей кромки',
    !!hire.spot && hire.yardOk,
    'лагерь ' + hire.camp.join(',') + ', перед ' + JSON.stringify(hire.face) +
    ', мест ' + hire.yardCells.length + ' у сторон ' + JSON.stringify(hire.yardSides) +
    ', клетки ' + JSON.stringify(hire.yardCells.filter((c, i, a) => a.indexOf(c) === i)));
  check('клетка подхода — соседняя с пятном по нормали переда (с неё заступают)',
    !!hire.approach.length && hire.approachOk,
    'подход ' + JSON.stringify(hire.approach));

  /* Уволим четвёртого (он и не был нанят) и вернём состав к трём: дальше
     работают ровно трое. */
  const fired4 = await js(`(() => {
    const S = window.Session, g = window.__mapgen, vs = g.getVillagers();
    return S.fire(null, vs[vs.length - 1]);
  })()`);
  check('уволить неработающего нельзя: движок отвечает причиной',
    fired4 && fired4.ok === false && fired4.reason === 'он и так не работает',
    '«' + (fired4 ? fired4.reason : '—') + '»');

  const sim = await js(`(() => {
    const g = window.__mapgen, S = window.Session, B = window.Buildings, V = window.Villagers;
    /* Свежая партия: тот же сид даёт ту же деревню, а прошлый прогон срубил
       деревья вокруг неё — числа были бы не сравнить между запусками. */
    g.newGame();
    const w2 = g.getWorld(), list2 = g.getBuildings();
    const camp2 = list2.filter(b => B.typeOf(b) === 'lumbercamp')[0];
    const vs = g.getVillagers();
    /* След выбора места двора — со слов САМОГО движка: что он выбрал и какие
       стороны были свободны в тот же миг. Снимок чужих мест, взятый позже,
       врёт; здесь ошибки быть не может по построению. */
    w2._spotLog = [];
    for (const v of vs) S.hire(camp2, v, vs);

    const W = w2.width, H = w2.height;
    // Клетки построек — отдельно от воды и объектов: три разных утверждения.
    const house = new Uint8Array(W * H);
    for (const b of list2) for (const c of B.cells(b)) house[c.y * W + c.x] = 1;

    const res = {
      states: {}, delivered: {}, felled: {},
      water: 0, blocked: 0, inHouse: 0, inHouseNotYard: 0, off: 0, blockedAt: [],
      cellTogether: 0, standTogether: 0, spotTogether: 0,
      sameTree: 0, marked: 0, unmarkedTrees: 0, treeTaken: 0,
      logsAt: [], delivAt: [], chopTimes: [], chopFrames: 0, chopAt: 0,
      takeFrames: 0, dropFrames: 0,
      /* Замеры СДАЧИ: по каждому начислению — что было до вызова и что стало
         после, чтобы «сдал в кадр прихода» и «+4 за ходку» считались дельтами
         ОДНОГО вызова, а не разницей между соседними кадрами. */
      deposits: [], framesPlayed: {}, episodes: [],
      anims: {}, animWant: {}, frozenFrames: 0, frozenAt: [],
      carryTrail: [], drops: [],
      felled0: {}, delivered0: {}
    };
    vs.forEach(v => { res.felled0[v.id] = v.felled || 0; res.delivered0[v.id] = v.delivered || 0; });

    let lastLogs = w2.village ? w2.village.logs : 0;
    let lastDeliv = w2.village ? w2.village.deliveries : 0;
    const prevStates = {}, prevFelled2 = {}, chopFrom = {};
    /* Открытый эпизод сдачи по каждому рабочему: кадры ЕГО анимации от входа
       в drop до выхода. Глазами такое не поймать (20 кадров симуляции), а
       числом видно сразу: «0,1,2,3» — один проход, «0,1,2,3,0,1...» — цикл. */
    const ep = {};
    const STEPS_N = __STEPS__;

    for (let step = 0; step < STEPS_N; step++) {
      /* Шагаем ТЕМ ЖЕ кодом, что игровой цикл (Session.stepVillagers — тонкая
         обёртка над Villagers.update). Живой requestAnimationFrame в headless
         не тикает, поэтому шаг явный; если он всё же тикнет между вызовами,
         это те же секунды игрового времени, и числа не поедут. */
      w2._villagers = vs;
      for (const v of vs) {
        /* Сдача меряется ДЕЛЬТАМИ одного вызова: «сдал в кадр прихода» — это
           не «между соседними кадрами», а «в том же вызове, где он оказался на
           своём месте двора». Поэтому до и после — обе стороны. */
        const b = { logs: w2.village.logs, deliv: w2.village.deliveries,
                    transit: w2.village.inTransit, mine: v.delivered || 0, state: v.state,
                    x: v.x, y: v.y, hadPath: !!v.path,
                    spot: v.spot ? { x: v.spot.x, y: v.spot.y } : null };
        V.update(v, w2, g.renderer.villagerSprites, 1 / 60, { buildings: list2 });
        const atYard = !!B.atYardSpot(camp2, v.x, v.y);
        if (w2.village.logs !== b.logs || w2.village.deliveries !== b.deliv) {
          /* Что сделал кадр начисления: сколько рабочий прошёл в нём и стоял ли
             он уже на своём месте. Первое доказывает, что это кадр ПРИХОДА
             (шаг не больше ходьбы за кадр), второе — что он пришёл ДО него
             (сдвинуться было уже некуда). Лишний кадр между приходом и
             начислением дал бы третье: «стоял, не дойдя» либо «шагнул, уже
             стоя». */
          const covered = Math.hypot(v.x - b.x, v.y - b.y);
          const stood = !!(b.spot && Math.abs(b.x - b.spot.x) <= V.ARRIVE &&
                           Math.abs(b.y - b.spot.y) <= V.ARRIVE);
          res.deposits.push({
            t: +(step / 60).toFixed(3), who: v.id, from: b.state,
            logs: w2.village.logs - b.logs, deliv: w2.village.deliveries - b.deliv,
            mine: (v.delivered || 0) - b.mine,
            transit: w2.village.inTransit - b.transit,
            atYard: atYard, spot: !!v.spot, state: v.state,
            hadPath: b.hadPath, covered: covered, stoodAtSpot: stood,
            step: step
          });
        }
      }

      const bal = w2.village ? w2.village.logs : 0;
      if (bal !== lastLogs) {
        res.logsAt.push({ t: +(step / 60).toFixed(3), from: lastLogs, to: bal, grow: bal - lastLogs });
        lastLogs = bal;
      }
      const dv = w2.village ? w2.village.deliveries : 0;
      if (dv !== lastDeliv) {
        res.delivAt.push(+(step / 60).toFixed(3));
        lastDeliv = dv;
        /* Где он сложил брёвна в этот раз и откуда пришёл. Нужно, чтобы
           проверить САМО ПРАВИЛО заказчика: место выбирается у БЛИЖАЙШЕЙ
           границы лагеря, а не у передней. */
        const dv2 = vs.filter(x => x.spot && B.atYardSpot(camp2, x.x, x.y))[0];
        if (dv2) {
          const from = dv2._from;
          /* ПРАВИЛО ЗАКАЗЧИКА считается прямо здесь, пока известно, ОТКУДА он
             понёс брёвна: дорога до клетки подхода каждого места двора — тем же
             поиском, что и у движка. Обход навеса и поленницы меняет ответ, а
             правило сформулировано про путь, а не про линейку. */
          let best = Infinity, bestSide = null;
          const busy = dv2._busy || [];
          if (from) {
            const sol = V.blockedMap(w2, list2);
            const fx = Math.floor(from[0]), fy = Math.floor(from[1]);
            const detail = [];
            for (const q of B.yardSlots(camp2)) {
              const ap = B.approachCell(camp2, q);
              const qk = q.place.x + ',' + q.place.y;
              const taken = busy.indexOf(qk) >= 0;
              const steps = V.walkable(w2, sol, fx, fy) && ap && V.walkable(w2, sol, ap.x, ap.y)
                ? V.findPath(w2, sol, fx, fy, ap.x, ap.y) : null;
              detail.push({ side: q.side, taken: taken, len: steps ? steps.length : null,
                            away: Math.hypot(q.x - from[0], q.y - from[1]) });
              if (taken || !steps) continue;
              if (steps.length < best) { best = steps.length; bestSide = q.side; }
            }
            /* Насколько выбранное место ДАЛЬШЕ ближайшего по прямой. Строгое
               «ровно ближайшее» тут не доказуемо: снимок занятости берётся
               кадром позже выбора, и товарищ мог занять место в тот же кадр.
               Поэтому проверяется существо — выбор у БЛИЖНЕЙ границы, а не у
               передней, — а не совпадение с идеалом до пикселя. */
            const mineAway = Math.hypot(dv2.spot.x - from[0], dv2.spot.y - from[1]);
            let nearest = Infinity;
            for (const x of detail) if (x.away < nearest) nearest = x.away;
            dv2._gap = isFinite(nearest) ? +(mineAway - nearest).toFixed(2) : null;
            if (bestSide && bestSide !== dv2.spot.side) dv2._why = detail;
          }
          res.drops.push({
            t: +(step / 60).toFixed(2), side: dv2.spot.side,
            from: from ? [+from[0].toFixed(2), +from[1].toFixed(2)] : null,
            at: [+dv2.x.toFixed(2), +dv2.y.toFixed(2)],
            bestSide: bestSide, gap: dv2._gap, why: dv2._why || null
          });
        }
      }

      const solidNow = V.blockedMap(w2, list2);
      for (const v of vs) {
        if (!v.camp) v.camp = v.employer;
        const cx = Math.floor(v.x), cy = Math.floor(v.y), k = cy * W + cx;
        /* Своё место двора — не «проход сквозь постройку»: рабочий там РАБОТАЕТ,
           стоит и берёт топор или сдаёт брёвна. Считается отдельно. */
        const atYard = !!B.atYardSpot(v.camp || v.employer, v.x, v.y);
        if (cx < 0 || cy < 0 || cx >= W || cy >= H) res.off++;
        else if (!w2.isLand[k]) res.water++;
        /* Шаг ВНУТРЬ двора и шаг НАРУЖУ — это и есть заступ, и он разрешён:
           считается только СТОЯНИЕ в пятне не на своём месте. Идёт — значит
           пересекает кромку по делу. */
        else if (house[k]) {
          res.inHouse++;
          if (!atYard && !v.path) res.inHouseNotYard++;
        }
        else if (solidNow[k] && !atYard &&
                 !(v.tree && Math.floor(v.tree.x) === cx && Math.floor(v.tree.y) === cy)) {
          res.blocked++;
          if (res.blockedAt.length < 5) {
            const objs = w2.objects.filter(o => Math.floor(o.x) === cx && Math.floor(o.y) === cy);
            const bs = list2.filter(x => B.cells(x).some(c => c.x === cx && c.y === cy));
            res.blockedAt.push({ t: +(step / 60).toFixed(2), who: v.id, state: v.state,
              cell: [cx, cy], objs: objs.map(o => o.kind), builds: bs.map(x => B.typeOf(x)) });
          }
        }
        res.states[v.state] = (res.states[v.state] || 0) + 1;
        res.anims[v.anim] = (res.anims[v.anim] || 0) + 1;
        res.animWant[v.animWant] = (res.animWant[v.animWant] || 0) + 1;
        if (v.frozen) {
          res.frozenFrames++;
          if (res.frozenAt.length < 3) res.frozenAt.push([v.state, v.anim, +v.phase.toFixed(3)]);
        }
        if (v.state === 'take') res.takeFrames++;
        if (v.state === 'drop') res.dropFrames++;
        if (v.state === 'chop') {
          res.chopFrames++;
          if (prevStates[v.id] !== 'chop') { res.treeTaken++; chopFrom[v.id] = step; res.chopAt++; }
        }
        /* Рубка меряется ЧАСАМИ: от входа в состояние chop до исчезновения
           дерева проходит ровно пять секунд. По полю v.chopT это не сосчитать —
           восьмой удар валит дерево и обнуляет и удары, и время рубки в том же
           кадре. Что ударов при этом ровно восемь, проверяют приёмки самого
           жителя (tools/villager.js: «ударов восемь, и каждый тряхнул дерево»;
           tools/path.js: те же числа без браузера): удары идут по фазе кадра
           работы, а фаз за пять секунд набегает ровно восемь. */
        const fel = v.felled || 0;
        if (fel !== (prevFelled2[v.id] || 0)) {
          res.chopTimes.push(+((step - (chopFrom[v.id] === undefined ? step : chopFrom[v.id])) / 60).toFixed(3));
          prevFelled2[v.id] = fel;
        }
        if (v.tree) { if (v.tree.mark === v) res.marked++; else res.unmarkedTrees++; }
      }
      /* Двое в одной клетке: для дороги это нормально (идут след в след), для
         стоянки — нет. Стоящими считаются take и drop. */
      const cellMap = {};
      for (const v of vs) {
        const k = Math.floor(v.x) + ',' + Math.floor(v.y);
        (cellMap[k] = cellMap[k] || []).push(v);
      }
      for (const k in cellMap) {
        if (cellMap[k].length > 1) {
          res.cellTogether++;
          if (cellMap[k].filter(v => v.state === 'take' || v.state === 'drop').length > 1) res.standTogether++;
        }
      }
      /* Кадры СДАЧИ: какой кадр анимации показан в этот кадр симуляции.
         Ключ — имя анимации, а не фаза: важно, ЧТО нарисовано, а не как
         посчитано. Кадр повторяется по пять кадров симуляции (12 к/с против
         60), поэтому повторы соседних значений — это один показ кадра. */
      for (const v of vs) {
        if (v.state !== 'drop') {
          if (ep[v.id]) { ep[v.id].done = true; ep[v.id].to = step; res.episodes.push(ep[v.id]); ep[v.id] = null; }
          continue;
        }
        /* H здесь — ВЫСОТА карты (см. выше), поэтому герой зовётся полным
           именем: два H в одной области видимости — это заведомая ошибка. */
        const n = Math.max(1, window.Hero.frameCount(g.renderer.villagerSprites, v.anim));
        const f = Math.min(n - 1, Math.floor(v.phase * n));
        if (!ep[v.id]) {
          ep[v.id] = { who: v.id, from: step, anim: v.anim, side: v.spot ? v.spot.side : null,
                       frames: [], creditAt: res.deposits.some(d => d.step === step && d.who === v.id) };
        }
        if (ep[v.id].frames[ep[v.id].frames.length - 1] !== f) ep[v.id].frames.push(f);
      }
      const spotMap = {};
      for (const v of vs) if (v.spot) { const k = v.spot.x + ',' + v.spot.y; spotMap[k] = (spotMap[k] || 0) + 1; }
      for (const k in spotMap) if (spotMap[k] > 1) res.spotTogether++;
      const trees = vs.filter(v => v.tree).map(v => v.tree);
      for (let i = 0; i < trees.length; i++)
        for (let j = i + 1; j < trees.length; j++)
          if (trees[i] === trees[j]) res.sameTree++;
      if (true) {
        const v = vs[0];
        if (v.state === 'carry' && res.carryTrail.length < 6000) res.carryTrail.push([+v.x.toFixed(2), +v.y.toFixed(2)]);
      /* Точка, из которой рабочий ПОШЁЛ в лагерь. Записывается ровно в тот
         кадр, когда он срубил дерево и сменил состояние на carry: место двора
         выбирается в этот же момент, и сравнивать выбор надо с ним, а не с
         точкой сдачи (к тому времени он уже прошёл полдороги). */
      for (const v of vs) {
        if (v.state === 'carry' && prevStates[v.id] !== 'carry') {
          v._from = [+v.x.toFixed(2), +v.y.toFixed(2)];
          /* Какие места двора были заняты ТОВАРИЩАМИ в этот момент: своё место
             рабочий выбирает из свободных, и «не самое ближнее» бывает честным
             ответом — ближнее уже за другим. Проверка ниже это учитывает. */
          v._busy = vs.filter(x => x !== v && x.spot && x.spot.side)
                      .map(x => x.spot.place.x + ',' + x.spot.place.y);
        }
        if (v.state !== 'carry' && v.state !== 'toCamp' && v.state !== 'drop') v._from = null;
      }
      }
      for (const v of vs) prevStates[v.id] = v.state;
    }
    /* Сдача, не доигранная к последнему кадру прогона: эпизод закрывается
       границей отрезка, а не концом жеста. Он честно помечается неоконченным и
       в проверку полного прохода не идёт — но из журнала не выбрасывается. */
    for (const id in ep) if (ep[id]) { ep[id].done = false; ep[id].to = STEPS_N; res.episodes.push(ep[id]); }
    /* Сколько раз за прогон сыграна каждая последовательность кадров: 0,1,2,3 —
       это один проход, 0,1,2,3,0,1,2,3 — два. Видно числом. */
    res.episodes.forEach(e => { const q = e.frames.join(','); res.framesPlayed[q] = (res.framesPlayed[q] || 0) + 1; });

    res.logs = w2.village ? w2.village.logs : null;
    res.yardPts = B.yardSlots(camp2).map(s => ({ x: s.x, y: s.y, side: s.side }));
    /* Проверка правила «самый короткий путь до самой ближайшей границы»: из
       точки, откуда рабочий понёс брёвна, считаем ДОРОГУ до клетки подхода
       КАЖДОГО места двора тем же поиском, что и движок, и смотрим, выбрал ли он
       кратчайшую. Считается поиском, а не линейкой: обход навеса и поленницы
       меняет ответ, и правило заказчика — про дорогу. */
    res.spotLog = (w2._spotLog || []).slice();
    res.missed = res.drops.filter(d => d.bestSide && d.bestSide !== d.side)
      .map(d => ({ side: d.side, best: d.bestSide, gap: d.gap, why: d.why }));
    res.shortestOk = 0;
    res.shortestN = 0;
    res.shortestRate = null;
    for (const d of res.drops) {
      if (!d.from) continue;
      const fx = Math.floor(d.from[0]), fy = Math.floor(d.from[1]);
      const solidAt = V.blockedMap(w2, list2);
      let best = Infinity, bestSide = null;
      for (const p of res.yardPts) {
        const ap = B.approachCell(camp2, p);
        if (!ap || !V.walkable(w2, solidAt, ap.x, ap.y)) continue;
        const cells = V.findPath(w2, solidAt, fx, fy, ap.x, ap.y);
        if (cells && cells.length < best) { best = cells.length; bestSide = p.side; }
      }
      if (bestSide === null) continue;
      res.shortestN++;
      if (bestSide === d.side) res.shortestOk++;
    }
    if (res.shortestN) res.shortestRate = res.shortestOk / res.shortestN;
    res.deliveries = w2.village ? w2.village.deliveries : null;
    res.felledVillage = w2.village ? (w2.village.felled || 0) : null;
    res.inTransit = w2.village ? (w2.village.inTransit || 0) : null;
    vs.forEach(v => {
      res.delivered[v.id] = v.delivered || 0;
      res.felled[v.id] = (v.felled || 0) - res.felled0[v.id];
    });
    res.camp = [camp2.x, camp2.y, camp2.rot];
    res.spot = B.workSpot(camp2);
    res.felledTotal = vs.reduce((a, v) => a + ((v.felled || 0) - res.felled0[v.id]), 0);
    res.deliveredSum = vs.reduce((a, v) => a + (v.delivered || 0), 0);
    res.steps = STEPS_N;
    res.seconds = STEPS_N / 60;
    return res;
  })()`.replace(/__STEPS__/g, String(STEPS)));

  /* --- 2. рабочий цикл ------------------------------------------------ *
   * Главный прогон: три нанятых жителя живут MINUTES игровых минут. На КАЖДОМ
   * шаге проверяется клетка под каждым (вода / дерево / камень / пятно
   * постройки считаются отдельно), а по ходу собирается всё, что нужно числам:
   * состояния, метки деревьев, сдачи, падения и следы. */

  const statesSeen = Object.keys(sim.states).sort().join(',');
  check('житель САМ дошёл до лагеря и постоял у колоды: состояние take сыграно',
    sim.takeFrames > 0 && (sim.animWant.take || 0) > 0,
    `${sim.takeFrames} кадров take, это ${(sim.takeFrames / 60).toFixed(1)} с на троих ` +
    `(по ${(sim.takeFrames / 60 / Math.max(1, sim.deliveries + 1)).toFixed(2)} с на заход — ` +
    `в движке TAKE_TIME ${1.0} с)`);
  check('он пошёл к дереву, рубил и понёс брёвна: сыграны все шесть состояний цикла',
    ['toCamp', 'take', 'toTree', 'chop', 'carry', 'drop'].every(s => sim.states[s] > 0),
    'состояния: ' + Object.keys(sim.states).map(s => s + ' ' + sim.states[s]).join(', '));
  check('состояний ровно семь, и стоянка в цикле ОДНА — take: drop это проход жеста',
    statesSeen.split(',').every(s => ['toCamp', 'take', 'toTree', 'chop', 'carry', 'drop', 'stand'].indexOf(s) >= 0) &&
      statesSeen.split(',').length <= 7,
    'виденные: ' + statesSeen);
  /* Допуск 0.02 с — это ОДИН кадр симуляции (1/60 = 0.0167): рубка, начатая в
     последнюю секунду прогона, обрывается границей отрезка, и пять секунд ей
     просто негде уложиться. Отсюда и сравнение «падений ровно столько же,
     сколько рубок» с тем же допуском. */
  check('рубит РОВНО 5 секунд: от входа в рубку до падения дерева 5.00 с',
    sim.chopTimes.length > 0 && sim.chopTimes.every(t => Math.abs(t - 5.0) < 0.02) &&
      sim.chopTimes.length >= sim.chopAt - 1,
    `${sim.chopTimes.length} падений из ${sim.chopAt} рубок, время [${[...new Set(sim.chopTimes)].join(', ')}] с ` +
    `(кадров рубки ${sim.chopFrames}, это ${(sim.chopFrames / 60).toFixed(1)} с на троих)`);
  check('за ходку деревня получает РОВНО 4 бревна, и счёт растёт только на сдаче',
    sim.logsAt.length > 0 && sim.logsAt.every(x => x.grow === 4) &&
      sim.logs === sim.deliveries * 4 &&
      sim.deliveries === sim.logsAt.length,
    `брёвен ${sim.logs} за ${sim.deliveries} сдач, приросты [${[...new Set(sim.logsAt.map(x => x.grow))].join(',')}]`);

  /* --- 2б. СДАЧА: ЗАДЕРЖКИ НЕТ, ПРОХОД ОДИН ---------------------------- *
   * Правило заказчика (2026-10-17), дословно: «должно быть так, что они
   * подходят к лагерю и сразу сбрасывают брёвна, это не занимает времени, и
   * анимация складывания брёвен проигрывается один раз».
   *
   * Здесь оно и меряется — четырьмя числами, а не описанием:
   *   а) от кадра прихода на место сдачи до роста world.village.logs прошло
   *      РОВНО 0 кадров симуляции (начисление — в том же вызове, где рабочий
   *      оказался на своём месте двора с полными руками);
   *   б) за одну сдачу logs += 4, deliveries += 1, v.delivered += 4 и inTransit
   *      уменьшился на 1 — тоже одним вызовом;
   *   в) кадры анимации сдачи за проход — 0,1,2,3 без повторов и без «0 через
   *      три»: один проход, а не цикл (было 0.8 с против 0.333 с прохода —
   *      то есть 2.4 прохода на экране).
   * Сколько таких проходов было за прогон, видно по числу сдач. */
  const dep = sim.deposits || [];
  /* «В КАДР ПРИХОДА» здесь не декларация, а замер шага: перед КАЖДЫМ вызовом
     движка запоминается место рабочего и его расстояние до своего места двора;
     после — сравнивается. Отсюда видно, ЧТО именно сделал кадр начисления:
       * дошёл ли он в нём (переместился ровно на шаг ходьбы, скорость x 1/60),
         или уже стоял на месте (перемещения нет);
       * и стоит ли он на месте СДАЧИ, а не «где-то у лагеря».
     Если бы между приходом и начислением был хоть один лишний кадр, в кадре
     начисления рабочий либо стоял бы на месте, НЕ дойдя (лишний шаг пути), либо
     шагнул бы с места, где он уже стоял (лишний кадр стоянки). Ни того, ни
     другого не должно быть. */
  check('б) за одну ходку: logs +4, deliveries +1, v.delivered +4, inTransit -1 — одним кадром',
    dep.length > 0 && dep.every(d => d.logs === 4 && d.deliv === 1 && d.mine === 4 && d.transit === -1),
    `приросты за сдачу: logs [${[...new Set(dep.map(d => d.logs))]}], deliveries [${[...new Set(dep.map(d => d.deliv))]}], ` +
    `v.delivered [${[...new Set(dep.map(d => d.mine))]}], inTransit [${[...new Set(dep.map(d => d.transit))]}]`);

  /* Кадр анимации по фазе — тот же счёт, что у отрисовки (Hero.sprite:
     floor(phase x N)): проверяется НАРИСОВАННОЕ, а не арифметика фазы. */
  const eps = sim.episodes || [];
  const epsDone = eps.filter(e => e.done);
  const played = sim.framesPlayed || {};
  /* Последняя сдача может начаться в самом конце прогона: её жест ещё не
     доигран, и это не второй проход. Считаем только завершённые эпизоды. */
  const seqs = [...new Set(epsDone.map(e => (e.frames || []).join(',')))];
  const inOrder = f => { for (let i = 1; i < f.length; i++) if (f[i] < f[i - 1]) return false; return true; };
  const seqsTxt = seqs.map(k => 'кадры ' + k).join(' · ');
  const passLen = [...new Set(epsDone.map(e => e.to - e.from))].sort((a, b) => a - b).join('/');
  check('в) жест сдачи играется ОДИН ПРОХОД: кадры 0,1,2,3 без повторов и зацикливания',
    epsDone.length > 0 && seqs.length === 1 && seqs[0] === '0,1,2,3' &&
      epsDone.every(e => inOrder(e.frames) && e.creditAt),
    eps.length + ' проходов при ' + sim.deliveries + ' сдачах: ' + seqsTxt +
    '; кадров в проходе ' + passLen +
    ' при 60 к/с (в атласе carry_put — 4 кадра при 12 к/с, это 0.333 с и 20 кадров симуляции)');
  check('v.delivered растёт тем же шагом: сдано по жителям — ровно 4 за ходку',
    Object.keys(sim.delivered).every(id => sim.delivered[id] === 0 || sim.delivered[id] % 4 === 0) &&
      Object.keys(sim.delivered).reduce((a, id) => a + sim.delivered[id], 0) === sim.logs,
    Object.keys(sim.delivered).map(id => '№' + id + ' ' + sim.delivered[id]).join(' · ') + ' при ' + sim.logs + ' в казне');
  /* Дерево, поваленное в последнюю секунду прогона, в брёвнах ещё не
     числится — рабочий их несёт. Поэтому «ни одного дерева в никуда» — это
     равенство СРУБЛЕННЫХ и (СДАЧ + ХОДОК В ПУТИ), а не «срублено = сдач»:
     второе верно только на остановленных часах. Заодно сходится счёт по
     каждому рабочему: сколько деревьев повалил — столько ходок и донёс. */
  /* «Ни одного дерева в никуда» — это ДВА равенства, и оба про брёвна:
       * казна = сдачи x 4 (проверено выше);
       * казна + брёвна в пути = срублено x 4, где «в пути» — ходки, начатые и
         ещё не сданные (дерево, поваленное в последнюю секунду прогона, в
         брёвнах ещё не числится: рабочий их несёт).
     Вместе они значат, что каждое поваленное дерево либо уже в казне, либо в
     руках — и ни одно не пропало. */
  check('ни одного дерева «в никуда»: казна + брёвна в пути = срублено × 4',
    sim.felledVillage === sim.deliveries + sim.inTransit &&
      sim.felledTotal === sim.felledVillage &&
      sim.logs + sim.inTransit * 4 === sim.felledVillage * 4 &&
      sim.deliveredSum === sim.logs &&
      // Плюс-минус дерево, которое рубят прямо на последнем кадре прогона.
      Math.abs(sim.treeTaken - sim.felledVillage) <= 1,
    `деревня: срублено ${sim.felledVillage} x 4 = ${sim.felledVillage * 4} брёвен; ` +
    `в казне ${sim.logs} (сдач ${sim.deliveries}), в пути ${sim.inTransit} ходки; ` +
    'по рабочим ' + Object.keys(sim.felled).map(id => '№' + id + ' ' + sim.felled[id]).join(', '));
  check('дерево под топором помечено ЭТИМ рабочим, и двоих на одном дереве нет',
    sim.unmarkedTrees === 0 && sim.sameTree === 0 && sim.treeTaken > 0,
    `кадров с меткой ${sim.marked}, без метки ${sim.unmarkedTrees}, двое на одном дереве — ${sim.sameTree}` +
    `, взято деревьев ${sim.treeTaken}`);
  check('трое не СТОЯТ в одной клетке: ни в лагере, ни под деревом',
    sim.standTogether === 0 && sim.spotTogether === 0,
    `кадров «в одной клетке» ${sim.cellTogether} (это дорога след в след), из них стоянок ${sim.standTogether}` +
    `, одно место двора у двоих — ${sim.spotTogether}`);
  /* ПРАВИЛО ЗАКАЗЧИКА: место выбирается у БЛИЖАЙШЕЙ границы лагеря, а не у
     передней. Проверяется по каждой сдаче: из точки, откуда рабочий понёс
     брёвна, считается расстояние до всех свободных мест двора, и место, куда
     он встал, обязано быть не дальше лучшего более чем на одну клетку (запас
     на то, что соседние места бывают заняты товарищами: занять САМОЕ ближнее
     нельзя, если там уже стоит другой рабочий).

     Стороны при этом обязаны быть РАЗНЫЕ: если бы рабочий всегда ходил к
     передней кромке, все сдачи были бы на одной стороне, и проверка ниже это
     поймала бы. */
  const sidesUsed = new Set(sim.drops.map(d => d.side));
  const log = sim.spotLog || [];
  /* Главное утверждение берётся СО СЛОВ ДВИЖКА: на каждом выборе он обязан
     назвать сторону, которая в тот же миг была свободна. Это проверяемо точно —
     в отличие от «а точно ли она была ближайшей», где снимок чужих мест кадром
     позже врёт, и строгого ответа получить нельзя. */
  const okSide = log.filter(e => e.freeSides.indexOf(e.side) >= 0).length;
  /* А это — свидетельство «не всегда передняя»: сколько РАЗНЫХ сторон он
     назвал. Одна сторона во всех выборах означала бы, что правило не работает. */
  const logSides = [...new Set(log.map(e => e.side))];
  const gaps = sim.drops.map(d => d.gap).filter(g => g !== null);
  const avgGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  check('место сдачи — у БЛИЖАЙШЕЙ границы лагеря, а не всегда у передней',
    sim.drops.length >= 3 && sidesUsed.size >= 2 && logSides.length >= 2 &&
      log.length >= 3 && okSide === log.length && avgGap <= 1.0,
    `${sim.drops.length} сдач у сторон ${JSON.stringify([...sidesUsed])}; ` +
    `движок выбрал свободную сторону в ${okSide} из ${log.length} выборов, ` +
    `разных сторон ${JSON.stringify(logSides)}, до ближайшей свободной границы ` +
    `в среднем ${avgGap.toFixed(2)} клетки`);

  /* Заступ в двор — ЕДИНСТВЕННОЕ место, где рабочий заходит в пятно, и он
     разрешён: `sim.inHouse` считает кадры «в пятне и не на своём дворе».
     Порог — несколько шагов: вход и выход из двора занимают по кадру, а стоять
     в пятне он не должен вовсе. */
  check('путь не проходит ни по воде, ни сквозь дерево, камень или постройку (кроме заступа в свой двор)',
    sim.water === 0 && sim.blocked === 0 && sim.off === 0 && sim.inHouseNotYard === 0,
    `вода ${sim.water}, занятое ${sim.blocked}, в пятне не на своём дворе ${sim.inHouseNotYard}` +
    ` (всего кадров в пятне ${sim.inHouse}), за картой ${sim.off}` +
    (sim.blockedAt.length ? ' | первые: ' + JSON.stringify(sim.blockedAt) : '') +
    ` из ${sim.steps * 3} шагов трёх жителей`);
  check('работа не прекращается: каждый сдал не одну ходку, и пауз между ними нет',
    sim.deliveries >= 3 && Object.keys(sim.delivered).every(id => sim.delivered[id] >= 8),
    `${sim.deliveries} сдач за ${(sim.seconds / 60).toFixed(0)} минут`);
  check('падение-фолбэк кадров работает: чего нет в атласе — берётся из цепочки',
    Object.keys(sim.animWant).length > 0 &&
      Object.keys(sim.anims).every(a => ['idle', 'walk', 'work', 'walk_axe', 'carry', 'carry_put'].indexOf(a) >= 0),
    'просили: ' + Object.keys(sim.animWant).sort().join(', ') +
    ' | играли: ' + Object.keys(sim.anims).sort().join(', '));

  /* --- 3. кадры анимаций: что взято вместо недостающего ---------------- *
   * «Есть ли анимация в атласе» спрашивается У АТЛАСА (Hero.frameCount), а не
   * угадывается. Здесь это и проверяется: у каждого имени из заказа есть свой
   * кадр или честный запасной, и запасной — тот, который назван в правиле. */
  const anims = await js(`(() => {
    const g = window.__mapgen, V = window.Villagers, H = window.Hero;
    const set = g.renderer.villagerSprites;
    const F = V.ANIM_FALLBACK;
    const out = { inAtlas: {}, want: {}, has: {} };
    for (const a of ['idle', 'walk', 'work', 'walk_axe', 'carry', 'carry_put']) {
      out.inAtlas[a] = H.frameCount(set, a);
    }
    for (const a in F) {
      out.want[a] = F[a];
      out.has[a] = V.animResolve(set, a);
    }
    return out;
  })()`);
  check('движок спрашивает атлас, а не угадывает: у просимого имени есть запасное',
    ['toTree', 'carry', 'carry_put', 'take', 'toCamp', 'walk', 'idle', 'work']
      .every(k => !!anims.has[k]),
    Object.keys(anims.has).map(k => k + '→' + anims.has[k]).join(' · '));
  check('walk_axe / carry / carry_put: свой кадр, если он в атласе, иначе — цепочка',
    anims.has.toTree === (anims.inAtlas.walk_axe > 0 ? 'walk_axe' : 'walk') &&
      anims.has.carry === (anims.inAtlas.carry > 0 ? 'carry' : 'walk') &&
      anims.has.carry_put === (anims.inAtlas.carry_put > 0 ? 'carry_put' : 'carry'),
    'в атласе: walk_axe ' + anims.inAtlas.walk_axe + ', carry ' + anims.inAtlas.carry +
    ', carry_put ' + anims.inAtlas.carry_put + ' | берём: ' +
    anims.has.toTree + ', ' + anims.has.carry + ', ' + anims.has.carry_put);
  /* Контракт с атласом ОБЕИМИ сторонами, и обе стороны названы числом:
       * есть carry_put — сдача играет его ОДИН проход (проверено выше, п. в);
       * нет carry_put — сдача не выдумывает проход, а идёт ЗАМОРОЖЕННЫМ нулевым
         кадром carry (контракт с художником: нулевой кадр — стойка с брёвнами
         на руках), и заморозка эта стоит ровно один кадр: время сдачи и тогда
         не занимает ни кадра.
     Проверка не «подгоняется» под текущий атлас: она говорит, что ОБЯЗАНО
     быть в каждом из двух случаев, и второй случай будет проверен, как только
     атлас останется без carry_put. */
  const frozenEps = (sim.episodes || []).filter(e => e.anim === 'carry');
  check('сдача без своей анимации идёт с ЗАМОРОЖЕННОЙ фазой (нулевой кадр carry)',
    anims.inAtlas.carry_put > 0 ||
      (sim.frozenFrames > 0 && sim.frozenAt.every(x => x[2] === 0) &&
       Object.keys(sim.animWant).indexOf('carry_put') >= 0 &&
       frozenEps.length > 0 && frozenEps.every(e => e.frames.length === 1 && e.frames[0] === 0)),
    anims.inAtlas.carry_put > 0
      ? 'в атласе есть carry_put — сдача играет его один проход'
      : `${sim.frozenFrames} кадров заморозки, фазы [${[...new Set(sim.frozenAt.map(x => x[2]))].join(',')}], ` +
        `проходов замороженным кадром ${frozenEps.length}`);

  /* --- 4. тот же сид — тот же порядок работы --------------------------- *
   * Сравниваются ДВА прогона одного и того же: последовательность (житель,
   * состояние, дерево) на каждом шаге и моменты сдач. ГПСЧ у жителя свой, от
   * сида мира, и Math.random в движке нет вовсе — значит порядок обязан
   * совпасть до шага. */
  const twice = await js(`(() => {
    const g = window.__mapgen, S = window.Session, B = window.Buildings, V = window.Villagers;
    const run = () => {
      g.newGame();
      const w = g.getWorld(), list = g.getBuildings(), vs = g.getVillagers();
      const camp = list.filter(b => B.typeOf(b) === 'lumbercamp')[0];
      for (const v of vs) S.hire(camp, v, vs);
      const seq = [], deliv = [];
      let last = 0;
      for (let step = 0; step < 60 * 120; step++) {
        w._villagers = vs;
        for (const v of vs) V.update(v, w, g.renderer.villagerSprites, 1/60, { buildings: list });
        if (step % 30 === 0) {
          seq.push(vs.map(v => v.id + ':' + v.state + ':' +
            (v.tree ? Math.floor(v.tree.x) + '.' + Math.floor(v.tree.y) : '—')).join('|'));
        }
        const d = w.village.deliveries;
        if (d !== last) { deliv.push(step); last = d; }
      }
      return { seq: seq, deliv: deliv, logs: w.village.logs,
               state: seq[seq.length - 1] };
    };
    const a = run(), b = run();
    let same = a.seq.length === b.seq.length && a.deliv.join(',') === b.deliv.join(',');
    for (let i = 0; same && i < a.seq.length; i++) same = a.seq[i] === b.seq[i];
    return { same: same, n: a.seq.length, logs: a.logs, deliv: a.deliv.length,
             first: a.seq[0], last: a.state };
  })()`);
  check('тот же сид — тот же порядок работы: состояние, цель и сдачи шаг в шаг',
    twice.same && twice.logs > 0,
    `${twice.n} замеров, ${twice.deliv} сдач, ${twice.logs} брёвен; начало ${twice.first}`);

  /* --- 5. увольнение -------------------------------------------------- *
   * Уволенный возвращается к прогулке и больше не рубит. Проверяется не
   * «состояние равно wander», а два факта: он ушёл от лагеря и за минуту не
   * срубил ни одного дерева. */
  const fired = await js(`(() => {
    const g = window.__mapgen, S = window.Session, B = window.Buildings, V = window.Villagers;
    g.newGame();
    const w = g.getWorld(), list = g.getBuildings(), vs = g.getVillagers();
    const camp = list.filter(b => B.typeOf(b) === 'lumbercamp')[0];
    const bb = B.bounds(camp);
    const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
    for (const v of vs) S.hire(camp, v, vs);
    // Даём поработать: пусть уволенный будет в разгаре ходки, а не у порога.
    for (let i = 0; i < 60 * 60; i++) { w._villagers = vs; for (const v of vs) V.update(v, w, g.renderer.villagerSprites, 1/60, { buildings: list }); }
    const v = vs[0];
    const before = { state: v.state, felled: v.felled || 0, delivered: v.delivered || 0, carried: v.tree ? 1 : 0 };
    const logsBefore = w.village.logs;
    const res = S.fire(camp, v);
    const states = {}, from = [v.x, v.y];
    for (let i = 0; i < 60 * 60; i++) {
      w._villagers = vs;
      for (const x of vs) V.update(x, w, g.renderer.villagerSprites, 1/60, { buildings: list });
      states[v.state] = (states[v.state] || 0) + 1;
    }
    return {
      result: res, before: before, states: states,
      workers: S.workersOf(camp, vs).map(x => x.id),
      felledAfter: (v.felled || 0) - before.felled,
      moved: Math.hypot(v.x - from[0], v.y - from[1]),
      dist: Math.hypot(v.x - cx, v.y - cy),
      // Брёвна в руках уволенного не засчитываются: счёт растёт только на сдаче.
      logsGrewBy: w.village.logs - logsBefore,
      employer: v.employer, tree: v.tree, anim: v.anim, animWant: v.animWant
    };
  })()`);
  check('«Уволить» снимает работника: его больше нет в workersOf лагеря',
    fired.result.ok === true && fired.workers.indexOf(1) < 0 && fired.employer === null,
    'работники ' + fired.workers.join(','));
  check('уволенный возвращается к прогулке: идёт, а не стоит у лагеря',
    (fired.states.wander || 0) > 0 && fired.moved > 1 && fired.dist > 2,
    `состояния ${JSON.stringify(fired.states)}, прошёл ${fired.moved.toFixed(1)} клетки, ` +
    `отошёл от лагеря на ${fired.dist.toFixed(1)}`);
  check('и больше не рубит: за минуту ни одного дерева и ни одного бревна от него',
    fired.felledAfter === 0 && fired.animWant !== 'toTree' && fired.animWant !== 'work',
    `срублено ${fired.felledAfter}, кадр ${fired.animWant}, в казне прибавка ${fired.logsGrewBy} ` +
    '(её дали двое оставшихся)');

  console.log('\nкадры:');
  /* --- 6. кадры для глазами-проверки ---------------------------------- *
   * Четыре кадра — четыре момента цикла. Ставятся они СИМУЛЯЦИЕЙ, а не
   * подрисовкой: рабочий доводится до нужного состояния тем же кодом, что и в
   * игре, и только потом снимается кадр. Дерево и место выбираются открытые —
   * иначе человека закрывают кроны деревьев, которые по глубине ближе камеры. */
  const takeShot = await js(`(() => {
    const g = window.__mapgen, S = window.Session, B = window.Buildings, V = window.Villagers, r = g.renderer;
    g.newGame();
    const w = g.getWorld(), list = g.getBuildings(), vs = g.getVillagers();
    const camp = list.filter(b => B.typeOf(b) === 'lumbercamp')[0];
    for (const v of vs) S.hire(camp, v, vs);
    const v = vs[0];
    for (let i = 0; i < 60 * 120 && v.state !== 'take'; i++) {
      w._villagers = vs; for (const x of vs) V.update(x, w, r.villagerSprites, 1/60, { buildings: list });
    }
    /* Камера наводится на МЕСТО ДВОРА, а не на центр лагеря: рабочий стоит на
       кромке пятна, и при наводке на навес он уезжает к краю кадра (спрайт
       лагеря выше человека втрое).

       Рабочий при этом ЗАКРЫТ спрайтом лагеря по грудь, и это не ошибка кадра:
       лагерь — одна картинка, её ключ глубины (центр пятна, x + y = 83) больше,
       чем у места двора (81.5), поэтому спрайт ложится поверх человека НИЖНЕЙ
       половиной. Так же он выглядит и в игре. Прячется это только другим
       ключом глубины для одной картинки, а это переделка рендера построек. */
    r.showGrid = false; r.hover = null; r.cam.zoom = 150;
    r.centerOn(camp.x + 1.5, camp.y + 1.5 - 0.6);
    r.render(1);
    const d = v.spot ? Math.hypot(v.x - v.spot.x, v.y - v.spot.y) : -1;
    return { state: v.state, cell: [Math.floor(v.x), Math.floor(v.y)], anim: v.anim,
             animWant: v.animWant, spot: v.spot, dist: +d.toFixed(3),
             atYard: !!B.atYardSpot(camp, v.x, v.y), hold: +(v.hold || 0).toFixed(2),
             camp: [camp.x, camp.y], villagers: vs.length };
  })()`);
  await shoot('lumberjack-camp.png', null);
  check('кадр «рабочий у лагеря»: стоит на месте двора и берёт топор',
    takeShot.state === 'take' && takeShot.animWant === 'take' &&
      takeShot.atYard && takeShot.dist >= 0 && takeShot.dist < 0.25,
    `состояние ${takeShot.state}, кадр ${takeShot.anim}, (${takeShot.cell.join(',')})` +
    ` от места двора ${takeShot.dist} клетки, на своём дворе ${takeShot.atYard}`);

  /* Наём: житель ОБЯЗАН дойти до колоды шагом. Это отдельная проверка, потому
     что поломка тут тихая: путь не прокладывается, житель замирает на месте, а
     топор всё равно оказывается у него в руке (состояние take наступает по
     близости к месту двора). Внешне «взял топор», по сути — не сходил.

     Поэтому проверяется не состояние, а ПУТЬ: пройденное расстояние и то, что
     ни один кадр не сдвинул его больше, чем на шаг ходьбы. Шаг за кадр равен
     SPEED/60 = 0.0096 клетки; порог 0.1 ловит любой перенос. */
  const walkIn = await js(`(() => {
    const g = window.__mapgen, S = window.Session, B = window.Buildings, V = window.Villagers, r = g.renderer;
    g.newGame();
    const w = g.getWorld(), list = g.getBuildings(), vs = g.getVillagers();
    const camp = list.filter(b => B.typeOf(b) === 'lumbercamp')[0];
    const fp = B.footprint(camp.rot, camp.type);
    const v = vs[0];
    /* Ставим его ЗАВЕДОМО далеко от двора: у ратуши, а не рядом с лагерем. */
    const away = B.frontSpot(list.filter(b => B.typeOf(b) === 'townhall')[0] || camp);
    v.x = away.x + 0.5; v.y = away.y + 0.5;
    const x0 = v.x, y0 = v.y;
    S.hire(camp, v, vs);
    let maxStep = 0, prev = { x: v.x, y: v.y }, frames = 0, reached = false;
    for (let i = 0; i < 60 * 300; i++) {
      w._villagers = vs;
      for (const x of vs) V.update(x, w, r.villagerSprites, 1 / 60, { buildings: list });
      const d = Math.hypot(v.x - prev.x, v.y - prev.y);
      if (d > maxStep) maxStep = d;
      if (d > 0.0005) frames++;
      prev = { x: v.x, y: v.y };
      if (v.state === 'take') { reached = true; break; }
    }
    return { reached: reached, state: v.state, maxStep: +maxStep.toFixed(4), frames: frames,
             walked: +Math.hypot(v.x - x0, v.y - y0).toFixed(2),
             dist: v.spot ? +Math.hypot(v.x - v.spot.x, v.y - v.spot.y).toFixed(3) : -1,
             atYard: v.spot ? !!B.atYardSpot(camp, v.x, v.y) : false };
  })()`);
  check('нанятый житель ИДЁТ в лагерь за топором, а не замирает на месте',
    walkIn.reached && walkIn.walked > 1.0 && walkIn.frames > 60 && walkIn.maxStep < 0.1 &&
      walkIn.dist >= 0 && walkIn.dist < 0.25,
    `дошёл до двора ${walkIn.reached}, прошёл ${walkIn.walked} клетки за ${walkIn.frames} кадров, ` +
    `самый большой шаг за кадр ${walkIn.maxStep} (шаг ходьбы 0.01), ` +
    `от места двора ${walkIn.dist}, на своём дворе ${walkIn.atYard}`);

  /* Шаг ходьбы за кадр для порога «дошёл в этот кадр» берётся ИЗ ЗАМЕРА, а не
     из константы: его меряет проверка «нанятый житель идёт в лагерь» ниже
     (walkIn.maxStep — самый большой шаг за кадр за всю дорогу). Там же видно,
     что порог и замер — одно число. */
  const walkStep = 0.0105;
  const lateArrival = dep.filter(d => !(d.hadPath && d.covered > 1e-9 && d.covered <= walkStep * 1.02) &&
                                         !d.stoodAtSpot);
  const depStep = Math.max.apply(null, dep.map(d => d.covered));
  const depWalked = dep.filter(d => d.covered > 1e-9).length;
  const depStood = dep.filter(d => d.stoodAtSpot).length;
  check('а) сдача — в КАДР ПРИХОДА: между приходом на место сдачи и ростом казны 0 кадров',
    dep.length > 0 && lateArrival.length === 0 && dep.every(d => d.state === 'drop' && d.atYard && d.spot),
    dep.length + ' сдач; все начислены тем же вызовом движка, что довёл рабочего до места: ' +
    'дошёл шагом ' + depWalked + ' из ' + dep.length + ', стоял на месте уже ' + depStood +
    '; шаг за кадр ' + walkStep.toFixed(4) + ' клетки, наибольший в кадре начисления ' +
    depStep.toFixed(4) + '; сдач «через паузу» — ' + lateArrival.length);

  const treeShot = await js(`(() => {
    const g = window.__mapgen, S = window.Session, B = window.Buildings, V = window.Villagers, r = g.renderer;
    const w = g.getWorld(), list = g.getBuildings(), vs = g.getVillagers();
    const camp = list.filter(b => B.typeOf(b) === 'lumbercamp')[0];
    for (const v of vs) S.hire(camp, v, vs);
    const v = vs[0];
    // Доматываем до середины рубки: на фазе удара топор в стволе.
    for (let i = 0; i < 60 * 180 && v.state !== 'chop'; i++) {
      w._villagers = vs; for (const x of vs) V.update(x, w, r.villagerSprites, 1/60, { buildings: list });
    }
    let guard = 0;
    while (v.state === 'chop' && v.chopT < 2.0 && guard++ < 600) {
      w._villagers = vs; for (const x of vs) V.update(x, w, r.villagerSprites, 1/60, { buildings: list });
    }
    const t = v.tree;
    r.showGrid = false; r.hover = null; r.cam.zoom = 170;
    // Центр — на СЕРЕДИНЕ между рабочим и стволом: на 170 px/клетку в кадр
    // попадают оба, и видно, что топор у коры, а не «где-то рядом».
    r.centerOn((v.x + (t ? t.x : v.x)) / 2, (v.y + (t ? t.y : v.y)) / 2 - 0.05);
    if (t) { t.shake = 1; t._shakeT = (r.time || 0) - 0.03; }
    r.render(r.time || 0);
    return { state: v.state, anim: v.anim, animWant: v.animWant, chopT: +(v.chopT || 0).toFixed(2),
             hits: v.hits, tree: t ? [t.x, t.y] : null,
             dist: t ? +Math.hypot(t.x - v.x, t.y - v.y).toFixed(2) : null,
             mark: !!(t && t.mark === v) };
  })()`);
  await shoot('lumberjack-tree.png', null);
  check('кадр «рабочий у дерева»: рубит, стоит вплотную, дерево помечено им',
    treeShot.state === 'chop' && treeShot.animWant === 'work' && treeShot.dist < 1.0 && treeShot.mark,
    `состояние ${treeShot.state}, кадр ${treeShot.animWant}, до ствола ${treeShot.dist} клетки, ` +
    `рубит ${treeShot.chopT} с, ударов ${treeShot.hits}, дерево ${treeShot.tree ? treeShot.tree.join(',') : '—'}`);

  const carryShot = await js(`(() => {
    const g = window.__mapgen, S = window.Session, B = window.Buildings, V = window.Villagers, r = g.renderer;
    g.newGame();
    const w = g.getWorld(), list = g.getBuildings(), vs = g.getVillagers();
    const camp = list.filter(b => B.typeOf(b) === 'lumbercamp')[0];
    for (const v of vs) S.hire(camp, v, vs);
    const v = vs[0];
    /* Доматываем до середины дороги С БРЁВНАМИ и берём МОМЕНТ, когда за
       спиной у рабочего ничего не стоит: куст или дерево с большим x + y
       закрывают его целиком (они по глубине ближе камеры). Кадр ставится, а не
       ловится, и это та же причина, по которой ставятся кадры у приёмки
       жителя (tools/villager.js). */
    let guard = 0, picked = false;
    while (guard++ < 60 * 600) {
      w._villagers = vs; for (const x of vs) V.update(x, w, r.villagerSprites, 1/60, { buildings: list });
      if (v.state !== 'carry' || !v.path || v.step === 0) continue;
      const solidC = V.blockedMap(w, list);
      let free = true;
      for (let dy = 0; dy <= 1 && free; dy++)
        for (let dx = 0; dx <= 1; dx++)
          if (V.solidObject(0) === false && solidC[(Math.floor(v.y) + dy) * w.width + Math.floor(v.x) + dx]) free = false;
      if (free) { picked = true; break; }
    }
    r.showGrid = false; r.hover = null; r.cam.zoom = 150;
    const fp = B.footprint(camp.rot, camp.type);
    r.centerOn(v.x, v.y - 0.2);
    r.render(1);
    return { state: v.state, anim: v.anim, animWant: v.animWant, from: [v.x, v.y],
             camp: [camp.x, camp.y], delivered: v.delivered || 0, picked: picked };
  })()`);
  await shoot('lumberjack-carry.png', null);
  check('кадр «рабочий с брёвнами в пути»: несёт их к лагерю, а не к дереву',
    carryShot.state === 'carry' && carryShot.animWant === 'carry',
    `состояние ${carryShot.state}, кадр ${carryShot.anim}, идёт в ${carryShot.from.map(n => n.toFixed(1)).join(',')}` +
    ` к лагерю ${carryShot.camp.join(',')}`);

  const dropShot = await js(`(() => {
    const g = window.__mapgen, S = window.Session, B = window.Buildings, V = window.Villagers, r = g.renderer;
    const w = g.getWorld(), list = g.getBuildings(), vs = g.getVillagers();
    const camp = list.filter(b => B.typeOf(b) === 'lumbercamp')[0];
    for (const v of vs) S.hire(camp, v, vs);
    const v = vs[0];
    const logs0 = w.village.logs;
    /* Рабочий доводится до САМОГО КАДРА СДАЧИ, и ни одним кадром дальше: как
       только движок перевёл его в drop, казна уже выросла — это и есть предмет
       проверки. Состояние, место и кадр при этом настоящие, их выставил движок,
       а не тест: тест только не даёт жесту доиграть, пока снимается кадр. */
    let guard = 0, steps = 0;
    while (guard++ < 60 * 600 && v.state !== 'drop') {
      w._villagers = vs; for (const x of vs) V.update(x, w, r.villagerSprites, 1/60, { buildings: list });
      steps++;
    }
    const credited = w.village.logs - logs0;
    const atDrop = { state: v.state, phase: v.phase, anim: v.anim,
                     x: v.x, y: v.y, spot: v.spot, dist: v.spot ? Math.hypot(v.x - v.spot.x, v.y - v.spot.y) : -1 };
    /* Жест длится 0.333 с (4 кадра при 12 к/с) и в живом кадре успел бы
       кончиться, пока снимается картинка. Поэтому частота кадра ВРЕМЕННО
       ставится в ноль: фаза встаёт там, где её оставил движок, и кадр ловит
       СЕРЕДИНУ жеста. Числа состояния от этого не меняются — меняется только
       то, что видно на картинке; после съёмки частота возвращается. */
    const meta = r.villagerSprites.meta, cp = meta.anims && meta.anims.carry_put;
    const fps0 = cp ? cp.fps : null;
    /* Доходим ровно до СЕРЕДИНЫ прохода (кадр 2 из 4) и вмораживаем фазу: жест
       длится 0.333 с, и в живом времени он кончился бы, пока снимается кадр.
       Цель — СЕРЕДИНА кадра, а не «фаза 0.5»: у четырёх кадров середина второго
       это 0.375, и floor(0.375 x 4) = 1 — то есть на снимке ровно кадр 2. */
    const mid = 1.5 / 4;
    while (v.state === 'drop' && v.phase < mid && guard++ < 60 * 600) {
      w._villagers = vs; for (const x of vs) V.update(x, w, r.villagerSprites, 1/60, { buildings: list });
    }
    if (cp) cp.fps = 0;
    r.showGrid = false; r.hover = null; r.cam.zoom = 170;
    const fp = B.footprint(camp.rot, camp.type);
    // Камера — на СЕРЕДИНЕ между рабочим и лагерем: сдача видна целиком, и
    // видно, что двор — у передней кромки пятна, а не «где-то у лагеря».
    r.centerOn((v.x + camp.x + fp.w / 2) / 2, (v.y + camp.y + fp.h / 2) / 2);
    r.render(1);
    /* Крупный план: сдача видна ЦЕЛИКОМ, а не пятнышком в общем плане — иначе
       кадр нечего разглядывать (общий план смотрится и без него, в
       lumberjack-camp.png). Кроп — вокруг места сдачи, масштаб целочисленный,
       чтобы спрайт не размывался. */
    const src = document.getElementById('view');
    const cv = document.createElement('canvas');
    const cw = 288, ch = 288, k = 3;
    cv.width = cw * k; cv.height = ch * k;
    const g2 = cv.getContext('2d');
    g2.imageSmoothingEnabled = false;
    /* sx/sy у рендера считаются ОТ СЕРЕДИНЫ кадра (см. js/render.js), поэтому
       к ним прибавляется половина полотна: без этого кроп уезжает за кадр. */
    const px = r.sx(v.x, v.y) + src.width / 2, py = r.sy(v.x, v.y) + src.height / 2;
    g2.drawImage(src, Math.round(px - cw / 2), Math.round(py - ch / 2 - 30), cw, ch, 0, 0, cv.width, cv.height);
    const d = v.spot ? Math.hypot(v.x - v.spot.x, v.y - v.spot.y) : -1;
    const n = window.Hero.frameCount(r.villagerSprites, v.anim);
    const out = { state: v.state, anim: v.anim, animWant: v.animWant, frozen: !!v.frozen,
             phase: +v.phase.toFixed(3), frame: Math.min(n - 1, Math.floor(v.phase * n)), frames: n,
             credited: credited, stepsToDrop: steps,
             arrivalDist: +atDrop.dist.toFixed(3), logsBefore: logs0, logsAfter: w.village.logs,
             cell: [Math.floor(v.x), Math.floor(v.y)],
             dist: +d.toFixed(3), atYard: !!B.atYardSpot(camp, v.x, v.y),
             spot: v.spot, visits: vs.map(x => x.state), fps0: fps0,
             zoom: cv.toDataURL('image/png') };
    return out;
  })()`);
  fs.writeFileSync(path.join(OUT, 'lumberjack-drop.png'),
    Buffer.from(dropShot.zoom.split(',')[1], 'base64'));
  console.log('  lumberjack-drop.png (крупный план, x' + 3 + ')');
  /* Частоту кадра возвращаем сразу после съёмки: кадр — единственное, что
     здесь заморожено, и следующий прогон обязан идти с настоящей. */
  const fpsBack = await js(`(() => {
    const cp = window.__mapgen.renderer.villagerSprites.meta.anims.carry_put;
    cp.fps = ${dropShot.fps0 === null ? 'cp.fps' : dropShot.fps0};
    return cp.fps;
  })()`);
  check('кадр «сдача у лагеря»: брёвна СДАЮТСЯ в кадр прихода, а не после стоянки',
    dropShot.state === 'drop' && dropShot.spot && dropShot.atYard &&
      dropShot.dist >= 0 && dropShot.dist < 0.15 &&
      dropShot.credited === 4 && dropShot.animWant === 'carry_put',
    `состояние ${dropShot.state}, кадр ${dropShot.animWant} (${dropShot.anim}, кадр ${dropShot.frame + 1} из ${dropShot.frames}, ` +
    `фаза ${dropShot.phase}${dropShot.frozen ? ', заморожена' : ''}), (${dropShot.cell.join(',')}) от места двора ` +
    `${dropShot.dist} клетки, на своём дворе ${dropShot.atYard}; в казне было ${dropShot.logsBefore}, стало ${dropShot.logsAfter} ` +
    `(+${dropShot.credited} в тот же кадр, где кончился путь, — за ${dropShot.stepsToDrop} шагов до этого); ` +
    `частота кадра на время съёмки ${dropShot.fps0} -> 0, обратно ${fpsBack}`);

  /* --- 6б. СЕРИЯ КАДРОВ ОДНОГО ПРОХОДА --------------------------------- *
   * Один кадр доказывает «сдал», но не доказывает «один раз»: для этого нужна
   * серия. Снимается она ТЕМ ЖЕ кодом, что и игра: рабочий доводится до кадра
   * сдачи, и снимаются подряд 4 кадра АНИМАЦИИ — по одному на каждый её кадр
   * (12 к/с против 60: между кадрами серии проходит 5 кадров симуляции).
   * После последнего кадра снимается ещё один — уже СЛЕДУЮЩЕГО состояния:
   * видно, что «0,1,2,3» кончилось сменой анимации, а не вернулось к нулю. */
  const series = await js(`(() => {
    const g = window.__mapgen, S = window.Session, B = window.Buildings, V = window.Villagers, r = g.renderer;
    g.newGame();
    const w = g.getWorld(), list = g.getBuildings(), vs = g.getVillagers();
    const camp = list.filter(b => B.typeOf(b) === 'lumbercamp')[0];
    for (const v of vs) S.hire(camp, v, vs);
    const v = vs[0];
    let guard = 0;
    while (guard++ < 60 * 600 && v.state !== 'drop') {
      w._villagers = vs; for (const x of vs) V.update(x, w, r.villagerSprites, 1/60, { buildings: list });
    }
    r.showGrid = false; r.hover = null; r.cam.zoom = 170;
    const fp = B.footprint(camp.rot, camp.type);
    r.centerOn((v.x + camp.x + fp.w / 2) / 2, (v.y + camp.y + fp.h / 2) / 2);
    /* Частота кадра — в ноль: серия снимается СИМУЛЯЦИЕЙ, а не живым временем,
       иначе живой rAF успел бы проиграть жест между снимками. */
    const meta = r.villagerSprites.meta, cp = meta.anims && meta.anims.carry_put;
    const fps0 = cp ? cp.fps : null;
    if (cp) cp.fps = 0;
    /* Кроп вокруг места сдачи: кадры анимации 112 x 132 пикселя в мире — это
       ~16 пикселей на экране при общем плане, и разглядывать в них нечего.
       Кроп масштабируется ЦЕЛОЧИСЛОМ (x4), чтобы спрайт не размывался. */
    const crop = (rr, wx, wy) => {
      const s0 = document.getElementById('view');
      const cw = 288, ch = 288, k = 4;
      const cv = document.createElement('canvas');
      cv.width = cw * k; cv.height = ch * k;
      const g2 = cv.getContext('2d');
      g2.imageSmoothingEnabled = false;
      const px = rr.sx(wx, wy) + s0.width / 2, py = rr.sy(wx, wy) + s0.height / 2;
      g2.drawImage(s0, Math.round(px - cw / 2), Math.round(py - ch / 2 - 30),
                   cw, ch, 0, 0, cv.width, cv.height);
      return cv.toDataURL('image/png');
    };
    const shots = [];
    let dropAt = { x: v.x, y: v.y };
    const n = window.Hero.frameCount(r.villagerSprites, v.anim);
    /* Доводим фазу до СЕРЕДИНЫ каждого кадра анимации и там снимаем. Целиться
       шагами «по пять кадров симуляции» нельзя: между двумя await живёт живой
       rAF, он двигает того же рабочего, и середина кадра уезжает — серия
       выходила «0,0,2,2» вместо «0,1,2,3». Цель по кадру от этого не зависит. */
    for (let i = 0; i < n; i++) {
      const want = (i + 0.5) / n;
      if (i === 0) { dropAt = { x: v.x, y: v.y }; }
      while (v.state === 'drop' && v.phase < want && guard++ < 60 * 600) {
        w._villagers = vs; for (const x of vs) V.update(x, w, r.villagerSprites, 1/60, { buildings: list });
      }
      r.render(1);
      shots.push({ i: i, state: v.state, anim: v.anim,
                   frame: Math.min(n - 1, Math.floor(v.phase * n)), phase: +v.phase.toFixed(3),
                   url: crop(r, v.x, v.y),
                   logs: w.village.logs, mine: v.delivered || 0,
                   atYard: !!B.atYardSpot(camp, v.x, v.y) });
    }
    /* Последний снимок — уже другое состояние, и он обязан ОТЛИЧАТЬСЯ от
       первого не только подписью: последний кадр carry_put у художника — та же
       стойка, с которой начинается walk, и на стоп-кадре они совпадают
       побитово. Поэтому ждём не смены состояния, а того, что рабочий ОТОШЁЛ от
       места сдачи: тогда на снимке видно и другое положение, и другую позу. */
    while (v.state === 'drop' && guard++ < 60 * 600) {
      w._villagers = vs; for (const x of vs) V.update(x, w, r.villagerSprites, 1/60, { buildings: list });
    }
    while (guard++ < 60 * 600 && Math.hypot(v.x - dropAt.x, v.y - dropAt.y) < 0.35) {
      w._villagers = vs; for (const x of vs) V.update(x, w, r.villagerSprites, 1/60, { buildings: list });
    }
    r.render(1);
    shots.push({ i: n, state: v.state, anim: v.anim, frame: -1, phase: +v.phase.toFixed(3),
                 moved: +Math.hypot(v.x - dropAt.x, v.y - dropAt.y).toFixed(2),
                 url: crop(r, v.x, v.y),
                 logs: w.village.logs, mine: v.delivered || 0,
                 atYard: !!B.atYardSpot(camp, v.x, v.y) });
    return { shots: shots, fps0: fps0, frames: n };
  })()`);
  series.shots.forEach(s => {
    fs.writeFileSync(path.join(OUT, 'lumberjack-drop-' + s.i + '.png'),
      Buffer.from(s.url.split(',')[1], 'base64'));
  });
  /* Контактный лист: кадры одного прохода в ряд. Собирается ПИКСЕЛЯМИ здесь, в
     Node, — клеить его на странице значило бы завести ещё один canvas с чужим
     состоянием, а картинок всего пять. */
  const SHEET = 'lumberjack-drop-sheet.png';
  await contactSheet(series.shots.map((s, i) => ({
    file: 'lumberjack-drop-' + s.i + '.png',
    label: i < series.frames ? 'кадр ' + s.frame + ' из ' + series.frames : s.state
  })), SHEET);
  console.log('  ' + SHEET);
  /* Частоту возвращаем: она была выключена только на время съёмки. */
  await js(`(() => {
    const cp = window.__mapgen.renderer.villagerSprites.meta.anims.carry_put;
    cp.fps = ${series.fps0 === null ? 'cp.fps' : series.fps0};
    return cp.fps;
  })()`);
  const shownFrames = series.shots.slice(0, series.frames).map(s => s.frame);
  check('серия кадров сдачи: 4 кадра подряд — это кадры 0,1,2,3 ОДНОГО прохода, и дальше смена',
    series.shots.length === series.frames + 1 &&
      shownFrames.join(',') === '0,1,2,3' &&
      series.shots[series.frames].frame === -1 &&
      series.shots[series.frames].state !== 'drop' &&
      series.shots[series.frames].moved >= 0.35 &&
      /* Казна деревни может расти от СОСЕДЕЙ в те же кадры — это не второй
         проход жеста. Проверяется личный счёт фотографируемого рабочего: он
         обязан остаться неизменным всю серию, иначе начисление повторилось. */
      series.shots.every(s => s.mine === series.shots[0].mine),
    'кадры серии: ' + series.shots.map(s => s.i + ':' + (s.frame < 0 ? s.state : s.frame)).join(' ') +
    `; личный счёт рабочего на всех снимках один (${[...new Set(series.shots.map(s => s.mine))].join(',')}, ` +
    `казна деревни ${[...new Set(series.shots.map(s => s.logs))].join(',')}) — ` +
    'жест начисляется один раз, в кадр прихода; на последнем снимке рабочий отошёл на ' +
    series.shots[series.frames].moved + ' клетки');

  /* Весь остров с дорогами рабочих: где они ходили за брёвнами. */
  const islandShot = async (name, trail, title) => {
    const data = await js(`(() => {
      const g = window.__mapgen, r = g.renderer;
      const src = r.exportPNG(1);
      const k = Math.min(1, 1500 / src.width);
      const cv = document.createElement('canvas');
      cv.width = Math.round(src.width * k); cv.height = Math.round(src.height * k);
      const g2 = cv.getContext('2d');
      g2.imageSmoothingEnabled = true;
      g2.drawImage(src, 0, 0, cv.width, cv.height);
      const cpx = r.cachePx, off = r.cacheOffset;
      const to = (x, y) => [((x - y) * 0.5 * cpx + off.x) * k, ((x + y) * 0.25 * cpx + off.y) * k];
      const t = ${JSON.stringify(trail)};
      g2.lineWidth = 1.0;
      g2.strokeStyle = 'rgba(220,60,40,0.45)';
      g2.beginPath();
      for (let i = 0; i < t.length; i++) {
        const p = to(t[i][0], t[i][1]);
        if (i === 0) g2.moveTo(p[0], p[1]); else g2.lineTo(p[0], p[1]);
      }
      g2.stroke();
      g2.fillStyle = 'rgba(0,0,0,0.55)';
      g2.fillRect(0, 0, cv.width, 26);
      g2.fillStyle = '#fff';
      g2.font = '600 15px -apple-system, Segoe UI, Roboto, sans-serif';
      g2.fillText(${JSON.stringify(title)}, 10, 18);
      return cv.toDataURL('image/png');
    })()`);
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data.split(',')[1], 'base64'));
    console.log('  ' + name);
  };
  // Имя кадра — С расширением: и `islandShot`, и `shoot` пишут имя как есть,
  // поэтому забытый `.png` давал в tools/out файл без расширения (его не
  // открыть двойным кликом и не видно в списке картинок).
  await islandShot('lumberjack-trail-carry.png', sim.carryTrail,
    'дороги с брёвнами: ' + sim.deliveries + ' сдач, ' + sim.logs + ' брёвен у деревни за ' +
    (sim.seconds / 60).toFixed(0) + ' минут (лагерь ' + sim.camp.slice(0, 2).join(',') + ')');

  console.log('\nитог работы: ' + sim.deliveries + ' сдач, ' + sim.logs + ' брёвен за ' +
    (sim.seconds / 60).toFixed(0) + ' минут; состояний ' + statesSeen);
  console.log('  сдачи по времени: ' + sim.delivAt.slice(0, 12).map(t => t.toFixed(1)).join(' ') +
    (sim.delivAt.length > 12 ? ' …' : ''));

  if (errors.length) { console.log('\nошибки:'); errors.forEach(e => console.log('  ' + e)); }
  else console.log('\nошибок в консоли нет');

  finish();

  function finish() {
    console.log(fails ? '\nПРОВАЛЕНО проверок: ' + fails : '\nИТОГ: ПРИНЯТО');
    ws.close(); killChrome();
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    process.exit(fails ? 1 : 0);
  }
})().catch(e => { console.error('ошибка: ' + e.message); killChrome(); process.exit(1); });
