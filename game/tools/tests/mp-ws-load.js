/* mp-ws-load.js — браузерная приёмка WebSocket на 300 жителях.

   Поднимает настоящий server.js с MP_TEST_HOOKS=1, создаёт лобби, стартует
   комнату, наполняет её 300 жителями тем же Villagers.blank, что и игра, и
   меряет на живой странице:
     • транспорт — WebSocket (не SSE);
     • сколько двоичных снимков пришло за секунду и какого они размера;
     • максимальный разрыв между снимками;
     • кадры requestAnimationFrame и движение жителей;
     • переживает ли клиент обрыв сети и возвращается ли на WebSocket.

   Запуск: node game/tools/tests/mp-ws-load.js [--entities 300] [--keep]
   Отчёт: game/tools/out/mp-ws-load-<n>.json, exit 0 — PASS. */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const CHROME = require('../../../mapgen2/tools/chrome.js');
const ROOT = path.resolve(__dirname, '..', '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function post(base, p, body) {
  const r = await fetch(base + p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j };
}
async function tab(cdp, url) {
  return new Promise((resolve, reject) => {
    const q = http.request({ host: '127.0.0.1', port: cdp,
      path: '/json/new?' + encodeURIComponent(url), method: 'PUT' }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; });
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    q.on('error', reject); q.end();
  });
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pend = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(String(m.params && m.params.exceptionDetails &&
        (m.params.exceptionDetails.text || 'exception') || 'exception'));
    }
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  };
  await new Promise((r) => { ws.onopen = r; });
  const send = (method, params) => new Promise((r) => {
    const i = ++id; pend.set(i, r);
    ws.send(JSON.stringify({ id: i, method: method, params: params || {} }));
  });
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression: expression, returnByValue: true, awaitPromise: true
    });
    if (r.result && r.result.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails));
    }
    return r.result && r.result.result && r.result.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable');
  return { send, js, errors, close: () => { try { ws.close(); } catch (e) {} } };
}

async function main() {
  const want = Math.max(30, Math.min(3000, arg('entities', 300)));
  const sseMode = process.argv.includes('--sse');
  const expectedTransport = sseMode ? 'sse' : 'ws';
  const port = await freePort();
  const cdp = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-wsload-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-chrome-'));
  const server = spawn(process.execPath, [path.join(ROOT, 'game/server/server.js'),
    '--local', '--port', String(port), '--no-upnp'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      STATE_DIR: stateDir, MP_TEST_HOOKS: '1'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await getJson(base + '/api/build');
      if (r && r.ok) break;
    } catch (e) {}
    await sleep(100);
  }
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + cdp,
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', 'about:blank'
  ], { detached: true, stdio: 'ignore' });
  await sleep(900);

  const out = {
    entitiesWanted: want, chrome: 'headless', transport: null,
    villagers: 0, snapshots: null, frames: null, movers: 0,
    reconnect: null, errors: [], ok: false
  };
  let page = null;
  try {
    const t = await tab(cdp, 'about:blank');
    page = await connect(t.webSocketDebuggerUrl);
    if (sseMode) {
      /* Проверяем именно резервный канал: WebSocket в странице выключен,
         как в прокси, который не пропускает Upgrade. */
      await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: 'try{Object.defineProperty(window,"WebSocket",{value:undefined});}catch(e){window.WebSocket=undefined;}'
      });
    }
    await page.send('Page.navigate', { url: base + '/game/' });
    await sleep(3500);
    const created = await page.js('Net.create(2,"Host").then(r=>r)');
    if (!created || !created.code || !created.token) throw new Error('lobby not created');
    /* Второй игрок нужен только для старта: комната проверяет состав, а
       дальше мир считает сервер. Гостя подключаем HTTP-ом — он не рисует. */
    const guest = await post(base, '/api/join', {
      code: created.code, name: 'LoadGuest', protocol: 4
    });
    if (!guest.json || !guest.json.token) {
      throw new Error('guest join failed: ' + JSON.stringify(guest.json));
    }
    await post(base, '/api/ready', {
      code: created.code, token: created.token, ready: true
    });
    await post(base, '/api/ready', {
      code: created.code, token: guest.json.token, ready: true
    });
    const started = await post(base, '/api/start', {
      code: created.code, token: created.token
    });
    if (!started.json || !started.json.ok) {
      throw new Error('start failed: ' + JSON.stringify(started.json));
    }
    await sleep(1800);

    const filled = await post(base, '/api/test/fill', {
      code: created.code, token: created.token, n: want
    });
    if (!filled.json || !filled.json.ok) {
      throw new Error('fill failed: ' + JSON.stringify(filled.json));
    }
    await sleep(3500);
    /* Счётчики разрыва — по ровному участку: наполнение мира 600 жителями
       само по себе одноразовая пауза, и записывать её в «сеть lagает»
       нечестно. */
    await page.js('Net.resetTransportStats && Net.resetTransportStats(); true');

    const st0 = await page.js(`({
      transport: Net.transport(), stats: Net.transportStats(),
      villagers: Play.state.villagers.length,
      seq: Play.state.netSeq, mode: Play.state.gameMode,
      errors: (window.__mpErrors||[]).length
    })`);
    out.transport = st0.transport;
    out.villagers = st0.villagers;

    const frames = await page.js(`new Promise(function(resolve){
      var f=[], last=performance.now(), start=last;
      function step(now){
        f.push(now-last); last=now;
        if (now-start < 7000) requestAnimationFrame(step);
        else {
          var s=f.slice().sort(function(a,b){return a-b;});
          var p=function(q){return +s[Math.min(s.length-1,Math.floor((s.length-1)*q))].toFixed(2);};
          resolve({ frames:f.length, p50:p(0.5), p95:p(0.95),
            max:+Math.max.apply(null,f).toFixed(2),
            over50:f.filter(function(x){return x>50;}).length });
        }
      }
      requestAnimationFrame(step);
    })`);
    const before = await page.js('[Play.state.villagers.map(v=>[v.id,v.x,v.y]),Net.transportStats(),Play.state.netSeq]');
    await sleep(1500);
    const after = await page.js('[Play.state.villagers.map(v=>[v.id,v.x,v.y]),Net.transportStats(),Play.state.netSeq]');
    const moved = after[0].filter((v, i) => before[0][i] &&
      (Math.abs(v[1] - before[0][i][1]) > 0.05 ||
       Math.abs(v[2] - before[0][i][2]) > 0.05)).length;
    out.frames = frames;
    out.movers = moved;
    out.snapshots = after[1];
    const snapRate = (after[1].snapshotsIn - before[1].snapshotsIn) / 1.5;
    out.snapshotsPerSecond = +snapRate.toFixed(2);
    out.lastSnapBytes = after[1].lastSnapBytes;
    out.maxGapMs = after[1].maxGapMs;
    out.seq = after[2];
    out.seqPerSecond = +((after[2] - before[2]) / 1.5).toFixed(2);

    /* Обрыв сети: WebSocket должен закрыться, клиент — переподключиться и
       снова пойти вперёд по revision. */
    await page.send('Network.enable');
    await page.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    });
    await sleep(1200);
    await page.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    });
    await sleep(5000);
    const rec = await page.js(`({
      transport: Net.transport(), stats: Net.transportStats(),
      seq: Play.state.netSeq, stale: Play.state.netStale
    })`);
    out.reconnect = rec;

    /* F5: сессия лежит в localStorage, сервер отдаёт тот же мир, а клиент
       обязан снова подняться на WebSocket, а не остаться в меню. */
    await page.send('Page.reload', { ignoreCache: false });
    await sleep(6000);
    const f5 = await page.js(`({
      mode: Play.state.gameMode, transport: Net.transport(),
      villagers: Play.state.villagers.length, seq: Play.state.netSeq,
      code: Net.code(), room: Net.roomId()
    })`);
    out.f5 = f5;

    const checks = [
      ['transport', out.transport === expectedTransport, out.transport],
      ['villagers', out.villagers >= want, out.villagers + ' >= ' + want],
      ['snapshotsPerSecond', sseMode
        ? out.seqPerSecond >= 10
        : out.snapshotsPerSecond >= 8,
        sseMode ? out.seqPerSecond + ' rev/s' : out.snapshotsPerSecond],
      ['maxGapMs', sseMode || (out.maxGapMs > 0 && out.maxGapMs < 400),
        sseMode ? 'n/a' : out.maxGapMs],
      ['snapshotBytes', sseMode || (out.lastSnapBytes > 0 && out.lastSnapBytes < 60000),
        sseMode ? 'n/a' : out.lastSnapBytes],
      ['framesP95', out.frames && out.frames.p95 < 50, out.frames && out.frames.p95],
      ['framesOver50', out.frames && out.frames.over50 < 20, out.frames && out.frames.over50],
      ['movers', out.movers > Math.min(50, want / 3), out.movers],
      ['reconnectTransport', out.reconnect &&
        out.reconnect.transport === expectedTransport,
        out.reconnect && out.reconnect.transport],
      ['reconnectSeq', out.reconnect && out.reconnect.seq > out.seq,
        out.seq + ' -> ' + (out.reconnect && out.reconnect.seq)],
      ['f5InGame', out.f5 && out.f5.mode === 'mp', out.f5 && out.f5.mode],
      ['f5Villagers', out.f5 && out.f5.villagers >= want, out.f5 && out.f5.villagers],
      ['f5Transport', out.f5 && out.f5.transport === expectedTransport,
        out.f5 && out.f5.transport],
      ['f5Seq', out.f5 && out.f5.seq > (out.reconnect && out.reconnect.seq),
        (out.reconnect && out.reconnect.seq) + ' -> ' + (out.f5 && out.f5.seq)],
      ['pageErrors', page.errors.length === 0, page.errors.join('; ')]
    ];
    out.checks = checks.map(([name, ok, value]) => ({
      name: name, ok: !!ok, value: value
    }));
    out.ok = checks.every((x) => x[1]);
    if (!out.ok) {
      out.failed = checks.filter((x) => !x[1]).map((x) => x[0]);
    }
  } catch (e) {
    out.error = String(e && e.stack || e);
  } finally {
    try { chrome.kill('SIGKILL'); } catch (e) {}
    try { server.kill('SIGKILL'); } catch (e) {}
    try { if (page) page.close(); } catch (e) {}
  }
  const dir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mp-ws-load-' + want + (sseMode ? '-sse' : '') + '.json');
  out.serverLogTail = serverLog.slice(-2000);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
  console.log('written ' + file);
  process.exit(out.ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
