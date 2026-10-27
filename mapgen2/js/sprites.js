/* sprites.js — спрайты объектов из атласа Blender.

   Модели низкополигональные, но рисовать их в 3D на карте с тысячами деревьев
   незачем: спрайты пекутся один раз и дальше стоят копейки. У каждого объекта
   четыре поворота через 90° — этого достаточно, чтобы роща не выглядела
   копипастой, и не нужно тащить матрицы отражения в кадр отрисовки.

   Кадр выбирается детерминированно по координате объекта, а не по счётчику:
   при повторной отрисовке (или после перегенерации того же сида) карта
   выглядит ровно так же и не «мерцает». */
(function (global) {
  'use strict';

  // Какое имя объекта из мира соответствует префиксу кадра в атласе
  var FRAME_PREFIX = {
    tree: { oak: 'tree_oak', pine: 'tree_pine', birch: 'tree_birch', autumn: 'tree_autumn' },
    stone: {
      pebble: 'rock_pebble', boulder: 'rock_boulder', rock: 'rock_cluster',
      iron: 'ore_iron', salt: 'salt_crystals'
    },
    bush: ['bush', 'bush_berry'],
    reed: ['reeds'],
    tuft: ['grass_tuft'],
    flower: { f1: 'flower_white', f2: 'flower_yellow', f3: 'flower_pink' }
  };

  var ROTS = 4;                       // поворотов на модель
  var ROT_STEP = 90;

  function framesOf(meta, baseName) {
    var out = [];
    for (var i = 0; i < ROTS; i++) {
      var f = meta.frames[baseName + '_' + (i * ROT_STEP)];
      if (f) out.push(f);
    }
    return out;
  }

  function spriteFrom(img, f) {
    return {
      img: img,
      sx: f.x, sy: f.y, sw: f.w, sh: f.h,
      // Точка опоры: пиксель в кадре, куда проецируется центр клетки.
      ax: f.anchorX / f.w,
      ay: f.anchorY / f.h
    };
  }

  // Загрузка атласа. Файл-скрипт (atlas.js) даёт данные сразу и работает
  // с file:// без запросов; JSON — запасной путь для http-сервера.
  function load(opts, onReady, onError) {
    opts = opts || {};
    // base — путь к папке ассетов, например 'assets/'. Путь к самому атласу
    // лежит внутри meta.atlas и задан относительно неё, поэтому склеивать
    // их «в лоб» нельзя: получится assets/sprites/sprites/atlas.png.
    var base = opts.base || 'assets/';
    var metaName = opts.metaName || 'SPRITE_ATLAS';
    var meta = global[metaName];
    if (meta) { loadImage(meta, base, opts, onReady, onError); return; }

    if (typeof fetch !== 'function') { onError(new Error('нет ни atlas.js, ни fetch')); return; }
    var metaPath = (metaName === 'MOBILE_SPRITE_ATLAS')
      ? 'sprites/mobile/atlas.json' : 'sprites/atlas.json';
    fetch(joinPath(base, metaPath)).then(function (r) {
      if (!r.ok) throw new Error('atlas.json: HTTP ' + r.status);
      return r.json();
    }).then(function (json) {
      global[metaName] = json;
      loadImage(json, base, opts, onReady, onError);
    }).catch(onError);
  }

  // Склейка путей без двойных слэшей
  function joinPath(base, rel) {
    if (!base) return rel;
    return base.charAt(base.length - 1) === '/' ? base + rel : base + '/' + rel;
  }

  function loadImage(meta, base, opts, onReady, onError) {
    var src = joinPath(base, meta.atlas);
    var img = new Image();
    img.onerror = function () { onError(new Error('не загрузился атлас: ' + src)); };
    img.onload = function () { onReady(build(img, meta, opts)); };
    img.src = src;
    return src;
  }

  function build(img, meta, opts) {
    var set = { tree: {}, stone: {}, bush: [], reed: [], tuft: [], flower: {}, meta: meta };
    var kind, key, frames, arr, names, i, k;

    for (kind in FRAME_PREFIX) {
      var spec = FRAME_PREFIX[kind];
      if (kind === 'tree' || kind === 'stone' || kind === 'flower') {
        for (key in spec) {
          frames = framesOf(meta, spec[key]);
          if (frames.length) set[kind][key] = frames.map(function (f) { return spriteFrom(img, f); });
        }
      } else {
        names = spec;
        arr = [];
        for (i = 0; i < names.length; i++) {
          frames = framesOf(meta, names[i]);
          for (k = 0; k < frames.length; k++) arr.push(spriteFrom(img, frames[k]));
        }
        set[kind] = arr;
      }
    }

    /* Перевод единиц — самое неочевидное место во всём рендере.

       В атласе лежат готовые картинки моделей, а не сами модели. Поле ppu
       (пикселей на юнит) относится к юнитам Blender, а не к клеткам карты:
       у дуба кадр 107 px в ширину, и это ~10.7 юнита модели, то есть один
       юнит модели — это ~10 px атласа, а вовсе не 96.

       Поэтому спрайт сопоставляется с клеткой через размер кадра:
       доля клетки = frameW / ppu / tileUnits, где tileUnits — сколько
       юнитов карты приходится на клетку. При mul = 1 кадр занимает ровно
       эту долю. Дальше mul просто задаёт «крупность» мира. */
    set.ppu = meta.ppu || 96;
    set.tileUnits = opts.tileUnits === undefined ? 1 : opts.tileUnits;
    // 5 подобрано так, чтобы крона дуба занимала ~1.5 клетки: дерево
    // перекрывает соседей ровно настолько, чтобы роща читалась рощей.
    set.mul = opts.mul === undefined ? 1.35 : opts.mul;
    return set;
  }

  // Спрайт для объекта: аррей кадров по виду и варианту.
  function framesFor(set, obj) {
    if (obj.kind === 'tree') return set.tree[obj.variant] || set.tree.oak;
    if (obj.kind === 'stone') return set.stone[obj.variant] || set.stone.boulder;
    if (obj.kind === 'bush') return set.bush;
    if (obj.kind === 'reed') return set.reed;
    if (obj.kind === 'tuft') return set.tuft;
    if (obj.kind === 'flower') return set.flower[obj.variant] || set.flower.f1;
    return null;
  }

  // Выбор кадра. Хеш считается по координате и варианту, поэтому поворот
  // не меняется, пока объект не переставили.
  function pick(set, obj) {
    var arr = framesFor(set, obj);
    if (!arr || !arr.length) return null;
    if (arr.length === 1) return arr[0];
    var h = global.Noise.hash2i(
      Math.round(obj.x * 977), Math.round(obj.y * 1021),
      (obj.kind === 'stone' ? 7717 : 4242) + (obj.variant ? obj.variant.length * 31 : 0)
    );
    return arr[Math.min(arr.length - 1, Math.floor(h * arr.length))];
  }

  global.Sprites = { load: load, build: build, pick: pick, framesFor: framesFor, FRAME_PREFIX: FRAME_PREFIX };
})(typeof window !== 'undefined' ? window : globalThis);
