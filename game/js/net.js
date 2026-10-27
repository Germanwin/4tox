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
  /* Устойчивая клиентская сессия комнаты: instance выдаёт сервер, sequence
     переживает F5. Сброс ID на 1 внутри той же instance запрещён — иначе
     сервер не отличит новую команду от повтора старой. */
  var roomId = null, roomEpoch = 0, clientInstance = null, clientSeq = 0;

  /* Версия формата этого клиента. Сервер отвечает своей (`protocol` в
     /api/build и в старте); расхождение — только предупреждение, не отказ. */
  var CLIENT_PROTOCOL = 4;

  /* Поколение партии. Растёт в reset()/create()/join()/resume(). Любой
     асинхронный ответ (status/resume/command/command-state/snapshot) несёт
     снимок поколения и, если оно уже сменилось, НЕ применяется: иначе
     ответ старой партии снимал бы busy новой, дописывал старый лобби и
     запускал чужой остров. */
  var generation = 0;
  function bumpGeneration() { generation++; return generation; }
  function isCurrent(gen) { return gen === generation; }

  /* Пределы ожидания. Вынесены в один объект, чтобы приёмка могла сделать
     их короткими и проверить таймауты без восьмисекундного ожидания; игра
     значения не меняет. */
  var LIMITS = {
    request: 8000,       // обычный POST/GET
    status: 5000,        // опрос лобби
    resume: 8000,        // возврат в партию
    start: 10000,        // кнопка «Начать игру»
    commandState: 4000,  // опрос результата команды
    ping: 4000,
    snapshot: 6000,      // POST снимка
    snapshotPack: 1500,  // упаковка gzip ДО отправки
    commandSend: 3000,   // весь POST команды с повтором
    commandResult: 8000, // ожидание applied/rejected/expired
    pollMin: 200,
    pollMax: 1200
  };
  function setLimits(patch) {
    if (patch && typeof patch === 'object') {
      Object.keys(patch).forEach(function (k) {
        if (!Object.prototype.hasOwnProperty.call(LIMITS, k)) return;
        var v = patch[k];
        if (typeof v === 'number' && isFinite(v) && v >= 0) LIMITS[k] = v;
      });
    }
    return Object.assign({}, LIMITS);
  }

  /* Ошибки различаются полем kind: play.js по нему решает, показать
     «результат уточняется» (timeout) или «сервер отказал» (http/parse). */
  function makeError(kind, message, extra) {
    var e = new Error(message);
    e.kind = kind;
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }
  function timeoutError(ms, phase) {
    return makeError('timeout', 'сервер не ответил за ' + Math.round(ms) + ' мс',
      { timeoutMs: ms, phase: phase || 'request' });
  }
  function httpError(status, reason) {
    return makeError('http', reason || ('HTTP ' + status), { status: status });
  }
  function parseError(status, message) {
    return makeError('parse', message || 'ответ сервера не JSON', { status: status });
  }
  function networkError(cause) {
    var e = makeError('network', 'сеть недоступна' +
      (cause && cause.message ? ': ' + cause.message : ''));
    e.cause = cause;
    return e;
  }
  function staleError() {
    return makeError('stale', 'партия уже сменилась');
  }
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
  var pendingCmds = Object.create(null);    // n → {n,sn,at,gen,resolve,reject}
  var pumpTimer = null, pumpBusy = false, pollEvery = LIMITS.pollMin;
  /* Сколько команд сейчас в фазе отправки. Приёмка проверяет, что после
     ошибки/смены партии счётчик возвращается к нулю, а не залипает. */
  var sendBusy = 0;

  function cmdProto() { return (started && started.cmdProto) || 0; }

  function clearPending(reason, kind) {
    var key, keys = [];
    for (key in pendingCmds) {
      if (Object.prototype.hasOwnProperty.call(pendingCmds, key)) keys.push(key);
    }
    for (var i = 0; i < keys.length; i++) {
      var pc = pendingCmds[keys[i]];
      delete pendingCmds[keys[i]];
      if (pc && pc.reject) {
        try {
          pc.reject(makeError(kind || 'stale', reason || 'нет лобби',
            { n: pc.n, commandId: pc.n }));
        } catch (e) {}
      }
    }
    if (pumpTimer) { global.clearTimeout(pumpTimer); pumpTimer = null; }
    pumpBusy = false;
    pollEvery = LIMITS.pollMin;
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
    /* Ответ старой партии не должен ни резолвить чужую команду, ни снимать
       busy новой. */
    if (pc.gen !== undefined && pc.gen !== generation) {
      try { pc.reject(staleError()); } catch (e) {}
      return false;
    }
    var unknown = r.state === 'unknown';
    var out = {
      ok: r.state === 'applied', n: pc.n, commandId: pc.n,
      sn: r.sn !== undefined ? r.sn : pc.sn,
      state: r.state, reason: r.reason || '',
      /* `unknown` — не отказ: сервер честно не знает, выполнялась ли команда.
         Промис резолвится, игра показывает «результат уточняется» и не
         считает это доказанным rejected. */
      unknown: unknown, pending: unknown,
      ids: Array.isArray(r.ids) ? r.ids : [],
      appliedSeq: typeof r.appliedSeq === 'number' ? r.appliedSeq : 0,
      waitedMs: Math.max(0, Date.now() - pc.at)
    };
    try { pc.resolve(out); } catch (e) {}
    emit('command-result', out);
    return true;
  }

  function pumpResults() {
    if (!code || !token) { clearPending('нет лобби', 'stale'); return; }
    var any = false, key, pc;
    for (key in pendingCmds) {
      if (!Object.prototype.hasOwnProperty.call(pendingCmds, key)) continue;
      pc = pendingCmds[key];
      if (Date.now() - pc.at >= LIMITS.commandResult) {
        delete pendingCmds[key];
        try {
          pc.reject(makeError('timeout',
            'результат команды не пришёл за ' +
            Math.round(LIMITS.commandResult / 1000) + ' с',
            { n: pc.n, commandId: pc.n, phase: 'command-result' }));
        } catch (e) {}
        continue;
      }
      any = true;
    }
    if (!any) { pollEvery = LIMITS.pollMin; return; }
    if (pumpBusy) return;
    var gen = generation;
    pumpBusy = true;
    var req;
    try {
      req = apiGet('/api/command-state?code=' + encodeURIComponent(code) +
        '&token=' + encodeURIComponent(token), LIMITS.commandState);
    } catch (e) {
      pumpBusy = false;
      schedulePump();
      return;
    }
    req.then(function (j) {
      /* Поздний ответ старой партии не трогает ни pendingCmds, ни busy
         новой: выходим ДО любых присваиваний. */
      if (!isCurrent(gen)) return;
      try {
        var list = (j && j.results) || [];
        for (var i = 0; i < list.length; i++) {
          var r = list[i];
          if (!r || typeof r.n !== 'number') continue;
          if (r.state === 'applied' || r.state === 'rejected' ||
              r.state === 'expired' || r.state === 'unknown') {
            settleCommand(r.n, r);
          }
        }
        var left = false, k2;
        for (k2 in pendingCmds) {
          if (Object.prototype.hasOwnProperty.call(pendingCmds, k2)) { left = true; break; }
        }
        if (!left) { pollEvery = LIMITS.pollMin; return; }
        pollEvery = Math.min(LIMITS.pollMax, pollEvery + 150);
        schedulePump();
      } finally {
        /* busy снимается в любом исходе, включая исключение обработчика:
           иначе следующая команда не получила бы результата вовсе. */
        if (isCurrent(gen)) pumpBusy = false;
      }
    }, function (e) {
      if (!isCurrent(gen)) return;
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
            pc.resolve({ ok: true, n: pc.n, commandId: pc.n, sn: pc.sn,
              state: 'pending', legacy: true, waitedMs: Date.now() - pc.at });
          } catch (x) {}
        }
        pollEvery = LIMITS.pollMin;
        return;
      }
      if (/403|нет доступа/.test(msg)) { clearPending('нет доступа', 'stale'); return; }
      /* Сеть моргнула — ждём до общего предела, но реже. Таймаут опроса не
         выдаём за отказ: команда может быть применена. */
      var still = false, k3;
      for (k3 in pendingCmds) {
        if (Object.prototype.hasOwnProperty.call(pendingCmds, k3)) { still = true; break; }
      }
      if (still) {
        pollEvery = Math.min(LIMITS.pollMax, pollEvery + 250);
        schedulePump();
      }
    });
  }

  function waitResult(n, sn, at, gen) {
    return new Promise(function (resolve, reject) {
      if (gen !== undefined && gen !== generation) {
        reject(staleError());
        return;
      }
      pendingCmds[n] = { n: n, commandId: n, sn: sn, at: at,
        gen: gen === undefined ? generation : gen, resolve: resolve, reject: reject };
      schedulePump(LIMITS.pollMin);
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
      code: code, token: token, playerId: playerId, hostId: hostId,
      roomId: roomId, epoch: roomEpoch,
      instance: clientInstance, seq: clientSeq, at: Date.now()
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
    roomId = v.roomId || null;
    roomEpoch = v.epoch || 0;
    clientInstance = v.instance || null;
    clientSeq = v.seq || 0;
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

  /* Тело ответа читается и разбирается ВНУТРИ общего предела запроса:
     `r.json()` (а значит и JSON.parse) — такая же часть сети, как fetch.
     Раньше таймер снимался, едва пришли заголовки, и ответ с телом, которое
     никогда не кончается, держал промис вечно (воспроизведение: заголовки
     сразу, тело не приходит, timeout=20 мс, через 80 мс промис pending и
     signal.aborted=false). */
  function parse(r) {
    return r.text().then(function (text) {
      var j = null, bad = false;
      try { j = text ? JSON.parse(text) : {}; }
      catch (e) { bad = true; }
      if (!r.ok) {
        var he = httpError(r.status, (j && j.reason) || ('HTTP ' + r.status));
        he.body = j;
        if (j && j.code) he.code = j.code;
        throw he;
      }
      if (bad) throw parseError(r.status, 'ответ сервера не JSON');
      if (j && j.ok === false) {
        var je = httpError(r.status, j.reason || ('HTTP ' + r.status));
        je.body = j;
        if (j.code) je.code = j.code;
        throw je;
      }
      return j;
    }, function (e) {
      throw networkError(e);
    });
  }

  /* Запрос с пределом ожидания НА ВЕСЬ ОТВЕТ, включая тело. Без него
     зависший fetch держал бы очередь команд и «занятый» снимок вечно — игра
     выглядела бы замершей, хотя сеть просто молчит. */
  function request(url, opts, timeoutMs) {
    opts = opts || {};
    var ms = (timeoutMs === undefined || timeoutMs === null)
      ? LIMITS.request : timeoutMs;
    var ctrl = global.AbortController ? new global.AbortController() : null;
    if (ctrl) opts.signal = ctrl.signal;
    return new Promise(function (resolve, reject) {
      var done = false, timedOut = false, timer = null;
      function finish(err, value) {
        if (done) return;
        done = true;
        if (timer) { global.clearTimeout(timer); timer = null; }
        if (err) reject(err);
        else resolve(value);
      }
      if (ctrl && ms > 0) {
        timer = global.setTimeout(function () {
          timedOut = true;
          try { ctrl.abort(); } catch (e) {}
          finish(timeoutError(ms));
        }, ms);
      }
      var fp;
      try { fp = fetch(url, opts); }
      catch (e) { finish(networkError(e)); return; }
      Promise.resolve(fp).then(function (r) {
        if (done) return null;
        return parse(r);
      }).then(function (j) {
        if (!done) finish(null, j);
      }, function (e) {
        if (done) return;
        /* Обрыв, который случился уже после нашего таймера, — таймаут, а не
           отдельная ошибка: игра должна показать «результат уточняется», а
           не «сервер отказал». */
        if (timedOut || (e && e.name === 'AbortError')) {
          finish(timeoutError(ms));
          return;
        }
        if (e && e.kind) { finish(e); return; }
        finish(networkError(e));
      });
    });
  }

  function api(path, body, timeoutMs) {
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }, timeoutMs === undefined ? LIMITS.request : timeoutMs);
  }

  function apiGet(path, timeoutMs) {
    return request(path, { cache: 'no-store' },
      timeoutMs === undefined ? LIMITS.request : timeoutMs);
  }

  /* Старт приходит и событием, и опросом (и повторно — при переподключении).
     Один и тот же остров не должен запускать вторую партию: сравниваем ключ
     партии и молчим, если это тот же старт. */
  function handleStart(data) {
    if (!data || !data.seed) return;
    var key = data.seed + '|' + data.size + '|' +
      (data.players || []).map(function (p) { return p.id; }).join(',') +
      '|' + (data.roomId || '') + '|' + (data.epoch || 0);
    if (data.hostId !== undefined) hostId = data.hostId;
    if (data.roomId) roomId = data.roomId;
    if (data.epoch !== undefined) roomEpoch = data.epoch;
    var me = null;
    for (var i = 0; i < (data.players || []).length; i++) {
      if (data.players[i] && data.players[i].id === playerId) { me = data.players[i]; break; }
    }
    if (me) {
      if (me.instance) clientInstance = me.instance;
      if (!clientInstance) clientInstance = 's' + (me.owner || 0) + '-' + String(playerId);
      if (me.nextClientSequence === undefined && !clientSeq) clientSeq = 0;
    }
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
    var gen = generation;
    var source = new EventSource('/api/events?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token));
    es = source;
    ['hello', 'lobby', 'start', 'snapshot', 'command', 'command-result',
      'peer-left', 'peer-back', 'host-left', 'host-back', 'room-fault'].forEach(function (type) {
      source.addEventListener(type, function (ev) {
        /* Событие старого соединения после reset/create не должно оживлять
           прежнюю партию: проверяем и поколение, и то, что это всё ещё наш
           EventSource. */
        if (!isCurrent(gen) || es !== source) return;
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
    source.onopen = function () {
      if (!isCurrent(gen) || es !== source) return;
      online = true;
      emit('net-ok', {});
    };
    source.onerror = function () {
      if (!isCurrent(gen) || es !== source) return;
      online = false;
      emit('net-error', { message: 'связь с сервером потеряна' });
    };
  }

  function reset() {
    bumpGeneration();
    if (es) { try { es.close(); } catch (e) {} }
    clearPending('партия закрыта', 'stale');
    es = null; token = null; code = null; playerId = null; hostId = 0;
    lobby = null; started = null; startKey = null; online = false;
    roomId = null; roomEpoch = 0; clientInstance = null; clientSeq = 0;
    resuming = false; pendingStart = null;
    cmdSeq = 0; cmdChain = Promise.resolve();
    sendBusy = 0;
    serverInfoCache = null;
  }

  function create(max, name) {
    reset();
    var gen = generation;
    return api('/api/lobby', {
      max: max, name: name,
      protocol: CLIENT_PROTOCOL, build: 'net.js'
    }).then(function (r) {
      if (!isCurrent(gen)) throw staleError();
      code = r.code; token = r.token; playerId = r.playerId; hostId = r.hostId;
      if (r.players) useLobby({ code: r.code, max: r.max, players: r.players, hostId: r.hostId });
      saveSession();
      connect();
      return r;
    }, function (e) {
      if (!isCurrent(gen)) throw staleError();
      throw e;
    });
  }

  function join(c, name) {
    reset();
    var gen = generation;
    return api('/api/join', {
      code: c, name: name,
      protocol: CLIENT_PROTOCOL, build: 'net.js'
    }).then(function (r) {
      if (!isCurrent(gen)) throw staleError();
      code = r.code; token = r.token; playerId = r.playerId; hostId = r.hostId;
      if (r.players) useLobby({ code: r.code, max: r.max, players: r.players, hostId: r.hostId });
      saveSession();
      connect();
      return r;
    }, function (e) {
      if (!isCurrent(gen)) throw staleError();
      throw e;
    });
  }

  function ready(on) {
    if (!code || !token) return Promise.reject(makeError('state', 'нет лобби'));
    var gen = generation;
    return api('/api/ready', { code: code, token: token, ready: !!on }).then(function (r) {
      if (!isCurrent(gen)) throw staleError();
      online = true;
      return r;
    }, function (e) {
      if (!isCurrent(gen)) throw staleError();
      throw e;
    });
  }

  /* Опрос состояния лобби. Возвращает разобранный ответ; события эмитятся те
     же, что и у SSE, — экран лобби не знает, откуда пришла правда. */
  function status() {
    if (!code || !token) return Promise.reject(makeError('state', 'нет лобби'));
    var gen = generation;
    return apiGet('/api/status?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token), LIMITS.status).then(function (j) {
      /* Поздний ответ старой партии не применяем и не снимаем busy новой:
         ни lobby, ни start, ни online. */
      if (!isCurrent(gen)) throw staleError();
      online = true;
      if (j.lobby) {
        useLobby(j.lobby);
        emit('lobby', j.lobby);
      }
      if (j.started && j.start) handleStart(j.start);
      saveSession();
      return j;
    }, function (e) {
      if (!isCurrent(gen)) throw staleError();
      throw e;
    });
  }

  /* Поднять сохранённую партию. Сначала SSE (он принесёт hello и, возможно,
     start), затем /api/resume — уже со снимком. Старт, приехавший по SSE,
     откладывается в pendingStart (handleStart), чтобы не запустить игру без
     мира. */
  function resume() {
    if (!restore()) return Promise.reject(makeError('state', 'нет сохранённой партии'));
    /* Новое поколение: опрос лобби, начатый до /api/resume, уже не должен
       применяться к поднятой партии. */
    bumpGeneration();
    /* Старые команды/опросы принадлежат прежнему поколению: их результат
       уже нельзя применить, а их busy не должен держать новое. */
    clearPending('возврат в партию', 'stale');
    cmdChain = Promise.resolve();
    sendBusy = 0;
    var gen = generation;
    resuming = true;
    pendingStart = null;
    connect();
    return apiGet('/api/resume?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token), LIMITS.resume).then(function (j) {
      if (!isCurrent(gen)) throw staleError();
      resuming = false;
      if (j.lobby) {
        useLobby(j.lobby);
        emit('lobby', j.lobby);
      }
      var st = j.start || pendingStart;
      if (st) {
        /* pendingStart — старт, который SSE успел принести раньше
           /api/resume. Он тоже настоящий, просто без снимка. */
        if (j.baseline) st.baseline = j.baseline;
        else if (j.snapshot) st.baseline = j.snapshot;
        if (j.room) st.room = j.room;
        if (j.session) {
          st.session = j.session;
          if (j.session.instance) clientInstance = j.session.instance;
          if (j.session.epoch !== undefined) roomEpoch = j.session.epoch;
          if (j.session.roomId) roomId = j.session.roomId;
        }
        if (j.seq !== undefined) st.lastSeq = j.seq;
        handleStart(st);
      }
      pendingStart = null;
      saveSession();
      return j;
    }, function (e) {
      /* Ответ старой попытки не трогает состояние новой партии. */
      if (!isCurrent(gen)) throw staleError();
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
    var gen = generation;
    return apiGet('/api/server', LIMITS.request).then(function (j) {
      if (!isCurrent(gen)) throw staleError();
      serverInfoCache = j;
      return j;
    }, function (e) {
      if (!isCurrent(gen)) throw staleError();
      throw e;
    });
  }

  function delay(ms) {
    return new Promise(function (resolve) { global.setTimeout(resolve, ms); });
  }

  /* Команда хосту. Возвращаемый промис несёт `.n` и `.commandId` — номер
     команды — и резолвится КОНЕЧНЫМ результатом: applied / rejected /
     expired. HTTP 200 значит только «сервер принял в очередь»; построен дом
     или нет, отвечает /api/command-state. Отказ мира (rejected) — не сетевой
     сбой: промис резолвится с ok:false и причиной. Отклоняем только сеть,
     смену партии и «результат не пришёл вовсе» — и у ошибки стоит kind:
     timeout/network/stale, чтобы игра показала «результат уточняется», а не
     выдала молчание за доказанный отказ.

     Повтор после обрыва несёт ТОТ ЖЕ item.n: сервер по паре (from,n) узнает
     повтор и не выполнит действие дважды. Повторов не больше двух, весь POST
     включая повтор укладывается в LIMITS.commandSend. */
  /* ---------------- команда нового протокола (room-authoritative) ------ *
   *
   * Клиент не создаёт «n от часов» и не ждёт хоста: есть устойчивая instance
   * и строго последовательный clientSequence. HTTP 202 значит `received`;
   * настоящий результат приходит из /api/command-state по commandId. Повтор
   * после обрыва несёт тот же commandId и тот же payload — сервер вернёт
   * прежний результат, а не выполнит действие второй раз.
   * -------------------------------------------------------------------- */
  function commandPayload(cmd) {
    if (cmd.payload && typeof cmd.payload === 'object') return cmd.payload;
    var out = {};
    ['buildingType', 'variant', 'rot', 'x', 'y', 'x2', 'y2', 'id', 'action',
      'campId', 'villagerId', 'ids'].forEach(function (k) {
      if (cmd[k] !== undefined) out[k] = cmd[k];
    });
    return out;
  }

  function commandDone(res, seq, commandId) {
    var state = res && res.status ? res.status : 'unknown';
    return {
      ok: state === 'applied', n: seq, commandId: commandId,
      state: state, reason: (res && res.reason) || '',
      reasonCode: (res && res.reasonCode) || null,
      ids: (res && res.ids) || [],
      appliedSeq: (res && res.appliedRevision) || 0,
      appliedRevision: (res && res.appliedRevision) || 0,
      appliedTick: res && res.appliedTick,
      unknown: state === 'unknown',
      pending: state === 'received'
    };
  }

  function waitCommandV4(commandId, seq, first, gen) {
    if (first && (first.status === 'applied' || first.status === 'rejected' ||
        first.status === 'expired' || first.status === 'history_expired')) {
      var done = commandDone(first, seq, commandId);
      emit('command-result', done);
      return Promise.resolve(done);
    }
    var started = Date.now();
    return new Promise(function (resolve, reject) {
      function poll() {
        if (!isCurrent(gen)) return reject(staleError());
        if (Date.now() - started > LIMITS.commandResult) {
          return resolve({
            ok: false, n: seq, commandId: commandId, state: 'unknown',
            unknown: true, reason: 'результат уточняется', ids: []
          });
        }
        var q = '/api/command-state?code=' + encodeURIComponent(code) +
          '&token=' + encodeURIComponent(token) +
          '&id=' + encodeURIComponent(commandId);
        apiGet(q, LIMITS.commandState).then(function (j) {
          if (!isCurrent(gen)) return reject(staleError());
          if (j && typeof j.nextClientSequence === 'number' &&
              j.nextClientSequence - 1 > clientSeq) {
            clientSeq = j.nextClientSequence - 1;
            saveSession();
          }
          var list = j && j.results ? j.results : [];
          var r = null;
          for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].commandId === commandId) { r = list[i]; break; }
          }
          if (r && (r.status === 'applied' || r.status === 'rejected' ||
              r.status === 'expired' || r.status === 'history_expired')) {
            var done = commandDone(r, seq, commandId);
            emit('command-result', done);
            return resolve(done);
          }
          global.setTimeout(poll, 220);
        }, function () {
          global.setTimeout(poll, 320);
        });
      }
      global.setTimeout(poll, 160);
    });
  }

  function commandV4(cmd) {
    if (!code || !token) return Promise.reject(makeError('state', 'нет лобби'));
    var gen = generation;
    if (!clientInstance) clientInstance = 's0-' + String(playerId);
    if (!roomId) roomId = code;
    var seq = ++clientSeq;
    var commandId = clientInstance + ':' + seq;
    saveSession();
    var envelope = {
      protocol: CLIENT_PROTOCOL,
      roomId: roomId,
      epoch: roomEpoch,
      commandId: commandId,
      clientSequence: seq,
      type: cmd.type,
      payload: commandPayload(cmd)
    };
    /* Строго по одной: новый clientSequence уходит только после receipt
       предыдущего. Иначе сервер справедливо ответит sequence_gap на вторую
       команду, обогнавшую первую в сети. */
    var accepted = cmdChain.then(function () {
      if (!isCurrent(gen)) throw staleError();
      return api('/api/command', { code: code, token: token, command: envelope },
        LIMITS.commandSend);
    });
    cmdChain = accepted.catch(function () {});
    var p = accepted.then(function (r) {
      if (!isCurrent(gen)) throw staleError();
      if (r && typeof r.nextClientSequence === 'number' &&
          r.nextClientSequence - 1 > clientSeq) {
        clientSeq = r.nextClientSequence - 1;
        saveSession();
      }
      return waitCommandV4(commandId, seq, r, gen);
    }, function (e) {
      if (!isCurrent(gen)) throw staleError();
      /* admitted:false — команда НЕ принята, ID не consumed. Это не сетевой
         сбой: показываем точную причину и разрешаем тот же ID позже. */
      if (e && e.body && e.body.admitted === false) {
        /* ID НЕ consumed: возвращаем счётчик, чтобы повтор с тем же ID не
           получил sequence_gap. */
        if (clientSeq === seq) {
          clientSeq = Math.max(0, seq - 1);
          saveSession();
        }
        if (e.body.code === 'stale_epoch' && e.body.epoch !== undefined) {
          roomEpoch = e.body.epoch;
          saveSession();
        }
        var refused = {
          ok: false, n: seq, commandId: commandId, state: 'rejected',
          reason: e.body.reason || e.message, reasonCode: e.body.code || null,
          admitted: false, ids: []
        };
        emit('command-result', refused);
        return refused;
      }
      if (e && typeof e === 'object') {
        e.commandId = commandId;
        e.n = seq;
      }
      throw e;
    });
    p.commandId = commandId;
    p.n = seq;
    p.catch(function (e) {
      if (e && typeof e === 'object') {
        if (e.commandId === undefined) e.commandId = commandId;
        if (e.n === undefined) e.n = seq;
      }
      emit('command-error', {
        command: cmd, n: seq, commandId: commandId,
        kind: (e && e.kind) || 'network',
        message: (e && e.message) || 'команда не ушла'
      });
    });
    return p;
  }

  function command(cmd) {
    if (!code || !token) return Promise.reject(makeError('state', 'нет лобби'));
    /* Новый сервер отдаёт roomId и protocol 4 в старте. Старый путь остаётся
       только для чтения старого лобби; в running-комнате он недостижим. */
    if (started && started.roomId && (started.protocol || 4) >= 4) {
      return commandV4(cmd);
    }
    var gen = generation;
    var item = {}, k;
    for (k in (cmd || {})) {
      if (Object.prototype.hasOwnProperty.call(cmd, k)) item[k] = cmd[k];
    }
    item.n = nextCmdSeq();
    var at = Date.now();
    var attempts = 0;

    function post() {
      var deadline = Date.now() + LIMITS.commandSend;
      function attempt(left) {
        attempts++;
        var ms = Math.max(700, Math.min(2500, deadline - Date.now() + 200));
        return api('/api/command', { code: code, token: token, command: item }, ms)
          .catch(function (e) {
            if (!isCurrent(gen)) throw staleError();
            if (left <= 1 || Date.now() > deadline - 150) throw e;
            return delay(120).then(function () {
              if (!isCurrent(gen)) throw staleError();
              return attempt(left - 1);
            });
          });
      }
      return attempt(2);
    }

    var accepted = cmdChain.then(function () {
      /* Пока ждали очередь, могли выйти из лобби или начать другую партию. */
      if (!code || !token) throw makeError('state', 'нет лобби');
      if (!isCurrent(gen)) throw staleError();
      return post();
    });
    /* Очередь не должна застрять на неудачной команде — и не должна ждать
       конечного результата: только приёма. */
    cmdChain = accepted.catch(function () {});

    if (isCurrent(gen)) sendBusy++;
    accepted.then(function () {
      if (isCurrent(gen)) sendBusy = Math.max(0, sendBusy - 1);
    }, function () {
      if (isCurrent(gen)) sendBusy = Math.max(0, sendBusy - 1);
    });

    var p = accepted.then(function (r) {
      if (!isCurrent(gen)) throw staleError();
      var n = item.n;
      var sn = r && typeof r.sn === 'number' ? r.sn : undefined;
      if (sn !== undefined) p.sn = sn;
      var state = r && r.state;
      if (state === 'applied' || state === 'rejected' ||
          state === 'expired' || state === 'unknown') {
        var done = {
          ok: state === 'applied', n: n, commandId: n, sn: sn, state: state,
          reason: (r && r.reason) || '', duplicate: !!(r && r.duplicate),
          unknown: state === 'unknown', pending: state === 'unknown',
          ids: (r && Array.isArray(r.ids)) ? r.ids : [],
          appliedSeq: (r && typeof r.appliedSeq === 'number') ? r.appliedSeq : 0,
          attempts: attempts, waitedMs: Date.now() - at
        };
        emit('command-result', done);
        return done;
      }
      /* Старый сервер не умеет результатов: 200 = «в очереди», и это всё,
         что он может сказать. Новый — cmdProto:2 в старте. */
      if (cmdProto() < 2) {
        return { ok: true, n: n, commandId: n, sn: sn, state: 'pending',
          legacy: true, attempts: attempts, waitedMs: Date.now() - at };
      }
      return waitResult(n, sn, at, gen);
    }, function (e) {
      if (!isCurrent(gen)) throw staleError();
      throw e;
    });
    p.n = item.n;
    p.commandId = item.n;
    p.catch(function (e) {
      if (e && typeof e === 'object') {
        if (e.n === undefined) e.n = item.n;
        if (e.commandId === undefined) e.commandId = item.n;
        if (e.state === undefined) e.state = 'unknown';
      }
      emit('command-error', {
        command: item, n: item.n, commandId: item.n,
        kind: (e && e.kind) || 'network',
        message: (e && e.message) || 'команда не ушла'
      });
    });
    return p;
  }

  /* Один результат по номеру — для приёмки и отладки; игра пользуется
     ожиданием промиса выше. */
  function commandState(ids) {
    if (!code || !token) return Promise.reject(makeError('state', 'нет лобби'));
    var gen = generation;
    var q = '/api/command-state?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token);
    if (Array.isArray(ids)) {
      ids.forEach(function (id) {
        if (id !== undefined && id !== null) q += '&id=' + encodeURIComponent(String(id));
      });
    } else if (ids !== undefined && ids !== null) {
      q += '&id=' + encodeURIComponent(String(ids));
    }
    if (clientSeq > 0 && started && started.roomId) {
      q += '&watermark=' + encodeURIComponent(clientSeq);
    }
    return apiGet(q, LIMITS.commandState).then(function (j) {
      if (!isCurrent(gen)) throw staleError();
      if (j && typeof j.nextClientSequence === 'number' &&
          j.nextClientSequence - 1 > clientSeq) {
        clientSeq = j.nextClientSequence - 1;
        saveSession();
      }
      return j;
    }, function (e) {
      if (!isCurrent(gen)) throw staleError();
      throw e;
    });
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
    /* В комнате нового протокола снимок строит сервер. Клиент, который всё
       ещё позвал это, получает явный отказ, а не молчаливый 409. */
    if (started && started.roomId && (started.protocol || 4) >= 4) {
      var sa = makeError('server-authoritative',
        'мир считает сервер: клиентский снимок больше не публикуется');
      sa.code = 'server_authoritative';
      return Promise.reject(sa);
    }
    var gen = generation;
    var body;
    try {
      body = JSON.stringify({ code: code, token: token, snapshot: snap });
    } catch (e) {
      var se = makeError('serialize', 'снимок не сериализуется');
      se.cause = e;
      return Promise.reject(se);
    }
    var headers = { 'content-type': 'application/json' };
    function send(payload) {
      if (!isCurrent(gen)) return Promise.reject(staleError());
      return request('/api/snapshot', {
        method: 'POST', headers: headers, body: payload
      }, LIMITS.snapshot).then(function (r) {
        if (!isCurrent(gen)) throw staleError();
        return r;
      });
    }
    /* Упаковка gzip — отдельный предел: CompressionStream в зависшем
       браузере/полифилле не должен держать netBusy хоста вечно. Таймаут
       упаковки — ошибка (kind: timeout), а не молчаливый пропуск кадра:
       play.js снимает busy и повторит следующим кадром. */
    function packDeadline(p) {
      return new Promise(function (resolve, reject) {
        var done = false;
        var timer = global.setTimeout(function () {
          if (done) return;
          done = true;
          var e = timeoutError(LIMITS.snapshotPack, 'snapshot-pack');
          e.message = 'упаковка gzip снимка не завершилась за ' +
            Math.round(LIMITS.snapshotPack) + ' мс';
          reject(e);
        }, LIMITS.snapshotPack);
        Promise.resolve(p).then(function (v) {
          if (done) return;
          done = true;
          global.clearTimeout(timer);
          resolve(v);
        }, function (e) {
          if (done) return;
          done = true;
          global.clearTimeout(timer);
          reject(e);
        });
      });
    }
    if (started && started.snapGzip) {
      var packed = null;
      try { packed = gzipBody(body); } catch (e) { packed = null; }
      if (packed) {
        var packOnly = packDeadline(Promise.resolve(packed).then(function (bytes) {
          if (!isCurrent(gen)) throw staleError();
          return bytes;
        }, function () {
          /* Упаковка не удалась быстро (нет потока/ошибка) — шлём обычный
             JSON, как раньше. Это не таймаут: кадр не теряем. */
          return null;
        }));
        return packOnly.then(function (bytes) {
          if (!isCurrent(gen)) throw staleError();
          if (bytes) {
            headers['content-encoding'] = 'gzip';
            return send(bytes);
          }
          return send(body);
        });
      }
    }
    return send(body);
  }

  function start() {
    if (!code || !token) return Promise.reject(makeError('state', 'нет лобби'));
    var gen = generation;
    return api('/api/start', { code: code, token: token }, LIMITS.start).then(function (j) {
      if (!isCurrent(gen)) throw staleError();
      /* Старт мог не дойти событием (SSE как раз и умирает первым) —
         ответ на кнопку несёт тот же пакет. handleStart защищён от повтора. */
      if (j && j.start) handleStart(j.start);
      return j;
    }, function (e) {
      if (!isCurrent(gen)) throw staleError();
      throw e;
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
  /* Буфер Resource Timing по умолчанию 250 записей; хост шлёт снимок 12 раз
     в секунду и заполняет его за полминуты. После заполнения браузер ПЕРЕСТАЁТ
     записывать новые записи (и наблюдатель их не получает), поэтому круг
     честно мерился, а показать это было нечем. Увеличиваем буфер один раз на
     вкладку: 4096 маленьких записей — это единицы мегабайт на долгую партию. */
  try {
    if (global.performance && global.performance.setResourceTimingBufferSize) {
      global.performance.setResourceTimingBufferSize(4096);
    }
  } catch (e) { /* старый браузер — останется обычный буфер */ }

  /* Записи нашего ping собирает PerformanceObserver, а не только буфер.
     Буфер Resource Timing вмещает 250 записей, а хост шлёт снимок 12 раз в
     секунду: через полминуты буфер полон, и новые записи ping в него уже не
     попадают — ping честно измерялся, но показать это было нечем. Наблюдатель
     получает запись в момент появления, независимо от заполнения буфера. */
  var pingEntries = [];
  try {
    if (global.PerformanceObserver) {
      var po = new global.PerformanceObserver(function (list) {
        var es = list.getEntries();
        for (var i = 0; i < es.length; i++) {
          var e = es[i];
          if ((e.name || '').indexOf('/api/ping') < 0) continue;
          pingEntries.push({ s: e.startTime, rq: e.requestStart, re: e.responseEnd });
          if (pingEntries.length > 32) pingEntries.shift();
        }
      });
      po.observe({ type: 'resource', buffered: true });
    }
  } catch (e) { /* нет PerformanceObserver — ниже обычный буфер */ }

  function resourceRtt(t0) {
    /* Сначала — наблюдатель: он не зависит от заполнения буфера. Запись
       могла начаться на несколько миллисекунд РАНЬШЕ t0 (часы Resource
       Timing округляются/наблюдатель приходит задачей) — это всё равно наш
       круг, если ответ пришёл уже после старта. Совсем старые записи
       (круг прошлых секунд) не берём: measuredBy обязан говорить правду. */
    var RECENT = 250;
    for (var k = pingEntries.length - 1; k >= 0; k--) {
      var pe = pingEntries[k];
      if (!(pe.re > 0)) continue;
      if (pe.re < t0 - RECENT) continue;
      var fromE = pe.rq > 0 ? pe.rq : pe.s;
      var msE = pe.re - fromE;
      /* Ноль здесь значит «записи нет», а не «круг 0 мс». На loopback
         responseEnd-requestStart бывает 0.3 мс, Math.round даёт 0 — и честный
         сетевой круг показывался бы как wall. Меньше миллисекунды — всё равно
         1 мс сетевого стека. */
      if (msE >= 0) return Math.max(1, Math.round(msE));
    }
    try {
      var p = global.performance;
      if (!p || !p.getEntriesByType) return 0;
      var list = p.getEntriesByType('resource');
      for (var i = list.length - 1; i >= 0; i--) {
        var e = list[i];
        if ((e.name || '').indexOf('/api/ping') < 0) continue;
        if (!(e.responseEnd > 0)) continue;
        if (e.responseEnd < t0 - RECENT) continue;     // круг прошлых секунд
        /* requestStart может быть 0 (старый/занятый браузер): тогда от
           начала записи — это всё ещё сетевой стек, а не стенные часы
           главного потока. */
        var from = e.requestStart > 0 ? e.requestStart : e.startTime;
        var ms = e.responseEnd - from;
        if (ms >= 0) return Math.max(1, Math.round(ms));
      }
    } catch (e) { /* нет Resource Timing — ниже запасной замер */ }
    return 0;
  }

  function ping() {
    if (!code || !token) return Promise.reject(makeError('state', 'нет лобби'));
    var gen = generation;
    /* Буфер Resource Timing НЕ чистим. Прежде здесь стоял clear перед
       каждым кругом — и два круга, идущие внахлёст (игра шлёт свой раз в
       2.5 с, приёмка зовёт свой), стирали запись друг друга: чтение
       возвращало 0, и честный сетевой круг показывался как «wall». Запись
       ищется по имени и времени старта, поэтому старая не мешает; браузер
       сам выбрасывает самые старые, когда буфер полон. */
    var t0 = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    var t0s = Math.round(t0 * 1000) / 1000;
    return apiGet('/api/ping?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token) +
      '&c0=' + encodeURIComponent(t0s), LIMITS.ping).then(function (j) {
      if (!isCurrent(gen)) throw staleError();
      var t1 = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
      var wall = Math.max(0, Math.round(t1 - t0));
      /* Часы комнаты: отдаём клиенту c0/c3 и серверные s1/s2. Число `ms`
         ниже остаётся сетевым RTT для индикатора; offset считает
         ServerClock по этим же меткам. */
      j.c0 = t0s;
      j.c3 = Math.round(t1 * 1000) / 1000;
      j.t1 = t1;
      function finish(net) {
        if (!isCurrent(gen)) throw staleError();
        j.msWall = wall;
        j.ms = net > 0 ? net : wall;
        j.measuredBy = net > 0 ? 'network' : 'wall';
        /* Диагностика для приёмки: почему число взято из сети или со стенных
           часов. Без флага не собирается. */
        if (global.__netDebug) {
          var dbg = { t0: Math.round(t0), obs: pingEntries.length, entries: 0, support: !!global.PerformanceObserver };
          try {
            var dl = global.performance.getEntriesByType('resource');
            for (var di = 0; di < dl.length; di++) {
              if ((dl[di].name || '').indexOf('/api/ping') >= 0) dbg.entries++;
            }
          } catch (e) { dbg.err = String(e && e.message || e); }
          j.diag = dbg;
        }
        return j;
      }
      var net = resourceRtt(t0);
      if (net > 0) return finish(net);
      /* Запись Resource Timing иногда появляется на такт позже промиса
         (главный поток занят кадром). Один короткий повтор честнее, чем
         показать стенные 3 мс как «сеть»: приёмочный тест и игрок должны
         видеть источник числа. */
      /* Запись PerformanceObserver приходит задачей, и на загруженном главном
         потоке это бывает позже промиса. Ждём её до ~0.8 с мелкими шагами:
         это дешевле, чем соврать «wall» на честном сетевом круге. */
      return new Promise(function (resolve) {
        var left = 12;
        (function tick() {
          var again = resourceRtt(t0);
          if (again > 0 || --left <= 0) { resolve(finish(again)); return; }
          global.setTimeout(tick, 60);
        })();
      });
    }, function (e) {
      if (!isCurrent(gen)) throw staleError();
      throw e;
    });
  }

  /* Серверная диагностика (OBS-01). Отдаёт только хост: у гостя сервер
     ответит 403, и это нормально — его мир всё равно у хоста. Токены в
     ответе сервер не кладёт, поэтому его можно включать в выгрузку. */
  function diag() {
    if (!code || !token) return Promise.reject(makeError('state', 'нет лобби'));
    var gen = generation;
    return apiGet('/api/diag?code=' + encodeURIComponent(code) +
      '&token=' + encodeURIComponent(token), 5000).then(function (j) {
      if (!isCurrent(gen)) throw staleError();
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
    /* Поколение партии: по нему игра и приёмка отличают ответ старой партии
       от текущего. `isCurrent(g)` — единственная проверка, которой можно
       пользоваться снаружи. */
    generation: function () { return generation; },
    isCurrent: isCurrent,
    /* Пределы ожидания — для приёмки и диагностики; игра их не меняет. */
    setLimits: setLimits,
    limits: function () { return Object.assign({}, LIMITS); },
    /* Занятость сети: pump — опрос результатов, sends — команды в отправке.
       Приёмка проверяет, что после ошибки/смены партии оба нуля. */
    busy: function () {
      var c = 0, k;
      for (k in pendingCmds) if (Object.prototype.hasOwnProperty.call(pendingCmds, k)) c++;
      return { pump: pumpBusy, sends: sendBusy, pending: c, generation: generation };
    },
    hasSaved: hasSaved,
    clearSaved: clearSaved,
    serverInfo: serverInfo,
    diag: diag,
    ping: ping,
    leave: leave,
    reset: reset,
    on: on,
    isHost: function () { return playerId !== null && playerId === hostId; },
    playerId: function () { return playerId; },
    hostId: function () { return hostId; },
    code: function () { return code; },
    roomId: function () { return roomId; },
    epoch: function () { return roomEpoch; },
    session: function () {
      return { sessionId: playerId === null ? null : String(playerId),
        instance: clientInstance, sequence: clientSeq, epoch: roomEpoch };
    },
    lobby: function () { return lobby; },
    started: function () { return started; },
    online: function () { return online; },
    connected: function () { return !!es; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
