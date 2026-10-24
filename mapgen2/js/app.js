/* app.js — склейка: параметры, камера, ввод, миникарта, цикл отрисовки. */
(function (global) {
  'use strict';

  var WG = global.WorldGen;

  var $ = function (id) { return document.getElementById(id); };

  /* Ратуша игрока — та же, что в игре (game/index.html): вариант C и поворот
     на 90°. Число живёт в js/session.js, чтобы обе оболочки ставили одну и
     ту же ратушу; здесь только ссылка на него. */
  var HOME = global.Session.HOME;

  var view = $('view');
  var renderer = new global.Render.Renderer(view);
  var mm = $('mm');
  var mmCtx = mm.getContext('2d');
  var hudText = $('hudText');

  var world = null;
  var needFrame = true;
  var texturesLoaded = false;
  var urlSeed = null;

  /* --------------------------- постройки --------------------------- */

  var buildings = [];                       // поставленные ратуши
  var villagers = [];                       // жители: ходят сами (js/villager.js)
  /* Призрак и постановка мышью: вариант, поворот, расчистка. Поворот по
     умолчанию — общий для всех построек FACE_ROT (лицом вправо-вниз): игрок
     ставит дом таким, каким его видно, а повернуть может Q/E или чипами.
     Число берётся у движка построек — js/buildings.js подключается раньше
     (см. порядок тегов в index.html), и правило поворота живёт только там. */
  var place = {
    on: false, variant: 'a', rot: global.Buildings.FACE_ROT,
    clear: true, strict: false
  };
  var ghost = null;                         // призрак под курсором

  /* Атлас ратуши: панель размещения ставит только её, и «есть ли что ставить»
     спрашивается у набора по типу, а не у рендера целиком (js/render.js:
     spritesFor). Деревня на старте ставится из js/session.js — панель в это
     не вмешивается. */
  function homeSprites() {
    return renderer.spritesFor(global.Buildings.DEFAULT_TYPE);
  }

  function placeOpts() {
    // yard — клетка вокруг пятна: и в неё смотрит расчистка, и она же
    // попадает в предупреждение (дерево вплотную к стене читается как ошибка
    // кадра). Число берётся у движка (js/buildings.js: YARD): им же меряет
    // отрисовка, закрывая мелочь под призраком и под вставшим домом.
    // Кусты и трава в счёт не идут вовсе — они не помеха, их сминает
    // постановка (js/buildings.js: obstacle, settle).
    // clear — то же, что clearable, но про ДЕЙСТВИЕ: «расчистить ли площадку,
    // когда дом встанет». Разрешение спрашивают один раз, а читают его двое
    // (проверка места и settle), поэтому числа два, а галочка одна.
    return { clearable: place.clear, requireClear: place.strict,
             yard: global.Buildings.YARD, clear: place.clear };
  }

  function applyBuildings() {
    renderer.setBuildings(buildings);
    refreshGhost();
    updatePlaceInfo();
    needFrame = true;
  }

  /* ---------------------------- жители ---------------------------- */

  /* Жителя создаёт и ведёт js/session.js: партия у генератора и у игры одна
     и та же, и «житель вышел из ратуши и пошёл рубить» — её часть, а не
     особенность панели. Здесь остаются имена, которыми пользуются панель и
     автотесты. */
  function spawnVillagers(home) {
    villagers = global.Session.spawnVillagers(world, renderer, buildings, home);
    return villagers.length;
  }

  var felledSeen = 0;          // сколько деревьев срублено на прошлом шаге (см. ниже)

  function stepVillagers(dt) {
    if (!world || !villagers.length) return 0;
    var felled = global.Session.stepVillagers(villagers, world, renderer, dt, buildings);
    /* Срубленное дерево — это минус дерево в мире, и панель обязана это
       показать. Обновляем её только когда счёт ДЕЙСТВИТЕЛЬНО изменился: житель
       валит дерево раз в 10..20 секунд (пять секунд рубки плюс дорога), а
       панель — это шесть записей в DOM, и дёргать их каждый кадр незачем. */
    if (felled !== felledSeen) {
      felledSeen = felled;
      if (world.stats) updateStats();
    }
    return villagers.length;
  }

  // Призрак пересчитывается от клетки под курсором: та клетка, на которую
  // указывает мышь, — верхний угол пятна, дальше здание уходит вправо и вниз.
  function refreshGhost() {
    if (!place.on || !world || !renderer.hover) {
      ghost = null;
      renderer.ghost = null;
      updatePlaceInfo();
      return;
    }
    var b = { variant: place.variant, rot: place.rot, x: renderer.hover.x, y: renderer.hover.y };
    var chk = global.Buildings.canPlace(world, buildings, b, placeOpts());
    ghost = { b: b, ok: chk.ok, reason: chk.reason, blocked: chk.blocked };
    renderer.ghost = ghost;
    var fp = global.Buildings.footprint(place.rot);
    hudText.textContent = b.x + ', ' + b.y + ' · ратуша ' + fp.w + ' × ' + fp.h + ' · ' +
      (chk.ok ? chk.reason : 'нельзя: ' + chk.reason);
    updatePlaceInfo();
    needFrame = true;
  }

  function updatePlaceInfo() {
    var el = $('placeInfo');
    if (!el) return;
    if (!homeSprites()) {
      el.textContent = 'Спрайты ратуши не загрузились';
      el.className = 'place-info bad';
      return;
    }
    if (!place.on) {
      el.textContent = 'Режим размещения выключен';
      el.className = 'place-info';
      return;
    }
    var fp = global.Buildings.footprint(place.rot);
    var head = 'Ратуша ' + String.fromCharCode(64 + 'abc'.indexOf(place.variant) + 1) +
      ' · ' + fp.w + ' × ' + fp.h;
    if (!ghost) { el.textContent = head + ' · наведите на карту'; el.className = 'place-info'; return; }
    el.textContent = head + ' · ' + ghost.reason;
    el.className = 'place-info ' + (ghost.ok ? (ghost.blocked.length ? 'warn' : 'ok') : 'bad');
  }

  function setPlaceMode(on) {
    // Без атласа ратуши режим включать нечем: пятно рисовалось бы, а ставить
    // было бы нечего. Кнопка в панели в этом случае тоже заблокирована.
    if (on && !homeSprites()) return;
    place.on = !!on;
    renderer.selected = null;
    $('thPlace').classList.toggle('active', place.on);
    view.classList.toggle('placing', place.on);
    refreshGhost();
    needFrame = true;
  }

  function setVariant(v) {
    place.variant = v;
    var chips = $('thVariants').children;
    for (var i = 0; i < chips.length; i++) chips[i].classList.toggle('active', chips[i].dataset.variant === v);
    refreshGhost();
    needFrame = true;
  }

  function setRotation(rot) {
    place.rot = ((rot % 360) + 360) % 360;
    var chips = $('thRots').children;
    for (var i = 0; i < chips.length; i++) chips[i].classList.toggle('active', +chips[i].dataset.rot === place.rot);
    refreshGhost();
    needFrame = true;
  }

  function rotate(delta) { setRotation(place.rot + delta); }

  // Ставит ратушу в пятно. Возвращает false, если место не годится —
  // вызывающий сам решает, что об этом сказать.
  function placeAt(b) {
    /* Постройка заводится через make, и проверяется ровно то, что ляжет в
       список: классификатор (kind), целые x/y и поворот из четвертей — его
       работа, а не панели. Одно место создания на весь движок: по kind
       постройку отличают от ландшафта и выбор мышью, и режим правки игры. */
    var made = global.Buildings.make(b);
    var chk = global.Buildings.canPlace(world, buildings, made, placeOpts());
    if (!chk.ok) return false;
    /* Постройка встала — и вместе с ней решается судьба того, что под ней:
       расчистка, если игрок её разрешил, и всегда — смятие мелочи (куст под
       домом рисуется поверх стены). Правило это движковое: js/buildings.js,
       settle. */
    global.Buildings.settle(world, made, placeOpts());
    buildings.push(made);
    applyBuildings();
    updateStats();
    return true;
  }

  function buildingUnder(cell) {
    return renderer.buildingAt(cell.x, cell.y);
  }

  function removeBuilding(b) {
    var i = buildings.indexOf(b);
    if (i < 0) return false;
    buildings.splice(i, 1);
    if (renderer.selected === b) renderer.selected = null;
    applyBuildings();
    updateStats();
    return true;
  }

  function removeLast() {
    if (!buildings.length) return;
    removeBuilding(renderer.selected && buildings.indexOf(renderer.selected) >= 0
      ? renderer.selected : buildings[buildings.length - 1]);
  }

  function clearBuildings() {
    if (!buildings.length) return;
    buildings = [];
    renderer.selected = null;
    applyBuildings();
    updateStats();
  }

  function placeAllThree() {
    // Поворот не задаём: «все три» встают так же, как всё остальное на карте, —
    // лицом вправо-вниз, а это правило живёт в js/buildings.js (FACE_ROT).
    var spots = global.Buildings.placeAll(world, {
      clear: place.clear, clearable: place.clear, requireClear: place.strict,
      variants: ['a', 'b', 'c']
    });
    for (var i = 0; i < spots.length; i++) buildings.push(spots[i]);
    applyBuildings();
    updateStats();
    return spots.length;
  }

  // Перегенерация: постройки остаются, если их место всё ещё годится.
  // Ратуша посреди воды — не «особенность сида», а мусор на карте.
  function keepValidBuildings() {
    var keep = [], dropped = 0;
    for (var i = 0; i < buildings.length; i++) {
      // opts по умолчанию: деревья и камни в пятне не считаются запретом,
      // иначе смена ползунка «только чистое место» сносила бы готовые
      // постройки. Про мелочь и говорить нечего — она место не портит.
      if (global.Buildings.canPlace(world, keep, buildings[i], {}).ok) {
        // А вот площадку расчищаем всегда, даже если расчистка выключена:
        // лес на новом сиде растёт заново и без этого прорастает сквозь
        // стены, а куст в передней половине пятна рисуется поверх дома.
        // Стоящая ратуша приоритетнее того, что выросло на её месте.
        global.Buildings.clearSite(world, buildings[i], {});
        keep.push(buildings[i]);
      } else {
        dropped++;
      }
    }
    buildings = keep;
    return dropped;
  }

  /* --------------------------- параметры --------------------------- */

  function readUI() {
    return {
      seed: $('seed').value || 'seed',
      size: parseInt($('size').value, 10),
      land: parseInt($('land').value, 10) / 100,
      coast: parseInt($('coast').value, 10) / 100,
      forest: parseInt($('forest').value, 10) / 100,
      rock: parseInt($('rock').value, 10) / 100,
      trees: parseInt($('tree').value, 10) / 100,
      rocks: 0.6
    };
  }

  function syncLabels() {
    $('landVal').textContent = $('land').value + ' %';
    $('coastVal').textContent = $('coast').value + ' %';
    $('forestVal').textContent = $('forest').value + ' %';
    $('rockVal').textContent = $('rock').value + ' %';
    $('treeVal').textContent = $('tree').value + ' %';
  }

  function applyToggles() {
    renderer.showGrid = $('tGrid').checked;
    renderer.showTrees = $('tTrees').checked;
    renderer.showRocks = $('tRocks').checked;
    renderer.showSmall = $('tSmall').checked;
    renderer.showBuildings = $('tBuild').checked;
    renderer.showVillagers = $('tVillager').checked;
  }

  /* --------------------------- генерация --------------------------- */

  /* Новая партия: случайная карта на текущих настройках (при открытии игры
     это дефолтные значения) и ратуша игрока у центра острова. Пока это вся
     игра — генератор как игра и начинается, и заканчивается. */
  function newGame() {
    var params = readUI();
    var t0 = performance.now();
    world = WG.generate(params);
    renderer.world = world;
    var tGen = performance.now() - t0;
    renderer.buildCache();

    buildings = [];
    renderer.selected = null;
    // Ратуша игрока, постройки партии и кадр «остров целиком» — из
    // js/session.js: ровно то же делает игра (game/index.html) на своей
    // стороне, и разойтись эти две партии не могут.
    var st = global.Session.startHome(world, renderer, placeOpts());
    var home = st.home;
    buildings = st.buildings;
    refreshGhost();
    spawnVillagers(home);
    updateStats(tGen);
    drawMinimap();
    needFrame = true;
    hudText.textContent = 'мир ' + world.width + '×' + world.height + ' · сид ' + world.seed +
      (home ? ' · ратуша ' + home.x + ', ' + home.y : ' · места под ратушу нет');
    return home;
  }

  // Перегенерация карты из панели: постройки остаются, если их место всё
  // ещё годится. В игре этим не пользуются, это инструмент генератора.
  function regenerate(keepCamera) {
    var params = readUI();
    var t0 = performance.now();
    world = WG.generate(params);
    renderer.world = world;
    var tGen = performance.now() - t0;

    renderer.buildCache();
    if (!keepCamera) renderer.fitIsland();
    // Кэш местности пересобирается целиком: узор текстуры привязан к размеру
    // клетки в кэше, при смене размера карты он другой.
    var dropped = keepValidBuildings();
    renderer.setBuildings(buildings);
    refreshGhost();
    updateStats(tGen);
    // Житель переезжает вместе с картой: его путь — это клетки ТОГО мира, на
    // котором он его считал, и после перегенерации он вёл бы человека по
    // воде. Место — у той ратуши, что уцелела.
    spawnVillagers(buildings.length ? buildings[0] : null);
    mm.width = 192; mm.height = 192;
    drawMinimap();
    needFrame = true;
    hudText.textContent = 'мир ' + world.width + '×' + world.height + ' · сид ' + world.seed +
      (dropped ? ' · убрано построек: ' + dropped : '');
  }

  function updateStats(tGen) {
    var s = world.stats;
    $('sTiles').textContent = s.tiles.toLocaleString('ru-RU');
    $('sLand').textContent = Math.round(s.landShare * 100) + ' %';
    $('sTrees').textContent = s.trees.toLocaleString('ru-RU');
    $('sRocks').textContent = s.rocks.toLocaleString('ru-RU');
    $('sSmall').textContent = s.smallRocks.toLocaleString('ru-RU');
    $('sBuild').textContent = buildings.length;
    // Время генерации обновляем только когда мир действительно пересобрали:
    // постановка ратуши карту не перегенерирует.
    if (tGen) {
      $('sTime').textContent = world.genTimeMs.toFixed(0) + ' мс (+' +
        Math.max(0, tGen - world.genTimeMs).toFixed(0) + ' мс кэш)';
    }
  }

  /* --------------------------- миникарта --------------------------- */

  function drawMinimap() {
    if (!renderer.minimap) return;
    mmCtx.setTransform(1, 0, 0, 1, 0, 0);
    mmCtx.clearRect(0, 0, mm.width, mm.height);
    mmCtx.drawImage(renderer.minimap, 0, 0, mm.width, mm.height);

    // Рамка обзора — в мировых углах видимой области. Порядок именно такой:
    // в изометрии эти четыре точки идут по периметру ромба, а не крест-накрест
    // (иначе рамка рисуется «бабочкой» — двумя перекрещенными треугольниками).
    var box = renderer.viewTiles(0);
    var corners = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]];
    mmCtx.beginPath();
    for (var i = 0; i < 4; i++) {
      var p = renderer.worldToMM(corners[i][0], corners[i][1]);
      if (i === 0) mmCtx.moveTo(p.x, p.y); else mmCtx.lineTo(p.x, p.y);
    }
    mmCtx.closePath();
    mmCtx.strokeStyle = 'rgba(255,255,255,0.85)';
    mmCtx.lineWidth = 1.5;
    mmCtx.stroke();
    mmCtx.strokeStyle = 'rgba(0,0,0,0.45)';
    mmCtx.lineWidth = 3.5;
    mmCtx.globalCompositeOperation = 'destination-over';
    mmCtx.stroke();
    mmCtx.globalCompositeOperation = 'source-over';

    /* Житель на обзоре. Обзор пересобирается только по генерации карты, а
       житель ходит — значит, точка ставится здесь, на каждый кадр, поверх
       готовой картинки обзора. Без неё найти человека на острове можно
       только обшарив его глазами: он один и он маленький. */
    global.Session.drawVillagers(mmCtx, renderer, villagers);
  }

  /* ------------------------------ ввод ------------------------------ */

  var drag = null;

  /* Пороги указателя — те же правила, что у игры (game/js/play.js): дрожь
     меряется РАССТОЯНИЕМ от точки нажатия, а не суммой пути, клик терпит 8 px,
     камера едет только после порога. Иначе рука на Windows дрожит на 8–10 px, и
     «поставить здание» превращается в «подвинуть карту». */
  var CLICK_SLOP = 8;
  var PAN_SLOP = CLICK_SLOP;
  /* Пока ставим здание, рука прицеливается: 10–15 px дрожи — это «сюда», а не
     «увести карту». Тот же порог, что у постановки в игре (PLACE_SLOP). */
  var PLACE_SLOP = 18;
  function moveSlop() { return place.on ? PLACE_SLOP : PAN_SLOP; }

  /* Колесо: Firefox меряет deltaY строками (deltaMode 1), Windows-мышь — по
     100 пикселей за щелчок. Без пересчёта зум в Firefox почти не работал. */
  function wheelDelta(e) {
    var d = e.deltaY || 0;
    if (e.deltaMode === 1) d *= 16;          // строки
    else if (e.deltaMode === 2) d *= 400;    // страницы
    if (d > 240) d = 240;
    if (d < -240) d = -240;
    return d;
  }

  function pointerAt(e) {
    var rect = view.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  view.addEventListener('pointerdown', function (e) {
    view.setPointerCapture(e.pointerId);
    view.classList.add('dragging');
    drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, moved: 0 };
    var p = pointerAt(e);
    updateHover(p.x, p.y);
  });

  view.addEventListener('pointermove', function (e) {
    var p = pointerAt(e);
    if (drag) {
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      var reach = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
      if (reach > drag.moved) drag.moved = reach;
      if (drag.moved > moveSlop()) {
        renderer.panScreen(dx, dy);
        needFrame = true;
      }
    }
    updateHover(p.x, p.y);
  });

  // Клик отличается от перетаскивания расстоянием от точки нажатия: панорама
  // тоже начинается с нажатия, и без этого порога здание ставилось бы в конце
  // каждого сдвига камеры.
  view.addEventListener('pointerup', function (e) {
    view.classList.remove('dragging');
    var wasDrag = !!(drag && drag.moved > CLICK_SLOP);
    var wasPlaceDrag = !!(drag && drag.moved > PLACE_SLOP);
    drag = null;
    if (e.button !== 0 || !world) return;

    var pt = pointerAt(e);
    var p = renderer.screenToWorld(pt.x - renderer.cssW / 2, pt.y - renderer.cssH / 2);
    var cell = { x: Math.floor(p.x), y: Math.floor(p.y) };

    if (place.on) {
      // Настоящая панорама (сдвиг больше PLACE_SLOP) постановку отменяет;
      // дрожь руки — нет: призрак всё это время стоял под курсором.
      if (wasPlaceDrag) return;
      // Призрак считается от клетки под курсором, а не от последнего
      // движения мыши: клик без движения тоже должен ставить.
      refreshGhost();
      if (ghost && ghost.ok) placeAt(ghost.b);
      else if (ghost) hudText.textContent = 'сюда нельзя: ' + ghost.reason;
      needFrame = true;
      return;
    }
    if (wasDrag) return;

    // Вне режима размещения клик выбирает постройку: по выбранной видно
    // пятно, её можно снести клавишей Delete, а не откатывать всё подряд.
    var b = buildingUnder(cell);
    if (b !== renderer.selected) {
      renderer.selected = b;
      needFrame = true;
    }
    updatePlaceInfo();
  });
  view.addEventListener('pointercancel', function () { drag = null; view.classList.remove('dragging'); });

  /* Потеря фокуса окна: отпускание до полотна не доедет, и камера осталась бы
     «в руке». */
  global.addEventListener('blur', function () { drag = null; view.classList.remove('dragging'); });

  // ПКМ по карте — выход из режима размещения: привычнее, чем искать Esc.
  view.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    if (place.on) setPlaceMode(false);
  });

  view.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = view.getBoundingClientRect();
    var vx = e.clientX - rect.left - rect.width / 2;
    var vy = e.clientY - rect.top - rect.height / 2;
    var factor = Math.pow(1.0016, -wheelDelta(e));
    renderer.zoomAt(vx, vy, factor);
    needFrame = true;
  }, { passive: false });

  view.addEventListener('mouseleave', function () {
    renderer.hover = null;
    refreshGhost();
    needFrame = true;
  });

  var keys = Object.create(null);

  global.addEventListener('keydown', function (e) {
    if (global.Keys ? global.Keys.typing(e)
        : (e.target && /input|select|textarea/i.test(e.target.tagName))) return;
    /* Имя клавиши — по физическому месту (js/keys.js): на русской раскладке
       `e.key` для W приходит как «ц», и молчали WASD, B, R, G и остальные
       буквы. */
    var k = global.Keys ? global.Keys.name(e) : String(e.key || '').toLowerCase();
    keys[k] = true;
    if (k === 'b') { setPlaceMode(!place.on); }
    else if (place.on && (k === 'q' || k === '[')) { rotate(-90); }
    else if (place.on && (k === 'e' || k === ']')) { rotate(90); }
    else if (place.on && '123'.indexOf(k) >= 0) { setVariant('abc'.charAt(+k - 1)); }
    else if (k === 'escape') {
      if (place.on) setPlaceMode(false);
      else if (renderer.selected) { renderer.selected = null; needFrame = true; updatePlaceInfo(); }
    }
    else if (k === 'delete' || k === 'backspace') { removeLast(); }
    else if (k === 'r') { newSeed(); }
    else if (k === 'g') { $('tGrid').checked = !$('tGrid').checked; applyToggles(); needFrame = true; }
    else if (k === 'f') { renderer.fitIsland(); needFrame = true; }
    else if (k === 'v') { toggleTopView(); }
    else if (k === '`' || k === '~' || k === 'ё') { setPanel($('panel').classList.contains('hidden')); }
    else if (k === '=' || k === '+') { renderer.zoomAt(0, 0, 1.15); needFrame = true; }
    else if (k === '-' || k === '_') { renderer.zoomAt(0, 0, 1 / 1.15); needFrame = true; }
    if (k.indexOf('arrow') === 0 || 'wasd'.indexOf(k) >= 0) e.preventDefault();
  });
  global.addEventListener('keyup', function (e) {
    keys[global.Keys ? global.Keys.name(e) : String(e.key || '').toLowerCase()] = false;
  });
  global.addEventListener('blur', function () { keys = Object.create(null); });

  // Камера от клавиш едет в экранных направлениях, как при перетаскивании:
  // «вверх» — карта едет вниз по экрану. В изометрии это не совпадает
  // с осями мира, поэтому переводим вектор через ту же обратную проекцию,
  // что и мышь: иначе стрелки уводили бы вид по диагонали.
  function stepCamera(dt) {
    var vx = 0, vy = 0;
    if (keys['a'] || keys['arrowleft']) vx += 1;
    if (keys['d'] || keys['arrowright']) vx -= 1;
    if (keys['w'] || keys['arrowup']) vy += 1;
    if (keys['s'] || keys['arrowdown']) vy -= 1;
    if (!vx && !vy) return false;
    var speed = 900 * dt;                    // пикселей экрана в секунду
    var len = Math.hypot(vx, vy) || 1;
    renderer.panScreen(vx / len * speed, vy / len * speed);
    return true;
  }

  function toggleTopView() {
    // «Общий план» — тот же кадр, что и при старте партии: остров целиком
    // и по половине его диаметра моря вокруг. Это не отдельный рендер,
    // а просто максимальное отдаление.
    if (Math.abs(renderer.cam.zoom - renderer.minZoom) < 1e-6) {
      renderer.cam.zoom = Math.min(renderer._savedZoom || renderer.minZoom * 3, renderer.maxZoom);
    } else {
      renderer._savedZoom = renderer.cam.zoom;
      renderer.fitIsland();
    }
    // Зум выставлен напрямую, а предел панорамы зависит от него — проверяем
    // камеру тем же зажимом, что и панорама.
    renderer.clampCamera();
    needFrame = true;
  }

  function updateHover(vx, vy) {
    // Экран -> центр экрана
    var cx = vx - view.clientWidth / 2, cy = vy - view.clientHeight / 2;
    var p = renderer.screenToWorld(cx, cy);
    var tx = Math.floor(p.x), ty = Math.floor(p.y);
    if (renderer.hover && renderer.hover.x === tx && renderer.hover.y === ty) return;
    renderer.hover = { x: tx, y: ty };
    // Что на клетке — считает движок (worldgen.js: describeCell): ту же строку
    // показывает под курсором игра, и разойтись в словах оболочки не могут.
    var cell = WG.describeCell(world, tx, ty);
    hudText.textContent = cell && cell.inside ? cell.text : 'за картой';
    // Призрак строится от той же клетки, что и подсветка: одна точка входа,
    // иначе здание встаёт не туда, куда показывает курсор.
    refreshGhost();
    needFrame = true;
  }

  // Клик по миникарте — переход в точку
  mm.addEventListener('pointerdown', function (e) {
    var r = mm.getBoundingClientRect();
    var p = renderer.pickMinimap(
      (e.clientX - r.left) * (mm.width / r.width),
      (e.clientY - r.top) * (mm.height / r.height));
    if (!p) return;
    // pickMinimap возвращает угол клетки, а камеру ставим в её центр
    renderer.centerOn(p.x + 0.5, p.y + 0.5);
    needFrame = true;
  });

  /* --------------------------- управление --------------------------- */

  $('regen').addEventListener('click', function () { regenerate(true); });
  $('dice').addEventListener('click', newSeed);
  $('seed').addEventListener('keydown', function (e) { if (e.key === 'Enter') regenerate(true); });
  $('reset').addEventListener('click', function () { renderer.fitIsland(); needFrame = true; });
  $('size').addEventListener('change', function () {
    // Новая карта — заново и кадр, и предел отдаления: он зависит от габарита острова.
    regenerate(false);
    needFrame = true;
  });

  ['land', 'coast', 'forest', 'rock', 'tree'].forEach(function (id) {
    var el = $(id);
    el.addEventListener('input', syncLabels);
    el.addEventListener('change', function () { regenerate(true); });
  });

  ['tGrid', 'tTrees', 'tRocks', 'tSmall', 'tBuild', 'tVillager'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      applyToggles();
      if (id === 'tBuild' && renderer.cache) renderer.buildMinimap();
      needFrame = true;
    });
  });

  /* --- панель ратуши ------------------------------------------------ */

  $('thVariants').addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-variant]') : null;
    if (el) setVariant(el.dataset.variant);
  });
  $('thRots').addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('[data-rot]') : null;
    if (el) setRotation(+el.dataset.rot);
  });
  $('thPlace').addEventListener('click', function () { setPlaceMode(!place.on); });
  $('thTurn').addEventListener('click', function () { rotate(90); });
  $('thAll').addEventListener('click', function () {
    var n = placeAllThree();
    hudText.textContent = n ? 'поставлено ратуш: ' + n : 'не нашлось места под три ратуши';
  });
  $('thUndo').addEventListener('click', removeLast);
  $('thClear').addEventListener('click', clearBuildings);
  $('thClearSite').addEventListener('change', function () {
    place.clear = $('thClearSite').checked;
    refreshGhost();
  });
  $('thStrict').addEventListener('change', function () {
    place.strict = $('thStrict').checked;
    refreshGhost();
  });

  // Миниатюры вариантов: спрайт берётся из того же атласа, что и на карте,
  // поэтому в панели видно ровно то, что встанет на клетки.
  function drawVariantThumbs() {
    var set = homeSprites();
    if (!set) return;
    var thumbs = $('thVariants').querySelectorAll('canvas');
    for (var i = 0; i < thumbs.length; i++) {
      var cv = thumbs[i], v = cv.dataset.variant;
      var spr = global.Buildings.sprite(set, v, 0);
      if (!spr) continue;
      var k = Math.min(cv.width / spr.sw, cv.height / spr.sh);
      var dw = spr.sw * k, dh = spr.sh * k;
      var g = cv.getContext('2d');
      g.clearRect(0, 0, cv.width, cv.height);
      g.imageSmoothingEnabled = true;
      g.drawImage(spr.img, spr.sx, spr.sy, spr.sw, spr.sh,
        (cv.width - dw) / 2, cv.height - dh, dw, dh);
    }
  }

  $('export').addEventListener('click', function () {
    var scale = renderer.cachePx >= 32 ? 2 : 1;
    var cv = renderer.exportPNG(scale);
    if (!cv) return;
    var url;
    // По file:// холст со спрайтами испорчен («чужой источник»), и выгрузить
    // его браузер не даёт. Это ограничение file://, а не карты: говорим об
    // этом вслух, а не роняем исключение в консоль.
    try {
      url = cv.toDataURL('image/png');
    } catch (e) {
      hudText.textContent = 'экспорт PNG недоступен по file:// — поднимите http-сервер';
      return;
    }
    var a = document.createElement('a');
    a.download = 'map-' + world.seed + '-' + world.width + 'x' + world.height + '.png';
    a.href = url;
    a.click();
  });

  // R и 🎲 — новая партия: другой сид, другая карта, другая ратуша.
  function newSeed() {
    $('seed').value = global.randomSeed();
    newGame();
  }

  /* ------------------------- панель генератора ------------------------- *
   *
   * При открытии игры панели не видно: открывается игра, а не генератор.
   * Но генератор никуда не делся — он за кнопкой в углу и клавишей «`»,
   * и всё, что в нём есть, работает как раньше.
   * -------------------------------------------------------------------- */

  function setPanel(on) {
    $('panel').classList.toggle('hidden', !on);
    $('devToggle').classList.toggle('active', !!on);
    // Полотно стало другим по ширине — камера обязана об этом узнать.
    renderer.resize();
    needFrame = true;
  }

  /* ----------------------------- загрузка ----------------------------- */

  var TEXTURES = {
    grass: 'assets/textures/grass.png',
    meadow: 'assets/textures/meadow.png',
    // Газон участков: низкая трава темнее луга, плитка 2 x 2 клетки.
    // Исходник и сборка — art/textures/plot_grass.
    plot_grass: 'assets/textures/plot_grass.png',
    sand: 'assets/textures/sand.png',
    water: 'assets/textures/water.png',
    // Рябь моря — не текстура земли, а готовая карта яркости для умножения;
    // лежит рядом с атласом волн, готовит её tools/pack_waves.py.
    ripple: 'assets/waves/ripple.png',
    stony: 'assets/textures/stony.png'
  };

  function loadTextures(done) {
    var keys = Object.keys(TEXTURES);
    var out = {}, left = keys.length;
    keys.forEach(function (k) {
      var img = new Image();
      img.onload = function () { out[k] = img; if (--left === 0) done(out); };
      img.onerror = function () { if (--left === 0) done(out); };
      img.src = TEXTURES[k];
    });
  }

  function start() {
    syncLabels();
    applyToggles();
    setPanel(false);
    renderer.resize();

    urlSeed = new URLSearchParams(location.search).get('seed');
    $('seed').value = urlSeed || global.randomSeed();
    $('devToggle').addEventListener('click', function () {
      setPanel($('panel').classList.contains('hidden'));
    });

    loadTextures(function (tex) {
      texturesLoaded = true;
      renderer.setTextures(tex);
      bootSprites();
    });
  }

  function bootSprites() {
    // Шесть загрузок: спрайты мира, волны, три постройки деревни, житель.
    // Постройки грузятся одним циклом (см. ниже) — их число берётся из
    // таблицы типов, чтобы новую постройку не приходилось считать тут.
    var left = 4 + Object.keys(global.Buildings.TYPES).length, failed = null;
    function done() {
      if (--left > 0) return;
      // Открывается партия: случайная карта с дефолтными настройками и
      // ратуша игрока у центра. Панель генератора в это не вмешивается.
      newGame();
      // Оверлей прячем только если спрайты на месте: иначе он и есть
      // сообщение об ошибке, и прятать его незачем.
      if (!failed) $('loading').classList.add('hidden');
      loop(performance.now());
    }

    /* Загрузка может упасть не колбэком, а исключением — и тогда счётчик
       не дойдёт до нуля, а игрок останется на «Загрузке спрайтов» навсегда
       (так уже было: SecurityError на холсте с текстурой валил всю загрузку).
       Считаем такое падение обычным «не загрузилось» и всё равно открываем
       партию — без картинки, но открываем. */
    function start(run) {
      try {
        run();
      } catch (e) {
        failed = failed || e;
        var el = $('loading');
        if (el) el.textContent = 'Не загрузились спрайты: ' + (e && e.message ? e.message : e);
        done();
      }
    }

    start(function () { global.Sprites.load({ base: 'assets/' }, function (set) {
      renderer.sprites = set;
      // Единицы спрайтов переводятся в клетки в sprites.js; здесь только
      // задаётся «крупность» мира. mul = 1.35 → крона дуба ~1.5 клетки,
      // как дерево в Clash of Clans. Меняя это число, мир «крупнеет».
      set.mul = 1.35;
      done();
    }, function (err) {
      // Без спрайтов карта всё равно должна открыться: показываем рельеф.
      failed = err;
      var el = $('loading');
      el.textContent = 'Не загрузились спрайты: ' + (err && err.message ? err.message : err);
      done();
    }); });

    // Атлас волн — тоже отдельная загрузка: без него море остаётся гладким,
    // и это не повод не открывать партию.
    start(function () { global.Waves.load({ base: 'assets/' }, function (set) {
      renderer.waveSprites = set;
      done();
    }, function () {
      renderer.waveSprites = null;
      done();
    }); });

    // Атласы построек — по одному на тип, и каждый отдельной загрузкой: без
    // ратуши карта работает, просто панель размещения честно говорит, что
    // ставить нечего; без дома и лагеря деревня на старте просто меньше.
    Object.keys(global.Buildings.TYPES).forEach(function (type) {
      start(function () { global.Buildings.load(type, { base: 'assets/' }, function (set) {
        renderer.setBuildingSet(type, set);
        if (type === global.Buildings.DEFAULT_TYPE) {
          drawVariantThumbs();
          updatePlaceInfo();
        }
        done();
      }, function (err) {
        renderer.setBuildingSet(type, null);
        if (type === global.Buildings.DEFAULT_TYPE) {
          // Панель размещения ставит ратуши: нет её атласа — нечего и ставить.
          $('thPlace').disabled = true;
          $('thAll').disabled = true;
          $('placeInfo').textContent = 'Атлас ратуши не загрузился: ' + (err && err.message ? err.message : err);
          $('placeInfo').className = 'place-info bad';
        }
        done();
      }); });
    });

    // Атлас жителя — отдельная загрузка: без него карта работает, просто
    // по острову никто не ходит.
    start(function () { global.Villagers.load({ base: 'assets/' }, function (set) {
      renderer.villagerSprites = set;
      done();
    }, function () {
      renderer.villagerSprites = null;
      done();
    }); });

    // Атлас рыцаря — в броне, шлеме и с мечом. Необязателен: без него рыцарь
    // рисуется обычным жителем, и карта не падает.
    start(function () { global.Villagers.load({
      base: 'assets/', dir: 'armored_villager/', metaName: 'ARMORED_VILLAGER_ATLAS'
    }, function (set) {
      renderer.knightSprites = set;
      done();
    }, function () {
      renderer.knightSprites = null;
      done();
    }); });
  }

  /* ------------------------------- цикл ------------------------------- */

  var last = 0;

  function loop(t) {
    var dt = Math.min(0.05, (t - last) / 1000) || 0;
    last = t;

    if (stepCamera(dt)) needFrame = true;
    stepVillagers(dt);

    // Волны на море анимируются всегда: они теперь по всей воде, и без
    // движения море читается нарисованным. Кадр стоит доли миллисекунды —
    // земля лежит в кэше и кладётся одним блитом, — так что экономить не на
    // чем. Раньше перерисовку включали только при зуме от 14: блики
    // рисовались мазком по каждой клетке воды, и это было дорого.
    if (world) needFrame = true;

    if (needFrame) {
      needFrame = false;
      renderer.render(t / 1000);
      drawMinimap();
    }
    requestAnimationFrame(loop);
  }

  global.addEventListener('resize', function () {
    renderer.resize();
    needFrame = true;
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  global.__mapgen = {
    renderer: renderer,
    regenerate: regenerate,
    newGame: newGame,
    setPanel: setPanel,
    home: function () { return HOME; },
    getWorld: function () { return world; },
    readUI: readUI,
    // Размещение построек — наружу: этим пользуются автотесты, а не только
    // панель. Один и тот же код ставит ратушу мышью и из теста.
    getBuildings: function () { return buildings; },
    getGhost: function () { return ghost; },
    setPlaceMode: setPlaceMode,
    isPlacing: function () { return place.on; },
    setVariant: setVariant,
    setRotation: setRotation,
    placeAt: placeAt,
    placeAllThree: placeAllThree,
    removeLast: removeLast,
    clearBuildings: clearBuildings,
    placeOptions: placeOpts,
    drawMinimap: drawMinimap,
    // Жители — наружу тем же порядком: их ведёт app.js, но автотесту нужен
    // и список (проверить, где они), и шаг без кадра (прожить час за секунду).
    getVillagers: function () { return villagers; },
    spawnVillagers: spawnVillagers,
    stepVillagers: stepVillagers
  };
})(typeof window !== 'undefined' ? window : globalThis);
