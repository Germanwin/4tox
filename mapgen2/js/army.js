/* army.js — управление дружиной: группы, выбор и приказ по карте.

   Заказчик (2026-10-23) хочет выбирать не «всех воинов» одной кнопкой, а
   гибко: всех, только из конкретного лагеря, половину, половину из лагеря.
   Поэтому здесь нет «отряда» как отдельной сущности — есть ГРУППЫ по местам
   службы (лагерь, двор казармы), а выбор — это число от каждой группы.

   Приказ — не «идти в точку» толпой: каждому воину выдаётся СВОЁ место в
   круге вокруг точки. Иначе двадцать человек сходятся в одну клетку и
   выглядят одним спрайтом. Места считаются детерминированно (золотой угол),
   чтобы один и тот же приказ давал одну и ту же картину. */
(function (global) {
  'use strict';

  var MIN_R = 2.5;       // клеток: радиус зоны приказа
  var SPACING = 1.0;     // клеток между местами
  var GOLDEN = 2.399963229728653;

  function ownerOf(v) { return v && v.owner !== undefined ? v.owner : 0; }

  function isWarrior(v) { return !!(v && v.warrior && !v.dead && !v.trainee); }

  function typeOf(b) {
    return global.Buildings && global.Buildings.typeOf
      ? global.Buildings.typeOf(b) : (b && b.type);
  }

  function groupKey(b) {
    return b.x + ':' + b.y + ':' + b.rot;
  }

  /* Группы воинов по местам службы. Лагерь — до 20, двор казармы — до 10;
     воин без места попадает в «резерв», чтобы не пропасть из интерфейса.

     Постройки тоже свои: в сети в мире лежат лагеря и казармы ВСЕХ игроков, а
     панель «Войска» — это дружина ЭТОГО игрока (2026-10-24). Без отбора чужая
     пустая казарма попадала в список, а чужой лагерь с воинами — тем более.
     Владелец группы тот же, по кому отбираются воины в add(). */
  function groups(buildings, villagers, owner) {
    var camps = [], bars = [], orphan = [], i, b, v;
    for (i = 0; i < (buildings || []).length; i++) {
      b = buildings[i];
      if (!b || b.rubble || ownerOf(b) !== owner) continue;
      if (typeOf(b) === 'warcamp') camps.push(b);
      else if (typeOf(b) === 'barracks') bars.push(b);
    }
    for (i = 0; i < (villagers || []).length; i++) {
      v = villagers[i];
      if (!isWarrior(v) || ownerOf(v) !== owner) continue;
      if (v.warcamp && !v.warcamp.rubble) continue;
      if (v.station && !v.station.rubble) continue;
      orphan.push(v);
    }
    var out = [], n = 0;
    function add(kind, building, name, cap) {
      var ids = [], j, w;
      for (j = 0; j < (villagers || []).length; j++) {
        w = villagers[j];
        if (!isWarrior(w) || ownerOf(w) !== owner) continue;
        if (kind === 'warcamp' && w.warcamp === building && !w.station) ids.push(w);
        if (kind === 'barracks' && w.station === building) ids.push(w);
      }
      ids.sort(function (a, c) { return (a.id || 0) - (c.id || 0); });
      if (!ids.length && !building) return;
      out.push({
        key: building ? kind + ':' + groupKey(building) : 'reserve',
        kind: kind, building: building, name: name,
        cap: cap || 0, count: ids.length, ids: ids
      });
    }
    camps.sort(function (a, c) { return (a.x + a.y) - (c.x + c.y); });
    bars.sort(function (a, c) { return (a.x + a.y) - (c.x + c.y); });
    for (i = 0; i < camps.length; i++) {
      add('warcamp', camps[i], 'Лагерь №' + (i + 1), global.Buildings.WARCAMP_CAP);
    }
    for (i = 0; i < bars.length; i++) {
      add('barracks', bars[i], 'Двор казармы №' + (i + 1), global.Buildings.BARRACKS_YARD_CAP);
    }
    if (orphan.length) {
      out.push({ key: 'reserve', kind: 'reserve', building: null, name: 'Без места',
        cap: 0, count: orphan.length, ids: orphan });
    }
    return out;
  }

  function half(n) { return n > 1 ? Math.ceil(n / 2) : n; }

  /* «Половина» от всего отряда — это половина ВСЕХ воинов, а не сумма
     половин по группам: при 3 + 3 берётся 3, а не 2 + 2. Места раздаются
     пропорционально размеру групп; если от нечётного остался один, его
     получает группа с большей дробной частью. Порядок групп — тот же, что в
     панели, поэтому один и тот же отряд всегда даёт один и тот же выбор. */
  function halfCounts(groupsList) {
    var list = groupsList || [], out = {}, rest = [], i, g, total = 0, want = 0, got = 0;
    for (i = 0; i < list.length; i++) total += list[i].ids.length;
    want = total > 1 ? Math.ceil(total / 2) : total;
    for (i = 0; i < list.length; i++) {
      g = list[i];
      var exact = total ? want * g.ids.length / total : 0;
      var n = Math.floor(exact);
      out[g.key] = n;
      got += n;
      rest.push({ key: g.key, rem: exact - n, max: g.ids.length, at: i });
    }
    /* Остаток — по дробной части. Одинаковые доли разрешает порядок групп. */
    rest.sort(function (a, c) { return (c.rem - a.rem) || (a.at - c.at); });
    while (got < want) {
      var took = false;
      for (i = 0; i < rest.length && got < want; i++) {
        if (out[rest[i].key] < rest[i].max) {
          out[rest[i].key]++;
          got++;
          took = true;
        }
      }
      if (!took) break;
    }
    return out;
  }

  function sumCounts(counts) {
    var n = 0;
    for (var k in counts) if (Object.prototype.hasOwnProperty.call(counts, k)) n += counts[k];
    return n;
  }

  /* Выбор по числам от групп. counts: {ключ группы: сколько}. */
  function select(groupsList, counts) {
    var ids = [], i, g, n, j;
    for (i = 0; i < (groupsList || []).length; i++) {
      g = groupsList[i];
      n = Math.max(0, Math.min(g.ids.length, counts[g.key] || 0));
      for (j = 0; j < n; j++) ids.push(g.ids[j]);
    }
    return ids;
  }

  function wardens(ids, villagers) {
    var out = [], i, j, id;
    for (i = 0; i < (ids || []).length; i++) {
      id = (ids[i] && typeof ids[i] === 'object') ? ids[i].id : ids[i];
      for (j = 0; j < (villagers || []).length; j++) {
        if (villagers[j] && villagers[j].id === id && isWarrior(villagers[j])) {
          out.push(villagers[j]);
          break;
        }
      }
    }
    return out;
  }

  /* Область проходимости вокруг точки клика. Место воина — не просто суша,
     а клетка ТОЙ ЖЕ связной области: иначе на берегу часть круга попадает на
     другой берег, пути туда нет, и воины вечно повторяют обход острова.
     Возвращает null, если Villagers ещё не загружен (старые тесты). */
  function areaAround(world, cx, cy) {
    var V = global.Villagers;
    if (!world || !V || !V.areas || !V.blockedMap) return null;
    var solid = V.blockedMap(world, world._buildings || []);
    var grid = V.areas(world, solid);
    var sx = Math.floor(cx), sy = Math.floor(cy), id = -1;
    if (V.walkable(world, solid, sx, sy)) id = grid.ids[sy * world.width + sx];
    /* Клик пришёлся на воду или пятно дома: берём ближайшую проходимую
       клетку в пределах кольца, как это делает freeCell. */
    for (var r = 1; r <= 5 && id < 0; r++) {
      for (var dy = -r; dy <= r && id < 0; dy++) {
        for (var dx = -r; dx <= r && id < 0; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          var nx = sx + dx, ny = sy + dy;
          if (!V.walkable(world, solid, nx, ny)) continue;
          id = grid.ids[ny * world.width + nx];
        }
      }
    }
    if (id < 0) return { solid: solid, grid: grid, id: -1 };
    return { solid: solid, grid: grid, id: id };
  }

  function freeCell(world, x, y, used, taken, area) {
    var r, dx, dy, nx, ny, key;
    for (r = 0; r <= 5; r++) {
      for (dy = -r; dy <= r; dy++) {
        for (dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          nx = x + dx; ny = y + dy;
          key = nx + ',' + ny;
          if (used[key]) continue;
          if (taken && taken[key]) continue;
          if (world && world.isLand &&
              (nx < 0 || ny < 0 || nx >= world.width || ny >= world.height ||
               !world.isLand[ny * world.width + nx])) continue;
          if (area && area.id >= 0 &&
              area.grid.ids[ny * world.width + nx] !== area.id) continue;
          used[key] = 1;
          return { x: nx, y: ny };
        }
      }
    }
    /* Настоящего места не нашлось. Раньше возвращалась сама точка — часто
       вода или пятно, — и воин бесконечно ходил в недостижимую клетку.
       Лучше не отдавать место вовсе: order пропустит этого воина. */
    if (area) return null;
    used[x + ',' + y] = 1;
    return { x: x, y: y };
  }

  /* Места в круге вокруг точки. Радиус растёт с числом воинов, чтобы и
     двадцать, и сорок получили разное место, а не встали в одну клетку. */
  function formation(world, cx, cy, n, opts) {
    var out = [], used = {}, blocked = {}, i, r, a, x, y, B = global.Buildings;
    var area = (opts && opts.area) || null;
    if (!(n > 0)) return out;
    /* Пятна построек — не места для ног. Вода проверяется в freeCell, а
       постройки здесь: у Army нет карты проходимости, но клетки пятен есть. */
    var list = (world && world._buildings) || [];
    for (i = 0; i < list.length; i++) {
      if (!list[i] || list[i].rubble || !B) continue;
      var cells = B.cells(list[i]);
      for (var j = 0; j < cells.length; j++) blocked[cells[j].x + ',' + cells[j].y] = 1;
    }
    r = Math.max(MIN_R, Math.sqrt(n) * SPACING * 0.9);
    for (i = 0; i < n; i++) {
      var rad = r * Math.sqrt((i + 0.5) / n);
      a = i * GOLDEN;
      x = Math.floor(cx + Math.cos(a) * rad);
      y = Math.floor(cy + Math.sin(a) * rad);
      out.push(freeCell(world, x, y, used, blocked, area));
    }
    return out;
  }

  /* Выходит ли лагерь на ту же область, что и точка клика. Внутри пятна
     клетки закрыты, поэтому смотрим кольцо вокруг пятна: если хоть одна
     клетка кольца проходима и лежит в области клика — из лагеря можно
     выйти и дойти. */
  function touchesArea(world, b, area) {
    var B = global.Buildings, V = global.Villagers;
    if (!world || !b || !area || !B || !V) return true;
    var bb = B.bounds(b), x, y, i;
    for (y = bb.y0 - 1; y <= bb.y1; y++) {
      for (x = bb.x0 - 1; x <= bb.x1; x++) {
        var inside = x >= bb.x0 && x < bb.x1 && y >= bb.y0 && y < bb.y1;
        if (inside) continue;
        if (!V.walkable(world, area.solid, x, y)) continue;
        i = y * world.width + x;
        if (area.grid.ids[i] === area.id) return true;
      }
    }
    return false;
  }

  /* Приказ: выбрать каждому своё место и записать цель. Воин сам проложит
     путь в villager.js; здесь только данные приказа.

     Места выдаются только в той же связной области, что и точка клика. Воины
     из другой области в приказ не попадают: они всё равно не дойдут, а их
     попытки «дойти» стоят полного обхода острова каждая. */
  function order(world, ids, villagers, x, y) {
    var all = wardens(ids, villagers), i, list = [], skipped = 0;
    if (!all.length) return { ok: false, reason: 'воинов не выбрано', count: 0, skipped: 0 };
    var area = areaAround(world, x, y);
    if (area && area.id < 0) {
      return { ok: false, reason: 'туда не дойти: другой берег', count: 0, skipped: all.length };
    }
    var B = global.Buildings;
    for (i = 0; i < all.length; i++) {
      var w = all[i];
      if (!area) { list.push(w); continue; }
      var cx = Math.floor(w.x), cy = Math.floor(w.y);
      var inCamp = w.warcamp && B && B.insideWarcamp(w.warcamp, w.x, w.y);
      var walkHere = global.Villagers &&
        global.Villagers.walkable(world, area.solid, cx, cy);
      /* В лагере клетка занята пятном, и area там -1. Смотрим, выходит ли
         кольцо лагеря в область клика: лагерь на другом острове не должен
         отправлять своих воинов в вечный обход. Остальные, уже стоящие на
         своей земле в другой области, тоже не дойдут. */
      if (inCamp) {
        if (!touchesArea(world, w.warcamp, area)) { skipped++; continue; }
      } else if (walkHere && area.grid.ids[cy * world.width + cx] !== area.id) {
        skipped++;
        continue;
      }
      list.push(w);
    }
    if (!list.length) {
      return { ok: false, reason: 'туда не дойти: другой берег',
        count: 0, skipped: skipped };
    }
    var slots = formation(world, x, y, list.length, area ? { area: area } : null);
    var assigned = 0;
    for (i = 0; i < list.length; i++) {
      var v = list[i], s = slots[i];
      if (!s) { skipped++; continue; }
      v.target = null;
      v.combatMode = null;
      v.prevTarget = null;
      v.path = null;
      v.goal = null;
      v.stuck = 0;
      v.routeFail = 0;
      v.combatFail = 0;
      /* Первые шаги путей разносятся по кадрам: иначе 128 A* стартуют в
         одном кадре и дают заметный столб на 0.3–1 с. */
      v.routeT = (i % 16) * 0.04;
      v.order = {
        x: s.x + 0.5, y: s.y + 0.5, r: MIN_R,
        issuedAt: (world && world.time) || 0, done: false
      };
      v.state = 'march';
      assigned++;
    }
    return {
      ok: assigned > 0, reason: '',
      count: assigned, skipped: skipped,
      slots: slots.filter(function (s) { return !!s; })
    };
  }

  function stop(ids, villagers) {
    var list = wardens(ids, villagers), i;
    for (i = 0; i < list.length; i++) {
      list[i].order = null;
      list[i].path = null;
      list[i].routeFail = 0;
      list[i].combatFail = 0;
      list[i].state = 'stand';
    }
    return list.length;
  }

  global.Army = {
    MIN_R: MIN_R,
    SPACING: SPACING,
    groups: groups,
    half: half,
    halfCounts: halfCounts,
    sumCounts: sumCounts,
    select: select,
    wardens: wardens,
    formation: formation,
    order: order,
    stop: stop
  };
})(typeof window !== 'undefined' ? window : globalThis);
