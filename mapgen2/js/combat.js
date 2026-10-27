/* combat.js — бой: здоровье, цели, удары, смерть и завалы.

   Почему отдельный модуль, а не ещё одна ветка в villager.js. У жителя уже
   есть работа, прогулка, тренировка и дружина; бой — пятый режим, и если
   писать его там же, никто не скажет, кто в кадре двигает человека, а кто
   выбирает цель. Здесь только ПРАВИЛА боя: кого видит воин, когда бьёт и что
   остаётся от убитого. Движение по-прежнему в villager.js: он читает
   `v.target`/`v.combatMode` и идёт, а этот модуль только выставляет их и
   считает урон.

   ЧИСЛА — В ОДНОМ МЕСТЕ (CONFIG). HP по таблице заказчика 2026-10-23, урон
   по юнитам и по зданиям — разные числа: без этого пятеро воинов сносили
   ратушу за 3 с, и защитник не успевал даже обучить троих (обучение 5 с).
   Цель баланса (контракт §5): ратуша держит атаку 5 воинов 15–25 с; замер
   прототипа — 17 с идеально и 19–21 с с дорогой. Старые имена
   (`HP`, `WARRIOR_DAMAGE`, `ATTACK_EVERY`) оставлены алиасами: HUD и
   приёмки не должны собирать свою копию таблицы.

   ЧТО ЗДЕСЬ ПОЯВИЛОСЬ ПОСЛЕ РАЗБОРА (2026-10-26):
   * замах `windup` перед первым ударом по новой цели — урон больше не
     приходит в тот же кадр, что цель вошла в дальность;
   * интервал по типу цели: по зданию реже, чем по юниту;
   * прямая до цели (`losBlocked`): за углом/стеной не бьём;
   * житель в закрытой клетке чужого пятна (двор лагеря) снаружи не
     достаётся; исключение — кольцо своего военного лагеря;
   * цель-постройка выбирается только если до её кольца есть путь (иначе
     каждый воин гонял по 18 поисков пути в секунду за водой);
   * кеш недостижимого (`v.noPathKey`) и `chaseGiveUp` — цель, к которой
     воин не идёт 3 с, отпускается до смены карты или приказа;
   * `holdFire` — «Стоп» снимает бой и не даёт снова взять цель самому;
   * события `attack` (с троттлингом 8 с) и `destroy` — в общий журнал. */
(function (global) {
  'use strict';

  /* Единственный источник чисел боя. Всё остальное — алиасы ниже. */
  var CONFIG = {
    hp: {
      villager: 15,
      warrior: 25,
      townhall: 120,
      house: 50,
      lumbercamp: 35,
      barracks: 80,
      warcamp: 40
    },
    damage: { unit: 6, building: 2 },
    interval: { unit: 0.8, building: 1.5 },
    windup: 0.35,                 // с: замах перед первым ударом по новой цели
    range: 1.2,                   // клеток до центра клетки цели
    aggro: 8,                     // клеток: кого вообще замечает
    defendR: 12,                  // клеток от ратуши: «враг в деревне»
    retargetR: 3,                 // клеток: воин важнее здания в этом радиусе
    barTime: 5,                   // с: сколько видна полоса после удара
    flinch: 0.16,                 // с: вздрагивание
    think: 0.2,                   // с: как часто искать цель
    /* Поводки. `fight` — радиус вокруг МЕСТА СТЫЧКИ: погоня не уходит за
       остров, но и не привязана к конечной точке приказа (BATTLE-01).
       `selfDefense` — «близкий удар»: ответ на него не зависит ни от какого
       поводка. `order` оставлен только как имя для старых ссылок и тестов,
       цель приказа больше не отсекает стычку по пути. */
    leash: { camp: 16, order: 10, home: 8, fight: 12 },
    selfDefense: 3,               // клеток: допустимый ближний удар
    reaction: 0.2,                // с: think + явный допуск реакции на удар
    chaseGiveUp: 3.0              // с: цель жива, но воин не идёт — в кеш
  };

  var HP = CONFIG.hp;
  var WARRIOR_DAMAGE = CONFIG.damage.unit;
  var BUILDING_DAMAGE = CONFIG.damage.building;
  var ATTACK_EVERY = CONFIG.interval.unit;
  var BUILDING_EVERY = CONFIG.interval.building;
  var WINDUP = CONFIG.windup;
  var ATTACK_RANGE = CONFIG.range;
  var AGGRO = CONFIG.aggro;
  var DEFEND_R = CONFIG.defendR;
  var RETARGET_R = CONFIG.retargetR;
  var BAR_TIME = CONFIG.barTime;
  var FLINCH_TIME = CONFIG.flinch;
  var THINK_EVERY = CONFIG.think;
  var CAMP_LEASH = CONFIG.leash.camp;
  var ORDER_LEASH = CONFIG.leash.order;
  var HOME_LEASH = CONFIG.leash.home;
  var FIGHT_LEASH = CONFIG.leash.fight;
  var SELF_DEFENSE = CONFIG.selfDefense;

  /* --------------------------- ограниченный след ------------------------- *
   *
   * OBS-01: бой нельзя объяснить постфактум по HP. Нужен след ДЛЯ НЕСКОЛЬКИХ
   * выбранных юнитов: позиция, приказ, якорь стычки, цель/атакующий, причина
   * отказа от цели и урон. Писать все пары каждый кадр навсегда запрещено —
   * это нагрузка и шум. Поэтому:
   *   * по умолчанию след ВЫКЛЮЧЕН и ничего не стоит;
   *   * включает его игра/приёмка для конкретных id (или для всех);
   *   * кольцо фиксированного размера (512 записей), старые вытесняются.
   * В снимок и сеть след не попадает — только в выгрузку диагностики. */
  var TRACE_MAX = 512;
  var traceOn = false, traceIds = null, traceBuf = [];
  function traceEnable(ids) {
    traceOn = true;
    traceIds = (ids && ids.length) ? ids.slice() : null;
    return { on: true, ids: traceIds ? traceIds.length : 'all', max: TRACE_MAX };
  }
  function traceDisable() { traceOn = false; traceIds = null; return { on: false }; }
  function traceWanted(v) {
    if (!traceOn || !v) return false;
    return !traceIds || traceIds.indexOf(v.id) >= 0;
  }
  function tracePush(rec) {
    if (!traceOn) return;
    traceBuf.push(rec);
    if (traceBuf.length > TRACE_MAX) traceBuf.shift();
  }
  function traceDump() {
    return { on: traceOn, ids: traceIds ? traceIds.slice() : null,
      max: TRACE_MAX, items: traceBuf.slice() };
  }

  function ownerOf(o) {
    if (!o) return -1;
    return o.owner === undefined ? 0 : o.owner;
  }

  function isBuilding(o) { return !!(o && o.kind === 'building'); }

  /* Версия карты проходимости — одна на движок (villager.js), чтобы кеши
     здесь и там сбрасывались в один момент. */
  function mapVer(world) {
    if (global.Villagers && global.Villagers.mapVer) return global.Villagers.mapVer(world);
    return ((world && world.objects ? world.objects.length : 0) + '/' +
      ((world && world._buildings) || []).length + '/' + ((world && world._buildRev) || 0));
  }

  /* Карта занятых клеток — ТОЛЬКО через кеш villager.js: blockedMap считает
     её один раз на версию и не пересобирает на каждый удар. */
  function solidMap(world, buildings) {
    if (!world || !global.Villagers || !global.Villagers.blockedMap) return null;
    return global.Villagers.blockedMap(world, buildings || world._buildings || []);
  }

  /* Город ещё в партии? У выбывшего по ратуше войска остаются на карте, но
     воевать от его имени больше нельзя: он наблюдает. */
  function townAlive(world, o) {
    if (!world || !world.towns) return true;
    var id = o && o.town !== undefined ? o.town : ownerOf(o);
    var town = world.towns[id];
    return !town || town.alive !== false;
  }

  /* Одна ли это связная область суши. Постройки/лагеря стоят на занятых
     клетках, и areaAt возвращает -1 — там проверку пропускаем: воин может
     выйти из лагеря, а до стены дома достаёт снаружи. */
  function sameArea(world, v, o, solid) {
    if (!world || isBuilding(o) || !global.Villagers || !global.Villagers.areaAt) return true;
    var V = global.Villagers;
    var map = solid || V.blockedMap(world, world._buildings || []);
    var a = V.areaAt(world, map, v.x, v.y);
    var b = V.areaAt(world, map, o.x, o.y);
    if (a < 0 || b < 0) return true;
    return a === b;
  }

  /* Клетка внутри пятна постройки, в которую нельзя войти. Кеш «клетка ->
     постройка» по версии карты: пятна меняются только с постройками.
     Кольцо своего военного лагеря — не закрытая клетка: оно открыто для
     ходьбы воинов, и защитников лагеря снаружи бить можно. */
  function cellBuildings(world) {
    var B = global.Buildings;
    if (!world || !B) return null;
    var ver = mapVer(world);
    var cache = world._cellBuildings;
    if (cache && cache.ver === ver) return cache;
    var map = {}, ring = {}, list = (world._buildings || []).slice(), i, j, b, cells, key;
    for (i = 0; i < list.length; i++) {
      b = list[i];
      if (!b || b.rubble) continue;
      cells = B.cells(b);
      for (j = 0; j < cells.length; j++) {
        key = cells[j].x + ',' + cells[j].y;
        map[key] = b;
      }
      if (B.typeOf(b) === 'warcamp' && B.patrolCells) {
        cells = B.patrolCells(b);
        for (j = 0; j < cells.length; j++) ring[cells[j].x + ',' + cells[j].y] = 1;
      }
    }
    cache = world._cellBuildings = { ver: ver, map: map, ring: ring };
    return cache;
  }

  function inClosedCell(world, o) {
    if (!o || isBuilding(o)) return false;
    var c = cellBuildings(world);
    if (!c) return false;
    var key = Math.floor(o.x) + ',' + Math.floor(o.y);
    return !!(c.map[key] && !c.ring[key]);
  }

  /* Прямая между центрами: проверяются клетки, через которые она проходит,
     кроме своей и клетки цели (цель может стоять на кольце лагеря, а оно в
     общей карте закрыто). Шаг 0.1 клетки: при дальности 1.2 это 12 проб —
     дешевле любого A*, а стену толщиной в клетку пропустить не может.

     `skipA`/`skipB` — постройки, клетки которых прямой не мешают: свой
     военный лагерь (воин стоит на его кольце, а кольцо в общей карте
     закрыто) и пятно самой цели-постройки (иначе её собственная стена
     «мешала» бы бить по ней). */
  function losBlocked(world, solid, x0, y0, x1, y1, skipA, skipB) {
    if (!world || !solid) return false;
    var W = world.width, H = world.height;
    var sx = Math.floor(x0), sy = Math.floor(y0);
    var ex = Math.floor(x1), ey = Math.floor(y1);
    var dx = x1 - x0, dy = y1 - y0;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 0)) return false;
    var cb = (skipA || skipB) ? cellBuildings(world) : null;
    var n = Math.max(2, Math.ceil(len / 0.1)), i, t, cx, cy, k, own;
    for (i = 1; i < n; i++) {
      t = i / n;
      cx = Math.floor(x0 + dx * t);
      cy = Math.floor(y0 + dy * t);
      if (cx === sx && cy === sy) continue;
      if (cx === ex && cy === ey) continue;
      if (cx < 0 || cy < 0 || cx >= W || cy >= H) return true;
      k = cy * W + cx;
      if (!solid[k]) continue;
      if (cb) {
        own = cb.map[cx + ',' + cy];
        if (own && (own === skipA || own === skipB)) continue;
      }
      return true;
    }
    return false;
  }

  /* Центр ближайшей к точке клетки пятна: по нему меряется прямая до
     постройки. До центра чужого дома прямая всегда проходит сквозь его же
     стену, и «прямой нет» означало бы «не бей дом никогда». */
  function nearestCellCenter(b, x, y) {
    var B = global.Buildings;
    var cells = B.cells(b), best = null, bd = Infinity, i, dx, dy, d;
    for (i = 0; i < cells.length; i++) {
      dx = cells[i].x + 0.5 - x;
      dy = cells[i].y + 0.5 - y;
      d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = { x: cells[i].x + 0.5, y: cells[i].y + 0.5 }; }
    }
    return best || { x: b.x + 0.5, y: b.y + 0.5 };
  }

  /* Есть ли прямая от воина до цели. Своё кольцо лагеря и пятно цели-здания
     прямой не мешают; чужая стена, дерево, вода — мешают. */
  function clearShot(world, solid, v, o) {
    if (!world || !solid || !v || !o) return true;
    var campA = (v.warcamp && !v.warcamp.rubble) ? v.warcamp : null;
    var ex, ey, campB = null;
    if (isBuilding(o)) {
      var p = nearestCellCenter(o, v.x, v.y);
      ex = p.x; ey = p.y;
      campB = o;
    } else {
      ex = o.x; ey = o.y;
      if (o.warcamp && !o.warcamp.rubble) campB = o.warcamp;
    }
    return !losBlocked(world, solid, v.x, v.y, ex, ey, campA, campB);
  }

  /* Области, из которых можно подойти к постройке: проходимые клетки её
     кольца. Кеш на постройке по версии карты. Пустая карта областей — не
     повод запрещать цель: старые миры и приёмки без Villagers живут как жили. */
  function ringAreaIds(world, b, solid) {
    var V = global.Villagers;
    if (!world || !b || !solid || !V || !V.areas) return null;
    var ver = mapVer(world);
    if (b._ring && b._ring.ver === ver) return b._ring.ids;
    var cells = approachCells(world, b, b.x, b.y);
    var areas = V.areas(world, solid);
    var ids = {}, any = false, i, cx, cy, id;
    for (i = 0; i < cells.length; i++) {
      cx = cells[i].x; cy = cells[i].y;
      if (!V.walkable || !V.walkable(world, solid, cx, cy)) continue;
      id = areas.ids[cy * world.width + cx];
      if (id >= 0) { ids[id] = 1; any = true; }
    }
    b._ring = { ver: ver, ids: ids, any: any };
    return ids;
  }

  /* Достижимо ли кольцо постройки из связной области воина. Область пятна
     (-1) для этого не годится: клетки дома закрыты, и areaAt там всегда -1 —
     именно из-за этого воин «видел» дом за водой и бесконечно искал путь. */
  function canReachBuilding(world, v, b, solid) {
    var V = global.Villagers;
    if (!world || !V || !V.areaAt || !solid) return true;
    var ids = ringAreaIds(world, b, solid);
    if (!ids) return true;
    if (!b._ring || !b._ring.any) return false;
    var a = V.areaAt(world, solid, v.x, v.y);
    if (a < 0) return true;            // воин сам в закрытой клетке (кольцо лагеря)
    return !!ids[a];
  }

  /* Ключ «отсюда эту цель не достать». Входит клетка воина: сдвинулся —
     попробуй снова. У юнита входит и его клетка: ушёл — кеш больше не про
     него. Сбрасывается сменой версии карты и новым приказом (army.js). */
  function targetKey(world, v, o) {
    var own = isBuilding(o) ? '' : '@' + Math.floor(o.x) + ',' + Math.floor(o.y);
    var id = o && o.id !== undefined ? o.id : (Math.floor(o.x) + ',' + Math.floor(o.y));
    return mapVer(world) + '@' + Math.floor(v.x) + ',' + Math.floor(v.y) + '>' + id + own;
  }

  /* Якорь, вокруг которого воин ищет угрозу, когда боя ещё нет.
   
     BATTLE-01: раньше при живом приказе якорем была КОНЕЧНАЯ точка `v.order`
     с радиусом ORDER_LEASH. У встречных армий конечные точки разные, поэтому
     одна армия видела врага, а другая с той же дистанции — нет, и бой шёл
     всухую. Теперь приказ задаёт только КУДА идти; стычка ищется вокруг
     САМОГО воина («локальная угроза»), а конечная точка на обнаружение не
     влияет. Охрана лагеря/двора и дом остаются со своими поводками: им
     действительно нельзя уводить гарнизон через остров. */
  function baseAnchor(v) {
    var B = global.Buildings;
    if (!v) return null;
    /* Марш: замечаем врага рядом с собой. Радиус — aggro: «кто задел или
       подошёл вплотную по дороге», а не «весь остров». */
    if (v.order) return { x: v.x, y: v.y, r: AGGRO };
    if (v.warcamp && !v.warcamp.rubble && B) {
      var c = B.center(v.warcamp);
      return { x: c.x, y: c.y, r: CAMP_LEASH };
    }
    if (v.station && !v.station.rubble && B) {
      var s = B.center(v.station);
      return { x: s.x, y: s.y, r: CAMP_LEASH };
    }
    if (v.anchor) return { x: v.anchor.x, y: v.anchor.y, r: HOME_LEASH };
    return null;
  }

  /* Якорь стычки: пока цель жива, погоня считается по МЕСТУ, ГДЕ БОЙ НАЧАЛСЯ
     (`_fightAnchor` ставит tick в момент первого удара/подхода), а не по
     конечной точке приказа. Иначе дальний waypoint запрещал догонять врага,
     который стоит в двух шагах. */
  function leashAnchor(v) {
    if (v && v.target && v._fightAnchor) return v._fightAnchor;
    return baseAnchor(v);
  }

  function withinLeash(v, o) {
    var a = leashAnchor(v);
    if (!a || !o) return true;
    var d = isBuilding(o)
      ? distToBuilding(o, a.x, a.y)
      : Math.sqrt(dist2(o.x, o.y, a.x, a.y));
    return d <= a.r;
  }

  /* Допустимый БЛИЖНИЙ удар: ответ на него не фильтруется ни приказом, ни
     лагерем, ни якорем стычки. Близко — это клетки рядом с самим воином;
     убежавшего через полкарты не преследуем (погоня — уже отдельный поводок
     боя). */
  function withinSelfDefense(v, o) {
    if (!v || !o) return false;
    var d = isBuilding(o) ? distToBuilding(o, v.x, v.y)
      : Math.sqrt(dist2(o.x, o.y, v.x, v.y));
    return d <= SELF_DEFENSE;
  }

  function aliveBuilding(b) {
    return !!(b && !b.rubble && (b.hp === undefined || b.hp > 0));
  }

  function aliveVillager(v) {
    return !!(v && !v.dead && !v.hidden && !v.trainee);
  }

  function maxHpOf(o) {
    if (!o) return 0;
    if (isBuilding(o)) {
      var B = global.Buildings;
      var type = B && B.typeOf ? B.typeOf(o) : o.type;
      return HP[type] || 1;
    }
    return o.warrior ? HP.warrior : HP.villager;
  }

  /* Ленивая инициализация: старые миры и постройки, созданные до боя, не
     имеют hp. Заполняем один раз, не перетирая уже полученный урон. */
  function init(world, buildings, villagers) {
    var i, o;
    for (i = 0; i < (buildings || []).length; i++) {
      o = buildings[i];
      if (!o) continue;
      if (o.owner === undefined) o.owner = 0;
      if (!(o.maxHp > 0)) o.maxHp = maxHpOf(o);
      if (!(o.hp > 0) && !o.rubble) o.hp = o.maxHp;
      if (o.hpUntil === undefined) o.hpUntil = 0;
      if (o.flinch === undefined) o.flinch = 0;
    }
    for (i = 0; i < (villagers || []).length; i++) {
      o = villagers[i];
      if (!o) continue;
      if (o.owner === undefined) o.owner = 0;
      if (!(o.maxHp > 0)) o.maxHp = maxHpOf(o);
      if (!(o.hp > 0) && !o.dead) o.hp = o.maxHp;
      if (o.hpUntil === undefined) o.hpUntil = 0;
      if (o.flinch === undefined) o.flinch = 0;
      if (o.attackT === undefined) o.attackT = 0;
      if (o.attackTarget === undefined) o.attackTarget = null;
      if (o.holdFire === undefined) o.holdFire = false;
      if (o.noPathKey === undefined) o.noPathKey = null;
      if (o.noPathT === undefined) o.noPathT = 0;
      if (o._fightAnchor === undefined) o._fightAnchor = null;
    }
  }

  function dist2(ax, ay, bx, by) {
    var dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
  }

  /* Расстояние до постройки — до ближайшей клетки пятна, а не до центра: у
     ратуши 4 x 3 и лагеря 5 x 5 центр далеко от стены, и воин «не доставал»
     бы до края, стоя вплотную. */
  function distToBuilding(b, x, y) {
    var B = global.Buildings;
    var cells = B.cells(b), best = Infinity, i, dx, dy, d;
    for (i = 0; i < cells.length; i++) {
      dx = cells[i].x + 0.5 - x;
      dy = cells[i].y + 0.5 - y;
      d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  function distTo(o, x, y) {
    if (isBuilding(o)) return distToBuilding(o, x, y);
    return Math.sqrt(dist2(o.x, o.y, x, y));
  }

  /* Можно ли вообще взять это в цель: чужой, живой, в той же связной области
     (для юнита), с достижимым кольцом (для постройки), не в закрытой клетке
     чужого пятна и не в кеше недостижимого. Прямая проверяется отдельно —
     на выбор цели для юнитов и на самом ударе. */
  function canTarget(v, o, world, solid) {
    if (!o || o === v) return false;
    if (ownerOf(o) === ownerOf(v)) return false;
    if (isBuilding(o)) {
      if (!aliveBuilding(o)) return false;
    } else if (!aliveVillager(o)) {
      return false;
    }
    var map = solid || (world && global.Villagers ? solidMap(world, world._buildings) : null);
    if (v.noPathKey && v.noPathKey === targetKey(world, v, o)) return false;
    if (isBuilding(o)) {
      if (world && !canReachBuilding(world, v, o, map)) return false;
    } else {
      if (world && inClosedCell(world, o)) return false;
      if (world && !sameArea(world, v, o, map)) return false;
    }
    return true;
  }

  /* Ближайший враг в радиусе. Сначала цель по расстоянию, затем проверки:
     дешёвая дистанция отсекает почти всех, дорогие area/LOS остаются
     единицам. Ближний воин важнее здания — это отдельное правило в
     chooseTarget, а здесь просто «кто ближе». */
  function nearestEnemy(v, buildings, villagers, radius, world, solid) {
    var best = null, bestD = radius * radius, i, o, d;
    for (i = 0; i < (buildings || []).length; i++) {
      o = buildings[i];
      if (!o) continue;
      d = distToBuilding(o, v.x, v.y);
      if (d * d > bestD) continue;
      if (!canTarget(v, o, world, solid) || !withinLeash(v, o)) continue;
      bestD = d * d; best = o;
    }
    for (i = 0; i < (villagers || []).length; i++) {
      o = villagers[i];
      if (!o || o === v) continue;
      d = dist2(o.x, o.y, v.x, v.y);
      if (d > bestD) continue;
      if (!canTarget(v, o, world, solid) || !withinLeash(v, o)) continue;
      if (!clearShot(world, solid, v, o)) continue;
      bestD = d; best = o;
    }
    return best;
  }

  function nearestEnemyWarrior(v, villagers, radius, world, solid) {
    var best = null, bestD = radius * radius, i, o, d;
    for (i = 0; i < (villagers || []).length; i++) {
      o = villagers[i];
      if (!o || o === v || !o.warrior || ownerOf(o) === ownerOf(v)) continue;
      d = dist2(o.x, o.y, v.x, v.y);
      if (d > bestD) continue;
      if (!aliveVillager(o) || !townAlive(world, o)) continue;
      if (!canTarget(v, o, world, solid) || !withinLeash(v, o)) continue;
      if (!clearShot(world, solid, v, o)) continue;
      bestD = d; best = o;
    }
    return best;
  }

  /* Гражданские — такие же цели: воин не обязан игнорировать рабочего,
     который идёт ближе дома и не за стеной. */
  function nearestEnemyCivilian(v, villagers, radius, world, solid) {
    var best = null, bestD = radius * radius, i, o, d;
    for (i = 0; i < (villagers || []).length; i++) {
      o = villagers[i];
      if (!o || o === v || o.warrior || ownerOf(o) === ownerOf(v)) continue;
      d = dist2(o.x, o.y, v.x, v.y);
      if (d > bestD) continue;
      if (!aliveVillager(o) || !townAlive(world, o)) continue;
      if (!canTarget(v, o, world, solid) || !withinLeash(v, o)) continue;
      if (!clearShot(world, solid, v, o)) continue;
      bestD = d; best = o;
    }
    return best;
  }

  function townhallOf(owner, buildings) {
    var B = global.Buildings;
    for (var i = 0; i < (buildings || []).length; i++) {
      var b = buildings[i];
      if (b && !b.rubble && ownerOf(b) === owner && B.typeOf(b) === 'townhall') return b;
    }
    return null;
  }

  /* Воин в лагере защищает СВОЮ деревню: если вражеский воин выбрал целью
     постройку или жителя этой деревни (или подошёл к ратуше), он бросается
     на него даже с расстояния больше восьми. Это требование заказчика
     дословно: «замечает ... если вражеский воин выбрал цель в ЕГО деревне». */
  function defenderTarget(v, buildings, villagers, world, solid) {
    if (!v.warcamp || v.warcamp.rubble) return null;
    var th = townhallOf(ownerOf(v), buildings);
    if (!th) return null;
    var best = null, bestD = Infinity, i, e, t, d;
    for (i = 0; i < (villagers || []).length; i++) {
      e = villagers[i];
      if (!e || e === v || !e.warrior || !aliveVillager(e)) continue;
      if (ownerOf(e) === ownerOf(v)) continue;
      if (!townAlive(world, e)) continue;
      t = e.target;
      var threat = !!(t && ownerOf(t) === ownerOf(v));
      if (!threat) {
        var c = global.Buildings.center(th);
        threat = dist2(e.x, e.y, c.x, c.y) <= DEFEND_R * DEFEND_R;
      }
      if (!threat) continue;
      if (!withinLeash(v, e) || !canTarget(v, e, world, solid)) continue;
      if (!clearShot(world, solid, v, e)) continue;
      d = dist2(e.x, e.y, v.x, v.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /* Кого бить. Приоритет:
     0) после «Стопа» — только ответ на удар, сам цель не берёт;
     1) тот, кто только что ударил меня (если это воин);
     2) вражеский воин в 3 клетках важнее здания; гражданский — если он
        ближе здания;
     3) текущая цель, пока жива;
     4) цель, которую я отложил, — после убийства воина вернуться к зданию;
     5) ближайший враг в радиусе 8;
     6) защита деревни (для воина в лагере). */
  function chooseTarget(v, buildings, villagers, world, solid) {
    var t = v.target;

    /* «Стоп» — это не «подожди удара»: воин не берёт цель сам. Ответ на удар
       разрешён и НЕ зависит от поводка приказа: иначе стоп означал бы «убей
       меня, я не буду защищаться». Контракт явный: holdFire разрешает ровно
       ответ тому, кто ударил, пока тот рядом; новых целей нет. */
    if (v.holdFire) {
      v.targetWhy = 'hold';
      var att = v.attacker;
      if (att && v.attackerT > 0 && canTarget(v, att, world, solid) &&
          withinSelfDefense(v, att) &&
          clearShot(world, solid, v, att)) {
        return att;
      }
      return null;
    }

    if (t && (!canTarget(v, t, world, solid) || !withinLeash(v, t))) {
      v.targetWhy = canTarget(v, t, world, solid) ? 'leash' : 'invalid';
      t = null;
      v.target = null;
      /* Цель потеряна — стычка кончилась. Следующая заведёт свой якорь. */
      v._fightAnchor = null;
    }

    if (v.attacker && v.attackerT > 0 && canTarget(v, v.attacker, world, solid) &&
        withinSelfDefense(v, v.attacker) && v.attacker.warrior &&
        clearShot(world, solid, v, v.attacker)) {
      if (t && isBuilding(t) && v.prevTarget !== t) v.prevTarget = t;
      return v.attacker;
    }

    /* Ближний воин важнее здания: в радиусе 3 бросаем дом. Гражданский —
       если он ближе дома: идущий мимо рабочий не должен быть невидимкой. */
    if (t && isBuilding(t)) {
      var w = nearestEnemyWarrior(v, villagers, RETARGET_R, world, solid);
      if (w) {
        v.prevTarget = t;
        return w;
      }
      var c = nearestEnemyCivilian(v, villagers, AGGRO, world, solid);
      if (c && dist2(c.x, c.y, v.x, v.y) < distTo(t, v.x, v.y) * distTo(t, v.x, v.y)) {
        v.prevTarget = t;
        return c;
      }
    }

    if (t) return t;

    if (v.prevTarget && canTarget(v, v.prevTarget, world, solid) &&
        withinLeash(v, v.prevTarget)) {
      var back = v.prevTarget;
      v.prevTarget = null;
      return back;
    }

    /* Ближний воин важнее ближнего здания и в первом выборе. */
    var wNear = nearestEnemyWarrior(v, villagers, RETARGET_R, world, solid);
    if (wNear) return wNear;

    var near = nearestEnemy(v, buildings, villagers, AGGRO, world, solid);
    if (near) return near;

    var def = defenderTarget(v, buildings, villagers, world, solid);
    if (def) return def;

    return null;
  }

  function killVillager(v, world) {
    if (!v || v.dead) return;
    v.dead = true;
    v.hp = 0;
    v.hpUntil = 0;
    v.hidden = true;
    v.target = null;
    v.combatMode = null;
    v.attackTarget = null;
    v._fightAnchor = null;
    v.path = null;
    v.goal = null;
    v.trainee = false;
    v.trainingAt = null;
    v.trainT = 0;
    v.employer = null;
    v.job = null;
    v.station = null;
    v.garrisonSpot = null;
    v.warcamp = null;
    v.anim = 'idle';
  }

  function ruinBuilding(world, b, villagers) {
    var B = global.Buildings;
    if (!b || b.rubble) return;
    if (B && B.ruin) B.ruin(world, b, { villagers: villagers });
    else { b.rubble = true; b.hp = 0; b.hpUntil = 0; }
    if (global.Events && global.Events.push) {
      global.Events.push(world, {
        kind: 'destroy', owner: ownerOf(b),
        x: b.x === undefined ? null : b.x, y: b.y === undefined ? null : b.y,
        text: 'постройка разрушена', count: 1
      });
    }
  }

  function hit(world, v, target, opts) {
    var villagers = (opts && opts.villagers) || (world && world._villagers) || [];
    var before = target.hp || 0;
    var dmg = isBuilding(target) ? BUILDING_DAMAGE : WARRIOR_DAMAGE;
    target.hp = Math.max(0, before - dmg);
    if (traceOn && (traceWanted(v) || traceWanted(target))) {
      tracePush({
        t: +((world && world.time) || 0).toFixed(3), kind: 'hit',
        from: v && v.id, to: target && (target.id !== undefined ? target.id : 'bld'),
        dmg: Math.min(dmg, before), hp: target.hp
      });
    }
    /* Событие — только по настоящему урону: «на деревню напали» один раз на
       владельца за 8 с (Events.attack троттлит сам). Удар по уже мёртвому или
       по завалу события не создаёт. */
    if (target.hp < before) {
      target.hpUntil = (world.time || 0) + BAR_TIME;
      target.flinch = FLINCH_TIME;
      if (global.Events && global.Events.attack && world) {
        /* Журнал заводится ДО первого события: Events.throttled запоминает
           агрегат в world._evAgg, а ленивый init внутри push() заменил бы его
           новым объектом — тогда первый и второй удар дали бы два события
           вместо одного со счётчиком. В игре init зовёт Play.start; здесь —
           страховка для headless-миров и будущих режимов. */
        if (!world.events) global.Events.init(world);
        global.Events.attack(world, ownerOf(target), target.x, target.y);
      }
    }
    if (!isBuilding(target) && target.warrior) {
      target.attacker = v;
      target.attackerT = 2.5;
      /* Удар БУДИТ: ответ не ждёт следующей фазы think. Без этого воин с
         thinkT до 0.2 с и «фазой по id» замечал удар с задержкой, и
         требование «реакция в пределах think + допуск» зависело от id. */
      target.thinkT = 0;
    }
    if (target.hp <= 0) {
      if (isBuilding(target)) {
        ruinBuilding(world, target, villagers);
        if (global.Buildings.typeOf(target) === 'townhall' && opts && opts.onDefeat) {
          opts.onDefeat(ownerOf(target), target);
        }
      } else {
        killVillager(target, world);
      }
    }
  }

  /* Один кадр боя. Зовётся ДО Session.stepVillagers: цель и режим должны быть
     выставлены к тому моменту, как villager.js начнёт шаг. Урон наносится
     здесь же; движение — там. */
  function tick(world, dt, opts) {
    if (!world || !(dt > 0)) return;
    opts = opts || {};
    var buildings = opts.buildings || world._buildings || [];
    var villagers = opts.villagers || world._villagers || [];
    /* Область проходимости кэшируется по составу мира: пусть в ней будут
       именно те списки, по которым сейчас идёт бой. */
    if (opts.buildings) world._buildings = buildings;
    if (opts.villagers) world._villagers = villagers;
    /* Часы мира принадлежат ОДНОМУ владельцу шага. Server Simulation и
       локальная оболочка ставят world.time сами и передают advanceTime:false;
       старые прямые вызовы Combat.tick (приёмки, прототипы) по умолчанию
       двигают часы, как раньше. Иначе серверный тик и world.time расходились
       на один шаг. */
    if (opts.advanceTime !== false) world.time = (world.time || 0) + dt;
    init(world, buildings, villagers);
    var solid = opts.solid || solidMap(world, buildings);

    /* Одновременные удары разрешаются ПАКЕТОМ (BATTLE-01): сначала все, кто
       бьёт в этом кадре, выбирают цель и попадают в список, затем урон
       применяется. Раньше удар наносился прямо в цикле, и первый в массиве
       убивал второго до его хода: порядок массива/владельца давал
       систематическое преимущество, а встречные армии бились несимметрично.
       Теперь обе стороны бьют по состоянию НА НАЧАЛО кадра, включая
       добивающий удар погибшего в этом же кадре. */
    var pending = [];

    var i, v, t, d;
    /* Вздрагивание построек гаснет здесь же: иначе руина/дом тряслись бы
       вечно после первого попадания. */
    for (i = 0; i < buildings.length; i++) {
      var bb = buildings[i];
      if (bb && bb.flinch > 0) bb.flinch = Math.max(0, bb.flinch - dt);
    }
    for (i = 0; i < villagers.length; i++) {
      v = villagers[i];
      if (!v) continue;
      if (v.flinch > 0) v.flinch = Math.max(0, v.flinch - dt);
      if (v.attackerT > 0) v.attackerT = Math.max(0, v.attackerT - dt);
      else v.attacker = null;
      if (v.attackT > 0) v.attackT = Math.max(0, v.attackT - dt);

      /* Выбывший по ратуше наблюдает: его дружина больше не воюет, даже
         если стоит на карте. Иначе «наблюдатель» продолжал бы бой сам. */
      if (!townAlive(world, v)) {
        v.target = null;
        v.combatMode = null;
        v.attackTarget = null;
        v._fightAnchor = null;
        v.order = null;
        continue;
      }

      if (!v.warrior || v.dead || v.trainee) {
        v.target = null;
        v.combatMode = null;
        v.attackTarget = null;
        v._fightAnchor = null;
        continue;
      }

      v.thinkT = (v.thinkT || 0) - dt;
      if (v.thinkT <= 0) {
        /* Разные фазы у воинов: иначе все двадцать ищут цель в один кадр. */
        v.thinkT = THINK_EVERY + (v.id % 7) * 0.01;
        var before = v.target;
        v.target = chooseTarget(v, buildings, villagers, world, solid);
        /* Новая цель — новая стычка. Якорь старого боя не должен держать
           погоню за новой целью: он про то место, где дрались раньше. */
        if (v.target !== before && v.target !== v.attackTarget) v._fightAnchor = null;
      }

      t = v.target;
      if (!t || !canTarget(v, t, world, solid)) {
        v.target = null;
        v.combatMode = null;
        v.attackTarget = null;
        v._fightAnchor = null;
        v.noPathT = 0;
        continue;
      }

      /* Новая цель — замах. Удар по ней будет не раньше windup: урон не
         приходит в тот же кадр, что цель вошла в дальность. Якорь стычки
         ставится на МЕСТО ВСТРЕЧИ (текущую позицию), а не на конечную точку
         приказа: см. leashAnchor и BATTLE-01. */
      if (t !== v.attackTarget) {
        v.attackTarget = t;
        v.attackT = Math.max(v.attackT || 0, WINDUP);
        v.noPathT = 0;
        if (!v._fightAnchor) {
          v._fightAnchor = { x: v.x, y: v.y, r: FIGHT_LEASH };
        }
      }

      d = distTo(t, v.x, v.y);
      if (d <= ATTACK_RANGE) {
        v.noPathT = 0;
        /* Прямой нет — не бьём. Отсюда эту постройку не достать: запоминаем
           и отпускаем (следующий кадр вернёт к приказу/лагерю). Юнита не
           запоминаем по id: в ключ входит и его клетка, а он может отойти. */
        if (!clearShot(world, solid, v, t)) {
          v.targetWhy = 'no-shot';
          if (isBuilding(t)) v.noPathKey = targetKey(world, v, t);
          v.target = null;
          v.combatMode = null;
          v.attackTarget = null;
          v._fightAnchor = null;
          v.path = null;
          continue;
        }
        v.combatMode = 'attack';
        v.path = null;
        v.state = 'attack';
        if (v.attackT <= 0) {
          v.attackT = isBuilding(t) ? BUILDING_EVERY : ATTACK_EVERY;
          pending.push({ v: v, t: t });
        }
      } else {
        v.combatMode = 'chase';
        v.targetWhy = v.targetWhy === 'no-shot' ? 'no-shot' : '';
        /* Цель жива, а воин не идёт: пути нет уже chaseGiveUp секунд —
           значит, недостижима (за водой, в закрытом кармане, за стеной из
           домов). В кеш, чтобы не гонять A* по кругу. Путь есть — идёт, и
           это не «недостижима», даже если далеко. */
        if (v.path) {
          v.noPathT = 0;
        } else {
          v.noPathT = (v.noPathT || 0) + dt;
          if (v.noPathT >= CONFIG.chaseGiveUp) {
            v.targetWhy = 'unreachable';
            v.noPathKey = targetKey(world, v, t);
            v.target = null;
            v.combatMode = null;
            v.attackTarget = null;
            v._fightAnchor = null;
            v.noPathT = 0;
          }
        }
      }
    }

    /* След для выбранных юнитов — ОДНА запись на кадр на юнита, уже после
       выбора цели и режима. Здесь же видно, почему цель не взята. */
    if (traceOn) {
      for (i = 0; i < villagers.length; i++) {
        var tv = villagers[i];
        if (!traceWanted(tv)) continue;
        var ta = leashAnchor(tv);
        tracePush({
          t: +(world.time || 0).toFixed(3), kind: 'unit', id: tv.id,
          owner: ownerOf(tv), x: +tv.x.toFixed(2), y: +tv.y.toFixed(2),
          order: tv.order ? { x: tv.order.x, y: tv.order.y } : null,
          anchor: ta ? { x: +ta.x.toFixed(2), y: +ta.y.toFixed(2), r: ta.r } : null,
          target: tv.target ? (tv.target.id !== undefined ? tv.target.id : 'bld') : null,
          attacker: tv.attacker ? tv.attacker.id : null,
          mode: tv.combatMode || '', why: tv.targetWhy || '',
          holdFire: !!tv.holdFire
        });
      }
    }

    /* Пакетное применение урона. Порядок здесь больше не решает исход:
       каждая пара «кто бьёт → кого» выбрана до первого удара, и добивающий
       удар погибшего в этом кадре тоже считается. */
    for (i = 0; i < pending.length; i++) {
      var ph = pending[i];
      if (!ph || !ph.v || !ph.t) continue;
      hit(world, ph.v, ph.t, opts);
    }
  }

  /* Клетки, с которых можно бить постройку: кольцо вокруг пятна, по порядку
     близости. Проходимость проверяет villager.js: у него карта занятых клеток
     и лагерное кольцо. */
  function approachCells(world, b, x, y) {
    var B = global.Buildings;
    var bb = B.bounds(b), out = [], i, j;
    for (j = bb.y0 - 1; j <= bb.y1; j++) {
      for (i = bb.x0 - 1; i <= bb.x1; i++) {
        var inside = i >= bb.x0 && i < bb.x1 && j >= bb.y0 && j < bb.y1;
        if (inside) continue;
        if (world && (i < 0 || j < 0 || i >= world.width || j >= world.height)) continue;
        if (world && world.isLand && !world.isLand[j * world.width + i]) continue;
        out.push({ x: i, y: j, d: dist2(i + 0.5, j + 0.5, x, y) });
      }
    }
    out.sort(function (a, c) { return a.d - c.d; });
    return out;
  }

  global.Combat = {
    CONFIG: CONFIG,
    HP: HP,
    WARRIOR_DAMAGE: WARRIOR_DAMAGE,
    BUILDING_DAMAGE: BUILDING_DAMAGE,
    ATTACK_EVERY: ATTACK_EVERY,
    BUILDING_EVERY: BUILDING_EVERY,
    WINDUP: WINDUP,
    ATTACK_RANGE: ATTACK_RANGE,
    AGGRO: AGGRO,
    DEFEND_R: DEFEND_R,
    RETARGET_R: RETARGET_R,
    BAR_TIME: BAR_TIME,
    FLINCH_TIME: FLINCH_TIME,
    CAMP_LEASH: CAMP_LEASH,
    ORDER_LEASH: ORDER_LEASH,
    HOME_LEASH: HOME_LEASH,
    FIGHT_LEASH: FIGHT_LEASH,
    SELF_DEFENSE: SELF_DEFENSE,
    baseAnchor: baseAnchor,
    leashAnchor: leashAnchor,
    withinSelfDefense: withinSelfDefense,
    init: init,
    tick: tick,
    ownerOf: ownerOf,
    townAlive: townAlive,
    withinLeash: withinLeash,
    sameArea: sameArea,
    maxHpOf: maxHpOf,
    distTo: distTo,
    distToBuilding: distToBuilding,
    aliveBuilding: aliveBuilding,
    aliveVillager: aliveVillager,
    canTarget: canTarget,
    canReachBuilding: canReachBuilding,
    ringAreaIds: ringAreaIds,
    inClosedCell: inClosedCell,
    losBlocked: losBlocked,
    targetKey: targetKey,
    nearestEnemy: nearestEnemy,
    nearestEnemyWarrior: nearestEnemyWarrior,
    nearestEnemyCivilian: nearestEnemyCivilian,
    chooseTarget: chooseTarget,
    defenderTarget: defenderTarget,
    approachCells: approachCells,
    killVillager: killVillager,
    ruinBuilding: ruinBuilding,
    hit: hit,
    /* OBS-01: включаемый след боя для выбранных юнитов. */
    traceEnable: traceEnable,
    traceDisable: traceDisable,
    traceDump: traceDump
  };
})(typeof window !== 'undefined' ? window : globalThis);
