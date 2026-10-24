/* filecheck.js — проверка, что стенд открывается ДВОЙНЫМ КЛИКОМ (нужен Chrome).
 *
 * `shot.js` гоняет стенд с флагом `--allow-file-access-from-files`: он нужен
 * только самой приёмке, чтобы прочитать пиксели кадра атласа для сверки цвета.
 * Обычному человеку флагов негде взять — он открывает index.html из Finder.
 *
 * Поэтому здесь Chrome запускается БЕЗ единого послабления и проверяется ровно
 * то, на чём стенд может молча сломаться в этом режиме:
 *   1) страница поднялась и каталог на месте;
 *   2) GLB разобрался из base64 (никакого fetch — по file:// он запрещён);
 *   3) картинка атласа грузится по относительному пути;
 *   4) в консоли нет ошибок и исключений.
 *
 * Запуск: node tools/filecheck.js
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = process.argv[2] || 'file://' + path.join(__dirname, '..', 'index.html');
const PORT = 9910 + (process.pid % 80);
const PROFILE = '/tmp/dsh-stand-plain-' + process.pid;

let fails = 0;
function check(name, ok, extra) {
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (extra ? '   ' + extra : ''));
}

// Ни одного послабления: ни --allow-file-access-from-files, ни --disable-web-security.
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
  '--no-first-run', '--hide-scrollbars', '--enable-unsafe-swiftshader',
  '--window-size=1400,900', 'about:blank'
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
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
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
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result.value;
  };

  console.log('стенд без послаблений Chrome: ' + url);
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 2500));

  const up = await evalJS('!!(window.__stand && window.__stand.catalog)');
  check('страница поднялась, каталог на месте', up);

  const info = up ? JSON.parse(await evalJS('JSON.stringify(window.__stand.info())')) : null;
  check('GLB разобрался из base64 (без fetch)',
    !!(info && info.tris3 > 0), info ? info.meshKey + ', ' + info.tris3 + ' трис' : '');

  const img = JSON.parse(await evalJS(`(async () => {
    const a = window.__stand.catalog.atlases.find(x => x.name === 'townhall');
    const im = new Image();
    const done = new Promise(res => { im.onload = () => res('ok'); im.onerror = () => res('fail'); });
    im.src = '../../../' + a.image;
    return JSON.stringify({ state: await done, w: im.naturalWidth, h: im.naturalHeight });
  })()`));
  check('картинка атласа грузится относительным путём',
    img.state === 'ok' && img.w > 0, img.w + '×' + img.h);

  const frames = await evalJS('document.querySelectorAll("#spriteGrid .fr").length');
  check('кадры атласа нарезались', frames > 0, frames + ' кадров');

  check('в консоли нет ошибок', errors.length === 0, errors.slice(0, 3).join(' | '));

  console.log('\n' + (fails ? 'ПРОВАЛЕНО проверок: ' + fails
    : 'ИТОГ ПРИНЯТО: стенд открывается двойным кликом, без флагов Chrome'));
  ws.close(); chrome.kill('SIGKILL');
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ошибка: ' + (e && e.stack || e)); chrome.kill('SIGKILL'); process.exit(1); });
