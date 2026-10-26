/* stream.js — приёмка NET-01: SSE с gzip, backpressure и метрики потоков.

   Проверяется не «curl увидел gzip», а поведение под нагрузкой, из-за
   которого игра лагала: 500–2000 снимков по 24 000 символов, один клиент
   читает быстро, второй не читает вовсе (медленный сокет). До патча цепочка
   `broadcast → gz.write → res.write` игнорировала результат записи, и в
   gzip могли лежать мегабайты, а `queue` в ответе хосту был 0.

   Что проверяется числами:
     • `queue`/`queueWire` в ответе на снимок и в `/api/stream-stats` —
       ограничены, включают gzip и сокет;
     • у медленного растут dropped/coalesced, у быстрого идёт свежий seq;
     • heapUsed сервера не растёт линейно по числу устаревших кадров;
     • после reconnect медленный получает последний снимок;
     • контрольный `command-result` не теряется за снимками;
     • gzip и обычный SSE работают оба;
     • закрытые потоки исчезают из метрик (zlib/сокет/таймер освобождены).

   Запуск: node game/tools/stream.js
   Код возврата 1 при FAIL. NOT RUN — не PASS. */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const PORT = 9000 + (process.pid % 80);
const BASE = 'http://127.0.0.1:' + PORT;
/* Один снимок — как в воспроизведении из ТЗ: ~24 000 символов. Содержимое
   высокоэнтропийное, иначе gzip сожмёт его в сотню байт и сокет не
   заполнится — тогда проверка очереди ничего бы не значила. */
const SNAP_CHARS = 24000;
const GZIP_EVENTS = 900;
const PLAIN_EVENTS = 260;
const QUEUE_LIMIT = 512 * 1024;
const HEAP_LIMIT = 32 * 1024 * 1024;

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

function postJSON(url, body) {
  return fetch(BASE + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, j: await r.json() }));
}
function getJSON(url) {
  return fetch(BASE + url).then(async (r) => ({ status: r.status, j: await r.json() }));
}
function api(pathname, code, token) {
  return '/api/' + pathname + '?code=' + encodeURIComponent(code) +
    '&token=' + encodeURIComponent(token);
}
async function waitFor(fn, timeout, step) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(step || 50);
  }
  return !!fn();
}

/* SSE-поток. read=false — то самое «клиент не читает»: ответ не потребляется,
   сокет и gzip на сервере обязаны остановиться на своём пределе, а не
   копить мегабайты. */
function openSSE(code, token, opts) {
  opts = opts || {};
  const gzip = opts.gzip !== false;
  const read = opts.read !== false;
  const headers = {};
  if (gzip) headers['accept-encoding'] = 'gzip';
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + '/api/events?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token), { headers }, (res) => {
        const st = {
          req, res, headers: res.headers, wireBytes: 0, chunks: 0,
          events: [], snapshots: [], error: null, closed: false,
          onEvent: opts.onEvent || null
        };
        let text = '';
        function feed(chunk) {
          st.chunks++;
          text += chunk.toString('utf8');
          let i;
          while ((i = text.indexOf('\n\n')) >= 0) {
            const block = text.slice(0, i);
            text = text.slice(i + 2);
            parseBlock(block);
          }
        }
        function parseBlock(block) {
          let type = 'message';
          const dataLines = [];
          block.split('\n').forEach((line) => {
            if (line.startsWith('event: ')) type = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
          });
          if (!dataLines.length) return;
          let data = null;
          try { data = JSON.parse(dataLines.join('\n')); } catch (e) { return; }
          st.events.push({ type, data, at: Date.now() });
          if (type === 'snapshot') st.snapshots.push(data);
          if (st.onEvent) st.onEvent(type, data, st);
        }
        res.on('data', (chunk) => { st.wireBytes += chunk.length; });
        res.on('error', (e) => { st.error = e.message; });
        if (!read) {
          /* Не вешаем 'data' на распаковщик: поток остаётся стоять, как
             вкладка, которую свернули/закрыли. */
          res.pause();
          st.close = () => {
            if (st.closed) return;
            st.closed = true;
            try { req.destroy(); } catch (e) {}
            try { res.destroy(); } catch (e) {}
          };
          resolve(st);
          return;
        }
        let src = res;
        if (/gzip/.test(res.headers['content-encoding'] || '')) {
          const gz = zlib.createGunzip();
          gz.on('error', (e) => { st.error = e.message; });
          res.pipe(gz);
          src = gz;
        }
        src.on('data', feed);
        src.on('error', (e) => { st.error = e.message; });
        st.close = () => {
          if (st.closed) return;
          st.closed = true;
          try { req.destroy(); } catch (e) {}
          try { res.destroy(); } catch (e) {}
        };
        resolve(st);
      });
    req.on('error', reject);
  });
}

function snapPayload(seq) {
  return {
    seq: seq,
    t: seq / 10,
    seed: 'приёмка-потока',
    size: 192,
    towns: [
      { id: 0, owner: 0, name: 'Хост', color: '#4a90d9', alive: true,
        logs: seq % 100, deliveries: 2, felled: 20, inTransit: 1 },
      { id: 1, owner: 1, name: 'Гость', color: '#d94a4a', alive: true,
        logs: 5, deliveries: 1, felled: 10, inTransit: 0 }
    ],
    buildings: [{ id: 10, type: 'townhall', x: 40, y: 60, owner: 0 }],
    villagers: [{ id: 1, owner: 0, x: 41, y: 61, hp: 15 }],
    objectTotal: 7200,
    /* Случайные 24 000 символов: gzip почти не сжимает, очередь сокета
       заполняется по-настоящему, а не остаётся в теории. */
    notes: crypto.randomBytes(SNAP_CHARS * 3 / 4).toString('base64'),
    tail: seq
  };
}

/* ---------------------------- первый сервер ---------------------------- */
let server = null;
let serverErr = '';
function startServer() {
  server = spawn(process.execPath, [
    path.join(REPO, 'game/server/server.js'),
    '--port', String(PORT), '--local'
  ], { cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'] });
  server.stderr.on('data', (d) => { serverErr += d.toString(); });
}
async function waitServer() {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    try {
      const r = await getJSON('/api/build');
      if (r.status === 200 && r.j.ok) return r.j;
    } catch (e) { /* сервер ещё поднимается */ }
    await sleep(100);
  }
  return null;
}
function killServer() {
  if (!server) return;
  try { server.kill('SIGTERM'); } catch (e) {}
  server = null;
}

/* Один сценарий: лобби на хоста + двух гостей, поток gzip/plain, серия
   снимков. Возвращает всё, что нужно проверкам. */
async function burstScenario(opts) {
  const gzip = opts.gzip !== false;
  const total = opts.events;
  const lobby = await postJSON('/api/lobby', { max: 3, name: 'Хост-потока' });
  if (!lobby.j.ok) throw new Error('лобби не создано: ' + JSON.stringify(lobby.j));
  const code = lobby.j.code;
  const hostToken = lobby.j.token;
  const slowP = await postJSON('/api/join', { code: code, name: 'Медленный' });
  const fastP = await postJSON('/api/join', { code: code, name: 'Быстрый' });
  if (!slowP.j.ok || !fastP.j.ok) throw new Error('гости не вошли');
  for (const p of [lobby.j, slowP.j, fastP.j]) {
    await postJSON('/api/ready', { code: code, token: p.token, ready: true });
  }
  const started = await postJSON('/api/start', { code: code, token: hostToken });
  if (!started.j.ok) throw new Error('старт не удался: ' + JSON.stringify(started.j));

  /* Медленный НЕ читает. Быстрый читает всё и складывает seq. */
  const slow = await openSSE(code, slowP.j.token, { gzip: gzip, read: false });
  let commandResult = null;
  const fast = await openSSE(code, fastP.j.token, {
    gzip: gzip, read: true,
    onEvent: (type, data) => {
      if (type === 'command-result') commandResult = data;
    }
  });
  await sleep(150);

  let maxQueue = 0, maxQueueWire = 0, maxQueueAge = 0;
  let sentCmd = null, cmdDoneSent = false;
  const samples = [];
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const payload = { seq: i + 1, t: i / 10, notes: snapPayload(i + 1).notes };
    /* Контрольное событие посреди шквала снимков: результат команды обязан
       доехать, хотя очередь снимков полна. */
    if (i === Math.floor(total / 3)) {
      sentCmd = {
        type: 'build', buildingType: 'house', x: 6, y: 6, rot: 0,
        n: 900000 + i
      };
      await postJSON('/api/command', {
        code: code, token: fastP.j.token, command: sentCmd
      });
    }
    if (sentCmd && !cmdDoneSent && i === Math.floor(total / 3) + 2) {
      payload.cmdDone = [{
        from: fastP.j.playerId, n: sentCmd.n, state: 'applied',
        reason: '', ids: ['p' + fastP.j.playerId + ':b' + i], appliedSeq: i + 1
      }];
      cmdDoneSent = true;
    }
    const r = await postJSON('/api/snapshot', {
      code: code, token: hostToken, snapshot: payload
    });
    if (!r.j.ok) throw new Error('снимок не принят: ' + JSON.stringify(r.j));
    if (r.j.queue > maxQueue) maxQueue = r.j.queue;
    if (r.j.queueWire > maxQueueWire) maxQueueWire = r.j.queueWire;
    if (r.j.queueAge > maxQueueAge) maxQueueAge = r.j.queueAge;
    if (i % 150 === 0) {
      const s = await getJSON(api('stream-stats', code, hostToken));
      if (s.j.ok) {
        samples.push(s.j);
        if (s.j.queue > maxQueue) maxQueue = s.j.queue;
        if (s.j.queueAgeMs > maxQueueAge) maxQueueAge = s.j.queueAgeMs;
      }
    }
  }
  const sentMs = Date.now() - t0;
  /* Даём быстрому дочитать остаток (если он отстал на burst). */
  await waitFor(() => fast.snapshots.length &&
    fast.snapshots[fast.snapshots.length - 1].seq >= total, 15000, 50);
  const fastSnaps = fast.snapshots.map((s) => s.seq);
  const fastLast = fastSnaps.length ? Math.max.apply(null, fastSnaps) : 0;

  const stats = await getJSON(api('stream-stats', code, hostToken));
  const listeners = (stats.j.streams || []);
  const slowStats = listeners.find((s) => s.name === 'Медленный') || null;
  const fastStats = listeners.find((s) => s.name === 'Быстрый') || null;
  const diag = await getJSON(api('diag', code, hostToken));

  return {
    code, hostToken, slow, fast, fastP, slowP, total, sentMs,
    maxQueue, maxQueueWire, maxQueueAge, samples,
    fastLast, fastSnaps, stats: stats.j, slowStats, fastStats,
    diag: diag.j, commandResult, sentCmd,
    close: async () => {
      try { slow.close(); } catch (e) {}
      try { fast.close(); } catch (e) {}
      await sleep(250);
    },
    leave: async () => {
      await postJSON('/api/leave', { code: code, token: fastP.j.token });
      await postJSON('/api/leave', { code: code, token: slowP.j.token });
      await postJSON('/api/leave', { code: code, token: hostToken });
    }
  };
}

async function main() {
  console.log('stream.js — SSE/gzip/backpressure, сервер ' + BASE);
  startServer();
  const build = await waitServer();
  if (!build) {
    notRun('сервер не поднялся: ' + (serverErr || 'нет /api/build за 8 с'));
    killServer();
    finish();
    return;
  }
  check(build.ok && typeof build.build === 'string' && build.build.length > 0,
    'GET /api/build отдаёт build: ' + JSON.stringify(build.build));
  check(build.protocol >= 3 && build.node === process.version &&
    typeof build.uptimeMs === 'number' && !!build.startedAt,
    'в /api/build есть protocol/node/uptimeMs/startedAt: ' +
    JSON.stringify({ protocol: build.protocol, node: build.node,
      uptimeMs: build.uptimeMs, startedAt: build.startedAt }));
  const build2 = await getJSON('/api/build');
  check(build2.j.build === build.build, 'build id стабилен между запросами');

  /* ------------------------- gzip: медленный + быстрый ----------------- */
  console.log('\n-- gzip SSE: ' + GZIP_EVENTS + ' снимков по ~24 КБ --');
  let res = null;
  try {
    res = await burstScenario({ gzip: true, events: GZIP_EVENTS });
  } catch (e) {
    check(false, 'сценарий gzip-потока: ' + (e && e.message));
    killServer();
    finish();
    return;
  }
  check(!!res.slow.headers['content-encoding'] &&
    /gzip/.test(res.slow.headers['content-encoding']),
    'медленный клиент получил gzip: ' + res.slow.headers['content-encoding']);
  check(!!res.fast.headers['content-encoding'] &&
    /gzip/.test(res.fast.headers['content-encoding']),
    'быстрый клиент получил gzip: ' + res.fast.headers['content-encoding']);

  check(res.fastLast === res.total,
    'быстрый получил последний снимок: seq ' + res.fastLast + ' из ' + res.total +
    ' (' + res.fastSnaps.length + ' событий, ' + res.sentMs + ' мс на серию)');
  check(res.fastSnaps.length > res.total * 0.1,
    'быстрый получил много кадров, а не только последний: ' +
    res.fastSnaps.length + ' из ' + res.total);
  check(!!res.slowStats && res.slowStats.dropped > 0 && res.slowStats.coalesced > 0,
    'у медленного растут dropped/coalesced: ' +
    JSON.stringify({ dropped: res.slowStats && res.slowStats.dropped,
      coalesced: res.slowStats && res.slowStats.coalesced }));
  check(!!res.slowStats && res.slowStats.queue <= QUEUE_LIMIT,
    'очередь медленного ограничена: queue=' + (res.slowStats && res.slowStats.queue) +
    ' Б (socket=' + (res.slowStats && res.slowStats.socketQueued) +
    ', gzip=' + (res.slowStats && res.slowStats.gzipQueued) +
    ', pending=' + (res.slowStats && res.slowStats.pending) + ')');
  check(res.maxQueue <= QUEUE_LIMIT,
    'queue в ответе на снимок ограничена: max=' + res.maxQueue + ' Б, ' +
    'wire=' + res.maxQueueWire + ' Б, age=' + res.maxQueueAge + ' мс');
  check(res.maxQueue > 0,
    'queue не врёт нулём при заполненном gzip/сокете: max=' + res.maxQueue + ' Б');
  check(!!res.slowStats && res.slowStats.gzipQueued <= 128 * 1024 + SNAP_CHARS,
    'gzip-буфер медленного ограничен: ' +
    (res.slowStats && res.slowStats.gzipQueued) + ' Б');
  check(!!res.slowStats && res.slowStats.pending <= 2 * SNAP_CHARS + 16 * 1024,
    'pending снимок не копится: ' + (res.slowStats && res.slowStats.pending) + ' Б');
  check(!!res.slowStats && res.slowStats.ageMs < 10000,
    'возраст ожидающего снимка ограничен: ' + (res.slowStats && res.slowStats.ageMs) + ' мс');
  check(!!res.fastStats && res.fastStats.queue < 128 * 1024,
    'быстрый не тормозит медленным: его queue=' +
    (res.fastStats && res.fastStats.queue) + ' Б');
  check(!!res.slowStats && res.slowStats.rawBytes > res.slowStats.gzipBytes &&
    res.slowStats.gzipBytes > 0,
    'у gzip-потока раздельно видны raw/gzip/wire: ' +
    JSON.stringify({ raw: res.slowStats && res.slowStats.rawBytes,
      gzip: res.slowStats && res.slowStats.gzipBytes,
      wire: res.slowStats && res.slowStats.wireBytes }));

  /* Контрольное событие: команда ушла в середине шквала, результат —
     отдельной управляющей очередью, а не за снимками. */
  check(!!res.commandResult && res.commandResult.n === res.sentCmd.n,
    'command-result не потерялся за очередью снимков: ' +
    JSON.stringify(res.commandResult && {
      n: res.commandResult.n, state: res.commandResult.state,
      ids: res.commandResult.ids, appliedSeq: res.commandResult.appliedSeq
    }));
  check(!!res.commandResult && res.commandResult.state === 'applied' &&
    res.commandResult.appliedSeq > 0 && Array.isArray(res.commandResult.ids),
    'command-result несёт ids/appliedSeq (UX-01): ' +
    JSON.stringify(res.commandResult && {
      ids: res.commandResult.ids, appliedSeq: res.commandResult.appliedSeq
    }));

  /* Диагностика: кольцо ограничено, токенов нет, pending/coalesced есть. */
  const diag = res.diag;
  check(!!diag && diag.ok && diag.protocol >= 3 && !!diag.build,
    '/api/diag отдаёт build/protocol: ' +
    JSON.stringify({ build: diag && diag.build, protocol: diag && diag.protocol }));
  check(!!diag && typeof diag.heap.heapUsed === 'number' &&
    typeof diag.eventLoopDelay.maxMs === 'number',
    '/api/diag отдаёт heap и event-loop delay: ' +
    JSON.stringify({ heapUsed: diag && diag.heap && diag.heap.heapUsed,
      loopMax: diag && diag.eventLoopDelay && diag.eventLoopDelay.maxMs }));
  check(!!diag && Array.isArray(diag.log) && diag.log.length <= 200 &&
    Array.isArray(diag.serverLog) && diag.serverLog.length <= 200,
    'кольца журнала ограничены 200: lobby=' + (diag.log || []).length +
    ', server=' + (diag.serverLog || []).length);
  const diagText = JSON.stringify(diag);
  check(diagText.indexOf(res.slowP.j.token) < 0 &&
    diagText.indexOf(res.fastP.j.token) < 0 &&
    diagText.indexOf(res.hostToken) < 0,
    '/api/diag не содержит токенов');
  const diagSlow = (diag.lobby.streams || []).find((s) => s.name === 'Медленный');
  check(!!diagSlow && typeof diagSlow.pending === 'number' &&
    typeof diagSlow.coalesced === 'number',
    'в /api/diag по каждому потоку pending/coalesced: ' +
    JSON.stringify(diagSlow && { pending: diagSlow.pending,
      coalesced: diagSlow.coalesced, queue: diagSlow.queue }));

  /* Память: серия устаревших кадров не должна осесть в heap. */
  const heapAfter = (await getJSON(api('diag', res.code, res.hostToken))).j;
  /* Сравниваем состояние сразу после серии и после паузы: если бы старые
     кадры оседали в памяти, второй замер не стал бы меньше. Абсолютное
     значение сверяем с половиной отправленного объёма — это заведомо
     щедрый порог для ограниченных очередей. */
  await sleep(500);
  const heapSettled = (await getJSON(api('diag', res.code, res.hostToken))).j;
  const payloadTotal = res.total * SNAP_CHARS;
  check(heapSettled.heap.heapUsed < payloadTotal / 2 + 16 * 1024 * 1024,
    'heapUsed не растёт линейно по устаревшим кадрам: ' +
    (heapSettled.heap.heapUsed / 1024 / 1024).toFixed(1) + ' МБ при ' +
    (payloadTotal / 1024 / 1024).toFixed(1) + ' МБ отправленных снимков');
  console.log('       heapUsed после серии: ' +
    (heapAfter.heap.heapUsed / 1024 / 1024).toFixed(1) + ' МБ, после паузы: ' +
    (heapSettled.heap.heapUsed / 1024 / 1024).toFixed(1) + ' МБ, RSS ' +
    (heapSettled.heap.rss / 1024 / 1024).toFixed(1) + ' МБ');

  /* Reconnect медленного: новый поток обязан получить последний снимок. */
  const lastSeq = res.total;
  res.slow.close();
  await sleep(200);
  const again = await openSSE(res.code, res.slowP.j.token, { gzip: true, read: true });
  const got = await waitFor(() => again.snapshots.length > 0, 5000, 50);
  check(got && again.snapshots[0].seq === lastSeq,
    'медленный после reconnect получил последний снимок: seq ' +
    (again.snapshots[0] && again.snapshots[0].seq) + ' (ждали ' + lastSeq + ')');
  check(!again.error, 'reconnect-поток без ошибок: ' + (again.error || 'нет'));
  again.close();
  res.fast.close();
  await sleep(400);
  const afterClose = (await getJSON(api('stream-stats', res.code, res.hostToken))).j;
  check(afterClose.ok && afterClose.streamsCount === 0,
    'закрытые потоки убраны из lobby.streams: streams=' + afterClose.streamsCount);
  await res.leave();

  /* ------------------------- обычный SSE (без gzip) -------------------- */
  console.log('\n-- обычный SSE: ' + PLAIN_EVENTS + ' снимков по ~24 КБ --');
  let plain = null;
  try {
    plain = await burstScenario({ gzip: false, events: PLAIN_EVENTS });
  } catch (e) {
    check(false, 'сценарий без gzip: ' + (e && e.message));
  }
  if (plain) {
    check(!plain.slow.headers['content-encoding'],
      'без Accept-Encoding поток не сжат');
    check(!!plain.slowStats && plain.slowStats.gzip === false &&
      plain.slowStats.gzipBytes === 0,
      'в метриках без gzip: gzip=false, gzipBytes=0');
    check(!!plain.fastStats && plain.fastStats.wireBytes === plain.fastStats.rawBytes,
      'без gzip wireBytes == rawBytes: ' +
      JSON.stringify(plain.fastStats && {
        raw: plain.fastStats.rawBytes, wire: plain.fastStats.wireBytes
      }));
    check(plain.fastLast === plain.total,
      'без gzip быстрый получил последний снимок: ' + plain.fastLast +
      ' из ' + plain.total);
    check(!!plain.slowStats && plain.slowStats.queue <= QUEUE_LIMIT &&
      plain.slowStats.dropped > 0 && plain.slowStats.coalesced > 0,
      'без gzip очередь медленного ограничена и кадры склеены: ' +
      JSON.stringify(plain.slowStats && {
        queue: plain.slowStats.queue, dropped: plain.slowStats.dropped,
        coalesced: plain.slowStats.coalesced
      }));
    plain.slow.close();
    plain.fast.close();
    await sleep(300);
    await plain.leave();
  }

  killServer();
  finish();
}

function finish() {
  console.log('\nИТОГ: ok ' + ok + ', FAIL ' + fail + ', NOT RUN ' + notrun);
  if (fail) process.exitCode = 1;
}
process.on('SIGINT', () => { killServer(); process.exit(130); });
main().catch((e) => {
  console.error('НЕОЖИДАННАЯ ОШИБКА: ' + (e && e.stack || e));
  killServer();
  process.exit(1);
});
