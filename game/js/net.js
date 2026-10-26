/* net.js — клиент лобби и релея.

   Транспорт: SSE вниз, POST вверх. Токен лобби — единственный пропуск; он
   приходит при создании/входе и уходит в каждый запрос. Никакой магии:
   сервер не доверяет никому, кто не назвал токен.

   Второй канал — опрос /api/status (Lobby зовёт его, пока открыт экран
   лобби). Он нужен не «на всякий случай»: SSE — единственное, что умеет
   мгновенно рассказать про «готов» и «старт», но он же первым умирает при
   плохой сети. Опрос возвращает то же состояние, поэтому «оба готовы, а игра
   не началась» лечится даже при полностью мёртвом SSE. */
(function (global) {
  'use strict';

  var token = null, code = null, playerId = null, hostId = 0;
  var es = null, handlers = {}, lobby = null, started = null, startKey = null;
  var online = false, serverInfoCache = null;
  /* Команды уходят строго по одной: ответ на предыдущую получен — уходит
     следующая. HTTP-соединений несколько, и параллельные POST легко
     приезжают не в том порядке: «повернуть, потом снести» превращалось в
     «снести, потом повернуть». Номер n — для хоста: повтор после обрыва не
     должен выполнить действие дважды. */
  var cmdSeq = 0, cmdChain = Promise.resolve();

  /* Номер команды должен только расти — в том числе после F5. Хост помнит
     последний выполненный номер и отбрасывает меньший как повтор; со
     счётчиком «с нуля» гость после перезагрузки не мог поставить ни одного
     дома (его n=1…N были меньше старых). Date.now() монотонен между
     перезагрузками, а счётчик разводит команды в одну миллисекунду. */
  function nextCmdSeq() {
    var t = Date.now();
    cmdSeq = t > cmdSeq ? t : cmdSeq + 1;
    return cmdSeq;
  }

  /* ---------------- конечный результат команды ------------------------- *
   *
   * HTTP 200 на /api/command значит только «принято в очередь». Настоящий
   * ответ — state applied/rejected/expired в /api/command-state. Опрос один
   * на все ждущие команды: без n сервер отдаёт последние результаты этого
   * игрока, так что десять кликов не превращаются в десять запросов в
   * секунду. SSE `command-result` — быстрый путь, опрос — гарантия.
   * -------------------------------------------------------------------- */
  var CMD_SEND_BUDGET = 3000;   // весь POST, включая повтор: не дольше 3 с
  var CMD_RESULT_WAIT = 8000;   // ждём конечный результат не дольше 8 с
  var CMD_POLL_MIN = 200;
  var CMD_POLL_MAX = 1200;
  var pendingCmds = Object.create(null);    // n → {n,sn,at,resolve,reject}
  var pumpTimer = null, pumpBusy = false, pollEvery = CMD_POLL_MIN;

  function cmdProto() { return (started && started.cmdProto) || 0; }

  function clearPending(reason) {
    var key, keys = [];
    for (key in pendingCmds) {
      if (Object.prototype.hasOwnProperty.call(pendingCmds, key)) keys.push(key);
    }
    for (var i = 0; i < keys.length; i++) {
      var pc = pendingCmds[keys[i]];
      delete pendingCmds[keys[i]];
      if (pc && pc.reject) {
        try { pc.reject(new Error(reason || 'нет лобби')); } catch (e) {}
      }
    }
    if (pumpTimer) { global.clearTimeout(pumpTimer); pumpTimer = null; }
    pumpBusy = false;
    pollEvery = CMD_POLL_MIN;
  }

  function schedulePump(ms) {
    if (pumpTimer) return;
    pumpTimer = global.setTimeout(function () { pumpTimer = null; pumpResults(); },
      ms || pollEvery);
  }

  /* Окончательный результат одной команды: резолвим промис и говорим игре
     событием — HUD покажет отказ в журнале, а не всплывашкой. */
  function settleCommand(n, r) {
    var pc = pendingCmds[n];
    if (!pc || !r) return false;
    delete pendingCmds[n];
    var out = {
      ok: r.state === 'applied', n: pc.n,
      sn: r.sn !== undefined ? r.sn : pc.sn,
      state: r.state, reason: r.reason || '',
      waitedMs: Math.max(0, Date.now() - pc.at)
    };
    try { pc.resolve(out); } catch (e) {}
    emit('command-result', out);
    return true;
  }

  function pumpResults() {
    if (!code || !token) { clearPending('нет лобби'); return; }
    var any = false, key, pc;
    for (key in pendingCmds) {
      if (!Object.prototype.hasOwnProperty.call(pendingCmds, key)) continue;
      pc = pendingCmds[key];
      if (Date.now() - pc.at >= CMD_RESULT_WAIT) {
        delete pendingCmds[key];
        try {
          pc.reject(new Error('результат команды не пришёл за ' +
            Math.round(CMD_RESULT_WAIT / 1000) + ' с'));
        } catch (e) {}
        continue;
      }
      any = true;
    }
    if (!any) { pollEvery = CMD_POLL_MIN; return; }
    if (pumpBusy) return;
    pumpBusy = true;
    apiGet('/api/command-state?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token), 4000).then(function (j) {
      pumpBusy = false;
      var list = (j && j.results) || [];
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (!r || typeof r.n !== 'number') continue;
        if (r.state === 'applied' || r.state === 'rejected' || r.state === 'expired') {
          settleCommand(r.n, r);
        }
      }
      var left = false, k2;
      for (k2 in pendingCmds) {
        if (Object.prototype.hasOwnProperty.call(pendingCmds, k2)) { left = true; break; }
      }
      if (!left) { pollEvery = CMD_POLL_MIN; return; }
      pollEvery = Math.min(CMD_POLL_MAX, pollEvery + 150);
      schedulePump();
    }, function (e) {
      pumpBusy = false;
      var msg = (e && e.message) || '';
      /* Старый сервер: /api/command-state ещё нет — конечного результата в
         природе нет, отдаём «в очереди», как раньше, и не держим игру. */
      if (/404|нет такого api/.test(msg)) {
        var keys = [], key;
        for (key in pendingCmds) {
          if (Object.prototype.hasOwnProperty.call(pendingCmds, key)) keys.push(key);
        }
        for (var i = 0; i < keys.length; i++) {
          var pc = pendingCmds[keys[i]];
          delete pendingCmds[keys[i]];
          try {
            pc.resolve({ ok: true, n: pc.n, sn: pc.sn, state: 'pending',
              legacy: true, waitedMs: Date.now() - pc.at });
          } catch (x) {}
        }
        pollEvery = CMD_POLL_MIN;
        return;
      }
      if (/403|нет доступа/.test(msg)) { clearPending('нет доступа'); return; }
      /* Сеть моргнула — ждём до общего предела, но реже. */
      var still = false, k3;
      for (k3 in pendingCmds) {
        if (Object.prototype.hasOwnProperty.call(pendingCmds, k3)) { still = true; break; }
      }
      if (still) {
        pollEvery = Math.min(CMD_POLL_MAX, pollEvery + 250);
        schedulePump();
      }
    });
  }

  function waitResult(n, sn, at) {
    return new Promise(function (resolve, reject) {
      pendingCmds[n] = { n: n, sn: sn, at: at, resolve: resolve, reject: reject };
      schedulePump(CMD_POLL_MIN);
    });
  }

  /* Возврат в партию после F5. Токен лобби — единственный пропуск, и он
     лежит в localStorage этого браузера. Никакого «войти заново»: сервер
     узнаёт того же игрока и отдаёт тот же город. */
  var STORE = '4tox.multiplayer.v1';
  var TAB = '4tox.multiplayer.tab';
  var resuming = false, pendingStart = null;

  /* Ключ — на вкладку. Так два игрока в одном браузере (и автотест с двумя
     вкладками) не затирают сессии друг друга, а F5 в той же вкладке находит
     свою. sessionStorage переживает reload, localStorage — падение вкладки. */
  function tabId() {
    try {
      var t = global.sessionStorage.getItem(TAB);
      if (!t) {
        t = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        global.sessionStorage.setItem(TAB, t);
      }
      return t;
    } catch (e) { return 'tab'; }
  }
  function storeKey() { return STORE + '.' + tabId(); }
  function storeGet() {
    try { return global.localStorage.getItem(storeKey()); } catch (e) {}
    try { return global.sessionStorage.getItem(storeKey()); } catch (e) { return null; }
  }
  function storeSet(raw) {
    try { global.localStorage.setItem(storeKey(), raw); return; } catch (e) {}
    try { global.sessionStorage.setItem(storeKey(), raw); } catch (e) {}
  }
  function storeRemove() {
    try { global.localStorage.removeItem(storeKey()); } catch (e) {}
    try { global.sessionStorage.removeItem(storeKey()); } catch (e) {}
  }

  function saveSession() {
    if (!code || !token) return;
    storeSet(JSON.stringify({
      code: code, token: token, playerId: playerId, hostId: hostId, at: Date.now()
    }));
  }

  function clearSaved() { storeRemove(); }

  function readSaved() {
    try {
      var raw = storeGet();
      if (!raw) return null;
      var v = JSON.parse(raw);
      if (!v || !v.code || !v.token) return null;
      return v;
    } catch (e) { return null; }
  }

  function hasSaved() { return !!readSaved(); }

  function restore() {
    if (code && token) return true;
    var v = readSaved();
    if (!v) return false;
    code = v.code; token = v.token;
    playerId = v.playerId === undefined ? null : v.playerId;
    hostId = v.hostId === undefined ? 0 : v.hostId;
    lobby = null; started = null; startKey = null; online = false;
    return true;
  }

  function on(type, fn) {
    (handlers[type] || (handlers[type] = [])).push(fn);
    return function () {
      handlers[type] = handlers[type].filter(function (f) { return f !== fn; });
    };
  }
  function emit(type, data) {
    (handlers[type] || []).forEach(function (fn) {
      try { fn(data); } catch (e) { /* обработчик не должен ронять сеть */ }
    });
  }

  function parse(r) {
    return r.json().then(function (j) {
      if (!r.ok || j.ok === false) throw new Error(j.reason || ('HTTP ' + r.status));
      return j;
    });
  }

  /* Запрос с пределом ожидания. Без него зависший fetch держал бы очередь
     команд и «занятый» снимок вечно — игра выглядела бы замершей, хотя сеть
     просто молчит. */
  function request(url, opts, timeoutMs) {
    var ctrl = global.AbortController ? new global.AbortController() : null;
    var timer = null;
    if (ctrl && timeoutMs) {
      timer = global.setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs);
    }
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (r) {
      if (timer) { global.clearTimeout(timer); timer = null; }
      return parse(r);
    }, function (e) {
      if (timer) { global.clearTimeout(timer); timer = null; }
      if (e && e.name === 'AbortError') throw new Error('сервер не ответил');
      throw e;
    });
  }

  function api(path, body, timeoutMs) {
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }, timeoutMs || 8000);
  }

  function apiGet(path, timeoutMs) {
    return request(path, { cache: 'no-store' }, timeoutMs || 8000);
  }

  /* Старт приходит и событием, и опросом (и повторно — при переподключении).
     Один и тот же остров не должен запускать вторую партию: сравниваем ключ
     партии и молчим, если это тот же старт. */
  function handleStart(data) {
    if (!data || !data.seed) return;
    var key = data.seed + '|' + data.size + '|' +
      (data.players || []).map(function (p) { return p.id; }).join(',');
    if (data.hostId !== undefined) hostId = data.hostId;
    /* Пока идёт /api/resume, старт по SSE не применяем: в нём ещё нет
       снимка. Дождёмся ответа и склеим их — иначе после F5 хост поднял бы
       пустой остров вместо своего. */
    if (resuming) { pendingStart = data; return; }
    if (started && startKey === key) return;
    started = data;
    startKey = key;
    saveSession();
    emit('start', data);
  }

  function useLobby(view) {
    if (!view) return;
    lobby = view;
    if (view.hostId !== undefined) hostId = view.hostId;
  }

  function connect() {
    if (es) { try { es.close(); } catch (e) {} }
    var source = new EventSource('/api/events?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token));
    es = source;
    ['hello', 'lobby', 'start', 'snapshot', 'command', 'command-result',
      'peer-left', 'peer-back', 'host-left', 'host-back'].forEach(function (type) {
        source.addEventListener(type, function (ev) {
          var data = null;
          try { data = JSON.parse(ev.data); } catch (e) { return; }
          if (type === 'hello') {
            playerId = data.playerId;
            hostId = data.hostId;
            useLobby(data.lobby);
            online = true;
            saveSession();
            emit('net-ok', data);
          } else if (type === 'lobby') {
            useLobby(data);
            saveSession();
          } else if (type === 'start') {
            handleStart(data);
            return;                        // emit делает handleStart
          } else if (type === 'command') {
            /* Хост по этому событию только будит снимок: выполнять команду
               здесь нельзя — путь выполнения один, из ответа на снимок. */
            emit('command-ready', data);
          } else if (type === 'command-result') {
            /* Быстрый путь для интерфейса; правду всё равно подтвердит опрос
               /api/command-state, если поток оборвётся. */
            if (data && typeof data.n === 'number' && settleCommand(data.n, data)) {
              return;
            }
          }
          emit(type, data);
        });
      });
    source.onopen = function () { online = true; emit('net-ok', {}); };
    source.onerror = function () {
      if (es !== source) return;
      online = false;
      emit('net-error', { message: 'связь с сервером потеряна' });
    };
  }

  function reset() {
    if (es) { try { es.close(); } catch (e) {} }
    clearPending('партия закрыта');
    es = null; token = null; code = null; playerId = null; hostId = 0;
    lobby = null; started = null; startKey = null; online = false;
    resuming = false; pendingStart = null;
    cmdSeq = 0; cmdChain = Promise.resolve();
  }

  function create(max, name) {
    reset();
    return api('/api/lobby', { max: max, name: name }).then(function (r) {
      code = r.code; token = r.token; playerId = r.playerId; hostId = r.hostId;
      if (r.players) useLobby({ code: r.code, max: r.max, players: r.players, hostId: r.hostId });
      saveSession();
      connect();
      return r;
    });
  }

  function join(c, name) {
    reset();
    return api('/api/join', { code: c, name: name }).then(function (r) {
      code = r.code; token = r.token; playerId = r.playerId; hostId = r.hostId;
      if (r.players) useLobby({ code: r.code, max: r.max, players: r.players, hostId: r.hostId });
      saveSession();
      connect();
      return r;
    });
  }

  function ready(on) {
    if (!code || !token) return Promise.reject(new Error('нет лобби'));
    return api('/api/ready', { code: code, token: token, ready: !!on })
      .then(function (r) { online = true; return r; });
  }

  /* Опрос состояния лобби. Возвращает разобранный ответ; события эмитятся те
     же, что и у SSE, — экран лобби не знает, откуда пришла правда. */
  function status() {
    if (!code || !token) return Promise.reject(new Error('нет лобби'));
    return apiGet('/api/status?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token), 5000).then(function (j) {
      online = true;
      if (j.lobby) {
        useLobby(j.lobby);
        emit('lobby', j.lobby);
      }
      if (j.started && j.start) handleStart(j.start);
      saveSession();
      return j;
    });
  }

  /* Поднять сохранённую партию. Сначала SSE (он принесёт hello и, возможно,
     start), затем /api/resume — уже со снимком. Старт, приехавший по SSE,
     откладывается в pendingStart (handleStart), чтобы не запустить игру без
     мира. */
  function resume() {
    if (!restore()) return Promise.reject(new Error('нет сохранённой партии'));
    resuming = true;
    pendingStart = null;
    connect();
    return apiGet('/api/resume?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token), 8000).then(function (j) {
      resuming = false;
      if (j.lobby) {
        useLobby(j.lobby);
        emit('lobby', j.lobby);
      }
      var st = j.start || pendingStart;
      if (st) {
        /* pendingStart — старт, который SSE успел принести раньше
           /api/resume. Он тоже настоящий, просто без снимка. */
        if (j.snapshot) st.snapshot = j.snapshot;
        if (j.seq !== undefined) st.lastSeq = j.seq;
        handleStart(st);
      }
      pendingStart = null;
      saveSession();
      return j;
    }, function (e) {
      resuming = false;
      pendingStart = null;
      /* Ответа нет — не даём SSE запустить игру без снимка: закрываем поток,
         Lobby очистит сессию и вернёт меню. */
      if (es) { try { es.close(); } catch (x) {} es = null; }
      online = false;
      throw e;
    });
  }

  function serverInfo(force) {
    if (serverInfoCache && !force) return Promise.resolve(serverInfoCache);
    return apiGet('/api/server').then(function (j) {
      serverInfoCache = j;
      return j;
    });
  }

  function delay(ms) {
    return new Promise(function (resolve) { global.setTimeout(resolve, ms); });
  }

  /* Команда хосту. Возвращаемый промис несёт `.n` — номер команды — и
     резолвится КОНЕЧНЫМ результатом: applied / rejected / expired. HTTP 200
     значит только «сервер принял в очередь»; построен дом или нет, отвечает
     /api/command-state. Отказ мира (rejected) — не сетевой сбой: промис
     резолвится с ok:false и причиной, чтобы игра показала её в журнале.
     Отклоняем только сеть и «результат не пришёл вовсе».

     Очередь отправки держим по ПРИЁМУ, а не по результату: следующая команда
     не должна ждать, пока хост построит предыдущую. Весь POST, включая
     повтор, укладывается в CMD_SEND_BUDGET = 3 с. */
  function command(cmd) {
    if (!code || !token) return Promise.reject(new Error('нет лобби'));
    var item = {}, k;
    for (k in (cmd || {})) {
      if (Object.prototype.hasOwnProperty.call(cmd, k)) item[k] = cmd[k];
    }
    item.n = nextCmdSeq();
    var at = Date.now();

    function post() {
      var deadline = Date.now() + CMD_SEND_BUDGET;
      function attempt(left) {
        var ms = Math.max(700, Math.min(2500, deadline - Date.now() + 200));
        return api('/api/command', { code: code, token: token, command: item }, ms)
          .catch(function (e) {
            if (left <= 1 || Date.now() > deadline - 150) throw e;
            return delay(120).then(function () { return attempt(left - 1); });
          });
      }
      return attempt(2);
    }

    var accepted = cmdChain.then(function () {
      /* Пока ждали очередь, могли выйти из лобби. */
      if (!code || !token) throw new Error('нет лобби');
      return post();
    });
    /* Очередь не должна застрять на неудачной команде — и не должна ждать
       конечного результата: только приёма. */
    cmdChain = accepted.catch(function () {});

    var p = accepted.then(function (r) {
      var n = item.n;
      var sn = r && typeof r.sn === 'number' ? r.sn : undefined;
      if (sn !== undefined) p.sn = sn;
      var state = r && r.state;
      if (state === 'applied' || state === 'rejected' || state === 'expired') {
        var done = {
          ok: state === 'applied', n: n, sn: sn, state: state,
          reason: (r && r.reason) || '', duplicate: !!(r && r.duplicate),
          waitedMs: Date.now() - at
        };
        emit('command-result', done);
        return done;
      }
      /* Старый сервер не умеет результатов: 200 = «в очереди», и это всё,
         что он может сказать. Новый — cmdProto:2 в старте. */
      if (cmdProto() < 2) {
        return { ok: true, n: n, sn: sn, state: 'pending', legacy: true,
          waitedMs: Date.now() - at };
      }
      return waitResult(n, sn, at);
    });
    p.n = item.n;
    p.catch(function (e) {
      emit('command-error', { command: item,
        message: (e && e.message) || 'команда не ушла' });
    });
    return p;
  }

  /* Один результат по номеру — для приёмки и отладки; игра пользуется
     ожиданием промиса выше. */
  function commandState(n) {
    if (!code || !token) return Promise.reject(new Error('нет лобби'));
    var q = '/api/command-state?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token) +
      (n !== undefined ? '&n=' + encodeURIComponent(n) : '');
    return apiGet(q, 4000);
  }

  /* Сжать тело снимка в браузере. CompressionStream есть во всех современных
     браузерах; нет его — вернём null и пошлём обычный JSON.
     Поток берётся из `new Response(text).body`, а НЕ из `new Blob([text])
     .stream()`: замер в Chrome — 0,2 мс против 14 мс на кадр. Blob-поток
     отдаёт данные отдельной задачей, и при 12,5 кадрах в секунду снимки
     редели до шести: хост ждал собственную упаковку, а не сеть. */
  function gzipBody(text) {
    if (!global.CompressionStream || !global.Response) return null;
    try {
      var body = new global.Response(text).body;
      if (!body) return null;
      var stream = body.pipeThrough(new global.CompressionStream('gzip'));
      return new global.Response(stream).arrayBuffer().then(function (buf) {
        return new Uint8Array(buf);
      });
    } catch (e) { return null; }
  }

  /* Снимок хоста. Ошибку НЕ глотаем: play.js по ней понимает, что кадр не
     ушёл, и не запускает следующий, пока этот не завершился (иначе при
     медленной сети запросы копились бы и клиент видел устаревшие кадры).

     В VPS-режиме этот POST идёт не по loopback, а с домашнего интернета на
     релей: 5,2 КБ × 12,5 = 520 Кбит/с ВВЕРХ, и канал хоста (тот же, из
     которого играют) заполняется. Поэтому тело сжимается gzip, если сервер
     сказал `snapGzip` в старте. Без CompressionStream или старого сервера
     уходит обычный JSON — приём одинаковый. */
  function snapshot(snap) {
    if (!code || !token || playerId !== hostId) return Promise.resolve(null);
    var body = JSON.stringify({ code: code, token: token, snapshot: snap });
    var headers = { 'content-type': 'application/json' };
    function send(payload) {
      return request('/api/snapshot', {
        method: 'POST', headers: headers, body: payload
      }, 6000);
    }
    if (started && started.snapGzip) {
      var packed = gzipBody(body);
      if (packed) {
        return packed.then(function (bytes) {
          headers['content-encoding'] = 'gzip';
          return send(bytes);
        }, function () { return send(body); });
      }
    }
    return send(body);
  }

  function start() {
    if (!code || !token) return Promise.reject(new Error('нет лобби'));
    return api('/api/start', { code: code, token: token }, 10000).then(function (j) {
      /* Старт мог не дойти событием (SSE как раз и умирает первым) —
         ответ на кнопку несёт тот же пакет. handleStart защищён от повтора. */
      if (j && j.start) handleStart(j.start);
      return j;
    });
  }

  /* Круг до сервера. Не «пинг хоста», но именно он показывает, жива ли
     связь, и даёт игроку число вместо «вроде лагает». Код и токен здесь не
     для ответа, а чтобы сервер знал: игрок жив. Для хоста это heartbeat —
     даже если снимок задержался, «хост потерян» не объявят.

     Число берётся из Resource Timing (requestStart → responseEnd), а не из
     разницы performance.now() вокруг промиса. Разница меряет ещё и главный
     поток: если браузер друга занят кадром на 400 мс, честный круг в 20 мс
     показывался как «420 мс», и игрок шёл чинить интернет вместо того, чтобы
     уменьшить окно. Resource Timing живёт в сетевом стеке и от кадров не
     зависит; запасное число (msWall) остаётся для браузеров без него. */
  function resourceRtt(t0) {
    try {
      var p = global.performance;
      if (!p || !p.getEntriesByType) return 0;
      var list = p.getEntriesByType('resource');
      for (var i = list.length - 1; i >= 0; i--) {
        var e = list[i];
        if ((e.name || '').indexOf('/api/ping') < 0) continue;
        if (e.startTime + 0.5 < t0) continue;         // круг прошлых секунд
        if (!(e.requestStart > 0) || !(e.responseEnd > 0)) continue;
        var ms = e.responseEnd - e.requestStart;
        if (ms >= 0) return Math.round(ms);
      }
    } catch (e) { /* нет Resource Timing — ниже запасной замер */ }
    return 0;
  }

  function ping() {
    if (!code || !token) return Promise.reject(new Error('нет лобби'));
    /* Буфер Resource Timing ограничен; чистим перед своим кругом, чтобы
       запись не вытеснилась долгой партией. */
    try {
      if (global.performance && global.performance.clearResourceTimings) {
        global.performance.clearResourceTimings();
      }
    } catch (e) {}
    var t0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    return apiGet('/api/ping?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token), 4000).then(function (j) {
      var t1 = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
      var wall = Math.max(0, Math.round(t1 - t0));
      var net = resourceRtt(t0);
      j.msWall = wall;
      j.ms = net > 0 ? net : wall;
      j.measuredBy = net > 0 ? 'network' : 'wall';
      return j;
    });
  }

  function leave() {
    var c = code, t = token;
    clearSaved();
    reset();
    if (!c || !t) return Promise.resolve();
    return api('/api/leave', { code: c, token: t }).catch(function () {});
  }

  global.Net = {
    create: create,
    join: join,
    ready: ready,
    start: start,
    command: command,
    commandState: commandState,
    pendingCommands: function () {
      var c = 0, k;
      for (k in pendingCmds) if (Object.prototype.hasOwnProperty.call(pendingCmds, k)) c++;
      return c;
    },
    snapshot: snapshot,
    status: status,
    resume: resume,
    hasSaved: hasSaved,
    clearSaved: clearSaved,
    serverInfo: serverInfo,
    ping: ping,
    leave: leave,
    reset: reset,
    on: on,
    isHost: function () { return playerId !== null && playerId === hostId; },
    playerId: function () { return playerId; },
    hostId: function () { return hostId; },
    code: function () { return code; },
    lobby: function () { return lobby; },
    started: function () { return started; },
    online: function () { return online; },
    connected: function () { return !!es; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
