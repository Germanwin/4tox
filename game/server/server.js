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
const { spawn } = require('child_process');
const UPnP = require('./upnp');
const Tunnel = require('./tunnel');

const ROOT = path.resolve(__dirname, '..', '..');
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
    hostGone: false, hostTimer: null, lastSnapAt: 0, lastSnapshot: null,
    /* Команды, ждущие хоста: [{...cmd, from, owner, at}]. Хост забирает их
       ответом на снимок (см. CMD_TTL), а не событием SSE. */
    cmdQueue: []
  };
  lobbies.set(c, lobby);
  return lobby;
}

function lobbyView(lobby) {
  const host = lobby.players.find(function (p) { return p.id === lobby.hostId; });
  return {
    code: lobby.code, max: lobby.max, started: lobby.started,
    seed: lobby.seed, size: lobby.size, hostId: lobby.hostId,
    hostGone: !!lobby.hostGone,
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

function send(res, type, data) {
  try { res.write(eventText(type, data)); } catch (e) { /* поток уже закрыт */ }
}

/* opts.drop — событие можно ПРОПУСТИТЬ для отстающего потока. Так делают
   только снимки: следующий снимок абсолютный (мир + битовая карта убранного),
   поэтому потеря промежуточного ничего не ломает. Без этого медленный друг
   копил бы в памяти сервера мегабайты SSE, и лагали бы все. */
function broadcast(lobby, type, data, exceptId, opts) {
  const text = eventText(type, data);
  lobby.streams.forEach(function (res, id) {
    if (exceptId !== undefined && id === exceptId) return;
    if (opts && opts.drop && res.writableLength > 256 * 1024) return;
    try { res.write(text); } catch (e) { /* поток уже закрыт */ }
  });
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
function addPlayer(lobby, name) {
  const colors = ['#4a90d9', '#d94a4a', '#9b59b6', '#e0a030'];
  const id = lobby.nextId++;
  const p = {
    id: id, name: String(name || ('Игрок ' + (id + 1))).slice(0, 24),
    ready: false, token: token(), color: colors[id % colors.length],
    joined: now(), lastSeen: now(), online: true, goneAt: 0, timer: null,
    owner: undefined
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

function hostLeft(lobby, p) {
  if (lobby.hostGone) return;
  lobby.hostGone = true;
  if (lobby.hostTimer) { clearTimeout(lobby.hostTimer); lobby.hostTimer = null; }
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
  broadcast(lobby, 'host-back', {
    id: p.id, name: p.name, owner: p.owner === undefined ? 0 : p.owner, host: true
  });
  broadcast(lobby, 'lobby', lobbyView(lobby));
  console.log('  лобби ' + lobby.code + ': хост ' + p.name + ' вернулся');
}

function dropPlayer(lobby, p) {
  if (p.timer) { clearTimeout(p.timer); p.timer = null; }
  lobby.players = lobby.players.filter(function (x) { return x !== p; });
  const stream = lobby.streams.get(p.id);
  if (stream) {
    lobby.streams.delete(p.id);
    try { stream.end(); } catch (e) {}
  }
  if (!lobby.players.length) {
    if (lobby.hostTimer) clearTimeout(lobby.hostTimer);
    lobbies.delete(lobby.code);
    return;
  }
  if (lobby.hostId === p.id && lobby.started) {
    /* В партии мир живёт во вкладке хоста: передать его нельзя. Честно
       говорим клиентам, что игра остановлена, вместо замершего кадра. */
    hostLeft(lobby, p);
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

function markOffline(lobby, p) {
  if (lobby.players.indexOf(p) < 0) return;
  /* Пока старый поток закрывался, игрок мог успеть открыть новый. Живой
     поток важнее события close: иначе переподключение гонкой превращалось бы
     в «нет связи» у только что вернувшегося. */
  if (lobby.streams.has(p.id)) return;
  p.online = false;
  p.goneAt = now();
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
        if (lobbies.get(lobby.code) === lobby) hostLeft(lobby, p);
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

/* ------------------------------- старт -------------------------------- */
/* Что хосту пора выполнить. Забирается в ответе на снимок: SSE для команд
   больше не единственный путь (см. CMD_TTL). ack — карта «id игрока → номер
   последней выполненной команды»; всё, что не больше ack, из очереди уходит.
   Заодно выбрасываются просроченные: хост, который не присылал снимков
   дольше CMD_TTL, эти клики уже не увидит, а копить их незачем. */
function pendingCommands(lobby, ack) {
  if (ack && typeof ack === 'object') {
    lobby.cmdQueue = lobby.cmdQueue.filter(function (c) {
      const done = ack[String(c.from)];
      return !(done !== undefined && typeof c.n === 'number' && c.n <= done);
    });
  }
  const t = now();
  lobby.cmdQueue = lobby.cmdQueue.filter(function (c) {
    return t - (c.at || 0) <= CMD_TTL;
  });
  return lobby.cmdQueue;
}

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
    players: lobby.players.map(function (p, i) {
      return { id: p.id, name: p.name, owner: i, color: p.color };
    })
  };
  lobby.startPayload = payload;
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

/* ------------------------------- тело -------------------------------- */
function readJson(req, cb) {
  let body = '';
  req.on('data', function (chunk) {
    body += chunk;
    if (body.length > 4 * 1024 * 1024) req.destroy();
  });
  req.on('end', function () {
    try { cb(JSON.parse(body || '{}')); }
    catch (e) { cb(null); }
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
  return {
    ok: true,
    lobby: lobbyView(lobby),
    started: lobby.started,
    start: lobby.started ? lobby.startPayload : null,
    block: startBlock(lobby)
  };
}

/* ------------------------------- сервер ------------------------------- */
const server = http.createServer(function (req, res) {
  const u = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));

  /* Адреса сервера: из них клиент собирает ссылку-приглашение. */
  if (req.method === 'GET' && u.pathname === '/api/server') {
    return json(res, 200, serverView());
  }

  if (req.method === 'POST' && u.pathname === '/api/lobby') {
    return readJson(req, function (body) {
      if (!body) return json(res, 400, { ok: false, reason: 'нет тела' });
      const lobby = makeLobby(body.max);
      const p = addPlayer(lobby, body.name || 'Хост');
      lobby.hostId = p.id;
      json(res, 200, { ok: true, code: lobby.code, token: p.token, playerId: p.id,
        hostId: lobby.hostId, max: lobby.max, players: lobbyView(lobby).players });
      console.log('  лобби ' + lobby.code + ' создано (хост ' + p.name + ')');
    });
  }

  if (req.method === 'POST' && u.pathname === '/api/join') {
    return readJson(req, function (body) {
      if (!body) return json(res, 400, { ok: false, reason: 'нет тела' });
      const lobby = lobbies.get(String(body.code || '').toUpperCase());
      if (!lobby) return json(res, 404, { ok: false, reason: 'лобби не найдено — проверьте код' });
      if (lobby.started) return json(res, 409, { ok: false, reason: 'игра уже началась' });
      if (lobby.players.length >= lobby.max) {
        return json(res, 409, { ok: false, reason: 'лобби заполнено' });
      }
      const p = addPlayer(lobby, body.name || ('Игрок ' + (lobby.players.length)));
      json(res, 200, { ok: true, code: lobby.code, token: p.token, playerId: p.id,
        hostId: lobby.hostId, max: lobby.max, players: lobbyView(lobby).players });
      broadcast(lobby, 'lobby', lobbyView(lobby));
      console.log('  лобби ' + lobby.code + ': +' + p.name + ' (' + p.id + ')');
      /* Старт — только по кнопке хоста. Автостарт «как только все готовы»
         оставлял за бортом друга, который ещё открывал ссылку: двое нажали
         «Готов» — и лобби на трёх закрылось вдвоём. */
    });
  }

  if (req.method === 'POST' && u.pathname === '/api/ready') {
    return readJson(req, function (body) {
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
    return readJson(req, function (body) {
      const lobby = lobbyForRequest(body || {});
      const p = playerByToken(lobby, body && body.token);
      if (!lobby || !p) return json(res, 403, { ok: false, reason: 'нет доступа' });
      if (p.id !== lobby.hostId) return json(res, 403, { ok: false, reason: 'начинает хост' });
      touchPlayer(p);
      const started = startLobby(lobby);
      if (!started.ok && !started.already) {
        return json(res, 409, { ok: false, reason: started.reason, canStart: false });
      }
      json(res, 200, { ok: true, already: !!started.already, start: lobby.startPayload });
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
    if (code && tok) {
      const lobby = lobbyForRequest({ code: code });
      const p = playerByToken(lobby, tok);
      if (lobby && p) {
        touchPlayer(p);
        if (lobby.hostGone && p.id === lobby.hostId) hostBack(lobby, p);
      }
    }
    return json(res, 200, { ok: true, t: now() });
  }

  /* Возврат в уже начатую партию после перезагрузки страницы. Токен тот же —
     нового игрока не создаём. Снимок нужен и хосту (по нему он поднимает
     мир), и клиенту (чтобы не мигать пустым островом до первого кадра). */
  if (req.method === 'GET' && u.pathname === '/api/resume') {
    const lobby = lobbyForRequest({ code: u.searchParams.get('code') });
    const p = playerByToken(lobby, u.searchParams.get('token'));
    if (!lobby || !p) return json(res, 403, { ok: false, reason: 'лобби не найдено' });
    touchPlayer(p);
    if (lobby.started && p.id === lobby.hostId) {
      /* Хост возобновляет нумерацию с последнего снимка, а не с нуля. Сам
         host-back уйдёт вместе с первым снимком: пока мир не поднят, клиенты
         не должны решить, что игра уже идёт. */
      lobby.lastSnapSeq = (lobby.lastSnapshot && lobby.lastSnapshot.seq) || 0;
    }
    return json(res, 200, {
      ok: true,
      started: lobby.started,
      host: p.id === lobby.hostId,
      lobby: lobbyView(lobby),
      start: lobby.started ? lobby.startPayload : null,
      snapshot: lobby.started ? lobby.lastSnapshot : null,
      /* Даже если снимка нет, номер последнего кадра нужен: иначе хост после
         возврата начал бы seq с единицы, а клиенты отбросили бы его как
         устаревший. */
      seq: lobby.lastSnapSeq || 0
    });
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
    if (old && old !== res) { try { old.end(); } catch (e) {} }
    lobby.streams.set(p.id, res);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    /* Мелкие события не должны ждать 40 мс на Nagle — это заметно на каждом
       «готов» и команде. */
    try { if (res.socket) res.socket.setNoDelay(true); } catch (e) {}
    if (res.flushHeaders) res.flushHeaders();
    res.write('retry: 1500\n\n');
    send(res, 'hello', { playerId: p.id, hostId: lobby.hostId, lobby: lobbyView(lobby) });
    if (lobby.started && lobby.startPayload) send(res, 'start', lobby.startPayload);
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

    const ping = setInterval(function () { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
    if (typeof ping.unref === 'function') ping.unref();
    req.on('close', function () {
      clearInterval(ping);
      if (lobby.streams.get(p.id) === res) lobby.streams.delete(p.id);
      if (lobby.players.indexOf(p) < 0) return;
      if (lobby.started) {
        broadcast(lobby, 'peer-left', {
          id: p.id, name: p.name,
          owner: p.owner === undefined ? 0 : p.owner,
          host: p.id === lobby.hostId
        });
        /* Хосту это заводит таймер «потерян», клиенту — просто отметку
           offline в лобби. */
        markOffline(lobby, p);
        return;
      }
      markOffline(lobby, p);
    });
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/snapshot') {
    return readJson(req, function (body) {
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
      /* Снимок сам по себе — доказательство, что хост жив, даже если его SSE
         оборвался. Возвращать партию из «хост потерян» имеет право только
         поток снимков. */
      if (lobby.hostGone) hostBack(lobby, p);
      const seq = body.snapshot.seq;
      /* Команды отдаём и на «устаревшем» снимке: если хост после возврата
         повторил номер, это не повод держать его очередь до следующего. */
      const commands = pendingCommands(lobby, body.snapshot.cmdAck);
      if (seq !== undefined) {
        if (seq <= (lobby.lastSnapSeq || 0)) {
          return json(res, 200, { ok: true, stale: true, commands: commands });
        }
        lobby.lastSnapSeq = seq;
      }
      /* Последний снимок — для возврата в партию после перезагрузки: хост
         восстанавливает по нему мир, клиент сразу рисует знакомое. */
      lobby.lastSnapshot = body.snapshot;
      /* Сначала ответ хосту: его следующий кадр не должен ждать, пока мы
         разложим текущий по всем потокам. В ответе — команды, ждущие хоста:
         этот POST работает даже тогда, когда SSE у него оборван. */
      json(res, 200, { ok: true, commands: commands });
      broadcast(lobby, 'snapshot', body.snapshot, p.id, { drop: true });
    });
  }

  if (req.method === 'POST' && u.pathname === '/api/command') {
    return readJson(req, function (body) {
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
      cmd.from = p.id;                       // кто прислал — id лобби
      cmd.owner = p.owner === undefined ? 0 : p.owner;   // чей это город
      /* Повтор после обрыва несёт тот же n: второй раз в очередь не кладём,
         иначе хост получил бы один клик дважды. Ищем именно в очереди, а не
         в вечной карте «что уже видели»: команда, протухшая по CMD_TTL, не
         должна запрещать повтор с тем же номером навсегда. Выполненную и
         подтверждённую команду отсеет уже сам хост (netCmdLast). */
      if (typeof cmd.n === 'number') {
        for (let i = 0; i < lobby.cmdQueue.length; i++) {
          const q = lobby.cmdQueue[i];
          if (q.n === cmd.n && q.from === p.id) {
            return json(res, 200, { ok: true, duplicate: true });
          }
        }
      }
      cmd.at = now();
      lobby.cmdQueue.push(cmd);
      if (lobby.cmdQueue.length > CMD_MAX) lobby.cmdQueue.shift();
      json(res, 200, { ok: true, pending: lobby.cmdQueue.length });
      /* Оставляем событие для старого хоста, который ещё не умеет забирать
         команды из ответа снимка. Новый хост этот обработчик не слушает:
         два пути выполнения одной команды разошлись бы по порядку. */
      broadcast(lobby, 'command', cmd, p.id);
    });
  }

  if (req.method === 'POST' && u.pathname === '/api/leave') {
    return readJson(req, function (body) {
      const lobby = lobbyForRequest(body || {});
      const p = playerByToken(lobby, body && body.token);
      if (!lobby || !p) return json(res, 200, { ok: true });
      dropPlayer(lobby, p);
      json(res, 200, { ok: true });
    });
  }

  if (u.pathname.startsWith('/api/')) return json(res, 404, { ok: false, reason: 'нет такого api' });
  serveStatic(req, res);
});

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

server.on('error', function (err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error('Порт ' + PORT + ' занят. Закройте прошлый сервер или');
    console.error('запустите с другим портом: node game/server/server.js --port ' + (PORT + 1));
  } else {
    console.error('Сервер не поднялся: ' + (err && err.message || err));
  }
  process.exit(1);
});

server.listen(PORT, HOST, function () {
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

process.on('SIGINT', function () {
  if (tunnel) { try { tunnel.stop(); } catch (e) {} }
  console.log('\nостановлен');
  process.exit(0);
});
