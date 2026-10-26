/* hud.js — то, что лежит поверх карты во время партии.

   Таблички деревни и выбранной постройки, панель найма в лагере, обзор,
   подсказки клавиш, всплывающие сообщения и меню паузы. Всё это — экран, а не
   мир: мир живёт в js/play.js, и HUD только читает его состояние.

   Четыре решения, которые тут видны:

   1. ПОРТРЕТЫ ЖИТЕЛЕЙ ЖИВЫЕ. В строках деревни не картинка «человек вообще»,
      а тот кадр атласа, который житель играет прямо сейчас: идёт — шагает,
      рубит — замахивается. Это стоит одного drawImage на строку и сразу
      отвечает на вопрос «чем он занят», не заставляя искать его глазами на
      карте.

   2. ГЛАВНЫЙ СЧЁТЧИК ДЕРЕВНИ — БРЁВНА. Число берётся из мира
      (world.village.logs), а не считается здесь: сдача брёвен — событие мира,
      и второй счётчик в интерфейсе разошёлся бы с первым на первой же правке.
      Срубленные деревья не выброшены — они уехали в паузу: там их видно, а
      карту они не занимают.

   3. ПАНЕЛЬ НАЙМА НИЧЕГО НЕ РЕШАЕТ. Кто может работать в лагере, решает
      движок (Session.canHire/hire/fire, Buildings.workSlots), а HUD только
      раскладывает ответ по экрану — включая причину отказа: выключенная
      кнопка без объяснения это загадка.

   4. ПОДСКАЗКИ УЕЗЖАЮТ САМИ. Полоса клавиш нужна первые полминуты; потом она
      только закрывает карту. Она уходит вниз и возвращается, когда игрок ведёт
      мышью по нижнему краю экрана.

   5. ОТЛАДКА УБРАНА С ГЛАЗ. Сид, герб острова и список жителей — сведения
      для разработчика, а не для игрока: они лежат в выезжающей панели
      (`#debugDrawer`), вместе с «Следить» и «К жителю». На виду осталась
      строка добытых ресурсов: пока ресурс один — брёвна, и рядом с числом
      стоит настоящая охапка из игры (`game/assets/wood.png`).

   6. СТРОЙКА — ЭТО ПОКУПКА. Меню построек показывает то, что вернул
      `Play.buildOptions` (цена, пятно, хватает ли брёвен), а постановка —
      `Play.beginBuild` / `Play.buildAction`. HUD не решает ни «сколько
      стоит», ни «годится ли место»: это движок и мир. */

(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* Обзор считается в координатах движка (render.js: MM_SIZE = 192): по ним
     же отдаёт точки worldToMM и принимает пиксели pickMinimap. Размер канваса
     на экране задаёт CSS, а внутренний — этот, умноженный на плотность. */
  var MM = 192;

  /* Через сколько секунд партии полоса подсказок уезжает. */
  var HINTS_LIFE = 26;

  /* Как часто обновляются надписи. Состояние жителя меняется раз в несколько
     секунд, счёт — раз в десять; шесть записей в DOM на кадр тут не нужны. */
  var REFRESH = 0.12;

  /* Сколько живёт всплывающее «+4» над лагерем. Число одно на JS и CSS
     (hud.css: gain-rise .95s): если анимация длиннее — элемент исчезнет на
     середине полёта. */
  var GAIN_LIFE = 950;

  /* Точки жителей на обзоре: у нанятого и у гуляющего разный цвет. Движок
     (Session.drawVillagers) рисует их одинаковыми — это взгляд генератора, где
     найма нет; в игре работа видна и на обзоре. */
  var DOT_FREE = '#fff2c4';      // гуляет — cream, как рисовал движок
  var DOT_WORK = '#2f6420';      // работает — grass-deep: тёмная точка на траве
  var DOT_WORK_RING = '#fff6d8';

  var el = {};
  var mmCtx = null;
  var mmDpr = 1;
  var actions = {};
  var rows = [];              // строки жителей в выезжающей панели
  var listSig = '';           // по нему видно, что строки надо пересобрать
  var lastLogs = -1;
  var hintT = 0;
  var stateAcc = 0;
  /* Открыт экран «Меню» (бывшая пауза). Это НЕ остановка мира: время идёт,
     жители работают, доска только закрывает карту и показывает счётчики. */
  var paused = false;
  var netLostShown = false;   // экран «связь с хостом потеряна», а не победа/поражение
  /* Своя ратуша пала, партия ещё идёт: смотрим, но не строим и не воюем. */
  var spectator = false;
  var hire = { camp: null, mode: null, rows: [], sig: '' };
  /* Войска: открыта ли панель, сколько взято от каждой группы и какие id
     выбраны. Группы и выбор считает mapgen2/js/army.js; здесь только числа. */
  var squad = { open: false, counts: {}, groups: [], ids: [], sig: '' };
  var drawerOpen = false;     // сведения о деревне выехали
  var buildOpen = false;      // меню построек открыто
  var buildRows = [];         // карточки меню построек
  var buildSig = '';          // по нему видно, что карточки надо пересобрать
  var placeSig = '';          // строка полосы размещения
  var spendTimer = 0;

  /* Сколько секунд метка угрозы живёт на мини-карте (задание 4.9). Само
     событие остаётся в журнале: гаснет только метка и кнопка «к месту атаки». */
  var THREAT_LIFE = 10;

  /* Журнал событий. items — уже развёрнутые к виду «новые сверху», lastId —
     номер последнего прочитанного события: по нему видно, надо ли вообще
     трогать DOM (Events.sinceId считает то же на стороне движка). Ни один
     показ здесь не всплывашка: журнал — часть интерфейса, он живёт и в сети,
     где всплывашек нет вовсе. */
  var evLog = { open: false, lastId: 0, items: [], threat: null };

  /* Обзор свёрнут игроком (кнопка «обзор») — отдельно от временного
     сворачивания на время постановки (#hud.placing). */
  var mmFolded = false;

  /* Профиль экономии: 30 кадров/с + DPR до 1.5 + реже волны. Скорость мира не
     меняется — её держат стенные часы boot.js, а не число кадров. */
  var economy = false;

  /* Как выглядит событие: значок и цвет строки. Виды — контракт §6
     (mapgen2/js/events.js): attack, destroy, growth-stop, no-forest, no-path,
     build-refused, command-rejected, net-back (+ net-lost у сети). */
  var EV_KINDS = {
    attack:             { ico: '⚔', cls: 'attacked' },
    destroy:            { ico: '☠', cls: 'destroyed' },
    'growth-stop':      { ico: '⏳', cls: 'warn' },
    'no-forest':        { ico: '🌲', cls: 'warn' },
    'no-path':          { ico: '🚧', cls: 'warn' },
    'build-refused':    { ico: '⛔', cls: 'warn' },
    'command-rejected': { ico: '⛔', cls: 'warn' },
    'net-lost':         { ico: '📶', cls: 'warn' },
    'net-back':         { ico: '📶', cls: 'good' }
  };

  function init(bind) {
    actions = bind || {};

    el.hud = $('hud');
    el.island = $('hudIsland');
    el.dims = $('hudDims');
    el.logs = $('villageLogs');
    el.logsWord = $('villageLogsWord');
    el.resBar = $('resBar');
    el.resWoodIcon = $('resWoodIcon');
    el.villagerList = $('villagerList');
    el.villagerCount = $('villagerCount');
    el.growthNote = $('growthNote');
    el.crest = $('crest');
    el.hints = $('hintBar');
    el.toasts = $('toasts');
    el.netBadge = $('netBadge');
    el.spectatorBadge = $('spectatorBadge');
    el.pause = $('pause');
    el.mm = $('mm');
    // Выезжающая панель сведений: сид, жители, «Следить» и «К жителю».
    el.drawer = $('debugDrawer');
    el.btnDrawer = $('btnDrawer');
    // Меню построек и полоса размещения.
    el.buildMenu = $('buildMenu');
    el.btnBuild = $('btnBuild');
    el.buildList = $('buildList');
    el.placeBar = $('placeBar');
    el.placeName = $('placeName');
    el.placePrice = $('placePrice');
    el.placeState = $('placeState');
    // Клетка под курсором и выбранная постройка.
    el.cellBar = $('cellBar');
    el.cellText = $('cellText');
    el.buildPlaque = $('buildPlaque');
    el.buildName = $('buildName');
    el.buildSize = $('buildSize');
    el.buildCell = $('buildCell');
    el.buildFace = $('buildFace');
    // «Править» в табличке выбранного здания — вход в правку без удержания.
    el.btnEdit = $('btnEdit');
    // Панель постройки: у лагеря наём, у казармы тренировка.
    el.hirePanel = $('hirePanel');
    el.hireTitle = $('hireTitle');
    el.hireSlots = $('hireSlots');
    el.hireList = $('hireList');
    el.hireNote = $('hireNote');
    el.hireAll = $('hireAll');
    el.fireAll = $('fireAll');
    el.hireBatchNote = $('hireBatchNote');
    // Войска: панель отряда и её кнопки.
    el.btnSquad = $('btnSquad');
    el.squadPanel = $('squadPanel');
    el.squadClose = $('squadClose');
    el.squadSlots = $('squadSlots');
    el.squadList = $('squadList');
    el.squadNote = $('squadNote');
    el.squadAll = $('squadAll');
    el.squadHalf = $('squadHalf');
    el.squadClear = $('squadClear');
    el.squadOrder = $('squadOrder');
    el.squadStop = $('squadStop');
    el.squadHint = $('squadHint');
    // Итог боя.
    el.result = $('result');
    el.resultTitle = $('resultTitle');
    el.resultText = $('resultText');
    el.resultMenu = $('resultMenu');
    // Полоса правки постройки (открывается удержанием ЛКМ, см. js/play.js).
    el.editBar = $('editBar');
    el.editName = $('editName');
    el.editState = $('editState');
    el.editNote = $('editNote');
    // Журнал событий: плашка, её шапка, счётчик и список.
    el.eventLog = $('eventLog');
    el.eventLogToggle = $('eventLogToggle');
    el.eventLogLast = $('eventLogLast');
    el.eventLogIcon = $('eventLogIcon');
    el.eventLogCount = $('eventLogCount');
    el.eventLogList = $('eventLogList');
    // Полоса размещения: подтверждение на телефоне и вся линия.
    el.placeConfirm = $('placeConfirm');
    el.lineConfirm = $('lineConfirm');
    el.lineRotate = $('lineRotate');
    el.lineCancel = $('lineCancel');
    // Обзор: сворачивание, кнопка угрозы, рамка (для класса folded).
    el.minimapFrame = $('minimapFrame');
    el.btnMmFold = $('btnMmFold');
    el.threatGo = $('threatGo');
    // «Мир пропустил N с» и профиль экономии.
    el.simBadge = $('simBadge');
    el.btnEconomy = $('btnEconomy');

    /* Плотность мини-карты ограничена двумя: внутренний холст 192 x 2 — это
       уже 147 456 пикселей на перерисовку, а DPR 3 давал 331 776 при том же
       размере на экране. Обзор — картинка «где я», а не текст: разницы
       глазом не видно, а блит вдвое дешевле. */
    mmDpr = Math.min(global.devicePixelRatio || 1, 2);

    /* На телефоне журнал по умолчанию свёрнут в одну строку: экран низкий, и
       раскрытый список закрыл бы карту. На компьютере — раскрыт. */
    evLog.open = global.innerWidth > 560 && global.innerHeight > 500;
    el.mm.width = MM * mmDpr;
    el.mm.height = MM * mmDpr;
    mmCtx = el.mm.getContext('2d');

    bindButtons();
    bindHints();
  }


  function bindButtons() {
    $('btnFollow').addEventListener('click', function () {
      var on = global.Play.toggleFollow();
      $('btnFollow').classList.toggle('active', on);
      if (on) toast('Камера следит за выбранным жителем');
    });
    $('btnFind').addEventListener('click', function () {
      if (!global.Play.focusVillager()) toast('Жителя пока нет');
    });
    $('btnZoomIn').addEventListener('click', function () { global.Play.zoom(1.3); });
    $('btnZoomOut').addEventListener('click', function () { global.Play.zoom(1 / 1.3); });
    $('btnPause').addEventListener('click', function () { actions.pause && actions.pause(); });

    /* Сведения о деревне: кнопка в левом углу и крестик в самой панели.
       Панель выезжает слева; сид и жители больше не закрывают карту. */
    el.btnDrawer.addEventListener('click', function () { toggleDrawer(); });
    $('btnDrawerClose').addEventListener('click', function () { closeDrawer(); });

    /* Меню построек: кнопка «Стройка», крестик и повторное нажатие. Клик по
       карте закрывает меню: игрок уже выбрал место глазами, и панель не
       должна висеть над ним. */
    el.btnBuild.addEventListener('click', function () { toggleBuildMenu(); });
    $('btnBuildClose').addEventListener('click', function () { closeBuildMenu(); });

    /* «Править» в табличке выбранного здания. Команда — миру
       (Play.editSelected), своих правил у кнопки нет; отказ говорится
       всплывашкой той же фразой движка. Ведение по кнопке НЕ начинается: дом
       встаёт в режим правки и ждёт «Двигать» или удержания. */
    if (el.btnEdit) {
      el.btnEdit.addEventListener('click', function () {
        var P = global.Play;
        if (!P || typeof P.editSelected !== 'function') return;
        var res = P.editSelected();
        if (res && res.ok === false && res.reason) toast(res.reason);
      });
    }

    /* Полоса размещения. «Повернуть» и «Отменить» — команды мира
       (Play.buildAction), своих правил у HUD нет. */
    $('placeRotate').addEventListener('click', function () { buildAct('rotate'); });
    $('placeCancel').addEventListener('click', function () { buildAct('cancel'); });

    $('btnResume').addEventListener('click', function () { actions.resume && actions.resume(); });
    $('btnNewIsland').addEventListener('click', function () { actions.newIsland && actions.newIsland(); });
    $('btnToMenu').addEventListener('click', function () { actions.toMenu && actions.toMenu(); });
    if (el.resultMenu) {
      el.resultMenu.addEventListener('click', function () {
        hideResult();
        if (actions.toMenu) actions.toMenu();
      });
    }

    /* Кнопки полосы правки. Каждая — одно действие движка и ничего больше:
       «что можно» решает Buildings.EDIT, «годится ли место» — Buildings.checkAt,
       а HUD только передаёт команду и показывает ответ. Отказ, у которого нет
       своей кнопки (например «сюда нельзя: вода»), говорится всплывашкой —
       фразой движка дословно. */
    [['editMove', 'move'], ['editRotate', 'rotate'], ['editDelete', 'delete'],
      ['editApply', 'apply'], ['editCancel', 'cancel']].forEach(function (pair) {
      var btn = $(pair[0]);
      if (!btn) return;
      btn.addEventListener('click', function () { editAct(pair[1]); });
    });

    /* Пакетные действия найма: те же canHire/hire/fire, только в цикле. HUD
       не решает, кого брать и сколько: ответ целиком у движка (Session.hireAll,
       Session.fireAll), здесь только кнопка и всплывашка. */
    if (el.hireAll) {
      el.hireAll.addEventListener('click', function () { hireBatch('hire'); });
    }
    if (el.fireAll) {
      el.fireAll.addEventListener('click', function () { hireBatch('fire'); });
    }

    /* Войска: открыть/закрыть панель, «Всех», «Половина», «Сброс», приказ и
       стоп. Числа от групп и id воинов собирает army.js; HUD не решает, кто в
       отряде, — он только передаёт выбор в Play.setSquad.

       «Сброс» ЗАПИСЫВАЕТ НУЛИ в каждую группу, а не стирает объект: иначе
       refreshSquad принимал отсутствующее число за «новую группу» и снова
       выбирал всех — кнопка «Сброс» на деле выбирала весь отряд. */
    if (el.btnSquad) {
      el.btnSquad.addEventListener('click', function () { toggleSquad(); });
    }
    if (el.squadClose) {
      el.squadClose.addEventListener('click', function () { closeSquad(); });
    }
    if (el.squadAll) {
      el.squadAll.addEventListener('click', function () {
        squad.groups.forEach(function (g) { squad.counts[g.key] = g.ids.length; });
        refreshSquad();
      });
    }
    if (el.squadHalf) {
      el.squadHalf.addEventListener('click', function () {
        if (global.Army && global.Army.halfCounts) {
          squad.counts = global.Army.halfCounts(squad.groups);
        } else {
          squad.counts = {};
          squad.groups.forEach(function (g) {
            squad.counts[g.key] = g.ids.length > 1 ? Math.ceil(g.ids.length / 2) : g.ids.length;
          });
        }
        refreshSquad();
      });
    }
    if (el.squadClear) {
      el.squadClear.addEventListener('click', function () {
        squad.groups.forEach(function (g) { squad.counts[g.key] = 0; });
        refreshSquad();
      });
    }
    if (el.squadOrder) {
      el.squadOrder.addEventListener('click', function () {
        var ids = squad.ids.slice();
        if (!ids.length) { toast('Сначала выберите воинов'); return; }
        if (global.Play.beginOrder) {
          global.Play.beginOrder(ids);
          toast('Кликните по карте — отряд пойдёт туда');
        }
      });
    }
    if (el.squadStop) {
      el.squadStop.addEventListener('click', function () {
        /* Никто не выбран — «Стоп» останавливает весь отряд. Выключенная
           кнопка при живых воинах и надпись «останавливать некого» были бы
           ложью: останавливать есть кого. */
        var ids = squad.ids.length ? squad.ids : null;
        var n = global.Play.stopArmy ? global.Play.stopArmy(ids) : 0;
        toast(n ? (ids ? 'Выбранные воины остановлены' : 'Все воины остановлены')
                : 'Останавливать некого');
      });
    }
    if (el.squadList) {
      el.squadList.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-squad]') : null;
        if (!btn) return;
        var row = btn.closest('.squad-row');
        if (!row) return;
        var key = row.getAttribute('data-key');
        var g = null, i;
        for (i = 0; i < squad.groups.length; i++) if (squad.groups[i].key === key) g = squad.groups[i];
        if (!g) return;
        var cur = Math.max(0, Math.min(g.ids.length, squad.counts[key] || 0));
        var act = btn.getAttribute('data-squad');
        if (act === 'inc') cur++;
        else if (act === 'dec') cur--;
        else if (act === 'half') cur = global.Army ? global.Army.half(g.ids.length) : Math.ceil(g.ids.length / 2);
        squad.counts[key] = Math.max(0, Math.min(g.ids.length, cur));
        refreshSquad();
      });
    }

    // Клик по обзору — переход в точку. Это единственное, что обзор умеет,
    // и подсказывать тут нечего: курсор над ним — перекрестие.
    el.mm.addEventListener('pointerdown', function (e) {
      var r = el.mm.getBoundingClientRect();
      var renderer = global.Play.renderer();
      if (!renderer) return;
      var p = renderer.pickMinimap(
        (e.clientX - r.left) * (MM / r.width),
        (e.clientY - r.top) * (MM / r.height));
      if (!p) return;
      renderer.centerOn(p.x + 0.5, p.y + 0.5);
      global.Play.state.follow = false;
      $('btnFollow').classList.remove('active');
    });

    /* Журнал: шапка сворачивает/раскрывает, стрелка «→» ведёт камеру к месту
       события (Play.goToEvent). Делегирование — потому что строки
       пересобираются на каждое новое событие. */
    if (el.eventLogToggle) {
      el.eventLogToggle.addEventListener('click', function () {
        setEventLogOpen(!evLog.open);
      });
    }
    if (el.eventLogList) {
      el.eventLogList.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('.ev-go') : null;
        if (!btn) return;
        var row = btn.closest('.event-row');
        if (!row) return;
        var x = +row.getAttribute('data-x'), y = +row.getAttribute('data-y');
        if (isFinite(x) && isFinite(y) && global.Play.goToEvent) {
          global.Play.goToEvent(x, y);
        }
      });
    }
    /* «К месту атаки» у обзора: та же точка, что у последнего attack. */
    if (el.threatGo) {
      el.threatGo.addEventListener('click', function () {
        var th = evLog.threat;
        if (th && global.Play.goToEvent) global.Play.goToEvent(th.x, th.y);
      });
    }
    /* Сворачивание обзора: на телефоне он занимает пол-экрана. */
    if (el.btnMmFold) {
      el.btnMmFold.addEventListener('click', function () { setMmFolded(!mmFolded); });
    }
    /* «Поставить» на телефоне: касание карты двигает призрак, подтверждение —
       этой кнопкой (то же действие, что клик мышью). */
    if (el.placeConfirm) {
      el.placeConfirm.addEventListener('click', function () { buildAct('place'); });
    }
    /* Линия: «Построить N» — одна транзакция, «Повернуть» — поворот серии,
       «Отменить» — закрыть без покупки. Своих правил у кнопок нет. */
    if (el.lineConfirm) {
      el.lineConfirm.addEventListener('click', function () {
        var res = global.Play.lineConfirm ? global.Play.lineConfirm() : null;
        if (res && !res.ok && res.reason) toast(res.reason);
      });
    }
    if (el.lineRotate) {
      el.lineRotate.addEventListener('click', function () {
        var res = global.Play.lineRotate ? global.Play.lineRotate() : null;
        if (res && !res.ok && res.reason) toast(res.reason);
      });
    }
    if (el.lineCancel) {
      el.lineCancel.addEventListener('click', function () {
        if (global.Play.lineCancel) global.Play.lineCancel();
      });
    }
    /* Экономия: единственная настройка качества, которая видна игроку. */
    if (el.btnEconomy) {
      el.btnEconomy.addEventListener('click', function () { toggleEconomy(); });
    }

    /* Клик по карте убирает меню построек: место выбирают глазами по карте, и
       панель не должна закрывать её в этот момент. Панель сведений так не
       закрывается — она живёт сбоку и карте не мешает. */
    $('view').addEventListener('pointerdown', function () {
      if (buildOpen) closeBuildMenu();
    });
  }

  function bindHints() {
    global.addEventListener('pointermove', function (e) {
      if (!el.hints) return;
      var near = e.clientY > global.innerHeight - 130 && e.clientX < 560;
      if (near && el.hints.classList.contains('faded')) {
        el.hints.classList.remove('faded');
        hintT = HINTS_LIFE - 10;           // показали — дали ещё десять секунд
      }
    });

    /* Клавиши, которые принадлежат экрану, а не миру: T открывает сведения о
       деревне, O — панель войск (её ловит js/play.js), Esc закрывает меню
       построек, панель войск и сведения о деревне ПРЕЖДЕ, чем мир снимет
       выбор или откроет паузу. Иначе одно нажатие делало бы два дела.
       Полоса размещения — исключение: её отменяет мир (js/play.js), и Esc при
       ней доходит до него. */
    global.addEventListener('keydown', function (e) {
      if (global.Keys ? global.Keys.typing(e)
          : (e.target && /input|select|textarea/i.test(e.target.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      /* Имя клавиши — по физическому месту (mapgen2/js/keys.js): на русской
         раскладке `e.key` для T приходит как «е», и панель деревни не
         открывалась. */
      var k = global.Keys ? global.Keys.name(e) : String(e.key || '').toLowerCase();
      if (k === 't') {
        toggleDrawer();
        e.preventDefault();
        return;
      }
      if (k !== 'escape') return;
      if (global.Play.buildInfo && global.Play.buildInfo()) return;   // отменит мир
      if (buildOpen) {
        closeBuildMenu();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (squad.open) {
        /* Режим приказа — действие мира, и Esc отменяет его первым. Панель
           останется открытой: игрок только что нажал в ней «Приказ» и,
           передумав, ждёт отмены приказа, а не закрытия панели. */
        if (global.Play.state && global.Play.state.order) return;
        closeSquad();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (drawerOpen) {
        closeDrawer();
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    });
  }

  /* --------------------- сведения о деревне (панель) ------------------- */

  function toggleDrawer(on) {
    setDrawer(on === undefined ? !drawerOpen : !!on);
  }

  function setDrawer(on) {
    drawerOpen = !!on;
    if (!el.drawer) return;
    el.drawer.classList.toggle('open', drawerOpen);
    el.drawer.setAttribute('aria-hidden', drawerOpen ? 'false' : 'true');
    el.btnDrawer.setAttribute('aria-expanded', drawerOpen ? 'true' : 'false');
    el.btnDrawer.classList.toggle('active', drawerOpen);
    /* Панель открыли — строки жителей надо пересобрать сразу, а не ждать
       следующего тика HUD: игрок смотрит на них сейчас. Панель войск
       закрывается: она стоит на том же левом краю, и две таблички спорили бы
       за одно место. */
    if (drawerOpen) {
      closeSquad();
      listSig = '';
      paintVillagers(global.Play.state);
      // Пересборка строк снимает подсветку — возвращаем её: выбранного жителя
      // выбирают на карте, а смотрят в панели.
      onFocus({ villager: global.Play.state.focus });
    }
  }

  function closeDrawer() { setDrawer(false); }

  /* ------------------------- меню построек ---------------------------- */

  function toggleBuildMenu(on) {
    if (on === undefined) on = !buildOpen;
    if (on) openBuildMenu(); else closeBuildMenu();
  }

  function openBuildMenu() {
    if (!global.Play.isPlaying() || spectator) return;
    closeSquad();
    buildOpen = true;
    buildSig = '';
    el.buildMenu.classList.remove('hidden');
    el.btnBuild.classList.add('active');
    el.btnBuild.setAttribute('aria-expanded', 'true');
    rebuildBuildMenu();
  }

  function closeBuildMenu() {
    buildOpen = false;
    if (el.buildMenu) el.buildMenu.classList.add('hidden');
    if (el.btnBuild) {
      el.btnBuild.classList.remove('active');
      el.btnBuild.setAttribute('aria-expanded', 'false');
    }
  }

  function buildOptions() {
    var P = global.Play;
    return (P && typeof P.buildOptions === 'function') ? P.buildOptions() : [];
  }

  function rebuildBuildMenu() {
    if (!el.buildList) return;
    var opts = buildOptions();
    /* Ключ по типу, варианту и цене: если состав меню не изменился, строки не
       пересобираются — меняется только доступность кнопок (refreshBuildMenu). */
    var sig = opts.map(function (o) { return o.type + ':' + o.variant + ':' + o.price; }).join('|');
    if (sig === buildSig) { refreshBuildMenu(); return; }
    buildSig = sig;
    el.buildList.innerHTML = '';
    buildRows = [];
    for (var i = 0; i < opts.length; i++) addBuildRow(opts[i]);
    refreshBuildMenu();
  }

  function addBuildRow(opt) {
    var li = document.createElement('li');
    li.className = 'build-card';
    li.dataset.type = opt.type;

    var preview = document.createElement('span');
    preview.className = 'build-preview';
    var canvas = document.createElement('canvas');
    canvas.width = 68; canvas.height = 52;
    preview.appendChild(canvas);

    var info = document.createElement('span');
    info.className = 'build-info';
    var name = document.createElement('b');
    name.textContent = capitalize(opt.name || opt.type);
    var note = document.createElement('i');
    note.textContent = opt.note + ' · ' + opt.fp.w + ' × ' + opt.fp.h;
    info.appendChild(name);
    info.appendChild(note);

    var price = document.createElement('span');
    price.className = 'build-price';
    price.title = 'цена в брёвнах';
    var icon = document.createElement('img');
    icon.src = 'assets/wood.png';
    icon.alt = 'брёвна';
    icon.draggable = false;
    var cost = document.createElement('b');
    cost.textContent = opt.price;
    price.appendChild(icon);
    price.appendChild(cost);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wood-btn build-btn';
    btn.textContent = 'Поставить';
    btn.addEventListener('click', function () { chooseBuilding(opt.type); });

    /* Вторая кнопка карточки — серия. Тот же тип и цена, другое действие:
       Play.beginLine ведёт линию с предпросмотром всей серии и одной
       транзакцией (Buildings.planLine). */
    var lineBtn = document.createElement('button');
    lineBtn.type = 'button';
    lineBtn.className = 'wood-btn build-btn line-btn';
    lineBtn.textContent = 'Линия';
    lineBtn.title = 'Несколько таких построек одной линией, с предпросмотром';
    lineBtn.addEventListener('click', function () { chooseLine(opt.type); });

    li.appendChild(preview);
    li.appendChild(info);
    li.appendChild(price);
    li.appendChild(btn);
    li.appendChild(lineBtn);
    el.buildList.appendChild(li);
    buildRows.push({ li: li, canvas: canvas, btn: btn, lineBtn: lineBtn, opt: opt });

    paintBuildPreview(canvas, opt);
  }

  /* Портрет постройки в карточке — тот кадр атласа, который встанет на карту
     (вариант и поворот из Play.buildOptions). Если атлас ещё не приехал, канвас
     остаётся пустым: карточка читается по имени и цене. */
  function paintBuildPreview(canvas, opt) {
    var renderer = global.Play.renderer();
    var set = renderer && renderer.spritesFor(opt.type);
    var spr = set && global.Buildings.sprite(set, opt.variant, opt.rot);
    paintWholeSprite(canvas, spr, 0.94, previewZoom(opt.type));
  }

  /* Насколько увеличить кадр в портрете.

     У дома, лагеря и казармы (96 ppu) вокруг модели большие прозрачные поля:
     сама постройка занимает центр примерно 48 % кадра, и в квадратном
     портрете она выглядела бы вдвое мельче ратуши — у ратуши кадр обрезан
     вплотную. Это свойство атласов, а не модели, и компенсируется здесь, в
     показе; атласы не трогаются. Число — 1 / 0.48 с запасом. */
  function previewZoom(type) {
    return (type === 'house' || type === 'lumbercamp' || type === 'barracks' ||
      type === 'warcamp') ? 2.05 : 1;
  }

  /* Картинка постройки в портрет.

     Точку опоры здесь брать нельзя: у построек anchorY — середина основания
     кадра, ниже неё ещё двор, и вписывание по опоре срезало низ карточки
     (проверено кадром: от дома оставалась крыша). Поэтому кадр масштабируется
     целиком и центрируется, а `zoom` добирает прозрачные поля атласов. */
  function paintWholeSprite(canvas, spr, fit, zoom) {
    if (!canvas || !spr) return;
    var dpr = global.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 56, cssH = canvas.clientHeight || 56;
    var w = Math.max(1, Math.round(cssW * dpr));
    var h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    var g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    var k = Math.min(canvas.width / spr.sw, canvas.height / spr.sh) *
      (fit || 0.94) * (zoom || 1);
    var dw = spr.sw * k, dh = spr.sh * k;
    g.imageSmoothingEnabled = true;
    g.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh,
      (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  }

  /* Обновление доступности карточек: цена и «хватает ли» спрашиваются у мира
     каждый тик HUD, пока меню открыто. Строки при этом не пересобираются. */
  function refreshBuildMenu() {
    if (!buildOpen || !buildRows.length) return;
    var opts = buildOptions();
    for (var i = 0; i < buildRows.length && i < opts.length; i++) {
      var row = buildRows[i], opt = opts[i];
      row.opt = opt;
      row.li.classList.toggle('poor', !opt.afford);
      row.btn.disabled = !opt.afford;
      row.btn.textContent = opt.afford ? 'Поставить' : 'Мало брёвен';
      row.btn.title = opt.afford
        ? 'Взять постройку и поставить на карте'
        : 'не хватает брёвен: нужно ' + opt.price + ', у деревни ' + opt.logs;
      /* «Линия» включается и выключается тем же ответом мира: одна цена на
         первое здание, а всю серию считает и проверяет движок. */
      if (row.lineBtn) {
        row.lineBtn.disabled = !opt.afford;
        row.lineBtn.title = opt.afford
          ? 'Серия таких построек одной линией, с предпросмотром'
          : 'не хватает брёвен: нужно ' + opt.price + ', у деревни ' + opt.logs;
      }
    }
  }

  function chooseBuilding(type) {
    var res = global.Play.beginBuild(type);
    if (res && res.ok) closeBuildMenu();
    else if (res && res.reason) toast(res.reason);
  }

  function chooseLine(type) {
    var res = global.Play.beginLine ? global.Play.beginLine(type) : null;
    if (res && res.ok) closeBuildMenu();
    else if (res && res.reason) toast(res.reason);
  }

  function buildAct(action) {
    var P = global.Play;
    if (!P || typeof P.buildAction !== 'function') return null;
    var res = P.buildAction(action);
    if (res && !res.ok && res.reason) toast(res.reason);
    return res;
  }

  /* Полоса размещения: что ставим, сколько стоит и годится ли место под
     курсором. Всё приходит готовым из мира (`Play` шлёт событие `build`).
     Два вида полосы — одно здание и линия: у линии считаются N и общая цена,
     а подтверждает её отдельная кнопка «Построить N» (одна транзакция). */
  function onBuild(ev) {
    if (!el.placeBar) return;
    var info = ev && ev.info;
    if (!info) {
      el.placeBar.classList.add('hidden');
      el.placeBar.classList.remove('line');
      el.hud.classList.remove('placing');
      placeSig = '';
      return;
    }
    var line = info.mode === 'line';
    el.placeBar.classList.toggle('line', line);
    /* Пока открыта полоса, мини-карта сворачивается в квадрат (CSS
       #hud.placing): они стоят в одном углу, и на телефоне полоса накрывала
       обзор на 20 700 px². */
    el.hud.classList.add('placing');
    var name = capitalize(info.name || info.type);
    el.placeName.textContent = line ? (name + ' · линия') : name;
    el.placePrice.textContent = line ? (info.cost || 0) : info.price;
    el.placePrice.title = line
      ? 'Столько брёвен спишется за всю серию'
      : 'Столько брёвен спишется при постановке';
    var text;
    if (line) {
      var n = info.count || 0;
      var parts = [];
      parts.push(n
        ? (n + ' ' + buildingWord(n) + ' · ' + info.price + ' × ' + n + ' = ' +
           info.cost + ' ' + logWord(info.cost))
        : 'серия ещё не начата');
      if (!info.ok) parts.push('нельзя: ' + (info.reason || 'нет места'));
      else if (!info.afford) parts.push('не хватает брёвен');
      else parts.push(touchUI()
        ? 'место годится · тап — другой конец · «Построить» — вся серия'
        : 'место годится · тяните линию · R — повернуть');
      text = parts.join(' · ');
      var can = !!(info.ok && info.afford && n);
      if (el.lineConfirm) {
        el.lineConfirm.textContent = 'Построить' + (n ? ' ' + n : '');
        el.lineConfirm.disabled = !can;
        el.lineConfirm.title = can
          ? ('Построить всю серию: ' + n + ' шт. за ' + info.cost + ' брёвен')
          : (info.reason || 'не хватает брёвен');
      }
    } else {
      text = buildStateText(info);
      /* «Поставить» — только там, где касание не ставит само: на телефоне и
         планшете (Play.touchPreferred). На компьютере кнопка скрыта, мышь
         ставит кликом, как раньше. */
      if (el.placeConfirm) el.placeConfirm.classList.toggle('hidden', !touchUI());
    }
    if (text !== placeSig) {
      placeSig = text;
      el.placeState.textContent = text;
      el.placeState.classList.toggle('bad', line ? !(info.ok && info.afford) : !info.ok);
    }
    el.placeBar.classList.remove('hidden');
  }

  function buildStateText(info) {
    var head = info.x + ', ' + info.y + ' · ' + info.rot + '° · ';
    if (!info.ok) return head + 'нельзя: ' + info.reason;
    return head + (touchUI()
      ? 'место годится · тап — двигать · «Поставить» — поставить'
      : 'место годится · ЛКМ — поставить · R — повернуть');
  }

  function onBuilt(ev) {
    if (!ev) return;
    toast('Построено: ' + ev.name + ' · −' + ev.price + ' брёвен');
    paintLogs(global.Play.state);
  }

  /* ------------------------------- экраны ------------------------------ */

  function show() { el.hud.classList.remove('hidden'); }

  /* Есть ли на экране партия, которой нужны всплывашки и «+4». Пока открыто
     главное меню (HUD спрятан) или доска «Меню», мир за ними продолжает жить,
     и события оттуда не должны всплывать над чужим экраном. */
  function uiLive() {
    return !!(el.hud && !el.hud.classList.contains('hidden') && !paused);
  }
  /* HUD уходит — уходит и панель найма: она часть партии, а не экрана
     «поверх всего». Возврат в партию её не воскрешает: игрок снова кликнет по
     лагерю, если она ему нужна. Полоса правки уходит вместе с ней — и режим
     правки тоже закрывает мир (js/play.js: showInMenu), а не экран. */
  function hide() {
    el.hud.classList.add('hidden');
    closeHire();
    closePause();
    closeDrawer();
    closeBuildMenu();
    if (el.placeBar) el.placeBar.classList.add('hidden');
    onEdit(null);
  }

  /* Доска «Меню»: те же числа, что в HUD, только крупно и на паузе-экране.
     Ничего не останавливает — Play.pause() теперь только запрещает ввод. */
  /* Бейдж связи: «хост», «12 мс» или «нет связи». В одиночной игре скрыт.
     Число — круг клиент→сервер; оно не обещает 12 мс до хоста, но честно
     показывает, что канал жив и насколько он просел. */
  function setNetPing(ms, state) {
    if (!el.netBadge) return;
    var P = global.Play && global.Play.state;
    if (!P || !P.netRole) { el.netBadge.classList.add('hidden'); return; }
    el.netBadge.classList.remove('hidden');
    var bad = !!(state && (state.hostGone || state.stale));
    el.netBadge.classList.toggle('bad', bad);
    if (bad) {
      el.netBadge.textContent = 'нет связи';
      el.netBadge.title = 'Связь с хостом потеряна — ждём';
    } else if (P.netRole === 'host') {
      el.netBadge.textContent = 'хост';
      el.netBadge.title = 'Мир считается в этой вкладке';
    } else {
      el.netBadge.textContent = ms ? (ms + ' мс') : 'сеть';
      el.netBadge.title = 'Круг до сервера';
    }
  }

  /* Выбывший по ратуше — наблюдатель. Смотреть карту можно, но стройка и
     приказы войску закрыты: это не пауза и не конец партии, мир живёт. */
  function setSpectator(on) {
    spectator = !!on;
    if (el.spectatorBadge) {
      el.spectatorBadge.classList.toggle('hidden', !spectator);
      el.spectatorBadge.title = 'Ваша ратуша пала — вы наблюдаете';
    }
    if (el.btnBuild) el.btnBuild.disabled = spectator;
    if (el.btnSquad) el.btnSquad.disabled = spectator;
    if (el.btnEdit) el.btnEdit.disabled = spectator;
    if (spectator) {
      closeBuildMenu();
      closeHire();
      if (global.Play && global.Play.cancelOrder) global.Play.cancelOrder();
    }
    if (el.squadOrder) el.squadOrder.disabled = spectator || !squad.ids.length;
    if (el.squadStop) {
      var total = 0;
      for (var i = 0; i < squad.groups.length; i++) total += squad.groups[i].ids.length;
      el.squadStop.disabled = spectator || !total;
    }
  }

  /* «Связь с хостом потеряна» — НЕ экран итога и не выход из партии.

     Заказчик 2026-10-24: «игру выкинуло, у друга поднялся пинг и его тоже
     выкинуло». Хост мог просто задуматься на пару секунд (браузер отдал
     кадр позже, сеть моргнула); выбрасывать за это в меню нельзя. Поэтому
     здесь только всплывашка и бейдж «нет связи», а мир остаётся на экране
     последним кадром. Вернётся хост — hideNetLost снимет ожидание; не
     вернётся — игрок сам решит, когда открыть «Меню» и выйти. */
  function showNetLost(text) {
    if (netLostShown) return;
    netLostShown = true;
    if (el.result) el.result.classList.add('hidden');
    toast(text || 'Связь с хостом пропала — ждём. Вернётся — игра продолжится.',
      12000);
    setNetPing(0, { hostGone: true });
  }

  function hideNetLost() {
    if (!netLostShown) return false;
    netLostShown = false;
    if (el.result) el.result.classList.add('hidden');
    /* Доска «Меню» могла быть открыта до потери хоста — не закрываем её:
       игрок сам решит, вернуться в замерший мир или выйти. */
    return true;
  }

  function isNetLostShown() { return netLostShown; }

  function openPause() {
    var st = global.Play.state;
    if (!st.world) return;
    paused = true;
    closeHire();
    closeSquad();
    closeDrawer();
    closeBuildMenu();
    onBuild(null);
    $('pauseSeed').textContent = '«' + st.world.seed + '»';
    $('pauseSize').textContent = st.world.islandSize + ' × ' + st.world.islandSize;
    $('pauseLogs').textContent = logsOf(st);
    $('pauseFelled').textContent = st.felled;
    $('pauseTime').textContent = global.Play.timeText();
    el.pause.classList.remove('hidden');
  }

  function closePause() {
    paused = false;
    el.pause.classList.add('hidden');
  }

  function isPaused() { return paused; }

  function hideResult() {
    if (el.result) el.result.classList.add('hidden');
  }

  /* Ратуша пала. Экран итога — не пауза: время уже стоит, а игроку нужно
     сказать, чем кончилось. Кнопка одна — в меню; «ещё бой» начинается из
     меню, чтобы не плодить второй способ начать партию. */
  function onDefeat(ev) {
    var win = ev && ev.result === 'win';
    paused = true;
    closeHire();
    closeSquad();
    closeBuildMenu();
    closeDrawer();
    if (el.spectatorBadge) el.spectatorBadge.classList.add('hidden');
    if (el.resultTitle) el.resultTitle.textContent = win ? 'Победа' : 'Поражение';
    if (el.resultText) {
      el.resultText.textContent = win
        ? 'Ратуша врага разрушена. Деревня свободна.'
        : 'Ваша ратуша разрушена. Деревня пала.';
    }
    if (el.result) el.result.classList.remove('hidden');
  }

  /* ------------------------------- начало ------------------------------ */

  /* Новая партия: герб острова, имя, счётчики, список жителей. */
  function onStart(ev) {
    var w = ev.world;
    if (netLostShown) hideNetLost();
    // Новая партия — чистый верх экрана: всплывашка прошлой игры не должна
    // висеть над новым островом (в сети их и не будет — см. `toast`).
    if (el.toasts) el.toasts.innerHTML = '';
    el.island.textContent = '«' + w.seed + '»';
    /* Размер показывается тот, который игрок выбрал в меню, — домен острова
       (islandSize). Полная ширина мира больше: движок насыпает вокруг острова
       полосу моря, чтобы берег не обрывался по краю полотна. Игрок моря не
       выбирал, и в табличке ему не место. */
    el.dims.textContent = w.islandSize + ' × ' + w.islandSize + ' клеток';

    var marks = [];
    if (ev.home) {
      var fp = global.Buildings.footprint(ev.home.rot);
      marks.push({ x: ev.home.x + fp.w / 2, y: ev.home.y + fp.h / 2, color: '#fff2c4' });
    }
    global.Play.paintThumbnail(el.crest, w, { marks: marks });

    // Строка клетки, табличка выбранного дома и панель найма принадлежат
    // ПРОШЛОЙ партии: новая карта — новая клетка под курсором, другой выбор и
    // другая деревня. Полоса правки — тем более: постройки прошлого мира на
    // новой карте нет.
    onHover(null);
    onSelect(null);
    onEdit(null);
    onBuild(null);
    closeDrawer();
    closeBuildMenu();
    closeSquad();
    hideResult();
    setSpectator(false);
    squad.counts = {};
    squad.sig = '';

    // Жители новые: строки собираются заново, счёт начинается с нуля.
    rows = [];
    listSig = '';
    lastLogs = -1;
    buildSig = '';
    placeSig = '';

    /* Журнал прошлой партии — прошлый мир: его события к новому острову не
       относятся. Метка угрозы тоже снимается. */
    evLog.lastId = 0;
    evLog.items = [];
    evLog.threat = null;
    if (el.threatGo) el.threatGo.classList.add('hidden');
    paintEventLog();
    paintSimBadge(global.Play.state);

    hintT = 0;
    el.hints.classList.remove('faded');
    $('btnFollow').classList.remove('active');
    closePause();
    // Обзор — сразу: ключ «что изменилось» у нового острова может совпасть со
    // старым (тот же размер, та же камера), а показать надо новый.
    drawMinimap(true);
    setNetPing(0, global.Play.state);
  }

  /* ------------------------------- кадр -------------------------------- */

  function tick(dt) {
    if (el.hud.classList.contains('hidden')) return;
    var st = global.Play.state;
    if (!st.world) return;

    // Подсказки: прожили своё — уехали.
    if (!paused && hintT < HINTS_LIFE) {
      hintT += dt;
      if (hintT >= HINTS_LIFE) el.hints.classList.add('faded');
    }

    stateAcc += dt;
    if (stateAcc >= REFRESH) {
      stateAcc = 0;
      paintLogs(st);
      refreshEvents(st);
      paintSimBadge(st);
      paintVillagers(st);
      paintGrowth(st);
      fillHire();
      if (squad.open) refreshSquad();
      if (buildOpen) refreshBuildMenu();
      // Доска «Меню» показывает живые числа: время за ней идёт, поэтому
      // брёвна, срубленное и часы партии обязаны меняться.
      if (paused) {
        $('pauseLogs').textContent = logsOf(st);
        $('pauseFelled').textContent = st.felled;
        $('pauseTime').textContent = global.Play.timeText();
      }
    }

    drawMinimap();
  }

  /* Население и рост своей деревни словами: «население 3 / 4 · заселение
     через 12 с», а если роста нет — почему (один житель, нет места, двери
     заняты, город выбыл). Считает движок (Play.birthInfo → Session.
     birthStatus); HUD только повторяет — своей арифметики у панели нет. */
  function paintGrowth(st) {
    var info = global.Play && global.Play.birthInfo ? global.Play.birthInfo() : null;
    if (!el.growthNote) return;
    var note = '—';
    if (info) {
      if (info.alive === false) note = 'деревня выбыла из партии';
      else {
        var head = 'население ' + (info.population || 0) + ' / ' + (info.capacity || 0);
        var tail = '';
        if (info.reason) tail = info.reason;
        else if (typeof info.next === 'number') {
          var left = Math.max(0, Math.ceil(info.next - (st.seconds || 0)));
          tail = left > 0 ? 'заселение через ' + left + ' с' : 'заселение вот-вот';
        }
        note = head + (tail ? ' · ' + tail : '');
        if (typeof info.retryIn === 'number' && info.retryIn > 0 && !info.reason) {
          note += ' · повтор через ' + Math.ceil(info.retryIn) + ' с';
        }
      }
      if (el.villagerCount) {
        el.villagerCount.textContent = (info.population || 0) + ' / ' +
          (info.capacity || 0) + ' чел.';
      }
    }
    if (el.growthNote.textContent !== note) {
      el.growthNote.textContent = note;
      el.growthNote.classList.toggle('bad', !!(info && (info.reason || info.alive === false)));
    }
  }

  /* ------------------------------ счётчики ------------------------------ */

  /* Брёвна деревни. Число берётся из мира целиком (world.village.logs): игра
     его не считает — она его показывает, а второй счётчик разошёлся бы с
     первым на первой же правке правил сдачи. */
  function logsOf(st) {
    var w = st && st.world;
    var v = w && w.towns && w.towns[st.playerOwner] ? w.towns[st.playerOwner] : (w && w.village);
    return v && typeof v.logs === 'number' ? v.logs : 0;
  }

  /* Слово при числе: 1 бревно, 2 бревна, 5 брёвен. Считается, а не пишется
     рядом с цифрой: числа тут растут четвёрками, и «4 брёвен» читалось бы
     ошибкой. */
  function logWord(n) {
    var t = Math.abs(n) % 100;
    if (t >= 11 && t <= 14) return 'брёвен';
    var d = t % 10;
    if (d === 1) return 'бревно';
    if (d >= 2 && d <= 4) return 'бревна';
    return 'брёвен';
  }

  function paintLogs(st) {
    var logs = logsOf(st);
    if (logs === lastLogs) return;
    var grew = lastLogs >= 0 && logs > lastLogs;
    var spent = lastLogs >= 0 && logs < lastLogs;
    lastLogs = logs;
    el.logs.textContent = logs;
    el.logsWord.textContent = logWord(logs);
    // Счёт подпрыгивает: иначе на краю экрана смену цифры не заметишь.
    if (grew) {
      el.logs.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.55)' }, { transform: 'scale(1)' }],
        { duration: 420, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    }
    // Трата — наоборот: дощечка коротко вспыхивает, чтобы покупка была видна
    // не только новой постройкой, но и счётом.
    if (spent && el.resBar) {
      el.resBar.classList.remove('spend');
      void el.resBar.offsetWidth;          // перезапуск анимации
      el.resBar.classList.add('spend');
      global.clearTimeout(spendTimer);
      spendTimer = global.setTimeout(function () { el.resBar.classList.remove('spend'); }, 420);
    }
  }

  /* ---------------------- список жителей деревни ------------------------ *
   * Все жители деревни строками: номер, живой портрет и занятие словами.
   * Строки собираются по списку партии (Play.state.villagers), а не по
   * разметке: сколько жителей — знает мир, а не страница. */

  function villagerNo(v, i) {
    return (v && typeof v.id === 'number') ? v.id : (i + 1);
  }

  /* Как зовут жителя — словами движка (Session.villagerName). Собирать это имя
     самим нельзя: оно одно на всю игру — в табличке, в панели, во всплывашке и
     в приёмке, — и разойтись ему негде. Запасной путь оставлен старому
     движку, где имени ещё нет. */
  function villagerLabel(v, i) {
    var S = global.Session;
    if (S && typeof S.villagerName === 'function') {
      var name = S.villagerName(v);
      if (name) return name;
    }
    return 'Житель №' + villagerNo(v, i);
  }

  function doing(v) {
    var S = global.Session;
    if (!S || typeof S.villagerDoing !== 'function') return '';
    var chop = global.Villagers ? global.Villagers.CHOP_TIME : 5;
    return S.villagerDoing(v, chop);
  }

  /* Прописка словами: дом или «бездомный». Дом — постройка, а не флаг, и
     название у неё своё (Buildings.TYPES), поэтому подпись собирается здесь,
     а не хранится в жителе. */
  function homeText(v) {
    return (v && v.home) ? 'числится в доме' : 'бездомный';
  }

  function listKey(list) {
    var parts = [];
    for (var i = 0; i < list.length; i++) {
      parts.push(villagerNo(list[i], i) + (list[i].home ? 'h' : '-'));
    }
    return parts.join('|');
  }

  function paintVillagers(st) {
    /* В «против деревни» в списке только свои: чужие жители — не деревня
       игрока, и их имена в панели сбивали бы с толку. */
    var me = global.Play.state.playerOwner || 0;
    var list = (st.villagers || []).filter(function (v) {
      return v && (v.owner === undefined ? 0 : v.owner) === me;
    });
    var key = listKey(list);
    if (key !== listSig) { rebuildRows(list); listSig = key; }
    for (var i = 0; i < list.length && i < rows.length; i++) {
      var v = list[i], row = rows[i];
      var text = homeText(v) + ' · ' + doing(v);
      if (row.doing.textContent !== text) row.doing.textContent = text;
      paintFace(row.face, v, row);
    }
  }

  function rebuildRows(list) {
    if (!el.villagerList) return;
    var scroll = el.villagerList.scrollTop;
    el.villagerList.innerHTML = '';
    rows = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      var li = document.createElement('li');
      li.className = 'villager-row';
      li.dataset.vid = villagerNo(v, i);

      var wrap = document.createElement('span');
      wrap.className = 'face-wrap';
      var face = document.createElement('canvas');
      // Атрибуты — буфер, размер на экране задаёт CSS (hud.css: .face-wrap).
      face.width = 30;
      face.height = 38;
      wrap.appendChild(face);

      var who = document.createElement('span');
      who.className = 'villager-who';
      var name = document.createElement('b');
      name.textContent = villagerLabel(v, i);
      var line = document.createElement('i');
      line.textContent = '…';
      who.appendChild(name);
      who.appendChild(line);

      li.appendChild(wrap);
      li.appendChild(who);
      el.villagerList.appendChild(li);
      rows.push({ li: li, doing: line, face: face, key: '', set: null });
    }
    el.villagerList.scrollTop = scroll;
    if (el.villagerCount) el.villagerCount.textContent = list.length + ' чел.';
    /* Пересборка снимает подсветку — возвращаем её сразу: выбранного жителя
       выбирают на карте, а смотрят в панели (и в панели найма тоже). */
    onFocus({ villager: global.Play.state.focus });
  }

  /* Портрет жителя: тот кадр, который он играет сейчас. Ключ — анимация,
     кадр и поворот: перерисовываем только когда он сменился (в строке это
     одно drawImage на жителя, но строк может стать и десять). */
  function paintFace(canvas, v, row) {
    if (!canvas || !v) return;
    var renderer = global.Play.renderer();
    var set = renderer && (renderer.villagerSet ? renderer.villagerSet(v) : renderer.villagerSprites);
    if (!set) return;
    var n = Math.max(1, global.Hero.frameCount(set, v.anim));
    var frame = Math.floor(v.phase * n) % n;
    /* Атлас входит в ключ: житель стал воином — сменился атлас, и портрет
       обязан перерисоваться, даже если кадр и поворот совпали. */
    var key = (row.set === set ? '' : 's:') + v.anim + ':' + frame + ':' + Math.round(v.rot);
    row.set = set;
    if (key === row.key) return;
    row.key = key;

    var spr = global.Villagers.sprite(set, v);
    if (!spr) return;

    var dpr = global.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 30, cssH = canvas.clientHeight || 38;
    var w = Math.max(1, Math.round(cssW * dpr));
    var h = Math.max(1, Math.round(cssH * dpr));
    /* Размер буфера ставится, только если он ДЕЙСТВИТЕЛЬНО другой. Запись в
       width/height пересоздаёт буфер отрисовки, а портрет перерисовывается на
       каждый кадр анимации жителя — десять раз в секунду. Десять пересозданий
       канваса в секунду не стоят ничего по отдельности и заметно дорого
       вместе: это не рисование, а выделение памяти под картинку. */
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    var g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    var k = Math.min(canvas.width / spr.sw, canvas.height / spr.sh);
    var dw = spr.sw * k, dh = spr.sh * k;
    // Ступни ставятся на «землю» портрета (74 % высоты — там начинается
    // трава), а не к нижнему краю кадра: под ступнями в спрайте пустое место
    // под тень, и человек висел бы в воздухе.
    var feet = canvas.height * 0.74;
    g.imageSmoothingEnabled = true;
    g.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh,
      (canvas.width - dw) / 2, feet - dh * (spr.ay || 0.81), dw, dh);
  }

  /* Выбранный житель: тот, к кому ведут клавиши H и C. Выбирает его мир
     (js/play.js: клик по человеку), а HUD только подсвечивает строку — иначе
     непонятно, о ком речь, когда их трое. */
  function onFocus(ev) {
    var v = ev && ev.villager;
    var vid = v ? String(villagerNo(v, 0)) : '';
    for (var i = 0; i < rows.length; i++) {
      rows[i].li.classList.toggle('focused', !!vid && rows[i].li.dataset.vid === vid);
    }
    /* Панель найма пересобирается после каждого найма и увольнения. Подсветка
       выбранного жителя — не украшение строки: по ней видно, о ком речь, — и
       она обязана пережить пересортировку. */
    for (var j = 0; j < hire.rows.length; j++) {
      hire.rows[j].li.classList.toggle('focused', !!v && hire.rows[j].v === v);
    }
  }

  /* --------------- панель постройки: лагерь и казарма ------------------- *
   *
   * Панель ОДНА, но режимов у неё два, и это не косметика:
   *
   *   work  — лагерь лесоруба: наём, увольнение, пакетные кнопки. Правила
   *           живут в Session.canHire/hire/fire/batchInfo (js/session.js).
   *   train — казарма: «Тренировать» по свободному жителю. Найма здесь нет
   *           вовсе: человек идёт учиться, пять секунд тренируется и уходит
   *           воином в военный лагерь. Правила — Session.canTrain/train/
   *           trainingOrder/trainingBatchInfo.
   *
   * HUD не решает ни «кого можно», ни «сколько мест»: он рисует ответ
   * движка, включая причину отказа. Кнопки и строки те же самые — меняются
   * подписи и источник ответа, а не разметка. */

  function isTrainMode(camp) {
    var S = global.Session;
    return !!(S && typeof S.isTrainer === 'function' && S.isTrainer(camp));
  }

  /* Есть ли в движке наём. Старый движок панель не роняет: она честно пишет,
     чего не хватает, — молчаливая «пустая» панель врала бы, что нанять
     некого. */
  function hireApi() {
    var S = global.Session, B = global.Buildings;
    if (!S || !B) return null;
    if (typeof S.canHire !== 'function' || typeof S.hire !== 'function' ||
        typeof S.fire !== 'function' || typeof S.workersOf !== 'function' ||
        typeof S.hireOrder !== 'function' || typeof S.hireGroup !== 'function' ||
        typeof S.batchInfo !== 'function' || typeof S.hireAll !== 'function' ||
        typeof S.fireAll !== 'function' || typeof B.workSlots !== 'function') return null;
    return { S: S, B: B };
  }

  function trainApi() {
    var S = global.Session, B = global.Buildings;
    if (!S || !B) return null;
    if (typeof S.canTrain !== 'function' || typeof S.train !== 'function' ||
        typeof S.traineesOf !== 'function' || typeof S.warriorsOf !== 'function' ||
        typeof S.trainingOrder !== 'function' || typeof S.trainingGroup !== 'function' ||
        typeof S.trainingBatchInfo !== 'function' || typeof S.trainAll !== 'function' ||
        typeof B.trainingSlots !== 'function') return null;
    return { S: S, B: B };
  }

  function panelApi(camp) { return isTrainMode(camp) ? trainApi() : hireApi(); }

  function isWorker(camp, list, v) {
    var S = global.Session;
    if (S && typeof S.worksAt === 'function') return S.worksAt(camp, v);
    return !!(v && v.employer === camp);
  }

  function groupOf(camp, v) {
    var S = global.Session;
    if (isTrainMode(camp)) {
      return (S && S.trainingGroup) ? S.trainingGroup(camp, v) : 'other';
    }
    if (S && S.hireGroup) return S.hireGroup(camp, v);
    if (v && v.employer === camp) return 'here';
    return (v && !v.employer) ? 'free' : 'other';
  }

  function groupLabel(camp, group) {
    var S = global.Session;
    if (isTrainMode(camp)) {
      return (S && S.trainingGroupLabel) ? S.trainingGroupLabel(camp, group) : 'жители';
    }
    if (S && S.hireGroupLabel) return S.hireGroupLabel(camp, group);
    return group === 'here' ? 'работают здесь' : (group === 'free' ? 'свободны' : 'заняты');
  }

  function openHire(camp) {
    if (!el.hirePanel || spectator) return;
    hire.camp = camp;
    hire.mode = isTrainMode(camp) ? 'train' : 'work';
    hire.sig = '';                 // состав строк соберётся заново
    el.hirePanel.classList.remove('hidden');
    fillHire();
  }

  function closeHire() {
    hire.camp = null;
    hire.mode = null;
    hire.rows = [];
    hire.sig = '';
    if (el.hirePanel) el.hirePanel.classList.add('hidden');
  }

  /* ------------------------------- войска ------------------------------- */

  function toggleSquad() { if (squad.open) closeSquad(); else openSquad(); }

  function openSquad() {
    if (!el.squadPanel || spectator) return;
    closeBuildMenu();
    closeHire();
    closeDrawer();               // обе панели живут у левого края
    squad.open = true;
    el.squadPanel.classList.remove('hidden');
    if (el.btnSquad) {
      el.btnSquad.setAttribute('aria-expanded', 'true');
      el.btnSquad.classList.add('active');
    }
    refreshSquad();
  }

  function closeSquad() {
    squad.open = false;
    if (el.squadPanel) el.squadPanel.classList.add('hidden');
    if (el.btnSquad) {
      el.btnSquad.setAttribute('aria-expanded', 'false');
      el.btnSquad.classList.remove('active');
    }
  }

  /* Пересобрать числа выбора. Группы берутся из army.js по постройкам и
     жителям партии; счётчики — «сколько взято от группы», не «сколько всего».
     Новый лагерь появляется со всеми своими воинами выбранными: игрок только
     что их построил, и заставлять его кликать ещё раз незачем. Явный ноль
     (его ставит «Сброс») остаётся нулём — отсутствие ключа и ноль здесь
     разные вещи. */
  function refreshSquad() {
    if (!squad.open || !el.squadList) return;
    var A = global.Army, st = global.Play.state;
    if (!A || !st || !st.world) return;
    /* Чья дружина. В сети у каждого свой номер деревни (playerOwner), и он не
       всегда 0: гость — 1, 2, 3. Здесь стоял жёсткий 0, поэтому у всех гостей
       панель показывала войско хоста, а своё не показывала вовсе — и приказ,
       отправленный по чужому id, хост отклонял (2026-10-24). */
    var me = st.playerOwner || 0;
    var groups = A.groups(st.buildings || [], st.villagers || [], me);
    var counts = {}, i, g, total = 0;
    for (i = 0; i < groups.length; i++) {
      g = groups[i];
      total += g.ids.length;
      var n = squad.counts[g.key];
      if (n === undefined) n = g.ids.length;
      counts[g.key] = Math.max(0, Math.min(g.ids.length, n));
    }
    squad.groups = groups;
    squad.counts = counts;
    squad.ids = A.select(groups, counts).map(function (v) { return v.id; });
    if (global.Play.setSquad) global.Play.setSquad(squad.ids);

    var sig = groups.map(function (g) { return g.key + ':' + g.ids.length; }).join('|');
    if (sig !== squad.sig) { rebuildSquad(); squad.sig = sig; }

    for (i = 0; i < groups.length; i++) {
      g = groups[i];
      var row = el.squadList.querySelector('[data-key="' + g.key + '"]');
      if (!row) continue;
      var num = row.querySelector('.squad-num');
      var tot = row.querySelector('.squad-total');
      if (num) num.textContent = String(counts[g.key] || 0);
      if (tot) {
        tot.textContent = g.cap ? g.ids.length + ' / ' + g.cap : String(g.ids.length);
        tot.title = g.cap
          ? 'в группе ' + g.ids.length + ' воинов, мест ' + g.cap
          : 'воины без места службы';
      }
    }
    if (el.squadSlots) el.squadSlots.textContent = 'воины ' + total;
    if (el.squadNote) {
      el.squadNote.textContent = total
        ? 'Выбрано ' + squad.ids.length + ' из ' + total
        : 'воинов пока нет — обучите жителя в казарме';
    }
    if (el.squadOrder) el.squadOrder.disabled = spectator || !squad.ids.length;
    if (el.squadStop) el.squadStop.disabled = spectator || !total;
  }

  function rebuildSquad() {
    if (!el.squadList) return;
    el.squadList.innerHTML = '';
    squad.groups.forEach(function (g) {
      var li = document.createElement('li');
      li.className = 'squad-row';
      li.setAttribute('data-key', g.key);
      var name = document.createElement('span');
      name.className = 'squad-name';
      name.textContent = g.name;
      var tot = document.createElement('span');
      tot.className = 'squad-total';
      tot.textContent = g.cap ? g.ids.length + ' / ' + g.cap : String(g.ids.length);
      tot.title = g.cap
        ? 'в группе ' + g.ids.length + ' воинов, мест ' + g.cap
        : 'воины без места службы';
      var ctl = document.createElement('span');
      ctl.className = 'squad-controls';
      ctl.innerHTML =
        '<button type="button" class="mini-btn" data-squad="dec" title="взять на одного меньше" aria-label="взять на одного меньше">−</button>' +
        '<b class="squad-num">0</b>' +
        '<button type="button" class="mini-btn" data-squad="inc" title="взять на одного больше" aria-label="взять на одного больше">+</button>' +
        '<button type="button" class="mini-btn squad-half" data-squad="half" title="взять половину этой группы" aria-label="взять половину этой группы">½ группы</button>';
      li.appendChild(name);
      li.appendChild(tot);
      li.appendChild(ctl);
      el.squadList.appendChild(li);
    });
  }


  function fillHire() {
    if (!el.hirePanel || el.hirePanel.classList.contains('hidden')) return;
    var camp = hire.camp;
    if (!camp) { closeHire(); return; }
    var st = global.Play.state;
    var list = st.villagers || [];
    var train = isTrainMode(camp);
    var api = panelApi(camp);

    // Имя постройки — из таблицы типов движка (Buildings.TYPES), а не из
    // разметки: панель открывается по типу, и подпись обязана быть тем же
    // словом, которым постройка называется везде.
    var type = global.Buildings.typeOf(camp);
    var typeInfo = global.Buildings.TYPES[type];
    el.hireTitle.textContent = capitalize(typeInfo ? typeInfo.name : 'лагерь');

    if (!api) {
      el.hireSlots.textContent = train ? 'тренировка недоступна' : 'наём недоступен';
      el.hireNote.textContent = train
        ? 'в этом движке нет тренировки: нужен Session.canTrain'
        : 'в этом движке нет найма: нужен Session.canHire';
      el.hireNote.classList.remove('hidden');
      el.hireList.innerHTML = '';
      hire.rows = [];
      hire.sig = '';
      if (el.hireAll) el.hireAll.disabled = true;
      if (el.fireAll) el.fireAll.disabled = true;
      if (el.hireBatchNote) el.hireBatchNote.classList.add('hidden');
      return;
    }
    el.hireNote.classList.add('hidden');

    var slots, ordered;
    if (train) {
      /* «воины 2 · тренируются 1 / 3»: воины — свои обученные, а не все на
         карте (в «против деревни» список партии общий); в знаменателе только
         места тренировки, потому что обученный воин казарму уже покинул. */
      slots = api.B.trainingSlots(camp);
      var me = camp.owner === undefined ? 0 : camp.owner;
      var trainees = api.S.traineesOf(camp, list);
      var warriors = api.S.warriorsOf(list, me);
      el.hireSlots.textContent = 'воины ' + warriors.length +
        ' · тренируются ' + trainees.length + ' / ' + slots;
      ordered = api.S.trainingOrder(camp, list);
    } else {
      /* «работники 2 / 3»: первое число — из Session.workersOf, второе — из
         Buildings.workSlots. Всё три считает движок. */
      slots = api.B.workSlots(camp);
      var workers = api.S.workersOf(camp, list);
      el.hireSlots.textContent = 'работники ' + workers.length + ' / ' + slots;
      ordered = api.S.hireOrder(camp, list);
    }

    /* Порядок строк — движковый: у лагеря «нанятые здесь → свободные →
       занятые», у казармы «тренируются здесь → свободные → воины → занятые».
       HUD его только рисует. */
    var sig = hireKey(camp, ordered, slots);
    if (sig !== hire.sig) { rebuildHire(camp, ordered); hire.sig = sig; }
    updateHire(camp, ordered);
    updateBatch(camp, list, api, train);
  }

  /* Ключ строк панели: номер жителя, его группа и число мест. Занятие в него
     не входит — оно меняется каждую секунду, а пересобирать строки из-за
     текста незачем: текст обновляется на месте. Смена группы или порядка
     ключ меняет, и строки собираются заново. */
  function hireKey(camp, order, slots) {
    var parts = ['s' + slots, hire.mode || 'work'];
    for (var i = 0; i < order.length; i++) {
      parts.push(villagerNo(order[i], i) + groupOf(camp, order[i]).charAt(0));
    }
    return parts.join('|');
  }

  /* Пересборка строк с сохранением прокрутки: список не должен прыгать в
     начало после найма или увольнения — игрок смотрит на того же жителя. */
  function rebuildHire(camp, order) {
    var scroll = el.hireList.scrollTop;
    el.hireList.innerHTML = '';
    hire.rows = [];
    var last = null;
    for (var i = 0; i < order.length; i++) {
      var v = order[i];
      var g = groupOf(camp, v);
      /* Пустой группы и её заголовка не бывает: заголовок ставится только
         перед первой строкой самой группы. */
      if (g !== last) { addGroupRow(camp, g); last = g; }
      addHireRow(camp, v, i);
    }
    el.hireList.scrollTop = scroll;
    onFocus({ villager: global.Play.state.focus });
  }

  function addGroupRow(camp, group) {
    var li = document.createElement('li');
    li.className = 'hire-group';
    li.dataset.group = group;
    li.textContent = groupLabel(camp, group);
    el.hireList.appendChild(li);
  }

  /* Одна строка панели: имя, прописка с занятием, причина отказа, пометка и
     кнопка. Вынесено в функцию, а не в тело цикла, ради ЗАМЫКАНИЯ: кнопка
     помнит СВОЕГО жителя, и в цикле с `var` все кнопки запомнили бы
     последнего — нажатие на «Тренировать» у первого жителя отправляло бы
     третьего. */
  function addHireRow(camp, v, i) {
    var li = document.createElement('li');
    li.className = 'hire-row';
    li.dataset.vid = villagerNo(v, i);

    var name = document.createElement('b');
    name.className = 'hire-name';
    name.textContent = villagerLabel(v, i);

    var line = document.createElement('i');
    line.className = 'hire-info';
    line.textContent = '…';

    var why = document.createElement('span');
    why.className = 'hire-why hidden';

    var box = document.createElement('span');
    box.className = 'hire-actions';
    var mark = document.createElement('em');
    mark.className = 'hire-mark hidden';
    mark.textContent = '';
    var btn = document.createElement('button');
    btn.className = 'wood-btn hire-btn';
    btn.type = 'button';
    btn.dataset.vid = villagerNo(v, i);
    btn.textContent = '…';
    btn.addEventListener('click', function () { act(v); });
    box.appendChild(mark);
    box.appendChild(btn);

    li.appendChild(name);
    li.appendChild(box);
    li.appendChild(line);
    li.appendChild(why);
    el.hireList.appendChild(li);
    hire.rows.push({ li: li, doing: line, why: why, mark: mark, btn: btn, v: v });
  }

  /* Обновление строк НА МЕСТЕ. Житель берётся у самой строки (row.v), а не из
     списка по индексу: после сортировки строки и данные не должны
     разъезжаться, и кнопка обязана действовать на того, кто в ней показан. */
  function updateHire(camp, order) {
    var row, i;
    if (isTrainMode(camp)) {
      for (i = 0; i < hire.rows.length; i++) updateTrainRow(camp, hire.rows[i], order);
      return;
    }
    var api = hireApi();
    if (!api) return;
    for (i = 0; i < hire.rows.length; i++) {
      row = hire.rows[i];
      var v = row.v;
      var works = isWorker(camp, order, v);
      var verdict = works ? null : api.S.canHire(camp, v, order);
      var can = works || !!(verdict && verdict.ok);

      row.li.classList.toggle('worker', works);
      row.li.classList.toggle('focused', global.Play.state.focus === v);
      row.doing.textContent = homeText(v) + ' · ' + doing(v);
      row.mark.classList.toggle('hidden', !works);
      row.mark.textContent = (api.S.workMark ? api.S.workMark(camp) : 'работает здесь');
      row.btn.textContent = works ? 'Уволить' : 'Нанять';
      row.btn.disabled = !can;

      // Причина — словами движка (Session.canHire), а не своей выдумкой:
      // правила найма живут в одном месте, и объяснение обязано быть тем же.
      var why = (!works && !can && verdict && verdict.reason) ? verdict.reason : '';
      row.why.textContent = why;
      row.why.classList.toggle('hidden', !why);
      row.btn.title = why || (works ? 'Уволить жителя' : 'Нанять в лагерь лесоруба');
    }
  }

  /* Строка казармы. Пока учится — «Тренируется» без нажатия; уже обученный —
     «Воин»; свободный — «Тренировать». Отказы говорит Session.canTrain. */
  function updateTrainRow(camp, row, order) {
    var S = global.Session;
    var v = row.v;
    var group = S.trainingGroup(camp, v);
    var training = group === 'training';
    var warrior = group === 'warrior';
    var verdict = (training || warrior) ? null : S.canTrain(camp, v, order, global.Play.state.buildings);
    var can = !training && !warrior && !!(verdict && verdict.ok);
    var why = (!training && !warrior && !can && verdict && verdict.reason) ? verdict.reason : '';

    row.li.classList.toggle('worker', training || warrior);
    row.li.classList.toggle('focused', global.Play.state.focus === v);
    row.doing.textContent = homeText(v) + ' · ' + doing(v);
    row.mark.classList.toggle('hidden', !(training || warrior));
    row.mark.textContent = training ? 'учится' : 'воин';
    row.btn.textContent = training ? 'Тренируется' : (warrior ? 'Воин' : 'Тренировать');
    row.btn.disabled = !can;
    row.why.textContent = why;
    row.why.classList.toggle('hidden', !why);
    row.btn.title = why || (training
      ? 'Ждёт конца тренировки'
      : (warrior ? 'Уже обучен: он в военном лагере' : 'Отправить жителя учиться в казарму'));
  }

  function campaignList() {
    return (global.Play.state && global.Play.state.villagers) || [];
  }

  function campaignBuildings() {
    return (global.Play.state && global.Play.state.buildings) || [];
  }

  /* Пакетные кнопки. У лагеря — наём/роспуск; у казармы — только «Тренировать
     свободных», потому что «распускать» обученных воинов механика не
     предусматривает. Сколько можно и почему нельзя — отвечает движок. */
  function updateBatch(camp, list, api, train) {
    if (train) {
      var info = api.S.trainingBatchInfo(camp, list, campaignBuildings());
      if (el.hireAll) {
        el.hireAll.textContent = 'Тренировать свободных';
        el.hireAll.disabled = !info.train.ok;
        el.hireAll.setAttribute('aria-disabled', info.train.ok ? 'false' : 'true');
        el.hireAll.title = info.train.ok
          ? 'Заполнить свободные места (до ' + (info.train.count || 0) + ')'
          : (info.train.reason || '');
      }
      if (el.fireAll) {
        el.fireAll.classList.add('hidden');
        el.fireAll.disabled = true;
      }
      if (!el.hireBatchNote) return;
      var notes = [];
      if (!info.train.ok && info.train.reason) notes.push('Тренировать свободных: ' + info.train.reason);
      el.hireBatchNote.textContent = notes.join(' · ');
      el.hireBatchNote.classList.toggle('hidden', !notes.length);
      return;
    }
    if (el.fireAll) el.fireAll.classList.remove('hidden');
    var work = api.S.batchInfo(camp, list);
    setBatchBtn(el.hireAll, work.hire, 'Нанять свободных');
    setBatchBtn(el.fireAll, work.fire, 'Распустить всех');
    if (!el.hireBatchNote) return;
    var notes2 = [];
    /* Состояние работы — словами движка (Session.hireStatus): занято,
       вакансии, идут, нет пути, нет леса. Строку «работники N / M» панель
       берёт оттуда же, поэтому числа не расходятся. */
    var wi = global.Play && global.Play.workInfo ? global.Play.workInfo(camp) : null;
    if (wi) {
      if (wi.text && el.hireSlots) {
        el.hireSlots.textContent = wi.text;
        el.hireSlots.title = wi.reason || '';
      }
      if (wi.status === 'нет леса' || wi.status === 'нет пути') {
        notes2.push(wi.status + ' у ' + (wi.standing || 0) + ' из ' + (wi.workers || 0));
      } else if (wi.status === 'идут' && wi.coming) {
        notes2.push('идут к работе: ' + wi.coming);
      }
    }
    if (!work.hire.ok && work.hire.reason) notes2.push('Нанять свободных: ' + work.hire.reason);
    if (!work.fire.ok && work.fire.reason) notes2.push('Распустить всех: ' + work.fire.reason);
    el.hireBatchNote.textContent = notes2.join(' · ');
    el.hireBatchNote.classList.toggle('hidden', !notes2.length);
  }

  function setBatchBtn(btn, info, text) {
    if (!btn) return;
    btn.textContent = text;
    btn.disabled = !info.ok;
    btn.setAttribute('aria-disabled', info.ok ? 'false' : 'true');
    btn.title = info.ok
      ? (text === 'Нанять свободных'
        ? 'Заполнить свободные места (до ' + (info.count || 0) + ')'
        : 'Распустить всех здешних работников')
      : (info.reason || '');
  }

  /* Одиночное действие: в лагере — наём/увольнение, в казарме — тренировка.
     Считает движок, а игрок видит всплывающее сообщение — и в случае отказа
     тоже. */
  function act(v) {
    var camp = hire.camp;
    if (!camp || !v) return;
    if (spectator) { toast('вы наблюдаете: командовать нельзя'); return; }
    var st = global.Play.state;
    var list = st.villagers || [];
    var who = villagerLabel(v, list.indexOf(v));
    /* В сети команду выполняет хост: клиент только просит. Иначе два клиента
       правили бы разные копии мира. */
    if (st.netRole === 'client' && global.Net) {
      var netType = isTrainMode(camp) ? 'train' : (isWorker(camp, list, v) ? 'fire' : 'hire');
      global.Net.command({ type: netType, campId: camp.id, villagerId: v.id });
      toast(who + (netType === 'train' ? ' отправлен учиться'
        : (netType === 'fire' ? ' больше не работает' : ' нанят')));
      return;
    }
    var res;
    if (isTrainMode(camp)) {
      res = global.Session.train(camp, v, list, st.buildings || []);
      if (res && res.ok) toast(who + ' пошёл тренироваться в казарму', 5000);
      else toast((res && res.reason) || 'Не вышло');
      if (res && res.ok) refreshHireViews();
      return;
    }
    var api = hireApi();
    if (!api) return;
    var works = isWorker(camp, list, v);
    res = works ? api.S.fire(camp, v) : api.S.hire(camp, v, list);
    if (res && res.ok) {
      toast(who + (works ? ' больше не работает в лагере' : ' нанят в лагерь лесоруба'));
      refreshHireViews();
    } else {
      toast((res && res.reason) || 'Не вышло');
    }
  }

  /* Пакетное действие: у лагеря — наём/роспуск, у казармы — «Тренировать
     свободных». Своих правил у HUD нет: ответ целиком у движка. */
  function hireBatch(kind) {
    var camp = hire.camp;
    if (!camp) return;
    if (spectator) { toast('вы наблюдаете: командовать нельзя'); return; }
    var list = campaignList();
    var netState = global.Play.state;
    if (netState.netRole === 'client' && global.Net) {
      var sent = 0;
      /* Только свои: список партии общий, а чужие в панели не показываются и
         командовать ими нельзя — хост всё равно ответил бы отказом. */
      var me = camp.owner === undefined ? 0 : camp.owner;
      list.forEach(function (v) {
        if ((v.owner === undefined ? 0 : v.owner) !== me) return;
        if (isTrainMode(camp)) {
          if (!v.trainee && !v.warrior && !v.employer) {
            global.Net.command({ type: 'train', campId: camp.id, villagerId: v.id });
            sent++;
          }
        } else {
          var working = isWorker(camp, list, v);
          if ((kind === 'hire' && !working && !v.employer) ||
              (kind === 'fire' && working)) {
            global.Net.command({ type: kind === 'hire' ? 'hire' : 'fire',
              campId: camp.id, villagerId: v.id });
            sent++;
          }
        }
      });
      toast((kind === 'hire' ? 'Отправлено: ' : 'Распущено: ') + sent);
      return;
    }
    if (isTrainMode(camp)) {
      if (kind !== 'hire') return;
      var tr = global.Session.trainAll(camp, list, campaignBuildings());
      if (tr && tr.ok) {
        toast('Отправлено на тренировку: ' + tr.trained);
        refreshHireViews();
      } else {
        toast((tr && tr.reason) || 'Не вышло');
      }
      return;
    }
    var api = hireApi();
    if (!api) return;
    var res = kind === 'hire' ? api.S.hireAll(camp, list) : api.S.fireAll(camp, list);
    if (res && res.ok) {
      toast(kind === 'hire' ? 'Нанято ' + res.hired : 'Распущено ' + res.fired);
      refreshHireViews();
    } else {
      toast((res && res.reason) || 'Не вышло');
    }
  }

  /* После найма/увольнения/тренировки список собирается сразу, а не ждёт
     тика: игрок смотрит на него сейчас. Прокрутку и подсветку сохраняет
     rebuildHire. */
  function refreshHireViews() {
    hire.sig = '';
    listSig = '';
    fillHire();
    paintVillagers(global.Play.state);
  }

  /* Новый воин: человек вышел из казармы в броне и пошёл в военный лагерь.
     Это событие мира, а не панели, поэтому о нём говорится всплывашкой. */
  function onWarrior(ev) {
    var v = ev && ev.villager;
    if (!v) return;
    var me = global.Play.state.playerOwner || 0;
    if ((v.owner === undefined ? 0 : v.owner) !== me) return;
    toast(villagerLabel(v, v.id - 1) + ' стал воином и ушёл в военный лагерь');
  }

  /* Первое срубленное дерево — событие, о котором стоит сказать словами;
     дальше счёт растёт молча и живёт в меню. */
  function onFelled(ev) {
    var v = ev && ev.villager;
    var me = global.Play.state.playerOwner || 0;
    if (v && (v.owner === undefined ? 0 : v.owner) !== me) return;
    if (ev.first) toast('Житель срубил первое дерево');
  }

  /* ------------------------- сдача брёвен ------------------------------ *
   * «+4» над лагерем в момент сдачи. Это DOM поверх канваса, а не рисунок на
   * нём: цифра живёт меньше секунды и принадлежит экрану, а не миру. */

  function onDelivery(ev) {
    if (!uiLive()) return;
    var dv = ev && ev.villager;
    var me = global.Play.state.playerOwner || 0;
    if (dv && (dv.owner === undefined ? 0 : dv.owner) !== me) return;
    if (ev.first) toast('Первое бревно в деревне');
    var renderer = global.Play.renderer();
    var view = $('view');
    if (!renderer || !view || !el.hud) return;
    var r = view.getBoundingClientRect();
    var d = document.createElement('div');
    d.className = 'gain';
    d.textContent = '+' + (ev.amount || 0);
    // Над лагерем — то есть над тем местом, где житель сдал брёвна. Чуть выше
    // точки: цифра не должна лежать на самой постройке.
    d.style.left = (r.left + r.width / 2 + renderer.sx(ev.x, ev.y)) + 'px';
    d.style.top = (r.top + r.height / 2 + renderer.sy(ev.x, ev.y) - 14) + 'px';
    el.hud.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, GAIN_LIFE);
  }

  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* Обзор перерисовывается не каждый кадр, а когда меняется то, что на нём
     видно: камера, житель, постройки. Стоящий на месте игрок и рубящий дерево
     житель дают один и тот же кадр обзора — а рисуется там не точка, а вся
     карта острова, растянутая на канвас. Ключ округляет положение до
     четверти клетки: дрожание на полпикселя картинку не меняет, а лишний
     кадр стоит полного блита. */
  var mmKey = '';

  function drawMinimap(force) {
    var renderer = global.Play.renderer();
    if (!mmCtx || !renderer || !renderer.minimap) return;
    var st = global.Play.state;

    /* Версия обзора меняется только при пересборке (состав/место построек),
       а не на каждый снимок. Раньше в ключе стояло число построек и обзор
       перерисовывался на каждое движение камеры и жителей, хотя сам холст
       обзора не менялся. */
    var key = (Math.round(renderer.cam.x * 4) / 4) + ',' + (Math.round(renderer.cam.y * 4) / 4) +
      ',' + (Math.round(renderer.cam.zoom * 4) / 4) + ',' +
      (renderer.minimapVersion || 0) + '|';
    for (var v = 0; v < st.villagers.length; v++) {
      key += (Math.round(st.villagers[v].x * 8) / 8) + ',' + (Math.round(st.villagers[v].y * 8) / 8) + ';';
    }
    /* Метка угрозы живёт в том же холсте, но меняется по времени: без неё в
       ключе обзор не перерисовался бы и метка застыла. Четверть секунды —
       достаточно, чтобы кольцо пульсировало. */
    var th = evLog.threat;
    if (th) key += '|threat:' + th.x + ',' + th.y + ',' + Math.floor((st.seconds || 0) * 4);
    if (!force && key === mmKey) return;
    mmKey = key;

    mmCtx.setTransform(mmDpr, 0, 0, mmDpr, 0, 0);
    mmCtx.clearRect(0, 0, MM, MM);
    mmCtx.drawImage(renderer.minimap, 0, 0, MM, MM);

    // Рамка обзора — в мировых углах видимой области. Порядок именно такой:
    // в изометрии эти четыре точки идут по периметру ромба, а не крест-накрест
    // (иначе рамка рисуется «бабочкой» — двумя перекрещенными треугольниками).
    var box = renderer.viewTiles(0);
    var corners = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]];
    mmCtx.beginPath();
    for (var i = 0; i < 4; i++) {
      var p = renderer.worldToMM(corners[i][0], corners[i][1]);
      if (i === 0) mmCtx.moveTo(p.x, p.y); else mmCtx.lineTo(p.x, p.y);
    }
    mmCtx.closePath();
    mmCtx.strokeStyle = 'rgba(255,255,255,0.85)';
    mmCtx.lineWidth = 1.5;
    mmCtx.stroke();
    mmCtx.globalCompositeOperation = 'destination-over';
    mmCtx.strokeStyle = 'rgba(0,0,0,0.45)';
    mmCtx.lineWidth = 3.5;
    mmCtx.stroke();
    mmCtx.globalCompositeOperation = 'source-over';

    // Дом игрока: на обзоре он один и его стоит помнить.
    for (var b = 0; b < st.buildings.length; b++) {
      var bp = renderer.worldToMM(st.buildings[b].x + 1.5, st.buildings[b].y + 2);
      mmCtx.beginPath();
      mmCtx.rect(bp.x - 2.6, bp.y - 2.6, 5.2, 5.2);
      mmCtx.fillStyle = '#ffe9a8';
      mmCtx.fill();
      mmCtx.lineWidth = 1.2;
      mmCtx.strokeStyle = 'rgba(40,30,6,0.9)';
      mmCtx.stroke();
    }

    drawVillagerDots(renderer, st);
    if (th) drawThreatMark(renderer, th, st);
  }

  /* Точки жителей на обзоре. Движок умеет то же самое (Session.drawVillagers),
     но одинаковым цветом: у генератора найма нет, и «кто работает» там не
     вопрос. В игре это вопрос, и ответ виден на обзоре: занятый (лесоруб,
     ученик казармы или воин) — тёмная зелёная точка, гуляющий — cream.
     Растворённого в казарме на обзоре нет вовсе. */
  function drawVillagerDots(renderer, st) {
    var list = st.villagers || [];
    var V = global.Villagers;
    for (var i = 0; i < list.length; i++) {
      if (V && V.visible && !V.visible(list[i])) continue;
      var hired = !!(list[i].employer || list[i].trainee || list[i].warrior);
      var p = renderer.worldToMM(list[i].x, list[i].y);
      mmCtx.beginPath();
      mmCtx.arc(p.x, p.y, hired ? 2.8 : 2.4, 0, Math.PI * 2);
      mmCtx.fillStyle = hired ? DOT_WORK : DOT_FREE;
      mmCtx.fill();
      mmCtx.lineWidth = 1.2;
      mmCtx.strokeStyle = hired ? DOT_WORK_RING : 'rgba(40,30,6,0.9)';
      mmCtx.stroke();
    }
  }

  /* ------------------- клетка под курсором и выбранная постройка --------- *
   * Считать нечего: и то и другое приходит готовым от мира (play.js шлёт
   * события `hover` и `select`), а здесь только раскладывается по экрану.
   * Живёт это в HUD по той же причине, что и портрет жителя: там, где видно
   * игроку, а не там, где считается. */

  /* Строка клетки. Мышь ушла с карты — строка уходит вместе с ней: она про
     то, на что игрок показывает, а не про последнее, что он видел. */
  function onHover(ev) {
    if (!el.cellBar) return;
    var info = ev && ev.info;
    if (!info) { el.cellBar.classList.add('hidden'); return; }
    el.cellText.textContent = info.label;
    el.cellBar.classList.remove('hidden');
  }

  /* Выбранная постройка: имя, пятно, клетка и её портрет. Портрет — тот кадр
     атласа, который стоит на карте (тот же вариант и поворот): у постройки их
     три на четыре, и подписью «дом» выбор не проверить.

     Лагерь лесоруба — не просто постройка, а рабочее место: клик по нему
     открывает панель найма. Открывается и закрывается она ЗДЕСЬ, на событии
     выбора: выбор снимается кликом по пустой земле, клавишей Esc, уходом в
     меню и паузой — и панель уходит вместе с ним, а не живёт своей жизнью. */
  function onSelect(ev) {
    if (!el.buildPlaque) return;
    var info = ev && ev.info;
    if (!info) { el.buildPlaque.classList.add('hidden'); closeHire(); return; }
    el.buildName.textContent = info.name;
    el.buildSize.textContent = 'пятно ' + info.w + ' × ' + info.h + ' клетки';
    el.buildCell.textContent = 'клетка ' + info.x + ', ' + info.y;
    // Сначала показать, потом рисовать: у скрытого канваса clientWidth равен
    // нулю, и портрет строился бы в буфер по запасному размеру — на экране с
    // плотностью 2 он был бы мыльным.
    el.buildPlaque.classList.remove('hidden');
    paintBuilding(info.building);
    /* Панель открывается на рабочее место и на казарму: у лагеря в ней наём,
       у казармы — тренировка. Тип решает движок, а не список в HUD. */
    var S = global.Session;
    var mine = (info.building.owner === undefined ? 0 : info.building.owner) ===
      (global.Play.state.playerOwner || 0);
    /* Кнопка «Править» — третий вход в правку, кроме удержания и двойного
       клика: тот, кто про жест не знает, всё равно найдёт её здесь. Правила не
       дублируются — ответ даёт движок (Play.editSelected → Buildings.EDIT), а
       причина отказа уходит и в подпись кнопки, и всплывашкой. */
    if (el.btnEdit) {
      var editWhy = global.Play.editReject ? global.Play.editReject(info.building) : '';
      el.btnEdit.classList.toggle('hidden', !mine);
      el.btnEdit.setAttribute('aria-disabled', editWhy ? 'true' : 'false');
      el.btnEdit.title = editWhy || 'Править: подвинуть, повернуть, снести';
    }
    var workplace = mine && S && (typeof S.isWorkplace === 'function'
      ? S.isWorkplace(info.building)
      : info.type === 'lumbercamp');
    var trainer = mine && S && typeof S.isTrainer === 'function' && S.isTrainer(info.building);
    if (workplace || trainer) openHire(info.building); else closeHire();
  }
  function paintBuilding(b) {
    if (!el.buildFace || !b) return;
    var renderer = global.Play.renderer();
    var B = global.Buildings;
    var type = B.typeOf(b);
    var set = renderer && renderer.spritesFor(type);
    var spr = set && B.sprite(set, b.variant, b.rot);
    // Крыша у постройки свешивается за пятно, и кадру нужен запас: вписываем
    // весь кадр, а прозрачные поля атласа добираем крупностью портрета.
    paintWholeSprite(el.buildFace, spr, 0.94, previewZoom(type));
  }

  /* ---------------------------- правка постройки ------------------------- *
   * Полоса правки ничего не решает. Что можно делать с постройкой, решает
   * движок (Buildings.EDIT → canEdit), годится ли место — Buildings.checkAt, и
   * приходит это готовым в событии `edit` (js/play.js). Здесь — разложить
   * ответ по кнопкам: приглушить то, чего нельзя, и написать причину словами
   * движка. Причина одна и та же уходит и в подпись кнопки (title), и во
   * всплывашку: переписывать её тут нельзя — тогда одно правило звучало бы
   * по-разному в зависимости от того, куда игрок смотрит. */

  var editSig = '';      // последняя строка состояния: DOM трогаем по изменению

  /* Команда движку. Отказ без своей кнопки (например «сюда нельзя: вода»)
     говорится всплывашкой — той же фразой, что вернул движок. */
  function editAct(action) {
    var P = global.Play;
    if (!P || typeof P.editAction !== 'function') return null;
    var res = P.editAction(action);
    if (res && !res.ok && res.reason) toast(res.reason);
    return res;
  }

  /* Строка о том, что сейчас с постройкой: ведут её или она стоит, есть ли
     правки и что мешает применить. Всё — из ответа движка. Причина отказа
     показывается и во время ведения: место под курсором может быть и водой, и
     занятым пятном, и молчать об этом нельзя — игрок ведёт дом именно туда. */
  function editStateText(info) {
    var head;
    if (info.valid) {
      head = info.mode === 'move' ? 'ведите мышью · клик — поставить'
        : (info.changed ? 'место годится · есть правки' : 'место годится · изменений нет');
    } else {
      head = 'нельзя применить: ' + info.reason;
      if (info.mode === 'move') head = 'ведите мышью · ' + head;
    }
    // Растительность рядом — предупреждение, а не запрет: оно и стоит отдельно.
    return info.yardWarn ? head + ' · ' + info.yardWarn : head;
  }

  function onEdit(ev) {
    if (!el.editBar) return;
    var info = ev && ev.info;
    if (!info) {
      el.editBar.classList.add('hidden');
      editSig = '';
      return;
    }
    el.editName.textContent = info.name;
    var line = info.x + ', ' + info.y + ' · ' + info.rot + '° · ' + editStateText(info);
    if (line !== editSig) { editSig = line; el.editState.textContent = line; }

    setEditBtn('editMove', info.canMove,
      info.canMove ? 'Двигать постройку' : info.reason, info.mode === 'move');
    setEditBtn('editRotate', info.canRotate,
      info.canRotate ? 'Повернуть на 90°' : info.reason, false);
    /* У ратуши причина своя — «ратушу снести нельзя», — и она же стоит в
       подписи кнопки. Кнопка при этом остаётся нажимаемой: нажатие скажет
       причину всплывашкой, а выключенная кнопка молчит. */
    setEditBtn('editDelete', info.canRemove,
      info.canRemove ? 'Снести постройку' : info.removeReason, false);
    // «Применить»: пока место не годится, нажатие объясняет, что именно не так.
    setEditBtn('editApply', info.valid, info.valid ? 'Применить правку' : info.reason, false);
    setEditBtn('editCancel', true, 'Вернуть как было', false);

    var warn = info.yardWarn || '';
    el.editNote.textContent = warn;
    el.editNote.classList.toggle('hidden', !warn);
    el.editBar.classList.remove('hidden');
  }

  /* Запрещённая кнопка не глохнет молча: она помечена aria-disabled (вид
     приглушён, css) и объясняет причину при нажатии. */
  function setEditBtn(id, can, title, active) {
    var btn = $(id);
    if (!btn) return;
    btn.setAttribute('aria-disabled', can ? 'false' : 'true');
    btn.classList.toggle('active', !!active);
    btn.title = title || '';
  }

  /* Действие отклонено без кнопки: удержание по другому зданию, тычок мимо при
     несохранённых правках. Фраза приходит готовой от мира. */
  function onEditNote(ev) {
    if (ev && ev.text) toast(ev.text);
  }

  /* --------------------------- журнал событий -------------------------- *
   * Что случилось с деревней и почему встала экономика. Читаем
   * Play.playerEvents(n) — это Events.recent(world, n, playerOwner), то есть
   * события ТОЛЬКО своего владельца; в сети хост кладёт в снимок не события,
   * а клиент выводит свои attack/destroy из дельт (js/play.js) и пишет их в
   * тот же журнал. Поэтому HUD не знает, одиночная это игра или сеть.
   *
   * Никаких всплывашек: в сети их нет вовсе (правило 2026-10-24), а здесь —
   * плашка со списком, которая копится молча. */

  function touchUI() {
    var P = global.Play;
    return !!(P && typeof P.touchPreferred === 'function' && P.touchPreferred());
  }

  function fmtTime(t) {
    var n = Math.max(0, Math.floor(t || 0));
    var m = Math.floor(n / 60);
    n = n % 60;
    return m + ':' + (n < 10 ? '0' : '') + n;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;';
    });
  }

  /* «3 здания», «5 зданий»: число в подписи кнопки читается как речь. */
  function buildingWord(n) {
    var t = Math.abs(n) % 100, d = t % 10;
    if (t >= 11 && t <= 14) return 'зданий';
    if (d === 1) return 'здание';
    if (d >= 2 && d <= 4) return 'здания';
    return 'зданий';
  }

  function setEventLogOpen(on) {
    evLog.open = !!on;
    if (!el.eventLog) return;
    el.eventLog.classList.toggle('open', evLog.open);
    if (el.eventLogToggle) {
      el.eventLogToggle.setAttribute('aria-expanded', evLog.open ? 'true' : 'false');
    }
  }

  /* Один проход по журналу на кадр HUD (0.12 с). DOM трогается, только когда
     пришло новое событие: Events.sinceId считает то же, но здесь достаточно
     lastId — он растёт вместе с id. Метка угрозы пересчитывается ВСЕГДА: она
     гаснет по времени, даже если новых событий нет. */
  function refreshEvents(st) {
    if (!el.eventLog || !global.Play || !global.Events) return;
    var list = global.Play.playerEvents ? (global.Play.playerEvents(12) || []) : [];
    var sec = (st && st.seconds) || 0;
    var threat = null;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || e.kind !== 'attack') continue;
      if (typeof e.x !== 'number' || typeof e.y !== 'number') continue;
      if (sec - (e.t || 0) <= THREAT_LIFE) threat = e;
    }
    evLog.threat = threat;
    if (el.threatGo) el.threatGo.classList.toggle('hidden', !threat);
    var last = list.length ? (list[list.length - 1].id || 0) : 0;
    if (last === evLog.lastId) return;
    evLog.lastId = last;
    evLog.items = list.slice(-8).reverse();   // новые сверху
    paintEventLog(st);
  }

  function paintEventLog() {
    if (!el.eventLog) return;
    var items = evLog.items;
    var top = items[0];
    el.eventLog.classList.toggle('empty', !top);
    el.eventLog.classList.toggle('open', !!evLog.open);
    if (el.eventLogToggle) {
      el.eventLogToggle.setAttribute('aria-expanded', evLog.open ? 'true' : 'false');
    }
    if (!top) {
      if (el.eventLogIcon) el.eventLogIcon.textContent = '•';
      if (el.eventLogLast) el.eventLogLast.textContent = 'событий пока нет';
      if (el.eventLogCount) el.eventLogCount.classList.add('hidden');
      if (el.eventLogList) el.eventLogList.innerHTML = '';
      return;
    }
    var kind = EV_KINDS[top.kind] || { ico: '•', cls: '' };
    if (el.eventLogIcon) el.eventLogIcon.textContent = kind.ico;
    if (el.eventLogLast) {
      el.eventLogLast.textContent = (top.text || top.kind || '') + ' · ' + fmtTime(top.t);
    }
    if (el.eventLogCount) {
      if (top.count > 1) {
        el.eventLogCount.textContent = '×' + top.count;
        el.eventLogCount.classList.remove('hidden');
      } else {
        el.eventLogCount.classList.add('hidden');
      }
    }
    if (!el.eventLogList) return;
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var e = items[i];
      var k = EV_KINDS[e.kind] || { ico: '•', cls: '' };
      var hasGo = typeof e.x === 'number' && typeof e.y === 'number';
      html += '<li class="event-row ' + k.cls + (hasGo ? ' has-go' : '') + '"' +
        ' data-id="' + (e.id || 0) + '"' +
        (hasGo ? ' data-x="' + e.x + '" data-y="' + e.y + '"' : '') + '>' +
        '<span class="ev-ico" aria-hidden="true">' + k.ico + '</span>' +
        '<span class="ev-time">' + fmtTime(e.t) + '</span>' +
        '<span class="ev-text">' + escapeHtml(e.text || e.kind) + '</span>' +
        (e.count > 1 ? '<span class="ev-count">×' + e.count + '</span>' : '<span></span>') +
        (hasGo
          ? '<button class="ev-go" type="button" title="К месту атаки" aria-label="К месту атаки">→</button>'
          : '<span></span>') +
        '</li>';
    }
    el.eventLogList.innerHTML = html;
  }

  /* «Мир пропустил N с» — постоянная строка, а не тост: boot.js выбрасывает
     долг больше MAX_DEBT и пишет его в Play.state.simDropped. Молчаливое
     ускорение мира запрещено контрактом §1 — отброшенное время должно быть
     видно, пока игрок не начнёт новую партию. */
  function paintSimBadge(st) {
    if (!el.simBadge) return;
    var lost = (st && st.simDropped) || 0;
    if (!(lost > 0.05)) {
      el.simBadge.classList.add('hidden');
      return;
    }
    el.simBadge.classList.remove('hidden');
    el.simBadge.textContent = 'мир пропустил ' +
      (lost >= 10 ? String(Math.round(lost)) : String(Math.round(lost * 10) / 10).replace('.', ',')) +
      ' с';
    el.simBadge.title = 'Браузер не успел догнать простой: ' + Math.round(lost) +
      ' с мира отброшено (boot.js, MAX_DEBT). Игра не ускорялась — время потеряно.';
  }

  /* Метка угрозы на обзоре: ромб и расходящееся кольцо в точке последнего
     attack. Живёт THREAT_LIFE секунд и гаснет сама; в журнале событие
     остаётся. */
  function drawThreatMark(renderer, ev, st) {
    var p = renderer.worldToMM(ev.x + 0.5, ev.y + 0.5);
    var sec = (st && st.seconds) || 0;
    var age = Math.max(0, Math.min(THREAT_LIFE, sec - (ev.t || 0)));
    var pulse = 0.5 + 0.5 * Math.sin(sec * 6.283);
    mmCtx.save();
    mmCtx.beginPath();
    mmCtx.arc(p.x, p.y, 6.5 + 3.5 * pulse, 0, Math.PI * 2);
    mmCtx.strokeStyle = 'rgba(224,90,78,' + (0.85 - 0.5 * (age / THREAT_LIFE)) + ')';
    mmCtx.lineWidth = 2;
    mmCtx.stroke();
    mmCtx.beginPath();
    mmCtx.moveTo(p.x, p.y - 5);
    mmCtx.lineTo(p.x + 5, p.y);
    mmCtx.lineTo(p.x, p.y + 5);
    mmCtx.lineTo(p.x - 5, p.y);
    mmCtx.closePath();
    mmCtx.fillStyle = 'rgba(224,90,78,0.95)';
    mmCtx.fill();
    mmCtx.strokeStyle = 'rgba(255,246,216,0.9)';
    mmCtx.lineWidth = 1;
    mmCtx.stroke();
    mmCtx.restore();
  }

  /* Свернуть/развернуть обзор. Свёрнутый — квадрат 44 x 44 с кнопкой «обзор»;
     на время постановки он сворачивается сам (CSS #hud.placing). */
  function setMmFolded(on) {
    mmFolded = !!on;
    if (el.minimapFrame) el.minimapFrame.classList.toggle('folded', mmFolded);
    if (el.btnMmFold) {
      el.btnMmFold.setAttribute('aria-expanded', mmFolded ? 'false' : 'true');
      el.btnMmFold.textContent = mmFolded ? '▣' : 'обзор';
      el.btnMmFold.title = mmFolded ? 'Развернуть обзор' : 'Свернуть обзор';
      el.btnMmFold.setAttribute('aria-label', mmFolded ? 'Развернуть обзор' : 'Свернуть обзор');
    }
  }

  /* Экономия: 30 кадров/с (Play.setFpsCap — троттлинг кадра, не мира),
     DPR до 1.5 и реже волны. Это единственная настройка качества, которую
     видит игрок; на компьютере она тоже работает, но не включается сама. */
  function toggleEconomy() {
    var P = global.Play;
    var r = P && P.renderer ? P.renderer() : null;
    economy = !economy;
    var cap = economy ? 1.5 : (touchUI() ? 2 : 3);
    if (r && r.setQuality) r.setQuality(economy ? 0.6 : 1, cap);
    if (P && P.setFpsCap) P.setFpsCap(economy ? 30 : 0);
    if (el.btnEconomy) {
      el.btnEconomy.classList.toggle('active', economy);
      el.btnEconomy.setAttribute('aria-pressed', economy ? 'true' : 'false');
      el.btnEconomy.title = economy
        ? 'Обычная чёткость и 60 кадров/с'
        : 'Экономия: 30 кадров/с и мельче картинка — для телефона';
    }
  }

  /* ------------------------------ сообщения ---------------------------- */

  /* Сетевая партия говорит тихо (правило заказчика 2026-10-24): вчетвером
     лента всплывашек перекрывала верх карты, а вести о связи мигали на
     каждом моргании сети. Состояние связи остаётся в бейдже «хост / мс / нет
     связи» (`setNetPing`), а мир — в своих счётчиках и подписях кнопок.
     Одиночная игра и «против деревни» всплывашками говорят как раньше. */
  function netSilent() {
    var st = global.Play && global.Play.state;
    return !!(st && st.netRole);
  }

  function toast(text, ms) {
    if (netSilent()) return;
    // Мир в главном меню и за доской «Меню» живёт, но всплывашки его событий
    // принадлежат партии, а не чужому экрану.
    if (!el.toasts || !uiLive()) return;
    var d = document.createElement('div');
    d.className = 'toast';
    d.textContent = text;
    el.toasts.appendChild(d);
    setTimeout(function () {
      d.classList.add('out');
      setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 320);
    }, ms || 2600);
  }

  global.Hud = {
    init: init,
    show: show,
    hide: hide,
    tick: tick,
    drawMinimap: drawMinimap,
    toast: toast,
    setNetPing: setNetPing,
    setSpectator: setSpectator,
    showNetLost: showNetLost,
    hideNetLost: hideNetLost,
    isNetLostShown: isNetLostShown,
    onStart: onStart,
    onFelled: onFelled,
    onWarrior: onWarrior,
    onDelivery: onDelivery,
    onFocus: onFocus,
    onHover: onHover,
    onSelect: onSelect,
    onEdit: onEdit,
    onEditNote: onEditNote,
    onBuild: onBuild,
    onBuilt: onBuilt,
    openPause: openPause,
    closePause: closePause,
    isPaused: isPaused,
    /* Панель сведений и меню построек открываются и снаружи — приёмке это
       нужно, чтобы не гонять мышь по кнопкам, а игроку хватает самих кнопок. */
    openDrawer: function () { setDrawer(true); },
    closeDrawer: closeDrawer,
    isDrawerOpen: function () { return drawerOpen; },
    openBuildMenu: openBuildMenu,
    closeBuildMenu: closeBuildMenu,
    isBuildMenuOpen: function () { return buildOpen; },
    isSquadOpen: function () { return squad.open; },
    toggleSquad: toggleSquad,
    closeSquad: closeSquad,
    onDefeat: onDefeat,
    hideResult: hideResult
  };
})(typeof window !== 'undefined' ? window : globalThis);
