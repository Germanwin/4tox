/* probe.js — поддерживаемая копия внешней диагностической обвязки 4tox.
 *
 * ЧТО ЭТО. Отдельный файл, который НЕ входит в игру и не правит её исходники.
 * Он вставляется в страницу через CDP `Page.addScriptToEvaluateOnNewDocument`
 * ДО первого скрипта игры, находит уже загруженные модули (boot.js кладёт их
 * в window) и оборачивает их публичные функции тонкими обёртками. Обёртки
 * включаются только после `__passport.start()`; пока не включены, каждая
 * стоит одну проверку `if (!S.on)`.
 *
 * ЧЕМ ОТЛИЧАЕТСЯ ОТ evidence-копии (D02). Старая обёртка выглядела так:
 *
 *     try { return onCall.call(this, orig, arguments); }
 *     catch (e) { return orig.apply(this, arguments); }
 *
 * Если измерение падало ПОСЛЕ того, как оригинал уже выполнился, оригинал
 * вызывался второй раз. Это и был дефект повторного исполнения: игровая
 * функция с побочным эффектом выполнялась дважды, а исключение оригинала
 * подменялось исключением измерителя.
 *
 * Теперь API обёртки — `wrap(objName, fnName, hooks)`. Хуки только измеряют и
 * НЕ получают ссылку на оригинал:
 *
 *   hooks.before(args)                  -> sample (что угодно измерителя);
 *   hooks.after(sample, result, args)   -> ничего;
 *   hooks.error(sample, error, args)    -> ничего (оригинал уже бросил);
 *   hooks.async(sample, promise, args)  -> ничего; навешивает наблюдатель на
 *                                          ИСХОДНЫЙ Promise (обе ветки).
 *
 * Оригинал вызывается РОВНО ОДИН РАЗ, в одном месте. `this`, `arguments`,
 * результат и объект исключения сохраняются. `safeMeasure` ловит только
 * ошибки измерительных хуков, считает их в отдельном `probeErrors` и не
 * влияет ни на результат, ни на исключение игры. Асинхронный хук получает
 * исходный Promise и обязан вернуть управление, не подменяя его: наружу
 * уходит ТОТ ЖЕ Promise, повторной операции нет. Длительность синхронного
 * входа (`ms`) и время до расчёта Promise (`settledMs`) — разные поля.
 *
 * ЧТО СЧИТАЕТСЯ
 *   кадры      — свои rAF-интервалы (не игровые): когда браузер реально
 *                отдал кадр; плюс покадровая выборка состояния мира;
 *   секундные — раз в 1000 мс снимок Metrics.snapshot() и сетевых полей
 *                Play.state (steps, caughtUp, dropped, netEvery, netQueue…);
 *   снимки     — Serialize.apply на госте: seq, t хоста, smooth, длительность;
 *   отправки   — Net.snapshot на хосте: начало/конец, БАЙТЫ UTF-8, queue из
 *                ответа; сжатые байты — только если их вернул сервер;
 *   тики       — Play.tick: dt и длительность (шаг мира / тик клиента);
 *   draw/hud   — длительность отрисовки и интерфейса за кадр;
 *   события    — visibilitychange/focus/blur/pageshow/pagehide/freeze/resume;
 *   житель     — по одному выбранному id: x/y, цель снимка (_netTX/_netTY)
 *                в каждом кадре. Это и есть «трасса телепортаций».
 *
 * РАЗМЕР. 30000 кадров × 8 колонок Float64 = ~1,9 МБ на страницу, плюс
 * секундные записи. Всё фиксировано: длинная партия не увеличивает память
 * (запись по кольцу перезаписывает старое). Полные счётчики событий
 * (`counters()`) живут отдельно от колец: `retained` (сколько записей ещё
 * лежит) и `total` (сколько событий было всего) — разные величины.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  /* В браузере файл вставляется до игры: создаём singleton сразу. В Node
     (тесты) ничего не поднимаем сами — тест зовёт createProbe с своим env. */
  if (root && root.document && !root.__passport && api && api.createProbe) {
    root.__passport = api.createProbe(root, { autoInstall: true });
  }
})(typeof window !== 'undefined' ? window
  : (typeof globalThis !== 'undefined' ? globalThis : this), function (root) {
  'use strict';

  var VERSION = 3;

  var CAP_F = 30000;      // кадров
  var CAP_S = 4000;       // секундных записей (больше часа)
  var CAP_E = 500;        // событий видимости/фокуса
  var CAP_A = 2000;       // применённых снимков
  var CAP_N = 2000;       // отправленных снимков
  var CAP_T = 20000;      // тиков мира

  /* ------------------------------------------------------------- байты */

  /* В браузере — TextEncoder, в Node — Buffer.byteLength. Обе считают UTF-8;
     `String.length` для кириллицы даёт в два раза меньше байт, поэтому старая
     формула `JSON.stringify(body).length` как «байты» не годится. */
  function byteSize(text, env) {
    var s = String(text);
    var e = env || root || {};
    var B = (typeof Buffer !== 'undefined') ? Buffer : e.Buffer;
    if (B && typeof B.byteLength === 'function') {
      try { return B.byteLength(s, 'utf8'); } catch (err) { /* пробуем дальше */ }
    }
    var TE = e.TextEncoder || (typeof TextEncoder !== 'undefined' ? TextEncoder : null);
    if (TE) {
      try { return new TE().encode(s).byteLength; } catch (err) { /* пробуем дальше */ }
    }
    /* Последний резерв без библиотек: считаем UTF-8 вручную. */
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d <= 0xDFFF) { n += 4; i++; } else n += 3;
      } else n += 3;
    }
    return n;
  }

  /* ------------------------------------------------------------ фабрика */

  function createProbe(g, options) {
    g = g || root || {};
    options = options || {};

    function now() {
      return (g.performance && typeof g.performance.now === 'function')
        ? g.performance.now() : Date.now();
    }
    function unixNow() { return Date.now(); }
    function slot(cap, n) { return n % cap; }

    var S = {
      version: VERSION,
      on: false,
      framesOn: false,
      t0: now(),
      installed: {},
      instTries: 0,
      nF: 0,
      fT: new Float64Array(CAP_F), fSeq: new Float64Array(CAP_F),
      fSim: new Float64Array(CAP_F),
      fWX: new Float64Array(CAP_F), fWY: new Float64Array(CAP_F),
      fTX: new Float64Array(CAP_F), fTY: new Float64Array(CAP_F),
      fN: new Int32Array(CAP_F), fHid: new Uint8Array(CAP_F),
      nS: 0, sRec: new Array(CAP_S),
      nE: 0, eT: new Float64Array(CAP_E), eK: new Array(CAP_E),
      eUnix: new Float64Array(CAP_E),
      nA: 0, aT: new Float64Array(CAP_A), aSeq: new Float64Array(CAP_A),
      aHost: new Float64Array(CAP_A), aSmooth: new Int8Array(CAP_A),
      aMs: new Float64Array(CAP_A), aUnix: new Float64Array(CAP_A),
      nN: 0, nT: new Float64Array(CAP_N), nMs: new Float64Array(CAP_N),
      nBytes: new Float64Array(CAP_N), nQueue: new Float64Array(CAP_N),
      nGzip: new Int8Array(CAP_N), nOK: new Int8Array(CAP_N),
      nGzBytes: new Float64Array(CAP_N), nSettled: new Float64Array(CAP_N),
      nUnix: new Float64Array(CAP_N), nGen: new Int32Array(CAP_N),
      nTk: 0, kT: new Float64Array(CAP_T), kDt: new Float64Array(CAP_T),
      kMs: new Float64Array(CAP_T), kUnix: new Float64Array(CAP_T),
      watch: null,
      probeErrors: 0,
      probeErrorSamples: [],
      timer: null,
      rafWanted: false,
      rafScheduled: false,
      agg: {
        longTasks: 0, longTaskMs: 0, longTaskMax: 0,
        ticks: 0, tickMs: 0, drawMs: 0, hudMs: 0,
        applyCount: 0, applyMs: 0, sendCount: 0, sendMs: 0,
        hiddenChanges: 0, blurCount: 0, focusCount: 0
      },
      marks: []
    };

    /* --------------------------------------------------------- измерение */

    /* Единственное место, где ловятся ошибки измерителя. Оригинальную
       игровую функцию сюда не передают НИКОГДА: вызов оригинала — только в
       wrap(). Ошибка хука не меняет ни результат, ни исключение игры. */
    function safeMeasure(fn) {
      try {
        return fn();
      } catch (e) {
        S.probeErrors++;
        if (S.probeErrorSamples.length < 20) {
          S.probeErrorSamples.push(String((e && e.stack) || e));
        }
        return undefined;
      }
    }

    /* ------------------------------------------------------------- события */

    function ev(kind) {
      if (!S.on) return;
      var i = slot(CAP_E, S.nE);
      S.eK[i] = kind; S.eT[i] = now(); S.eUnix[i] = unixNow(); S.nE++;
      if (kind === 'hidden') S.agg.hiddenChanges++;
      if (kind === 'blur') S.agg.blurCount++;
      if (kind === 'focus') S.agg.focusCount++;
    }

    function bindEvents() {
      var d = g.document;
      if (!d || typeof d.addEventListener !== 'function') return;
      d.addEventListener('visibilitychange', function () { ev(d.hidden ? 'hidden' : 'visible'); });
      if (typeof g.addEventListener === 'function') {
        g.addEventListener('focus', function () { ev('focus'); });
        g.addEventListener('blur', function () { ev('blur'); });
        g.addEventListener('pageshow', function (e) { ev(e && e.persisted ? 'pageshow-bfcache' : 'pageshow'); });
        g.addEventListener('pagehide', function () { ev('pagehide'); });
      }
      d.addEventListener('freeze', function () { ev('freeze'); });
      d.addEventListener('resume', function () { ev('resume'); });
      /* Длинные задачи: единственный штатный способ увидеть, что главный
         поток был занят. Есть не во всех браузерах — тогда счётчик остаётся
         нулём, и это честно написано в ограничениях. */
      try {
        if (g.PerformanceObserver) {
          var po = new g.PerformanceObserver(function (list) {
            if (!S.on) return;
            list.getEntries().forEach(function (e) {
              S.agg.longTasks++;
              S.agg.longTaskMs += e.duration;
              if (e.duration > S.agg.longTaskMax) S.agg.longTaskMax = e.duration;
            });
          });
          po.observe({ entryTypes: ['longtask'] });
          S.installed.longtask = true;
        }
      } catch (e) { /* нет longtask — не ошибка */ }
    }

    /* --------------------------------------------------------------- кадры */

    function scheduleFrame() {
      if (!S.rafWanted || S.rafScheduled) return;
      if (typeof g.requestAnimationFrame !== 'function') return;
      S.rafScheduled = true;
      g.requestAnimationFrame(frameTick);
    }

    function frameTick() {
      S.rafScheduled = false;
      if (S.on && S.framesOn) {
        var t = now();
        var i = slot(CAP_F, S.nF);
        S.fT[i] = t;
        var P = g.Play && g.Play.state ? g.Play.state : null;
        S.fSeq[i] = P ? (P.netSeq || 0) : 0;
        S.fSim[i] = P ? (P.seconds || 0) : 0;
        S.fN[i] = P && P.villagers ? P.villagers.length : 0;
        S.fHid[i] = (g.document && g.document.hidden) ? 1 : 0;
        var v = null;
        if (S.watch != null && P && P.villagers) {
          for (var k = 0; k < P.villagers.length; k++) {
            if (P.villagers[k] && P.villagers[k].id === S.watch) { v = P.villagers[k]; break; }
          }
        }
        if (v) {
          S.fWX[i] = v.x; S.fWY[i] = v.y;
          S.fTX[i] = (typeof v._netTX === 'number') ? v._netTX : v.x;
          S.fTY[i] = (typeof v._netTY === 'number') ? v._netTY : v.y;
        } else {
          S.fWX[i] = NaN; S.fWY[i] = NaN; S.fTX[i] = NaN; S.fTY[i] = NaN;
        }
        S.nF++;
      }
      if (S.rafWanted && S.on && S.framesOn) scheduleFrame();
    }

    /* ------------------------------------------------------------ секундные */

    function secSample() {
      if (!S.on) return;
      var P = g.Play && g.Play.state ? g.Play.state : null;
      var M = g.Metrics;
      var rec = {
        t: Math.round(now() * 100) / 100, unix: unixNow(),
        vis: g.document ? g.document.visibilityState : '?',
        focus: g.document && typeof g.document.hasFocus === 'function' ? !!g.document.hasFocus() : null,
        role: P ? P.netRole : null,
        simSec: P ? Math.round((P.seconds || 0) * 1000) / 1000 : 0,
        netSeq: P ? (P.netSeq || 0) : 0,
        netEvery: P ? (P.netEvery || 0) : 0,
        netQueue: P ? (P.netQueue || 0) : 0,
        netGzip: P ? !!P.netGzip : false,
        netPing: P ? (P.netPing || 0) : 0,
        netBusy: P ? !!P.netBusy : false,
        netSilence: P ? (P.netSilence || 0) : 0,
        netStale: P ? !!P.netStale : false,
        netHostGone: P ? !!P.netHostGone : false,
        simDropped: P ? Math.round((P.simDropped || 0) * 1000) / 1000 : 0,
        running: P ? !!P.running : false,
        mode: P ? P.mode : null,
        nV: P && P.villagers ? P.villagers.length : 0,
        nB: P && P.buildings ? P.buildings.length : 0,
        fault: P ? !!P.faulted : false,
        probeErrors: S.probeErrors,
        mem: (g.performance && g.performance.memory)
          ? { used: g.performance.memory.usedJSHeapSize, total: g.performance.memory.totalJSHeapSize }
          : null
      };
      if (M && M.snapshot) { try { rec.m = M.snapshot(); } catch (e) { rec.mErr = String(e); } }
      rec.agg = {
        longTasks: S.agg.longTasks, longTaskMs: Math.round(S.agg.longTaskMs * 10) / 10,
        longTaskMax: Math.round(S.agg.longTaskMax * 10) / 10,
        ticks: S.agg.ticks, drawMs: Math.round(S.agg.drawMs * 10) / 10,
        hudMs: Math.round(S.agg.hudMs * 10) / 10,
        applyCount: S.agg.applyCount, applyMs: Math.round(S.agg.applyMs * 10) / 10,
        sendCount: S.agg.sendCount, sendMs: Math.round(S.agg.sendMs * 10) / 10,
        probeErrors: S.probeErrors
      };
      S.sRec[slot(CAP_S, S.nS)] = rec;
      S.nS++;
    }

    /* ------------------------------------------------------------- обёртки */

    /* Оригинал вызывается РОВНО ОДИН РАЗ. Хуки получают только sample,
       результат/исключение и arguments — ссылки на оригинал у них нет. */
    function wrap(objName, fnName, hooks) {
      hooks = hooks || {};
      var key = objName + '.' + fnName;
      if (S.installed[key]) return true;
      var owner = g[objName];
      if (!owner || typeof owner[fnName] !== 'function') return false;
      var orig = owner[fnName];
      var wrapped = function () {
        if (!S.on) return orig.apply(this, arguments);
        var receiver = this;
        var args = arguments;
        var sample = safeMeasure(function () {
          return typeof hooks.before === 'function' ? hooks.before(args) : undefined;
        });
        var result;
        try {
          /* ЕДИНСТВЕННОЕ место вызова оригинала. */
          result = orig.apply(receiver, args);
        } catch (error) {
          /* Бросаем ТОТ ЖЕ объект: hooks.error не может его подменить. */
          safeMeasure(function () {
            if (typeof hooks.error === 'function') hooks.error(sample, error, args);
          });
          throw error;
        }
        safeMeasure(function () {
          if (typeof hooks.after === 'function') hooks.after(sample, result, args);
        });
        var thenable = false;
        try {
          thenable = !!result && typeof result.then === 'function';
        } catch (e) { thenable = false; }
        if (thenable && typeof hooks.async === 'function') {
          /* Наблюдатель на ИСХОДНОМ Promise. Возвращаем не его, а result:
             цепочка `.then()` хука не подменяет результат игры. */
          safeMeasure(function () { hooks.async(sample, result, args); });
        }
        return result;
      };
      wrapped.__passport = true;
      owner[fnName] = wrapped;
      S.installed[key] = true;
      return true;
    }

    function install() {
      S.instTries++;
      var all = true;

      all = wrap('Play', 'tick', {
        before: function (args) { return { t0: now(), dt: args && args[0] }; },
        after: function (sample) {
          var ms = now() - sample.t0;
          S.agg.ticks++; S.agg.tickMs += ms;
          var i = slot(CAP_T, S.nTk);
          S.kT[i] = sample.t0; S.kDt[i] = sample.dt; S.kMs[i] = ms;
          S.kUnix[i] = unixNow();
          S.nTk++;
        }
      }) && all;

      all = wrap('Play', 'draw', {
        before: function () { return { t0: now() }; },
        after: function (sample) { S.agg.drawMs += now() - sample.t0; }
      }) && all;

      all = wrap('Hud', 'tick', {
        before: function () { return { t0: now() }; },
        after: function (sample) { S.agg.hudMs += now() - sample.t0; }
      }) && all;

      all = wrap('Serialize', 'apply', {
        before: function (args) {
          return { t0: now(), snap: args && args[1], opts: args && args[3] };
        },
        after: function (sample) {
          var ms = now() - sample.t0;
          var snap = sample.snap;
          var opts = sample.opts;
          S.agg.applyCount++; S.agg.applyMs += ms;
          var i = slot(CAP_A, S.nA);
          S.aT[i] = sample.t0;
          S.aSeq[i] = (snap && snap.seq !== undefined) ? snap.seq : -1;
          S.aHost[i] = (snap && snap.t !== undefined) ? snap.t : -1;
          S.aSmooth[i] = opts ? (opts.smooth ? 1 : 0) : -1;
          S.aMs[i] = ms;
          S.aUnix[i] = unixNow();
          S.nA++;
        }
      }) && all;

      all = wrap('Net', 'snapshot', {
        before: function (args) {
          var body = args && args[0];
          var bytes = -1;
          try { bytes = byteSize(JSON.stringify(body), g); } catch (e) { bytes = -1; }
          return { i: slot(CAP_N, S.nN), t0: now(), bytes: bytes, gen: -1 };
        },
        after: function (sample) {
          var ms = now() - sample.t0;
          var i = sample.i;
          var gen = ++S.nGen[i];
          sample.gen = gen;
          S.agg.sendCount++; S.agg.sendMs += ms;
          S.nT[i] = sample.t0; S.nMs[i] = ms; S.nBytes[i] = sample.bytes;
          S.nQueue[i] = -1; S.nGzip[i] = -1; S.nOK[i] = 0;
          S.nGzBytes[i] = -1; S.nSettled[i] = -1;
          S.nUnix[i] = unixNow();
          S.nN++;
        },
        async: function (sample, promise) {
          var i = sample.i;
          promise.then(function (res) {
            if (sample.gen < 0 || S.nGen[i] !== sample.gen) return res;
            S.nOK[i] = 1;
            S.nSettled[i] = now() - sample.t0;
            if (res) {
              if (typeof res.queue === 'number') S.nQueue[i] = res.queue;
              if (res.gzip !== undefined) S.nGzip[i] = res.gzip ? 1 : 0;
              /* Сжатые байты — только если сервер их правда вернул. Иначе
                 -1: ноль означал бы «ноль байт», а это неправда. */
              if (typeof res.gzipBytes === 'number') S.nGzBytes[i] = res.gzipBytes;
            }
            return res;
          }, function () {
            if (sample.gen < 0 || S.nGen[i] !== sample.gen) return;
            S.nOK[i] = -1;
            S.nSettled[i] = now() - sample.t0;
          });
        }
      }) && all;

      return !!(S.installed['Play.tick'] && S.installed['Serialize.apply']);
    }

    function tryInstall() {
      install();
      if (!(S.installed['Play.tick'] && S.installed['Serialize.apply'] && S.installed['Play.draw'])) {
        if (S.instTries < 600 && typeof g.setTimeout === 'function') g.setTimeout(tryInstall, 50); // ~30 с
      }
    }

    /* --------------------------------------------------------------- API */

    function ringStart(n, cap) { return n > cap ? (n % cap) : 0; }

    function counters() {
      return {
        on: S.on,
        framesOn: S.framesOn,
        frames: S.nF, secs: S.nS, events: S.nE,
        applies: S.nA, sends: S.nN, ticks: S.nTk,
        capacities: {
          frames: CAP_F, secs: CAP_S, events: CAP_E,
          applies: CAP_A, sends: CAP_N, ticks: CAP_T
        },
        wrapped: {
          frames: S.nF > CAP_F, secs: S.nS > CAP_S, events: S.nE > CAP_E,
          applies: S.nA > CAP_A, sends: S.nN > CAP_N, ticks: S.nTk > CAP_T
        },
        probeErrors: S.probeErrors
      };
    }

    var api = {
      version: VERSION,
      start: function (opts) {
        opts = opts || {};
        /* Счётчики движка (mapgen2/js/metrics.js) по умолчанию выключены. Их
           включает не игра, а диагностика: без этого Metrics.snapshot() отдаёт
           нули, и «поля без писателя» выглядят как «ничего не происходит». */
        if (g.Metrics) {
          try { g.Metrics.on = true; if (g.Metrics.reset) g.Metrics.reset(); } catch (e) { /* пусто */ }
        }
        S.on = true;
        S.framesOn = opts.frames !== false;
        S.t0 = now();
        if (!S.timer && typeof g.setInterval === 'function') S.timer = g.setInterval(secSample, 1000);
        if (S.framesOn) { S.rafWanted = true; scheduleFrame(); }
        return true;
      },
      stop: function () {
        S.on = false;
        S.rafWanted = false;
        if (S.timer) {
          if (typeof g.clearInterval === 'function') g.clearInterval(S.timer);
          S.timer = null;
        }
        return true;
      },
      wrap: wrap,
      install: install,
      safeMeasure: safeMeasure,
      byteSize: function (text) { return byteSize(text, g); },
      counters: counters,
      watch: function (id) { S.watch = (id === null || id === undefined) ? null : id; return S.watch; },
      /* Автовыбор: житель, у которого расхождение «где нарисован» и «где
         хоста» самое большое, — то есть уже едущий, а не стоящий. */
      pickMover: function () {
        var P = g.Play && g.Play.state ? g.Play.state : null;
        if (!P || !P.villagers || !P.villagers.length) return null;
        var best = null, bestD = -1;
        for (var i = 0; i < P.villagers.length; i++) {
          var v = P.villagers[i];
          if (!v) continue;
          var tx = (typeof v._netTX === 'number') ? v._netTX : v.x;
          var ty = (typeof v._netTY === 'number') ? v._netTY : v.y;
          var d = Math.abs(tx - v.x) + Math.abs(ty - v.y);
          if (d > bestD) { bestD = d; best = v.id; }
        }
        S.watch = best;
        return best;
      },
      mark: function (label) {
        S.marks.push({ t: Math.round(now() * 100) / 100, unix: unixNow(), label: String(label) });
        return true;
      },
      info: function () {
        return {
          inst: Object.keys(S.installed), tries: S.instTries, on: S.on,
          framesOn: S.framesOn,
          hidden: g.document ? g.document.hidden : null,
          vis: g.document ? g.document.visibilityState : null,
          focus: g.document && typeof g.document.hasFocus === 'function' ? !!g.document.hasFocus() : null,
          role: g.Play && g.Play.state ? g.Play.state.netRole : null,
          build: (g.Play && g.Play.state && g.Play.state.build) || g.BUILD_ID || null,
          ua: g.navigator ? g.navigator.userAgent : null,
          probeErrors: S.probeErrors,
          probeErrorSamples: S.probeErrorSamples.slice()
        };
      },
      dump: function () {
        var i, k, n, start;
        var frames = [];
        n = Math.min(S.nF, CAP_F); start = ringStart(S.nF, CAP_F);
        for (k = 0; k < n; k++) {
          i = (start + k) % CAP_F;
          frames.push([
            Math.round(S.fT[i] * 100) / 100,
            S.fSeq[i], Math.round(S.fSim[i] * 1000) / 1000,
            Math.round(S.fWX[i] * 1000) / 1000, Math.round(S.fWY[i] * 1000) / 1000,
            Math.round(S.fTX[i] * 1000) / 1000, Math.round(S.fTY[i] * 1000) / 1000,
            S.fN[i], S.fHid[i]
          ]);
        }
        var applies = [];
        n = Math.min(S.nA, CAP_A); start = ringStart(S.nA, CAP_A);
        for (k = 0; k < n; k++) {
          i = (start + k) % CAP_A;
          /* [t, seq, hostT, smooth, ms, unix] — старые индексы 0..4 целы. */
          applies.push([Math.round(S.aT[i] * 100) / 100, S.aSeq[i],
            S.aHost[i], S.aSmooth[i], Math.round(S.aMs[i] * 1000) / 1000,
            S.aUnix[i]]);
        }
        var sends = [];
        n = Math.min(S.nN, CAP_N); start = ringStart(S.nN, CAP_N);
        for (k = 0; k < n; k++) {
          i = (start + k) % CAP_N;
          /* [t, ms, bytesUtf8, queue, gzip, ok, gzipBytes, unix, settledMs].
             -1 у очереди/gzip/сжатых байт означает «неизвестно», не ноль. */
          sends.push([Math.round(S.nT[i] * 100) / 100, Math.round(S.nMs[i] * 100) / 100,
            S.nBytes[i], S.nQueue[i], S.nGzip[i], S.nOK[i],
            S.nGzBytes[i], S.nUnix[i],
            S.nSettled[i] < 0 ? -1 : Math.round(S.nSettled[i] * 100) / 100]);
        }
        var ticks = [];
        n = Math.min(S.nTk, CAP_T); start = ringStart(S.nTk, CAP_T);
        for (k = 0; k < n; k++) {
          i = (start + k) % CAP_T;
          ticks.push([Math.round(S.kT[i] * 100) / 100, S.kDt[i],
            Math.round(S.kMs[i] * 1000) / 1000, S.kUnix[i]]);
        }
        var secs = [];
        n = Math.min(S.nS, CAP_S); start = ringStart(S.nS, CAP_S);
        for (k = 0; k < n; k++) {
          i = (start + k) % CAP_S;
          if (S.sRec[i]) secs.push(S.sRec[i]);
        }
        var events = [];
        n = Math.min(S.nE, CAP_E); start = ringStart(S.nE, CAP_E);
        for (k = 0; k < n; k++) {
          i = (start + k) % CAP_E;
          events.push([Math.round(S.eT[i] * 100) / 100, S.eK[i], S.eUnix[i]]);
        }
        return {
          v: S.version,
          info: api.info(),
          page: g.location ? g.location.href.replace(/token=[^&]+/g, 'token=<hidden>') : '',
          watch: S.watch,
          t0: S.t0,
          frames: frames, secs: secs, events: events,
          applies: applies, sends: sends, ticks: ticks,
          marks: S.marks, agg: S.agg,
          counters: counters(),
          probeErrors: S.probeErrors,
          probeErrorSamples: S.probeErrorSamples.slice(),
          nowWall: unixNow()
        };
      }
    };

    /* В тестах probe создаётся без DOM; там bindEvents — no-op. */
    if (options.bindEvents !== false) bindEvents();
    if (options.autoInstall) tryInstall();

    return api;
  }

  return { version: VERSION, createProbe: createProbe, byteSize: byteSize };
});
