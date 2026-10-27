/* waves.js — гребни волн: атлас спрайтов и поле гребней на море.

   Волна в этой игре — не нарисованная линия и не узор-текстура, а такие же
   низкополигональные модели, как деревья, камни и ратуша: их отрисовал
   Blender в конвенциях атласа (азимут 45°, подъём 35.2644°, солнце
   сверху-слева), потом `waves/tools/compose_waves.py` собрал спрайты, а
   `tools/pack_waves.py` — атлас. Здесь только две вещи: загрузка атласа и
   раскладка гребней по морю.

   Раскладка — не сетка и не полосы. Гребни ставятся по клеткам решётки
   (CELL клеток), но каждая клетка хешем задаёт своё смещение внутри неё,
   свою форму, свой размер и свою скорость. Хеш — от координат клетки, так
   что поле не меняется от кадра к кадру и не «кипит»: гребень, который
   сейчас на экране, останется тем же и через минуту. Время входит только
   сдвигом вдоль течения и лёгким покачиванием.

   Куда бежит волна: вдоль оси x мира — по экрану это диагональ вниз-вправо.
   Спрайты формы 0 нарисованы валом вдоль течения, формы 90 — поперёк (см.
   waves/README.md про то, почему поворот именно 90°).
*/
(function (global) {
  'use strict';

  // Решётка редкая: гребень — это пена на воде, а не ковёр. На клетку поля
  // приходится примерно один гребень из трёх, и между ними видно саму воду.
  var CELL = 7.2;           // клеток между соседними гребнями в решётке
  var FILL = 0.45;          // доля занятых клеток поля
  var FLOW = 11.5;          // клеток в секунду: волна бежит по оси x
  var BOB = 0.055;          // клеток: насколько гребень покачивает по вертикали

  /* ------------------------------- загрузка ------------------------------ */

  function joinPath(base, rel) {
    if (!base) return rel;
    return base.charAt(base.length - 1) === '/' ? base + rel : base + '/' + rel;
  }

  function load(opts, onReady, onError) {
    opts = opts || {};
    var base = opts.base || 'assets/';
    var dir = opts.dir || 'waves/';
    var metaName = opts.metaName || 'WAVE_ATLAS';
    var meta = global[metaName];
    if (meta) { loadImage(meta, base, dir, onReady, onError); return; }
    if (typeof fetch !== 'function') { onError(new Error('нет ни atlas.js волн, ни fetch')); return; }
    fetch(joinPath(base, dir + 'atlas.json')).then(function (r) {
      if (!r.ok) throw new Error('waves/atlas.json: HTTP ' + r.status);
      return r.json();
    }).then(function (json) {
      global[metaName] = json;
      loadImage(json, base, dir, onReady, onError);
    }).catch(onError);
  }

  function loadImage(meta, base, dir, onReady, onError) {
    var src = joinPath(base, dir + meta.atlas);
    var img = new Image();
    img.onerror = function () { onError(new Error('не загрузился атлас волн: ' + src)); };
    img.onload = function () { onReady(build(img, meta)); };
    img.src = src;
  }

  function build(img, meta) {
    var set = { img: img, meta: meta, ppu: meta.ppu || 120,
                az: (meta.az_deg === undefined ? 45 : meta.az_deg) * Math.PI / 180,
                el: (meta.el_deg === undefined ? 35.264389682754654 : meta.el_deg) * Math.PI / 180,
                along: [], across: [] };
    for (var name in meta.frames) {
      var f = meta.frames[name];
      var spr = {
        img: img,
        sx: f.x, sy: f.y, sw: f.w, sh: f.h,
        ax: f.anchorX / f.w, ay: f.anchorY / f.h, units: f.units || 1
      };
      // 0 — вал вдоль течения, 90 — поперёк: две разные роли в море, и
      // смешивать их в одном списке нельзя, у них разная плотность.
      (f.rotation === 90 ? set.across : set.along).push(spr);
    }
    return set;
  }

  /* ------------------------------- масштаб ------------------------------- */

  // Пиксели атласа на пиксель карты. Та же формула, что у ратуши: юнит
  // модели обязан лечь в клетку карты, а клетка — ромб 2:1, тогда как камера
  // рендера поднята на 35.2644°, поэтому по осям масштаб разный.
  function scaleAt(set, z) {
    var ca = Math.cos(set.az);
    return {
      x: z / (2 * ca * set.ppu),
      y: z / (4 * Math.sin(set.el) * ca * set.ppu)
    };
  }

  /* ------------------------------ поле гребней --------------------------- */

  // Хеш клетки: три независимых числа из пары координат. Без Math.random —
  // поле обязано быть одним и тем же в каждом кадре.
  function hash(i, j) {
    var h = i * 374761393 + j * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    h = h ^ (h >> 16);
    var a = (h >>> 0) / 4294967296;
    var h2 = (h * 2246822519 + 374761393) | 0;
    h2 = h2 ^ (h2 >> 15);
    var b = (h2 >>> 0) / 4294967296;
    var h3 = (h2 * 3266489917 + 668265263) | 0;
    h3 = h3 ^ (h3 >> 13);
    return [a, b, (h3 >>> 0) / 4294967296];
  }

  /* Гребни, попадающие в клеточный прямоугольник [x0..x1] × [y0..y1].

     time — секунды. Течение сдвигает всё поле вдоль оси x, поэтому клетки
     решётки перебираются не вокруг кадра, а вокруг кадра, сдвинутого назад
     на этот сдвиг: иначе с каждым кадром в выборку попадали бы всё новые
     клетки, а сами гребни уезжали бы из неё. Так у каждого гребня есть
     постоянное имя (i, j) на всю партию: он не мигает и не меняет форму,
     пока виден.

     Список отдаётся наружу: проекцию мира в экран знает только рендер, и
     второй её копии здесь быть не должно. */
  function crests(set, box, time) {
    if (!set || (!set.along.length && !set.across.length)) return [];
    var out = [];
    var shift = time * FLOW;
    var i0 = Math.floor((box.x0 - shift) / CELL) - 1;
    var i1 = Math.ceil((box.x1 - shift) / CELL) + 1;
    var j0 = Math.floor(box.y0 / CELL) - 1;
    var j1 = Math.ceil(box.y1 / CELL) + 1;

    for (var i = i0; i <= i1; i++) {
      for (var j = j0; j <= j1; j++) {
        var h = hash(i, j);
        // Часть клеток пустая: сплошное поле гребней читается ковром.
        if (h[0] > FILL) continue;
        var across = h[1] < 0.3;                     // поперёк течения — реже
        var pool = across ? set.across : set.along;
        if (!pool.length) continue;
        // Форма выбирается со смещением: вдоль течения чаще длинный накат,
        // поперёк — короткая пена. Ряд одинаковых гребней читается узором. 
        var pr = (h[0] * 42967) % 1, pick = Math.floor(pool.length * Math.pow(pr, 1.7));
        if (across) pick = pool.length - 1 - pick;
        if (pick < 0) pick = 0;
        if (pick >= pool.length) pick = pool.length - 1;
        // Размер вразнобой и с перекосом в мелкое: крупных гребней мало, и
        // именно они задают море, а мелочь заполняет промежутки. Одинаковые
        // гребни в ряд читаются узором, а море должно быть нестроевым.
        var r1 = (h[1] * 7919) % 1, r2 = (h[2] * 104729) % 1;
        // Мелких гребней много, крупных мало — но и крупный не больше
        // примерно полутора клеток в длину: на воде это уже не гребень,
        // а льдина.
        var big = r1 * r1;
        out.push({
          x: i * CELL + (h[0] - 0.5) * CELL + shift,
          y: j * CELL + (h[1] - 0.5) * CELL,
          spr: pool[pick],
          scale: 0.7 + big * 0.75,
          // Растяжение по осям врозь: форма гребня тоже должна гулять.
          kx: 0.88 + ((h[0] * 6151) % 1) * 0.24,
          ky: 0.85 + r2 * 0.3,
          // Прозрачность невысокая: пена лежит на воде, а не поверх неё.
          alpha: (across ? 0.28 : 0.34) + r2 * 0.36,
          bob: BOB * Math.sin(time * 1.7 + h[2] * 6.283)
        });
      }
    }
    return out;
  }

  global.Waves = {
    load: load,
    scaleAt: scaleAt,
    crests: crests,
    CELL: CELL,
    FILL: FILL,
    FLOW: FLOW
  };
})(typeof window !== 'undefined' ? window : globalThis);
