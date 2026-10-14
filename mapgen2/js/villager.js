/* villager.js — житель: идёт к ближайшему дереву и рубит его.

   Житель — не игрок и не постройка. Кликом его не послать: как только он
   появился на сцене, он сам находит ближайшее дерево, сам идёт к нему и,
   дойдя, РУБИТ его топором пять секунд — после чего дерево падает, а он идёт
   к следующему. Это первый объект в игре, у которого своё ПОВЕДЕНИЕ, а не своё
   место на карте.

   Четыре вещи, которые определяют, как он это делает:

   1. ЦЕЛЬ — БЛИЖАЙШЕЕ ДЕРЕВО, до которого есть путь. Деревья перебираются по
      воздушному расстоянию, и берётся первое, к которому поиск нашёл дорогу:
      дерево на соседнем островке по линейке ближе, но дойти до него нельзя, и
      «ближайшее» без этой оговорки было бы неправдой. Он идёт не к центру
      дерева (там ствол), а на свободную клетку рядом с ним — с той стороны,
      откуда путь короче.

   2. ИДЁТ ОН ПО ПРЯМОЙ, А НЕ ПО КЛЕТКАМ. Путь считается поиском (A*) по
      клеткам суши — в восемь сторон, с запретом срезать угол, — а потом
      распрямляется: из цепи клеток выбираются самые дальние узлы, до которых
      прямая не задевает ни воды, ни дерева, ни пятна постройки. Идти по такой
      цепи — значит идти отрезками по прямой; на клеточной лесенке (ходьба
      из центра клетки в центр соседней) человека мотало бы зигзагом.

      Прямую проверяет ОБХОД ОТРЕЗКА ПО КЛЕТКАМ (lineClear): в путь попадает
      каждая клетка, которую отрезок задевает, включая задетые углом. Поэтому
      «не заходит в море» — свойство самого пути, а не проверка на каждом шаге,
      и дом на пути он обходит, а не проходит сквозь него.

   3. ОН ПОВЁРНУТ ТУДА, КУДА ИДЁТ, а не по четырём осям. Курс — угол в
      градусах (0 = +X), и он свободный: это 3D-модель, повернуть её можно на
      любой угол. В атласе поворотов конечное число (сейчас восемь, через 45°),
      поэтому для рисования курс округляется до ближайшего кадра — но не
      наоборот: походка не подстраивается под атлас. Дойдя, он доворачивается
      на дерево — точно, а не «примерно в ту сторону».

   4. ДОЙДЯ, ОН РУБИТ ДЕРЕВО, А НЕ ОТДЫХАЕТ. Пять секунд он стоит на месте:
      рубить — это стоять и бить, шага в этой анимации нет. Удар наносится
      ровно один на кадр удара (третья анимация атласа, `work`), дерево от
      каждого удара вздрагивает (js/render.js: treeShake), а на восьмом ударе —
      он же ровно пятая секунда рубки — дерево падает, и житель идёт к
      следующему. Пока деревья есть, он не останавливается.

   Разбирает атлас общий с лесорубом код (js/hero.js). Формат у них один:
   idle / walk / work по 6..8 кадров на поворот, клетка 112 x 132, опора
   57,107 — земля между ступнями. Числа формата общие, и код на них один; а
   вот РАЗМЕР человечка на карте — решение игры (SHRINK ниже), и оно у жителя
   своё. */
(function (global) {
  'use strict';

  /* Во сколько раз человечек мельче крупности мира.

     Решение заказчика (2026-10-13): «персонаж в игре слишком большой,
     уменьшить его в масштабе в 2.2 раза». Было из чего: при крупности
     растительности (app.js: 1.35) фигура занимала на экране 1.18 клетки —
     выше дверного проёма дома (0.70) почти вдвое и вровень с его карнизом
     (1.51). Стало 1.18 / 2.2 = 0.54 клетки (в юнитах мира 0.985 / 2.2).

     Крупность растительности и поле mul атласа при этом НЕ тронуты: атлас
     описывает, как кадр модели ложится в мир (и обязан совпадать с деревьями,
     рядом с которыми человечек стоит), а размер человека — решение игры.
     Лесоруб (assets/hero) остаётся на 1.35: заказчик решил уменьшать только
     жителя, поэтому до его решения двое людей читаются разным ростом. */
  var SHRINK = 2.2;

  /* Скорость шага. Считается не «на глаз», а из анимации: шаг человека —
     примерно 0.42 его роста, рост в этой игре — ровно одна клетка (канон:
     «человек 1.0 юнита, дверь 0.72»), а в цикле ходьбы 8 кадров при 12 к/с
     укладываются два шага. Отсюда 2 x 0.42 / (8/12) = 1.26 клетки в секунду.
     На скорости лесоруба (1.7) ноги едут по земле — это видно на бегу.

     При уменьшении фигуры шаг делится на ТОТ ЖЕ множитель, и это не «на
     глаз»: замер опорной ноги по кадрам walk (villager/tools/gait_probe.py)
     даёт 0.253 юнита за полуцикл при размахе ступни 0.349 за цикл, то есть
     рисунок походки целиком задан анимацией. Поделив и рост, и путь за
     секунду на одно число, мы сохраняем отношение «шаг/рост» — на экране
     походка та же, просто в 2.2 раза мельче.

     Числа обновлены 2026-10-13 вместе с починкой шага (villager/README.md,
     находка 5): было 0.207 за полуцикл при размахе 0.47. Тогда опорная ступня
     не ехала назад, а качалась на месте — «шаг» был нарисован, но механики в
     нём не было, и мерить его было нечего. Скорость при этом НЕ менялась:
     заказчик её не просил, а 0.253 ближе к заложенным 0.42, чем прежние
     0.207. Если на экране ступни поедут по земле — SPEED двигается ровно во
     столько же раз, во сколько разошёлся замер. */
  var SPEED = 1.26 / SHRINK;

  var ARRIVE = 0.02;       // ближе этого точка пути считается пройденной
  var TREE_TRIES = 24;     // сколько ближайших деревьев перебрать, если путь не нашёлся
  var ESCAPE = 12;         // на сколько клеток искать выход, если житель оказался в занятой
  var CORNER = 1e-9;       // щель между «идём прямо» и «уже пришли» в арифметике

  /* Сколько житель рубит дерево, прежде чем оно упадёт.

     Заказчик (2026-10-14): «рубил его 5 секунд а потом дерево исчезало».
     Число это не «примерно пять»: удар в анимации работы стоит на фазе 0.50
     (villager/tools/poses.py: WORK), кадров в ней 8 при 12 к/с, значит удары
     ложатся через 2/3 секунды — 0.333, 1.000, 1.667, ... Восьмой удар
     приходится РОВНО на 5.000 с, и дерево падает на нём: пять секунд рубки —
     это восемь ударов, а не «пять секунд, когда получится». */
  var CHOP_TIME = 5.0;
  var CHOP_HIT = 0.5;      // фаза кадра удара в анимации работы
  var CHOP_EPS = 1e-3;     // запас на сложение dt: 5.000 против 4.9999999

  /* На сколько житель придвигается к стволу, встав под дерево.

     С середины соседней клетки топор до ствола НЕ ДОСТАЁТ, и это замер, а не
     ощущение: кромка топора в ударе уходит вперёд на 0.47 юнита от опоры
     (villager/tools/axe_probe.py — считает по геометрии в кадре удара), а кора
     ближней стороны ствола стоит на 0.88 (ствол дерева в атласе 17..29 px на
     96 ppu = 0.18..0.30 юнита в поперечнике, опора спрайта — центр клетки).
     Сдвиг 0.30 оставляет 0.11 юнита: топор достаёт до коры, а житель остаётся
     в СВОЕЙ клетке (0.30 < 0.5), поэтому все проверки «что под ним» и разбор
     клеток не меняются. */
  var STAND_OFF = 0.30;
  var STAND_MAX = 0.45;    // дальше — уже чужая клетка (клетка дерева), туда нельзя

  /* Восемь сторон света в клетках. Первые четыре — по осям, остальные —
     диагонали: диагональ дороже (√2) и разрешена только тогда, когда свободны
     обе смежные по осям клетки (иначе житель срезал бы угол дома). */
  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  var DIAG = [false, false, false, false, true, true, true, true];
  var SQ2 = Math.SQRT2;

  /* -------------------------------- атлас -------------------------------- */

  function joinPath(base, rel) {
    if (!base) return rel;
    return base.charAt(base.length - 1) === '/' ? base + rel : base + '/' + rel;
  }

  /* Как у героя и ратуши: сначала готовый скрипт (работает по file://),
     затем JSON — запасной путь для http-сервера. */
  function load(opts, onReady, onError) {
    opts = opts || {};
    var base = opts.base || 'assets/';
    var dir = opts.dir || 'villager/';
    var meta = global.VILLAGER_ATLAS;
    if (meta) { loadImage(meta, base, dir, onReady, onError); return; }
    if (typeof fetch !== 'function') { onError(new Error('нет ни atlas.js жителя, ни fetch')); return; }
    fetch(joinPath(base, dir + 'atlas.json')).then(function (r) {
      if (!r.ok) throw new Error('villager/atlas.json: HTTP ' + r.status);
      return r.json();
    }).then(function (json) {
      global.VILLAGER_ATLAS = json;
      loadImage(json, base, dir, onReady, onError);
    }).catch(onError);
  }

  function loadImage(meta, base, dir, onReady, onError) {
    var src = joinPath(base, dir + meta.atlas);
    var img = new Image();
    img.onerror = function () { onError(new Error('не загрузился атлас жителя: ' + src)); };
    img.onload = function () { onReady(build(img, meta)); };
    img.src = src;
  }

  // Набор кадров — тем же кодом, что у лесоруба: формат атласа общий.
  // Скольких поворотов он ни был бы — разбор один (js/hero.js: build).
  function build(img, meta) { return global.Hero.build(img, meta); }

  // Кадр по состоянию жителя — общий с лесорубом, а масштаб кадра — свой:
  // крупность мира из атласа делится на SHRINK (см. выше).
  function sprite(set, v) { return global.Hero.sprite(set, v); }
  function scaleAt(set, z) { return global.Hero.scaleAt(set, z) / SHRINK; }

  /* ------------------------------ что мешает ----------------------------- */

  /* Дерево и камень занимают клетку целиком: лес — не газон, сквозь него не
     ходят. Галька, кусты, трава и цветы не мешают — по ним и ходят. */
  function solidObject(o) {
    if (o.kind === 'tree') return true;
    if (o.kind === 'stone') return o.variant !== 'pebble';
    return false;
  }

  /* Карта занятых клеток: суша отдельно (она в world.isLand), поверх неё —
     то, что стоит. Собирается один раз на мир и пересобирается, когда мир
     изменился: срубили дерево, поставили ратушу. Пересобирать её на каждый
     шаг жителя нельзя — это проход по тысячам объектов в секунду.

     Ключ версии — длины списков: и дерево, и постройка меняют её своим
     появлением или исчезновением, а переставить постройку, не тронув длину,
     в игре нечем. */
  function blockedMap(world, buildings) {
    var list = buildings || [];
    var ver = world.objects.length + '/' + list.length;
    var m = world._villagerBlocked;
    if (m && m.version === ver) return m.solid;

    var W = world.width, H = world.height;
    var solid = new Uint8Array(W * H);
    var i, o, cells, c;
    for (i = 0; i < world.objects.length; i++) {
      o = world.objects[i];
      if (!solidObject(o)) continue;
      var ox = Math.floor(o.x), oy = Math.floor(o.y);
      if (ox < 0 || oy < 0 || ox >= W || oy >= H) continue;
      solid[oy * W + ox] = 1;
    }
    var B = global.Buildings;
    if (B) {
      for (i = 0; i < list.length; i++) {
        cells = B.cells(list[i]);
        for (c = 0; c < cells.length; c++) {
          var cx = cells[c].x, cy = cells[c].y;
          if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
          solid[cy * W + cx] = 1;      // в доме житель не живёт
        }
      }
    }
    m = world._villagerBlocked = { version: ver, solid: solid };
    return solid;
  }

  // Клетка, по которой можно идти: суша и ничего не стоит.
  function walkable(world, solid, cx, cy) {
    if (cx < 0 || cy < 0 || cx >= world.width || cy >= world.height) return false;
    var i = cy * world.width + cx;
    return !!world.isLand[i] && !solid[i];
  }

  /* ------------------------------ поиск пути ----------------------------- */

  /* A* по клеткам. Ходьба в восемь сторон, оценка — октильная
     (max + (√2−1)·min): она кратчайший путь не завышает, поэтому первый
     найденный путь и есть кратчайший. Именно поэтому обход ратуши выходит
     БЛИЖАЙШИМ путём к дереву, а не «каким-нибудь»: поиск не перебирает
     варианты, а считает длину.

     Кучи и таблицы заводятся на один поиск, а поиск идёт раз на появление
     жителя, а не раз на кадр: 128 x 128 клеток — это доли миллисекунды. */
  function findPath(world, solid, sx, sy, tx, ty) {
    var W = world.width, H = world.height, N = W * H;
    if (sx === tx && sy === ty) return null;
    if (!walkable(world, solid, sx, sy) || !walkable(world, solid, tx, ty)) return null;

    var start = sy * W + sx, goal = ty * W + tx;
    var g = new Float64Array(N);         // 0 = «ещё не дошли»: вход в клетку стоит >= 1
    var came = new Int32Array(N);
    var closed = new Uint8Array(N);

    /* Двоичная куча: индексы клеток и их оценки. Растёт по надобности —
       клетка может попасть в кучу больше одного раза (зашли дешевле), а
       лишнее отсеет closed. Ставить потолок «на глаз» тут нечего. */
    var heap = new Int32Array(1024), hf = new Float64Array(1024), hn = 0;

    function grow() {
      var h2 = new Int32Array(heap.length * 2); h2.set(heap); heap = h2;
      var f2 = new Float64Array(hf.length * 2); f2.set(hf); hf = f2;
    }

    function push(i, f) {
      if (hn >= heap.length) grow();
      var c = hn++;
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

    function pop() {
      var top = heap[0];
      hn--;
      heap[0] = heap[hn]; hf[0] = hf[hn];
      var c = 0;
      for (;;) {
        var l = c * 2 + 1, r = l + 1, s = c;
        if (l < hn && hf[l] < hf[s]) s = l;
        if (r < hn && hf[r] < hf[s]) s = r;
        if (s === c) break;
        var ti = heap[s], tf = hf[s];
        heap[s] = heap[c]; hf[s] = hf[c];
        heap[c] = ti; hf[c] = tf;
        c = s;
      }
      return top;
    }

    function h(i) {
      var x = i % W, y = (i / W) | 0;
      var ax = Math.abs(x - tx), ay = Math.abs(y - ty);
      return ax > ay ? ax + (SQ2 - 1) * ay : ay + (SQ2 - 1) * ax;
    }

    g[start] = 1;                        // 1, а не 0: ноль значит «не посещали»
    came[start] = -1;
    push(start, h(start));

    var found = false;
    while (hn > 0) {
      var cur = pop();
      if (cur === goal) { found = true; break; }
      if (closed[cur]) continue;
      closed[cur] = 1;

      var cx = cur % W, cy = (cur / W) | 0;
      for (var d = 0; d < 8; d++) {
        var dx = DIRS[d][0], dy = DIRS[d][1];
        var nx = cx + dx, ny = cy + dy;
        if (!walkable(world, solid, nx, ny)) continue;
        // Угол дома не срезаем: диагональ — только между двумя свободными.
        if (DIAG[d] && (!walkable(world, solid, cx + dx, cy) ||
                        !walkable(world, solid, cx, cy + dy))) continue;
        var ni = ny * W + nx;
        if (closed[ni]) continue;
        var ng = g[cur] + (DIAG[d] ? SQ2 : 1);
        if (g[ni] && ng >= g[ni] - CORNER) continue;
        g[ni] = ng;
        came[ni] = cur;
        push(ni, ng + h(ni));
      }
    }
    if (!found) return null;

    // Путь собирается от цели к началу и разворачивается: житель идёт по нему
    // вперёд, и первая клетка в списке — та, на которой он стоит.
    var out = [];
    for (var i = goal; i !== -1; i = came[i]) out.push(i);
    out.reverse();
    return out;
  }

  /* --------------------- прямая через клетки (без задеваний) -------------- */

  /* Задевает ли отрезок между двумя точками занятую клетку.

     Идёт обход клеток по лучу (Amanatides & Woo): на каждом шаге луч входит
     ровно в одну следующую клетку, и она проверяется. Особый случай — луч
     проходит РОВНО через угол: тогда он задевает обе клетки, смежные с углом,
     и обе обязаны быть свободны. Без этого правила прямой путь срезал бы угол
     дома ровно по его углу, а «между узлами» житель оказался бы в стене.

     Возвращает false, если хоть одна задетая клетка занята, — и тогда прямая
     не годится, путь пойдёт в обход. */
  function lineClear(world, solid, x0, y0, x1, y1) {
    // Нечисловые концы — не «свободно»: такую прямую считать нельзя, и молчаливое
    // «да» тут дороже ошибки в вызывающем коде (на этом уже попался тест:
    // цель-объект читалась как массив, и все прямые оказались «свободны»).
    if (!isFinite(x0) || !isFinite(y0) || !isFinite(x1) || !isFinite(y1)) return false;
    var cx = Math.floor(x0), cy = Math.floor(y0);
    if (!walkable(world, solid, cx, cy)) return false;
    var dx = x1 - x0, dy = y1 - y0;
    if (!dx && !dy) return true;

    var stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    var stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    var tMaxX = stepX ? ((stepX > 0 ? cx + 1 : cx) - x0) / dx : Infinity;
    var tMaxY = stepY ? ((stepY > 0 ? cy + 1 : cy) - y0) / dy : Infinity;
    var tDeltaX = stepX ? Math.abs(1 / dx) : Infinity;
    var tDeltaY = stepY ? Math.abs(1 / dy) : Infinity;

    for (var guard = 0; guard < 100000; guard++) {
      /* Ближайшее пересечение границы клетки. Пока оно дальше конца отрезка
         (t > 1) — смотреть нечего: клетки за концом к отрезку не относятся.
         Проверять их нельзя, и это не придирка: на этом уже была ошибка —
         отрезок из центра клетки в центр соседней по диагонали задевал углом
         ровно одну границу (t = 0.5), цикл шёл дальше и браковал прямую по
         дереву, стоящему ЗА целью. Путь от этого дробился лишними точками. */
      var corner = Math.abs(tMaxX - tMaxY) < 1e-12;
      var t = corner ? tMaxX : (tMaxX < tMaxY ? tMaxX : tMaxY);
      if (t > 1) return true;

      if (corner) {                                  // ровно через угол
        if (!walkable(world, solid, cx + stepX, cy)) return false;
        if (!walkable(world, solid, cx, cy + stepY)) return false;
        cx += stepX; cy += stepY;
        tMaxX += tDeltaX; tMaxY += tDeltaY;
      } else if (tMaxX < tMaxY) {
        cx += stepX; tMaxX += tDeltaX;
      } else {
        cy += stepY; tMaxY += tDeltaY;
      }
      if (!walkable(world, solid, cx, cy)) return false;
    }
    return false;
  }

  /* Распрямление пути: из цепи клеток — в короткий список точек, между
     которыми можно идти по прямой. Берётся самый дальний узел цепи, до
     которого прямая ничего не задевает, он становится следующей точкой, и
     так до цели. Лесенка «шаг по оси, шаг по диагонали» на этом исчезает:
     через открытое поле путь становится ОДНИМ отрезком. */
  function smoothPath(world, solid, path) {
    var W = world.width;
    function px(i) { return (i % W) + 0.5; }
    function py(i) { return ((i / W) | 0) + 0.5; }

    var out = [{ x: px(path[0]), y: py(path[0]) }];
    var i = 0;
    var guard = 0;
    while (i < path.length - 1 && guard++ < 100000) {
      var j = path.length - 1;
      for (; j > i + 1; j--) {
        if (lineClear(world, solid, px(path[i]), py(path[i]), px(path[j]), py(path[j]))) break;
      }
      out.push({ x: px(path[j]), y: py(path[j]) });
      i = j;
    }
    return out;
  }

  /* ------------------------------- дерево -------------------------------- */

  /* Деревья по воздушному расстоянию от точки: ближайшее — первое. Список
     режется: если двадцать четыре ближайших дерева недостижимы (житель на
     островке без леса), то и двадцать пятое не спасёт, а перебор всех деревьев
     острова — это сотни поисков пути на ровном месте. */
  function treesNear(world, x, y, limit) {
    var all = [], i, o;
    for (i = 0; i < world.objects.length; i++) {
      o = world.objects[i];
      if (o.kind === 'tree') all.push(o);
    }
    all.sort(function (a, b) {
      return ((a.x - x) * (a.x - x) + (a.y - y) * (a.y - y)) -
             ((b.x - x) * (b.x - x) + (b.y - y) * (b.y - y));
    });
    return limit && all.length > limit ? all.slice(0, limit) : all;
  }

  /* Клетки, с которых можно встать под этим деревом: четыре соседние по осям,
     свободные, по возрастанию расстояния до жителя. Диагонали не берём: с
     угла человек стоит в 1.41 клетки от ствола и «рядом с деревом» уже не
     читается. */
  function standCells(world, solid, tree, x, y) {
    var cx = Math.floor(tree.x), cy = Math.floor(tree.y);
    var out = [];
    for (var d = 0; d < 4; d++) {
      var nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (!walkable(world, solid, nx, ny)) continue;
      out.push({
        x: nx + 0.5, y: ny + 0.5, cx: nx, cy: ny,
        d: (nx + 0.5 - x) * (nx + 0.5 - x) + (ny + 0.5 - y) * (ny + 0.5 - y)
      });
    }
    out.sort(function (a, b) { return a.d - b.d; });
    return out;
  }

  /* Выбор цели и пути к ней: ближайшее дерево, до которого есть дорога.
     Возвращает false, если деревьев нет или ни до одного не дойти, — тогда
     житель стоит и ждёт (деревья в этой игре не растут, а только исчезают). */
  function plan(v, world, solid) {
    var sx = Math.floor(v.x), sy = Math.floor(v.y);

    // Страховка: если житель оказался в занятой клетке (на его место поставили
    // дом, под ним срубили дерево) — выходим на ближайшую свободную.
    if (!walkable(world, solid, sx, sy)) {
      var out = spawnSpot(world, solid, v.x, v.y);
      if (!out) return false;
      v.x = out.x; v.y = out.y;
      sx = Math.floor(v.x); sy = Math.floor(v.y);
    }

    var trees = treesNear(world, v.x, v.y, TREE_TRIES);
    for (var i = 0; i < trees.length; i++) {
      var tree = trees[i];
      var spots = standCells(world, solid, tree, v.x, v.y);
      for (var j = 0; j < spots.length; j++) {
        // Он уже стоит под этим деревом — идти некуда, но повернуться надо.
        if (spots[j].cx === sx && spots[j].cy === sy) {
          v.tree = tree;
          v.goal = { x: spots[j].x, y: spots[j].y };
          v.close = false;
          arrive(v);
          return true;
        }
        var cells = findPath(world, solid, sx, sy, spots[j].cx, spots[j].cy);
        if (!cells || cells.length < 2) continue;
        v.tree = tree;
        v.goal = { x: spots[j].x, y: spots[j].y };
        v.path = smoothPath(world, solid, cells);
        v.step = 1;                    // 0 — клетка, в которой он стоит
        v.close = false;               // к стволу он ещё не подошёл
        v.chopT = 0;
        v.hits = 0;
        v.seen = world._villagerBlocked ? world._villagerBlocked.version : null;
        v.trips++;
        setAnim(v, 'walk');
        return true;
      }
    }
    return false;
  }

  /* Путь к произвольной клетке — тем же поиском и тем же распрямлением.
     Нужен не игре, а тестам: поставить жителя в нужную точку острова и
     проверить, что он и туда идёт, не заходя в воду и в дом. */
  function routeTo(v, world, solid, x, y) {
    var tx = Math.floor(x), ty = Math.floor(y);
    if (!walkable(world, solid, tx, ty)) return false;
    var sx = Math.floor(v.x), sy = Math.floor(v.y);
    if (sx === tx && sy === ty) return false;
    var cells = findPath(world, solid, sx, sy, tx, ty);
    if (!cells || cells.length < 2) return false;
    v.tree = null;
    v.goal = { x: tx + 0.5, y: ty + 0.5 };
    v.path = smoothPath(world, solid, cells);
    v.step = 1;
    v.close = false;
    v.seen = world._villagerBlocked ? world._villagerBlocked.version : null;
    v.state = 'toward';
    setAnim(v, 'walk');
    return true;
  }

  /* ------------------------------- появление ----------------------------- */

  /* Место появления: первая свободная клетка вокруг заданной точки. Кольца
     расширяются, пока не найдётся проход, — так житель встаёт рядом с
     ратушей, а не в её пятне и не в море за домом. Занятые другими жителями
     клетки пропускаются: двум человекам в одной клетке делать нечего. */
  function spawnSpot(world, solid, x, y, avoid) {
    var cx0 = Math.floor(x), cy0 = Math.floor(y);
    for (var r = 0; r <= ESCAPE; r++) {
      for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          var cx = cx0 + dx, cy = cy0 + dy;
          if (!walkable(world, solid, cx, cy)) continue;
          if (taken(avoid, cx, cy)) continue;
          return { x: cx + 0.5, y: cy + 0.5 };
        }
      }
    }
    return null;
  }

  function taken(list, cx, cy) {
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
      if (Math.floor(list[i].x) === cx && Math.floor(list[i].y) === cy) return true;
    }
    return false;
  }

  /* Список клеток суши — площадь острова для отчёта теста. Лежит на мире:
     мир перегенерировали — список другой, и это правильно. */
  function landCells(world) {
    if (world._villagerLand) return world._villagerLand;
    var W = world.width, H = world.height, out = [];
    for (var i = 0; i < W * H; i++) if (world.isLand[i]) out.push(i);
    return (world._villagerLand = Int32Array.from(out));
  }

  function create(world, opts) {
    opts = opts || {};
    var solid = blockedMap(world, opts.buildings);
    var spot = spawnSpot(world, solid, opts.x === undefined ? world.width / 2 : opts.x,
      opts.y === undefined ? world.height / 2 : opts.y, opts.avoid);
    if (!spot) spot = { x: opts.x || world.width / 2, y: opts.y || world.height / 2 };
    // ГПСЧ свой, от сида мира и номера жителя: тот же сид — та же прогулка.
    // Мир от этого не меняется: генератор считает своей ручкой, не этой.
    var rng = new global.RNG((world.seed || 'seed') + ':житель:' + (opts.index || 0));
    var v = {
      x: spot.x, y: spot.y,
      rot: rng.pick([0, 90, 180, 270]),
      anim: 'idle',
      phase: 0,
      // toward — идёт к дереву, chop — рубит его, stand — дерева нет, стоит
      state: 'toward',
      world: world,        // по какому миру считан путь: сменился — считаем заново
      seen: null,          // версия карты занятых клеток, на которой считан путь
      path: null,          // точки текущего перехода, по прямой между соседними
      step: 0,             // на какой точке пути стоит
      tree: null,          // дерево, к которому он идёт (или которое рубит)
      goal: null,          // клетка под деревом, куда он встанет
      close: false,        // придвинулся к стволу на STAND_OFF — можно рубить
      chopT: 0,            // сколько секунд рубит текущее дерево
      hits: 0,             // сколько ударов по нему нанёс
      trips: 0,            // переходов сделано — для отчёта
      walked: 0,           // пройдено клеток — для отчёта
      felled: 0,           // сколько деревьев срубил — для отчёта
      speed: SPEED,
      rng: rng
    };
    /* Дерево ищется СРАЗУ, ещё до первого кадра: «появился — пошёл». Паузы
       перед первым переходом нет: стоящий человек в начале партии читался бы
       так, будто он ничего не делает. */
    if (!plan(v, world, solid)) v.state = 'stand';
    return v;
  }

  /* ------------------------------- движение ------------------------------ */

  function deg(rad) { return ((rad * 180 / Math.PI) % 360 + 360) % 360; }

  function setAnim(v, anim) {
    if (v.anim === anim) return;
    v.anim = anim;
    v.phase = 0;
  }

  /* Пришёл. Здесь цель достигнута: путь забыт, житель доворачивается на
     дерево — ровно на него, а не «примерно туда» — и начинает рубить.

     Сначала он делает ПОЛШАГА к стволу (STAND_OFF): с середины клетки топор
     до дерева не достаёт. Это тот же шаг по прямой, что и весь путь, а не
     перенос координаты: иначе житель дёргался бы на полклетки в кадре
     остановки. Второй заход в arrive() (v.close уже стоит) и начинает рубку. */
  function arrive(v) {
    v.path = null;
    v.step = 0;
    if (v.tree) {
      v.rot = deg(Math.atan2(v.tree.y - v.y, v.tree.x - v.x));
      var p = v.close ? null : closeSpot(v);
      if (p && (Math.abs(p.x - v.x) > ARRIVE || Math.abs(p.y - v.y) > ARRIVE)) {
        v.close = true;
        v.path = [p];
        v.step = 0;
        setAnim(v, 'walk');
        return;
      }
    }
    if (v.tree) {
      v.state = 'chop';
      v.chopT = 0;
      v.hits = 0;
      setAnim(v, 'work');
    } else {
      v.state = 'stand';
      setAnim(v, 'idle');
    }
  }

  /* Точка, с которой топор достаёт до ствола: STAND_OFF от текущего места в
     сторону дерева. Ближе STAND_MAX не подходим — за этой границей начинается
     клетка дерева, а она занята. */
  function closeSpot(v) {
    var dx = v.tree.x - v.x, dy = v.tree.y - v.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (!(d > 1e-6)) return null;
    var k = Math.min(STAND_OFF, STAND_MAX);
    return { x: v.x + dx / d * k, y: v.y + dy / d * k };
  }

  /* Перешла ли фаза через x за этот кадр. Фаза едет по кругу (0..1), поэтому
     переход через 1 — тоже переход: без этого удар пропадал бы на кадре,
     попавшем на стык цикла. Считать удар по равенству фазы нельзя: dt дробный,
     и фаза не попадает в 0.5 ровно никогда. */
  function crossed(before, now, x) {
    if (before <= now) return before < x && x <= now;
    return before < x || x <= now;
  }

  /* Удар топором: дерево вздрагивает, а на восьмом ударе (CHOP_TIME) падает.

     Тряска — это флаг на самом дереве (shake = 1), гасит его рендер по времени
     (js/render.js: treeShake): удары идут через 2/3 секунды, и тряска успевает
     погаснуть между ними — иначе дерево дрожало бы непрерывно и «удар» перестал
     бы читаться ударом. */
  function strike(v, world) {
    v.hits++;
    if (v.tree) v.tree.shake = 1;
    if (v.chopT + CHOP_EPS >= CHOP_TIME) fell(v, world);
  }

  /* Дерево падает — ровно тем же способом, что у лесоруба (js/hero.js: fell):
     объект выкидывается из world.objects, счётчик деревьев уменьшается, кэш
     спрайта сбрасывается. Карту занятых клеток чистить не нужно: её версия —
     это ДЛИНА списка объектов (blockedMap), а длина изменилась, и она
     пересоберётся сама. */
  function fell(v, world) {
    var tree = v.tree, objs = world.objects, keep = [], i;
    for (i = 0; i < objs.length; i++) if (objs[i] !== tree) keep.push(objs[i]);
    world.objects = keep;
    if (world.stats && world.stats.trees) world.stats.trees--;
    if (tree) tree._spr = null;
    v.tree = null;
    v.goal = null;
    v.path = null;
    v.close = false;
    v.state = 'toward';        // следующее дерево он выберет сам, в update
    v.felled++;
  }

  /* Шаг по прямой к текущей точке пути. Курс — направление шага: человек
     повёрнут туда, куда идёт. */
  function walk(v, world, set, dt) {
    var wp = v.path[v.step];
    var dx = wp.x - v.x, dy = wp.y - v.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    var step = v.speed * dt;

    if (d > CORNER) v.rot = deg(Math.atan2(dy, dx));

    if (d <= step) {                   // дошли до точки: она пройдена целиком
      v.x = wp.x; v.y = wp.y;
      v.walked += d;
      v.step++;
      if (v.step >= v.path.length) { arrive(v); return; }
    } else {
      v.x += dx / d * step;
      v.y += dy / d * step;
      v.walked += step;
    }

    setAnim(v, 'walk');
    var n = Math.max(1, global.Hero.frameCount(set, 'walk'));
    v.phase = (v.phase + dt * global.Hero.fps(set, 'walk') / n) % 1;
  }

  /* Один кадр жизни жителя. Здесь только состояние и время: рисование живёт
     в render.js, а кто и когда его создал — в app.js. */
  function update(v, world, set, dt, opts) {
    if (!v || !world) return;
    var solid = blockedMap(world, opts && opts.buildings);

    // Мир сменился (нажали «Сгенерировать»): путь считан по клеткам старого
    // острова, и по нему житель пошёл бы по воде. Считаем заново.
    if (v.world !== world) {
      v.world = world; v.path = null; v.close = false; v.chopT = 0;
      v.state = 'toward';
    }

    /* Мир мог смениться и под ногами: срубили дерево, поставили ратушу — в том
       числе поперёк уже проложенного пути. Проверяется это НЕ каждый кадр, а
       когда сменилась карта занятых клеток (её версия — длина списков): в
       обычном кадре сравнение одной строки, а в изменившемся пересчитывается
       текущий отрезок — не задевает ли он новую стену. Не задевает — идём
       дальше как шли; задевает — маршрут считается заново. */
    var ver = world._villagerBlocked ? world._villagerBlocked.version : null;
    if (v.seen !== ver) {
      v.seen = ver;
      var here = !walkable(world, solid, Math.floor(v.x), Math.floor(v.y));
      var next = v.path ? v.path[v.step] : null;
      var cut = next && (!walkable(world, solid, Math.floor(next.x), Math.floor(next.y)) ||
                         !lineClear(world, solid, v.x, v.y, next.x, next.y));
      if (here || cut) {
        v.path = null;
        v.close = false;
        v.state = 'toward';        // дом поставили на него или поперёк дороги
      }
    }

    if (v.state === 'chop') {          // дошёл: рубит дерево (CHOP_TIME секунд)
      if (!v.tree || world.objects.indexOf(v.tree) < 0) {
        // дерево уже срубили — своё или чужое (лесоруб успел первым, второй
        // житель бьёт то же дерево): идём выбирать следующее
        v.tree = null;
        v.path = null;
        v.close = false;
        v.state = 'toward';
        return;
      }
      setAnim(v, 'work');
      var n = Math.max(1, global.Hero.frameCount(set, 'work'));
      var before = v.phase;
      v.phase = (v.phase + dt * global.Hero.fps(set, 'work') / n) % 1;
      v.chopT += dt;
      if (crossed(before, v.phase, CHOP_HIT)) strike(v, world);
      return;
    }

    if (v.state === 'stand') {         // дерева нет (или до него не дойти): стоит
      setAnim(v, 'idle');
      var n2 = Math.max(1, global.Hero.frameCount(set, 'idle'));
      v.phase = (v.phase + dt * global.Hero.fps(set, 'idle') / n2) % 1;
      return;
    }

    if (!v.path) {
      if (!plan(v, world, solid)) { v.state = 'stand'; return; }
    }
    walk(v, world, set, dt);
  }

  global.Villagers = {
    load: load, build: build, create: create, update: update,
    sprite: sprite, scaleAt: scaleAt,
    findPath: findPath, smoothPath: smoothPath, lineClear: lineClear,
    routeTo: routeTo, plan: plan, treesNear: treesNear, standCells: standCells,
    closeSpot: closeSpot, crossed: crossed, strike: strike, fell: fell,
    walkable: walkable, blockedMap: blockedMap,
    spawnSpot: spawnSpot, landCells: landCells, solidObject: solidObject,
    SPEED: SPEED, SHRINK: SHRINK, ARRIVE: ARRIVE, TREE_TRIES: TREE_TRIES,
    CHOP_TIME: CHOP_TIME, CHOP_HIT: CHOP_HIT, STAND_OFF: STAND_OFF
  };
})(typeof window !== 'undefined' ? window : globalThis);
