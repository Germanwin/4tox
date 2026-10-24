/* play.js — партия: мир, камера, ход времени и ввод по карте.

   Это игра вокруг движка: движок (генерация, отрисовка, постройки, житель)
   живёт в `mapgen2/js/` и общий с генератором карт, а здесь — то, чем игра
   от него отличается: заставка на живом острове, подлёт камеры при начале
   партии, следование за жителем и доска «Меню» (не пауза: мир за ней идёт).

   Чего здесь НЕТ и не должно быть: РАССТАНОВКИ построек. Новых домов игрок
   не ставит — деревня приходит из js/session.js, а умение ставить ратуши
   осталось инструментом генератора карт (mapgen2/js/app.js: B и клик).

   А вот ПРАВКА уже стоящей постройки — наоборот, здесь: подвинуть, повернуть,
   снести. Разница не в словах: у расстановки место выбирают с нуля (и всё, что
   растёт в пятне, — расчистка), а у правки постройка уже стоит и занимает
   пятно, поэтому правила строже, и живут они в движке
   (mapgen2/js/buildings.js: EDIT, checkAt). Здесь только состояние правки
   (`state.edit`), ввод (удержание ЛКМ) и команды кнопок (`editAction`): игра
   спрашивает движок и раскладывает ответ по экрану, а не считает правила
   заново — иначе кнопка и мир разошлись бы на первой же правке. */

(function (global) {
  'use strict';

  var WG = global.WorldGen;
  var $ = function (id) { return document.getElementById(id); };

  /* Крупность растительности. То же число, что у генератора
     (mapgen2/js/app.js): mul = 1.35 — крона дуба около полутора клеток.
     Мир у игры и у генератора один, и «крупнеет» он одинаково. */
  var SPRITE_MUL = 1.35;

  /* Размер острова на заставке: маленький — он всё равно приглушён меню, а
     генерируется вдвое быстрее большого. */
  var DIORAMA_SIZE = 48;

  /* Сколько летит камера в начале партии: от ратуши крупно — к острову
     целиком. Полторы секунды: успеваешь увидеть, куда тебя принесло. */
  var ARRIVAL = 1.4;

  /* Сеть. 80 мс — 12.5 снимков в секунду: движение жителя уже читается, а
     канал не занимается лишним. Снимок шлётся не по таймеру, а из игрового
     цикла и только после ответа на предыдущий: при медленной связи кадры не
     копятся, а редеют (лучше 5 свежих снимков, чем 30 устаревших).
     NET_SMOOTH — за сколько секунд клиент догоняет позицию из снимка; это
     сглаживание, а не задержка: оно убирает ступеньки между кадрами. */
  var NET_INTERVAL = 0.08;
  /* Если снимок идёт до сервера дольше этого, канал уже забит: редеем до
     NET_INTERVAL_MAX. Так загрузка хоста не превращается в растущий пинг у
     всех — 12 кадров в секунду лучше 25, из которых половина стоит в очереди
     и приходит устаревшей. */
  var NET_INTERVAL_MAX = 0.2;
  var NET_SLOW_MS = 420;
  var NET_FAST_MS = 170;
  var NET_SMOOTH = 0.07;
  /* Сколько клиент молчит, прежде чем сказать «связь с хостом пропала». */
  var NET_SILENCE = 1.8;

  /* Сколько держать ЛКМ по постройке, чтобы взять её в руки.

     Число одно на ОБА жеста, и это намеренно: первый — открыть правку на
     постройке, которой ещё не правили (удержал — режим открылся, здание пошло
     за курсором); второй — взять её снова, когда режим уже открыт и здание
     стоит (удержал — оно опять идёт за курсором). Разводить их незачем: игрок
     в обоих случаях делает одно и то же — держит ЛКМ, — и два числа разошлись
     бы на первой же правке. По нему же срабатывает удержание, о нём говорит
     подсказка, и им измеряет приёмка.

     Полсекунды: секунда читалась как «ничего не происходит» — за это время
     игрок успевал отпустить и решить, что режим не работает. Короче половины
     уже не отличить от клика (клик по постройке её выбирает), поэтому 0.5 —
     нижняя граница, на которой жест ещё намеренный. */
  var EDIT_HOLD_MS = 500;

  /* Меню построек: что можно купить за брёвна. Цена — правило ИГРЫ, а не
     движка: движок не знает про казну деревни, он умеет только сажать
     постройку в пятно. Здесь же и вариант: дом и лагерь — A, казарма — A
     (открытый плац), как просил заказчик. */
  var BUILD_MENU = [
    { type: 'house', variant: 'a', price: 12, note: 'жильё для четверых' },
    { type: 'lumbercamp', variant: 'a', price: 20, note: 'три рабочих места' },
    { type: 'barracks', variant: 'a', price: 28, note: 'открытый плац · тип А' },
    /* Военный лагерь больше не стоит на старте (требование 2026-10-23):
       дружина появляется только после того, как игрок её построит. */
    { type: 'warcamp', variant: 'x', price: 24, note: 'дружина до 20 воинов' }
  ];

  /* Место под купленную постройку — те же правила, что у правки стоящей:
     деревья и камни мешают (расчищать их покупка не разрешает), а куст и
     трава — нет; они сминаются в момент постановки. Двор вокруг берётся у
     движка (Buildings.YARD): тем же числом меряет и правка, и отрисовка. */
  var BUILD_SITE = { clearable: false, requireClear: true, yard: global.Buildings.YARD };

  var view = $('view');
  var renderer = null;

  /* Состояние партии — одно место, где видно, что сейчас происходит. Оболочка
     (js/boot.js, js/hud.js) читает его, а не свои копии: копия «идёт ли игра»
     расходится с настоящей на первом же экране. */
  var state = {
    mode: 'empty',      // empty | diorama | play | paused — paused: открыт экран «Меню»
    running: false,     // идёт ли время: житель ходит, счёт растёт (стоит только до партии и после боя)
    world: null,
    buildings: [],
    villagers: [],
    focus: null,        // выбранный житель: к нему ведут H и C (см. ниже)
    seconds: 0,         // сколько длится партия
    /* Часы попыток заселения: { next, attempts } из движка. Время в них не
       идёт само — его подаёт tick, и только пока state.running. Новая партия
       заводит часы с нуля (start). */
    birth: null,
    felled: 0,          // срублено деревьев (уехало в меню, см. hud.js)
    logs: 0,            // брёвен сдано деревней — то же, что world.village.logs
    deliveries: 0,      // сколько было сдач
    follow: false,      // камера едет за выбранным жителем
    /* Открытая правка постройки или null. Смысл полей — как в контракте
       режима: building — что правим, orig — снимок на момент открытия (для
       «отменить»), mode — 'idle' (стоит) или 'move' (ведут за курсором),
       changed — есть ли несохранённые отличия от orig, valid/reason — можно ли
       применить то, что стоит сейчас (ответ движка, не наш). */
    edit: null,
    /* Постройка, купленная в меню и ведомая курсором, или null. Поля те же,
       что у правки, плюс цена и «годится ли место» (ответ Buildings.canPlace):
       экран показывает этот ответ, а не считает своё. */
    build: null,
    /* Отряд: выбранные id (для колец под ногами), режим приказа и последняя
       точка (для метки). Сами правила выбора и приказа — mapgen2/js/army.js. */
    squadIds: [],
    order: null,        // { ids } — ждём клик по карте
    lastOrder: null,    // { x, y, r, until } — метка последнего приказа
    result: null,       // null | 'win' | 'lose' — итог для ЭТОГО игрока
    /* Партия окончена (остался один город) и кто победил — номер деревни.
       Пока идёт бой, `over` false даже у выбывшего: он наблюдает, мир живёт. */
    over: false, winner: null,
    /* Выбыл по ратуше, но партия продолжается: смотреть можно, строить и
       командовать войском — нет. */
    spectator: false,
    gameMode: 'solo',   // solo | bot | mp — чтобы «Новый остров» не терял режим
    netRole: null,      // null | 'host' | 'client'
    playerOwner: 0,     // чей это клиент: 0 в одиночной, id игрока в сети
    netPlayers: [],
    netCentered: false,
    /* Сеть: seq — номер последнего применённого снимка; netAcc — накопитель
       до следующего; netBusy — кадр уже в пути (новый не шлём, пока старый не
       вернулся); netForce — послать вне очереди после команды. */
    netSeq: 0, netAcc: 0, netBusy: false, netForce: false,
    netEvery: NET_INTERVAL,
    netSilence: 0, netStale: false, netHostGone: false, netLastTick: 0,
    netCmdLast: {}, netRejects: [], netSeqSeen: {},
    /* Умеет ли сервер отдавать команды в ответе снимка. false — старый
       сервер: команды приходят только SSE (запасной путь, см. startNet). */
    netPull: false,
    netPing: 0, netPingAt: 0, netPingBusy: false,
    nextBuildId: 1000   // id новых построек: сквозной, не зависит от списка
  };

  var arrival = null;   // подлёт камеры: {t, dur, from, to}
  var felledSeen = 0;
  var logsSeen = 0;     // world.village.logs на прошлом шаге
  var deliveredSeen = [];   // v.delivered по жителям: по нему видно сдачу
  var firstDelivery = true; // первое бревно партии — о нём стоит сказать словами
  var warriorSeen = {};     // id уже обученных воинов: по нему видно новый чин
  var driftT = 0;       // время заставки: по нему «дышит» камера
  var driftBase = 0;
  var savedZoom = 0;    // зум до ухода на общий план (клавиша V)
  var listeners = [];
  var keys = Object.create(null);
  var drag = null;

  /* ------------------------------ события ------------------------------ */

  function on(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function emit(ev) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](ev); } catch (e) { /* подписчик не роняет партию */ }
    }
  }

  /* Строить/править/командовать можно только пока своя деревня в партии и
     партия не кончена. Наблюдатель смотрит, но не действует. */
  function canCommand() {
    return !state.spectator && !state.over;
  }

  function commandRefusal() {
    if (state.over) return 'партия окончена';
    if (state.spectator) return 'вы наблюдаете: командовать нельзя';
    return '';
  }

  /* Перевести ЭТОГО игрока в наблюдатели. Это не конец партии: у сети мир
     продолжает считаться у хоста, а у выбывшего только гаснут команды. */
  function setSpectator(on) {
    on = !!on;
    if (state.spectator === on) return;
    state.spectator = on;
    if (on) {
      cancelBuild();
      cancelOrder();
      if (state.edit) editClose();
      state.squadIds = [];
    }
    if (global.Hud && global.Hud.setSpectator) global.Hud.setSpectator(on);
    emit({ type: 'spectator', on: on });
  }

  /* Конец партии. Победитель — номер деревни; для каждого клиента итог
     считается по его `playerOwner`, а не по тому, кто первым упал. */
  function finishGame(winner) {
    if (state.over) return;
    state.over = true;
    state.winner = winner === undefined ? null : winner;
    state.result = state.winner !== null && state.winner === state.playerOwner
      ? 'win' : 'lose';
    state.running = false;
    state.netForce = true;
    emit({ type: 'defeat', result: state.result, winner: state.winner, over: true });
  }

  /* Пала ратуша города `owner`. Город выбывает, но партия продолжается,
     пока живы хотя бы два. Раньше здесь было `owner === 0 -> lose,
     owner === 1 -> win` и безусловная остановка мира: в партии на троих
     падение ратуши третьего показывало хосту «Поражение» и морозило всех. */
  function handleTownFallen(owner) {
    var w = state.world;
    if (!w || !w.towns) return;
    var town = null, i;
    for (i = 0; i < w.towns.length; i++) {
      if (w.towns[i] && w.towns[i].owner === owner) { town = w.towns[i]; break; }
    }
    if (!town || town.alive === false) return;
    town.alive = false;
    if (owner === state.playerOwner) setSpectator(true);
    var st = global.Session && global.Session.standing
      ? global.Session.standing(w) : null;
    if (st && st.over) finishGame(st.winner);
    else if (state.netRole === 'host') state.netForce = true;
  }

  /* ------------------------------ запуск ------------------------------ */

  function init() {
    renderer = new global.Render.Renderer(view);
    renderer.showGrid = false;
    /* Подсветка клетки под курсором и выбор постройки — не инструмент
       генератора, а общая возможность движка (render.js: drawHover и
       drawSelection). Обе оболочки их показывают; здесь они просто пусты,
       пока игрок не повёл мышью (см. «клетка под курсором» ниже). */
    renderer.hover = null;
    renderer.selected = null;
    // Размер полотна спрашивается сразу: от него зависят и предел отдаления, и
    // кадр. Без этого зум выходит NaN — движок рисует «ничего» и молчит.
    renderer.resize();
  }

  function ready() { return !!renderer; }

  // Общий кусок начала партии: сгенерировать мир, построить кэш, поставить
  // ратушу игрока. Что делать дальше — решает вызывающий: заставке довольно
  // мира, партии ещё нужен житель.
  function buildWorld(params, mode) {
    var t0 = performance.now();
    var w = WG.generate(params);
    renderer.world = w;
    renderer.buildCache();
    var st = (mode === 'bot' && global.Session.startBot)
      ? global.Session.startBot(w, renderer, { site: global.Session.SITE })
      : global.Session.startHome(w, renderer, global.Session.SITE);
    state.world = w;
    state.buildings = st.buildings;
    return { world: w, home: st.home, buildings: st.buildings, ms: performance.now() - t0, villagers: st.villagers };
  }

  /* Заставка: остров за главным меню. Ратуша на нём есть, жителя нет — он
     выходит, когда партия началась, и это видно. */
  function diorama(seed) {
    state.villagers = [];
    var st = buildWorld({ seed: seed || global.randomSeed(), size: DIORAMA_SIZE });
    renderer.setVillagers([]);
    villageCleanup();
    frameDiorama();
    driftT = 0;
    state.mode = 'diorama';
    state.running = false;
    state.follow = false;
    arrival = null;
    return st.world;
  }

  /* Где на экране стоит остров заставки.

     Композиция меню — две колонки: слева вывеска и доска, справа остров.
     Значит остров надо сдвинуть вправо, а «сдвинуть остров» в изометрии —
     это сдвинуть камеру: экранная координата считается как (x − y − cam.x +
     cam.y), поэтому уводим cam.x назад и cam.y вперёд на одну и ту же
     величину. Сумма cam.x + cam.y при этом не меняется, а от неё зависит
     вертикаль, — остров едет вбок, а не по диагонали.

     Колонку измеряет само меню (Menu.artBox): сколько места оно оставило под
     остров, знает меню, а не движок. Нет колонки (узкое окно) — остров
     встаёт по центру общим планом. */
  function frameDiorama() {
    if (!renderer || !state.world) return;
    var w = state.world, b = w.landBounds;
    renderer.fitIsland();                      // общий план — точка отсчёта

    var box = global.Menu && global.Menu.artBox ? global.Menu.artBox() : null;
    if (!box) { driftBase = renderer.cam.zoom; return; }

    // Габарит острова на экране при общем плане: в изометрии ромб со
    // сторонами (W + H) клеток, то есть шириной (W + H) / 2 и высотой вдвое
    // меньше. От него и считаем, во сколько раз можно приблизиться.
    var spanX = ((b.x1 - b.x0) + (b.y1 - b.y0)) * 0.5;
    var spanY = spanX * 0.5;
    var z0 = renderer.minZoom;
    var k = Math.min((box.width - 30) / (spanX * z0), (box.height - 30) / (spanY * z0), 1);
    renderer.cam.zoom = z0 * k;

    // Сдвиг камеры: по горизонтали — на D пикселей, по вертикали — на V.
    var z = renderer.cam.zoom;
    var d = (box.left + box.width / 2 - renderer.cssW / 2) / z;
    var e = (box.top + box.height / 2 - renderer.cssH / 2) * 2 / z;
    renderer.cam.x -= d + e;
    renderer.cam.y += d - e;
    renderer.clampCamera();
    driftBase = renderer.cam.zoom;
  }

  /* --------------------------- мультиплеер ------------------------------ *
   *
   * Хост считает мир и шлёт снапшоты; клиенты только рисуют и шлют команды.
   * Так нет рассинхрона «у каждого свой мир», а сервер остаётся релеем: он не
   * знает ни правил, ни карты.
   * ---------------------------------------------------------------------- */

  function stopNet(reset) {
    (state.netOff || []).forEach(function (off) { try { off(); } catch (e) {} });
    state.netOff = [];
    state.netRole = null;
    state.netBusy = false;
    state.netForce = false;
    state.netSeq = 0;
    state.netAcc = 0;
    state.netEvery = NET_INTERVAL;
    state.netSilence = 0;
    state.netStale = false;
    state.netHostGone = false;
    state.netLastTick = 0;
    state.netCmdLast = {};
    state.netRejects = [];
    state.netSeqSeen = {};
    state.netPing = 0;
    state.netPingBusy = false;
    if (reset !== false && global.Net) global.Net.reset();
  }

  /* Один кадр мира на провод. Возвращает промис (или null, если слать
     нечего/уже шлём). Следующий кадр play.js отправит только после ответа:
     при медленной сети частота падает, а очередь не растёт. */
  function netSend(force) {
    if (!state.world || state.netRole !== 'host' || !global.Net || state.netBusy) return null;
    if (!force && state.netAcc < state.netEvery) return null;
    state.netAcc = 0;
    state.netBusy = true;
    var seq = ++state.netSeq;
    var started = nowMs();
    var notes = state.netRejects.map(function (n) {
      return { to: n.to, n: n.n, reason: n.reason };
    });
    var snap;
    try {
      snap = global.Serialize.world(state.world, state.buildings, state.villagers,
        { seq: seq, notes: notes, over: state.over, winner: state.winner });
    } catch (e) {
      /* Кривой объект в мире не должен останавливать игровой цикл: кадр
         пропускаем, следующий попробует снова. */
      state.netBusy = false;
      return null;
    }
    /* Какие команды гостей уже выполнены. Карта не пустая только у хоста, и
       в обычном кадре это десятки байт; сервер по ней чистит очередь. */
    var ack = null, who;
    for (who in state.netCmdLast) {
      if (Object.prototype.hasOwnProperty.call(state.netCmdLast, who)) {
        var done = state.netCmdLast[who];
        if (typeof done === 'number' && done > 0) {
          (ack || (ack = {}))[who] = done;
        }
      }
    }
    if (ack) snap.cmdAck = ack;
    /* Частота подстраивается под фактическое время круга. На быстрой сети
       остаётся 80 мс; на забитой — редеет до 200 мс, чтобы хост не топил
       собственный канал и пинг у друзей не рос. Это не задержка мира:
       клиент сглаживает позиции между снимками. */
    function pace() {
      var rtt = nowMs() - started;
      if (rtt > NET_SLOW_MS) {
        state.netEvery = Math.min(NET_INTERVAL_MAX, state.netEvery + 0.02);
      } else if (rtt < NET_FAST_MS) {
        state.netEvery = Math.max(NET_INTERVAL, state.netEvery - 0.01);
      }
    }
    var p = global.Net.snapshot(snap).then(function (res) {
      state.netBusy = false;
      pace();
      /* Команды гостей пришли в ответе на наш снимок — тот же POST, которым
         хост доказывает, что жив. Применяем по порядку, как их положил
         сервер; повтор (n не больше уже выполненного) отсеет netCmdLast. */
      var cmds = res && res.commands;
      var applied = false;
      if (cmds && cmds.length) {
        for (var ci = 0; ci < cmds.length; ci++) applyNetCommand(cmds[ci]);
        state.netForce = true;
        applied = true;
      }
      /* Ответы на команды живут несколько снимков: если один кадр потерялся
         по дороге, отказ всё равно доедет. */
      for (var i = 0; i < state.netRejects.length; i++) state.netRejects[i].ttl--;
      state.netRejects = state.netRejects.filter(function (n) { return n.ttl > 0; });
      /* Применили команду — шлём снимок СРАЗУ, не ожидая следующего тика.
         В скрытой вкладке браузер редеет таймеры до раза в секунду (а в
         глубоком фоне — до раза в минуту), и «ждать тика» значило бы держать
         постройку гостя до минуты. Этот же кадр несёт cmdAck, поэтому сервер
         убирает команду из очереди, а гость видит результат. */
      if (applied) netSend(true);
      return true;
    }, function () {
      state.netBusy = false;
      pace();
      return false;
    });
    return p;
  }

  /* Отказ клиенту. Пишется в ближайшие снимки; клиент сам отбросит чужое и
     повторно пришедшее (netSeqSeen). */
  function netReject(cmd, reason) {
    if (!cmd || cmd.n === undefined || cmd.from === undefined) return;
    state.netRejects.push({
      to: cmd.from, n: cmd.n, reason: String(reason || 'не вышло'), ttl: 6
    });
    if (state.netRejects.length > 24) state.netRejects.shift();
  }

  /* Сколько стоит постройка. Цена — правило игры (BUILD_MENU), и хост обязан
     спрашивать её у себя, а не верить клиенту: иначе гость строил бы
     бесплатно. */
  function buildPrice(type) {
    for (var i = 0; i < BUILD_MENU.length; i++) {
      if (BUILD_MENU[i].type === type) return BUILD_MENU[i].price;
    }
    return 0;
  }

  /* Самый большой номер постройки в id вида "p0:b1042": после возврата в
     партию новые id не должны совпасть со старыми. */
  function nextBuildIdFrom(list) {
    var max = 999;
    for (var i = 0; i < (list || []).length; i++) {
      var id = list[i] && list[i].id;
      if (typeof id !== 'string') continue;
      var m = /:b(\d+)$/.exec(id);
      if (m) max = Math.max(max, parseInt(m[1], 10) || 0);
    }
    return max + 1;
  }

  /* Поднять мир из последнего снимка. Используется и хостом (тогда он снова
     считает), и клиентом (тогда он просто сразу видит знакомую картину). */
  function restoreFromSnapshot(w, snap) {
    var res = global.Serialize.apply(w, snap, renderer, {
      owner: state.playerOwner, smooth: false
    });
    state.buildings = res.buildings;
    state.villagers = res.villagers;
    state.seconds = w.time || 0;
    state.over = !!snap.over;
    state.winner = snap.winner === undefined ? null : snap.winner;
    if (state.over) {
      state.result = state.winner !== null && state.winner === state.playerOwner
        ? 'win' : 'lose';
    }
    var own = (w.towns && w.towns[state.playerOwner]) || (w.towns && w.towns[0]) || null;
    state.spectator = !!(own && own.alive === false);
    w.village = own || w.village;
    state.logs = own ? (own.logs || 0) : 0;
    state.deliveries = own ? (own.deliveries || 0) : 0;
    state.felled = own ? (own.felled || 0) : 0;
    state.nextBuildId = nextBuildIdFrom(state.buildings);
    state.netSeq = snap.seq || 0;
    /* Подтверждения команд переживают F5. Без этого хост после возврата
       забыл бы, что уже выполнил, и команда из серверной очереди легла бы
       второй раз (двойной дом, двойная трата брёвен). */
    state.netCmdLast = {};
    if (snap.cmdAck && typeof snap.cmdAck === 'object') {
      for (var who in snap.cmdAck) {
        if (Object.prototype.hasOwnProperty.call(snap.cmdAck, who)) {
          state.netCmdLast[who] = snap.cmdAck[who] || 0;
        }
      }
    }
    state.netCentered = true;
    var home = own && own.townhall ? own.townhall : null;
    if (home) {
      renderer.cam.zoom = Math.min(renderer.maxZoom,
        Math.max(renderer.minZoom * 2.5, 42));
      renderer.cam.x = home.x + 1.5;
      renderer.cam.y = home.y + 1.5;
      renderer.clampCamera();
    } else if (renderer.fitIsland) {
      renderer.fitIsland();
    }
    arrival = null;
    return home;
  }

  /* Хост после F5 продолжает считать. Пути и цели жителей в снимке не
     хранятся — сбрасываем их и даём обычному шагу построить заново. Иначе
     житель с state "toTree", но без дерева, стоял бы вечно. */
  function normalizeResumedVillagers(list) {
    for (var i = 0; i < (list || []).length; i++) {
      var v = list[i];
      if (!v || v.dead) continue;
      v.path = null; v.goal = null; v.spot = null; v.order = null;
      v.target = null; v.combatMode = null; v.tree = null; v.job = null;
      v.campKey = undefined; v.stationKey = undefined;
      v.intoYard = false; v.exitYard = false; v.escape = false;
      v.spotTrip = false; v.jobPath = false; v.close = false;
      v.garrisonSpot = null; v.hold = 0; v.stuck = 0; v.lost = 0;
      if (v.trainee) {
        if (!v.trainingAt || v.trainingAt.rubble) {
          v.trainee = false; v.hidden = false; v.trainT = 0;
          v.state = 'wander';
        }
        continue;
      }
      if (v.employer && !v.employer.rubble) {
        v.state = 'toCamp';
      } else if (v.employer) {
        v.employer = null;
        v.state = 'wander';
      } else if (v.warrior) {
        v.state = v.warcamp && !v.warcamp.rubble ? 'patrol' : 'stand';
      } else {
        v.state = 'wander';
      }
    }
  }

  function startNet(payload, isHost) {
    if (!payload || !payload.players) return null;
    var resumeSnap = payload.snapshot || null;
    stopNet(false);
    villageCleanup();
    var w = WG.generate({ seed: payload.seed, size: payload.size });
    renderer.world = w;
    renderer.buildCache();
    state.world = w;
    state.buildings = [];
    state.villagers = [];
    state.netRole = isHost ? 'host' : 'client';
    /* Чей это город. В лобби у игрока стабильный id (он не меняется при
       переподключении), а в партии владелец — ПОРЯДКОВЫЙ НОМЕР деревни.
       Совпадают они только пока никто не выходил; поэтому берём owner из
       стартового пакета, а не playerId. */
    state.playerOwner = 0;
    var myId = global.Net ? global.Net.playerId() : null;
    for (var pi = 0; pi < (payload.players || []).length; pi++) {
      var pl = payload.players[pi];
      if (pl && pl.id === myId) {
        state.playerOwner = pl.owner === undefined ? pi : pl.owner;
        break;
      }
    }
    state.netPlayers = payload.players;
    state.netCentered = false;
    state.nextBuildId = 1000;
    state.result = null;
    state.over = false;
    state.winner = null;
    state.spectator = false;
    state.gameMode = 'mp';
    state.seconds = 0;
    state.birth = global.Session.birthClock();
    w.time = 0;
    state.netOff = [];
    state.netSeq = payload.lastSeq || 0;
    state.netAcc = 0;
    state.netEvery = NET_INTERVAL;
    state.netBusy = false;
    state.netForce = false;
    state.netSilence = 0;
    state.netStale = false;
    state.netHostGone = false;
    state.netLastTick = 0;
    state.netCmdLast = {};
    state.netRejects = [];
    state.netSeqSeen = {};
    state.netPing = 0;
    state.netPingAt = nowMs();
    state.netPingBusy = false;

    /* Уход игрока виден и хосту, и гостям: молчаливое исчезновение чужой
       деревни читается как поломка. */
    state.netOff.push(global.Net.on('peer-left', function (ev) {
      emit({ type: 'net-peer-left', id: ev && ev.id,
        name: ev && ev.name, owner: ev && ev.owner, host: !!(ev && ev.host) });
    }));
    state.netOff.push(global.Net.on('peer-back', function (ev) {
      emit({ type: 'net-peer-back', id: ev && ev.id,
        name: ev && ev.name, owner: ev && ev.owner });
    }));

    var st = null;
    var home = null;
    if (isHost) {
      if (resumeSnap) {
        /* F5 у хоста: мир уже есть в последнем снимке. Не строим деревню
           заново — иначе развитие друзей пропало бы. */
        home = restoreFromSnapshot(w, resumeSnap);
        normalizeResumedVillagers(state.villagers);
        state.birth = global.Session.birthClock();
        if (state.birth) {
          state.birth.next = (Math.floor(state.seconds / global.Session.BIRTH_EVERY) + 1) *
            global.Session.BIRTH_EVERY;
        }
        if (global.Combat) global.Combat.init(w, state.buildings, state.villagers);
      } else {
        st = global.Session.startMulti(w, renderer, { players: payload.players.length });
        state.buildings = st.buildings;
        state.villagers = st.villagers;
        if (global.Combat) global.Combat.init(w, state.buildings, state.villagers);
      }
      /* Команды гостей хост забирает в ответе на СВОЙ снимок (netSend):
         SSE для них — односторонний поток без подтверждений, и его обрыв
         терял постройку молча. Слушателя `command` здесь поэтому нет. */
      /* Первый снимок — сразу, не ожидая тика: гостю нечего рисовать до него. */
      netSend(true);
    } else {
      if (resumeSnap) {
        home = restoreFromSnapshot(w, resumeSnap);
      } else {
        w.towns = payload.players.map(function (p, i) {
          return { id: i, owner: p.owner, name: p.name, color: p.color,
            alive: true, isBot: false, logs: 0, deliveries: 0, felled: 0,
            buildings: [], villagers: [], townhall: null };
        });
        w.village = w.towns[state.playerOwner] || w.towns[0];
        renderer.setBuildings([]);
        renderer.setVillagers([]);
      }
      state.netOff.push(global.Net.on('snapshot', applySnapshot));
      state.netOff.push(global.Net.on('host-left', onHostLeft));
      state.netOff.push(global.Net.on('host-back', onHostBack));
      state.netOff.push(global.Net.on('net-error', function () {
        emit({ type: 'net-trouble' });
      }));
      state.netOff.push(global.Net.on('command-error', function (ev) {
        emit({ type: 'net-note',
          text: 'Команда не ушла: ' + ((ev && ev.message) || 'сеть') });
      }));
    }
    state.running = !state.over;
    state.mode = 'play';
    if (resumeSnap) {
      logsSeen = state.logs;
      felledSeen = state.felled;
    } else {
      state.logs = 0;
      logsSeen = 0;
      state.felled = 0;
      felledSeen = 0;
    }
    warriorSeen = {};
    /* Дом игрока — его деревня, а не первая в списке: если хостом стал
       второй игрок (первый вышел до старта), towns[0] принадлежит другому. */
    if (!home) {
      if (st) {
        var own0 = st.towns && st.towns[state.playerOwner];
        home = (own0 && own0.townhall) || st.home || null;
      } else if (w.towns && w.towns[state.playerOwner]) {
        home = w.towns[state.playerOwner].townhall || null;
      }
    }
    /* После возврата камера уже стоит на своей ратуше (restoreFromSnapshot):
       подлёт с общего плана тут был бы вторым началом партии. */
    if (!resumeSnap) startArrival(home);
    emit({ type: 'start', world: w, home: home, net: true });
    /* `onStart` у HUD сбрасывает наблюдателя и прячет итог, поэтому состояние
       возврата говорим уже ПОСЛЕ старта. */
    if (state.spectator && global.Hud && global.Hud.setSpectator) {
      global.Hud.setSpectator(true);
    }
    if (state.over) {
      emit({ type: 'defeat', result: state.result, winner: state.winner, over: true });
    }
    return st;
  }

  function onHostLeft(ev) {
    if (state.netRole !== 'client') return;
    state.netHostGone = true;
    state.running = false;
    emit({ type: 'net-host-left', name: ev && ev.name,
      owner: ev && ev.owner, host: true });
  }

  function onHostBack() {
    if (state.netRole !== 'client' || !state.netHostGone) return;
    state.netHostGone = false;
    state.netSilence = 0;
    state.netStale = false;
    // Экран «Меню» — не остановка мира, поэтому вернувшийся хост поднимает
    // время и за открытой доской; в главном меню сессия уже оставлена.
    if (!state.over && (state.mode === 'play' || state.mode === 'paused')) {
      state.running = true;
    }
    emit({ type: 'net-host-back' });
  }

  function applySnapshot(snap) {
    if (!snap || state.netRole !== 'client' || !state.world) return;
    /* Чужой остров (например, после возврата в лобби) не применяем: карта по
       сиду у каждого своя, и подменять её снимком нельзя. */
    if (snap.seed !== undefined && state.world.seed !== snap.seed) return;
    if (snap.seq !== undefined) {
      if (snap.seq <= state.netSeq) return;          // запоздавший кадр
      state.netSeq = snap.seq;
    }
    /* Пока клиент был offline, хост мог вернуться: снимок — доказательство,
       что он снова здесь, даже если событие host-back не доехало. */
    if (state.netHostGone) onHostBack();
    var hold = state.edit && state.edit.building ? state.edit.building : null;
    var wasSelected = renderer.selected;
    var wasOver = state.over;
    /* Сглаживать есть смысл только когда кадры идут. В скрытой вкладке или
       после долгой заморозки кадров нет — там снимок ставит позицию сразу,
       иначе житель «догонял» бы её только к следующему кадру. */
    var smooth = !(global.document && global.document.hidden) &&
      state.netLastTick > 0 && nowMs() - state.netLastTick < 300;
    var res = global.Serialize.apply(state.world, snap, renderer, {
      owner: state.playerOwner, smooth: smooth, hold: hold
    });
    state.buildings = res.buildings;
    state.villagers = res.villagers;
    state.seconds = state.world.time || 0;
    var town = state.world && state.world.towns && state.world.towns[state.playerOwner];
    state.logs = town ? town.logs : 0;
    state.deliveries = town ? town.deliveries : 0;
    /* Своя ратуша пала — этот клиент наблюдает, но мир у хоста живёт.
       Итог показываем только когда в снимке пришёл `over`. */
    setSpectator(!!(town && town.alive === false));
    state.winner = snap.winner === undefined ? null : snap.winner;
    if (snap.over !== undefined) {
      if (snap.over && !wasOver) finishGame(state.winner);
      else {
        state.over = !!snap.over;
        if (state.over) {
          state.result = state.winner !== null && state.winner === state.playerOwner
            ? 'win' : 'lose';
        }
      }
    }
    state.netSilence = 0;
    if (state.netStale) {
      state.netStale = false;
      emit({ type: 'net-ok' });
    }
    /* Выбранный житель и открытая правка — те же объекты (serialize.js
       сверяет по id), но если объект всё-таки исчез, ссылку надо снять. */
    if (state.focus && state.villagers.indexOf(state.focus) < 0) setFocus(null);
    if (state.edit && state.buildings.indexOf(state.edit.building) < 0) editClose();
    /* Постройку снесли (или она пала) — табличка выбранного дома не должна
       показывать то, чего на карте уже нет. */
    if (wasSelected && renderer.selected !== wasSelected) selectBuilding(null);

    /* Ответы на свои команды: отказ показываем словами, успех виден по миру. */
    var notes = snap.notes || [];
    for (var i = 0; i < notes.length; i++) {
      var note = notes[i];
      if (!note || note.to !== myId()) continue;
      var key = note.to + '|' + note.n;
      if (state.netSeqSeen[key]) continue;
      state.netSeqSeen[key] = 1;
      if (Object.keys(state.netSeqSeen).length > 400) state.netSeqSeen = {};
      emit({ type: 'net-note', text: note.reason || 'команда не вышла', n: note.n });
    }

    /* Первый снапшот: клиент до сих пор висел на общем плане в центре, а
       его деревня — у края. Ставим камеру на свою ратушу один раз, без
       анимации: тик клиента мир не считает и полёт бы не доехал. */
    if (!state.netCentered && town && town.townhall) {
      var th = town.townhall;
      renderer.cam.zoom = Math.min(renderer.maxZoom, Math.max(renderer.minZoom * 2.5, 42));
      renderer.cam.x = th.x + 1.5;
      renderer.cam.y = th.y + 1.5;
      renderer.clampCamera();
      state.netCentered = true;
      arrival = null;
    }
  }

  /* Сглаживание позиций гостя. Снимок приходит 12 раз в секунду, кадр — 60;
     без этого житель ехал бы ступеньками. Цель — последняя позиция хоста,
     скорость сходимости задаёт NET_SMOOTH. */
  function netSmoothVillagers(dt) {
    if (dt <= 0) return;
    var k = 1 - Math.exp(-dt / NET_SMOOTH);
    var list = state.villagers || [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!v || typeof v._netTX !== 'number' || typeof v._netTY !== 'number') continue;
      var dx = v._netTX - v.x, dy = v._netTY - v.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.002) {
        v.x = v._netTX; v.y = v._netTY;
      } else {
        v.x += dx * k; v.y += dy * k;
      }
    }
  }

  function myId() { return global.Net ? global.Net.playerId() : null; }

  function villagerById(id) {
    for (var i = 0; i < state.villagers.length; i++) {
      if (state.villagers[i] && state.villagers[i].id === id) return state.villagers[i];
    }
    return null;
  }
  function buildingById(id) {
    for (var i = 0; i < state.buildings.length; i++) {
      if (state.buildings[i] && state.buildings[i].id === id) return state.buildings[i];
    }
    return null;
  }

  /* Какие из присланных id — свои воины. null означает «все свои воины»
     (кнопка «Стоп» без списка). */
  function ownWarriorIds(ids, who) {
    var out = [], i, v;
    if (!ids) {
      for (i = 0; i < state.villagers.length; i++) {
        v = state.villagers[i];
        if (v && v.warrior && (v.owner === undefined ? 0 : v.owner) === who) out.push(v.id);
      }
      return out;
    }
    for (i = 0; i < ids.length; i++) {
      v = villagerById(ids[i]);
      if (v && v.warrior && (v.owner === undefined ? 0 : v.owner) === who) out.push(v.id);
    }
    return out;
  }

  /* Команда клиента на хосте. Всё проверяется теми же правилами, что и у
     хоста: чужой не может поставить дом в воду, построить без брёвен или
     тренировать в чужой казарме. */
  function applyNetCommand(cmd) {
    if (!cmd || state.netRole !== 'host' || state.over) return;
    var B = global.Buildings, S = global.Session;
    /* owner — номер города в партии, from — id игрока в лобби. Это разные
       числа, как только кто-то выходил из комнаты до старта. */
    var who = cmd.owner === undefined ? cmd.from : cmd.owner;
    /* Повтор после обрыва: тот же n — уже выполнено. */
    if (cmd.n !== undefined && cmd.from !== undefined) {
      var last = state.netCmdLast[cmd.from] || 0;
      if (cmd.n <= last) return;
      state.netCmdLast[cmd.from] = cmd.n;
    }
    var town = state.world && state.world.towns && state.world.towns[who];
    if (!town || town.alive === false) {
      netReject(cmd, 'ваша деревня больше не в игре');
      return;
    }
    if (cmd.type === 'order' && global.Army) {
      /* Команда действует только на СВОИХ: чужой id в списке — не приказ, а
         попытка увести чужую дружину. */
      var order = global.Army.order(state.world, ownWarriorIds(cmd.ids, who),
        state.villagers, cmd.x, cmd.y);
      if (order && order.ok === false) netReject(cmd, order.reason);
      state.netForce = true;
      return;
    }
    if (cmd.type === 'stop' && global.Army) {
      var stopIds = cmd.ids ? ownWarriorIds(cmd.ids, who) : ownWarriorIds(null, who);
      global.Army.stop(stopIds, state.villagers);
      state.netForce = true;
      return;
    }
    if (cmd.type === 'build') {
      var price = buildPrice(cmd.buildingType);
      if (!price) { netReject(cmd, 'неизвестная постройка'); return; }
      if ((town.logs || 0) < price) {
        netReject(cmd, 'не хватает брёвен: нужно ' + price + ', у деревни ' + (town.logs || 0));
        return;
      }
      var made = B.make({
        type: cmd.buildingType, variant: cmd.variant || 'a', rot: cmd.rot || 0,
        x: cmd.x, y: cmd.y, owner: who, town: who,
        id: 'p' + cmd.from + ':b' + (state.nextBuildId++)
      });
      var chk = B.canPlace(state.world, state.buildings, made, BUILD_SITE);
      if (!chk.ok) { netReject(cmd, chk.reason); return; }
      town.logs -= price;
      B.settle(state.world, made, { clear: false });
      B.touch(state.world);
      state.buildings.push(made);
      if (cmd.buildingType === 'warcamp' && S.rebalanceGarrison) {
        S.rebalanceGarrison(state.world, state.buildings, state.villagers);
      }
      renderer.setBuildings(state.buildings);
      state.netForce = true;
      return;
    }
    if (cmd.type === 'edit') {
      var b = buildingById(cmd.id);
      if (!b || (b.owner === undefined ? 0 : b.owner) !== who) {
        netReject(cmd, 'это не ваша постройка');
        return;
      }
      if (cmd.action === 'rotate') {
        var can = B.canEdit(b, 'rotate');
        if (!can.ok) { netReject(cmd, can.reason); return; }
        B.setSpot(state.world, b, { rot: b.rot + 90 });
        renderer.setBuildings(state.buildings);
        state.netForce = true;
      } else if (cmd.action === 'delete') {
        var res = B.remove(state.world, state.buildings, b, { villagers: state.villagers });
        if (!res.ok) { netReject(cmd, res.reason); return; }
        B.touch(state.world);
        renderer.setBuildings(state.buildings);
        state.netForce = true;
      } else if (cmd.action === 'move') {
        var at = B.checkAt(state.world, state.buildings, b, { x: cmd.x, y: cmd.y }, BUILD_SITE);
        if (!at.ok) { netReject(cmd, at.reason); return; }
        B.setSpot(state.world, b, { x: cmd.x, y: cmd.y });
        B.touch(state.world);
        renderer.setBuildings(state.buildings);
        state.netForce = true;
      }
      return;
    }
    if (cmd.type === 'train' || cmd.type === 'hire' || cmd.type === 'fire') {
      var camp = buildingById(cmd.campId), v = villagerById(cmd.villagerId);
      if (!camp || !v) { netReject(cmd, 'нет такой постройки или жителя'); return; }
      if ((camp.owner === undefined ? 0 : camp.owner) !== who) {
        netReject(cmd, 'это чужая постройка'); return;
      }
      if ((v.owner === undefined ? 0 : v.owner) !== who) {
        netReject(cmd, 'это чужой житель'); return;
      }
      var answer = cmd.type === 'train'
        ? S.train(camp, v, state.villagers, state.buildings)
        : (cmd.type === 'fire' ? S.fire(camp, v) : S.hire(camp, v, state.villagers));
      if (answer && answer.ok === false) netReject(cmd, answer.reason);
      state.netForce = true;
      return;
    }
  }

  /* Начало партии: мир выбранного размера, ратуша, житель и подлёт камеры. */
  function start(opts) {
    opts = opts || {};
    if (state.netRole) stopNet();
    var st = buildWorld({ seed: opts.seed || global.randomSeed(), size: opts.size || 64 }, opts.mode);
    state.villagers = (opts.mode === 'bot' && st.villagers)
      ? st.villagers
      : global.Session.spawnVillagers(st.world, renderer, st.buildings, st.home);
    villageCleanup();
    state.seconds = 0;
    st.world.time = 0;
    state.result = null;
    state.over = false;
    state.winner = null;
    state.spectator = false;
    state.gameMode = opts.mode || 'solo';
    /* Одиночный остров всегда принадлежит нулевому городу. После выхода из
       сети (гость — owner 1) playerOwner не сбрасывался, и новая одиночная
       партия считала игрока гостем: панели отбирали чужих жителей, а «Войска»
       показывали пустоту (2026-10-24). */
    state.playerOwner = 0;
    state.netPlayers = [];
    if (global.Combat && global.Combat.init) {
      global.Combat.init(st.world, st.buildings, state.villagers);
    }
    state.birth = global.Session.birthClock();
    state.felled = 0;
    state.logs = villageLogs();
    state.deliveries = villageDeliveries();
    state.follow = false;
    felledSeen = 0;
    logsSeen = state.logs;
    deliveredSeen = [];
    firstDelivery = true;
    warriorSeen = {};
    state.running = true;
    state.mode = 'play';
    startArrival(st.home);
    emit({ type: 'start', world: st.world, home: st.home, ms: st.ms });
    return st;
  }

  // Мелочь, которая должна сбрасываться на каждой новой партии.
  function villageCleanup() {
    savedZoom = 0;
    drag = null;
    view.classList.remove('dragging');
    // Карта другая — подсветка, выбор постройки и выбранный житель относились
    // к прошлой. Правка и начатая постановка — тоже: построек прошлого мира на
    // новой карте нет.
    cancelBuild();
    cancelOrder();
    state.squadIds = [];
    state.lastOrder = null;
    forgetHover();
    selectBuilding(null);
    setFocus(null);
    editClose();
  }

  function startArrival(home) {
    // Session.startHome уже поставил камеру на общий план — запоминаем его
    // как цель полёта и только потом уводим камеру к ратуше.
    var to = { zoom: renderer.cam.zoom, x: renderer.cam.x, y: renderer.cam.y };
    var fp = home ? global.Buildings.footprint(home.rot) : null;
    var from = {
      zoom: Math.min(to.zoom * 2.6, renderer.maxZoom),
      x: home ? home.x + fp.w / 2 : state.world.width / 2,
      y: home ? home.y + fp.h / 2 : state.world.height / 2
    };
    renderer.cam.zoom = from.zoom;
    renderer.cam.x = from.x;
    renderer.cam.y = from.y;
    renderer.clampCamera();
    arrival = { t: 0, dur: ARRIVAL, from: from, to: to };
  }

  /* ------------------------------- время ------------------------------- */

  /* «Дыхание» камеры на заставке — движение, и если система просит его
     убрать (настройка «уменьшить движение»), его не будет: море и волны
     останутся, а камера встанет. */
  function reduceMotion() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function nowMs() {
    return (global.performance && global.performance.now)
      ? global.performance.now() : Date.now();
  }

  function tick(dt) {
    if (!renderer || !state.world) return;
    /* Сетевой клиент не считает мир: он получает снапшоты и только рисует.
       Часы ему приходят в снапшоте, поэтому state.seconds здесь не растёт.
       Движение между снимками сглаживается здесь же: иначе житель ехал бы
       ступеньками 12 раз в секунду. */
    if (state.netRole === 'client') {
      state.seconds = state.world.time || 0;
      state.netLastTick = nowMs();
      netSmoothVillagers(dt);
      state.netSilence += dt;
      if (!(global.document && global.document.hidden) && !state.netHostGone &&
          !state.netStale && state.netSilence > NET_SILENCE) {
        state.netStale = true;
        emit({ type: 'net-stale' });
      }
      /* Круг до сервера раз в две секунды: число в HUD вместо «вроде
         лагает», и раннее предупреждение, что связь просела. */
      if (global.Net && !state.netPingBusy &&
          !(global.document && global.document.hidden) &&
          nowMs() - state.netPingAt > 2000) {
        state.netPingBusy = true;
        state.netPingAt = nowMs();
        global.Net.ping().then(function (r) {
          state.netPingBusy = false;
          state.netPing = r && r.ms ? r.ms : 0;
          emit({ type: 'net-ping', ms: state.netPing });
        }, function () {
          state.netPingBusy = false;
          state.netPing = 0;
          emit({ type: 'net-ping', ms: 0 });
        });
      }
      return;
    }

    /* Хост шлёт снимки из игрового цикла. Это и есть ограничитель скорости:
       следующий кадр уходит только после ответа на предыдущий, а при
       подвисании вкладки кадры не копятся втайне от игрока. */
    if (state.netRole === 'host') {
      state.netAcc += dt;
      if (state.netForce && !state.netBusy) {
        state.netForce = false;
        netSend(true);
      } else {
        netSend(false);
      }
      /* Короткий heartbeat хоста. Снимок сам по себе доказывает, что хост
         жив, но если кадр задержался (тяжёлый кадр, GC, вкладка моргнула), у
         сервера не должно быть повода объявить «хост потерян». Один запрос в
         2.5 с стоит копейки, а живой партии — не даёт развалиться. */
      if (global.Net && !state.netPingBusy && nowMs() - state.netPingAt > 2500) {
        state.netPingBusy = true;
        state.netPingAt = nowMs();
        global.Net.ping().then(function () {
          state.netPingBusy = false;
        }, function () {
          state.netPingBusy = false;
        });
      }
    }

    // Заставка: камера чуть «дышит», иначе меню стоит на застывшем скриншоте.
    // Выхода отсюда нет намеренно: мир за главным меню — та же партия, и он
    // продолжает жить (правило заказчика 2026-10-24: не останавливаться
    // никогда). До первой партии state.running выключен, и шаг ниже её не пустит.
    if (state.mode === 'diorama') {
      if (!reduceMotion()) {
        driftT += dt;
        renderer.cam.zoom = driftBase * (1 + 0.022 * Math.sin(driftT * 0.35));
        renderer.clampCamera();
      }
    }

    if (arrival) {
      arrival.t += dt;
      var k = Math.min(1, arrival.t / arrival.dur);
      var e = 1 - Math.pow(1 - k, 3);            // мягкое торможение
      renderer.cam.zoom = arrival.from.zoom + (arrival.to.zoom - arrival.from.zoom) * e;
      renderer.cam.x = arrival.from.x + (arrival.to.x - arrival.from.x) * e;
      renderer.cam.y = arrival.from.y + (arrival.to.y - arrival.from.y) * e;
      renderer.clampCamera();
      if (k >= 1) arrival = null;
    }

    /* Стоит только до первой партии и после боя. Экран «Меню» и главное меню
       сюда не относятся: в них время идёт. */
    if (!state.running) return;
    state.seconds += dt;

    /* Бой — до шага жителей: Combat выставляет v.target/v.combatMode и наносит
       урон, а Villagers.update ведёт воина к цели. Два модуля не пишут одно
       поле: движение остаётся за villager.js. */
    if (global.Combat) {
      global.Combat.tick(state.world, dt, {
        buildings: state.buildings,
        villagers: state.villagers,
        onDefeat: function (owner) {
          /* Город выбывает, а не «партия кончается у всех». В 3–4 игроках
             мир должен идти дальше; итог считает Session.standing. */
          handleTownFallen(owner);
        }
      });
    }

    /* Заселение: раз в 30 секунд ИГРОВОГО времени, сразу после того, как это
       время выросло. Одна попытка на шаг; если шаг перепрыгнул сразу несколько
       границ (ручной tick), догоняются не все — Session.birthDue ставит
       следующую по текущему seconds. Фоновое время приходит шагами по 0.05,
       поэтому границы в нём не теряются. До партии и после боя сюда не
       доходят: стоит state.running — экран «Меню» и заставка время не стоят. */
    if (global.Session.birthDue(state.birth, state.seconds)) {
      global.Session.tryBirth(state.world, renderer, state.villagers, state.buildings);
    }

    var felled = global.Session.stepVillagers(state.villagers, state.world, renderer, dt, state.buildings);
    /* Убитые боем уходят из списка после кадра: Combat только помечает dead,
       иначе он вынимал бы людей из массива, пока сам по нему идёт. */
    if (global.Combat) {
      var dead = false;
      for (var di = 0; di < state.villagers.length; di++) {
        if (state.villagers[di] && state.villagers[di].dead) { dead = true; break; }
      }
      if (dead) {
        state.villagers = state.villagers.filter(function (v) { return v && !v.dead; });
        state.world._villagers = state.villagers;
        renderer.setVillagers(state.villagers);
      }
    }
    /* Новый воин — событие для экрана: сравнение флага с прошлым кадром, а не
       чтение состояния движка. Так оно переживёт переименование состояний. */
    for (var wi = 0; wi < state.villagers.length; wi++) {
      var wv = state.villagers[wi];
      if (wv.warrior && !warriorSeen[wv.id]) {
        warriorSeen[wv.id] = true;
        emit({ type: 'warrior', villager: wv });
      }
    }
    if (felled !== felledSeen) {
      var first = felledSeen === 0 && felled > 0;
      felledSeen = felled;
      state.felled = felled;
      emit({ type: 'felled', total: felled, first: first });
    }
    stepDeliveries();

    var who = focused();
    if (state.follow && who) {
      renderer.cam.x = who.x;
      renderer.cam.y = who.y;
      renderer.clampCamera();
    }
  }

  /* ------------------------------ сдача брёвен --------------------------- *
   * Деревня сдаёт брёвна: счётчик живёт в мире (world.village.logs, +4 за
   * сдачу — правило движка), а игре нужно знать МОМЕНТ сдачи, чтобы показать
   * «+4» над лагерем и всплывашку про первое бревно. События от движка тут не
   * ждём: сравнение двух чисел — счётчика и личных сдач жителей — не зависит
   * от того, как движок называет свои состояния, и переживёт правку правил.
   *
   * Сдача бывает у нескольких жителей в одном шаге (редко, но бывает): тогда
   * прибавка делится по-честному, остаток достаётся последнему — сумма
   * всплывашек обязана совпасть с прибавкой счётчика. */

  /* Казна ИГРОКА: в сети у каждого свой город, и чужой лог в HUD — ложь. */
  function playerTown() {
    var w = state.world;
    if (!w) return null;
    if (w.towns && w.towns[state.playerOwner]) return w.towns[state.playerOwner];
    return w.village;
  }

  function villageLogs() {
    var v = playerTown();
    return v && typeof v.logs === 'number' ? v.logs : 0;
  }

  function villageDeliveries() {
    var v = playerTown();
    return v && typeof v.deliveries === 'number' ? v.deliveries : 0;
  }

  function stepDeliveries() {
    var list = state.villagers || [];
    var logs = villageLogs();
    var gained = logs - logsSeen;
    var deliveries = villageDeliveries();

    // Кто сдал с прошлого шага: у жителя это его личный счёт.
    var grew = [];
    for (var i = 0; i < list.length; i++) {
      var was = typeof deliveredSeen[i] === 'number' ? deliveredSeen[i] : 0;
      var now = typeof list[i].delivered === 'number' ? list[i].delivered : 0;
      if (now > was) grew.push(list[i]);
      deliveredSeen[i] = now;
    }
    state.logs = logs;
    state.deliveries = deliveries;

    if (!grew.length) { logsSeen = logs; return; }
    var firstEver = firstDelivery;
    firstDelivery = false;
    var shown = 0;
    for (var g = 0; g < grew.length; g++) {
      var v = grew[g];
      var amount = (g === grew.length - 1) ? gained - shown : Math.round(gained / grew.length);
      shown += amount;
      var at = campSpot(v);
      emit({
        type: 'delivery', villager: v, amount: amount, total: logs,
        x: at.x, y: at.y, first: firstEver && g === 0
      });
    }
    logsSeen = logs;
  }

  /* Где рисовать «+4»: над ЛАГЕРЕМ, куда житель сдал брёвна. Лагерь у жителя
     спрашивается у движка (`v.employer` — его ставит наём, `v.job` — то же
     самое для кода, который спрашивает «работает ли»), а середина пятна
     считается по `Buildings.footprint`: постройка опирается на левый угол
     пятна, и цифра над углом висела бы сбоку от двора. Жителя, у которого
     лагеря нет, это не касается: сдавать брёвна некуда, и события не будет. */
  function campSpot(v) {
    var camp = v.employer || v.job || null;
    var B = global.Buildings;
    if (camp && typeof camp.x === 'number') {
      var fp = (B && B.footprint) ? B.footprint(camp.rot, camp.type) : null;
      return { x: camp.x + (fp ? fp.w / 2 : 1.5), y: camp.y + (fp ? fp.h / 2 : 1.5) };
    }
    return { x: v.x, y: v.y };
  }

  function draw(time) {
    if (!renderer || !state.world) return;
    renderer.render(time);
    drawCombatOverlay();
    drawArmyOverlay();
  }

  /* Полосы здоровья — экранный слой, а не часть спрайта: они не должны
     попадать под деревья и не должны перекрашивать атлас. Рисуются после
     мира, в тех же координатах, что подсветка клетки.

     Полоса появляется только после удара (`hpUntil`), гаснет через 5 секунд
     без удара и не рисуется у убитых/завалов. Цвет: свой — зелёный, чужой —
     красный; когда появятся команды (P3), сюда придёт цвет владельца. */
  function drawCombatOverlay() {
    var w = state.world, r = renderer;
    if (!w || !r || !r.ctx) return;
    var z = r.cam.zoom;
    if (z < 8) return;
    var g = r.ctx;
    g.save();
    g.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    g.translate(r.cssW / 2, r.cssH / 2);

    function bar(cx, top, wpx, hp, maxHp, foe) {
      if (!(maxHp > 0) || hp <= 0 || hp >= maxHp) return;
      var h = Math.max(3, Math.round(z * 0.075));
      var bw = Math.max(16, Math.round(wpx));
      var x = cx - bw / 2, y = top - h - 4;
      g.fillStyle = 'rgba(20,16,10,0.82)';
      g.fillRect(x - 1, y - 1, bw + 2, h + 2);
      g.fillStyle = foe ? '#e05a4e' : '#7ed957';
      g.fillRect(x, y, Math.max(0, Math.round(bw * hp / maxHp)), h);
      g.strokeStyle = 'rgba(255,246,227,0.55)';
      g.lineWidth = 1;
      g.strokeRect(x - 0.5, y - 0.5, bw + 1, h + 1);
    }

    var i, b, v, box, vb, foe;
    /* Цвет деревни на карте живёт на кайме САМОГО спрайта (render.js,
       drawSpriteOutline) — одного тонкого слоя достаточно. Колец под каждым
       жителем здесь больше нет: в бою и в сети они давали второй слой поверх
       каймы и забивали карту (правило заказчика 2026-10-24). */
    for (i = 0; i < state.buildings.length; i++) {
      b = state.buildings[i];
      if (!b || b.rubble || !(b.hp < b.maxHp) || !(w.time < b.hpUntil)) continue;
      box = r.buildingBox(b, z);
      if (!box) continue;
      foe = (b.owner === undefined ? 0 : b.owner) !== 0;
      bar(box.cx, box.dy + 2, z * 0.9, b.hp, b.maxHp, foe);
    }
    for (i = 0; i < state.villagers.length; i++) {
      v = state.villagers[i];
      if (!v || v.dead || v.hidden || !(v.hp < v.maxHp) || !(w.time < v.hpUntil)) continue;
      vb = r.villagerBox(v, z);
      if (!vb) continue;
      foe = (v.owner === undefined ? 0 : v.owner) !== 0;
      bar(vb.x, vb.dy + 2, z * 0.55, v.hp, v.maxHp, foe);
    }
    g.restore();
  }

  /* ------------------------------- режимы ------------------------------ */

  /* «Пауза» — это экран «Меню», а не остановка мира.

     Правило заказчика 2026-10-24: игра не должна останавливаться никогда.
     Поэтому pause() только меняет режим (игровой ввод замолкает — isPlaying
     смотрит на mode), а state.running остаётся включённым: жители работают,
     бой идёт, счётчики растут за открытой доской. Выключить время может
     только исход боя. */
  function pause() {
    cancelBuild();
    if (state.mode !== 'play') return false;
    state.mode = 'paused';
    arrival = null;
    return true;
  }

  function resume() {
    if (state.mode !== 'paused') return false;
    // running не включаем: если ратуша пала, пока меню было открыто, мир
    // обязан остаться стоящим.
    state.mode = 'play';
    return true;
  }

  /* Игрок ушёл в главное меню.

     Мир остаётся ТОТ САМЫЙ — на котором играли, — и продолжает жить: возврат
     в меню не должен выглядеть как «всё пропало» (правило 2026-10-24). Кадр
     переставляется под меню: игрок мог смотреть на ратушу вблизи, и в меню
     остров уходил бы за край экрана обрезанным куском. Дальше это обычная
     заставка — тот же режим, что и до первой партии, только мир не новый. */
  function showInMenu() {
    state.follow = false;
    arrival = null;
    cancelBuild();
    // Подсветка, выбор постройки и выбранный житель — про партию: в меню их не
    // видно и помнить о них незачем. Правка — тем более: она про конкретную
    // постройку этого мира.
    forgetHover();
    selectBuilding(null);
    setFocus(null);
    editClose();
    if (!state.world) { state.running = false; state.mode = 'empty'; return; }
    frameDiorama();
    driftT = 0;
    state.mode = 'diorama';
  }

  /* Игровой ввод и карта: в главном меню и за доской «Меню» они молчат, но
     время при этом идёт — это разные вещи, и путать их нельзя. */
  function isPlaying() { return state.running && state.mode === 'play'; }

  /* Вернулись на вкладку — проверить, не выбросил ли браузер холст
     местности. Это дешёвая проверка нескольких пикселей; если холст пуст,
     остров перерисовывается, а не остаётся одной водой. */
  function checkCache() {
    if (!renderer || !state.world) return false;
    return !!(renderer.repaintIfBlank && renderer.repaintIfBlank());
  }

  function resize() {
    if (!renderer) return;
    renderer.resize();
    // Заставка зависит от ширины окна: на широком остров стоит справа, на
    // узком — по центру. Развернули окно с открытым меню — кадр пересобирается.
    if (state.mode === 'diorama') frameDiorama();
  }

  /* ------------------------------- камера ------------------------------ */

  function fit() {
    if (!renderer || !state.world) return;
    arrival = null;
    renderer.fitIsland();
  }

  /* Кто из жителей «наш» для клавиш H и C.

     Правило: H и C ведут к ВЫБРАННОМУ жителю — тому, по кому игрок кликнул на
     карте; если не выбран никто, это первый житель деревни (Житель №1). Выбор
     живёт в мире, а не в HUD: он влияет и на камеру, и на подсветку строки в
     табличке (hud.js: onFocus), и на то, к кому летит камера в следящем режиме. */
  function focused() {
    var v = state.focus;
    if (v && (state.villagers || []).indexOf(v) >= 0) return v;
    return (state.villagers && state.villagers.length) ? state.villagers[0] : null;
  }

  function setFocus(v) {
    v = v || null;
    if (state.focus === v) return state.focus;
    state.focus = v;
    emit({ type: 'focus', villager: v });
    return state.focus;
  }

  /* Житель под точкой полотна. Радиус — треть клетки: человек на карте ростом
     0.54 клетки, и без запаса в него нельзя попасть мышью. Считается по земле
     (v.x, v.y), а не по спрайту: спрайт нарисован выше своей клетки, и клик по
     голове уводил бы выбор в соседнюю клетку. */
  var VILLAGER_PICK = 0.34;

  function villagerAt(vx, vy) {
    if (!renderer || !state.world) return null;
    var p = renderer.screenToWorld(vx - renderer.cssW / 2, vy - renderer.cssH / 2);
    var best = null, bestD = VILLAGER_PICK;
    for (var i = 0; i < state.villagers.length; i++) {
      var v = state.villagers[i];
      var d = Math.hypot(v.x - p.x, v.y - p.y);
      if (d <= bestD) { bestD = d; best = v; }
    }
    return best;
  }

  function focusVillager() {
    var v = focused();
    if (!renderer || !v) return false;
    arrival = null;
    renderer.centerOn(v.x, v.y);
    // Если камера стояла на общем плане, показывать с него одного человека
    // бессмысленно: приближаемся до readable-крупности.
    if (renderer.cam.zoom <= renderer.minZoom * 1.02) {
      renderer.cam.zoom = Math.min(renderer.minZoom * 4, renderer.maxZoom);
      renderer.centerOn(v.x, v.y);
    }
    return true;
  }

  function focusHome() {
    if (!renderer || !state.buildings.length) return false;
    arrival = null;
    var b = state.buildings[0];
    var fp = global.Buildings.footprint(b.rot);
    renderer.centerOn(b.x + fp.w / 2, b.y + fp.h / 2);
    if (renderer.cam.zoom <= renderer.minZoom * 1.02) {
      renderer.cam.zoom = Math.min(renderer.minZoom * 3.4, renderer.maxZoom);
    }
    return true;
  }

  function toggleFollow() {
    state.follow = !state.follow;
    if (state.follow) focusVillager();
    return state.follow;
  }
  // Общий план и обратно: то же поведение, что у клавиши V в генераторе.
  function toggleTopView() {
    if (!renderer) return;
    arrival = null;
    if (Math.abs(renderer.cam.zoom - renderer.minZoom) < 1e-6) {
      renderer.cam.zoom = Math.min(savedZoom || renderer.minZoom * 3, renderer.maxZoom);
    } else {
      savedZoom = renderer.cam.zoom;
      renderer.fitIsland();
    }
    renderer.clampCamera();
  }

  function zoom(factor) {
    if (!renderer || !state.world) return;
    arrival = null;
    renderer.zoomAt(0, 0, factor);
  }

  /* ------------------ клетка под курсором и выбор постройки -------------- *
   * И то и другое РИСУЕТ ДВИЖОК (render.js: drawHover, drawSelection), и
   * оболочке остаётся ровно две вещи: следить за мышью и сказать HUD, что
   * написать словами. Так же устроен генератор карт (mapgen2/js/app.js) —
   * это одна возможность движка, а не два похожих поведения: подсветка
   * совпадает с клеткой под курсором, пятно выбранной постройки обводится,
   * а мышью без движения клик всё равно выбирает то, на что показывают
   * (поэтому клетка считается и на нажатии, а не только на движении). */

  // Клетка под точкой полотна (координаты внутри канваса, а не страницы).
  function cellAt(vx, vy) {
    var p = renderer.screenToWorld(vx - renderer.cssW / 2, vy - renderer.cssH / 2);
    return { x: Math.floor(p.x), y: Math.floor(p.y) };
  }

  /* Последняя точка мыши над полотном. Нужна потому, что подсветка зависит не
     только от мыши, но и от камеры: игрок уехал стрелками — под неподвижным
     курсором уже другая клетка, и рамка обязана переехать вместе с картой. */
  var lastPointer = null;

  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  /* Что стоит в клетке и что об этом написать. Про саму клетку знает движок
     (worldgen.js: describeCell) — тем же словом её называет генератор;
     постройка сверху — надстройка игры. */
  function hoverInfo(cell) {
    if (!renderer || !state.world) return null;
    var info = WG.describeCell(state.world, cell.x, cell.y);
    if (!info) return null;
    var b = info.inside ? renderer.buildingAt(cell.x, cell.y) : null;
    var B = global.Buildings;
    var name = b && B ? capitalize(B.TYPES[B.typeOf(b)].name) : null;
    return {
      cell: cell, inside: info.inside, text: info.text,
      building: b, buildingName: name,
      // Готовая строка для HUD. Под постройкой движок рамку клетки не рисует
      // (она ложилась бы на крышу), и имя постройки тут — единственный ответ
      // на вопрос «на что я показываю».
      label: info.inside ? info.text + (name ? ' · ' + name : '') : 'за картой'
    };
  }

  /* Подсветка идёт за мышью и во время панорамы тоже: клетка под курсором —
     это то, на что игрок смотрит, а не то, что он в этот момент двигает. */
  function updateHover(vx, vy) {
    if (!renderer || !isPlaying()) return null;
    var cell = cellAt(vx, vy);
    if (renderer.hover && renderer.hover.x === cell.x && renderer.hover.y === cell.y) return null;
    renderer.hover = cell;
    // Постройка, взятая из меню, едет за курсором: у неё тот же hover, но
    // пятно и ответ «годится ли» считает refreshBuildGhost.
    if (state.build) refreshBuildGhost(cell);
    var info = hoverInfo(cell);
    // Курсор над постройкой — «сюда можно нажать»: иначе о том, что дом
    // выбирается кликом, игрок не догадается.
    view.classList.toggle('pick', !!(info && info.building));
    emit({ type: 'hover', info: info });
    return info;
  }

  /* Подсветки нет: ни рамки, ни строки в HUD. Точка мыши забывается заодно —
     иначе после новой партии первое же нажатие стрелки воскресило бы подсветку
     там, где мышь была когда-то, а не там, где она есть. */
  function forgetHover() {
    if (renderer) renderer.hover = null;
    lastPointer = null;
    view.classList.remove('pick');
    emit({ type: 'hover', info: null });
  }

  /* Подсветку двигает не только мышь, но и камера: уехали стрелками или
     колесом — под тем же курсором уже другая клетка. Точка мыши помнится
     последней, а не берётся из события: события тут нет. */
  function refreshHover() {
    if (!lastPointer) return null;
    return updateHover(lastPointer.x, lastPointer.y);
  }

  /* Что показать про выбранную постройку. Считается здесь, а не в HUD: HUD —
     экран и в мир не заглядывает, он только раскладывает готовое. */
  function selectionInfo(b) {
    if (!b) return null;
    var B = global.Buildings;
    var type = B.typeOf(b);
    var fp = B.footprint(b.rot, type);
    return {
      building: b, type: type, variant: b.variant, rot: b.rot,
      name: capitalize(B.TYPES[type].name),
      w: fp.w, h: fp.h, x: b.x, y: b.y
    };
  }

  function selectBuilding(b) {
    if (!renderer) return null;
    renderer.selected = b || null;
    emit({ type: 'select', info: selectionInfo(renderer.selected) });
    return renderer.selected;
  }

  /* Клик по карте: сначала постройка, потом человек, потом «мимо».

     Постройка старше человека намеренно. Клетка лагеря занята домом, и клик по
     ней обязан выбирать лагерь — то есть открывать панель найма, — даже если
     работник в этот момент стоит рядом: иначе панель открывалась бы через раз,
     смотря где оказался житель. А по пустой земле клик снимает выбор совсем:
     и постройку, и человека. */
  function selectAt(vx, vy) {
    if (!renderer || !state.world) return null;
    var cell = cellAt(vx, vy);
    var b = renderer.buildingAt(cell.x, cell.y);
    if (b) { setFocus(null); return selectBuilding(b); }
    var v = villagerAt(vx, vy);
    if (v) { selectBuilding(null); return setFocus(v); }
    if (!renderer.selected && !state.focus) return null;
    selectBuilding(null);
    return setFocus(null);
  }

  /* ------------------------- правка постройки --------------------------- *
   *
   * Постройку открывают УДЕРЖАНИЕМ ЛКМ (EDIT_HOLD_MS): короткий клик — это
   * выбор, он был и остаётся, а «взять дом в руки» — жест намеренный, и
   * спутать их нельзя. Дальше режим живёт сам: здание можно вести мышью
   * (mode 'move'), а можно нажимать кнопки полосы правки (#editBar).
   *
   * Что здесь есть, а чего нет. Здесь — состояние (state.edit), ввод и
   * команды (editAction). Правила — «можно ли снести ратушу», «годится ли
   * место», «что станет с пятном при повороте» — живут в движке
   * (Buildings.editRules/canEdit/checkAt/setSpot/remove), и игра их только
   * спрашивает: своей копии правила тут нет ни одного. Фраза отказа тоже
   * движковая — она уходит и в кнопку, и во всплывашку, и в отчёт приёмки
   * дословно.
   *
   * Место здания меняется ТОЛЬКО через Buildings.setSpot, и он же отмечает,
   * что пятно переехало (touch → world._buildRev): по этой отметке
   * пересобирается карта проходимости жителей, и без неё житель ходил бы
   * сквозь переставленный дом. */
  var editCheck = null;           // последняя проверка: { ok, reason, blocked, yard }
  var editGrab = { x: 0, y: 0 };  // за какой угол пятна взялись при ведении
  var editHold = null;            // удержание ЛКМ: { timer }

  /* Готовое описание правки для экрана и для приёмки: одна сборка на событие
     шины, чтобы панель, отчёт и подсказка не собирали его каждая по-своему. */
  function editInfo() {
    var e = state.edit;
    if (!e) return null;
    var B = global.Buildings, b = e.building;
    var type = B.typeOf(b);
    var fp = B.footprint(b.rot, type);
    var move = B.canEdit(b, 'move');
    var rotate = B.canEdit(b, 'rotate');
    var del = B.canEdit(b, 'remove');
    /* Кольцо вокруг пятна — предупреждение, а не запрет (см. buildings.js:
       checkAt). Считаются в нём только ПОМЕХИ: дерево или камень вплотную к
       стене читаются в кадре как ошибка рендера, и об этом стоит сказать
       словами. Куст и трава рядом — не беда: их сомнёт «применить», и пугать
       игрока тем, что и так исчезнет, незачем. */
    var ring = editCheck ? editCheck.yardBlocked : null;
    return {
      building: b, type: type,
      name: capitalize((B.TYPES[type] || {}).name || type),
      mode: e.mode, changed: e.changed, valid: e.valid, reason: e.reason,
      x: b.x, y: b.y, rot: b.rot, w: fp.w, h: fp.h,
      canMove: move.ok, canRotate: rotate.ok,
      canRemove: del.ok, removeReason: del.reason,
      yardWarn: (ring && ring.length) ? 'рядом деревья и камни: ' + ring.length : ''
    };
  }

  function emitEdit() { emit({ type: 'edit', info: editInfo() }); }

  /* Фраза игроку, когда действие отклонено без кнопки: удержание по другому
     зданию и тычок мимо, когда правки ещё не применены. Молча ничего не
     происходит только тогда, когда терять нечего. */
  function editNote(text) { emit({ type: 'edit-note', text: text }); }

  /* Есть ли несохранённые отличия от снимка. Считается СРАВНЕНИЕМ, а не
     флажком «трогали хоть раз»: игрок, подвинувший дом и вернувший его на
     место, ничего не изменил, и «применить/отменить» ему предлагать нечего. */
  function editChanged() {
    var e = state.edit, b = e.building, o = e.orig;
    return b.x !== o.x || b.y !== o.y || b.rot !== o.rot;
  }

  // Спросить у движка, годится ли место, где постройка стоит сейчас.
  function recheck() {
    var e = state.edit;
    if (!e) return null;
    editCheck = global.Buildings.canApply(state.world, state.buildings, e.building);
    e.valid = !!editCheck.ok;
    e.reason = editCheck.ok ? '' : editCheck.reason;
    e.changed = editChanged();
    return editCheck;
  }

  /* Пятно и запреты на экране. Пока здание ведут — это призрак
     (footprintOnly): рисовать полупрозрачный СПРАЙТ нельзя, здание уже стоит
     там, куда его ведут, и второй спрайт был бы двойником. Стоит здание —
     призрака нет вовсе, а пятно рисует рендер (render.js: drawEditing). */
  function editGhost() {
    if (!renderer) return null;
    var e = state.edit;
    if (!e) { renderer.ghost = null; return null; }
    recheck();
    renderer.ghost = (e.mode === 'move') ? {
      b: e.building, ok: editCheck.ok, reason: editCheck.reason,
      blocked: editCheck.blocked, yard: editCheck.yard, footprintOnly: true
    } : null;
    return renderer.ghost;
  }

  /* Почему правку открыть нельзя — словами для экрана. Пустая строка значит
     «можно». Одна проверка на удержание, двойной клик и кнопку «Править»:
     раньше отказ в каждом входе был свой и молчал по-разному. */
  function editReject(b) {
    if (!renderer || !state.world) return 'мир ещё не готов';
    if (!isPlaying()) return 'сейчас не партия';
    if (state.build) return 'сначала поставьте или отмените покупку';
    var B = global.Buildings;
    /* Дерево, камень или куст — не постройка: режим правки на них не
       открывается никогда (Buildings.isBuilding). */
    if (!B.isBuilding(b)) return 'это не постройка';
    /* Чужое не правим: в режиме «против деревни» и в сети постройка врага
       выбирается только для осмотра, а не для переноса/сноса. */
    if ((b.owner === undefined ? 0 : b.owner) !== (state.playerOwner || 0)) {
      return 'чужая постройка: её можно только осмотреть';
    }
    // Постройка не из списка партии — править нечего: её нет на карте.
    if (state.buildings.indexOf(b) < 0) return 'постройки нет на карте';
    return '';
  }

  function editOpen(b) {
    var why = editReject(b);
    if (why) return null;
    var B = global.Buildings;
    if (state.edit) {
      if (state.edit.building !== b) editNote('сначала примените или отмените правку');
      return null;
    }
    state.edit = {
      building: b, orig: B.snapshot(b),
      mode: 'idle', changed: false, valid: true, reason: ''
    };
    renderer.editing = b;
    renderer.ghost = null;
    /* Табличка выбранного здания и панель найма закрываются: пока идёт правка,
       экран занимает полоса правки, и два ответа на один вопрос («что это»)
       спорили бы друг с другом. */
    selectBuilding(null);
    recheck();
    emitEdit();
    return state.edit;
  }

  /* «Править» из таблички выбранного здания. Тот же вход в режим, что у
     удержания и двойного клика, но доступный одним нажатием: игрок, который не
     знает про удержание, всё равно найдёт правку. Ведение при этом НЕ
     начинается — постройка поедет только по кнопке «Двигать» или повторному
     удержанию, иначе она ходила бы за курсором без нажатой кнопки. */
  function editSelected() {
    if (!canCommand()) return { ok: false, reason: commandRefusal() };
    var b = renderer && renderer.selected;
    if (!b) return { ok: false, reason: 'постройка не выбрана' };
    if (state.edit) return { ok: true, reason: '' };    // полоса уже открыта
    var why = editReject(b);
    if (why) return { ok: false, reason: why };
    if (!editOpen(b)) return { ok: false, reason: 'правка не открылась' };
    return { ok: true, reason: '' };
  }

  function editClose() {
    if (!state.edit) return false;
    state.edit = null;
    editCheck = null;
    holdCancel();
    if (renderer) { renderer.editing = null; renderer.ghost = null; }
    emitEdit();
    return true;
  }

  /* Ведение здания за курсором: место ставится в САМ объект (setSpot),
     поэтому на карте дом уже там, куда его ведут. Порядок отрисовки при этом
     сбрасывается (invalidateOrder), а миникарта не пересобирается: во время
     ведения это десятки раз в секунду, а на обзоре дом — прямоугольник в
     четыре пикселя. Полный setBuildings — на «применить», «отменить», снос. */
  function editFollow(vx, vy) {
    var e = state.edit;
    if (!e || e.mode !== 'move') return false;
    var cell = cellAt(vx, vy);
    var x = cell.x - editGrab.x, y = cell.y - editGrab.y;
    var moved = (x !== e.building.x || y !== e.building.y);
    if (moved) {
      global.Buildings.setSpot(state.world, e.building, { x: x, y: y });
      renderer.invalidateOrder();
    }
    editGhost();
    emitEdit();
    return moved;
  }

  /* Начать ведение. `grab` — за какой угол пятна взялись: при удержании это
     точка, где игрок нажал (дом не прыгает под курсор), у кнопки «Двигать»
     такой точки нет, и пятно встаёт углом под курсор — как при расстановке. */
  function editMove(grab) {
    var e = state.edit;
    if (!e) return { ok: false, reason: 'режим правки не открыт' };
    var verdict = global.Buildings.canEdit(e.building, 'move');
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    e.mode = 'move';
    editGrab = grab || { x: 0, y: 0 };
    /* Подсветка клетки гаснет: под курсором теперь пятно застройки, и две
       подсветки в одном месте читались бы как ошибка (то же правило, что у
       режима размещения в генераторе). */
    muteHover();
    if (lastPointer) editFollow(lastPointer.x, lastPointer.y);
    else { editGhost(); emitEdit(); }
    return { ok: true, reason: '' };
  }

  /* Команды режима правки. Возвращают ответ движка как есть: интерфейс
     показывает `reason` дословно, а не придумывает своё объяснение. */
  function editAction(action) {
    if (!canCommand() && action !== 'cancel') {
      return { ok: false, reason: commandRefusal() };
    }
    var e = state.edit;
    if (!e) return { ok: false, reason: 'режим правки не открыт' };
    var B = global.Buildings, b = e.building;
    /* Сетевой клиент правит только через хоста: локально он может вести
       призрак, но мир меняет команда. */
    if (state.netRole === 'client' && global.Net) {
      if (action === 'rotate') {
        /* Поворот после переноса: сначала место, потом угол — очередь команд
           сохранит порядок. Иначе хост повернул бы дом на старом месте. */
        if (e.orig && (e.orig.x !== b.x || e.orig.y !== b.y)) {
          global.Net.command({ type: 'edit', action: 'move', id: b.id, x: b.x, y: b.y });
        }
        global.Net.command({ type: 'edit', action: 'rotate', id: b.id });
        editClose();
      } else if (action === 'delete') {
        global.Net.command({ type: 'edit', action: 'delete', id: b.id });
        editClose();
      } else if (action === 'place') {
        global.Net.command({ type: 'edit', action: 'move', id: b.id, x: b.x, y: b.y });
        editClose();
      } else if (action === 'apply') {
        /* «Применить» после переноса — это и есть команда хосту. Раньше
           клиент закрывал режим молча, и на следующем снимке дом прыгал
           обратно: правка на клиенте не доезжала. */
        if (!e.valid) return { ok: false, reason: e.reason };
        var moved = e.orig && (e.orig.x !== b.x || e.orig.y !== b.y);
        if (moved) {
          global.Net.command({ type: 'edit', action: 'move', id: b.id, x: b.x, y: b.y });
        }
        editClose();
      } else if (action === 'cancel') {
        B.restore(state.world, b, e.orig);
        editClose();
      } else {
        editClose();
      }
      return { ok: action !== 'move', reason: '' };
    }

    if (action === 'move') return editMove(null);

    if (action === 'place') {
      if (e.mode !== 'move') return { ok: false, reason: 'постройку не ведут за курсором' };
      e.mode = 'idle';
      editGhost();                      // призрак уходит, пятно остаётся
      emitEdit();
      return { ok: true, reason: '' };
    }

    if (action === 'rotate') {
      var can = B.canEdit(b, 'rotate');
      if (!can.ok) return { ok: false, reason: can.reason };
      /* Поворот — через setSpot: он же нормализует угол и отметит, что пятно
         переехало. Пятно после поворота другое (3 x 4 вместо 4 x 3), поэтому
         порядок отрисовки сбрасывается. */
      B.setSpot(state.world, b, { rot: b.rot + 90 });
      renderer.setBuildings(state.buildings);
      state.netForce = true;
      editGhost();
      emitEdit();
      return { ok: true, reason: '' };
    }

    if (action === 'delete') {
      /* Сносим вместе с жителями: снесённая казарма или лагерь не должны
         оставлять работника с employer, которого больше нет. Освобождает
         движок (Buildings.remove → Session.fire) — общим кодом с «Уволить». */
      var res = B.remove(state.world, state.buildings, b, { villagers: state.villagers });
      if (!res.ok) return { ok: false, reason: res.reason };
      editClose();
      selectBuilding(null);       // снесённой постройки больше нет в мире
      if (renderer) renderer.setBuildings(state.buildings);
      state.netForce = true;
      return { ok: true, reason: '' };
    }

    if (action === 'apply') {
      // «Применить» посреди ведения — это «поставить и применить»: кнопка
      // делает то, что игрок и хотел, а не отказывает.
      if (e.mode === 'move') editAction('place');
      if (!e.valid) return { ok: false, reason: e.reason };
      /* Постройка встала окончательно — вот теперь сминается мелочь под ней и
         вокруг (Buildings.crushDecor; двор — его же число, Buildings.YARD).
         Не раньше: ведение дома за курсором места не закрепляет, и «отменить»
         обязано вернуть дом на нетронутый луг. Пока правка не применена, мелочь
         под домом не СМИНАЕТСЯ, но и не рисуется — прячет её отрисовка
         (js/render.js: coverMask), иначе куст стоял бы прямо в доме, который
         ведут (правило заказчика 2026-10-18). Деревья и камни не трогаются
         никогда — правка их и не пропускает (checkAt). */
      B.crushDecor(state.world, b);
      editClose();
      if (renderer) renderer.setBuildings(state.buildings);
      state.netForce = true;
      return { ok: true, reason: '' };
    }

    if (action === 'cancel') {
      B.restore(state.world, b, e.orig);
      editClose();
      if (renderer) renderer.setBuildings(state.buildings);
      state.netForce = true;
      return { ok: true, reason: '' };
    }

    return { ok: false, reason: 'неизвестное действие: ' + action };
  }

  /* Удержание ЛКМ. Таймер снимается на отпускании и на настоящем сдвиге мыши:
     сдвиг — это панорама (её ведёт тот же pointerdown), а не «взять постройку».
     Сработало удержание — постройка сразу идёт за курсором. Второе удержание по
     ТОЙ ЖЕ постройке снова берёт её (режим уже открыт — значит, игрок хочет
     вести ещё раз, а не открыть второй); по другой — отказ словами.

     `grab` — за какую клетку пятна взялись при нажатии. За полсекунды рука
     дрожит на 5–12 px (на Windows-мыши это норма), поэтому к моменту срабатывания
     захват пересчитывается по ТЕКУЩЕЙ клетке: дом остаётся там, где стоял, а не
     прыгает под курсор на величину дрожи. */
  function holdStart(b, grab) {
    holdCancel();
    var take = grab || { x: 0, y: 0 };
    editHold = { timer: global.setTimeout(function () {
      editHold = null;
      if (!isPlaying() || !drag || drag.moved > HOLD_SLOP) return;
      /* Захват — по клетке под курсором СЕЙЧАС. Ограничивать её пятном
         постройки нельзя: именно ограничение и давало прыжок на клетку, когда
         за полсекунды рука дрогнула за кромку. Без ограничения `editFollow`
         ставит дом ровно туда, где он стоит (cell − grab = b.x), — игрок просил
         «взять», а не «сдвинуть». */
      if (lastPointer) {
        var cell = cellAt(lastPointer.x, lastPointer.y);
        take = { x: cell.x - b.x, y: cell.y - b.y };
      }
      if (state.edit) {
        if (state.edit.building !== b) { editNote('сначала примените или отмените правку'); return; }
        if (state.edit.mode !== 'move') editMove(take);
        return;
      }
      if (editOpen(b)) editMove(take);
    }, EDIT_HOLD_MS) };
  }

  function holdCancel() {
    if (!editHold) return;
    if (editHold.timer) global.clearTimeout(editHold.timer);
    editHold = null;
  }

  /* Погасить подсветку клетки, не забывая точку мыши: она нужна ведению.
     forgetHover здесь не годится — он стирает lastPointer, и здание после
     первого же движения прыгало бы в угол карты. */
  function muteHover() {
    if (renderer) renderer.hover = null;
    view.classList.remove('pick');
    emit({ type: 'hover', info: null });
  }

  /* --------------------------- меню построек ---------------------------- *
   *
   * Игра наконец СТАВИТ постройки: не ратуши в генераторе карт, а то, что
   * игрок купил за брёвна. Покупка и постановка разделены намеренно:
   *
   *   beginBuild — взять постройку из меню. Списывается НИЧЕГО: игрок ещё не
   *                выбрал место, и «Отменить» не должно стоить денег;
   *   placeBuild — поставить туда, где место годится. Здесь и только здесь
   *                брёвна уходят из казны, а постройка появляется в списке.
   *
   * Правила места — движковые (Buildings.canPlace): деревья и камни мешают,
   * вода и песок не годятся, куст и трава не помеха и сминаются (settle).
   * Своего «что здесь можно» у игры нет — иначе меню и мир разошлись бы.
   *
   * Постройка, которую ведут, — это `renderer.ghost` (движок рисует пятно и
   * полупрозрачный спрайт), а не объект в списке: пока игрок не поставил,
   * мира она не касается.
   * ---------------------------------------------------------------------- */

  function buildOptions() {
    var B = global.Buildings;
    var logs = villageLogs();
    var out = [];
    for (var i = 0; i < BUILD_MENU.length; i++) {
      var o = BUILD_MENU[i];
      var info = B.TYPES[o.type] || { name: o.type };
      var fp = B.footprint(B.FACE_ROT, o.type);
      out.push({
        type: o.type, variant: o.variant, price: o.price, note: o.note,
        name: info.name, rot: B.FACE_ROT,
        fp: { w: fp.w, h: fp.h },
        logs: logs, afford: logs >= o.price
      });
    }
    return out;
  }

  function buildOption(type) {
    for (var i = 0; i < BUILD_MENU.length; i++) {
      if (BUILD_MENU[i].type === type) return BUILD_MENU[i];
    }
    return null;
  }

  /* Куда встанет постройка, если мышь ещё ни разу не была над картой: середина
     текущего кадра — игрок смотрит туда, и призрак не должен появляться в углу
     острова. */
  function buildStartCell() {
    if (renderer && renderer.hover) return { x: renderer.hover.x, y: renderer.hover.y };
    if (renderer) return { x: Math.floor(renderer.cam.x), y: Math.floor(renderer.cam.y) };
    return { x: Math.floor(state.world.width / 2), y: Math.floor(state.world.height / 2) };
  }

  function buildInfo() {
    var e = state.build;
    if (!e) return null;
    var B = global.Buildings;
    var info = B.TYPES[e.type] || {};
    var fp = B.footprint(e.rot, e.type);
    return {
      type: e.type, variant: e.variant, name: info.name || e.type,
      price: e.price, rot: e.rot, x: e.x, y: e.y, w: fp.w, h: fp.h,
      ok: !!e.ok, reason: e.reason || '', logs: villageLogs()
    };
  }

  function emitBuild() { emit({ type: 'build', info: buildInfo() }); }
  function buildNote(text) { emit({ type: 'build-note', text: text }); }

  /* Пересчитать призрак под курсором. Ответ о месте — движковый; экран его
     только повторяет. Событие шлётся по изменению клетки/поворота/ответа, а не
     на каждое движение мыши: HUD не должен переписывать строку зря. */
  function refreshBuildGhost(cell) {
    var e = state.build;
    if (!e || !renderer) {
      if (renderer) renderer.ghost = null;
      return null;
    }
    var c = cell || (renderer.hover ? { x: renderer.hover.x, y: renderer.hover.y }
                                    : { x: e.x, y: e.y });
    e.x = c.x;
    e.y = c.y;
    var cand = global.Buildings.make({
      type: e.type, variant: e.variant, rot: e.rot, x: e.x, y: e.y
    });
    var chk = global.Buildings.canPlace(state.world, state.buildings, cand, BUILD_SITE);
    e.ok = !!chk.ok;
    e.reason = chk.ok ? '' : chk.reason;
    renderer.ghost = {
      b: cand, ok: chk.ok, reason: chk.reason,
      blocked: chk.blocked, yard: chk.yard
    };
    var sig = e.x + ',' + e.y + ',' + e.rot + ',' + (e.ok ? 1 : 0) + ',' + e.reason;
    if (sig !== e.sig) { e.sig = sig; emitBuild(); }
    return e;
  }

  /* Взять постройку из меню. Денег пока не списывает. */
  function beginBuild(type) {
    if (!isPlaying()) return { ok: false, reason: 'сейчас не партия' };
    if (!canCommand()) return { ok: false, reason: commandRefusal() };
    var opt = buildOption(type);
    if (!opt) return { ok: false, reason: 'такой постройки нет в меню' };
    if (state.build) cancelBuild();
    if (state.edit) return { ok: false, reason: 'сначала примените или отмените правку' };
    var B = global.Buildings;
    if (!renderer || !renderer.spritesFor(type)) {
      return { ok: false, reason: 'атлас постройки не загрузился' };
    }
    var have = villageLogs();
    if (have < opt.price) {
      return { ok: false, reason: 'не хватает брёвен: нужно ' + opt.price + ', у деревни ' + have };
    }
    var c = buildStartCell();
    state.build = {
      type: opt.type, variant: opt.variant, price: opt.price,
      rot: B.FACE_ROT, x: c.x, y: c.y,
      ok: false, reason: '', sig: ''
    };
    // Табличка выбранной постройки и панель найма уходят: пока место выбирают,
    // на экране один вопрос — годится ли оно.
    selectBuilding(null);
    view.classList.add('placing');
    refreshBuildGhost(c);       // сам шлёт событие `build`, если ответ изменился
    return { ok: true, reason: '' };
  }

  /* Отменить постановку. Брёвна не трогаются: они ещё и не списывались. */
  function cancelBuild() {
    if (!state.build) return false;
    state.build = null;
    if (renderer) renderer.ghost = null;
    view.classList.remove('placing');
    emitBuild();
    return true;
  }

  function buildAction(action) {
    if (!canCommand() && action !== 'cancel') {
      return { ok: false, reason: commandRefusal() };
    }
    var e = state.build;
    if (!e) return { ok: false, reason: 'постановка не начата' };
    if (action === 'rotate') {
      e.rot = (e.rot + 90) % 360;
      refreshBuildGhost();
      return { ok: true, reason: '' };
    }
    if (action === 'cancel') { cancelBuild(); return { ok: true, reason: '' }; }
    if (action === 'place') return placeBuild();
    return { ok: false, reason: 'неизвестное действие: ' + action };
  }

  /* Списать брёвна. logsSeen правится вместе с казной: иначе следующая сдача
     сравнила бы новый счёт со старым и «прибавка» оказалась бы отрицательной
     или на брёвна больше. */
  function spendLogs(n) {
    var v = playerTown();
    if (!v || !n) return 0;
    v.logs = Math.max(0, (v.logs || 0) - n);
    state.logs = v.logs;
    logsSeen = v.logs;
    return v.logs;
  }

  /* Поставить купленное. Единственное место, где брёвна уходят и постройка
     появляется в мире. */
  function placeBuild() {
    if (!canCommand()) return { ok: false, reason: commandRefusal() };
    var e = state.build;
    if (!e) return { ok: false, reason: 'постановка не начата' };
    refreshBuildGhost();
    if (!e.ok) {
      buildNote(e.reason);
      return { ok: false, reason: e.reason };
    }
    /* Сетевой клиент не ставит дом у себя: он просит хоста. Хост проверит
       место, цену и пришлёт снапшот; до него дом не появится. Цену сверяем и
       здесь: если у своей деревни заведомо не хватает брёвен, незачем гонять
       команду по кругу и ждать отказа. */
    var have = villageLogs();
    if (have < e.price) {
      var poor = 'не хватает брёвен: нужно ' + e.price + ', у деревни ' + have;
      buildNote(poor);
      return { ok: false, reason: poor };
    }
    if (state.netRole === 'client' && global.Net) {
      global.Net.command({
        type: 'build', buildingType: e.type, variant: e.variant,
        rot: e.rot, x: e.x, y: e.y
      });
      state.build = null;
      renderer.ghost = null;
      view.classList.remove('placing');
      emitBuild();
      return { ok: true, reason: '', pending: true };
    }
    var B = global.Buildings;
    var made = B.make({
      type: e.type, variant: e.variant, rot: e.rot, x: e.x, y: e.y,
      owner: state.playerOwner, town: state.playerOwner,
      id: 'p' + state.playerOwner + ':b' + (state.nextBuildId++)
    });
    var chk = B.canPlace(state.world, state.buildings, made, BUILD_SITE);
    if (!chk.ok) {
      e.ok = false;
      e.reason = chk.reason;
      emitBuild();
      return { ok: false, reason: chk.reason };
    }
    var info = B.TYPES[e.type] || {};
    var name = info.name || e.type;
    var price = e.price;

    spendLogs(price);
    /* Постройка ВСТАЛА: мелочь под ней и в клетке вокруг сминается. Деревьев и
       камней здесь быть не может — их не пропустил canPlace. */
    B.settle(state.world, made, { clear: false });
    B.touch(state.world);
    state.buildings.push(made);
    renderer.setBuildings(state.buildings);
    state.netForce = true;

    /* Построили военный лагерь — ждущие во дворах казарм идут туда сами.
       Это правило заказчика (2026-10-23), а не отдельная кнопка. */
    if (e.type === 'warcamp' && global.Session.rebalanceGarrison) {
      global.Session.rebalanceGarrison(state.world, state.buildings, state.villagers);
    }

    state.build = null;
    renderer.ghost = null;
    view.classList.remove('placing');
    emitBuild();
    emit({
      type: 'built', building: made, buildingType: e.type, name: name,
      price: price, logs: villageLogs()
    });
    return { ok: true, reason: '', building: made };
  }

  /* ------------------------------- отряд -------------------------------- */

  /* Выбранные воины для колец под ногами. Список собирает HUD (по числам от
     групп), игра только помнит его и рисует. */
  function setSquad(ids) {
    state.squadIds = (ids || []).slice();
    return state.squadIds;
  }

  /* Режим приказа: следующий клик по карте отправит выбранных. Постановка и
     правка закрываются: два «следующих клика» одновременно — это спор о том,
     кому достанется нажатие. */
  function beginOrder(ids) {
    if (!canCommand()) return false;
    if (!ids || !ids.length) return false;
    cancelBuild();
    if (state.edit) editAction('cancel');
    state.order = { ids: ids.slice() };
    view.classList.add('ordering');
    emit({ type: 'order', active: true });
    return true;
  }

  function cancelOrder() {
    if (!state.order) return false;
    state.order = null;
    view.classList.remove('ordering');
    emit({ type: 'order', active: false });
    return true;
  }

  function orderAt(cell) {
    if (!canCommand()) return false;
    if (!state.order || !state.world || !global.Army) return false;
    if (state.netRole === 'client' && global.Net) {
      global.Net.command({ type: 'order', ids: state.order.ids,
        x: cell.x + 0.5, y: cell.y + 0.5 });
      state.lastOrder = { x: cell.x + 0.5, y: cell.y + 0.5,
        r: global.Army.MIN_R, until: state.seconds + 4 };
      cancelOrder();
      return true;
    }
    var res = global.Army.order(state.world, state.order.ids, state.villagers,
      cell.x + 0.5, cell.y + 0.5);
    if (res.ok) {
      state.lastOrder = {
        x: cell.x + 0.5, y: cell.y + 0.5, r: global.Army.MIN_R,
        until: state.seconds + 4
      };
      var note = 'Отряд: ' + res.count + ' воинов идут';
      if (res.skipped) note += '; ' + res.skipped + ' не дойдут: другой берег';
      emit({ type: 'order-note', text: note });
      state.netForce = true;
    } else {
      emit({ type: 'order-note', text: res.reason || 'приказ не вышел' });
    }
    cancelOrder();
    return res.ok;
  }

  function stopArmy(ids) {
    if (!canCommand()) return 0;
    var list, i, n = 0, me = state.playerOwner || 0;
    if (state.netRole === 'client' && global.Net) {
      global.Net.command({ type: 'stop', ids: ids || null });
      /* Без списка команда останавливает всех СВОИХ воинов. Число для
         всплывашки считаем по своим: раньше здесь всегда был 0, и гость
         читал «останавливать некого», хотя приказ уже ушёл хосту. */
      if (!ids) {
        return state.villagers.filter(function (v) {
          return v && v.warrior && !v.dead &&
            (v.owner === undefined ? 0 : v.owner) === me;
        }).length;
      }
      return ids.length;
    }
    /* И у хоста «Стоп» без списка — только своя дружина: иначе он снимал бы
       приказы и у друзей, а в «против деревни» — у бота. ownWarriorIds отдаёт
       НОМЕРА своих воинов, поэтому обратно в объекты их переводит Army.wardens
       (он же отсеивает мёртвых и учеников). */
    list = global.Army
      ? global.Army.wardens(ownWarriorIds(ids || null, me), state.villagers)
      : [];
    for (i = 0; i < list.length; i++) {
      list[i].order = null;
      list[i].path = null;
      list[i].target = null;
      list[i].combatMode = null;
      list[i].state = 'stand';
      n++;
    }
    if (n) state.netForce = true;
    return n;
  }

  /* Воин занят делом? У хоста это его поля приказа/боя, у сетевого клиента
     их нет — снапшот присылает только состояние (serialize.js), поэтому
     клиент смотрит на те же состояния, что ставит villager.js. Без этого на
     клиенте кольцо «на задании» не появилось бы вовсе. */
  function onDuty(v) {
    if (!v || !v.warrior || v.dead || v.hidden) return false;
    if (v.order || (v.combatMode && v.target)) return true;
    if (!v._net) return false;
    return v.state === 'march' || v.state === 'toBattle' ||
      v.state === 'attack' || v.state === 'hold';
  }

  function drawArmyOverlay() {
    var r = renderer, w = state.world;
    if (!r || !r.ctx || !w) return;
    var z = r.cam.zoom;
    if (z < 6) return;
    var g = r.ctx;
    g.save();
    g.setTransform(r.dpr, 0, 0, r.dpr, 0, 0);
    g.translate(r.cssW / 2, r.cssH / 2);
    var i, v, p;
    /* Кольцо — только у воина НА ЗАДАНИИ: он идёт по приказу или дерётся.
       Выбранный, но стоящий в лагере воин кольца не получает: выбор виден в
       панели «Войска», а карту он не засоряет. Кольцо тонкое и прозрачное,
       в цвет деревни, — это подсказка «занят», а не вторая обводка спрайта. */
    for (i = 0; i < state.villagers.length; i++) {
      v = state.villagers[i];
      if (!onDuty(v)) continue;
      p = { x: r.sx(v.x, v.y), y: r.sy(v.x, v.y) };
      g.beginPath();
      g.ellipse(p.x, p.y, z * 0.3, z * 0.15, 0, 0, Math.PI * 2);
      g.strokeStyle = r.teamColorFor(v.owner, 0.35);
      g.lineWidth = Math.max(1, z * 0.03);
      g.stroke();
    }
    /* Метка последнего приказа: круг радиуса зоны и флажок в точке. Круг
       приглушён: он подсказывает место, а не перекрывает воинов. */
    var lo = state.lastOrder;
    if (lo && state.seconds < lo.until) {
      p = { x: r.sx(lo.x, lo.y), y: r.sy(lo.x, lo.y) };
      g.beginPath();
      g.ellipse(p.x, p.y, lo.r * z * 0.5, lo.r * z * 0.25, 0, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(126,217,87,0.5)';
      g.lineWidth = Math.max(1, z * 0.035);
      g.stroke();
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.lineTo(p.x, p.y - z * 0.9);
      g.strokeStyle = 'rgba(255,242,196,0.85)';
      g.stroke();
      g.beginPath();
      g.moveTo(p.x, p.y - z * 0.9);
      g.lineTo(p.x + z * 0.35, p.y - z * 0.75);
      g.lineTo(p.x, p.y - z * 0.6);
      g.closePath();
      g.fillStyle = 'rgba(224,90,78,0.9)';
      g.fill();
    }
    g.restore();
  }


  /* Пороги указателя. Считаются по РАССТОЯНИЮ от точки нажатия, а не по сумме
     пройденного пути: рука дрогнула туда-обратно — это всё ещё клик, а раньше
     каждый пиксель дрожи складывался, и клик превращался в панораму.

     Почему числа такие. Мышь на Windows (и тачпад ноутбука) за полсекунды
     удержания сдвигается на 5–12 пикселей — это не «перетаскивание», а обычная
     рука. При старом пороге 6 px (да ещё по сумме!) у друга на Windows
     ломалось и удержание («не могут редактировать здания»), и клик («ЛКМ не
     работает»), и постановка («с трудом ставят»): жест считался панорамой.
     Поэтому клик терпит 8 px, удержание — 18 px, а камера трогается только
     после 8 px, а не от первого дрожания.

     Приёмка: game/tools/menu.js — дрожащие клик, удержание и постановка. */
  var CLICK_SLOP = 8;        // клик и постановка: до 8 px от точки нажатия
  var HOLD_SLOP = 18;        // удержание терпит дрожь сильнее клика
  var PAN_SLOP = CLICK_SLOP; // камера едет только после этого порога
  /* Пока в руке купленная постройка, рука занята прицеливанием: дрожание в
     10–15 px — это всё ещё «поставить сюда», а не «увести карту». Поэтому
     постановка терпит столько же, сколько удержание, и камера в это время
     не едет до того же порога. Иначе клик на Windows с дрожью 9–12 px
     съедался как панорама: дом оставался в руке, игрок жал снова — снаружи
     это выглядело как «здание встало через полминуты». Настоящую панораму
     (сдвиг больше 18 px) постановка по-прежнему не делает. */
  var PLACE_SLOP = HOLD_SLOP;

  /* Колесо: Windows-мышь даёт deltaY = 100 за щелчок, тачпад — единицы, а
     Firefox меряет колесо СТРОКАМИ (deltaMode 1), где 3 «строки» — это один
     щелчок. Без пересчёта зум в Firefox на Windows почти не работал:
     Math.pow(1.0016, -3) — это полпроцента за щелчок. */
  function wheelDelta(e) {
    var d = e.deltaY || 0;
    if (e.deltaMode === 1) d *= 16;          // строки
    else if (e.deltaMode === 2) d *= 400;    // страницы
    if (d > 240) d = 240;
    if (d < -240) d = -240;
    return d;
  }

  /* Курсор в пикселях полотна. Считается по getBoundingClientRect, а не по
     clientWidth: при масштабе Windows 125/150 % размер окна бывает дробным, и
     округление сдвигало бы клик у границы клетки. */
  function pointerAt(e) {
    var rect = view.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /* Мышь по карте. Живёт здесь, а не в оболочке: камера — это мир, а не
     меню. Клавиши — тоже здесь, но что делать с «Esc» и «N», решает
     оболочка: у неё экраны. */
  function bindInput(actions) {
    actions = actions || {};

    view.addEventListener('pointerdown', function (e) {
      view.setPointerCapture(e.pointerId);
      view.classList.add('dragging');
      /* Точка нажатия запоминается отдельно (x0/y0): по ней меряется дрожь —
         вернул руку на место, и это снова клик, а не панорама. */
      drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: 0 };
      if (arrival) arrival = null;      // игрок взял камеру — полёт отменён
      var p = pointerAt(e);
      // Клетка считается и на нажатии: клик без движения мыши — тоже клик по
      // клетке, а подсветки до него могло не быть вовсе.
      lastPointer = p;
      updateHover(p.x, p.y);
      /* Идёт постановка купленной постройки: нажатие только двигает камеру
         (панораму), правку оно не открывает. */
      if (state.build) return;
      /* Ждём клик приказа: нажатие не должно открывать правку под ним. */
      if (state.order) return;
      /* Удержание по постройке открывает правку (см. «правка постройки»).
         Захват берётся по клетке под курсором, а не по центру здания: за какой
         угол пятна игрок взялся, за тот дом и поедет. */
      if (e.button !== 0 || !isPlaying() || renderer.ghost) return;
      var cell = cellAt(p.x, p.y);
      var b = renderer.buildingAt(cell.x, cell.y);
      if (b && global.Buildings.isBuilding(b)) {
        holdStart(b, { x: cell.x - b.x, y: cell.y - b.y });
      }
    });

    view.addEventListener('pointermove', function (e) {
      var p = pointerAt(e);
      /* Здание ведут за курсором: курсор двигает ПОСТРОЙКУ, а не камеру.
         Панорама в этот момент выключена намеренно — иначе дом уезжал бы
         вместе с картой и встать точно было бы нельзя. */
      if (state.edit && state.edit.mode === 'move') {
        holdCancel();
        if (drag) drag = null;
        view.classList.remove('dragging');
        lastPointer = p;
        editFollow(p.x, p.y);
        return;
      }
      if (drag) {
        var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        /* Дрожь — расстояние от точки нажатия, и оно только растёт: путь
           туда-обратно (2 px вправо, 2 px назад) — это не «драг». */
        var reach = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
        if (reach > drag.moved) drag.moved = reach;
        // Панорама тоже забирает камеру у следящего режима: иначе игрок тянет
        // карту, а она возвращается к жителю — и он думает, что игра сломалась.
        // И начинается она только после порога: иначе дрожащая рука уводила бы
        // карту из-под клика.
        if (drag.moved > (state.build ? PLACE_SLOP : PAN_SLOP)) {
          if (state.follow) state.follow = false;
          renderer.panScreen(dx, dy);
        }
      }
      lastPointer = p;
      updateHover(p.x, p.y);
      // Мышь поехала — значит, игрок ведёт камеру, а не берёт постройку.
      if (editHold && drag && drag.moved > HOLD_SLOP) holdCancel();
    });

    view.addEventListener('pointerup', function (e) {
      holdCancel();
      view.classList.remove('dragging');
      // Клик отличается от перетаскивания расстоянием от точки нажатия:
      // панорама тоже начинается с нажатия, и без порога выбор срабатывал бы в
      // конце каждого сдвига камеры.
      var wasDrag = !!(drag && drag.moved > CLICK_SLOP);
      // У постановки свой, более щедрый порог: 10–15 px дрожания — это
      // прицеливание, а не панорама (см. PLACE_SLOP).
      var wasPlaceDrag = !!(drag && drag.moved > PLACE_SLOP);
      drag = null;

      /* Ведение кончилось: отпустил ЛКМ — здание встало. Режим правки при этом
         остаётся открытым: «применить» — отдельное решение игрока, и до него
         всё можно отменить.

         Эта ветка стоит ВЫШЕ проверки «это драг, а не клик» намеренно. При
         дрожащем удержании (а на Windows 5–12 px дрожи — норма) отпускание
         приходило с `drag.moved > CLICK_SLOP`, проверка съедала его, и дом
         оставался «в руке»: ехал за курсором без нажатой кнопки. Раньше это
         пряталось за тем, что при ведении первый pointermove обнулял `drag`;
         но если игрок отпустил кнопку, не сдвинув мышь после срабатывания
         удержания, обнулять было нечему. */
      if (state.edit && state.edit.mode === 'move' && e.button === 0) {
        editAction('place');
        return;
      }

      /* Постановка купленного: ЛКМ ставит, ПКМ отменяет. Перетаскивание
         (панорама) не ставит ничего — иначе карта ехала бы под зданием, а оно
         вставало бы в случайном месте. */
      if (state.build) {
        if (e.button === 2) { cancelBuild(); return; }
        if (e.button !== 0 || wasPlaceDrag || !isPlaying()) return;
        placeBuild();
        return;
      }

      if (e.button !== 0 || wasDrag || !isPlaying()) return;
      var pt = pointerAt(e);
      var vx = pt.x, vy = pt.y;

      /* Приказ отряду: клик по карте — точка сбора. Стоит после постановки и
         правки: если игрок в них, приказ не должен воровать клик. */
      if (state.order) {
        orderAt(cellAt(vx, vy));
        return;
      }

      /* Тычок мимо правимой постройки. Без правок это просто «закрыть», а с
         правками — отказ словами: молча выбросить несохранённое нельзя. */
      if (state.edit) {
        var cell = cellAt(vx, vy);
        if (renderer.buildingAt(cell.x, cell.y) !== state.edit.building) {
          if (state.edit.changed) {
            editNote('есть неприменённые правки: «Применить» или «Отменить»');
            return;
          }
          editAction('cancel');
        }
        return;
      }

      selectAt(vx, vy);
    });

    /* Указатель ушёл с полотна — в том числе на обзор, на кнопку или за окно —
       подсветка гаснет: она про то, где мышь, а мышь уже не тут. */
    view.addEventListener('pointerleave', function () { forgetHover(); });

    /* Правая кнопка в партии — отмена постановки, а не меню браузера. */
    view.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    view.addEventListener('pointercancel', function () {
      holdCancel();
      view.classList.remove('dragging');
      drag = null;
      // Касание отменили посреди ведения — дом не должен остаться «в руке».
      if (state.edit && state.edit.mode === 'move') editAction('place');
    });

    /* Двойной клик по СВОЕЙ постройке — второй, привычный всем вход в правку:
       первый — удержание, третий — кнопка «Править» в табличке. Открывает
       полосу правки, но НЕ берёт дом в руки: после двойного клика кнопка мыши
       отпущена, и «ведение» поехало бы за курсором само. Дальше — «Двигать» или
       удержание. */
    view.addEventListener('dblclick', function (e) {
      if (!isPlaying() || state.build || state.order || state.edit) return;
      var p = pointerAt(e);
      var cell = cellAt(p.x, p.y);
      var b = renderer && renderer.buildingAt(cell.x, cell.y);
      if (!b) return;
      var why = editReject(b);
      if (why) { editNote(why); return; }
      editOpen(b);
    });

    /* Потеря фокуса окна (Alt+Tab, меню «Пуск», уход на другую вкладку) —
       отпускание до полотна не доедет, а таймер удержания сработает уже без
       мыши и «возьмёт» дом. Гасим и удержание, и ведение. */
    function dropPointer() {
      holdCancel();
      drag = null;
      view.classList.remove('dragging');
      if (state.edit && state.edit.mode === 'move' && isPlaying()) editAction('place');
    }
    global.addEventListener('blur', dropPointer);
    global.addEventListener('pagehide', dropPointer);
    if (global.document) {
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.hidden) dropPointer();
      });
    }

    view.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (!renderer || !state.world) return;
      var rect = view.getBoundingClientRect();
      var vx = e.clientX - rect.left - rect.width / 2;
      var vy = e.clientY - rect.top - rect.height / 2;
      arrival = null;                            // колесо тоже отменяет полёт
      /* Шаг колеса приводится к пикселям: Windows-мышь и тачпад, Firefox со
         строчными deltaMode — все дают разное, а зум должен быть один. */
      renderer.zoomAt(vx, vy, Math.pow(1.0016, -wheelDelta(e)));
      refreshHover();
    }, { passive: false });

    global.addEventListener('keydown', function (e) {
      // В поле ввода клавиши не наши: сид набирают, а не летят по карте.
      if (global.Keys ? global.Keys.typing(e)
          : (e.target && /input|select|textarea/i.test(e.target.tagName))) return;
      /* Имя клавиши — по физическому месту (mapgen2/js/keys.js): у игрока с
         русской раскладкой `e.key` для W приходит как «ц», и раньше молчали
         WASD, R, O и остальные буквы. */
      var k = global.Keys ? global.Keys.name(e) : String(e.key || '').toLowerCase();
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      keys[k] = true;

      // Esc сначала снимает выбор, а меню открывает СЛЕДУЮЩИМ нажатием —
      // та же лестница, что у генератора карт: отменяется то, что игрок
      // выбрал, а не то, что он открыл. Выбранный житель — тоже выбор (и он
      // снимается первым: панель найма закрывается вместе с выбором лагеря).
      // Открытая правка стоит впереди всех: она — самое свежее действие игрока,
      // и Esc обязан вернуть постройку на место, а не открыть меню поверх неё.
      if (k === 'escape') {
        if (state.order) { cancelOrder(); return; }
        if (state.build) { cancelBuild(); return; }
        if (state.edit) { editAction('cancel'); return; }
        if (state.focus) { setFocus(null); return; }
        if (renderer && renderer.selected) { selectBuilding(null); return; }
        if (actions.escape) actions.escape();
        return;
      }
      if (!isPlaying()) return;                  // в меню и на паузе игровые клавиши молчат

      /* R — поворот купленной постройки, пока она ещё не встала. Вне
         постановки клавиша свободна и ничего не делает. O — отряд: T занята
         панелью сведений о деревне (js/hud.js), и раньше одно нажатие
         открывало обе панели сразу. */
      if (k === 'r' && state.build) { buildAction('rotate'); return; }
      if (k === 'o') { actions.squad && actions.squad(); return; }
      if (k === 'h') { focusVillager(); }
      else if (k === 'c') { toggleFollow(); actions.followChanged && actions.followChanged(state.follow); }
      else if (k === 'v') { toggleTopView(); }
      else if (k === 'f') { fit(); }
      else if (k === 'n') { actions.newIsland && actions.newIsland(); }
      else if (k === '=' || k === '+') { zoom(1.15); }
      else if (k === '-' || k === '_') { zoom(1 / 1.15); }
      if (k.indexOf('arrow') === 0 || 'wasd'.indexOf(k) >= 0) e.preventDefault();
    });

    global.addEventListener('keyup', function (e) {
      keys[global.Keys ? global.Keys.name(e) : String(e.key || '').toLowerCase()] = false;
    });
    global.addEventListener('blur', function () { keys = Object.create(null); });
  }

  /* Панорама от клавиш идёт в экранных направлениях, как при перетаскивании:
     «вверх» — карта едет вниз по экрану. В изометрии это не совпадает с
     осями мира, поэтому вектор переводится той же обратной проекцией, что и
     мышь. */
  function stepKeys(dt) {
    if (!isPlaying() || !renderer) return false;
    var vx = 0, vy = 0;
    if (keys['a'] || keys['arrowleft']) vx += 1;
    if (keys['d'] || keys['arrowright']) vx -= 1;
    if (keys['w'] || keys['arrowup']) vy += 1;
    if (keys['s'] || keys['arrowdown']) vy -= 1;
    if (!vx && !vy) return false;
    state.follow = false;
    var speed = 900 * dt;
    var len = Math.hypot(vx, vy) || 1;
    renderer.panScreen(vx / len * speed, vy / len * speed);
    // Камера уехала под неподвижным курсором: под ним уже другая клетка.
    refreshHover();
    return true;
  }

  /* --------------------------- атласы и текстур -------------------------- *
   * Грузит их оболочка (js/boot.js): она показывает полоску загрузки. Здесь
   * только места, куда их положить, — ровно те же поля, что и у генератора. */

  function setTextures(tex) { renderer.textures = tex; }

  function setSprites(set) {
    renderer.sprites = set;
    set.mul = SPRITE_MUL;
  }

  /* --------------------------- остров «сверху» -------------------------- *
   * Мини-карта движка для иконок не годится: она рисуется по кэшу местности
   * (текстуры, блики, тени) и в сорока пикселях превращается в кашу. Здесь —
   * чистая схема в цветах самой игры: море, отмель, песок, трава, лес,
   * камень. Ею нарисованы и герб острова в партии, и карточки размеров в
   * главном меню, поэтому живёт она здесь: это взгляд на мир, а не на меню.
   *
   * Рисуется В ДВА ШАГА, и это не прихоть, а разница в двадцать раз по
   * времени: сначала клетки кладутся по одной в буфер «пиксель на клетку»
   * (запись в массив байт), потом буфер кладётся на канвас одной картинкой,
   * растянутой до нужного размера. Попытка нарисовать то же самое честными
   * fillRect — по прямоугольнику на клетку — стоила под сотню миллисекунд
   * (замер на карте 96: 106 мс): смена fillStyle на каждую клетку дороже
   * самого рисования. Кадр в 100 мс виден глазом как залипание, и именно
   * поэтому так больше не делается. */

  var THUMB = {
    0: [38, 112, 166],    // глубина
    1: [47, 134, 189],    // вода
    2: [124, 196, 224],   // отмель
    3: [240, 220, 162],   // песок
    4: [125, 199, 94]     // трава
  };
  var THUMB_FOREST = [90, 166, 63];
  var THUMB_STONE = [169, 167, 149];
  // Прибой у берега: тёмная кайма по кромке суши — тот же контур, что у
  // спрайтов. Без него светлый песок и отмель расплываются в белое пятно.
  var THUMB_EDGE = [24, 46, 60];

  // Буфер «пиксель на клетку» переиспользуется между вызовами: карточек в
  // меню четыре, и каждая не должна заводить свой холст заново.
  var thumbCanvas = null, thumbCtx = null;

  function paintThumbnail(canvas, world, opts) {
    world = world || state.world;
    if (!canvas || !world) return false;
    opts = opts || {};
    var dpr = global.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || canvas.width || 64;
    var cssH = canvas.clientHeight || canvas.height || 64;
    var cw = Math.max(1, Math.round(cssW * dpr));
    var ch = Math.max(1, Math.round(cssH * dpr));
    // Канвас трогается, только если размер ДЕЙСТВИТЕЛЬНО изменился: запись в
    // width/height пересоздаёт буфер отрисовки, даже когда число то же.
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    var g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);

    // Кадр — остров плюс полоса моря вокруг: без неё карточка читается как
    // «кусок зелени», а с ней — как остров.
    var b = world.landBounds;
    var span = Math.max(b.x1 - b.x0, b.y1 - b.y0);
    var pad = Math.round(span * 0.08) + 2;
    var x0 = Math.max(0, Math.floor(b.x0 - pad));
    var y0 = Math.max(0, Math.floor(b.y0 - pad));
    var sw = Math.min(world.width, Math.ceil(b.x1 + pad)) - x0;
    var sh = Math.min(world.height, Math.ceil(b.y1 + pad)) - y0;
    if (sw <= 0 || sh <= 0) return false;

    var k = Math.min(cw / sw, ch / sh);
    var ox = (cw - sw * k) / 2, oy = (ch - sh * k) / 2;

    var W = world.width, land = world.isLand, tile = world.tile;
    var forest = world.forestness, stone = world.stonyness;

    if (!thumbCanvas) thumbCanvas = document.createElement('canvas');
    if (thumbCanvas.width !== sw || thumbCanvas.height !== sh) {
      thumbCanvas.width = sw;
      thumbCanvas.height = sh;
      thumbCtx = null;
    }
    if (!thumbCtx) thumbCtx = thumbCanvas.getContext('2d');
    var img = thumbCtx.createImageData(sw, sh);
    var data = img.data;
    var o = 0;
    for (var y = 0; y < sh; y++) {
      for (var x = 0; x < sw; x++) {
        var i = (y + y0) * W + (x + x0);
        var c = THUMB[tile[i]];
        if (tile[i] === 4) {
          if (forest[i] > 0.35) c = THUMB_FOREST;
          else if (stone[i] > 0.3) c = THUMB_STONE;
        } else if (!land[i]) {
          // Море у самой суши темнее: это и есть кайма берега.
          var near = (x > 0 && land[i - 1]) || (x < sw - 1 && land[i + 1]) ||
                     (y > 0 && land[i - W]) || (y < sh - 1 && land[i + W]);
          if (near) c = THUMB_EDGE;
        }
        data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
        o += 4;
      }
    }
    thumbCtx.putImageData(img, 0, 0);

    g.fillStyle = 'rgb(' + THUMB[0].join(',') + ')';
    g.fillRect(0, 0, cw, ch);
    g.imageSmoothingEnabled = true;
    g.drawImage(thumbCanvas, 0, 0, sw, sh, ox, oy, sw * k, sh * k);

    // Метки: то, что игрок ищет глазами.
    var list = opts.marks || [];
    for (var m = 0; m < list.length; m++) {
      var mk = list[m];
      g.beginPath();
      g.arc(ox + (mk.x - x0) * k, oy + (mk.y - y0) * k, mk.r || Math.max(2.2, k * 1.6), 0, Math.PI * 2);
      g.fillStyle = mk.color || '#fff2c4';
      g.fill();
      g.lineWidth = Math.max(1, k * 0.55);
      g.strokeStyle = 'rgba(40,30,6,.85)';
      g.stroke();
    }
    return true;
  }

  global.Play = {
    init: init,
    ready: ready,
    state: state,
    renderer: function () { return renderer; },
    on: on,
    canCommand: canCommand,
    handleTownFallen: handleTownFallen,
    finishGame: finishGame,
    /* Сколько держать ЛКМ по постройке, чтобы открыть правку. Наружу — потому
       что число одно на всю игру: по нему срабатывает удержание, о нём говорит
       подсказка, и им же меряет приёмка. */
    EDIT_HOLD_MS: EDIT_HOLD_MS,
    editAction: editAction,
    /* «Править» из таблички выбранного здания: тот же режим, что у удержания и
       двойного клика, но одним нажатием (js/hud.js). */
    editSelected: editSelected,
    /* Почему постройку нельзя править — словами для подписи кнопки. Пустая
       строка значит «можно»; правила одни на все входы. */
    editReject: editReject,
    /* Открыта ли правка и что в ней — для таблички и приёмки. */
    editInfo: editInfo,
    /* Стройка: что можно купить, взять в руки, повернуть и поставить. */
    BUILD_MENU: BUILD_MENU,
    buildOptions: buildOptions,
    buildInfo: buildInfo,
    beginBuild: beginBuild,
    cancelBuild: cancelBuild,
    buildAction: buildAction,
    setSquad: setSquad,
    beginOrder: beginOrder,
    cancelOrder: cancelOrder,
    orderAt: orderAt,
    stopArmy: stopArmy,
    diorama: diorama,
    start: start,
    startNet: startNet,
    stopNet: stopNet,
    applyNetCommand: applyNetCommand,
    applySnapshot: applySnapshot,
    tick: tick,
    draw: draw,
    pause: pause,
    resume: resume,
    showInMenu: showInMenu,
    isPlaying: isPlaying,
    resize: resize,
    checkCache: checkCache,
    fit: fit,
    focusVillager: focusVillager,
    focused: focused,
    setFocus: setFocus,
    villagerAt: villagerAt,
    focusHome: focusHome,
    toggleFollow: toggleFollow,
    toggleTopView: toggleTopView,
    zoom: zoom,
    bindInput: bindInput,
    stepKeys: stepKeys,
    selectBuilding: selectBuilding,
    setTextures: setTextures,
    setSprites: setSprites,
    paintThumbnail: paintThumbnail,
    /* Сколько идёт партия — словами, для меню паузы: «3 мин 12 с». */
    timeText: function () {
      var s = Math.floor(state.seconds);
      var m = Math.floor(s / 60);
      s = s % 60;
      return m ? m + ' мин ' + (s < 10 ? '0' : '') + s + ' с' : s + ' с';
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
