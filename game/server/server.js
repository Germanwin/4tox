/* server.js — локальный сервер мультиплеера: статика, лобби и релей.

   Почему свой сервер, а не python3 -m http.server. Игре нужны:
     1) раздача репозитория (game/ + mapgen2/) по http;
     2) лобби 2–4 человек с «готов»;
     3) релей снапшотов и команд между браузерами.

   Зависимостей нет: только node:http. Вниз — SSE (text/event-stream), вверх —
   обычный POST. Для 4 игроков на локальной сети этого хватает, а ставить ws
   ради одного канала — лишняя зависимость.

   Сеть: по умолчанию сервер слушает 0.0.0.0, то есть доступен по IP этой
   машины — друзьям достаточно ссылки `http://<ваш IP>:8787/game/`. Но у
   домашнего интернета часто нет входящего публичного адреса (CGNAT), поэтому
   сервер сам проверяет сеть через UPnP: пробует пробросить порт и прямо
   говорит, если провайдер держит за общим NAT. Тогда остаются Hamachi/VPN
   (настоящий IP, друг должен быть в той же сети) или HTTPS-туннель pinggy
   (`--tunnel`). cloudflared для туннеля не годится: он буферизует SSE, и
   события «кто готов» / «старт» до браузеров не доезжают.

   Авторитет — у ХОСТА (браузер создателя лобби): он считает мир и присылает
   снапшоты. Сервер не симулирует и не может «зачитерить» состояние; его дело —
   честно раздать, кто в лобби, и не пустить чужого без токена.

   Транспорт лобби нарочно ДВУХКАНАЛЬНЫЙ:
     • SSE  — мгновенные события (кто вошёл, кто готов, старт);
     • POST /api/status — опрос раз в полторы секунды.
   Если SSE порвался (спящий ноутбук, злой Wi-Fi), старт всё равно доедет
   опросом: «оба нажали готов — игра не началась» больше не воспроизводится.

   Запуск:
     node game/server/server.js              # 0.0.0.0:8787, ссылки по IP
     node game/server/server.js --tunnel     # + HTTPS-ссылка через pinggy
     node game/server/server.js --local      # только 127.0.0.1 (для одного)
     node game/server/server.js --no-upnp    # не трогать роутер
     node game/server/server.js --open       # открыть браузер
     node game/server/server.js --port 8787
   Порт: --port 8787. */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');
const { Worker } = require('worker_threads');
const UPnP = require('./upnp');
const Tunnel = require('./tunnel');

const ROOT = path.resolve(__dirname, '..', '..');
/* Сетевые числа сервера и клиента — одна таблица. Протокол 4: мир считает
   worker комнаты, браузерный хост больше не публикует снимки. */
const NET = require(path.join(ROOT, 'game', 'shared', 'net-config.js'));
const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf('--' + name);
  return i < 0 ? def : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
}
const PORT = parseInt(opt('port', '8787'), 10);
const LOCAL = !!opt('local', false);
const OPEN = !!opt('open', false);
const TUNNEL = !!opt('tunnel', false);
const NO_UPNP = !!opt('no-upnp', false);
/* Адрес, по которому сервер виден снаружи, когда перед ним стоит reverse
   proxy (Caddy/nginx). Без него лобби считает, что порт наружу не проброшен,
   и показывает предупреждение, хотя HTTPS-ссылка уже работает. */
const PUBLIC_URL_OPT = opt('public-url', null);
const PUBLIC_URL = typeof PUBLIC_URL_OPT === 'string' && PUBLIC_URL_OPT
  ? PUBLIC_URL_OPT : null;
/* --lan остаётся синонимом поведения по умолчанию: старые лаунчеры и
   привычки не должны ломаться. */
/* --host нужен VPS: игра слушает только 127.0.0.1, а наружу её отдаёт Caddy.
   Без него пришлось бы открывать порт Node в интернет. */
const HOST_OPT = opt('host', null);
const HOST = typeof HOST_OPT === 'string' && HOST_OPT
  ? HOST_OPT : (LOCAL ? '127.0.0.1' : '0.0.0.0');

/* ---- сборка и протокол (OBS-01) --------------------------------------- *
 *
 * По этим числам координатор и приёмка понимают, ЧТО запущено и совместимо
 * ли оно: `build` — короткий git-хеш (без git — 'dev'), `protocol` — номер
 * формата. `cmdProto` в стартовом пакете остаётся 2: контракт команд
 * (sn, cmdDone, /api/command-state) не менялся, новые поля только добавлены
 * (ageMs). Поэтому старый клиент не ломается, а новый видит номер протокола
 * в /api/build и в старте. */
const PROTOCOL = NET.protocol;
const CMD_PROTO = NET.commandProtocol;
const STARTED_AT_MS = Date.now();
let buildCache = null;
/* Сборка — не только git. На проде (/opt/4tox) репозитория нет: файлы
   копируются, и `git rev-parse` вернул бы 'dev', то есть «неизвестно, что
   запущено». Поэтому порядок такой:
     1) BUILD_ID / GIT_COMMIT из окружения (systemd может передать);
     2) файл COMMIT в корне — его пишет выкладка ровно тем хешем, который
        собран и проверен;
     3) git (рабочая копия разработчика);
     4) 'dev'.
   Число нужно одно и правдивое: по нему `/api/build` и старт говорят, что
   реально работает на VPS. */
function buildId() {
  if (buildCache) return buildCache;
  const env = process.env.BUILD_ID || process.env.GIT_COMMIT;
  if (env && String(env).trim()) {
    buildCache = String(env).trim().slice(0, 16);
    return buildCache;
  }
  try {
    const fromFile = fs.readFileSync(path.join(ROOT, 'COMMIT'), 'utf8').trim();
    if (fromFile) {
      buildCache = fromFile.slice(0, 16);
      return buildCache;
    }
  } catch (e) { /* файла нет — обычная рабочая копия */ }
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT, encoding: 'utf8', timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    buildCache = String(out || '').trim().slice(0, 16) || 'dev';
  } catch (e) {
    buildCache = 'dev';
  }
  return buildCache;
}
function buildInfo() {
  return {
    ok: true, build: buildId(), protocol: PROTOCOL,
    cmdProto: CMD_PROTO,
    node: process.version, pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    startedAt: new Date(STARTED_AT_MS).toISOString()
  };
}
function memInfo() {
  const m = process.memoryUsage();
  return {
    heapUsed: m.heapUsed, heapTotal: m.heapTotal,
    rss: m.rss, external: m.external
  };
}

/* ------------------------------ движок -------------------------------- *
 * worldgen нужен, чтобы выбрать сид, на котором есть n площадок под деревни.
 * Модули — те же IIFE, что в браузере; грузим их в общий контекст. */
function loadWorldGen() {
  const files = ['noise.js', 'rng.js', 'worldgen.js'];
  for (const f of files) {
    const code = fs.readFileSync(path.join(ROOT, 'mapgen2', 'js', f), 'utf8');
    new Function(code + '\n//# sourceURL=' + f)();
  }
  return globalThis.WorldGen;
}
const WG = loadWorldGen();

function randomSeed() {
  const words = ['тихая', 'зелёная', 'дальняя', 'вольная', 'каменная', 'мшистая'];
  const nouns = ['пойма', 'согра', 'грива', 'долина', 'заводь', 'плёс'];
  return words[Math.floor(Math.random() * words.length)] + '-' +
    nouns[Math.floor(Math.random() * nouns.length)] + '-' +
    Math.floor(100 + Math.random() * 900);
}

/* ------------------------------- адреса ------------------------------- *
 * Клиенту нельзя доверять `location.origin`: хост открывает страницу по
 * 127.0.0.1, и такая ссылка у друга ведёт на компьютер друга. Поэтому адреса
 * считает сервер и отдаёт их через GET /api/server.
 *
 * Адреса бывают трёх пород, и путать их нельзя:
 *   • «эта сеть» — Wi-Fi/Ethernet, работает только у друга в той же сети;
 *   • «VPN» — Hamachi/Radmin/Tailscale: друг должен быть в той же виртуальной
 *     сети, зато это настоящий IP и CGNAT ему не мешает;
 *   • «через интернет» — публичный IP. Работает только если провайдер даёт
 *     входящие соединения и порт проброшен; при CGNAT не работает вообще. */
const findKind = function (name, ip) {
  if (/^25\./.test(ip)) {
    return { kind: 'hamachi', label: 'Hamachi (друг должен быть в сети Hamachi)' };
  }
  if (/^26\./.test(ip)) {
    return { kind: 'hamachi', label: 'Radmin VPN (друг должен быть в сети Radmin)' };
  }
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) {
    return { kind: 'vpn', label: 'Tailscale/VPN (друг должен быть в этой сети)' };
  }
  if (/^(utun|tun|ipsec|ppp)/.test(name)) {
    return { kind: 'vpn', label: 'VPN (друг должен быть в этой сети)' };
  }
  if (/^(en|eth|wlan|wl)/.test(name)) {
    return { kind: 'lan', label: 'эта сеть (Wi-Fi/Ethernet)' };
  }
  return { kind: 'lan', label: 'эта сеть' };
};

function lanAddresses() {
  const nets = os.networkInterfaces();
  const list = [];
  Object.keys(nets).forEach(function (name) {
    (nets[name] || []).forEach(function (n) {
      if (n.family === 'IPv4' && !n.internal) {
        list.push({ address: n.address, iface: name });
      }
    });
  });
  /* Сначала обычные домашние сети, потом виртуальные (Hamachi/VPN). */
  function rank(a) {
    if (/^192\.168\./.test(a.address)) return 0;
    if (/^10\./.test(a.address)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) return 2;
    if (/^169\.254\./.test(a.address)) return 9;
    return 3;
  }
  list.sort(function (a, b) { return rank(a) - rank(b); });
  return list;
}

/* Состояние сети: заполняется после запуска (UPnP + внешний IP). */
const net = {
  checking: true,
  ok: false,
  cgnat: null,          // true — входящие до нас не доходят, IP не поможет
  router: null,
  externalIp: null,     // адрес, который видит роутер
  mapped: false,        // UPnP пробросил порт
  reason: null,
  localAddress: null
};
let publicIp = null;
let tunnel = null;

/* ---- кольцо журнала и задержка event loop (OBS-01) -------------------- *
 *
 * Журнал нужен не «на всякий случай», а чтобы после жалобы «лагало» было
 * чем ответить без гаданий: когда открылся поток, когда ушёл снимок, что
 * лежало в очередях gzip/сокета, сколько снимков склеилось, на каком этапе
 * команда, почему хост объявлен потерянным, сколько занято heap/RSS.
 *
 * Размер фиксирован (200 записей на лобби и 200 на сервер). Токены и
 * секреты в журнал не попадают: ключи с такими именами выбрасываются, а
 * значения обрезаются. Иначе диагностика сама стала бы утечкой.
 * ---------------------------------------------------------------------- */
const RING_MAX = 200;
const SERVER_LOG = [];
const loopInfo = {
  resolutionMs: 50, lastMs: 0, maxMs: 0, avgMs: 0, p95Ms: 0,
  samples: 0, timer: null, hist: []
};
function cleanLogValue(v, depth) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 160 ? v.slice(0, 160) + '…' : v;
  if (depth > 2) return '…';
  if (Array.isArray(v)) {
    return v.slice(0, 8).map(function (x) { return cleanLogValue(x, depth + 1); });
  }
  if (typeof v === 'object') {
    const out = {};
    Object.keys(v).slice(0, 24).forEach(function (k) {
      if (/token|secret|authorization|password|cookie/i.test(k)) return;
      out[k] = cleanLogValue(v[k], depth + 1);
    });
    return out;
  }
  return String(v);
}
function ringPush(arr, rec) {
  arr.push(rec);
  if (arr.length > RING_MAX) arr.splice(0, arr.length - RING_MAX);
}
function makeLogRec(room, kind, data) {
  const rec = { t: now(), kind: String(kind || 'event') };
  if (room) rec.room = room;
  if (data && typeof data === 'object') {
    Object.keys(data).slice(0, 24).forEach(function (k) {
      if (/token|secret|authorization|cookie/i.test(k)) return;
      rec[k] = cleanLogValue(data[k], 0);
    });
  }
  return rec;
}
function lobbyLog(lobby, kind, data) {
  if (!lobby) return;
  if (!lobby.log) lobby.log = [];
  ringPush(lobby.log, makeLogRec(lobby.code, kind, data));
}
function serverLog(kind, data) {
  ringPush(SERVER_LOG, makeLogRec(null, kind, data));
}
function startLoopMonitor() {
  if (loopInfo.timer) return;
  let prev = Date.now();
  loopInfo.timer = setInterval(function () {
    const t = Date.now();
    const lag = Math.max(0, t - prev - loopInfo.resolutionMs);
    prev = t;
    loopInfo.lastMs = lag;
    if (lag > loopInfo.maxMs) loopInfo.maxMs = lag;
    loopInfo.hist.push(lag);
    if (loopInfo.hist.length > 120) loopInfo.hist.shift();
    loopInfo.samples++;
  }, loopInfo.resolutionMs);
  if (typeof loopInfo.timer.unref === 'function') loopInfo.timer.unref();
}
function loopSnapshot() {
  const h = loopInfo.hist.slice().sort(function (a, b) { return a - b; });
  const sum = h.reduce(function (a, b) { return a + b; }, 0);
  return {
    resolutionMs: loopInfo.resolutionMs,
    lastMs: loopInfo.lastMs,
    maxMs: loopInfo.maxMs,
    avgMs: h.length ? +(sum / h.length).toFixed(2) : 0,
    p95Ms: h.length ? h[Math.min(h.length - 1, Math.floor(h.length * 0.95))] : 0,
    samples: loopInfo.samples
  };
}

/* Периодический снимок heap/event-loop в кольцо сервера: без него журнал
   показывал бы только события, а «память росла» или «event loop встал» —
   нет. Раз в 10 секунд, фиксированный размер кольца. */
let diagTimer = null;
function startDiagSampler() {
  if (diagTimer) return;
  diagTimer = setInterval(function () {
    const m = memInfo();
    serverLog('sample', {
      heapUsed: m.heapUsed, heapTotal: m.heapTotal, rss: m.rss,
      loopLastMs: loopInfo.lastMs, loopMaxMs: loopInfo.maxMs,
      lobbies: lobbies.size
    });
  }, 10000);
  if (typeof diagTimer.unref === 'function') diagTimer.unref();
}

function discoverPublicIp(done) {
  if (typeof fetch !== 'function') return done();
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 3000);
  fetch('https://api.ipify.org?format=json', { signal: ctrl.signal })
    .then(function (r) { return r.json(); })
    .then(function (j) { publicIp = (j && j.ip) || null; })
    .catch(function () { /* без интернета: покажем только локальные адреса */ })
    .then(function () { clearTimeout(timer); done(); });
}

function gameUrl(host) { return 'http://' + host + ':' + PORT + '/game/'; }

/* Может ли друг вообще дойти по публичному адресу:
   true — порт проброшен, false — CGNAT (или проброс не удался), null — не знаем. */
function publicReachable() {
  if (net.cgnat) return false;
  if (net.mapped) return true;
  return null;
}

function serverView() {
  const urls = [];
  const reachable = PUBLIC_URL ? true : publicReachable();
  if (PUBLIC_URL) {
    /* За reverse proxy адреса этой машины (10.x, 172.x) друзьям не нужны:
       единственная настоящая ссылка — публичная. */
    urls.push({ kind: 'public', label: 'через интернет (HTTPS)', iface: null,
      url: PUBLIC_URL, reachable: true });
  } else {
    if (tunnel && tunnel.url()) {
      urls.push({ kind: 'tunnel', label: 'через интернет (HTTPS)', iface: null,
        url: tunnel.url() + '/game/' });
    }
    lanAddresses().forEach(function (a) {
      const info = findKind(a.iface, a.address);
      urls.push({ kind: info.kind, label: info.label, iface: a.iface,
        url: gameUrl(a.address) });
    });
    if (publicIp && reachable !== false) {
      const dup = urls.some(function (u) { return u.url === gameUrl(publicIp); });
      if (!dup) {
        urls.push({
          kind: 'public', iface: null,
          label: reachable === true ? 'через интернет (порт проброшен)'
            : 'через интернет (нужен проброс порта)',
          url: gameUrl(publicIp), reachable: reachable
        });
      }
    }
  }
  const netView = PUBLIC_URL
    ? {
      checking: false, ok: true, cgnat: false, router: null,
      externalIp: publicIp, mapped: true, reason: null, reachable: true
    }
    : {
      checking: net.checking, ok: net.ok, cgnat: net.cgnat, router: net.router,
      externalIp: net.externalIp, mapped: net.mapped, reason: net.reason,
      reachable: reachable
    };
  return {
    ok: true, port: PORT, local: gameUrl('127.0.0.1'), urls: urls, publicIp: publicIp,
    publicUrl: PUBLIC_URL,
    tunnel: tunnel && tunnel.url() ? tunnel.url() : null,
    tunnelState: tunnel ? tunnel.status() : 'off',
    build: buildId(), protocol: PROTOCOL,
    net: netView
  };
}

/* ------------------------------- лобби -------------------------------- */
const lobbies = new Map();
const MAX_PLAYERS = 4;
/* Сколько ждём пропавшего игрока, прежде чем выкинуть из лобби. EventSource
   переподключается сам за секунды; этого запаса хватает с головой. */
const OFFLINE_GRACE = 45000;
/* Хост считается потерянным, только если от него нет НИ ОДНОГО запроса:
   снапшоты идут POST-ом и могут жить, когда SSE уже оборвался, а в игре хост
   ещё и шлёт короткий heartbeat. Восемь секунд оказалось слишком мало:
   браузер мог отдать кадр позже, сеть — моргнуть, а скрытая вкладка Chrome
   редеет таймеры до раза в минуту — и клиенты получали «хост потерян» на
   живой партии. Минута покрывает самый глубокий фон; клиенты всё равно
   узнают о пропаже раньше по тишине снимков и показывают «ждём», а не экран
   «выкинуло». */
const HOST_GRACE = 60000;

/* Неактивная партия живёт 30 секунд (заказчик 2026-10-29). «Активна» —
   есть живой SSE-поток или игрок обращался к серверу внутри окна.
   Скрытая вкладка держит SSE, поэтому фон партию не убивает; F5 успевает
   вернуться. INACTIVE_TTL переопределяется в приёмке, чтобы не ждать 30 с. */
const INACTIVE_TTL = Math.max(1000,
  parseInt(process.env.INACTIVE_TTL || '30000', 10) || 30000);
const INACTIVE_SWEEP = Math.max(250,
  Math.min(1000, Math.floor(INACTIVE_TTL / 10)));

/* ---- команды клиентов: очередь, а не только SSE ----------------------- *
 *
 * Заказчик 2026-10-25: «у друга огромный пинг, здания ставятся через 30
 * секунд, иногда быстрее». Причина была не в скорости мира, а в канале
 * команд: они уходили хосту ТОЛЬКО событием SSE. SSE — односторонний поток
 * без подтверждений; если у хоста он оборвался или подвис (мобильная сеть,
 * VPN, прокси), снапшоты продолжали идти POST-ом, а команды пропадали
 * молча — клиент получал 200 и ждал постройку, которой никто не видел.
 * Когда поток случайно оживал, накопленные клики «доезжали» пачкой — отсюда
 * «иногда быстрее».
 *
 * Теперь команда кладётся в очередь лобби, а хост забирает её в ОТВЕТЕ на
 * свой POST снимка. Это тот же путь, что и снапшоты: он уже доказал, что
 * жив, и не зависит от SSE. Хост подтверждает выполненное номером n в
 * следующем снимке (`cmdAck`), и очередь чистится. Повтор с тем же n
 * (обрыв, ретрай) второй раз не встаёт. CMD_TTL не даёт копиться командам,
 * пока хост действительно пропал: через 15 с они уже не нужны. */
const CMD_TTL = 15000;
const CMD_MAX = 200;
/* Сколько живёт РЕЗУЛЬТАТ команды. Клиент опрашивает его после 200 на
   /api/command; 15 с TTL очереди + запас на опрос и на возврат в партию. */
const CMD_RESULT_TTL = 60000;
/* Команда, которую хост уже забрал, но ещё не подтвердил, ждёт дольше: он
   мог задуматься на кадр/свернуть вкладку. 15 с — срок для НЕзабранной
   команды; забранной даём минуту, иначе просрочка обгоняла бы ответ хоста и
   клиент видел «expired» у уже построенного дома. */
const CMD_DELIVERED_TTL = 60000;
/* Потолок карты результатов на лобби: без него долгая партия копила бы
   записи о каждой команде до перезапуска сервера.
   История ОТВЕТОВ (с причиной) — 2000: при 12 снимках в секунду и десятках
   команд это часы игры. Вытесненные ответы не исчезают бесследно: их ключи и
   состояние уходят в компактные «надгробия» cmdSeen (8192 на лобби), поэтому
   повтор старой команды после >1000 действий всё ещё распознаётся как
   повтор. Обе карты ограничены — память не растёт с длиной партии. */
const CMD_RESULT_MAX = 2000;
const CMD_SEEN_MAX = 8192;
const CMD_SEEN_TTL = 5 * 60 * 1000;
/* Сколько результатов хост кладёт в один снимок и сколько сервер готов
   принять: больше 20 хосту в кадр не влезает, но старый/новый хост может
   прислать пачку — лишнее не теряем молча, а просто не читаем сверх лимита. */
const CMD_DONE_MAX = 20;
const CMD_DONE_ACCEPT = 64;
/* Состояния результата. pending живёт только в очереди; карта результатов —
   окончательные. */
const CMD_FINAL = { applied: 1, rejected: 1, expired: 1 };

function code() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}
function token() { return crypto.randomBytes(18).toString('hex'); }
function now() { return Date.now(); }

function makeLobby(max) {
  let c = code();
  while (lobbies.has(c)) c = code();
  const lobby = {
    code: c, max: Math.max(2, Math.min(MAX_PLAYERS, max || 4)),
    players: [], started: false, seed: null, size: 192, streams: new Map(),
    createdAt: now(), hostId: 0, nextId: 0, startPayload: null,
    /* С какого момента в партии нет ни одного подключённого игрока.
       0 — партия активна; выставляет sweepInactiveLobbies. */
    inactiveSince: 0,
    hostGone: false, hostTimer: null, lastSnapAt: 0, lastSnapshot: null,
    /* Команды, ждущие хоста: [{...cmd, from, owner, sn, at}].
       Хост забирает их ответом на снимок (см. CMD_TTL), а не событием SSE.
       sn — порядковый номер ПРИЁМА в лобби: по нему хост выполняет команды
       одного отправителя, даже если они приехали вразнобой. */
    cmdQueue: [],
    /* Какие команды уже отдавались хосту (from:n → время). Отдельная карта,
       а не поле команды: хост не должен получать служебные поля, а ack
       водяным знаком снимает только отданное. */
    cmdDelivered: new Map(),
    cmdSeq: 0,
    /* Окончательные результаты: ключ from: n → {from,n,sn,state,reason,
       at,decidedAt}. Отдаются GET /api/command-state, живут результат-TTL. */
    cmdResults: new Map(),
    /* Компактные «надгробия» вытесненных результатов: ключ from: n →
       {state,sn,at,decidedAt}. Нужны, чтобы повтор давно решённой команды
       после вытеснения из cmdResults не выполнился второй раз. Размер
       ограничен отдельно, поэтому идемпотентность живёт дольше истории
       ответов, но остаётся ограниченной по памяти. */
    cmdSeen: new Map(),
    /* Кольцо журнала лобби и сводка закрытых потоков. */
    log: [],
    totals: {
      streamsOpened: 0, streamsClosed: 0,
      rawBytes: 0, gzipBytes: 0, wireBytes: 0,
      dropped: 0, coalesced: 0, droppedControls: 0, errors: 0
    },
    lastSseAt: 0,
    hostGoneReason: null,
    /* Не чаще раза в секунду: иначе 12 снимков/с вытеснят из кольца всё
       остальное (команды, ошибки, потерю хоста). */
    lastSnapLogAt: 0
  };
  lobbies.set(c, lobby);
  return lobby;
}

/* ----------------------- комнаты: worker на партию ---------------------- *
 *
 * Авторитетный мир считает отдельный worker_threads.Worker. Главный поток
 * обслуживает HTTP, лобби, токены и SSE; он не исполняет физику и не хранит
 * N копий мира. На комнату — один worker, поэтому глобальные IIFE-модули
 * движка не смешиваются между партиями.
 *
 * MAX_ACTIVE_ROOMS по умолчанию 1: предел выбран ДО измерения вместимости
 * VPS. Отказ явный `server_capacity`, а не бесконечное число worker'ов.
 * ---------------------------------------------------------------------- */
const MAX_ACTIVE_ROOMS = Math.max(1, parseInt(process.env.MAX_ACTIVE_ROOMS || '1', 10) || 1);
const STATE_DIR = process.env.STATE_DIR
  ? path.resolve(process.env.STATE_DIR)
  : path.resolve(process.cwd(), 'game', 'server', 'var', 'rooms');
const roomRecords = new Map();   // lobby.code -> record
let roomGeneration = 0;

function monoMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function roomFor(lobby) {
  return lobby ? roomRecords.get(lobby.code) || null : null;
}

/* Лобби переживает перезапуск Node вместе с комнатой: токены, состав и
   владельцы лежат в STATE_DIR/<room>/lobby.json с правами 0600. Мир и
   результаты команд — в checkpoint/журнале комнаты, а не здесь. */
function lobbyMetaPath(roomId) {
  return path.join(STATE_DIR, roomId, 'lobby.json');
}

function saveLobbyMeta(lobby) {
  if (!lobby || !lobby.code) return;
  try {
    const dir = path.dirname(lobbyMetaPath(lobby.code));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const meta = {
      code: lobby.code, max: lobby.max, hostId: lobby.hostId,
      seed: lobby.seed, size: lobby.size, createdAt: lobby.createdAt,
      players: lobby.players.map(function (p) {
        return {
          id: p.id, token: p.token, name: p.name, color: p.color,
          proto: p.proto, owner: p.owner, ready: !!p.ready
        };
      })
    };
    const file = lobbyMetaPath(lobby.code);
    fs.writeFileSync(file, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (e) { /* Windows */ }
  } catch (e) {
    console.error('  lobby meta: ' + (e && e.message || e));
  }
}

function restoreLobbies() {
  let dirs = [];
  try { dirs = fs.readdirSync(STATE_DIR); } catch (e) { return 0; }
  let n = 0;
  for (const roomId of dirs) {
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(lobbyMetaPath(roomId), 'utf8'));
    } catch (e) { continue; }
    if (!meta || !meta.code || !Array.isArray(meta.players) || !meta.players.length) continue;
    if (lobbies.has(meta.code)) continue;
    /* makeLobby создаёт пустую запись; код заменяем на сохранённый. */
    const lobby = makeLobby(meta.max);
    lobbies.delete(lobby.code);
    lobby.code = meta.code;
    lobbies.set(lobby.code, lobby);
    lobby.hostId = meta.hostId === undefined ? meta.players[0].id : meta.hostId;
    lobby.seed = meta.seed || null;
    lobby.size = meta.size || 192;
    lobby.createdAt = meta.createdAt || now();
    lobby.started = true;
    lobby.startPayload = null;
    lobby.lastSnapshot = null;
    lobby.players = meta.players.map(function (p) {
      return {
        id: p.id, token: p.token, name: p.name || ('Игрок ' + p.id),
        color: p.color, proto: p.proto || PROTOCOL, owner: p.owner,
        ready: true, online: false, lastSeen: 0, timer: null, goneAt: 0
      };
    });
    n++;
    console.log('  лобби ' + lobby.code + ' восстановлено из ' + roomId);
  }
  return n;
}

function buildStartPayload(lobby, rec, opts) {
  opts = opts || {};
  const baseline = rec && (rec.baseline || rec.latest) || null;
  return {
    seed: lobby.seed, size: lobby.size, sites: opts.sites || [],
    hostId: lobby.hostId,
    snapGzip: true,
    cmdProto: CMD_PROTO,
    protocol: PROTOCOL,
    build: buildId(),
    protocolWarning: protocolWarning(lobby),
    serverNow: now(),
    roomId: rec ? rec.roomId : null,
    epoch: rec ? rec.epoch : null,
    revision: baseline ? baseline.revision : 0,
    simulationTick: baseline ? baseline.simulationTick : 0,
    baseline: baseline,
    players: lobby.players.map(function (p, i) {
      const owner = p.owner === undefined ? i : p.owner;
      return {
        id: p.id, name: p.name, owner: owner, color: p.color,
        sessionId: String(p.id),
        instance: 's' + owner + '-' + crypto.createHash('sha1').update(String(p.id)).digest('hex').slice(0, 8),
        nextClientSequence: 1
      };
    })
  };
}

function roomSummary(rec) {
  if (!rec) return null;
  const s = rec.latest || {};
  return {
    roomId: rec.roomId,
    epoch: rec.epoch,
    revision: s.revision === undefined ? null : s.revision,
    simulationTick: s.simulationTick === undefined ? null : s.simulationTick,
    simulationTimeMs: s.simulationTimeMs === undefined ? null : s.simulationTimeMs,
    roomStatus: rec.fault ? 'faulted' : (s.roomStatus || rec.status || 'starting'),
    status: rec.fault ? 'faulted' : (rec.status || 'starting'),
    fault: rec.fault || null
  };
}

function roomWorkerFault(rec, fault) {
  if (!rec || rec.fault) return;
  rec.fault = fault || { phase: 'worker', message: 'worker fault' };
  rec.status = 'faulted';
  const lobby = rec.lobby;
  if (lobby) {
    broadcast(lobby, 'room-fault', {
      roomId: rec.roomId, epoch: rec.epoch, fault: rec.fault
    });
    lobbyLog(lobby, 'room-fault', rec.fault);
  }
  /* Команды, ожидающие ответа worker'а, не должны висеть вечно. */
  for (const [, pending] of rec.pending) {
    try { pending.reject(new Error('room_fault')); } catch (e) {}
  }
  rec.pending.clear();
}

function createRoomWorker(lobby) {
  if (roomFor(lobby)) return roomFor(lobby);
  if (roomRecords.size >= MAX_ACTIVE_ROOMS) {
    const err = new Error('server_capacity');
    err.code = 'server_capacity';
    throw err;
  }
  const generation = ++roomGeneration;
  const rec = {
    roomId: lobby.code,
    generation: generation,
    lobby: lobby,
    worker: null,
    status: 'starting',
    epoch: null,
    latest: null,
    baseline: null,
    fault: null,
    reqSeq: 0,
    pending: new Map(),
    ready: null,
    createdAt: now()
  };
  rec.ready = new Promise(function (resolve, reject) {
    rec._resolveReady = resolve;
    rec._rejectReady = reject;
  });
  const worker = new Worker(path.join(__dirname, 'room-worker.js'), {
    workerData: { roomId: lobby.code, workerGeneration: generation },
    env: Object.assign({}, process.env, { STATE_DIR: STATE_DIR })
  });
  rec.worker = worker;
  worker.on('message', function (msg) {
    if (!msg || msg.roomId !== rec.roomId) return;
    if (msg.workerGeneration !== undefined && msg.workerGeneration !== rec.generation) return;
    if (msg.type === 'ready') {
      rec.epoch = msg.epoch;
      rec.baseline = msg.baseline;
      rec.latest = msg.baseline;
      rec.status = 'running';
      rec.diagnostics = msg.diagnostics;
      lobby.lastSnapshot = msg.baseline;
      lobby.lastSnapAt = now();
      lobby.lastSnapshotBytes = byteLen(JSON.stringify(msg.baseline));
      if (rec._resolveReady) rec._resolveReady(rec);
      return;
    }
    if (msg.type === 'snapshot') {
      const snap = msg.snapshot;
      if (!snap) return;
      rec.latest = snap;
      rec.status = snap.roomStatus || 'running';
      lobby.lastSnapshot = snap;
      lobby.lastSnapAt = now();
      lobby.lastSnapshotBytes = byteLen(JSON.stringify(snap));
      broadcast(lobby, 'snapshot', snap);
      try {
        worker.postMessage({
          type: 'snapshotAck', roomId: rec.roomId,
          workerGeneration: rec.generation
        });
      } catch (e) {}
      return;
    }
    if (msg.type === 'received') {
      const list = msg.commands || [];
      for (const item of list) {
        const p = rec.pending.get(item.requestId);
        if (!p) continue;
        rec.pending.delete(item.requestId);
        if (p.timer) clearTimeout(p.timer);
        /* roomSubmit ждёт форму сообщения, а worker отдаёт один элемент
           пачки. Оборачиваем здесь, чтобы не было второго формата ответа. */
        p.resolve({ commands: [item] });
      }
      return;
    }
    if (msg.type === 'diagnostics') {
      const p = rec.pending.get(msg.requestId);
      if (p) {
        rec.pending.delete(msg.requestId);
        if (p.timer) clearTimeout(p.timer);
        p.resolve(msg);
      }
      return;
    }
    if (msg.type === 'fault') {
      roomWorkerFault(rec, msg.fault);
      if (rec._rejectReady) rec._rejectReady(new Error('room_fault'));
      return;
    }
    if (msg.type === 'closed') {
      rec.status = 'closed';
      return;
    }
  });
  worker.on('error', function (e) {
    roomWorkerFault(rec, { phase: 'worker-error', message: String(e && e.message || e) });
    if (rec._rejectReady) rec._rejectReady(e);
  });
  worker.on('exit', function (code) {
    if (rec.status !== 'closed' && !rec.fault) {
      roomWorkerFault(rec, {
        phase: 'worker-exit', message: 'worker exited with code ' + code
      });
    }
    if (rec._rejectReady) rec._rejectReady(new Error('worker_exit'));
    roomRecords.delete(rec.roomId);
  });
  roomRecords.set(rec.roomId, rec);
  return rec;
}

/* Старт комнаты: seed/size выбираются здесь один раз, состав players→owners
   фиксируется, worker поднимает мир и только после `ready` лобби объявляет
   старт. Пока worker не готов, пустая running-партия не отдаётся. */
async function startRoom(lobby) {
  if (lobby.started && lobby.startPayload) return { ok: true, already: true };
  const block = startBlock(lobby);
  if (block) return { ok: false, reason: block.reason, waiting: block.waiting };
  const start = chooseStart(lobby);
  if (!start) return { ok: false, reason: 'не удалось выбрать остров — нажмите «Начать игру» ещё раз' };
  let rec;
  try { rec = createRoomWorker(lobby); }
  catch (e) {
    if (e && e.code === 'server_capacity') {
      return { ok: false, code: 'server_capacity',
        reason: 'на сервере уже идёт другая партия; попробуйте позже' };
    }
    throw e;
  }
  if (!rec.worker) return { ok: false, reason: 'комната уже занята' };
  lobby.players.forEach(function (p, i) { p.owner = i; });
  const players = lobby.players.map(function (p, i) {
    return {
      sessionId: String(p.id), playerId: p.id, owner: i,
      name: p.name, instance: 's' + i + '-' + crypto.createHash('sha1').update(String(p.id)).digest('hex').slice(0, 8)
    };
  });
  try {
    rec.worker.postMessage({
      type: 'init', roomId: rec.roomId, workerGeneration: rec.generation,
      seed: start.seed, size: start.size, players: players,
      epoch: 1, stateDir: STATE_DIR, buildHash: buildId(),
      protocol: NetConfig.protocol
    });
    await Promise.race([
      rec.ready,
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('room_ready_timeout')); }, 15000);
      })
    ]);
  } catch (e) {
    roomWorkerFault(rec, { phase: 'start', message: String(e && e.message || e) });
    try { rec.worker.postMessage({ type: 'shutdown', roomId: rec.roomId, workerGeneration: rec.generation }); } catch (err) {}
    roomRecords.delete(rec.roomId);
    return { ok: false, reason: 'комната не поднялась: ' + String(e && e.message || e) };
  }
  lobby.seed = start.seed;
  lobby.size = start.size;
  lobby.started = true;
  lobby.lastSnapshot = rec.baseline;
  lobby.lastSnapAt = now();
  lobby.seed = start.seed;
  lobby.size = start.size;
  const payload = buildStartPayload(lobby, rec, { sites: start.sites });
  lobby.startPayload = payload;
  saveLobbyMeta(lobby);
  broadcast(lobby, 'start', payload);
  lobbyLog(lobby, 'start', {
    seed: start.seed, size: start.size, players: lobby.players.length,
    build: buildId(), protocol: PROTOCOL, roomId: rec.roomId,
    epoch: rec.epoch
  });
  console.log('  лобби ' + lobby.code + ': старт комнаты ' + rec.roomId +
    ', сид «' + start.seed + '», ' + lobby.players.length + ' игрока');
  return { ok: true, seed: start.seed, roomId: rec.roomId };
}

/* Возврат в комнату, пережившую перезапуск Node. Мир поднимается из
   checkpoint+журнала; лобби и токены — из lobby.json. */
async function ensureRoom(lobby) {
  const existing = roomFor(lobby);
  if (existing && existing.worker) return existing;
  if (!lobby.started) throw new Error('not_started');
  const rec = createRoomWorker(lobby);
  const players = lobby.players.map(function (p, i) {
    const owner = p.owner === undefined ? i : p.owner;
    return {
      sessionId: String(p.id), playerId: p.id, owner: owner,
      name: p.name,
      instance: 's' + owner + '-' + crypto.createHash('sha1').update(String(p.id)).digest('hex').slice(0, 8)
    };
  });
  try {
    rec.worker.postMessage({
      type: 'init', roomId: rec.roomId, workerGeneration: rec.generation,
      seed: lobby.seed, size: lobby.size, players: players,
      epoch: 1, stateDir: STATE_DIR, buildHash: buildId(),
      protocol: NetConfig.protocol
    });
    await Promise.race([
      rec.ready,
      new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('room_ready_timeout')); }, 15000);
      })
    ]);
  } catch (e) {
    roomWorkerFault(rec, { phase: 'resume', message: String(e && e.message || e) });
    try { rec.worker.postMessage({ type: 'shutdown', roomId: rec.roomId, workerGeneration: rec.generation }); } catch (err) {}
    roomRecords.delete(rec.roomId);
    throw e;
  }
  lobby.startPayload = buildStartPayload(lobby, rec, { sites: [] });
  lobby.lastSnapshot = rec.baseline;
  lobby.lastSnapAt = now();
  saveLobbyMeta(lobby);
  return rec;
}

function roomRequest(rec, type, data, timeoutMs) {
  if (!rec || !rec.worker) return Promise.reject(new Error('room_not_running'));
  const requestId = ++rec.reqSeq;
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      rec.pending.delete(requestId);
      reject(new Error('room_timeout'));
    }, timeoutMs || 10000);
    rec.pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
    try {
      rec.worker.postMessage(Object.assign({
        type: type, roomId: rec.roomId, workerGeneration: rec.generation,
        requestId: requestId
      }, data || {}));
    } catch (e) {
      rec.pending.delete(requestId);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function roomSubmit(rec, auth) {
  if (!rec || !rec.worker) return Promise.reject(new Error('room_not_running'));
  const requestId = ++rec.reqSeq;
  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      rec.pending.delete(requestId);
      reject(new Error('room_timeout'));
    }, 15000);
    rec.pending.set(requestId, {
      resolve: function (msg) {
        const list = msg.commands || [];
        resolve(list[0] || { admitted: false, status: 'rejected', reasonCode: 'no_receipt' });
      },
      reject: reject, timer: timer
    });
    try {
      rec.worker.postMessage({
        type: 'commands', roomId: rec.roomId, workerGeneration: rec.generation,
        commands: [{ requestId: requestId, command: auth }]
      });
    } catch (e) {
      rec.pending.delete(requestId);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function roomStateQuery(rec, sessionId, ids, watermark) {
  return roomRequest(rec, 'diagnostics', {
    sessionId: sessionId, ids: ids, watermark: watermark
  }, 10000).then(function (msg) {
    return {
      diagnostics: msg.diagnostics || null,
      commandState: msg.commandState || null
    };
  });
}

/* Предупреждение о другой версии клиента. Это ТОЛЬКО поле: старт не
   отказывает — иначе игрок с чуть более старым кэшем не смог бы играть
   вовсе. Клиент показывает строку и продолжает. */
function protocolWarning(lobby) {
  const wrong = lobby.players.filter(function (p) {
    return p.proto && p.proto !== PROTOCOL;
  });
  if (!wrong.length) return null;
  return 'другая версия клиента: ' + wrong.map(function (p) {
    return p.name + ' (протокол ' + p.proto + ')';
  }).join(', ') + '; сервер ' + PROTOCOL + ' (' + buildId() + ')';
}

function lobbyView(lobby) {
  const host = lobby.players.find(function (p) { return p.id === lobby.hostId; });
  return {
    code: lobby.code, max: lobby.max, started: lobby.started,
    seed: lobby.seed, size: lobby.size, hostId: lobby.hostId,
    hostGone: !!lobby.hostGone,
    protocol: PROTOCOL, build: buildId(),
    protocolWarning: protocolWarning(lobby),
    canStart: !lobby.started && !startBlock(lobby),
    players: lobby.players.map(function (p) {
      return { id: p.id, name: p.name, ready: p.ready, host: p.id === lobby.hostId,
        color: p.color, online: p.online !== false };
    }),
    hostOnline: !!(host && host.online !== false)
  };
}

function eventText(type, data) {
  return 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

/* ---- поток клиента: SSE, сжатие и backpressure ----------------------- *
 *
 * Заказчик 2026-10-25: «каждую игру игра лагает и у друзей огромный пинг».
 * Замер показал, что один снимок мира — 5,2 КБ JSON, 12,5 кадров в секунду,
 * то есть ~520 Кбит/с НА КАЖДОГО друга. Канал вверх у домашнего интернета
 * общий и узкий; 2–3 таких потока заполняли его целиком, роутер ставил пакеты
 * в очередь — и круг до сервера рос до сотен миллисекунд, хотя сама игра
 * считает быстро.
 *
 * Половина снимка — повторяющиеся имена полей и hex-карта убранного, поэтому
 * обычный gzip сжимает его в 7–8 раз (5,2 КБ → ~0,65 КБ), а в потоке —
 * ещё сильнее: соседние кадры похожи, и работает словарь. Замер на приёмке
 * живой партии: было 523 Кбит/с, стало ~20. Ужимаем сам поток, а не формат
 * снимка: так не меняется ни одно правило игры и ни один обработчик клиента.
 *
 * flush: Z_SYNC_FLUSH обязателен: без него zlib копит кадр до заполнения
 * блока, и «мгновенные» события приезжают пачками по секунде. Уровень 1 —
 * сжатие почти как у 9-го (606 против 658 байт), а стоит копейки.
 *
 * Клиент без gzip (старый прокси, curl) получает обычный текст: формат SSE
 * от этого не меняется.
 *
 * ЧЕГО НЕ ХВАТАЛО ДО ПАТЧА (NET-01). Цепочка была
 * `broadcast → gz.write → gz 'data' → res.write`, и её результат нигде не
 * проверялся: `gz.write` мог вернуть false, `res.write` мог вернуть false, а
 * ограничитель смотрел только на `res.writableLength`. Воспроизведение из
 * ТЗ: 500 снимков по 24 000 символов синхронным burst при нечитающем
 * клиенте — `queue: 0`, `gz.writableLength: 12 017 500`, `needDrain: true`.
 * То есть 12 МБ лежали в zlib, а хост считал, что друзья успевают.
 *
 * Теперь у КАЖДОГО потока свой ограниченный конвейер:
 *   • `gz.writableLength + gz.readableLength + res.writableLength` — один
 *     видимый лимит; выше него в gzip не пишем;
 *   • `gz.write()`/`res.write()` == false останавливает конвейер до 'drain'
 *     соответствующего звена; при заполненном сокете gzip ставится на паузу;
 *   • снимки не копятся: в очереди живёт ОДИН последний, более свежий
 *     заменяет старый ДО сжатия (удалять байты из gzip нельзя — только целые
 *     события); замены считаются dropped/coalesced;
 *   • контрольные события (hello/start/lobby/command/command-result/host-*)
 *     идут отдельной ограниченной очередью и снимками не вытесняются;
 *   • 'error' у gz/res и 'close'/'abort' освобождают zlib, сокет, таймер и
 *     запись в lobby.streams; медленный поток не задерживает быстрый.
 * ---------------------------------------------------------------------- */
const STREAM_SOCKET_HIGH = 64 * 1024;    // предел res.writableLength
const STREAM_GZIP_HIGH = 64 * 1024;      // предел writable+readable у gzip
const STREAM_CONTROL_MAX = 64;           // событий в контрольной очереди
const STREAM_CONTROL_BYTES = 128 * 1024; // байт в контрольной очереди
const STREAM_ERROR_MAX = 8;

function byteLen(text) { return Buffer.byteLength(String(text), 'utf8'); }

function streamSocketQueued(st) {
  var res = st.res;
  if (res && typeof res.writableLength === 'number') return res.writableLength;
  return st.socketFallback || 0;
}
function streamGzipQueued(st) {
  if (!st.gz) return 0;
  return (st.gz.writableLength || 0) + (st.gz.readableLength || 0);
}
function streamPendingQueued(st) {
  return (st.controlBytes || 0) + (st.pendingSnapshot ? st.pendingSnapshot.bytes : 0);
}
function streamQueueBytes(st) {
  return streamSocketQueued(st) + streamGzipQueued(st) + streamPendingQueued(st);
}
/* Оценка того, сколько ещё байт ПРОВОДА ждёт: несжатый хвост gzip оцениваем
   по уже сложившемуся коэффициенту сжатия этого потока. Это для диагностики;
   queue для хоста — полная сумма стадий (см. streamQueueBytes), чтобы
   12 МБ в gzip не показывались нулём. */
function streamWireQueued(st) {
  var socket = streamSocketQueued(st);
  var gz = 0;
  if (st.gz) {
    var ratio = st.rawBytes > 0 ? Math.min(1, st.gzipBytes / st.rawBytes) : 0.25;
    gz = (st.gz.readableLength || 0) +
      Math.round((st.gz.writableLength || 0) * ratio);
  }
  return socket + gz + streamPendingQueued(st);
}
function streamCanWrite(st) {
  if (!st.res || st.res.destroyed || st.res.writableEnded) return false;
  if (streamSocketQueued(st) >= STREAM_SOCKET_HIGH) return false;
  if (st.gz && streamGzipQueued(st) >= STREAM_GZIP_HIGH) return false;
  return true;
}
function streamError(st, where, e) {
  var msg = (e && e.message) ? e.message : String(e || 'ошибка');
  st.errors.push({ t: now(), where: where, message: String(msg).slice(0, 160) });
  if (st.errors.length > STREAM_ERROR_MAX) st.errors.shift();
  if (st.lobby && st.lobby.totals) st.lobby.totals.errors++;
  lobbyLog(st.lobby, 'stream-error', {
    playerId: st.playerId, where: where, message: msg
  });
}

/* Один шаг конвейера: контрольная очередь важнее снимков. Снимок в очереди
   всегда последний — старые уже заменены при pushSnapshot. */
function nextStreamJob(st) {
  if (st.control.length) {
    var c = st.control.shift();
    st.controlBytes -= c.bytes;
    return c;
  }
  if (st.pendingSnapshot) {
    var s = st.pendingSnapshot;
    st.pendingSnapshot = null;
    return {
      kind: 'snapshot', text: s.text, bytes: s.bytes,
      seq: s.seq, at: s.at
    };
  }
  return null;
}

function writeStreamJob(st, job) {
  st.rawBytes += job.bytes;
  st.lastWriteAt = now();
  if (job.kind === 'snapshot') {
    st.snapshotsSent++;
    st.lastSnapshotAt = st.lastWriteAt;
    st.lastSnapshotSeq = job.seq;
    st.snapPushedAt = job.at || st.lastWriteAt;
  } else {
    st.controlsSent++;
  }
  if (st.gz) {
    var gok = true;
    try { gok = st.gz.write(job.text); }
    catch (e) {
      streamError(st, 'gzip-write', e);
      onStreamClosed(st.lobby, st.player, st, 'gzip-write');
      return;
    }
    if (gok === false) st.gzipBlocked = true;
    return;
  }
  if (!st.res || st.res.destroyed || st.res.writableEnded) {
    onStreamClosed(st.lobby, st.player, st, 'write-closed');
    return;
  }
  var wok = true;
  try { wok = st.res.write(job.text); }
  catch (e) {
    streamError(st, 'socket-write', e);
    onStreamClosed(st.lobby, st.player, st, 'socket-write');
    return;
  }
  st.wireBytes += job.bytes;
  st.socketFallback += job.bytes;
  if (wok === false) st.socketBlocked = true;
}

function pumpStream(st) {
  if (st.closed || st.pumping) return;
  st.pumping = true;
  try {
    while (!st.closed) {
      if (st.socketBlocked || st.gzipBlocked) break;
      if (!streamCanWrite(st)) break;
      var job = nextStreamJob(st);
      if (!job) break;
      writeStreamJob(st, job);
    }
  } finally {
    st.pumping = false;
    if (st.pumpAgain && !st.closed) {
      st.pumpAgain = false;
      requestStreamPump(st, false);
    }
  }
}
function requestStreamPump(st, immediate) {
  if (st.closed) return;
  if (st.pumping) { st.pumpAgain = true; return; }
  if (immediate) { pumpStream(st); return; }
  if (st.pumpScheduled) return;
  st.pumpScheduled = true;
  setImmediate(function () {
    st.pumpScheduled = false;
    pumpStream(st);
  });
}

/* Управляющее событие. Очередь ограничена; при переполнении выбрасываем
   САМОЕ СТАРОЕ (свежие hello/start/command-result важнее) и честно считаем
   это. Снимки сюда не попадают и вытеснить управление не могут. */
function pushControl(st, text, type, meta) {
  if (st.closed || !text) return false;
  var bytes = byteLen(text);
  if (st.control.length >= STREAM_CONTROL_MAX ||
      st.controlBytes + bytes > STREAM_CONTROL_BYTES) {
    var old = st.control.shift();
    if (old) st.controlBytes -= old.bytes;
    st.droppedControls++;
    st.dropped++;
    streamError(st, 'control-overflow', 'очередь управления переполнена');
  }
  st.control.push({
    kind: 'control', text: text, bytes: bytes,
    type: type || 'event', at: now(), meta: meta || null
  });
  st.controlBytes += bytes;
  requestStreamPump(st, true);
  return true;
}

/* Снимок — отдельный слот «последний». Пока предыдущий не записан в gzip,
   новый заменяет его целиком: удалять часть сжатого потока нельзя, а
   показывать друга устаревший кадр, когда есть свежий, незачем. */
function pushSnapshot(st, text, seq, at) {
  if (st.closed || !text) return false;
  var bytes = byteLen(text);
  if (st.pendingSnapshot) {
    /* Счётчики видны в /api/stream-stats и /api/diag; в кольцо журнала
       каждый такой кадр НЕ пишем: при 12 снимках/с и медленном друге это
       вытеснило бы команды и потерю хоста. */
    st.coalesced++;
    st.dropped++;
  }
  st.pendingSnapshot = {
    text: text, bytes: bytes,
    seq: seq === undefined ? null : seq,
    at: at || now()
  };
  requestStreamPump(st, true);
  return true;
}

function streamStats(st) {
  var socketQueued = streamSocketQueued(st);
  var gzipQueued = streamGzipQueued(st);
  var pending = streamPendingQueued(st);
  var queue = socketQueued + gzipQueued + pending;
  var ageMs = 0;
  if (st.pendingSnapshot) {
    ageMs = now() - st.pendingSnapshot.at;
  } else if (queue > 0 && st.snapPushedAt) {
    ageMs = now() - st.snapPushedAt;
  }
  return {
    playerId: st.playerId,
    name: st.name,
    gzip: !!st.gz,
    rawBytes: st.rawBytes,
    gzipBytes: st.gz ? st.gzipBytes : 0,
    wireBytes: st.wireBytes,
    socketQueued: socketQueued,
    gzipQueued: gzipQueued,
    gzipWritable: st.gz ? (st.gz.writableLength || 0) : 0,
    gzipReadable: st.gz ? (st.gz.readableLength || 0) : 0,
    pending: pending,
    controlPending: st.controlBytes || 0,
    pendingSnapshotBytes: st.pendingSnapshot ? st.pendingSnapshot.bytes : 0,
    dropped: st.dropped,
    coalesced: st.coalesced,
    droppedControls: st.droppedControls,
    queue: queue,
    wireQueue: streamWireQueued(st),
    ageMs: Math.max(0, ageMs),
    snapshotsSent: st.snapshotsSent,
    controlsSent: st.controlsSent,
    heartbeats: st.heartbeats || 0,
    lastSnapshotSeq: st.lastSnapshotSeq === undefined ? null : st.lastSnapshotSeq,
    errors: st.errors.slice(-STREAM_ERROR_MAX),
    openedAt: st.openedAt
  };
}

function openEventStream(req, res, lobby, p) {
  var gzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
  var headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Vary': 'Accept-Encoding'
  };
  if (gzip) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, headers);
  /* Мелкие события не должны ждать 40 мс на Nagle — это заметно на каждом
     «готов» и команде. */
  try { if (res.socket) res.socket.setNoDelay(true); } catch (e) {}

  var st = {
    lobby: lobby, player: p, playerId: p.id, name: p.name,
    req: req, res: res, gz: null,
    openedAt: now(), closed: false, closedReason: null,
    rawBytes: 0, gzipBytes: 0, wireBytes: 0,
    control: [], controlBytes: 0, pendingSnapshot: null,
    dropped: 0, coalesced: 0, droppedControls: 0,
    snapshotsSent: 0, controlsSent: 0, heartbeats: 0,
    errors: [], pumping: false, pumpAgain: false, pumpScheduled: false,
    socketBlocked: false, gzipBlocked: false, socketFallback: 0,
    lastWriteAt: 0, lastDrainAt: 0, lastSnapshotAt: 0,
    lastSnapshotSeq: null, snapPushedAt: 0, heartbeat: null,
    onResClose: null, onResError: null, onDrain: null
  };
  res.__stream = st;

  if (gzip) {
    var gz = zlib.createGzip({ level: 1, flush: zlib.constants.Z_SYNC_FLUSH });
    st.gz = gz;
    gz.on('data', function (chunk) {
      if (st.closed) return;
      st.gzipBytes += chunk.length;
      st.wireBytes += chunk.length;
      var ok = true;
      try { ok = res.write(chunk); }
      catch (e) {
        streamError(st, 'gzip-data', e);
        onStreamClosed(lobby, p, st, 'gzip-data');
        return;
      }
      if (ok === false) {
        st.socketBlocked = true;
        /* Сокет не принимает — останавливаем и источник, иначе zlib будет
           копить сжатое в readable-буфере. */
        try { if (typeof gz.pause === 'function') gz.pause(); } catch (e) {}
      } else {
        requestStreamPump(st, false);
      }
    });
    gz.on('drain', function () {
      st.gzipBlocked = false;
      requestStreamPump(st, false);
    });
    gz.on('end', function () {
      if (st.closed) return;
      try { res.end(); } catch (e) {}
    });
    gz.on('error', function (e) {
      streamError(st, 'gzip', e);
      onStreamClosed(lobby, p, st, 'gzip-error');
    });
  }

  st.onDrain = function () {
    st.socketBlocked = false;
    st.socketFallback = 0;
    st.lastDrainAt = now();
    if (st.gz && st.gz.isPaused && st.gz.isPaused()) {
      try { st.gz.resume(); } catch (e) {}
    }
    requestStreamPump(st, false);
  };
  st.onResClose = function () { onStreamClosed(lobby, p, st, 'res-close'); };
  st.onResError = function (e) {
    streamError(st, 'res', e);
    onStreamClosed(lobby, p, st, 'res-error');
  };
  res.on('drain', st.onDrain);
  res.on('close', st.onResClose);
  res.on('error', st.onResError);
  req.on('close', function () { onStreamClosed(lobby, p, st, 'req-close'); });

  /* Heartbeat — тоже через общий конвейер: сырой res.write в обход
     ограничителя вернул бы ту самую ошибку, из-за которой очередь врала. */
  st.heartbeat = setInterval(function () {
    st.heartbeats++;
    pushControl(st, ': ping\n\n', 'heartbeat');
  }, 15000);
  if (typeof st.heartbeat.unref === 'function') st.heartbeat.unref();

  lobby.lastSseAt = now();
  lobby.totals.streamsOpened++;
  lobbyLog(lobby, 'sse-open', {
    playerId: p.id, name: p.name, gzip: !!st.gz,
    streams: lobby.streams.size + 1
  });
  if (res.flushHeaders) {
    try { res.flushHeaders(); } catch (e) {}
  }
  return st;
}

/* Освобождение потока. Вызывается ровно один раз на поток (closed-guard):
   закрывает gzip, снимает таймер, чистит очереди, убирает запись из лобби. */
function closeStream(st, reason, hard) {
  if (st.closed) return;
  st.closed = true;
  st.closedReason = reason || st.closedReason;
  if (st.heartbeat) { clearInterval(st.heartbeat); st.heartbeat = null; }
  st.control = [];
  st.controlBytes = 0;
  st.pendingSnapshot = null;
  if (st.gz) {
    var gz = st.gz;
    st.gz = null;
    try { gz.removeAllListeners(); } catch (e) {}
    try { gz.destroy(); } catch (e) {}
  }
  if (st.res) {
    try { st.res.removeListener('drain', st.onDrain); } catch (e) {}
    try { st.res.removeListener('close', st.onResClose); } catch (e) {}
    try { st.res.removeListener('error', st.onResError); } catch (e) {}
    try { if (!st.res.destroyed && !st.res.writableEnded) {
      if (hard) st.res.destroy();
      else st.res.end();
    } } catch (e) {}
  }
  if (st.res) st.res.__stream = null;
  if (st.lobby) {
    st.lobby.lastSseAt = now();
    if (st.lobby.totals) {
      st.lobby.totals.streamsClosed++;
      st.lobby.totals.rawBytes += st.rawBytes;
      st.lobby.totals.gzipBytes += st.gzipBytes;
      st.lobby.totals.wireBytes += st.wireBytes;
      st.lobby.totals.dropped += st.dropped;
      st.lobby.totals.coalesced += st.coalesced;
      st.lobby.totals.droppedControls += st.droppedControls;
    }
    lobbyLog(st.lobby, 'sse-close', {
      playerId: st.playerId, reason: st.closedReason,
      rawBytes: st.rawBytes, gzipBytes: st.gzipBytes, wireBytes: st.wireBytes,
      dropped: st.dropped, coalesced: st.coalesced,
      droppedControls: st.droppedControls,
      errors: st.errors.length
    });
  }
}

/* Закрытие соединения. Если поток уже заменён новым (переподключение), не
   объявляем peer-left и не помечаем игрока offline: живой поток важнее
   запоздалого close. */
function onStreamClosed(lobby, p, st, reason) {
  if (st.closed) return;
  var current = lobby.streams.get(p.id) === st;
  if (current) lobby.streams.delete(p.id);
  closeStream(st, reason, true);
  if (!current) return;
  if (lobby.players.indexOf(p) < 0) return;
  if (lobby.started) {
    broadcast(lobby, 'peer-left', {
      id: p.id, name: p.name,
      owner: p.owner === undefined ? 0 : p.owner,
      host: p.id === lobby.hostId
    });
    markOffline(lobby, p);
    return;
  }
  markOffline(lobby, p);
}

/* Запись события в поток (совместимость с прежними вызовами). */
function streamWrite(res, text) {
  var st = res && res.__stream;
  if (st) { pushControl(st, text, 'raw'); return; }
  try { res.write(text); } catch (e) { /* поток уже закрыт */ }
}

function send(res, type, data) {
  streamWrite(res, eventText(type, data));
}

/* Снимки — в слот «последний» каждого потока (coalesce), всё остальное — в
   отдельную управляющую очередь. Так тысяча промежуточных кадров не может
   вытеснить command-result или host-left. */
function broadcast(lobby, type, data, exceptId, opts) {
  var text;
  try { text = eventText(type, data); }
  catch (e) { lobbyLog(lobby, 'event-error', { type: type, message: e.message }); return; }
  var seq = data && typeof data.seq === 'number' ? data.seq : null;
  lobby.streams.forEach(function (st, id) {
    if (exceptId !== undefined && id === exceptId) return;
    if (type === 'snapshot') pushSnapshot(st, text, seq, now());
    else pushControl(st, text, type);
  });
}

/* Сколько байт ещё не ушло самому отстающему потоку. В отличие от прежней
   версии это НЕ только res.writableLength: в сумму входят буферы gzip и
   слот ожидающего снимка. Именно по этому числу хост редеет кадры
   (play.js: NET_QUEUE_HIGH = 24 КБ), поэтому 12 МБ в zlib больше не могут
   выглядеть как queue: 0. */
function streamBacklog(lobby) {
  var max = 0, total = 0, count = 0, maxAge = 0, wireMax = 0;
  lobby.streams.forEach(function (st) {
    if (st.closed) return;
    var q = streamQueueBytes(st);
    var w = streamWireQueued(st);
    var age = 0;
    if (st.pendingSnapshot) age = now() - st.pendingSnapshot.at;
    else if (q > 0 && st.snapPushedAt) age = now() - st.snapPushedAt;
    if (q > max) max = q;
    if (w > wireMax) wireMax = w;
    if (age > maxAge) maxAge = age;
    total += q;
    count++;
  });
  return { queue: max, total: total, streams: count, ageMs: maxAge, wireQueue: wireMax };
}

function playerByToken(lobby, t) {
  if (!lobby || !t) return null;
  for (const p of lobby.players) if (p.token === t) return p;
  return null;
}

function lobbyForRequest(q) {
  return lobbies.get(String(q.code || '').toUpperCase());
}

/* Игрок приходит и уходит, а лобби живёт. Связь рвётся молча (ноутбук уснул,
   Wi-Fi моргнул) — это не повод выкидывать готового игрока: помечаем offline,
   даём OFFLINE_GRACE на переподключение и только потом убираем. */
function addPlayer(lobby, name, proto, clientBuild) {
  const colors = ['#4a90d9', '#d94a4a', '#9b59b6', '#e0a030'];
  const id = lobby.nextId++;
  const p = {
    id: id, name: String(name || ('Игрок ' + (id + 1))).slice(0, 24),
    ready: false, token: token(), color: colors[id % colors.length],
    joined: now(), lastSeen: now(), online: true, goneAt: 0, timer: null,
    owner: undefined,
    /* Версия клиента — только для предупреждения, не для отказа. */
    proto: (typeof proto === 'number' && isFinite(proto)) ? proto : 0,
    clientBuild: clientBuild ? String(clientBuild).slice(0, 32) : ''
  };
  lobby.players.push(p);
  return p;
}

/* Любой запрос игрока — доказательство, что он ещё здесь. Снимки хоста идут
   POST-ом и переживают обрыв SSE; считать хоста пропавшим только по SSE
   нельзя. */
function touchPlayer(p) {
  if (p) p.lastSeen = now();
}

function hostLeft(lobby, p, reason) {
  if (lobby.hostGone) return;
  lobby.hostGone = true;
  lobby.hostGoneReason = reason || 'host-lost';
  if (lobby.hostTimer) { clearTimeout(lobby.hostTimer); lobby.hostTimer = null; }
  const t = now();
  lobbyLog(lobby, 'host-timeout', {
    playerId: p.id, name: p.name, reason: lobby.hostGoneReason,
    lastSeenAgeMs: Math.max(0, t - (p.lastSeen || 0)),
    lastSnapshotAt: lobby.lastSnapAt || null,
    lastSnapshotAgeMs: lobby.lastSnapAt ? Math.max(0, t - lobby.lastSnapAt) : null,
    lastSseAt: lobby.lastSseAt || null,
    lastSseAgeMs: lobby.lastSseAt ? Math.max(0, t - lobby.lastSseAt) : null,
    snapSeq: lobby.lastSnapSeq || 0,
    cmdQueue: lobby.cmdQueue.length,
    graceMs: HOST_GRACE
  });
  broadcast(lobby, 'host-left', {
    id: p.id, name: p.name, owner: p.owner === undefined ? 0 : p.owner, host: true
  });
  broadcast(lobby, 'lobby', lobbyView(lobby));
  console.log('  лобби ' + lobby.code + ': хост ' + p.name + ' потерян');
}

function hostBack(lobby, p) {
  if (!lobby.hostGone) return;
  lobby.hostGone = false;
  if (lobby.hostTimer) { clearTimeout(lobby.hostTimer); lobby.hostTimer = null; }
  lobby.hostGoneReason = null;
  lobbyLog(lobby, 'host-back', {
    playerId: p.id, name: p.name,
    lastSnapshotAgeMs: lobby.lastSnapAt ? Math.max(0, now() - lobby.lastSnapAt) : null,
    snapSeq: lobby.lastSnapSeq || 0
  });
  broadcast(lobby, 'host-back', {
    id: p.id, name: p.name, owner: p.owner === undefined ? 0 : p.owner, host: true
  });
  broadcast(lobby, 'lobby', lobbyView(lobby));
  console.log('  лобби ' + lobby.code + ': хост ' + p.name + ' вернулся');
}

function dropPlayer(lobby, p) {
  if (p.timer) { clearTimeout(p.timer); p.timer = null; }
  lobbyLog(lobby, 'player-dropped', {
    playerId: p.id, name: p.name, host: p.id === lobby.hostId,
    lastSeenAgeMs: Math.max(0, now() - (p.lastSeen || 0)),
    snapSeq: lobby.lastSnapSeq || 0
  });
  lobby.players = lobby.players.filter(function (x) { return x !== p; });
  const stream = lobby.streams.get(p.id);
  if (stream) {
    lobby.streams.delete(p.id);
    closeStream(stream, 'player-dropped', true);
  }
  if (!lobby.players.length) {
    if (lobby.hostTimer) clearTimeout(lobby.hostTimer);
    /* Последний игрок ушёл — партия кончилась. Не просто забываем лобби:
       останавливаем worker и убираем состояние, иначе комната занимает
       слот MAX_ACTIVE_ROOMS и воскресает после перезапуска Node. */
    closeLobby(lobby, 'empty');
    return;
  }
  if (lobby.hostId === p.id && lobby.started) {
    /* В партии мир живёт во вкладке хоста: передать его нельзя. Честно
       говорим клиентам, что игра остановлена, вместо замершего кадра. */
    hostLeft(lobby, p, 'player-left');
  } else if (lobby.started) {
    broadcast(lobby, 'peer-left', {
      id: p.id, name: p.name,
      owner: p.owner === undefined ? 0 : p.owner,
      host: false
    });
  } else if (lobby.hostId === p.id) {
    const next = lobby.players.find(function (x) { return x.online !== false; }) || lobby.players[0];
    lobby.hostId = next.id;
    console.log('  лобби ' + lobby.code + ': хост ушёл, теперь ' + next.name);
  }
  broadcast(lobby, 'lobby', lobbyView(lobby));
}

/* --------------------- неактивные партии ------------------------------- *
 *
 * Заказчик 2026-10-29: «неактивные партии спустя 30 секунд удалялись».
 * Причина: комната живёт в worker'е и после ухода игроков, занимает
 * единственный слот MAX_ACTIVE_ROOMS, а после рестарта Node ещё и
 * поднимается из checkpoint — новая партия получает server_capacity
 * («на сервере уже идёт другая партия»).
 *
 * «Неактивна» — нет живого SSE ни у одного игрока И никто не обращался к
 * серверу дольше INACTIVE_TTL. Скрытая вкладка держит SSE, поэтому фон
 * живую партию не убивает; F5 успевает вернуться за окно.
 * ---------------------------------------------------------------------- */

/* Каталог комнаты удаляется целиком: иначе restoreLobbies() поднимет её
   после перезапуска, и она снова займёт слот. */
function removeRoomState(roomId) {
  const id = String(roomId || '');
  if (!/^[A-Z0-9]{4,12}$/.test(id)) return;
  try {
    fs.rmSync(path.join(STATE_DIR, id), { recursive: true, force: true });
  } catch (e) {
    console.error('  комната ' + id + ': состояние не удалено — ' +
      String(e && e.message || e));
  }
}

/* Остановка комнаты: сначала штатный shutdown, чтобы worker дописал
   checkpoint, потом terminate (если не вышел за 3 с) и удаление каталога. */
function stopRoom(lobby, reason) {
  const rec = roomFor(lobby);
  if (!rec) { removeRoomState(lobby.code); return; }
  let finished = false;
  const finish = function () {
    if (finished) return;
    finished = true;
    try { if (rec.worker) rec.worker.terminate(); } catch (e) {}
    roomRecords.delete(rec.roomId);
    const t = setTimeout(function () { removeRoomState(rec.roomId); }, 300);
    if (t.unref) t.unref();
  };
  try {
    rec.worker.postMessage({
      type: 'shutdown', roomId: rec.roomId,
      workerGeneration: rec.generation, reason: reason || 'closed'
    });
  } catch (e) { /* worker уже вышел */ }
  try { rec.worker.once('exit', finish); } catch (e) {}
  const timer = setTimeout(finish, 3000);
  if (timer.unref) timer.unref();
}

function closeLobby(lobby, reason) {
  if (!lobby || lobbies.get(lobby.code) !== lobby) return;
  lobbies.delete(lobby.code);
  if (lobby.hostTimer) { clearTimeout(lobby.hostTimer); lobby.hostTimer = null; }
  lobby.players.forEach(function (p) {
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
  });
  const streams = Array.from(lobby.streams.values());
  lobby.streams.clear();
  streams.forEach(function (st) {
    try { closeStream(st, 'lobby-closed', true); } catch (e) {}
  });
  stopRoom(lobby, reason);
  console.log('  лобби ' + lobby.code + ': закрыто (' + (reason || 'closed') + ')');
}

function lobbyActive(lobby, t) {
  if (!lobby) return false;
  if (lobby.streams && lobby.streams.size) return true;
  for (const p of lobby.players) {
    if (t - (p.lastSeen || 0) < INACTIVE_TTL) return true;
  }
  return false;
}

function sweepInactiveLobbies() {
  const t = now();
  for (const [code, lobby] of lobbies) {
    if (lobbyActive(lobby, t)) { lobby.inactiveSince = 0; continue; }
    if (!lobby.inactiveSince) { lobby.inactiveSince = t; continue; }
    if (t - lobby.inactiveSince >= INACTIVE_TTL) closeLobby(lobby, 'inactive');
  }
}

function markOffline(lobby, p) {
  if (lobby.players.indexOf(p) < 0) return;
  /* Пока старый поток закрывался, игрок мог успеть открыть новый. Живой
     поток важнее события close: иначе переподключение гонкой превращалось бы
     в «нет связи» у только что вернувшегося. */
  if (lobby.streams.has(p.id)) return;
  p.online = false;
  p.goneAt = now();
  lobbyLog(lobby, 'player-offline', {
    playerId: p.id, name: p.name, host: p.id === lobby.hostId,
    started: !!lobby.started,
    lastSeenAgeMs: Math.max(0, now() - (p.lastSeen || 0)),
    snapSeq: lobby.lastSnapSeq || 0
  });
  broadcast(lobby, 'lobby', lobbyView(lobby));
  if (lobby.started) {
    /* Хосту даём время вернуться: EventSource переподключается сам. Если за
       это время не было ни SSE, ни снапшота — партия честно встаёт. */
    if (lobby.hostId === p.id) {
      if (lobby.hostTimer) clearTimeout(lobby.hostTimer);
      lobby.hostTimer = setTimeout(function () {
        lobby.hostTimer = null;
        if (lobby.hostGone || p.online) return;
        if (now() - p.lastSeen < HOST_GRACE) {
          markOffline(lobby, p);          // продлить: хост ещё шлёт снимки
          return;
        }
        if (lobbies.get(lobby.code) === lobby) hostLeft(lobby, p, 'host-timeout');
      }, HOST_GRACE);
      if (typeof lobby.hostTimer.unref === 'function') lobby.hostTimer.unref();
    }
    return;                              // в партии уход — это peer-left, не вылет
  }
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(function () {
    p.timer = null;
    if (!p.online && lobbies.get(lobby.code) === lobby) {
      dropPlayer(lobby, p);
      console.log('  лобби ' + lobby.code + ': ' + p.name + ' не вернулся — убран');
    }
  }, OFFLINE_GRACE);
  if (typeof p.timer.unref === 'function') p.timer.unref();
}

/* --------------------------- команды: результаты ---------------------- *
 *
 * Очередь — только «ещё не решено». Как только хост сказал результат
 * (`cmdDone` в снимке) или команда протухла/вытеснена, она уходит из очереди
 * в карту результатов. Клиент узнаёт правду опросом `/api/command-state`, а
 * не по HTTP 200 на приёме.
 *
 * Почему нельзя чистить очередь только по `cmdAck`: ack — ВОДЯНОЙ ЗНАК
 * («всё до n решено»), а номера n у отправителя разрежены и приходят не в
 * порядке приёма. Поздняя команда с меньшим n, принятая ПОСЛЕ более новой,
 * при чисто арочном сравнении исчезла бы, ни разу не доехав до хоста.
 * Поэтому ack снимает только уже отданные хосту команды (cmdDelivered), а
 * точный результат приносит `cmdDone`.
 * ---------------------------------------------------------------------- */

function cmdKey(from, n) {
  return String(from) + ':' + String(n);
}

/* Окончательный результат или null. Просроченные записи выкидываем лениво:
 * отдельный таймер на каждое лобби не нужен, состояние и так трогают на
 * каждом снимке и опросе. */
function cmdResultOf(lobby, from, n) {
  const key = cmdKey(from, n);
  const r = lobby.cmdResults.get(key);
  if (r) {
    if (r.decidedAt && now() - r.decidedAt > CMD_RESULT_TTL) {
      lobby.cmdResults.delete(key);
    } else {
      return r;
    }
  }
  /* История ответов ограничена. Вытесненный ответ не должен превращать
     повтор в новое действие: компактное «надгробие» помнит пару (from,n) и
     итоговое состояние, пока не истечёт его собственный, более долгий TTL. */
  const seen = lobby.cmdSeen.get(key);
  if (!seen) return null;
  if (seen.decidedAt && now() - seen.decidedAt > CMD_SEEN_TTL) {
    lobby.cmdSeen.delete(key);
    return null;
  }
  return {
    from: from, n: n, sn: seen.sn || 0, state: seen.state,
    reason: seen.reason || '', at: seen.at || 0,
    decidedAt: seen.decidedAt || 0, compact: true,
    ids: seen.ids || [], appliedSeq: seen.appliedSeq || 0
  };
}

function findQueued(lobby, from, n) {
  for (let i = 0; i < lobby.cmdQueue.length; i++) {
    const c = lobby.cmdQueue[i];
    if (c.from === from && c.n === n) return c;
  }
  return null;
}

function rememberCmdResult(lobby, from, n, state, reason, extra) {
  if (!CMD_FINAL[state]) return null;
  const key = cmdKey(from, n);
  const prev = lobby.cmdResults.get(key);
  /* Первое решение — окончательное: просрочка не должна переписать уже
     доехавшее «applied», а повторный cmdDone — «rejected». Но если повтор
     принёс ids/appliedSeq, которых не было в первом ответе (например,
     сначала сработал cmdAck, потом точный cmdDone), их НЕ ТЕРЯЕМ. */
  if (prev && CMD_FINAL[prev.state]) {
    if (extra && Array.isArray(extra.ids) && extra.ids.length) {
      prev.ids = extra.ids.slice(0, 32).map(function (x) { return String(x).slice(0, 40); });
    }
    if (extra && typeof extra.appliedSeq === 'number' && isFinite(extra.appliedSeq)) {
      prev.appliedSeq = extra.appliedSeq;
    }
    if (lobby.cmdSeen.has(key)) {
      const seen = lobby.cmdSeen.get(key);
      if (prev.ids) seen.ids = prev.ids;
      if (prev.appliedSeq) seen.appliedSeq = prev.appliedSeq;
    }
    return prev;
  }
  const rec = {
    from: from, n: n,
    sn: extra && typeof extra.sn === 'number' ? extra.sn : (prev && prev.sn) || 0,
    state: state,
    reason: reason ? String(reason).slice(0, 160) : '',
    at: (extra && typeof extra.at === 'number') ? extra.at : (prev && prev.at) || now(),
    /* UX-01: какие постройки созданы/изменены и на какой версии мира это
       применилось. Сервер эти поля НЕ ВЫБРАСЫВАЕТ: иначе клиент не может
       сопоставить подтверждение с объектом после возврата в партию. */
    ids: Array.isArray(extra && extra.ids)
      ? extra.ids.slice(0, 32).map(function (x) { return String(x).slice(0, 40); })
      : (prev && prev.ids) || [],
    appliedSeq: (extra && typeof extra.appliedSeq === 'number' && isFinite(extra.appliedSeq))
      ? extra.appliedSeq : ((prev && prev.appliedSeq) || 0),
    decidedAt: now()
  };
  lobby.cmdResults.set(key, rec);
  while (lobby.cmdResults.size > CMD_RESULT_MAX) {
    const first = lobby.cmdResults.keys().next();
    if (first.done) break;
    lobby.cmdResults.delete(first.value);
  }
  /* «Надгробие» — без тела команды и без длинной причины: только то, что
     нужно, чтобы повтор не выполнился второй раз. */
  lobby.cmdSeen.set(key, {
    state: rec.state, sn: rec.sn, at: rec.at,
    reason: rec.reason.slice(0, 80), decidedAt: rec.decidedAt,
    ids: rec.ids, appliedSeq: rec.appliedSeq
  });
  while (lobby.cmdSeen.size > CMD_SEEN_MAX) {
    const firstSeen = lobby.cmdSeen.keys().next();
    if (firstSeen.done) break;
    lobby.cmdSeen.delete(firstSeen.value);
  }
  return rec;
}

/* Результат уходит отправителю сразу, если его SSE жив. Это только ускорение
 * для интерфейса: правду всё равно отдаёт /api/command-state, потому что SSE
 * мог оборваться. */
function notifyCmdResult(lobby, rec) {
  const stream = lobby.streams.get(rec.from);
  if (!stream) return;
  pushControl(stream, eventText('command-result', {
    n: rec.n, sn: rec.sn, state: rec.state, reason: rec.reason,
    commandId: rec.n, ageMs: Math.max(0, now() - (rec.at || now())),
    ids: rec.ids || [], appliedSeq: rec.appliedSeq || 0
  }), 'command-result');
}

function decideCmd(lobby, q, state, reason) {
  const rec = rememberCmdResult(lobby, q.from, q.n, state, reason,
    { sn: q.sn, at: q.at });
  if (rec) {
    lobbyLog(lobby, 'cmd-decided', {
      from: q.from, n: q.n, sn: q.sn, type: q.type || '',
      state: rec.state, reason: rec.reason,
      ids: (rec.ids || []).length, appliedSeq: rec.appliedSeq || 0,
      ageMs: Math.max(0, now() - (q.at || now()))
    });
    notifyCmdResult(lobby, rec);
  }
  return rec;
}

function dropQueued(lobby, from, n) {
  for (let i = 0; i < lobby.cmdQueue.length; i++) {
    const c = lobby.cmdQueue[i];
    if (c.from === from && c.n === n) {
      lobby.cmdQueue.splice(i, 1);
      return c;
    }
  }
  return null;
}

/* Просрочка: команда, которую хост не забрал за CMD_TTL, получает expired и
 * уходит из очереди. Это не «молчаливая потеря»: клиент видит результат
 * опросом, даже если снимков не было вовсе. */
function sweepCommands(lobby) {
  if (!lobby.cmdQueue.length) return;
  const t = now();
  const keep = [];
  for (const c of lobby.cmdQueue) {
    const takenAt = lobby.cmdDelivered.get(cmdKey(c.from, c.n));
    const delivered = typeof takenAt === 'number';
    const age = t - (delivered ? takenAt : (c.at || 0));
    const ttl = delivered ? CMD_DELIVERED_TTL : CMD_TTL;
    if (age > ttl) {
      decideCmd(lobby, c, 'expired', delivered
        ? 'хост забрал, но не ответил за ' + Math.round(CMD_DELIVERED_TTL / 1000) + ' с'
        : 'просрочена: хост не забрал за ' + Math.round(CMD_TTL / 1000) + ' с');
    } else {
      keep.push(c);
    }
  }
  lobby.cmdQueue = keep;
}

/* Что хосту пора выполнить. Забирается в ответе на снимок.
 *
 * snapshot.cmdDone — точные результаты: [{from,n,state|status,reason}].
 * snapshot.cmdAck — старое подтверждение водяным знаком; снимает ТОЛЬКО
 * команды, которые уже отдавались хосту.
 * Возвращает очередь в порядке sn (приёма) и помечает отданное. */
function pendingCommands(lobby, snapshot) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};

  /* 1. Точные результаты хоста. */
  const done = Array.isArray(snap.cmdDone) ? snap.cmdDone : null;
  if (done) {
    const lim = Math.min(done.length, CMD_DONE_ACCEPT);
    for (let i = 0; i < lim; i++) {
      const d = done[i];
      if (!d || typeof d !== 'object') continue;
      const state = String(d.state || d.status || '');
      if (!CMD_FINAL[state]) continue;
      const from = d.from, n = d.n;
      if (from === undefined || typeof n !== 'number') continue;
      const q = dropQueued(lobby, from, n);
      const rec = rememberCmdResult(lobby, from, n, state, d.reason,
        { sn: (q && q.sn) || d.sn, at: q && q.at,
          ids: d.ids, appliedSeq: d.appliedSeq });
      /* Повтор того же результата в соседних снимках не должен слать
         command-result второй раз. */
      if (rec && q) notifyCmdResult(lobby, rec);
    }
  }

  /* 2. Старое подтверждение водяным знаком. Только для уже отданных команд:
     иначе поздняя команда с меньшим n исчезла бы, не доехав. */
  const ack = snap.cmdAck;
  if (ack && typeof ack === 'object') {
    const keep = [];
    for (const c of lobby.cmdQueue) {
      const sent = ack[String(c.from)];
      const covered = sent !== undefined && typeof c.n === 'number' && c.n <= sent;
      if (covered && lobby.cmdDelivered.has(cmdKey(c.from, c.n))) {
        const rec = rememberCmdResult(lobby, c.from, c.n, 'applied',
          'подтверждено хостом (cmdAck)', { sn: c.sn, at: c.at });
        if (rec) notifyCmdResult(lobby, rec);
      } else {
        keep.push(c);
      }
    }
    lobby.cmdQueue = keep;
  }

  /* 3. Просрочка — с результатом. */
  sweepCommands(lobby);

  /* 4. Отдаём в порядке приёма и запоминаем, что эти команды хост увидел. */
  lobby.cmdQueue.sort(function (a, b) { return (a.sn || 0) - (b.sn || 0); });
  const t = now();
  const live = new Set();
  let fresh = 0, maxAge = 0;
  for (const c of lobby.cmdQueue) {
    const key = cmdKey(c.from, c.n);
    live.add(key);
    if (!lobby.cmdDelivered.has(key)) fresh++;
    /* Возраст считает СЕРВЕР по своим часам на момент выдачи. Хост берёт
       ageMs, а не cmd.at: часы компьютера хоста и сервера расходятся, и
       прежняя проверка `Date.now() - cmd.at > 20000` объявляла свежую
       команду просроченной (или наоборот). `at` оставлен для совместимости. */
    c.ageMs = Math.max(0, t - (c.at || t));
    if (c.ageMs > maxAge) maxAge = c.ageMs;
    lobby.cmdDelivered.set(key, t);
  }
  if (fresh) {
    lobbyLog(lobby, 'commands-delivered', {
      count: fresh, queue: lobby.cmdQueue.length,
      maxAgeMs: maxAge, oldestSn: lobby.cmdQueue.length ? lobby.cmdQueue[0].sn : null
    });
  }
  /* Не копим отметки о командах, которых уже нет в очереди. */
  if (lobby.cmdDelivered.size > lobby.cmdQueue.length) {
    for (const key of lobby.cmdDelivered.keys()) {
      if (!live.has(key)) lobby.cmdDelivered.delete(key);
    }
  }
  return lobby.cmdQueue;
}

/* ------------------------------- старт -------------------------------- */
function chooseStart(lobby) {
  const n = lobby.players.length;
  for (let attempt = 0; attempt < 40; attempt++) {
    const seed = randomSeed();
    try {
      const world = WG.generate({ seed: seed, size: lobby.size });
      const sites = WG.spawnSites(world, n);
      if (sites.length >= n) {
        return { seed: seed, size: lobby.size, sites: sites };
      }
    } catch (e) { /* следующий сид */ }
  }
  return null;
}

/* Почему старт не случился — словами. Раньше сервер молча возвращал null, и
   игроки видели «оба готовы, а ничего не происходит» без единой подсказки. */
function startBlock(lobby) {
  if (lobby.started) return null;
  if (lobby.hostGone) {
    return { reason: 'хост потерял связь', waiting: 1 };
  }
  if (lobby.players.length < 2) {
    return { reason: 'нужен ещё один игрок', waiting: 2 - lobby.players.length };
  }
  const notReady = lobby.players.filter(function (p) { return !p.ready; });
  if (notReady.length) {
    return {
      reason: 'не все готовы: ' + notReady.map(function (p) { return p.name; }).join(', '),
      waiting: notReady.length
    };
  }
  return null;
}

function startLobby(lobby) {
  if (lobby.started) return { ok: true, already: true };
  const block = startBlock(lobby);
  if (block) return { ok: false, reason: block.reason, waiting: block.waiting };
  const start = chooseStart(lobby);
  if (!start) return { ok: false, reason: 'не удалось выбрать остров — нажмите «Начать игру» ещё раз', waiting: 0 };

  lobby.started = true;
  lobby.seed = start.seed;
  /* Владелец в партии — ПОРЯДКОВЫЙ НОМЕР в списке, а не id лобби: id остаётся
     стабильным между переподключениями, и дыра в нумерации не должна
     сдвигать деревни. По этому номеру летят owner у построек и жителей. */
  lobby.players.forEach(function (p, i) { p.owner = i; });
  const payload = {
    seed: start.seed, size: start.size, sites: start.sites,
    hostId: lobby.hostId,
    /* Сервер принимает снимок, сжатый gzip (см. readJson). Клиент включает
       сжатие только по этому флагу: старый сервер такого тела не поймёт.
       Нужно это для VPS-режима: там снимок идёт с домашнего интернета хоста
       на релей, и 5,2 КБ × 12,5 в секунду — те же 520 Кбит/с вверх. */
    snapGzip: true,
    /* Протокол команд: 2 — есть sn, cmdDone и /api/command-state. Клиент по
       этому флагу понимает, что 200 на /api/command — только «в очереди», и
       ждёт конечный результат опросом. Старый сервер флага не шлёт. Формат
       команд не ломался, поэтому cmdProto остаётся 2; общий номер протокола
       сервера (3) и сборка едут отдельными полями — по ним видно, что
       запущено, и они не меняют поведение старого клиента. */
    cmdProto: CMD_PROTO,
    protocol: PROTOCOL,
    build: buildId(),
    protocolWarning: protocolWarning(lobby),
    serverNow: now(),
    cmdTtl: CMD_TTL,
    players: lobby.players.map(function (p, i) {
      return { id: p.id, name: p.name, owner: i, color: p.color };
    })
  };
  lobby.startPayload = payload;
  lobbyLog(lobby, 'start', {
    seed: start.seed, size: start.size, players: lobby.players.length,
    build: buildId(), protocol: PROTOCOL,
    protocolWarning: payload.protocolWarning
  });
  broadcast(lobby, 'start', payload);
  console.log('  лобби ' + lobby.code + ': старт, сид «' + start.seed + '», ' +
    lobby.players.length + ' игрока');
  return { ok: true, seed: start.seed };
}

/* ------------------------------ статика ------------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

/* Наружу отдаём только игру и движок. Корень репозитория (с .git, доками и
   инструментами) в сеть не уходит: сервер теперь слушает не только localhost. */
const STATIC_ROOTS = ['/game/', '/mapgen2/'];

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (e) { res.writeHead(400); res.end('bad url'); return; }
  if (urlPath === '/' || urlPath === '/game') urlPath = '/game/';
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  if (!STATIC_ROOTS.some(function (r) { return urlPath.startsWith(r); })) {
    res.writeHead(404); res.end('not found'); return;
  }
  const file = path.resolve(ROOT, '.' + urlPath);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    /* ETag/Last-Modified — чтобы повторная загрузка 10 МБ атласов не тянула
       их заново: браузер присылает If-None-Match и получает 304. Без этого
       Cache-Control: no-cache заставлял скачивать всё при каждом входе. */
    const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const cache = {
      'Cache-Control': 'no-cache',
      'ETag': etag,
      'Last-Modified': st.mtime.toUTCString()
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, cache);
      res.end();
      return;
    }
    fs.readFile(file, function (err2, data) {
      if (err2) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, Object.assign({
        'Content-Type': MIME[ext] || 'application/octet-stream'
      }, cache));
      res.end(data);
    });
  });
}

/* ------------------------------- тело -------------------------------- *
 * Тело принимаем и обычным, и сжатым. В VPS-режиме снимок идёт с домашнего
 * интернета хоста на релей; 5,2 КБ двенадцать раз в секунду — это 520 Кбит/с
 * ВВЕРХ, тот самый общий и узкий канал. gzip сжимает тело в ~7 раз, и
 * `CompressionStream` в браузере делает то же, что здесь `gunzip`.
 * `maxOutputLength` не даёт сжатому телу развернуться в гигабайты. */
/* Тело принимаем и обычным, и сжатым. В VPS-режиме снимок идёт с домашнего
 * интернета хоста на релей; 5,2 КБ двенадцать раз в секунду — это 520 Кбит/с
 * ВВЕРХ, тот самый общий и узкий канал. gzip сжимает тело в ~7 раз, и
 * `CompressionStream` в браузере делает то же, что здесь `gunzip`.
 * `maxOutputLength` не даёт сжатому телу развернуться в гигабайты.
 *
 * РАЗБОР И ВЫПОЛНЕНИЕ РАЗДЕЛЕНЫ. Раньше JSON.parse и бизнес-callback были в
 * одном try/catch: исключение обработчика (например, `.find` по undefined)
 * ловилось как «битый JSON» и вызывало cb(null) ВТОРОЙ раз — уже после того,
 * как обработчик успел ответить, или вместо честной 500. Теперь:
 *   • битый JSON / битый gzip / пустое тело → 400;
 *   • слишком большое тело → 413 и закрытие;
 *   • исключение callback → 500 ровно один раз, если ответа ещё не было;
 *     если ответ уже ушёл — сокет закрывается, второго ответа нет;
 *   • обрыв сокета → никакого ответа и никакого callback.
 * `send` внутри readJson — единственный писатель ошибок разбора.
 */
const MAX_BODY = 4 * 1024 * 1024;
const MAX_UNZIP = 8 * 1024 * 1024;

function readJson(req, res, cb) {
  const chunks = [];
  let size = 0;
  let settled = false;
  let aborted = false;

  function send(status, obj) {
    if (settled || aborted) return;
    settled = true;
    try { json(res, status, obj); } catch (e) { try { res.destroy(); } catch (x) {} }
  }
  function dispatch(raw) {
    if (settled || aborted) return;
    const text = raw.toString('utf8');
    if (!text.trim()) { send(400, { ok: false, reason: 'пустое тело' }); return; }
    let body;
    try { body = JSON.parse(text); }
    catch (e) {
      serverLog('json-broken', {
        path: (req.url || '').split('?')[0], bytes: raw.length,
        message: e.message
      });
      send(400, { ok: false, reason: 'тело не JSON' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(400, { ok: false, reason: 'тело должно быть объектом' });
      return;
    }
    /* callback отвечает сам; исключение из него — 500, а не повтор с null. */
    try { cb(body); }
    catch (e) {
      serverLog('handler-error', {
        path: (req.url || '').split('?')[0],
        message: (e && e.message) || String(e)
      });
      if (!res.headersSent && !res.writableEnded) {
        send(500, { ok: false, reason: 'внутренняя ошибка сервера' });
      } else {
        try { res.destroy(); } catch (x) {}
      }
      return;
    }
    settled = true;
  }

  req.on('data', function (chunk) {
    if (settled || aborted) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      aborted = true;
      chunks.length = 0;
      try {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8',
          'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, reason: 'тело больше 4 МБ' }));
      } catch (e) {}
      try { req.destroy(); } catch (e) {}
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', function () {
    if (settled || aborted) return;
    const buf = Buffer.concat(chunks);
    chunks.length = 0;
    const enc = String(req.headers['content-encoding'] || '').toLowerCase().trim();
    if (enc && enc !== 'identity' && !/\bgzip\b/.test(enc)) {
      send(400, { ok: false, reason: 'неизвестная кодировка тела: ' + enc });
      return;
    }
    if (!/\bgzip\b/.test(enc)) { dispatch(buf); return; }
    zlib.gunzip(buf, { maxOutputLength: MAX_UNZIP }, function (err, out) {
      if (settled || aborted) return;
      if (err) {
        serverLog('gzip-broken', {
          path: (req.url || '').split('?')[0], bytes: buf.length,
          message: err.message
        });
        send(400, { ok: false, reason: 'тело не распознано (gzip)' });
        return;
      }
      dispatch(out);
    });
  });
  /* Обрыв посреди тела: ответа нет, callback не зовём. */
  req.on('aborted', function () { aborted = true; chunks.length = 0; });
  req.on('error', function () { aborted = true; chunks.length = 0; });
  req.on('close', function () {
    if (!req.complete) { aborted = true; chunks.length = 0; }
  });
}

function json(res, status, obj) {
  try { if (res.socket) res.socket.setNoDelay(true); } catch (e) {}
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function statusView(lobby) {
  const rec = roomFor(lobby);
  return {
    ok: true,
    lobby: lobbyView(lobby),
    started: lobby.started,
    start: lobby.started ? lobby.startPayload : null,
    room: roomSummary(rec),
    block: startBlock(lobby)
  };
}


/* ---- диагностика (OBS-01) -------------------------------------------- *
 *
 * /api/diag и /api/stream-stats отдают только ХОСТУ лобби (по коду и
 * токену). В ответе нет токенов, секретов и тел команд — только счётчики,
 * имена, очереди и кольцо журнала. Это диагностика, а не второй пульт
 * управления: ни один эндпоинт здесь не меняет игру.
 * ---------------------------------------------------------------------- */
function diagPlayer(lobby, p) {
  return {
    id: p.id, name: p.name, owner: p.owner === undefined ? null : p.owner,
    ready: !!p.ready, online: p.online !== false,
    proto: p.proto || 0, clientBuild: p.clientBuild || '',
    lastSeenAgeMs: Math.max(0, now() - (p.lastSeen || 0)),
    hasStream: lobby.streams.has(p.id),
    host: p.id === lobby.hostId
  };
}
function diagLobby(lobby) {
  const t = now();
  const streams = [];
  let queue = 0, wireQueue = 0, queueAge = 0;
  lobby.streams.forEach(function (st) {
    if (st.closed) return;
    const stats = streamStats(st);
    streams.push(stats);
    if (stats.queue > queue) queue = stats.queue;
    if (stats.wireQueue > wireQueue) wireQueue = stats.wireQueue;
    if (stats.ageMs > queueAge) queueAge = stats.ageMs;
  });
  const lastHeartbeat = lobby.players.reduce(function (m, p) {
    return Math.max(m, p.lastSeen || 0);
  }, 0);
  const snap = lobby.lastSnapshot || null;
  return {
    code: lobby.code, started: !!lobby.started, hostId: lobby.hostId,
    hostGone: !!lobby.hostGone, hostGoneReason: lobby.hostGoneReason || null,
    players: lobby.players.map(function (p) { return diagPlayer(lobby, p); }),
    protocol: PROTOCOL, build: buildId(),
    protocolWarning: protocolWarning(lobby),
    lastHeartbeatAt: lastHeartbeat,
    lastHeartbeatAgeMs: lastHeartbeat ? Math.max(0, t - lastHeartbeat) : null,
    lastSnapshotAt: lobby.lastSnapAt || null,
    lastSnapshotAgeMs: lobby.lastSnapAt ? Math.max(0, t - lobby.lastSnapAt) : null,
    lastSseAt: lobby.lastSseAt || null,
    lastSseAgeMs: lobby.lastSseAt ? Math.max(0, t - lobby.lastSseAt) : null,
    tick: snap && snap.simulationTick !== undefined ? snap.simulationTick
      : (snap && snap.t !== undefined ? snap.t : null),
    room: roomSummary(roomFor(lobby)),
    snapshot: snap ? {
      seq: snap.seq === undefined ? null : snap.seq,
      revision: snap.revision === undefined ? null : snap.revision,
      simulationTick: snap.simulationTick === undefined ? null : snap.simulationTick,
      simulationTimeMs: snap.simulationTimeMs === undefined ? null : snap.simulationTimeMs,
      t: snap.t === undefined ? null : snap.t,
      ageMs: lobby.lastSnapAt ? Math.max(0, t - lobby.lastSnapAt) : null,
      bytes: lobby.lastSnapshotBytes || null
    } : null,
    lastSnapSeq: lobby.lastSnapSeq || 0,
    cmdSeq: lobby.cmdSeq || 0,
    cmdQueue: lobby.cmdQueue.length,
    cmdResults: lobby.cmdResults.size,
    cmdSeen: lobby.cmdSeen.size,
    streams: streams,
    queue: queue, queueWire: wireQueue, queueAgeMs: queueAge,
    totals: Object.assign({}, lobby.totals)
  };
}

function diagView(lobby) {
  return {
    ok: true, build: buildId(), protocol: PROTOCOL, cmdProto: CMD_PROTO,
    node: process.version, pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    startedAt: new Date(STARTED_AT_MS).toISOString(),
    now: now(),
    heap: memInfo(),
    eventLoopDelay: loopSnapshot(),
    lobby: diagLobby(lobby),
    limits: {
      ringMax: RING_MAX,
      streamSocketHigh: STREAM_SOCKET_HIGH,
      streamGzipHigh: STREAM_GZIP_HIGH,
      controlMax: STREAM_CONTROL_MAX,
      controlBytes: STREAM_CONTROL_BYTES,
      cmdTtl: CMD_TTL,
      cmdDeliveredTtl: CMD_DELIVERED_TTL,
      cmdResultTtl: CMD_RESULT_TTL,
      cmdSeenTtl: CMD_SEEN_TTL,
      cmdMax: CMD_MAX, cmdResultMax: CMD_RESULT_MAX, cmdSeenMax: CMD_SEEN_MAX
    },
    log: lobby.log.slice(-RING_MAX),
    serverLog: SERVER_LOG.slice(-RING_MAX)
  };
}

function streamStatsView(lobby) {
  const streams = [];
  let queue = 0, wireQueue = 0, queueAge = 0;
  lobby.streams.forEach(function (st) {
    if (st.closed) return;
    const stats = streamStats(st);
    streams.push(stats);
    if (stats.queue > queue) queue = stats.queue;
    if (stats.wireQueue > wireQueue) wireQueue = stats.wireQueue;
    if (stats.ageMs > queueAge) queueAge = stats.ageMs;
  });
  return {
    ok: true, build: buildId(), protocol: PROTOCOL, now: now(),
    streams: streams, streamsCount: streams.length,
    queue: queue, queueWire: wireQueue, queueAgeMs: queueAge,
    totals: Object.assign({}, lobby.totals)
  };
}

/* ------------------------------- сервер ------------------------------- */
async function handleRequest(req, res) {
  const u = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));

  /* Адреса сервера: из них клиент собирает ссылку-приглашение. */
  if (req.method === 'GET' && u.pathname === '/api/server') {
    return json(res, 200, serverView());
  }

  /* Версия сервера и формат протокола — без токена: это не секрет, а метка
     сборки, по которой приёмка и игрок понимают, что запущено. */
  if (req.method === 'GET' && u.pathname === '/api/build') {
    return json(res, 200, buildInfo());
  }

  /* Диагностика лобби — только хосту. Чужие токены и тела команд сюда не
     попадают: в журнале ключи с token/secret вырезаны. */
  if (req.method === 'GET' && u.pathname === '/api/diag') {
    const lobby = lobbyForRequest({ code: u.searchParams.get('code') });
    const p = playerByToken(lobby, u.searchParams.get('token'));
    if (!lobby || !p) return json(res, 403, { ok: false, reason: 'нет доступа' });
    if (p.id !== lobby.hostId) {
      return json(res, 403, { ok: false, reason: 'диагностика только хосту' });
    }
    touchPlayer(p);
    return json(res, 200, diagView(lobby));
  }

  /* Метрики потоков для приёмки NET-01: по каждому клиенту раздельно видно
     сырые, сжатые и проводные байты, очереди gzip/сокета/ожидающего снимка,
     dropped/coalesced и возраст снимка. Только хосту. */
  if (req.method === 'GET' && u.pathname === '/api/stream-stats') {
    const lobby = lobbyForRequest({ code: u.searchParams.get('code') });
    const p = playerByToken(lobby, u.searchParams.get('token'));
    if (!lobby || !p) return json(res, 403, { ok: false, reason: 'нет доступа' });
    if (p.id !== lobby.hostId) {
      return json(res, 403, { ok: false, reason: 'метрики только хосту' });
    }
    touchPlayer(p);
    return json(res, 200, streamStatsView(lobby));
  }

  if (req.method === 'POST' && u.pathname === '/api/lobby') {
    return readJson(req, res, function (body) {
      if (!body) return json(res, 400, { ok: false, reason: 'нет тела' });
      const lobby = makeLobby(body.max);
      const p = addPlayer(lobby, body.name || 'Хост', body.protocol, body.build);
      lobby.hostId = p.id;
      json(res, 200, {
        ok: true, code: lobby.code, token: p.token, playerId: p.id,
        hostId: lobby.hostId, max: lobby.max, players: lobbyView(lobby).players,
        build: buildId(), protocol: PROTOCOL, cmdProto: CMD_PROTO,
        protocolWarning: protocolWarning(lobby)
      });
      lobbyLog(lobby, 'lobby-created', {
        playerId: p.id, name: p.name, max: lobby.max,
        clientProto: p.proto, build: buildId()
      });
      console.log('  лобби ' + lobby.code + ' создано (хост ' + p.name + ')');
    });
  }

  if (req.method === 'POST' && u.pathname === '/api/join') {
    return readJson(req, res, function (body) {
      if (!body) return json(res, 400, { ok: false, reason: 'нет тела' });
      const lobby = lobbies.get(String(body.code || '').toUpperCase());
      if (!lobby) return json(res, 404, { ok: false, reason: 'лобби не найдено — проверьте код' });
      if (lobby.started) return json(res, 409, { ok: false, reason: 'игра уже началась' });
      if (lobby.players.length >= lobby.max) {
        return json(res, 409, { ok: false, reason: 'лобби заполнено' });
      }
      const p = addPlayer(lobby, body.name || ('Игрок ' + (lobby.players.length)),
        body.protocol, body.build);
      json(res, 200, {
        ok: true, code: lobby.code, token: p.token, playerId: p.id,
        hostId: lobby.hostId, max: lobby.max, players: lobbyView(lobby).players,
        build: buildId(), protocol: PROTOCOL, cmdProto: CMD_PROTO,
        protocolWarning: protocolWarning(lobby)
      });
      lobbyLog(lobby, 'player-joined', {
        playerId: p.id, name: p.name, players: lobby.players.length,
        clientProto: p.proto
      });
      broadcast(lobby, 'lobby', lobbyView(lobby));
      console.log('  лобби ' + lobby.code + ': +' + p.name + ' (' + p.id + ')');
      /* Старт — только по кнопке хоста. Автостарт «как только все готовы»
         оставлял за бортом друга, который ещё открывал ссылку: двое нажали
         «Готов» — и лобби на трёх закрылось вдвоём. */
    });
  }

  if (req.method === 'POST' && u.pathname === '/api/ready') {
    return readJson(req, res, function (body) {
      const lobby = lobbyForRequest(body || {});
      const p = playerByToken(lobby, body && body.token);
      if (!p) return json(res, 403, { ok: false, reason: 'нет доступа' });
      if (lobby.started) return json(res, 409, { ok: false, reason: 'игра уже началась' });
      touchPlayer(p);
      p.ready = !!body.ready;
      broadcast(lobby, 'lobby', lobbyView(lobby));
      json(res, 200, { ok: true, ready: p.ready, canStart: !startBlock(lobby) });
    });
  }

  /* Старт по кнопке хоста. Отдельный запрос, а не побочный эффект «готов»:
     хост сам решает, когда состав собран. */
  if (req.method === 'POST' && u.pathname === '/api/start') {
    return readJson(req, res, function (body) {
      const lobby = lobbyForRequest(body || {});
      const p = playerByToken(lobby, body && body.token);
      if (!lobby || !p) return json(res, 403, { ok: false, reason: 'нет доступа' });
      if (p.id !== lobby.hostId) return json(res, 403, { ok: false, reason: 'начинает хост' });
      touchPlayer(p);
      /* Старт асинхронный: worker должен успеть поднять мир и отдать первый
         committed baseline. Пока его нет, лобби остаётся `starting`, а не
         отдаёт пустую running-партию. */
      startRoom(lobby).then(function (started) {
        if (!started.ok && !started.already) {
          return json(res, started.code === 'server_capacity' ? 503 : 409, {
            ok: false, reason: started.reason, canStart: false,
            code: started.code || null
          });
        }
        json(res, 200, { ok: true, already: !!started.already, start: lobby.startPayload });
      }, function (e) {
        json(res, 500, { ok: false, reason: String(e && e.message || e) });
      });
    });
  }

  /* Восстановление остановленной комнаты — только организатор и только
     после явного room-fault. Автоматического повторения упавшего шага нет:
     мир поднимается из checkpoint + журнала, а команды прерванного тика
     получают durable rejected/recovery_interrupted. */
  if (req.method === 'POST' && u.pathname === '/api/recover') {
    return readJson(req, res, function (body) {
      const lobby = lobbyForRequest(body || {});
      const p = playerByToken(lobby, body && body.token);
      if (!lobby || !p) return json(res, 403, { ok: false, reason: 'нет доступа' });
      if (p.id !== lobby.hostId) return json(res, 403, { ok: false, reason: 'восстанавливает организатор' });
      const rec = roomFor(lobby);
      if (!rec || !rec.worker) return json(res, 409, { ok: false, code: 'room_unavailable', reason: 'комната не запущена' });
      if (!rec.fault) return json(res, 409, { ok: false, code: 'room_healthy', reason: 'комната не в ошибке' });
      roomRequest(rec, 'diagnostics', { action: 'recover', reason: 'organizer' }, 20000).then(function (msg) {
        if (!msg.recovery || !msg.recovery.ok) {
          return json(res, 500, { ok: false, code: 'recovery_failed', reason: msg.recovery && msg.recovery.reason || 'не удалось' });
        }
        rec.fault = null;
        rec.status = 'running';
        rec.epoch = msg.recovery.epoch;
        broadcast(lobby, 'room-recovered', { roomId: rec.roomId, epoch: rec.epoch, tick: msg.recovery.tick });
        json(res, 200, { ok: true, room: roomSummary(rec), recovery: msg.recovery, start: lobby.startPayload });
      }, function (e) {
        json(res, 503, { ok: false, code: 'room_unavailable', reason: String(e && e.message || e) });
      });
    });
  }

  /* Опрос лобби. Тот же ответ, что приходит событиями, но по запросу: если
     SSE молчит, состав и уже случившийся старт всё равно доезжают. Сам старт
     здесь не повторяется — его начинает только хост. */
  if (req.method === 'GET' && u.pathname === '/api/status') {
    const lobby = lobbyForRequest({ code: u.searchParams.get('code') });
    const p = playerByToken(lobby, u.searchParams.get('token'));
    if (!lobby || !p) return json(res, 403, { ok: false, reason: 'нет доступа' });
    touchPlayer(p);
    return json(res, 200, statusView(lobby));
  }

  /* Круг для индикатора связи в игре. С кодом и токеном он ещё и
     heartbeat: любой запрос игрока — доказательство, что он здесь. Это
     важно хосту, который может задуматься на кадр дольше обычного: раньше
     его жизнь подтверждали только снимки, и один долгий кадр при оборванном
     SSE выглядел как «хост ушёл». */
  if (req.method === 'GET' && u.pathname === '/api/ping') {
    const code = u.searchParams.get('code');
    const tok = u.searchParams.get('token');
    const c0 = Number(u.searchParams.get('c0'));
    const s1 = monoMs();
    let lobby = null, p = null, rec = null;
    if (code && tok) {
      lobby = lobbyForRequest({ code: code });
      p = playerByToken(lobby, tok);
      if (lobby && p) {
        touchPlayer(p);
        if (lobby.hostGone && p.id === lobby.hostId) hostBack(lobby, p);
        rec = roomFor(lobby);
      }
    }
    const s2 = monoMs();
    const snap = rec && rec.latest ? rec.latest : null;
    /* Часы: echo client-send-time и два серверных отрезка s1/s2. Клиент
       считает RTT = (c3-c0)-(s2-s1) и offset по середине. `ms` из одного
       performance.now() вокруг промиса — не сетевой RTT и здесь не
       используется. */
    const out = {
      ok: true, t: now(),
      clientSendAtMs: isFinite(c0) ? c0 : null,
      serverReceiveAtMs: s1,
      serverSendAtMs: s2,
      serverMonoMs: s2,
      epoch: rec ? rec.epoch : null,
      revision: snap ? snap.revision : null,
      tick: snap ? snap.simulationTick : null,
      simulationTimeMs: snap ? snap.simulationTimeMs : null,
      roomStatus: rec ? (rec.fault ? 'faulted' : (snap ? snap.roomStatus : rec.status)) : 'lobby',
      build: buildId(), protocol: PROTOCOL
    };
    return json(res, 200, out);
  }

  /* Возврат в уже начатую партию после перезагрузки страницы. Токен тот же —
     нового игрока не создаём. Снимок нужен и хосту (по нему он поднимает
     мир), и клиенту (чтобы не мигать пустым островом до первого кадра). */
  if (req.method === 'GET' && u.pathname === '/api/resume') {
    const lobby = lobbyForRequest({ code: u.searchParams.get('code') });
    const p = playerByToken(lobby, u.searchParams.get('token'));
    if (!lobby || !p) return json(res, 403, { ok: false, reason: 'лобби не найдено' });
    touchPlayer(p);
    if (lobby.started && !roomFor(lobby)) {
      try { await ensureRoom(lobby); }
      catch (e) {
        return json(res, 503, { ok: false, code: 'room_unavailable',
          reason: 'комната не поднимается: ' + String(e && e.message || e) });
      }
    }
    if (lobby.started && p.id === lobby.hostId) {
      /* Хост возобновляет нумерацию с последнего снимка, а не с нуля. Сам
         host-back уйдёт вместе с первым снимком: пока мир не поднят, клиенты
         не должны решить, что игра уже идёт. */
      lobby.lastSnapSeq = (lobby.lastSnapshot && lobby.lastSnapshot.seq) || 0;
    }
    const rec = roomFor(lobby);
    const resumed = {
      ok: true,
      started: lobby.started,
      host: p.id === lobby.hostId,
      lobby: lobbyView(lobby),
      start: lobby.started ? lobby.startPayload : null,
      /* База — независимый снимок комнаты, а не «последний мир от хоста».
         По нему клиент применяет структуру и поднимает display-буфер. */
      snapshot: lobby.started ? lobby.lastSnapshot : null,
      baseline: rec ? (rec.latest || rec.baseline) : null,
      room: roomSummary(rec),
      /* Даже если снимка нет, номер последнего кадра нужен: иначе клиент
         после возврата начал бы revision с единицы, а буфер отбросил бы его
         как устаревший. */
      seq: lobby.lastSnapSeq || 0,
      /* Версия и протокол — в том же ответе, что и старт: после F5 клиент
         сверяет сборку до первого кадра, а не после. */
      build: buildId(), protocol: PROTOCOL, cmdProto: CMD_PROTO,
      protocolWarning: protocolWarning(lobby),
      serverNow: now(),
      snapshotBytes: lobby.lastSnapshotBytes || null
    };
    if (lobby.started && rec) {
      const ps = rec.lobby.players.find(function (x) { return x.id === p.id; });
      resumed.session = {
        sessionId: String(p.id), owner: p.owner === undefined ? 0 : p.owner,
        instance: ps ? ('s' + (p.owner || 0) + '-' + crypto.createHash('sha1').update(String(p.id)).digest('hex').slice(0, 8)) : null,
        epoch: rec.epoch,
        roomId: rec.roomId
      };
    }
    lobbyLog(lobby, 'resume', {
      playerId: p.id, host: resumed.host, started: !!lobby.started,
      seq: resumed.seq, build: buildId()
    });
    return json(res, 200, resumed);
  }

  if (req.method === 'GET' && u.pathname === '/api/events') {
    const lobby = lobbyForRequest({ code: u.searchParams.get('code') });
    const p = playerByToken(lobby, u.searchParams.get('token'));
    if (!lobby || !p) { res.writeHead(403); res.end('forbidden'); return; }

    /* Вернулся — отменяем вылет и продолжаем той же записью в лобби. */
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    const back = p.online === false;
    p.online = true;
    p.goneAt = 0;
    touchPlayer(p);
    if (lobby.hostId === p.id && lobby.hostTimer) {
      clearTimeout(lobby.hostTimer);
      lobby.hostTimer = null;
    }

    const old = lobby.streams.get(p.id);
    /* Заголовки, gzip-обёртка, обработчики ошибок и heartbeat — в одном
       месте: поток обязан быть сжатым (или нет) с ПЕРВОГО байта. Смешать
       сырой текст с gzip нельзя. */
    const stream = openEventStream(req, res, lobby, p);
    if (old && old !== stream) {
      /* Старый поток мог висеть на медленном сокете: не ждём его 'drain',
         а освобождаем сразу. Запоздалый close не сочтёт игрока offline —
         новый поток уже лежит в карте (см. onStreamClosed). */
      lobby.streams.delete(p.id);
      closeStream(old, 'replaced', true);
    }
    lobby.streams.set(p.id, stream);
    /* Живой поток — партия активна, отсчёт удаления сбрасывается. */
    lobby.inactiveSince = 0;
    const liveRoom = roomFor(lobby);
    if (liveRoom) roomRequest(liveRoom, 'diagnostics', { empty: false }, 5000).catch(function () {});

    streamWrite(res, 'retry: 1500\n\n');
    send(res, 'hello', { playerId: p.id, hostId: lobby.hostId, lobby: lobbyView(lobby) });
    if (lobby.started && lobby.startPayload) send(res, 'start', lobby.startPayload);
    /* Переподключение посреди партии: последний снимок абсолютный, отдаём его
       сразу. Иначе медленный друг после reconnect ждал бы следующего кадра
       хоста, а хост может быть в фоне. */
    if (lobby.started && lobby.lastSnapshot) {
      send(res, 'snapshot', lobby.lastSnapshot);
    }
    /* Клиент, переподключившийся после падения хоста, обязан узнать, что
       игра стоит, — иначе он будет ждать снимков, которых нет. */
    if (lobby.started && lobby.hostGone && p.id !== lobby.hostId) {
      const host = lobby.players.find(function (x) { return x.id === lobby.hostId; });
      if (host) send(res, 'host-left', { id: host.id, name: host.name,
        owner: host.owner === undefined ? 0 : host.owner, host: true });
    }
    if (lobby.hostId === p.id && back) hostBack(lobby, p);
    if (back && lobby.started && p.id !== lobby.hostId) {
      broadcast(lobby, 'peer-back', {
        id: p.id, name: p.name,
        owner: p.owner === undefined ? 0 : p.owner
      });
    }
    if (back) broadcast(lobby, 'lobby', lobbyView(lobby), p.id);
    return;
  }

  /* Новый MP не принимает мир от браузера. Явный 409, а не тихое сохранение:
     старый клиент/хост должен увидеть, что архитектура другая, а не получить
     ложное «снимок принят». Payload не читается и не сохраняется. */
  if (req.method === 'POST' && u.pathname === '/api/snapshot') {
    try { req.resume(); } catch (e) {}
    return json(res, 409, {
      ok: false, reason: 'мир считает сервер', code: 'server_authoritative',
      protocol: PROTOCOL
    });
  }

  if (req.method === 'POST' && u.pathname === '/api/snapshot') {
    return readJson(req, res, function (body) {
      const lobby = lobbyForRequest(body || {});
      const p = playerByToken(lobby, body && body.token);
      if (!lobby || !p || p.id !== lobby.hostId) {
        return json(res, 403, { ok: false, reason: 'снапшоты шлёт только хост' });
      }
      if (!body.snapshot || typeof body.snapshot !== 'object') {
        return json(res, 400, { ok: false, reason: 'пустой снимок' });
      }
      touchPlayer(p);
      lobby.lastSnapAt = now();
      /* Сжатое ли тело пришло. Флаг возвращается хосту: приёмка по нему
         видит, что браузер действительно жмёт снимок, а не просто умеет. */
      const packed = /gzip/i.test(String(req.headers['content-encoding'] || ''));
      /* Снимок сам по себе — доказательство, что хост жив, даже если его SSE
         оборвался. Возвращать партию из «хост потерян» имеет право только
         поток снимков. */
      if (lobby.hostGone) hostBack(lobby, p);
      const seq = body.snapshot.seq;
      /* Команды отдаём и на «устаревшем» снимке: если хост после возврата
         повторил номер, это не повод держать его очередь до следующего.
         Заодно здесь применяются cmdDone/cmdAck и просрочка. */
      const commands = pendingCommands(lobby, body.snapshot);
      /* Отставание потоков — ДО раскладки этого снимка: именно оно говорит
         хосту, успевают ли друзья. Ответ уходит раньше broadcast, поэтому
         число описывает уже отправленное, а не текущий кадр. */
      const backlog = streamBacklog(lobby);
      if (seq !== undefined) {
        if (seq <= (lobby.lastSnapSeq || 0)) {
          return json(res, 200, { ok: true, stale: true, commands: commands,
            cmdSeq: lobby.cmdSeq, gzip: packed,
            serverNow: now(), build: buildId(), protocol: PROTOCOL,
            queue: backlog.queue, queueWire: backlog.wireQueue,
            queueAge: backlog.ageMs, streams: backlog.streams });
        }
        lobby.lastSnapSeq = seq;
      }
      /* Последний снимок — для возврата в партию после перезагрузки: хост
         восстанавливает по нему мир, клиент сразу рисует знакомое. */
      lobby.lastSnapshot = body.snapshot;
      /* Сначала ответ хосту: его следующий кадр не должен ждать, пока мы
         разложим текущий по всем потокам. В ответе — команды, ждущие хоста:
         этот POST работает даже тогда, когда SSE у него оборван. */
      const snapshotText = 'event: snapshot\ndata: ' +
        JSON.stringify(body.snapshot) + '\n\n';
      const snapshotBytes = byteLen(snapshotText);
      lobby.lastSnapshotBytes = snapshotBytes;
      json(res, 200, { ok: true, commands: commands, cmdSeq: lobby.cmdSeq,
        gzip: packed, serverNow: now(), build: buildId(), protocol: PROTOCOL,
        queue: backlog.queue, queueWire: backlog.wireQueue,
        queueAge: backlog.ageMs, streams: backlog.streams,
        snapshotBytes: snapshotBytes });
      broadcast(lobby, 'snapshot', body.snapshot, p.id, { drop: true });
      /* Журнал не чаще раза в секунду: 12 снимков/с иначе вытеснят из кольца
         команды и потерю хоста. При большой очереди пишем сразу — это и есть
         интересный случай. */
      const tLog = now();
      if (tLog - (lobby.lastSnapLogAt || 0) > 1000 ||
          backlog.queue > 24 * 1024 || commands.length) {
        lobby.lastSnapLogAt = tLog;
        lobbyLog(lobby, 'snapshot', {
          seq: seq === undefined ? null : seq, bytes: snapshotBytes,
          gzip: packed,
          commands: commands.length,
          queue: backlog.queue, queueWire: backlog.wireQueue,
          queueAge: backlog.ageMs, streams: backlog.streams
        });
      }
    });
  }

  /* ЕДИНСТВЕННЫЙ путь команды нового MP: аутентификация по токену, owner —
     из лобби, и передача worker'у комнаты. Хоста-посредника больше нет. */
  if (req.method === 'POST' && u.pathname === '/api/command') {
    return readJson(req, res, function (body) {
      const lobby = lobbyForRequest(body || {});
      const p = playerByToken(lobby, body && body.token);
      if (!lobby || !p) return json(res, 403, { ok: false, reason: 'нет доступа' });
      if (!lobby.started) return json(res, 409, { ok: false, reason: 'ещё не начали' });
      const rec = roomFor(lobby);
      if (!rec || !rec.worker || rec.fault) {
        return json(res, 409, { ok: false, reason: 'комната не принимает команды', code: 'room_unavailable' });
      }
      touchPlayer(p);
      const cmd = body.command;
      if (!cmd || typeof cmd !== 'object') {
        return json(res, 400, { ok: false, reason: 'пустая команда' });
      }
      if (byteLen(JSON.stringify(cmd)) > NetConfig.commandBodyMaxBytes) {
        return json(res, 413, { ok: false, reason: 'команда больше 16 КиБ' });
      }
      const type = cmd.type;
      if (typeof type !== 'string' || !type) {
        return json(res, 400, { ok: false, reason: 'нет типа команды' });
      }
      const payload = cmd.payload && typeof cmd.payload === 'object'
        ? cmd.payload
        : {
            buildingType: cmd.buildingType, variant: cmd.variant, rot: cmd.rot,
            x: cmd.x, y: cmd.y, x2: cmd.x2, y2: cmd.y2,
            id: cmd.id, action: cmd.action,
            campId: cmd.campId, villagerId: cmd.villagerId, ids: cmd.ids
          };
      const clientSequence = cmd.clientSequence === undefined ? cmd.n : cmd.clientSequence;
      if (!Number.isInteger(clientSequence) || clientSequence < 1) {
        return json(res, 400, { ok: false, reason: 'нет последовательного номера команды' });
      }
      const owner = p.owner === undefined ? 0 : p.owner;
      const instance = 's' + owner + '-' +
        crypto.createHash('sha1').update(String(p.id)).digest('hex').slice(0, 8);
      const commandId = String(cmd.commandId || (instance + ':' + clientSequence));
      /* commandId принадлежит выданной сервером instance этого игрока. Чужой
         префикс — попытка столкнуться с чужим ID в общем ledger'е комнаты. */
      if (commandId.indexOf(instance + ':') !== 0) {
        return json(res, 400, { ok: false, reason: 'чужой commandId', code: 'bad_command_id' });
      }
      if (Array.isArray(payload.ids) && payload.ids.length > NetConfig.commandMaxIds) {
        return json(res, 400, { ok: false, reason: 'слишком много id в команде' });
      }
      const epoch = cmd.epoch === undefined ? rec.epoch : cmd.epoch;
      if (cmd.roomId !== undefined && cmd.roomId !== lobby.code) {
        return json(res, 409, { ok: false, reason: 'чужая комната', code: 'bad_room' });
      }
      if (cmd.protocol !== undefined && cmd.protocol !== NetConfig.protocol) {
        return json(res, 409, { ok: false, reason: 'другая версия клиента', code: 'protocol_mismatch' });
      }
      const auth = {
        sessionId: String(p.id), playerId: p.id, owner: owner,
        command: {
          protocol: NetConfig.protocol, roomId: lobby.code, epoch: epoch,
          commandId: commandId, clientSequence: clientSequence,
          type: type, payload: payload
        }
      };
      roomSubmit(rec, auth).then(function (out) {
        if (!out || out.admitted === false) {
          const code = out && out.reasonCode || 'command_refused';
          const status = code === 'rate_limited' ? 429
            : (code === 'room_queue_full' || code === 'player_queue_full' ? 429 : 409);
          return json(res, status, {
            ok: false, admitted: false, status: out && out.status,
            code: code, reason: out && out.reason || 'команда не принята',
            nextClientSequence: out && out.nextClientSequence,
            epoch: out && out.epoch, room: roomSummary(rec)
          });
        }
        lobbyLog(lobby, 'cmd-accepted', {
          playerId: p.id, commandId: commandId, type: type,
          roomOrder: out.roomOrder, epoch: rec.epoch
        });
        json(res, out.duplicate ? 200 : 202, {
          ok: true, admitted: true, duplicate: !!out.duplicate, status: out.status,
          commandId: commandId, clientSequence: clientSequence,
          nextClientSequence: out.nextClientSequence,
          roomOrder: out.roomOrder, epoch: out.epoch || rec.epoch,
          appliedTick: out.appliedTick, appliedRevision: out.appliedRevision,
          reasonCode: out.reasonCode, reason: out.reason,
          ids: out.ids || [], serverNow: now()
        });
      }, function (e) {
        json(res, 503, {
          ok: false, admitted: false, code: 'room_unavailable',
          reason: String(e && e.message || e)
        });
      });
    });
  }

  if (req.method === 'POST' && u.pathname === '/api/command') {
    return readJson(req, res, function (body) {
      const lobby = lobbyForRequest(body || {});
      const p = playerByToken(lobby, body && body.token);
      if (!lobby || !p) return json(res, 403, { ok: false, reason: 'нет доступа' });
      if (!lobby.started) return json(res, 409, { ok: false, reason: 'ещё не начали' });
      if (lobby.hostGone) return json(res, 409, { ok: false, reason: 'хост вне сети' });
      touchPlayer(p);
      const cmd = body.command;
      if (!cmd || typeof cmd !== 'object') {
        return json(res, 400, { ok: false, reason: 'пустая команда' });
      }
      /* n — не «по желанию»: без него нельзя ни дедуплицировать повтор, ни
         назвать результат на /api/command-state. */
      if (typeof cmd.n !== 'number' || !isFinite(cmd.n) || cmd.n <= 0) {
        return json(res, 400, { ok: false, reason: 'нет номера команды n' });
      }
      if (typeof cmd.type !== 'string' || !cmd.type) {
        return json(res, 400, { ok: false, reason: 'нет типа команды' });
      }
      /* Форму команды проверяет хост: он один знает мир. Сервер отсекает
         только то, что делает протокол неоднозначным. */
      if (cmd.type === 'buildLine') {
        const keys = ['x', 'y', 'x2', 'y2'];
        for (let i = 0; i < keys.length; i++) {
          if (typeof cmd[keys[i]] !== 'number' || !isFinite(cmd[keys[i]])) {
            return json(res, 400, { ok: false, reason: 'у серии нет концов линии' });
          }
        }
        if (typeof cmd.buildingType !== 'string') {
          return json(res, 400, { ok: false, reason: 'у серии нет типа постройки' });
        }
      }
      if (Array.isArray(cmd.items) && cmd.items.length > CMD_DONE_MAX) {
        /* Контракт возит концы линии, items — внутренний результат плана.
           Если старая сборка всё же прислала список — серия не больше 20. */
        return json(res, 400, { ok: false, reason: 'в серии больше 20 зданий' });
      }
      cmd.from = p.id;                       // кто прислал — id лобби
      cmd.owner = p.owner === undefined ? 0 : p.owner;   // чей это город

      /* Повтор после обрыва/потери ответа несёт тот же n: второй раз в
         очередь не кладём. Если команда уже решена — отдаём её результат. */
      const queued = findQueued(lobby, p.id, cmd.n);
      if (queued) {
        return json(res, 200, {
          ok: true, duplicate: true, n: queued.n, commandId: queued.n,
          sn: queued.sn, state: 'pending', pending: lobby.cmdQueue.length,
          serverNow: now(), ageMs: Math.max(0, now() - (queued.at || now()))
        });
      }
      const known = cmdResultOf(lobby, p.id, cmd.n);
      if (known) {
        return json(res, 200, {
          ok: true, duplicate: true, n: known.n, commandId: known.n,
          sn: known.sn, state: known.state,
          reason: known.reason || undefined,
          ids: known.ids || [], appliedSeq: known.appliedSeq || 0,
          serverNow: now(),
          ageMs: Math.max(0, now() - (known.at || now())),
          compact: !!known.compact
        });
      }

      /* Очередь переполнена — вытесняем САМУЮ СТАРУЮ по приёму и говорим ей
         expired. Молчаливый shift оставлял клиента ждать вечно. */
      if (lobby.cmdQueue.length >= CMD_MAX) {
        /* Сначала вытесняем то, что хост ещё не видел: забранную команду
           он, возможно, уже выполняет, и «expired» соврал бы. */
        let oldest = -1;
        for (let i = 0; i < lobby.cmdQueue.length; i++) {
          const c = lobby.cmdQueue[i];
          if (lobby.cmdDelivered.has(cmdKey(c.from, c.n))) continue;
          if (oldest < 0 || (c.sn || 0) < (lobby.cmdQueue[oldest].sn || 0)) oldest = i;
        }
        if (oldest < 0) {
          oldest = 0;
          for (let i = 1; i < lobby.cmdQueue.length; i++) {
            if ((lobby.cmdQueue[i].sn || 0) < (lobby.cmdQueue[oldest].sn || 0)) oldest = i;
          }
        }
        const gone = lobby.cmdQueue.splice(oldest, 1)[0];
        if (gone) decideCmd(lobby, gone, 'expired', 'вытеснена: очередь команд переполнена');
      }

      cmd.sn = ++lobby.cmdSeq;               // порядок ПРИЁМА в лобби
      cmd.at = now();                        // часы СЕРВЕРА, для совместимости
      cmd.ageMs = 0;                         // на момент приёма команда свежая
      lobby.cmdQueue.push(cmd);
      lobbyLog(lobby, 'cmd-accepted', {
        from: p.id, n: cmd.n, sn: cmd.sn, type: cmd.type,
        owner: cmd.owner, pending: lobby.cmdQueue.length
      });
      /* 200 значит только «принято в очередь». Выполнение подтвердит
         cmdDone в снимке, а клиент узнает его через /api/command-state. */
      json(res, 200, {
        ok: true, n: cmd.n, commandId: cmd.n, sn: cmd.sn, state: 'pending',
        ageMs: 0, serverNow: now(), build: buildId(), protocol: PROTOCOL,
        pending: lobby.cmdQueue.length
      });
      /* Событие остаётся для старого хоста и как «толчок» новому: новый хост
         по нему только шлёт снимок сразу, а выполняет команды из ответа на
         снимок — путь выполнения один. ageMs считается заново на отправке:
         команда могла подождать в очереди, пока хост был занят. */
      broadcast(lobby, 'command', {
        type: cmd.type, n: cmd.n, sn: cmd.sn, from: cmd.from, owner: cmd.owner,
        x: cmd.x, y: cmd.y, x2: cmd.x2, y2: cmd.y2,
        buildingType: cmd.buildingType, variant: cmd.variant, rot: cmd.rot,
        ids: cmd.ids, at: cmd.at, ageMs: Math.max(0, now() - cmd.at)
      }, p.id);
    });
  }

  /* Результат команды: pending | applied | rejected | expired. Клиент
     опрашивает его после 200 на /api/command — HTTP 200 не значит «построено».
     Без n отдаём последние результаты этого игрока и его очередь (для опроса
     пачкой), с n — один результат. */
  if (req.method === 'GET' && u.pathname === '/api/command-state') {
    const lobby = lobbyForRequest({ code: u.searchParams.get('code') });
    const p = playerByToken(lobby, u.searchParams.get('token'));
    if (!lobby || !p) return json(res, 403, { ok: false, reason: 'нет доступа' });
    touchPlayer(p);
    const rec = roomFor(lobby);
    if (!rec || !rec.worker) {
      return json(res, 409, { ok: false, reason: 'комната не запущена', code: 'room_unavailable' });
    }
    const ids = [];
    ['id', 'commandId'].forEach(function (key) {
      u.searchParams.getAll(key).forEach(function (raw) {
        String(raw).split(',').forEach(function (part) {
          const s = part.trim();
          if (s && ids.indexOf(s) < 0) ids.push(s);
        });
      });
    });
    /* Старый `n` — совместимость формы запроса, не новый протокол. */
    const instance = 's' + (p.owner === undefined ? 0 : p.owner) + '-' +
      crypto.createHash('sha1').update(String(p.id)).digest('hex').slice(0, 8);
    u.searchParams.getAll('n').forEach(function (raw) {
      String(raw).split(',').forEach(function (part) {
        const n = Number(part);
        if (isFinite(n) && n > 0) {
          const id = instance + ':' + n;
          if (ids.indexOf(id) < 0) ids.push(id);
        }
      });
    });
    const wmRaw = u.searchParams.get('watermark');
    const watermark = wmRaw === null ? null : Number(wmRaw);
    roomStateQuery(rec, String(p.id), ids, watermark).then(function (msg) {
      const cs = msg.commandState || { results: [] };
      const first = cs.results && cs.results[0] ? cs.results[0] : null;
      json(res, 200, {
        ok: true, protocol: PROTOCOL,
        roomId: rec.roomId, epoch: cs.epoch || rec.epoch,
        revision: cs.revision, tick: cs.tick,
        roomStatus: cs.roomStatus || (rec.fault ? 'faulted' : rec.status),
        nextClientSequence: cs.nextClientSequence,
        watermark: cs.watermark,
        results: cs.results || [],
        /* Совместимые имена: старый клиент читал один результат. */
        state: first ? first.status : 'unknown',
        reason: first ? first.reason : '',
        ids: first ? first.ids : [],
        appliedSeq: first ? first.appliedRevision : 0
      });
    }, function (e) {
      json(res, 503, { ok: false, code: 'room_unavailable', reason: String(e && e.message || e) });
    });
    return;
  }

  if (req.method === 'GET' && u.pathname === '/api/command-state') {
    const lobby = lobbyForRequest({ code: u.searchParams.get('code') });
    const p = playerByToken(lobby, u.searchParams.get('token'));
    if (!lobby || !p) return json(res, 403, { ok: false, reason: 'нет доступа' });
    touchPlayer(p);
    sweepCommands(lobby);
    const ns = [];
    u.searchParams.getAll('n').forEach(function (raw) {
      String(raw).split(',').forEach(function (part) {
        const n = Number(part);
        if (isFinite(n) && n > 0 && ns.indexOf(n) < 0) ns.push(n);
      });
    });
    function ownState(n) {
      const q = findQueued(lobby, p.id, n);
      if (q) {
        return { n: n, commandId: n, sn: q.sn, state: 'pending', at: q.at,
          ageMs: Math.max(0, now() - (q.at || now())) };
      }
      const r = cmdResultOf(lobby, p.id, n);
      if (r) {
        return { n: r.n, commandId: r.n, sn: r.sn, state: r.state,
          reason: r.reason, at: r.at, decidedAt: r.decidedAt,
          ids: r.ids || [], appliedSeq: r.appliedSeq || 0,
          ageMs: Math.max(0, now() - (r.at || now())),
          compact: !!r.compact };
      }
      /* Честный unknown: «не знаю, выполнялась ли» — не то же самое, что
         «отклонена». Клиент покажет «результат уточняется». */
      return { n: n, commandId: n, state: 'unknown', ageMs: null };
    }
    if (ns.length === 1) {
      const one = ownState(ns[0]);
      one.ok = true;
      one.serverNow = now();
      return json(res, 200, one);
    }
    if (ns.length > 1) {
      return json(res, 200, { ok: true, now: now(), serverNow: now(),
        results: ns.slice(0, 20).map(ownState) });
    }
    /* Пачка: своя очередь (pending) + последние окончательные результаты. */
    const results = [];
    for (const q of lobby.cmdQueue) {
      if (q.from !== p.id) continue;
      results.push({ n: q.n, commandId: q.n, sn: q.sn, state: 'pending',
        at: q.at, ageMs: Math.max(0, now() - (q.at || now())) });
    }
    const finals = [];
    lobby.cmdResults.forEach(function (r) {
      if (r.from !== p.id) return;
      if (r.decidedAt && now() - r.decidedAt > CMD_RESULT_TTL) return;
      finals.push({ n: r.n, commandId: r.n, sn: r.sn, state: r.state,
        reason: r.reason, at: r.at, decidedAt: r.decidedAt,
        ids: r.ids || [], appliedSeq: r.appliedSeq || 0,
        ageMs: Math.max(0, now() - (r.at || now())) });
    });
    finals.sort(function (a, b) { return (a.decidedAt || 0) - (b.decidedAt || 0); });
    return json(res, 200, {
      ok: true, now: now(), serverNow: now(), pending: results.length,
      results: results.concat(finals.slice(-20)),
      build: buildId(), protocol: PROTOCOL
    });
  }

  if (req.method === 'POST' && u.pathname === '/api/leave') {
    return readJson(req, res, function (body) {
      const lobby = lobbyForRequest(body || {});
      const p = playerByToken(lobby, body && body.token);
      if (!lobby || !p) return json(res, 200, { ok: true });
      dropPlayer(lobby, p);
      json(res, 200, { ok: true });
    });
  }

  if (u.pathname.startsWith('/api/')) return json(res, 404, { ok: false, reason: 'нет такого api' });
  serveStatic(req, res);
}

function requestHandler(req, res) {
  /* handleRequest теперь async (возврат в комнату может поднимать worker).
     Ошибку не глотаем и не оставляем unhandled rejection. */
  Promise.resolve(handleRequest(req, res)).catch(function (e) {
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ ok: false, reason: String(e && e.message || e) }));
    } catch (err) { try { res.destroy(); } catch (x) {} }
    console.error('  request: ' + String(e && e.stack || e));
  });
}
const server = http.createServer(requestHandler);
function createServer() { return http.createServer(requestHandler); }

/* --------------------------- запуск и ссылки -------------------------- */
function printLinks() {
  console.log('4tox multiplayer');
  console.log('  локально: ' + gameUrl('127.0.0.1'));
  if (PUBLIC_URL) {
    console.log('  снаружи: ' + PUBLIC_URL + ' (reverse proxy)');
    console.log('');
    console.log('  ссылку на лобби не составляйте вручную: после «Создать» в игре');
    console.log('  показаны готовые ссылки с публичным адресом.');
    console.log('');
    return;
  }
  if (LOCAL) {
    console.log('  режим --local: снаружи не подключиться (только эта машина)');
    return;
  }
  const lan = lanAddresses();
  if (lan.length) {
    console.log('  по IP этой машины:');
    lan.forEach(function (a) {
      const info = findKind(a.iface, a.address);
      console.log('    ' + gameUrl(a.address) + '   (' + a.iface + ' · ' + info.label + ')');
    });
  } else {
    console.log('  сетевых адресов нет — проверьте Wi-Fi/Ethernet');
  }
  console.log('');
  console.log('  ссылку на лобби не составляйте вручную: после «Создать» в игре');
  console.log('  показаны готовые ссылки с адресом сервера.');
  console.log('  проверяю сеть (проброс порта, CGNAT)…');
  console.log('');
}

function printNetReport() {
  if (PUBLIC_URL) {
    console.log('  СЕТЬ: снаружи через reverse proxy: ' + PUBLIC_URL);
    console.log('');
    return;
  }
  if (net.checking) return;
  if (net.cgnat) {
    console.log('  СЕТЬ: ' + (net.router || 'роутер') + ', внешний адрес ' +
      (net.externalIp || '?'));
    console.log('  ВНИМАНИЕ: провайдер держит вас за CGNAT' +
      (net.reason ? ' (' + net.reason + ')' : '') + '.');
    if (publicIp) {
      console.log('  Публичный IP ' + publicIp + ' — общий; входящие до вас не доходят.');
    }
    console.log('  Проброс порта НЕ поможет: по внешнему IP друзья не зайдут.');
    console.log('  Работает: туннель (--tunnel, HTTPS) или VPN — Hamachi/Radmin.');
    if (!(tunnel && tunnel.url())) {
      console.log('  Ссылка Hamachi есть в лобби: друг должен войти в ту же сеть.');
    }
  } else if (net.mapped) {
    console.log('  СЕТЬ: ' + (net.router || 'роутер') + ' — порт ' + PORT +
      ' проброшен на роутере (UPnP).');
    if (publicIp) console.log('  Ссылка через интернет: ' + gameUrl(publicIp));
  } else if (net.ok) {
    console.log('  СЕТЬ: ' + (net.router || 'роутер') + ' — проброс порта не удался' +
      (net.reason ? ' (' + net.reason + ')' : '') + '.');
    console.log('  Пробросьте TCP ' + PORT + ' вручную или включите --tunnel.');
  } else {
    console.log('  СЕТЬ: UPnP недоступен' + (net.reason ? ' (' + net.reason + ')' : '') + '.');
    console.log('  Пробросьте TCP ' + PORT + ' вручную или включите --tunnel.');
  }
  if (tunnel && tunnel.url()) {
    console.log('  Друзьям (через интернет, HTTPS): ' + tunnel.url() + '/game/');
  } else if (TUNNEL) {
    console.log('  туннель: ' + (tunnel ? tunnel.status() : 'не запущен'));
  }
  console.log('');
}

function startNetProbe() {
  if (PUBLIC_URL) {
    net.checking = false;
    net.ok = true;
    net.cgnat = false;
    net.mapped = true;
    net.reason = null;
    printNetReport();
    return;
  }
  if (NO_UPNP) {
    net.checking = false;
    net.ok = false;
    net.reason = 'UPnP отключён (--no-upnp)';
    printNetReport();
    return;
  }
  UPnP.probe({ port: PORT, publicIp: publicIp }).then(function (res) {
    net.checking = false;
    net.ok = !!res.ok;
    net.cgnat = res.cgnat === true;
    net.router = res.router || null;
    net.externalIp = res.externalIp || null;
    net.mapped = !!res.mapped;
    net.reason = res.reason || null;
    net.localAddress = res.localAddress || null;
    /* Публичный IP мог выясниться позже роутера: адрес роутера и адрес,
       который видит интернет, обязаны совпадать, иначе между ними ещё один
       NAT (тот же CGNAT, просто другим боком). */
    if (!net.cgnat && net.externalIp && publicIp && net.externalIp !== publicIp) {
      net.cgnat = true;
      net.mapped = false;
      net.reason = 'роутер видит ' + net.externalIp + ', а интернет — ' + publicIp;
    }
    printNetReport();
  }).catch(function (e) {
    net.checking = false;
    net.ok = false;
    net.reason = e.message;
    printNetReport();
  });
}

function startServer() {
  server.on('error', function (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error('Порт ' + PORT + ' занят. Закройте прошлый сервер или');
      console.error('запустите с другим портом: node game/server/server.js --port ' + (PORT + 1));
    } else {
      console.error('Сервер не поднялся: ' + (err && err.message || err));
    }
    process.exit(1);
  });
  startLoopMonitor();
  startDiagSampler();
  /* Лобби и токены переживают перезапуск Node: комнаты поднимаются лениво
     по /api/resume из checkpoint+журнала. */
  restoreLobbies();
  /* Партия, в которой никого нет, удаляется через INACTIVE_TTL: worker
     останавливается, каталог состояния стирается, слот MAX_ACTIVE_ROOMS
     освобождается. Проверка частая и дешёвая — обход карты лобби. */
  setInterval(sweepInactiveLobbies, INACTIVE_SWEEP).unref();
  /* Пустая комната живёт 10 минут: reconnect внутри этого окна не создаёт
     мир заново. Проверка редкая — 30 с, не на каждый HTTP. */
  setInterval(function () {
    roomRecords.forEach(function (rec) {
      const online = rec.lobby && rec.lobby.players.some(function (p) { return p.online !== false; });
      roomRequest(rec, 'diagnostics', { empty: !online }, 5000).catch(function () {});
    });
  }, 30000).unref();
  /* Сборка определяется один раз при старте (git rev-parse --short HEAD),
     а не на каждый запрос: /api/build должен быть дешёвым и стабильным. */
  buildId();
  server.listen(PORT, HOST, function () {
    serverLog('server-start', {
      build: buildId(), protocol: PROTOCOL, port: PORT, host: HOST,
      node: process.version, pid: process.pid
    });
    printLinks();
    if (OPEN) {
      const cmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'start' : 'xdg-open');
      try { spawn(cmd, [gameUrl('127.0.0.1')], { detached: true, stdio: 'ignore' }).unref(); } catch (e) {}
    }
    if (LOCAL) {
      net.checking = false;
      net.reason = 'режим --local';
      return;
    }
    if (TUNNEL && !PUBLIC_URL) tunnel = Tunnel.start(PORT, console.log);
    if (PUBLIC_URL) {
      /* За reverse proxy внешний IP и UPnP не нужны: адрес уже известен. */
      startNetProbe();
      return;
    }
    discoverPublicIp(function () {
      if (publicIp) console.log('  внешний IP: ' + publicIp);
      startNetProbe();
    });
  });
}

if (require.main === module) {
  startServer();
  process.on('SIGINT', function () {
    if (tunnel) { try { tunnel.stop(); } catch (e) {} }
    console.log('\nостановлен');
    process.exit(0);
  });
}

/* Экспорт для приёмки: сервер не поднимается сам, readJson можно проверить
   в отдельном процессе/тесте. В обычном запуске всё работает как раньше. */
module.exports = {
  readJson: readJson,
  handleRequest: handleRequest,
  createServer: createServer,
  buildInfo: buildInfo,
  buildId: buildId,
  server: server,
  PROTOCOL: PROTOCOL,
  CMD_PROTO: CMD_PROTO
};
