/* snapshot-buffer.js — буфер серверных снимков и выбор позы по времени.

   Авторитетные объекты и отображаемые позы — разные вещи. Снимок приносит
   конечное положение на момент committed тика; рисование выбирает положение
   на `renderTime` (серверное время минус 150 мс) по ФАКТИЧЕСКОЙ ломаной
   движения, а не по прямой между двумя концами. Иначе житель, завернувший
   за угол внутри 100-мс интервала, срезал бы угол сквозь дом.

   Буфер ограничен 32 независимыми снимками. Старые позы не хранятся в
   логах и не копируются из checkpoint: это представление, его можно
   потерять и получить новым baseline. */
(function (global) {
  'use strict';

  var DEFAULTS = {
    max: 32,
    interpolationDelayMs: 150,
    maxExtrapolationMs: 100,
    staleAfterMs: 500,
    historyMs: 2000
  };

  /* Длительность кадра по имени анимации: одна на кадр, а не по объекту. */
  var animInfoCache = Object.create(null);

  function create(opts) {
    opts = opts || {};
    var protocol = opts.protocol === undefined ? 4 : opts.protocol;
    var roomId = opts.roomId || null;
    var epoch = opts.epoch === undefined ? 0 : opts.epoch;
    var max = opts.max || DEFAULTS.max;
    var maxExtrapolationMs = opts.maxExtrapolationMs === undefined
      ? DEFAULTS.maxExtrapolationMs : opts.maxExtrapolationMs;
    var historyMs = opts.historyMs || DEFAULTS.historyMs;
    var snapshots = [];
    var lastAccepted = -1;
    var byId = new Map();
    var metaById = new Map();

    function clear() {
      snapshots.length = 0;
      lastAccepted = -1;
      byId.clear();
      metaById.clear();
    }

    function addSample(id, t, x, y, rot) {
      if (!isFinite(t) || !isFinite(x) || !isFinite(y)) return;
      var list = byId.get(id);
      if (!list) { list = []; byId.set(id, list); }
      var last = list[list.length - 1];
      if (last && Math.abs(last.t - t) < 1e-9) {
        last.x = x; last.y = y; last.rot = isFinite(rot) ? rot : last.rot;
        return;
      }
      if (last && t < last.t) return;   // старая точка уже известна
      list.push({ t: t, x: x, y: y, rot: isFinite(rot) ? rot : 0 });
    }

    function trimEntity(id, cutoff) {
      var list = byId.get(id);
      if (!list) return;
      while (list.length > 2 && list[0].t < cutoff) list.shift();
      while (list.length > 128) list.shift();
    }

    function push(snap) {
      if (!snap || typeof snap !== 'object') {
        return { accepted: false, reason: 'empty' };
      }
      if (snap.protocol !== undefined && snap.protocol !== protocol) {
        return { accepted: false, reason: 'protocol' };
      }
      if (roomId && snap.roomId && snap.roomId !== roomId) {
        return { accepted: false, reason: 'room' };
      }
      var se = snap.epoch === undefined ? epoch : snap.epoch;
      var reset = false;
      if (se < epoch) return { accepted: false, reason: 'old_epoch' };
      if (se > epoch) {
        if (!snap.baseline) return { accepted: false, reason: 'epoch_without_baseline' };
        clear();
        epoch = se;
        reset = true;
      }
      var rev = snap.revision === undefined ? snap.seq : snap.revision;
      if (rev === undefined || rev === null) return { accepted: false, reason: 'no_revision' };
      if (!reset && rev <= lastAccepted) {
        return { accepted: false, reason: rev === lastAccepted ? 'duplicate' : 'old' };
      }
      lastAccepted = rev;
      snapshots.push(snap);
      while (snapshots.length > max) snapshots.shift();
      var t = snap.simulationTimeMs === undefined
        ? Math.round((snap.t || 0) * 1000) : snap.simulationTimeMs;
      var list = snap.villagers || [];
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (!v || v.id === undefined) continue;
        if (v.teleport) {
          /* Явный скачок: старую ломаную этого жителя не продолжаем. */
          byId.delete(v.id);
        }
        if (Array.isArray(v.motion)) {
          for (var m = 0; m < v.motion.length; m++) {
            var s = v.motion[m];
            if (!s) continue;
            var st = s.t === undefined ? t : s.t;
            addSample(v.id, st, s.x, s.y, s.rot);
          }
        }
        addSample(v.id, t, v.x, v.y, v.rot);
        /* Время кадра — рядом с самой анимацией: по нему доигрывается фаза,
           когда снимок пришёл без её длительности (двоичный кадр). */
        v._snapT = t;
        metaById.set(v.id, v);
      }
      var cutoff = t - historyMs;
      byId.forEach(function (_, id) { trimEntity(id, cutoff); });
      /* Сущности, которых нет дольше секунды, не держим вечно в памяти. */
      metaById.forEach(function (meta, id) {
        if (!byId.has(id)) metaById.delete(id);
      });
      return { accepted: true, reset: reset, epoch: epoch, revision: rev };
    }

    function rotLerp(a, b, alpha) {
      a = isFinite(a) ? a : 0;
      b = isFinite(b) ? b : 0;
      var d = ((b - a + 540) % 360) - 180;
      return ((a + d * alpha) % 360 + 360) % 360;
    }

    function findBracket(list, t) {
      var lo = 0, hi = list.length - 1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (list[mid].t < t) lo = mid + 1;
        else hi = mid - 1;
      }
      return lo;   // первый sample с time >= t
    }

    /* Длительность прохода кадра. Двоичный кадр (net-wire) не несёт
       animStartTimeMs/animDurationMs — в нём есть только phase на момент
       снимка. Длительность берём из GameplayConfig: это те же frames/fps,
       что у атласа, а не отдельная таблица в клиенте. Нет конфига — фазе
       неоткуда расти, и кадр честно остаётся на месте. */
    function animInfo(meta) {
      var key = (meta.warrior ? 'w:' : 'v:') + (meta.anim || 'idle');
      if (Object.prototype.hasOwnProperty.call(animInfoCache, key)) return animInfoCache[key];
      var G = global.GameplayConfig;
      if (!G || typeof G.animation !== 'function') return null;
      try {
        var a = G.animation(meta.warrior ? 'warrior' : 'villager',
          meta.anim || 'idle');
        animInfoCache[key] = (a && isFinite(a.duration) && a.duration > 0) ? a : null;
      } catch (e) {
        animInfoCache[key] = null;
      }
      return animInfoCache[key];
    }

    function animOf(meta, renderTime) {
      if (!meta) return null;
      var inst = meta.animInstance;
      var start = meta.animStartTimeMs;
      var dur = meta.animDurationMs;
      var loop = meta.loop !== false;
      var phase = 0;
      if (isFinite(start) && isFinite(dur) && dur > 0) {
        var e = (renderTime - start) / dur;
        /* Новая анимация началась ПОЗЖЕ момента отрисовки (интерполяция идёт
           на 150 мс назад): без этого ветка loop давала фазу 0.78–0.97, и
           гость видел конец цикла вместо начала. */
        if (e < 0) phase = 0;
        else if (loop) phase = e - Math.floor(e);
        else phase = Math.max(0, Math.min(1, e));
      } else {
        /* Доигровка от phase снимка: в двоичном кадре время начала кадра не
           передаётся, и без этого гость видел ВСЕ анимации застывшими на
           нулевом кадре (phase = 0 на каждом кадре). Снимок — точка отсчёта:
           phase на его времени, дальше время кадра идёт по длительности
           прохода. work у жителя и воина хост крутит по кругу (рубка и удары
           повторяются), хотя в атласе он объявлен loop:false; carry_put —
           один проход, его фаза не перескакивает через конец. */
        var p0 = Number(meta.phase);
        if (!isFinite(p0)) p0 = 0;
        var t0 = Number(meta._snapT);
        var info = animInfo(meta);
        if (info) {
          /* Отрисовка идёт на 150 мс ПОЗАДИ снимка. Если бы отрицательный
             зазор обрезался нулём, фаза замирала бы на каждом новом кадре и
             шла рывками: 150 мс стоит, 100 мс едет. Поэтому зазор
             знаковый: для цикла это просто фаза предыдущего прохода. */
          var dt = isFinite(t0) ? (renderTime - t0) / 1000 : 0;
          var f = p0 + dt / info.duration;
          var wraps = meta.anim === 'work' || info.loop !== false;
          if (wraps) phase = f - Math.floor(f);
          else phase = Math.max(0, Math.min(1, f));
        } else {
          phase = p0;
        }
      }
      return { anim: meta.anim || 'idle', animInstance: inst, phase: phase };
    }

    function pose(id, renderTime) {
      var list = byId.get(id);
      var meta = metaById.get(id) || null;
      var latestSnap = snapshots.length ? snapshots[snapshots.length - 1] : null;
      var stale = false;
      if (latestSnap) {
        var st = latestSnap.simulationTimeMs === undefined
          ? Math.round((latestSnap.t || 0) * 1000) : latestSnap.simulationTimeMs;
        stale = renderTime > st + DEFAULTS.staleAfterMs;
      }
      if (!list || !list.length) {
        if (!meta) return null;
        var ph0 = animOf(meta, renderTime);
        return {
          x: meta.x, y: meta.y, rot: meta.rot || 0,
          anim: ph0 && ph0.anim, animInstance: ph0 && ph0.animInstance,
          phase: ph0 ? ph0.phase : 0,
          state: meta.state || '', flinch: meta.flinch || 0,
          hidden: !!meta.hidden, mode: 'held', underflow: true, stale: stale
        };
      }
      var anim = animOf(meta, renderTime);
      function out(s, x, y, rot, mode, underflow) {
        var hidden = !!(meta && meta.hidden);
        if (meta && meta.spawnTimeMs !== undefined && renderTime < meta.spawnTimeMs) hidden = true;
        if (meta && meta.deathTimeMs !== undefined && renderTime >= meta.deathTimeMs) hidden = true;
        return {
          x: x, y: y, rot: rot,
          anim: anim && anim.anim, animInstance: anim && anim.animInstance,
          phase: anim ? anim.phase : 0, state: meta ? (meta.state || '') : '',
          flinch: meta ? (meta.flinch || 0) : 0, hidden: hidden,
          mode: mode, underflow: !!underflow, stale: stale
        };
      }
      if (renderTime <= list[0].t) {
        return out(list[0], list[0].x, list[0].y, list[0].rot, 'held', false);
      }
      var last = list[list.length - 1];
      if (Math.abs(renderTime - last.t) < 1e-9) {
        return out(last, last.x, last.y, last.rot, 'interpolated', false);
      }
      if (renderTime > last.t) {
        /* После последней точки экстраполяция разрешена ТОЛЬКО по
           продолжающемуся безопасному отрезку, не дольше 100 мс. */
        var safe = meta && meta.safeExtrapolationTo;
        var dt = renderTime - last.t;
        if (isFinite(safe) && renderTime <= safe && dt <= maxExtrapolationMs && list.length >= 2) {
          var prev = list[list.length - 2];
          var span = last.t - prev.t;
          if (span > 0) {
            var vx = (last.x - prev.x) / span;
            var vy = (last.y - prev.y) / span;
            return out(last, last.x + vx * dt, last.y + vy * dt, last.rot,
              'extrapolated', false);
          }
        }
        return out(last, last.x, last.y, last.rot, 'held', true);
      }
      var i = findBracket(list, renderTime);
      var a = list[i - 1], b = list[i];
      var den = b.t - a.t;
      if (!(den > 0)) return out(b, b.x, b.y, b.rot, 'held', true);
      var alpha = (renderTime - a.t) / den;
      return out(b,
        a.x + (b.x - a.x) * alpha,
        a.y + (b.y - a.y) * alpha,
        rotLerp(a.rot, b.rot, alpha),
        'interpolated', false);
    }

    function latest() { return snapshots.length ? snapshots[snapshots.length - 1] : null; }

    function stats() {
      return {
        snapshots: snapshots.length,
        epoch: epoch,
        lastAccepted: lastAccepted,
        entities: byId.size,
        max: max
      };
    }

    return {
      push: push,
      pose: pose,
      latest: latest,
      lastAccepted: function () { return lastAccepted; },
      epoch: function () { return epoch; },
      size: function () { return snapshots.length; },
      clear: clear,
      stats: stats
    };
  }

  global.SnapshotBuffer = { create: create, DEFAULTS: DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.SnapshotBuffer;
})(typeof window !== 'undefined' ? window : globalThis);
