/* metrics.js — переключаемые счётчики мира.

   Зачем отдельный модуль. Жалобы («лагерь работает неравномерно», «чем дольше
   партия, тем хуже», «войска зависли», «после фона всё замирает», «у друга
   0 fps») нельзя ни подтвердить, ни опровергнуть на глаз. Нужны числа:
   сколько поисков пути, сколько узлов A* рассмотрено, сколько раз поиск
   упёрся в бюджет, сколько занял шаг мира, сколько — кадр, сколько весит
   снимок, сколько он строится и применяется, сколько времени догоняется
   фоновый долг, сколько секунд выброшено, сколько жителей родилось и почему
   не родились. Собирать их «на каждом кадре с console.log» нельзя —
   логирование само становится нагрузкой и меняет то, что меришь.

   Поэтому здесь ОДИН объект счётчиков и один выключатель. Выключенные счётчики
   почти ничего не стоят: горячий цикл A* складывает узлы в локальную
   переменную и пишет в объект один раз за поиск, а не на каждом шаге.

   Модуль ничего не решает и не влияет на мир: только считает. Выключатель —
   `Metrics.on = true` (в игре — `__game.metrics.on`); оболочка и приёмки
   читают `Metrics.snapshot()` и `Metrics.reset()`.

   Наружу — только чтение, сброс и короткие функции-инкременты (`Metrics.frame`,
   `Metrics.step`, `Metrics.snap`, `Metrics.apply`, `Metrics.catchUp`,
   `Metrics.plan`, `Metrics.birth`, `Metrics.combat`, `Metrics.command`).
   Счётчики не ездят по сети и не попадают в снимок: это диагностика, а не
   состояние партии.

   Кто что пишет (важно для отчёта: поле, у которого нет писателя, — это
   «не измерено», а не ноль):
     mapgen2/js/villager.js   — paths/nodes/fails/budgetHits/plans/planFails/
                                unreachableHits/blockedBuilds/areaBuilds;
     game/js/boot.js          — steps/stepMs/longSteps/maxStepMs, frames и
                                frame*, caughtUp/dropped/catchUpMs/debtSec;
     game/js/play.js, net.js  — snaps/snapMs/snapJsonMs/snapBytes/snapGzBytes/
                                snapMaxBytes/snapApplyMs/snapQueueKB,
                                commands*;
     mapgen2/js/session.js    — births/birthBlocked…/birthPending/population/
                                housingFree;
     mapgen2/js/combat.js     — combatMs/attacks/damage;
     mapgen2/tools/profile.js — steps/snaps и всё, что относится к прогону,
                                вместо оболочки.
   Пока писателя нет, поле остаётся нулём, и profile.js печатает список
   «поля без писателя» отдельной строкой. */
(function (global) {
  'use strict';

  function blank() {
    return {
      /* Поиск пути. paths — сколько раз позвали findPath, nodes — сколько
         клеток разобрали, fails — сколько поисков не нашли путь,
         budgetHits — сколько упёрлись в предел и были отложены до следующего
         кадра, pathRetries — сколько раз житель пришёл повторять поиск после
         такого упора (растёт — значит бюджет режет работу, а не «пути нет»),
         pathNodesMax — худший один поиск по клеткам. */
      paths: 0, nodes: 0, fails: 0, budgetHits: 0, pathRetries: 0, pathNodesMax: 0,
      /* Планирование работы: сколько раз выбирали цель (plans), сколько раз не
         выбрали (planFails), и разбивка по видам (plansByKind: toward, tree,
         yard, wander, patrol, order). Разбивку заполняет тот, кто знает вид. */
      plans: 0, planFails: 0, plansByKind: {},
      /* Кэши: сколько раз пересобирали карту занятых клеток и связные области,
         сколько это заняло (areasMs) и сколько раз менялась версия карты
         (blockedVersionChurn — рост при спокойном мире значит, что версия
         мигает и кэш пересобирается впустую). */
      blockedBuilds: 0, areaBuilds: 0, blockedVersionChurn: 0, areasMs: 0,
      unreachableHits: 0,
      /* Шаг мира. stepMs — суммарное время шагов, steps — их число,
         longSteps — шаги дольше LONG_STEP_MS, maxStepMs — худший шаг. */
      steps: 0, stepMs: 0, longSteps: 0, maxStepMs: 0,
      /* Кадр оболочки целиком (rAF → draw): frames, сумма, худший, и сколько
         кадров дольше 16/33/50 мс. Это то, что игрок видит как «плавно» или
         «замерзло»; счётчики попадают сюда из boot.js, а не из движка. */
      frames: 0, frameMs: 0, frameMaxMs: 0,
      frameOver16: 0, frameOver33: 0, frameOver50: 0,
      /* Догон фонового времени (boot.js → advance): caughtUp — сколько секунд
         мира догнали, dropped — сколько выбросили по MAX_DEBT, catchUpMs и
         catchUpMaxMs — сколько это стоило стенными мс, debtSec — текущий долг
         на момент последнего вызова. */
      caughtUp: 0, dropped: 0, catchUpMs: 0, catchUpMaxMs: 0, debtSec: 0,
      /* Снимок: сколько сделано, сколько заняли сборка объекта (snapMs),
         JSON.stringify (snapJsonMs) и gzip (snapGzMs), сколько это байт
         (snapBytes сырых, snapGzBytes сжатых, snapMaxBytes худший сырой),
         сколько заняло применение на клиенте (snapApplyMs/snapApplyMaxMs) и
         очередь отстающего потока (snapQueueKB — то, по чему хост редеет). */
      snaps: 0, snapMs: 0, snapJsonMs: 0, snapBytes: 0, snapGzBytes: 0,
      snapGzMs: 0, snapMaxBytes: 0, snapApplyMs: 0, snapApplyMaxMs: 0,
      snapQueueKB: 0,
      /* Заселение: сколько родилось (births) и сколько попыток не дало места,
         с причиной: housing — нет свободного жилья, spot — жильё есть, но
         клетки у двери заняты, pending — попытка отложена на повтор, blocked —
         прочие отказы. population/housingFree — состояние на конец прогона. */
      births: 0, birthBlocked: 0, birthBlockedHousing: 0, birthBlockedSpot: 0,
      birthPending: 0, population: 0, housingFree: 0,
      /* Бой: сколько мс занял Combat.tick суммарно, сколько нанесено ударов и
         сколько урона. Дорогой бой при малом числе воинов — отдельная
         причина «замираний», и её нельзя путать с жителями. */
      combatMs: 0, attacks: 0, damage: 0,
      /* Команды игроков: сколько пришло, сколько применено, отклонено,
         просрочено, и худшая задержка от отправки (n) до применения. */
      commandsSeen: 0, commandsApplied: 0, commandsRejected: 0,
      commandsExpired: 0, cmdLatencyMaxMs: 0,
      /* Память: heapUsed и heapUsed после GC (если прогон с --expose-gc).
         Сравнивать только при одинаковом числе существ: рост населения сам по
         себе не утечка. */
      memMB: 0, heapGcMB: 0
    };
  }

  var counters = blank();

  /* Сколько шаг считается «долгим». 16 мс — кадр 60 к/с; всё, что дольше,
     видно как подёргивание. Кадр — то же число. */
  var LONG_STEP_MS = 16;

  function reset() {
    counters = blank();
    return counters;
  }

  function copy(obj) {
    var out = {};
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    }
    return out;
  }

  function snapshot() {
    var out = copy(counters);
    out.plansByKind = copy(counters.plansByKind);
    /* Часы и догон в секундах — под именами из контракта. Сами поля остались
       прежними (`caughtUp`/`dropped`), чтобы не сломать тех, кто их уже
       читает. */
    out.caughtUpSec = counters.caughtUp;
    out.droppedSec = counters.dropped;
    out.on = !!api.on;
    return out;
  }

  /* Один шаг мира: время и число. Зовётся оболочкой вокруг тика и приёмкой
     вокруг того же тика — чтобы «в игре» и «в замере» было одно и то же
     число. */
  function step(ms) {
    if (!api.on) return;
    counters.steps++;
    counters.stepMs += ms;
    if (ms > LONG_STEP_MS) counters.longSteps++;
    if (ms > counters.maxStepMs) counters.maxStepMs = ms;
  }

  /* Один кадр оболочки целиком (rAF → draw). Оболочка зовёт после отрисовки;
     сюда попадает и мир, и рендер — то, что игрок видит как плавность. */
  function frame(ms) {
    if (!api.on) return;
    counters.frames++;
    counters.frameMs += ms;
    if (ms > counters.frameMaxMs) counters.frameMaxMs = ms;
    if (ms > 16) counters.frameOver16++;
    if (ms > 33) counters.frameOver33++;
    if (ms > 50) counters.frameOver50++;
  }

  /* Снимок: ms — сборка объекта, bytes — длина готового JSON.
     jsonMs — JSON.stringify (если меряли), gzBytes/gzMs — сжатие. Все
     аргументы после bytes необязательны: старый вызов snap(ms, bytes) жив. */
  function snap(ms, bytes, jsonMs, gzBytes, gzMs) {
    if (!api.on) return;
    counters.snaps++;
    counters.snapMs += ms;
    counters.snapBytes += bytes;
    if (bytes > counters.snapMaxBytes) counters.snapMaxBytes = bytes;
    if (jsonMs) counters.snapJsonMs += jsonMs;
    if (gzBytes) counters.snapGzBytes += gzBytes;
    if (gzMs) counters.snapGzMs += gzMs;
  }

  /* Применение снимка на клиенте (сверка по id, обновление спрайтов). */
  function apply(ms) {
    if (!api.on) return;
    counters.snapApplyMs += ms;
    if (ms > counters.snapApplyMaxMs) counters.snapApplyMaxMs = ms;
  }

  /* Очередь отстающего потока в сжатых байтах — по ней хост редеет. */
  function snapQueue(kb) {
    if (!api.on) return;
    counters.snapQueueKB = kb;
  }

  /* Худший один поиск по числу разобранных клеток. */
  function pathNodes(n) {
    if (!api.on) return;
    if (n > counters.pathNodesMax) counters.pathNodesMax = n;
  }

  /* Повтор поиска после упора в бюджет: житель пришёл снова. */
  function pathRetry() {
    if (!api.on) return;
    counters.pathRetries++;
  }

  /* Планирование работы; kind — вид цели (toward/tree/yard/wander/patrol/
     order). Неизвестный вид попадает в счётчик как есть: лучше строка, чем
     потерянное число. */
  function plan(kind) {
    if (!api.on) return;
    counters.plans++;
    if (!kind) return;
    counters.plansByKind[kind] = (counters.plansByKind[kind] || 0) + 1;
  }

  /* Заселение. kind: 'born' | 'housing' | 'spot' | 'pending' | 'blocked'.
     Без kind считается «прочий отказ» — так старый код не потеряет попытку. */
  function birth(kind, n) {
    if (!api.on) return;
    var k = n || 1;
    if (kind === 'born') { counters.births += k; return; }
    counters.birthBlocked += k;
    if (kind === 'housing') counters.birthBlockedHousing += k;
    else if (kind === 'spot') counters.birthBlockedSpot += k;
    else if (kind === 'pending') counters.birthPending += k;
  }

  function combat(ms, hits, dmg) {
    if (!api.on) return;
    counters.combatMs += ms || 0;
    counters.attacks += hits || 0;
    counters.damage += dmg || 0;
  }

  /* Команда игрока. state: 'seen' | 'applied' | 'rejected' | 'expired';
     latencyMs — от отправки (n) до применения, только для applied. */
  function command(state, latencyMs) {
    if (!api.on) return;
    if (state === 'applied') counters.commandsApplied++;
    else if (state === 'rejected') counters.commandsRejected++;
    else if (state === 'expired') counters.commandsExpired++;
    else counters.commandsSeen++;
    if (latencyMs > counters.cmdLatencyMaxMs) counters.cmdLatencyMaxMs = latencyMs;
  }

  /* Догон: ms — стоимость вызова, sec — сколько мира догнали, droppedSec —
     сколько выбросили. */
  function catchUp(ms, sec, droppedSec) {
    if (!api.on) return;
    counters.caughtUp += sec || 0;
    counters.dropped += droppedSec || 0;
    counters.catchUpMs += ms || 0;
    if (ms > counters.catchUpMaxMs) counters.catchUpMaxMs = ms;
  }

  function debt(sec) {
    if (!api.on) return;
    counters.debtSec = sec || 0;
  }

  /* Память. gcMB — после GC, если прогон с --expose-gc: тогда видно, растёт
     ли ЖИВОЕ, а не мусор. */
  function mem(mb, gcMB) {
    if (!api.on) return;
    counters.memMB = mb || 0;
    if (gcMB !== undefined) counters.heapGcMB = gcMB || 0;
  }

  function population(n, free) {
    if (!api.on) return;
    counters.population = n || 0;
    counters.housingFree = free || 0;
  }

  var api = {
    on: false,
    reset: reset,
    snapshot: snapshot,
    step: step,
    frame: frame,
    snap: snap,
    apply: apply,
    snapQueue: snapQueue,
    pathNodes: pathNodes,
    pathRetry: pathRetry,
    plan: plan,
    birth: birth,
    combat: combat,
    command: command,
    catchUp: catchUp,
    debt: debt,
    mem: mem,
    population: population,
    LONG_STEP_MS: LONG_STEP_MS,
    fresh: blank
  };

  /* `Metrics.on = true` — включить. Читатели счётчиков берут `Metrics.counters`
     и пишут в него напрямую: вызов функции на каждую клетку A* дороже, чем
     сама клетка. */
  Object.defineProperty(api, 'counters', {
    get: function () { return counters; },
    enumerable: true
  });

  global.Metrics = api;
})(typeof window !== 'undefined' ? window : globalThis);
