/* server-clock.js — серверное время на клиенте.

   Клиент не считает мир, значит и «сейчас» для интерполяции должен взять у
   сервера. Часы комнаты — монотонные (не календарь), поэтому offset
   считается по четырём меткам одного круга:
     c0 — клиент отправил, s1 — сервер принял,
     s2 — сервер ответил, c3 — клиент получил.
   networkRtt = (c3-c0) - (s2-s1), offset = ((s1-c0)+(s2-c3))/2.

   Число — оценка: асимметрия канала в неё входит. Ошибка не меньше RTT/2,
   и это честно показывается, а не выдаётся за точную доставку. */
(function (global) {
  'use strict';

  var MAX_SAMPLES = 8;

  function create(opts) {
    opts = opts || {};
    var now = opts.now || function () {
      return (global.performance && global.performance.now)
        ? global.performance.now() : Date.now();
    };
    var samples = [];
    var epoch = opts.epoch || 0;
    var lastOffset = 0;
    var lastRender = -Infinity;
    var lastSim = -Infinity;
    var errorMs = 0;
    var frozen = false;

    function addSample(s) {
      if (!s) return false;
      var c0 = Number(s.c0), c3 = Number(s.c3);
      var s1 = Number(s.s1), s2 = Number(s.s2);
      if (![c0, c3, s1, s2].every(function (v) { return isFinite(v); })) return false;
      var rtt = (c3 - c0) - (s2 - s1);
      if (!(rtt >= 0)) rtt = Math.max(0, c3 - c0);
      var offset = ((s1 - c0) + (s2 - c3)) / 2;
      if (!isFinite(offset)) return false;
      samples.push({ c0: c0, c3: c3, s1: s1, s2: s2, rtt: rtt, offset: offset, at: now() });
      while (samples.length > MAX_SAMPLES) samples.shift();
      return true;
    }

    function bestOffset() {
      if (!samples.length) return 0;
      var sorted = samples.slice().sort(function (a, b) { return a.rtt - b.rtt; });
      var pick = sorted.filter(function (s) { return s.rtt >= 0; }).slice(0, 3);
      if (!pick.length) pick = sorted.slice(0, 1);
      var vals = pick.map(function (s) { return s.offset; }).sort(function (a, b) { return a - b; });
      var mid = vals.length >> 1;
      var off = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
      errorMs = Math.max(0, pick[0].rtt / 2);
      return off;
    }

    function offset() { return bestOffset(); }

    function estimatedServerMono(c) {
      return c + offset();
    }

    function reset(newEpoch) {
      epoch = newEpoch === undefined ? epoch + 1 : newEpoch;
      samples.length = 0;
      lastOffset = 0;
      lastRender = -Infinity;
      lastSim = -Infinity;
      errorMs = 0;
      frozen = false;
    }

    function rebase() {
      lastRender = -Infinity;
      lastSim = -Infinity;
    }

    function renderTime(latest, c, o) {
      o = o || {};
      if (!latest) return { renderTime: 0, simTime: 0, stale: true, underflow: true, mode: 'empty' };
      var delay = o.interpolationDelayMs === undefined ? 150 : o.interpolationDelayMs;
      var status = latest.roomStatus || 'running';
      var off = offset();
      var simTime;
      if (status === 'faulted' || status === 'suspended' || status === 'over') {
        simTime = latest.simulationTimeMs || 0;
        frozen = true;
      } else {
        frozen = false;
        if (!samples.length) {
          /* До первой пробы показываем baseline, не выдумывая ход времени. */
          simTime = latest.simulationTimeMs || 0;
        } else {
          var serverMono = (c === undefined ? now() : c) + off;
          simTime = (latest.simulationTimeMs || 0) + (serverMono - (latest.serverGeneratedAtMs || 0));
        }
      }
      var rt = simTime - delay;
      /* Огромная ошибка, возврат из скрытой вкладки, новый epoch — явный
         rebase, а не путешествие через устаревшую историю. */
      var big = o.lastBigErrorMs === undefined ? 500 : o.lastBigErrorMs;
      if (o.forceRebase || (isFinite(lastRender) && Math.abs(rt - lastRender) > big)) {
        lastRender = -Infinity;
        lastSim = -Infinity;
      }
      if (!isFinite(lastRender)) {
        lastRender = rt;
        lastSim = simTime;
      } else if (rt < lastRender) {
        /* Время не идёт назад из-за уточнения offset. */
        rt = lastRender;
        simTime = Math.max(simTime, lastSim);
      } else {
        var maxJump = big;
        if (o.frameDeltaMs > 0) {
          var corr = o.maxCorrectionPerFrameMs === undefined ? 5 : o.maxCorrectionPerFrameMs;
          maxJump = o.frameDeltaMs + corr;
        }
        if (rt - lastRender > maxJump) rt = lastRender + maxJump;
        lastRender = rt;
        lastSim = Math.max(lastSim, simTime);
      }
      var age = (o.clientNow === undefined ? now() : o.clientNow) -
        ((latest.serverGeneratedAtMs || 0) - off);
      var stale = !frozen && age > (o.staleAfterMs === undefined ? 500 : o.staleAfterMs);
      return {
        renderTime: rt,
        simTime: simTime,
        stale: stale,
        underflow: false,
        mode: frozen ? 'frozen' : (samples.length ? 'running' : 'baseline'),
        offset: off,
        errorMs: errorMs
      };
    }

    function snap() {
      return {
        epoch: epoch, samples: samples.length, offset: offset(),
        errorMs: errorMs, lastRender: lastRender, frozen: frozen
      };
    }

    return {
      addSample: addSample,
      offset: offset,
      error: function () { if (samples.length) bestOffset(); return errorMs; },
      estimatedServerMono: estimatedServerMono,
      renderTime: renderTime,
      reset: reset,
      rebase: rebase,
      now: now,
      snap: snap
    };
  }

  global.ServerClock = { create: create };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.ServerClock;
})(typeof window !== 'undefined' ? window : globalThis);
