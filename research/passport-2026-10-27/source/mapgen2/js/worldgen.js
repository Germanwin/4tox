/* worldgen.js — генерация мира.

   Что получается на выходе: квадратная карта, внутри которой лежит материк,
   а по краям — вода. Берег неровный: полуострова, косы, заливы. Биом суши
   один — трава, поэтому «разнообразие» даёт не биом, а рельеф берега, пятна
   леса и каменистые выходы.

   Три вещи, которые определяют вид карты:

   1. Органический берег. Высота — это радиальный конверт (1 в середине,
      0 к кромке), к которому добавлены:
        · три НЕСОВПАДАЮЩИЕ гармоники cos(kθ + φ), k = 2, 3, 5 — крупная
          асимметрия острова; в отличие от прежнего одиночного k = 4, они не
          дают креста и не повторяются через 90°;
        · многооктавный fBm в декартовых координатах — заливы, косы и
          «случайный» берег, как у шума в Minecraft;
        · domain warp и мелкий хребтовый/краевой шум.
      Всё, кроме радиального конверта, масштабируется ползунком coast:
      при coast = 0 остаётся гладкий овал, при coast = 1 — рваный берег.
      Радиальный конверт (а не прежняя p-норма с лепестками) не привязан к
      осям карты, поэтому у острова нет «углов» и «креста».

   2. Порог воды — по квантилю, а не по абсолютной высоте. «62 % суши»
      значит ровно 62 % площади при любом сиде и любом размере. После
      квантиля остаётся один материк (keepLargestComponent) и засыпаются
      внутренние озёра (fillEnclosedWater): остров не кольцо и не решето.
      Отдельных кусков суши нет — по воде житель ходить не умеет.

   3. Объекты ставятся по непрерывным полям (лес, камень), а не по битому
      шуму на клетку. Поле леса мелкое и рваное: рощи — пятна в несколько
      клеток, разбросанные по всему острову, а не один огромный массив, в
      котором один игрок стартует, а другой идёт до леса минуту. Порог поля
      леса при этом не один на карту, а свой в каждой области
      (forestQuotas): рощ вдвое больше прежнего, средний размер не вырос,
      и они не сбиваются в кучу на одном краю острова. */
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
  function smoothstep(a, b, x) {
    var t = clamp01((x - a) / (b - a || 1e-6));
    return t * t * (3 - 2 * t);
  }

  var DEFAULTS = {
    seed: 'тихая-долина-701',
    size: 64,          // домен острова: size × size клеток
    land: 0.62,        // доля суши (от домена острова, не от картинки)
    coast: 0.5,        // 0 — ровный берег, 1 — рваный
    forest: 0.5,       // сколько суши занимают рощи
    rock: 0.5,         // сколько суши занимает камень
    trees: 0.45,       // плотность деревьев внутри рощ
    rocks: 0.6,        // плотность камней внутри каменистых выходов
    sea: null          // ширина моря вокруг острова в клетках; null — посчитать
  };

  /* --- Лес: мелкое поле и норма по областям -------------------------- *
   *
   * Заказчик (2026-10-24): «в два раза больше лесов, не увеличивая средний
   * размер леса» и «чтобы леса распределялись так же рандомно и естественно,
   * но более равномерно».
   *
   * Отсюда три числа, которые держат это правило:
   *
   * · FOREST_DETAIL — во сколько раз поле леса мельче прежнего. Вдвое
   *   большая доля суши под рощи при прежней частоте дала бы вдвое БОЛЬШИЕ
   *   пятна (соседние рощи слипаются). На частоте ×1.15 те же 12 % суши
   *   распадаются на вдвое больше пятен того же размера: 25 пятен со
   *   средним 99 клеток на 256×256 становятся 51 пятном со средним 97.
   *
   * · FOREST_LEVELS — сетка, по узлам которой считается СВОЙ порог леса.
   *   Прежний общий порог оставлял целые края острова без рощ: там поле
   *   просто не дотягивало до квантиля. Своя квота в каждой области
   *   чинит это без сетки на карте: порог между узлами интерполируется,
   *   а рваную кромку рощи по-прежнему рисует поле.
   *
   * · FOREST_QUOTA_MAX — доля суши под рощи в области при ползунке 100 %.
 *   0.68 — это ~27 % суши рощами, вдвое больше прежнего максимума (13 %).
 *   Выше брать нельзя: рощи занимают уже пол-острова, «в роще/вне рощи»
 *   перестаёт читаться, и деревья выглядят равномерно рассыпанными.
   */
  var FOREST_DETAIL = 1.15;
  var FOREST_LEVELS = 5;
  var FOREST_QUOTA_MAX = 0.68;
  var FOREST_MIN_SAMPLES = 12;   // меньше суши в окне — узел берёт соседа

  // Доля суши под рощи в одной области по ползунку «Лес».
  // Кривая проходит через 0 (леса нет), 0.5 (прежние 50 % ползунка — но
  // рощ теперь вдвое больше) и FOREST_QUOTA_MAX на 100 %. Именно кривая,
  // а не прямая: у прямой через (0,0) и (0.5,0.5) на сотне вышла бы
  // единица — вся суша сплошным лесом, без рощ.
  function forestQuota(slider) {
    var t = clamp01(slider);
    var a = 2 * (FOREST_QUOTA_MAX - 1);   // −0.64 при 0.68
    var b = 2 - FOREST_QUOTA_MAX;         //  1.32
    return t * (b + a * t);
  }

  /* ------------------------------------------------------------------ *
   *  Маска материка                                                    *
   * ------------------------------------------------------------------ */

  // Нормированное расстояние по метрике суперэллипса: 0 — центр, 1 — кромка.
  // p управляет «квадратностью» углов:
  // p = 2 это круг, p → ∞ — квадрат.
  //
  // Функция оставлена экспортированной для совместимости: на неё могут
  // смотреть внешние инструменты. Сама генерация её больше НЕ использует:
  // берег строится из радиального конверта, трёх гармоник и fBm. Старое
  // поведение (деление на sqrt(2)) сохранено намеренно: это исторический
  // контракт экспорта, а не ошибка, которую надо тихо починить под чужим кодом.
  function squareMask(u, v, p) {
    var a = Math.pow(Math.abs(u), p) + Math.pow(Math.abs(v), p);
    return Math.pow(a, 1 / p);          // нормированное расстояние 0…1
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

    // Материк стоит по центру: смещение на пару клеток сжимало габарит суши
    // с одной стороны и поднимало bbox fill выше 0.80. Разнообразие дают
    // гармоники и шум, а не сдвиг всего острова.
    var cx = 0.5, cy = 0.5;

    // Органический берег: радиальный конверт + три НЕСОВПАДАЮЩИЕ гармоники
    // (k = 2, 3, 5) + многооктавный fBm. Гармоники дают крупную асимметрию,
    // fBm — заливы и косы. Всё, кроме конверта, масштабируется coast, поэтому
    // при 0 остаётся гладкий овал, а при 1 берег рваный. Никакого одиночного
    // k = 4: именно он превращал остров в крест, повторяющийся через 90°.
    var shapeSeed = (S ^ 0x51ed2701) | 0;
    var coastSeed = (S ^ 0x1b873593) | 0;
    var edgeSeed = (S ^ 0x2545f491) | 0;
    var contSeed = (S ^ 0x27d4eb2d) | 0;
    var groveSeed = (S ^ 0x85ebca6b) | 0;

    // Фазы и веса трёх гармоник — из сида, но считаются хешем, а не жребием:
    // расстановка деревьев не должна зависеть от того, какую форму выбрал
    // берег. k = 2, 3, 5 — взаимно простые, поэтому сумма не повторяется
    // через 90° и не даёт ни креста, ни четырёхлепесткового цветка.
    var lobeSeed = (S ^ 0x68e31da4) | 0;
    var lw1 = 0.55 + NZ.hash2i(1, 0, lobeSeed) * 0.75;
    var lw2 = 0.55 + NZ.hash2i(2, 0, lobeSeed) * 0.75;
    var lw3 = 0.55 + NZ.hash2i(3, 0, lobeSeed) * 0.75;
    var lwSum = lw1 + lw2 + lw3;
    var lph1 = NZ.hash2i(4, 0, lobeSeed) * Math.PI * 2;
    var lph2 = NZ.hash2i(5, 0, lobeSeed) * Math.PI * 2;
    var lph3 = NZ.hash2i(6, 0, lobeSeed) * Math.PI * 2;

    var P_ENV_START = 0.55;                             // где конверт начинает падать
    var P_ENV_END = 1.05;                               // где он доходит до нуля
    var P_BASE_W = 0.50;                                // высота в центре
    var P_FLOOR = 0.08;                                 // фон: при 90 % суши карта заливается
    var A_CONT = 0.90 * p.coast;                        // крупный fBm: заливы/косы
    var A_LOBE = 0.50 * p.coast;                        // три гармоники: асимметрия
    var A_WARP = 0.26 * p.coast;                        // искривление координат
    var A_RIDGE = 0.26 * p.coast;                       // хребтовый шум берега
    var A_EDGE = 0.05 * p.coast;                        // средний fBm
    var A_FINE = 0.32 * p.coast;                        // мелкая рябь берега

    var heightField = new Float32Array(N);        // «сырой» рельеф, может быть > 1
    var elevation = new Float32Array(N);     // нормированная высота суши 0…1
    var forestField = new Float32Array(N);
    var stonyField = new Float32Array(N);
    var moisture = new Float32Array(N);
    var fertility = new Float32Array(N);

    var forestSeed = (S ^ 0x7feb352d) | 0;
    var stoneSeed = (S ^ 0x165667b1) | 0;
    var moistSeed = (S ^ 0x9e3779b1) | 0;

    // Частоты подобраны под размер карты, чтобы картинка не зависела от того,
    // 48 клеток в карте или 256: на всех размерах видно столько же «пятен».
    // Лес намеренно мелкий: 9.5/GW с добавкой 18/GW давали рощи-пятна в
    // несколько клеток, а FOREST_DETAIL делает их ещё мельче — при вдвое
    // большей доле суши под лес пятна не растут, а множатся.
    var kWarp = 1.4 / GW, kCont = 3.3 / GW;
    var kCoast = 1.8 / GW, kEdge = 6.0 / GW;
    var kFine = 16.0 / GW;               // мелкая рябь берега: растёт с coast
    var kForest = (9.5 * FOREST_DETAIL) / GW;
    var kGrove = (18.0 * FOREST_DETAIL) / GW;
    var kStone = 9.0 / GW, kMoist = 3.0 / GW;

    var x, y, i, j;
    for (y = 0; y < GH; y++) {
      for (x = 0; x < GW; x++) {
        i = y * GW + x;

        // Нормированные координаты: 0 в центре, ±1 у кромки карты.
        // Множитель 2 обязателен: без него весь диапазон сжимается до ±0.5
        // и маска материка не доходит до края карты.
        var u = ((x + 0.5) / GW - cx) * 2;
        var v = ((y + 0.5) / GH - cy) * 2;

        // Искривляем сами координаты: берег перестаёт быть симметричным.
        // При coast = 0 варп нулевой — остров остаётся гладким овалом.
        var ox = (NZ.fbm2(x * kWarp, y * kWarp, shapeSeed, 3) - 0.5) * A_WARP;
        var oy = (NZ.fbm2(x * kWarp + 31.7, y * kWarp + 11.3, shapeSeed + 77, 3) - 0.5) * A_WARP;
        var uu = u + ox, vv = v + oy;

        // Радиальный конверт: 1 в середине, 0 к кромке домена. Он не привязан
        // к осям карты, поэтому у острова нет «углов».
        var rr = Math.sqrt(uu * uu + vv * vv);
        var env = 1 - smoothstep(P_ENV_START, P_ENV_END, rr);

        // Крупная асимметрия: три гармоники с разными k и фазами.
        var lobe = 0;
        if (A_LOBE > 0) {
          var th = Math.atan2(vv, uu);
          lobe = (lw1 * Math.cos(2 * th + lph1) +
                  lw2 * Math.cos(3 * th + lph2) +
                  lw3 * Math.cos(5 * th + lph3)) / lwSum;
        }

        // Крупный fBm в декартовых координатах: заливы и косы. Это не
        // радиальная функция, поэтому берег не повторяется через угол.
        var cont = A_CONT > 0 ? NZ.fbm2(x * kCont, y * kCont, contSeed, 4) - 0.5 : 0;

        var base = P_FLOOR + env * P_BASE_W + cont * A_CONT + lobe * A_LOBE;
        // Шум разрешён только там, где живёт сам материк: иначе в открытом
        // море рождались островки-крошки, квантиль считал их сушей, а
        // keepLargestComponent выбрасывал — и доля суши уезжала.
        var envelope = env * 6 < 1 ? env * 6 : 1;

        // Хребтовый шум вытягивает косы, средний рвёт кромку, мелкий
        // добавляет рябь — и всё это тем сильнее, чем больше coast.
        var ridge = NZ.ridged2(x * kCoast, y * kCoast, coastSeed, 3) - 0.42;
        var edge = NZ.fbm2(x * kEdge, y * kEdge, edgeSeed, 3) - 0.5;
        var fine = NZ.fbm2(x * kFine + 7.3, y * kFine - 4.1, edgeSeed + 33, 3) - 0.5;

        // Обрезки сверху нет намеренно: если прижать рельеф к 1, у половины
        // клеток высота станет одинаковой и квантиль упрётся в потолок —
        // берег превратится в ровную линию поперёк карты.
        heightField[i] = base + (ridge * A_RIDGE + edge * A_EDGE + fine * A_FINE) * envelope;

        // Лес: крупная составляющая задаёт «лесистые края», мелкая — сами
        // рощи. Вместе это мелкие пятна, разбросанные по всей суше.
        forestField[i] = NZ.fbm2(x * kForest, y * kForest, forestSeed, 4) * 0.7 +
          NZ.fbm2(x * kGrove, y * kGrove, groveSeed, 3) * 0.3;
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

    // Водная рамка внутри домена: 2 % против прежних 5 %. Она нужна только
    // для того, чтобы кромка домена осталась водой; море вокруг острова
    // добавляет addSea (seaMargin), и «вода по краям» проверяется уже по
    // полной карте.
    var RIM = Math.max(1, Math.round(GW / 50));
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
    // площади внутри неё, иначе материк прилипнет к краю домена.
    var landShare = clamp(p.land, 0.15, rimMaxLand);
    var waterThreshold = quantileValue(clamp01(1 - landShare));

    var tile = new Uint8Array(N);
    var isLand = new Uint8Array(N);
    for (i = 0; i < N; i++) {
      var raw = heightField[i];
      isLand[i] = raw > waterThreshold && raw > 0.02 ? 1 : 0;
    }

    // Один материк — и никаких «мелких островов у берега». Раньше осколки
    // оставляли, если главный кусок был больше половины суши; но при сильном
    // coast гармоники и шум рождают десятки клочков, компонент становится
    // больше одного, а доля суши после чистки уезжает. minShare = 0 значит
    // «оставить только самый большой кусок».
    keepLargestComponent(isLand, GW, GH, 0);

    // Внутренние озёра не добавляем: вода, не связанная с внешним морем,
    // засыпается сушей. Остров остаётся материком, а не решетом.
    fillEnclosedWater(isLand, GW, GH);

    // Высота и число суши — уже по финальной маске (после чистки и засыпки),
    // иначе статистика врёт: квантиль считал одно, а на карте осталось другое.
    var landCount = 0;
    for (i = 0; i < N; i++) {
      if (!isLand[i]) { elevation[i] = 0; continue; }
      landCount++;
      var el = clamp01((heightField[i] - waterThreshold) / Math.max(1e-4, 1 - waterThreshold));
      elevation[i] = el < 0.02 ? 0.02 : el;   // засыпанное озеро — низкая суша
    }

    /* --- 3. Расстояния ---------------------------------------------- */

    // distanceTransform считает расстояние ДО ближайшей единицы маски.
    // Поэтому для глубины воды передаём сушу, а для «далеко ли до воды»
    // на суше — тоже сушу: там, где она кончается, и есть берег.
    var distLand = distanceTransform(isLand, GW, GH, 6);        // вода: глубина
    var distWater = distanceTransform(isLand, GW, GH, 8);       // суша: до воды

    /* --- 4. Классы клеток ------------------------------------------- */

    var beachW = 1.3;                          // ширина песка в клетках: та же, что рисует render.js (BEACH_W)
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

    // Камень режем по одному порогу на всю сушу: его мало, и «ровность» ему
    // не нужна — выходы и должны стоять там, где легло поле.
    var rockShare = p.rock * 0.075;            // 0.5 -> ~3.7 % под выходы
    var rockCut = thresholdOnLand(stonyField, rockShare);

    // Лес — по локальной квоте: в каждой области острова под рощи уходит
    // своя, одна и та же доля суши, поэтому пустых краёв не остаётся.
    var quotas = forestQuotas(forestField, isLand, GW, GH, landIdx,
      forestQuota(p.forest));

    var forestness = new Float32Array(N);
    var stonyness = new Float32Array(N);
    var sScale = 1 / Math.max(1e-4, rockCut.max - rockCut.t);
    // «Чаща» нормируется от порога до самого высокого места на суше: кромка
    // у каждой рощи своя, а шкала густоты общая.
    var fScale = quotas ? 1 / Math.max(1e-4, quotas.max - quotas.avg) : 0;
    for (j = 0; j < landCount; j++) {
      i = landIdx[j];
      // 0 у порога, 1 — «самая чаща» этого поля
      forestness[i] = quotas
        ? clamp01((forestField[i] - quotas.at(i % GW, (i - i % GW) / GW)) * fScale)
        : 0;
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

    var out = addSea({
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
    /* У объектов природы — стабильные номера: по ним сеть говорит «это
       дерево срублено», не пересылая весь лес. objectTotal — сколько их было
       ДО первой рубки: по нему сеть кодирует список убранного битовой
       картой, и он не меняется, когда objects укорачивается. */
    for (var oi = 0; oi < out.objects.length; oi++) out.objects[oi].id = oi;
    out.objectTotal = out.objects.length;
    out.removedIds = [];
    return out;
  }

  /* ------------------------------------------------------------------ *
   *  Море вокруг острова                                               *
   * ------------------------------------------------------------------ */

  /* Остров считается в домене size × size: так заданная доля суши — это
     доля острова, а не доля картинки, и материк не зависит от того, сколько
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
    // острова. Иначе доля на ползунке разошлась бы с числом в панели
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

  /* --- Площадки под деревню у берега ------------------------------- *
   *
   * `spawnSites(world, n)` — API для режимов (бой, мультиплеер, бот): n мест,
   * где можно поставить стартовую деревню. Числа и правила:
   *
   *   · площадка — квадрат SITE × SITE клеток (9 × 9, на острове меньше 96
   *     клеток — 7 × 7, см. spawnSiteSize), целиком трава, не песок и не
   *     вода; внутри нет ни дерева, ни камня (проверяются и `world.tile`,
   *     и `world.objects`);
   *   · точки — только суша; центр площадки стоит у берега, а не в глубине
   *     острова;
   *   · первая точка — у края в направлении, которое детерминированно
   *     выбирается из сида; каждая следующая — самая далёкая от уже выбранных
   *     (жадный farthest-point). Поэтому точки расходятся по разным концам
   *     острова, а не сбиваются в кучу;
   *   · между точками не меньше MIN_SEP клеток. Не набралось n — возвращаем
   *     сколько есть: выдумывать площадку на воде или в лесу нельзя.
   *
   * Возврат: [{x, y}] — центры площадок в клетках. Функция ничего не меняет
   * в мире и полностью детерминирована сидом.
   * ------------------------------------------------------------------ */

  var SPAWN_SITE = 9;                 // сторона площадки в клетках на большом острове

  /* Сторона площадки под деревню. На 64×64 квадрат 9 × 9 — это 1/50 всей
     карты; после удвоения лесов (правило 2026-10-24) чистых таких квадратов
     на маленьком острове почти не остаётся: 64-я карта давала 1–2 точки
     вместо двух, а мультиплеер на две деревни падал. Площадка 7 × 7 (49
     клеток) — та же поляна, только в масштабе маленького острова; на 96 и
     больше остаётся 9 × 9. */
  function spawnSiteSize(world) {
    var island = world && (world.islandSize || Math.min(world.width, world.height));
    return island && island < 96 ? 7 : SPAWN_SITE;
  }

  function spawnSites(world, n) {
    n = Math.round(n || 0);
    if (!world || !world.tile || !world.isLand || n <= 0) return [];
    var W = world.width, H = world.height, N = W * H;
    var S = spawnSiteSize(world), half = (S - 1) / 2;
    if (W < S + 2 || H < S + 2) return [];

    // 1. Плохие клетки: не трава или занято деревом/камнем. Кусты, трава и
    //    цветы — украшение, они площадку не портят (то же правило, что у
    //    постановки зданий: js/buildings.js, obstacle).
    var bad = new Uint8Array(N);
    for (var i = 0; i < N; i++) if (world.tile[i] !== T.GRASS) bad[i] = 1;
    var objects = world.objects || [];
    for (var oi = 0; oi < objects.length; oi++) {
      var o = objects[oi];
      if (o.kind !== 'tree' && o.kind !== 'stone') continue;
      var ox = Math.floor(o.x), oy = Math.floor(o.y);
      if (ox >= 0 && oy >= 0 && ox < W && oy < H) bad[oy * W + ox] = 1;
    }

    // 2. Интегральные суммы. Окно S × S проверяется за O(1), а ресурсы
    //    вокруг площадки — той же таблицей: деревья и камни в радиусе resR.
    //    Это нужно для баланса: площадка не должна стоять в чаще, а соседняя
    //    — в голой степи, иначе одному игроку до леса два шага, другому минута.
    var stride = W + 1;
    function prefixSum(grid) {
      var S2 = new Int32Array((W + 1) * (H + 1));
      for (var yy = 0; yy < H; yy++) {
        var row2 = (yy + 1) * stride, prev2 = yy * stride;
        for (var xx = 0; xx < W; xx++) {
          S2[row2 + xx + 1] = grid[yy * W + xx] + S2[prev2 + xx + 1] + S2[row2 + xx] - S2[prev2 + xx];
        }
      }
      return S2;
    }
    var sums = prefixSum(bad);
    function rangeSum(S2, x0, y0, x1, y1) {
      return S2[y1 * stride + x1] - S2[y0 * stride + x1]
        - S2[y1 * stride + x0] + S2[y0 * stride + x0];
    }
    function windowSum(x0, y0) {
      return rangeSum(sums, x0, y0, x0 + S, y0 + S);
    }

    // Списки ресурсов: расстояние до дерева считается по-настоящему
    // евклидовым, а не по квадрату 9×9. Квадрат включал бы деревья в углах
    // на 30 клетках и врал бы «лес рядом».
    var treeObjs = [], stoneObjs = [];
    for (oi = 0; oi < objects.length; oi++) {
      var o2 = objects[oi];
      if (o2.kind === 'tree') treeObjs.push(o2);
      else if (o2.kind === 'stone' && o2.variant !== 'pebble') stoneObjs.push(o2);
    }

    // 3. Кандидаты. Центр — в клетке (x, y), окно — от x−4 до x+4.
    //    «У берега»: расстояние до воды не больше band. Если таких меньше n,
    //    band не режет: лучше площадка чуть глубже, чем меньше n.
    //
    //    Расстояние считаем заново, с потолком в размер острова:
    //    world.distWater после addSea обрезан на reach (8..11 клеток), и
    //    «11» у него значит и 11, и 40 — по нему берег от середины не отличить.
    var islandSize = world.islandSize || Math.min(W, H);
    var band = Math.max(8, Math.round(islandSize * 0.16));
    var resR = Math.max(10, Math.round(islandSize * 0.12));
    var distToWater = distanceTransform(world.isLand, W, H, Math.max(band + 2, islandSize));
    var all = [], coastal = [];
    var x, y;
    var landBounds = world.landBounds || { x0: 0, y0: 0, x1: W, y1: H };
    var ccx = (landBounds.x0 + landBounds.x1) / 2;
    var ccy = (landBounds.y0 + landBounds.y1) / 2;
    for (y = half + 1; y < H - half - 1; y++) {
      for (x = half + 1; x < W - half - 1; x++) {
        if (windowSum(x - half, y - half) !== 0) continue;
        var dw = distToWater[y * W + x];
        var c = { x: x, y: y, dw: dw, dx: x - ccx, dy: y - ccy, trees: 0, stones: 0 };
        all.push(c);
        if (dw <= band) coastal.push(c);
      }
    }

    // Точный счёт ресурсов вокруг площадки — в круге radius resR.
    for (var ti = 0; ti < coastal.length; ti++) {
      var c3 = coastal[ti], tcount = 0, scount = 0;
      var r2 = resR * resR;
      for (var tj = 0; tj < treeObjs.length; tj++) {
        var tdx = treeObjs[tj].x - c3.x, tdy = treeObjs[tj].y - c3.y;
        if (tdx * tdx + tdy * tdy <= r2) tcount++;
      }
      for (tj = 0; tj < stoneObjs.length; tj++) {
        var sdx = stoneObjs[tj].x - c3.x, sdy = stoneObjs[tj].y - c3.y;
        if (sdx * sdx + sdy * sdy <= r2) scount++;
      }
      c3.trees = tcount; c3.stones = scount;
    }

    // 3а. Баланс ресурсов. У каждой площадки должен быть свой лес и камень
    //     в радиусе resR, и не в десять раз больше, чем у соседней. Коридоры
    //     идут от строгого к мягкому, и следующий берётся только если из
    //     предыдущего не вышло n РАЗНЕСЁННЫХ точек.
    //
    //     Проверять одну длину списка нельзя: после удвоения лесов (2026-10-24)
    //     строгий коридор давал десятки клеток, но все в одном углу острова.
    //     «Список >= n» проходил, farthest-point ставил две точки и упирался
    //     в минимальную дистанцию, а режим на несколько деревень оставался
    //     без мест. Теперь расширение коридора зависит от того, что нужно
    //     на самом деле, — от числа разных концов острова.
    var minTrees = Math.max(6, Math.round(islandSize * 0.14));
    var maxTrees = Math.max(minTrees + 6, Math.round(islandSize * 0.45));
    var minStones = Math.max(1, Math.round(islandSize * 0.02));
    var pools = [
      [],                       // строго: лес в норме и камень в норме
      [],                       // лес с запасом, камень в норме
      [],                       // леса сколько угодно, камень в норме
      [],                       // леса сколько угодно, камень есть
      [],                       // любой чистый берег
      all                       // в крайнем случае — чистый участок в глубине
    ];
    var i2;
    for (i2 = 0; i2 < coastal.length; i2++) {
      var cc = coastal[i2];
      if (cc.trees >= minTrees && cc.trees <= maxTrees && cc.stones >= minStones) pools[0].push(cc);
      if (cc.trees >= minTrees && cc.trees <= maxTrees * 1.5 && cc.stones >= minStones) pools[1].push(cc);
      if (cc.trees >= minTrees && cc.stones >= minStones) pools[2].push(cc);
      if (cc.trees >= minTrees && cc.stones >= 1) pools[3].push(cc);
      if (cc.trees >= minTrees) pools[4].push(cc);
    }

    // 4. Точки на выбранном коридоре. Первая — у края в направлении из сида:
    //    угол — хеш от seedInt, поэтому один сид даёт одну и ту же площадку.
    //    Дальше жадный farthest-point: каждая следующая — максимально далеко
    //    от всех уже выбранных. Это и есть «по разным концам», без бросков.
    var ang = NZ.hash2i(9, 0, (world.seedInt | 0)) * Math.PI * 2;
    var dirX = Math.cos(ang), dirY = Math.sin(ang);
    var minSep = Math.max(12, Math.round(islandSize * 0.15));

    function pickSites(pool) {
      if (!pool.length) return [];
      var first = pool[0], bestScore = -Infinity;
      for (var ci = 0; ci < pool.length; ci++) {
        var c2 = pool[ci];
        // Проекция на «конец» минус небольшая плата за глубину: из двух
        // точек на одном конце выбираем ту, что ближе к берегу.
        var score = c2.dx * dirX + c2.dy * dirY - c2.dw * 0.35;
        if (score > bestScore) { bestScore = score; first = c2; }
      }
      var out = [first], chosen = [first];
      while (out.length < n) {
        var best = null, bestD = -1;
        for (ci = 0; ci < pool.length; ci++) {
          var cand = pool[ci];
          var used = false;
          for (var k = 0; k < chosen.length; k++) {
            if (chosen[k] === cand) { used = true; break; }
          }
          if (used) continue;
          var dmin = Infinity;
          for (k = 0; k < chosen.length; k++) {
            var ddx = cand.x - chosen[k].x, ddy = cand.y - chosen[k].y;
            var d2 = ddx * ddx + ddy * ddy;
            if (d2 < dmin) dmin = d2;
          }
          if (dmin > bestD) { bestD = dmin; best = cand; }
        }
        // Ближе MIN_SEP — это уже «куча», а не разные концы.
        if (!best || bestD < minSep * minSep) break;
        out.push(best);
        chosen.push(best);
      }
      return out;
    }

    // Берём самый строгий коридор, который даёт n точек; если такого нет —
    // возвращаем лучший из виденных, а не выдумываем площадку на воде.
    var bestOut = [];
    for (i2 = 0; i2 < pools.length; i2++) {
      var picked = pickSites(pools[i2]);
      if (picked.length > bestOut.length) bestOut = picked;
      if (picked.length >= n) break;
    }

    var result = [];
    for (i = 0; i < bestOut.length; i++) result.push({ x: bestOut[i].x, y: bestOut[i].y });
    return result;
  }

  /* Что на клетке — словами. Курсор над картой есть и у генератора, и у
     игры, и обе оболочки пишут под ним одно и то же: «12, 34 · Трава · роща».
     Считать эту строку в каждой оболочке своим куском кода значит разойтись
     в словах на первой же правке — поэтому строка собирается здесь, рядом
     с именами классов клеток, а оболочки её только показывают.

     За картой (курсор ушёл на бесконечное море вокруг полотна) клетки нет:
     inside = false, text = null. Это не ошибка ввода, а нормальный случай. */
  function describeCell(world, x, y) {
    if (!world || !world.tile) return null;
    if (x < 0 || y < 0 || x >= world.width || y >= world.height) {
      return { inside: false, x: x, y: y, tile: -1, name: null, extra: '', text: null };
    }
    var i = y * world.width + x;
    var t = world.tile[i];
    var name = TILE_NAMES[t];
    // Роща и камень — не класс клетки, а поле: по клетке видно только траву,
    // а по полю — что тут лес или выход камня. Без этого строка врёт.
    var extra = '';
    if (t === T.GRASS) {
      if (world.forestness[i] > 0.35) extra = ' · роща';
      else if (world.stonyness[i] > 0.3) extra = ' · камень';
    }
    return {
      inside: true, x: x, y: y, tile: t, name: name, extra: extra,
      land: !!world.isLand[i],
      text: x + ', ' + y + ' · ' + name + extra
    };
  }

  /* --- Оставляем только самую крупную сушу -------------------------- *
   * minShare — порог, ниже которого дробление считается ошибкой: если
   * крупнейший кусок меньше него, осколки убираются все. minShare = 0 —
   * безусловно оставить только главный кусок (так генерация и делает:
   * «один материк» проверяется тестом формы).
   * ------------------------------------------------------------------ */

  function keepLargestComponent(isLand, W, H, minShare) {
    var N = W * H;
    var label = new Int32Array(N);
    var best = -1, bestSize = 0;
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

  /* --- Засыпаем внутренние озёра ------------------------------------ *
   * «Внутренние озёра не добавляй»: вода, до которой нельзя дойти от края
   * домена по воде, — это дыра в материке. Заливаем её сушей. Заодно это
   * чинит берег после keepLargestComponent: замкнутая вода не остаётся
   * кольцом, а остров не становится решетом.
   * ------------------------------------------------------------------ */

  function fillEnclosedWater(isLand, W, H) {
    var N = W * H;
    var outside = new Uint8Array(N);
    var stack = new Int32Array(N);
    var sp = 0;
    var i, x, y;

    function push(k) {
      if (!isLand[k] && !outside[k]) { outside[k] = 1; stack[sp++] = k; }
    }
    for (x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }

    while (sp > 0) {
      i = stack[--sp];
      x = i % W; y = (i - x) / W;
      if (x > 0) push(i - 1);
      if (x < W - 1) push(i + 1);
      if (y > 0) push(i - W);
      if (y < H - 1) push(i + W);
    }

    for (i = 0; i < N; i++) if (!isLand[i] && !outside[i]) isLand[i] = 1;
  }

  /* --- Норма леса по областям --------------------------------------- *
   *
   * Один порог на всю карту оставлял целые края острова без рощ: поле леса —
   * шум, и в одной области оно в среднем выше, в другой ниже, а квантиль
   * режет карту по общей высоте. Здесь порог считается по КРУПНОЙ сетке: в
   * каждом узле — квантиль поля на суше в окне вокруг узла. Значит, в каждой
   * области под рощи уходит одна и та же доля суши, и лес ложится по карте
   * ровно, а не кучей на одном краю.
   *
   * Между узлами порог интерполируется билинейно, поэтому сетки на карте не
   * видно: кромку рощи по-прежнему рисует рваное поле, а не ячейка.
   *
   * Возвращает { at(x, y), max, avg } или null, если леса нет:
   *   at(x, y) — порог поля в клетке (дробный, интерполяция между узлами);
   *   max      — максимум поля на суше: по нему нормируется «чаща»;
   *   avg      — средний порог: нижняя точка шкалы густоты.
   * ------------------------------------------------------------------ */

  function forestQuotas(field, isLand, W, H, landIdx, share) {
    if (share <= 0 || !landIdx.length) return null;

    var G = FOREST_LEVELS;
    var nodes = new Float32Array((G + 1) * (G + 1));
    var valid = new Uint8Array(nodes.length);
    var cellW = W / G, cellH = H / G;
    // Окно узла — чуть больше ячейки: узел стоит на стыке четырёх областей,
    // и его квантиль должен опираться на все четыре, а не на одну.
    var rad = Math.max(2, Math.round(Math.max(cellW, cellH) * 0.8));
    var buf = new Float32Array((2 * rad + 1) * (2 * rad + 1));
    var gx, gy, x, y, k;

    for (gy = 0; gy <= G; gy++) {
      for (gx = 0; gx <= G; gx++) {
        var cx = Math.round(gx / G * W), cy = Math.round(gy / G * H);
        var n = 0;
        for (y = Math.max(0, cy - rad); y <= Math.min(H - 1, cy + rad); y++) {
          for (x = Math.max(0, cx - rad); x <= Math.min(W - 1, cx + rad); x++) {
            if (isLand[y * W + x]) buf[n++] = field[y * W + x];
          }
        }
        if (n < FOREST_MIN_SAMPLES) continue;      // узел в море
        var view = buf.subarray(0, n);
        view.sort();                               // типизированный sort — числом
        k = gy * (G + 1) + gx;
        nodes[k] = view[Math.floor((1 - share) * (n - 1))];
        valid[k] = 1;
      }
    }

    // Узлы над водой берут порог ближайшего сухого узла: иначе у берега порог
    // тянуло бы к нулю и прибрежные рощи раздувались бы.
    for (gy = 0; gy <= G; gy++) {
      for (gx = 0; gx <= G; gx++) {
        k = gy * (G + 1) + gx;
        if (valid[k]) continue;
        var bestD = Infinity, bestV = 0;
        for (var jy = 0; jy <= G; jy++) {
          for (var jx = 0; jx <= G; jx++) {
            var jk = jy * (G + 1) + jx;
            if (!valid[jk]) continue;
            var dx = jx - gx, dy = jy - gy, dd = dx * dx + dy * dy;
            if (dd < bestD) { bestD = dd; bestV = nodes[jk]; }
          }
        }
        nodes[k] = bestV;
      }
    }

    var maxV = -Infinity;
    for (var li = 0; li < landIdx.length; li++) {
      var v = field[landIdx[li]];
      if (v > maxV) maxV = v;
    }
    var sum = 0;
    for (k = 0; k < nodes.length; k++) sum += nodes[k];

    function at(px, py) {
      var fx = px / W * G, fy = py / H * G;
      var x0 = fx | 0, y0 = fy | 0;
      if (x0 > G - 1) x0 = G - 1;
      if (y0 > G - 1) y0 = G - 1;
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      var tx = fx - x0, ty = fy - y0;
      var row0 = y0 * (G + 1) + x0, row1 = row0 + (G + 1);
      var top = nodes[row0] + (nodes[row0 + 1] - nodes[row0]) * tx;
      var bot = nodes[row1] + (nodes[row1 + 1] - nodes[row1]) * tx;
      return top + (bot - top) * ty;
    }

    return { at: at, max: maxV, avg: sum / nodes.length };
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
    // Площадка деревни: в центре острова не ставим деревья и камни. Там
    // встаёт ратуша с домом и лагерем, и лес вплотную к стене — не лес, а
    // помеха; заодно стартовая клетка жителя не оказывается под стволом.
    var clearR = Math.max(4, Math.round(W * 0.06));
    var ccx = W / 2, ccy = H / 2;

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
    var treeDensity = p.trees * 9.0;     // плотность внутри рощ
    // Камни в клетке с деревом не ставятся (сначала дерево, и клетка занята).
    // Рощ стало вдвое больше, и без поправки часть бросков камня до своей
    // ветки не доходила: выходов на карте стало бы на 10 % меньше. Поправка
    // растёт вместе с ползунком леса, при «без леса» её нет вовсе.
    var rockDensity = p.rocks * 2.4 * (1 + 0.22 * p.forest);
    // Просветы внутри рощ: высокочастотное поле, по которому дерево то
    // стоит, то нет. Без него мелкая роща всё равно выглядит сплошной
    // кляксой, а с ним читается как лес с полянами.
    var dappleSeed = (ctx.S ^ 0x9e3779b1) | 0;
    var kDapple = 20.0 / W;

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
        var inVillage = Math.hypot(px - ccx, py - ccy) < clearR;
        if (t === T.GRASS && nearWater > 1.2 && f > 0 && !inVillage) {
          var treeChance = treeDensity * (0.03 + f * f);
          var dapple = NZ.fbm2(x * kDapple + 3.1, y * kDapple - 5.7, dappleSeed, 3);
          treeChance *= 0.40 + 1.0 * dapple;          // поляны и прогалы
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
        if (t !== T.SAND && st > 0 && !inVillage) {
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
    landBounds: landBounds,
    spawnSites: spawnSites,
    spawnSiteSize: spawnSiteSize,
    describeCell: describeCell
  };
})(typeof window !== 'undefined' ? window : globalThis);
