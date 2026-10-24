/* combat.js — бой: здоровье, цели, удары, смерть и завалы.

   Почему отдельный модуль, а не ещё одна ветка в villager.js. У жителя уже
   есть работа, прогулка, тренировка и дружина; бой — пятый режим, и если
   писать его там же, никто не скажет, кто в кадре двигает человека, а кто
   выбирает цель. Здесь только ПРАВИЛА боя: кого видит воин, когда бьёт и что
   остаётся от убитого. Движение по-прежнему в villager.js: он читает
   `v.target`/`v.combatMode` и идёт, а этот модуль только выставляет их и
   считает урон.

   Числа — требование заказчика (2026-10-23). Таблица HP одна на весь движок:
   HUD, приёмки и рендер спрашивают её здесь, а не помнят свои копии. */
(function (global) {
  'use strict';

  var HP = {
    villager: 15,
    warrior: 25,
    townhall: 120,
    house: 50,
    lumbercamp: 35,
    barracks: 80,
    warcamp: 40
  };

  var WARRIOR_DAMAGE = 6;       // за удар
  var ATTACK_EVERY = 0.8;       // с между ударами
  var AGGRO = 8;                // клеток: кого вообще замечает
  var DEFEND_R = 12;            // клеток от ратуши: «враг в деревне»
  var RETARGET_R = 3;           // клеток: воин бросает здание ради воина
  var ATTACK_RANGE = 1.2;       // клеток до центра клетки цели: соседняя по диагонали тоже достаёт
  var BAR_TIME = 5;             // с: сколько видна полоса после удара
  var FLINCH_TIME = 0.16;       // с: вздрагивание
  var THINK_EVERY = 0.2;        // с: как часто искать цель
  /* Насколько далеко воин может уйти от своего места службы/приказа за
     целью. Раньше текущая цель не отпускалась вообще, пока жива, и один
     враг, пробежавший мимо лагеря, уводил дружину через весь остров. */
  var CAMP_LEASH = 16;          // клеток от центра лагеря/двора
  var ORDER_LEASH = 10;         // клеток от точки приказа
  var HOME_LEASH = 8;           // клеток от места появления без лагеря

  function ownerOf(o) {
    if (!o) return -1;
    return o.owner === undefined ? 0 : o.owner;
  }

  function isBuilding(o) { return !!(o && o.kind === 'building'); }

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
  function sameArea(world, v, o) {
    if (!world || isBuilding(o) || !global.Villagers || !global.Villagers.areaAt) return true;
    var V = global.Villagers;
    var solid = V.blockedMap(world, world._buildings || []);
    var a = V.areaAt(world, solid, v.x, v.y);
    var b = V.areaAt(world, solid, o.x, o.y);
    if (a < 0 || b < 0) return true;
    return a === b;
  }

  /* Якорь, от которого считается погоня: точка приказа, лагерь, двор
     казармы или место появления. */
  function leashAnchor(v) {
    var B = global.Buildings;
    if (!v) return null;
    if (v.order) return { x: v.order.x, y: v.order.y, r: ORDER_LEASH };
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

  function withinLeash(v, o) {
    var a = leashAnchor(v);
    if (!a || !o) return true;
    var d = isBuilding(o)
      ? distToBuilding(o, a.x, a.y)
      : Math.sqrt(dist2(o.x, o.y, a.x, a.y));
    return d <= a.r;
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

  function canTarget(v, o, world) {
    if (!o || o === v) return false;
    if (ownerOf(o) === ownerOf(v)) return false;
    if (isBuilding(o)) {
      if (!aliveBuilding(o)) return false;
    } else if (!aliveVillager(o)) {
      return false;
    }
    /* Цель за водой/в отрезанном лесном кармане не выбирается вовсе: иначе
       каждый воин, увидев её, гоняет полный A* по острову. */
    if (world && !sameArea(world, v, o)) return false;
    return true;
  }

  function nearestEnemy(v, buildings, villagers, radius, world) {
    var best = null, bestD = radius * radius, i, o, d;
    for (i = 0; i < (buildings || []).length; i++) {
      o = buildings[i];
      if (!canTarget(v, o, world) || !withinLeash(v, o)) continue;
      d = distToBuilding(o, v.x, v.y);
      if (d * d <= bestD) { bestD = d * d; best = o; }
    }
    for (i = 0; i < (villagers || []).length; i++) {
      o = villagers[i];
      if (!canTarget(v, o, world) || !withinLeash(v, o)) continue;
      d = dist2(o.x, o.y, v.x, v.y);
      if (d <= bestD) { bestD = d; best = o; }
    }
    return best;
  }

  function nearestEnemyWarrior(v, villagers, radius, world) {
    var best = null, bestD = radius * radius, i, o, d;
    for (i = 0; i < (villagers || []).length; i++) {
      o = villagers[i];
      if (!o || o === v || !o.warrior || ownerOf(o) === ownerOf(v)) continue;
      if (!aliveVillager(o)) continue;
      if (!townAlive(world, o)) continue;
      if (world && !sameArea(world, v, o)) continue;
      d = dist2(o.x, o.y, v.x, v.y);
      if (d <= bestD) { bestD = d; best = o; }
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
  function defenderTarget(v, buildings, villagers, world) {
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
      if (!withinLeash(v, e)) continue;
      if (world && !sameArea(world, v, e)) continue;
      d = dist2(e.x, e.y, v.x, v.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /* Кого бить. Приоритет:
     1) тот, кто только что ударил меня (если это воин);
     2) вражеский воин рядом, если я бью здание;
     3) текущая цель, пока жива;
     4) цель, которую я отложил, — после убийства воина вернуться к зданию;
     5) ближайший враг в радиусе 8;
     6) защита деревни (для воина в лагере). */
  function chooseTarget(v, buildings, villagers, world) {
    var t = v.target;
    if (t && (!canTarget(v, t, world) || !withinLeash(v, t))) {
      t = null;
      v.target = null;
    }

    if (v.attacker && v.attackerT > 0 && canTarget(v, v.attacker, world) &&
        withinLeash(v, v.attacker) && v.attacker.warrior) {
      if (t && isBuilding(t) && v.prevTarget !== t) v.prevTarget = t;
      return v.attacker;
    }

    if (t && isBuilding(t)) {
      var w = nearestEnemyWarrior(v, villagers, RETARGET_R, world);
      if (w) {
        v.prevTarget = t;
        return w;
      }
    }

    if (t) return t;

    if (v.prevTarget && canTarget(v, v.prevTarget, world) &&
        withinLeash(v, v.prevTarget)) {
      var back = v.prevTarget;
      v.prevTarget = null;
      return back;
    }

    var near = nearestEnemy(v, buildings, villagers, AGGRO, world);
    if (near) return near;

    var def = defenderTarget(v, buildings, villagers, world);
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
  }

  function hit(world, v, target, opts) {
    var villagers = (opts && opts.villagers) || (world && world._villagers) || [];
    target.hp = Math.max(0, (target.hp || 0) - WARRIOR_DAMAGE);
    target.hpUntil = (world.time || 0) + BAR_TIME;
    target.flinch = FLINCH_TIME;
    if (!isBuilding(target) && target.warrior) {
      target.attacker = v;
      target.attackerT = 2.5;
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
    world.time = (world.time || 0) + dt;
    init(world, buildings, villagers);

    var i, v, t, d, mode;
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
        v.order = null;
        continue;
      }

      if (!v.warrior || v.dead || v.trainee) {
        v.target = null;
        v.combatMode = null;
        continue;
      }

      v.thinkT = (v.thinkT || 0) - dt;
      if (v.thinkT <= 0) {
        /* Разные фазы у воинов: иначе все двадцать ищут цель в один кадр. */
        v.thinkT = THINK_EVERY + (v.id % 7) * 0.01;
        v.target = chooseTarget(v, buildings, villagers, world);
      }

      t = v.target;
      if (!t || !canTarget(v, t, world)) {
        v.target = null;
        v.combatMode = null;
        continue;
      }
      d = distTo(t, v.x, v.y);
      if (d <= ATTACK_RANGE) {
        v.combatMode = 'attack';
        v.path = null;
        v.state = 'attack';
        if (v.attackT <= 0) {
          v.attackT = ATTACK_EVERY;
          hit(world, v, t, opts);
        }
      } else {
        v.combatMode = 'chase';
      }
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
    HP: HP,
    WARRIOR_DAMAGE: WARRIOR_DAMAGE,
    ATTACK_EVERY: ATTACK_EVERY,
    AGGRO: AGGRO,
    DEFEND_R: DEFEND_R,
    RETARGET_R: RETARGET_R,
    ATTACK_RANGE: ATTACK_RANGE,
    BAR_TIME: BAR_TIME,
    FLINCH_TIME: FLINCH_TIME,
    CAMP_LEASH: CAMP_LEASH,
    ORDER_LEASH: ORDER_LEASH,
    HOME_LEASH: HOME_LEASH,
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
    nearestEnemy: nearestEnemy,
    chooseTarget: chooseTarget,
    defenderTarget: defenderTarget,
    approachCells: approachCells,
    killVillager: killVillager,
    ruinBuilding: ruinBuilding,
    hit: hit
  };
})(typeof window !== 'undefined' ? window : globalThis);
