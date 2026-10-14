/* render.js — отрисовка карты в изометрии 2:1 (как в Clash of Clans).

   Мир — плоская сетка клеток. Клетка (x, y) проецируется в ромб:

       sx = (x - y) * tw/2
       sy = (x + y) * tw/4           (tw — ширина ромба в пикселях)

   Из этого следует главное решение: поверхность земли — это аффинное
   преобразование плоскости. Пока камера не поворачивается, всю местность
   можно нарисовать один раз в собственном разрешении и потом показывать
   одной картинкой. Объекты (деревья, камни) стоят вертикально, поэтому
   рисуются отдельно, билбордами, в порядке глубины (x + y).

   Порядок слоёв в кадре:
     1. кэш местности      — вода, отмели, материк с текстурой, песок
     2. рябь моря          — текстура воды умножением, по всему морю
     3. гребни волн        — спрайты low-poly моделей (assets/waves/)
     4. объекты            — отсортированы по x + y (один раз, на генерации)
     5. подсветка клетки, сетка, миникарта
*/
(function (global) {
  'use strict';

  var WG = global.WorldGen;
  var T = WG.T;

  var OVERLAP = 0.75;      // перекрытие клеток при заливке, px кэша
  var TEX_REPEAT = 2;      // раз во сколько клеток повторяется текстура земли
  var CACHE_MIN_PX = 16;   // нижняя граница разрешения кэша, px на клетку
  var CACHE_MAX_PX = 40;   // верхняя: больше не нужно, это уже про печать

  var MIN_ZOOM = 3;        // ниже не пускаем даже крошечное окно
  var MAX_ZOOM = 120;

  /* Тряска дерева от удара топором (ставит её житель: js/villager.js: strike).

     Удар ставит дереву shake = 1, а ГАСИТ его время, а не житель: удары идут
     через 2/3 секунды, и к следующему от тряски не должно остаться следа —
     иначе дерево дрожало бы непрерывно, и удар перестал бы читаться ударом.

     Тряска — ПОВОРОТ вокруг комля, а не сдвиг спрайта: сдвиг читается «дерево
     поехало», поворот — «дерево качнулось». Комель — та же точка опоры, что у
     контактной тени (anchor спрайта), вокруг неё и вращаем. Числа: 2.2° в
     первом кадре, 7 качаний в секунду, затухание e^-9 за секунду — к 0.4 с
     остаётся 2% амплитуды, то есть меньше пикселя. */
  var SHAKE_ANG = 0.038;   // радианы: размах поворота в первом кадре удара
  var SHAKE_HZ = 7.0;      // качаний в секунду: чаще — уже дрожь, а не удар
  var SHAKE_DECAY = 9.0;   // 1/с: во сколько раз гаснет за секунду (e^-9)
  var SHAKE_FLOOR = 0.02;  // ниже этого дерево считается стоящим

  // Глубина: где кончается отмель и где начинается глубина. Те же числа,
  // что в классах клеток у генератора (shallowW и shallowW * 2.4) — иначе
  // цвет воды разошёлся бы с тем, что написано в подсказке под курсором.
  var SHALLOW_W = 2.6;
  var DEPTH_W = 6.4;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  var PAL = {
    deep: [22, 78, 128],
    water: [38, 112, 166],
    shallow: [86, 176, 205],
    foam: [186, 228, 238],
    sand: [232, 214, 152],
    sandDark: [204, 180, 122],
    cliff: [150, 126, 92]
  };

  function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  /* ------------------------------- рендер ------------------------------- */

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = null;
    this.sprites = null;
    this.buildings = [];                   // поставленные ратуши
    this.buildingSprites = null;           // атлас ратуши (js/buildings.js)
    this.villagers = [];                   // жители: у них своё поведение (js/villager.js)
    this.villagerSprites = null;           // атлас жителя
    this.ghost = null;                     // призрак размещения: {b, ok, reason, blocked}
    this.textures = {};
    this.dpr = 1;

    this.cam = { x: 0, y: 0, zoom: 40 };   // x, y — в клетках, zoom — px на клетку
    this.minZoom = MIN_ZOOM;               // дальше этого не отдаляемся (см. fitIsland)
    this.maxZoom = MAX_ZOOM;
    this.showGrid = false;
    this.showTrees = true;
    this.showRocks = true;
    this.showSmall = true;
    this.showBuildings = true;
    this.showVillagers = true;

    this.hover = null;                     // {x, y} в клетках
    this.selected = null;                  // выбранная постройка
    this.time = 0;

    this.cache = null;
    this.cachePx = CACHE_MAX_PX;
    this.cacheOffset = { x: 0, y: 0 };
    this.landPatterns = null;
    this.ripplePattern = null;             // модуль ряби моря (умножением)
    this.landClip = null;                  // ромбы суши: по ним из моря вырезается земля
    this.landCells = null;                 // клетки суши: по ним предел панорамы
    this.seaClip = null;                   // «всё, кроме суши» — обрезка для волн
    this.mmBox = null;                     // что показывает миникарта, в пикселях кэша
    this._order = null;                    // кэш порядка отрисовки построек
    this.waveSprites = null;               // атлас гребней волн (js/waves.js)
  }

  /* --- постройки ------------------------------------------------------ *
   *
   * Ратуша — билборд, как дерево, но в отличие от дерева она стоит не в
   * точке, а на пятне 4 x 3, и порядок глубины у неё считается по центру
   * пятна. Список объектов мира уже отсортирован по x + y на генерации,
   * поэтому постройки в него не вклеиваются, а вливаются слиянием двух
   * отсортированных списков: пересортировывать тысячи деревьев на каждое
   * перемещение призрака незачем.
   * -------------------------------------------------------------------- */

  Renderer.prototype.setBuildings = function (list) {
    this.buildings = list || [];
    this._order = null;
    // Миникарта собирается из того же кэша, поэтому на изменение состава
    // построек её надо пересобрать: иначе ратуша видна на карте, но не
    // на обзоре, и клик по обзору уводит в пустое место.
    if (this.cache) this.buildMinimap();
  };

  Renderer.prototype.buildingOrder = function () {
    if (this._order) return this._order;
    var B = global.Buildings;
    var out = [];
    for (var i = 0; i < this.buildings.length; i++) {
      var b = this.buildings[i];
      out.push({ b: b, key: B ? B.depth(b) : (b.x + b.y) });
    }
    out.sort(function (a, c) { return a.key - c.key; });
    this._order = out;
    return out;
  };

  /* Жители. Список ведёт app.js (он же их и двигает), рендер только рисует.
     Порядок глубины у них считается на каждый кадр, а не кэшируется, как у
     построек: житель ходит, и его ключ x + y меняется каждый шаг. Жителей
     единицы — сортировка тут дешевле, чем слежение за тем, когда кэш протух. */
  Renderer.prototype.setVillagers = function (list) {
    this.villagers = list || [];
  };

  Renderer.prototype.villagerOrder = function () {
    var out = [];
    for (var i = 0; i < this.villagers.length; i++) {
      var v = this.villagers[i];
      out.push({ v: v, key: v.x + v.y });
    }
    out.sort(function (a, c) { return a.key - c.key; });
    return out;
  };

  // Спрайт жителя на экране при текущем зуме: та же точка опоры, что у
  // деревьев (земля между ступнями), но масштаб — человека, а не дерева.
  Renderer.prototype.villagerBox = function (v, z) {
    var V = global.Villagers, set = this.villagerSprites;
    if (!V || !set) return null;
    var spr = V.sprite(set, v);
    if (!spr) return null;
    var sc = V.scaleAt(set, z);
    var dw = spr.sw * sc, dh = spr.sh * sc;
    var px = this.sx(v.x, v.y), py = this.sy(v.x, v.y);
    return {
      spr: spr, dw: dw, dh: dh, x: px, y: py,
      dx: px - dw * spr.ax,
      dy: py - dh * spr.ay
    };
  };

  // Геометрия спрайта постройки на экране при текущем зуме, в пикселях.
  Renderer.prototype.buildingBox = function (b, z) {
    var B = global.Buildings, set = this.buildingSprites;
    if (!B || !set) return null;
    var spr = B.sprite(set, b.variant, b.rot);
    if (!spr) return null;
    var c = B.center(b), sc = B.scaleAt(set, z);
    /* Точка опоры смещается так, чтобы в середине пятна оказалась середина
       наземного контура — цоколь вместе с крыльцом (B.anchorShift). По
       модели основание стоит не по середине: крыльцо выходит за пятно. */
    var sh = B.anchorShift ? B.anchorShift(spr, set.mul) : { x: 0, y: 0 };
    var dw = spr.sw * sc.x, dh = spr.sh * sc.y;
    var cx = this.sx(c.x - sh.x, c.y - sh.y), cy = this.sy(c.x - sh.x, c.y - sh.y);
    return {
      spr: spr, dw: dw, dh: dh, cx: cx, cy: cy,
      dx: cx - dw * spr.ax,
      dy: cy - dh * spr.ay
    };
  };

  /* --- мелкие помощники --------------------------------------------- */

  // Ромб клетки (x, y) в произвольных координатах с общим масштабом s.
  // Начинается с moveTo и заканчивается closePath: подконтуры соседних
  // клеток не соединяются линией. Без этого при заливке группы ромбов
  // между ними протягивались диагональные швы — из-за них трава на крупном
  // зуме выглядела полосатой, а по воде шли лишние косые линии.
  // grow — на сколько пикселей раздуть ромб. Заливка группы клеток без
  // перекрытия оставляет волосяные швы: сглаженный край каждой клетки
  // подмешивает цвет фона, и по стыкам идут тёмные полосы. Перекрытие
  // в доли пикселя их убирает.
  Renderer.prototype.tileDiamond = function (g, x, y, s, grow) {
    var g2 = grow || 0;
    var hw = s * 0.5 + g2, hh = s * 0.25 + g2;
    var cx = (x - y) * s * 0.5, cy = (x + y) * s * 0.25;
    g.moveTo(cx, cy - hh);
    g.lineTo(cx + hw, cy);
    g.lineTo(cx, cy + hh);
    g.lineTo(cx - hw, cy);
    g.closePath();
  };

  /* Полоса клеток из одного ряда: союз ромбов — один параллелограмм.

     Соседние ромбы ряда сходятся углами: правый угол клетки (x, y) — это
     ровно верхний угол клетки (x + 1, y). Поэтому вся полоса описывается
     четырьмя точками, и путь из сотни клеток стоит четырёх операций вместо
     пятисот. На 128×128 это разница между сотнями фигур и одиннадцатью
     тысячами: кэш собирается в разы быстрее, а заливка без перекрытия по
     отдельным ромбам ещё и оставляла волосяные полосы на стыках. */
  Renderer.prototype.tileRun = function (g, x0, x1, y, px, grow) {
    var g2 = grow || 0;
    var hw = px * 0.5 + g2, hh = px * 0.25 + g2;
    var cx0 = (x0 - y) * px * 0.5, cy0 = (x0 + y) * px * 0.25;
    var cx1 = (x1 - y) * px * 0.5, cy1 = (x1 + y) * px * 0.25;
    g.moveTo(cx0, cy0 - hh);
    g.lineTo(cx1 + hw, cy1);
    g.lineTo(cx1, cy1 + hh);
    g.lineTo(cx0 - hw, cy0);
    g.closePath();
  };

  /* Все полосы прямоугольника клеток, где клетка проходит проверку pass.
     Координаты — в мировых пикселях кэша БЕЗ его начала: в paintCache сдвиг
     даёт преобразование контекста, а в buildLandClip путь строится в
     координатах кэша, и сдвиг добавляется там (см. ниже). Держать сдвиг
     в одном месте обязательно: с ним в двух сразу заливка уезжает на
     полкарты и суша рисуется поверх моря. */
  Renderer.prototype.tileRuns = function (g, x0, y0, x1, y1, px, grow, pass) {
    for (var y = y0; y < y1; y++) {
      var x = x0;
      while (x < x1) {
        if (!pass(x, y)) { x++; continue; }
        var s = x;
        while (x < x1 && pass(x, y)) x++;
        this.tileRun(g, s, x - 1, y, px, grow);
      }
    }
  };

  // Путь из тех же полос, но уже в координатах кэша (со сдвигом начала).
  Renderer.prototype.landRunsPath = function (px, offX) {
    var w = this.world, isLand = w.isLand, W = w.width, H = w.height;
    var raw = new Path2D();
    this.tileRuns(raw, 0, 0, W, H, px, 0, function (x, y) {
      return isLand[y * W + x];
    });
    var path = new Path2D();
    path.addPath(raw, new DOMMatrix([1, 0, 0, 1, offX, 0]));
    return path;
  };

  // Мир -> экран. Возвращает координаты относительно центра канваса,
  // поэтому смещение камеры входит сюда же. Одна пара функций на всю
  // отрисовку: и местность, и объекты считаются этим преобразованием,
  // иначе спрайты уезжают относительно земли.
  Renderer.prototype.sx = function (wx, wy) {
    var z = this.cam.zoom, c = this.cam;
    return (wx - wy - c.x + c.y) * z * 0.5;
  };
  Renderer.prototype.sy = function (wx, wy) {
    var z = this.cam.zoom, c = this.cam;
    return (wx + wy - c.x - c.y) * z * 0.25;
  };

  // Экран (в клетках-пикселях, без учёта dpr) -> мир
  // Экран (от центра канваса) -> мир. Строго обратная к sx/sy:
  //   sx = (u − v)·z/2,  sy = (u + v)·z/4
  // Решаем систему: u = (2·sy + sx)/z,  v = (2·sy − sx)/z.
  Renderer.prototype.screenToWorld = function (vx, vy) {
    var z = this.cam.zoom, c = this.cam;
    return {
      x: c.x + (vy * 2 + vx) / z,
      y: c.y + (vy * 2 - vx) / z
    };
  };

  /* --- кэш местности -------------------------------------------------- */

  Renderer.prototype.setTextures = function (map) {
    this.textures = map || {};
    this.landPatterns = null;
    if (this.world) this.buildCache();
  };

  Renderer.prototype.buildCache = function () {
    var w = this.world;
    if (!w) return;
    var N = w.width * w.height;

    // Разрешение кэша выбирается от размера карты: 64×64 рисуется «в полный
    // рост», большие карты — мельче, чтобы не съесть память. На экране это
    // незаметно: зум всё равно ограничен.
    var px = clamp(Math.round(Math.sqrt(9.0e6 / N)), CACHE_MIN_PX, CACHE_MAX_PX);
    this.cachePx = px;

    var offX = w.height * px * 0.5;      // левый край: x - y = -H
    var offY = 0;                        // верхний край: x + y = 0
    var cw = Math.ceil((w.width + w.height) * px * 0.5) + 2;
    var chh = Math.ceil((w.width + w.height) * px * 0.25) + 2;

    var cv = document.createElement('canvas');
    cv.width = cw; cv.height = chh;
    this.cache = cv;
    this.cacheOffset = { x: offX, y: offY };

    var g = cv.getContext('2d');
    this.buildPatterns();
    this.paintCache(g, px, offX, offY, 0, 0, w.width, w.height);
    this.landClip = this.buildLandClip();
    // Клетки суши — для предела панорамы.
    this.landCells = this.buildLandCells();
    // «Море везде, кроме суши»: прямоугольник заведомо больше любой видимой
    // области плюс ромбы суши. Правило even-odd вычитает вторые из первого,
    // поэтому обрезка строится один раз, а не на каждый кадр.
    var sea = new Path2D();
    sea.rect(-1e6, -1e6, 2e6, 2e6);
    sea.addPath(this.landClip);
    this.seaClip = sea;
    this.buildMinimap();
    // Предел отдаления считается от габарита суши, а он известен только
    // после генерации: до этого отдаляться было не от чего.
    this.minZoom = this.zoomOutLimit();
    // Заодно и предел панорамы: после перегенерации остров другой, и камера
    // могла остаться там, где нового острова уже не видно.
    this.clampCamera();
  };

  // Рисует прямоугольник клеток [x0..x1) × [y0..y1) в контекст, где начало
  // координат кэша — в (offX, offY).
  Renderer.prototype.paintCache = function (g, px, offX, offY, x0, y0, x1, y1) {
    var w = this.world, W = w.width, H = w.height;
    var tile = w.tile, distLand = w.distLand, isLand = w.isLand;
    var patterns = this.landPatterns;
    var x, y, i;

    g.save();
    g.setTransform(1, 0, 0, 1, offX, offY);

    // --- 1. Глубина: одним прямоугольником на весь прямоугольник --------
    // Дно рисуется заливкой, а не клетками: под водой границ клеток всё
    // равно не видно, зато нет тысяч лишних операций.
    var ddw = px * 0.5, ddh = px * 0.25;
    var ix0 = (x0 - y1) * ddw, ix1 = (x1 - y0) * ddw;
    var iy0 = (x0 + y0) * ddh, iy1 = (x1 + y1) * ddh;
    g.fillStyle = rgb(PAL.deep);
    g.fillRect(ix0 - 1, iy0 - 1, (ix1 - ix0) + 2, (iy1 - iy0) + 2);

    // --- 2. Отмель: полоса вдоль берега, с градиентом по глубине --------
    // Градиент идёт в два отрезка: отмель -> вода -> глубина. Обрывать его
    // на цвете воды нельзя: получается ступенька, и по морю проходит
    // ровная линия, которая читается как край полотна. Заканчивается он
    // ровно на цвете глубины, а он же — цвет фона, поэтому дальше море
    // продолжается без шва.
    for (y = y0; y < y1; y++) {
      for (x = x0; x < x1; x++) {
        i = y * W + x;
        if (isLand[i]) continue;
        var d = distLand[i];
        if (d > DEPTH_W) continue;
        var col = d <= SHALLOW_W
          ? mixTo(PAL.shallow, PAL.water, d / SHALLOW_W)
          : mixTo(PAL.water, PAL.deep, (d - SHALLOW_W) / (DEPTH_W - SHALLOW_W));
        g.fillStyle = rgb(col);
        g.beginPath();
        this.tileDiamond(g, x, y, px, OVERLAP);
        g.fill();
      }
    }

    // --- 3. Материк: одна заливка текстурой на всю сушу -----------------
    // Ключевой момент: узор один на всю карту, поэтому стыков между
    // клетками не бывает по построению. Раньше каждая клетка рисовалась
    // своей плиткой, и на стыках получалась сетка из светлых полос.
    g.fillStyle = patterns && patterns.grass ? patterns.grass : rgb([104, 168, 74]);
    g.beginPath();
    this.tileRuns(g, x0, y0, x1, y1, px, OVERLAP, function (cx, cy) {
      return isLand[cy * W + cx];
    });
    g.fill();

    // --- 4. Песок у самой кромки ---------------------------------------
    g.fillStyle = patterns && patterns.sand ? patterns.sand : rgb(PAL.sand);
    g.beginPath();
    this.tileRuns(g, x0, y0, x1, y1, px, OVERLAP, function (cx, cy) {
      return tile[cy * W + cx] === T.SAND;
    });
    g.fill();

    // --- 5. Тёмная кромка песка: берег читается объёмнее -----------------
    g.strokeStyle = 'rgba(150,124,78,0.5)';
    g.lineWidth = Math.max(0.6, px / 26);
    g.beginPath();
    var beachW = Math.max(0.9, W / 64);
    for (y = y0; y < y1; y++) {
      for (x = x0; x < x1; x++) {
        i = y * W + x;
        if (!isLand[i] || w.distWater[i] > beachW + 0.6) continue;
        this.tileDiamond(g, x, y, px, OVERLAP);
      }
    }
    g.stroke();

    g.restore();
  };

  // Смесь двух цветов палитры.
  function mixTo(a, b, t) {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  }

  /* --- область моря ---------------------------------------------------- */

  /* Контур суши в координатах кэша. Обрезать приходится не воду, а землю:
     вода теперь не кончается вместе с картой (см. drawWaterShimmer), а
     материк по-прежнему конечен, и волны не должны ложиться на траву.

     Ромбы берутся без перекрытия (OVERLAP тут только навредил бы): под
     правилом even-odd две перекрывающиеся клетки дают чётное число
     пересечений, то есть дырку в обрезке и мазок волны прямо на суше.
     Стык в стык ромбы покрывают землю ровно, без зазоров. */
  Renderer.prototype.buildLandClip = function () {
    if (!this.world) return new Path2D();
    // Сдвиг начала координат кэша добавляется здесь — путь обязан лежать
    // в тех же координатах, что и блит местности, иначе обрезка моря
    // уезжает на полкарты и вырезает не то место.
    return this.landRunsPath(this.cachePx, this.cacheOffset.x);
  };

  /* --- узоры текстур --------------------------------------------------- */

  // Приводим квадратную текстуру Blender к периоду повтора и превращаем
  // в узор. Текстура земли должна лечь как проекция площади на изометрию,
  // поэтому узор не сплющивается: он просто периодичен по обеим осям.
  Renderer.prototype.buildPatterns = function () {
    var px = this.cachePx;
    var period = Math.max(8, Math.round(TEX_REPEAT * px));
    var out = {};
    for (var k in this.textures) {
      var img = this.textures[k];
      if (!img) continue;
      var cv = document.createElement('canvas');
      cv.width = period; cv.height = period;
      var g = cv.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.drawImage(img, 0, 0, period, period);
      out[k] = g.createPattern(cv, 'repeat');
    }
    this.landPatterns = out;

    // Рябь моря — готовая картинка (assets/waves/ripple.png): модуль яркости
    // текстуры воды, приведённый к серому у белого. Считать её здесь, читая
    // пиксели холста, нельзя: под `file://` картинка считается чужим
    // источником, и getImageData падает с SecurityError — на этом уже один
    // раз встала вся загрузка спрайтов. Готовит её tools/pack_waves.py.
    this.ripplePattern = out.ripple || null;
  };

  /* --- миникарта ------------------------------------------------------- */

  /* Что попадает на миникарту. Это не карта целиком, а игровой кадр: остров
     и по половине его диаметра моря вокруг — ровно то, что видно при
     максимальном отдалении. По карте обзор строить нельзя: карта меньше
     кадра (море вокруг неё дорисовывает рендер), и рамка обзора уезжала бы
     за её пределы, а сам обзор показывал бы только остров вплотную. */
  Renderer.prototype.viewBox = function () {
    var w = this.world;
    if (!w) return null;
    var b = w.landBounds || { x0: 0, y0: 0, x1: w.width, y1: w.height };
    // Клетка запаса на кроны деревьев по кромке: остров должен быть виден
    // целиком, вместе с тем, что растёт у самой воды.
    var pad = 1;
    var x0 = b.x0 - pad, y0 = b.y0 - pad, x1 = b.x1 + pad, y1 = b.y1 + pad;
    // И по половине его диаметра моря с каждой стороны.
    var mx = (x1 - x0) * 0.5, my = (y1 - y0) * 0.5;
    return { x0: x0 - mx, y0: y0 - my, x1: x1 + mx, y1: y1 + my };
  };

  // Прямоугольник миникарты в пикселях кэша плюс перевод в её пиксели.
  Renderer.prototype.computeMinimapBox = function () {
    var v = this.viewBox();
    if (!v) return null;
    var px = this.cachePx, off = this.cacheOffset;
    var x0 = (v.x0 - v.y1) * px * 0.5 + off.x;
    var x1 = (v.x1 - v.y0) * px * 0.5 + off.x;
    var y0 = (v.x0 + v.y0) * px * 0.25 + off.y;
    var y1 = (v.x1 + v.y1) * px * 0.25 + off.y;
    // Карта обязана попасть на обзор целиком, как бы ни легли габариты.
    x0 = Math.min(x0, 0); y0 = Math.min(y0, 0);
    x1 = Math.max(x1, this.cache.width); y1 = Math.max(y1, this.cache.height);
    var k = Math.min(MM_SIZE / (x1 - x0), MM_SIZE / (y1 - y0));
    return {
      x0: x0, y0: y0, x1: x1, y1: y1, k: k,
      ox: (MM_SIZE - (x1 - x0) * k) / 2, oy: (MM_SIZE - (y1 - y0) * k) / 2
    };
  };

  Renderer.prototype.buildMinimap = function () {
    var w = this.world;
    if (!w || !this.cache) return;
    var size = MM_SIZE;
    var cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    var g = cv.getContext('2d');
    var c = this.cache;
    var b = this.computeMinimapBox();
    this.mmBox = b;
    g.fillStyle = rgb(PAL.deep);
    g.fillRect(0, 0, size, size);
    g.imageSmoothingEnabled = true;
    // Кэш кладётся той же формулой, что и всё остальное: пиксель кэша ->
    // пиксель миникарты. Иначе точки объектов встают не на свои клетки.
    g.drawImage(c, b.ox + (0 - b.x0) * b.k, b.oy + (0 - b.y0) * b.k,
      c.width * b.k, c.height * b.k);

    // Объекты поверх уменьшенной карты: иначе на миникарте не видно, где лес,
    // а это главное, что на ней ищут. Мелкие точки прореживаем — 1 к 3.
    var objs = w.objects;
    // Размер точки — примерно клетка, но не меньше полутора пикселей:
    // при мелком масштабе точка в клетку получается субпиксельной и лес
    // на миникарте просто не видно, а именно за ним на неё и смотрят.
    var sd = Math.max(1.5, this.cachePx * b.k * 0.7);
    for (var i = 0; i < objs.length; i++) {
      var o = objs[i];
      if (o.kind === 'tuft' || o.kind === 'flower' || o.kind === 'reed') continue;
      if (o.kind === 'stone' && !o.mineable && (i % 3)) continue;
      // Позицию считает worldToMM — та же функция, что и для рамки обзора
      // и клика по миникарте. Своя формула здесь уже расходилась с остальными
      // на множитель cachePx, и точки уезжали выше своих клеток.
      var p = this.worldToMM(o.x, o.y);
      g.fillStyle = o.kind === 'tree' ? 'rgba(26,72,38,0.85)' : 'rgba(72,72,80,0.85)';
      g.fillRect(p.x - sd * 0.5, p.y - sd * 0.5, sd, sd);
    }
    // Постройки — поверх всего: на обзоре ратуша должна находиться сразу,
    // иначе непонятно, куда её поставили. Рисуем и пятно застройки целиком,
    // и точку в его центре: у здания размер — главное, но на обзоре всего
    // кадра пятно занимает три-четыре пикселя, и по одной только заливке
    // ратушу там не найти (обрезка по краю съедает больше половины).
    var bl = this.buildings, B = global.Buildings;
    if (this.showBuildings && B) {
      for (var k = 0; k < bl.length; k++) {
        var bb = B.bounds(bl[k]);
        var corners = [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y1], [bb.x0, bb.y1]];
        g.beginPath();
        for (var q = 0; q < 4; q++) {
          var pp = this.worldToMM(corners[q][0], corners[q][1]);
          if (q === 0) g.moveTo(pp.x, pp.y); else g.lineTo(pp.x, pp.y);
        }
        g.closePath();
        g.fillStyle = 'rgba(255,222,150,0.9)';
        g.fill();
        g.strokeStyle = 'rgba(56,38,10,0.85)';
        g.lineWidth = 1;
        g.stroke();

        var bc = B.center(bl[k]);
        var pc = this.worldToMM(bc.x, bc.y);
        g.fillStyle = 'rgba(255,238,182,0.98)';
        g.fillRect(pc.x - 2, pc.y - 2, 4, 4);
        g.strokeStyle = 'rgba(56,38,10,0.9)';
        g.strokeRect(pc.x - 2, pc.y - 2, 4, 4);
      }
    }
    this.minimap = cv;
  };

  /* Миникарта: те же две системы координат, что и у карты, только в
     масштабе MM_SIZE. Преобразования держим в одном месте — и рисование
     рамки обзора, и клик по миникарте, иначе они расходятся, и клик
     уводит камеру не туда, куда попал. */
  var MM_SIZE = 192;

  Renderer.prototype.mmScale = function () {
    return this.mmBox ? this.mmBox.k : 1;
  };

  // Мир (клетки) -> пиксели миникарты
  Renderer.prototype.worldToMM = function (wx, wy) {
    var b = this.mmBox;
    if (!b) return { x: 0, y: 0 };
    return {
      x: b.ox + ((wx - wy) * 0.5 * this.cachePx + this.cacheOffset.x - b.x0) * b.k,
      y: b.oy + ((wx + wy) * 0.25 * this.cachePx + this.cacheOffset.y - b.y0) * b.k
    };
  };

  // Пиксель миникарты -> мир (клетки). Обратное к worldToMM.
  Renderer.prototype.pickMinimap = function (mx, my) {
    var w = this.world, b = this.mmBox;
    if (!w || !b) return null;
    var px = (mx - b.ox) / b.k + b.x0 - this.cacheOffset.x;   // пиксели кэша
    var py = (my - b.oy) / b.k + b.y0 - this.cacheOffset.y;
    // Обратная изометрия: кэш -> клетки мира. Это ровно обратное к
    // worldToMM, поэтому без сдвига на полклетки: попадание в клетку
    // и так определяется через Math.floor у вызывающего.
    var s = this.cachePx;
    return {
      x: (py * 2 + px) / s,
      y: (py * 2 - px) / s
    };
  };

  /* --- экспорт PNG ------------------------------------------------------ */

  // Рисует всю карту в отдельный холст. Кэш местности уже готов, остаётся
  // положить его и добавить объекты — с той же сортировкой, что и на экране.
  Renderer.prototype.exportPNG = function (scale) {
    var w = this.world;
    if (!w || !this.cache) return null;
    scale = scale || 1;
    var c = this.cache;
    var cv = document.createElement('canvas');
    cv.width = Math.round(c.width * scale);
    cv.height = Math.round(c.height * scale);
    var g = cv.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.fillStyle = rgb(PAL.deep);
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(c, 0, 0, cv.width, cv.height);

    // Объекты: масштаб пересчитываем на новое разрешение, чтобы пропорции
    // совпали с тем, что видно на экране.
    var px = this.cachePx * scale;
    var set = this.sprites;
    var base = set ? (px / ((set.ppu || 96) * (set.tileUnits || 1))) * (set.mul || 1.35) : 0;
    var self = this;
    var ox = this.cacheOffset.x * scale, oy = this.cacheOffset.y * scale;
    var oi = -1;                     // номер объекта в списке: по нему прореживаем россыпь

    // Тот же порядок глубины и те же пропуски слоёв, что и на экране:
    // экспорт обязан показывать ровно то, что видно на карте.
    this.eachSprite(function (o) {
      oi++;
      if (base <= 0) return;
      if (o.kind !== 'tree' && o.kind !== 'stone') return;
      if (o.kind === 'tree' && !self.showTrees) return;
      if (o.kind === 'stone') {
        if (o.mineable) { if (!self.showRocks) return; }
        else if (!self.showSmall || (oi % 3)) return;
      }
      var spr = global.Sprites.pick(set, o);
      if (!spr) return;
      var sc = base * (o.scale || 1);
      var dw = spr.sw * sc, dh = spr.sh * sc;
      if (dw < 2) return;
      var sx = (o.x - o.y) * 0.5 * px + ox;
      var sy = (o.x + o.y) * 0.25 * px + oy;
      // тряску дерева экспорт показывает так же, как экран: он снимается в тот
      // же момент времени и обязан показывать ровно то, что видно на карте
      var shake = self.treeShake(o, self.time);
      if (shake) {
        g.save();
        g.translate(sx, sy);
        g.rotate(shake * SHAKE_ANG);
        g.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh,
          -dw * spr.ax, -dh * spr.ay, dw, dh);
        g.restore();
        return;
      }
      g.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh,
        sx - dw * spr.ax, sy - dh * spr.ay, dw, dh);
    }, function (b) {
      var B = global.Buildings, bset = self.buildingSprites;
      if (!B || !bset) return;
      var spr = B.sprite(bset, b.variant, b.rot);
      if (!spr) return;
      var c = B.center(b), s = B.scaleAt(bset, px);
      var dw = spr.sw * s.x, dh = spr.sh * s.y;
      var cx = (c.x - c.y) * 0.5 * px + ox;
      var cy = (c.x + c.y) * 0.25 * px + oy;
      g.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh,
        cx - dw * spr.ax, cy - dh * spr.ay, dw, dh);
    }, function (v) {
      var V = global.Villagers, vset = self.villagerSprites;
      if (!V || !vset) return;
      var vspr = V.sprite(vset, v);
      if (!vspr) return;
      var vsc = V.scaleAt(vset, px);
      var vdw = vspr.sw * vsc, vdh = vspr.sh * vsc;
      if (vdw < 3) return;
      var vx = (v.x - v.y) * 0.5 * px + ox;
      var vy = (v.x + v.y) * 0.25 * px + oy;
      g.drawImage(vspr.img, vspr.sx, vspr.sy, vspr.sw, vspr.sh,
        vx - vdw * vspr.ax, vy - vdh * vspr.ay, vdw, vdh);
    });
    return cv;
  };

  /* --- основной кадр --------------------------------------------------- */

  Renderer.prototype.resize = function () {
    var c = this.canvas;
    var dpr = global.devicePixelRatio || 1;
    this.dpr = dpr;
    var w = c.clientWidth || 1, h = c.clientHeight || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.cssW = w;
    this.cssH = h;
    // Предел отдаления зависит от размера окна, а не только от карты:
    // при новом окне он пересчитывается. Если камера стояла на пределе
    // (а это штатный вид игры), она на нём и остаётся — иначе после
    // разворота окна остров оказался бы обрезан.
    if (this.world) {
      var wasLimit = Math.abs(this.cam.zoom - this.minZoom) < 1e-6;
      this.minZoom = this.zoomOutLimit();
      if (wasLimit || this.cam.zoom < this.minZoom) this.cam.zoom = this.minZoom;
      // Новое окно — новый предел и панорамы: узкое окно видит меньше, и
      // камера, стоявшая у края, обязана подтянуться к острову.
      this.clampCamera();
    }
  };

  Renderer.prototype.render = function (time) {
    this.time = time || 0;
    if (!this.world) return;
    var ctx = this.ctx, c = this.canvas;
    var dpr = this.dpr;
    var cw = c.width, ch = c.height;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = rgb(PAL.deep);
    ctx.fillRect(0, 0, cw, ch);

    // Экранные координаты: 0,0 — центр экрана; масштаб dpr применяем сразу,
    // чтобы все формулы были в клетках и пикселях на клетку.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(this.cssW / 2, this.cssH / 2);

    this.drawLand(ctx);
    this.drawSeaTexture(ctx);
    this.drawWaterShimmer(ctx);
    this.drawObjects(ctx);
    this.drawSelection(ctx);
    this.drawGhost(ctx);
    if (this.showGrid) this.drawGrid(ctx);
    this.drawHover(ctx);
    this.drawVignette(ctx);
  };

  Renderer.prototype.drawLand = function (ctx) {
    var w = this.world, c = this.cache;
    if (!c) return;

    /* Кэш нарисован в мировых координатах, поэтому блит — это одно
       преобразование «пиксель кэша -> пиксель канваса», а не вычисление
       прямоугольников назначения руками. На ручных прямоугольниках уже
       дважды терялось то смещение камеры, то знак, и местность переставала
       двигаться вместе с объектами.

       midX, midY — центр карты в пикселях кэша: начало координат кэша это
       левый угол ромба, а не его середина. */
    var z = this.cam.zoom;
    var k = z / this.cachePx;

    // Центр карты в пикселях кэша: кэш нарисован так, что верхний угол ромба
    // лежит в (offX, 0), значит центр — ровно на половине высоты.
    var midX = this.cacheOffset.x;
    var midY = this.cacheOffset.y + c.height / 2;

    /* Преобразование «пиксель кэша -> пиксель канваса»:

           canvas = cssW/2 + (cx − midX) · k + camP

       camP — экранная позиция мирового нуля, то есть ровно sx(0, 0), sy(0, 0).
       В пикселях кэша это camP / k, и именно на столько кэш сдвинут
       относительно центра канваса. */
    var camPx = this.sx(0, 0);
    var camPy = this.sy(0, 0);

    /* Единое преобразование «пиксель кэша -> пиксель канваса».

       Мировой ноль лежит в кэше в точке (midX, 0), а на канвасе — в
       css/2 + camP. Отсюда всё преобразование:

           canvas = css/2 + (cache − (midX, 0)) · k + camP

       camP = (sx(0,0), sy(0,0)) — экранная позиция мирового нуля. */
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.cssW / 2 + camPx, this.cssH / 2 + camPy);
    ctx.scale(k, k);
    ctx.translate(-midX, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(c, 0, 0);
    ctx.restore();

    // След блита: по нему проверяется, что карта вписана и отцентрована.
    // Формулы проекции для этого не годятся — они не знают, что именно
    // из кэша попало на канвас.
    this.lastBlit = {
      k: k, mid: [midX, midY], camPx: [camPx, camPy],
      src: [midX - this.cssW / 2 / k, midY - this.cssH / 2 / k,
        this.cssW / k, this.cssH / k]
    };
  };

  /* --- море и волны ---------------------------------------------------- *
   *
   * Вода в кэше неподвижна и конечна: за краем полотна её нет. Но море не
   * должно кончаться вместе с картой — иначе на общем плане видно не остров
   * в море, а кусок ландшафта в пустоте. Поэтому поверх кадра кладётся море
   * целиком: цвет глубины и волны рисуются по всей видимой области, а суша
   * из них вырезается (seaClip). Так море выглядит бесконечным, хотя не
   * сгенерировано ни одной лишней клетки: за картой оно ровно такое же,
   * каким стало у её края, — а у края оно уже глубина (см. addSea).
   * -------------------------------------------------------------------- */

  /* Текстура воды по всему морю.

     В кэше вода — один градиент глубины, без фактуры, а за краем карты её и
     вовсе нет: там ровная заливка цветом глубины. На такой воде пена читается
     предметами на столе. Поэтому поверх земли кладётся мягкая текстура воды из
     assets/textures/water.png — та же самая, что задаёт рябь на воде в кэше,
     — и заливка идёт по всему морю сразу: и внутри карты, и за её краем.
     Обрезка та же, что у волн (seaClip): суша из текстуры вырезана. */
  Renderer.prototype.drawSeaTexture = function (ctx) {
    var w = this.world, c = this.cache;
    if (!w || !c) return;
    var pat = this.ripplePattern;
    if (!pat) return;
    var px = this.cachePx;
    var k = this.cam.zoom / px;
    var offX = this.cacheOffset.x;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.cssW / 2 + this.sx(0, 0), this.cssH / 2 + this.sy(0, 0));
    ctx.scale(k, k);
    ctx.translate(-offX, 0);
    if (this.seaClip) ctx.clip(this.seaClip, 'evenodd');
    // Заливка — по габариту видимой области в клетках, переведённому в
    // пиксели кэша. Прямоугольник по размеру экрана тут не годится: видимая
    // область в кэше — ромб, и он выходит за него углами.
    var box = this.viewTiles(2);
    var x0 = (box.x0 - box.y1) * px * 0.5 + offX, x1 = (box.x1 - box.y0) * px * 0.5 + offX;
    var y0 = (box.x0 + box.y0) * px * 0.25, y1 = (box.x1 + box.y1) * px * 0.25;
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = pat;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  };

  /* Мельче этого гребень на экране не рисуется: на общем плане он всё равно
     вырождается в пару пикселей, а спрайтов на кадре — сотни, и каждый стоит
     времени. Отбраковка идёт по размеру самого гребня, а не по зуму, поэтому
     при отдалении волны не переставляются: пропадают только самые мелкие. */
  var WAVE_MIN_PX = 9;

  /* Море: заливка всего кадра узором волн под обрезкой «всё, кроме суши».

     Волны — те же низкополигональные модели, что деревья и ратуша: их
     отрисовал Blender (папка waves/), `tools/pack_waves.py` сложил в атлас,
     а `js/waves.js` раскладывает по морю. Здесь только рисование: спрайт
     ставится точкой опоры в мировую точку гребня, размер берётся из той же
     формулы, что у ратуши (юнит модели = клетка карты), поэтому гребень
     масштабируется вместе с картой.

     Почему спрайты, а не узор-текстура, как было раньше. Узор читался
     полосами, идущими в ряд: он periodic по построению, и любая попытка
     сделать его «нестроевым» упиралась в то, что повтор обязан сойтись сам
     с собой. Гребень — отдельный объект: у него своё место, своя форма, свой
     размер и своя прозрачность, и повторов в кадре не видно.

     Порядок здесь важен. Вода из кэша уже лежит под нами (drawLand), а
     волны кладутся поверх неё и поверх пустоты за краем карты — так море
     и получается сплошным. Обрезка берётся из кэша (seaClip) и задаётся в
     экранных пикселях: гребень не должен вылезать на песок. */
  Renderer.prototype.drawWaterShimmer = function (ctx) {
    var w = this.world, c = this.cache;
    if (!w || !c || !this.seaClip) return;
    var set = this.waveSprites;
    if (!set || (!set.along.length && !set.across.length)) return;

    var z = this.cam.zoom, px = this.cachePx;
    var k = z / px;
    var camPx = this.sx(0, 0), camPy = this.sy(0, 0);
    var midX = this.cacheOffset.x;

    ctx.save();
    // Ровно то же преобразование, что в drawLand: обрезка построена в
    // координатах кэша. Любое расхождение здесь сдвигает её, и волны
    // начинают лезть на траву.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.cssW / 2 + camPx, this.cssH / 2 + camPy);
    ctx.scale(k, k);
    ctx.translate(-midX, 0);
    ctx.clip(this.seaClip, 'evenodd');

    // Дальше — экранные пиксели: спрайты испечены в них, и растить их
    // вместе с кэшем незачем. Обрезка при смене преобразования не теряется:
    // она уже лежит в координатах холста, и снимать её нельзя — иначе пена
    // выползает на песок.
    var sc = global.Waves.scaleAt(set, z);
    var box = this.viewTiles(2);
    var list = global.Waves.crests(set, box, this.time);
    var hw = this.cssW / 2 + 64, hh = this.cssH / 2 + 64;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.cssW / 2, this.cssH / 2);
    for (var i = 0; i < list.length; i++) {
      var cr = list[i];
      // Клетку суши пропускаем сразу: обрезка бы её и так срезала, но
      // рисовать сотни спрайтов ради того, чтобы их вырезали, незачем.
      var tx = Math.floor(cr.x), ty = Math.floor(cr.y);
      if (tx >= 0 && ty >= 0 && tx < w.width && ty < w.height &&
          w.isLand[ty * w.width + tx]) continue;
      var sx = this.sx(cr.x, cr.y), sy = this.sy(cr.x, cr.y) + cr.bob * z * 0.25;
      var spr = cr.spr;
      var dw = spr.sw * sc.x * cr.scale * cr.kx;
      var dh = spr.sh * sc.y * cr.scale * cr.ky;
      if (dw < WAVE_MIN_PX) continue;
      if (sx + dw < -hw || sx - dw > hw || sy + dh < -hh || sy - dh > hh) continue;
      ctx.globalAlpha = cr.alpha;
      ctx.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh,
        sx - dw * spr.ax, sy - dh * spr.ay, dw, dh);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  /* --- объекты --------------------------------------------------------- */

  /* Тряска дерева: -1..1, ноль — дерево стоит.

     Флаг shake ставит житель ударом топора (js/villager.js: strike), а живёт
     затухание ЗДЕСЬ, потому что только здесь есть время кадра. Момент удара
     запоминается на самом объекте (o._shakeT): без него синус считался бы от
     начала времён, и дерево качалось бы вразнобой само с собой.

     Возврат к нулю обязателен: пока o.shake не сброшен, кадр рисуется через
     save/rotate/restore, а это дороже обычного drawImage — дерево, оттрясшееся
     до 2%, снова становится обычным спрайтом. */
  Renderer.prototype.treeShake = function (o, time) {
    if (!o || o.kind !== 'tree' || !o.shake) return 0;
    if (o._shakeT === undefined) o._shakeT = time;
    var age = time - o._shakeT;
    var amp = Math.exp(-age * SHAKE_DECAY);
    if (amp < SHAKE_FLOOR) {
      o.shake = 0;
      o._shakeT = undefined;
      return 0;
    }
    return Math.sin(age * SHAKE_HZ * Math.PI * 2) * amp;
  };

  /* Обход всех спрайтов в порядке глубины: объекты мира, постройки и жители
     в одном потоке. Нужен затем, что порядок отрисовки обязан совпадать у
     экрана и у экспорта PNG: две отдельные реализации этого порядка уже
     расходились (в экспорт постройки просто не попадали, а без них ратуша
     «исчезала» ровно на выгрузке). */
  Renderer.prototype.eachSprite = function (onObject, onBuilding, onWalker) {
    var w = this.world;
    if (!w) return;
    var objs = w.objects;
    var blds = this.showBuildings ? this.buildingOrder() : [];
    var vils = (onWalker && this.showVillagers) ? this.villagerOrder() : [];
    var i = 0, j = 0, k = 0, o, b, v;
    while (i < objs.length || j < blds.length || k < vils.length) {
      o = i < objs.length ? objs[i] : null;
      b = j < blds.length ? blds[j] : null;
      v = k < vils.length ? vils[k] : null;
      /* Опорная точка объекта — его собственная координата, у постройки —
         центр пятна, у жителя — он сам: дерево перед ратушей рисуется поверх
         неё, а дерево за ней — под ней. При равном ключе вперёд идут те, кто
         «стоит», а не ходит: трава и куст в клетке жителя ложатся ему под
         ноги, а не поверх человека. */
      var ko = o ? o.x + o.y : Infinity;
      var kb = b ? b.key : Infinity;
      var kv = v ? v.key : Infinity;
      if (kb <= ko && kb <= kv) { onBuilding(b.b); j++; }
      else if (kv <= ko) { onWalker(v.v); k++; }
      else { onObject(o); i++; }
    }
  };

  Renderer.prototype.drawObjects = function (ctx) {
    var w = this.world, set = this.sprites;
    if (!w) return;
    var z = this.cam.zoom;
    var box = this.viewTiles(2);
    var self = this;

    // Размер спрайта на единицу масштаба объекта. Смысл перевода единиц
    // описан в sprites.js: кадр атласа измеряется в юнитах модели, а не
    // в клетках карты, поэтому знаменатель — ppu × tileUnits.
    var base = set ? (z / ((set.ppu || 96) * (set.tileUnits || 1))) * (set.mul || 1.35) : 0;
    var sway = z >= 26;

    this.eachSprite(function (o) {
      if (!set) return;
      if (o.x < box.x0 || o.x > box.x1 || o.y < box.y0 || o.y > box.y1) return;

      if (o.kind === 'tree') { if (!self.showTrees) return; }
      else if (o.kind === 'stone') {
        if (o.mineable) { if (!self.showRocks) return; }
        else if (!self.showSmall) return;
      } else if (!self.showSmall) return;

      var spr = o._spr || (o._spr = global.Sprites.pick(set, o));
      if (!spr) return;

      var sc = base * (o.scale || 1);
      var dw = spr.sw * sc, dh = spr.sh * sc;
      if (dw < 2.5) return;                      // мельче — всё равно не видно
      var px = self.sx(o.x, o.y);
      var py = self.sy(o.x, o.y);
      if (sway && o.kind === 'tree') px += Math.sin(self.time * 0.9 + (o.phase || 0)) * z * 0.018;

      var shake = self.treeShake(o, self.time);
      if (shake) {
        // вращаем вокруг КОМЛЯ (px, py — точка опоры спрайта), а не вокруг
        // середины кадра: дерево качается от земли, как живое
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(shake * SHAKE_ANG);
        ctx.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh,
          -dw * spr.ax, -dh * spr.ay, dw, dh);
        ctx.restore();
        return;
      }
      ctx.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh,
        px - dw * spr.ax, py - dh * spr.ay, dw, dh);
    }, function (b) {
      self.drawBuilding(ctx, b, z, 1);
    }, function (v) {
      if (v.x < box.x0 || v.x > box.x1 || v.y < box.y0 || v.y > box.y1) return;
      var vb = self.villagerBox(v, z);
      if (!vb || vb.dw < 3) return;               // мельче — не видно, кто это
      ctx.drawImage(vb.spr.img, vb.spr.sx, vb.spr.sy, vb.spr.sw, vb.spr.sh,
        vb.dx, vb.dy, vb.dw, vb.dh);
    });
  };

  // Одна постройка. alpha < 1 — призрак под курсором.
  Renderer.prototype.drawBuilding = function (ctx, b, z, alpha) {
    var box = this.buildingBox(b, z);
    if (!box) return null;
    var old = ctx.globalAlpha;
    if (alpha !== undefined && alpha < 1) ctx.globalAlpha = old * alpha;
    ctx.drawImage(box.spr.img, box.spr.sx, box.spr.sy, box.spr.sw, box.spr.sh,
      box.dx, box.dy, box.dw, box.dh);
    ctx.globalAlpha = old;
    return box;
  };



  /* --- сетка и подсветка ----------------------------------------------- */

  /* Пятно застройки: клетки ромбами плюс внешний контур параллелограммом.
     Ромбы показывают, какие именно клетки займёт здание, контур — его
     габарит целиком: по нему видно, ровно ли пятно садится на сетку. */
  Renderer.prototype.drawFootprint = function (ctx, b, style) {
    var B = global.Buildings;
    if (!B) return;
    var z = this.cam.zoom;
    var cells = B.cells(b);
    var hw = z * 0.5, hh = z * 0.25;
    var i, c, cx, cy;

    ctx.save();
    ctx.beginPath();
    for (i = 0; i < cells.length; i++) {
      c = cells[i];
      cx = this.sx(c.x + 0.5, c.y + 0.5);
      cy = this.sy(c.x + 0.5, c.y + 0.5);
      ctx.moveTo(cx, cy - hh);
      ctx.lineTo(cx + hw, cy);
      ctx.lineTo(cx, cy + hh);
      ctx.lineTo(cx - hw, cy);
      ctx.closePath();
    }
    if (style.fill) { ctx.fillStyle = style.fill; ctx.fill(); }
    if (style.stroke) {
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = style.lineWidth || Math.max(1, z / 40);
      ctx.stroke();
    }

    var bb = B.bounds(b);
    var corners = [[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x1, bb.y1], [bb.x0, bb.y1]];
    ctx.beginPath();
    for (i = 0; i < 4; i++) {
      cx = this.sx(corners[i][0], corners[i][1]);
      cy = this.sy(corners[i][0], corners[i][1]);
      if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
    }
    ctx.closePath();
    ctx.strokeStyle = style.edge || style.stroke || 'rgba(255,255,255,0.8)';
    ctx.lineWidth = style.edgeWidth || Math.max(1.4, z / 22);
    ctx.stroke();
    ctx.restore();
  };

  // Призрак размещения: пятно под курсором и полупрозрачный спрайт.
  Renderer.prototype.drawGhost = function (ctx) {
    var g = this.ghost;
    if (!g || !g.b || !this.world) return;
    var B = global.Buildings;
    var fp = B.footprint(g.b.rot);

    this.drawFootprint(ctx, g.b, {
      fill: g.ok ? 'rgba(126,232,164,0.26)' : 'rgba(240,104,86,0.30)',
      stroke: g.ok ? 'rgba(206,255,224,0.55)' : 'rgba(255,190,180,0.55)',
      edge: g.ok ? 'rgba(232,255,240,0.95)' : 'rgba(255,150,136,0.95)'
    });

    // Клетки, которые придётся расчистить, подкрашиваем поверх пятна:
    // видно и куда встанет дом, и что под ним исчезнет. Двор (клетка вокруг)
    // подсвечивается слабее — он расчищается заодно, но это не пятно.
    var z = this.cam.zoom, hw = z * 0.5, hh = z * 0.25;
    var cellsWith = function (list, fill) {
      if (!list || !list.length) return;
      ctx.save();
      ctx.beginPath();
      for (var i = 0; i < list.length; i++) {
        var o = list[i];
        var cx = this.sx(Math.floor(o.x) + 0.5, Math.floor(o.y) + 0.5);
        var cy = this.sy(Math.floor(o.x) + 0.5, Math.floor(o.y) + 0.5);
        ctx.moveTo(cx, cy - hh);
        ctx.lineTo(cx + hw, cy);
        ctx.lineTo(cx, cy + hh);
        ctx.lineTo(cx - hw, cy);
        ctx.closePath();
      }
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.restore();
    }.bind(this);
    cellsWith(g.yard, 'rgba(255,206,110,0.16)');
    cellsWith(g.blocked, 'rgba(255,206,110,0.35)');

    this.drawBuilding(ctx, g.b, this.cam.zoom, 0.62);

    // Подпись «4 x 3» у пятна — чтобы размер был виден без панели.
    ctx.save();
    ctx.font = '600 12px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    var tx = this.sx(g.b.x + fp.w / 2, g.b.y + fp.h / 2);
    var ty = this.sy(g.b.x, g.b.y) - 10;
    var label = fp.w + ' × ' + fp.h;
    ctx.fillText(label, tx + 1, ty + 1);
    ctx.fillStyle = g.ok ? '#eafff2' : '#ffd9d2';
    ctx.fillText(label, tx, ty);
    ctx.restore();
  };

  // Пятно выбранной постройки: видно, что именно удалится или сдвинется.
  Renderer.prototype.drawSelection = function (ctx) {
    var b = this.selected;
    if (!b || !global.Buildings) return;
    this.drawFootprint(ctx, b, {
      stroke: 'rgba(255,255,255,0.75)',
      edge: 'rgba(255,236,170,0.95)',
      edgeWidth: Math.max(2, this.cam.zoom / 20)
    });
  };

  Renderer.prototype.drawGrid = function (ctx) {
    var z = this.cam.zoom;
    var step = z >= 34 ? 1 : (z >= 18 ? 4 : 8);
    var box = this.viewTiles(2);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    var x, y;
    for (y = Math.floor(box.y0); y <= box.y1; y++) {
      for (x = Math.floor(box.x0 / step) * step; x <= box.x1; x += step) {
        ctx.moveTo(this.sx(x, y), this.sy(x, y));
        ctx.lineTo(this.sx(x + step, y), this.sy(x + step, y));
      }
    }
    for (x = Math.floor(box.x0); x <= box.x1; x++) {
      for (y = Math.floor(box.y0 / step) * step; y <= box.y1; y += step) {
        ctx.moveTo(this.sx(x, y), this.sy(x, y));
        ctx.lineTo(this.sx(x, y + step), this.sy(x, y + step));
      }
    }
    ctx.stroke();
    ctx.restore();
  };

  // Постройка, накрывающая клетку, или null. Нужна и подсветке клетки,
  // и выбору постройки кликом.
  Renderer.prototype.buildingAt = function (x, y) {
    var B = global.Buildings;
    if (!B) return null;
    for (var i = 0; i < this.buildings.length; i++) {
      var bb = B.bounds(this.buildings[i]);
      if (x >= bb.x0 && x < bb.x1 && y >= bb.y0 && y < bb.y1) return this.buildings[i];
    }
    return null;
  };

  Renderer.prototype.drawHover = function (ctx) {
    // При размещении клетку не подсвечиваем: там уже стоит пятно застройки,
    // и две подсветки под одним курсором читаются как ошибка.
    if (!this.hover || this.ghost) return;
    var x = this.hover.x, y = this.hover.y;
    if (x < 0 || y < 0 || x >= this.world.width || y >= this.world.height) return;
    // Под стоящей ратушей рамку тоже не рисуем: она ложится поверх крыши
    // и читается как артефакт рендера, а не как курсор. Само здание и так
    // показывает, где мышь.
    if (this.buildingAt(x, y)) return;
    var z = this.cam.zoom;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = Math.max(1.2, z / 26);
    ctx.beginPath();
    var cx = this.sx(x + 0.5, y + 0.5), cy = this.sy(x + 0.5, y + 0.5);
    var hw2 = z * 0.5, hh2 = z * 0.25;
    ctx.moveTo(cx, cy - hh2);
    ctx.lineTo(cx + hw2, cy);
    ctx.lineTo(cx, cy + hh2);
    ctx.lineTo(cx - hw2, cy);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  };

  Renderer.prototype.drawVignette = function (ctx) {
    // Мягкое затемнение по краям: центр кадра читается как «сцена»,
    // а не как бесконечное поле.
    var w = this.cssW, h = this.cssH;
    if (!this._vig || this._vigW !== w || this._vigH !== h) {
      var g = ctx.createRadialGradient(0, 0, Math.min(w, h) * 0.35, 0, 0, Math.max(w, h) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(4,16,24,0.42)');
      this._vig = g; this._vigW = w; this._vigH = h;
    }
    ctx.save();
    ctx.fillStyle = this._vig;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  };

  /* --- видимая область в клетках --------------------------------------- */

  Renderer.prototype.viewTiles = function (pad) {
    pad = pad || 0;
    var hw = this.cssW / 2, hh = this.cssH / 2;
    // Обратная изометрия: четыре угла экрана -> мир, берём охватывающий бокс.
    var pts = [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]];
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (var i = 0; i < 4; i++) {
      var p = this.screenToWorld(pts[i][0], pts[i][1]);
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    return {
      x0: Math.floor(x0) - pad, x1: Math.ceil(x1) + pad,
      y0: Math.floor(y0) - pad, y1: Math.ceil(y1) + pad
    };
  };

  /* --- камера ---------------------------------------------------------- */

  /* Максимальное отдаление: остров целиком и ещё по половине его диаметра
     моря с каждой стороны. Меряется не по карте, а по габариту суши:
     карта — это остров плюс полоса моря, и по ней кадр вышел бы теснее,
     чем нужно. Видимая область — габарит острова, растянутый вдвое; её
     экранная ширина в изометрии (bw + bh)·z/2, высота вдвое меньше. */
  Renderer.prototype.zoomOutLimit = function () {
    var v = this.viewBox();
    if (!v) return MIN_ZOOM;
    var span = (v.x1 - v.x0) + (v.y1 - v.y0);
    var z = Math.min(this.cssW / (span * 0.5), this.cssH / (span * 0.25));
    return clamp(z, MIN_ZOOM, MAX_ZOOM);
  };

  /* Предел панорамы: докуда можно увести камеру, чтобы остров не потерялся.

     В кадре всегда целиком лежит прямоугольник в клетках со стороной 2h, где
     h = min(cssW/(2·z), cssH/z): его проекция — ровно 2h·z на h·z пикселей,
     то есть он вписан в экран. Значит камера стоит в законном месте, если
     этот прямоугольник задевает хоть одну клетку суши: её центр попадает на
     экран, а вместе с ним и остров.

     Отсюда предел: центр камеры не дальше h от центра какой-нибудь клетки
     суши. Это не прямоугольник вокруг острова, а сам остров с полосой в h
     клеток — у берега предел идёт по берегу, и у неровного острова камера не
     встаёт в пустую воду у угла габарита.

     Зажим — проекция на ближайший такой квадрат: если камера уже внутри,
     ничего не меняется, а если её увели дальше, она возвращается на границу
     по кратчайшему пути. */
  Renderer.prototype.buildLandCells = function () {
    var w = this.world;
    if (!w) return null;
    var W = w.width, H = w.height, isLand = w.isLand;
    var out = [], i;
    for (i = 0; i < W * H; i++) if (isLand[i]) out.push(i % W, (i / W) | 0);
    return Int32Array.from(out);
  };

  Renderer.prototype.clampCamera = function () {
    var w = this.world, cells = this.landCells;
    if (!w) return;
    var h = Math.min(this.cssW / (2 * this.cam.zoom), this.cssH / this.cam.zoom);
    if (!cells || !cells.length) {
      // Суши нет вовсе. Такого не бывает — генератор всегда делает остров, —
      // но и на пустой воде уезжать в бесконечное море незачем: держим
      // камеру у карты.
      this.cam.x = clamp(this.cam.x, -h, w.width + h);
      this.cam.y = clamp(this.cam.y, -h, w.height + h);
      return;
    }
    var cx = this.cam.x, cy = this.cam.y;
    var bx = cx, by = cy, best = Infinity;
    for (var i = 0; i < cells.length; i += 2) {
      // Опорная точка — центр клетки: он суша, а не угол между клетками.
      var ax = cells[i] + 0.5, ay = cells[i + 1] + 0.5;
      var dx = Math.abs(cx - ax) - h, dy = Math.abs(cy - ay) - h;
      if (dx < 0) dx = 0;
      if (dy < 0) dy = 0;
      var d = dx * dx + dy * dy;
      if (d < best) {
        best = d; bx = ax; by = ay;
        if (d === 0) return;          // камера и так в законном месте
      }
    }
    this.cam.x = clamp(cx, bx - h, bx + h);
    this.cam.y = clamp(cy, by - h, by + h);
  };

  Renderer.prototype.fitIsland = function () {
    var w = this.world;
    if (!w) return;
    var v = this.viewBox();
    this.minZoom = this.zoomOutLimit();
    this.cam.zoom = this.minZoom;
    this.cam.x = (v.x0 + v.x1) / 2;
    this.cam.y = (v.y0 + v.y1) / 2;
    this.clampCamera();
  };

  Renderer.prototype.fitToWorld = function () {
    var w = this.world;
    if (!w) return;
    // Изометрия: карта в экранных координатах шире, чем в клетках, ровно
    // в (W + H) / 2 раз по горизонтали и (W + H) / 4 по вертикали.
    var mapW = (w.width + w.height) * 0.5;
    var mapH = (w.width + w.height) * 0.25;
    var z = Math.min((this.cssW - 40) / mapW, (this.cssH - 40) / mapH);
    this.cam.zoom = clamp(z, this.minZoom, MAX_ZOOM);
    this.cam.x = w.width / 2;
    this.cam.y = w.height / 2;
    this.clampCamera();
  };

  Renderer.prototype.centerOn = function (x, y) {
    this.cam.x = x;
    this.cam.y = y;
    this.clampCamera();
  };

  Renderer.prototype.zoomAt = function (vx, vy, factor) {
    var before = this.screenToWorld(vx, vy);
    this.cam.zoom = clamp(this.cam.zoom * factor, this.minZoom, this.maxZoom);
    var after = this.screenToWorld(vx, vy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clampCamera();
  };

  // Панорама по вектору экрана: в изометрии «тянуть влево» и «ехать влево»
  // это разные векторы в мире, поэтому переводим через обратную проекцию.
  Renderer.prototype.panScreen = function (vx, vy) {
    var before = this.screenToWorld(0, 0);
    var after = this.screenToWorld(vx, vy);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.clampCamera();
  };

  global.Render = {
    Renderer: Renderer,
    PAL: PAL,
    TEX_REPEAT: TEX_REPEAT
  };
})(typeof window !== 'undefined' ? window : globalThis);
