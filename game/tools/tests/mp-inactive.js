/* mp-inactive.js — приёмка удаления неактивных партий.

   Заказчик 2026-10-29: «неактивные партии спустя 30 секунд удалялись».
   Партия без единого подключённого игрока не должна вечно держать слот
   MAX_ACTIVE_ROOMS (иначе новая получает server_capacity) и не должна
   воскресать из checkpoint после перезапуска Node.

   Проверяем на изолированном сервере с INACTIVE_TTL=1200:
   - лобби, к которому никто не подключился, исчезает, каталог стирается;
   - живой SSE держит партию дольше TTL (скрытая вкладка не убивает игру);
   - после закрытия SSE партия удаляется;
   - уход последнего игрока останавливает комнату и освобождает слот:
     следующая партия стартует без server_capacity.

   Запуск: node game/tools/tests/mp-inactive.js
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TTL = 1200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;

function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
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

async function waitFor(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) { /* сервер ещё поднимается */ }
    await sleep(100);
  }
  throw new Error('server_not_ready');
}

async function post(base, p, body) {
  const r = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let json = null;
  try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, json: json };
}

async function get(base, p) {
  const r = await fetch(base + p);
  let json = null;
  try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, json: json };
}

async function openSse(base, code, token) {
  const ctrl = new AbortController();
  const r = await fetch(base + '/api/events?code=' + encodeURIComponent(code) +
    '&token=' + encodeURIComponent(token), { signal: ctrl.signal });
  return { response: r, ctrl: ctrl, reader: r.body.getReader() };
}

async function waitGone(fn, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: node game/tools/tests/mp-inactive.js');
    console.log('INACTIVE_TTL=' + TTL + ', изолированный сервер и STATE_DIR');
    return 0;
  }
  const port = await freePort();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), '4tox-inactive-'));
  const logPath = path.join(os.tmpdir(), '4tox-inactive-' + port + '.log');
  const log = fs.createWriteStream(logPath);
  const child = spawn(process.execPath, [path.join(ROOT, 'game', 'server', 'server.js'),
    '--local', '--port', String(port), '--no-upnp'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      STATE_DIR: stateDir,
      INACTIVE_TTL: String(TTL)
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  const base = 'http://127.0.0.1:' + port;
  const roomDir = (code) => path.join(stateDir, code);
  const sse = [];

  try {
    await waitFor(base + '/api/build', 10000);

    /* 1. Лобби, к которому никто не подключился, обязано исчезнуть.
       Опрашивать /api/status в цикле нельзя: каждый запрос — это
       touchPlayer, то есть активность. Ждём молча и смотрим один раз. */
    const a = await post(base, '/api/lobby', { name: 'HostA', max: 2, protocol: 4 });
    const aCode = a.json && a.json.code;
    const aTok = a.json && a.json.token;
    check('lobby A created', a.status === 200 && !!aCode, aCode);
    await sleep(TTL * 3);
    const aStatus = await get(base, '/api/status?code=' + aCode + '&token=' + aTok);
    check('lobby without connection is deleted after TTL', aStatus.status === 403,
      'status ' + aStatus.status + ', TTL ' + TTL + 'ms');
    check('state directory of inactive lobby is removed', !fs.existsSync(roomDir(aCode)),
      roomDir(aCode));

    /* 2. Живой SSE — партия активна, TTL её не трогает. */
    const b = await post(base, '/api/lobby', { name: 'HostB', max: 2, protocol: 4 });
    const bCode = b.json && b.json.code;
    const bTok = b.json && b.json.token;
    const bSse = await openSse(base, bCode, bTok);
    sse.push(bSse);
    check('lobby B created with live SSE', b.status === 200 && !!bCode, bCode);
    await sleep(TTL + 700);
    const bAlive = await get(base, '/api/status?code=' + bCode + '&token=' + bTok);
    check('live SSE keeps the party past TTL', bAlive.status === 200,
      'status ' + bAlive.status);
    bSse.ctrl.abort();
    await sleep(TTL * 3);
    const bAfter = await get(base, '/api/status?code=' + bCode + '&token=' + bTok);
    check('party is deleted after its last SSE closes', bAfter.status === 403,
      'status ' + bAfter.status + ', dir=' + fs.existsSync(roomDir(bCode)));

    /* 3. Старт комнаты, уход последнего игрока — слот освобождается. */
    async function startParty(tag) {
      const l = await post(base, '/api/lobby', { name: 'Host' + tag, max: 2, protocol: 4 });
      const code = l.json && l.json.code, hostTok = l.json && l.json.token;
      const g = await post(base, '/api/join', { code: code, name: 'Guest' + tag, protocol: 4 });
      const guestTok = g.json && g.json.token;
      await post(base, '/api/ready', { code: code, token: hostTok, ready: true });
      await post(base, '/api/ready', { code: code, token: guestTok, ready: true });
      const s = await post(base, '/api/start', { code: code, token: hostTok });
      return { code, hostTok, guestTok, started: s };
    }

    const c = await startParty('C');
    check('party C starts (slot is free)', c.started.status === 200 &&
      !!(c.started.json && c.started.json.start), 'status ' + c.started.status);
    check('room C state directory exists', fs.existsSync(roomDir(c.code)), c.code);
    await post(base, '/api/leave', { code: c.code, token: c.guestTok });
    await post(base, '/api/leave', { code: c.code, token: c.hostTok });
    const goneC = await waitGone(async () => !fs.existsSync(roomDir(c.code)), 6000);
    check('leaving the last player removes the room state', goneC, c.code);
    const cStatus = await get(base, '/api/status?code=' + c.code + '&token=' + c.hostTok);
    check('closed lobby answers 403', cStatus.status === 403, 'status ' + cStatus.status);

    /* 4. Главное: после закрытия первой комнаты вторая стартует, а не
       получает server_capacity. */
    const d = await startParty('D');
    const dErr = d.started.json && d.started.json.reason;
    check('next party starts after the slot is freed', d.started.status === 200 &&
      !!(d.started.json && d.started.json.start), dErr || ('status ' + d.started.status));
    await post(base, '/api/leave', { code: d.code, token: d.guestTok });
    await post(base, '/api/leave', { code: d.code, token: d.hostTok });
    await waitGone(async () => !fs.existsSync(roomDir(d.code)), 6000);
  } catch (e) {
    check('acceptance runs', false, String(e && e.stack || e));
  } finally {
    sse.forEach((s) => { try { s.ctrl.abort(); } catch (e) {} });
    try { child.kill('SIGKILL'); } catch (e) {}
    await sleep(200);
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.unlinkSync(logPath); } catch (e) {}
  }
  console.log(fails ? ('FAILED: ' + fails) : 'OK: all checks passed');
  return fails ? 1 : 0;
}

main().then(function (code) {
  process.exit(code);
}).catch(function (e) {
  console.error(e);
  process.exit(1);
});
