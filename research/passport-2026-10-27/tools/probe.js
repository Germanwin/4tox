/* probe.js — внешняя диагностическая обвязка для паспорта 4tox.
 *
 * ЧТО ЭТО. Отдельный файл, который НЕ входит в игру и не правит её исходники.
 * Он вставляется в страницу через CDP `Page.addScriptToEvaluateOnNewDocument`
 * ДО первого скрипта игры, находит уже загруженные модули (boot.js кладёт их
 * в window) и оборачивает их публичные функции тонкими обёртками. Обёртки
 * включаются только после `__passport.start()`; пока не включены, каждая
 * стоит одну проверку `if (!S.on)`.
 *
 * ПОЧЕМУ ТАК. Игру нельзя править в этом поручении, а измерить нужно именно
 * её. Обёртка снаружи даёт те же числа и не меняет поведение: она ничего не
 * решает и ничего не подменяет, только считает и складывает в кольцевые
 * буферы фиксированного размера (память не растёт с длиной партии).
 *
 * ЧТО СЧИТАЕТСЯ
 *   кадры      — свои rAF-интервалы (не игровые): когда браузер реально
 *                отдал кадр; плюс покадровая выборка состояния мира;
 *   секундные — раз в 1000 мс снимок Metrics.snapshot() и сетевых полей
 *                Play.state (steps, caughtUp, dropped, netEvery, netQueue…);
 *   снимки     — Serialize.apply на госте: seq, t хоста, smooth, длительность;
 *   отправки   — Net.snapshot на хосте: начало/конец, байты, queue из ответа;
 *   тики       — Play.tick: dt и длительность (шаг мира / тик клиента);
 *   draw/hud   — длительность отрисовки и интерфейса за кадр;
 *   события    — visibilitychange/focus/blur/pageshow/pagehide/freeze/resume;
 *   житель     — по одному выбранному id: x/y, цель снимка (_netTX/_netTY)
 *                в каждом кадре. Это и есть «трасса телепортаций».
 *
 * ВЫКЛЮЧАТЕЛЬ. `__passport.start({frames:true})` включает покадровую выборку,
 * `__passport.start({frames:false})` — только секундные счётчики (лёгкий
 * режим). `__passport.stop()` выключает. По умолчанию выключено.
 *
 * РАЗМЕР. 30000 кадров × 8 колонок Float64 = ~1,9 МБ на страницу, плюс
 * секундные записи. Всё фиксировано: длинная партия не увеличивает память
 * (запись по кольцу перезаписывает старое).
 */
(function (g) {
  'use strict';
  if (g.__passport) return;

  var CAP_F = 30000;      // кадров
  var CAP_S = 4000;       // секундных записей (больше часа)
  var CAP_E = 500;        // событий видимости/фокуса
  var CAP_A = 2000;       // применённых снимков
  var CAP_N = 2000;       // отправленных снимков
  var CAP_T = 20000;      // тиков мира

  function now() {
    return (g.performance && g.performance.now) ? g.performance.now() : Date.now();
  }
  function slot(cap, n) { return n % cap; }

  var S = {
    version: 2,
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
    nA: 0, aT: new Float64Array(CAP_A), aSeq: new Float64Array(CAP_A),
    aHost: new Float64Array(CAP_A), aSmooth: new Int8Array(CAP_A),
    aMs: new Float64Array(CAP_A),
    nN: 0, nT: new Float64Array(CAP_N), nMs: new Float64Array(CAP_N),
    nBytes: new Float64Array(CAP_N), nQueue: new Float64Array(CAP_N),
    nGzip: new Int8Array(CAP_N), nOK: new Int8Array(CAP_N),
    nTk: 0, kT: new Float64Array(CAP_T), kDt: new Float64Array(CAP_T),
    kMs: new Float64Array(CAP_T),
    watch: null,
    agg: {
      longTasks: 0, longTaskMs: 0, longTaskMax: 0,
      ticks: 0, tickMs: 0, drawMs: 0, hudMs: 0,
      applyCount: 0, applyMs: 0, sendCount: 0, sendMs: 0,
      hiddenChanges: 0, blurCount: 0, focusCount: 0
    },
    marks: []
  };

  /* ------------------------------------------------------------- события */

  function ev(kind) {
    if (!S.on) return;
    var i = slot(CAP_E, S.nE);
    S.eK[i] = kind; S.eT[i] = now(); S.nE++;
    if (kind === 'hidden') S.agg.hiddenChanges++;
    if (kind === 'blur') S.agg.blurCount++;
    if (kind === 'focus') S.agg.focusCount++;
  }

  function bindEvents() {
    var d = g.document;
    d.addEventListener('visibilitychange', function () { ev(d.hidden ? 'hidden' : 'visible'); });
    g.addEventListener('focus', function () { ev('focus'); });
    g.addEventListener('blur', function () { ev('blur'); });
    g.addEventListener('pageshow', function (e) { ev(e && e.persisted ? 'pageshow-bfcache' : 'pageshow'); });
    g.addEventListener('pagehide', function () { ev('pagehide'); });
    d.addEventListener('freeze', function () { ev('freeze'); });
    d.addEventListener('resume', function () { ev('resume'); });
    /* Длинные задачи: единственный штатный способ увидеть, что главный поток
       был занят. Есть не во всех браузерах — тогда счётчик остаётся нулём, и
       это честно написано в LIMITATIONS. */
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

  function frameTick() {
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
    g.requestAnimationFrame(frameTick);
  }

  /* ------------------------------------------------------------ секундные */

  function secSample() {
    if (!S.on) return;
    var P = g.Play && g.Play.state ? g.Play.state : null;
    var M = g.Metrics;
    var rec = {
      t: Math.round(now() * 100) / 100, unix: Date.now(),
      vis: g.document ? g.document.visibilityState : '?',
      focus: g.document ? !!g.document.hasFocus() : null,
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
      sendCount: S.agg.sendCount, sendMs: Math.round(S.agg.sendMs * 10) / 10
    };
    S.sRec[slot(CAP_S, S.nS)] = rec;
    S.nS++;
  }

  /* ------------------------------------------------------------- обёртки */

  function wrap(objName, fnName, onCall) {
    var key = objName + '.' + fnName;
    if (S.installed[key]) return true;
    var o = g[objName];
    if (!o || typeof o[fnName] !== 'function') return false;
    var orig = o[fnName];
    var w = function () {
      if (!S.on) return orig.apply(this, arguments);
      try { return onCall.call(this, orig, arguments); } catch (e) { return orig.apply(this, arguments); }
    };
    w.__passport = true;
    o[fnName] = w;
    S.installed[key] = true;
    return true;
  }

  function install() {
    S.instTries++;
    var all = true;

    all = wrap('Play', 'tick', function (orig, args) {
      var dt = args && args[0];
      var t0 = now();
      var r = orig.apply(this, args);
      var ms = now() - t0;
      S.agg.ticks++; S.agg.tickMs += ms;
      var i = slot(CAP_T, S.nTk);
      S.kT[i] = t0; S.kDt[i] = dt; S.kMs[i] = ms;
      S.nTk++;
      return r;
    }) && all;

    all = wrap('Play', 'draw', function (orig, args) {
      var t0 = now();
      var r = orig.apply(this, args);
      S.agg.drawMs += now() - t0;
      return r;
    }) && all;

    all = wrap('Hud', 'tick', function (orig, args) {
      var t0 = now();
      var r = orig.apply(this, args);
      S.agg.hudMs += now() - t0;
      return r;
    }) && all;

    all = wrap('Serialize', 'apply', function (orig, args) {
      var snap = args && args[1];
      var opts = args && args[3];
      var t0 = now();
      var r = orig.apply(this, args);
      var ms = now() - t0;
      S.agg.applyCount++; S.agg.applyMs += ms;
      var i = slot(CAP_A, S.nA);
      S.aT[i] = t0;
      S.aSeq[i] = (snap && snap.seq !== undefined) ? snap.seq : -1;
      S.aHost[i] = (snap && snap.t !== undefined) ? snap.t : -1;
      S.aSmooth[i] = opts ? (opts.smooth ? 1 : 0) : -1;
      S.aMs[i] = ms;
      S.nA++;
      return r;
    }) && all;

    all = wrap('Net', 'snapshot', function (orig, args) {
      var body = args && args[0];
      var bytes = 0;
      try { bytes = JSON.stringify(body).length; } catch (e) { bytes = -1; }
      var t0 = now();
      var p = orig.apply(this, args);
      var ms = now() - t0;
      S.agg.sendCount++; S.agg.sendMs += ms;
      var i = slot(CAP_N, S.nN);
      S.nT[i] = t0; S.nMs[i] = ms; S.nBytes[i] = bytes;
      S.nQueue[i] = -1; S.nGzip[i] = -1; S.nOK[i] = 0;
      S.nN++;
      if (p && p.then) {
        p.then(function (res) {
          S.nOK[i] = 1;
          if (res) {
            if (typeof res.queue === 'number') S.nQueue[i] = res.queue;
            if (res.gzip !== undefined) S.nGzip[i] = res.gzip ? 1 : 0;
          }
          return res;
        }, function () { S.nOK[i] = -1; });
      }
      return p;
    }) && all;

    return !!(S.installed['Play.tick'] && S.installed['Serialize.apply']);
  }

  function tryInstall() {
    install();
    if (!(S.installed['Play.tick'] && S.installed['Serialize.apply'] && S.installed['Play.draw'])) {
      if (S.instTries < 600) g.setTimeout(tryInstall, 50);  // ~30 с
    }
  }

  /* --------------------------------------------------------------- API */

  g.__passport = {
    version: S.version,
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
      if (!S.timer) S.timer = g.setInterval(secSample, 1000);
      if (!S.raf) { S.raf = true; g.requestAnimationFrame(frameTick); }
      return true;
    },
    stop: function () {
      S.on = false;
      if (S.timer) { g.clearInterval(S.timer); S.timer = null; }
      return true;
    },
    watch: function (id) { S.watch = (id === null || id === undefined) ? null : id; return S.watch; },
    /* Автовыбор: житель, у которого расхождение «где нарисован» и «где у
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
    mark: function (label) { S.marks.push({ t: Math.round(now() * 100) / 100, unix: Date.now(), label: String(label) }); return true; },
    info: function () {
      return {
        inst: Object.keys(S.installed), tries: S.instTries, on: S.on,
        hidden: g.document ? g.document.hidden : null,
        vis: g.document ? g.document.visibilityState : null,
        focus: g.document ? !!g.document.hasFocus() : null,
        role: g.Play && g.Play.state ? g.Play.state.netRole : null,
        build: (g.Play && g.Play.state && g.Play.state.build) || g.BUILD_ID || null,
        ua: g.navigator ? g.navigator.userAgent : null
      };
    },
    dump: function () {
      var i, k, n, start;
      var frames = [];
      n = Math.min(S.nF, CAP_F); start = S.nF > CAP_F ? (S.nF % CAP_F) : 0;
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
      n = Math.min(S.nA, CAP_A); start = S.nA > CAP_A ? (S.nA % CAP_A) : 0;
      for (k = 0; k < n; k++) {
        i = (start + k) % CAP_A;
        applies.push([Math.round(S.aT[i] * 100) / 100, S.aSeq[i],
          S.aHost[i], S.aSmooth[i], Math.round(S.aMs[i] * 1000) / 1000]);
      }
      var sends = [];
      n = Math.min(S.nN, CAP_N); start = S.nN > CAP_N ? (S.nN % CAP_N) : 0;
      for (k = 0; k < n; k++) {
        i = (start + k) % CAP_N;
        sends.push([Math.round(S.nT[i] * 100) / 100, Math.round(S.nMs[i] * 100) / 100,
          S.nBytes[i], S.nQueue[i], S.nGzip[i], S.nOK[i]]);
      }
      var ticks = [];
      n = Math.min(S.nTk, CAP_T); start = S.nTk > CAP_T ? (S.nTk % CAP_T) : 0;
      for (k = 0; k < n; k++) {
        i = (start + k) % CAP_T;
        ticks.push([Math.round(S.kT[i] * 100) / 100, S.kDt[i], Math.round(S.kMs[i] * 1000) / 1000]);
      }
      var secs = [];
      n = Math.min(S.nS, CAP_S); start = S.nS > CAP_S ? (S.nS % CAP_S) : 0;
      for (k = 0; k < n; k++) {
        i = (start + k) % CAP_S;
        if (S.sRec[i]) secs.push(S.sRec[i]);
      }
      var events = [];
      n = Math.min(S.nE, CAP_E); start = S.nE > CAP_E ? (S.nE % CAP_E) : 0;
      for (k = 0; k < n; k++) {
        i = (start + k) % CAP_E;
        events.push([Math.round(S.eT[i] * 100) / 100, S.eK[i]]);
      }
      return {
        v: S.version,
        info: g.__passport.info(),
        page: g.location ? g.location.href.replace(/token=[^&]+/g, 'token=<hidden>') : '',
        watch: S.watch,
        t0: S.t0,
        frames: frames, secs: secs, events: events,
        applies: applies, sends: sends, ticks: ticks,
        marks: S.marks, agg: S.agg,
        nowWall: Date.now()
      };
    }
  };

  bindEvents();
  tryInstall();
})(window);
