/* commands.js — ЕДИНСТВЕННЫЙ обработчик игровых команд.

   Прежде бизнес-ветки жили в game/js/play.js (applyNetCommandNow): браузер
   хоста решал, можно ли строить, списывал брёвна, ставил дом и рассылал
   результат. Теперь тот же код исполняется в комнате на сервере, а оболочка
   только присылает команду и рисует ответ.

   Здесь нет renderer, DOM, toast, emit и сетевых вызовов. На вход — доверенная
   команда (`owner` поставлен сервером по токену, `roomOrder` — очередью
   комнаты), на выход — данные: applied/rejected, причина, id созданного.
   Движок повторно проверяет игровые условия: даже своя команда не считается
   разрешённой только потому, что пришла от владельца.

   Команды одного тика исполняются по возрастанию roomOrder; порядок массива
   не сортируется заново по owner или быстроте HTTP. */
(function (global) {
  'use strict';

  function reason(code, text) {
    return { status: 'rejected', reasonCode: code, reason: String(text || '') };
  }

  function applied(extra) {
    var out = { status: 'applied', reasonCode: null, reason: '' };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
      }
    }
    return out;
  }

  function ownerOf(o) { return o && o.owner !== undefined ? o.owner : 0; }

  function townOf(sim, owner) {
    var towns = sim.world && sim.world.towns;
    if (!towns) return null;
    for (var i = 0; i < towns.length; i++) {
      if (towns[i] && towns[i].owner === owner) return towns[i];
    }
    return null;
  }

  function buildingById(sim, id) {
    for (var i = 0; i < sim.buildings.length; i++) {
      if (sim.buildings[i] && sim.buildings[i].id === id) return sim.buildings[i];
    }
    return null;
  }

  function villagerById(sim, id) {
    for (var i = 0; i < sim.villagers.length; i++) {
      if (sim.villagers[i] && sim.villagers[i].id === id) return sim.villagers[i];
    }
    return null;
  }

  /* Цена — правило игры, а не клиента. Числа приходят из общего
     GameplayConfig; запасная таблица повторяет BUILD_MENU на случай старого
     локального запуска без сгенерированного конфига. */
  var PRICE_FALLBACK = { house: 12, lumbercamp: 20, barracks: 28, warcamp: 24 };

  function validRot(rot) {
    return rot === 0 || rot === 90 || rot === 180 || rot === 270;
  }

  function buildPrice(type) {
    var G = global.GameplayConfig;
    if (G && G.prices && G.prices[type] !== undefined) return G.prices[type];
    if (G && G.buildPrices && G.buildPrices[type] !== undefined) return G.buildPrices[type];
    return PRICE_FALLBACK[type] || 0;
  }

  function buildSiteOpts(sim) {
    var G = global.GameplayConfig;
    var base = (G && G.buildSite) || {};
    return {
      clearable: base.clearable === undefined ? false : base.clearable,
      requireClear: base.requireClear === undefined ? true : base.requireClear,
      yard: base.yard === undefined ? global.Buildings.YARD : base.yard,
      villagers: sim.villagers || []
    };
  }

  function ownWarriorIds(sim, ids, who) {
    var out = [], list = sim.villagers || [], i, j;
    var want = null;
    if (ids && ids.length) {
      want = {};
      for (i = 0; i < ids.length && i < 200; i++) want[ids[i]] = 1;
    }
    for (i = 0; i < list.length; i++) {
      var v = list[i];
      if (!v || v.dead || !v.warrior) continue;
      if (ownerOf(v) !== who) continue;
      if (want && !want[v.id]) continue;
      out.push(v.id);
    }
    return out;
  }

  function makeId(sim, owner) {
    return 'p' + owner + ':b' + (sim.nextBuildId++);
  }

  /* Построить одну постройку. Вынесено в helper: этим же пользуется
     buildLine, чтобы список домов и одиночный дом проверялись одинаково. */
  function buildOne(sim, who, town, type, variant, rot, x, y, site) {
    var B = global.Buildings;
    var b = B.make({
      type: type, variant: variant || 'a', rot: rot || 0,
      x: x, y: y, owner: who, town: town.id, id: makeId(sim, who)
    });
    var chk = B.canPlace(sim.world, sim.buildings, b, site);
    if (!chk.ok) return { ok: false, reason: chk.reason, building: b };
    return { ok: true, building: b };
  }

  function settleBuilt(sim, list) {
    var B = global.Buildings;
    if (B.settleMany) B.settleMany(sim.world, list, { clear: false });
    else for (var i = 0; i < list.length; i++) B.settle(sim.world, list[i], { clear: false });
    B.touch(sim.world);
  }

  function afterBuild(sim, type) {
    if (type === 'warcamp' && global.Session.rebalanceGarrison) {
      global.Session.rebalanceGarrison(sim.world, sim.buildings, sim.villagers);
    }
  }

  function apply(sim, cmd) {
    if (!sim || !cmd) return reason('bad_command', 'нет команды');
    if (cmd.type === 'order') {
      if (!global.Army) return reason('unsupported', 'отряд не загружен');
      var whoO = cmd.owner;
      var idsO = ownWarriorIds(sim, cmd.payload && cmd.payload.ids, whoO);
      var pO = cmd.payload || {};
      var xO = pO.x, yO = pO.y;
      if (!isFinite(xO) || !isFinite(yO)) return reason('bad_coords', 'нечисловые координаты');
      var order = global.Army.order(sim.world, idsO, sim.villagers, xO, yO);
      if (order && order.ok === false) return reason('order_failed', order.reason);
      return applied({ ids: idsO });
    }
    if (cmd.type === 'stop') {
      if (!global.Army) return reason('unsupported', 'отряд не загружен');
      var pS = cmd.payload || {};
      var idsS = pS.ids ? ownWarriorIds(sim, pS.ids, cmd.owner) : ownWarriorIds(sim, null, cmd.owner);
      global.Army.stop(idsS, sim.villagers);
      return applied({ ids: idsS });
    }
    if (cmd.type === 'build') {
      var B = global.Buildings, p = cmd.payload || {};
      var who = cmd.owner;
      var town = townOf(sim, who);
      if (!town || town.alive === false) return reason('town_gone', 'ваша деревня больше не в игре');
      var type = p.buildingType;
      if (!isFinite(p.x) || !isFinite(p.y)) return reason('bad_coords', 'нечисловые координаты');
      if (!validRot(p.rot || 0)) return reason('bad_rot', 'поворот не кратен 90°');
      var price = buildPrice(type);
      if (!price) return reason('unknown_building', 'неизвестная постройка');
      if ((town.logs || 0) < price) {
        return reason('no_resources', 'не хватает брёвен: нужно ' + price +
          ', у деревни ' + (town.logs || 0));
      }
      var made = buildOne(sim, who, town, type, p.variant, p.rot, p.x, p.y, buildSiteOpts(sim));
      if (!made.ok) return reason('invalid_place', made.reason);
      /* Списание — ПОСЛЕ проверки места и до вставки: мир не должен знать
         дом, за который не заплачено, а казна — не должна платить за дом,
         который не встал. */
      town.logs -= price;
      settleBuilt(sim, [made.building]);
      sim.buildings.push(made.building);
      afterBuild(sim, type);
      return applied({ ids: [made.building.id] });
    }
    if (cmd.type === 'buildLine') {
      var BL = global.Buildings, pl = cmd.payload || {};
      if (!BL.planLine) return reason('unsupported', 'серия не поддерживается');
      var townL = townOf(sim, cmd.owner);
      if (!townL || townL.alive === false) return reason('town_gone', 'ваша деревня больше не в игре');
      var typeL = pl.buildingType;
      if (!isFinite(pl.x) || !isFinite(pl.y) || !isFinite(pl.x2) || !isFinite(pl.y2)) {
        return reason('bad_coords', 'нечисловые концы линии');
      }
      if (!validRot(pl.rot || 0)) return reason('bad_rot', 'поворот не кратен 90°');
      var priceL = buildPrice(typeL);
      if (!priceL) return reason('unknown_building', 'неизвестная постройка');
      var plan = BL.planLine(sim.world, sim.buildings, {
        type: typeL, variant: pl.variant || 'a', rot: pl.rot || 0,
        from: { x: pl.x, y: pl.y }, to: { x: pl.x2, y: pl.y2 }
      }, buildSiteOpts(sim));
      if (!plan.ok) return reason('invalid_line', plan.reason);
      if (plan.items.length > 64) return reason('line_too_long', 'в серии больше 64 построек');
      var cost = plan.items.length * priceL;
      if ((townL.logs || 0) < cost) {
        return reason('no_resources', 'не хватает брёвен на серию: нужно ' + cost +
          ', у деревни ' + (townL.logs || 0));
      }
      /* Сначала проверяем ВСЕ места и считаем полную стоимость. Только потом
         списываем и ставим. Один недопустимый элемент — ноль домов и ноль
         списаний; частичной серии не бывает. */
      var built = [], i;
      for (i = 0; i < plan.items.length; i++) {
        var it = plan.items[i];
        var one = buildOne(sim, cmd.owner, townL, typeL, pl.variant, pl.rot, it.x, it.y, buildSiteOpts(sim));
        if (!one.ok) return reason('invalid_line', one.reason);
        built.push(one.building);
      }
      townL.logs -= cost;
      settleBuilt(sim, built);
      for (i = 0; i < built.length; i++) sim.buildings.push(built[i]);
      afterBuild(sim, typeL);
      return applied({ ids: built.map(function (b) { return b.id; }) });
    }
    if (cmd.type === 'edit') {
      var BE = global.Buildings, pe = cmd.payload || {};
      var b = buildingById(sim, pe.id);
      if (!b || ownerOf(b) !== cmd.owner) return reason('not_owner', 'это не ваша постройка');
      if (pe.action === 'rotate') {
        var can = BE.canEdit(b, 'rotate');
        if (!can.ok) return reason('cannot_edit', can.reason);
        var rots = BE.checkAt(sim.world, sim.buildings, b, { rot: b.rot + 90 }, buildSiteOpts(sim));
        if (!rots.ok) return reason('invalid_place', rots.reason);
        BE.setSpot(sim.world, b, { rot: b.rot + 90 });
        return applied();
      }
      if (pe.action === 'delete') {
        var res = BE.remove(sim.world, sim.buildings, b, { villagers: sim.villagers });
        if (!res.ok) return reason('cannot_delete', res.reason);
        return applied();
      }
      if (pe.action === 'move') {
        if (!isFinite(pe.x) || !isFinite(pe.y)) return reason('bad_coords', 'нечисловые координаты');
        var at = BE.checkAt(sim.world, sim.buildings, b, { x: pe.x, y: pe.y }, buildSiteOpts(sim));
        if (!at.ok) return reason('invalid_place', at.reason);
        BE.setSpot(sim.world, b, { x: pe.x, y: pe.y });
        return applied();
      }
      return reason('unknown_edit', 'неизвестная правка: ' + pe.action);
    }
    if (cmd.type === 'train' || cmd.type === 'hire' || cmd.type === 'fire') {
      var S = global.Session, pp = cmd.payload || {};
      var camp = buildingById(sim, pp.campId);
      var v = villagerById(sim, pp.villagerId);
      if (!camp || !v) return reason('not_found', 'нет такой постройки или жителя');
      if (ownerOf(camp) !== cmd.owner) return reason('not_owner', 'это чужая постройка');
      if (ownerOf(v) !== cmd.owner) return reason('not_owner', 'это чужой житель');
      var answer = cmd.type === 'train'
        ? S.train(camp, v, sim.villagers, sim.buildings)
        : (cmd.type === 'fire' ? S.fire(camp, v, { world: sim.world })
          : S.hire(camp, v, sim.villagers));
      if (answer && answer.ok === false) return reason('game_rule', answer.reason);
      return applied();
    }
    return reason('unknown_command', 'неизвестная команда: ' + cmd.type);
  }

  global.Commands = {
    apply: apply,
    buildPrice: buildPrice,
    buildSiteOpts: buildSiteOpts,
    ownWarriorIds: ownWarriorIds,
    townOf: townOf,
    buildingById: buildingById,
    villagerById: villagerById
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Commands;
})(typeof window !== 'undefined' ? window : globalThis);
