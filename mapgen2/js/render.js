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

  /* Мигание правимой постройки (js/play.js: режим правки).

     Пока постройку правят, она «дышит» прозрачностью: на карте три дома, и
     надо видеть, какой именно правится. Синус, а не ступенька: ступенчатое
     мигание читается как сломанный кадр, а не как признак. Размах 0.55..1 —
     ниже постройка сливается с травой, а «в ноль» её гасить нельзя, здание
     стоит на карте и должно оставаться видно. При системной настройке
     «уменьшить движение» колебаний нет вовсе: ровно 0.72 — приглушено, но
     неподвижно. */
  var BLINK_MIN = 0.55;
  var BLINK_MAX = 1;
  var BLINK_PERIOD = 0.9;  // секунды: один вдох-выдох
  var BLINK_STILL = 0.72;  // прозрачность без колебаний (reduce motion)

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

  /* --- земля: участки и песок (BIG-PLAN, P2) --------------------------- *
   *
   * Участок — плоская трава вокруг постройки: всё её пятно (Buildings.bounds)
   * без полосы PLOT_INSET у кромки. Полоса нужна не для красоты: кромка
   * участка, совпавшая с кромкой пятна, читается как граница клетки, а пятно
   * у нас — расчётная величина, а не то, что видит игрок. Внутри участка нет
   * ни одного ВЫСОКОГО спрайта: трава и кусты под постройкой сминаются
   * (js/buildings.js: settle), а на кадре прячутся маской (coverMask). Зато
   * по пятну густо стоят тёмные кустики травы; участок читается дерном,
   * а не пустой рамкой. Дерн печётся в свой холст
   * (plotLayer), поэтому виден на любом зуме и стоит один drawImage.
   *
   * Пятно берётся у движка (Buildings.bounds), а не у спрайта: у военного
   * лагеря модель 2 x 2 стоит по центру площадки 5 x 5, и участок обязан
   * занимать все 5 x 5 клеток. Поворот тоже уже в bounds: 4 x 3 и 3 x 4
   * дают разные прямоугольники, 5 x 5 от поворота не меняется.
   *
   * Песок. Ширина пляжа — не от размера карты, а одна на все карты
   * (BEACH_W). Раньше она считалась как max(0.9, W/64), и на 128-й карте
   * пляж выходил вдвое шире, чем на 64-й. Классы клеток в worldgen пока
   * живут по своему правилу (его ведёт другой агент), поэтому рендер считает
   * песок сам, по distWater, а не по w.tile: иначе вид и подсказка клетки
   * разъехались бы на больших картах ещё сильнее.
   *
   * Кромка песка — не штрих по ромбам (он и давал коричневую обводку и швы),
   * а дизеринг: сплошная заливка до первой клетки у воды и мелкие ромбы
   * песка в следующих рядах, по хешу клетки. Мокрый песок — полупрозрачная
   * тёмная полоса у самой воды, тоже без штриха.
   * -------------------------------------------------------------------- */
  var PLOT_INSET = 0.12;       // клетки: полоса пятна, не занятая участком
  /* Дерн участка — не заливка, а те же спрайты травы, что и на карте, только
     гуще и мельче. Край не обрезается прямоугольником: плотность падает по
     вероятности, а отдельные кустики выходят за пятно. */
  var PLOT_EDGE = 0.50;        // клетки: на сколько трава выходит за пятно
  var PLOT_MARGIN = 0.85;      // клетки: запас холста под высокие спрайты
  /* Печём слой в отдельный холст с запасом к максимальному зуму игры
     (MAX_ZOOM = 120): 128 px на клетку — это чуть больше, чем нужно, зато
     спрайт травы остаётся резким и на самом близком плане. */
  var PLOT_BAKE = 128;         // px на клетку в запечённом слое участка
  /* Плитка газона участка: art/textures/plot_grass. Период — две клетки, как
     у текстуры земли; на запечённом слое это 256 px. */
  var PLOT_TEX_CELLS = 2;
  var PLOT_TEX_EDGE = 0.28;    // клетки: насколько газон выходит за пятно
  var PLOT_TEX_FADE = 22;      // px запечённого слоя: мягкая кромка газона
  var BEACH_W = 1.3;           // клетки: ширина пляжа, одна на все карты
  var BEACH_CORE = 1.2;        // сплошная полоса: ряд 1.0 и запас на сглаживание
  var BEACH_FRINGE = 3.1;      // докуда редкие зёрна перехода (не ширина пляжа)
  var WET_W = 0.42;            // клетки: ширина полосы мокрого песка
  var WET_ALPHA = 0.18;        // прозрачность мокрого песка (0..1)

  function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  // Детерминированный хеш клетки: 0..1. Нужен дизерингу песка и пучкам
  // травы: «случайность» обязана быть одинаковой на каждом кадре и после
  // перегенерации кэша, иначе кромка «кипит» при движении камеры.
  function hash2(x, y, salt) {
    var h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) +
      Math.imul(salt | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  /* ------------------------------- рендер ------------------------------- */

  /* Телефон/планшет. Нужен только для предела плотности пикселей: DPR 3 —
     это 9 пикселей полотна на один CSS-пиксель, и заполнение (земля, море,
     спрайты) дорожает ровно во столько же раз. (pointer: coarse) — тот же
     признак, которым пользуется игра для «подтверждать кнопкой». */
  function coarsePointer() {
    try {
      return !!(global.matchMedia && global.matchMedia('(pointer: coarse)').matches);
    } catch (e) { return false; }
  }

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = null;
    this.sprites = null;
    this.buildings = [];                   // поставленные постройки: ратуша, дом, лагерь
    this.buildingSets = {};                // атласы построек по типам (js/buildings.js)
    this.ruinSets = {};                    // атласы завалов по типам (assets/ruins)
    this.villagers = [];                   // жители: у них своё поведение (js/villager.js)
    this.villagerSprites = null;           // атлас жителя
    this.knightSprites = null;             // атлас рыцаря (armored_villager)
    this.ghost = null;                     // призрак размещения: {b, ok, reason, blocked}
    this.lineGhost = null;                 // предпросмотр всей серии: {items, rot, type, ok}
    this.editing = null;                   // что правим: постройка или null (ведёт игра)
    this.textures = {};
    this.dpr = 1;
    /* Потолок плотности пикселей. На телефоне 2: текст и кнопки — DOM и
       остаются резкими, а мир мягче всего на 1/3, зато пикселей полотна
       в 2.25 раза меньше, чем при DPR 3. В профиле экономии (HUD) — 1.5. */
    this.dprCap = coarsePointer() ? 2 : 3;
    /* quality < 1 — реже волны; 1 — полный декор. Мир от числа не зависит. */
    this.quality = 1;

    this.cam = { x: 0, y: 0, zoom: 40 };   // x, y — в клетках, zoom — px на клетку
    this.minZoom = MIN_ZOOM;               // дальше этого не отдаляемся (см. fitIsland)
    this.maxZoom = MAX_ZOOM;
    this.showGrid = false;
    this.showTrees = true;
    this.showRocks = true;
    this.showSmall = true;
    this.showBuildings = true;
    this.showVillagers = true;
    this.showPlots = true;                 // слой участков (drawPlots)

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
   * Постройка — билборд, как дерево, но в отличие от дерева она стоит не в
   * точке, а на пятне (у ратуши 4 x 3), и порядок глубины у неё считается по
   * центру пятна. Список объектов мира уже отсортирован по x + y на
   * генерации, поэтому постройки в него не вклеиваются, а вливаются слиянием
   * двух отсортированных списков: пересортировывать тысячи деревьев на каждое
   * перемещение призрака незачем.
   *
   * Атласов несколько — по одному на тип (js/buildings.js: TYPES). Ложатся
   * они сюда: setBuildingSet('house', set). Какой атлас рисовать, решает сам
   * тип постройки, а не порядок загрузки: атласа типа нет — постройка просто
   * не рисуется, и партия от этого не падает.
   * -------------------------------------------------------------------- */

  Renderer.prototype.setBuildingSet = function (type, set) {
    var id = type || global.Buildings.DEFAULT_TYPE;
    if (set) this.buildingSets[id] = set;
    else delete this.buildingSets[id];
  };

  Renderer.prototype.spritesFor = function (type, ruined) {
    var B = global.Buildings;
    var id = (B && B.typeOf) ? B.typeOf({ type: type }) : (type || 'townhall');
    if (ruined && this.ruinSets[id]) return this.ruinSets[id];
    return this.buildingSets[id] || null;
  };

  /* Атлас завалов: один PNG, по типу — свой набор кадров (ppu/mul/anchor/
     ground у каждого типа свои). Собираем по типу тем же Buildings.build,
     что и целые постройки, чтобы точка опоры, контур и масштаб считались
     одним кодом, а не второй копией. */
  Renderer.prototype.setRuins = function (img, meta) {
    var B = global.Buildings;
    if (!B || !img || !meta || !meta.types) return;
    Object.keys(meta.types).forEach(function (type) {
      var t = meta.types[type], frames = {}, name;
      for (name in (meta.frames || {})) {
        var f = meta.frames[name];
        if (!f || f.variant !== type) continue;
        frames[name] = f;
      }
      var sub = {
        ppu: t.ppu || meta.ppu, az_deg: meta.az_deg, el_deg: meta.el_deg,
        mul: t.mul === undefined ? meta.mul : t.mul, cell: meta.cell,
        variants: {}, frames: frames
      };
      sub.variants[type] = t.footprint;
      B.build('ruins:' + type, img, sub);
      this.ruinSets[type] = B.sets['ruins:' + type] || null;
    }, this);
  };

  /* opts.minimap === false — не пересобирать обзор.

     Сетевой снимок приходит 10–12 раз в секунду. Пересборка обзора на каждый
     снимок — это новый холст и проход по тысячам деревьев; хуже того, старые
     холсты не успевают собираться сборщиком мусора, и браузер начинает
     выбрасывать крупный кэш местности. Поэтому снимок просит только сбросить
     порядок, а полную пересборку — лишь когда изменился состав или место
     построек (serialize.js). */
  Renderer.prototype.setBuildings = function (list, opts) {
    this.buildings = list || [];
    this.invalidateOrder();
    if (this.cache && (!opts || opts.minimap !== false)) this.buildMinimap();
  };

  /* Сбросить только порядок отрисовки — без миникарты.

     Разница не в экономии: у постройки порядок глубины считается по центру
     пятна, и ПОКА ЕЁ ВЕДУТ за курсором, ключ меняется десятки раз в секунду.
     Порядок при этом обязан ехать вместе с ней (иначе дом рисуется не в своей
     глубине), а обзор — нет: на обзоре дом это прямоугольник в четыре пикселя,
     и пересобирать ради него всю карту острова на каждое движение мыши незачем.
     Поэтому ведение зовёт invalidateOrder, а «применить», «отменить» и снос —
     полный setBuildings. */
  Renderer.prototype.invalidateOrder = function () {
    this._order = null;
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

  /* Атлас КОНКРЕТНОГО жителя. Воин — тот, кто уже вышел из казармы обученным
     (`v.warrior`). Пока он идёт в казарму и тренируется, это обычный житель:
     броня надевается ровно в кадр выхода, а не в кадр нажатия «Тренировать».
     Нет атласа воина — рисуем обычного жителя: партия не должна падать. */
  Renderer.prototype.villagerSet = function (v) {
    if (v && v.warrior && this.knightSprites) return this.knightSprites;
    return this.villagerSprites;
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
    var V = global.Villagers, set = this.villagerSet(v);
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
    var B = global.Buildings, set = this.spritesFor(b.type, b.rubble);
    if (!B || !set) return null;
    /* У завалов вариант один — имя типа; у целых построек вариант из атласа. */
    var spr = B.sprite(set, b.rubble ? B.typeOf(b) : b.variant, b.rot);
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
    var isLand = w.isLand;
    var patterns = this.landPatterns;

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

    // --- 2. Отмель: сглаженная заливка по дробной глубине ---------------
    // Цвет считается по той же дробной distLand, что и раньше, но кладётся
    // картинкой «пиксель на клетку»: при растяжении она сглаживается
    // билинейно, и границы цветовых полос перестают совпадать с кромками
    // клеток. Ступенька в пол-клетки на глаз уже не читается, а стоит это
    // одного drawImage вместо тысяч ромбов.
    this.paintWaterDepth(g, px, offX, offY, W, H);

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

    // --- 4. Песок: сплошная заливка и дизеринг кромки -------------------
    // Никакого stroke по ромбам: он и давал коричневую обводку и швы на
    // стыках. Песок заливается одним путём, как трава.
    this.paintSand(g, px, W, H, x0, y0, x1, y1, patterns);

    // --- 5. Мокрый песок у воды ----------------------------------------
    this.paintWetSand(g, px, offX, offY, W, H);

    g.restore();
  };

  /* Глубина воды: цвет по дробной distLand, но не ромбами, а маленькой
     картинкой «пиксель на клетку». При растяжении на карту билинейное
     сглаживание размывает границы цветовых полос на клетку — ступени по
     distLand (целые клетки в классе) перестают читаться. Ширины SHALLOW_W /
     DEPTH_W не меняются: на них завязаны подсказки клеток. */
  Renderer.prototype.paintWaterDepth = function (g, px, offX, offY, W, H) {
    var w = this.world, distLand = w.distLand, isLand = w.isLand;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var cg = cv.getContext('2d');
    var img = cg.createImageData(W, H);
    var data = img.data;
    for (var i = 0; i < W * H; i++) {
      var col;
      if (isLand[i]) {
        // Суша будет залита травой; в воде у берега нужен самый светлый тон,
        // чтобы интерполяция не темнила кромку.
        col = PAL.shallow;
      } else {
        var d = distLand[i];
        if (d > DEPTH_W) col = PAL.deep;
        else if (d <= SHALLOW_W) col = mixTo(PAL.shallow, PAL.water, d / SHALLOW_W);
        else col = mixTo(PAL.water, PAL.deep, (d - SHALLOW_W) / (DEPTH_W - SHALLOW_W));
      }
      var k = i * 4;
      data[k] = col[0];
      data[k + 1] = col[1];
      data[k + 2] = col[2];
      data[k + 3] = 255;
    }
    cg.putImageData(img, 0, 0);

    g.save();
    g.imageSmoothingEnabled = true;
    /* Клетка (u, v) -> ромб кэша: та же проекция, что у tileDiamond, только
       записанная матрицей. Сдвиг на полчетверти клетки по Y — чтобы центры
       пикселей картинки легли в центры ромбов. */
    g.setTransform(px * 0.5, px * 0.25, -px * 0.5, px * 0.25,
      offX, offY - px * 0.25);
    g.drawImage(cv, 0, 0);
    g.restore();
  };

  /* Песок. Сплошная полоса — клетки, ортогонально касающиеся воды
     (distWater == 1), и дизеринг на 2–3 ряда вглубь суши. Ширина сплошной
     полосы — BEACH_CORE, дизеринг дотягивает видимый пляж до ~BEACH_W:
     одна и та же на 64, 96 и 128. */
  Renderer.prototype.paintSand = function (g, px, W, H, x0, y0, x1, y1, patterns) {
    var w = this.world, isLand = w.isLand, distWater = w.distWater;
    var fill = patterns && patterns.sand ? patterns.sand : rgb(PAL.sand);
    var x, y, i;

    // 4а. Сплошная полоса: один путь на всю карту, одна заливка. Ромбы не
    // перекрываются сильнее OVERLAP — иначе на стыках темнеют полосы.
    /* Сплошная полоса: один путь на всю карту, одна заливка. Размытие всего
       пути здесь не годится: оно смешивает песок с травой и водой и делает
       полосу грязной. Мягкость даёт дизеринг ниже, а сама полоса остаётся
       чистого цвета. */
    g.fillStyle = fill;
    g.beginPath();
    this.tileRuns(g, x0, y0, x1, y1, px, OVERLAP, function (cx, cy) {
      var k = cy * W + cx;
      return isLand[k] === 1 && distWater[k] <= BEACH_CORE + 1e-6;
    });
    g.fill();

    // 4б. Кромка: мелкие зёрна песка по хешу клетки, 3–6 на клетку. Это не
    // «конфетти» по всему пляжу: зёрна живут только в 2–3 рядах сразу за
    // сплошной полосой и редеют к траве. Крупные ромбы тут не годятся — они
    // читаются отдельными островками, а не мягкой кромкой.
    g.beginPath();
    for (y = y0; y < y1; y++) {
      for (x = x0; x < x1; x++) {
        i = y * W + x;
        if (!isLand[i]) continue;
        var d = distWater[i];
        if (d <= BEACH_CORE + 1e-6 || d > BEACH_FRINGE) continue;
        /* Ряды идут по distWater, а не по «ширине пляжа»: у chamfer-метрики
           первый ряд — ровно 1.0, второй — 2.0 (диагональные углы 1.369),
           третий — 3.0. Полосы режутся по этим числам, иначе весь дизеринг
           уходил бы в дальний ряд и кромка оставалась линейкой. */
        var n, pc;
        if (d <= 2.1) { n = 6; pc = 0.9; }
        else if (d <= 3.1) { n = 4; pc = 0.55; }
        else { n = 3; pc = 0.25; }
        if (hash2(x, y, 9137) > pc) continue;
        for (var j = 0; j < n; j++) {
          var h1 = hash2(x * 17 + j, y * 31 + j, 9138);
          var h2 = hash2(x * 29 + j, y * 13 + j, 9139);
          var h3 = hash2(x * 7 + j, y * 23 + j, 9140);
          // Зерно не крупнее 0.16 клетки: на зуме игры это 3–6 px.
          var hw = (0.03 + h3 * 0.05) * px;
          var hh = hw * 0.5;
          var u = x + 0.08 + h1 * 0.84;
          var v = y + 0.08 + h2 * 0.84;
          var cx = (u - v) * px * 0.5;
          var cy = (u + v) * px * 0.25;
          g.moveTo(cx, cy - hh);
          g.lineTo(cx + hw, cy);
          g.lineTo(cx, cy + hh);
          g.lineTo(cx - hw, cy);
          g.closePath();
        }
      }
    }
    g.fill();
  };

  /* Мокрый песок: полупрозрачная тёмная полоса у самой воды. Рисуется той же
     маленькой картинкой, что и глубина, и обрезается контуром суши: полоса
     ложится только на берег, а билинейное растяжение делает её мягкой.
     Ширина — WET_W клетки от кромки воды. */
  Renderer.prototype.paintWetSand = function (g, px, offX, offY, W, H) {
    var w = this.world, isLand = w.isLand, distWater = w.distWater;
    var distLand = w.distLand;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var cg = cv.getContext('2d');
    var img = cg.createImageData(W, H);
    var data = img.data;
    for (var i = 0; i < W * H; i++) {
      var a = 0;
      if (isLand[i]) {
        var d = distWater[i];
        if (d <= 1 + WET_W) a = (1 - (d - 1) / WET_W) * WET_ALPHA;
      } else if (distLand[i] <= 1) {
        // Вода у самого берега держит ту же прозрачность: иначе билинейное
        // сглаживание уводило бы самую тёмную часть полосы на клетку вглубь.
        a = WET_ALPHA;
      }
      if (a <= 0) continue;
      var k = i * 4;
      /* Цвет нарочно сдвинут от «коричневого штриха» (150,124,78): мокрый
         песок не должен давать пикселей, неотличимых от старой обводки. */
      data[k] = 72;
      data[k + 1] = 86;
      data[k + 2] = 66;
      data[k + 3] = Math.round(Math.min(1, a) * 255);
    }
    cg.putImageData(img, 0, 0);

    var land = this.landRunsPath(px, 0);
    g.save();
    g.clip(land);
    g.imageSmoothingEnabled = true;
    g.setTransform(px * 0.5, px * 0.25, -px * 0.5, px * 0.25,
      offX, offY - px * 0.25);
    g.drawImage(cv, 0, 0);
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
    /* Холст обзора переиспользуется. Раньше здесь на каждую сборку
       создавался новый canvas: в сети обзор пересобирался на каждый снимок,
       то есть 10 раз в секунду, и браузер не успевал освобождать старые
       поверхности. Это и был рост памяти / провалы кадров после долгой
       партии. */
    var cv = this.minimap;
    if (!cv || cv.width !== size || cv.height !== size) {
      cv = document.createElement('canvas');
      cv.width = size; cv.height = size;
    }
    var g = cv.getContext('2d');
    var c = this.cache;
    var b = this.computeMinimapBox();
    this.mmBox = b;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, size, size);
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
    // HUD по этому номеру понимает, что обзор изменился, и не перерисовывает
    // его на каждый кадр «на всякий случай».
    this.minimapVersion = (this.minimapVersion || 0) + 1;
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

  /* Не потерялся ли холст местности. Браузер имеет право выбросить
     поверхность большого canvas под давлением памяти; тогда drawImage рисует
     пустоту, и на экране остаётся одна вода. Проверяем несколько клеток суши
     по альфа-каналу — прозрачная клетка на суше означает «кэш пуст». */
  Renderer.prototype.cacheLooksBlank = function () {
    var w = this.world, c = this.cache;
    if (!w || !c || !w.isLand) return false;
    var g = c.getContext('2d');
    if (!g) return false;
    var N = w.width * w.height, step = Math.max(1, Math.floor(N / 400));
    var px = this.cachePx, off = this.cacheOffset;
    var tried = 0, seen = 0;
    for (var i = 0; i < N && tried < 6; i += step) {
      if (!w.isLand[i]) continue;
      tried++;
      var cx = (i % w.width) + 0.5, cy = ((i / w.width) | 0) + 0.5;
      var x = Math.round((cx - cy) * 0.5 * px + off.x);
      var y = Math.round((cx + cy) * 0.25 * px + off.y);
      if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;
      seen++;
      /* Под file:// текстуры — «чужой источник», холст помечен, и чтение
         пикселя падает SecurityError. Это не «кэш пуст»: прочитать его
         нельзя. Если игра открыта по http, проверка работает как раньше. */
      var d;
      try { d = g.getImageData(x, y, 1, 1).data; }
      catch (e) { return false; }
      if (d[3] > 0) return false;
    }
    return seen > 0;
  };

  Renderer.prototype.repaintIfBlank = function () {
    if (!this.cacheLooksBlank()) return false;
    this.buildCache();
    return true;
  };

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

    /* Участки — тот же плоский слой, что и на экране, и до спрайтов. Иначе
       «на карте трава вокруг дома есть, а в выгрузке нет»: ровно та ошибка,
       ради которой экран и экспорт ходят одним обходом eachSprite. */
    this.drawPlots(g, { export: true, scale: scale });

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
      var B = global.Buildings, bset = self.spritesFor(b.type);
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
      var V = global.Villagers, vset = self.villagerSet(v);
      if (!V || !vset) return;
      /* Экспорт обязан показывать ровно то, что видно на карте: растворённый
         в казарме не рисуется, а проявляющийся/новорождённый — с той же
         прозрачностью, что и на экране. */
      var vis = V.visibility ? V.visibility(v) : (v.hidden ? 0 : 1);
      if (vis <= 0) return;
      var ap = V.appear ? V.appear(v) : 1;
      var vspr = V.sprite(vset, v);
      if (!vspr) return;
      var vsc = V.scaleAt(vset, px);
      var vk = ap < 1 ? 0.85 + 0.15 * ap : 1;
      var vdw = vspr.sw * vsc * vk, vdh = vspr.sh * vsc * vk;
      if (vdw < 3) return;
      var vx = (v.x - v.y) * 0.5 * px + ox;
      var vy = (v.x + v.y) * 0.25 * px + oy;
      if (ap < 1 || vis < 1) {
        g.save();
        g.globalAlpha = g.globalAlpha * ap * vis;
        g.drawImage(vspr.img, vspr.sx, vspr.sy, vspr.sw, vspr.sh,
          vx - vdw * vspr.ax, vy - vdh * vspr.ay, vdw, vdh);
        g.restore();
        return;
      }
      g.drawImage(vspr.img, vspr.sx, vspr.sy, vspr.sw, vspr.sh,
        vx - vdw * vspr.ax, vy - vdh * vspr.ay, vdw, vdh);
    });
    return cv;
  };

  /* --- основной кадр --------------------------------------------------- */

  Renderer.prototype.resize = function () {
    var c = this.canvas;
    /* Плотность пикселей ограничена потолком (см. конструктор и setQuality):
       на телефоне DPR 3 — это 2.07 Мпикс полотна на 360 x 640 против 0.92 при
       DPR 2. Экранная геометрия (cssW/cssH) не меняется, поэтому клики,
       камера и пределы панорамы остаются прежними. */
    var raw = global.devicePixelRatio || 1;
    var dpr = Math.min(raw, this.dprCap || 3);
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

  /* Профиль качества: предел DPR и густота декора. Зовётся из HUD («экономия»)
     и из приёмки; сама игра качество не меняет. Мир, время и физика живут
     выше отрисовки — здесь только пиксели. */
  Renderer.prototype.setQuality = function (quality, dprCap) {
    this.quality = (quality === undefined || quality === null)
      ? 1 : Math.max(0.3, Math.min(1, quality));
    if (dprCap) this.dprCap = Math.max(1, Math.min(3, dprCap));
    if (this.canvas) this.resize();
    return { quality: this.quality, dprCap: this.dprCap, dpr: this.dpr };
  };

  Renderer.prototype.render = function (time) {
    this.time = time || 0;
    if (!this.world) return;
    /* Камера — единственное место, где испорченное число превращает кадр в
       «только вода»: NaN в transform не рисует ни земли, ни спрайтов, а
       масштаб, уехавший в ноль, растягивает море на километры. Такого не
       должно быть, но проверка дешевле, чем чёрный экран у игрока. */
    if (!isFinite(this.cam.x) || !isFinite(this.cam.y) ||
        !isFinite(this.cam.zoom) || this.cam.zoom <= 0) {
      this.cam.zoom = this.minZoom || MIN_ZOOM;
      this.cam.x = this.world.width / 2;
      this.cam.y = this.world.height / 2;
      this.clampCamera();
    }
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
    /* Плоский слой участков — после земли и воды, до ВСЕХ спрайтов. Ровно
       один раз: в eachSprite его не вставлять, иначе участок вклинится в
       порядок глубины и перекроет дерево за домом или жителя. */
    this.drawPlots(ctx);
    /* Предпросмотр серии — под спрайтами: это пятна на земле, а не здания.
       Порядок слоёв не меняется: участки -> пятна серии -> спрайты -> выбор,
       правка, призрак. */
    this.drawLineGhost(ctx);
    this.drawObjects(ctx);
    /* Порядок слоёв подсветки: выбор -> правка -> призрак. Призрак лежит
       поверх всех (он про то, куда здание ведут), правка — поверх выбора:
       выбранная постройка и правимая — обычно одна и та же, и её пятно должно
       быть цветным по «годится/не годится», а не белым. */
    this.drawSelection(ctx);
    this.drawEditing(ctx);
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

  /* Разумен ли охват кадра в клетках. Нормальный общий план большой карты —
     это примерно (2·остров)² : у 192-й карты на пределе отдаления выходит
     около 600 000 клеток, и это НЕ испорченный кадр. Прежний порог 400 000
     объявлял законный общий план сломанным: море и волны на нём просто не
     рисовались (а из-за save без restore ещё и копился стек контекста).
     Миллион с лишним — уже признак уехавшей камеры, и рисовать по такому
     кадру узоры и гребни бессмысленно. */
  var VIEW_MAX_CELLS = 1200000;
  function viewSane(box) {
    if (!box) return false;
    var w = box.x1 - box.x0, h = box.y1 - box.y0;
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return false;
    return w * h <= VIEW_MAX_CELLS;
  }

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
    /* Проверка кадра — ДО ctx.save(). Раньше она стояла после save и
       возвращала управление без restore: на общем плане 192-й карты кадр
       больше 400 000 клеток, и каждый кадр оставлял в стеке контекста ещё
       одно состояние с обрезкой. Стек рос без предела — сначала проседали
       кадры, потом хост переставал успевать со снимками, а клиенты видели
       «связь с хостом потеряна». Тот же баг был и в drawWaterShimmer. */
    var box = this.viewTiles(2);
    if (!viewSane(box)) return;
    /* В экономии на общем плане узор ряби не кладётся: под волнами его всё
       равно почти не видно, а заливка идёт по всему морю кадра. */
    var q = (this.quality === undefined || this.quality === null) ? 1 : this.quality;
    if (q < 0.8) {
      var span = (box.x1 - box.x0) * (box.y1 - box.y0);
      if (span > 2500) return;
    }

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.cssW / 2 + this.sx(0, 0), this.cssH / 2 + this.sy(0, 0));
    ctx.scale(k, k);
    ctx.translate(-offX, 0);
    if (this.seaClip) ctx.clip(this.seaClip, 'evenodd');
    // Заливка — по габариту видимой области в клетках, переведённому в
    // пиксели кэша. Прямоугольник по размеру экрана тут не годится: видимая
    // область в кэше — ромб, и он выходит за него углами.
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
    /* Тот же порядок, что в drawSeaTexture: сначала «стоит ли вообще
       рисовать этот кадр», потом save. Иначе общий план 192-й карты копил
       в стеке контекста по состоянию с обрезкой на кадр. */
    var sc = global.Waves.scaleAt(set, z);
    var box = this.viewTiles(2);
    /* Испорченный кадр не должен превращаться в миллион спрайтов: именно
       так «пропавший остров» становился ещё и слайд-шоу. */
    if (!viewSane(box)) return;

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
    var list = global.Waves.crests(set, box, this.time);
    var hw = this.cssW / 2 + 64, hh = this.cssH / 2 + 64;
    /* Экономия: на телефоне гребней вдвое меньше и мелочь не рисуется. Это
       декор, а не мир: гребни не влияют ни на проходимость, ни на время. */
    var q = (this.quality === undefined || this.quality === null) ? 1 : this.quality;
    var minPx = WAVE_MIN_PX * (q < 0.8 ? 1.5 : 1);

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
      if (q < 0.8 && (i % 2)) continue;
      if (dw < minPx) continue;
      if (sx + dw < -hw || sx - dw > hw || sy + dh < -hh || sy - dh > hh) continue;
      ctx.globalAlpha = cr.alpha;
      ctx.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh,
        sx - dw * spr.ax, sy - dh * spr.ay, dw, dh);
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  };

  /* --- участки построек ------------------------------------------------- *
   *
   * Плоский слой травы вокруг КАЖДОЙ постройки. Лежит между землёй/водой и
   * спрайтами: в render зовётся один раз после drawWaterShimmer и до
   * drawObjects, в exportPNG — после блита кэша и до eachSprite. В eachSprite
   * его вставлять нельзя: там порядок по глубине, и участок, попав в него,
   * начал бы перекрывать деревья за домом и жителей. То же и в
   * coverMask/скрытие декора — участок ничего не прячет, он просто лежит под
   * всем.
   *
   * Участок — пятно постройки без полосы PLOT_INSET. Пятно берётся у движка
   * (Buildings.bounds), поэтому поворот и военный лагерь 5 x 5 с моделью
   * 2 x 2 получаются сами: прямоугольник у 4 x 3 и 3 x 4 разный, у 5 x 5 —
   * один и тот же.
   *
   * Внутри — не заливка и не рамка, а густой дерн из коротких травинок в той
   * же палитре и с тем же характером, что у травы на карте. Заказчик
   * 2026-10-24: «у тебя же получилось спрайты травы сделать отдельные,
   * которые по карте раскиданы; почему ты здесь выборочно наблевал зелёными
   * палками вместо травы, так ещё и какие-то полосы на участке» и прислал
   * референс плотного газона. Поэтому здесь нет ни полос кошения, ни редких
   * «палок»: те же кустики `grass_tuft`, что на лугу, стоят вплотную и
   * подкрашены в тёмно-зелёный — дерн обязан быть темнее поля. Под кустиками
   * тёмная зелёная подложка, чтобы между ними не просвечивало светлое поле.
   * Цветов в дерне нет: заказчик просил траву, а не клумбу.
   *
   * Кромка — не линия: за пятном плотность падает по вероятности, а кайма
   * гуляет по ширине, поэтому силуэт рваный. Отдельные травинки выходят за
   * пятно на PLOT_EDGE = 0.50 клетки, четыре угла заведомо заняты травой:
   * приёмка (tools/ground.js) должна видеть участок, а не пустоту.
   *
   * Участок — только у ЦЕЛОЙ постройки. У завала его нет (paintPlot): под
   * руиной участок открыт целиком и читается пятном вокруг обломков, а
   * разрушенное место должно зарастать дикой травой.
   *
   * Почему дерн ЗАПЕКАЕТСЯ. Тысячи травинок на кадр — это лишние штрихи и
   * сортировка. Поэтому на каждую постройку один раз строится холст
   * plotLayer в разрешении PLOT_BAKE и дальше только кладётся картинкой:
   * один drawImage на участок. Кэш висит на самой постройке и пересобирается,
   * когда меняется пятно (переезд) или разрешение кэша местности. Завал
   * участок не меняет: он виден только моделью (правило 2026-10-24, см.
   * plotLayer).
   *
   * Координаты. Слой рисуется в координатах кэша местности и тем же
   * преобразованием, что drawLand: спрайты масштабируются вместе с землёй, а
   * не живут в экранных пикселях. Для экспорта — то же самое, но множителем
   * scale.
   * -------------------------------------------------------------------- */

  // Прямоугольник участка в клетках мира: пятно постройки без полосы
  // PLOT_INSET у кромки. Поворот уже в bounds — своего расчёта здесь нет.
  Renderer.prototype.plotRect = function (b) {
    var B = global.Buildings;
    if (!B || !b) return null;
    var bb = B.bounds(b);
    var k = PLOT_INSET;
    return { x0: bb.x0 + k, y0: bb.y0 + k, x1: bb.x1 - k, y1: bb.y1 - k };
  };

  // Четыре угла участка в координатах кэша (пиксели кэша, без начала).
  Renderer.prototype.plotCorners = function (r, px, off, grow) {
    var pts = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
    var out = [];
    for (var i = 0; i < 4; i++) {
      out.push([(pts[i][0] - pts[i][1]) * px * 0.5 + off.x,
                (pts[i][0] + pts[i][1]) * px * 0.25 + off.y]);
    }
    /* На полпикселя наружу: сглаженный угол иначе смешивается с дикой травой
       и участок теряет угол. Это не обводка — та же заливка чуть шире. */
    if (grow) {
      var mx = (out[0][0] + out[2][0]) * 0.5, my = (out[0][1] + out[2][1]) * 0.5;
      for (var j = 0; j < 4; j++) {
        var dx = out[j][0] - mx, dy = out[j][1] - my;
        var len = Math.hypot(dx, dy) || 1;
        out[j][0] += dx / len * grow;
        out[j][1] += dy / len * grow;
      }
    }
    return out;
  };

  /* Плоский слой участков. opts.export — рисовать в холст выгрузки (там своё
     разрешение и нет камеры); opts.scale — во сколько раз выгрузка крупнее
     кэша. В обычном кадре преобразование повторяет drawLand один в один:
     стоит его потерять, и участки уедут относительно домов. */
  Renderer.prototype.drawPlots = function (ctx, opts) {
    opts = opts || {};
    var w = this.world;
    if (!w || !this.showPlots) return;
    var B = global.Buildings;
    if (!B || !B.bounds) return;
    var px = this.cachePx, off = this.cacheOffset;
    var factor;

    ctx.save();
    if (opts.export) {
      var scale = opts.scale || 1;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      factor = scale;
    } else {
      var k = this.cam.zoom / px;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.translate(this.cssW / 2 + this.sx(0, 0), this.cssH / 2 + this.sy(0, 0));
      ctx.scale(k, k);
      ctx.translate(-off.x, 0);
      factor = k;
    }

    var st = {
      px: px, off: off, factor: factor,
      // База для призрака — та же трава, что у земли; у готового участка
      // своя запечённая текстура (plotLayer).
      pattern: this.landPatterns && this.landPatterns.grass ? this.landPatterns.grass : null
    };

    if (this.showBuildings) {
      for (var i = 0; i < this.buildings.length; i++) {
        if (this.buildings[i]) this.paintPlot(ctx, this.buildings[i], st);
      }
    }
    /* Призрак под курсором: тот же участок, только полупрозрачный и цветной.
       Зелёный — место годится, красный — нет. Цвета те же, что у пятна
       призрака (drawGhost), чтобы курсор читался одним целым. */
    if (!opts.export && this.ghost && this.ghost.b) {
      this.paintPlot(ctx, this.ghost.b, st, this.ghost);
    }
    ctx.restore();
  };

  /* Цвет команды для кромки участка/кольца. В одиночной игре город один, и
     цвет не нужен: кромка остаётся тёмно-зелёной. В «против деревни» и в
     сети городов больше одного — тогда кромка красится в цвет владельца. */
  Renderer.prototype.teamColor = function (b, alpha) {
    var w = this.world;
    if (!w || !w.towns || w.towns.length < 2 || !b) return null;
    var t = w.towns[b.owner === undefined ? 0 : b.owner];
    if (!t || !t.color) return null;
    var hex = String(t.color).replace('#', '');
    if (hex.length !== 6) return null;
    var r = parseInt(hex.slice(0, 2), 16);
    var g = parseInt(hex.slice(2, 4), 16);
    var bl = parseInt(hex.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + bl + ',' + (alpha === undefined ? 0.85 : alpha) + ')';
  };

  /* Цвет команды по номеру владельца. В одиночной игре тоже есть цвет:
     тонкая цветная обводка спрайта — единственный признак «свой», когда
     городов несколько, и просто аккуратная обводка, когда один. */
  Renderer.prototype.teamColorFor = function (owner, alpha) {
    var w = this.world;
    var t = w && w.towns && w.towns[owner === undefined ? 0 : owner];
    var hex = t && t.color ? String(t.color).replace('#', '') : '4a90d9';
    if (hex.length !== 6) hex = '4a90d9';
    var r = parseInt(hex.slice(0, 2), 16);
    var g = parseInt(hex.slice(2, 4), 16);
    var bl = parseInt(hex.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + bl + ',' + (alpha === undefined ? 1 : alpha) + ')';
  };

  /* Силуэт кадра в одном цвете. Кэшируется на самом спрайте: кадров немного,
     а цветов — по числу команд. getImageData не нужен, поэтому работает и
     под file://, где пиксели чужого холста читать нельзя. */
  Renderer.prototype.silhouette = function (spr, color) {
    if (!spr || !spr.img) return null;
    var cache = spr._outlines || (spr._outlines = {});
    if (cache[color]) return cache[color];
    var cv = document.createElement('canvas');
    cv.width = spr.sw; cv.height = spr.sh;
    var g = cv.getContext('2d');
    if (!g) return null;
    g.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh, 0, 0, spr.sw, spr.sh);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, cv.width, cv.height);
    cache[color] = cv;
    return cv;
  };

  /* Тонкая цветная обводка ПОВЕРХ чёрного контура спрайта.

     Чёрный контур — часть атласа, и перекрашивать пиксели через getImageData
     нельзя: под file:// холст с чужой картинкой считается tainted. Поэтому
     делаем маску без чтения пикселей: цветной силуэт минус уменьшенная копия
     самого спрайта. Остаётся кайма по краю — она и ложится поверх чёрного
     контура. Внутри спрайт остаётся целым.

     Каёмочных холстов на спрайт держим горстку. Толщина каймы задана в
     пикселях экрана, а режется она в пикселях спрайта, поэтому плавный зум
     пробегает десятки значений — и каждое оставляло бы свой холст размером с
     кадр. Кадр ратуши — это ~0.9 МБ; десятки значений на спрайт — десятки
     мегабайт на одну постройку. В кадре спрайт рисуется ровно одной толщиной,
     так что хватает последних. */
  var EDGE_CACHE = 6;
  Renderer.prototype.spriteEdge = function (spr, color, thickness, clipBottom) {
    var t = Math.max(1, Math.round(thickness || 2));
    /* clipBottom — в пикселях кадра: ниже этой строки кайма не режется.
       Нужен жителю: у его кадра запечена мягкая тень, и общая кайма
       обводила бы её отдельным синим овалом под ногами — тем самым
       «кружком», которого быть не должно. Обводим человека, не тень. */
    var clip = Math.max(0, Math.round(clipBottom || 0));
    var key = color + '|' + t + '|' + clip;
    var cache = spr._edges || (spr._edges = []);
    for (var i = 0; i < cache.length; i++) {
      if (cache[i].key !== key) continue;
      // Недавно нужный — в конец: его выбросят последним.
      var hit = cache.splice(i, 1)[0];
      cache.push(hit);
      return hit.cv;
    }
    var cv = document.createElement('canvas');
    cv.width = spr.sw; cv.height = spr.sh;
    var g = cv.getContext('2d');
    if (!g) return null;
    g.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh, 0, 0, cv.width, cv.height);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, cv.width, cv.height);
    // Вырезаем середину уменьшенной копией спрайта: остаётся кайма.
    g.globalCompositeOperation = 'destination-out';
    var k = Math.max(0.5, 1 - 2 * t / Math.min(cv.width, cv.height));
    g.save();
    g.translate(cv.width / 2, cv.height / 2);
    g.scale(k, k);
    g.translate(-cv.width / 2, -cv.height / 2);
    g.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh, 0, 0, cv.width, cv.height);
    g.restore();
    if (clip > 0 && clip < cv.height) {
      g.globalCompositeOperation = 'destination-out';
      g.fillRect(0, clip, cv.width, cv.height - clip);
    }
    cache.push({ key: key, cv: cv });
    if (cache.length > EDGE_CACHE) cache.shift();
    return cv;
  };

  /* Обводка в пикселях ЭКРАНА, а не спрайта (правило 2026-10-24).

     screenPx — толщина на экране, одинаковая на любом отдалении: кайма
     режется в пикселях кадра, а спрайт рисуется сжатым, поэтому переводит
     одно в другое масштаб самого спрайта — box.dw / spr.sw (сколько
     экранных пикселей приходится на пиксель кадра). Раньше сюда было
     подмешано ещё и отношение пикселей кэша земли (cam.zoom / cachePx):
     масштаб спрайта уже содержит зум, и он входил второй раз — на отдалении
     обводка росла как z² и выходила в 3–4 пикселя вместо 1.4 (а при
     приближении, наоборот, истончалась до 0.6). Отсюда и жалоба «когда
     отдаляешь, обводка становится слишком жирной».

     Пиксель кадра — предел снизу: тоньше одного пикселя силуэт не режется,
     и на самом крупном зуме кайма выходит ~0.8 экранного пикселя. */
  Renderer.prototype.drawSpriteOutline = function (ctx, box, color, screenPx,
                                                   clipBottom) {
    var spr = box.spr;
    if (!spr || !spr.img) return;
    var perPx = box.dw / spr.sw;
    if (!(perPx > 0)) return;
    var px = Math.max(1, Math.round((screenPx || 1.4) / perPx));
    var edge = this.spriteEdge(spr, color, px, clipBottom);
    if (edge) ctx.drawImage(edge, box.dx, box.dy, box.dw, box.dh);
  };

  /* Один участок. ghost — объект призрака {ok, ...} или ничего.

     Готовый участок — ОДНА картинка, запечённая в plotLayer: в кадре нет ни
     тысяч штрихов, ни повторов узора. Призрак остаётся плоским и
     полупрозрачным: его ведут за курсором десятки раз в секунду, и печь ему
     луг на каждый шаг нельзя.

     У ЗАВАЛА УЧАСТКА НЕТ (правило заказчика 2026-10-24). Участок — знак
     обжитого места: у целой постройки его почти не видно из-под спрайта, а
     под руиной он открыт целиком и читается пятном вокруг обломков — ровно
     тем, на что заказчик и жаловался. Поэтому разрушенная постройка стоит на
     дикой траве: она и должна зарастать. Модель завала при этом меняется
     сама (spritesFor(type, true)), и больше о разрушении ничего не говорит. */
  Renderer.prototype.paintPlot = function (ctx, b, st, ghost) {
    if (b && b.rubble) return;
    var r = this.plotRect(b);
    if (!r || r.x1 <= r.x0 || r.y1 <= r.y0) return;

    if (ghost) {
      this.paintGhostPlot(ctx, r, st, ghost);
      return;
    }

    var layer = this.plotLayer(b);
    if (!layer) return;
    /* Пересчёт «пиксель запечённого слоя -> пиксель кэша». Слой лежит в той
       же изометрии, что и местность: сдвиг ox/oy — его собственное начало,
       а PLOT_BAKE — масштаб, в котором он нарисован. */
    var s = st.px / PLOT_BAKE;
    ctx.drawImage(layer.canvas,
      st.off.x + layer.ox * s, st.off.y + layer.oy * s,
      layer.canvas.width * s, layer.canvas.height * s);
  };

  /* Призрак под курсором: полупрозрачная трава и цветной тон поверх неё.
     Сквозь него видно, куда именно встанет дом; зелёный — место годится,
     красный — нет. Цвета те же, что у пятна призрака (drawGhost). */
  Renderer.prototype.paintGhostPlot = function (ctx, r, st, ghost) {
    var pts = this.plotCorners(r, st.px, st.off, Math.max(1.2, 2.0 / st.factor));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha = 0.62;
    ctx.fillStyle = st.pattern || rgb([126, 178, 96]);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = ghost.ok ? 'rgba(126,232,164,0.30)' : 'rgba(240,104,86,0.34)';
    ctx.fill();
    ctx.restore();
  };

  /* Запечённый слой участка. Холст живёт на самой постройке: у каждого
     участка своя раскладка травы (хеш от x, y и поворота), поэтому два дома
     рядом не выглядят копиями. Ключ — пятно и разрешение кэша местности:
     переехала постройка или сменилась карта — слой собирается заново.
     Атласа в ключе нет: дерн процедурный, спрайты карты в него не входят.

     Зовётся только для целой постройки: у завала участка нет вовсе
     (paintPlot), а выгоревшего пятна с пеплом и углями не стало ещё раньше —
     это оно висело тёмной кляксой вокруг руины (правило 2026-10-24). */
  Renderer.prototype.plotLayer = function (b) {
    if (!b) return null;
    var r = this.plotRect(b);
    if (!r || r.x1 <= r.x0 || r.y1 <= r.y0) return null;
    var set = this.sprites;
    var tex = this.textures && this.textures.plot_grass;
    if (!tex && (!set || !set.tuft || !set.tuft.length)) return null;
    var key = [r.x0, r.y0, r.x1, r.y1, this.cachePx,
               set ? set.ppu : 0, set ? set.mul : 0, tex ? 1 : 0].join('|');
    if (b._plotLayer && b._plotLayer.key === key) return b._plotLayer;

    /* Габарит холста — ромб участка, расширенный на PLOT_MARGIN: спрайты
       выше своей точки опоры и выходят за кромку пятна. */
    var pad = PLOT_MARGIN;
    var bx0 = (r.x0 - pad - (r.y1 + pad)) * PLOT_BAKE * 0.5;
    var bx1 = (r.x1 + pad - (r.y0 - pad)) * PLOT_BAKE * 0.5;
    var by0 = (r.x0 - pad + (r.y0 - pad)) * PLOT_BAKE * 0.25;
    var by1 = (r.x1 + pad + r.y1 + pad) * PLOT_BAKE * 0.25;
    var M = 12;
    var ox = Math.floor(bx0 - M);
    var oy = Math.floor(by0 - M);
    var cw = Math.max(1, Math.ceil(bx1 - bx0 + 2 * M));
    var ch = Math.max(1, Math.ceil(by1 - by0 + 2 * M));

    var cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    var ctx = cv.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    var out = { key: key, canvas: cv, ox: ox, oy: oy };
    this.bakeTurf(ctx, b, r, ox, oy);
    b._plotLayer = out;
    return out;
  };

  /* --- газон участка из плитки Blender ------------------------------- *
   *
   * До 2026-10-24 участок пёкся из тех же спрайтов `grass_tuft`, что растут
   * на лугу, только плотно и с тёмной подкраской. Вплотную друг к другу они
   * читались частоколом кустиков, а не газоном. Заказчик попросил «текстуру
   * поверхности: низкая трава, слегка темнее той, что по всей карте, в стиле
   * разбросанной травы, но другого цвета».
   *
   * Поэтому теперь у участка своя плитка — `assets/textures/plot_grass.png`.
   * Она собрана в Blender (art/textures/plot_grass): короткие широкие листья,
   * тот же тон, что у луга, на ступень темнее. Плитка периодическая и лежит
   * на 2 x 2 клетки — в том же масштабе, что текстура земли (TEX_REPEAT).
   *
   * Здесь она только кладётся: маска участка с рваной кромкой, четыре
   * поворота плитки (соседние дома не выглядят клонами) и редкие листья-
   * бахрома за кромкой, чтобы газон не обрывался линейкой. Спрайты в этом
   * пути не участвуют вовсе — ни одного `drawImage` атласа на участок.
   * -------------------------------------------------------------------- */

  /* Плитка, приведённая к 2 x 2 клеткам запечённого слоя (256 px), и четыре
     её поворота. Кэш висит на рендерере: сама картинка одна на игру. */
  Renderer.prototype.plotGrass = function () {
    var tex = this.textures && this.textures.plot_grass;
    if (!tex || !tex.width) return null;
    if (this._plotGrass && this._plotGrass.tex === tex) return this._plotGrass;
    var tile = PLOT_TEX_CELLS * PLOT_BAKE;
    var src = document.createElement('canvas');
    src.width = tile; src.height = tile;
    var sg = src.getContext('2d');
    if (!sg) return null;
    sg.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in sg) sg.imageSmoothingQuality = 'high';
    sg.drawImage(tex, 0, 0, tile, tile);

    var patterns = [];
    for (var k = 0; k < 4; k++) {
      var cv = document.createElement('canvas');
      cv.width = tile; cv.height = tile;
      var cg = cv.getContext('2d');
      if (!cg) return null;
      cg.translate(tile * 0.5, tile * 0.5);
      cg.rotate(k * Math.PI * 0.5);
      cg.drawImage(src, -tile * 0.5, -tile * 0.5);
      patterns.push(cg.createPattern(cv, 'repeat'));
    }
    this._plotGrass = { tex: tex, tile: tile, patterns: patterns };
    return this._plotGrass;
  };

  /* Маска газона: прямоугольник участка, раздутый на PLOT_TEX_EDGE, с рваной
     кромкой. Возвращает и многоугольник для клипа, и точки кромки с нормалью
     и касательной — по ним потом растёт бахрома. */
  Renderer.prototype.plotGrassEdge = function (b, r) {
    var seed = (Math.imul(b.x | 0, 2246822519) ^
      Math.imul(b.y | 0, 3266489917) ^
      Math.imul((b.rot || 0) + 7, 668265263)) >>> 0;
    if (!seed) seed = 0x9e3779b9;
    var rs = seed;
    function rnd() {
      rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0;
      return rs / 4294967296;
    }
    var grow = PLOT_TEX_EDGE;
    var poly = [], edges = [];
    function seg(ax, ay, bx, by, nx, ny) {
      var dx = bx - ax, dy = by - ay;
      var len = Math.hypot(dx, dy) || 1;
      var tx = dx / len, ty = dy / len;
      var n = Math.max(10, Math.round(len / 0.085));
      for (var i = 0; i < n; i++) {
        var t = i / n;
        var w = grow + (rnd() - 0.5) * 0.20;
        var u = ax + dx * t + nx * w;
        var v = ay + dy * t + ny * w;
        poly.push([u, v]);
        edges.push({ u: u, v: v, nx: nx, ny: ny, tx: tx, ty: ty });
      }
    }
    seg(r.x0, r.y0, r.x1, r.y0, 0, -1);
    poly.push([r.x1 + grow, r.y0 - grow]);
    seg(r.x1, r.y0, r.x1, r.y1, 1, 0);
    poly.push([r.x1 + grow, r.y1 + grow]);
    seg(r.x1, r.y1, r.x0, r.y1, 0, 1);
    poly.push([r.x0 - grow, r.y1 + grow]);
    seg(r.x0, r.y1, r.x0, r.y0, -1, 0);
    poly.push([r.x0 - grow, r.y0 - grow]);
    return { poly: poly, edges: edges };
  };

  /* Газон участка: одна картинка-плитка вместо тысяч листьев.

     Плитка кладётся на отдельный холст и маскируется МЯГКО: кромка газона
     растворяется в лугу на несколько пикселей, а не обрывается ромбом. В
     кадре участок и раньше не был рамкой — он был дерном; теперь дерн ещё и
     не спорит с полем силуэтом. Бахрома из листьев рисуется уже после маски:
     она выходит за кромку и добивает рваность. */
  Renderer.prototype.bakeTurfTexture = function (ctx, b, r, ox, oy) {
    var pack = this.plotGrass();
    if (!pack) return false;
    var BAKE = PLOT_BAKE;

    function X(uu, vv) { return (uu - vv) * BAKE * 0.5 - ox; }
    function Y(uu, vv) { return (uu + vv) * BAKE * 0.25 - oy; }
    function DX(du, dv) { return (du - dv) * BAKE * 0.5; }
    function DY(du, dv) { return (du + dv) * BAKE * 0.25; }

    var eg = this.plotGrassEdge(b, r);
    var poly = eg.poly, edges = eg.edges;
    var W = ctx.canvas.width, H = ctx.canvas.height;

    function path(g) {
      g.beginPath();
      g.moveTo(X(poly[0][0], poly[0][1]), Y(poly[0][0], poly[0][1]));
      for (var i = 1; i < poly.length; i++) {
        g.lineTo(X(poly[i][0], poly[i][1]), Y(poly[i][0], poly[i][1]));
      }
      g.closePath();
    }

    // 1. Текстура на своём холсте: так её можно погасить к кромке маской.
    var tv = document.createElement('canvas');
    tv.width = W; tv.height = H;
    var tg = tv.getContext('2d');
    if (!tg) return false;
    tg.save();
    path(tg);
    tg.clip();

    // Подложка того же тона, что у плитки: она нужна только на случай
    // сглаженной кромки и не должна читаться тёмной каймой.
    tg.fillStyle = 'rgb(106,168,80)';
    tg.fillRect(0, 0, W, H);

    /* Поворот и сдвиг плитки — от координат постройки. Четыре поворота
       ломают повтор: у двух соседних домов газон не один и тот же. */
    var rot = (Math.imul(b.x | 0, 7) ^ Math.imul(b.y | 0, 13) ^
               (b.rot || 0)) & 3;
    var pat = pack.patterns[rot] || pack.patterns[0];
    var tile = pack.tile;
    var phx = ((Math.imul(b.x | 0, 73) + Math.imul(b.y | 0, 131)) % tile + tile) % tile;
    var phy = ((Math.imul(b.x | 0, 151) + Math.imul(b.y | 0, 47)) % tile + tile) % tile;
    tg.translate(phx, phy);
    /* Плитка ложится целиком: она уже плоская — в Blender это эмиссия без
       света и теней, поэтому листья не читаются зарослями. Подложка нужна
       только на сглаженной кромке. */
    tg.fillStyle = pat;
    tg.fillRect(-phx, -phy, W + tile * 2, H + tile * 2);
    tg.restore();

    // 2. Мягкая маска: белый путь с размытием, затем destination-in.
    var mv = document.createElement('canvas');
    mv.width = W; mv.height = H;
    var mg = mv.getContext('2d');
    if (!mg) return false;
    mg.fillStyle = '#fff';
    mg.filter = 'blur(' + PLOT_TEX_FADE + 'px)';
    path(mg);
    mg.fill();
    mg.filter = 'none';
    tg.globalCompositeOperation = 'destination-in';
    tg.drawImage(mv, 0, 0);
    tg.globalCompositeOperation = 'source-over';
    ctx.drawImage(tv, 0, 0);

    /* 3. Бахрома: короткие листья из-за кромки. Это не обводка и не спрайты
       атласа — те же тона, что у плитки, только длиннее и реже. */
    var FRINGE = ['rgb(94,152,70)', 'rgb(118,180,88)', 'rgb(140,200,104)'];
    var rs2 = (Math.imul(b.x | 0, 374761393) ^
      Math.imul(b.y | 0, 668265263) ^
      Math.imul((b.rot || 0) + 3, 1442695041)) >>> 0;
    if (!rs2) rs2 = 0x85ebca6b;
    function rnd2() {
      rs2 = (Math.imul(rs2, 1664525) + 1013904223) >>> 0;
      return rs2 / 4294967296;
    }

    function blade(px, py, nx, ny, tx, ty) {
      var len = 0.10 + rnd2() * 0.12;
      var wid = 0.024 + rnd2() * 0.026;
      var bend = (rnd2() - 0.5) * len * 0.55;
      var dx = DX(nx * len, ny * len);
      var dy = DY(nx * len, ny * len);
      var bx = px + dx + DX(tx * bend, ty * bend);
      var by = py + dy + DY(tx * bend, ty * bend);
      var lx = px - DX(tx * wid * 0.5, ty * wid * 0.5);
      var ly = py - DY(tx * wid * 0.5, ty * wid * 0.5);
      var rx = px + DX(tx * wid * 0.5, ty * wid * 0.5);
      var ry = py + DY(tx * wid * 0.5, ty * wid * 0.5);
      var c1x = px + dx * 0.55 + DX(tx * (bend * 0.3 + wid * 0.7),
                                    ty * (bend * 0.3 + wid * 0.7));
      var c1y = py + dy * 0.55 + DY(tx * (bend * 0.3 + wid * 0.7),
                                    ty * (bend * 0.3 + wid * 0.7));
      var c2x = px + dx * 0.55 + DX(tx * (bend * 0.3 - wid * 0.7),
                                    ty * (bend * 0.3 - wid * 0.7));
      var c2y = py + dy * 0.55 + DY(tx * (bend * 0.3 - wid * 0.7),
                                    ty * (bend * 0.3 - wid * 0.7));
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.quadraticCurveTo(c1x, c1y, bx, by);
      ctx.quadraticCurveTo(c2x, c2y, rx, ry);
      ctx.closePath();
      ctx.fillStyle = FRINGE[(rnd2() * FRINGE.length) | 0];
      ctx.fill();
    }

    for (var j = 0; j < edges.length; j++) {
      if (rnd2() > 0.12) continue;
      var e = edges[j];
      var jt = (rnd2() - 0.5) * 0.07;
      blade(X(e.u + e.tx * jt, e.v + e.ty * jt),
            Y(e.u + e.tx * jt, e.v + e.ty * jt),
            e.nx, e.ny, e.tx, e.ty);
    }
    // Углы: по три листа наружу по диагонали, иначе кромка на углу голая.
    var corners = [
      [r.x1, r.y0, 1, -1], [r.x1, r.y1, 1, 1],
      [r.x0, r.y1, -1, 1], [r.x0, r.y0, -1, -1]
    ];
    for (var c = 0; c < corners.length; c++) {
      for (var k2 = 0; k2 < 4; k2++) {
        var cx2 = corners[c][0] + corners[c][2] * (0.08 + rnd2() * 0.08);
        var cy2 = corners[c][1] + corners[c][3] * (0.08 + rnd2() * 0.08);
        blade(X(cx2, cy2), Y(cx2, cy2),
              corners[c][2], corners[c][3],
              corners[c][3], -corners[c][2]);
      }
    }
    return true;
  };

  /* Запасной дерн участка: те же кустики grass_tuft, что растут на лугу,
     только плотным ковром и темнее поля. Этот путь включается, если плитка
     `plot_grass` не загрузилась: участок не должен исчезнуть из-за одной
     картинки. Основной путь — bakeTurfTexture выше. */
  Renderer.prototype.bakeTurf = function (ctx, b, r, ox, oy) {
    /* Основной путь — плитка газона. Старый дерн из кустиков остаётся
       запасным: если картинка не загрузилась, участок не должен исчезнуть. */
    if (this.textures && this.textures.plot_grass) {
      if (this.bakeTurfTexture(ctx, b, r, ox, oy)) return;
    }
    var BAKE = PLOT_BAKE;
    var set = this.sprites;
    if (!set || !set.tuft || !set.tuft.length) return;

    function X(uu, vv) { return (uu - vv) * BAKE * 0.5 - ox; }
    function Y(uu, vv) { return (uu + vv) * BAKE * 0.25 - oy; }

    var seed = (Math.imul(b.x | 0, 374761393) ^
      Math.imul(b.y | 0, 668265263) ^
      Math.imul((b.rot || 0) + 1, 1442695041)) >>> 0;
    if (!seed) seed = 0x1b873593;
    var rs = seed;
    function rnd() {
      rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0;
      return rs / 4294967296;
    }

    /* Подкрашенные кадры кустиков кэшируются на рендерере: сам атлас не
       трогаем, иначе потемнеет и дикая трава. */
    var tint = this._tuftTint;
    if (!tint || tint.set !== set) {
      var frames = [];
      var ti;
      for (ti = 0; ti < set.tuft.length; ti++) {
        var src = set.tuft[ti];
        var cv = document.createElement('canvas');
        cv.width = src.sw; cv.height = src.sh;
        var cc = cv.getContext('2d');
        if (!cc) continue;
        cc.drawImage(src.img, src.sx, src.sy, src.sw, src.sh, 0, 0, src.sw, src.sh);
        cc.globalCompositeOperation = 'source-atop';
        cc.fillStyle = 'rgba(56,102,40,0.42)';
        cc.fillRect(0, 0, src.sw, src.sh);
        cc.globalCompositeOperation = 'source-over';
        frames.push({ img: cv, sw: src.sw, sh: src.sh, ax: src.ax, ay: src.ay });
      }
      tint = { set: set, frames: frames };
      this._tuftTint = tint;
    }
    var tufts = tint.frames;
    if (!tufts.length) return;

    var area = (r.x1 - r.x0) * (r.y1 - r.y0);
    var step = area < 14 ? 0.105 : 0.125;
    var maxTufts = 6000;
    var i, u, v;

    /* 1. Тёмная зелёная подложка: между кустиками не должно быть светлых
       дыр. Кромка неровная и мягкая, но сама подложка не выходит за траву. */
    var bp = 0.05;
    var b0u = r.x0 + bp, b0v = r.y0 + bp;
    var b1u = r.x1 - bp, b1v = r.y1 - bp;
    var edge = [], per = 10, q;
    function edgeLine(u0, v0, u1, v1) {
      for (q = 0; q < per; q++) {
        var et = q / per;
        edge.push([
          u0 + (u1 - u0) * et + (rnd() - 0.5) * 0.08,
          v0 + (v1 - v0) * et + (rnd() - 0.5) * 0.08
        ]);
      }
    }
    edgeLine(b0u, b0v, b1u, b0v);
    edgeLine(b1u, b0v, b1u, b1v);
    edgeLine(b1u, b1v, b0u, b1v);
    edgeLine(b0u, b1v, b0u, b0v);
    ctx.save();
    ctx.filter = 'blur(1.2px)';
    ctx.beginPath();
    ctx.moveTo(X(edge[0][0], edge[0][1]), Y(edge[0][0], edge[0][1]));
    for (i = 1; i < edge.length; i++) {
      ctx.lineTo(X(edge[i][0], edge[i][1]), Y(edge[i][0], edge[i][1]));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(52,92,38,0.55)';
    ctx.fill();
    ctx.restore();

    /* 2. Частая сетка кустиков. Внутри пятна — почти сплошной ковёр, к
       кромке плотность падает, за кромкой остаются редкие травинки. */
    var list = [];
    var f = BAKE / ((set.ppu || 96) * (set.tileUnits || 1)) * (set.mul || 1.35);
    for (u = r.x0 - PLOT_EDGE + rnd() * step; u < r.x1 + PLOT_EDGE && list.length < maxTufts; u += step) {
      for (v = r.y0 - PLOT_EDGE + rnd() * step; v < r.y1 + PLOT_EDGE && list.length < maxTufts; v += step) {
        var out = Math.max(r.x0 - u, u - r.x1, r.y0 - v, v - r.y1, 0);
        var wob = 0.5 + 0.5 * Math.sin(u * 17.3 + v * 9.7);
        var rim = 0.10 + 0.16 * wob;
        var acc = out <= 0 ? 0.92 : (out < rim ? 0.65 : 0.04);
        if (rnd() > acc) continue;
        list.push({
          u: u + (rnd() - 0.5) * step * 0.9,
          v: v + (rnd() - 0.5) * step * 0.9,
          spr: tufts[Math.floor(rnd() * tufts.length)],
          scale: 0.42 + rnd() * 0.16
        });
      }
    }
    // Сначала дальние кустики, потом ближние: так стыки читаются слоями.
    list.sort(function (a, c) { return (a.u + a.v) - (c.u + c.v); });

    for (i = 0; i < list.length; i++) {
      var it = list[i];
      var dw = it.spr.sw * f * it.scale;
      var dh = it.spr.sh * f * it.scale;
      var px = X(it.u, it.v), py = Y(it.u, it.v);
      ctx.drawImage(it.spr.img, 0, 0, it.spr.sw, it.spr.sh,
        px - dw * it.spr.ax, py - dh * it.spr.ay, dw, dh);
    }
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

  /* --- что закрыто постройкой ------------------------------------------ *
   *
   * Маска клеток, которые закрывает постройка: пятно и двор вокруг — ровно те
   * клетки, что расчищает постановка (js/buildings.js: coverCells, YARD). Ключ
   * клетки — её номер в ряду мира, значение — единица.
   *
   * Зачем это отрисовке. Постановка и «Применить» мелочь под домом сминают
   * (js/buildings.js: crushDecor), а ВЕДЕНИЕ дома за курсором — нет: мир обязан
   * остаться нетронутым, иначе «Отменить» вернуло бы дом на выкошенный луг
   * (правило заказчика 2026-10-17). Но дом, который ведут, уже стоит там, куда
   * его ведут, — и куст из пятна оказывался прямо в доме: по земле он честно
   * ближе камеры и рисуется после стены (правило заказчика 2026-10-18: «внутри
   * него отображается куст или трава»).
   *
   * Поэтому прячет мелочь ОТРИСОВКА, а не мир: мир про неё не знает, «Отменить»
   * возвращает дом на целый луг, а мелочь возвращается сама — её и не убирали.
   * То же правило отвечает за призрак под курсором: под ним видно ровно то, что
   * останется после постановки.
   *
   * Прячется ровно УКРАШЕНИЕ (Buildings.decor) — то, что стройке не помеха.
   * Дерево и камень помеха, и прятать их незачем: место под ними и не годится,
   * а в генераторе призрак над деревом честно показывает, что тут будут рубить
   * (постановка их снесёт — settle).
   *
   * Маска собирается на каждый обход, а не кэшируется: дом ведут за курсором
   * десятки раз в секунду, и следить за тем, когда кэш протух, дороже, чем
   * разложить по клеткам три десятка клеток на постройку.
   * ---------------------------------------------------------------------- */
  Renderer.prototype.coverMask = function () {
    var B = global.Buildings, w = this.world;
    if (!B || !w || !B.coverCells) return null;
    var out = {}, i, j, cells, c;
    var list = (this.buildings || []).slice();
    // Призрак — та же постройка, только ещё не вставшая: спрашивается тем же
    // правилом, а не своим (иначе «что закроется» и «что закрыто» разошлись бы).
    if (this.ghost && this.ghost.b) list.push(this.ghost.b);
    for (i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      cells = B.coverCells(list[i]);
      for (j = 0; j < cells.length; j++) {
        c = cells[j];
        if (c.x < 0 || c.y < 0 || c.x >= w.width || c.y >= w.height) continue;
        out[c.y * w.width + c.x] = 1;
      }
    }
    return out;
  };

  /* Обход всех спрайтов в порядке глубины: объекты мира, постройки и жители
     в одном потоке. Нужен затем, что порядок отрисовки обязан совпадать у
     экрана и у экспорта PNG: две отдельные реализации этого порядка уже
     расходились (в экспорт постройки просто не попадали, а без них ратуша
     «исчезала» ровно на выгрузке).

     Мелочь, закрытая постройкой, из обхода ВЫПАДАЕТ (coverMask): так один и тот
     же пропуск достаётся и экрану, и экспорту — второй реализации правила,
     которая однажды разошлась бы с первой, не заводится. */
  Renderer.prototype.eachSprite = function (onObject, onBuilding, onWalker) {
    var w = this.world;
    if (!w) return;
    var B = global.Buildings;
    var objs = w.objects;
    var mask = this.coverMask();
    var blds = this.showBuildings ? this.buildingOrder() : [];
    var vils = (onWalker && this.showVillagers) ? this.villagerOrder() : [];
    var i = 0, j = 0, k = 0, o, b, v;
    while (i < objs.length || j < blds.length || k < vils.length) {
      /* Пропуск считается здесь, а не в drawObjects: обход один на экран и на
         выгрузку, и оба обязаны видеть одну и ту же картинку. */
      while (i < objs.length) {
        o = objs[i];
        var tx = Math.floor(o.x), ty = Math.floor(o.y);
        if (mask && B && B.decor(o) &&
            mask[ty * w.width + tx] === 1) { i++; continue; }
        break;
      }
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
      /* Растворённый в казарме не рисуется вовсе; растворение и проявление
         считаются ОДНОЙ видимостью (Villagers.visibility). */
      var vis = global.Villagers && global.Villagers.visibility
        ? global.Villagers.visibility(v) : (v.hidden ? 0 : 1);
      if (vis <= 0) return;
      var vb = self.villagerBox(v, z);
      if (!vb || vb.dw < 3) return;               // мельче — не видно, кто это
      /* Кайму режем до опоры: ниже неё в кадре запечена тень, и общая
         кайма обвела бы тень синим овалом под ногами. */
      var edgeClip = Math.round(vb.spr.ay * vb.spr.sh) + 1;
      /* Новорождённый проявляется: alpha 0 -> 1, масштаб 0.85 -> 1. Масштаб
         считается ОТ ТОЧКИ ОПОРЫ (ноги), поэтому dx/dy берутся заново от
         vb.x/vb.y, а не масштабируются готовые: иначе ступни поехали бы по
         земле. У обычного жителя прогресс 1 — рисуется прежним путём, без
         save/restore и без изменения кадра. */
      /* Цветная кайма живёт на САМОМ спрайте и рисуется всегда, а не только
         в партии с несколькими городами (правило заказчика 2026-10-24):
         «сам спрайт жителя должен быть обведён цветом». Это единственный
         постоянный признак свой/чужой. Колец под ногами больше нет: они были
         вторым слоем той же обводки и забивали карту. */
      var ap = global.Villagers && global.Villagers.appear
        ? global.Villagers.appear(v) : 1;
      if (ap < 1 || vis < 1) {
        var k = ap < 1 ? 0.85 + 0.15 * ap : 1;
        var dw = vb.dw * k, dh = vb.dh * k;
        ctx.save();
        ctx.globalAlpha = ctx.globalAlpha * ap * vis;
        ctx.drawImage(vb.spr.img, vb.spr.sx, vb.spr.sy, vb.spr.sw, vb.spr.sh,
          vb.x - dw * vb.spr.ax, vb.y - dh * vb.spr.ay, dw, dh);
        /* Кайма идёт по УМЕНЬШЕННОМУ кадру проявления, а не по полному:
           иначе первые полсекунды вокруг новорождённого висел бы большой
           цветной контур от спрайта, которого ещё нет. */
        self.drawSpriteOutline(ctx, {
          spr: vb.spr, dx: vb.x - dw * vb.spr.ax, dy: vb.y - dh * vb.spr.ay,
          dw: dw, dh: dh
        }, self.teamColorFor(v.owner, 0.9), 1.1, edgeClip);
        ctx.restore();
        return;
      }
      /* Вздрагивание: сдвиг вбок на пару пикселей. Только картинка, не
         координаты жителя — иначе он «прыгал» бы по карте. */
      if (v.flinch > 0) {
        var shake = Math.sin(self.time * 140) * Math.max(1, z * 0.03);
        ctx.save();
        ctx.translate(shake, 0);
        ctx.drawImage(vb.spr.img, vb.spr.sx, vb.spr.sy, vb.spr.sw, vb.spr.sh,
          vb.dx, vb.dy, vb.dw, vb.dh);
        self.drawSpriteOutline(ctx, vb, self.teamColorFor(v.owner, 0.9), 1.1, edgeClip);
        ctx.restore();
      } else {
        ctx.drawImage(vb.spr.img, vb.spr.sx, vb.spr.sy, vb.spr.sw, vb.spr.sh,
          vb.dx, vb.dy, vb.dw, vb.dh);
        self.drawSpriteOutline(ctx, vb, self.teamColorFor(v.owner, 0.9), 1.1, edgeClip);
      }
    });
  };

  // Одна постройка. alpha < 1 — призрак под курсором.
  Renderer.prototype.drawBuilding = function (ctx, b, z, alpha) {
    var box = this.buildingBox(b, z);
    if (!box) return null;
    /* Прозрачность постройки — это ещё и признак «её правят»: blinkAlpha
       умножается на переданную прозрачность, а не заменяет её, иначе призрак
       размещения перестал бы быть призраком, стоило открыть режим правки. */
    var a = (alpha === undefined ? 1 : alpha) * this.blinkAlpha(b, this.time);
    var old = ctx.globalAlpha;
    if (a < 1) ctx.globalAlpha = old * a;
    /* Вздрагивание от удара: короткий сдвиг вбок, не смена кадра. Полоса
       здоровья и опора спрайта остаются на месте — трясётся только картинка. */
    var fl = b.flinch > 0 ? Math.sin(this.time * 130) * Math.max(1, z * 0.035) : 0;
    if (fl) {
      ctx.save();
      ctx.translate(fl, 0);
    }
    ctx.drawImage(box.spr.img, box.spr.sx, box.spr.sy, box.spr.sw, box.spr.sh,
      box.dx, box.dy, box.dw, box.dh);
    /* Цветная кайма — ПОВЕРХ спрайта: она должна лечь на чёрный контур
       атласа, а не спрятаться под ним. Внутри кадра она прозрачна. */
    var owner = b.owner === undefined ? 0 : b.owner;
    this.drawSpriteOutline(ctx, box, this.teamColorFor(owner, 1), 1.4);
    if (fl) ctx.restore();
    ctx.globalAlpha = old;
    return box;
  };

  /* Прозрачность постройки в этот момент времени: 1 у всех, кроме правимой.
     Ведёт признак игра (renderer.editing), рендер только читает — иначе о том,
     что постройку правят, знали бы два места, и они разошлись бы. Числа
     (BLINK_*) живут здесь, рядом с рисованием: их читает и приёмка. */
  Renderer.prototype.blinkAlpha = function (b, time) {
    if (b !== this.editing) return 1;
    // Настройка спрашивается один раз на кадр (правимая постройка одна).
    if (global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return BLINK_STILL;
    }
    var t = time === undefined ? this.time : time;
    return BLINK_MIN + (BLINK_MAX - BLINK_MIN) *
      (0.5 + 0.5 * Math.sin(2 * Math.PI * t / BLINK_PERIOD));
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
  /* Предпросмотр всей серии: пятно КАЖДОГО кандидата. Один призрак
     (renderer.ghost) остаётся у негодной серии — он показывает, во что она
     упёрлась; здесь же вся картина «сколько и где встанет». Цвет — ответ
     движка: ok && afford зелёный, иначе красный (серия не встанет целиком).
     Номера рисуются, только когда их можно прочесть: до 20 штук и при
     достаточном зуме. */
  Renderer.prototype.drawLineGhost = function (ctx) {
    var g = this.lineGhost;
    if (!g || !g.items || !g.items.length || !this.world) return;
    var B = global.Buildings;
    if (!B || !B.make) return;
    var z = this.cam.zoom;
    var ok = g.ok !== false;
    var fill = ok ? 'rgba(126,232,164,0.20)' : 'rgba(240,104,86,0.24)';
    var stroke = ok ? 'rgba(206,255,224,0.50)' : 'rgba(255,190,180,0.55)';
    var i, it, b;
    for (i = 0; i < g.items.length; i++) {
      it = g.items[i];
      if (!it) continue;
      b = it.b || (B.make ? B.make({
        type: it.type || g.type,
        variant: it.variant || g.variant,
        rot: it.rot === undefined || it.rot === null ? g.rot : it.rot,
        x: it.x, y: it.y
      }) : null);
      if (!b) continue;
      this.drawFootprint(ctx, b, { fill: fill, stroke: stroke });
    }
    if (z > 8 && g.items.length <= 20) {
      ctx.save();
      ctx.font = '700 11px -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (i = 0; i < g.items.length; i++) {
        it = g.items[i];
        if (!it) continue;
        var fp = B.footprint(it.rot === undefined || it.rot === null ? g.rot : it.rot,
          it.type || g.type);
        var cx = this.sx(it.x + fp.w / 2, it.y + fp.h / 2);
        var cy = this.sy(it.x + fp.w / 2, it.y + fp.h / 2);
        ctx.fillStyle = 'rgba(24,19,12,0.55)';
        ctx.fillText(String(i + 1), cx + 1, cy + 1);
        ctx.fillStyle = ok ? '#eafff2' : '#ffd9d2';
        ctx.fillText(String(i + 1), cx, cy);
      }
      ctx.restore();
    }
  };

  Renderer.prototype.drawGhost = function (ctx) {
    var g = this.ghost;
    if (!g || !g.b || !this.world) return;
    var B = global.Buildings;
    /* Пятно — по типу постройки: у дома оно 2 x 3, и ратушное 4 x 3 здесь
       нарисовало бы чужой прямоугольник. Постройка без типа и раньше считалась
       ратушей — footprint() про это знает. */
    var fp = B.footprint(g.b.rot, g.b.type);

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

    /* Полупрозрачный спрайт рисуется только у ПРИЗРАКА РАЗМЕЩЕНИЯ: там здания
       на карте ещё нет, и призрак — единственное, что показывает, что ставится.
       У правки (footprintOnly) здание уже стоит там, куда его ведут (его
       подвинул setSpot), и второй его спрайт был бы двойником: два дома в
       полуклетке друг от друга. Пятно, клетки помех и подпись размера при этом
       нужны те же — по ним игрок и выбирает место. */
    if (!g.footprintOnly) this.drawBuilding(ctx, g.b, this.cam.zoom, 0.62);

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

  /* Пятно ПРАВИМОЙ постройки: зелёный контур — место годится, красный — нет.

     Пока здание ведут за курсором, пятно рисует призрак (drawGhost): он знает
     и место, и запреты, и размер. Стоит здание — призрака нет, и пятно
     приходится рисовать здесь. «Годится или нет» спрашивается у ДВИЖКА
     (Buildings.canApply по тому же списку построек) — рендер своё правило не
     считает, иначе на карте был бы один ответ, а у кнопки «Применить» другой. */
  Renderer.prototype.drawEditing = function (ctx) {
    var b = this.editing;
    if (!b || !global.Buildings || !this.world) return;
    if (this.ghost && this.ghost.b === b) return;   // пятно уже нарисовано
    var chk = global.Buildings.canApply
      ? global.Buildings.canApply(this.world, this.buildings, b)
      : { ok: true };
    var ok = !!chk.ok;
    this.drawFootprint(ctx, b, {
      fill: ok ? 'rgba(126,232,164,0.16)' : 'rgba(240,104,86,0.20)',
      stroke: ok ? 'rgba(206,255,224,0.45)' : 'rgba(255,190,180,0.45)',
      edge: ok ? 'rgba(232,255,240,0.95)' : 'rgba(255,150,136,0.95)',
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
    if (!isFinite(this.cam.x) || !isFinite(this.cam.y) ||
        !isFinite(this.cam.zoom) || this.cam.zoom <= 0) {
      this.cam.zoom = this.minZoom || MIN_ZOOM;
      this.cam.x = w.width / 2;
      this.cam.y = w.height / 2;
      if (!cells || !cells.length) return;
    }
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
    TEX_REPEAT: TEX_REPEAT,
    // Числа земли — наружу: по ним приёмка (tools/ground.js) считает, где
    // искать участок и какой ширины ждать пляж, вместо копии чисел в тесте.
    PLOT_INSET: PLOT_INSET,
    BEACH_W: BEACH_W,
    BEACH_CORE: BEACH_CORE,
    BEACH_FRINGE: BEACH_FRINGE
  };
})(typeof window !== 'undefined' ? window : globalThis);
