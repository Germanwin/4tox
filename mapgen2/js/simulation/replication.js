/* replication.js — DTO для клиента, отдельно от checkpoint.

   В снимок едет ТОЛЬКО представление: деревни, постройки, жители, убранное,
   версия структуры и короткий хвост уже совершённого движения. Ни RNG, ни
   A* heaps, ни checkpoint, ни токены сюда не попадают.

   Почему движение отдельным хвостом. 10 полных снимков/с при 20 тиках/с —
   это два тика между кадрами. Житель за 100 мс может завернуть за угол;
   если клиент интерполирует между двумя конечными положениями, он срежет
   угол сквозь дом. Поэтому сервер записывает фактическую ломаную последней
   секунды (точки `walk`, включая углы) и шлёт её вместе со снимком. Потеря
   одного снимка тогда не теряет поворот.

   Модуль не меняет игровое состояние. Трасса движения и анимаций —
   display-only: после восстановления комнаты она пуста, и первый снимок
   просто ставит текущие позы. */
(function (global) {
  'use strict';

  var TRACE_WINDOW_MS = 1000;
  var TRACE_MAX = 128;
  var motion = new Map();     // id -> [{t,x,y,rot}]
  var anims = new Map();      // id -> {name,instance,start,duration,loop}
  var lastPos = new Map();    // id -> {x,y}; для явного teleport
  var lastSeenTick = -1;

  function nowMs(v) {
    var w = v && v.world;
    return w && typeof w.time === 'number' ? Math.round(w.time * 1000) : 0;
  }

  function noteMove(v, t, x, y, rot) {
    if (!v || v.id === undefined || !isFinite(x) || !isFinite(y)) return;
    var list = motion.get(v.id);
    if (!list) { list = []; motion.set(v.id, list); }
    var tm = typeof t === 'number' && isFinite(t) ? t : nowMs(v);
    var last = list[list.length - 1];
    if (last && Math.abs(last.t - tm) < 1e-9) {
      last.x = x; last.y = y; last.rot = rot;
    } else {
      list.push({ t: tm, x: x, y: y, rot: rot });
    }
    while (list.length > TRACE_MAX) list.shift();
    var cutoff = tm - TRACE_WINDOW_MS;
    while (list.length > 2 && list[0].t < cutoff) list.shift();
  }

  function noteAnim(v) {
    if (!v || v.id === undefined) return;
    var prev = anims.get(v.id);
    var name = v.anim || 'idle';
    if (prev && prev.name === name) return;
    var d = 0, loop = true;
    var G = global.GameplayConfig;
    var a = G && (G.animations && G.animations[name] ||
      (G.profiles && G.profiles.villager &&
        (G.profiles.villager.animations && G.profiles.villager.animations[name] ||
         G.profiles.villager[name])));
    if (a && a.frames > 0 && a.fps > 0) {
      d = a.frames / a.fps * 1000;
      loop = a.loop !== false;
    } else if (v._set && v._set.anims && v._set.anims[name]) {
      var b = v._set.anims[name];
      if (b.frames > 0 && b.fps > 0) { d = b.frames / b.fps * 1000; loop = b.loop !== false; }
    }
    anims.set(v.id, {
      name: name,
      instance: prev ? prev.instance + 1 : 1,
      start: nowMs(v),
      duration: d,
      loop: loop
    });
  }

  function forget(id) {
    motion.delete(id);
    anims.delete(id);
  }

  function trimTo(liveIds) {
    var keep = new Set(liveIds || []);
    motion.forEach(function (v, id) { if (!keep.has(id)) motion.delete(id); });
    anims.forEach(function (v, id) { if (!keep.has(id)) anims.delete(id); });
    lastPos.forEach(function (v, id) { if (!keep.has(id)) lastPos.delete(id); });
  }

  /* Коллинеарные промежуточные точки с той же скоростью/состоянием не нужны:
     они не меняют ни линию, ни поворот. Углы, остановки и точки событий
     остаются. Сравнение в пределах 1e-9 — как требует контракт. */
  function trimSamples(list) {
    if (!list || list.length < 3) return list ? list.slice() : [];
    var out = [list[0]];
    for (var i = 1; i < list.length - 1; i++) {
      var a = out[out.length - 1], b = list[i], c = list[i + 1];
      var abx = b.x - a.x, aby = b.y - a.y, bcx = c.x - b.x, bcy = c.y - b.y;
      var cross = abx * bcy - aby * bcx;
      var dot = abx * bcx + aby * bcy;
      var sameRot = Math.abs(((b.rot - a.rot + 540) % 360) - 180) < 1e-9 &&
        Math.abs(((c.rot - b.rot + 540) % 360) - 180) < 1e-9;
      if (Math.abs(cross) <= 1e-9 && dot >= -1e-9 && sameRot) continue;
      out.push(b);
    }
    out.push(list[list.length - 1]);
    return out;
  }

  function safeExtrapolationTo(v, simNowMs) {
    if (!v || !v.path || v.step >= v.path.length) return null;
    if (!(v.speed > 0)) return null;
    var wp = v.path[v.step];
    var d = Math.hypot(wp.x - v.x, wp.y - v.y);
    if (!isFinite(d) || d <= 0) return null;
    var ms = d / v.speed * 1000;
    var max = 100;
    return Math.round(Math.min(simNowMs + max, simNowMs + ms));
  }

  function worldgenHash(seed, size) {
    var s = '4tox-worldgen-1|' + seed + '|' + size;
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }

  function build(simState, opts) {
    opts = opts || {};
    var world = simState.world;
    var base = global.Serialize.world(world, simState.buildings, simState.villagers, {
      seq: opts.revision,
      over: simState.over,
      winner: simState.winner
    });
    var now = opts.serverGeneratedAtMs || 0;
    var live = [];
    var list = base.villagers || [];
    for (var i = 0; i < list.length; i++) {
      var vs = list[i];
      var v = simState.villagers[i];
      live.push(vs.id);
      if (!v) continue;
      var a = anims.get(v.id);
      if (a) {
        vs.animInstance = a.instance;
        vs.animStartTimeMs = a.start;
        vs.animDurationMs = a.duration;
        vs.loop = a.loop;
      }
      var prevPos = lastPos.get(v.id);
      if (prevPos && Math.hypot(v.x - prevPos.x, v.y - prevPos.y) > 2) {
        /* Скачок через полкарты — не движение, а выход из казармы/перенос.
           Клиент не должен интерполировать сквозь стену. */
        vs.teleport = 1;
      }
      lastPos.set(v.id, { x: v.x, y: v.y });
      var samples = trimSamples(motion.get(v.id) || []);
      if (samples.length) vs.motion = samples;
      var simNow = (simState.tick || 0) * ((global.NetConfig && global.NetConfig.tickMs) || 50);
      var safe = safeExtrapolationTo(v, simNow);
      if (safe !== null) vs.safeExtrapolationTo = safe;
      if (v.hidden) vs.hidden = 1;
      if (v.dead) vs.deathTimeMs = now;
    }
    trimTo(live);
    var snap = {
      protocol: opts.protocol || (global.NetConfig && global.NetConfig.protocol) || 4,
      roomId: opts.roomId || null,
      epoch: opts.epoch || 1,
      revision: opts.revision || 0,
      seq: opts.revision || 0,
      simulationTick: simState.tick || 0,
      simulationTimeMs: (simState.tick || 0) * ((global.NetConfig && global.NetConfig.tickMs) || 50),
      serverGeneratedAtMs: now,
      worldgenVersion: 'v1',
      worldgenHash: worldgenHash(world.seed, world.islandSize || simState.size),
      gameplayConfigHash: (global.GameplayConfig && global.GameplayConfig.hash) || null,
      seed: world.seed,
      size: world.islandSize || simState.size,
      structureVersion: simState.structureVersion || 1,
      over: !!simState.over,
      winner: simState.winner,
      roomStatus: opts.roomStatus || (simState.over ? 'over' : 'running'),
      towns: base.towns,
      buildings: base.buildings,
      villagers: base.villagers,
      objectTotal: base.objectTotal,
      removed: base.removed
    };
    if (opts.baseline) snap.baseline = true;
    if (opts.commandResults && opts.commandResults.length) snap.commandResults = opts.commandResults;
    return snap;
  }

  function reset() {
    motion.clear();
    anims.clear();
    lastPos.clear();
    lastSeenTick = -1;
  }

  global.Replication = {
    build: build,
    noteMove: noteMove,
    noteAnim: noteAnim,
    forget: forget,
    reset: reset,
    trimSamples: trimSamples,
    worldgenHash: worldgenHash
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Replication;
})(typeof window !== 'undefined' ? window : globalThis);
