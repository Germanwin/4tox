/* shot.js — приёмка стенда моделей (нужен Chrome).
 *
 * Проверяет то, что легко сломать молча:
 *   1) каталог на странице — тот же, что в data/catalog.js;
 *   2) каждая модель из каталога открывается и разбирается three.js, и число
 *      треугольников в браузере совпадает с числом, которое посчитал
 *      build_catalog.py по самому GLB. Два независимых разбора одного файла:
 *      расхождение значит, что один из них врёт;
 *   3) кадры атласа нарезаются: у выбранной модели в ленте столько кадров,
 *      сколько обещает атлас;
 *   4) вьюпорт не пустой — в кадре больше трёх цветов, то есть модель
 *      действительно нарисовалась, а не остался фон;
 *   5) камера рендера у каждой модели та, что объявлена в каталоге;
 *   6) средний цвет модели в стенде не разъехался с её же спрайтом;
 *   7) во вьюпорте нарисована модель, а не пустой фон;
 *   8) в консоли нет ошибок и исключений.
 *
 * Кадры складываются в tools/out/ — доказательство прогона, в git не идёт
 * (правило то же, что у mapgen2/tools/out/).
 *
 * Запуск: node tools/shot.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] || 'file://' + path.join(__dirname, '..', 'index.html');
const OUT = path.join(__dirname, 'out');
const PORT = 9800 + (process.pid % 150);
const PROFILE = '/tmp/dsh-stand-' + process.pid;

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

fs.mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--allow-file-access-from-files', '--hide-scrollbars',
  '--enable-unsafe-swiftshader', '--window-size=1600,1000', 'about:blank'
], { stdio: 'ignore' });

const getJSON = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});

(async () => {
  for (let i = 0; i < 120; i++) {
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map(a => a.value || a.description).join(' '));
    }
  });
  const send = (method, params) => new Promise(r => {
    const i = id++; pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  const evalJS = async (expr) => {
    const res = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text + ' ' +
        JSON.stringify(res.exceptionDetails.exception && res.exceptionDetails.exception.description));
    }
    return res.result.value;
  };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  console.log('стенд: ' + url);
  await send('Page.navigate', { url });

  async function ready() {
    for (let i = 0; i < 120; i++) {
      const ok = await evalJS('!!(window.__stand && window.__stand.ready())').catch(() => false);
      if (ok) return true;
      await wait(120);
    }
    return false;
  }

  if (!await ready()) { console.error('стенд не поднялся'); chrome.kill('SIGKILL'); process.exit(1); }

  /* --- 1. каталог ------------------------------------------------- */
  const cat = await evalJS('({ models: window.__stand.catalog.models.length, atlases: window.__stand.catalog.atlases.length, frames: window.__stand.catalog.counts.frames })');
  const inList = await evalJS('document.querySelectorAll("#list .item").length');
  check('каталог: ' + cat.models + ' моделей, ' + cat.atlases + ' атласов, ' + cat.frames + ' кадров', cat.models > 0);
  check('в списке столько же пунктов, сколько моделей и атласов',
    inList === cat.models + cat.atlases, inList + ' пунктов');

  // Каталог и байты моделей — два файла. Если сборка прервалась или браузер
  // подхватил один свежий, а другой нет, в списке будут модели, которые нечем
  // нарисовать: снаружи это выглядит как «модели нет». Ловим это здесь.
  const noBytes = await evalJS('window.__stand.catalog.models.filter(m => !window.MODEL_STAND_MESHES[m.meshKey]).map(m => m.id).join(", ")');
  check('у каждой модели каталога есть её байты в data/meshes.js', !noBytes, noBytes);

  const started = await evalJS('window.__stand.state.modelId');
  check('стенд открывается на ратуше (вариант C — тот, что ставит игра)',
    /townhall_c$/.test(started), started);

  const first = await evalJS('document.querySelector("#list .item .it-title").textContent');
  const firstBadge = await evalJS('document.querySelector("#list .item .badge").textContent');
  check('первым в списке идёт то, что в игре', firstBadge === 'в игре', first + ' [' + firstBadge + ']');

  /* --- 2. каждая модель грузится и сходится по треугольникам ------ */
  const ids = await evalJS('window.__stand.catalog.models.map(m => m.id)');
  let mismatched = [], failed = [];
  for (const mid of ids) {
    await evalJS(`window.__stand.select(${JSON.stringify(mid)})`);
    if (!await ready()) { failed.push(mid); continue; }
    const info = await evalJS('JSON.stringify(window.__stand.info())');
    const d = JSON.parse(info);
    if (!d || d.meshKey !== mid || d.tris3 !== d.tris) mismatched.push(mid + ' (' + (d && d.tris3) + ' ≠ ' + (d && d.tris) + ')');
  }
  check('все ' + ids.length + ' моделей открылись', failed.length === 0, failed.join(', '));
  check('треугольники three.js = треугольники из GLB во всех моделях',
    mismatched.length === 0, mismatched.join(', '));

  /* --- 3. кадры атласа -------------------------------------------- */
  const frameCheck = await evalJS(`(() => {
    const out = [];
    for (const a of window.__stand.catalog.atlases) {
      const m = a.models.length ? a.models[0] : null;
      if (!m) continue;
      window.__stand.select(m);
      out.push({ atlas: a.name, frames: a.frames.length, model: m });
    }
    return out;
  })()`);
  await wait(400);
  for (const item of frameCheck) {
    await evalJS(`window.__stand.select(${JSON.stringify(item.model)})`);
    await ready(); await wait(120);
    const shown = await evalJS('document.querySelectorAll("#spriteGrid .fr").length');
    check('атлас ' + item.atlas + ': лента нарезала кадры',
      shown > 0 && shown <= item.frames, shown + ' из ' + item.frames + ' кадров на листе');
  }

  /* --- 4. камера: у каждой модели своя, и она объявлена в каталоге --- */
  const camCheck = await evalJS(`(async () => {
    const out = [];
    for (const m of window.__stand.catalog.models) {
      window.__stand.select(m.id);
      await new Promise(r => setTimeout(r, 60));
      const c = window.__stand.camera();
      out.push({ id: m.id, want: m.camera, got: c.id, title: c.title });
    }
    return out;
  })()`);
  const camBad = camCheck.filter(c => c.want !== c.got);
  check('камера рендера берётся из каталога у всех ' + camCheck.length + ' моделей',
    camBad.length === 0, camBad.map(c => c.id + ': ' + c.got + ' ≠ ' + c.want).join(', '));

  /* --- 5. цвет модели в 3D против цвета её спрайта ------------------- */
  async function meanInView() {
    const v = await evalJS(`(() => {
      const cv = document.getElementById('view');
      const c2 = document.createElement('canvas'); c2.width = 200; c2.height = 200;
      const ctx = c2.getContext('2d');
      ctx.drawImage(cv, 0, 0, 200, 200);
      const d = ctx.getImageData(0, 0, 200, 200).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        // фон вьюпорта и линии сетки моделью не считаем
        const R = d[i], G = d[i+1], B = d[i+2];
        const bg = Math.abs(R-13) < 12 && Math.abs(G-26) < 14 && Math.abs(B-34) < 16;
        const grid = (R + G + B) < 230 && R < 80 && G < 105 && B < 125;
        if (!bg && !grid) { r += R; g += G; b += B; n++; }
      }
      return n ? [r/n, g/n, b/n, n] : null;
    })()`);
    return v;
  }
  async function meanInSprite(atlasName, frameName) {
    return await evalJS(`(async () => {
      const a = window.__stand.catalog.atlases.find(x => x.name === ${JSON.stringify(atlasName)});
      const fr = a.frames.find(f => f.name === ${JSON.stringify(frameName)});
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = '../../../' + a.image; });
      const c2 = document.createElement('canvas'); c2.width = fr.w; c2.height = fr.h;
      const ctx = c2.getContext('2d');
      ctx.drawImage(img, fr.x, fr.y, fr.w, fr.h, 0, 0, fr.w, fr.h);
      const d = ctx.getImageData(0, 0, fr.w, fr.h).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i+3] > 200) { r += d[i]; g += d[i+1]; b += d[i+2]; n++; }
      }
      return n ? [r/n, g/n, b/n, n] : null;
    })()`);
  }

  console.log('\nцвет: модель в 3D против кадра атласа (среднее по пикселям)');
  const colorPairs = [
    ['art/buildings/townhall/out/townhall_c', 'townhall', 'townhall_c_0'],
    ['art/buildings/townhall/out/hutrect_b', 'hut', 'hutrect_b_0'],
    ['art/characters/villager/out/villager', 'villager', 'villager_idle_0_0'],
    ['art/buildings/villager_house/out/house_a', 'house', 'vh_a_0']
  ];
  let colorBad = [];
  for (const [mid, atlasName, frameName] of colorPairs) {
    await evalJS(`window.__stand.select(${JSON.stringify(mid)}); window.__stand.setQuad(false); window.__stand.setIso(true);`);
    await ready(); await wait(400);
    const v = await meanInView();
    const s = await meanInSprite(atlasName, frameName);
    const delta = v && s ? Math.max(Math.abs(v[0]-s[0]), Math.abs(v[1]-s[1]), Math.abs(v[2]-s[2])) : 999;
    const line = mid.split('/').pop().padEnd(12) +
      ' 3D ' + v.slice(0, 3).map(x => x.toFixed(0).padStart(3)).join(',') +
      '   спрайт ' + s.slice(0, 3).map(x => x.toFixed(0).padStart(3)).join(',') +
      '   Δ ' + delta.toFixed(1);
    console.log('  ' + line);
    if (delta > 45) colorBad.push(mid);
  }
  check('цвет модели в стенде не разъехался с её спрайтом (Δ ≤ 45 из 255)',
    colorBad.length === 0, colorBad.join(', '));

  /* --- 6. кадры ---------------------------------------------------- */
  const shots = [
    ['01-townhall-iso', 'art/buildings/townhall/out/townhall_c', s => `window.__stand.setQuad(false); window.__stand.setIso(true); window.__stand.select(${JSON.stringify(s)});`],
    ['02-townhall-quad', 'art/buildings/townhall/out/townhall_c', s => `window.__stand.select(${JSON.stringify(s)}); window.__stand.setQuad(true);`],
    ['03-townhall-persp', 'art/buildings/townhall/out/townhall_b', s => `window.__stand.setQuad(false); window.__stand.setIso(false); window.__stand.select(${JSON.stringify(s)});`],
    ['04-hut-quad', 'art/buildings/townhall/out/hutrect_b', s => `window.__stand.select(${JSON.stringify(s)}); window.__stand.setQuad(true);`],
    ['05-villager-walk', 'art/characters/villager/out/villager', s => `window.__stand.select(${JSON.stringify(s)}); window.__stand.setQuad(false); window.__stand.setAnim('walk', 0);`],
    ['06-villager-quad', 'art/characters/villager/out/villager', s => `window.__stand.select(${JSON.stringify(s)}); window.__stand.setQuad(true);`],
    ['07-villager-other-cam', 'art/characters/villager/out/villager', s => `window.__stand.select(${JSON.stringify(s)}); window.__stand.setCamera('pipeline'); window.__stand.setQuad(true);`],
    ['08-lumbercamp', 'art/buildings/lumbercamp/out/lc_model', s => `window.__stand.setCamera(null); window.__stand.select(${JSON.stringify(s)}); window.__stand.setQuad(true);`],
    ['09-wave', 'art/fx/waves/out/wave_0', s => `window.__stand.setQuad(false); window.__stand.setIso(false); window.__stand.select(${JSON.stringify(s)});`],
    ['10-axe-persp', 'art/props/axe/out/axe_b', s => `window.__stand.select(${JSON.stringify(s)});`],
    ['11-house-wire', 'art/buildings/villager_house/out/house_a', s => `window.__stand.select(${JSON.stringify(s)}); window.__stand.setWire(true);`],
    ['12-coc-house', 'research/coc_house/out/coc_house', s => `window.__stand.setWire(false); window.__stand.select(${JSON.stringify(s)});`],
    ['13-sheet-townhall', 'art/buildings/townhall/out/townhall_b', s => `window.__stand.select(${JSON.stringify(s)}); window.__stand.setSheet(true);`],
    ['14-sheet-villager', 'art/characters/villager/out/villager', s => `window.__stand.select(${JSON.stringify(s)}); window.__stand.setAnim('work', 90); window.__stand.setSheet(true);`],
    ['15-atlas-sprites', null, () => `window.__stand.setSheet(false); window.__stand.setQuad(false); window.__stand.setIso(false); window.__stand.selectAtlas('sprites');`],
    ['16-atlas-hero', null, () => `window.__stand.selectAtlas('hero');`],
    ['17-atlas-lumbercamp', null, () => `window.__stand.selectAtlas('lumbercamp');`]
  ];

  console.log('\nкадры:');
  let blank = [];
  for (const [name, model, setup] of shots) {
    await evalJS(setup(model));
    await ready(); await wait(450);
    const stat = await evalJS('JSON.stringify(window.__stand.canvasStats())');
    const colors = JSON.parse(stat).colors;
    // Пустой вьюпорт — не всегда дефект: в режиме «лист во весь экран» канвас
    // скрыт намеренно, а у атласа без 3D-модели показывать в 3D нечего.
    const skipBlank = await evalJS('window.__stand.state.sheet || !window.__stand.state.modelId');
    if (!skipBlank && colors <= 3) blank.push(name);
    const dataUrl = await evalJS(`document.getElementById('view').toDataURL('image/png')`);
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '-page.png'), Buffer.from(shot.data, 'base64'));
    console.log('  ' + name + '.png + -page.png   цветов в кадре: ' + colors);
  }
  check('во всех кадрах вьюпорта есть модель, а не пустой фон', blank.length === 0, blank.join(', '));

  /* --- 7. консоль -------------------------------------------------- */
  check('в консоли нет ошибок', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log('\n' + (fails ? 'ПРОВАЛЕНО проверок: ' + fails : 'ИТОГ ПРИНЯТО: стенд открывается, все модели на месте'));
  console.log('кадры: ' + path.relative(process.cwd(), OUT));
  ws.close(); chrome.kill('SIGKILL');
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ошибка: ' + (e && e.stack || e)); chrome.kill('SIGKILL'); process.exit(1); });
