/* navigation.js — поиск пути как ОГРАНИЧЕННАЯ РАБОТА НА ТИК.

   Почему отдельный модуль. В villager.js A* был синхронным: один вызов
   разбирал до N/4 клеток, а бюджет «на кадр» выдавался вызовом update. При
   разной частоте кадров это давало разное число поисков за секунду, а один
   длинный обход мог занять весь кадр. В серверной комнате шаг фиксированный
   (20 Гц), и работа должна быть одинаковой на каждом шаге.

   Здесь живёт очередь job'ов. Job — это НЕЗАВЕРШЁННЫЙ A*: своя куча, свои
   `g/came/closed`, свой счётчик снятий. Он продолжается на следующем тике с
   того же места, а не начинается заново. Бюджет (4096 снятий) один на мир и
   тик; одному job'у за очередь достаётся не больше 256 снятий. Незавершённый
   поиск — это 'deferred', а НЕ «пути нет»: unreachable доказывается только
   пустой кучей.

   Модуль чистый: ни DOM, ни Canvas, ни PNG. Проходимость спрашивает у
   Villagers.walkable — той же функции, что и ходьба, поэтому «путь есть» и
   «идти можно» не могут разойтись. */
(function (global) {
  'use strict';

  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  var DIAG = [0, 0, 0, 0, 1, 1, 1, 1];
  var SQ2 = Math.SQRT2;

  var DEFAULTS = {
    maxPopsPerTick: 4096,
    quantum: 256,
    maxActive: 8,
    maxWaiting: 4096,
    maxCompleted: 512,
    maxPerEntity: 16
  };

  function nowTick(world) {
    return (world && world._navigation && world._navigation.tick) || 0;
  }

  function versionOf(world) {
    if (!world) return 0;
    if (typeof world.navVersion === 'number') return world.navVersion;
    if (global.Villagers && global.Villagers.mapVer) return global.Villagers.mapVer(world);
    return 0;
  }

  function ensure(world, opts) {
    if (!world) return null;
    var s = world._navigation;
    if (s && s.schema === 1) return s;
    s = world._navigation = {
      schema: 1,
      tick: 0,
      budget: DEFAULTS.maxPopsPerTick,
      maxPopsPerTick: (opts && opts.maxPops) || DEFAULTS.maxPopsPerTick,
      quantum: (opts && opts.quantum) || DEFAULTS.quantum,
      maxActive: DEFAULTS.maxActive,
      maxWaiting: DEFAULTS.maxWaiting,
      maxCompleted: DEFAULTS.maxCompleted,
      maxPerEntity: DEFAULTS.maxPerEntity,
      nextJobId: 1,
      jobs: Object.create(null),
      active: [],
      waiting: [],
      completed: Object.create(null),
      completedOrder: [],
      stats: {
        tickPops: 0, requests: 0, ready: 0, deferred: 0,
        unreachable: 0, limited: 0, invalid: 0, cancelled: 0,
        queueFull: 0, maxWaitTicks: 0
      }
    };
    return s;
  }

  function resetStats(s) {
    var st = s.stats;
    st.tickPops = 0;
    st.requests = 0;
    st.ready = 0;
    st.deferred = 0;
    st.unreachable = 0;
    st.limited = 0;
    st.invalid = 0;
    st.cancelled = 0;
    st.queueFull = 0;
  }

  function heapPush(job, i, f) {
    var heap = job.heap, hf = job.hf;
    var c = job.hn++;
    heap[c] = i; hf[c] = f;
    while (c > 0) {
      var p = (c - 1) >> 1;
      if (hf[p] <= hf[c]) break;
      var ti = heap[p], tf = hf[p];
      heap[p] = heap[c]; hf[p] = hf[c];
      heap[c] = ti; hf[c] = tf;
      c = p;
    }
  }

  function heapGrow(job) {
    var h2 = new Int32Array(job.heap.length * 2);
    h2.set(job.heap);
    job.heap = h2;
    var f2 = new Float64Array(job.hf.length * 2);
    f2.set(job.hf);
    job.hf = f2;
  }

  function heapPop(job) {
    var heap = job.heap, hf = job.hf;
    var top = heap[0];
    job.hn--;
    heap[0] = heap[job.hn]; hf[0] = hf[job.hn];
    var c = 0;
    for (;;) {
      var l = c * 2 + 1, r = l + 1, sel = c;
      if (l < job.hn && hf[l] < hf[sel]) sel = l;
      if (r < job.hn && hf[r] < hf[sel]) sel = r;
      if (sel === c) break;
      var ti = heap[sel], tf = hf[sel];
      heap[sel] = heap[c]; hf[sel] = hf[c];
      heap[c] = ti; hf[c] = tf;
      c = sel;
    }
    return top;
  }

  function heuristic(job, i) {
    var x = i % job.W, y = (i / job.W) | 0;
    var ax = Math.abs(x - job.tx), ay = Math.abs(y - job.ty);
    return ax > ay ? ax + (SQ2 - 1) * ay : ay + (SQ2 - 1) * ax;
  }

  function allocJob(world, s, req) {
    var W = world.width, H = world.height, N = W * H;
    var job = {
      id: s.nextJobId++,
      key: req.key,
      entityId: req.entityId,
      purpose: req.purpose,
      sx: req.sx, sy: req.sy, tx: req.tx, ty: req.ty,
      version: req.version,
      solid: req.solid || null,
      enqueuedTick: s.tick,
      startTick: s.tick,
      status: 'active',           // active | waiting | ready | unreachable | limit | invalid | cancelled
      W: W, H: H, N: N,
      gen: 1,
      gGen: new Int32Array(N),
      g: new Float64Array(N),
      came: new Int32Array(N),
      closedGen: new Int32Array(N),
      heap: new Int32Array(2048),
      hf: new Float64Array(2048),
      hn: 0,
      pops: 0,
      limit: req.limit > 0 ? req.limit : 0,
      path: null,
      finishedTick: 0,
      read: false
    };
    var start = req.sy * W + req.sx;
    var goal = req.ty * W + req.tx;
    job.goal = goal;
    job.gGen[start] = job.gen;
    job.g[start] = 0;
    job.came[start] = -1;
    heapPush(job, start, heuristic(job, start));
    return job;
  }

  function finish(s, job, status, path) {
    job.status = status;
    job.path = path || null;
    job.finishedTick = s.tick;
    job.heap = null; job.hf = null;
    job.gGen = null; job.g = null; job.came = null; job.closedGen = null;
    if (job.queue === 'active') {
      var ai = s.active.indexOf(job);
      if (ai >= 0) s.active.splice(ai, 1);
    } else if (job.queue === 'waiting') {
      var wi = s.waiting.indexOf(job);
      if (wi >= 0) s.waiting.splice(wi, 1);
    }
    delete s.jobs[job.key];
    if (status === 'ready') s.stats.ready++;
    else if (status === 'unreachable') s.stats.unreachable++;
    else if (status === 'limit') s.stats.limited++;
    else if (status === 'invalid') s.stats.invalid++;
    /* Результат ждёт следующего обращения СВОЕГО жителя. Храним его отдельно
       и ограниченно: без потолка очередь завершённых росла бы вместе с
       числом кандидатов, а планировщик перебирает десятки деревьев. */
    if (status !== 'cancelled') {
      s.completed[job.key] = job;
      s.completedOrder.push(job.key);
      while (s.completedOrder.length > s.maxCompleted) {
        var old = s.completedOrder.shift();
        if (old !== job.key) delete s.completed[old];
      }
      job.queue = null;
    }
  }

  function reconstruct(job) {
    var out = [];
    var guard = 0;
    for (var i = job.goal; i !== -1 && guard++ <= job.N; i = job.came[i]) out.push(i);
    out.reverse();
    return out.length ? out : null;
  }

  function runJob(world, s, job, maxPops) {
    if (!job || job.status !== 'active') return job ? job.status : 'invalid';
    var budget = Math.min(maxPops || s.quantum, s.budget);
    if (budget <= 0) {
      s.stats.deferred++;
      return 'deferred';
    }
    var pops = 0;
    while (job.hn > 0 && pops < budget && s.budget > 0) {
      var cur = heapPop(job);
      pops++;
      job.pops++;
      s.budget--;
      s.stats.tickPops++;
      if (job.closedGen[cur] === job.gen) continue;  // устаревшая запись тоже
      job.closedGen[cur] = job.gen;
      if (cur === job.goal) {
        var path = reconstruct(job);
        finish(s, job, path ? 'ready' : 'invalid', path);
        return job.status;
      }
      var cx = cur % job.W, cy = (cur / job.W) | 0;
      for (var d = 0; d < 8; d++) {
        var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
        if (!global.Villagers.walkable(world, job.solid, nx, ny)) continue;
        if (DIAG[d] &&
            (!global.Villagers.walkable(world, job.solid, cx + DIRS[d][0], cy) ||
             !global.Villagers.walkable(world, job.solid, cx, cy + DIRS[d][1]))) continue;
        var ni = ny * job.W + nx;
        if (job.closedGen[ni] === job.gen) continue;
        var ng = job.g[cur] + (DIAG[d] ? SQ2 : 1);
        if (job.gGen[ni] === job.gen && ng >= job.g[ni] - 1e-9) continue;
        job.g[ni] = ng;
        job.gGen[ni] = job.gen;
        job.came[ni] = cur;
        var f = ng + heuristic(job, ni);
        if (job.hn >= job.heap.length) heapGrow(job);
        heapPush(job, ni, f);
      }
      if (job.limit > 0 && job.pops >= job.limit) {
        finish(s, job, 'limit', null);
        return job.status;
      }
    }
    if (job.hn === 0) {
      finish(s, job, 'unreachable', null);
      return job.status;
    }
    s.stats.deferred++;
    return 'deferred';
  }

  /* Один раз на тик, ДО обхода жителей. Сначала обслуживаются job'ы прошлых
     тиков: незавершённый поиск продолжается с тем же open/came. Новые
     запросы этого тика придут уже после и получат остаток бюджета. */
  function beginTick(world, opts) {
    var s = ensure(world, opts);
    if (!s) return { tick: 0, budget: 0 };
    s.tick++;
    s.budget = s.maxPopsPerTick;
    resetStats(s);
    var version = versionOf(world);
    /* Смена карты отменяет поиски по старой геометрии: путь, найденный по
       снесённому дому, был бы путём сквозь дом. */
    var all = s.active.concat(s.waiting);
    for (var i = 0; i < all.length; i++) {
      var j = all[i];
      if (j && j.version !== version) {
        j.status = 'cancelled';
        finish(s, j, 'cancelled', null);
        s.stats.cancelled++;
      }
    }
    /* Round-robin по активным: каждый получает quantum, пока есть бюджет. */
    var guard = 0;
    while (s.budget > 0 && s.active.length && guard++ < 4096) {
      var progressed = false;
      var len = s.active.length;
      for (var k = 0; k < len && s.budget > 0; k++) {
        var job = s.active[k];
        if (!job || job.status !== 'active') continue;
        var before = job.pops;
        var r = runJob(world, s, job, s.quantum);
        if (job.pops !== before) progressed = true;
        if (r !== 'deferred' && r !== 'active') break;
      }
      if (!progressed) break;
    }
    /* Освободившиеся слоты занимают ожидающие — по очереди, без обгона. */
    while (s.active.length < s.maxActive && s.waiting.length && s.budget > 0) {
      var next = s.waiting.shift();
      if (!next || next.status !== 'waiting') continue;
      next.status = 'active';
      next.queue = 'active';
      s.active.push(next);
    }
    /* Ожидающие, которые уже никогда не понадобятся, стареют: это не отмена
       живого запроса, а ограничение памяти. Житель, которому путь всё ещё
       нужен, попросит снова — с тем же ключом и тем же возрастом. */
    if (s.waiting.length > s.maxWaiting) {
      var drop = s.waiting.splice(0, s.waiting.length - s.maxWaiting);
      for (var d = 0; d < drop.length; d++) {
        if (drop[d]) { drop[d].status = 'cancelled'; drop[d].queue = null; }
      }
      s.stats.queueFull++;
    }
    for (var a = 0; a < s.active.length; a++) {
      if (!s.active[a]) continue;
      var wait = s.tick - s.active[a].enqueuedTick;
      if (wait > s.stats.maxWaitTicks) s.stats.maxWaitTicks = wait;
    }
    world._navTick = s.tick;
    return { tick: s.tick, budget: s.budget, stats: s.stats };
  }

  function requestPath(world, opts) {
    opts = opts || {};
    var s = ensure(world, opts);
    if (!s) return { status: 'invalid' };
    s.stats.requests++;
    var W = world.width, H = world.height;
    var sx = opts.sx | 0, sy = opts.sy | 0, tx = opts.tx | 0, ty = opts.ty | 0;
    var entityId = opts.entityId === undefined || opts.entityId === null
      ? 0 : opts.entityId;
    var purpose = opts.purpose || 'move';
    var version = opts.passabilityVersion === undefined
      ? versionOf(world) : opts.passabilityVersion;
    if (sx < 0 || sy < 0 || tx < 0 || ty < 0 ||
        sx >= W || sy >= H || tx >= W || ty >= H) {
      s.stats.invalid++;
      return { status: 'invalid', reason: 'out_of_bounds' };
    }
    if (sx === tx && sy === ty) {
      s.stats.invalid++;
      return { status: 'invalid', reason: 'same_cell' };
    }
    var solid = opts.solid || null;
    if (!solid && global.Villagers && global.Villagers.blockedMap) {
      solid = global.Villagers.blockedMap(world, world._buildings || []);
    }
    if (!global.Villagers.walkable(world, solid, sx, sy) ||
        !global.Villagers.walkable(world, solid, tx, ty)) {
      s.stats.invalid++;
      return { status: 'invalid', reason: 'not_walkable' };
    }
    var key = entityId + '|' + purpose + '|' + sx + ',' + sy + '>' + tx + ',' + ty + '|' + version;
    /* Готовый результат отдаётся ровно один раз: следующий вызов с тем же
       ключом — это уже новый запрос (например, тот же житель снова идёт в
       ту же клетку после возврата). */
    var done = s.completed[key];
    if (done) {
      delete s.completed[key];
      var oi = s.completedOrder.indexOf(key);
      if (oi >= 0) s.completedOrder.splice(oi, 1);
      if (done.status === 'ready') return { status: 'ready', path: done.path, requestId: done.id };
      return { status: done.status, requestId: done.id };
    }
    var job = s.jobs[key];
    if (job) {
      if (job.status === 'waiting') {
        s.stats.deferred++;
        return { status: 'deferred', requestId: job.id, queue: 'waiting' };
      }
      if (job.limit && opts.limit > job.limit) job.limit = opts.limit;
      var r = runJob(world, s, job, s.quantum);
      if (r === 'ready') {
        var p = job.path;
        delete s.completed[key];
        var pi = s.completedOrder.indexOf(key);
        if (pi >= 0) s.completedOrder.splice(pi, 1);
        return { status: 'ready', path: p, requestId: job.id };
      }
      if (r === 'deferred') return { status: 'deferred', requestId: job.id };
      return { status: r, requestId: job.id };
    }
    /* Новый job. Старые незавершённые запросы ТОГО ЖЕ жителя по тому же
       назначению, но с другой целью, больше не актуальны: он передумал.
       Это не касается перебора кандидатов планирования: у них purpose
       начинается с 'plan:' и они живут до завершения. */
    if (purpose.indexOf('plan:') !== 0) {
      cancelEntity(world, entityId, key, purpose);
    } else {
      capEntity(world, entityId, s.maxPerEntity);
    }
    if (s.active.length >= s.maxActive) {
      if (s.waiting.length >= s.maxWaiting) {
        s.stats.queueFull++;
        return { status: 'deferred', reason: 'navigation_queue_full' };
      }
      job = allocJob(world, s, {
        key: key, entityId: entityId, purpose: purpose,
        sx: sx, sy: sy, tx: tx, ty: ty, version: version,
        solid: solid, limit: opts.limit
      });
      job.status = 'waiting';
      job.queue = 'waiting';
      job.solid = solid;
      s.jobs[key] = job;
      s.waiting.push(job);
      s.stats.deferred++;
      return { status: 'deferred', requestId: job.id, queue: 'waiting' };
    }
    job = allocJob(world, s, {
      key: key, entityId: entityId, purpose: purpose,
      sx: sx, sy: sy, tx: tx, ty: ty, version: version,
      solid: solid, limit: opts.limit
    });
    job.queue = 'active';
    s.jobs[key] = job;
    s.active.push(job);
    var rr = runJob(world, s, job, s.quantum);
    if (rr === 'ready') {
      var path = job.path;
      var ci = s.completedOrder.indexOf(key);
      if (ci >= 0) s.completedOrder.splice(ci, 1);
      delete s.completed[key];
      return { status: 'ready', path: path, requestId: job.id };
    }
    if (rr === 'deferred') return { status: 'deferred', requestId: job.id };
    return { status: rr, requestId: job.id };
  }

  function forEachJob(s, fn) {
    var k;
    for (k in s.jobs) if (Object.prototype.hasOwnProperty.call(s.jobs, k)) fn(s.jobs[k], k);
    for (k in s.completed) if (Object.prototype.hasOwnProperty.call(s.completed, k)) fn(s.completed[k], k);
  }

  function cancelJob(s, job) {
    if (!job || job.status === 'cancelled') return;
    job.status = 'cancelled';
    if (job.queue === 'active') {
      var ai = s.active.indexOf(job);
      if (ai >= 0) s.active.splice(ai, 1);
    } else if (job.queue === 'waiting') {
      var wi = s.waiting.indexOf(job);
      if (wi >= 0) s.waiting.splice(wi, 1);
    }
    if (job.key) {
      delete s.jobs[job.key];
      delete s.completed[job.key];
      var oi = s.completedOrder.indexOf(job.key);
      if (oi >= 0) s.completedOrder.splice(oi, 1);
    }
    job.heap = null; job.hf = null;
    job.gGen = null; job.g = null; job.came = null; job.closedGen = null;
    s.stats.cancelled++;
  }

  /* Житель умер, сменил приказ или цель. Отменяем ВСЕ его поиски, кроме
     ключа, который ещё актуален. Иначе очередь забивается мёртвыми. */
  function cancelEntity(world, entityId, keepKey, purpose) {
    var s = world && world._navigation;
    if (!s) return 0;
    var n = 0, list = [];
    forEachJob(s, function (j) {
      if (!j || j.entityId !== entityId) return;
      if (keepKey && j.key === keepKey) return;
      if (purpose && j.purpose !== purpose && j.purpose.indexOf('plan:') !== 0) return;
      list.push(j);
    });
    for (var i = 0; i < list.length; i++) { cancelJob(s, list[i]); n++; }
    return n;
  }

  /* Потолок кандидатов одного жителя: планирование перебирает деревья, и без
     этого один рабочий мог бы занять всю очередь ожидания. Вытесняем самые
     старые ожидающие, но НЕ активные: активный поиск уже потратил тики. */
  function capEntity(world, entityId, max) {
    var s = world && world._navigation;
    if (!s) return;
    for (;;) {
      var mine = [], i;
      for (i = 0; i < s.waiting.length; i++) {
        if (s.waiting[i] && s.waiting[i].entityId === entityId) mine.push(s.waiting[i]);
      }
      if (mine.length <= max) return;
      cancelJob(s, mine[0]);
    }
  }

  function cancelAll(world) {
    var s = world && world._navigation;
    if (!s) return 0;
    var n = 0;
    forEachJob(s, function (j) { if (j) { cancelJob(s, j); n++; } });
    return n;
  }

  function diagnostics(world) {
    var s = world && world._navigation;
    if (!s) return { tick: 0, active: 0, waiting: 0, completed: 0, stats: null };
    return {
      tick: s.tick,
      budget: s.budget,
      active: s.active.length,
      waiting: s.waiting.length,
      completed: s.completedOrder.length,
      jobs: Object.keys(s.jobs).length,
      stats: JSON.parse(JSON.stringify(s.stats))
    };
  }

  global.Navigation = {
    beginTick: beginTick,
    requestPath: requestPath,
    cancelEntity: cancelEntity,
    cancelAll: cancelAll,
    diagnostics: diagnostics,
    ensure: ensure,
    versionOf: versionOf,
    DEFAULTS: DEFAULTS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Navigation;
})(typeof window !== 'undefined' ? window : globalThis);
