/* metrics.js — переключаемые счётчики мира.

   Зачем отдельный модуль. Жалобы («лагерь работает неравномерно», «чем дольше
   партия, тем хуже», «войска зависли») нельзя ни подтвердить, ни опровергнуть
   на глаз. Нужны числа: сколько поисков пути, сколько узлов A* рассмотрено,
   сколько раз поиск упёрся в бюджет, сколько занял шаг мира, сколько весит
   снимок. Собирать их «на каждом кадре с console.log» нельзя — логирование
   само становится нагрузкой и меняет то, что меришь.

   Поэтому здесь ОДИН объект счётчиков и один выключатель. Выключенные счётчики
   почти ничего не стоят: горячий цикл A* складывает узлы в локальную
   переменную и пишет в объект один раз за поиск, а не на каждом шаге.

   Модуль ничего не решает и не влияет на мир: только считает. Выключатель —
   `Metrics.on = true` (в игре — `__game.metrics.on(true)`); оболочка и приёмки
   читают `Metrics.snapshot()` и `Metrics.reset()`.

   Наружу — только чтение и сброс. Счётчики не ездят по сети и не попадают в
   снимок: это диагностика, а не состояние партии. */
(function (global) {
  'use strict';

  function blank() {
    return {
      /* Поиск пути. paths — сколько раз позвали findPath, nodes — сколько
         клеток разобрали, fails — сколько поисков не нашли путь,
         budgetHits — сколько упёрлись в предел и были отложены до следующего
         кадра. */
      paths: 0, nodes: 0, fails: 0, budgetHits: 0,
      /* Планирование работы: сколько раз выбирали цель и сколько раз не
         выбрали (нет дерева/пути). */
      plans: 0, planFails: 0,
      /* Кэши: сколько раз пересобирали карту занятых клеток и связные
         области. Рост этих чисел при спокойном мире — признак мигающей
         версии карты. */
      blockedBuilds: 0, areaBuilds: 0, unreachableHits: 0,
      /* Шаг мира. stepMs — суммарное время шагов, steps — их число,
         longSteps — шаги дольше LONG_STEP_MS, maxStepMs — худший шаг. */
      steps: 0, stepMs: 0, longSteps: 0, maxStepMs: 0,
      /* Снимок: сколько сделано, сколько заняли сериализация и JSON, сколько
         это байт. */
      snaps: 0, snapMs: 0, snapBytes: 0, snapMaxBytes: 0,
      /* Заселение: сколько детей родилось и сколько попыток осталось без
         места. */
      births: 0, birthBlocked: 0,
      /* Бюджет часов: сколько секунд мира догнали и сколько выбросили, чтобы
         не застрять (game/js/boot.js). */
      caughtUp: 0, dropped: 0,
      /* Худший кадр целиком (ставит оболочка): мс. */
      frameMaxMs: 0
    };
  }

  var counters = blank();

  /* Сколько шаг считается «долгим». 16 мс — кадр 60 к/с; всё, что дольше,
     видно как подёргивание. */
  var LONG_STEP_MS = 16;

  function reset() {
    counters = blank();
    return counters;
  }

  function snapshot() {
    var out = {};
    for (var k in counters) {
      if (Object.prototype.hasOwnProperty.call(counters, k)) out[k] = counters[k];
    }
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

  /* Снимок: ms — время сериализации, bytes — длина готового JSON. */
  function snap(ms, bytes) {
    if (!api.on) return;
    counters.snaps++;
    counters.snapMs += ms;
    counters.snapBytes += bytes;
    if (bytes > counters.snapMaxBytes) counters.snapMaxBytes = bytes;
  }

  var api = {
    on: false,
    reset: reset,
    snapshot: snapshot,
    step: step,
    snap: snap,
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
