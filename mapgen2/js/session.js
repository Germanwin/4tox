/* session.js — начало партии: деревня игрока и жители на карте.

   Партия — это не «карта плюс настройки панели», а четыре вещи вместе: мир,
   ДЕРЕВНЯ на нём (ратуша игрока, дом жителя, лагерь лесоруба и военный
   лагерь) и ЖИТЕЛИ, которые в этой деревне живут — гуляют вокруг своего дома.
   Собирает их один код, и он лежит здесь, а не в оболочке.

   Оболочек теперь две, и партия у них одна и та же:

   * `mapgen2/index.html` — генератор карт: та же партия плюс панель, которой
     можно поставить ещё ратуш, посмотреть сводку и перегенерировать мир;
   * `game/index.html` — игра: меню, выбор размера и партия без панели.

   Разойтись они не могут: обе зовут Session. Раньше это жило в app.js, и
   вторая оболочка начала бы с того, что скопировала бы себе сорок строк
   «как начинается игра», — а через месяц копии разошлись бы, и вопрос «где
   настоящая игра» стал бы ребусом.

   Что здесь НЕ живёт: параметры генерации (их читает оболочка), панель,
   камера и ввод. Здесь только то, что делает карту партией. */

(function (global) {
  'use strict';

  /* Ратуша игрока: вариант C и поворот лицом вправо-вниз.

     Это не настройка панели, а часть начала игры, поэтому выбор живёт здесь,
     а не в разметке: обе оболочки должны ставить одну и ту же ратушу. Число
     поворота берётся у движка построек (`Buildings.FACE_ROT`) — правило одно
     на все постройки, и заказчик (2026-10-15) называет правильной именно
     ратушу, стоящую под ним. */
  var HOME = { type: 'townhall', variant: 'c', rot: global.Buildings.FACE_ROT };

  /* Деревня вокруг ратуши: дом жителя — вплотную к ратуше, лагерь лесоруба и
   * военный лагерь — рядом с ними (требование заказчика 2026-10-14: «в начале
   * игры на карте появлялась не только ратуша, а ещё и дом жителя рядом с
   * ратушей и лагерь лесоруба»; военный лагерь добавлен 2026-10-22, чтобы
   * обученному воину было куда идти сразу).
   *
   * Вариант дома — A, у лагеря вариант один. Место каждой постройки выбирает
   * js/buildings.js: `neighbourSpot` прикладывает пятно к габариту уже
   * стоящих. Поворот при этом не выбирается местом: все постройки деревни
   * смотрят передней частью вправо-вниз (`Buildings.FACE_ROT`, требование
   * заказчика 2026-10-15) — до него дом и лагерь разворачивались «лицом к
   * деревне», и в половине сидов дом встречал игрока спиной, а лагерь —
   * навесом. Порядок в списке — порядок постановки: дом ближе к ратуше,
   * лагерь — к деревне целиком.
   *
   * Житель выходит из дома (см. spawnVillagers), а не из ратуши: дом — его.
   *
   * ВОЕННОГО ЛАГЕРЯ НА СТАРТЕ НЕТ (требование заказчика 2026-10-23). Раньше
   * он стоял здесь, чтобы обученному воину было куда идти. Теперь лагерь
   * покупается за брёвна, как остальные постройки, а воины до его постройки
   * ждут во дворе казармы (см. destinationFor). */
  var VILLAGE = [
    { type: 'house', variant: 'a' },
    { type: 'lumbercamp', variant: 'a' }
  ];

  /* Настройки площадки под постройки деревни. clear: true — площадка
     расчищается, лес не прорастает сквозь стены; мелочь (куст, трава) под
     домом и в клетке вокруг сминается и без этого — куст вплотную к стене
     рисуется поверх дома, по земле он ближе. Двор в одну клетку — та же
     забота: см. js/buildings.js, yardOccupants и settle. */
  var SITE = { clearable: true, requireClear: false, clear: true, yard: 1 };

  /* Жителей трое — правило заказчика (2026-10-16: «в начале партии появляются
     ТРИ жителя»). У каждого свой идентификатор (v.id, с единицы по порядку
     появления) и своя прописка в доме (v.home).

     До 2026-10-16 житель был один и с рождения шёл рубить лес. Теперь житель
     БЕЗ РАБОТЫ не рубит вовсе: он гуляет вокруг своего дома, не отходя дальше
     `Villagers.WANDER_R` клеток (см. js/villager.js). Работа у него появится
     с наймом — это задача 3; тогда рабочему циклу и достанутся планировщик
     дерева и рубка, которые в villager.js остались нетронутыми.

     Массив тут не «на всякий случай»: трое — это уже толпа, и всё, что про
     жителей в оболочках написано, обязано работать со списком, а не с первым
     его элементом. */
  var VILLAGERS = 3;

  /* Цвета команд: 0 — игрок, 1 — враг/второй игрок, дальше сеть. Числа здесь,
     потому что цвет — свойство города, а не интерфейса; рендер читает его у
     постройки/жителя, а не выдумывает своё. */
  var TEAM_COLORS = ['#4a90d9', '#d94a4a', '#9b59b6', '#e0a030'];

  /* Город. В одиночной игре он один; в «против деревни» — два; в сети — до
     четырёх. Список живёт на мире, потому что мир переживает перегенерацию,
     а город — нет. */
  function newTown(world, owner, name) {
    if (!world.towns) world.towns = [];
    var t = {
      id: world.towns.length,
      owner: owner === undefined ? 0 : owner,
      name: name || (owner ? 'Деревня ' + (owner + 1) : 'Деревня'),
      color: TEAM_COLORS[(owner || 0) % TEAM_COLORS.length],
      alive: true, isBot: false,
      logs: 0, deliveries: 0, felled: 0, inTransit: 0,
      buildings: [], villagers: [], townhall: null
    };
    world.towns.push(t);
    if (t.id === 0) world.village = t;
    return t;
  }

  function townOf(world, owner) {
    var list = (world && world.towns) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].owner === owner) return list[i];
    }
    return null;
  }

  /* Кто ещё в партии. Город выбывает, когда пала его ратуша: `alive=false`
     ставит оболочка (game/js/play.js), а не бой — Combat знает только «чья
     ратуша рассыпалась», но не правила партии на 2–4 человек.

     `over` наступает, когда живых городов осталось не больше одного. Для
     одиночной деревни без врага это тоже верно: после падения её ратуши
     список пуст, и партия окончена. */
  function aliveTowns(world) {
    var list = (world && world.towns) || [], out = [], i;
    for (i = 0; i < list.length; i++) {
      if (list[i] && list[i].alive !== false) out.push(list[i]);
    }
    return out;
  }

  function standing(world) {
    var alive = aliveTowns(world);
    return {
      alive: alive,
      over: alive.length <= 1,
      winner: alive.length === 1 ? alive[0].owner : null
    };
  }

  function townById(world, id) {
    var list = (world && world.towns) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].id === id) return list[i];
    }
    return null;
  }

  /* --------------------------- тренировка воина --------------------------- *
   *
   * Заказчик (2026-10-22): «в казарме они должны не наниматься, а
   * тренироваться»; «тренировка воина должна идти 5 секунд». Число живёт
   * здесь, а не в HUD: его считает движок, а интерфейс только показывает
   * остаток. Vanish/emerge — время растворения у двери и появления воина:
   * это тоже правило мира, а не анимация панели.
   *
   * Пять секунд начинаются, когда житель ЗАСТУПИЛ на территорию казармы, а не
   * когда игрок нажал кнопку: дорога до двери — отдельное время. */
  var TRAIN_TIME = 5.0;
  var VANISH_TIME = 0.35;   // с: растворяется, войдя в казарму
  var EMERGE_TIME = 0.50;   // с: воин проявляется уже за дверью

  /* -------------------------- рождение жителей ---------------------------- *
   *
   * Раз в 30 секунд ИГРОВОГО времени КАЖДАЯ ЖИВАЯ ДЕРЕВНЯ пробует заселить
   * свободные места в СВОИХ домах. Рост независим: заблокированный дом одной
   * деревни не мешает другой, выбывший город не рождает вовсе.
   *
   * Время сюда не приходит и таймера здесь нет: часы партии живут в оболочке
   * (game/js/play.js: state.seconds), потому что только она знает, идёт ли
   * игра, стоит ли пауза и открыто ли меню. Здесь — ПРАВИЛО: когда попытка
   * положена (birthDue), кто и куда родится (tryBirth). Отсчёт с 30-й секунды,
   * дальше 60, 90... Пропущенные границы не догоняются.
   *
   * ОДНА ПОПЫТКА — ОДНО ПРАВИЛО. Если места в домах есть, но ВСЕ двери заняты
   * (жители/постройки в радиусе BIRTH_REACH), попытка не пропадает: она
   * откладывается (pending) и повторяется через BIRTH_RETRY секунд, но не
   * дальше следующей границы. Это НЕ новый темп: отложенная попытка добирает
   * только остаток уже положенного числа детей (pending.left), а новое
   * «min(floor(pop/2), free)» считается только на границе 30 с.
   *
   * Прописка. Жильё деревни — её живые дома (не rubble, h.town === town.id).
   * Жильцы — все живые жители деревни, ВКЛЮЧАЯ воинов и учеников: у них та же
   * прописка (v.home), и место в доме они занимают. Выбывший город
   * (alive=false, ратуша пала или её нет) не рождает, и его дома не считаются.
   *
   * id не переиспользуется: диапазон деревни town.id*1000, номер идёт от
   * max(живых этой деревни, town._vidNext) + 1. После F5 нумерация
   * продолжается (syncVillagerIds), а не начинается заново.
   * ---------------------------------------------------------------------- */
  var BIRTH_EVERY = 30;    // с игрового времени между попытками
  var BIRTH_FADE = 0.5;    // с: сколько новорождённый проявляется (0.4..0.6)
  var BIRTH_REACH = 2;     // клеток: насколько далеко искать место от двери
  var BIRTH_RETRY = 5;     // с: повтор отложенной попытки (не дольше границы)

  /* Часы попыток. Одна штука на партию: начало партии заводит их с нуля.
     `towns` — слоты по деревням: { next, pending, blocked, last }. Форма
     `{next, attempts}` без `towns` поддерживается: старые тесты и инструменты
     ставят такие часы руками, и они не должны рожать раньше времени. */
  function birthClock() {
    return { next: BIRTH_EVERY, attempts: 0, towns: {} };
  }

  function nextBoundary(seconds) {
    return (Math.floor(seconds / BIRTH_EVERY) + 1) * BIRTH_EVERY;
  }

  /* Слот попыток деревни. initialNext — когда слот создан старыми часами без
     `towns`, он наследует их границу; в обычном случае (граница уже сработала)
     слот созревает сразу. */
  function birthSlot(clock, town, initialNext) {
    if (!clock) return null;
    if (!clock.towns) clock.towns = {};
    var id = town && town.id !== undefined ? town.id : 0;
    var slot = clock.towns[id];
    if (!slot) {
      slot = clock.towns[id] = {
        next: typeof initialNext === 'number' ? initialNext : 0,
        pending: null, blocked: [], last: null, growthReason: ''
      };
    }
    return slot;
  }

  /* Пора ли пробовать. true — на границе 30 с (ровно один раз: следующая
     ставится по текущему времени) или на отложенном повторе. Пачка
     пропущенных границ не превращается в пачку попыток. */
  function birthDue(clock, seconds) {
    if (!clock) return false;
    if (typeof clock.next !== 'number') clock.next = BIRTH_EVERY;
    var due = false;
    if (seconds >= clock.next) {
      clock.next = nextBoundary(seconds);
      clock.attempts = (clock.attempts || 0) + 1;
      clock.due = true;
      clock.lastDue = seconds;
      due = true;
    }
    var slots = clock.towns || {};
    for (var id in slots) {
      if (!Object.prototype.hasOwnProperty.call(slots, id)) continue;
      var slot = slots[id];
      if (!slot || !slot.pending) continue;
      if (seconds >= slot.pending.at && seconds < slot.next) due = true;
    }
    return due;
  }

  /* Ратуша деревни: в списке построек (а не только ссылкой town.townhall —
     после снимка она восстанавливается именно из построек). */
  function townHallOf(town, buildings) {
    var list = buildings || (town && town.buildings) || [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || b.rubble) continue;
      if (global.Buildings.typeOf(b) !== 'townhall') continue;
      if (town && b.town !== undefined && b.town !== town.id) continue;
      if (town && ownerId(b) !== town.owner) continue;
      return b;
    }
    return null;
  }

  /* Жив ли город. Выбывший (alive=false), с павшей ратушей или вовсе без неё
     не рождает. Деревня без списка городов (генератор карт) считается живой:
     там нет ни ратуши, ни городов, а рождение — обычная проверка движка. */
  function townAlive(town, buildings) {
    if (!town) return false;
    if (town._synthetic) return true;
    if (town.alive === false) return false;
    if (town.townhall && town.townhall.rubble) return false;
    if (town.townhall && !town.townhall.rubble) return true;
    return !!townHallOf(town, buildings);
  }

  /* Живые дома деревни: только этот тип, не завал, только свой город. Старый
     дом без поля town относится к деревне по владельцу. */
  function townHouses(town, buildings) {
    var B = global.Buildings, out = [], i, h;
    var list = buildings || (town && town.buildings) || [];
    for (i = 0; i < list.length; i++) {
      h = list[i];
      if (!h || h.rubble) continue;
      if (B.typeOf(h) !== 'house') continue;
      if (town && !town._synthetic) {
        if (h.town !== undefined) { if (h.town !== town.id) continue; }
        else if (ownerId(h) !== town.owner) continue;
      }
      out.push(h);
    }
    return out;
  }

  /* Жители деревни: все живые, включая воинов и учеников. Списки town.villagers
     для этого не годятся — там остаются ссылки на мёртвых. */
  function townResidents(town, villagers) {
    var out = [], list = villagers || [], i, v;
    for (i = 0; i < list.length; i++) {
      v = list[i];
      if (!v || v.dead) continue;
      if (town && !town._synthetic) {
        if (v.town !== undefined) { if (v.town !== town.id) continue; }
        else if (ownerId(v) !== town.owner) continue;
      }
      out.push(v);
    }
    return out;
  }

  /* Свободные места в домах деревни. */
  function housingFreeOf(town, buildings, villagers) {
    var B = global.Buildings, houses = townHouses(town, buildings), free = 0;
    for (var i = 0; i < houses.length; i++) {
      free += Math.max(0,
        B.housingCapacity(houses[i]) - residentsOf(houses[i], villagers).length);
    }
    return free;
  }

  /* Сколько свободных мест в домах. Без третьего аргумента — по всем домам
     (старый вызов); с деревней — по ней; с миром — по живым городам. */
  function housingFree(buildings, villagers, worldOrTown) {
    if (worldOrTown && worldOrTown.towns) {
      var towns = worldOrTown.towns, free = 0;
      for (var t = 0; t < towns.length; t++) {
        if (townAlive(towns[t], buildings)) free += housingFreeOf(towns[t], buildings, villagers);
      }
      return free;
    }
    if (worldOrTown) return housingFreeOf(worldOrTown, buildings, villagers);
    var B = global.Buildings, all = 0, i;
    for (i = 0; i < (buildings || []).length; i++) {
      var h = buildings[i];
      if (!h || B.typeOf(h) !== 'house') continue;
      all += Math.max(0, B.housingCapacity(h) - residentsOf(h, villagers).length);
    }
    return all;
  }

  /* Дом для следующего ребёнка: среди домов ЭТОЙ деревни со свободными
     местами — тот, где их больше; при равенстве — раньше в списке. Дом из
     skip (в этой попытке его дверь занята) пропускается. Старый вызов
     birthHouse(buildings, villagers) работает как раньше — по всем домам. */
  function birthHouse(town, buildings, villagers, skip) {
    var B = global.Buildings, houses, i;
    if (Array.isArray(town)) {
      /* Старый вызов birthHouse(buildings, villagers): по всем домам. */
      var legacyVillagers = buildings;
      buildings = town;
      villagers = legacyVillagers;
      houses = buildings;
      skip = arguments[3] || null;
    } else {
      houses = townHouses(town, buildings);
    }
    var best = null, bestFree = 0;
    for (i = 0; i < houses.length; i++) {
      var h = houses[i];
      if (!h || B.typeOf(h) !== 'house') continue;
      if (skip && h.id !== undefined && skip[String(h.id)]) continue;
      var free = Math.max(0, B.housingCapacity(h) - residentsOf(h, villagers).length);
      if (free > bestFree) { best = h; bestFree = free; }
    }
    return best;
  }

  /* Города, которые пробуют родить: живые. Мир без списка городов — одна
     условная деревня владельца 0 (генератор карт). */
  function birthTowns(world, buildings) {
    var list = (world && world.towns) || [], out = [], i;
    for (i = 0; i < list.length; i++) {
      if (townAlive(list[i], buildings)) out.push(list[i]);
    }
    if (out.length) return out;
    if (!list.length) return [{ id: 0, owner: 0, alive: true, _synthetic: true }];
    return out;
  }

  /* Следующий номер жителя деревни. Не переиспользует номера: берёт максимум
     по ЖИВЫМ этой деревни и по town._vidNext (он переживает смерть и F5), а
     занятый номер (например, из другого диапазона) пропускает. */
  function nextVillagerId(world, villagers, town) {
    var list = villagers || [], i, v;
    var base = town && typeof town.id === 'number' ? town.id * 1000 : 0;
    var maxId = 0, used = {};
    for (i = 0; i < list.length; i++) {
      v = list[i];
      if (!v || typeof v.id !== 'number') continue;
      used[v.id] = true;
      if (town && !town._synthetic) {
        if (v.town !== undefined && v.town !== town.id &&
            ownerId(v) !== town.owner) continue;
        if (v.town === undefined && ownerId(v) !== town.owner) continue;
      }
      if (v.id > maxId) maxId = v.id;
    }
    var next = Math.max(base, maxId + 1, (town && town._vidNext) || 0);
    while (used[next]) next++;
    if (town) town._vidNext = next + 1;
    return next;
  }

  /* Продолжить нумерацию после F5/старта: по каждому городу max id + 1. */
  function syncVillagerIds(world, villagers) {
    var towns = (world && world.towns) || [], byTown = {}, i, v;
    for (i = 0; i < (villagers || []).length; i++) {
      v = villagers[i];
      if (!v || typeof v.id !== 'number') continue;
      var tid = v.town;
      if (tid === undefined) {
        var t = townOf(world, ownerId(v));
        tid = t ? t.id : 0;
      }
      byTown[tid] = Math.max(byTown[tid] || 0, v.id);
    }
    for (i = 0; i < towns.length; i++) {
      var town = towns[i];
      if (!town) continue;
      var base = (typeof town.id === 'number' ? town.id : i) * 1000;
      town._vidNext = Math.max(base, (byTown[town.id] || 0) + 1, town._vidNext || 0);
    }
    return byTown;
  }

  /* Отметка «рост остановлен»: событие на СМЕНУ причины, не на каждый кадр.
     Внутри Events.growthStop уже держит паузу 30 с на владельца. */
  function noteGrowth(world, town, slot, reason) {
    if (!slot) return;
    if (slot.growthReason === (reason || '')) return;
    slot.growthReason = reason || '';
    if (!reason) return;
    if (global.Events && global.Events.growthStop) {
      global.Events.growthStop(world, town.owner, reason);
    }
  }

  /* Одна попытка одной деревни. pending — остаток УЖЕ положенной попытки:
     quota считается только на границе, повтор добирает pending.left. */
  function birthAttempt(world, villagers, buildings, town, slot, solid, seconds, born) {
    var V = global.Villagers, B = global.Buildings;
    var houses = townHouses(town, buildings);
    var pop = townResidents(town, villagers).length;
    var free = housingFreeOf(town, buildings, villagers);
    var pending = slot ? slot.pending : null;
    var blockedIds = [], blocked = {}, blockedN = 0;
    var quota = 0, got = 0, reason = '';
    var k, house, spot, door, child;

    if (slot) { slot.pending = null; slot.blocked = []; }

    if (!townAlive(town, buildings)) reason = 'город выбыл';
    else if (!houses.length) reason = 'нет дома';
    else if (pop <= 1) reason = 'один житель';
    else if (free <= 0) reason = 'нет свободного места';
    else {
      quota = Math.min(Math.floor(pop / 2), free);
      if (pending && typeof pending.left === 'number') {
        quota = Math.min(quota, pending.left);
      }
      for (k = 0; k < quota; k++) {
        house = null;
        spot = null;
        while (true) {
          house = birthHouse(town, buildings, villagers, blocked);
          if (!house) break;
          door = B.frontSpot(house);
          spot = V.spawnSpot(world, solid, door.x + 0.5, door.y + 0.5,
            villagers, BIRTH_REACH);
          if (spot) break;
          var hid = house.id === undefined ? '#' + blockedN : String(house.id);
          blocked[hid] = true;
          blockedIds.push(hid);
          blockedN++;
          house = null;
        }
        if (!house || !spot) break;
        var childId = nextVillagerId(world, villagers, town);
        child = V.create(world, {
          id: childId,
          index: childId,
          rngKey: childId,
          x: spot.x, y: spot.y,
          buildings: buildings,
          owner: town.owner === undefined ? 0 : town.owner,
          town: town.id === undefined ? 0 : town.id,
          home: house,
          avoid: villagers,
          appear: BIRTH_FADE
        });
        if (!child) break;
        villagers.push(child);
        var btown = townById(world, child.town);
        if (btown) btown.villagers.push(child);
        born.push(child);
        got++;
      }
      if (got < quota) reason = blockedN > 0 ? 'двери заняты' : 'нет места';
    }

    if (slot) {
      slot.blocked = blockedIds.slice();
      slot.last = {
        at: seconds, reason: reason, blocked: blockedN,
        born: got, quota: quota, pop: pop, free: free
      };
      if (reason === 'двери заняты' && seconds !== null && got < quota &&
          slot.next > seconds + BIRTH_RETRY) {
        slot.pending = {
          at: seconds + BIRTH_RETRY,
          left: quota - got,
          reason: reason,
          blocked: blockedN
        };
      }
      noteGrowth(world, town, slot, reason);
    }
    return got;
  }

  /* Попытки заселения. opts = {clock, seconds, town}: часы и время партии, а
     также (для отладки) одна деревня. Без opts — немедленная попытка по всем
     живым городам: так зовут profile.js и старые приёмки. */
  function tryBirth(world, renderer, villagers, buildings, opts) {
    opts = opts || {};
    if (!world || !renderer || !renderer.villagerSprites || !villagers) return [];
    var V = global.Villagers, B = global.Buildings;
    if (!V || !B) return [];
    var clock = opts.clock || null;
    var seconds = typeof opts.seconds === 'number' ? opts.seconds : null;
    var towns = opts.town ? [opts.town] : birthTowns(world, buildings);
    var solid = null, born = [], i, town, slot, due;

    for (i = 0; i < towns.length; i++) {
      town = towns[i];
      if (opts.town && town !== opts.town) continue;
      slot = clock ? birthSlot(clock, town, clock.due ? 0 : clock.next) : null;
      if (!clock) due = true;
      else if (clock.due) due = true;
      else if (slot.pending && seconds !== null &&
               seconds >= slot.pending.at && seconds < slot.next) due = true;
      else if (seconds !== null && seconds >= slot.next) due = true;
      else due = false;
      if (!due) continue;
      if (!solid) solid = V.blockedMap(world, buildings);
      /* Граница следующей попытки обновляется ДО разбора: отложенный повтор
         живёт только внутри неё (pending.at < slot.next). */
      if (slot && seconds !== null) {
        slot.next = nextBoundary(seconds);
        if (clock.next < slot.next) clock.next = slot.next;
        if (town) town.birthNext = slot.next;
      }
      birthAttempt(world, villagers, buildings, town, slot, solid, seconds, born);
    }
    if (clock) clock.due = false;
    if (born.length) renderer.setVillagers(villagers);
    return born;
  }

  /* После F5: следующая граница для всех городов, отложенные повторы сняты. */
  function rearmBirth(world, clock, seconds) {
    if (!clock) return clock;
    var next = nextBoundary(seconds || 0);
    clock.next = next;
    clock.attempts = clock.attempts || 0;
    clock.due = false;
    if (!clock.towns) clock.towns = {};
    var towns = (world && world.towns) || [];
    for (var i = 0; i < towns.length; i++) {
      var town = towns[i];
      if (!town) continue;
      var id = town.id === undefined ? i : town.id;
      var slot = clock.towns[id] || (clock.towns[id] = {
        next: next, pending: null, blocked: [], last: null, growthReason: ''
      });
      slot.next = next;
      slot.pending = null;
      slot.blocked = [];
      slot.growthReason = '';
      town.birthNext = next;
    }
    return clock;
  }

  /* Что показать игроку про рост деревни. Считается только по переданному
     списку жителей; town.villagers не используется (там остаются мёртвые).
     Поля: население/вместимость, свободные места, время до заселения, причина
     задержки и готовый текст для HUD. */
  function birthStatus(world, town, villagers, buildings, clock, seconds) {
    var B = global.Buildings;
    var out = {
      town: town ? town.id : null,
      owner: town ? town.owner : null,
      alive: false,
      population: 0, civilians: 0, warriors: 0, trainees: 0,
      capacity: 0, free: 0, houses: 0, housesFree: 0,
      next: null, retryIn: null, blockedHouses: 0,
      reason: '', canGrow: false, text: ''
    };
    if (!town) { out.reason = 'нет деревни'; return out; }
    out.alive = townAlive(town, buildings);
    var pop = townResidents(town, villagers), i, v;
    out.population = pop.length;
    for (i = 0; i < pop.length; i++) {
      v = pop[i];
      if (v.warrior) out.warriors++;
      else if (v.trainee) out.trainees++;
      else out.civilians++;
    }
    var houses = townHouses(town, buildings), cap = 0, free = 0, freeHouses = 0;
    for (i = 0; i < houses.length; i++) {
      var hcap = B.housingCapacity(houses[i]);
      var hfree = Math.max(0, hcap - residentsOf(houses[i], villagers).length);
      cap += hcap;
      free += hfree;
      if (hfree > 0) freeHouses++;
    }
    out.capacity = cap;
    out.free = free;
    out.houses = houses.length;
    out.housesFree = freeHouses;
    var slot = clock && clock.towns
      ? clock.towns[town.id === undefined ? 0 : town.id] : null;
    var boundary = slot && typeof slot.next === 'number' && slot.next > 0
      ? slot.next
      : (clock && typeof clock.next === 'number' ? clock.next : town.birthNext);
    if (slot && slot.pending && seconds !== null) {
      out.retryIn = Math.max(0, +(slot.pending.at - seconds).toFixed(1));
      out.next = out.retryIn;
      out.blockedHouses = slot.pending.blocked || 0;
    } else if (typeof boundary === 'number' && seconds !== null) {
      out.next = Math.max(0, +(boundary - seconds).toFixed(1));
    }
    if (!out.alive) out.reason = 'город выбыл';
    else if (!houses.length) out.reason = 'нет дома';
    else if (out.population <= 1) out.reason = 'один житель';
    else if (free <= 0) out.reason = 'нет свободного места';
    else if (slot && slot.pending) out.reason = 'двери заняты';
    out.canGrow = !out.reason;
    out.text = 'население ' + out.population + ' / ' + out.capacity;
    if (out.next !== null) out.text += ' · заселение через ' + Math.ceil(out.next) + ' с';
    return out;
  }

  /* ---------------------- режим «против деревни» ------------------------ *
   *
   * Игрок — у края острова, враг — в противоположном. У врага та же
   * деревенская машина, но без интеллекта: лесорубы работают, воины
   * защищаются (см. combat.js), строить и тренировать он не умеет.
   *
   * Состав врага — требование заказчика (2026-10-23): ратуша, два лагеря
   * лесорубов с нанятыми, казарма, военный лагерь с 10 воинами и дома на 16
   * жителей. 16 = 4 дома x 4 места; 6 лесорубов + 10 воинов. */
  var BOT_VILLAGE = [
    { type: 'lumbercamp', variant: 'a' },
    { type: 'lumbercamp', variant: 'a' },
    { type: 'barracks', variant: 'a' },
    { type: 'warcamp', variant: 'x' },
    { type: 'house', variant: 'a' },
    { type: 'house', variant: 'a' },
    { type: 'house', variant: 'a' },
    { type: 'house', variant: 'a' }
  ];

  function startBot(world, renderer, opts) {
    opts = opts || {};
    var B = global.Buildings;
    var sites = (global.WorldGen && global.WorldGen.spawnSites)
      ? global.WorldGen.spawnSites(world, 2) : [];
    if (sites.length < 2) {
      /* Остров не дал двух площадок — не ломаем партию: играем одиночную. */
      return startHome(world, renderer, opts);
    }
    var player = newTown(world, 0, 'Ваша деревня');
    var playerList = B.villageAt(world, sites[0], HOME, VILLAGE, opts.site || SITE);
    var i;
    for (i = 0; i < playerList.length; i++) {
      playerList[i].owner = 0;
      playerList[i].town = player.id;
      playerList[i].id = player.id + ':b' + i;
    }
    player.buildings = playerList;
    player.townhall = playerList[0] || null;
    world.village = player;

    var bot = newTown(world, 1, 'Деревня врага');
    bot.isBot = true;
    var botList = B.villageAt(world, sites[1], HOME, BOT_VILLAGE, opts.site || SITE);
    for (i = 0; i < botList.length; i++) {
      botList[i].owner = 1;
      botList[i].town = bot.id;
      botList[i].id = bot.id + ':b' + i;
    }
    bot.buildings = botList;
    bot.townhall = botList[0] || null;

    var all = playerList.concat(botList);
    world._buildings = all;
    renderer.world = world;
    renderer.setBuildings(all);

    var pv = spawnVillagers(world, renderer, all, player.townhall, {
      count: VILLAGERS, owner: 0, townId: player.id, idBase: 0
    });
    var bv = spawnVillagers(world, renderer, all, bot.townhall, {
      count: 16, owner: 1, townId: bot.id, idBase: 1000, append: true
    });
    var villagers = world._villagers;

    /* 6 лесорубов: по три в каждый лагерь. */
    var camps = botList.filter(function (b) { return B.typeOf(b) === 'lumbercamp'; });
    var free = bv.filter(function (v) { return !v.warrior; });
    var hired = 0;
    for (i = 0; i < camps.length; i++) {
      for (var k = 0; k < 3 && hired < free.length; k++) {
        if (hire(camps[i], free[hired], villagers).ok) hired++;
      }
    }

    /* 10 воинов — сразу в лагерь, без пяти секунд обучения: у врага деревня
       уже стоит. Ставим их на кольцо территории, чтобы не оказались на
       модели 2 x 2. */
    var wc = botList.filter(function (b) { return B.typeOf(b) === 'warcamp'; })[0];
    var patrol = wc ? B.patrolCells(wc) : [];
    var warriors = bv.filter(function (v) { return !v.warrior && !v.employer; });
    for (i = 0; i < warriors.length && i < 10; i++) {
      var w = warriors[i];
      w.warrior = true;
      w.warcamp = wc;
      w.station = null;
      w.state = wc ? 'patrol' : 'stand';
      w.path = null;
      if (wc && patrol.length) {
        var c = patrol[i % patrol.length];
        w.x = c.x + 0.5;
        w.y = c.y + 0.5;
      }
    }

    renderer.setVillagers(villagers);
    if (renderer.fitIsland) renderer.fitIsland();
    return {
      home: player.townhall, buildings: all, playerTown: player,
      botTown: bot, villagers: villagers
    };
  }

  /* --------------------------- мультиплеер ------------------------------ *
   *
   * 2–4 одинаковые стартовые деревни по разным концам острова: ратуша, дом,
   * лагерь лесоруба и три жителя. Никаких военных лагерей и казарм на старте
   * (то же правило 2026-10-23, что и в одиночной игре).
   *
   * Деревни строит ОДИН код для всех игроков: если бы у первого была одна
   * деревня, а у второго другая, «одинаковый старт» был бы только на словах. */
  function startMulti(world, renderer, opts) {
    opts = opts || {};
    var B = global.Buildings;
    var n = Math.max(2, Math.min(4, opts.players || 2));
    var sites = (global.WorldGen && global.WorldGen.spawnSites)
      ? global.WorldGen.spawnSites(world, n) : [];
    if (sites.length < n) {
      throw new Error('остров не дал ' + n + ' площадок: ' + sites.length);
    }
    var all = [], towns = [], i;
    for (i = 0; i < n; i++) {
      var town = newTown(world, i, 'Игрок ' + (i + 1));
      var list = B.villageAt(world, sites[i], HOME, VILLAGE, opts.site || SITE);
      for (var j = 0; j < list.length; j++) {
        list[j].owner = i;
        list[j].town = town.id;
        list[j].id = town.id + ':b' + j;
      }
      town.buildings = list;
      town.townhall = list[0] || null;
      towns.push(town);
      all = all.concat(list);
    }
    world.village = towns[0];
    world._buildings = all;
    renderer.world = world;
    renderer.setBuildings(all);
    for (i = 0; i < n; i++) {
      spawnVillagers(world, renderer, all, towns[i].townhall, {
        count: VILLAGERS, owner: i, townId: towns[i].id,
        idBase: i * 1000, append: i > 0
      });
    }
    renderer.setVillagers(world._villagers);
    if (renderer.fitIsland) renderer.fitIsland();
    return {
      home: towns[0].townhall, buildings: all, towns: towns,
      villagers: world._villagers
    };
  }

  /* Деревня игрока на только что сгенерированном мире.

     Возвращает `{ home, buildings }`: `home` — ратуша (или null, если места
     не нашлось), `buildings` — список построек партии: ратуша первой, за ней
     дом, лагерь лесоруба и военный лагерь. Список отдаётся готовым, чтобы оболочки не собирали его
     каждая по-своему, и чтобы «ратуша — первая» было свойством партии, а не
     совпадением: камеру и таблички оболочки наводят по ней.

     Рендер получает мир, постройки и кадр «остров целиком»: партия всегда
     открывается общим планом, и это тоже часть начала игры. */
  function startHome(world, renderer, opts) {
    var site = opts || SITE;
    /* Казна деревни. Счётчик добытого живёт ЗДЕСЬ, на мире партии, и это
       ЕДИНСТВЕННОЕ его место: и игра, и генератор читают world.village, а
       второго счётчика («сколько сдал лагерь») нет — два счётчика об одном и
       том же расходятся на первой же правке.

       Заводится при НАЧАЛЕ ПАРТИИ, а не при найме: партия без рабочих тоже
       имеет казну, просто пустую (logs = 0). Поле на мире, а не в замыкании
       Session, потому что мир — то, что переживает перегенерацию: новая карта
       начинает счёт заново, и это правильный ответ.

       Что означают числа: logs — сколько брёвен деревня приняла; deliveries —
       сколько ходок было сдано. Одно без другого не бывает, и вместе они
       отвечают на вопрос «работал ли лагерь»: 12 брёвен за 3 ходки. */
    var town = (world.towns && world.towns[0]) || newTown(world, 0, 'Деревня');
    town.logs = 0;
    world.village = town;
    // village() сама расчищает площадку ДО постановки: лес на новом сиде
    // растёт заново и без этого прорастает сквозь стены.
    var list = global.Buildings.village(world, HOME, VILLAGE, site);
    for (var bi = 0; bi < list.length; bi++) {
      list[bi].owner = town.owner;
      list[bi].town = town.id;
      list[bi].id = town.id + ':b' + bi;
    }
    town.buildings = list;
    town.townhall = list.length ? list[0] : null;
    var home = list.length ? list[0] : null;
    if (renderer) {
      renderer.world = world;
      renderer.setBuildings(list);
      renderer.fitIsland();
    }
    return { home: home, buildings: list };
  }

  // Дом жителя в списке построек (или null: дом не поставился).
  function houseOf(buildings) {
    for (var i = 0; i < (buildings || []).length; i++) {
      if (buildings[i] && global.Buildings.typeOf(buildings[i]) === 'house') return buildings[i];
    }
    return null;
  }

  /* Жители выходят из дома: место появления — клетка перед дверью дома
     жителя, а не двор ратуши, как было до деревни. Дверь дома смотрит
     вправо-вниз, на камеру (все постройки деревни стоят так: FACE_ROT), а
     клетку перед ней считает `Buildings.frontSpot` по тому же правилу, что и
     сам поворот, — значит человек выходит на передний план, а не из-за угла
     дома. Дальше он ходит сам, и в этом весь смысл: игрок им не управляет.

     Дома нет — атлас не загрузился или места не нашлось — выходят из двора
     ратуши, с той стороны, откуда смотрит камера (x + y больше — значит,
     ближе к зрителю). Партия без дома остаётся партией.

     ПРОПИСКА. Кто в доме числится, решает вместимость дома, а не число
     жителей: `Buildings.housingCapacity(house)` = 4 у дома первого уровня,
     значит трое помещаются все. Не поместившиеся остаются БЕЗДОМНЫМИ
     (v.home = null) — и это не поломка партии: бездомный просто гуляет вокруг
     того места, где появился (якорь прогулки, см. villager.js). Дом не
     поставился — бездомные все. */
  function spawnVillagers(world, renderer, buildings, home, opts) {
    var list = [];
    opts = opts || {};
    var n = opts.count === undefined ? VILLAGERS : opts.count;
    // Атласа нет — жителей нет: спрайты грузит оболочка, и это не повод
    // ронять партию.
    if (!world || !renderer.villagerSprites || n <= 0) {
      renderer.setVillagers(list);
      return list;
    }
    var base = (opts.append && world._villagers) ? world._villagers.slice() : [];
    var list = [];
    var town = opts.townId !== undefined ? townById(world, opts.townId) : townOf(world, opts.owner || 0);
    var houses = [], i;
    for (i = 0; i < (buildings || []).length; i++) {
      var hb = buildings[i];
      if (!hb || global.Buildings.typeOf(hb) !== 'house') continue;
      if (opts.owner !== undefined &&
          (hb.owner === undefined ? 0 : hb.owner) !== opts.owner) continue;
      if (opts.townId !== undefined && hb.town !== opts.townId) continue;
      houses.push(hb);
    }
    var caps = houses.map(function (h) { return global.Buildings.housingCapacity(h); });
    var totalCap = caps.reduce(function (a, c) { return a + c; }, 0);
    function homeFor(k) {
      var left = k;
      for (var j = 0; j < houses.length; j++) {
        if (left < caps[j]) return houses[j];
        left -= caps[j];
      }
      return null;
    }
    var fallbackX = world.width / 2, fallbackY = world.height / 2;
    if (home) {
      var fp = global.Buildings.footprint(home.rot, home.type);
      fallbackX = home.x + fp.w + 1;
      fallbackY = home.y + fp.h + 1;
    }
    for (i = 0; i < n; i++) {
      var h = homeFor(i);
      var sx = fallbackX, sy = fallbackY;
      if (h) {
        var door = global.Buildings.frontSpot(h);
        sx = door.x + 0.5;
        sy = door.y + 0.5;
      }
      var v = global.Villagers.create(world, {
        index: i, id: (opts.idBase || 0) + i + 1,
        x: sx, y: sy, buildings: buildings,
        owner: opts.owner === undefined ? 0 : opts.owner,
        town: town ? town.id : (opts.town === undefined ? 0 : opts.town),
        // Кому досталось место в доме, кому нет: сверх вместимости — null.
        home: h,
        // Двое в одной клетке не встают: второй ищет место рядом.
        avoid: base.concat(list)
      });
      list.push(v);
      base.push(v);
      if (town) town.villagers.push(v);
    }
    renderer.setVillagers(base);
    /* Список партии — на мире: по нему движок выбирает места двора
       (Villagers.partnersOf) и освобождает работников при сносе постройки.
       Тот же список каждый кадр кладёт stepVillagers; здесь он появляется
       сразу, ещё до первого шага. */
    world._villagers = base;
    return list;
  }

  /* Кто числится в этом доме — выборка по v.home. Правда о прописке живёт в
     ОДНОМ месте, на жителе (`v.home`): списка жильцов у дома нет и быть не
     должно — два списка об одном и том же расходятся на первой же правке.

     Дом null — жильцов нет: бездомный не числится нигде. */
  function residentsOf(house, villagers) {
    var out = [];
    if (!house) return out;
    for (var i = 0; i < (villagers || []).length; i++) {
      if (villagers[i] && villagers[i].home === house) out.push(villagers[i]);
    }
    return out;
  }

  /* Как зовут жителя. Тоже одно место: id присваивается в Villagers.create
     (opts.index), а читается здесь — HUD и интерфейс лагеря (задача 4) зовут
     человека этими словами, а не собирают «Житель №» у себя. */
  function villagerName(v) {
    return v && v.id ? 'Житель №' + v.id : 'Житель';
  }

  /* ============================ наём на работу ============================ *
   *
   * Рабочее место одно — лагерь лесоруба (рубят лес). В него нанимают жителей
   * (правило заказчика 2026-10-16: «в него нанимают жителей, до трёх»).
   * Казарма больше не рабочее место: там тренируют воинов (см. ниже), и наём
   * в неё запрещён.
   *
   * Правда о найме живёт в ОДНОМ поле — `v.employer` (постройка, которая
   * человека наняла, или null). Списка работников у постройки нет и быть не
   * должно: кто в ней работает, считается ВЫБОРКОЙ по этому полю (workersOf).
   * Два списка об одном и том же расходятся на первой же правке — на этом уже
   * стояла прописка в доме (v.home, residentsOf), и наём устроен так же.
   *
   * Сколько человек постройка берёт, решает ПОСТРОЙКА, а не этот файл:
   * Buildings.workSlots(b) — таблица по типам и уровням (у лагеря первого
   * уровня три места). Здесь только спрашивают.
   * ---------------------------------------------------------------------- */

  // Работники постройки — выборка по v.employer, а не список где-то ещё.
  function workersOf(camp, villagers) {
    var out = [];
    if (!camp) return out;
    for (var i = 0; i < (villagers || []).length; i++) {
      if (villagers[i] && villagers[i].employer === camp) out.push(villagers[i]);
    }
    return out;
  }

  /* Чьё это — житель, постройка, город. У старой постройки и у одинокой
     деревни owner может отсутствовать, и это игрок 0 — так же его читают
     начало партии и бой. Одна функция на все выборки: сравнение в панели не
     должно разойтись с проверкой в canHire/canTrain. */
  function ownerId(o) {
    return o && o.owner !== undefined ? o.owner : 0;
  }

  /* ------------------------- кто где работает ---------------------------- *
   *
   * Рабочее место в игре одно — лагерь лесоруба; оно и живёт в таблице
   * Buildings.WORK. Воин — не работник: у него нет v.employer, а есть
   * v.warrior и v.warcamp. Поэтому isWorkplace и isTrainer — разные вопросы.
   * ---------------------------------------------------------------------- */
  function isWorkplace(b) {
    return !!(b && global.Buildings.workSlots(b) > 0);
  }

  function isBarracks(b) {
    return !!b && global.Buildings.typeOf(b) === 'barracks';
  }

  /* Воин — не «житель, занятый казармой»: обучение закончилось, казарма
     осталась позади, а человек теперь ходит по военному лагерю. Поэтому
     признак живёт на самом жителе (`v.warrior`), а не выводится из
     `v.employer`: до выхода из казармы он ещё НЕ воин, а после — уже не
     работник казармы. */
  function isKnight(v) {
    return !!(v && v.warrior);
  }

  function isWarrior(v) { return isKnight(v); }

  function worksAt(b, v) {
    return !!(b && v && v.employer === b);
  }

  /* Где человек занят — словами для причины отказа. */
  function employerPhrase(emp) {
    if (!emp) return '';
    if (global.Buildings.typeOf(emp) === 'lumbercamp') return 'работает в лагере лесоруба';
    return 'работает в другом месте';
  }

  function slotReason(camp) {
    return isBarracks(camp)
      ? 'в казарме нет свободных мест'
      : 'в лагере нет свободных мест';
  }

  function hereReason(camp) {
    return isBarracks(camp)
      ? 'он уже служит в этой казарме'
      : 'он уже работает в этом лагере';
  }

  function noFireReason(camp) {
    return isBarracks(camp)
      ? 'в казарме тренируют, а не нанимают'
      : 'в лагере нет работников';
  }

  /* Слова панели найма. Они живут здесь, а не в HUD: «работники 2 / 3»,
     «здесь работает» — это то же правило о занятости, только названное
     по-русски. Панель лагеря берёт слова у движка; у казармы свои слова
     тренировки (trainingGroupLabel). */
  function workWord(camp) {
    return 'работники';
  }

  function workMark(camp) {
    return 'здесь работает';
  }

  function hireGroup(camp, v) {
    if (!v) return 'other';
    if (v.employer === camp) return 'here';
    if (!v.employer) return 'free';
    return 'other';
  }

  function hireGroupLabel(camp, group) {
    if (group === 'here') return 'работают здесь';
    if (group === 'free') return 'свободны';
    return 'заняты';
  }

  /* ПОРЯДОК СПИСКА НАЙМА — одно правило на все интерфейсы найма.
   *
   * Три группы: нанятые в этой постройке, свободные, все остальные (занятые в
   * другом месте — например, на другой работе). Внутри группы — по номеру
   * жителя, стабильно. Если нанятых здесь нет, список начинается со
   * свободных: пустой группы и заголовка не будет.
   *
   * Сортирует ДВИЖОК, а HUD только рисует этот список. Второго порядка в
   * интерфейсе нет: иначе панель и пакетные кнопки разошлись бы на первой же
   * правке.
   *
   * Чужие сюда не попадают вовсе: в «против деревни» и в сети список партии
   * общий, но нанимать можно только своих, и canHire всё равно ответил бы
   * «чужая постройка». Показывать такого человека в панели незачем.
   */
  function hireOrder(camp, villagers) {
    var here = [], free = [], other = [];
    var list = villagers || [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!v || ownerId(v) !== ownerId(camp)) continue;
      var item = { v: v, i: i };
      var g = hireGroup(camp, v);
      if (g === 'here') here.push(item);
      else if (g === 'free') free.push(item);
      else other.push(item);
    }
    function order(a, b) {
      var ia = typeof a.v.id === 'number' ? a.v.id : Infinity;
      var ib = typeof b.v.id === 'number' ? b.v.id : Infinity;
      return (ia - ib) || (a.i - b.i);
    }
    here.sort(order);
    free.sort(order);
    other.sort(order);
    var out = [];
    for (var g = 0; g < 3; g++) {
      var part = g === 0 ? here : (g === 1 ? free : other);
      for (var k = 0; k < part.length; k++) out.push(part[k].v);
    }
    return out;
  }

  /* Можно ли нанять этого жителя в эту постройку. Причина отказа — по-русски и
     словами интерфейса: HUD показывает её КАК ЕСТЬ, не переписывая, и поэтому
     она живёт здесь.

     Отказов ровно четыре, и все они — ответы, а не ошибки: не постройка, не
     рабочее место, все места заняты, человек уже нанят (сюда или в другое
     место). Проверка «уже нанят» стоит ДО проверки мест: работник, которого
     пробуют нанять второй раз, не должен получать «нет мест» — места как раз
     есть, он сам их занимает. */
  function canHire(camp, v, villagers) {
    var B = global.Buildings;
    if (!camp) return { ok: false, reason: 'нет постройки' };
    if (!v) return { ok: false, reason: 'нет жителя' };
    if (ownerId(camp) !== ownerId(v)) {
      return { ok: false, reason: 'чужая постройка' };
    }
    if (isBarracks(camp)) {
      return { ok: false, reason: 'в казарме тренируют, а не нанимают' };
    }
    if (!isWorkplace(camp)) {
      return { ok: false, reason: 'работать можно только в лагере лесоруба' };
    }
    if (v.warrior) return { ok: false, reason: 'он уже воин' };
    if (v.trainee) return { ok: false, reason: 'он тренируется в казарме' };
    if (v.employer) {
      return { ok: false, reason: v.employer === camp
        ? hereReason(camp)
        : 'он уже ' + employerPhrase(v.employer) };
    }
    var slots = B.workSlots(camp);
    if (workersOf(camp, villagers).length >= slots) {
      return { ok: false, reason: slotReason(camp) };
    }
    return { ok: true, reason: '' };
  }

  /* Нанять. Ставит employer (и job — то же самое, для кода, который спрашивает
     «работает ли») и СРАЗУ отправляет человека к лагерю: состояние toCamp,
     прогулка брошена. Первый кадр после найма — уже шаг к постройке, паузы
     нет. Жителя, который уже занят, наём не трогает: причина отказа у canHire.
     В казарму не нанимают — там тренируют. */
  function hire(camp, v, villagers) {
    var chk = canHire(camp, v, villagers);
    if (!chk.ok) return chk;
    v.employer = camp;
    v.job = camp;
    v.state = 'toCamp';
    v.path = null;
    v.carrying = false;     // приняли на работу — брёвен на руках ещё нет
    // Метка с прежней цели снимается ДО того, как цель забыта: без этого дерево
    // осталось бы «занятым» навсегда и в списке целей его не стало бы ни для кого.
    if (global.Villagers.unmark) global.Villagers.unmark(v, v.tree);
    v.tree = null;
    v.goal = null;
    v.close = false;
    v.spot = null;
    v.spotTrip = false;
    v.intoYard = false;
    v.exitYard = false;
    v.escape = false;
    v.campKey = undefined;
    v.lost = 0;
    v.hold = 0;
    v.stuck = 0;
    return { ok: true, reason: '' };
  }

  /* Уволить. Снимает employer и НЕМЕДЛЕННО возвращает человека к прогулке:
     он больше не работник, дерево не ищет и не рубит. Дом, имя и id не
     меняются, цель и путь сбрасываются тем же кодом.

     Брёвна, которые он нёс, НЕ ЗАСЧИТЫВАЮТСЯ: счёт деревни растёт только в
     кадр прихода на место сдачи (js/villager.js: deposit — зовётся из того же
     кадра, где кончился путь), а не в момент удара топором. Уволенный с
     полными руками ничего не приносит — так и задумано: брёвна появляются у
     деревни тогда, когда их приняли, а не тогда, когда их несут. */
  function fire(camp, v) {
    if (!v) return { ok: false, reason: 'нет жителя' };
    if (!v.employer) return { ok: false, reason: 'он и так не работает' };
    if (camp && v.employer !== camp) {
      return { ok: false, reason: 'он ' + employerPhrase(v.employer) };
    }
    if (global.Villagers.unmark) global.Villagers.unmark(v, v.tree);
    v.employer = null;
    v.job = null;
    v.spot = null;
    v.spotTrip = false;
    v.intoYard = false;
    v.exitYard = false;
    v.escape = false;
    v.campKey = undefined;
    v.jobPath = false;
    v.lost = 0;
    v.carrying = false;     // уволенный брёвна не донесёт и не сдаст
    v.tree = null;
    v.goal = null;
    v.path = null;
    v.close = false;
    v.hold = 0;
    v.stuck = 0;
    v.chopT = 0;
    v.hits = 0;
    // К прогулке: точка берётся в круге вокруг дома тем же планировщиком, что и
    // у никогда не работавшего (js/villager.js: planWander) — прогулка одна.
    v.state = 'wander';
    v.anim = 'walk';
    v.animWant = 'walk';
    v.frozen = false;
    v.phase = 0;
    return { ok: true, reason: '' };
  }

  /* ========================== тренировка в казарме ======================== *
   *
   * В казарме НЕ нанимают. Свободный житель идёт ко входу, заступает на
   * территорию казармы, растворяется в дверях, пять секунд тренируется и
   * выходит уже воином — и сразу уходит в военный лагерь. Правда о тренировке
   * живёт на жителе: `v.trainee` (учится), `v.trainingAt` (в какой казарме),
   * `v.trainT` (сколько осталось), `v.warrior` (уже воин), `v.warcamp` (куда
   * идти). `v.employer` тренировка НЕ трогает: это поле про работу, а не про
   * обучение.
   *
   * Списка учеников у казармы нет и быть не должно — он выборка по
   * `v.trainingAt`, как жильцы дома и работники лагеря. Два списка об одном и
   * том же расходятся на первой же правке. */

  function isTrainer(b) { return isBarracks(b); }

  function traineesOf(camp, villagers) {
    var out = [];
    if (!camp) return out;
    for (var i = 0; i < (villagers || []).length; i++) {
      var v = villagers[i];
      if (v && v.trainee && v.trainingAt === camp) out.push(v);
    }
    return out;
  }

  /* Все воины списка. owner задан — только его: панель казармы считает «воины
     N» своей деревни, а не всех, кто есть на карте. Без owner — все, как
     раньше: так его зовут проверки движка, которым нужен весь состав. */
  function warriorsOf(villagers, owner) {
    var out = [];
    for (var i = 0; i < (villagers || []).length; i++) {
      var v = villagers[i];
      if (!v || !v.warrior) continue;
      if (owner !== undefined && ownerId(v) !== owner) continue;
      out.push(v);
    }
    return out;
  }

  function warcampsOf(buildings) {
    var out = [];
    for (var i = 0; i < (buildings || []).length; i++) {
      if (buildings[i] && global.Buildings.typeOf(buildings[i]) === 'warcamp') out.push(buildings[i]);
    }
    return out;
  }

  /* Сколько воинов УЖЕ стоит в лагере. Считаются только живые, обученные и
     приписанные к этому лагерю; идущий в лагерь тоже считается — иначе двое
     последних мест достались бы одному и тому же отряду. */
  function warriorsAt(camp, villagers) {
    var n = 0;
    for (var i = 0; i < (villagers || []).length; i++) {
      var v = villagers[i];
      if (v && v.warrior && !v.trainee && !v.station && v.warcamp === camp) n++;
    }
    return n;
  }

  function warcampRoom(camp, villagers) {
    return Math.max(0, global.Buildings.WARCAMP_CAP - warriorsAt(camp, villagers));
  }

  /* Сколько воинов ждёт во дворе казармы. Двор — не пятно: там стоят снаружи
     стены, поэтому вместимость отдельная (Buildings.BARRACKS_YARD_CAP). */
  function garrisonAt(barracks, villagers) {
    var n = 0;
    for (var i = 0; i < (villagers || []).length; i++) {
      var v = villagers[i];
      if (v && v.warrior && !v.trainee && v.station === barracks) n++;
    }
    return n;
  }

  function barracksRoom(barracks, villagers) {
    return Math.max(0, global.Buildings.BARRACKS_YARD_CAP - garrisonAt(barracks, villagers));
  }

  /* Сколько ещё воинов деревня примет прямо сейчас: свободные места во всех
     лагерях плюс дворы всех казарм. Это число и есть предел тренировки. */
  function armyRoom(buildings, villagers, owner) {
    var n = 0;
    for (var i = 0; i < (buildings || []).length; i++) {
      var b = buildings[i];
      if (!b || b.rubble) continue;
      if (owner !== undefined && b.owner !== owner) continue;
      if (global.Buildings.typeOf(b) === 'warcamp') n += warcampRoom(b, villagers);
      else if (isBarracks(b)) n += barracksRoom(b, villagers);
    }
    return n;
  }

  /* Ближайший лагерь, в котором ЕСТЬ МЕСТО. Старое имя сохранено: без списка
     жителей занятость не проверить, и тогда выбирается просто ближайший —
     так зовут тесты и старый код. */
  function nearestWarcamp(buildings, x, y, villagers, owner) {
    var list = warcampsOf(buildings), best = null, bestD = Infinity;
    for (var i = 0; i < list.length; i++) {
      if (list[i].rubble) continue;
      if (owner !== undefined && list[i].owner !== owner) continue;
      if (villagers && warcampRoom(list[i], villagers) <= 0) continue;
      var c = global.Buildings.center(list[i]);
      var d = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y);
      if (d < bestD) { bestD = d; best = list[i]; }
    }
    return best;
  }

  function nearestBarracksWithYard(buildings, x, y, villagers, owner) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < (buildings || []).length; i++) {
      var b = buildings[i];
      if (!b || b.rubble || !isBarracks(b)) continue;
      if (owner !== undefined && b.owner !== owner) continue;
      if (villagers && barracksRoom(b, villagers) <= 0) continue;
      var c = global.Buildings.center(b);
      var d = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  /* Куда девать обученного воина: сначала лагерь со свободным местом, потом
     двор казармы. null — мест нет вовсе, и тогда тренировать нельзя (иначе
     воин вышел бы в мир, где ему негде стоять). */
  function destinationFor(buildings, villagers, x, y, owner) {
    var camp = nearestWarcamp(buildings, x, y, villagers, owner);
    if (camp) return { camp: camp, barracks: null };
    var bar = nearestBarracksWithYard(buildings, x, y, villagers, owner);
    if (bar) return { camp: null, barracks: bar };
    return null;
  }

  /* Перевести ждущих из дворов казарм в лагеря, где освободилось место.
     Зовётся после постройки лагеря, после боя и раз в секунду в stepVillagers.
     Воинов, у которых уже есть лагерь или приказ, не трогает. */
  function rebalanceGarrison(world, buildings, villagers) {
    var moved = 0, i, v, dest;
    for (i = 0; i < (villagers || []).length; i++) {
      v = villagers[i];
      if (!v || !v.warrior || v.trainee) continue;
      if (v.order) continue;
      if (v.warcamp && !v.warcamp.rubble) continue;
      dest = destinationFor(buildings, villagers, v.x, v.y, v.owner);
      if (!dest || !dest.camp) continue;
      v.warcamp = dest.camp;
      v.station = null;
      v.garrisonSpot = null;
      v.path = null;
      v.campKey = null;
      v.state = 'toWarcamp';
      moved++;
    }
    return moved;
  }

  function trainingSlots(camp) {
    return global.Buildings.trainingSlots(camp);
  }

  /* Свободен ли житель для тренировки: не работает, не учится и не воин. */
  function freeForTraining(v) {
    return !!(v && !v.employer && !v.trainee && !v.warrior);
  }

  /* Можно ли отправить этого жителя учиться в эту казарму. Причина отказа —
     словами интерфейса, как у canHire: HUD показывает её как есть. */
  function canTrain(camp, v, villagers, buildings) {
    var B = global.Buildings;
    if (!camp) return { ok: false, reason: 'нет казармы' };
    if (!v) return { ok: false, reason: 'нет жителя' };
    if (!isBarracks(camp)) return { ok: false, reason: 'тренировать можно только в казарме' };
    if (ownerId(camp) !== ownerId(v)) {
      return { ok: false, reason: 'чужая казарма' };
    }
    if (v.warrior) return { ok: false, reason: 'он уже воин' };
    if (v.trainee) {
      return { ok: false, reason: v.trainingAt === camp
        ? 'он уже тренируется в этой казарме'
        : 'он уже тренируется в другой казарме' };
    }
    if (v.employer) return { ok: false, reason: 'он уже ' + employerPhrase(v.employer) };
    var slots = B.trainingSlots(camp);
    if (traineesOf(camp, villagers).length >= slots) {
      return { ok: false, reason: 'в казарме нет свободных мест для тренировки' };
    }
    /* Куда денется обученный. Раньше без лагеря тренировка запрещалась; теперь
       есть двор казармы, и запрет только один — мест нет нигде. Если список
       построек не передан, проверку пропускаем: это вызов движка без мира. */
    if (buildings && buildings.length && !destinationFor(buildings, villagers, camp.x, camp.y, camp.owner)) {
      return { ok: false, reason: 'военный лагерь и двор казармы заполнены' };
    }
    return { ok: true, reason: '' };
  }

  /* Отправить жителя учиться. Он сейчас же бросает прогулку и идёт ко входу
     казармы; состояниями занимается js/villager.js (traineeUpdate). */
  function train(camp, v, villagers, buildings) {
    var chk = canTrain(camp, v, villagers, buildings);
    if (!chk.ok) return chk;
    if (global.Villagers.unmark) global.Villagers.unmark(v, v.tree);
    /* Работа, если она была, снимается: тренируют только свободных, но
       страховка дешёвая и не даёт двум режимам спорить за одного человека. */
    v.employer = null;
    v.job = null;
    v.tree = null;
    v.goal = null;
    v.path = null;
    v.spot = null;
    v.spotTrip = false;
    v.intoYard = false;
    v.exitYard = false;
    v.escape = false;
    v.carrying = false;
    v.close = false;
    v.hold = 0;
    v.stuck = 0;
    v.lost = 0;
    v.chopT = 0;
    v.hits = 0;
    v.trainee = true;
    v.trainingAt = camp;
    v.trainT = TRAIN_TIME;
    v.trainKey = camp.x + ':' + camp.y + ':' + camp.rot;
    v.warrior = false;
    /* Куда пойдёт после обучения, окончательно решает finishTraining: за пять
       секунд место могло освободиться или наоборот. Здесь — только подсказка
       для интерфейса и согласованность полей. */
    var dest = destinationFor(buildings, villagers, v.x, v.y, v.owner);
    v.warcamp = dest && dest.camp ? dest.camp : null;
    v.station = dest && dest.barracks ? dest.barracks : null;
    v.garrisonSpot = null;
    v.hidden = false;
    v.vanishT = 0;
    v.vanishDur = VANISH_TIME;
    v.emergeT = 0;
    v.emergeDur = EMERGE_TIME;
    v.entering = false;
    v.exiting = false;
    v.state = 'toBarracks';
    v.jobPath = true;
    v.anim = 'walk';
    v.animWant = 'walk';
    v.frozen = false;
    v.phase = 0;
    return { ok: true, reason: '' };
  }

  /* Отменить обучение и вернуть человека к прогулке. Зовётся, когда казарму
     снесли или ученик оказался в мире без неё. Если он был внутри, его
     ставят за дверью (вход считает Buildings.entrance) — иначе он оказался бы
     в пятне постройки, которой уже нет. */
  function cancelTraining(camp, v, opts) {
    if (!v || !v.trainee) return { ok: false, reason: 'он не тренируется' };
    if (camp && v.trainingAt && v.trainingAt !== camp) {
      return { ok: false, reason: 'он тренируется в другой казарме' };
    }
    var at = v.trainingAt;
    var ent = at && global.Buildings.entrance(at);
    if (ent && opts && opts.outside) {
      v.x = ent.out.x;
      v.y = ent.out.y;
    }
    v.trainee = false;
    v.trainingAt = null;
    v.trainT = 0;
    v.trainKey = null;
    v.hidden = false;
    v.vanishT = 0;
    v.entering = false;
    v.exiting = false;
    v.emergeT = EMERGE_TIME;
    v.emergeDur = EMERGE_TIME;
    v.state = 'wander';
    v.path = null;
    v.goal = null;
    v.anim = 'idle';
    v.animWant = 'idle';
    v.frozen = false;
    v.phase = 0;
    v.stuck = 0;
    return { ok: true, reason: '' };
  }

  /* Все ученики снесённой казармы — назад в свободные. Возвращает число. */
  function releaseTrainees(camp, villagers) {
    var list = traineesOf(camp, villagers), n = 0;
    for (var i = 0; i < list.length; i++) {
      if (cancelTraining(camp, list[i], { outside: true }).ok) n++;
    }
    return n;
  }

  /* Порядок строк панели казармы: кто учится здесь, свободные, воины, все
     остальные (занятые в лагере или в другой казарме). Внутри — по номеру. */
  function trainingGroup(camp, v) {
    if (!v) return 'other';
    if (v.trainee && v.trainingAt === camp) return 'training';
    if (v.warrior) return 'warrior';
    if (v.trainee) return 'other';
    if (!v.employer) return 'free';
    return 'other';
  }

  function trainingGroupLabel(camp, group) {
    if (group === 'training') return 'тренируются здесь';
    if (group === 'free') return 'свободны';
    if (group === 'warrior') return 'воины';
    return 'заняты';
  }

  /* В списке только жители владельца казармы: чужих не тренируют (canTrain
     ответит «чужая казарма»), и в панели им делать нечего — даже в группе
     «заняты» или «воины». */
  function trainingOrder(camp, villagers) {
    var buckets = { training: [], free: [], warrior: [], other: [] };
    var list = villagers || [], i;
    for (i = 0; i < list.length; i++) {
      if (!list[i] || ownerId(list[i]) !== ownerId(camp)) continue;
      buckets[trainingGroup(camp, list[i])].push({ v: list[i], i: i });
    }
    function order(a, b) {
      var ia = typeof a.v.id === 'number' ? a.v.id : Infinity;
      var ib = typeof b.v.id === 'number' ? b.v.id : Infinity;
      return (ia - ib) || (a.i - b.i);
    }
    var out = [];
    ['training', 'free', 'warrior', 'other'].forEach(function (g) {
      buckets[g].sort(order);
      for (var k = 0; k < buckets[g].length; k++) out.push(buckets[g][k].v);
    });
    return out;
  }

  function trainingBatchInfo(camp, villagers, buildings) {
    var out = { train: { ok: false, count: 0, free: 0, room: 0, reason: '' } };
    if (!camp) { out.train.reason = 'нет казармы'; return out; }
    var slots = global.Buildings.trainingSlots(camp);
    var busy = traineesOf(camp, villagers).length;
    var order = trainingOrder(camp, villagers), free = [], i;
    for (i = 0; i < order.length; i++) {
      if (freeForTraining(order[i])) free.push(order[i]);
    }
    out.train.free = free.length;
    out.train.room = Math.max(0, slots - busy);
    var destRoom = armyRoom(buildings, villagers, camp.owner);
    out.train.destRoom = destRoom;
    out.train.count = Math.min(free.length, out.train.room, destRoom);
    if (!isBarracks(camp)) out.train.reason = 'тренировать можно только в казарме';
    else if (!free.length) out.train.reason = 'нет свободных жителей';
    else if (out.train.room <= 0) out.train.reason = 'в казарме нет свободных мест для тренировки';
    else if (destRoom <= 0) out.train.reason = 'военный лагерь и двор казармы заполнены';
    else out.train.ok = true;
    return out;
  }

  /* Отправить на тренировку всех свободных, сколько помещается. Порядок — по
     номеру жителя, правила — те же canTrain/train. */
  function trainAll(camp, villagers, buildings) {
    var info = trainingBatchInfo(camp, villagers, buildings);
    if (!info.train.ok || info.train.count <= 0) {
      return { ok: false, reason: info.train.reason || 'тренировать некого', trained: 0, count: 0 };
    }
    var order = trainingOrder(camp, villagers), trained = 0, i, res;
    for (i = 0; i < order.length && trained < info.train.count; i++) {
      if (!freeForTraining(order[i])) continue;
      res = train(camp, order[i], villagers, buildings);
      if (res.ok) trained++;
    }
    if (!trained) return { ok: false, reason: info.train.reason || 'тренировать некого', trained: 0, count: 0 };
    return { ok: true, reason: '', trained: trained, count: trained };
  }

  /* ------------------------- пакетные действия --------------------------- *
   *
   * «Нанять свободных» и «Распустить всех» — те же canHire/hire/fire, только
   * в цикле по порядку списка. Своих правил у пакета нет: сколько мест, кто
   * свободен и почему нельзя — отвечает движок.
   *
   * batchInfo — сухой ответ для кнопок: сколько наймётся/распустится и почему
   * нельзя, если нельзя. hireAll/fireAll делают то же самое по-настоящему.
   * ---------------------------------------------------------------------- */
  function batchInfo(camp, villagers) {
    var out = {
      hire: { ok: false, count: 0, free: 0, room: 0, reason: '' },
      fire: { ok: false, count: 0, reason: '' }
    };
    if (!camp) {
      out.hire.reason = 'нет постройки';
      out.fire.reason = 'нет постройки';
      return out;
    }
    if (isBarracks(camp)) {
      out.hire.reason = 'в казарме тренируют, а не нанимают';
      out.fire.reason = 'в казарме тренируют, а не нанимают';
      return out;
    }
    var slots = global.Buildings.workSlots(camp);
    var workers = workersOf(camp, villagers);
    var order = hireOrder(camp, villagers), free = [], i;
    for (i = 0; i < order.length; i++) if (!order[i].employer) free.push(order[i]);
    out.hire.free = free.length;
    out.hire.room = Math.max(0, slots - workers.length);
    out.hire.count = Math.min(free.length, out.hire.room);
    if (!isWorkplace(camp)) out.hire.reason = 'работать можно только в лагере лесоруба';
    else if (!free.length) out.hire.reason = 'нет свободных жителей';
    else if (out.hire.room <= 0) out.hire.reason = slotReason(camp);
    else out.hire.ok = true;

    out.fire.count = workers.length;
    if (!workers.length) out.fire.reason = noFireReason(camp);
    else out.fire.ok = true;
    return out;
  }

  /* Нанять свободных, сколько помещается. Порядок — как в списке: свободные
     по номеру жителя. Возвращает, сколько нанято; отказ — причиной движка. */
  function hireAll(camp, villagers) {
    var info = batchInfo(camp, villagers);
    if (!info.hire.ok || info.hire.count <= 0) {
      return { ok: false, reason: info.hire.reason || 'нанимать некого', hired: 0, count: 0 };
    }
    var order = hireOrder(camp, villagers), hired = 0, i, res;
    for (i = 0; i < order.length && hired < info.hire.count; i++) {
      if (order[i].employer) continue;
      res = hire(camp, order[i], villagers);
      if (res.ok) hired++;
    }
    if (!hired) return { ok: false, reason: info.hire.reason || 'нанимать некого', hired: 0, count: 0 };
    return { ok: true, reason: '', hired: hired, count: hired };
  }

  /* Распустить всех, кто работает ИМЕННО ЗДЕСЬ. Чужие не трогаются: выборка
     workersOf идёт по v.employer === camp. */
  function fireAll(camp, villagers) {
    var workers = workersOf(camp, villagers);
    if (!workers.length) {
      return { ok: false, reason: noFireReason(camp), fired: 0, count: 0 };
    }
    var fired = 0, i;
    for (i = 0; i < workers.length; i++) {
      if (fire(camp, workers[i]).ok) fired++;
    }
    if (!fired) return { ok: false, reason: noFireReason(camp), fired: 0, count: 0 };
    return { ok: true, reason: '', fired: fired, count: fired };
  }

  /* Шаг всех жителей: сколько деревьев срублено суммарно.

     Живёт здесь, а не в render.js: состояние и время — одно, рисование —
     другое. Оболочкам остаётся сравнить число с прошлым кадром и обновить
     надпись — счёт меняется раз в 10..20 секунд, а панель это записи в DOM.

     У гуляющего жителя рубки нет вовсе (см. villager.js), поэтому в партии
     без найма сумма всегда 0 — и это правильный ответ, а не «счётчик сломан». */
  function stepVillagers(villagers, world, renderer, dt, buildings) {
    if (!world || !villagers || !villagers.length) return 0;
    /* Список жителей партии кладётся на мир: по нему движок считает, занято ли
       место двора у лагеря другим рабочим (js/villager.js: partnersOf). Второго
       реестра работников при этом не заводится — правда о найме живёт в
       v.employer, а список партии и так один. */
    world._villagers = villagers;
    world._buildings = buildings || [];
    /* Раз в секунду проверяем, не освободилось ли место в лагере: воины из
       дворов казарм должны уйти туда сами. Каждый кадр это не нужно — состав
       дружины меняется редко, а обход всех жителей дешёвый, но лишний. */
    world._garrisonT = (world._garrisonT || 0) + dt;
    if (world._garrisonT >= 1) {
      world._garrisonT = 0;
      rebalanceGarrison(world, world._buildings, villagers);
    }
    var opts = { buildings: buildings };
    /* Бюджет поиска пути на этот кадр — ОДИН на всех жителей. */
    if (global.Villagers.beginFrame) global.Villagers.beginFrame(world);
    var felled = 0;
    for (var i = 0; i < villagers.length; i++) {
      global.Villagers.update(villagers[i], world, renderer.villagerSprites, dt, opts);
      felled += villagers[i].felled;
    }
    return felled;
  }

  /* Жители на обзоре. Обзор пересобирается только по генерации карты, а жители
     ходят — значит, точки ставятся на каждый кадр, поверх готовой картинки.
     Без них найти человека на острове можно только обшарив его глазами: он
     маленький, а с 2026-10-16 их ещё и трое. */
  function drawVillagers(ctx, renderer, villagers) {
    if (!ctx || !renderer || !villagers) return 0;
    var drawn = 0;
    for (var i = 0; i < villagers.length; i++) {
      /* Растворённый в казарме не точка на обзоре: его там нет. */
      if (global.Villagers.visible && !global.Villagers.visible(villagers[i])) continue;
      var p = renderer.worldToMM(villagers[i].x, villagers[i].y);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff2c4';
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(40,30,6,0.9)';
      ctx.stroke();
      drawn++;
    }
    return drawn;
  }

  /* Что житель делает прямо сейчас — словами.
  
     Состояний у жителя БЕЗ РАБОТЫ два (см. villager.js): `wander` — гуляет,
     `stand` — идти некуда (заперт: кругом вода, дом или стена). У НАНЯТОГО их
     шесть, и все шесть названы здесь: идёт в лагерь, берёт топор, идёт к
     дереву, рубит, несёт брёвна, сдаёт. Слово для интерфейса живёт в ОДНОМ
     месте — задача 4 показывает эти слова как есть, а не собирает свои.

     Идёт и рубит — это ещё и разное «рубит: 2 из 5 секунд»: без остатка
     надпись «рубит» выглядела бы застывшей, а работа идёт. */
  function villagerDoing(v, chopping) {
    if (!v) return 'нет';
    /* Ученик казармы и воин — разные состояния одного человека, и слова у них
       разные. Пока учится — идёт ко входу, входит, тренируется; после выхода
       из казармы он уже воин и идёт в лагерь. */
    if (v.trainee) {
      switch (v.state) {
        case 'toBarracks':
        case 'toward': return 'идёт в казарму';
        case 'enterBarracks': return 'входит в казарму';
        case 'training':
          return 'тренируется · ' + Math.max(0, v.trainT || 0).toFixed(1) + ' с';
        case 'stand': return 'в казарму не пройти';
        default: return 'идёт в казарму';
      }
    }
    if (v.warrior) {
      switch (v.state) {
        case 'toWarcamp':
        case 'toward': return 'идёт в военный лагерь';
        case 'patrol': return 'воин в лагере';
        case 'stand': return 'воину негде ходить';
        default: return 'воин в лагере';
      }
    }
    switch (v.state) {
      case 'chop':
        var left = Math.max(0, (chopping || 5) - v.chopT);
        return 'рубит дерево · ' + left.toFixed(1) + ' с';
      case 'toCamp': return 'идёт в лагерь';
      case 'take': return 'берёт топор';
      case 'toTree':
      case 'toward': return 'идёт к дереву';
      case 'carry': return 'несёт брёвна';
      case 'drop': return 'сдаёт брёвна';
      // `stand` у нанятого — «работать негде» (деревьев не осталось или все
      // заняты), у гуляющего — «идти некуда». Разбирать их по названию нельзя
      // ровно так же, как в villager.js (см. working).
      case 'stand': return v.employer ? 'работать негде' : 'стоит: идти некуда';
      default: return v.employer ? 'идёт в лагерь' : 'гуляет по деревне';
    }
  }

  global.Session = {
    HOME: HOME,
    VILLAGE: VILLAGE,
    SITE: SITE,
    VILLAGERS: VILLAGERS,
    TRAIN_TIME: TRAIN_TIME,
    VANISH_TIME: VANISH_TIME,
    EMERGE_TIME: EMERGE_TIME,
    BIRTH_EVERY: BIRTH_EVERY,
    BIRTH_FADE: BIRTH_FADE,
    BIRTH_REACH: BIRTH_REACH,
    BIRTH_RETRY: BIRTH_RETRY,
    startHome: startHome,
    startBot: startBot,
    startMulti: startMulti,
    newTown: newTown,
    aliveTowns: aliveTowns,
    standing: standing,
    townOf: townOf,
    townById: townById,
    houseOf: houseOf,
    spawnVillagers: spawnVillagers,
    residentsOf: residentsOf,
    villagerName: villagerName,
    birthClock: birthClock,
    birthDue: birthDue,
    housingFree: housingFree,
    housingFreeOf: housingFreeOf,
    townAlive: townAlive,
    townHallOf: townHallOf,
    townHouses: townHouses,
    townResidents: townResidents,
    birthHouse: birthHouse,
    tryBirth: tryBirth,
    rearmBirth: rearmBirth,
    birthStatus: birthStatus,
    nextVillagerId: nextVillagerId,
    syncVillagerIds: syncVillagerIds,
    nextBoundary: nextBoundary,
    workersOf: workersOf,
    isWorkplace: isWorkplace,
    isBarracks: isBarracks,
    isKnight: isKnight,
    isWarrior: isWarrior,
    isTrainer: isTrainer,
    traineesOf: traineesOf,
    warriorsOf: warriorsOf,
    warcampsOf: warcampsOf,
    nearestWarcamp: nearestWarcamp,
    warriorsAt: warriorsAt,
    warcampRoom: warcampRoom,
    garrisonAt: garrisonAt,
    barracksRoom: barracksRoom,
    armyRoom: armyRoom,
    destinationFor: destinationFor,
    rebalanceGarrison: rebalanceGarrison,
    trainingSlots: trainingSlots,
    freeForTraining: freeForTraining,
    canTrain: canTrain,
    train: train,
    cancelTraining: cancelTraining,
    releaseTrainees: releaseTrainees,
    trainingGroup: trainingGroup,
    trainingGroupLabel: trainingGroupLabel,
    trainingOrder: trainingOrder,
    trainingBatchInfo: trainingBatchInfo,
    trainAll: trainAll,
    worksAt: worksAt,
    workWord: workWord,
    workMark: workMark,
    hireGroup: hireGroup,
    hireGroupLabel: hireGroupLabel,
    hireOrder: hireOrder,
    canHire: canHire,
    hire: hire,
    fire: fire,
    batchInfo: batchInfo,
    hireAll: hireAll,
    fireAll: fireAll,
    stepVillagers: stepVillagers,
    drawVillagers: drawVillagers,
    villagerDoing: villagerDoing
  };
})(typeof window !== 'undefined' ? window : globalThis);
