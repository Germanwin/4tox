/* lobby.js — экран лобби: создать, войти, готов, старт.

   Правила простые и все на сервере: кто в лобби, кто готов, когда старт.
   Здесь только поля и кнопки; ни состав игроков, ни решение «пора начинать»
   не считаются в браузере — иначе два клиента разошлись бы в том, началась
   игра или нет.

   Две вещи, которые сделаны нарочно:

   1. ССЫЛКА БЕРЁТСЯ НЕ ИЗ location.origin. Хост открывает игру по
      127.0.0.1, и ссылка с таким адресом у друга ведёт на компьютер друга.
      Адреса сервера отдаёт GET /api/server, ссылка собирается из них, а все
      варианты (эта сеть, интернет) показаны списком.

   2. ПОКА ЭКРАН ОТКРЫТ, ИДЁТ ОПРОС /api/status. SSE — быстрый канал, но
      именно он первым умирает при плохой сети. Опрос возвращает то же
      состояние, поэтому «оба нажали готов, а игра не началась» не зависит от
      того, дошло ли событие. */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var el = {};
  var actions = {};
  var max = 2;
  var readyOn = false;
  var linkFromQuery = null;
  var serverInfo = null;
  var pollTimer = null;
  var linksKey = '';
  var lastInfoAt = 0;
  var pollBusy = false;
  var infoBusy = false;
  var readySentAt = 0;

  function init(bind) {
    actions = bind || {};
    el.screen = $('lobby');
    el.menuPane = $('lobbyMenu');
    el.waitPane = $('lobbyWait');
    el.name = $('lobbyName');
    el.create = $('lobbyCreate');
    el.max = $('lobbyMax');
    el.joinName = $('joinName');
    el.joinCode = $('joinCode');
    el.join = $('lobbyJoin');
    el.note = $('lobbyNote');
    el.code = $('lobbyCode');
    el.link = $('lobbyLink');
    el.links = $('lobbyLinks');
    el.net = $('lobbyNet');
    el.warn = $('lobbyWarn');
    el.waitNote = $('lobbyWaitNote');
    el.players = $('lobbyPlayers');
    el.ready = $('lobbyReady');
    el.start = $('lobbyStart');
    el.leave = $('lobbyLeave');
    el.back = $('lobbyBack');
    el.hint = $('lobbyHint');
    if (!el.screen) return;

    if (el.max) {
      el.max.addEventListener('click', function (e) {
        var b = e.target && e.target.closest ? e.target.closest('[data-max]') : null;
        if (!b) return;
        max = parseInt(b.dataset.max, 10);
        [].forEach.call(el.max.children, function (c) {
          c.classList.toggle('selected', parseInt(c.dataset.max, 10) === max);
        });
      });
    }
    if (el.create) el.create.addEventListener('click', createLobby);
    if (el.join) el.join.addEventListener('click', joinLobby);
    if (el.ready) el.ready.addEventListener('click', toggleReady);
    if (el.start) el.start.addEventListener('click', startGame);
    if (el.leave) el.leave.addEventListener('click', leaveLobby);
    if (el.back) el.back.addEventListener('click', close);
    if (el.link) el.link.addEventListener('focus', function () { el.link.select(); });
    if (el.links) el.links.addEventListener('click', copyFromList);

    global.Net.on('lobby', function (lobby) { renderLobby(lobby); });
    global.Net.on('start', function (payload) {
      stopPolling();
      /* Хост стартует первым: он и есть авторитет. Клиенты получат снапшоты. */
      if (actions.start) actions.start(payload, global.Net.isHost());
    });
    global.Net.on('net-ok', function () { renderStatus(global.Net.lobby()); });
    global.Net.on('net-error', function (ev) {
      renderStatus(global.Net.lobby());
      var msg = (ev && ev.message) || 'связь с сервером потеряна';
      if (el.waitNote && !el.waitPane.classList.contains('hidden')) waitNote(msg);
    });

    /* Ссылка вида ?lobby=ABCDE: сразу открываем «войти», код уже в поле. */
    try {
      var q = new URLSearchParams(global.location.search);
      linkFromQuery = q.get('lobby');
    } catch (e) { linkFromQuery = null; }
    if (linkFromQuery && el.joinCode) el.joinCode.value = linkFromQuery.toUpperCase();
  }

  function note(text) {
    if (!el.note) return;
    el.note.textContent = text || '';
    el.note.classList.toggle('hidden', !text);
  }

  function waitNote(text) {
    if (!el.waitNote) return;
    el.waitNote.textContent = text || '';
    el.waitNote.classList.toggle('hidden', !text);
  }

  function isFile() { return global.location.protocol === 'file:'; }

  function open(prefill) {
    if (!el.screen) return;
    hideMenu();
    el.screen.classList.remove('hidden');
    readyOn = false;
    readySentAt = 0;
    note(isFile()
      ? 'Мультиплеер работает по http. Запустите: node game/server/server.js'
      : '');
    if (prefill && el.joinCode) el.joinCode.value = String(prefill).toUpperCase();
    if (linkFromQuery && el.joinCode && !el.joinCode.value) el.joinCode.value = linkFromQuery.toUpperCase();
    if (el.name && !el.name.value) el.name.value = 'Хозяин';
    if (el.joinName && !el.joinName.value) el.joinName.value = 'Игрок';

    /* Уже в лобби (вернулись из меню) — показываем его, а не форму заново. */
    if (global.Net.code && global.Net.code() && global.Net.lobby()) {
      showPanes('wait');
      renderLobby(global.Net.lobby());
      startPolling();
    } else {
      showPanes('menu');
    }
    loadServerInfo(true);
  }

  function hideMenu() {
    if (global.Menu && global.Menu.hide) global.Menu.hide();
    if (global.Hud && global.Hud.hide) global.Hud.hide();
  }

  function close() {
    stopPolling();
    if (el.screen) el.screen.classList.add('hidden');
    global.Net.leave();
    if (global.Menu && global.Menu.show) global.Menu.show();
  }

  /* Есть ли сохранённая партия в этом браузере. Спрашивается до показа
     меню: после F5 игрок должен вернуться в игру, а не искать лобби заново. */
  function hasSaved() {
    return !!(global.Net && global.Net.hasSaved && global.Net.hasSaved());
  }

  /* Поднять сохранённую партию. Экран лобби показывается сразу, чтобы не
     мигать меню; если сервер говорит «ещё не начали» — остаёмся ждать
     остальных, если «уже играем» — обработчик start сам уведёт в партию. */
  function resumeSaved() {
    if (!hasSaved()) return Promise.resolve('none');
    hideMenu();
    if (el.screen) {
      el.screen.classList.remove('hidden');
      showPanes('wait');
      waitNote('возвращаемся в игру…');
    }
    var p = global.Net.resume();
    startPolling();
    return p.then(function (j) {
      waitNote('');
      if (j && j.started && global.Net.started()) return 'game';
      if (j && j.lobby) renderLobby(j.lobby);
      showPanes('wait');
      return 'lobby';
    }).catch(function () {
      stopPolling();
      waitNote('');
      if (global.Net && global.Net.clearSaved) global.Net.clearSaved();
      if (global.Net && global.Net.reset) global.Net.reset();
      if (el.screen) el.screen.classList.add('hidden');
      return 'none';
    });
  }

  /* Игра началась: экран лобби больше не нужен, опрос прекращаем. */
  function enterGame() {
    stopPolling();
    if (el.screen) el.screen.classList.add('hidden');
  }

  function showPanes(which) {
    if (el.menuPane) el.menuPane.classList.toggle('hidden', which !== 'menu');
    if (el.waitPane) el.waitPane.classList.toggle('hidden', which !== 'wait');
    if (el.back) el.back.classList.toggle('hidden', which === 'wait');
  }

  /* --------------------------- адреса сервера --------------------------- */

  function loadServerInfo(force) {
    if (!global.Net || !global.Net.serverInfo || infoBusy) return;
    infoBusy = true;
    global.Net.serverInfo(force).then(function (info) {
      serverInfo = info;
      lastInfoAt = Date.now();
      renderLinks(global.Net.lobby());
      renderStatus(global.Net.lobby());
    }).catch(function () { /* адреса — украшение, код всё равно работает */ })
      .then(function () { infoBusy = false; });
  }

  function originOf(url) {
    if (!url) return null;
    try { return new URL(url).origin; } catch (e) { return null; }
  }

  function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === 'localhost' ||
      host === '::1' || host === '[::1]';
  }

  /* С какого адреса друзьям открывать. Порядок:
       1) HTTPS-туннель — работает через интернет даже за CGNAT;
       2) если страница открыта не с localhost, её origin и есть сервер;
       3) VPN (Hamachi/Radmin) — друг должен быть в той же сети;
       4) эта сеть (Wi-Fi) — только друг рядом;
       5) публичный IP.
     Разница важна: хост сидит на 127.0.0.1, и ссылка с этим адресом у друга
     ведёт на компьютер друга. */
  function preferredOrigin() {
    if (isFile()) return null;
    if (serverInfo && serverInfo.tunnel) {
      var tun = originOf(serverInfo.tunnel);
      if (tun) return tun;
    }
    if (!isLoopbackHost(global.location.hostname)) return global.location.origin;
    var urls = (serverInfo && serverInfo.urls) || [];
    var ham = urls.filter(function (u) { return u.kind === 'hamachi'; })[0];
    if (ham) return originOf(ham.url);
    var lan = urls.filter(function (u) { return u.kind === 'lan'; })[0];
    if (lan) return originOf(lan.url);
    var vpn = urls.filter(function (u) { return u.kind === 'vpn'; })[0];
    if (vpn) return originOf(vpn.url);
    var pub = urls.filter(function (u) { return u.kind === 'public'; })[0];
    if (pub) return originOf(pub.url);
    if (serverInfo && serverInfo.local) return originOf(serverInfo.local);
    return global.location.origin;
  }

  function inviteLink(code) {
    var origin = preferredOrigin();
    return origin ? origin + '/game/?lobby=' + code : '';
  }

  /* Список всех адресов: HTTPS через интернет, VPN, эта сеть, этот компьютер.
     Копирование — по кнопке; поле «ссылка» всегда содержит главную. */
  function renderLinks(lobby) {
    var code = (lobby && lobby.code) || (global.Net && global.Net.code && global.Net.code()) || '';
    if (!code) return;
    var primary = inviteLink(code);
    if (el.link && el.link.value !== primary) el.link.value = primary;

    var rows = [];
    var seen = {};
    var primaryOrigin = originOf(primary);
    function add(kind, label, origin) {
      if (!origin || seen[origin]) return;
      seen[origin] = true;
      rows.push({ kind: kind, label: label, url: origin + '/game/?lobby=' + code,
        primary: origin === primaryOrigin });
    }
    /* Туннель дублируем из urls, но добавляем первым: он и есть главный. */
    if (serverInfo && serverInfo.tunnel) {
      add('tunnel', 'через интернет (HTTPS, туннель)', originOf(serverInfo.tunnel));
    }
    if (!isLoopbackHost(global.location.hostname)) {
      add('page', 'открыто сейчас', global.location.origin);
    }
    var urls = (serverInfo && serverInfo.urls) || [];
    urls.forEach(function (u) { add(u.kind, u.label, originOf(u.url)); });
    if (serverInfo && serverInfo.local) add('local', 'этот компьютер', originOf(serverInfo.local));

    var order = { tunnel: 0, hamachi: 1, page: 2, lan: 3, vpn: 4, public: 5, local: 6 };
    rows.sort(function (a, b) {
      if (a.primary !== b.primary) return a.primary ? -1 : 1;
      return (order[a.kind] === undefined ? 9 : order[a.kind]) -
        (order[b.kind] === undefined ? 9 : order[b.kind]);
    });
    var key = rows.map(function (r) { return r.url; }).join('\n');
    if (!el.links || key === linksKey) return;
    linksKey = key;
    el.links.innerHTML = '';
    rows.forEach(function (r) {
      var row = document.createElement('div');
      row.className = 'lobby-link-row' + (r.primary ? ' primary' : '');
      var label = document.createElement('span');
      label.className = 'lobby-link-label';
      label.textContent = r.label;
      var addr = document.createElement('code');
      addr.textContent = r.url;
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'mini-btn';
      copy.dataset.copy = r.url;
      copy.textContent = 'копировать';
      row.appendChild(label);
      row.appendChild(addr);
      row.appendChild(copy);
      el.links.appendChild(row);
    });
  }

  function copyFromList(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!b) return;
    var text = b.dataset.copy;
    var done = function () {
      var old = b.textContent;
      b.textContent = 'скопировано';
      global.setTimeout(function () { b.textContent = old; }, 1200);
    };
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(text).then(done, function () {});
    } else if (el.link) {
      el.link.value = text;
      el.link.focus();
      el.link.select();
      done();
    }
  }

  /* ------------------------------ опрос -------------------------------- */

  function startPolling() {
    stopPolling();
    pollTimer = global.setInterval(poll, 1500);
    poll();
  }

  function stopPolling() {
    if (pollTimer) { global.clearInterval(pollTimer); pollTimer = null; }
  }

  function poll() {
    if (!global.Net || !global.Net.code || !global.Net.code()) { stopPolling(); return; }
    /* Через туннель ответ идёт секундами; накладывать запросы нельзя — потом
       придут устаревшие ответы и отменят только что нажатую кнопку. */
    if (pollBusy) return;
    pollBusy = true;
    /* Адреса проверяются на сервере после старта (UPnP, CGNAT, туннель).
       Пока идёт проверка или туннель поднимается — перечитываем их. */
    if (!serverInfo ||
        (serverInfo.net && serverInfo.net.checking) ||
        serverInfo.tunnelState === 'starting' || serverInfo.tunnelState === 'down' ||
        (Date.now() - lastInfoAt > 8000)) {
      loadServerInfo(true);
    }
    global.Net.status().then(function (j) {
      if (j.lobby) renderLobby(j.lobby);
      if (j.started) stopPolling();
    }).catch(function (e) {
      /* «нет доступа» — лобби больше нет (например, хост закрыл комнату). */
      if (/нет доступа|не найдено/.test(e.message || '')) {
        stopPolling();
        waitNote(e.message);
      }
    }).then(function () { pollBusy = false; });
  }

  /* ------------------------------ действия ----------------------------- */

  function createLobby() {
    if (isFile()) { note('Нужен http: node game/server/server.js'); return; }
    var name = (el.name && el.name.value || '').trim() || 'Хозяин';
    note('создаю…');
    global.Net.create(max, name).then(function () {
      note('');
      showPanes('wait');
      waitNote('');
      renderLobby(global.Net.lobby());
      startPolling();
      loadServerInfo(true);
    }).catch(function (e) {
      note('не вышло: ' + e.message);
    });
  }

  function joinLobby() {
    if (isFile()) { note('Нужен http: node game/server/server.js'); return; }
    var code = (el.joinCode && el.joinCode.value || '').trim().toUpperCase();
    var name = (el.joinName && el.joinName.value || '').trim() || 'Игрок';
    if (!code) { note('введите код из ссылки'); return; }
    note('вхожу…');
    global.Net.join(code, name).then(function () {
      note('');
      showPanes('wait');
      waitNote('');
      renderLobby(global.Net.lobby());
      startPolling();
      loadServerInfo(true);
    }).catch(function (e) {
      note('не вышло: ' + e.message);
    });
  }

  function toggleReady() {
    var next = !readyOn;
    readyOn = next;
    readySentAt = Date.now();
    if (el.ready) el.ready.textContent = next ? 'Не готов' : 'Готов';
    waitNote('');
    global.Net.ready(next).then(function () {
      /* Ответ на «готов» уже мог принести старт — проверим сразу, не ждём
         следующего тика опроса. «Не все готовы» — это не ошибка, а подсказка
         в lobbyHint; отдельным сообщением её не дублируем. */
      poll();
    }).catch(function (e) {
      readyOn = !next;
      readySentAt = 0;
      if (el.ready) el.ready.textContent = readyOn ? 'Не готов' : 'Готов';
      waitNote('не вышло: ' + e.message);
    });
  }

  /* Старт по кнопке хоста. Состав собран — решает хост, а не «все нажали
     готов в эту секунду»: друг мог ещё открывать ссылку. */
  function startGame() {
    if (!global.Net || !global.Net.isHost || !global.Net.isHost()) return;
    waitNote('начинаю…');
    global.Net.start().then(function (j) {
      if (!j || !j.start) waitNote('старт не вышел — попробуйте ещё раз');
    }).catch(function (e) {
      waitNote('старт не вышел: ' + (e.message || e));
    });
  }

  function leaveLobby() {
    stopPolling();
    global.Net.leave();
    readyOn = false;
    readySentAt = 0;
    if (el.ready) el.ready.textContent = 'Готов';
    waitNote('');
    showPanes('menu');
    if (global.Menu && global.Menu.show) global.Menu.show();
    if (el.screen) el.screen.classList.add('hidden');
  }

  /* ------------------------------ экран -------------------------------- */

  function renderStatus(lobby) {
    if (!el.net) return;
    var online = global.Net && global.Net.online && global.Net.online();
    var n = lobby && lobby.players ? lobby.players.length : 0;
    var m = lobby && lobby.max ? lobby.max : max;
    el.net.textContent = (online ? 'связь с сервером есть' : 'связи нет — пробуем снова') +
      (n ? ' · игроков: ' + n + '/' + m : '');
    el.net.classList.toggle('offline', !online);
    el.net.classList.remove('hidden');

    /* Главная беда домашних сетей: провайдер за CGNAT. Внешний IP есть, но
       входящие до компьютера не доходят — ни проброс порта, ни ссылка по IP
       не помогут. Сказать это словами лучше, чем показать мёртвую ссылку. */
    var warn = '';
    var info = serverInfo || {};
    var net = info.net || {};
    if (info.tunnelState === 'failed') {
      warn = 'Туннель не поднялся. Проверьте ssh и сеть, включите Hamachi ' +
        'или перезапустите сервер.';
    } else if (net.cgnat && !info.tunnel) {
      warn = 'Провайдер держит вас за CGNAT: по внешнему IP друзья не зайдут. ' +
        'Запустите сервер с --tunnel (HTTPS-ссылка) или используйте Hamachi.';
    } else if (!info.tunnel && !net.checking && net.ok === false && serverInfo) {
      warn = 'Порт наружу не проброшен: друзья из другой сети не подключатся. ' +
        'Запустите с --tunnel или пробросьте порт ' + (info.port || 8787) + '.';
    }
    if (el.warn) {
      el.warn.textContent = warn;
      el.warn.classList.toggle('hidden', !warn);
    }
  }

  /* Кнопка «Начать игру» есть только у хоста и только когда все готовы.
     Гостю её не показываем: старт — решение хоста, а не голосование. */
  function renderStart(lobby) {
    if (!el.start) return;
    var host = !!(global.Net && global.Net.isHost && global.Net.isHost());
    if (!host || (lobby && lobby.started)) {
      el.start.classList.add('hidden');
      return;
    }
    var can = lobby && lobby.canStart !== undefined
      ? !!lobby.canStart
      : !!(lobby && (lobby.players || []).length >= 2 &&
        (lobby.players || []).every(function (p) { return p.ready; }));
    el.start.classList.remove('hidden');
    el.start.disabled = !can;
    el.start.textContent = can ? 'Начать игру' : 'Ждём готовности';
  }

  function hintFor(lobby) {
    var host = global.Net && global.Net.isHost && global.Net.isHost();
    var hostNote = host ? ' Вы хост: не закрывайте эту вкладку — мир считается здесь.' : '';
    /* У бесплатного pinggy первый переход показывают страницу-предупреждение.
       Хост должен знать это заранее, иначе друг решит, что ссылка «не та». */
    var tunnelNote = (serverInfo && serverInfo.tunnel)
      ? ' Друг открывает HTTPS-ссылку и один раз жмёт «Enter site» — это защита туннеля.'
      : '';
    if (lobby.started) return 'Игра начинается…';
    var players = lobby.players || [];
    if (players.length < 2) {
      return 'Нужен ещё игрок: отправьте другу ссылку или код.' + tunnelNote + hostNote;
    }
    var notReady = players.filter(function (p) { return !p.ready; });
    if (notReady.length) {
      return 'Ждём: ' + notReady.map(function (p) { return p.name; }).join(', ') +
        '. Все нажимают «Готов», затем хост нажимает «Начать игру».' + tunnelNote + hostNote;
    }
    return (host
      ? 'Все готовы — нажмите «Начать игру».'
      : 'Все готовы. Ждём, когда хост начнёт игру.') + tunnelNote + hostNote;
  }

  function renderLobby(lobby) {
    if (!lobby) return;
    if (el.code) el.code.textContent = lobby.code;
    renderLinks(lobby);
    renderStatus(lobby);

    var me = null;
    var players = lobby.players || [];
    for (var k = 0; k < players.length; k++) {
      if (players[k].id === global.Net.playerId()) me = players[k];
    }
    /* Состояние «готов» — из лобби, а не из локальной переменной: после
       переподключения кнопка обязана показывать правду. Но через туннель
       ответ опроса может быть старше нажатия; в первые секунды после него
       верим игроку, иначе кнопка мигает «Готов» и второе нажатие отменяет
       готовность. */
    var serverReady = !!(me && me.ready);
    if (serverReady === readyOn) {
      readySentAt = 0;
    } else if (Date.now() - readySentAt > 6000) {
      readyOn = serverReady;
      readySentAt = 0;
    }
    if (el.ready) el.ready.textContent = readyOn ? 'Не готов' : 'Готов';

    if (el.players) {
      el.players.innerHTML = '';
      players.forEach(function (p) {
        var li = document.createElement('li');
        li.className = p.ready ? 'ready' : 'notready';
        if (p.online === false) li.classList.add('offline');
        var name = document.createElement('span');
        name.textContent = (p.host ? '★ ' : '') + p.name +
          (p.id === global.Net.playerId() ? ' (вы)' : '') +
          (p.online === false ? ' · нет связи' : '');
        var st = document.createElement('b');
        st.textContent = p.ready ? 'готов' : 'ждёт';
        li.appendChild(name);
        li.appendChild(st);
        el.players.appendChild(li);
      });
    }
    if (el.hint) el.hint.textContent = hintFor(lobby);
    renderStart(lobby);
    showPanes('wait');
  }

  global.Lobby = {
    init: init,
    open: open,
    close: close,
    enterGame: enterGame,
    hasSaved: hasSaved,
    resumeSaved: resumeSaved,
    note: note
  };
})(typeof window !== 'undefined' ? window : globalThis);
