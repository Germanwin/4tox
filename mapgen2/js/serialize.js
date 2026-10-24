/* serialize.js — снимок мира для сети.

   Хост считает мир, клиенты только рисуют. Значит по проводу должно уехать
   всё, что видно: постройки, жители, деревни и время. Лес по сиду у всех
   одинаковый, поэтому карту (tile/isLand) не шлём — только номера убранных
   объектов.

   Формат снимка (v2):
     seq          — номер снимка, растёт на единицу. Клиент применяет только
                    более новые: запоздавший ответ не откатывает мир назад.
     t            — игровое время хоста.
     seed, size   — какая это партия; чужой снимок не применяется.
     towns        — казна и жизнь деревень.
     buildings    — постройки целиком: их единицы, а не тысячи.
     villagers    — жители целиком: их тоже единицы.
     objectTotal  — сколько объектов природы было до первой рубки.
     removed      — битовая карта убранного, hex-строкой. Раньше здесь был
                    массив номеров, и он рос с каждой срубленной травинкой:
                    к середине партии каждый снимок (10 раз в секунду) тащил
                    весь список заново. Битовая карта занимает objectTotal/8
                    байт и не зависит от того, сколько уже убрано.
     notes        — редкие ответы хоста на команды (отказ словами).
     over, winner — партия кончена и номер победившего города. Клиент считает
                    свой «Победа/Поражение» по playerOwner; без этих полей он
                    видел только замороженный кадр.

   Применение на клиенте — не замена списков, а СВЕРКА по id: объекты
   жителей и построек переиспользуются. Иначе каждые 100 мс выбранный житель,
   открытая постройка и захваченный отряд указывали бы на старые объекты, а
   миникарта пересобиралась бы на каждый снимок (см. render.js:setBuildings). */
(function (global) {
  'use strict';

  var HEX = '0123456789abcdef';

  function townSnap(t) {
    return {
      id: t.id, owner: t.owner, name: t.name, color: t.color,
      alive: t.alive !== false, isBot: !!t.isBot,
      logs: t.logs || 0, deliveries: t.deliveries || 0,
      felled: t.felled || 0, inTransit: t.inTransit || 0
    };
  }

  function buildingSnap(b) {
    return {
      id: b.id, type: b.type, variant: b.variant, rot: b.rot,
      x: b.x, y: b.y, owner: b.owner, town: b.town,
      hp: b.hp, maxHp: b.maxHp, hpUntil: b.hpUntil || 0,
      flinch: +(b.flinch || 0).toFixed(2), rubble: !!b.rubble
    };
  }

  function villagerSnap(v) {
    return {
      id: v.id, owner: v.owner, town: v.town,
      x: +v.x.toFixed(3), y: +v.y.toFixed(3),
      rot: Math.round(v.rot || 0), anim: v.anim || 'idle',
      phase: +(v.phase || 0).toFixed(3), frozen: !!v.frozen,
      state: v.state || 'wander', warrior: !!v.warrior,
      trainee: !!v.trainee, hidden: !!v.hidden,
      trainingId: v.trainingAt ? v.trainingAt.id : null,
      trainT: +(v.trainT || 0).toFixed(3),
      homeId: v.home ? v.home.id : null,
      employerId: v.employer ? v.employer.id : null,
      campId: v.warcamp ? v.warcamp.id : null,
      stationId: v.station ? v.station.id : null,
      hp: v.hp, maxHp: v.maxHp, hpUntil: v.hpUntil || 0,
      flinch: +(v.flinch || 0).toFixed(2), attackT: +(v.attackT || 0).toFixed(2),
      carrying: !!v.carrying,
      appearT: v.appearT, appearDur: v.appearDur,
      vanishT: v.vanishT, emergeT: v.emergeT,
      dead: !!v.dead
    };
  }

  /* Сколько объектов природы было изначально. У мира, созданного до
     появления objectTotal, число восстанавливается по максимальному id. */
  function objectTotal(world) {
    if (world.objectTotal) return world.objectTotal;
    var total = 0, i, objs = world.objects || [], ids = world.removedIds || [];
    for (i = 0; i < objs.length; i++) {
      if (objs[i] && objs[i].id >= total) total = objs[i].id + 1;
    }
    for (i = 0; i < ids.length; i++) if (ids[i] >= total) total = ids[i] + 1;
    world.objectTotal = total;
    return total;
  }

  /* Битовая карта убранного: id объекта — номер бита. Строка hex, а не
     base64: btoa/atob есть не во всех окружениях, а разница в размере
     невелика. Кэш по длине removedIds: хост только дописывает в конец. */
  function removedHex(world) {
    var total = objectTotal(world);
    var ids = world.removedIds || [];
    var cache = world._removedHexCache;
    if (cache && cache.n === ids.length && cache.total === total) return cache.hex;
    var bytes = new Uint8Array((total + 7) >> 3);
    var i;
    for (i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (typeof id === 'number' && id >= 0 && id < total) bytes[id >> 3] |= 1 << (id & 7);
    }
    var hex = '';
    for (i = 0; i < bytes.length; i++) hex += HEX.charAt(bytes[i] >> 4) + HEX.charAt(bytes[i] & 15);
    world._removedHexCache = { n: ids.length, total: total, hex: hex };
    return hex;
  }

  function removedList(world, snap) {
    if (Array.isArray(snap.removed)) return snap.removed;   // старый формат
    if (typeof snap.removed !== 'string') return null;
    var hex = snap.removed;
    if (hex.length & 1) return null;
    var total = snap.objectTotal || objectTotal(world);
    var bytes = new Uint8Array(hex.length >> 1);
    for (var i = 0; i < bytes.length; i++) {
      var a = HEX.indexOf(hex.charAt(i * 2));
      var b = HEX.indexOf(hex.charAt(i * 2 + 1));
      if (a < 0 || b < 0) return null;
      bytes[i] = (a << 4) | b;
    }
    var out = [];
    for (i = 0; i < total; i++) {
      if (bytes[i >> 3] & (1 << (i & 7))) out.push(i);
    }
    return out;
  }

  /* Снимок. opts.seq — номер (хост ведёт счётчик), opts.notes — ответы
     клиентам, которые ещё не доехали. */
  function world(world, buildings, villagers, opts) {
    opts = opts || {};
    var snap = {
      t: +(world.time || 0).toFixed(3),
      seed: world.seed, size: world.islandSize,
      towns: (world.towns || [world.village]).map(townSnap),
      buildings: (buildings || []).map(buildingSnap),
      villagers: (villagers || []).map(villagerSnap),
      objectTotal: objectTotal(world),
      removed: removedHex(world)
    };
    if (opts.seq !== undefined) snap.seq = opts.seq;
    if (opts.notes && opts.notes.length) snap.notes = opts.notes;
    /* Итог партии едет вместе с миром: клиент не считает бой и иначе никогда
       не узнал бы, что партия кончилась и кто победил. `winner` — номер
       деревни, а не id игрока в лобби: у клиента есть свой playerOwner. */
    if (opts.over !== undefined) snap.over = !!opts.over;
    if (opts.winner !== undefined) snap.winner = opts.winner;
    return snap;
  }

  /* Сверка одного жителя. Позицию при включённом smooth не переставляем
     скачком: Play.tick доводит её до цели между снимками. Крупный скачок
     (телепорт, выход из казармы, переподключение) ставим сразу — иначе
     житель «летел» бы через полкарты. */
  function updateVillager(v, vs, opts) {
    var fresh = !v._net;
    var tx = vs.x, ty = vs.y;
    if (fresh || !opts.smooth) {
      v.x = tx; v.y = ty;
    } else if (Math.abs(tx - v.x) + Math.abs(ty - v.y) > 3) {
      v.x = tx; v.y = ty;
    }
    v._net = true;
    v._netTX = tx; v._netTY = ty;

    v.id = vs.id; v.owner = vs.owner; v.town = vs.town;
    v.rot = vs.rot; v.anim = vs.anim; v.phase = vs.phase;
    v.frozen = !!vs.frozen; v.state = vs.state; v.warrior = !!vs.warrior;
    v.trainee = !!vs.trainee; v.hidden = !!vs.hidden;
    v.trainingId = vs.trainingId === undefined ? null : vs.trainingId;
    v.trainT = vs.trainT || 0;
    v.hp = vs.hp; v.maxHp = vs.maxHp; v.hpUntil = vs.hpUntil;
    v.flinch = vs.flinch || 0; v.attackT = vs.attackT || 0;
    v.carrying = !!vs.carrying;
    v.appearT = vs.appearT; v.appearDur = vs.appearDur;
    v.vanishT = vs.vanishT; v.emergeT = vs.emergeT;
    v.dead = !!vs.dead;
    v.homeId = vs.homeId; v.employerId = vs.employerId;
    v.campId = vs.campId; v.stationId = vs.stationId;
    /* Клиент не считает путь: он только рисует. Поля движения хоста на
       клиенте не нужны; порядок боя и отряда клиент берёт из id. */
    v.path = null; v.goal = null; v.spot = null; v.order = null;
    v.target = null; v.combatMode = null;
  }

  /* Применить снимок на клиенте. Мир уже сгенерирован по тому же сиду;
     здесь сверяются только изменяемые списки. */
  function apply(world, snap, renderer, opts) {
    opts = opts || {};
    if (!world || !snap) return { buildings: [], villagers: [], structural: false };
    var B = global.Buildings, i;
    world.time = snap.t || 0;
    if (snap.over !== undefined) world.over = !!snap.over;
    if (snap.winner !== undefined) world.winner = snap.winner;

    /* --- деревни ----------------------------------------------------- */
    if (snap.towns) {
      if (!world.towns) world.towns = [];
      for (i = 0; i < snap.towns.length; i++) {
        var ts = snap.towns[i];
        var t = world.towns[i];
        if (!t || t.id !== ts.id) {
          t = { id: ts.id, owner: ts.owner, name: ts.name, color: ts.color,
            alive: true, isBot: false, buildings: [], villagers: [], townhall: null };
          world.towns[i] = t;
        }
        t.owner = ts.owner; t.name = ts.name; t.color = ts.color;
        t.alive = ts.alive; t.isBot = ts.isBot;
        t.logs = ts.logs; t.deliveries = ts.deliveries;
        t.felled = ts.felled; t.inTransit = ts.inTransit;
        t.townhall = null;
        t.buildings = [];
        t.villagers = [];
      }
      world.village = world.towns[opts.owner || 0] || world.towns[0];
    }

    /* --- постройки ---------------------------------------------------- */
    var oldBuildings = world._buildings || (renderer && renderer.buildings) || [];
    var byB = {}, oldCount = 0;
    for (i = 0; i < oldBuildings.length; i++) {
      if (oldBuildings[i] && oldBuildings[i].id !== undefined) {
        byB[oldBuildings[i].id] = oldBuildings[i];
        oldCount++;
      }
    }
    var hold = opts.hold || null;
    var structural = false;
    var list = [];
    for (i = 0; i < (snap.buildings || []).length; i++) {
      var bs = snap.buildings[i];
      var b = byB[bs.id];
      if (!b) {
        b = B.make({
          id: bs.id, type: bs.type, variant: bs.variant, rot: bs.rot,
          x: bs.x, y: bs.y, owner: bs.owner, town: bs.town
        });
        structural = true;
      } else {
        delete byB[bs.id];
        var sameSpot = (b.x === bs.x && b.y === bs.y && b.rot === bs.rot &&
          b.type === bs.type && b.variant === bs.variant);
        if (!sameSpot && b !== hold) {
          b.x = bs.x; b.y = bs.y; b.rot = bs.rot;
          b.type = bs.type; b.variant = bs.variant;
          structural = true;
        } else if (!sameSpot) {
          /* Постройку ведут мышью на клиенте: не откатываем её под курсором
             до ответа хоста. Когда правка закроется, следующий снимок
             поставит её на место. */
          b.type = bs.type; b.variant = bs.variant;
        }
      }
      var wasRubble = !!b.rubble;
      b.id = bs.id; b.owner = bs.owner; b.town = bs.town;
      b.hp = bs.hp; b.maxHp = bs.maxHp; b.hpUntil = bs.hpUntil || 0;
      b.flinch = bs.flinch || 0; b.rubble = !!bs.rubble;
      if (wasRubble !== b.rubble) structural = true;
      list.push(b);

      if (world.towns && world.towns[bs.town]) {
        var town = world.towns[bs.town];
        town.buildings.push(b);
        if (!b.rubble && B.typeOf(b) === 'townhall') town.townhall = b;
      }
    }
    if (oldCount !== list.length) structural = true;
    else {
      for (var oid in byB) {
        if (Object.prototype.hasOwnProperty.call(byB, oid)) { structural = true; break; }
      }
    }

    /* --- жители ------------------------------------------------------- */
    var oldVillagers = world._villagers || (renderer && renderer.villagers) || [];
    var byV = {};
    for (i = 0; i < oldVillagers.length; i++) {
      if (oldVillagers[i] && oldVillagers[i].id !== undefined) {
        byV[oldVillagers[i].id] = oldVillagers[i];
      }
    }
    var vlist = [];
    for (i = 0; i < (snap.villagers || []).length; i++) {
      var vs = snap.villagers[i];
      var v = byV[vs.id] || {};
      delete byV[vs.id];
      updateVillager(v, vs, opts);
      vlist.push(v);
    }

    /* --- ссылки на постройки ----------------------------------------- */
    var byId = {};
    for (i = 0; i < list.length; i++) byId[list[i].id] = list[i];
    for (i = 0; i < vlist.length; i++) {
      var vv = vlist[i];
      vv.home = vv.homeId !== null && vv.homeId !== undefined ? byId[vv.homeId] || null : null;
      vv.trainingAt = vv.trainingId !== null && vv.trainingId !== undefined
        ? byId[vv.trainingId] || null : null;
      vv.employer = vv.employerId !== null && vv.employerId !== undefined ? byId[vv.employerId] || null : null;
      vv.warcamp = vv.campId !== null && vv.campId !== undefined ? byId[vv.campId] || null : null;
      vv.station = vv.stationId !== null && vv.stationId !== undefined ? byId[vv.stationId] || null : null;
      if (world.towns && world.towns[vv.town]) world.towns[vv.town].villagers.push(vv);
    }

    world._buildings = list;
    world._villagers = vlist;

    /* --- убранное (битовая карта) ------------------------------------ *
     * Сначала сравниваем САМУ карту с прошлой: если рубки не было, decoding
     * тысяч бит и фильтрация списка объектов не нужны. */
    var removedChanged = false;
    var total = snap.objectTotal || objectTotal(world);
    var sig = typeof snap.removed === 'string'
      ? snap.removed
      : (Array.isArray(snap.removed) ? ('a' + snap.removed.length) : null);
    if (sig !== null && (world._removedSig !== sig || world._removedTotal !== total)) {
      var removed = removedList(world, snap);
      if (removed) {
        if (world.objects) {
          var gone = {}, keep = [];
          for (i = 0; i < removed.length; i++) gone[removed[i]] = 1;
          for (i = 0; i < world.objects.length; i++) {
            if (world.objects[i] && !gone[world.objects[i].id]) keep.push(world.objects[i]);
          }
          world.objects = keep;
        }
        world.removedIds = removed;
        world._removedSig = sig;
        world._removedTotal = total;
        removedChanged = true;
      }
    } else if (world.objectTotal !== total) {
      world.objectTotal = total;
    }

    if (renderer) {
      /* Миникарту пересобираем только когда изменился СОСТАВ или место
         построек, либо лес. На обычном снимке (жители идут, HP меняется) она
         не трогается — иначе 12 раз в секунду пересобирался бы холст. */
      if (renderer.setBuildings) renderer.setBuildings(list, { minimap: structural || removedChanged });
      if (renderer.setVillagers) renderer.setVillagers(vlist);
      /* Выбор и правку не сбрасываем: объекты те же. Убираем только то, чего
         в новом снимке больше нет. */
      if (renderer.selected && !byId[renderer.selected.id]) renderer.selected = null;
      if (renderer.editing && !byId[renderer.editing.id]) renderer.editing = null;
    }
    return { buildings: list, villagers: vlist, structural: structural };
  }

  global.Serialize = { world: world, apply: apply, removedHex: removedHex };
})(typeof window !== 'undefined' ? window : globalThis);
