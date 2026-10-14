/* buildings.js — постройки на карте: спрайты ратуши, пятно застройки, правила.

   Ратуша — первый объект, который не «растёт» из карты, а ставится на неё
   игроком. Отсюда три вещи, которых нет у деревьев и камней:

   1. Пятно застройки. Ратуша занимает 4 x 3 клетки (X — длинная сторона),
      при повороте на 90° — 3 x 4. Пятно это не украшение: по нему считаются
      и проверка места, и подсветка под курсором, и порядок отрисовки.

   2. Посадка спрайта по сетке, а не «на глаз». Спрайты ратуши отрисованы
      ортографической камерой с азимутом 45° и подъёмом 35.2644°, то есть
      80 пикселей кадра на юнит модели, и один юнит — одна клетка карты.
      Проверка считается от проекции: сторона пятна в 4 клетки на экране
      занимает 4 * z/2 пикселей (z — ширина ромба клетки), а в кадре те же
      4 юнита занимают 4 * cos(45°) * ppu пикселей. Отсюда масштаб по X:

          scaleX = (z / 2) / (cos(az) * ppu)

      По Y масштаб другой, и это не ошибка: у карты клетка проецируется как
      ромб 2:1 (sin = 0.5), а камера рендера поднята на 35.2644° (sin = 0.577).
      Если тянуть спрайт по обеим осям одинаково, основание ратуши съезжает
      с пятна на 15 % — на клетке 64 px это ~8 px, и видно, что дом «висит».
      Поэтому:

          scaleY = (z / 4) / (sin(el) * cos(az) * ppu)

      Отношение scaleY/scaleX = sin(30°)/sin(35.2644°) = 0.866: спрайт
      поджимается по вертикали, и основание ложится ровно в пятно. А чтобы
      оно не легло в край пятна, масштаб умножен на «крупность» mul — общее
      правило зазора, см. «правило посадки» ниже.

   3. Правила места. Ставить можно на траву (не на воду и не на песок),
      не на другую постройку. Всё, что растёт в пятне, — не запрет, а
      «расчистка»: генератор не игра, и вычистить площадку под стройку
      честнее, чем искать поляну. Кто хочет строго — включает «только
      чистое место», и тогда занятое пятно не годится.

      Расчищается всё, включая кусты, траву и цветы. Первая версия считала
      помехой только деревья и камни, а украшения оставляла: по глубине они
      попадают в переднюю половину пятна и рисуются ПОСЛЕ дома, то есть
      куст торчит прямо по стене (и это не ошибка порядка отрисовки —
      он честно ближе к камере, ошибка была в том, что его там оставили). */
(function (global) {
  'use strict';

  var T = global.WorldGen ? global.WorldGen.T : { SAND: 3, GRASS: 4 };

  // Пятно застройки по повороту, клетки. Длинная сторона ратуши — по X.
  var FOOTPRINT = {
    0: { w: 4, h: 3 },
    90: { w: 3, h: 4 },
    180: { w: 4, h: 3 },
    270: { w: 3, h: 4 }
  };

  var ROTS = [0, 90, 180, 270];

  function footprint(rot) {
    return FOOTPRINT[((rot % 360) + 360) % 360] || FOOTPRINT[0];
  }

  function spriteFrom(img, f) {
    return {
      img: img,
      sx: f.x, sy: f.y, sw: f.w, sh: f.h,
      // Точка опоры: пиксель кадра, куда проецируется центр пятна застройки.
      ax: f.anchorX / f.w,
      ay: f.anchorY / f.h,
      footprint: f.footprint || null,
      // Наземный контур (цоколь вместе с крыльцом) в клетках от точки опоры.
      // Считает упаковщик атласа (tools/pack_townhall.py): по пикселям кадра
      // это единственное место, где его видно.
      ground: f.ground || null
    };
  }

  /* Куда сдвинуть точку опоры, чтобы в середине пятна оказалась середина
     НАЗЕМНОГО контура, а не центр модели. Разница не украшение: у ратуши
     сбоку крыльцо и приступок, они выходят за пятно на 0.6 клетки, и по
     модели основание стоит не по середине — с одной стороны зазор, с другой
     деталь торчит за край. Контур меряется при крупности 1, поэтому сдвиг
     умножается на ту же крупность: масштаб тянет контур к точке опоры. */
  function anchorShift(spr, mul) {
    var g = spr && spr.ground;
    if (!g) return { x: 0, y: 0 };
    var k = mul === undefined ? 1 : mul;
    return { x: (g[0] + g[1]) / 2 * k, y: (g[2] + g[3]) / 2 * k };
  }

  /* ---------------------- правило посадки: зазор до края ----------------- *
   *
   * Требование заказчика (2026-10-13): здание не встаёт вплотную к краям
   * клеток своего пятна. Между основанием и краем пятна остаётся треть
   * клетки — и это правило общее: так встаёт любая постройка, а не только
   * ратуша. Правило живёт здесь, в одном месте, и распространяется на все
   * атласы построек: пятно застройки у каждого своё, а зазор один.
   *
   * Почему зазор делается масштабом, а не моделью поменьше. Спрайт
   * отрисован с пятном в натуральную величину: один юнит модели — клетка
   * карты. Значит, чтобы основание отошло от края, достаточно поджать
   * спрайт к его точке опоры — это и делает множитель mul в scaleAt.
   * Перерисовывать ради этого модель незачем: пятно, проверка места,
   * подсветка и порядок отрисовки считаются по клеткам и о масштабе
   * спрайта ничего не знают.
   *
   * Почему зазор считается по длинной стороне пятна. Масштаб у спрайта один
   * на обе оси: если тянуть оси по-разному, основание перестаёт быть
   * прямоугольником в проекции и его стены перестают совпадать с
   * направлениями клеток — видно, что дом стоит криво. Поэтому зазор по
   * короткой стороне выходит меньше ровно во столько раз, во сколько она
   * короче: у пятна 4 x 3 при зазоре 1/3 клетки по длинной стороне по
   * короткой выходит 1/4. У квадратного пятна (сарай, башня — 2 x 2)
   * зазоры совпадают.
   *
   * Множитель проверяется в tools/place.js: он сравнивает масштаб с
   * правилом и меряет, что силуэт спрайта больше не вылезает за пятно.
   * ---------------------------------------------------------------------- */
  var BASE_MARGIN = 1 / 3;                 // клетки, по длинной стороне пятна

  /* Длинная сторона пятна по всем кадрам атласа. Поворот её не меняет
     (4 x 3 и 3 x 4 — одна и та же четвёрка), поэтому масштаб у всех
     поворотов один: иначе при повороте здание меняло бы размер. */
  function longestSide(meta) {
    var frames = (meta && meta.frames) || {}, side = 0;
    for (var name in frames) {
      var fp = frames[name].footprint;
      if (!fp) continue;
      side = Math.max(side, fp[0], fp[1]);
    }
    return side;
  }

  // 1 — основание ровно в край пятна (как было до правила), меньше —
  // зазор BASE_MARGIN с каждой стороны длинной стороны.
  function fitMul(side) {
    return side > 0 ? 1 - 2 * BASE_MARGIN / side : 1;
  }

  // Зазоры по сторонам пятна в клетках — то, что видно на карте.
  // По длинной стороне это ровно BASE_MARGIN, по короткой — меньше во
  // столько раз, во сколько она короче: масштаб-то один.
  function gaps(fp) {
    var w = fp.w === undefined ? fp[0] : fp.w;
    var h = fp.h === undefined ? fp[1] : fp.h;
    var k = fitMul(Math.max(w, h));
    return { long: Math.max(w, h) * (1 - k) / 2, short: Math.min(w, h) * (1 - k) / 2 };
  }

  function joinPath(base, rel) {
    if (!base) return rel;
    return base.charAt(base.length - 1) === '/' ? base + rel : base + '/' + rel;
  }

  /* ------------------------------- загрузка ------------------------------ */

  // Как и у основного атласа: сначала готовый скрипт (работает по file://),
  // затем JSON — запасной путь для http.
  function load(opts, onReady, onError) {
    opts = opts || {};
    var base = opts.base || 'assets/';
    var dir = opts.dir || 'townhall/';
    var meta = global.TOWNHALL_ATLAS;
    if (meta) { loadImage(meta, base, dir, onReady, onError); return; }
    if (typeof fetch !== 'function') { onError(new Error('нет ни atlas.js ратуши, ни fetch')); return; }
    fetch(joinPath(base, dir + 'atlas.json')).then(function (r) {
      if (!r.ok) throw new Error('townhall/atlas.json: HTTP ' + r.status);
      return r.json();
    }).then(function (json) {
      global.TOWNHALL_ATLAS = json;
      loadImage(json, base, dir, onReady, onError);
    }).catch(onError);
  }

  function loadImage(meta, base, dir, onReady, onError) {
    var src = joinPath(base, dir + meta.atlas);
    var img = new Image();
    img.onerror = function () { onError(new Error('не загрузился атлас ратуши: ' + src)); };
    img.onload = function () { onReady(build(img, meta)); };
    img.src = src;
  }

  function build(img, meta) {
    var set = {
      img: img, meta: meta,
      ppu: meta.ppu || 80,
      az: (meta.az_deg === undefined ? 45 : meta.az_deg) * Math.PI / 180,
      el: (meta.el_deg === undefined ? 35.264389682754654 : meta.el_deg) * Math.PI / 180,
      /* Крупность. По умолчанию — из правила посадки: основание отходит от
         края пятна на BASE_MARGIN по длинной стороне (у ратуши 4 x 3 это
         5/6, то есть 1/3 клетки по длинной стороне и 1/4 по короткой).
         meta.mul — не «ручка на всякий случай», а исключение из правила:
         он нужен только там, где здание намеренно стоит не как все, и в
         атласах его нет. Если он появится, правило для этой постройки
         перестаёт действовать — tools/place.js это увидит и скажет. */
      mul: meta.mul === undefined ? fitMul(longestSide(meta)) : meta.mul,
      frames: {}
    };
    for (var name in meta.frames) {
      var f = meta.frames[name];
      if (!f.variant) continue;
      if (!set.frames[f.variant]) set.frames[f.variant] = {};
      set.frames[f.variant][f.rotation] = spriteFrom(img, f);
    }
    return set;
  }

  function sprite(set, variant, rot) {
    if (!set) return null;
    var v = set.frames[variant] || set.frames.a;
    if (!v) return null;
    return v[((rot % 360) + 360) % 360] || v[0];
  }

  /* ------------------------------- масштаб ------------------------------- */

  // Пиксели кадра на пиксель карты по осям. z — ширина ромба клетки.
  function scaleAt(set, z) {
    var ca = Math.cos(set.az), k = set.mul === undefined ? 1 : set.mul;
    return {
      x: k * z / (2 * ca * set.ppu),
      y: k * z / (4 * Math.sin(set.el) * ca * set.ppu)
    };
  }

  /* -------------------------------- пятно -------------------------------- */

  // Клетки пятна: x, y — верхняя (северная) клетка пятна, дальше вправо и вниз.
  function cells(b) {
    var fp = footprint(b.rot), out = [];
    for (var j = 0; j < fp.h; j++) {
      for (var i = 0; i < fp.w; i++) out.push({ x: b.x + i, y: b.y + j });
    }
    return out;
  }

  function bounds(b) {
    var fp = footprint(b.rot);
    return { x0: b.x, y0: b.y, x1: b.x + fp.w, y1: b.y + fp.h };
  }

  // Центр пятна в клетках: в него проецируется точка опоры спрайта.
  function center(b) {
    var fp = footprint(b.rot);
    return { x: b.x + fp.w / 2, y: b.y + fp.h / 2 };
  }

  /* Ключ глубины для порядка отрисовки — по центру пятна, как у объектов по их
     собственной точке.

     Пробовал считать по переднему углу пятна (так делают для многоклеточных
     объектов): тогда дом прячет всё, что не впереди его передней кромки, и
     куст у стены исчезает. Но вместе с кустом прячутся и деревья на три-четыре
     клетки впереди — их кроны режет линия крыши, а это заметнее и неправда:
     по земле они честно ближе камеры. Поэтому ключ остаётся по центру, а
     вплотную к стенам растительность просто не оставляют — двор расчищается
     (см. clearSite). */
  function depth(b) {
    var c = center(b);
    return c.x + c.y;
  }

  function overlaps(a, b) {
    var A = bounds(a), B = bounds(b);
    return A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1;
  }

  /* ---------------------------- проверка места --------------------------- */

  /* Всё, что стоит в клетках пятна: деревья, камни и украшения. Клетка
     объекта — та, где его основание, а не вся крона: дерево на соседней
     клетке зданию не мешает, даже если ветки над ним. */
  function occupants(world, b) {
    var fp = footprint(b.rot), out = [];
    var objs = world.objects;
    for (var i = 0; i < objs.length; i++) {
      var o = objs[i];
      var tx = Math.floor(o.x), ty = Math.floor(o.y);
      if (tx < b.x || ty < b.y || tx >= b.x + fp.w || ty >= b.y + fp.h) continue;
      out.push(o);
    }
    return out;
  }

  /* Всё, что стоит в пятне И в полосе yard клеток вокруг него — двор.

     Двор нужен не для красоты: куст в соседней с домом клетке по земле честно
     ближе камеры, чем центр пятна, и по порядку глубины рисуется поверх стены.
     Порядок тут не врёт — врёт картинка: куст, приклеенный к стене на высоте
     окон, читается как ошибка рендера. Поэтому вокруг дома растительности
     просто не остаётся: одна клетка двора убирает все случаи «вплотную». */
  function yardOccupants(world, b, yard) {
    if (!yard) return [];
    var fp = footprint(b.rot), out = [];
    var x0 = b.x - yard, y0 = b.y - yard;
    var x1 = b.x + fp.w + yard, y1 = b.y + fp.h + yard;
    var objs = world.objects;
    for (var i = 0; i < objs.length; i++) {
      var o = objs[i];
      var tx = Math.floor(o.x), ty = Math.floor(o.y);
      if (tx < x0 || ty < y0 || tx >= x1 || ty >= y1) continue;
      // пятно уже посчитано отдельно
      if (tx >= b.x && ty >= b.y && tx < b.x + fp.w && ty < b.y + fp.h) continue;
      out.push(o);
    }
    return out;
  }

  /* opts.clearable  — разрешено расчищать место (по умолчанию да);
     opts.requireClear — строго: занятое пятно не годится;
     opts.yard — сколько клеток вокруг пятна тоже расчищается (по умолчанию 1). */
  function canPlace(world, list, b, opts) {
    opts = opts || {};
    var fp = footprint(b.rot);
    var res = { ok: false, reason: '', blocked: [], yard: [], fp: fp };

    if (b.x < 0 || b.y < 0 || b.x + fp.w > world.width || b.y + fp.h > world.height) {
      res.reason = 'край карты';
      return res;
    }

    var water = 0, sand = 0, i, j, c;
    for (j = 0; j < fp.h; j++) {
      for (i = 0; i < fp.w; i++) {
        c = world.tile[(b.y + j) * world.width + (b.x + i)];
        if (c === T.GRASS) continue;
        if (c === T.SAND) sand++; else water++;
      }
    }
    if (water) { res.reason = 'вода'; return res; }
    if (sand) { res.reason = 'песок'; return res; }

    for (i = 0; i < list.length; i++) {
      if (!list[i] || list[i] === b) continue;
      if (overlaps(b, list[i])) { res.reason = 'тут уже стоит постройка'; return res; }
    }

    res.blocked = occupants(world, b);
    res.yard = yardOccupants(world, b, opts.yard === undefined ? 1 : opts.yard);
    if (res.blocked.length && (opts.requireClear || opts.clearable === false)) {
      res.reason = 'мешают растения и камни: ' + res.blocked.length;
      return res;
    }

    res.ok = true;
    var n = res.blocked.length + res.yard.length;
    res.reason = n ? 'площадку и двор расчистим: ' + n : 'место свободно';
    return res;
  }

  /* Убирает из мира всё, что попало в пятно и в двор. Возвращает, сколько
     убрано. Заодно правит сводку мира: без этого панель продолжала бы
     показывать деревья, которых на карте уже нет. */
  function clearSite(world, b, opts) {
    var yard = opts && opts.yard !== undefined ? opts.yard : 1;
    var blocked = occupants(world, b).concat(yardOccupants(world, b, yard));
    if (!blocked.length) return 0;
    var objs = world.objects, keep = [];
    for (var i = 0; i < objs.length; i++) {
      if (blocked.indexOf(objs[i]) < 0) keep.push(objs[i]);
    }
    var removed = objs.length - keep.length;
    world.objects = keep;
    if (world.stats) {
      var s = world.stats;
      for (i = 0; i < blocked.length; i++) {
        var o = blocked[i];
        if (o.kind === 'tree') { if (s.trees) s.trees--; }
        else if (o.kind === 'stone') {
          if (o.mineable) { if (s.rocks) s.rocks--; if (s.mineable) s.mineable--; }
          else if (s.smallRocks) s.smallRocks--;
        } else if (s.decor) s.decor--;
      }
    }
    return removed;
  }

  /* --------------------------- поиск места подряд ------------------------ */

  /* Куда поставить ратушу, если ставит не человек, а кнопка «поставить все
     три». Это не случайный поиск: один и тот же сид должен давать одну и ту
     же расстановку, поэтому кандидаты перебираются по порядку, а выбор —
     по счёту, а не по жребию.

     Счёт: сколько придётся расчистить (дорого), насколько далеко от середины
     карты (хотим умеренно близко — там суша) и насколько близко к уже
     поставленным (не хотим строить вплотную). */
  function findSpot(world, list, variant, rot, opts) {
    opts = opts || {};
    var minSep = opts.minSep === undefined ? 7 : opts.minSep;
    var ideal = Math.min(world.width, world.height) * 0.18;
    var best = null, bestScore = Infinity;
    var step = opts.step || 2;
    var cx = world.width / 2, cy = world.height / 2;

    for (var y = 0; y <= world.height; y += step) {
      for (var x = 0; x <= world.width; x += step) {
        var b = { variant: variant, rot: rot, x: x, y: y };
        var chk = canPlace(world, list, b, opts);
        if (!chk.ok) continue;
        var score = chk.blocked.length * 4;   // чем меньше расчистки, тем лучше
        var d = Math.hypot(x + 1.5 - cx, y + 1.5 - cy);
        score += Math.abs(d - ideal) * 0.8;
        for (var i = 0; i < list.length; i++) {
          var c2 = center(list[i]);
          var dd = Math.hypot(x + 1.5 - c2.x, y + 1.5 - c2.y);
          if (dd < minSep) score += (minSep - dd) * 20;
        }
        if (score < bestScore) { bestScore = score; best = b; }
      }
    }
    return best;
  }

  // Ставит три варианта ратуши: A, B, C. Возвращает список поставленных.
  function placeAll(world, opts) {
    opts = opts || {};
    var out = [], rots = opts.rotations || [0, 180, 0];
    var variants = opts.variants || ['a', 'b', 'c'];
    for (var i = 0; i < variants.length; i++) {
      var spot = findSpot(world, out, variants[i], rots[i % rots.length], opts);
      if (!spot) continue;
      var chk = canPlace(world, out, spot, opts);
      if (opts.clear) clearSite(world, spot, opts);
      out.push(spot);
    }
    return out;
  }

  /* --- ратуша игрока ---------------------------------------------------- *
   *
   * Первая постройка партии: она не «ставится игроком», а уже стоит, когда
   * карта открывается. Место — у центра острова, но не в одной и той же
   * клетке от карты к карте: у каждого сида своя ратуша, и «случайность»
   * здесь детерминированная, как и всё остальное в генераторе. Один сид —
   * одна карта, одна ратуша, одно место.
   *
   * Разброс намеренно небольшой: центр острова — единственное место, про
   * которое заранее известно, что там суша, и ратуша не должна оказаться
   * у самой воды. Кандидаты перебираются в круге радиуса ~1/8 острова, и
   * берётся первый, под который не нужно ничего расчищать: дерево под
   * стенами — не катастрофа (clearSite его уберёт), но начинать партию
   * с вырубки рощи посреди будущей площади незачем.
   * -------------------------------------------------------------------- */
  function homeSpot(world, opts) {
    opts = opts || {};
    var variant = opts.variant || 'c';
    var rot = opts.rot === undefined ? 90 : opts.rot;
    var fp = footprint(rot);
    var b = world.landBounds || { x0: 0, y0: 0, x1: world.width, y1: world.height };
    var cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    var R = Math.max(2, ((b.x1 - b.x0) + (b.y1 - b.y0)) * 0.06);
    var place = { clearable: true, requireClear: false, yard: 1 };
    // Сид ратуши отдельный: он не должен зависеть от того, сколько деревьев
    // генератор успел поставить до этого.
    var rng = new global.RNG((world.seedInt ^ 0x5bf03635) >>> 0);
    var fallback = null;

    for (var i = 0; i < 96; i++) {
      var ang = rng.range(0, Math.PI * 2);
      var r = Math.sqrt(rng.next()) * R;
      var cand = {
        variant: variant, rot: rot,
        x: Math.round(cx + Math.cos(ang) * r - fp.w / 2),
        y: Math.round(cy + Math.sin(ang) * r - fp.h / 2)
      };
      var chk = canPlace(world, [], cand, place);
      if (!chk.ok) continue;
      if (!chk.blocked.length) return cand;      // чистое место у центра
      if (!fallback) fallback = cand;
    }
    if (fallback) return fallback;
    // Совсем не повезло: вокруг центра вода или песок. Тогда ищем по карте
    // тем же поиском, что и «поставить все три», только без соседей.
    return findSpot(world, [], variant, rot, { clearable: true, minSep: 0 });
  }

  global.Buildings = {
    ROTS: ROTS,
    BASE_MARGIN: BASE_MARGIN,
    load: load,
    build: build,
    sprite: sprite,
    scaleAt: scaleAt,
    longestSide: longestSide,
    fitMul: fitMul,
    gaps: gaps,
    anchorShift: anchorShift,
    footprint: footprint,
    cells: cells,
    bounds: bounds,
    center: center,
    depth: depth,
    overlaps: overlaps,
    canPlace: canPlace,
    clearSite: clearSite,
    occupants: occupants,
    yardOccupants: yardOccupants,
    findSpot: findSpot,
    placeAll: placeAll,
    homeSpot: homeSpot
  };
})(typeof window !== 'undefined' ? window : globalThis);
