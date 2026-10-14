/* hero.js — персонаж-лесоруб: ходьба по карте и рубка деревьев.

   Персонаж — не украшение и не постройка: у него своя точка на карте, своё
   место в порядке глубины (он загораживает дерево, которое стоит за ним, и
   сам загораживается деревом перед ним) и своя логика. Ходит он по приказу
   кликом, рубит деревья в три удара.

   Кадры атласа: anim (idle/walk/chop) x frame x поворот. Поворот — это
   НАПРАВЛЕНИЕ движения: модель в Blender смотрит в +X, а повороты 0/90/180/270
   вокруг Z дают +X / +Y / -X / -Y. Поэтому индекс кадра = угол движения / 90°.
   Одно правило на весь рендер и на всю логику — разъехаться они не могут.

   Ходьба и рубка идут в МИРОВЫХ клетках, а не в пикселях: скорость, дистанция
   удара и «дошёл» считаются в клетках, как и всё в этом проекте. */
(function (global) {
  'use strict';

  var SPEED = 1.7;        // клеток в секунду: 8 кадров ходьбы при 12 к/с
  var REACH = 1.45;       // с какого расстояния топор достаёт дерево
  var HITS = 3;           // сколько ударов держит дерево
  var ARRIVE = 0.10;      // ближе этого считаем, что пришли
  var TURN = 14.0;        // скорость доворота корпуса, рад/с
  var CHOP_HIT_FRAME = 5; // на каком кадре удара топор попадает в дерево

  function joinPath(base, rel) {
    if (!base) return rel;
    return base.charAt(base.length - 1) === '/' ? base + rel : base + '/' + rel;
  }

  /* ------------------------------- загрузка ------------------------------ */

  /* Как у основного атласа и ратуши: сначала готовый скрипт (работает по
     file://), затем JSON — запасной путь для http-сервера. */
  function load(opts, onReady, onError) {
    opts = opts || {};
    var base = opts.base || 'assets/';
    var dir = opts.dir || 'hero/';
    var meta = global.HERO_ATLAS;
    if (meta) { loadImage(meta, base, dir, onReady, onError); return; }
    if (typeof fetch !== 'function') { onError(new Error('нет ни atlas.js героя, ни fetch')); return; }
    fetch(joinPath(base, dir + 'atlas.json')).then(function (r) {
      if (!r.ok) throw new Error('hero/atlas.json: HTTP ' + r.status);
      return r.json();
    }).then(function (json) {
      global.HERO_ATLAS = json;
      loadImage(json, base, dir, onReady, onError);
    }).catch(onError);
  }

  function loadImage(meta, base, dir, onReady, onError) {
    var src = joinPath(base, dir + meta.atlas);
    var img = new Image();
    img.onerror = function () { onError(new Error('не загрузился атлас героя: ' + src)); };
    img.onload = function () { onReady(build(img, meta)); };
    img.src = src;
  }

  function spriteFrom(img, f) {
    return {
      img: img,
      sx: f.x, sy: f.y, sw: f.w, sh: f.h,
      // Точка опоры: пиксель кадра, куда проецируется точка (0,0,0) модели —
      // у человека это земля между ступнями.
      ax: f.anchorX / f.w,
      ay: f.anchorY / f.h
    };
  }

  function build(img, meta) {
    var set = {
      img: img, meta: meta,
      ppu: meta.ppu || 96,
      /* Крупность мира. У героя она ОБЯЗАНА совпадать с крупностью
         растительности (app.js: set.mul = 1.35 у атласа спрайтов), иначе
         человек перестанет соответствовать деревьям, рядом с которыми стоит.
         Житель рисуется мельче — своим SHRINK в js/villager.js: это решение
         заказчика о размере человека, а не свойство атласа, и здесь ему не
         место. */
      mul: meta.mul === undefined ? 1 : meta.mul,
      anims: meta.anims || {},
      rots: [],              // какие повороты объявлены в атласе, по возрастанию
      frames: {}
    };
    for (var name in meta.frames) {
      var f = meta.frames[name];
      if (f.anim === undefined || f.frame === undefined) continue;
      var byAnim = set.frames[f.anim] || (set.frames[f.anim] = []);
      var byFrame = byAnim[f.frame] || (byAnim[f.frame] = {});
      var rot = ((f.rotation % 360) + 360) % 360;
      byFrame[rot] = spriteFrom(img, f);
      if (set.rots.indexOf(rot) < 0) set.rots.push(rot);
    }
    set.rots.sort(function (a, b) { return a - b; });
    return set;
  }

  function frameCount(set, anim) {
    if (!set) return 0;
    var a = (set.anims && set.anims[anim]) || null;
    if (a && a.frames) return a.frames;
    return (set.frames[anim] || []).length;
  }

  function fps(set, anim) {
    var a = set && set.anims && set.anims[anim];
    return (a && a.fps) || 10;
  }

  function loops(set, anim) {
    var a = set && set.anims && set.anims[anim];
    return !a || a.loop !== false;
  }

  /* Ближайший к курсу поворот из тех, что есть в кадре.

     Поворотов в атласе конечное число, и у двух людей оно РАЗНОЕ: лесоруб
     отрендерен в четыре (0/90/180/270), житель — в восемь (через 45°), потому
     что он ходит по прямой в любую сторону (js/villager.js). Поэтому кадр
     выбирается не делением на 90°, а поиском ближайшего объявленного поворота:
     атлас с четырьмя поворотами работает как работал, атлас с восемью даёт
     диагонали, а третьего правила в коде нет.

     При равном расстоянии побеждает больший угол — ровно так же, как это
     делал прежний Math.round(deg / 90): курс 45° при четырёх поворотах давал
     90°, а не 0°. */
  function nearestRot(byFrame, deg) {
    var best = null, bd = Infinity;
    for (var k in byFrame) {
      var r = +k;
      var d = Math.abs(((deg - r + 540) % 360) - 180);
      if (d < bd - 1e-9 || (best !== null && Math.abs(d - bd) <= 1e-9 && r > best)) {
        bd = d; best = r;
      }
    }
    return best === null ? 0 : best;
  }

  /* Кадр по состоянию персонажа: анимация, фаза и поворот, ближайший к курсу.
     Курс при этом остаётся свободным — округляется КАДР, а не походка. */
  function sprite(set, h) {
    if (!set) return null;
    var byAnim = set.frames[h.anim] || set.frames.idle;
    if (!byAnim) return null;
    var n = Math.max(1, frameCount(set, h.anim));
    var i = Math.floor(h.phase * n) % n;
    var byFrame = byAnim[i] || byAnim[0];
    var rot = nearestRot(byFrame, h.rot);
    return byFrame[rot] || byFrame[0] || null;
  }

  /* ------------------------------- масштаб ------------------------------- */

  /* Пикселей кадра на пиксель карты. Та же формула, что у объектов в
     render.js: кадр атласа измерен в юнитах модели, а не в клетках, поэтому
     знаменатель — ppu, а крупность задаёт mul. */
  function scaleAt(set, z) {
    return (z / (set.ppu || 96)) * (set.mul === undefined ? 1 : set.mul);
  }

  /* -------------------------------- карта -------------------------------- */

  function isLand(world, x, y) {
    var cx = Math.floor(x), cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= world.width || cy >= world.height) return false;
    return !!world.isLand[cy * world.width + cx];
  }

  /* Что стоит поперёк дороги. Дерево и камень занимают клетку целиком: лес —
     не газон, сквозь него не ходят. Галька, кусты, трава и цветы не мешают. */
  function solid(o) {
    if (o.kind === 'tree') return true;
    if (o.kind === 'stone') return o.variant !== 'pebble';
    return false;
  }

  function key(cx, cy) { return cx + ',' + cy; }

  /* Карта занятых клеток строится один раз на мир и точечно правится, когда
     дерево срубили: пересобирать её на каждый шаг персонажа нельзя (это
     проход по тысячам объектов 60 раз в секунду). */
  function blockedMap(world) {
    var m = world._heroBlocked;
    if (!m || m.version !== world.objects.length) {
      m = world._heroBlocked = { version: world.objects.length, cells: Object.create(null) };
      for (var i = 0; i < world.objects.length; i++) {
        var o = world.objects[i];
        if (solid(o)) m.cells[key(Math.floor(o.x), Math.floor(o.y))] = o;
      }
    }
    return m;
  }

  function canStand(world, x, y, ignore) {
    if (!isLand(world, x, y)) return false;
    var o = blockedMap(world).cells[key(Math.floor(x), Math.floor(y))];
    return !o || o === ignore;
  }

  function free(world, x, y) {
    return isLand(world, x, y) && !blockedMap(world).cells[key(Math.floor(x), Math.floor(y))];
  }

  function objectAt(world, cx, cy) {
    var m = blockedMap(world);
    return m.cells[key(cx, cy)] || null;
  }

  /* Ближайшее дерево к точке: ищем в квадрате радиуса r клеток. Ходить по
     всему лесу на каждый клик незачем — рубить можно только то, до чего
     дошёл, то есть рядом. */
  function nearestTree(world, x, y, r) {
    var best = null, bd = Infinity;
    var x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(world.width - 1, Math.ceil(x + r));
    var y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(world.height - 1, Math.ceil(y + r));
    for (var cy = y0; cy <= y1; cy++) {
      for (var cx = x0; cx <= x1; cx++) {
        var o = blockedMap(world).cells[key(cx, cy)];
        if (!o || o.kind !== 'tree') continue;
        var d = (o.x - x) * (o.x - x) + (o.y - y) * (o.y - y);
        if (d < bd) { bd = d; best = o; }
      }
    }
    return best;
  }

  /* Клетка, с которой можно рубить это дерево: первая свободная из четырёх
     соседних. Если дерево стоит в чаще, подойти получится только с той
     стороны, где есть проход, — и персонаж подойдёт именно с неё. */
  function standSpot(world, o) {
    var cx = Math.floor(o.x), cy = Math.floor(o.y);
    var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var i = 0; i < dirs.length; i++) {
      var nx = cx + dirs[i][0], ny = cy + dirs[i][1];
      if (free(world, nx + 0.5, ny + 0.5)) return { x: nx + 0.5, y: ny + 0.5 };
    }
    return { x: o.x, y: o.y };
  }

  /* -------------------------------- персонаж ------------------------------ */

  function create(world, opts) {
    opts = opts || {};
    var spot = spawnSpot(world, opts.x, opts.y);
    return {
      x: spot.x, y: spot.y,
      rot: 0,                    // градусы: 0 = +X (вправо-вниз по кадру)
      anim: 'idle',
      phase: 0,
      order: null,               // {x, y} — куда идти
      target: null,              // дерево, которое рубим
      hitFrame: -1,              // на каком кадре удара уже нанесли урон
      swings: 0,                 // сколько деревьев срублено (для HUD)
      speed: SPEED
    };
  }

  /* Место появления: у ратуши игрока, на первой свободной клетке рядом.
     Если ратуши нет — ближайшая суша к центру карты. */
  function spawnSpot(world, x, y) {
    if (x === undefined || y === undefined) {
      x = Math.floor(world.width / 2);
      y = Math.floor(world.height / 2);
    }
    for (var r = 0; r < 12; r++) {
      for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          var cx = Math.floor(x) + dx, cy = Math.floor(y) + dy;
          if (free(world, cx + 0.5, cy + 0.5)) return { x: cx + 0.5, y: cy + 0.5 };
        }
      }
    }
    return { x: x + 0.5, y: y + 0.5 };
  }

  function facing(dx, dy) {
    if (!dx && !dy) return null;
    var deg = Math.atan2(dy, dx) * 180 / Math.PI;
    return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  }

  function turn(h, want, dt) {
    var d = ((want - h.rot + 540) % 360) - 180;
    var step = TURN * dt * 180 / Math.PI;
    h.rot = (h.rot + Math.max(-step, Math.min(step, d)) + 360) % 360;
  }

  /* Приказ идти. Клик по дереву сразу переводится в «подойди и руби». */
  function order(h, world, x, y) {
    var o = objectAt(world, Math.floor(x), Math.floor(y));
    if (o && o.kind === 'tree') { chop(h, world, o); return 'chop'; }
    h.target = null;
    h.order = { x: x, y: y };
    return 'move';
  }

  function chop(h, world, tree) {
    h.target = tree;
    h.order = standSpot(world, tree);
    h.hitFrame = -1;
  }

  function cancel(h) {
    h.order = null;
    h.target = null;
  }

  /* ------------------------------- движение ------------------------------ */

  /* Шаг с обходом препятствий: сначала пробуем идти прямо, потом — по одной
     оси. Это не поиск пути, но вдоль берега и вокруг дерева персонаж идёт
     сам, а не встаёт носом в воду. */
  function advance(h, world, dt, tx, ty) {
    var dx = tx - h.x, dy = ty - h.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d <= ARRIVE) return true;
    var vx = dx / d * h.speed * dt, vy = dy / d * h.speed * dt;
    var moves = [[vx, vy], [vx, 0], [0, vy]];
    for (var i = 0; i < moves.length; i++) {
      var mx = moves[i][0], my = moves[i][1];
      if (!mx && !my) continue;
      if (canStand(world, h.x + mx, h.y + my, h.target)) {
        h.x += mx; h.y += my;
        var f = facing(mx, my);
        if (f !== null) turn(h, f, dt);
        return false;
      }
    }
    return true;                        // упёрлись: считаем, что дошли
  }

  function setAnim(h, anim, set) {
    if (h.anim === anim) return;
    h.anim = anim;
    h.phase = 0;
  }

  /* Один кадр жизни персонажа. Здесь только состояние и время — рисование
     и ввод живут в render.js и app.js. */
  function update(h, world, set, dt) {
    if (!h || !world) return;
    var n, fpsA;

    // 1. Рубка: стоим у дерева и бьём, пока оно не упадёт.
    if (h.target) {
      var t = h.target, dx = t.x - h.x, dy = t.y - h.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      var f = facing(dx, dy);
      if (f !== null) turn(h, f, dt);
      if (d > REACH) {
        setAnim(h, 'walk', set);
        if (!h.order || advance(h, world, dt, h.order.x, h.order.y)) {
          h.order = standSpot(world, t);        // цель сдвинулась — пересчитать
        }
        n = Math.max(1, frameCount(set, 'walk'));
        h.phase = (h.phase + dt * fps(set, 'walk') / n) % 1;
        return;
      }
      setAnim(h, 'chop', set);
      n = Math.max(1, frameCount(set, 'chop'));
      fpsA = fps(set, 'chop');
      var before = Math.floor(h.phase * n) % n;
      h.phase += dt * fpsA / n;
      var now = Math.floor(h.phase * n) % n;
      if (!loops(set, 'chop') && h.phase >= 1) {
        h.phase = 0;
      }
      // Урон — ровно один раз за проход кадра удара, а не за каждый кадр.
      if (now !== before && now === CHOP_HIT_FRAME) fell(h, world, t);
      return;
    }

    // 2. Приказ идти.
    if (h.order) {
      setAnim(h, 'walk', set);
      n = Math.max(1, frameCount(set, 'walk'));
      h.phase = (h.phase + dt * fps(set, 'walk') / n) % 1;
      if (advance(h, world, dt, h.order.x, h.order.y)) {
        h.order = null;
        setAnim(h, 'idle', set);
      }
      return;
    }

    // 3. Стоим.
    setAnim(h, 'idle', set);
    n = Math.max(1, frameCount(set, 'idle'));
    h.phase = (h.phase + dt * fps(set, 'idle') / n) % 1;
  }

  /* Удар топором по дереву. Дерево падает не сразу: три удара, и только
     потом ствол исчезает — иначе «рубка» выглядела бы мгновенным удалением. */
  function fell(h, world, tree) {
    tree.hits = (tree.hits === undefined ? HITS : tree.hits) - 1;
    if (tree.hits > 0) return false;
    var objs = world.objects, keep = [];
    for (var i = 0; i < objs.length; i++) if (objs[i] !== tree) keep.push(objs[i]);
    if (keep.length === objs.length) return false;
    world.objects = keep;
    if (world._heroBlocked) {
      delete world._heroBlocked.cells[key(Math.floor(tree.x), Math.floor(tree.y))];
      world._heroBlocked.version = keep.length;
    }
    if (world.stats && world.stats.trees) world.stats.trees--;
    h.target = null;
    h.order = null;
    h.swings++;
    if (tree._spr) tree._spr = null;
    return true;
  }

  global.Hero = {
    load: load, build: build, create: create, update: update,
    sprite: sprite, scaleAt: scaleAt, frameCount: frameCount, fps: fps,
    nearestRot: nearestRot,
    order: order, chop: chop, cancel: cancel, nearestTree: nearestTree,
    objectAt: objectAt, canStand: canStand, free: free, isLand: isLand,
    spawnSpot: spawnSpot, standSpot: standSpot,
    REACH: REACH, HITS: HITS, SPEED: SPEED
  };
})(typeof window !== 'undefined' ? window : globalThis);
