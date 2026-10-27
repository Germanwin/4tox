/* simulation.js — авторитетный мир, который считается ТОЛЬКО здесь.

   Один шаг = ровно 50 мс. Произвольный dt снаружи не принимается: иначе
   экономика снова начнёт зависеть от частоты кадров клиента. Порядок фаз
   зафиксирован контрактом §6.3 и не переставляется ради «оптимизации».

   В состоянии нет ни камеры, ни selected/follow, ни DOM, ни Promise, ни
   сетевых сокетов, ни диагностических колец. Это игровые данные и только
   они; всё остальное живёт в комнате и оболочке. */
(function (global) {
  'use strict';

  var TICK_MS = 50;
  var TICK_SECONDS = 0.05;
  var COMMANDS_PER_TICK = 64;

  function tickMs() {
    var C = global.NetConfig;
    return C && C.tickMs ? C.tickMs : TICK_MS;
  }

  function tickSeconds() {
    return tickMs() / 1000;
  }

  function gameplayAnimSet(gameplay) {
    if (!gameplay) return null;
    if (gameplay.anims) return gameplay;
    if (gameplay.profiles && gameplay.profiles.villager) {
      var p = gameplay.profiles.villager;
      return { anims: p.animations || p, frames: {} };
    }
    if (gameplay.animations) return { anims: gameplay.animations, frames: {} };
    return null;
  }

  function structureSignature(buildings) {
    var out = [];
    for (var i = 0; i < (buildings || []).length; i++) {
      var b = buildings[i];
      if (!b) continue;
      out.push(b.id + '@' + b.x + ',' + b.y + ',' + b.rot + ',' +
        (b.type || 'townhall') + ',' + (b.variant || '') + ',' + (b.rubble ? 1 : 0));
    }
    return out.join('|');
  }

  /* Пала ратуша города. Город выбывает, партия продолжается, пока живы хотя
     бы два. Никакого UI: только данные. */
  function handleTownFallen(world, owner) {
    if (!world || !world.towns) return null;
    var town = null, i;
    for (i = 0; i < world.towns.length; i++) {
      if (world.towns[i] && world.towns[i].owner === owner) { town = world.towns[i]; break; }
    }
    if (!town || town.alive === false) return null;
    town.alive = false;
    return town;
  }

  function ensureWorldLinks(state) {
    var world = state.world;
    world._buildings = state.buildings;
    world._villagers = state.villagers;
    world.time = (state.tick || 0) * tickSeconds();
    if (global.Navigation && typeof global.Navigation.ensure === 'function') global.Navigation.ensure(world);
    return state;
  }

  function create(options) {
    options = options || {};
    var WG = global.WorldGen;
    if (!WG) throw new Error('WorldGen не загружен');
    var seed = options.seed;
    var size = options.size || 64;
    if (!seed) throw new Error('simulation_seed_required');
    var world = WG.generate({ seed: seed, size: size });
    /* genTimeMs — диагностическое время генерации, а не игровое состояние.
       В canonicalHash оно не должно делать два одинаковых мира разными. */
    world.genTimeMs = 0;
    var mode = options.mode || 'multi';
    var st;
    if (mode === 'multi') {
      st = global.Session.startMultiCore(world, {
        players: options.players || 2,
        site: options.site
      });
    } else if (mode === 'bot') {
      st = global.Session.startBotCore(world, { site: options.site });
    } else {
      st = global.Session.startHomeCore(world, options.site);
    }
    var state = {
      schema: 1,
      mode: mode,
      seed: seed,
      size: size,
      players: st.towns ? st.towns.length : (options.players || 1),
      world: world,
      buildings: st.buildings,
      villagers: st.villagers,
      birth: global.Session.birthClock(),
      tick: 0,
      nextBuildId: 1000,
      running: true,
      over: false,
      winner: null,
      structureVersion: 1,
      ledger: options.ledger || null,
      _structSig: ''
    };
    ensureWorldLinks(state);
    if (global.Combat) global.Combat.init(world, state.buildings, state.villagers);
    if (global.Session.syncVillagerIds) global.Session.syncVillagerIds(world, state.villagers);
    state._structSig = structureSignature(state.buildings);
    return wrap(state, gameplayAnimSet(options.gameplay));
  }

  function wrap(state, animSet) {
    var sim = {
      state: state,
      animSet: animSet,
      _lastEvents: [],
      step: function (commands) { return stepSim(state, animSet, commands, sim); },
      exportState: function () { return exportState(state); },
      events: function () {
        var list = (state.world && state.world.events) || [];
        return list.slice(Math.max(0, list.length - 40));
      },
      lastEvents: function () { return sim._lastEvents.slice(); },
      diagnostics: function () {
        return {
          tick: state.tick,
          simulationTimeMs: state.tick * tickMs(),
          structures: state.buildings.length,
          villagers: state.villagers.length,
          over: state.over,
          winner: state.winner,
          structureVersion: state.structureVersion,
          nav: global.Navigation && typeof global.Navigation.diagnostics === 'function'
            ? global.Navigation.diagnostics(state.world) : null
        };
      }
    };
    return sim;
  }

  function exportState(state) {
    if (!global.Checkpoint || typeof global.Checkpoint.encode !== 'function') {
      throw new Error('checkpoint_codec_not_loaded');
    }
    /* Кодек обязан получить НЕЗАВИСИМЫЙ DTO: дальше комната может менять
       живой мир, а сохранение не должно меняться вслед за ним. */
    return global.Checkpoint.encode(state);
  }

  function stepSim(state, animSet, commands, sim) {
    var C = global.NetConfig;
    var maxCommands = C && C.commandsPerTick ? C.commandsPerTick : COMMANDS_PER_TICK;
    var list = commands || [];
    if (list.length > maxCommands) throw new Error('too_many_commands');
    var dt = tickSeconds();
    var events = [];
    var results = [];
    var i;

    /* Команды — ДО увеличения тика: они адресованы тику tick+1, а их
       appliedTick будет равен новому номеру. Сортировка по roomOrder
       обязательна и не зависит от порядка HTTP или owner. */
    if (list.length > 1) {
      list = list.slice().sort(function (a, b) {
        var ra = a && typeof a.roomOrder === 'number' ? a.roomOrder : 0;
        var rb = b && typeof b.roomOrder === 'number' ? b.roomOrder : 0;
        return ra - rb;
      });
    }
    var nextTick = state.tick + 1;
    for (i = 0; i < list.length; i++) {
      var cmd = list[i];
      if (!cmd) continue;
      var res;
      try {
        res = global.Commands.apply(state, cmd);
      } catch (e) {
        if (e && typeof e === 'object') {
          e.__4tox = e.__4tox || { phase: 'command', commandId: cmd.commandId };
        }
        throw e;
      }
      res.commandId = cmd.commandId;
      res.clientSequence = cmd.clientSequence;
      res.appliedTick = res.status === 'applied' ? nextTick : null;
      res.decidedTick = nextTick;
      results.push(res);
    }

    state.tick = nextTick;
    state.world.time = state.tick * dt;

    /* 3. Бой — на той же границе, с теми же dt и порядком массива. */
    state.world._combatCells = null;
    if (global.Combat) {
      global.Combat.tick(state.world, dt, {
        buildings: state.buildings,
        villagers: state.villagers,
        advanceTime: false,
        onDefeat: function (owner) {
          var town = handleTownFallen(state.world, owner);
          if (town) events.push({ kind: 'town-fallen', owner: owner, town: town.id });
        }
      });
    }

    /* 4. Рождение — по часам партии, время уже обновлено. */
    var S = global.Session;
    if (S.birthDue(state.birth, state.world.time)) {
      var born = S.tryBirthCore(state.world, state.villagers, state.buildings, {
        clock: state.birth, seconds: state.world.time
      });
      for (i = 0; i < born.length; i++) {
        events.push({ kind: 'birth', owner: born[i].owner, id: born[i].id });
      }
      if (born.length) {
        if (global.Combat) global.Combat.init(state.world, state.buildings, state.villagers);
      }
    }

    /* 5. Один бюджет навигации на мир, затем шаг жителей БЕЗ повторной
       выдачи бюджета. */
    if (global.Navigation && typeof global.Navigation.beginTick === 'function') global.Navigation.beginTick(state.world);
    S.stepVillagersCore(state.villagers, state.world, dt, state.buildings, animSet);

    /* 6. Мёртвые уходят из списка после шага, а не во время обхода. */
    var dead = false;
    for (i = 0; i < state.villagers.length; i++) {
      if (state.villagers[i] && state.villagers[i].dead) { dead = true; break; }
    }
    if (dead) {
      for (i = 0; i < state.villagers.length; i++) {
        var dv = state.villagers[i];
        if (dv && dv.dead && global.Villagers.freeCombatCell) {
          global.Villagers.freeCombatCell(state.world, dv);
        }
      }
      state.villagers = state.villagers.filter(function (v) { return v && !v.dead; });
      state.world._villagers = state.villagers;
      if (state.world.towns) {
        for (i = 0; i < state.world.towns.length; i++) {
          var t = state.world.towns[i];
          if (t && t.villagers) t.villagers = t.villagers.filter(function (v) { return v && !v.dead; });
        }
      }
      events.push({ kind: 'deaths', count: 1 });
    }

    /* 7. Итог партии — данные, а не UI. */
    var standing = S.standing(state.world);
    if (standing.over) {
      state.over = true;
      state.winner = standing.winner;
      state.running = false;
    }

    /* 8. Структурная версия — по составу и месту построек, а не по длине
       массива: переезд дома при той же длине тоже структура. */
    var sig = structureSignature(state.buildings);
    if (sig !== state._structSig) {
      state._structSig = sig;
      state.structureVersion++;
    }

    var out = {
      tick: state.tick,
      simulationTimeMs: state.tick * tickMs(),
      events: events,
      commandResults: results,
      structureVersion: state.structureVersion
    };
    sim._lastEvents = events;
    return out;
  }

  function fromState(dto, options) {
    options = options || {};
    if (!global.Checkpoint || typeof global.Checkpoint.decode !== 'function') {
      throw new Error('checkpoint_codec_not_loaded');
    }
    var state = global.Checkpoint.decode(dto);
    if (!state || !state.world) throw new Error('checkpoint_invalid');
    state.tick = state.tick || 0;
    state.buildings = state.buildings || state.world._buildings || [];
    state.villagers = state.villagers || state.world._villagers || [];
    ensureWorldLinks(state);
    /* Ссылки на постройки после декодирования — те же объекты, но список
       world._buildings мог быть массивом-двойником. Приводим к одному. */
    state.world._buildings = state.buildings;
    state.world._villagers = state.villagers;
    if (global.Combat) global.Combat.init(state.world, state.buildings, state.villagers);
    /* Городские списки НЕ пересобираем: codec сохранил те же объекты и те же
       массивы. Фильтр по town создал бы новые массивы с теми же id, и
       canonicalHash после восстановления разошёлся бы с исходным — то есть
       «тот же мир» перестал бы быть доказуемо тем же. */
    state._structSig = structureSignature(state.buildings);
    if (!state.structureVersion) state.structureVersion = 1;
    return wrap(state, gameplayAnimSet(options.gameplay));
  }

  global.Simulation = {
    create: create,
    fromState: fromState,
    tickMs: tickMs,
    tickSeconds: tickSeconds,
    structureSignature: structureSignature
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Simulation;
})(typeof window !== 'undefined' ? window : globalThis);
