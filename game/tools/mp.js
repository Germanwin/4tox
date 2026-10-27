/* mp.js — браузерная приёмка сетевой комнаты.

   Две настоящие страницы game/: хост создаёт лобби, гость входит, оба жмут
   «Готов», хост начинает. Проверяется главное требование миграции: у обоих
   один серверный мир, оба — обычные клиенты, снимки идут от комнаты, гость
   командует через сервер, а закрытие вкладки организатора не останавливает
   партию.

   Запуск: node game/tools/mp.js
   Без браузера серверная часть проверяется game/tools/tests/mp-acceptance.js. */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const CHROME = require('../../mapgen2/tools/chrome.js');

const REPO = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let fails = 0;
function check(ok, text) {
  console.log((ok ? '  ok   ' : '  FAIL ') + text);
  if (!ok) fails++;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function newTab(cdp, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: cdp,
      path: '/json/new?' + encodeURIComponent(url), method: 'PUT'
    }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(String(m.params && m.params.exceptionDetails &&
        (m.params.exceptionDetails.text || '') || 'exception'));
    }
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  await new Promise((resolve) => { ws.onopen = resolve; });
  const send = (method, params) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method: method, params: params || {} }));
  });
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    if (r.result && r.result.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails));
    }
    return r.result && r.result.result && r.result.result.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  return { ws, send, js, errors };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: node game/tools/mp.js');
    console.log('starts an isolated server + headless Chrome and checks two clients');
    return 0;
  }
  const port = await freePort();
  const cdp = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-mp-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-chrome-'));
  const server = spawn(process.execPath, [path.join(REPO, 'game', 'server', 'server.js'),
    '--local', '--port', String(port), '--no-upnp'], {
    cwd: REPO,
    env: Object.assign({}, process.env, { STATE_DIR: stateDir }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await sleep(1200);
  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + cdp,
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', 'about:blank'
  ], { detached: true, stdio: 'ignore' });
  await sleep(1000);

  let A = null, B = null;
  try {
    const list = await getJSON('http://127.0.0.1:' + cdp + '/json/list');
    const first = list.find((t) => t.type === 'page');
    A = await connect(first.webSocketDebuggerUrl);
    B = await connect((await newTab(cdp, 'about:blank')).webSocketDebuggerUrl);
    await A.send('Page.navigate', { url: base + '/game/' });
    await B.send('Page.navigate', { url: base + '/game/' });
    await sleep(3500);

    const loaded = await A.js('({ready:!!(window.Play&&window.Net&&window.SnapshotBuffer&&window.ServerClock),proto:window.NetConfig&&NetConfig.protocol})');
    check(loaded.ready && loaded.proto === 4, 'game page: NetConfig 4, SnapshotBuffer, ServerClock');

    const created = await A.js('Net.create(2,"Host").then(r=>r)');
    const joined = await B.js('Net.join(' + JSON.stringify(created.code) + ',"Guest").then(r=>r)');
    check(created.ok && joined.ok, 'lobby created and joined: ' + created.code);
    await A.js('Net.ready(true)');
    await B.js('Net.ready(true)');
    const started = await A.js('Net.start().then(r=>r)');
    check(!!started && started.start && started.start.protocol === 4 &&
      !!started.start.baseline && !!started.start.roomId,
    'start payload: protocol 4 + server baseline + roomId');
    await sleep(2500);

    const sa = await A.js('({role:Play.state.netRole,proto:Play.state.netProtocol,seq:Play.state.netSeq,seed:Play.state.world&&Play.state.world.seed,nv:Play.state.villagers.length,nb:Play.state.buildings.length,center:Play.state.netCentered})');
    const sb = await B.js('({role:Play.state.netRole,proto:Play.state.netProtocol,seq:Play.state.netSeq,seed:Play.state.world&&Play.state.world.seed,nv:Play.state.villagers.length,nb:Play.state.buildings.length,center:Play.state.netCentered})');
    check(sa.role === 'client' && sa.proto === 4 && sb.role === 'client' && sb.proto === 4,
      'both are presentation clients (creator too)');
    check(sa.seed === sb.seed && sa.nv === sb.nv && sa.nb === sb.nb,
      'same seed and object counts: ' + sa.nv + ' жителей, ' + sa.nb + ' построек');
    check(sa.seq > 0 && sb.seq > 0, 'baseline and snapshots applied');

    const before = await B.js('[Play.state.villagers.map(v=>[v.id,v.x,v.y]),Play.state.netSeq]');
    await sleep(1200);
    const after = await B.js('[Play.state.villagers.map(v=>[v.id,v.x,v.y]),Play.state.netSeq]');
    check(after[1] > before[1], 'guest revision advances: ' + before[1] + ' -> ' + after[1]);
    const moved = after[0].some((v, i) => before[0][i] &&
      (Math.abs(v[1] - before[0][i][1]) > 0.01 || Math.abs(v[2] - before[0][i][2]) > 0.01));
    check(moved, 'display poses move between snapshots');

    const stop = await B.js('Net.command({type:"stop",ids:[]}).then(r=>r)');
    check(stop && stop.state === 'applied', 'guest command applied by server');

    const hireIds = await B.js('(function(){var camp=Play.state.buildings.filter(function(b){return b.owner===1&&b.type==="lumbercamp";})[0];var v=Play.state.villagers.filter(function(x){return x.owner===1&&!x.employer&&!x.warrior&&!x.trainee;})[0];return camp&&v?{campId:camp.id,villagerId:v.id}:null;})()');
    if (hireIds) {
      const hire = await B.js('Net.command({type:"hire",payload:' + JSON.stringify(hireIds) + '}).then(r=>r)');
      check(hire && hire.state === 'applied', 'guest hire command applied');
    }
    const build = await B.js('Net.command({type:"build",payload:{buildingType:"house",variant:"a",rot:90,x:Play.state.buildings[0].x+8,y:Play.state.buildings[0].y+8}}).then(r=>r)');
    check(build && build.state === 'rejected' && build.reasonCode === 'no_resources',
      'build command reaches server and is rejected for zero logs');

    const hostSeq = await A.js('Play.state.netSeq');
    const guestSeq = await B.js('Play.state.netSeq');
    check(hostSeq > 0 && guestSeq > 0, 'creator receives the same server snapshots');

    await A.send('Page.close');
    /* E01: по умолчанию быстрое окно; MP_HOST_CLOSE_MS=60000 — полное
       шестидесятисекундное окно для отчёта. */
    const hostCloseMs = Math.max(200, Number(process.env.MP_HOST_CLOSE_MS) || 1200);
    await sleep(hostCloseMs);
    const guestAfter = await B.js('Play.state.netSeq');
    check(guestAfter > guestSeq, 'guest keeps receiving ticks after creator closes: ' +
      guestSeq + ' -> ' + guestAfter);
    const fault = await B.js('Play.state.netFault');
    check(!fault, 'no room fault');

    const errs = (A.errors || []).concat(B.errors || []);
    check(errs.length === 0, 'no page exceptions' + (errs.length ? ': ' + errs.join('; ') : ''));
  } catch (e) {
    check(false, 'acceptance runs: ' + String(e && e.message || e));
  } finally {
    try { chrome.kill('SIGKILL'); } catch (e) {}
    try { server.kill('SIGKILL'); } catch (e) {}
    if (fails) console.error('\nserver log:\n' + serverLog.slice(-3000));
  }
  console.log(fails ? '\nMP: FAIL (' + fails + ')' : '\nMP: PASS');
  return fails ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(String(e && e.stack || e));
    process.exitCode = 2;
  });
}

module.exports = { main: main };
