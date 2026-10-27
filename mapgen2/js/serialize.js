/* serialize.js — снимок мира для сети.

   Хост считает мир, клиенты только рисуют. Значит по проводу должно уехать
   всё, что видно: постройки, жители, деревни и время. Лес по сиду у всех
   одинаковый, поэтому карту (tile/isLand) не шлём — только номера убранных
   объектов.

   Формат снимка (v3):
     seq          — номер снимка, растёт на единицу. Клиент применяет только
                    более новые: запоздавший ответ не откатывает мир назад.
     t            — игровое время хоста.
     seed, size   — какая это партия; чужой снимок не применяется.
     towns        — казна и жизнь деревень, включая потерянные ходки (lost),
                    время следующего заселения (birthNext) и следующий номер
                    жителя (vid): три числа на деревню, без них после F5
                    расходится инвариант груза и номер жителя может достаться
                    мёртвому.
     buildings    — постройки целиком: их единицы, а не тысячи.
     villagers    — жители целиком: их тоже единицы. Поля пишутся ТОЛЬКО
                    когда отличаются от умолчания (см. villagerSnap): у
                    идущего жителя это id, x, y, rot, anim, phase, state,
                    owner, town и редкие hp/carrying/orderX/orderY. Пустые
                    флаги, нули, null-ссылки и maxHp не пишутся вовсе:
                    maxHp клиент считает по типу через Combat.maxHpOf.
                    Старый полный снимок читается теми же умолчаниями.
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

   Снимок — это формат ОТОБРАЖЕНИЯ плюс минимум для возврата хоста. Полные
   поля живой симуляции (speed, rng, anchor, счётчики) в каждый кадр не едут:
   хост после F5 собирает жителей заново через `Villagers.blank` и накрывает
   полями снимка (`hydrate` ниже). Служебное поле в кадре только одно —
   orderX/orderY, и только у воина с живым приказом. Счётчики вроде felled
   не шлются вовсе: срубленное после правки 2026-10-26 считается по своей
   деревне, а не суммой по жителям.

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
      felled: t.felled || 0, inTransit: t.inTransit || 0,
      /* Потерянные ходки (session.js: loseCargo). Без них после F5
         инвариант logs + 4*(inTransit+lost) = 4*felled сходится хуже:
         «в пути» уменьшилось, а «потеряно» гость не узнал. */
      lost: t.lost || 0,
      /* Когда следующее заселение (игровые секунды) — гость не считает
         Session.birthClock и без числа не покажет отсчёт. */
      birthNext: t.birthNext === undefined ? null : t.birthNext,
      /* Следующий номер жителя (session.js: _vidNext). Живёт на деревне,
         поэтому переживает смерть и F5; без него номер мог бы достаться
         мёртвому. null — деревня ещё не раздавала номеров. */
      vid: t._vidNext === undefined ? null : t._vidNext
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

  /* Число из снимка: JSON не умеет NaN/Infinity и превращает их в null,
     поэтому «не число» — это отсутствие поля, а не значение. Умолчание
     задаёт вызывающий, а не этот помощник. */
  function num(x, def) {
    return (typeof x === 'number' && isFinite(x)) ? x : def;
  }

  /* Координата в кадре — два знака. Точности 0.01 клетки хватает и
     отрисовке, и сглаживанию, а третий знак стоил на 200 существах
     несколько килобайт в каждом кадре. */
  function coord(x) {
    x = +x;
    return isFinite(x) ? +x.toFixed(2) : 0;
  }

  function refId(x) {
    return x === undefined || x === null ? null : x;
  }

  /* Житель в кадре: только то, что отличается от умолчания. Пустой флаг,
     ноль и ссылка null не пишутся вовсе — клиент ставит умолчания в
     updateVillager, а хост собирает объект в hydrate. Старый полный снимок
     читается теми же умолчаниями: лишние поля просто перекрывают их.

     maxHp не пишется: это свойство типа (Combat.maxHpOf), а не состояние.
     hp пишется только у раненого — у целого hp === maxHp и так.

     orderX/orderY — единственное служебное поле кадра. Оно нужно хосту после
     F5 (контракт §2: приказ переживает возврат), но только у воина, у
     которого приказ ещё не выполнен: это единицы, а не все 200 существ. */
  function villagerSnap(v) {
    var s = { id: v.id, x: coord(v.x), y: coord(v.y) };
    if (v.owner) s.owner = v.owner;
    if (v.town) s.town = v.town;
    if (v.rot) s.rot = Math.round(v.rot);
    if (v.anim && v.anim !== 'idle') s.anim = v.anim;
    if (v.phase) s.phase = +(+v.phase).toFixed(3);
    if (v.frozen) s.frozen = 1;
    if (v.state && v.state !== 'wander') s.state = v.state;
    if (v.warrior) s.warrior = 1;
    if (v.trainee) s.trainee = 1;
    if (v.hidden) s.hidden = 1;
    if (v.trainingAt) {
      s.trainingId = v.trainingAt.id;
      s.trainT = +(+v.trainT || 0).toFixed(2);
    }
    if (v.home) s.homeId = v.home.id;
    if (v.employer) s.employerId = v.employer.id;
    if (v.warcamp) s.campId = v.warcamp.id;
    if (v.station) s.stationId = v.station.id;
    if (v.maxHp > 0 && v.hp < v.maxHp) s.hp = Math.max(0, +(+v.hp).toFixed(1));
    if (v.hpUntil) s.hpUntil = +(+v.hpUntil).toFixed(2);
    if (v.flinch) s.flinch = +(+v.flinch).toFixed(2);
    if (v.attackT) s.attackT = +(+v.attackT).toFixed(2);
    if (v.carrying) s.carrying = 1;
    if (v.appearT !== undefined && v.appearDur > 0 && v.appearT < v.appearDur) {
      s.appearT = +(+v.appearT).toFixed(2);
      s.appearDur = +(+v.appearDur).toFixed(2);
    }
    if (v.vanishT > 0) s.vanishT = +(+v.vanishT).toFixed(2);
    if (v.emergeT > 0) s.emergeT = +(+v.emergeT).toFixed(2);
    if (v.dead) s.dead = 1;
    if (v.warrior && v.order && !v.order.done &&
        isFinite(v.order.x) && isFinite(v.order.y)) {
      s.orderX = coord(v.order.x);
      s.orderY = coord(v.order.y);
    }
    return s;
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
    /* JSON не несёт NaN/Infinity: битое число приезжает null. Клиент не
       должен из-за этого уехать в NaN — ставим конечную точку. */
    var tx = num(vs.x, 0), ty = num(vs.y, 0);
    if (fresh || !opts.smooth) {
      v.x = tx; v.y = ty;
    } else if (Math.abs(tx - v.x) + Math.abs(ty - v.y) > 3) {
      v.x = tx; v.y = ty;
    }
    v._net = true;
    v._netTX = tx; v._netTY = ty;

    v.id = vs.id;
    /* Умолчания — здесь, а не в снимке. Снимок v3 не пишет пустые флаги,
       нули и null-ссылки; объект на клиенте переиспользуется между кадрами,
       поэтому КАЖДОЕ отсутствующее поле обязано вернуться к умолчанию, а не
       остаться от прошлого кадра. Старый полный снимок перекрывает эти же
       умолчания своими значениями — формат читается. */
    v.owner = vs.owner === undefined ? 0 : num(vs.owner, 0);
    v.town = vs.town === undefined ? 0 : num(vs.town, 0);
    v.rot = num(vs.rot, 0);
    v.anim = vs.anim || 'idle';
    v.phase = num(vs.phase, 0);
    v.frozen = !!vs.frozen;
    v.state = vs.state || 'wander';
    v.warrior = !!vs.warrior;
    v.trainee = !!vs.trainee;
    v.hidden = !!vs.hidden;
    v.trainingId = refId(vs.trainingId);
    v.trainT = Math.max(0, num(vs.trainT, 0));
    /* maxHp — свойство типа, а не состояния: в снимке его нет. Сначала
       warrior (он выбирает таблицу HP), потом здоровье. */
    var C = global.Combat;
    v.maxHp = vs.maxHp > 0 ? num(vs.maxHp, 0)
      : (C && C.maxHpOf ? C.maxHpOf(v) : 0);
    v.hp = (vs.hp === undefined || vs.hp === null)
      ? v.maxHp : Math.max(0, num(vs.hp, 0));
    v.hpUntil = Math.max(0, num(vs.hpUntil, 0));
    v.flinch = Math.max(0, num(vs.flinch, 0));
    v.attackT = Math.max(0, num(vs.attackT, 0));
    v.carrying = !!vs.carrying;
    v.appearT = vs.appearT === undefined || vs.appearT === null
      ? undefined : num(vs.appearT, 0);
    v.appearDur = vs.appearDur === undefined || vs.appearDur === null
      ? undefined : Math.max(0, num(vs.appearDur, 0));
    v.vanishT = vs.vanishT === undefined || vs.vanishT === null
      ? undefined : Math.max(0, num(vs.vanishT, 0));
    v.emergeT = vs.emergeT === undefined || vs.emergeT === null
      ? undefined : Math.max(0, num(vs.emergeT, 0));
    v.dead = !!vs.dead;
    v.homeId = refId(vs.homeId);
    v.employerId = refId(vs.employerId);
    v.campId = refId(vs.campId);
    v.stationId = refId(vs.stationId);
    /* Клиент не считает путь: он только рисует. Поля движения хоста на
       клиенте не нужны; порядок боя и отряда клиент берёт из id. Приказ
       отряда (orderX/orderY) — данные не движения: клиент их не исполняет,
       а хост после F5 собирает order заново в hydrate. */
    v.orderX = refId(vs.orderX);
    v.orderY = refId(vs.orderY);
    v.path = null; v.goal = null; v.spot = null; v.order = null;
    v.target = null; v.combatMode = null;
  }

  /* ------------------- авторитетное восстановление (F5) ------------------ *
   *
   * Клиент после снимка только рисует — ему хватает apply. Хост после F5
   * ПРОДОЛЖАЕТ СЧИТАТЬ, и `{}` с x/y/state для этого не годится: walk
   * умножал undefined на dt (NaN), прогулки падали на отсутствии rng, а
   * гражданский без anchor стоял вечно. Поэтому каждый житель собирается
   * заново `Villagers.blank` — единственным местом, где перечислены поля
   * живой симуляции, — и накрывается полями снимка.
   *
   * Что восстанавливается: ссылки (home/employer/trainingAt/warcamp/station),
   * груз (carrying), обучение (trainee/trainT/trainingAt), здоровье,
   * появление/растворение, приказ (orderX/orderY) и id. Что НЕ
   * восстанавливается и пересчитывается обычным шагом: путь, цель, дерево,
   * место двора, цель боя — это разрешено контрактом §2 и не потеря.
   *
   * speed, rng и anchor не едут в кадре: speed — константа движка, rng
   * выводится из сида мира и номера жителя, anchor — из двери его дома.
   * Поэтому снимок остаётся снимком отображения, а не checkpoint'ом на
   * 200 существ.
   *
   * `buildings` — уже применённый список построек (apply вернул его же);
   * opts.renderer — необязательный; opts.owner не нужен. Возвращает список
   * живых объектов и кладёт его на мир (`world._villagers`,
   * `world._buildings`, `town.villagers`). */
  function hydrate(world, snap, buildings, opts) {
    opts = opts || {};
    if (!world || !snap) return [];
    var V = global.Villagers;
    if (!V || typeof V.blank !== 'function') return [];
    var C = global.Combat;
    var list = buildings || world._buildings || [];
    var byId = {}, i;
    for (i = 0; i < list.length; i++) {
      if (list[i] && list[i].id !== undefined) byId[list[i].id] = list[i];
    }
    function ref(id) {
      var k = refId(id);
      return k === null ? null : (byId[k] || null);
    }
    function key(b) { return b ? (b.x + ':' + b.y + ':' + b.rot) : null; }

    var src = snap.villagers || [];
    var out = [];
    var cx = (world.width || 0) / 2, cy = (world.height || 0) / 2;
    for (i = 0; i < src.length; i++) {
      var vs = src[i];
      var home = ref(vs.homeId);
      var v = V.blank(world, {
        id: vs.id,
        /* Номер жителя — стабильный ключ ГПСЧ. Индекс рождения после F5
           неизвестен, а id переживает и рождение, и возврат. */
        rngKey: vs.id,
        x: num(vs.x, cx), y: num(vs.y, cy),
        home: home,
        owner: vs.owner === undefined ? 0 : vs.owner,
        town: vs.town === undefined ? 0 : vs.town
      });

      /* --- поля отображения и живого состояния --- */
      v.rot = vs.rot === undefined ? 0 : num(vs.rot, 0);
      v.anim = vs.anim || 'idle';
      v.animWant = v.anim;
      v.phase = num(vs.phase, 0);
      v.frozen = !!vs.frozen;
      v.state = vs.state || 'wander';
      v.warrior = !!vs.warrior;
      v.trainee = !!vs.trainee;
      v.hidden = !!vs.hidden;
      v.dead = !!vs.dead;
      v.carrying = !!vs.carrying;
      v.trainT = Math.max(0, num(vs.trainT, 0));
      v.hpUntil = Math.max(0, num(vs.hpUntil, 0));
      v.flinch = Math.max(0, num(vs.flinch, 0));
      v.attackT = Math.max(0, num(vs.attackT, 0));
      if (vs.appearT !== undefined || vs.appearDur !== undefined) {
        v.appearT = num(vs.appearT, 0);
        v.appearDur = Math.max(0, num(vs.appearDur, 0));
      }
      v.vanishT = Math.max(0, num(vs.vanishT, 0));
      v.emergeT = Math.max(0, num(vs.emergeT, 0));

      /* --- ссылки; постройка могла рухнуть, пока снимок ехал --- */
      v.home = home;
      v.employer = ref(vs.employerId);
      v.job = v.employer;
      v.trainingAt = ref(vs.trainingId);
      v.warcamp = ref(vs.campId);
      v.station = ref(vs.stationId);
      if (v.employer && v.employer.rubble) { v.employer = null; v.job = null; }
      if (v.trainingAt && v.trainingAt.rubble) {
        v.trainingAt = null;
        v.trainee = false;
        v.trainT = 0;
        v.hidden = false;
        v.state = 'wander';
      }
      if (v.warcamp && v.warcamp.rubble) v.warcamp = null;
      if (v.station && v.station.rubble) v.station = null;
      /* Ученик без казармы учиться не может: это не «пропавшее обучение»,
         а исчезнувшее место. Обычный шаг сам найдёт ему дело. */
      if (v.trainee && !v.trainingAt) {
        v.trainee = false;
        v.trainT = 0;
        v.hidden = false;
        if (v.state === 'training') v.state = 'wander';
      }

      /* --- здоровье: maxHp — свойство типа, hp — только урон --- */
      v.maxHp = (vs.maxHp > 0) ? num(vs.maxHp, 0)
        : (C && C.maxHpOf ? C.maxHpOf(v) : 0);
      v.hp = (vs.hp === undefined || vs.hp === null)
        ? v.maxHp : Math.max(0, num(vs.hp, 0));

      /* --- приказ дружины: те же поля, что ставит Army.order --- */
      if (v.warrior && isFinite(vs.orderX) && isFinite(vs.orderY)) {
        v.order = {
          x: +vs.orderX, y: +vs.orderY,
          r: (global.Army && global.Army.MIN_R) || 2.5,
          issuedAt: num(world.time, 0), done: false
        };
      } else {
        v.order = null;
      }

      /* --- ключи мест: чтобы первый кадр не сбрасывал путь/тренировку --- */
      v.campKey = v.employer ? key(v.employer) : (v.warcamp ? key(v.warcamp) : null);
      v.trainKey = v.trainingAt ? key(v.trainingAt) : null;
      if (v.trainee && v.state !== 'training') {
        /* Шёл к казарме — путь потерян, но не обучение: дойдёт заново. Без
           этого state='enterBarracks' без пути телепортировал бы его в дверь
           и начинал пять секунд с начала. */
        v.state = 'toBarracks';
      }
      if (v.vanishT > 0) v.vanishDur = (global.Session && global.Session.VANISH_TIME) || 0.35;
      if (v.emergeT > 0) v.emergeDur = (global.Session && global.Session.EMERGE_TIME) || 0.5;

      /* --- движение не восстанавливаем: его пересчитает обычный шаг --- */
      v.path = null; v.goal = null; v.step = 0; v.tree = null; v.spot = null;
      v.spotTrip = false; v.close = false; v.intoYard = false;
      v.exitYard = false; v.escape = false; v.entering = false;
      v.exiting = false; v.approach = null; v.target = null;
      v.combatMode = null; v.prevTarget = null; v.attacker = null;
      v.attackerT = 0; v.thinkT = 0; v.chaseT = 0; v.routeT = 0;
      v.routeFail = 0; v.combatFail = 0; v.garrisonSpot = null;
      v.hold = 0; v.stuck = 0; v.lost = 0; v.ref = null; v.refCell = null;
      v.seen = null;
      /* Счётчики отчётов (walked/trips/felled/delivered) начинаются с нуля:
         они не влияют ни на экономику, ни на груз. Срубленное деревня
         считает сама (town.felled), а не суммой по жителям. */
      out.push(v);
    }

    /* --- список партии и ссылки на него --- */
    for (i = 0; i < out.length; i++) out[i].avoid = out;
    world.time = snap.t === undefined ? world.time : num(snap.t, world.time || 0);
    world._buildings = list;
    world._villagers = out;
    if (world.towns) {
      for (i = 0; i < world.towns.length; i++) {
        if (world.towns[i]) world.towns[i].villagers = [];
      }
      for (i = 0; i < out.length; i++) {
        var t = world.towns[out[i].town];
        if (t) t.villagers.push(out[i]);
      }
    }
    if (opts.renderer && opts.renderer.setVillagers) opts.renderer.setVillagers(out);
    return out;
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
            alive: true, isBot: false, buildings: [], villagers: [], townhall: null,
            lost: 0, birthNext: null, _vidNext: 0 };
          world.towns[i] = t;
        }
        t.owner = ts.owner; t.name = ts.name; t.color = ts.color;
        t.alive = ts.alive; t.isBot = ts.isBot;
        t.logs = ts.logs; t.deliveries = ts.deliveries;
        t.felled = ts.felled; t.inTransit = ts.inTransit;
        /* Старый снимок полей не несёт — тогда не затираем то, что уже
           стоит на деревне (например, посчитанное при старте партии). */
        t.lost = ts.lost === undefined ? (t.lost || 0) : ts.lost;
        t.birthNext = ts.birthNext === undefined
          ? (t.birthNext === undefined ? null : t.birthNext) : ts.birthNext;
        t._vidNext = ts.vid === undefined ? (t._vidNext || 0) : ts.vid;
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
      /* F13: числа (hp/logs/позиция жителя) не меняют порядок отрисовки.
         setBuildings инвалидирует его, поэтому зовём только при структурном
         изменении — иначе 10 снимков/с пересортировывают неизменный список. */
      if (renderer.setBuildings && (structural || removedChanged)) {
        renderer.setBuildings(list, { minimap: structural || removedChanged });
      }
      if (renderer.setVillagers) renderer.setVillagers(vlist);
      /* Выбор и правку не сбрасываем: объекты те же. Убираем только то, чего
         в новом снимке больше нет. */
      if (renderer.selected && !byId[renderer.selected.id]) renderer.selected = null;
      if (renderer.editing && !byId[renderer.editing.id]) renderer.editing = null;
    }
    return { buildings: list, villagers: vlist, structural: structural };
  }

  global.Serialize = {
    world: world, apply: apply, hydrate: hydrate, removedHex: removedHex
  };
})(typeof window !== 'undefined' ? window : globalThis);
