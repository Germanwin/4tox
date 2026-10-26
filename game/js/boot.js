/* boot.js — сборка игры: загрузка атласов, порядок экранов и главный цикл.

   Это единственное место, где экраны знают друг о друге: меню не знает про
   HUD, HUD не знает про меню, а «кто кого показывает» решается здесь. Так же
   устроен генератор карт (mapgen2/js/app.js) — и это не совпадение: обе
   оболочки стоят на одном движке и собираются одинаково.

   Атласы и текстуры игра берёт у генератора: `mapgen2/assets/`. Копий нет —
   модель едет в игру через упаковщик, и лежит он ровно в одном месте
   (docs/PIPELINE.md). */

(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* Где лежит движок и его ассеты. Путь относительный: игра открывается и по
     file://, и по http, и в обоих случаях репозиторий лежит целиком. */
  var ASSETS = '../mapgen2/assets/';

  var TEXTURES = {
    grass: ASSETS + 'textures/grass.png',
    meadow: ASSETS + 'textures/meadow.png',
    // Газон участков: низкая трава темнее луга, плитка 2 x 2 клетки.
    // Исходник и сборка — art/textures/plot_grass.
    plot_grass: ASSETS + 'textures/plot_grass.png',
    sand: ASSETS + 'textures/sand.png',
    water: ASSETS + 'textures/water.png',
    // Рябь моря — не текстура земли, а готовая карта яркости для умножения;
    // лежит рядом с атласом волн, готовит её mapgen2/tools/pack_waves.py.
    ripple: ASSETS + 'waves/ripple.png',
    stony: ASSETS + 'textures/stony.png'
  };

  var STEPS = 11;             // текстур сколько угодно, а шагов загрузки одиннадцать:
                              // текстуры, четыре одиночных атласа (лес, волны,
                              // житель, воин) и пять атласов построек
                              // (ратуша, дом, лагерь, казарма, военный лагерь)
  var stepsDone = 0;

  var last = 0;

  /* ------------------------------- часы мира ---------------------------- *
   *
   * Время партии считается по СТЕННЫМ часам, а не по кадрам. Причина
   * заказчика (2026-10-24): «игра ставится на паузу, если ухожу с вкладки на
   * другую вкладку или в другое окно либо если захожу в меню; а нужно чтобы
   * никогда не останавливалась».
   *
   * requestAnimationFrame в скрытой вкладке не замедляется, а замирает
   * совсем; setInterval там редеет до раза в секунду, а после пяти минут —
   * до раза в минуту. Если бы мир шагал на dt кадра, он бы терял ровно
   * столько времени, сколько вкладка проспала. Поэтому мир догоняет по
   * Date.now: каждый, кто проснулся — кадр, таймер фона, возврат вкладки, —
   * подаёт Play.tick весь прошедший отрезок шагами SIM_STEP.
   *
   * 0.05 с — тот же шаг, которым жил мир до этой правки: ходьба, рубка, бой
   * и пятисекундная тренировка считают время шагами, и крупный шаг сдвинул
   * бы их.
   *
   * Догон ОГРАНИЧЕН. Без предела один вызов advance() прогонял весь отрезок
   * синхронно; замер на 192-й карте, 4 деревни, 200 существ: 600 с простоя —
   * это 12 000 шагов и ~1030 мс в главном потоке (62 пропущенных кадра), а
   * 60 с — ~207–380 мс. Поэтому за вызов тратится не больше BUDGET_MS
   * стенных миллисекунд; остаток долга (simDebt) ждёт следующего вызова.
   * Долг ограничен MAX_DEBT: всё, что больше, честно выбрасывается и
   * записывается в Play.state.simDropped — это не молчаливое ускорение,
   * игрок видит «мир пропустил N с». Минимум один шаг за вызов делается
   * всегда: шаг мира бывает тяжелее бюджета (замер: худший шаг 9.96 мс при
   * бюджете 8), и проверка бюджета ДО шага навсегда заблокировала бы долг.
   *
   * Долг не копится до первой партии, после боя и у клиента сети: там мир
   * либо не идёт, либо время авторитетно у хоста. */

  var SIM_STEP = 0.05;        // шаг мира, с
  var BUDGET_MS = 8;          // столько стенных мс на догон в видимой вкладке
  var BUDGET_HIDDEN_MS = 25;  // в скрытой: таймер редкий, кадр не рисуется
  var MAX_DEBT = 120;         // с: больше не догоняем, а выбрасываем и говорим
  var JUMP_MS = 5000;         // предел тестовой ручки __game.clock.jump
  var STALL_MS = 3000;        // столько без кадров — значит, окно не рисуется
  var simLast = 0;            // время прошлого шага, мс по Date.now
  var lastFrameAt = 0;        // когда кадр действительно случился
  var simDebt = 0;            // с: сколько мира ещё не догнано
  var simDropped = 0;         // с: сколько выброшено (зеркало Play.state.simDropped)

  /* Атласы построек: по одному на тип (mapgen2/js/buildings.js: TYPES).
     Раньше он был один — ратуша; теперь их четыре, и грузятся они одним
     циклом: появится пятая постройка — строка в TYPES и строка здесь. */
  var BUILDING_STEPS = {
    townhall: 'ставим ратушу…',
    house: 'строим дом жителя…',
    lumbercamp: 'разбиваем лагерь…',
    barracks: 'ставим казарму…',
    warcamp: 'разбиваем военный лагерь…'
  };

  function progress(text) {
    stepsDone++;
    $('bootFill').style.width = Math.round(stepsDone / STEPS * 100) + '%';
    if (text) $('bootText').textContent = text;
  }

  /* ------------------------------ экраны ------------------------------- */

  function startGame(seed, size, opts) {
    opts = opts || {};
    if (opts.mode === 'mp') {
      /* Мультиплеер — не партия, а лобби: сначала комната, потом сервер сам
         скажет, когда все готовы. Здесь только открываем экран. */
      if (global.Lobby) global.Lobby.open();
      return;
    }
    // Мир собирается ДО ухода меню: генерация и уход идут одновременно, и
    // когда доска уезжает, остров уже стоит и камера к нему летит.
    Play.start({ seed: seed, size: size, mode: opts.mode || 'solo' });
    Hud.show();
    Menu.leave();
    var w = Play.state.world;
    Hud.toast('«' + w.seed + '» · ' + w.islandSize + ' × ' + w.islandSize + ' клеток · ' +
      Math.round(w.stats.landShare * 100) + ' % суши' +
      (opts.mode === 'bot' ? ' · против деревни' : ''), 3600);
  }

  function startNet(payload, isHost) {
    if (!payload) return;
    var lobby = document.getElementById('lobby');
    if (lobby) lobby.classList.add('hidden');
    if (global.Lobby && global.Lobby.enterGame) global.Lobby.enterGame();
    Play.startNet(payload, isHost);
    Hud.show();
    Menu.leave();
    var w = Play.state.world;
    Hud.toast(isHost ? 'Лобби: вы хост · «' + w.seed + '»' : 'Лобби: вы подключились · «' + w.seed + '»', 4200);
  }

  function newIsland() {
    var st = Play.state;
    var size = st.world ? st.world.islandSize : Menu.size();
    var seed = global.randomSeed();
    var wasNet = !!st.netRole;
    Hud.closePause();
    /* «Новый остров» в сети — это выйти из комнаты и начать одиночную:
       подменять мир под живым лобби нельзя. */
    if (wasNet) {
      if (global.Net) global.Net.leave();
      Play.stopNet();
      if (global.Lobby) global.Lobby.close();
    }
    Play.start({ seed: seed, size: size, mode: wasNet ? 'solo' : (st.gameMode || 'solo') });
    Hud.show();
    Hud.toast('Новый остров: «' + seed + '» · ' + size + ' × ' + size, 3200);
  }

  function toMenu() {
    /* Из сетевой партии надо именно выйти: иначе сервер держит комнату, а
       второй игрок остаётся с замершим миром. */
    if (Play.state.netRole) {
      if (global.Net) global.Net.leave();
      Play.stopNet();
      if (global.Lobby) global.Lobby.close();
    }
    Hud.closePause();
    Hud.hideResult();
    Hud.hide();
    // Мир остаётся на экране и становится фоном меню — и продолжает жить:
    // вернувшись, игрок увидит, что прошло (правило 2026-10-24). Так возврат
    // в меню не выглядит как «всё пропало».
    if (Play.state.world) Menu.select(Play.state.world.islandSize);
    // Меню раскладывается ПЕРВЫМ: движок спрашивает у него, сколько осталось
    // места под остров (Play.showInMenu → frameDiorama → Menu.artBox).
    Menu.show();
    Play.showInMenu();
  }

  function openPause() {
    if (Play.pause()) Hud.openPause();
  }

  function closePause() {
    if (Play.resume()) Hud.closePause();
  }

  function onEscape() {
    if (Menu.isOpen()) return;                 // в меню Esc ничего не отменяет
    if (Hud.isPaused()) closePause();
    else openPause();
  }

  /* ------------------------------ загрузка ----------------------------- */

  function loadTextures(done) {
    var keys = Object.keys(TEXTURES);
    var out = {}, left = keys.length;
    keys.forEach(function (k) {
      var img = new Image();
      img.onload = function () { out[k] = img; if (--left === 0) done(out); };
      img.onerror = function () { if (--left === 0) done(out); };
      img.src = TEXTURES[k];
    });
  }

  /* Атласы грузятся по одному и независимо. Упал один — партия всё равно
     начинается: без ратуши карта работает, без дома и лагеря деревня просто
     меньше, без жителя по острову никто не ходит. Ронять игру из-за картинки
     нельзя. */
  function loadAtlases(done) {
    // Четыре одиночных атласа (лес, волны, житель, рыцарь) плюс по одному на
    // каждый тип постройки. Считать это числом нельзя: разошлось — и партия
    // не начнётся.
    var left = 5 + Object.keys(BUILDING_STEPS).length;
    function one() { if (--left === 0) done(); }
    function guard(run) { try { run(); } catch (e) { one(); } }

    guard(function () {
      global.Sprites.load({ base: ASSETS }, function (set) {
        Play.setSprites(set);
        progress('сажаем лес…');
        one();
      }, function () { one(); });
    });

    guard(function () {
      global.Waves.load({ base: ASSETS }, function (set) {
        Play.renderer().waveSprites = set;
        progress('поднимаем волны…');
        one();
      }, function () { Play.renderer().waveSprites = null; one(); });
    });

    guard(function () {
      global.Villagers.load({ base: ASSETS }, function (set) {
        Play.renderer().villagerSprites = set;
        progress('зовём жителя…');
        one();
      }, function () { Play.renderer().villagerSprites = null; one(); });
    });

    /* Воин — отдельный атлас той же модели-человека, но в броне, шлеме и с
       мечом. Он не обязателен: без него воин рисуется обычным жителем, и
       партия не падает. */
    guard(function () {
      global.Villagers.load({
        base: ASSETS, dir: 'armored_villager/', metaName: 'ARMORED_VILLAGER_ATLAS'
      }, function (set) {
        Play.renderer().knightSprites = set;
        progress('вооружаем рыцарей…');
        one();
      }, function () { Play.renderer().knightSprites = null; one(); });
    });

    // Постройки деревни: ратуша, дом жителя, лагерь лесоруба.
    Object.keys(BUILDING_STEPS).forEach(function (type) {
      guard(function () {
        global.Buildings.load(type, { base: ASSETS }, function (set) {
          Play.renderer().setBuildingSet(type, set);
          progress(BUILDING_STEPS[type]);
          one();
        }, function () { one(); });
      });
    });

    /* Завалы: один атлас на все типы. Без него бой работает, но разрушенное
       здание рисуется целым — поэтому атлас необязателен, как и остальные. */
    guard(function () {
      if (!global.RUINS_ATLAS) { one(); return; }
      var img = new Image();
      img.onload = function () {
        Play.renderer().setRuins(img, global.RUINS_ATLAS);
        progress('разбираем завалы…');
        one();
      };
      img.onerror = function () { one(); };
      img.src = ASSETS + 'ruins/atlas.png';
    });
  }

  function start() {
    // Рендер и таблички нужны раньше загрузки: грузить атласы некуда, пока
    // нет рендера, а прогресс загрузки показывает HUD.
    Play.init();
    Hud.init({
      pause: openPause,
      resume: closePause,
      newIsland: newIsland,
      toMenu: toMenu
    });
    Hud.hide();
    Play.bindInput({
      escape: onEscape,
      newIsland: newIsland,
      squad: function () { Hud.toggleSquad(); },
      followChanged: function (on) { $('btnFollow').classList.toggle('active', on); }
    });
    Lobby.init({ start: startNet });
    Menu.init({ play: startGame, mp: function () { Lobby.open(); } });
    /* Ссылка ?lobby=CODE открывает лобби сразу: участник не должен искать
       «мультиплеер» в меню. */
    try {
      var lobbyCode = new URLSearchParams(global.location.search).get('lobby');
      if (lobbyCode) Lobby.open(lobbyCode);
    } catch (e) { /* старый браузер без URLSearchParams — просто меню */ }
    Play.on(function (ev) {
      if (ev.type === 'start') Hud.onStart(ev);
      else if (ev.type === 'felled') Hud.onFelled(ev);
      // Новый воин: вышел из казармы в броне и ушёл в военный лагерь.
      else if (ev.type === 'warrior') Hud.onWarrior(ev);
      // Сдача брёвен: «+4» над лагерем и (один раз) весть о первом бревне.
      else if (ev.type === 'delivery') Hud.onDelivery(ev);
      // Клетка под курсором и выбор постройки: мир считает — HUD показывает.
      else if (ev.type === 'hover') Hud.onHover(ev);
      else if (ev.type === 'select') Hud.onSelect(ev);
      // Правка постройки: полоса внизу и фраза, когда действие отклонено.
      else if (ev.type === 'edit') Hud.onEdit(ev);
      else if (ev.type === 'edit-note') Hud.onEditNote(ev);
      // Стройка: полоса размещения, покупка и отказ словами мира.
      else if (ev.type === 'build') Hud.onBuild(ev);
      else if (ev.type === 'built') Hud.onBuilt(ev);
      else if (ev.type === 'build-note') Hud.toast(ev.text);
      // Приказ отряду: сообщение о том, сколько пошло, или отказ словами.
      else if (ev.type === 'order-note') Hud.toast(ev.text);
      // Выбранный житель: подсветка строки в табличке деревни.
      else if (ev.type === 'focus') Hud.onFocus(ev);
      // Сеть: отказ команды, уход игрока, потеря/возврат хоста и просадка
      // связи. Экран потери хоста — единственный случай, когда партия честно
      // встаёт: мир считается во вкладке хоста, и без неё продолжать нечего.
      else if (ev.type === 'net-note') Hud.toast(ev.text, 5200);
      else if (ev.type === 'net-peer-left') {
        Hud.toast((ev.name || 'Игрок') + ' вышел из игры', 4200);
      } else if (ev.type === 'net-peer-back') {
        Hud.toast((ev.name || 'Игрок') + ' снова в игре', 3200);
      } else if (ev.type === 'net-host-left') {
        /* Не выкидываем в меню: хост мог моргнуть сетью. Мир остаётся на
           экране последним кадром, а игрок ждёт возвращения (Esc → «Меню»,
           если хост не вернётся). */
        Hud.showNetLost((ev.name ? 'Хост ' + ev.name + ' ' : 'Хост ') +
          'пропал из сети — ждём. Вернётся — игра продолжится; не вернётся — Esc → «Меню».');
      } else if (ev.type === 'net-host-back') {
        if (Hud.hideNetLost()) Hud.toast('Связь с хостом восстановлена');
        else Hud.toast('Хост снова на связи');
        Hud.setNetPing(0, Play.state);
      } else if (ev.type === 'net-stale') {
        Hud.toast('Связь с хостом пропала — ждём', 5000);
        Hud.setNetPing(0, { stale: true });
      } else if (ev.type === 'net-ok') {
        Hud.toast('Связь вернулась');
        Hud.setNetPing(0);
      } else if (ev.type === 'net-ping') {
        Hud.setNetPing(ev.ms, Play.state);
      } else if (ev.type === 'sim-dropped') {
        /* Часы выбросили долг (см. MAX_DEBT в advance). Показывает HUD:
           постоянной строкой суммы, а не всплывашкой — в сети всплывашек нет
           по правилу 2026-10-24. Если агент 8 ещё не завёл обработчик, сумма
           всё равно живёт в Play.state.simDropped и доступна HUD. */
        if (Hud && typeof Hud.onSimDropped === 'function') {
          Hud.onSimDropped(ev.lost, ev.total);
        }
      } else if (ev.type === 'spectator') {
        /* Своя ратуша пала, но партия идёт: наблюдаем без команд. Это не
           экран итога — итог придёт отдельным событием `defeat`. */
        Hud.setSpectator(!!ev.on);
      } else if (ev.type === 'fault') {
        if (ev.fatal !== false) showFault(ev.fault);
        else Hud.toast('внутренняя ошибка записана в диагностику', 4200);
      } else if (ev.type === 'fault-recovered') {
        hideFault();
        Hud.toast('мир продолжен с контрольной точки', 4200);
      } else if (ev.type === 'pending') {
        /* Ожидание гостя: значок на карте уже есть. Экран лобби/панель не
           трогаем — это правило «в сети всплывашек нет». */
      }
      // Ратуша пала. В главном меню партия уже брошена: экран итога поверх
      // меню был бы вестью о мире, который игрок оставил.
      else if (ev.type === 'defeat') {
        if (!Menu.isOpen()) Hud.onDefeat(ev);
      }
    });

    global.addEventListener('resize', function () { Play.resize(); });

    /* LOOP-01: исключение и необработанный отказ промиса не должны исчезать
       молча. Исключение останавливает мир (fatal), отказ промиса пишется в
       диагностику и не гасит партию: он может быть сетевым. */
    installFaultScreen();
    global.addEventListener('error', function (e) {
      var err = e && e.error ? e.error : new Error((e && e.message) || 'ошибка');
      if (global.Play && Play.noteFault) Play.noteFault(err, 'window');
    });
    global.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      var err = r instanceof Error ? r : new Error(String(r));
      if (global.Play && Play.noteFault) {
        Play.noteFault(err, 'promise', { fatal: false });
      }
    });
    /* Версия сборки: сервер отдаёт свою, если он новый. Ошибка запроса не
       мешает игре — это только строка в диагностике. */
    global.__4toxBuild = (function () {
      var m = document.querySelector && document.querySelector('meta[name="4tox-build"]');
      return m ? m.getAttribute('content') : 'dev';
    })();
    if (global.Net && global.Net.serverInfo) {
      try {
        global.Net.serverInfo().then(function (j) { global.__4toxServer = j; },
          function () { /* старого сервера нет — не беда */ });
      } catch (e) { /* нет сети — не беда */ }
    }

    loadTextures(function (tex) {
      Play.setTextures(tex);
      progress('размечаем землю…');
      loadAtlases(function () {
        begin();
      });
    });
  }

  /* --------------------------- экран ошибки ----------------------------- *
   *
   * Мир остановлен явно, интерфейс жив. Здесь только DOM: ни движка, ни
   * отрисовки — экран обязан работать даже тогда, когда draw и Hud падают.
   * Кнопки: выгрузить диагностику (без токенов), продолжить с последней
   * ЦЕЛОЙ контрольной точки, уйти в меню. */
  function installFaultScreen() {
    if (document.getElementById('faultScreen')) return;
    var el = document.createElement('div');
    el.id = 'faultScreen';
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;' +
      'align-items:center;justify-content:center;background:rgba(10,16,22,.84);' +
      'font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#eaf2f8';
    el.innerHTML = '<div style="max-width:760px;width:calc(100% - 48px);' +
      'background:#16222c;border:1px solid #3a5160;border-radius:14px;' +
      'padding:20px 22px;box-shadow:0 20px 60px rgba(0,0,0,.5)">' +
      '<h2 style="margin:0 0 8px;font-size:19px">Мир остановлен</h2>' +
      '<p id="faultMsg" style="margin:0 0 10px;color:#f0b7ae"></p>' +
      '<pre id="faultStack" style="max-height:180px;overflow:auto;' +
      'background:#0d161d;border:1px solid #2a3d49;border-radius:8px;' +
      'padding:10px;font-size:11px;color:#a9c2d2;white-space:pre-wrap"></pre>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">' +
      '<button id="faultDiag" style="padding:8px 12px;border-radius:8px;' +
      'border:1px solid #4a6577;background:#223543;color:#eaf2f8;cursor:pointer">' +
      'Выгрузить диагностику</button>' +
      '<button id="faultResume" style="padding:8px 12px;border-radius:8px;' +
      'border:1px solid #4a6577;background:#2c4a3a;color:#eaf2f8;cursor:pointer">' +
      'Продолжить с контрольной точки</button>' +
      '<button id="faultMenu" style="padding:8px 12px;border-radius:8px;' +
      'border:1px solid #4a6577;background:#223543;color:#eaf2f8;cursor:pointer">' +
      'В главное меню</button></div>' +
      '<p id="faultNote" style="margin:10px 0 0;color:#a9c2d2;font-size:12px">' +
      'Мир не считает время, чтобы не продолжать полутранзакцию. ' +
      'Мир можно продолжить с последней целой контрольной точки.</p></div>';
    document.body.appendChild(el);
    var diag = document.getElementById('faultDiag');
    if (diag) diag.addEventListener('click', function () {
      if (global.Play && Play.downloadDiagnostics) Play.downloadDiagnostics();
    });
    var resume = document.getElementById('faultResume');
    if (resume) resume.addEventListener('click', function () {
      var note = document.getElementById('faultNote');
      if (Play.state.netRole === 'client') {
        if (note) note.textContent = 'Авторитетный мир у хоста: гость не восстанавливает его сам.';
        return;
      }
      var r = Play.recoverFromCheckpoint();
      if (r && r.ok) hideFault();
      else if (note) note.textContent = 'Не удалось: ' + ((r && r.reason) || 'нет контрольной точки');
    });
    var menu = document.getElementById('faultMenu');
    if (menu) menu.addEventListener('click', function () {
      hideFault();
      toMenu();
    });
  }

  function showFault(fault) {
    installFaultScreen();
    var el = document.getElementById('faultScreen');
    if (!el) return;
    var msg = document.getElementById('faultMsg');
    var stack = document.getElementById('faultStack');
    if (msg) msg.textContent = (fault && fault.phase ? '[' + fault.phase + '] ' : '') +
      ((fault && fault.message) || 'неизвестная ошибка');
    if (stack) stack.textContent = (fault && fault.stack) || '';
    var resume = document.getElementById('faultResume');
    if (resume) resume.style.display = Play.state.netRole === 'client' ? 'none' : '';
    el.style.display = 'flex';
  }

  function hideFault() {
    var el = document.getElementById('faultScreen');
    if (el) el.style.display = 'none';
  }

  /* ------------------------------- часы мира ---------------------------- */

  function simNow() { return Date.now(); }

  /* Стенные миллисекунды для бюджета. Date.now груб (1 мс) и прыгает от
     правки системного времени; бюджету нужен ровный счётчик. */
  function wallNow() {
    return (global.performance && global.performance.now)
      ? global.performance.now() : Date.now();
  }

  /* Выброшенное время видит игрок, журнал (Metrics) и HUD. Функция одна:
     иначе «пропущено» в часах, в Metrics и в Play.state разошлось бы. */
  function dropTime(sec) {
    if (!(sec > 0) || !isFinite(sec)) return;
    simDropped += sec;
    var M = global.Metrics;
    if (M && M.on && M.counters) M.counters.dropped += sec;
    var P = global.Play;
    if (P && typeof P.noteSimDropped === 'function') P.noteSimDropped(sec);
    else if (P && P.state) P.state.simDropped = (P.state.simDropped || 0) + sec;
  }

  /* Тратит не больше budgetMs стенных мс на догон. Возвращает, сколько
     секунд МИРА прогнано этим вызовом. Минимум один шаг делается всегда —
     даже если он один тяжелее бюджета: иначе долг не кончится никогда. */
  function drain(budgetMs) {
    if (!(simDebt > 1e-9)) return 0;
    var M = global.Metrics;
    var measure = !!(M && M.on);
    var started = wallNow();
    var simulated = 0;
    do {
      var step = simDebt > SIM_STEP ? SIM_STEP : simDebt;
      if (!(step > 1e-9)) break;
      var t0 = measure ? wallNow() : 0;
      Play.tick(step);
      if (measure) M.step(wallNow() - t0);
      simDebt -= step;
      simulated += step;
      if (!(simDebt > 1e-9)) break;
    } while (wallNow() - started < budgetMs);
    if (simulated > 0 && measure && M.counters) M.counters.caughtUp += simulated;
    return simulated;
  }

  /* Один шаг мира. Всё, что проснулось, догоняет по нему прошедшее время.
     Возвращает, сколько секунд мира догнано этим вызовом. */
  function advance(now) {
    if (!simLast) { simLast = now; return 0; }
    var elapsed = (now - simLast) / 1000;
    // Часы могли прыгнуть назад (правка системного времени) — это не долг
    // партии, а сбой: просто переставляем отметку.
    if (!(elapsed > 0)) { simLast = now; return 0; }
    simLast = now;

    var P = global.Play;
    if (!P || !P.state || !P.state.world) { simDebt = 0; return 0; }
    /* Мир остановлен диагностической границей: долг не копим, иначе после
       восстановления мы «догнали» бы время, в котором мир не считался. */
    if (P.state.faulted) { simDebt = 0; return 0; }

    /* Клиент не считает мир: его время приходит снимками. Один тик нужен
       только для сглаживания позиций — и один большой dt честнее тысячи
       маленьких: сглаживание по exp() и так сходится за него. Долг клиента
       не касается: авторитетное время у хоста. */
    if (P.state.netRole === 'client') {
      P.tick(elapsed);
      return elapsed;
    }

    /* До первой партии и после боя мир не идёт: копить за это время долг
       значило бы «догнать» несуществующие минуты при старте следующей. Но
       оболочка при этом жива: хост обязан слать снимки гостям и heartbeat
       (иначе «мир стоит» у хоста = «связи нет» у друзей), а Play.tick сам
       решает, что делать при running=false — сеть стоит в нём ДО проверки
       времени. Даём один кадр, а не весь отрезок: время мира не идёт. */
    if (!P.state.running) {
      simDebt = 0;
      P.tick(elapsed > SIM_STEP ? SIM_STEP : elapsed);
      return elapsed;
    }

    simDebt += elapsed;
    if (simDebt > MAX_DEBT) {
      var lost = simDebt - MAX_DEBT;
      simDebt = MAX_DEBT;
      dropTime(lost);
    }
    return drain(document.hidden ? BUDGET_HIDDEN_MS : BUDGET_MS);
  }

  function catchUp() { advance(simNow()); }

  /* Всё, что возвращает страницу в мир: вкладку выбрали, окно вернули,
     страницу разморозили. Мир к этому моменту отстал на весь отрезок — и
     догоняет его сразу, до первого кадра. Хосту тут же возвращается базовая
     частота снимков: в скрытой вкладке её замер сети врёт (см. Play.netWake),
     и без сброса друзья получали редкие кадры ещё несколько секунд. */
  function bindClock() {
    document.addEventListener('visibilitychange', function () {
      catchUp();
      if (!document.hidden && global.Play && global.Play.checkCache) global.Play.checkCache();
      if (!document.hidden && global.Play && global.Play.netWake) global.Play.netWake();
    });
    global.addEventListener('focus', function () {
      catchUp();
      if (global.Play && global.Play.netWake) global.Play.netWake();
    });
    global.addEventListener('blur', catchUp);
    global.addEventListener('pageshow', function () {
      catchUp();
      if (global.Play && global.Play.checkCache) global.Play.checkCache();
      if (global.Play && global.Play.netWake) global.Play.netWake();
    });
    document.addEventListener('resume', function () {
      catchUp();
      if (global.Play && global.Play.netWake) global.Play.netWake();
    });
    document.addEventListener('freeze', catchUp);

    /* Пока вкладка скрыта, кадров нет вовсе. Таймер там редеет (до раза в
       секунду, в глубоком фоне — до раза в минуту), поэтому он не «тикает
       раз в секунду», а каждый раз догоняет всё пропущенное. В видимой
       вкладке его роль играет rAF: если кадры идут, таймер молчит и не
       считает время дважды. */
    global.setInterval(function () {
      var now = simNow();
      if (!document.hidden && now - lastFrameAt < STALL_MS) return;
      advance(now);
    }, 1000);
  }

  function hideBoot() {
    $('boot').classList.add('leaving');
    global.setTimeout(function () { $('boot').classList.add('hidden'); }, 400);
  }

  /* Часы заводим ПОСЛЕ загрузки: время загрузки атласов партии не
     принадлежит. Дальше их двигает каждый кадр и каждый возврат. */
  function startClock() {
    simLast = simNow();
    simDebt = 0;
    simDropped = 0;
    lastFrameAt = simLast;
    bindClock();
    loop(performance.now());
  }

  function normalMenu() {
    // Заставка: живой остров за меню. Пока грузились атласы, экран показывал
    // море и доску загрузки — теперь под ними появляется мир. Порядок важен:
    // сначала меню раскладывает себя, потом движок ставит остров в его правую
    // колонку — до раскладки он не знает, сколько там места.
    Menu.show();
    Play.diorama();
    hideBoot();
    Menu.rollSeed();
    startClock();
  }

  function begin() {
    /* После F5 не показываем меню, если в этом браузере есть сохранённая
       партия: сначала пробуем вернуться в неё. Если лобби уже нет — обычное
       меню, без ложной надежды. */
    if (global.Lobby && global.Lobby.hasSaved && global.Lobby.hasSaved()) {
      var text = $('bootText');
      if (text) text.textContent = 'возвращаемся в игру…';
      global.Lobby.resumeSaved().then(function (where) {
        if (where === 'game' && Play.state.netRole) {
          hideBoot();
          startClock();
          return;
        }
        if (where === 'lobby') {
          /* Экран лобби уже раскрыт; меню под ним не показываем — иначе
             оно легло бы сверху (тот же z-index, позже в DOM). */
          Play.diorama();
          hideBoot();
          startClock();
          return;
        }
        normalMenu();
      }, normalMenu);
      return;
    }
    normalMenu();
  }

  /* ------------------------------- цикл -------------------------------- */

  /* Один кадр. Каждая подсистема — за своей границей: ошибка отрисовки не
     должна отменять шаг мира, а ошибка шага — рисование и интерфейс. Граница
     не глотает ошибку: Play.noteFault записывает стек/фазу/сущность и явно
     останавливает авторитетный мир (LOOP-01). */
  function guardFrame(label, fn) {
    try { return fn(); } catch (e) {
      if (global.Play && global.Play.noteFault) {
        global.Play.noteFault(e, label);
      } else {
        console.error('4tox: кадр (' + label + ')', e);
      }
      return null;
    }
  }

  function loop(t) {
    /* Следующий кадр ставится ПЕРВЫМ: раньше он стоял последним, и одно
       исключение в advance/draw/Hud.tick обрывало цепочку НАВСЕГДА —
       «полуживой мир», в котором не двигается даже интерфейс. */
    global.requestAnimationFrame(loop);
    try {
      frame(t);
    } catch (e) {
      if (global.Play && global.Play.noteFault) global.Play.noteFault(e, 'frame');
      else console.error('4tox: кадр', e);
    }
  }

  function frame(t) {
    var M = global.Metrics;
    var frameStart = (M && M.frame) ? wallNow() : 0;
    var dt = Math.min(0.05, (t - last) / 1000) || 0;
    last = t;
    lastFrameAt = simNow();
    var P = global.Play;

    guardFrame('keys', function () { Play.stepKeys(dt); });
    /* Мир идёт по стенным часам: кадр может опоздать на секунды — вкладка
       была скрыта, окно свёрнуто, машина спала, — и отрезок догоняется
       порциями по бюджету (advance). renderer получает время кадра, ему
       нужны волны и анимация. */
    if (!(P && P.state && P.state.faulted)) {
      guardFrame('advance', function () { advance(simNow()); });
      guardFrame('draw', function () { Play.draw(t / 1000); });
    }
    /* Интерфейс живёт всегда: по нему игрок выгружает диагностику и
       восстанавливается. Он не считает мир, поэтому стоящий мир ему не
       мешает. */
    guardFrame('hud', function () { Hud.tick(dt); });

    /* Полный кадр — для встроенных счётчиков (Metrics.frame). Если агент 2
       ещё не завёл функцию, ничего не выдумываем: поле frameMaxMs в
       metrics.js есть, но API кадра — его зона. */
    if (frameStart && M && M.frame) M.frame(wallNow() - frameStart);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  /* Наружу — для автотестов (game/tools/menu.js). Игра не обязана быть
     скриптуемой, но проверить её иначе нечем: снимок экрана не отвечает на
     вопрос «одна ли ратуша на карте». */
  global.__game = {
    Play: null,           // заполняется ниже: Play — глобальный модуль
    Menu: null,
    Hud: null,
    start: startGame,
    toMenu: toMenu,
    newIsland: newIsland,
    pause: openPause,
    resume: closePause,
    assets: ASSETS,
    /* Часы мира — для приёмки: `jump(ms)` делает вид, что прошло ms, и
       возвращает, сколько мира догнано. Проверять фон заморозкой страницы
       тоже можно (menu.js так и делает), но точный отрезок так короче.
       Догон идёт теми же порциями по BUDGET_MS, что и в игре, — иначе
       jump(600000) на 192-й карте синхронно держал бы поток ~1 с и
       приёмка «повисла» бы на одном вызове. Предел JUMP_MS не даёт
       зависнуть навсегда: что не успели, остаётся в долге (debt()) и
       догоняется следующими вызовами/кадрами, а не выбрасывается. */
    clock: {
      now: simNow,
      jump: function (ms) {
        var P = global.Play;
        if (!P || !P.state || !P.state.world) return 0;
        if (P.state.netRole === 'client' || !P.state.running) return 0;
        var want = Math.max(0, Number(ms) || 0) / 1000;
        if (!(want > 1e-9)) return 0;
        var before = P.state.seconds || 0;
        simDebt += want;
        var started = wallNow();
        while (simDebt > 1e-9 && wallNow() - started < JUMP_MS) {
          if (!(drain(BUDGET_MS) > 0)) break;
        }
        /* Время, потраченное на сам догон, миру не принадлежит. */
        simLast = simNow();
        var done = (P.state.seconds || 0) - before;
        return done > 0 ? done : 0;
      },
      debt: function () { return simDebt; },
      dropped: function () { return simDropped; },
      /* Приёмке: подать часы напрямую, не ожидая кадра или таймера. Это
         ровно тот же advance(now), что зовёт цикл; возвращает, сколько мира
         догнано этим вызовом. */
      advance: function (now) {
        return advance(typeof now === 'number' ? now : simNow());
      }
    }
  };
  global.__game.Play = global.Play;
  global.__game.Menu = global.Menu;
  global.__game.Hud = global.Hud;
})(typeof window !== 'undefined' ? window : globalThis);
