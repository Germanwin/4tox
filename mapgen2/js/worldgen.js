/* worldgen.js — генерация мира.

   Что получается на выходе: квадратная карта, внутри которой лежит материк,
   а по краям — вода. Берег неровный: полуострова, косы, заливы. Биом суши
   один — трава, поэтому «разнообразие» даёт не биом, а рельеф берега, пятна
   леса и каменистые выходы.

   Три вещи, которые определяют вид карты:

   1. Квадратная маска. Высота = шум × близость к центру, где близость
      считается по метрике суперэллипса |x|^p + |y|^p. При p = 2 это был бы
      круг (остров), при p → ∞ — квадрат с резкими углами. 3.4 даёт квадрат
      с мягкими углами: материк заполняет карту, а не висит в ней шаром.

   2. Порог воды — по квантилю, а не по абсолютной высоте. «72 % суши»
      значит ровно 72 % площади при любом сиде и любом размере. Без этого
      состав карты уезжает от сида к сиду и ломает расстановку ресурсов.

   3. Объекты ставятся по непрерывным полям (лес, камень), а не по битому
      шуму на клетку. Поэтому деревья собираются в рощи и в опушки, а камни —
      в выходы, и между ними остаётся чистое место под стройку. */
(function (global) {
  'use strict';

  var NZ = global.Noise;

  // Классы клеток. Вода разделена по глубине: это не биом, а способ
  // нарисовать берег мягко, без ступеньки «вода/земля» в один пиксель.
  var T = { DEEP: 0, WATER: 1, SHALLOW: 2, SAND: 3, GRASS: 4 };
  var TILE_NAMES = { 0: 'Глубина', 1: 'Вода', 2: 'Отмель', 3: 'Песок', 4: 'Трава' };

  var VARIANT_NAMES = {
    oak: 'Дуб', pine: 'Сосна', birch: 'Берёза', autumn: 'Осеннее дерево',
    pebble: 'Галька', boulder: 'Валун', rock: 'Каменный выход',
    iron: 'Железная руда', salt: 'Соль'
  };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smoothstep(a, b, x) {
    var t = clamp01((x - a) / (b - a || 1e-6));
    return t * t * (3 - 2 * t);
  }

  var DEFAULTS = {
    seed: 'тихая-долина-701',
    size: 64,          // домен острова: size × size клеток
    land: 0.72,        // доля суши (от домена острова, не от картинки)
    coast: 0.5,        // 0 — ровный берег, 1 — рваный
    forest: 0.5,       // сколько суши занимают рощи
    rock: 0.5,         // сколько суши занимает камень
    trees: 0.45,       // плотность деревьев внутри рощ
    rocks: 0.6,        // плотность камней внутри каменистых выходов
    sea: null          // ширина моря вокруг острова в клетках; null — посчитать
  };

  /* ------------------------------------------------------------------ *
   *  Маска материка                                                    *
   * ------------------------------------------------------------------ */

  // Нормированное расстояние до края по метрике суперэллипса.
  // 0 — граница карты, 1 — центр. p управляет «квадратностью» углов:
  // p = 2 это круг, p → ∞ — квадрат.
  function squareMask(u, v, p) {
    var a = Math.pow(Math.abs(u), p) + Math.pow(Math.abs(v), p);
    return Math.pow(a, 1 / p);          // нормированное расстояние 0…1
  }

  // Пологая кривая материка: превращает расстояние в плато с мягким склоном.
  // Без неё суперэллипс даёт узкий холм в центре и море по всей карте;
  // с ней суша занимает середину, а склон к берегу остаётся пологим —
  // именно по нему и гуляет шум, вырезая косы и заливы.
  function shelf(a, power) {
    if (a >= 1) return 0;
    if (a <= 0) return 1;
    return 1 - Math.pow(a, power);
  }

  /* ------------------------------------------------------------------ *
   *  Расстояние до берега                                              *
   * ------------------------------------------------------------------ */

  // Двухпроходный chamfer: точное евклидово расстояние по сетке.
  // Нужно, чтобы: песок лёг только у самой кромки, отмель — полосой вдоль
  // берега, а объекты не спавнились у воды.
  function distanceTransform(mask, W, H, maxD) {
    var INF = 1e9, N = W * H;
    var d = new Float32Array(N);
    var i, x, y;
    for (i = 0; i < N; i++) d[i] = mask[i] ? INF : 0;

    var D1 = 0.95509, D2 = 1.36930;   // chamfer 3×3, ошибка < 2 %

    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        i = y * W + x;
        if (d[i] === 0) continue;
        var best = d[i];
        if (y > 0) {
          if (d[i - W] + 1 < best) best = d[i - W] + 1;
          if (x > 0 && d[i - W - 1] + D2 < best) best = d[i - W - 1] + D2;
          if (x < W - 1 && d[i - W + 1] + D2 < best) best = d[i - W + 1] + D2;
        }
        if (x > 0 && d[i - 1] + 1 < best) best = d[i - 1] + 1;
        d[i] = best;
      }
    }
    for (y = H - 1; y >= 0; y--) {
      for (x = W - 1; x >= 0; x--) {
        i = y * W + x;
        if (d[i] === 0) continue;
        var b2 = d[i];
        if (y < H - 1) {
          if (d[i + W] + 1 < b2) b2 = d[i + W] + 1;
          if (x > 0 && d[i + W - 1] + D2 < b2) b2 = d[i + W - 1] + D2;
          if (x < W - 1 && d[i + W + 1] + D2 < b2) b2 = d[i + W + 1] + D2;
        }
        if (x < W - 1 && d[i + 1] + 1 < b2) b2 = d[i + 1] + 1;
        if (b2 > maxD) b2 = maxD;
        d[i] = b2;
      }
    }
    return d;
  }

  /* ------------------------------------------------------------------ *
   *  Сглаживание                                                       *
   * ------------------------------------------------------------------ */

  // Box-фильтр радиусом r. Считается через бегущую сумму, поэтому проход
  // стоит O(N), а не O(N·r²). Двух проходов хватает, чтобы убрать одиночные
  // клетки: они дают «соль с перцем» вдоль берега и мешают увидеть материк.
  // Считается по временному буферу: результат не должен влиять сам на себя.
  function boxBlur(field, W, H, r) {
    if (r < 1) return field;
    var tmp = new Float32Array(field.length);
    var x, y, i, sum, c, lo, hi, w = r * 2 + 1;

    for (y = 0; y < H; y++) {
      var row = y * W;
      sum = 0;
      for (x = -r; x <= r; x++) sum += field[row + clamp(x, 0, W - 1)];
      for (x = 0; x < W; x++) {
        tmp[row + x] = sum / w;
        lo = clamp(x - r, 0, W - 1);
        hi = clamp(x + r + 1, 0, W - 1);
        sum += field[row + hi] - field[row + lo];
      }
    }

    for (x = 0; x < W; x++) {
      sum = 0;
      for (y = -r; y <= r; y++) sum += tmp[clamp(y, 0, H - 1) * W + x];
      for (y = 0; y < H; y++) {
        field[y * W + x] = sum / w;
        lo = clamp(y - r, 0, H - 1);
        hi = clamp(y + r + 1, 0, H - 1);
        sum += tmp[hi * W + x] - tmp[lo * W + x];
      }
    }
    return field;
  }

  /* ------------------------------------------------------------------ *
   *  Генерация                                                         *
   * ------------------------------------------------------------------ */

  function generate(userParams) {
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var p = {};
    for (var k in DEFAULTS) p[k] = DEFAULTS[k];
    if (userParams) for (var k2 in userParams) if (userParams[k2] !== undefined) p[k2] = userParams[k2];

    var GW = Math.max(24, Math.round(p.size));
    var GH = GW;                       // форма границ карты — квадрат
    var N = GW * GH;
    var RNG = global.RNG;
    var rng = new RNG(p.seed);
    var S = rng.seed;

    /* --- 1. Поля ---------------------------------------------------- */

    // Смещение материка внутри карты: он не всегда ровно по центру.
    var cx = 0.5 + (rng.next() - 0.5) * 0.07;
    var cy = 0.5 + (rng.next() - 0.5) * 0.07;

    // Форма: базовая маска (крупная) + хребтовый шум (косы и заливы)
    // + мелкий fBm (рваная кромка).
    var shapeSeed = (S ^ 0x51ed2701) | 0;
    var coastSeed = (S ^ 0x1b873593) | 0;
    var edgeSeed = (S ^ 0x2545f491) | 0;

    var P_SHELF = 1.4;                                  // пологость склона к берегу
    var P_MASK = lerp(3.2, 5.0, p.coast);               // «квадратность» углов
    var A_RIDGE = 0.18 + 0.34 * p.coast;                // вклад хребтового шума
    var A_EDGE = 0.04 + 0.08 * p.coast;                 // вклад мелкого шума
    var A_WARP = 0.24 + 0.44 * p.coast;                 // искривление самой маски

    // Нормировка маски: в углах карты суперэллипс не доходит до единицы,
    // поэтому меряем его в самой дальней точке и растягиваем на весь диапазон.
    // Иначе «середина материка» зависит от того, насколько карта квадратная.
    // Нормировка метрики: p-норма в углу карты больше единицы, поэтому
    // приводим её к 0 в центре и ровно к 1 на кромке. Иначе «полоса гашения
    // шума» оказывается не там, где кончается карта, и суша липнет к рамке.
    var invP = 1 / P_MASK;
    var maskMax = Math.sqrt(2);
    if (maskMax < 1e-6) maskMax = 1e-6;

    var heightField = new Float32Array(N);        // «сырой» рельеф, может быть > 1
    var elevation = new Float32Array(N);     // нормированная высота суши 0…1
    var forestField = new Float32Array(N);
    var stonyField = new Float32Array(N);
    var moisture = new Float32Array(N);
    var fertility = new Float32Array(N);

    var forestSeed = (S ^ 0x27d4eb2d) | 0;
    var stoneSeed = (S ^ 0x165667b1) | 0;
    var moistSeed = (S ^ 0x9e3779b1) | 0;

    // Частоты подобраны под размер карты, чтобы картинка не зависела от того,
    // 48 клеток в карте или 128: на всех размерах видно столько же «пятен».
    // Частоты намеренно низкие. Высокочастотный шум на маленькой карте рубит
    // материк на осколки: берег превращается в крошево из луж и островков.
    var kShape = 1.1 / GW, kCoast = 1.7 / GW, kEdge = 6.0 / GW;
    var kForest = 4.5 / GW, kStone = 7.0 / GW, kMoist = 3.0 / GW;

    var x, y, i, j;
    for (y = 0; y < GH; y++) {
      for (x = 0; x < GW; x++) {
        i = y * GW + x;

        // Нормированные координаты: 0 в центре, ±1 у кромки карты.
        // Множитель 2 обязателен: без него весь диапазон сжимается до ±0.5
        // и маска материка не доходит до края карты.
        var u = ((x + 0.5) / GW - cx) * 2;
        var v = ((y + 0.5) / GH - cy) * 2;

        // Искривляем сами координаты маски: материк перестаёт быть
        // симметричным относительно центра, у него появляется «своя» форма.
        var ox = (NZ.fbm2(x * kShape, y * kShape, shapeSeed, 3) - 0.5) * A_WARP;
        var oy = (NZ.fbm2(x * kShape + 31.7, y * kShape + 11.3, shapeSeed + 77, 3) - 0.5) * A_WARP;
        var uu = u + ox, vv = v + oy;

        // Две разные функции, и путать их нельзя:
        //   m         — форма материка: плато в середине, склон к берегу;
        //   edgeWeight — гашение шума у самой кромки карты.
        // Метрика ed — p-норма координат: ровно 0 в центре и ровно 1 на
        // кромке карты, поэтому «полоса воды по краю» меряется в клетках,
        // а не в единицах наугад.
        var ed = clamp01(Math.pow(Math.pow(Math.abs(uu), P_MASK) + Math.pow(Math.abs(vv), P_MASK), invP) / maskMax);
        // 0.97, а не 1.0: у самой кромки карты профиль уже ноль, поэтому
        // рамка обязана остаться водой и не зависит от того, где встал квантиль.
        var m = Math.pow(1 - smoothstep(0.30, 0.99, ed), P_SHELF);
        var edgeWeight = 1 - smoothstep(0.90, 0.99, ed);

        // Хребтовый шум вытягивает косы и заливы, мелкий fBm рвёт кромку.
        var ridge = NZ.ridged2(x * kCoast, y * kCoast, coastSeed, 3) - 0.42;
        var edge = NZ.fbm2(x * kEdge, y * kEdge, edgeSeed, 3) - 0.5;

        // Обрезки сверху нет намеренно: если прижать рельеф к 1, у половины
        // клеток высота станет одинаковой и квантиль упрётся в потолок —
        // берег превратится в ровную линию поперёк карты.
        heightField[i] = m + (ridge * A_RIDGE + edge * A_EDGE) * edgeWeight;

        forestField[i] = NZ.fbm2(x * kForest, y * kForest, forestSeed, 4);
        stonyField[i] = NZ.ridged2(x * kStone, y * kStone, stoneSeed, 3);
        moisture[i] = NZ.fbm2(x * kMoist + 5.5, y * kMoist - 2.5, moistSeed, 3);
      }
    }

    // Сглаживание рельефа. Без него шум оставляет одиночные клетки суши
    // посреди воды и наоборот — берег получается крошевом. Два прохода
    // box-фильтра убирают эту «соль с перцем» и дают цельный материк
    // с ровными заливами.
    boxBlur(heightField, GW, GH, 1);

    /* --- 2. Порог воды по квантилю ---------------------------------- */

    // Рамка карты — вода, и точка. Профиль материка её и так гасит, но
    // квантиль мог бы выбрать в сушу углы, куда дотянулся хребтовый шум.
    // Обнуляем рельеф по периметру ДО расчёта порога: тогда квантиль
    // считает доли уже без рамки и «72 % суши» остаётся честными 72 %.
    var RIM = Math.max(2, Math.round(GW / 20));
    // Какая доля суши в принципе влезает в карту с такой рамкой
    var innerArea = (GW - 2 * RIM) * (GH - 2 * RIM);
    var rimMaxLand = clamp01(innerArea / N * 0.99);
    for (y = 0; y < GH; y++) {
      for (x = 0; x < GW; x++) {
        if (x < RIM || y < RIM || x >= GW - RIM || y >= GH - RIM) heightField[y * GW + x] = 0;
      }
    }

    var BINS = 2048;
    var hMin = Infinity, hMax = -Infinity;
    for (i = 0; i < N; i++) {
      var hv = heightField[i];
      if (hv < hMin) hMin = hv;
      if (hv > hMax) hMax = hv;
    }
    if (!(hMax > hMin)) hMax = hMin + 1e-6;

    // Гистограмма по фактическому диапазону высот. Растягивать его на
    // фиксированные 0…1 нельзя: рельеф запросто уходит выше единицы,
    // и тогда верхние байны копят половину карты — квантиль промахивается,
    // а вместе с ним и доля суши.
    var hSpan = hMax - hMin;
    var hist = new Uint32Array(BINS);
    for (i = 0; i < N; i++) {
      hist[clamp(Math.floor((heightField[i] - hMin) / hSpan * BINS), 0, BINS - 1)]++;
    }

    // Значение, ниже которого лежит доля q всех клеток. Считаем снизу:
    // вода — это нижний хвост распределения рельефа.
    function quantileValue(q) {
      var target = clamp01(q) * N, run = 0;
      for (var b = 0; b < BINS; b++) {
        run += hist[b];
        if (run >= target) return hMin + (b / BINS) * hSpan;
      }
      return hMax;
    }

    // Вода — это нижний хвост рельефа. Ставим порог на квантиле (1 − land):
    // выше него окажется ровно land клеток, то есть ровно заданная доля суши.
    // Сверху доля суши ограничена рамкой: суша не может занять больше
    // (1 − площадь рамки), иначе материк прилипнет к краю карты.
    var landShare = clamp(p.land, 0.15, rimMaxLand);
    var waterThreshold = quantileValue(clamp01(1 - landShare));

    var tile = new Uint8Array(N);
    var isLand = new Uint8Array(N);
    for (i = 0; i < N; i++) {
      var raw = heightField[i];
      var land = raw > waterThreshold && raw > 0.02;
      isLand[i] = land ? 1 : 0;
      elevation[i] = land ? clamp01((raw - waterThreshold) / Math.max(1e-4, 1 - waterThreshold)) : 0;
    }

    // Материк может случайно развалиться на пару крупных кусков. Если
    // осколков больше половины суши — оставляем только самый большой:
    // «материк, окружённый водой» это условие задачи, а мелкие острова
    // у берега выглядят естественно и пусть остаются.
    if (p.coast < 0.9) keepLargestComponent(isLand, GW, GH, 0.5);

    /* --- 3. Расстояния ---------------------------------------------- */

    // distanceTransform считает расстояние ДО ближайшей единицы маски.
    // Поэтому для глубины воды передаём сушу, а для «далеко ли до воды»
    // на суше — тоже сушу: там, где она кончается, и есть берег.
    var distLand = distanceTransform(isLand, GW, GH, 6);        // вода: глубина
    var distWater = distanceTransform(isLand, GW, GH, 8);       // суша: до воды

    /* --- 4. Классы клеток ------------------------------------------- */

    var beachW = Math.max(0.9, GW / 64);        // ширина песка в клетках
    var shallowW = 2.6;

    for (i = 0; i < N; i++) {
      if (!isLand[i]) {
        var d = distLand[i];
        tile[i] = d <= shallowW ? T.SHALLOW : (d <= shallowW * 2.4 ? T.WATER : T.DEEP);
      } else {
        tile[i] = distWater[i] <= beachW ? T.SAND : T.GRASS;
      }
    }

    /* --- 5. Поля по суше, приведённые к долям ----------------------- */

    // Лес и камень режем по квантилям от значений НА СУШЕ: «занимает 20 %
    // материка» — это ровно 20 %, как бы ни легла карта.
    var landIdx = [];
    for (i = 0; i < N; i++) if (isLand[i]) landIdx.push(i);
    var landCount = landIdx.length;

    // Порог по доле суши + фактический максимум поля на суше.
    // Нормировать на 1 нельзя: шум fBm редко дотягивается до единицы, и тогда
    // «чаща» упирается в 0.4 — деревья расставляются вяло, рощ не видно.
    function thresholdOnLand(field, share) {
      if (!landCount || share <= 0) return { t: Infinity, max: Infinity };
      var vals = new Float32Array(landCount);
      for (var j = 0; j < landCount; j++) vals[j] = field[landIdx[j]];
      vals.sort();
      var q = 1 - clamp01(share);
      return {
        t: vals[clamp(Math.floor(q * (landCount - 1)), 0, landCount - 1)],
        max: vals[landCount - 1]
      };
    }

    var forestShare = p.forest * 0.55;         // 0.5 -> ~27 % суши под рощи
    var rockShare = p.rock * 0.09;             // 0.5 -> ~4.5 % под выходы
    var forestCut = thresholdOnLand(forestField, forestShare);
    var rockCut = thresholdOnLand(stonyField, rockShare);

    var forestness = new Float32Array(N);
    var stonyness = new Float32Array(N);
    var fScale = 1 / Math.max(1e-4, forestCut.max - forestCut.t);
    var sScale = 1 / Math.max(1e-4, rockCut.max - rockCut.t);
    for (j = 0; j < landCount; j++) {
      i = landIdx[j];
      // 0 у порога, 1 — «самая чаща» этого поля
      forestness[i] = clamp01((forestField[i] - forestCut.t) * fScale);
      stonyness[i] = clamp01((stonyField[i] - rockCut.t) * sScale);
      // Плодородие: у воды лучше, в чаще и на камне — хуже. Задел под поля.
      fertility[i] = clamp01(0.35 + moisture[i] * 0.4 + (1 - forestness[i]) * 0.25
        - stonyness[i] * 0.35);
    }

    /* --- 6. Объекты ------------------------------------------------- */

    var objects = [];
    placeObjects(objects, {
      GW: GW, GH: GH, isLand: isLand, tile: tile, distWater: distWater,
      forestness: forestness, stonyness: stonyness, rng: rng, S: S, p: p
    });

    // Сортировка по глубине (x + y) — один раз, на генерации. В изометрии
    // это ровно тот порядок, в котором объекты должны перекрывать друг друга.
    objects.sort(function (a, b) { return (a.x + a.y) - (b.x + b.y); });

    /* --- 7. Сводка -------------------------------------------------- */

    var stats = {
      tiles: N,
      landTiles: landCount,
      landShare: landCount / N,
      water: 0, sand: 0, grass: 0,
      trees: 0, rocks: 0, smallRocks: 0, mineable: 0, decor: 0
    };
    for (i = 0; i < N; i++) {
      if (tile[i] === T.GRASS) stats.grass++;
      else if (tile[i] === T.SAND) stats.sand++;
      else stats.water++;
    }
    for (j = 0; j < objects.length; j++) {
      var o = objects[j];
      if (o.kind === 'tree') stats.trees++;
      else if (o.mineable) { stats.rocks++; stats.mineable++; }
      else if (o.kind === 'stone') stats.smallRocks++;
      else stats.decor++;
    }

    var t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    return addSea({
      width: GW, height: GH,
      seed: String(p.seed), seedInt: S,
      params: p,
      tile: tile,                    // Uint8Array, значения из WorldGen.T
      isLand: isLand,
      heightField: heightField,      // «сырой» рельеф: он и определяет берег
      elevation: elevation,          // высота суши 0…1 — под будущий рельеф
      forestness: forestness,
      stonyness: stonyness,
      moisture: moisture,
      fertility: fertility,
      distWater: distWater,          // для суши: до воды в клетках
      distLand: distLand,            // для воды: глубина в клетках
      waterThreshold: waterThreshold,
      rim: RIM,                      // ширина водной рамки внутри домена
      islandSize: GW,                // домен острова: GW × GW
      maxLandShare: rimMaxLand,      // больше суши в домен не влезает
      objects: objects,
      stats: stats,
      genTimeMs: t1 - t0
    }, p.sea, beachW, shallowW);
  }

  /* ------------------------------------------------------------------ *
   *  Море вокруг острова                                               *
   * ------------------------------------------------------------------ */

  /* Остров считается в домене size × size: так «72 % суши» — это доля
     острова, а не доля картинки, и материк не зависит от того, сколько
     моря вокруг него потом насыпали.

     Но если море кончается ровно по краю полотна, общий план читается не
     как остров, а как кусок ландшафта в пустоте: полоса отмели обрывается
     по прямой, волны кончаются вместе с картой. Поэтому вокруг домена
     добавляется полоса глубокой воды — ровно такая, чтобы градиент отмели
     успел закончиться внутри карты (shallowW + запас). Дальше море
     однородное, и рендер продолжает его сколь угодно далеко, не считая
     ни одной лишней клетки: см. drawSea в js/render.js.

     Ширина полосы берётся от домена, а не от рамки: рамка (GW/20) задаёт
     только то, насколько близко суша подходит к кромке домена, и при
     маленьком острове одной её не хватает. */
  function seaMargin(islandSize, rim) {
    // Градиент отмели кончается на shallowW * 2.4 = 6.24 клетки, а суша
    // может подойти к кромке домена на rim клеток. Значит полосе нужно
    // 8 − rim, чтобы вода на кромке карты была уже глубокой. Меньше 4 не
    // бывает: иначе «море вокруг острова» — это лужа.
    return Math.max(4, 8 - rim);
  }

  function addSea(w, seaParam, beachW, shallowW) {
    var IW = w.width, IH = w.height;
    var M = seaParam === null || seaParam === undefined
      ? seaMargin(IW, w.rim)
      : Math.max(0, Math.round(seaParam));
    var W = IW + 2 * M, H = IH + 2 * M, N = W * H;
    var i, x, y, o;

    w.sea = M;

    if (M) {
      // Поля переезжают в середину новой карты. Море вокруг — глубина:
      // ни суши, ни леса, ни рельефа там нет и быть не может.
      var pad = function (src, fill) {
        var out = new src.constructor(N);
        if (fill) out.fill(fill);
        for (y = 0; y < IH; y++) out.set(src.subarray(y * IW, y * IW + IW), (y + M) * W + M);
        return out;
      };

      var isLand = pad(w.isLand, 0);
      // Копия со сдвигом: список объектов уже отсортирован по x + y, а
      // сдвиг на одну и ту же величину по обеим осям порядок не меняет.
      var objects = [];
      for (i = 0; i < w.objects.length; i++) {
        o = w.objects[i];
        var copy = {};
        for (var key in o) copy[key] = o[key];
        copy.x = o.x + M;
        copy.y = o.y + M;
        objects.push(copy);
      }

      w.width = W; w.height = H;
      w.isLand = isLand;
      w.heightField = pad(w.heightField, 0);
      w.elevation = pad(w.elevation, 0);
      w.forestness = pad(w.forestness, 0);
      w.stonyness = pad(w.stonyness, 0);
      w.moisture = pad(w.moisture, 0);
      w.fertility = pad(w.fertility, 0);
      w.objects = objects;
    }

    /* Расстояния считаются по всей карте, и здесь важно не перепутать
       полярность маски. distanceTransform(mask) меряет расстояние от
       клеток mask = 1 до ближайшей клетки mask = 0:

         · маска «суша»  → для суши это расстояние до воды, для воды 0;
         · маска «вода»  → для воды это глубина, для суши 0.

       Раньше обе дистанции считались по маске суши, поэтому «глубина» на
       воде всегда выходила нулём: класс DEEP не встречался ни разу, а
       градиент отмели не рисовался — вся вода в карте была одного светлого
       цвета. Именно из-за этого кромка полотна и читалась как обрыв: у
       берега светло, за картой темно, и перехода между ними нет. */
    var isLandNow = w.isLand;
    var waterMask = new Uint8Array(N);
    for (i = 0; i < N; i++) waterMask[i] = isLandNow[i] ? 0 : 1;

    // Предел с запасом: класс DEEP начинается дальше shallowW * 2.4, и
    // упереться в потолок нельзя — иначе глубокой воды не будет вовсе.
    var reach = Math.max(8, M + w.rim + 3);
    w.distWater = distanceTransform(isLandNow, W, H, reach);   // суша → вода
    w.distLand = distanceTransform(waterMask, W, H, reach);    // вода → суша

    // Классы клеток — заново, по пересчитанным расстояниям. Теперь у моря
    // есть настоящая глубина: отмель у берега, вода, глубина.
    var tile = new Uint8Array(N);
    for (i = 0; i < N; i++) {
      if (isLandNow[i]) {
        tile[i] = w.distWater[i] <= beachW ? T.SAND : T.GRASS;
      } else {
        var d = w.distLand[i];
        tile[i] = d <= shallowW ? T.SHALLOW
          : (d <= shallowW * 2.4 ? T.WATER : T.DEEP);
      }
    }
    w.tile = tile;

    // Сводка: клетки считаются по всей карте, а доля суши — по домену
    // острова. Иначе «72 %» на ползунке разошлось бы с числом в панели
    // ровно на площадь моря.
    var s = w.stats;
    s.tiles = N;
    s.landShare = s.landTiles / (IW * IH);
    s.water = 0; s.sand = 0; s.grass = 0;
    for (i = 0; i < N; i++) {
      if (tile[i] === T.GRASS) s.grass++;
      else if (tile[i] === T.SAND) s.sand++;
      else s.water++;
    }
    w.landBounds = landBounds(isLandNow, W, H);
    return w;
  }

  // Габарит суши в клетках: по нему считается кадр игры (остров целиком
  // плюс по половине его диаметра моря с каждой стороны). По карте этого
  // не сделать: карта — остров плюс море, и она заведомо больше.
  function landBounds(isLand, W, H) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        if (!isLand[y * W + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x0 > x1) return { x0: 0, y0: 0, x1: W, y1: H };
    // x1, y1 — за последней клеткой суши: так габарит удобно сравнивать
    // с пятном застройки, у которого границы тоже исключающие.
    return { x0: x0, y0: y0, x1: x1 + 1, y1: y1 + 1 };
  }

  /* --- Оставляем только самую крупную сушу -------------------------- *
   * minShare — доля суши, ниже которой дробление считается ошибкой:
   * если крупнейший кусок меньше неё, осколки убираются все.
   * ------------------------------------------------------------------ */

  function keepLargestComponent(isLand, W, H, minShare) {
    var N = W * H;
    var label = new Int32Array(N);
    var best = -1, bestSize = 0, size = 0;
    var stack = new Int32Array(N);
    var cur = 0;
    var total = 0;

    for (var s = 0; s < N; s++) {
      if (!isLand[s] || label[s]) continue;
      cur++;
      var sp = 0, count = 0;
      stack[sp++] = s; label[s] = cur;
      while (sp > 0) {
        var i = stack[--sp]; count++;
        var x = i % W, y = (i - x) / W;
        if (x > 0 && isLand[i - 1] && !label[i - 1]) { label[i - 1] = cur; stack[sp++] = i - 1; }
        if (x < W - 1 && isLand[i + 1] && !label[i + 1]) { label[i + 1] = cur; stack[sp++] = i + 1; }
        if (y > 0 && isLand[i - W] && !label[i - W]) { label[i - W] = cur; stack[sp++] = i - W; }
        if (y < H - 1 && isLand[i + W] && !label[i + W]) { label[i + W] = cur; stack[sp++] = i + W; }
      }
      total += count;
      if (count > bestSize) { bestSize = count; best = cur; }
    }

    if (cur <= 1) return;
    if (minShare && bestSize >= total * minShare) return;
    for (var k = 0; k < N; k++) if (isLand[k] && label[k] !== best) isLand[k] = 0;
  }

  /* --- Расстановка деревьев и камней -------------------------------- *
   *
   * Объекты садятся по непрерывным полям, поэтому сами собой собираются
   * в рощи и выходы. Поверх — минимальная дистанция: она убирает слипшиеся
   * пары, из-за которых карта выглядит как каша из крон.
   * ------------------------------------------------------------------ */

  function placeObjects(out, ctx) {
    var W = ctx.GW, H = ctx.GH, tile = ctx.tile, isLand = ctx.isLand;
    var rng = ctx.rng, p = ctx.p;

    // Сетка занятости: клетка 1.4 тайла, проверяем 3×3 вокруг точки.
    var CELL = 1.4;
    var gw = Math.ceil(W / CELL) + 2, gh = Math.ceil(H / CELL) + 2;
    var grid = new Array(gw * gh);
    for (var g = 0; g < grid.length; g++) grid[g] = null;

    function farEnough(px, py, minD) {
      var gx = Math.floor(px / CELL) + 1, gy = Math.floor(py / CELL) + 1;
      for (var yy = gy - 1; yy <= gy + 1; yy++) {
        for (var xx = gx - 1; xx <= gx + 1; xx++) {
          var cell = grid[yy * gw + xx];
          if (!cell) continue;
          for (var c = 0; c < cell.length; c++) {
            var o = cell[c];
            var dx = o.x - px, dy = o.y - py;
            if (dx * dx + dy * dy < minD * minD) return false;
          }
        }
      }
      return true;
    }

    function push(o, px, py) {
      var gx = Math.floor(px / CELL) + 1, gy = Math.floor(py / CELL) + 1;
      var idx = gy * gw + gx;
      if (!grid[idx]) grid[idx] = [];
      grid[idx].push(o);
      out.push(o);
    }

    // Веса пород: дуб обычен, сосна в чаще, берёза по опушкам, осень — редкость.
    var TREE_VARIANTS = ['oak', 'pine', 'birch', 'autumn'];
    var TREE_WEIGHTS = [5, 3.4, 2.2, 1];

    // Множители перевода ползунков в шанс на клетку. Подобраны так, чтобы
    // на 50 % ползунка роща была рощей, а не «деревья кое-где».
    var treeDensity = p.trees * 7.0;     // плотность внутри рощ
    var rockDensity = p.rocks * 2.4;

    // Проход раз в клетку. Дробное смещение внутри клетки убирает сетку:
    // без него деревья встают ровными рядами по центрам клеток.
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var i = y * W + x;
        if (!isLand[i]) continue;

        var px = x + rng.range(0.18, 0.82);
        var py = y + rng.range(0.18, 0.82);
        var t = tile[i];
        var f = ctx.forestness[i];
        var st = ctx.stonyness[i];
        var nearWater = ctx.distWater[i];

        /* --- деревья --- */
        // В песок и к самой воде не лезем: там пляж. Шанс растёт с полем леса,
        // поэтому на опушке деревья редкие, а в чаще — почти сплошные.
        if (t === T.GRASS && nearWater > 1.2 && f > 0) {
          var treeChance = treeDensity * (0.03 + f * f);
          if (st > 0.55) treeChance *= 0.12;          // на камне деревьям тесно
          if (rng.next() < treeChance && farEnough(px, py, 0.55)) {
            var w = [TREE_WEIGHTS[0], TREE_WEIGHTS[1] * (0.5 + f), TREE_WEIGHTS[2] * (1.3 - f * 0.6), TREE_WEIGHTS[3]];
            var vi = rng.weighted(w);
            push({
              kind: 'tree', variant: TREE_VARIANTS[vi],
              x: px, y: py, scale: rng.range(0.88, 1.14),
              phase: rng.range(0, Math.PI * 2)
            }, px, py);
            continue;                                  // в клетке — либо дерево, либо камень
          }
        }

        /* --- камни --- */
        if (t !== T.SAND && st > 0) {
          var stoneChance = rockDensity * (0.05 + 1.5 * st * st);
          if (rng.next() < stoneChance) {
            var minD = 0.5;
            // Внутри каменистого выхода ставим руду: она и есть цель добычи,
            // поэтому её видно издалека и она крупнее россыпи.
            var ore = st > 0.62 && rng.next() < 0.22;
            var variant = ore ? (rng.next() < 0.72 ? 'iron' : 'salt')
              : (rng.next() < 0.45 ? 'boulder' : 'rock');
            if (farEnough(px, py, minD)) {
              push({
                kind: 'stone', variant: variant,
                x: px, y: py, scale: rng.range(0.85, 1.2),
                mineable: true, node: ore,
                amount: ore ? rng.int(180, 320) : rng.int(60, 140)
              }, px, py);
            }
          } else if (st < 0.35 && rng.next() < 0.05) {
            // Одиночная галька по лугу — просто украшение, копать её нельзя.
            if (farEnough(px, py, 0.35)) {
              push({
                kind: 'stone', variant: 'pebble',
                x: px, y: py, scale: rng.range(0.7, 1.05), phase: rng.range(0, 6.28)
              }, px, py);
            }
          }
        }

        /* --- мелочь --- */
        // Трава, кусты и цветы: заполняют пустоту между деревьями, чтобы луг
        // не выглядел голым листом бумаги.
        if (t === T.GRASS && nearWater > 1.4 && rng.next() < 0.16) {
          var roll = rng.next();
          var kind = roll < 0.5 ? 'tuft' : (roll < 0.82 ? 'bush' : 'flower');
          var dfar = kind === 'tuft' ? 0.3 : 0.45;
          if (farEnough(px, py, dfar)) {
            push({
              kind: kind,
              variant: kind === 'flower' ? 'f' + (1 + rng.int(0, 2)) : null,
              x: px, y: py, scale: rng.range(0.75, 1.15),
              phase: rng.range(0, 6.28)
            }, px, py);
          }
        } else if (t === T.SAND && nearWater < 2.2 && rng.next() < 0.08) {
          if (farEnough(px, py, 0.3)) {
            push({ kind: 'reed', variant: null, x: px, y: py, scale: rng.range(0.8, 1.2), phase: rng.range(0, 6.28) }, px, py);
          }
        }
      }
    }
  }

  global.WorldGen = {
    generate: generate,
    T: T,
    TILE_NAMES: TILE_NAMES,
    VARIANT_NAMES: VARIANT_NAMES,
    DEFAULTS: DEFAULTS,
    distanceTransform: distanceTransform,
    squareMask: squareMask,
    seaMargin: seaMargin,
    landBounds: landBounds
  };
})(typeof window !== 'undefined' ? window : globalThis);
