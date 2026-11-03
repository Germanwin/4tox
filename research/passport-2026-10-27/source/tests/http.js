/* http.js — приёмка NET-02 и серверной части §7/OBS-01 без Chrome.

   Две половины:

   1. Клиент `game/js/net.js` грузится в globalThis со стабами EventSource,
      localStorage/sessionStorage и fetch. Проверяются ровно те поломки, из-за
      которых игра «висела»:
        • таймаут считается до конца тела, а не до заголовков;
        • битый JSON, HTTP 500, обрыв fetch различаются полем kind;
        • после каждой ошибки следующий запрос работает;
        • поздний ответ старой партии не применяется (generation guard);
        • повтор команды идёт с ТЕМ ЖЕ n, а не с новым;
        • busy/pump не залипают, `unknown` — не отказ;
        • упаковка gzip-снимка имеет жёсткий предел и возвращает ошибку,
          а не висит.

   2. Настоящий `game/server/server.js` (spawn, PORT, --local):
        • ReadJson: битый JSON/gzip → 400, обрыв сокета не убивает сервер,
          исключение callback → одна 500, а не повтор с null;
        • команды: `ageMs` по серверным часам, `at` сохранён; >1000 действий
          не теряют идемпотентность; `ids`/`appliedSeq` не выбрасываются.

   Запуск: node game/tools/http.js
   Код возврата 1 при FAIL. NOT RUN — не PASS. */
'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 9100 + (process.pid % 70);
const BASE = 'http://127.0.0.1:' + PORT;

let ok = 0, fail = 0, notrun = 0;
function check(cond, text) {
  console.log((cond ? '  ok   ' : '  FAIL ') + text);
  if (cond) ok++; else fail++;
}
function notRun(text) {
  console.log('  NOT RUN ' + text);
  notrun++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------- *
 * Стабы браузера и загрузка net.js
 * --------------------------------------------------------------------- */
function makeStorage() {
  const data = Object.create(null);
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    clear: () => { Object.keys(data).forEach((k) => delete data[k]); }
  };
}
globalThis.window = globalThis;
globalThis.localStorage = makeStorage();
globalThis.sessionStorage = makeStorage();
globalThis.location = { protocol: 'http:', search: '' };

/* EventSource нужен только как конструкция: сеть в этих тестах — fetch. */
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = Object.create(null);
    this.onopen = null;
    this.onerror = null;
    this.closed = false;
  }
  addEventListener(type, fn) {
    (this.listeners[type] || (this.listeners[type] = [])).push(fn);
  }
  close() { this.closed = true; }
  emit(type, data) {
    (this.listeners[type] || []).forEach((fn) => fn({ data: JSON.stringify(data) }));
  }
}
globalThis.EventSource = FakeEventSource;

const realFetch = globalThis.fetch;
let fetchImpl = () => Promise.reject(new Error('fetch не задан'));
globalThis.fetch = (...args) => fetchImpl(...args);

function jsonResponse(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {})
  });
}
function setFetch(fn) { fetchImpl = fn; }
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function expectReject(p, kind) {
  return p.then(() => ({ rejected: false }),
    (e) => ({ rejected: true, error: e, kind: e && e.kind }));
}

/* Стартовый пакет с cmdProto:2, чтобы команда ждала конечный результат. */
function startPayload() {
  return {
    seed: 'http-тест', size: 64, sites: [],
    hostId: 0, cmdProto: 2, snapGzip: true,
    players: [{ id: 0, name: 'Хост', owner: 0, color: '#4a90d9' }]
  };
}
function lobbyView(code) {
  return { code: code, max: 2, started: true, hostId: 0,
    players: [{ id: 0, name: 'Хост', ready: true, host: true, online: true }] };
}

require(path.join(REPO, 'game/js/net.js'));
const Net = globalThis.Net;
const DEFAULT_LIMITS = Net.limits();

async function resetNet() {
  Net.setLimits(DEFAULT_LIMITS);
  Net.reset();
  await sleep(10);
  setFetch(() => Promise.reject(new Error('fetch не задан')));
}

function nextOkResponse() {
  setFetch(() => Promise.resolve(jsonResponse({ ok: true, port: 1 })));
  return Net.serverInfo(true);
}
async function worksAfter() {
  try {
    const j = await nextOkResponse();
    return !!(j && j.ok);
  } catch (e) {
    return false;
  }
}

async function clientTests() {
  console.log('\n-- net.js: таймауты, ошибки, поколение, команды --');

  /* 1. Заголовки пришли, тело не кончается: предел обязан покрывать тело. */
  await resetNet();
  Net.setLimits({ request: 20 });
  let sawSignal = null;
  setFetch((url, opts) => {
    sawSignal = opts && opts.signal;
    return Promise.resolve(new Response(new ReadableStream({ start() {} }), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
  });
  let t0 = Date.now();
  let r = await expectReject(Net.serverInfo(true), 'timeout');
  check(r.rejected && r.kind === 'timeout',
    'тело, которое никогда не кончается, даёт timeout (kind=' + r.kind + ')');
  check(Date.now() - t0 < 800,
    'таймаут сработал за ' + (Date.now() - t0) + ' мс, а не висел');
  check(!!sawSignal && sawSignal.aborted === true,
    'AbortController отменён: signal.aborted=' + (sawSignal && sawSignal.aborted));
  check(!!r.error && /не ответил/.test(r.error.message),
    'сообщение таймаута понятное: ' + (r.error && r.error.message));

  /* После каждого случая следующий запрос обязан работать. */
  check(await worksAfter(), 'после таймаута следующий запрос работает');
  check(await worksAfter(), 'после успешного запроса следующий тоже работает');

  /* 2. HTTP 500 и битый JSON различаются. */
  await resetNet();
  setFetch(() => Promise.resolve(new Response('{"ok":false,"reason":"бум"}', {
    status: 500, headers: { 'content-type': 'application/json' }
  })));
  r = await expectReject(Net.serverInfo(true), 'http');
  check(r.rejected && r.kind === 'http' && r.error.status === 500,
    'HTTP 500 — kind=http, status=' + (r.error && r.error.status));
  check(/бум/.test(r.error && r.error.message || ''),
    'причина HTTP-ошибки сохранена: ' + (r.error && r.error.message));
  check(await worksAfter(), 'после HTTP 500 следующий запрос работает');

  setFetch(() => Promise.resolve(new Response('{oops', {
    status: 200, headers: { 'content-type': 'application/json' }
  })));
  r = await expectReject(Net.serverInfo(true), 'parse');
  check(r.rejected && r.kind === 'parse' && r.error.status === 200,
    'битый JSON — kind=parse, status=' + (r.error && r.error.status));
  check(await worksAfter(), 'после битого JSON следующий запрос работает');

  /* 3. Обрыв fetch (сеть) — тоже отдельный kind. */
  setFetch(() => Promise.reject(new TypeError('fetch failed')));
  r = await expectReject(Net.serverInfo(true), 'network');
  check(r.rejected && r.kind === 'network',
    'обрыв fetch — kind=network: ' + (r.error && r.error.message));
  check(await worksAfter(), 'после обрыва fetch следующий запрос работает');

  /* 4. Generation guard: поздний create старой партии не подменяет новую. */
  await resetNet();
  let lobbyCalls = 0;
  const dA = deferred(), dB = deferred();
  setFetch((url) => {
    if (url === '/api/lobby') {
      lobbyCalls++;
      return lobbyCalls === 1 ? dA.promise : dB.promise;
    }
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  const pA = Net.create(2, 'A');
  const pACatch = pA.catch((e) => e);
  await sleep(10);
  const genA = Net.generation();
  const pB = Net.create(2, 'B');
  const genB = Net.generation();
  check(genB > genA && !Net.isCurrent(genA) && Net.isCurrent(genB),
    'поколение выросло в create: ' + genA + ' → ' + genB);
  dA.resolve(jsonResponse({ ok: true, code: 'AAAAA', token: 'ta',
    playerId: 7, hostId: 7, players: [] }));
  const aErr = await pACatch;
  check(!!aErr && aErr.kind === 'stale',
    'поздний create старой партии отвергнут как stale, а не применён');
  dB.resolve(jsonResponse({ ok: true, code: 'BBBBB', token: 'tb',
    playerId: 8, hostId: 8, players: [] }));
  const bRes = await pB;
  check(bRes.ok && Net.code() === 'BBBBB' && Net.playerId() === 8,
    'вторая партия осталась своей: code=' + Net.code() + ', playerId=' + Net.playerId());

  /* 5. Поздний status старой партии не запускает start и не трогает busy. */
  let starts = 0;
  const offStart = Net.on('start', () => { starts++; });
  const dStatus = deferred();
  setFetch((url) => {
    if (url.indexOf('/api/status') === 0) return dStatus.promise;
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  const pStatus = Net.status();
  const pStatusCatch = pStatus.catch((e) => e);
  await sleep(10);
  Net.reset();
  dStatus.resolve(jsonResponse({
    ok: true, started: true, start: startPayload(), lobby: lobbyView('BBBBB')
  }));
  const sErr = await pStatusCatch;
  check(!!sErr && sErr.kind === 'stale',
    'поздний status старой партии отвергнут как stale');
  check(starts === 0 && Net.started() === null,
    'поздний status не запустил start: событий ' + starts);
  offStart();

  /* 6. Поздний ответ команды старой партии не применяется и не снимает
     busy новой. */
  await resetNet();
  setFetch((url) => {
    if (url === '/api/lobby') {
      return Promise.resolve(jsonResponse({ ok: true, code: 'CCCCC', token: 'tc',
        playerId: 0, hostId: 0, players: [] }));
    }
    if (url.indexOf('/api/status') === 0) {
      return Promise.resolve(jsonResponse({
        ok: true, started: true, start: startPayload(), lobby: lobbyView('CCCCC')
      }));
    }
    if (url === '/api/command') return dCmd.promise;
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  await Net.create(2, 'C');
  await Net.status();
  const dCmd = deferred();
  const cmdStart = Net.command({ type: 'build', buildingType: 'house', x: 1, y: 1, n: 1 });
  const cmdCatch = cmdStart.catch((e) => e);
  await sleep(10);
  Net.reset();
  dCmd.resolve(jsonResponse({ ok: true, n: 1, sn: 1, state: 'pending' }));
  const cErr = await cmdCatch;
  check(!!cErr && cErr.kind === 'stale',
    'поздний ответ команды отвергнут как stale');
  check(Net.busy().sends === 0 && Net.busy().pump === false,
    'после смены партии busy не залип: ' + JSON.stringify(Net.busy()));

  /* 7. Повтор команды идёт с тем же n. */
  await resetNet();
  let cmdBodies = [], cmdAttempts = 0, cmdN = 0;
  setFetch((url, opts) => {
    if (url === '/api/lobby') {
      return Promise.resolve(jsonResponse({ ok: true, code: 'DDDDD', token: 'td',
        playerId: 0, hostId: 0, players: [] }));
    }
    if (url.indexOf('/api/status') === 0) {
      return Promise.resolve(jsonResponse({
        ok: true, started: true, start: startPayload(), lobby: lobbyView('DDDDD')
      }));
    }
    if (url === '/api/command') {
      cmdAttempts++;
      const body = JSON.parse(opts.body);
      cmdBodies.push(body);
      cmdN = body.command.n;
      if (cmdAttempts === 1) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(jsonResponse({ ok: true, n: cmdN, sn: 9, state: 'pending' }));
    }
    if (url.indexOf('/api/command-state') === 0) {
      return Promise.resolve(jsonResponse({ ok: true, results: [{
        n: cmdN, sn: 9, state: 'applied', reason: '', ids: ['p0:b1'], appliedSeq: 12
      }] }));
    }
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  Net.setLimits({ commandSend: 2000, commandResult: 500, pollMin: 40, pollMax: 80 });
  await Net.create(2, 'D');
  await Net.status();
  const cmd = Net.command({ type: 'build', buildingType: 'house', x: 1, y: 1 });
  const cmdRes = await cmd;
  check(cmdAttempts === 2 && cmdBodies.length === 2,
    'команда повторилась ' + cmdAttempts + ' раза (не больше)');
  check(cmdBodies[0].command.n === cmdBodies[1].command.n &&
    cmdBodies[0].command.n === cmd.n && cmd.commandId === cmd.n,
    'повтор несёт ТОТ ЖЕ n=' + cmd.n + ' и commandId=' + cmd.commandId);
  check(cmdRes.state === 'applied' && cmdRes.ok === true &&
    cmdRes.ids[0] === 'p0:b1' && cmdRes.appliedSeq === 12,
    'конечный результат applied с ids/appliedSeq: ' + JSON.stringify(cmdRes));

  /* 8. Нет ответа — честный timeout, а не «отклонено»; busy снят. */
  await resetNet();
  let hangN = 0;
  setFetch((url, opts) => {
    if (url === '/api/lobby') {
      return Promise.resolve(jsonResponse({ ok: true, code: 'EEEEE', token: 'te',
        playerId: 0, hostId: 0, players: [] }));
    }
    if (url.indexOf('/api/status') === 0) {
      return Promise.resolve(jsonResponse({
        ok: true, started: true, start: startPayload(), lobby: lobbyView('EEEEE')
      }));
    }
    if (url === '/api/command') {
      hangN = JSON.parse(opts.body).command.n;
      return Promise.resolve(jsonResponse({ ok: true, n: hangN, sn: 1, state: 'pending' }));
    }
    if (url.indexOf('/api/command-state') === 0) {
      return Promise.resolve(jsonResponse({ ok: true, results: [] }));
    }
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  Net.setLimits({ commandResult: 250, pollMin: 40, pollMax: 40 });
  await Net.create(2, 'E');
  await Net.status();
  t0 = Date.now();
  const noRes = await expectReject(Net.command({ type: 'build', buildingType: 'house', x: 2, y: 2 }),
    'timeout');
  check(noRes.rejected && noRes.kind === 'timeout',
    'отсутствие результата — timeout, а не выдуманный отказ');
  check(!!noRes.error && noRes.error.commandId === noRes.error.n &&
    typeof noRes.error.n === 'number',
    'у таймаута есть commandId: ' + (noRes.error && noRes.error.commandId));
  check(Date.now() - t0 < 2000 && Net.busy().sends === 0 && Net.busy().pump === false,
    'после таймаута busy не залип: ' + JSON.stringify(Net.busy()));

  /* 9. Сервер ответил unknown — промис резолвится, а не reject. */
  await resetNet();
  let unknownN = 0;
  setFetch((url, opts) => {
    if (url === '/api/lobby') {
      return Promise.resolve(jsonResponse({ ok: true, code: 'FFFFF', token: 'tf',
        playerId: 0, hostId: 0, players: [] }));
    }
    if (url.indexOf('/api/status') === 0) {
      return Promise.resolve(jsonResponse({
        ok: true, started: true, start: startPayload(), lobby: lobbyView('FFFFF')
      }));
    }
    if (url === '/api/command') {
      unknownN = JSON.parse(opts.body).command.n;
      return Promise.resolve(jsonResponse({ ok: true, n: unknownN, sn: 1, state: 'pending' }));
    }
    if (url.indexOf('/api/command-state') === 0) {
      if (/[?&]n=/.test(url)) {
        return Promise.resolve(jsonResponse({ ok: true, n: 777, state: 'unknown' }));
      }
      return Promise.resolve(jsonResponse({ ok: true, results: [{
        n: unknownN, state: 'unknown'
      }] }));
    }
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  Net.setLimits({ commandResult: 500, pollMin: 40, pollMax: 80 });
  await Net.create(2, 'F');
  await Net.status();
  const unknown = await Net.command({ type: 'build', buildingType: 'house', x: 3, y: 3 });
  check(unknown.state === 'unknown' && unknown.ok === false && unknown.unknown === true,
    'unknown резолвится как «результат уточняется»: ' + JSON.stringify(unknown));
  const direct = await Net.commandState(777);
  check(direct && direct.state === 'unknown',
    'Net.commandState(n) отдаёт unknown как есть');

  /* 10. Упаковка gzip-снимка висит → жёсткий предел, промис не висит. */
  await resetNet();
  setFetch((url) => {
    if (url === '/api/lobby') {
      return Promise.resolve(jsonResponse({ ok: true, code: 'GGGGG', token: 'tg',
        playerId: 0, hostId: 0, players: [] }));
    }
    if (url.indexOf('/api/status') === 0) {
      return Promise.resolve(jsonResponse({
        ok: true, started: true, start: startPayload(), lobby: lobbyView('GGGGG')
      }));
    }
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  await Net.create(2, 'G');
  await Net.status();
  const realCompression = globalThis.CompressionStream;
  globalThis.CompressionStream = function () {
    return new TransformStream({
      flush() { return new Promise(() => {}); }
    });
  };
  Net.setLimits({ snapshotPack: 60 });
  t0 = Date.now();
  const snapPack = await expectReject(Net.snapshot({ seq: 1 }), 'timeout');
  globalThis.CompressionStream = realCompression;
  check(snapPack.rejected && snapPack.kind === 'timeout' &&
    /упаковк/.test(snapPack.error && snapPack.error.message || ''),
    'зависшая gzip-упаковка снимка — timeout: ' +
    (snapPack.error && snapPack.error.message));
  check(Date.now() - t0 < 1000,
    'предел упаковки снимка сработал за ' + (Date.now() - t0) + ' мс');

  /* 11. Снимок: обрыв/таймаут запроса тоже возвращает ошибку, не висит. */
  Net.setLimits({ snapshot: 80 });
  setFetch(() => Promise.resolve(new Response(new ReadableStream({ start() {} }), {
    status: 200, headers: { 'content-type': 'application/json' }
  })));
  t0 = Date.now();
  const snapHang = await expectReject(Net.snapshot({ seq: 2 }), 'timeout');
  check(snapHang.rejected && snapHang.kind === 'timeout' && Date.now() - t0 < 1500,
    'зависший POST снимка возвращает timeout за ' + (Date.now() - t0) + ' мс');

  /* 12. Поздний ответ снимка старой партии — stale. */
  await resetNet();
  setFetch((url) => {
    if (url === '/api/lobby') {
      return Promise.resolve(jsonResponse({ ok: true, code: 'HHHHH', token: 'th',
        playerId: 0, hostId: 0, players: [] }));
    }
    if (url.indexOf('/api/status') === 0) {
      return Promise.resolve(jsonResponse({
        ok: true, started: true, start: startPayload(), lobby: lobbyView('HHHHH')
      }));
    }
    if (url === '/api/snapshot') return dSnap.promise;
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  await Net.create(2, 'H');
  await Net.status();
  const dSnap = deferred();
  const pSnap = Net.snapshot({ seq: 3 });
  const pSnapCatch = pSnap.catch((e) => e);
  await sleep(10);
  Net.reset();
  dSnap.resolve(jsonResponse({ ok: true, queue: 0 }));
  const snapErr = await pSnapCatch;
  check(!!snapErr && snapErr.kind === 'stale',
    'поздний ответ снимка старой партии отвергнут как stale');

  /* 13. Не хост — snapshot возвращает null, а не ошибку. */
  await resetNet();
  setFetch((url) => {
    if (url === '/api/lobby') {
      return Promise.resolve(jsonResponse({ ok: true, code: 'IIIII', token: 'ti',
        playerId: 5, hostId: 0, players: [] }));
    }
    return Promise.resolve(jsonResponse({ ok: true }));
  });
  await Net.create(2, 'I');
  const guestSnap = await Net.snapshot({ seq: 1 });
  check(guestSnap === null, 'гость не шлёт снимок: snapshot() → null');
}

/* --------------------------------------------------------------------- *
 * Настоящий сервер: ReadJson, команды, история >1000
 * --------------------------------------------------------------------- */
let server = null;
let serverErr = '';
function startServer() {
  server = spawn(process.execPath, [
    path.join(REPO, 'game/server/server.js'),
    '--port', String(PORT), '--local'
  ], { cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'] });
  server.stderr.on('data', (d) => { serverErr += d.toString(); });
}
function killServer() {
  if (!server) return;
  try { server.kill('SIGTERM'); } catch (e) {}
  server = null;
}
function postJSON(url, body, headers) {
  return fetch(BASE + url, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));
}
function getJSON(url) {
  return fetch(BASE + url).then(async (r) => ({ status: r.status, j: await r.json().catch(() => null) }));
}
async function waitServer() {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    try {
      const r = await getJSON('/api/build');
      if (r.status === 200 && r.j && r.j.ok) return r.j;
    } catch (e) { /* ещё поднимается */ }
    await sleep(100);
  }
  return null;
}

async function readJsonTests() {
  console.log('\n-- ReadJson: битый JSON/gzip, обрыв, исключение callback --');

  /* Битый JSON дважды: каждый раз 400, сервер жив, следующий запрос работает. */
  let r = await postJSON('/api/lobby', '{oops');
  check(r.status === 400, 'битый JSON → 400 (первый раз)');
  r = await postJSON('/api/lobby', '{oops');
  check(r.status === 400, 'битый JSON → 400 (второй раз, callback не зовётся с null)');
  let lobby = await postJSON('/api/lobby', { max: 2, name: 'После битого JSON' });
  check(lobby.status === 200 && lobby.j.ok,
    'после битого JSON сервер принимает нормальное лобби');

  /* Битый gzip. */
  r = await postJSON('/api/lobby', Buffer.from('это не gzip'),
    { 'content-encoding': 'gzip' });
  check(r.status === 400 && r.j && /gzip/.test(r.j.reason || ''),
    'битый gzip → 400: ' + (r.j && r.j.reason));
  const lobby2 = await postJSON('/api/lobby', { max: 2, name: 'После битого gzip' });
  check(lobby2.status === 200 && lobby2.j.ok,
    'после битого gzip сервер принимает нормальное лобби');

  /* Обрыв посреди тела: сервер не должен упасть и терять следующие запросы. */
  await new Promise((resolve) => {
    const req = http.request(BASE + '/api/lobby', {
      method: 'POST', headers: { 'content-type': 'application/json' }
    });
    req.on('error', () => resolve());
    req.write('{"max":');
    setTimeout(() => { try { req.destroy(); } catch (e) {} resolve(); }, 30);
  });
  await sleep(150);
  const lobby3 = await postJSON('/api/lobby', { max: 2, name: 'После обрыва' });
  check(lobby3.status === 200 && lobby3.j.ok,
    'обрыв сокета посреди тела не убивает сервер');

  /* Смена лобби: поздний запрос в удалённое лобби не должен трогать новое. */
  const oldLobby = await postJSON('/api/lobby', { max: 2, name: 'Старое' });
  await postJSON('/api/leave', { code: oldLobby.j.code, token: oldLobby.j.token });
  const newLobby = await postJSON('/api/lobby', { max: 2, name: 'Новое' });
  const lateSnap = await postJSON('/api/snapshot', {
    code: oldLobby.j.code, token: oldLobby.j.token,
    snapshot: { seq: 1, t: 1 }
  });
  check(lateSnap.status === 403,
    'поздний снимок в удалённое лобби — 403 (не 200 в новое)');
  const newSnap = await postJSON('/api/snapshot', {
    code: newLobby.j.code, token: newLobby.j.token,
    snapshot: { seq: 1, t: 1 }
  });
  check(newSnap.status === 200 && newSnap.j.ok && !newSnap.j.stale,
    'новое лобби после смены принимает свой снимок');
  await postJSON('/api/leave', { code: newLobby.j.code, token: newLobby.j.token });

  /* Исключение callback: ровно одна 500 на запрос, не повтор с null. */
  const mod = require(path.join(REPO, 'game/server/server.js'));
  let calls = 0;
  const probe = http.createServer((req, res) => {
    mod.readJson(req, res, () => {
      calls++;
      throw new Error('boom в обработчике');
    });
  });
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const probePort = probe.address().port;
  const first = await fetch('http://127.0.0.1:' + probePort, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"x":1}'
  });
  const firstBody = await first.json();
  check(first.status === 500 && calls === 1,
    'исключение callback → 500 один раз (вызовов ' + calls + ')');
  check(firstBody && firstBody.ok === false,
    'тело 500 — JSON с ok:false: ' + JSON.stringify(firstBody));
  const second = await fetch('http://127.0.0.1:' + probePort, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"x":2}'
  });
  await second.text();
  check(second.status === 500 && calls === 2,
    'второй запрос снова 500, callback снова один (вызовов ' + calls + ')');
  await new Promise((resolve) => probe.close(resolve));
}

async function commandTests() {
  console.log('\n-- сервер: ageMs, TTL по своим часам, идемпотентность >1000 --');

  /* Предупреждение о другой версии — только поле: старт не отказывает. */
  const oldClient = await postJSON('/api/lobby', {
    max: 2, name: 'Старый клиент', protocol: 2
  });
  const oldPeer = await postJSON('/api/join', {
    code: oldClient.j.code, name: 'Напарник', protocol: 2
  });
  check(!!oldClient.j.protocolWarning,
    'клиент другой версии получает protocolWarning в лобби: ' +
    oldClient.j.protocolWarning);
  await postJSON('/api/ready', { code: oldClient.j.code, token: oldClient.j.token, ready: true });
  await postJSON('/api/ready', { code: oldClient.j.code, token: oldPeer.j.token, ready: true });
  const oldStart = await postJSON('/api/start', {
    code: oldClient.j.code, token: oldClient.j.token
  });
  check(oldStart.j.ok && oldStart.j.start.protocolWarning &&
    oldStart.j.start.protocol >= 3,
    'старт с другой версией не отказан, предупреждение в пакете: ' +
    JSON.stringify({ ok: oldStart.j.ok, warning: oldStart.j.start.protocolWarning }));
  await postJSON('/api/leave', { code: oldClient.j.code, token: oldPeer.j.token });
  await postJSON('/api/leave', { code: oldClient.j.code, token: oldClient.j.token });
  const host = await postJSON('/api/lobby', { max: 2, name: 'Хост-команд' });
  const guest = await postJSON('/api/join', { code: host.j.code, name: 'Гость-команд' });
  await postJSON('/api/ready', { code: host.j.code, token: host.j.token, ready: true });
  await postJSON('/api/ready', { code: host.j.code, token: guest.j.token, ready: true });
  const started = await postJSON('/api/start', { code: host.j.code, token: host.j.token });
  check(started.j.ok && started.j.start.cmdProto === 2,
    'старт: cmdProto остался 2 (старые клиенты не ломаются)');
  check(started.j.start.protocol >= 3 && !!started.j.start.build,
    'старт несёт protocol/build: ' +
    JSON.stringify({ protocol: started.j.start.protocol, build: started.j.start.build }));

  /* ageMs: команда задерживается на 200 мс и приходит в снимке с возрастом. */
  const firstN = 10000;
  await postJSON('/api/command', {
    code: host.j.code, token: guest.j.token,
    command: { type: 'build', buildingType: 'house', x: 1, y: 1, rot: 0, n: firstN }
  });
  await sleep(200);
  let seq = 1;
  let snap = await postJSON('/api/snapshot', {
    code: host.j.code, token: host.j.token, snapshot: { seq: seq, t: 0.1 }
  });
  let cmds = snap.j.commands || [];
  const firstCmd = cmds.find((c) => c.n === firstN);
  check(!!firstCmd && typeof firstCmd.ageMs === 'number' && firstCmd.ageMs >= 150,
    'сервер кладёт ageMs по своим часам: ' +
    JSON.stringify(firstCmd && { ageMs: firstCmd.ageMs, at: firstCmd.at }));
  check(!!firstCmd && typeof firstCmd.at === 'number',
    'поле at сохранено для совместимости: ' + (firstCmd && firstCmd.at));
  check(snap.j.serverNow > 0 && snap.j.protocol >= 3,
    'ответ снимка несёт serverNow/protocol: ' +
    JSON.stringify({ serverNow: snap.j.serverNow, protocol: snap.j.protocol }));

  /* Подтверждаем первую команду водяным знаком. */
  seq++;
  await postJSON('/api/snapshot', {
    code: host.j.code, token: host.j.token,
    snapshot: { seq: seq, t: 0.2, cmdAck: { [guest.j.playerId]: firstN } }
  });
  let st = await getJSON('/api/command-state?code=' + host.j.code +
    '&token=' + guest.j.token + '&n=' + firstN);
  check(st.j.ok && st.j.state === 'applied',
    'команда подтверждена: ' + JSON.stringify({ state: st.j.state }));

  /* Больше 1000 действий: ответы вытесняются, повтор не выполняется заново. */
  const BATCH = 200;
  const BATCHES = 11;            // 2200 результатов, история ответов = 2000
  let n = 20000;
  const firstOfHistory = n + 1;   // первая команда первой серии
  for (let b = 0; b < BATCHES; b++) {
    const batchN = [];
    for (let i = 0; i < BATCH; i++) {
      n++;
      batchN.push(n);
      const rr = await postJSON('/api/command', {
        code: host.j.code, token: guest.j.token,
        command: { type: 'build', buildingType: 'house', x: 2, y: 2, rot: 0, n: n }
      });
      if (!rr.j || !rr.j.ok) {
        check(false, 'пакет команд: команда ' + n + ' не принята: ' +
          JSON.stringify(rr.j));
        return;
      }
    }
    seq++;
    const delivered = await postJSON('/api/snapshot', {
      code: host.j.code, token: host.j.token,
      snapshot: { seq: seq, t: b + 1 }
    });
    if ((delivered.j.commands || []).length !== BATCH) {
      check(false, 'пакет команд: доставлено ' +
        (delivered.j.commands || []).length + ' из ' + BATCH);
      return;
    }
    seq++;
    await postJSON('/api/snapshot', {
      code: host.j.code, token: host.j.token,
      snapshot: { seq: seq, t: b + 1.5,
        cmdAck: { [guest.j.playerId]: batchN[batchN.length - 1] } }
    });
  }
  check(true, 'через сервер прошло ' + (BATCHES * BATCH) + ' действий (>1000)');

  /* Первая команда истории уже вытеснена из cmdResults (2000 < 2200), но
     повтор обязан распознаться по компактному «надгробию». */
  const dup = await postJSON('/api/command', {
    code: host.j.code, token: guest.j.token,
    command: { type: 'build', buildingType: 'house', x: 2, y: 2, rot: 0, n: firstOfHistory }
  });
  check(dup.j.ok && dup.j.duplicate === true && dup.j.state === 'applied',
    'повтор команды после >1000 действий — duplicate applied: ' +
    JSON.stringify({ duplicate: dup.j.duplicate, state: dup.j.state,
      compact: dup.j.compact }));
  seq++;
  const afterDup = await postJSON('/api/snapshot', {
    code: host.j.code, token: host.j.token,
    snapshot: { seq: seq, t: BATCHES + 1 }
  });
  check((afterDup.j.commands || []).length === 0,
    'повтор не попал в очередь хоста (commands=0)');

  /* UX-01: ids/appliedSeq сохраняются в результате и отдаются обратно. */
  const uxN = 99000;
  await postJSON('/api/command', {
    code: host.j.code, token: guest.j.token,
    command: { type: 'buildLine', buildingType: 'house', variant: 'a',
      rot: 0, x: 5, y: 5, x2: 8, y: 5, n: uxN }
  });
  seq++;
  await postJSON('/api/snapshot', {
    code: host.j.code, token: host.j.token,
    snapshot: { seq: seq, t: BATCHES + 2, cmdDone: [{
      from: guest.j.playerId, n: uxN, state: 'applied', reason: '',
      ids: ['p1:b900', 'p1:b901'], appliedSeq: 4242
    }] }
  });
  st = await getJSON('/api/command-state?code=' + host.j.code +
    '&token=' + guest.j.token + '&n=' + uxN);
  check(st.j.ok && st.j.state === 'applied' &&
    Array.isArray(st.j.ids) && st.j.ids.length === 2 &&
    st.j.appliedSeq === 4242,
    'ids/appliedSeq не выброшены сервером: ' +
    JSON.stringify({ ids: st.j.ids, appliedSeq: st.j.appliedSeq }));

  /* F5/возврат: /api/resume отдаёт последний снимок и seq, а устаревший
     снимок после возврата не перезаписывает мир. */
  const resumed = await getJSON('/api/resume?code=' + host.j.code +
    '&token=' + host.j.token);
  check(resumed.status === 200 && resumed.j.ok && resumed.j.started &&
    resumed.j.snapshot && resumed.j.snapshot.seq === seq,
    'GET /api/resume отдаёт lastSnapshot с seq=' + seq + ': ' +
    JSON.stringify(resumed.j.snapshot && { seq: resumed.j.snapshot.seq }));
  check(resumed.j.seq === seq && resumed.j.protocol >= 3,
    '/api/resume отдаёт seq и protocol: ' +
    JSON.stringify({ seq: resumed.j.seq, protocol: resumed.j.protocol }));
  seq++;
  const staleAfterResume = await postJSON('/api/snapshot', {
    code: host.j.code, token: host.j.token,
    snapshot: { seq: seq - 2, t: BATCHES + 3 }
  });
  check(staleAfterResume.j.ok && staleAfterResume.j.stale === true,
    'устаревший снимок после возврата помечен stale');
  const freshAfterResume = await postJSON('/api/snapshot', {
    code: host.j.code, token: host.j.token,
    snapshot: { seq: seq, t: BATCHES + 3 }
  });
  check(freshAfterResume.j.ok && !freshAfterResume.j.stale,
    'следующий снимок после возврата принимается');

  /* Диагностика хоста: pending/coalesced в потоках и protocol. */
  const diag = await getJSON('/api/diag?code=' + host.j.code + '&token=' + host.j.token);
  check(diag.status === 200 && diag.j.ok && diag.j.protocol >= 3 &&
    diag.j.lobby && Array.isArray(diag.j.lobby.streams),
    '/api/diag доступен хосту и несёт protocol/streams');
  const guestDiag = await getJSON('/api/diag?code=' + host.j.code + '&token=' + guest.j.token);
  check(guestDiag.status === 403, 'гостю /api/diag закрыт (403)');

  await postJSON('/api/leave', { code: host.j.code, token: guest.j.token });
  await postJSON('/api/leave', { code: host.j.code, token: host.j.token });
}

async function main() {
  console.log('http.js — NET-02 и серверная часть §7');
  await clientTests();

  /* Стабы нужны были только net.js. Настоящему серверу — настоящий fetch,
     иначе его ответы подменялись бы тестовой заглушкой. */
  globalThis.fetch = realFetch;
  fetchImpl = realFetch;

  startServer();
  const build = await waitServer();
  if (!build) {
    notRun('сервер не поднялся: ' + (serverErr || 'нет /api/build за 8 с'));
    killServer();
    finish();
    return;
  }
  await readJsonTests();
  await commandTests();
  killServer();
  finish();
}

function finish() {
  console.log('\nИТОГ: ok ' + ok + ', FAIL ' + fail + ', NOT RUN ' + notrun);
  if (fail) process.exitCode = 1;
  /* Стабы EventSource/PerformanceObserver не должны держать процесс. */
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
}
process.on('SIGINT', () => { killServer(); process.exit(130); });
main().catch((e) => {
  console.error('НЕОЖИДАННАЯ ОШИБКА: ' + (e && e.stack || e));
  killServer();
  process.exit(1);
});
